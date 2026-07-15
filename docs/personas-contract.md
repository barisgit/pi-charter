# pi-charter persona contract

> **Superseded historical contract.** Current pi-charter has no persona configuration or orchestration layer; the agent is the loop driver and may independently use pi-subagents. See ADR-0014 and `docs/implementation/architecture.md`.

pi-charter ships **zero bundled personas**. Every persona role is fulfilled by a
Bring-Your-Own-Agent (BYOA) pi-subagents agent that you name in global config;
the charter runtime never registers, bundles, or spawns personas of its own.

## Persona configuration

Charter persona wiring is **global only**, resolved via Pi's `getAgentDir()`
(honors `$PI_CODING_AGENT_DIR`, falls back to `~/.pi/agent`):

```
<agentDir>/charter-config.json
```

There is intentionally no per-project override — tactical knobs go in `charter.md`
"Scope and constraints"; agent wiring stays in the user's global config so it
can't fork per repo. Model/thinking overrides for these agents live in
pi-subagents' `~/.pi/agent/subagent.json` preset `agents` map, not here.

Schema (all fields optional; see `src/persistence/charter-config.ts`):

```json
{
  "personas": {
    "plannerCritic": "<pi-subagents agent name>",
    "reviewer": "<pi-subagents agent name>",
    "qa": "<pi-subagents agent name>",
    "readinessProbe": "<pi-subagents agent name>"
  },
  "qaDir": "docs/qa",
  "policy": "interactive"
}
```

- `personas.*` — names of pi-subagents agents to use for each role. Default empty.
- `qaDir` — directory of QA briefs surfaced in status. Default `docs/qa`.
- `policy` — `"interactive" | "autonomous"`. Default `"interactive"`.

Role enum (`CharterPersonaRole`): `plannerCritic | reviewer | qa | readinessProbe`.

> **Wiring status:** this config surface is defined, schema-validated, and unit-tested
> (`loadCharterConfig`, `resolvePersona`), but it is **not yet consumed by any runtime
> path** in `src/` — no tool, lifecycle, or completion step reads it today. Treat it as
> forward-looking configuration, not an active gate or dispatch mechanism.

## Evidence contract

Per ADR-0013, the charter **records** evidence; it never runs verification. The
agent (or a BYOA persona) runs whatever checks it needs and records the result.
Evidence is a single flat record — there is **no typed `kind` discriminant**. The
legacy kinds `command | review | qa | readiness` are explicitly rejected by
`src/domain/evidence-schemas.ts`.

Each evidence entry carries:

- `source`: `"manual" | "verifier" | "subagent"` — provenance, surfaced for
  display/audit only. It is not a trust rank or completion gate. Command output the
  agent captured itself is recorded as `source: "verifier"`.
- `outcome`: `"pass" | "fail" | "partial"`.
- `summary`: what was observed.
- `because`: **required when `source: "manual"`** — the only evidence rule that can
  block completion (`blockingReason` blocks `manual` without `because`).
- `details`: optional structured payload (e.g. captured `{command, exitCode, stdout}`).

`recordedBy` is auto-populated and shown for display only. `requireReviewSubagent`
is parsed and displayed but is **not** a completion gate. There is no
identity-disjoint/session-disjoint review requirement and no trust-rank model.
