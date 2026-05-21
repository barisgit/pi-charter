#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: scripts/charter-named-test.sh <test-file> <phrase>" >&2
  exit 2
fi

test_file="$1"
phrase="$2"

set +e
output="$(bun test "$test_file" -t "$phrase" 2>&1)"
status=$?
set -e

pass_count="$(printf '%s\n' "$output" | awk '/^[[:space:]]*[0-9]+[[:space:]]+pass$/ { count = $1 } END { print count + 0 }')"
fail_count="$(printf '%s\n' "$output" | awk '/^[[:space:]]*[0-9]+[[:space:]]+fail$/ { count = $1 } END { print count + 0 }')"

if [[ "$fail_count" -ne 0 ]]; then
  printf '%s\n' "$output" >&2
  exit 1
fi

if [[ "$pass_count" -eq 0 ]]; then
  printf '%s\n' "$output" >&2
  echo "0 tests matched phrase: $phrase" >&2
  exit 1
fi

if [[ "$status" -ne 0 ]]; then
  printf '%s\n' "$output" >&2
  exit "$status"
fi

printf '%s\n' "$output"
