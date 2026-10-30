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

- `checkpoint` reads an agent-authored draft from `--file` or standard input
  and machine-collects Git facts. It requires the expected revision and refuses
  a different ticket identity. A ticket is an issue URL or a bare Jira key. The
  existing checkpoint's ticket wins; a first checkpoint without `--ticket`
  infers one from the branch (a Jira key, or a GitHub issue number resolved
  against a `github.com` `origin`) and otherwise fails.
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

The skill folder `skills/checkpoint` is the portable unit
([ADR 0002](docs/adr/0002-ship-the-cli-inside-the-skill-folder.md)): it holds
`SKILL.md`, the template, the committed CLI build, and `scripts/cairn`, a POSIX
shell wrapper. Without Node.js 20+, the wrapper makes a session-start hook
inject a one-line notice, keeps stop hooks silent, and fails other commands.

Each host gets an adapter. Claude Code installs this repository as a plugin and
its own marketplace; the plugin's hooks run the wrapper, and `bin/cairn` puts
the CLI on the agent's `PATH`. `cairn install` copies the skill to
`~/.agents/skills/cairn`, which Codex, Cursor, and Grok Build read, and merges
hooks into `~/.codex/hooks.json` and `~/.cursor/hooks.json` that run the
installed wrapper. Grok Build documents no session-start context injection, so
it gets the skill only and the user asks it to resume. Install also removes the
`~/.claude` hooks and per-host skill copies written by earlier versions.

Session start runs `cairn hook session-start`. It injects a fresh body, or a
drifted body under a `DRIFT` banner naming the fields
([ADR 0001](docs/adr/0001-inject-drifted-checkpoint-at-session-start.md)).
Without a checkpoint, it names the inferred ticket on a ticket branch and stays
silent elsewhere. Stop runs `cairn hook stop` and, where a checkpoint exists,
shows the user one notice per drifted fingerprint through `systemMessage`. The
notice leaves the agent's turn finished. Cursor's only stop output submits a
new user turn, so Cursor gets no stop notice. Hooks read the worktree
from their stdin payload, fail open, and do not select another worktree. MCP
and remote publication stay deferred.

## Validation and next increments

Automated tests cover two worktrees, staged/unstaged/untracked drift, HEAD drift,
revision and ticket conflicts, concurrent checkpoint writers, failed replacement,
ignored evidence, exports, rejection of invalid storage paths, ticket inference,
stdin drafts, hook output, the plugin hooks, the wrapper with and without Node,
the committed build matching `src`, and install merging disposable home
directories.

Before claiming usefulness, run Claude → Codex → Grok on a real ticket and test
a desktop attachment handoff and another-machine transfer. Measure repeated
investigation, acceptance failures, and total tokens where hosts expose them.

Next: inspect the adapters with real agents, then tighten the format from those
results. Add Jira/GitHub publication adapters or MCP only when a tested workflow
needs them. Any external posting is explicit. Live vendor sessions are not yet
validated. CLI commands and `export` remain the interface for a host that cannot
hook.

No paid service or subscription may be required for the core handoff workflow.
