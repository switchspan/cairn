---
name: checkpoint
description: Saves or resumes the cairn checkpoint for this Git worktree's ticket. Use when the user asks to checkpoint or resume, after meaningful progress, or before switching agents.
---

# Cairn checkpoint

A checkpoint is the reported execution state of one ticket in one worktree. It carries what the next session needs: objective, current state, decisions, verification, next action.

Run commands from the ticket worktree. `CAIRN` below means the `scripts/cairn` file inside this skill's directory, as an absolute path, or plain `cairn` when that is on `PATH`.

## Checkpoint

1. Run `CAIRN status`. Its `revision` is N. When it reports no checkpoint, N is 0.
2. Run `CAIRN template` and fill each heading. Target 500–1,000 tokens. Point to evidence by file path or URL; keep logs, transcripts, specifications, and source code out of the body. Keep every constraint the next session needs.
3. Pipe the draft in:

   ```sh
   CAIRN checkpoint --expected-revision N <<'EOF'
   ...draft...
   EOF
   ```

   The ticket comes from the existing checkpoint or the branch name. When the command says it cannot infer the ticket, ask the user once for the issue URL or Jira key and rerun with `--ticket`.
4. Done when the command prints `Checkpoint N+1 for TICKET: PATH`. Tell the user that line.

A revision conflict means another writer saved first: run `CAIRN resume --allow-stale`, merge its content into your draft, and save against the revision it reports.

## Resume

Most hosts inject the checkpoint when the session starts. When it is absent from your context, run `CAIRN resume`.

When the checkpoint is marked DRIFT, or `resume` refuses with drift, run `CAIRN resume --allow-stale`, compare it with `git status` and `git diff`, and treat its Verification section as unconfirmed until rerun. Write a fresh checkpoint once reconciled.

Done when you can state the objective and the next action, and you have read only the files the next action needs.

## Boundaries

- One worktree holds one ticket and one active code writer. A checkpoint from another worktree is out of scope, even as a fallback.
- A checkpoint reports state. Deployment, publication, credential changes, and reopening deferred work each still need the user's authorization.
- Checkpoint after meaningful progress, a changed constraint, or before a switch, rather than after every tool call.
