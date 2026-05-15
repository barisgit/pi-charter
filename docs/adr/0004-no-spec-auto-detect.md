# Do not auto-detect or copy spec files

Status: accepted

Creation takes only `{objective, budget?, idempotencyKey?}`; there is no `contractPath`, `charterPath`, `--charter-spec`, or spec auto-copy mode. Spec files are ordinary project files that the agent reads because the prompt says to use them; if an orchestrator has already produced a real charter, it writes `<charterDir>/charter.md` directly before spawn and file presence is the signal.
