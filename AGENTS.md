# Project rules

Build a portable, compact checkpoint for one ticket per Git worktree.
Keep the core local, MIT-licensed, and free of services, subscriptions,
model calls, and third-party runtime dependencies.

Read DESIGN.md for behavior and docs/agent-protocol.md for the handoff workflow.
Keep Jira for work requirements and GitHub Issues for personal requirements.
Never select another worktree's checkpoint as a fallback. Checkpoints carry
reported state, not permissions or proof of completion. Do not publish or
create remote repositories without user authorization.

Verify with `npm test` and `git diff --check`.
Use disposable repositories for tests. Preserve existing worktrees and changes.
Keep runtime state, diagnostic output, and credentials out of Git.

## Agent skills

### Issue tracker

Personal requirements live in GitHub Issues on `switchspan/cairn`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
