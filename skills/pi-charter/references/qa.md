# QA capture recipes

This shelf helps agents choose the right QA capture recipe for the surface under test. Start here, then open the referenced recipe for concrete capture commands, artifact expectations, and fallback guidance.

## What surface are you capturing?

- Terminal session, CLI tool, TUI, agent driving a shell -> qa/terminal.md
- Browser, web app, web TUI in headless browser -> qa/browser.md
- Native desktop app, OS UI, system dialog -> qa/desktop.md
- Mobile app, mobile web, simulator -> qa/mobile.md
- HTTP/REST/GraphQL API -> qa/http-api.md
- WebSocket / SSE / real-time -> qa/http-api.md#websocket-sse
- Database state, schema, query plans -> qa/database.md
- Server logs, processes, system metrics -> qa/logs-and-processes.md
- File changes, generated code, build outputs -> qa/generated-files.md
- Visual regression (before/after pixel diff) -> qa/visual-regression.md
- Reproducing the run (env, scripts) -> qa/reproducibility.md

## Shared conventions

- Artifacts inside QA evidence run dir: work/<feat>/evidence/<ts>/<filename>.
- Stable descriptive filenames (dashboard-after-login.png not screenshot1.png).
- Every artifact captured -> appears in BOTH qa.json artifacts[] AND qa.md.
- qa.md is human-readable narrative; qa.json is machine record.
- If recommended stack and graceful degradation both fail -> see 'When to abandon and improvise' section of the relevant recipe.

## Recipe status

| recipe | status | platform | date |
|---|---|---|---|
| qa/terminal.md | verified | macOS arm64 | 2026-05-21 |
| qa/browser.md | stub | n/a | n/a |
| qa/desktop.md | stub | n/a | n/a |
| qa/mobile.md | stub | n/a | n/a |
| qa/http-api.md | stub | n/a | n/a |
| qa/database.md | stub | n/a | n/a |
| qa/logs-and-processes.md | stub | n/a | n/a |
| qa/generated-files.md | stub | n/a | n/a |
| qa/visual-regression.md | stub | n/a | n/a |
| qa/reproducibility.md | stub | n/a | n/a |
