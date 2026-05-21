# Browser QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture browser, web app, and browser-driven TUI behavior with replayable traces plus human-readable screenshots and logs.

## Recommended stack

Unverified starting stack: Playwright trace + video + screenshots + console log + accessibility snapshot.

```bash
# UNVERIFIED: capture trace, video, screenshots, and console events from a Playwright test.
bunx playwright test tests/browser-smoke.spec.ts --trace on --video on --screenshot on
```

```bash
# UNVERIFIED: open the trace artifact for review.
bunx playwright show-trace work/<feat>/evidence/<ts>/trace.zip
```

```bash
# UNVERIFIED: run a focused accessibility check from the same browser harness.
bunx playwright test tests/a11y-smoke.spec.ts --project=chromium
```

## Detection

Prefer this recipe when the target URL or UI can be driven by Playwright, Puppeteer, or a real browser session.

```bash
# UNVERIFIED: quick local capability check.
command -v bun >/dev/null && bunx playwright --version
```

## Graceful degradation

1. Playwright trace + video + screenshots + console log.
2. Screenshots and copied console/network output only.
3. Plain terminal transcript of the browser-driving command.

## Platform-specific notes

- macOS: Playwright-managed Chromium is usually enough for headless capture.
- Linux: install browser dependencies before running headed tests in CI.
- Windows/WSL: keep artifacts on the Linux filesystem when using WSL browsers.

## Anti-patterns

- Do not attach only a final screenshot when the failure depends on navigation history.
- Do not omit console errors or accessibility findings from `qa.md`.
- Do not record credentials, cookies, or full auth headers in shared artifacts.

## Out-of-scope

Native desktop UI belongs in `desktop.md`. HTTP-only checks belong in `http-api.md`.

## When to abandon and improvise

If no browser harness can drive the surface, capture manual screenshots and logs, then state the reduced fidelity in `qa.md`.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when Playwright is unavailable.
bunx playwright --version >/dev/null
```
