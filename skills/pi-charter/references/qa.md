# QA artifact capture quick reference

Use this only when a criterion needs concrete artifact capture. The evidence source of truth is still the `Evidence:` line in `.charters/<id>/charter.md`; files under `.charters/<id>/work/` are supporting artifacts.

## Shared rules

- Save artifacts in `.charters/<id>/work/` using stable names such as `c1-login-flow.webm`, `c2-api-response.txt`, or `c3-before-after.png`.
- Cite relative paths in Evidence notes: `work/c1-login-flow.webm`.
- Inspect every artifact before citing it. Open screenshots, replay recordings, read saved output.
- Capture artifacts during criterion verification, not while curating `REPORT.md`.
- Redact secrets, tokens, private payloads, and user data before saving or linking artifacts.

## Choose the strongest useful capture

- Browser/web app: Playwright trace/video/screenshots, browser automation screenshots, console/network excerpts.
- Native desktop or OS UI: short screen recording plus key screenshots.
- Terminal CLI or TUI: real PTY recording with `asciinema`, `script`, or tmux; for non-interactive commands, saved stdout/stderr is enough.
- HTTP/API: replayable request plus sanitized response body, headers when relevant, stream transcript for SSE/WebSocket.
- Database: schema/query/count output that demonstrates the state change, with sensitive values redacted.
- Logs/processes: relevant log excerpt plus the action that produced it; include process health output when lifecycle matters.
- Generated files/build output: the generated artifact, checksum or diff when helpful, and the command output that produced it.
- Visual changes: before/after screenshots or a visual diff, with enough context to identify the surface.

## Minimal command patterns

```bash
# Browser trace/video/screenshots when the repo already has Playwright.
bunx playwright test <focused-spec> --trace on --video on --screenshot on

# Save API output.
mkdir -p .charters/<id>/work
curl -i http://localhost:3000/health | tee .charters/<id>/work/c1-health.txt

# Save non-interactive command output.
bun test 2>&1 | tee .charters/<id>/work/c2-tests.txt

# Record a terminal session when interactive behavior matters.
asciinema rec .charters/<id>/work/c3-tui.cast
```

## Evidence note examples

```markdown
Evidence: pass — drove checkout in local browser; confirmation showed order id; recording: work/c1-checkout.webm (2026-07-02)
Evidence: pass — curl returned 201 with created id and persisted row count 1; output: work/c2-api-create.txt (2026-07-02)
Evidence: pass — focused unit and integration checks pass for parser behavior; output: work/c3-tests.txt (2026-07-02)
```
