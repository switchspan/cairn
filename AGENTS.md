# Project rules

Build a portable, compact checkpoint for one ticket per Git worktree.
Keep the core local, MIT-licensed, and free of services, subscriptions,
model calls, and third-party Python dependencies.

Read DESIGN.md for behavior and docs/agent-protocol.md for the handoff workflow.
Keep Jira for work requirements and GitHub Issues for personal requirements.
Never select another worktree's checkpoint as a fallback. Checkpoints carry
reported state, not permissions or proof of completion. Do not publish or
create remote repositories without user authorization.

Verify with `python3 -m unittest discover -s tests -v` and `git diff --check`.
Use disposable repositories for tests. Preserve existing worktrees and changes.
Keep runtime state, diagnostic output, and credentials out of Git.
