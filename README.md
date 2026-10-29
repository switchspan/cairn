# cairn

Compact, local checkpoints for one ticket per Git worktree. Switch coding agents
without loading the previous conversation. MIT licensed; no service, account,
subscription, model API, or third-party runtime dependency required.

**Initial prototype.** CLI behavior is tested in disposable Git repositories.
Cross-vendor integrations and token savings have not yet been validated.

## Requirements

Node.js 20+, Git, and Linux or macOS.

## Install

From this repository:

```sh
npm install
npm install -g .
```

That puts `cairn` on your `PATH`. In a ticket worktree:

```sh
cairn resume
```

## Quick start

Keep this repository separate from the ticket worktree. Write a checkpoint draft
using [the template](templates/checkpoint.md). The draft is the outgoing agent's
concise account of the task, decisions, verification, and next action.

```sh
cairn --cwd /path/to/ticket-worktree checkpoint \
  --ticket https://github.com/OWNER/REPO/issues/142 \
  --file /tmp/checkpoint-draft.md --expected-revision 0

cairn --cwd /path/to/ticket-worktree resume
```

Use a Jira issue URL for work tickets. The URL is an identifier; this tool does
not fetch or post to either service. After the first checkpoint, use `status`
to read the revision and supply it as `--expected-revision` when replacing it.
`--file` resolves relative to the shell invocation directory, not `--cwd`.

```sh
cairn --cwd /path/to/ticket-worktree status
cairn --cwd /path/to/ticket-worktree resume --allow-stale
cairn --cwd /path/to/ticket-worktree export > /tmp/ticket-handoff.md
```

`resume` refuses stale code state by default. `--allow-stale` lets an agent read
the checkpoint to reconcile it; it does not certify old test results. Exports
are snapshots for attachment or transfer, and do not contain the actual code
changes. They may include local paths and user-written confidential information;
the prototype does not redact secrets automatically.

The checkpoint lives in `.cairn/current.md` within that worktree and is locally
ignored by Git. Large logs can live in `.cairn/evidence/` and be read on demand.
Keep one active code writer per worktree and checkpoint meaningful changes before
switching. A desktop chat needs filesystem access or an attached export.

## Development

```sh
npm test
git diff --check
```

Read [the design](DESIGN.md), [agent protocol](docs/agent-protocol.md), and
[research notes](docs/research.md). No remote repository has been created as part
of the initial local setup.
