# HTTP API QA capture recipe

> status=stub-unverified — NOT YET VERIFIED. Commands below are starting points only and have not been validated for pi-charter v2.1 evidence capture.

## What this is for

Capture HTTP, REST, GraphQL, WebSocket, SSE, and gRPC interactions with replayable requests and sanitized response artifacts.

## Recommended stack

Unverified starting stack: HAR where a browser is involved, `mitmproxy` for intercepted flows, `.http` files for repeatable calls, and `grpcurl` for gRPC.

```bash
# UNVERIFIED: run a checked-in .http request collection with an external client.
# Replace with the repository's chosen .http runner before relying on this.
bunx hurl --test qa/api-smoke.http
```

```bash
# UNVERIFIED: capture proxied HTTP traffic.
mitmdump -w work/<feat>/evidence/<ts>/api.flows
```

```bash
# UNVERIFIED: inspect a gRPC service.
grpcurl -plaintext localhost:50051 list
```

### WebSocket / SSE

```bash
# UNVERIFIED: capture a short event stream transcript.
curl -N http://localhost:3000/events | tee work/<feat>/evidence/<ts>/sse.txt
```

## Detection

Choose this recipe when request/response shape, status code, headers, stream events, or API compatibility is the proof.

```bash
# UNVERIFIED: detect common API capture tools.
command -v curl && (command -v mitmdump || command -v grpcurl || true)
```

## Graceful degradation

1. Replayable `.http` or gRPC command plus sanitized responses.
2. HAR or mitmproxy flow export when the browser creates the calls.
3. Redacted curl transcript with headers and body snippets.

## Platform-specific notes

- macOS/Linux: keep proxy certificates and captured secrets out of committed artifacts.
- CI: prefer localhost services and deterministic fixtures over shared staging data.
- Windows/WSL: ensure the client and server agree on localhost routing.

## Anti-patterns

- Do not store bearer tokens, cookies, or private payloads in evidence.
- Do not assert success from HTTP 200 alone when the body carries the real result.
- Do not omit request inputs needed to replay the proof.

## Out-of-scope

Browser rendering proof belongs in `browser.md`; database internals belong in `database.md`.

## When to abandon and improvise

If traffic cannot be replayed or captured safely, record sanitized request/response summaries and explain the redactions in `qa.md`.

## Smoke command

```bash
# UNVERIFIED: exits non-zero when curl is unavailable.
curl --version >/dev/null
```
