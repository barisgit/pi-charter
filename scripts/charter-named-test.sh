#!/usr/bin/env bash
set -euo pipefail

# Modes:
#   <test-file>            suite-guard: run the file/glob, fail if 0 tests ran
#   <test-file> <phrase>   named: run the file filtered by title (niche)
#   <phrase>               named across the whole suite (legacy; phrase-coupled)
# A single argument that looks like a path/glob (contains '/' or a test-file
# extension or a glob char) is treated as a FILE in suite-guard mode, NOT a
# phrase — this is the preferred behavior-level form that fails on absence.
test_file=""
phrase=""
if [[ $# -eq 1 ]]; then
  if [[ "$1" == */* || "$1" == *.ts || "$1" == *.tsx || "$1" == *.js || "$1" == *.jsx || "$1" == *.mjs || "$1" == *\** || "$1" == *\?* ]]; then
    test_file="$1"
  else
    phrase="$1"
  fi
elif [[ $# -eq 2 ]]; then
  test_file="$1"
  phrase="$2"
else
  echo "Usage: scripts/charter-named-test.sh [<test-file>] [<phrase>]" >&2
  echo "  <test-file>            run a file/glob and fail if 0 tests ran (preferred)" >&2
  echo "  <test-file> <phrase>   run a file filtered by test title (niche)" >&2
  echo "  <phrase>               run the whole suite filtered by title (discouraged)" >&2
  exit 2
fi

set +e
if [[ -n "$test_file" && -n "$phrase" ]]; then
  output="$(bun test "$test_file" -t "$phrase" 2>&1)"
elif [[ -n "$test_file" ]]; then
  output="$(bun test "$test_file" 2>&1)"
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
  if [[ -n "$phrase" ]]; then
    echo "0 tests matched phrase: $phrase" >&2
  else
    echo "0 tests ran for: ${test_file:-(whole suite)}" >&2
  fi
  exit 1
fi

if [[ "$status" -ne 0 ]]; then
  printf '%s\n' "$output" >&2
  exit "$status"
fi

printf '%s\n' "$output"
