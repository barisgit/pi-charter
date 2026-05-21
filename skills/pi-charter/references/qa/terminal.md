# Terminal QA capture recipe

## What this is for

Use this recipe when QA needs replayable evidence for a terminal session: a CLI command, shell workflow, TUI, or agent running inside a real PTY. The goal is to preserve what the operator saw, keep a machine-readable asciicast when possible, and provide a lightweight GIF for PR review.

## Recommended stack — verified

Verified on macOS arm64 with `tmux`, `asciinema 3.2.0`, `agg 1.8.1`, and `ffmpeg` available. The successful run drove `pi --no-session` inside tmux so the recorder had a real PTY and Pi did not create a session sidecar.

```bash
which tmux
which asciinema
which agg
which ffmpeg

mkdir -p /tmp/v2-1-demo/2026-05-21T15-51-16Z-interactive
cd /tmp/v2-1-demo/2026-05-21T15-51-16Z-interactive

tmux new-session -d -s qa-pi -x 100 -y 30 \
  "asciinema rec terminal.cast --command 'pi --no-session'"
sleep 6
tmux send-keys -t qa-pi 'count to 3' Enter
sleep 15
tmux send-keys -t qa-pi '/exit' Enter
sleep 3
tmux send-keys -t qa-pi C-d
sleep 1
tmux send-keys -t qa-pi C-d
tmux kill-session -t qa-pi

agg --theme monokai terminal.cast terminal.gif
ffmpeg -y -i terminal.gif -movflags faststart terminal.mp4
asciinema convert terminal.cast terminal.txt
```

Observed artifact sizes from the verified run: `terminal.cast` 64KB, `terminal.gif` 300KB, `terminal.mp4` 225KB, and `terminal.txt` 2.7KB. Commit `terminal.cast` when replay fidelity matters, attach `terminal.gif` when reviewers need quick visual context, and include `terminal.txt` only when text search or copy/paste is useful.

## Detection

```bash
if command -v tmux >/dev/null 2>&1 && \
   command -v asciinema >/dev/null 2>&1 && \
   command -v agg >/dev/null 2>&1 && \
   command -v ffmpeg >/dev/null 2>&1; then
  STACK=terminal-full
elif command -v asciinema >/dev/null 2>&1; then
  STACK=asciinema-only
elif command -v script >/dev/null 2>&1; then
  STACK=script-typescript
else
  STACK=plain-tee
fi
printf 'STACK=%s\n' "$STACK"
```

Use `which asciinema`, `which agg`, `which tmux`, and `which ffmpeg` in the QA note so reviewers can distinguish a verified capture from a degraded one.

## Graceful degradation

1. `asciinema` + `agg`: record `terminal.cast`, regenerate `terminal.gif` with `agg --theme monokai terminal.cast terminal.gif`, and optionally create `terminal.mp4` with `ffmpeg`.
2. `asciinema` only: record `terminal.cast` and attach it directly. Convert to text with `asciinema convert terminal.cast terminal.txt` if reviewers cannot replay casts.
3. `script(1)` typescript: run `script -q terminal.typescript`, perform the workflow, exit the shell, and attach the raw typescript plus a short summary.
4. Plain `tee` plus ANSI stripping: run the non-interactive command through `tee terminal.raw`, then produce `terminal.txt` with an ANSI-stripper such as `perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g' terminal.raw > terminal.txt`.

## Platform notes

### macOS

Install the verified stack with Homebrew:

```bash
brew install tmux asciinema agg ffmpeg
```

Run captures from a normal Terminal/iTerm tab or a tmux session. If a command behaves differently under fish/zsh/bash, note the shell in the QA narrative.

### Linux

Install the base tools with apt, then install `agg` from the package source available for the distro if it is not packaged:

```bash
sudo apt update
sudo apt install -y tmux asciinema ffmpeg
```

Prefer a tmux wrapper even on Linux CI so the tool under test sees a stable PTY size.

### Windows (WSL)

Use WSL for terminal captures. Install Linux packages inside the distro, run tmux inside WSL, and copy artifacts out through the mounted workspace only after recording completes.

## Anti-patterns

- `asciinema cat` is broken in 3.x for this workflow; use `asciinema convert terminal.cast terminal.txt` when a text transcript is needed.
- Running Pi without `--no-session` creates a sidecar session and pollutes the QA artifact directory. Use `pi --no-session` for throwaway captures.
- Running terminal QA without a PTY, for example print-mode command capture, can produce the headless warning instead of the interactive UI. Use tmux or another real PTY when validating TUI behavior.
- Do not stop after `/exit` alone. Pi/asciinema often needs a two-layer Ctrl-D exit dance: send `/exit`, then `C-d` to close Pi, then another `C-d` to let the recorder shell finish.

## Out-of-scope

Browser-hosted terminals and web TUIs captured through Chrome belong in `browser.md`. Non-TUI process tails, logs, metrics, and daemon health checks belong in `logs-and-processes.md`.

## When to abandon and improvise

If the recommended stack and every graceful fallback fail, paste plain command output into the QA note, describe exactly what could not be captured, and note the fidelity reduction in `qa.md`. Prefer an honest low-fidelity artifact over a fabricated replay.

## Smoke command

```bash
command -v asciinema >/dev/null && command -v agg >/dev/null && command -v tmux >/dev/null && command -v ffmpeg >/dev/null
```
