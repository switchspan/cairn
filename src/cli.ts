#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CairnError, checkpoint, isNodeError, load, render, rootFor } from './lib.js';

const HELP = `Usage: cairn [--cwd DIR] <command> [options]

Local checkpoints for one ticket per Git worktree.

Commands:
  checkpoint  Replace the checkpoint from a Markdown draft
  status      Show metadata and drift
  resume      Print a fresh checkpoint body and a receipt
  export      Print a portable checkpoint snapshot

checkpoint:
  --ticket URL              Full Jira or GitHub issue URL
  --file PATH               Markdown draft, relative to the invocation directory
  --expected-revision N     Revision this draft replaces; 0 creates the first

resume:
  --allow-stale             Read a stale checkpoint for reconciliation
`;

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

class HelpRequest extends Error {}

interface Arguments {
  cwd: string;
  command: 'checkpoint' | 'status' | 'resume' | 'export';
  ticket?: string;
  file?: string;
  expectedRevision?: number;
  allowStale: boolean;
}

export function main(argv: string[]): number {
  try {
    const args = parseArgs(argv);
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
  const commands = new Set(['checkpoint', 'status', 'resume', 'export']);
  let command: Arguments['command'] | undefined;
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
      if (!['cwd', 'ticket', 'file', 'expected-revision'].includes(name)) {
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
    if (command || !commands.has(token)) throw new UsageError(`Unexpected argument ${token}`);
    command = token as Arguments['command'];
  }
  if (!command) throw new UsageError('Missing command');
  if (allowStale && command !== 'resume') throw new UsageError('--allow-stale is only valid with resume');
  if (command !== 'checkpoint') {
    if (values.size > 0) throw new UsageError(`${command} does not take checkpoint options`);
    return { cwd, command, allowStale };
  }
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

function integerFlag(value: string, flag: string): number {
  if (!/^-?\d+$/.test(value)) throw new UsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`${flag} must be an integer`);
  return parsed;
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
