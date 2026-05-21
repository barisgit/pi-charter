# Logs and processes QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture server logs, process lifecycles, resource usage, live tails, and long-running command output.

## Recommended stack

Unverified starting stack: `tail`, journald, `/usr/bin/time -v`, and `tmux pipe-pane`.

```bash
# UNVERIFIED: capture an application log tail.
tail -n 200 -f app.log | tee work/<feat>/evidence/<ts>/app-tail.txt
```

```bash
# UNVERIFIED: capture systemd logs for a service.
journalctl -u my-service --since "10 minutes ago" > work/<feat>/evidence/<ts>/journal.txt
```

```bash
# UNVERIFIED: capture resource usage and tmux pane output.
/usr/bin/time -v bun test 2>&1 | tee work/<feat>/evidence/<ts>/time.txt
tmux pipe-pane -o -t qa:0.0 "cat > work/<feat>/evidence/<ts>/pane.log"
```

## Detection

Use this recipe when the useful evidence is emitted over time by processes rather than a single command result.

```bash
# UNVERIFIED: detect common log/process capture tools.
command -v tail && (command -v journalctl || command -v tmux || command -v time)
```

## Graceful degradation

1. Structured logs plus resource metrics.
2. Plain `tee` transcript around the action under test.
3. Final command output with process ids and timestamps noted manually.

## Platform-specific notes

- macOS: `/usr/bin/time -l` differs from GNU `/usr/bin/time -v`.
- Linux: journald access may require permissions or service names.
- tmux: start pipe capture before driving the pane to avoid missing early output.

## Anti-patterns

- Do not paste unbounded logs without trimming to the relevant window.
- Do not omit timestamps when ordering matters.
- Do not leak secrets from environment dumps or verbose logs.

## Out-of-scope

Terminal UI recordings belong in `terminal.md`; API traffic belongs in `http-api.md`.

## When to abandon and improvise

If logs are inaccessible, capture the supervising command output and state which log source was unavailable.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when no basic log capture command is available.
command -v tail >/dev/null
```
