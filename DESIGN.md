# Design

Status: initial local prototype, October 29, 2026.

## Goal

Continue a ticket across Claude, Codex, Grok, editors, terminals, and desktop
chats with enough context to produce correct software and little repeated
investigation. Optimize total tokens through accepted completion, including
checkpoint generation, rework and review. No token savings are claimed yet.

## Ownership and storage

One worktree normally belongs to one ticket and has one active code writer.
Jira holds work requirements; GitHub Issues holds personal requirements. Git
holds code and durable technical decisions. AGENTS.md holds short standing rules.
The local `.cairn/current.md` holds execution state. It is not a task board,
shared memory database, conversation archive, or source of authorization.

The first checkpoint creates `.cairn/.gitignore` containing `*`, without
editing project-level ignore rules. Each worktree owns its own directory. The
helper rejects a tracked or symlinked state directory. Ignoring is not access
control, and `git add -f` can still add ignored files.

## Record format

One UTF-8 Markdown file contains a JSON object in an initial HTML comment,
labeled `cairn`, and a human-readable body. JSON avoids a YAML dependency.
Schema 1 records revision,
ticket URL, timestamp, absolute worktree path, branch, HEAD, workspace fingerprint,
and a digest of the body. The JSON comment is local metadata, not normally fed
to the receiving agent; `resume` prints the body plus a small receipt on stderr.

The fingerprint covers tracked staged and unstaged diffs, status, and names,
modes and contents of nonignored untracked files. `.cairn` is excluded.
Ignored files, environment variables, dependencies, remote issue changes, and
nested submodule working-file contents are outside the fingerprint guarantee.
Matching fingerprints do not prove tests passed or requirements remain current.

## Commands and failure behavior

The executable is `cairn`.

- `checkpoint` reads an agent-authored draft and machine-collects Git facts.
  It requires the expected revision and refuses a different ticket identity.
- `status` reports identity, revision and changed state fields. Missing or invalid
  checkpoints are errors. Staleness is represented in the JSON `drift` list.
- `resume` refuses stale state unless `--allow-stale` explicitly requests reading
  for reconciliation. No body is printed on ordinary stale resume.
- `export` prints an explicitly dated, identified snapshot and drift information.
  It does not synchronize files, send messages, move code, or import native chats.

Writers use a local advisory lock and a revision comparison. A same-directory
temporary file is flushed, fsynced, and replaced atomically. Failed replacements
leave the prior record intact. This protects cooperating checkpoint writers,
not simultaneous code editors or hostile local processes. Power-loss durability
and network-filesystem lock semantics are not guaranteed by this prototype.

The helper checks the workspace twice before replacement to catch ordinary
concurrent edits. This is not a transactional snapshot of the repository: the
single-code-writer rule still applies. Manual body edits fail digest validation.
Hashes detect drift, not malicious modification or authorship.

## Context budget

The body target is 500–1,000 tokens. The prototype enforces a 12,000-byte UTF-8
ceiling, not an exact token limit. Oversize input fails rather than truncating.
Evidence is loaded by reference. No transcript ingestion, embeddings, automatic
recall, model calls, or network access is part of the core. Git fingerprinting
can take time on very large dirty worktrees even though it adds no model tokens.

## Platform and access

Node.js 20+ and Git; Linux and macOS initially. When `flock` from util-linux is
on `PATH`, writers lock `.cairn/write.lock` with it and hold that lock until the
process exits. Otherwise writers create the lock file exclusively and replace a
leftover file whose recorded process is gone. `CAIRN_LOCK=file` selects that
portable lock. Windows support requires a tested lock implementation before
being advertised.

`cairn install` merges user-level hooks and copies one checkpoint skill into
each of `~/.cursor`, `~/.claude`, and `~/.codex` that already exists. Session
start runs `cairn hook session-start` and injects a fresh body, or a short
stale refusal with drift field names. Stop runs `cairn hook stop` and emits one
reminder per drifted fingerprint. The skill calls `cairn template` and
`cairn checkpoint`. Hooks read the worktree from their stdin payload, fail open,
and do not select another worktree. MCP and remote publication stay deferred.

## Validation and next increments

Automated tests cover two worktrees, staged/unstaged/untracked drift, HEAD drift,
revision and ticket conflicts, concurrent checkpoint writers, failed replacement,
ignored evidence, exports, rejection of invalid storage paths, hook output, and
install merging disposable home directories.

Before claiming usefulness, run Claude → Codex → Grok on a real ticket and test
a desktop attachment handoff and another-machine transfer. Measure repeated
investigation, acceptance failures, and total tokens where hosts expose them.

Next: inspect the adapters with real agents, then tighten the format from those
results. Add Jira/GitHub publication adapters or MCP only when a tested workflow
needs them. Any external posting is explicit. Live vendor sessions are not yet
validated. CLI commands and `export` remain the interface for a host that cannot
hook.

No paid service or subscription may be required for the core handoff workflow.
