# Reproducibility QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture enough environment and script detail for another agent or reviewer to rerun the evidence path.

## Recommended stack

Unverified starting stack: `env.txt` for environment metadata and `repro.sh` for exact rerun steps.

```bash
# UNVERIFIED: capture basic environment metadata.
{
  date -u
  uname -a
  git rev-parse --short HEAD
  bun --version
} > work/<feat>/evidence/<ts>/env.txt
```

```bash
# UNVERIFIED: create a rerunnable script skeleton.
cat > work/<feat>/evidence/<ts>/repro.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
bun install
bun test tests/example.test.ts
SH
chmod +x work/<feat>/evidence/<ts>/repro.sh
```

## Detection

Use this recipe whenever the important claim should be independently repeatable, especially for multi-command QA.

```bash
# UNVERIFIED: detect minimum reproducibility tooling.
command -v bash && command -v git && command -v bun
```

## Graceful degradation

1. `env.txt` + executable `repro.sh`.
2. `env.txt` + copied command transcript.
3. Human-readable rerun notes with missing tool/version caveats.

## Platform-specific notes

- macOS/Linux: include OS, architecture, shell, runtime, and git revision.
- CI: include job URL or runner image when available.
- Secrets: list required variable names without values.

## Anti-patterns

- Do not write a repro script that depends on unmentioned local state.
- Do not include secret environment values in `env.txt`.
- Do not claim reproducibility without pinning the command sequence.

## Out-of-scope

Surface-specific screenshots, traces, and logs belong in the matching recipe; this recipe only ties rerun context together.

## When to abandon and improvise

If the run cannot be made reproducible, document the irreproducible dependency and preserve the best available environment transcript.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when required shell/runtime tools are unavailable.
command -v bash >/dev/null && command -v git >/dev/null && command -v bun >/dev/null
```
