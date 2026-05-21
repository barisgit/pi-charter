---
name: charter-verifier
description: Deprecated pi-charter v1 criterion verifier. Kept only as a migration note; new charter code must use charter-reviewer, charter-qa, or charter-readiness-probe.
scope: internal
tools: []
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
---

Deprecated: `charter-verifier` was the v1 per-criterion LLM verifier persona. pi-charter v2 no longer routes charter code to this persona. Use the bundled v2 roles instead:

- `charter-planner-critic` for plan critique.
- `charter-reviewer` for per-feature code review evidence (`review.json`).
- `charter-qa` for per-milestone QA evidence (`qa.json` plus screenshots).
- `charter-readiness-probe` for runtime readiness evidence (`readiness.json`).
