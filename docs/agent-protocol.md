# Agent handoff protocol

The Claude Code plugin, and `cairn install` for Codex and Cursor, add a
session-start hook and the checkpoint skill. The hook injects the current
checkpoint, under a `DRIFT` banner when the code has changed since. The skill
writes the next one, and resumes on request where no hook can inject, as in
Grok Build. Use the steps below when a host has neither.

A desktop chat without local filesystem access needs an exported attachment; a
file path alone does not grant access.

## Resume

1. Select the ticket's exact worktree. Read the project's standing instructions.
2. Run `cairn --cwd /path/to/worktree resume`.
3. If the checkpoint is stale, inspect it with `cairn resume --allow-stale`, reconcile
   the actual diff and recorded evidence, and update the checkpoint before
   relying on old verification. Never use a different worktree as a fallback.
4. Load the listed files and requirements only as needed for the next action.
5. Continue the authorized task. A checkpoint does not authorize deployment,
   publication, credential changes, or reopening explicitly deferred work.

## Checkpoint

1. Stop other writers to this worktree. Use `cairn status` to obtain the current revision;
   use revision 0 only when no checkpoint exists.
2. Write a concise Markdown draft using the template. Target 500–1,000 tokens;
   preserve necessary constraints even if that target is exceeded. Reference
   evidence instead of copying logs, transcripts, specifications, or source code.
3. Pipe the draft to `cairn checkpoint --expected-revision N`, or pass
   `--file DRAFT`. Add `--ticket URL|KEY` only when the command cannot infer
   the ticket from the branch.
4. Keep the revision receipt. If there is a conflict, read the new checkpoint
   and reconcile it; never blindly retry with a higher revision.

Checkpoint after meaningful progress, a changed constraint, or before a switch.
Do not rewrite it after every tool call. An unexpected crash can lose context
since the last checkpoint; Git changes alone cannot reconstruct intent.

## Transfer

For the same worktree, the receiving agent uses `resume`. For another machine or
an app without local access, use `export` and supply that snapshot explicitly.
Transfer the code separately through an available commit or patch. Review the
export for confidential content before attaching it or posting it to a ticket.

The receiver verifies repository identity, branch, commit and unfinished changes.
Do not copy `current.md` into another worktree and assume it is fresh. Reconcile
the exported snapshot and write a new local checkpoint. Preserve lasting design
decisions in project documents before deleting a ticket worktree.
