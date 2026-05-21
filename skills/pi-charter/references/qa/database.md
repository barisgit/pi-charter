# Database QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture database schema, query plans, migrations, and before/after row counts that prove persistent state changes.

## Recommended stack

Unverified starting stack: schema-only dump, `EXPLAIN ANALYZE`, and explicit before/after counts.

```bash
# UNVERIFIED: capture PostgreSQL schema without data.
pg_dump --schema-only "$DATABASE_URL" > work/<feat>/evidence/<ts>/schema.sql
```

```bash
# UNVERIFIED: capture a query plan with runtime metrics.
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM target_table LIMIT 10;" > work/<feat>/evidence/<ts>/explain.txt
```

```bash
# UNVERIFIED: capture before/after row counts.
psql "$DATABASE_URL" -c "SELECT count(*) FROM target_table;" | tee work/<feat>/evidence/<ts>/row-counts.txt
```

## Detection

Use this recipe when correctness depends on stored rows, schema shape, indexes, migrations, or query performance.

```bash
# UNVERIFIED: detect PostgreSQL client tooling.
command -v psql && command -v pg_dump
```

## Graceful degradation

1. Schema dump + query plans + before/after counts.
2. Targeted SQL transcript with redacted values.
3. Application-level test output plus a note that direct DB capture was unavailable.

## Platform-specific notes

- macOS/Linux: prefer local or disposable databases for evidence capture.
- CI: include migration command output next to schema and count artifacts.
- Hosted databases: redact hostnames, user names, and sensitive row values when needed.

## Anti-patterns

- Do not dump production data into evidence artifacts.
- Do not rely on ORM logs alone when SQL state is the claim.
- Do not compare row counts without naming the table and filter conditions.

## Out-of-scope

API request proof belongs in `http-api.md`; generated migration file diffs belong in `generated-files.md`.

## When to abandon and improvise

If direct DB access is unsafe or unavailable, capture migration/test output and explain why no database artifact was produced.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when PostgreSQL client tools are unavailable.
command -v psql >/dev/null && command -v pg_dump >/dev/null
```
