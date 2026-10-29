import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { atomicWrite, prefersFlock } from '../src/lib.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
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
