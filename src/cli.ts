#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { runHook, type HookEvent, type Host } from './hook.js';
import { installAdapters, templateText, uninstallAdapters } from './install.js';
import { CairnError, checkpoint, isNodeError, load, render, rootFor } from './lib.js';

const HELP = `Usage: cairn [--cwd DIR] <command> [options]

Local checkpoints for one ticket per Git worktree.

Commands:
  checkpoint  Replace the checkpoint from a Markdown draft
  status      Show metadata and drift
  resume      Print a fresh checkpoint body and a receipt
  export      Print a portable checkpoint snapshot
  template    Print the checkpoint draft template
  hook        Print host hook output for session-start or stop
  install     Register hooks and the checkpoint skill
  uninstall   Remove hooks and the checkpoint skill

checkpoint:
  --ticket URL              Full Jira or GitHub issue URL
  --file PATH               Markdown draft, relative to the invocation directory
  --expected-revision N     Revision this draft replaces; 0 creates the first

resume:
  --allow-stale             Read a stale checkpoint for reconciliation

hook:
  session-start|stop        Hook event
  --host cursor|claude|codex

install, uninstall:
  --home DIR                Configuration home; defaults to the current user
`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

class HelpRequest extends Error {}

type Command = 'checkpoint' | 'status' | 'resume' | 'export' | 'template' | 'hook' | 'install' | 'uninstall';

interface Arguments {
  cwd: string;
  command: Command;
  ticket?: string;
  file?: string;
  expectedRevision?: number;
  allowStale: boolean;
  home?: string;
  host?: Host;
  hookEvent?: HookEvent;
}

export function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);
    if (args.command === 'template') {
      process.stdout.write(templateText());
      return 0;
    }
    if (args.command === 'install' || args.command === 'uninstall') {
      const home = args.home ?? os.homedir();
      const lines = args.command === 'install' ? installAdapters(home) : uninstallAdapters(home);
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    if (args.command === 'hook') {
      const text = runHook(args.hookEvent ?? 'session-start', args.host ?? 'cursor', readStdin());
      if (text) process.stdout.write(text);
      return 0;
    }
    const root = rootFor(args.cwd);
    if (args.command === 'checkpoint') {
      const line = checkpoint(root, args.ticket ?? '', args.file ?? '', args.expectedRevision ?? Number.NaN);
      process.stdout.write(`${line}\n`);
      return 0;
    }
    const { metadata, body, drift } = load(root);
    const receipt = {
      ticket: metadata.ticket,
      revision: metadata.revision,
      updated: metadata.updated,
      drift,
    };
    if (args.command === 'status') {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return 0;
    }
    if (args.command === 'resume') {
      process.stderr.write(`${JSON.stringify(receipt)}\n`);
      if (drift.length > 0 && !args.allowStale) {
        throw new CairnError('Stale checkpoint; reconcile drift before continuing. Use --allow-stale to inspect.');
      }
      process.stdout.write(body);
      return 0;
    }
    const driftText = drift.length > 0 ? drift.join(', ') : 'none';
    process.stdout.write('# Exported cairn checkpoint\n\n');
    process.stdout.write('Snapshot only. Verify the receiving checkout; code and permissions are not transferred.\n\n');
    process.stdout.write(`Drift at export: ${driftText}\n\n`);
    process.stdout.write(render(metadata, body));
    return 0;
  } catch (error) {
    if (error instanceof HelpRequest) {
      process.stdout.write(HELP);
      return 0;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${HELP}`);
      return 2;
    }
    if (error instanceof CairnError || isNodeError(error)) {
      process.stderr.write(`cairn: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function parseArgs(argv: string[]): Arguments {
  let cwd = '.';
  let allowStale = false;
  const values = new Map<string, string>();
  const commands = new Set<Command>([
    'checkpoint', 'status', 'resume', 'export', 'template', 'hook', 'install', 'uninstall',
  ]);
  let command: Command | undefined;
  let hookEvent: HookEvent | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') throw new HelpRequest();
    if (token === '--allow-stale') {
      allowStale = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!['cwd', 'ticket', 'file', 'expected-revision', 'home', 'host'].includes(name)) {
        throw new UsageError(`Unknown option --${name}`);
      }
      const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
      if (eq === -1) index += 1;
      if (value === undefined || value.startsWith('--')) throw new UsageError(`Missing value for --${name}`);
      if (name === 'cwd') cwd = value;
      else values.set(name, value);
      continue;
    }
    if (token.startsWith('-')) throw new UsageError(`Unknown option ${token}`);
    if (!command) {
      if (!commands.has(token as Command)) throw new UsageError(`Unexpected argument ${token}`);
      command = token as Command;
      continue;
    }
    if (command === 'hook' && !hookEvent) {
      if (token !== 'session-start' && token !== 'stop') throw new UsageError(`Unexpected argument ${token}`);
      hookEvent = token;
      continue;
    }
    throw new UsageError(`Unexpected argument ${token}`);
  }
  if (!command) throw new UsageError('Missing command');
  if (allowStale && command !== 'resume') throw new UsageError('--allow-stale is only valid with resume');
  if (command === 'checkpoint') {
    rejectExtra(values, ['ticket', 'file', 'expected-revision'], command);
    const ticket = values.get('ticket');
    const file = values.get('file');
    const expected = values.get('expected-revision');
    if (ticket === undefined) throw new UsageError('Missing --ticket');
    if (file === undefined) throw new UsageError('Missing --file');
    if (expected === undefined) throw new UsageError('Missing --expected-revision');
    return {
      cwd,
      command,
      ticket,
      file,
      expectedRevision: integerFlag(expected, '--expected-revision'),
      allowStale,
    };
  }
  if (command === 'hook') {
    rejectExtra(values, ['host'], command);
    if (!hookEvent) throw new UsageError('Missing hook event');
    const host = values.get('host');
    if (host === undefined) throw new UsageError('Missing --host');
    if (!isHost(host)) throw new UsageError('--host must be cursor, claude, or codex');
    return { cwd, command, allowStale, host, hookEvent };
  }
  if (command === 'install' || command === 'uninstall') {
    rejectExtra(values, ['home'], command);
    return { cwd, command, allowStale, home: values.get('home') };
  }
  rejectExtra(values, [], command);
  return { cwd, command, allowStale };
}

function rejectExtra(values: Map<string, string>, allowed: string[], command: Command): void {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) throw new UsageError(`${command} does not take --${key}`);
  }
}

function isHost(value: string): value is Host {
  return value === 'cursor' || value === 'claude' || value === 'codex';
}

function integerFlag(value: string, flag: string): number {
  if (!/^-?\d+$/.test(value)) throw new UsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${flag} must be an integer`);
  return parsed;
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(0));
  } catch {
    return '';
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
