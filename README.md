# worktree-handoff

Compact, local checkpoints for one ticket per Git worktree. Switch coding agents
without loading the previous conversation. MIT licensed; no service, account,
subscription, model API, or third-party Python package required.

**Initial prototype.** CLI behavior is tested in disposable Git repositories.
Cross-vendor integrations and token savings have not yet been validated.

## Requirements

Python 3.11+, Git, and Linux or macOS. Run the script directly; no installation
or modification of agent configuration is necessary.

## Quick start

Keep this repository separate from the ticket worktree. Write a checkpoint draft
using [the template](templates/checkpoint.md). The draft is the outgoing agent's
concise account of the task, decisions, verification, and next action.

```sh
python3 ~/Projects/personal/worktree-handoff/handoff.py \
  --cwd /path/to/ticket-worktree checkpoint \
  --ticket https://github.com/OWNER/REPO/issues/142 \
  --file /tmp/checkpoint-draft.md --expected-revision 0

python3 ~/Projects/personal/worktree-handoff/handoff.py \
  --cwd /path/to/ticket-worktree resume
```

Use a Jira issue URL for work tickets. The URL is an identifier; this tool does
not fetch or post to either service. After the first checkpoint, use `status`
to read the revision and supply it as `--expected-revision` when replacing it.
`--file` resolves relative to the shell invocation directory, not `--cwd`.

```sh
python3 handoff.py --cwd /path/to/ticket-worktree status
python3 handoff.py --cwd /path/to/ticket-worktree resume --allow-stale
python3 handoff.py --cwd /path/to/ticket-worktree export > /tmp/ticket-handoff.md
```

`resume` refuses stale code state by default. `--allow-stale` lets an agent read
the checkpoint to reconcile it; it does not certify old test results. Exports
are snapshots for attachment or transfer, and do not contain the actual code
changes. They may include local paths and user-written confidential information;
the prototype does not redact secrets automatically.

The checkpoint lives in `.handoff/current.md` within that worktree and is locally
ignored by Git. Large logs can live in `.handoff/evidence/` and be read on demand.
Keep one active code writer per worktree and checkpoint meaningful changes before
switching. A desktop chat needs filesystem access or an attached export.

## Development

```sh
python3 -m unittest discover -s tests -v
git diff --check
```

Read [the design](DESIGN.md), [agent protocol](docs/agent-protocol.md), and
[research notes](docs/research.md). No remote repository has been created as part
of the initial local setup.
