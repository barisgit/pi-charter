# Store charter state in the project filesystem and bind sessions explicitly

Status: accepted

Charter state lives under `<project>/.pi/charters/<charterId>/` rather than only in Pi session entries or a global home directory. A root session binds through both `state.json.sessionId` and `~/.pi/agent/sessions/<sid>/charter.json`, while subagents receive charter scope through metadata; this supports project-local durability, worktrees, compaction, and explicit resume without making tactical tasks or subagents own charter binding.
