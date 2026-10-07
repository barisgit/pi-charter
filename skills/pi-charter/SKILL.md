---
name: pi-charter
description: "Create, inspect, pause, resume, complete, or abandon a durable Pi charter that keeps an authorized Objective available across idle continuation, compaction, and handoff. Use for multi-turn resumable work or explicit charter requests; skip quick fixes and tactical todo lists."
---

# pi-charter

A charter is a quiet backstop for long, resumable work: it keeps the user's authorized Objective on disk and restates it only when you go idle. It is not a plan or checklist. Work normally for quick fixes, and keep steps in pi-dag-tasks.

```ts
charter({ action: "create" | "list" | "status" | "pause" | "resume" | "complete" | "abandon", id?, objective?, note? })
```

Follow the returned `nextActions[]`. A session has at most one active or paused charter; complete or abandon it before creating another.

## The Objective

Pass the full authorized outcome as `objective`, in the user's words: intent, constraints, verification expectations, and requested deliverables. It must survive compaction and handoff without the conversation. Never summarize, change, or narrow it. Add detail only when the user authorized it; when the user adds a lasting constraint mid-work, write it into `.charters/<id>/charter.md` promptly.

Add `## References` for durable sources of authority and `## Scope` for authorized boundaries only when they help. Put any other notes under `## Notes`; they are optional and Charter does not interpret them.

## Ralph

When you and async subagents are idle, Ralph restates the Objective so you can continue or finish. A recovery prompt means the loop is repeating: check what is blocking you and change approach, or pause for a user decision. After a guard pause, only the user's `/charter resume` resets it; do not try to bypass it with the tool.

## Complete

Complete when you judge the Objective met after checking its constraints, verification expectations, and References. Verify the real result yourself; the charter does not. Give a concise `note` stating why it is met. Write `REPORT.md` or other deliverables only when the Objective asks for them.

A `file-interface` charter is read-only history; start a new charter to continue its work.
