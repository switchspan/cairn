# cairn

Compact, local continuity for one ticket per Git worktree, so a new agent
session can continue work without loading the previous conversation.

## Language

### Work

**Ticket**:
The single unit of requested work a worktree belongs to, identified by an issue URL or a bare Jira key.
_Avoid_: Task, issue (when meaning the work itself), story

**Checkpoint**:
The latest reported execution state of one ticket in one worktree: objective, current state, decisions, verification, and next action.
_Avoid_: Memory, notes, handoff file, summary

**Drift**:
Difference between the worktree's code state now and the state recorded when the checkpoint was written.
_Avoid_: Staleness (as a noun for the cause), out-of-date

### Agents

**Host**:
The agent program a person works in, such as Claude Code, Codex, or Cursor.
_Avoid_: Agent, tool, client, app

**Session**:
One conversation inside a host, bound to exactly one worktree.
_Avoid_: Chat, thread, conversation

**Adapter**:
The host-specific wiring, hooks plus the installed skill, that connects one host to cairn.
_Avoid_: Integration, plugin (reserved for Claude Code's packaged form of the adapter)

**Handoff**:
One session ending and a later session resuming the same worktree's checkpoint, in the same or a different host.
_Avoid_: Switch, transfer (reserved for moving an export off the machine)
