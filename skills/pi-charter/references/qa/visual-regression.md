# Visual regression QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture before/after visual differences for UI surfaces where pixel-level comparison is the useful proof.

## Recommended stack

Unverified starting stack: `pixelmatch` for direct image diffs and `reg-cli` for visual regression reports.

```bash
# UNVERIFIED: run a pixelmatch comparison through a small project script.
bun run scripts/pixelmatch.ts before.png after.png work/<feat>/evidence/<ts>/diff.png
```

```bash
# UNVERIFIED: create a reg-cli report.
bunx reg-cli work/<feat>/before work/<feat>/after work/<feat>/evidence/<ts>/reg-report -R work/<feat>/evidence/<ts>/reg-report.html
```

## Detection

Use this recipe when before/after image comparison is stronger than a standalone screenshot.

```bash
# UNVERIFIED: detect visual regression tooling.
bunx reg-cli --version || node -e "require.resolve('pixelmatch')"
```

## Graceful degradation

1. Pixel diff with threshold and before/after images.
2. Side-by-side screenshots with changed regions called out.
3. Manual screenshot review with explicit note that no diff tool ran.

## Platform-specific notes

- macOS/Linux: stabilize fonts, viewport, device scale factor, and animation state before diffing.
- CI: keep baseline and actual images in deterministic paths.
- Browser captures: pair this with `browser.md` when the source images come from Playwright.

## Anti-patterns

- Do not compare screenshots taken at different viewport sizes.
- Do not ignore antialiasing, font, clock, cursor, or animation noise.
- Do not call a visual diff pass without preserving before, after, and diff artifacts.

## Out-of-scope

Browser trace capture belongs in `browser.md`; native desktop capture setup belongs in `desktop.md`.

## When to abandon and improvise

If image diffs are unstable, preserve before/after screenshots and document the instability source in `qa.md`.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when reg-cli cannot be resolved.
bunx reg-cli --version >/dev/null
```
