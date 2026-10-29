# Research and adoption decision

Checked October 29, 2026. Counts are a dated snapshot of GitHub API results,
not evidence of effectiveness. Sources were inspected, not installed or benchmarked.

| Project | Stars | Assessment |
| --- | ---: | --- |
| [Entire CLI](https://github.com/entireio/cli) | 5,266 | Established adjacent tool; session capture and history are broader than this checkpoint workflow. |
| [agent-session-resume](https://github.com/hacktivist123/agent-session-resume) | 242 | MIT recovery skill; reconstructing context from transcripts adds reading. |
| [context-bridge](https://github.com/serdardb/context-bridge) | 5 | Developer preview; native session switching and worktree options. |
| [agent-handoff-skills](https://github.com/orzilca/agent-handoff-skills) | 1 | Small shared-directory handoff implementation with little adoption evidence. |
| [handoff-skill](https://github.com/klittle32/handoff-skill) | 0 | Useful focused-handoff example; temporary-file defaults do not provide durable transfer. |

[Kontinuo releases](https://github.com/pullbase/kontinuo-releases) explicitly
describe binary-only distribution and a private source repository. It is excluded
because public source and an open-source license are requirements. Pricing was
not established and is unnecessary to that exclusion.

The inspected [Entire handoff skill](https://github.com/entireio/skills/blob/main/skills/session-handoff/SKILL.md)
falls back to an unscoped session list when worktree filtering finds no matches.
This prototype instead requires an exact local checkpoint and reports absence.

Decision: build a small independent prototype, named cairn, to evaluate the
file contract and Git-state checks. No third-party implementation has been copied into this repo.
Reassess adoption after a real cross-agent trial; avoid building a memory platform.
