import fs from 'node:fs';
import path from 'node:path';
import { DIRECTORY, hasCheckpoint, inferTicket, load, rootFor } from './lib.js';
const NUDGE = 'stop-nudge';
export function runHook(event, host, stdin) {
    try {
        const directory = worktreeFromPayload(parsePayload(stdin));
        if (!directory)
            return '';
        const root = rootFor(directory);
        if (!hasCheckpoint(root)) {
            if (event === 'stop')
                return '';
            const ticket = inferTicket(root);
            return ticket ? renderSession(host, discoveryMessage(ticket)) : '';
        }
        const checkpoint = load(root);
        if (event === 'session-start')
            return renderSession(host, sessionStartMessage(checkpoint));
        // Cursor's only stop output submits a new user turn, so it gets no reminder.
        if (host === 'cursor')
            return '';
        const message = takeStopMessage(root, checkpoint);
        if (!message)
            return '';
        return `${JSON.stringify({ systemMessage: message })}\n`;
    }
    catch {
        return '';
    }
}
export function worktreeFromPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const record = payload;
    const worktree = record.worktree;
    if (worktree && typeof worktree === 'object' && !Array.isArray(worktree)) {
        const worktreePath = worktree.path;
        if (typeof worktreePath === 'string' && worktreePath.trim())
            return worktreePath;
    }
    if (typeof record.cwd === 'string' && record.cwd.trim())
        return record.cwd;
    const workspace = record.workspace;
    if (workspace && typeof workspace === 'object' && !Array.isArray(workspace)) {
        const current = workspace.current_dir;
        if (typeof current === 'string' && current.trim())
            return current;
    }
    return undefined;
}
function parsePayload(stdin) {
    if (!stdin.trim())
        return undefined;
    return JSON.parse(stdin);
}
// A drifted body is still injected (ADR 0001); the banner carries the warning.
function sessionStartMessage(checkpoint) {
    const { metadata, body, drift } = checkpoint;
    const heading = `Cairn checkpoint (${metadata.ticket}, revision ${metadata.revision}, updated ${metadata.updated})`;
    if (drift.length === 0)
        return `${heading}\n\n${body}`;
    const banner = `DRIFT: ${drift.join(', ')}. The code changed after this checkpoint was written. `
        + 'Reconcile it against the actual diff before trusting its Verification section, '
        + 'then write a new checkpoint with the cairn skill.';
    return `${heading}\n${banner}\n\n${body}`;
}
function discoveryMessage(ticket) {
    return `No cairn checkpoint exists yet for ${ticket} in this worktree. `
        + 'When the user asks to checkpoint, write one with the cairn skill.';
}
function takeStopMessage(root, checkpoint) {
    if (checkpoint.drift.length === 0)
        return null;
    const marker = path.join(root, DIRECTORY, NUDGE);
    if (readMarker(marker) === checkpoint.fingerprint)
        return null;
    try {
        const existing = fs.lstatSync(marker);
        if (existing.isSymbolicLink() || !existing.isFile())
            return null;
    }
    catch (error) {
        if (!isMissing(error))
            return null;
    }
    try {
        fs.writeFileSync(marker, `${checkpoint.fingerprint}\n`, { mode: 0o600 });
    }
    catch {
        return null;
    }
    const revision = checkpoint.metadata.revision;
    const drift = checkpoint.drift.join(', ');
    return `Cairn revision ${revision} is stale (drift: ${drift}). Ask the agent to checkpoint before switching agents.`;
}
function readMarker(file) {
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile())
            return null;
        return fs.readFileSync(file, 'utf8').trim();
    }
    catch (error) {
        if (isMissing(error))
            return null;
        return null;
    }
}
function isMissing(error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
function renderSession(host, text) {
    if (host === 'cursor')
        return `${JSON.stringify({ additional_context: text })}\n`;
    return `${JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: text,
        },
    })}\n`;
}
