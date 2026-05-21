#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 1 ]]; then
  test_file=""
  phrase="$1"
elif [[ $# -eq 2 ]]; then
  test_file="$1"
  phrase="$2"
else
  echo "Usage: scripts/charter-named-test.sh [<test-file>] <phrase>" >&2
  exit 2
fi

set +e
if [[ -n "$test_file" ]]; then
  output="$(bun test "$test_file" -t "$phrase" 2>&1)"
else
  output="$(bun test -t "$phrase" 2>&1)"
fi
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
