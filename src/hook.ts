import fs from 'node:fs';
import path from 'node:path';
import { DIRECTORY, load, rootFor, type Checkpoint } from './lib.js';

export type Host = 'cursor' | 'claude' | 'codex';
export type HookEvent = 'session-start' | 'stop';

const NUDGE = 'stop-nudge';

export function runHook(event: HookEvent, host: Host, stdin: string): string {
  try {
    const directory = worktreeFromPayload(parsePayload(stdin));
    if (!directory) return '';
    const root = rootFor(directory);
    const checkpoint = load(root);
    if (event === 'session-start') return renderSession(host, sessionStartMessage(checkpoint));
    const message = takeStopMessage(root, checkpoint);
    if (!message) return '';
    return renderStop(host, message);
  } catch {
    return '';
  }
}

export function worktreeFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const worktree = record.worktree;
  if (worktree && typeof worktree === 'object' && !Array.isArray(worktree)) {
    const worktreePath = (worktree as Record<string, unknown>).path;
    if (typeof worktreePath === 'string' && worktreePath.trim()) return worktreePath;
  }
  if (typeof record.cwd === 'string' && record.cwd.trim()) return record.cwd;
  const workspace = record.workspace;
  if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) {
    const current = (workspace as Record<string, unknown>).current_dir;
    if (typeof current === 'string' && current.trim()) return current;
  }
  return undefined;
}

function parsePayload(stdin: string): unknown {
  if (!stdin.trim()) return undefined;
  return JSON.parse(stdin);
}

function sessionStartMessage(checkpoint: Checkpoint): string {
  const { metadata, body, drift } = checkpoint;
  if (drift.length > 0) {
    return `Stale checkpoint; reconcile drift before continuing. Use --allow-stale to inspect. Drift: ${drift.join(', ')}.`;
  }
  return `Cairn checkpoint (${metadata.ticket}, revision ${metadata.revision}, updated ${metadata.updated})\n\n${body}`;
}

function takeStopMessage(root: string, checkpoint: Checkpoint): string | null {
  if (checkpoint.drift.length === 0) return null;
  const marker = path.join(root, DIRECTORY, NUDGE);
  if (readMarker(marker) === checkpoint.fingerprint) return null;
  try {
    const existing = fs.lstatSync(marker);
    if (existing.isSymbolicLink() || !existing.isFile()) return null;
  } catch (error) {
    if (!isMissing(error)) return null;
  }
  try {
    fs.writeFileSync(marker, `${checkpoint.fingerprint}\n`, { mode: 0o600 });
  } catch {
    return null;
  }
  const revision = checkpoint.metadata.revision;
  const drift = checkpoint.drift.join(', ');
  return `Cairn revision ${revision} is stale (drift: ${drift}); write a checkpoint with the cairn skill before switching agents.`;
}

function readMarker(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function renderSession(host: Host, text: string): string {
  if (host === 'cursor') return `${JSON.stringify({ additional_context: text })}\n`;
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  })}\n`;
}

function renderStop(host: Host, text: string): string {
  if (host === 'cursor') return `${JSON.stringify({ followup_message: text })}\n`;
  return `${JSON.stringify({ decision: 'block', reason: text })}\n`;
}
