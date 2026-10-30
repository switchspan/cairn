import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { atomicWrite, prefersFlock } from '../src/lib.js';

const SHIPPED = fileURLToPath(new URL('../../skills/checkpoint/scripts/lib/', import.meta.url));
const FRESH = fileURLToPath(new URL('../src/', import.meta.url));
const CLI = path.join(SHIPPED, 'cli.js');
const WRAPPER = fileURLToPath(new URL('../../skills/checkpoint/scripts/cairn', import.meta.url));
const TICKET = 'https://example.invalid/PAY-142';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  base: string;
  repo: string;
  draft: string;
  git: (...args: string[]) => string;
  run: (args: string[], cwd?: string, env?: Record<string, string>) => Result;
  save: (revision?: number, cwd?: string, env?: Record<string, string>) => void;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout;
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Cairn Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const excludes = path.join(base, 'excludes');
  fs.writeFileSync(excludes, '');
  git('config', 'core.excludesFile', excludes);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'original\n');
  git('add', '.');
  git('commit', '-m', 'baseline');
  const draft = path.join(base, 'draft.md');
  fs.writeFileSync(draft, 'Objective: fix retries.\nNext: run regression test.\n');
  const run = (args: string[], cwd = repo, env?: Record<string, string>): Result => {
    const result = spawnSync(process.execPath, [CLI, '--cwd', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const saveArgs = (revision = 0) => [
    'checkpoint', '--ticket', TICKET, '--file', draft, '--expected-revision', String(revision),
  ];
  return {
    base,
    repo,
    draft,
    git,
    run,
    save(revision = 0, cwd = repo, env?: Record<string, string>) {
      const result = run(saveArgs(revision), cwd, env);
      assert.equal(result.status, 0, result.stderr);
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function withFixture(fn: (fx: Fixture) => void | Promise<void>) {
  return async () => {
    const fx = createFixture();
    try {
      await fn(fx);
    } finally {
      fx.cleanup();
    }
  };
}

function race(repo: string, draft: string, env?: Record<string, string>): Promise<number[]> {
  const args = [
    CLI, '--cwd', repo, 'checkpoint', '--ticket', TICKET, '--file', draft, '--expected-revision', '0',
  ];
  const children = [0, 1].map(() => spawn(process.execPath, args, {
    stdio: 'ignore',
    env: { ...process.env, ...env },
  }));
  return Promise.all(children.map((child) => new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('checkpoint timed out'));
    }, 15_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  })));
}

test('round trip from a subdirectory uses a local ignore', withFixture((fx) => {
  fx.save();
  const nested = path.join(fx.repo, 'nested');
  fs.mkdirSync(nested);
  const result = fx.run(['resume'], nested);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, fs.readFileSync(fx.draft, 'utf8'));
  assert.equal(fx.git('status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(fx.repo, '.gitignore')), false);
  const record = fs.readFileSync(path.join(fx.repo, '.cairn', 'current.md'), 'utf8');
  assert.ok(record.startsWith('<!-- cairn\n'));
}));

test('dirty file content drifts when status text stays a modification', withFixture((fx) => {
  const file = path.join(fx.repo, 'code.txt');
  fs.writeFileSync(file, 'first edit\n');
  fx.save();
  fs.writeFileSync(file, 'second edit\n');
  const result = fx.run(['resume']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /fingerprint/);
  assert.equal(fx.run(['resume', '--allow-stale']).status, 0);
}));

test('untracked content drift', withFixture((fx) => {
  const file = path.join(fx.repo, 'new.txt');
  fs.writeFileSync(file, 'one');
  fx.save();
  fs.writeFileSync(file, 'two');
  assert.notEqual(fx.run(['resume']).status, 0);
}));

test('staging drift', withFixture((fx) => {
  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  fx.save();
  fx.git('add', 'code.txt');
  assert.notEqual(fx.run(['resume']).status, 0);
}));

test('HEAD drift', withFixture((fx) => {
  fx.save();
  fx.git('commit', '--allow-empty', '-m', 'new head');
  assert.match(fx.run(['status']).stdout, /head/);
  assert.notEqual(fx.run(['resume']).status, 0);
}));

test('worktrees keep separate checkpoints', withFixture((fx) => {
  fx.save();
  const other = path.join(fx.base, 'ticket-two');
  fx.git('worktree', 'add', '-b', 'ticket-two', other);
  const missing = fx.run(['resume'], other);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No checkpoint/);
  fs.writeFileSync(fx.draft, 'Objective: another ticket.\nNext: inspect parser.\n');
  fx.save(0, other);
  assert.match(fx.run(['resume']).stdout, /fix retries/);
  assert.match(fx.run(['resume'], other).stdout, /another ticket/);
}));

test('revision and ticket conflicts preserve the checkpoint', withFixture((fx) => {
  fx.save();
  const current = path.join(fx.repo, '.cairn', 'current.md');
  const original = fs.readFileSync(current);
  const conflict = fx.run([
    'checkpoint', '--ticket', TICKET, '--file', fx.draft, '--expected-revision', '0',
  ]);
  assert.match(conflict.stderr, /Revision conflict/);
  const mismatch = fx.run([
    'checkpoint', '--ticket', 'https://example.invalid/other', '--file', fx.draft, '--expected-revision', '1',
  ]);
  assert.match(mismatch.stderr, /Ticket mismatch/);
  assert.deepEqual(fs.readFileSync(current), original);
  fx.save(1);
  assert.match(fx.run(['status']).stdout, /"revision": 2/);
}));

test('concurrent checkpoints have one winner', { timeout: 20_000 }, withFixture(async (fx) => {
  const codes = (await race(fx.repo, fx.draft)).sort();
  assert.deepEqual(codes, [0, 1]);
  assert.equal(fx.run(['resume']).status, 0);
  if (prefersFlock()) {
    assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'write.lock')), true);
  }
}));

test('file lock serializes writers and releases the lock file', { timeout: 20_000 }, withFixture(async (fx) => {
  const codes = (await race(fx.repo, fx.draft, { CAIRN_LOCK: 'file' })).sort();
  assert.deepEqual(codes, [0, 1]);
  assert.equal(fx.run(['resume'], fx.repo, { CAIRN_LOCK: 'file' }).status, 0);
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'write.lock')), false);
}));

test('file lock replaces a lock whose process is gone', withFixture((fx) => {
  const directory = path.join(fx.repo, '.cairn');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'write.lock'), '99999999\n');
  fx.save(0, fx.repo, { CAIRN_LOCK: 'file' });
  assert.equal(fs.existsSync(path.join(directory, 'write.lock')), false);
  assert.equal(fx.run(['resume'], fx.repo, { CAIRN_LOCK: 'file' }).status, 0);
}));

test('failed replace preserves the old checkpoint', withFixture((fx) => {
  fx.save();
  const current = path.join(fx.repo, '.cairn', 'current.md');
  const original = fs.readFileSync(current);
  assert.throws(() => atomicWrite(current, 'replacement', () => {
    throw Object.assign(new Error('simulated interruption'), { code: 'EIO' });
  }), /simulated interruption/);
  assert.deepEqual(fs.readFileSync(current), original);
  const leftovers = fs.readdirSync(path.dirname(current)).filter((name) => name.startsWith('.checkpoint-'));
  assert.deepEqual(leftovers, []);
}));

test('symlink storage directory is rejected', withFixture((fx) => {
  const outside = path.join(fx.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fx.repo, '.cairn'));
  assert.notEqual(fx.run([
    'checkpoint', '--ticket', TICKET, '--file', fx.draft, '--expected-revision', '0',
  ]).status, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
}));

test('tracked checkpoint directory is rejected', withFixture((fx) => {
  const directory = path.join(fx.repo, '.cairn');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'old.md'), 'old');
  fx.git('add', '.cairn/old.md');
  const result = fx.run([
    'checkpoint', '--ticket', TICKET, '--file', fx.draft, '--expected-revision', '0',
  ]);
  assert.match(result.stderr, /tracked files/);
}));

test('oversize drafts and manual body edits are rejected', withFixture((fx) => {
  fs.writeFileSync(fx.draft, 'x'.repeat(12001));
  assert.notEqual(fx.run([
    'checkpoint', '--ticket', TICKET, '--file', fx.draft, '--expected-revision', '0',
  ]).status, 0);
  fs.writeFileSync(fx.draft, 'Objective: test.\nNext: verify.\n');
  fx.save();
  const current = path.join(fx.repo, '.cairn', 'current.md');
  fs.writeFileSync(current, fs.readFileSync(current, 'utf8') + 'changed');
  assert.match(fx.run(['resume']).stderr, /changed outside/);
}));

test('export contains identity and drift', withFixture((fx) => {
  fx.save();
  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  const result = fx.run(['export']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fingerprint/);
  assert.match(result.stdout, /https:\/\/example\.invalid\/PAY-142/);
  assert.match(result.stdout, /code and permissions are not transferred/);
}));

test('status does not create a checkpoint', withFixture((fx) => {
  assert.notEqual(fx.run(['status']).status, 0);
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn')), false);
}));

test('ignored evidence does not create drift', withFixture((fx) => {
  fx.save();
  fs.writeFileSync(path.join(fx.repo, '.cairn', 'evidence.log'), 'test output');
  assert.equal(fx.run(['resume']).status, 0);
}));

function runInput(args: string[], input = ''): Result {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function hookCommands(value: unknown, event: 'session-start' | 'stop'): string[] {
  const found: string[] = [];
  const visit = (node: unknown, seen: Set<unknown>) => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, seen);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.command === 'string' && record.command.includes(` hook ${event} --host `)) {
      found.push(record.command);
    }
    for (const entry of Object.values(record)) visit(entry, seen);
  };
  visit(value, new Set());
  return found;
}

test('template prints the draft headings', () => {
  const result = runInput(['template']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Next action/);
});

test('session start injects a fresh body and a drifted body under a banner', withFixture((fx) => {
  const absent = runInput(['hook', 'session-start', '--host', 'cursor'], JSON.stringify({ cwd: fx.repo }));
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, '');
  assert.equal(absent.stderr, '');
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn')), false);

  const missing = runInput(
    ['hook', 'session-start', '--host', 'cursor'],
    JSON.stringify({ cwd: fx.base }),
  );
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, '');

  fx.save();
  const fresh = runInput(
    ['--cwd', fx.base, 'hook', 'session-start', '--host', 'cursor'],
    JSON.stringify({ cwd: fx.base, worktree: { path: fx.repo } }),
  );
  assert.equal(fresh.status, 0, fresh.stderr);
  const cursor = JSON.parse(fresh.stdout) as { additional_context?: string };
  assert.deepEqual(Object.keys(cursor), ['additional_context']);
  assert.match(cursor.additional_context ?? '', /Objective: fix retries/);
  assert.ok((cursor.additional_context ?? '').includes(TICKET));
  assert.doesNotMatch(cursor.additional_context ?? '', /<!-- cairn/);

  const claude = runInput(
    ['hook', 'session-start', '--host', 'claude'],
    JSON.stringify({ workspace: { current_dir: fx.repo } }),
  );
  const claudePayload = JSON.parse(claude.stdout) as {
    additional_context?: string;
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.deepEqual(Object.keys(claudePayload), ['hookSpecificOutput']);
  assert.equal(claudePayload.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(claudePayload.hookSpecificOutput?.additionalContext ?? '', /Objective: fix retries/);
  const codex = runInput(['hook', 'session-start', '--host', 'codex'], JSON.stringify({ cwd: fx.repo }));
  const codexPayload = JSON.parse(codex.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.equal(
    codexPayload.hookSpecificOutput?.additionalContext,
    claudePayload.hookSpecificOutput?.additionalContext,
  );

  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  const stale = runInput(['hook', 'session-start', '--host', 'cursor'], JSON.stringify({ cwd: fx.repo }));
  assert.equal(stale.status, 0, stale.stderr);
  const drifted = JSON.parse(stale.stdout) as { additional_context?: string };
  assert.match(drifted.additional_context ?? '', /\nDRIFT: fingerprint\. .*Verification/);
  assert.match(drifted.additional_context ?? '', /Objective: fix retries/);
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'stop-nudge')), false);
  assert.equal(runInput(['hook', 'session-start', '--host', 'cursor'], '{').stdout, '');
}));

test('checkpoint reads stdin and infers a Jira key from the branch', withFixture((fx) => {
  fx.git('checkout', '-b', 'feature/PAY-142-retries');
  const first = runInput(['--cwd', fx.repo, 'checkpoint', '--expected-revision', '0'], 'Objective: from stdin.\n');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^Checkpoint 1 for PAY-142: /);
  assert.equal(fx.run(['resume']).stdout, 'Objective: from stdin.\n');

  fx.git('checkout', '-b', 'PAY-999-other');
  const kept = runInput(['--cwd', fx.repo, 'checkpoint', '--expected-revision', '1'], 'Objective: still 142.\n');
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /^Checkpoint 2 for PAY-142: /);
}));

test('a GitHub issue number resolves against a github.com origin', withFixture((fx) => {
  fx.git('remote', 'add', 'origin', 'git@github.com:acme/pay.git');
  fx.git('checkout', '-b', 'fix/142-retries');
  const ssh = runInput(['--cwd', fx.repo, 'checkpoint', '--expected-revision', '0'], 'Objective: ssh.\n');
  assert.match(ssh.stdout, /for https:\/\/github\.com\/acme\/pay\/issues\/142: /, ssh.stderr);

  const other = path.join(fx.base, 'issue-worktree');
  fx.git('worktree', 'add', '-b', 'issue-7', other);
  fx.git('remote', 'set-url', 'origin', 'https://github.com/acme/pay.git');
  const https = runInput(['--cwd', other, 'checkpoint', '--expected-revision', '0'], 'Objective: https.\n');
  assert.match(https.stdout, /for https:\/\/github\.com\/acme\/pay\/issues\/7: /, https.stderr);
}));

test('checkpoint without an inferable ticket asks for --ticket', withFixture((fx) => {
  const result = runInput(['--cwd', fx.repo, 'checkpoint', '--expected-revision', '0'], 'Objective: x.\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pass --ticket/);
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'current.md')), false);
}));

test('session start names the ticket only on a ticket branch without a checkpoint', withFixture((fx) => {
  const payload = JSON.stringify({ cwd: fx.repo });
  assert.equal(runInput(['hook', 'session-start', '--host', 'claude'], payload).stdout, '');
  fx.git('checkout', '-b', 'PAY-142-retries');
  const result = runInput(['hook', 'session-start', '--host', 'claude'], payload);
  const context = (JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? '';
  assert.match(context, /No cairn checkpoint exists yet for PAY-142/);
  assert.equal(runInput(['hook', 'stop', '--host', 'claude'], payload).stdout, '');
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn')), false);
}));

test('stop reminds once for a drifted fingerprint', withFixture((fx) => {
  fx.save();
  const fresh = runInput(['hook', 'stop', '--host', 'cursor'], JSON.stringify({ cwd: fx.repo }));
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout, '');
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'stop-nudge')), false);

  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  const claude = runInput(['hook', 'stop', '--host', 'claude'], JSON.stringify({ cwd: fx.repo }));
  const notice = JSON.parse(claude.stdout) as { systemMessage?: string };
  assert.deepEqual(Object.keys(notice), ['systemMessage']);
  assert.match(notice.systemMessage ?? '', /Cairn revision 1 is stale \(drift: fingerprint\)/);
  const marker = fs.readFileSync(path.join(fx.repo, '.cairn', 'stop-nudge'), 'utf8');
  assert.match(marker, /^[0-9a-f]{64}\n$/);

  const again = runInput(['hook', 'stop', '--host', 'codex'], JSON.stringify({ cwd: fx.repo }));
  assert.equal(again.stdout, '');
  assert.equal(fs.readFileSync(path.join(fx.repo, '.cairn', 'stop-nudge'), 'utf8'), marker);
  assert.doesNotMatch(fx.git('status', '--porcelain'), /stop-nudge/);
}));

test('cursor stop stays silent because its only output starts a new turn', withFixture((fx) => {
  fx.save();
  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  const result = runInput(['hook', 'stop', '--host', 'cursor'], JSON.stringify({ cwd: fx.repo }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(fx.repo, '.cairn', 'stop-nudge')), false);
}));

test('install merges host config and uninstall removes only cairn', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-home-'));
  try {
    const cursorDir = path.join(home, '.cursor');
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(cursorDir);
    fs.mkdirSync(codexDir);
    const cursorHooks = path.join(cursorDir, 'hooks.json');
    const codexHooks = path.join(codexDir, 'hooks.json');
    fs.writeFileSync(cursorHooks, `${JSON.stringify({
      version: 1,
      unrelated: true,
      hooks: {
        sessionStart: [{ command: 'echo keep-session' }],
        stop: [{ command: 'echo keep-stop' }],
      },
    }, null, 2)}\n`);
    fs.writeFileSync(codexHooks, `${JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-codex' }] }],
      },
    }, null, 2)}\n`);

    const installed = runInput(['install', '--home', home]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /claude: use the plugin: \/plugin marketplace add /);
    assert.equal(fs.existsSync(path.join(home, '.claude')), false);
    const skill = path.join(home, '.agents', 'skills', 'cairn');
    assert.match(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /^name: cairn$/m);
    const template = spawnSync(path.join(skill, 'scripts', 'cairn'), ['template'], { encoding: 'utf8' });
    assert.match(template.stdout, /## Next action/, template.stderr);
    const cursor = JSON.parse(fs.readFileSync(cursorHooks, 'utf8')) as {
      version: number;
      unrelated: boolean;
      hooks: { sessionStart: Array<{ command: string }>; stop: Array<{ command: string }> };
    };
    assert.equal(cursor.version, 1);
    assert.equal(cursor.unrelated, true);
    assert.equal(cursor.hooks.sessionStart[0]?.command, 'echo keep-session');
    assert.equal(hookCommands(cursor, 'session-start').length, 1);
    assert.equal(hookCommands(cursor, 'stop').length, 1);
    assert.ok(hookCommands(cursor, 'session-start')[0]?.startsWith(`'${path.join(skill, 'scripts', 'cairn')}'`));
    const codex = JSON.parse(fs.readFileSync(codexHooks, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(codex.theme, 'dark');
    assert.equal(codex.hooks.SessionStart[0]?.hooks[0]?.command, 'echo keep-codex');
    assert.equal(hookCommands(codex, 'session-start').length, 1);
    const backup = fs.readFileSync(`${cursorHooks}.cairn-bak`, 'utf8');
    assert.match(backup, /echo keep-session/);
    assert.doesNotMatch(backup, /hook session-start/);

    const again = runInput(['install', '--home', home]);
    assert.equal(again.status, 0, again.stderr);
    const repeated = JSON.parse(fs.readFileSync(cursorHooks, 'utf8')) as {
      hooks: { sessionStart: unknown[] };
    };
    assert.equal(repeated.hooks.sessionStart.length, 2);
    assert.equal(hookCommands(repeated, 'session-start').length, 1);
    assert.equal(fs.readFileSync(`${cursorHooks}.cairn-bak`, 'utf8'), backup);

    const removed = runInput(['uninstall', '--home', home]);
    assert.equal(removed.status, 0, removed.stderr);
    const restored = JSON.parse(fs.readFileSync(cursorHooks, 'utf8')) as {
      unrelated: boolean;
      hooks: { sessionStart: Array<{ command: string }>; stop: Array<{ command: string }> };
    };
    assert.equal(restored.unrelated, true);
    assert.deepEqual(restored.hooks.sessionStart, [{ command: 'echo keep-session' }]);
    assert.deepEqual(restored.hooks.stop, [{ command: 'echo keep-stop' }]);
    const restoredCodex = JSON.parse(fs.readFileSync(codexHooks, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }>; Stop?: unknown };
    };
    assert.equal(restoredCodex.theme, 'dark');
    assert.equal(restoredCodex.hooks.Stop, undefined);
    assert.deepEqual(restoredCodex.hooks.SessionStart, [{
      hooks: [{ type: 'command', command: 'echo keep-codex' }],
    }]);
    assert.equal(fs.existsSync(skill), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install removes the old Claude Code hooks and per-host skill copies', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-home-'));
  try {
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'skills', 'cairn'), { recursive: true });
    fs.mkdirSync(path.join(home, '.grok'));
    const settings = path.join(claudeDir, 'settings.json');
    fs.writeFileSync(settings, `${JSON.stringify({
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [
          { type: 'command', command: "'node' '/old/cli.js' hook session-start --host claude" },
          { type: 'command', command: 'echo keep-claude' },
        ] }],
        Stop: [{ hooks: [{ type: 'command', command: "'node' '/old/cli.js' hook stop --host claude" }] }],
      },
    }, null, 2)}\n`);

    const installed = runInput(['install', '--home', home]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /grok: skill only/);
    assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'cairn', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'cairn')), false);
    const cleaned = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      model: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }>; Stop?: unknown };
    };
    assert.equal(cleaned.model, 'opus');
    assert.deepEqual(cleaned.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo keep-claude' }] }]);
    assert.equal(cleaned.hooks.Stop, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install refuses an unreadable hooks file without replacing it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-home-'));
  try {
    const cursorDir = path.join(home, '.cursor');
    fs.mkdirSync(cursorDir);
    const hooks = path.join(cursorDir, 'hooks.json');
    fs.writeFileSync(hooks, '{');
    const result = runInput(['install', '--home', home]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not parse/);
    assert.equal(fs.readFileSync(hooks, 'utf8'), '{');
    assert.equal(fs.existsSync(`${hooks}.cairn-bak`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the committed skill build matches a fresh build of src', () => {
  const javascript = (directory: string) => fs.readdirSync(directory).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(javascript(SHIPPED), javascript(FRESH), 'run npm run build and commit the skill build');
  for (const name of javascript(FRESH)) {
    assert.equal(
      fs.readFileSync(path.join(SHIPPED, name), 'utf8'),
      fs.readFileSync(path.join(FRESH, name), 'utf8'),
      `${name} is stale; run npm run build and commit the skill build`,
    );
  }
});

test('the wrapper runs the CLI through a symlink', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-bin-'));
  try {
    const link = path.join(base, 'cairn');
    fs.symlinkSync(WRAPPER, link);
    const result = spawnSync(link, ['template'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Next action/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('without Node the wrapper reports and lets hooks continue', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-nonode-'));
  try {
    for (const tool of ['dirname', 'readlink', 'cat']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      fs.symlinkSync(found, path.join(bin, tool));
    }
    const run = (args: string[]) => spawnSync('/bin/sh', [WRAPPER, ...args], {
      encoding: 'utf8',
      input: '{}',
      env: { PATH: bin },
    });
    const claude = run(['hook', 'session-start', '--host', 'claude']);
    assert.equal(claude.status, 0, claude.stderr);
    const context = (JSON.parse(claude.stdout) as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    assert.match(context ?? '', /needs Node\.js 20\+/);
    const cursor = JSON.parse(run(['hook', 'session-start', '--host', 'cursor']).stdout) as {
      additional_context?: string;
    };
    assert.match(cursor.additional_context ?? '', /checkpoints are disabled/);
    const stop = run(['hook', 'stop', '--host', 'claude']);
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, '');
    const status = run(['status']);
    assert.equal(status.status, 1);
    assert.match(status.stderr, /needs Node\.js 20\+/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('the Claude Code plugin hooks run the skill wrapper', withFixture((fx) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const command = (event: string) => config.hooks[event]?.[0]?.hooks[0]?.command ?? '';
  const run = (event: string) => spawnSync('/bin/sh', ['-c', command(event)], {
    encoding: 'utf8',
    input: JSON.stringify({ cwd: fx.repo }),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
  });
  fx.save();
  fs.writeFileSync(path.join(fx.repo, 'code.txt'), 'changed');
  const start = run('SessionStart');
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /DRIFT: fingerprint/);
  const stop = run('Stop');
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /"systemMessage":"Cairn revision 1 is stale/);
  const shim = spawnSync(path.join(root, 'bin', 'cairn'), ['--cwd', fx.repo, 'status'], { encoding: 'utf8' });
  assert.match(shim.stdout, /"revision": 1/, shim.stderr);
}));

test('hook usage errors stay on stderr', () => {
  const result = runInput(['hook', 'session-start']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing --host/);
});
