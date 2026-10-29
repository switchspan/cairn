#!/usr/bin/env python3
"""Small, local checkpoints for one-ticket-per-worktree development."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


MAX_BODY_BYTES = 12_000
PREFIX = '<!-- worktree-handoff\n'
SUFFIX = '\n-->\n\n'


class HandoffError(Exception):
    pass


def git(cwd, *args):
    result = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True)
    if result.returncode:
        raise HandoffError(result.stderr.decode(errors='replace').strip())
    return result.stdout


def root_for(cwd):
    return Path(os.fsdecode(git(cwd, 'rev-parse', '--show-toplevel')).strip()).resolve()


def paths(root):
    directory = root / '.handoff'
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise HandoffError('.handoff must be a real directory in this worktree')
    for name in ('current.md', '.gitignore', 'write.lock'):
        p = directory / name
        if p.is_symlink() or (p.exists() and not p.is_file()):
            raise HandoffError(f'{p} must be a regular file')
    if git(root, 'ls-files', '--', '.handoff'):
        raise HandoffError('.handoff contains tracked files; remove them from tracking first')
    return directory, directory / 'current.md'


def snapshot(root):
    """Hash tracked diffs, staging state, and nonignored untracked contents."""
    head = subprocess.run(['git', '-C', str(root), 'rev-parse', '--verify', 'HEAD'],
                          capture_output=True)
    branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').decode().strip() if head.returncode == 0 else ''
    digest = hashlib.sha256()

    def add(data):
        digest.update(len(data).to_bytes(8, 'big'))
        digest.update(data)

    scope = ['--', '.', ':(exclude).handoff']
    for args in (['diff', '--no-ext-diff', '--no-textconv', '--binary'],
                 ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary'],
                 ['status', '--porcelain=v1', '-z', '--untracked-files=all']):
        add(git(root, *args, *scope))
    names = git(root, 'ls-files', '-z', '--others', '--exclude-standard', *scope)
    for raw in sorted(filter(None, names.split(b'\0'))):
        add(raw)
        p = root / os.fsdecode(raw)
        if p.is_symlink():
            add(b'link:' + os.fsencode(os.readlink(p)))
        elif p.is_file():
            add(str(p.stat().st_mode & 0o777).encode())
            file_hash = hashlib.sha256()
            with p.open('rb') as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b''):
                    file_hash.update(block)
            add(file_hash.digest())
        else:
            raise HandoffError(f'Cannot fingerprint untracked path: {p}')
    return {'worktree': str(root), 'branch': branch,
            'head': head.stdout.decode().strip() if head.returncode == 0 else None,
            'fingerprint': digest.hexdigest()}


def read_checkpoint(path):
    if not path.exists():
        return None
    text = path.read_text(encoding='utf-8')
    if not text.startswith(PREFIX) or SUFFIX not in text:
        raise HandoffError('Invalid checkpoint header')
    header, body = text[len(PREFIX):].split(SUFFIX, 1)
    try:
        metadata = json.loads(header)
        if (metadata['schema'] != 1 or type(metadata['revision']) is not int
                or metadata['revision'] < 1
                or not isinstance(metadata['ticket'], str)
                or not isinstance(metadata['updated'], str)
                or not isinstance(metadata['body_sha256'], str)):
            raise ValueError('Invalid metadata')
        for key in ('worktree', 'branch', 'fingerprint'):
            if not isinstance(metadata['state'][key], str):
                raise ValueError('Invalid state')
        if metadata['state']['head'] is not None and not isinstance(metadata['state']['head'], str):
            raise ValueError('Invalid HEAD')
    except (ValueError, KeyError, TypeError) as exc:
        raise HandoffError('Invalid or unsupported checkpoint metadata') from exc
    if hashlib.sha256(body.encode()).hexdigest() != metadata['body_sha256']:
        raise HandoffError('Checkpoint body changed outside checkpoint command')
    return metadata, body


def render(metadata, body):
    return PREFIX + json.dumps(metadata, sort_keys=True, indent=2) + SUFFIX + body


def atomic_write(path, text):
    fd, temporary = tempfile.mkstemp(prefix='.checkpoint-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def writer(directory):
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / 'write.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # A local ignore file keeps checkpoints out of git without editing project rules.
        ignore = directory / '.gitignore'
        if not ignore.exists():
            atomic_write(ignore, '*\n')
        yield


def checkpoint(root, args):
    body = Path(args.file).read_text(encoding='utf-8').strip() + '\n'
    if not body.strip():
        raise HandoffError('Checkpoint body is empty')
    if len(body.encode()) > MAX_BODY_BYTES:
        raise HandoffError('Checkpoint exceeds 12,000 UTF-8 bytes; link to detailed evidence')
    if not args.ticket.strip():
        raise HandoffError('Ticket must not be empty')
    directory, current = paths(root)
    with writer(directory):
        prior = read_checkpoint(current)
        revision = prior[0]['revision'] if prior else 0
        if revision != args.expected_revision:
            raise HandoffError(f'Revision conflict: expected {args.expected_revision}, found {revision}')
        if prior and prior[0]['ticket'] != args.ticket:
            raise HandoffError('Ticket mismatch: use a separate worktree for a different ticket')
        before = snapshot(root)
        metadata = {'schema': 1, 'revision': revision + 1, 'ticket': args.ticket,
                    'updated': datetime.now(timezone.utc).isoformat(), 'state': before,
                    'body_sha256': hashlib.sha256(body.encode()).hexdigest()}
        if snapshot(root) != before:
            raise HandoffError('Worktree changed while checkpointing; stop other writers and retry')
        atomic_write(current, render(metadata, body))
    print(f'Checkpoint {revision + 1}: {current}')


def inspect(root):
    _, current = paths(root)
    saved = read_checkpoint(current)
    if saved is None:
        raise HandoffError('No checkpoint in this worktree')
    metadata, body = saved
    actual = snapshot(root)
    drift = [key for key in actual if actual[key] != metadata['state'][key]]
    return metadata, body, drift


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cwd', default='.', help='Target checkout or a directory within it')
    commands = parser.add_subparsers(dest='command', required=True)
    save = commands.add_parser('checkpoint', help='Replace the checkpoint from a Markdown draft')
    save.add_argument('--ticket', required=True, help='Full Jira or GitHub issue URL')
    save.add_argument('--file', required=True, help='Markdown draft path, relative to invocation directory')
    save.add_argument('--expected-revision', required=True, type=int)
    commands.add_parser('status', help='Show metadata and drift, without loading the body into the agent')
    resume = commands.add_parser('resume', help='Print a fresh checkpoint body and verification receipt')
    resume.add_argument('--allow-stale', action='store_true', help='Read stale context for reconciliation')
    commands.add_parser('export', help='Print a portable checkpoint snapshot; transfers no code')
    args = parser.parse_args(argv)
    try:
        root = root_for(args.cwd)
        if args.command == 'checkpoint':
            checkpoint(root, args)
            return 0
        metadata, body, drift = inspect(root)
        receipt = {'ticket': metadata['ticket'], 'revision': metadata['revision'],
                   'updated': metadata['updated'], 'drift': drift}
        if args.command == 'status':
            print(json.dumps(receipt, indent=2))
        elif args.command == 'resume':
            print(json.dumps(receipt), file=sys.stderr)
            if drift and not args.allow_stale:
                raise HandoffError('Stale checkpoint; reconcile drift before continuing. Use --allow-stale to inspect.')
            print(body, end='')
        else:
            # Export is an explicit stdout operation. Shell redirection chooses the destination.
            print('# Exported worktree handoff\n')
            print('Snapshot only. Verify the receiving checkout; code and permissions are not transferred.\n')
            print('Drift at export: ' + (', '.join(drift) if drift else 'none') + '\n')
            print(render(metadata, body), end='')
        return 0
    except (HandoffError, OSError, UnicodeError) as exc:
        print(f'handoff: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
