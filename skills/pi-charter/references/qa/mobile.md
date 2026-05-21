# Mobile QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture mobile app, mobile web, iOS simulator, Android emulator, or attached-device evidence.

## Recommended stack

Unverified starting stack: `xcrun simctl` for iOS Simulator and `adb screenrecord` / `adb screencap` for Android.

```bash
# UNVERIFIED: iOS Simulator screenshot and video.
xcrun simctl io booted screenshot work/<feat>/evidence/<ts>/ios.png
xcrun simctl io booted recordVideo work/<feat>/evidence/<ts>/ios.mp4
```

```bash
# UNVERIFIED: Android screenshot and video.
adb exec-out screencap -p > work/<feat>/evidence/<ts>/android.png
adb shell screenrecord /sdcard/qa.mp4 && adb pull /sdcard/qa.mp4 work/<feat>/evidence/<ts>/android.mp4
```

## Detection

Use this recipe when a mobile viewport, device sensor state, app install, or simulator behavior is part of the claim.

```bash
# UNVERIFIED: discover available mobile capture tooling.
command -v xcrun || command -v adb
```

## Graceful degradation

1. Simulator/device video plus screenshot.
2. Screenshot after each critical state transition.
3. CLI logs with device id, app build, and manual observation notes.

## Platform-specific notes

- macOS: iOS Simulator capture requires Xcode command line tools.
- Android: `adb devices` must show the target before capture commands work.
- CI: simulator boot and recording may need explicit cleanup between runs.

## Anti-patterns

- Do not capture an unspecified device; include simulator/device name and OS version in `qa.md`.
- Do not leave the screen locked or notification shade covering the app state.
- Do not assume desktop browser responsive mode proves native app behavior.

## Out-of-scope

Desktop-native windows belong in `desktop.md`; HTTP-only mobile backend checks belong in `http-api.md`.

## When to abandon and improvise

If no simulator or device is available, record the missing-device condition and use the closest lower-fidelity artifact with explicit caveats.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when neither iOS nor Android tooling is available.
command -v xcrun || command -v adb
```
