import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DIRECTORY = '.cairn';
export const MAX_BODY_BYTES = 12_000;

const PREFIX = '<!-- cairn\n';
const SUFFIX = '\n-->\n\n';
const GIT_MAX_BUFFER = 128 * 1024 * 1024;
const LOCK_WAIT_MS = 30_000;
const STATE_KEYS = ['worktree', 'branch', 'head', 'fingerprint'] as const;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export class CairnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CairnError';
  }
}

export interface State {
  worktree: string;
  branch: string;
  head: string | null;
  fingerprint: string;
}

export interface Metadata {
  schema: 1;
  revision: number;
  ticket: string;
  updated: string;
  state: State;
  body_sha256: string;
}

export interface Checkpoint {
  metadata: Metadata;
  body: string;
  drift: string[];
  fingerprint: string;
}

export function prefersFlock(): boolean {
  if (process.env.CAIRN_LOCK === 'file') return false;
  const result = spawnSync('flock', ['--version'], { encoding: 'utf8' });
  return result.status === 0 && (result.stdout ?? '').includes('util-linux');
}

export function rootFor(cwd: string): string {
  const shown = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  return fs.realpathSync(shown);
}

export function checkpoint(
  root: string,
  requestedTicket: string | undefined,
  draft: string,
  expectedRevision: number,
): string {
  const body = `${draft.trim()}\n`;
  if (!body.trim()) throw new CairnError('Checkpoint body is empty');
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new CairnError('Checkpoint exceeds 12,000 UTF-8 bytes; link to detailed evidence');
  }
  if (requestedTicket !== undefined && !requestedTicket.trim()) {
    throw new CairnError('Ticket must not be empty');
  }
  const { directory, current } = locate(root);
  let revision = 0;
  let ticket = '';
  withWriter(directory, () => {
    const prior = readCheckpoint(current);
    revision = prior ? prior.metadata.revision : 0;
    if (revision !== expectedRevision) {
      throw new CairnError(`Revision conflict: expected ${expectedRevision}, found ${revision}`);
    }
    // An existing checkpoint owns the ticket identity; inference only names a first one.
    const resolved = requestedTicket ?? prior?.metadata.ticket ?? inferTicket(root);
    if (!resolved) {
      throw new CairnError('Cannot infer the ticket from the branch; pass --ticket with an issue URL or Jira key');
    }
    ticket = resolved;
    if (prior && prior.metadata.ticket !== ticket) {
      throw new CairnError('Ticket mismatch: use a separate worktree for a different ticket');
    }
    const before = snapshot(root);
    const metadata: Metadata = {
      schema: 1,
      revision: revision + 1,
      ticket,
      updated: new Date().toISOString(),
      state: before,
      body_sha256: createHash('sha256').update(body).digest('hex'),
    };
    if (!sameState(before, snapshot(root))) {
      throw new CairnError('Worktree changed while checkpointing; stop other writers and retry');
    }
    atomicWrite(current, render(metadata, body));
  });
  return `Checkpoint ${revision + 1} for ${ticket}: ${current}`;
}

export function hasCheckpoint(root: string): boolean {
  return lstatOrNull(locate(root).current) !== null;
}

// Names the ticket from the branch: a Jira key such as PAY-142, or a GitHub
// issue number such as 142-fix or issue-142 resolved against a github.com origin.
export function inferTicket(root: string): string | null {
  const branch = currentBranch(root);
  if (!branch) return null;
  const jira = /(?:^|[/_-])([A-Z][A-Z0-9]+-\d+)(?=$|[/_-])/.exec(branch);
  if (jira?.[1]) return jira[1];
  const leaf = branch.slice(branch.lastIndexOf('/') + 1);
  const issue = /^(?:(?:issues?|gh)[-_]?)?(\d+)(?:$|[-_])/i.exec(leaf);
  if (!issue?.[1]) return null;
  const repository = githubRepository(root);
  return repository ? `https://github.com/${repository}/issues/${Number(issue[1])}` : null;
}

function currentBranch(root: string): string | null {
  const result = spawnSync('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function githubRepository(root: string): string | null {
  const result = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/
    .exec(result.stdout.trim());
  return match?.[1] ?? null;
}

export function load(root: string): Checkpoint {
  const { current } = locate(root);
  const saved = readCheckpoint(current);
  if (!saved) throw new CairnError('No checkpoint in this worktree');
  const actual = snapshot(root);
  const drift = STATE_KEYS.filter((key) => actual[key] !== saved.metadata.state[key]);
  return { metadata: saved.metadata, body: saved.body, drift, fingerprint: actual.fingerprint };
}

export function render(metadata: Metadata, body: string): string {
  return `${PREFIX}${stableJson(metadata)}${SUFFIX}${body}`;
}

export function atomicWrite(
  file: string,
  text: string,
  replace: (source: string, destination: string) => void = fs.renameSync,
): void {
  const temporary = path.join(path.dirname(file), `.checkpoint-${randomBytes(8).toString('hex')}`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'w', 0o600);
    writeAll(descriptor, Buffer.from(text));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    replace(temporary, file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function withWriter(directory: string, fn: () => void): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = prefersFlock()
    ? acquireFlock(path.join(directory, 'write.lock'))
    : acquireFileLock(path.join(directory, 'write.lock'));
  try {
    // A local ignore file keeps checkpoints out of Git without editing project rules.
    const ignore = path.join(directory, '.gitignore');
    if (!fs.existsSync(ignore)) atomicWrite(ignore, '*\n');
    fn();
  } finally {
    release();
  }
}

function acquireFlock(lockPath: string): () => void {
  const descriptor = fs.openSync(lockPath, 'a');
  // flock(1) locks this shared open-file description and exits. The lock remains
  // with this process until the descriptor is closed, including on process death.
  const result = spawnSync('flock', ['--exclusive', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', descriptor],
  });
  if (result.error || result.status !== 0) {
    fs.closeSync(descriptor);
    if (result.error) throw result.error;
    const detail = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    throw new CairnError(detail || 'Could not lock the checkpoint');
  }
  return () => fs.closeSync(descriptor);
}

function acquireFileLock(lockPath: string): () => void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const descriptor = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        writeAll(descriptor, Buffer.from(`${process.pid}\n`));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (fileLockIsStale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      continue;
    }
    if (Date.now() > deadline) throw new CairnError('Timed out waiting for the checkpoint lock');
    Atomics.wait(sleepBuffer, 0, 0, 20);
  }
}

function fileLockIsStale(lockPath: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  if (!/^\d+$/.test(text)) {
    return Date.now() - fs.statSync(lockPath).mtimeMs > 2000;
  }
  return !processAlive(Number(text));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function locate(root: string): { directory: string; current: string } {
  const directory = path.join(root, DIRECTORY);
  const directoryStat = lstatOrNull(directory);
  if (directoryStat && (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())) {
    throw new CairnError(`${DIRECTORY} must be a real directory in this worktree`);
  }
  for (const name of ['current.md', '.gitignore', 'write.lock']) {
    const file = path.join(directory, name);
    const stat = lstatOrNull(file);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new CairnError(`${file} must be a regular file`);
    }
  }
  if (git(root, ['ls-files', '--', DIRECTORY]).length > 0) {
    throw new CairnError(`${DIRECTORY} contains tracked files; remove them from tracking first`);
  }
  return { directory, current: path.join(directory, 'current.md') };
}

function readCheckpoint(file: string): { metadata: Metadata; body: string } | null {
  if (!lstatOrNull(file)) return null;
  const text = readUtf8(file);
  if (!text.startsWith(PREFIX)) throw new CairnError('Invalid checkpoint header');
  const rest = text.slice(PREFIX.length);
  const boundary = rest.indexOf(SUFFIX);
  if (boundary === -1) throw new CairnError('Invalid checkpoint header');
  const metadata = parseMetadata(rest.slice(0, boundary));
  const body = rest.slice(boundary + SUFFIX.length);
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== metadata.body_sha256) {
    throw new CairnError('Checkpoint body changed outside checkpoint command');
  }
  return { metadata, body };
}

function parseMetadata(header: string): Metadata {
  let value: unknown;
  try {
    value = JSON.parse(header);
  } catch {
    throw new CairnError('Invalid or unsupported checkpoint metadata');
  }
  if (!isMetadata(value)) throw new CairnError('Invalid or unsupported checkpoint metadata');
  return value;
}

function isMetadata(value: unknown): value is Metadata {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (!state || typeof state !== 'object') return false;
  const fields = state as Record<string, unknown>;
  return record.schema === 1
    && Number.isInteger(record.revision)
    && (record.revision as number) >= 1
    && typeof record.ticket === 'string'
    && typeof record.updated === 'string'
    && typeof record.body_sha256 === 'string'
    && typeof fields.worktree === 'string'
    && typeof fields.branch === 'string'
    && typeof fields.fingerprint === 'string'
    && 'head' in fields
    && (fields.head === null || typeof fields.head === 'string');
}

function snapshot(root: string): State {
  const headResult = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (headResult.error) throw headResult.error;
  const hasHead = headResult.status === 0;
  const branch = hasHead
    ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toString('utf8').trim()
    : '';
  const digest = createHash('sha256');
  const scope = ['--', '.', `:(exclude)${DIRECTORY}`];
  const diffs = [
    ['diff', '--no-ext-diff', '--no-textconv', '--binary'],
    ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  ];
  for (const args of diffs) add(digest, git(root, [...args, ...scope]));
  const names = splitNull(git(root, ['ls-files', '-z', '--others', '--exclude-standard', ...scope]));
  names.sort((left, right) => Buffer.compare(left, right));
  for (const raw of names) {
    add(digest, raw);
    const file = path.join(root, raw.toString('utf8'));
    const stats = fs.lstatSync(file);
    if (stats.isSymbolicLink()) {
      add(digest, Buffer.concat([Buffer.from('link:'), Buffer.from(fs.readlinkSync(file))]));
    } else if (stats.isFile()) {
      add(digest, Buffer.from(String(stats.mode & 0o777)));
      add(digest, hashFile(file));
    } else {
      throw new CairnError(`Cannot fingerprint untracked path: ${file}`);
    }
  }
  return {
    worktree: root,
    branch,
    head: hasHead ? (headResult.stdout ?? Buffer.alloc(0)).toString('utf8').trim() : null,
    fingerprint: digest.digest('hex'),
  };
}

function sameState(left: State, right: State): boolean {
  return STATE_KEYS.every((key) => left[key] === right[key]);
}

function git(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: GIT_MAX_BUFFER });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim();
    throw new CairnError(detail || 'git failed');
  }
  return result.stdout ?? Buffer.alloc(0);
}

function add(digest: Hash, data: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(data.length));
  digest.update(length);
  digest.update(data);
}

function hashFile(file: string): Buffer {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest();
}

function splitNull(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index === buffer.length || buffer[index] === 0) {
      if (index > start) parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  return parts;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sorted(value), null, 2);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([key, entry]) => [key, sorted(entry)]));
  }
  return value;
}

export function readUtf8(file: string | number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new CairnError(`Invalid UTF-8 in ${file === 0 ? 'standard input' : String(file)}`);
    }
    throw error;
  }
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += fs.writeSync(descriptor, data, offset);
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof errorCode(error) === 'string';
}
