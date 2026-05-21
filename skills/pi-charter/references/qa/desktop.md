# Desktop QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture native desktop apps, OS UI, menus, dialogs, and flows that cannot be represented by browser or terminal artifacts.

## Recommended stack

Unverified starting stack: platform screenshot/video tools, then ffmpeg where a lower-level capture is needed.

```bash
# UNVERIFIED: macOS screenshot capture.
screencapture -x work/<feat>/evidence/<ts>/desktop.png
```

```bash
# UNVERIFIED: Linux Wayland screenshot/video fallbacks.
grim work/<feat>/evidence/<ts>/desktop.png
wf-recorder -f work/<feat>/evidence/<ts>/desktop.mp4
```

```bash
# UNVERIFIED: ffmpeg examples for macOS avfoundation or Linux X11.
ffmpeg -f avfoundation -i "1:none" -t 10 work/<feat>/evidence/<ts>/desktop.mp4
ffmpeg -f x11grab -i :0.0 -t 10 work/<feat>/evidence/<ts>/desktop.mp4
```

## Detection

Choose this recipe when the acceptance signal is visible in native OS chrome, app windows, or system dialogs.

```bash
# UNVERIFIED: detect common capture tools.
command -v screencapture || command -v wf-recorder || command -v grim || command -v scrot || command -v ffmpeg
```

## Graceful degradation

1. Native video plus screenshots.
2. Screenshots at key before/after states.
3. Written observation with exact app/window names and missing artifact rationale.

## Platform-specific notes

- macOS: `screencapture` is built in; ffmpeg avfoundation device ids vary by machine.
- Linux Wayland: prefer `wf-recorder` and `grim` when available.
- Linux X11: `scrot` and `ffmpeg -f x11grab` are common fallbacks.

## Anti-patterns

- Do not crop away window titles or dialog context needed to identify the surface.
- Do not rely on a verbal claim when the UI state is visible and capturable.
- Do not leave long videos untrimmed when a short clip proves the behavior.

## Out-of-scope

Browser DOM traces belong in `browser.md`; simulator or device captures belong in `mobile.md`.

## When to abandon and improvise

If OS permissions or headless execution block capture, record the command output and explain the permission or display limitation in `qa.md`.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when no desktop capture tool is available.
command -v screencapture || command -v wf-recorder || command -v grim || command -v scrot || command -v ffmpeg
```
