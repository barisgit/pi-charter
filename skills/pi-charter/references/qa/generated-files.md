# Generated files QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture generated code, build outputs, snapshots, reports, and file tree changes caused by the feature under test.

## Recommended stack

Unverified starting stack: `git diff`, `tree`, and targeted file diffs.

```bash
# UNVERIFIED: capture repository diff summary and patch.
git diff --stat > work/<feat>/evidence/<ts>/diff-stat.txt
git diff -- skills/ src/ tests/ > work/<feat>/evidence/<ts>/targeted.diff
```

```bash
# UNVERIFIED: capture output tree shape.
tree -a work/<feat>/output > work/<feat>/evidence/<ts>/output-tree.txt
```

```bash
# UNVERIFIED: capture a focused before/after file diff.
git diff -- path/to/generated-file > work/<feat>/evidence/<ts>/generated-file.diff
```

## Detection

Use this recipe when file content, generated output presence, or directory shape is the acceptance signal.

```bash
# UNVERIFIED: detect common file evidence tools.
command -v git && (command -v tree || command -v find)
```

## Graceful degradation

1. Git diff + tree output + targeted generated-file excerpts.
2. `find` listing plus checksums for key files.
3. Manual list of generated paths with command output that created them.

## Platform-specific notes

- macOS/Linux: `tree` may not be installed; `find` is the lowest-common fallback.
- CI: capture paths relative to repository root for stable artifacts.
- Large outputs: include summaries and targeted diffs rather than full directories.

## Anti-patterns

- Do not attach generated blobs without explaining why they matter.
- Do not include unrelated working-tree churn in evidence diffs.
- Do not rely on filenames alone when contents are the proof.

## Out-of-scope

Visual pixel comparisons belong in `visual-regression.md`; database schema dumps belong in `database.md`.

## When to abandon and improvise

If generated outputs are too large or binary, capture manifests, checksums, and representative excerpts with caveats in `qa.md`.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when git is unavailable.
git --version >/dev/null
```
