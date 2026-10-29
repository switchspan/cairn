---
name: cairn
description: Use it to write the local cairn checkpoint before switching agents or after meaningful progress.
---

# Cairn checkpoint

Write the checkpoint for this worktree. A fresh note is already injected when a session starts.

1. Run `cairn status` in this worktree. Use revision 0 only when that command reports that no checkpoint exists.
2. Run `cairn template` and fill that Markdown. Target 500–1,000 tokens. Reference evidence instead of copying logs, transcripts, specifications, or source code. Preserve necessary constraints.
3. Run `cairn checkpoint --ticket URL --file DRAFT --expected-revision N`. Use the ticket URL from the status receipt, or the worktree's Jira or GitHub issue URL when creating the first checkpoint. `--file` is relative to the invocation directory.

Keep one active code writer for this worktree. A revision conflict means read the new checkpoint and reconcile it. Do not retry with a higher revision. Do not use another worktree's checkpoint. A checkpoint does not authorize deployment, publication, credential changes, or reopening explicitly deferred work.

Checkpoint after meaningful progress, a changed constraint, or before a switch.
