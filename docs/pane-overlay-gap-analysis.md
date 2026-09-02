# paneOverlay migration status — pi-charter

Status: superseded. The original gap analysis was written against `pi-extension-utils` 0.3.2 and no longer describes the live implementation.

pi-charter now depends on `pi-extension-utils` 0.7.6 and `CharterPickerComponent` has been replaced by `createCharterPickerOverlay()` in `src/ui/charter-picker.ts`. The picker uses `paneOverlay()` directly, including its primary info zone, width-aware row rendering, separator rows, structured title tails, initial selection key, and render lifecycle hook.

The `/charters` command in `src/application/registration.ts` opens that picker through the real utils `connect(...).ui.fullscreen(...)` client path. `tests/registration.test.ts` covers the wiring with a fake fullscreen viewport TUI and verifies that the picker replaces the viewport layout root, then invalidates and restores the exact prior root when it closes.

The former recommendation to defer migration is therefore retired; there is no remaining migration blocker tracked by this document.
