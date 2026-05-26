# Orchestration layering — pi-subagents × pi-charter

> Question from user: *"My main session is the orchestrator (deterministic logic,
> auto-reviewer subagents). I maintain a fork of pi-subagents with quite a lot of
> changes + a 'workflow selection' in subagent.json by defining which agents we
> use as root, subagent, both. Do we split into subagent core, then workflows,
> then goals/charters can reuse core/workflows? Or combine into one super extension?"*

This document answers the split-vs-combine question with: **two extensions in a strict dependency stack — pi-charter on top of pi-subagents.** No separate "workflows" extension. Chain-of-personas is already the workflow primitive. Bundled internal personas plus two clean spawn surfaces (named + raw) give pi-charter everything it needs without leaking charter vocabulary into pi-subagents.

**Important framing:** pi-charter is not just `pi-goals` renamed. It is a new replacement concept: a charter is the binding document that authorises and constrains a run (`charter.md`: Objective / Criteria / Scope), while pi-subagents remains the spawn/workflow substrate. v1 `pi-goals` is only the historical baseline and extraction source.

> **Revision notes:**
>
> - **2026-05-14 (a):** An earlier draft proposed a three-layer stack with a middle `pi-workflows` extension. That was based on misreading `agent/agents/*.md` as workflow recipes; the user clarified those files are **personas** (system-prompt + behavioral rules), not recipes. "Workflow selection in subagent.json" is the role-topology config (which personas are root-allowed, subagent-allowed, both), not a separate engine. Deterministic glue (auto-reviewer, plan→implement→review chains) is already expressible with `subagent({chain:[...]})` plus persona names. Middle layer dropped.
> - **2026-05-14 (b):** Extension renamed `pi-goals` → `pi-charter` because v2 scope (Goal + Contract + Macro DAG + planning + evaluator + verifier + handoff envelope) is mission-shaped, not goal-shaped. The kernel TS type, the slash command, the tool surface, the hook events, the file layout, and the bundled personas all rename together (Option B — full rename, no half-measure). The word "goal" survives only as a noun for the **objective** field inside a Mission. See §11.
> - **2026-05-14 (c):** Folded the standalone `intent-sentinel` extension into pi-charter' bundled `legacy evaluator persona` persona. Same primitive, two prompt modes: **mission-scoped** when a mission is active, **free-form** otherwise. See §4.5.
> - **2026-05-14 (d):** Default lifecycle is now autonomous-first; plan-approval gate defaults ON (Factory-shape) via a bundled TUI approver subscribing to `charter:before_lock_plan`, flipped OFF via `PI_CHARTER_TUI=off` or `charter.config.json { tuiApprover: off }`. Completion strictness moved to per-criterion flags (`requireFreshEvidence` / `requireReviewSubagent`) inside `charter.md §Criteria`. See §10.
> - **2026-05-14 (e):** Renamed pi-missions → **pi-charter** and collapsed the earlier `mission.md` + `contract.md` split into one `charter.md` with three sections: Objective, Criteria, Scope and constraints. Older `charter_create` prose maps to `charter_manage({action: 'create'})` under the four-tool surface.

---

## 1. The primitives in play

| Primitive | What it is | Owner |
|---|---|---|
| **Subagent run** | "Spawn an agent and get a result back" | pi-subagents |
| **Chain / parallel / swarm** | Compose multiple subagent runs in one call | pi-subagents (existing `{chain:[...]}` etc.) |
| **Persona** | A named system-prompt + behavior rules, as a markdown file with frontmatter | pi-subagents (file convention in `agents/*.md`) |
| **Role topology** | Which personas can be root vs. subagent vs. internal (extension-only) | pi-subagents (subagent.json) |
| **Mission** | Durable container holding objective + contract + macro DAG; the alignment rail for a spawned agent's work | pi-charter |
| **Contract** | Markdown of verifiable VAL-* criteria that define done | pi-charter |
| **Macro DAG** | Features grouped into milestones, each with `fulfills[]` into the contract | pi-charter |
| **Bundled internal personas** | Extension-shipped personas, invocable only by extension code, file-shadowable by users | pi-charter (and any future extension) |

No separate workflow recipe layer. Chains-of-personas already are the workflow primitive.

---

## 2. The dependency stack

```
┌──────────────────────────────────────────────────────────────────┐
│  pi-charter                                                      │
│  Mission (objective + contract + macro DAG) · Evaluator · Verifier│
│  Ships bundled personas: charter-verifier, charter-planner-critic,│
│    legacy evaluator persona                                              │
│  Builds dynamic evaluator prompts at spawn time                   │
│  Calls subagent.spawn / subagent.spawnRaw with persona names or   │
│  inline prompts; tags spawns with metadata so hooks route results │
└──────────────────────────┬───────────────────────────────────────┘
                           │ uses (public subagent surface)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  pi-subagents (your fork)                                         │
│  Spawn · Chain · Parallel/Swarm · Async · Worktree isolation      │
│  Persona resolver with search path (per-context → user → bundled) │
│  Role topology in subagent.json (root | subagent | internal)      │
│  Two public spawn surfaces: spawn (named) and spawnRaw (inline)   │
│  Hook bus emits subagent:* events with passthrough metadata       │
└──────────────────────────────────────────────────────────────────┘
```

Hard rules of the stack:

1. **Arrows point up only.** pi-charter imports from pi-subagents; pi-subagents imports from neither.
2. **Each layer can run standalone.** Install pi-subagents alone → usable CLI for spawn/chain/parallel/swarm. Add pi-charter → contracts, planning, evaluator, verifier.
3. **pi-subagents can be replaced.** Any runner honoring the same tool surface + hook events keeps pi-charter working.
4. **Inter-layer integration is via tools + hooks + shared files only.** No internal-API coupling. Same discipline you already use for pi-charter ↔ pi-dag-tasks.
5. **No mission vocabulary in pi-subagents.** No `charterId`, `criterionId`, `featureId` named parameters in the spawn surface. Cross-layer tagging is opaque (see §5).

---

## 3. pi-subagents — surfaces and capabilities

### 3.1 Existing capabilities (your fork, unchanged)

| Capability | Status |
|---|---|
| `subagent({agent, task, ...})` for single runs | already shipped |
| `subagent({chain:[...]})` / `parallel` / `swarm` shapes | already shipped |
| `agent: "fork"` vs `agent: "fresh"` context (same-role only for fork) | already shipped |
| Async execution + status polling | already shipped |
| Worktree isolation | already shipped |
| Role topology in subagent.json (per-preset agent capabilities) | already shipped (your fork addition) |
| Persona registry from `~/.pi/agent/agents/*.md` (markdown with frontmatter) | already shipped |
| Chain template substitution (`{task}` / `{previous}` / `{chain_dir}`) | already shipped — workflow-shaped enough that no separate engine is needed |
| Pre/post-spawn hook events | already shipped (or trivial to add) |

### 3.2 New additions for v2 (small, additive)

> **Mechanism note (locked correction).** Earlier drafts of §3.2.2 and §3.2.3 wrote `subagent.spawnRaw({...})` and `subagent.registerPersonaDir({...})` as if `pi-coding-agent`'s `ExtensionAPI` exposed a generic extension-to-extension registry. **It doesn't.** Confirmed by reading `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — the `ExtensionAPI` interface has `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerProvider`/`unregisterProvider`. No namespace for sibling extensions to publish arbitrary methods onto `pi.*`.
>
> The shipped pattern in your repo for cross-extension function publishing is `pi-prune-router` + `pi-prune-swe-pruner-provider`: paired event constants on `pi.events.emit` / `pi.events.on` carrying the function reference (closures survive event emission — it's plain JS object passing, no serialization). The router stores the function in its own private `Map<string, RegisteredProvider>` and invokes it later. See `pi-prune-swe-pruner-provider/src/types.ts:1-2` (`PRUNE_REGISTER_PROVIDER_EVENT`, `PRUNE_UNREGISTER_PROVIDER_EVENT`) + `pi-prune-router/src/router.ts:22 registerProvider`.
>
> Surfaces below now spec to that pattern. §6 hard rules (`spawnRaw`/`registerPersonaDir` are not LLM-callable; no charter vocabulary in pi-subagents; metadata passthrough; persona name uniqueness) all still hold — they just enforce against event payload shape instead of a method on `pi.subagent`.

#### 3.2.1 `internal` role scope

The `scope` field in subagent.json (or persona frontmatter) gains a third value beyond `root` and `subagent`:

| Scope | Means | LLM-visible? | Invoked how |
|---|---|---|---|
| `root` | Persona is allowed as a session's top-level driver | yes | `pi` CLI with `--agent <name>`, or persona named in subagent.json preset's `defaultRole` |
| `subagent` | Persona can be spawned by root-level LLM | yes (in tool description) | root LLM calls `subagent({agent: "..."})` |
| `internal` | Persona is invocable only by extension code, never enumerated to the root LLM, never shown in the persona menu | **no** | extension calls `subagent.spawn({agent: "..."})` from its own code path |

Persona `frontmatter.scope` overrides the default scope from subagent.json. Bundled extension personas declare `scope: internal` in their frontmatter.

**Filtering rule:** when pi-subagents builds the tool description for the root LLM listing available `subagent({agent: ...})` values, it excludes any persona whose effective scope is `internal`. The internal personas are still in the resolver and still spawnable — just not advertised.

**Debug visibility:** `subagent.list({ includeInternal: true })` returns them. `pi subagent list --include-internal` from CLI.

#### 3.2.2 `subagent:expose-api` event — inline systemPrompt + prompt

**Mechanism: pi-subagents publishes its programmatic API surface via an event at startup; consumers (pi-charter) subscribe and capture the function reference.**

Shared constant (defined in pi-subagents, copied/re-exported by consumers):

```ts
export const SUBAGENT_EXPOSE_API_EVENT = "subagent:expose-api";

export interface SubagentExposedAPI {
  spawnRaw(input: SpawnRawInput): Promise<SpawnResult>;
  list(options?: { includeInternal?: boolean }): PersonaInfo[];
  // Future: spawn(...) once internal callers need it; today the LLM-tool form is enough.
}
```

pi-subagents emits the bag once at extension startup, and re-emits it on `session_start` for restart safety (mirrors how `pi-prune-swe-pruner-provider` re-announces in `index.ts:51`):

```ts
// inside pi-subagents extension startup
const api: SubagentExposedAPI = { spawnRaw: implSpawnRaw, list: implList };
pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, api);
pi.on("session_start", () => pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, api));
```

Consumers cache the latest reference and use it through their own typed handle:

```ts
// inside pi-charter extension startup
let subagentApi: SubagentExposedAPI | undefined;
pi.events.on(SUBAGENT_EXPOSE_API_EVENT, (api: SubagentExposedAPI) => {
  subagentApi = api;
});
```

The `SpawnRawInput` payload (passed to `spawnRaw(...)`) is unchanged from the earlier draft:

```ts
export interface SpawnRawInput {
  systemPrompt: string;
  prompt: string;
  tools?: string[];                   // tool allowlist; defaults to safe-read set
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean | string[];
  defaultReads?: string[];
  defaultProgress?: boolean;
  hooks?: HookConfig;
  metadata?: Record<string, unknown>;  // opaque passthrough; see §5
  async?: boolean;
  worktree?: boolean;
  // context is always "fresh" for raw spawns — not exposed
}
```

`spawnRaw` exists for the case where a system prompt must embed live state and can't be a stored file. The motivating example is pi-charter's post-turn evaluator (absorbed intent-sentinel), whose system prompt embeds current criteria status, last 3 evaluator verdicts, drift signals, and the contract digest. Storing that as a static persona file is impossible; constructing it inline at spawn time is natural.

`context` is not a parameter on `SpawnRawInput`. Extension-initiated spawns are always `fresh` — there's no parent conversation for the child to inherit. `fork` is reserved for `main` → `main` self-forks, which extensions never do.

**Why event-published vs. direct npm import of pi-subagents?**
- pi-subagents may not be installed in every host that loads pi-charter; the event subscribe is optional and gracefully no-ops when pi-subagents is absent (`subagentApi` stays `undefined`, pi-charter's evaluator falls back to the cheap in-process model call via `complete()` from pi-ai).
- No version pinning between sibling extensions — the event payload is the contract.
- Matches the precedent already in your repo (`pi-prune-router` + `pi-prune-swe-pruner-provider`).

#### 3.2.3 `subagent:register-persona-dir` event — extension-supplied bundled personas

**Mechanism: paired events on `pi.events`, modeled on `pi-prune-swe-pruner-provider/src/types.ts` (`PRUNE_REGISTER_PROVIDER_EVENT` / `PRUNE_UNREGISTER_PROVIDER_EVENT`).**

Shared constants (defined in pi-subagents, copied/re-exported by consumers):

```ts
export const SUBAGENT_REGISTER_PERSONA_DIR_EVENT = "subagent:register-persona-dir";
export const SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT = "subagent:unregister-persona-dir";

export interface RegisterPersonaDirPayload {
  extensionId: string;    // e.g. "pi-charter"; required
  path: string;           // absolute path to a directory of *.md persona files
  scope: "internal";      // only "internal" is supported via this event; forced by pi-subagents
}

export interface UnregisterPersonaDirPayload {
  extensionId: string;
}
```

Consumers emit at extension startup AND re-emit on `session_start` (so that mid-session pi-subagents reloads see the registration again):

```ts
// inside pi-charter extension startup
function announcePersonaDir() {
  pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, {
    extensionId: "pi-charter",
    path: path.join(__dirname, "../agents"),
    scope: "internal",
  });
}
announcePersonaDir();
pi.on("session_start", announcePersonaDir);
pi.on("shutdown", () => pi.events.emit(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, { extensionId: "pi-charter" }));
```

pi-subagents subscribes and maintains its own registry:

```ts
// inside pi-subagents extension
const personaDirRegistry = new Map<string, RegisterPersonaDirPayload>();
pi.events.on(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, (payload) => {
  // Uniqueness guard — throw if a different extension already owns a persona name here.
  validateAndAdd(personaDirRegistry, payload);
});
pi.events.on(SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT, ({ extensionId }) => {
  personaDirRegistry.delete(extensionId);
});
```

Personas inside registered directories are loaded with `scope: internal` (overriding their frontmatter scope, if present — protects against extensions accidentally registering root-visible personas).

**Resolver search order** (first match wins):
1. Per-context dir, if the spawn supplies one (e.g. `<charter-dir>/agents/<name>.md` — see §4.3)
2. `~/.pi/agent/agents/<name>.md` (user's library)
3. Extension-registered directories (in registration order, with uniqueness guard on persona name)

This order means **users can shadow extension-bundled personas** by dropping a file with the same name in their own agents dir. They have to know the name first, but that's documented per extension.

**Uniqueness guard:** two extensions cannot register the same persona name. pi-subagents emits a `subagent:register-persona-dir-error` event with payload `{extensionId, conflictingExtensionId, personaName, message}` if a collision is detected on subscribe. The originating extension is responsible for handling the error (typically: fail loud during the extension's own startup). Resolved by either extension renaming its persona.

#### 3.2.4 Hook events with passthrough metadata

The existing `subagent:*` events gain a `metadata` field in their payload, copied verbatim from the spawn config:

- `subagent:async-started` — `{ runId, agent?, metadata }`
- `subagent:async-complete` — `{ runId, exitCode, summary, artifacts, durationMs, metadata }`
- (Future) `subagent:spawn-started` / `subagent:completed` / `subagent:failed` for sync delegations — same `metadata` field shape

This is the only one of the four surfaces that is a pure payload addition rather than a new event — it's additive on existing `subagent:async-*` events and any future sync-delegation events.

pi-subagents never reads `metadata`. It just emits it. Downstream subscribers (pi-charter) read it on `pi.events.on('subagent:async-complete', ev => ev.metadata?.['pi-charter.featureId'])`.

---

## 4. pi-charter — what changes because of the surface

### 4.1 Bundled internal personas pi-charter ships

Three personas live inside the pi-charter extension at `pi-charter/agents/`:

| Persona | Purpose | Why bundled |
|---|---|---|
| `charter-verifier` | Run a criterion's verifier; structure output as evidence record fields (`{passed, observation, evidence}`); call `charter_record_evidence` and `charter_handoff_apply` | Contract-aware structured output that a generic `reviewer` can't produce reliably; ships with reasonable defaults, file-shadowable for project-specific tuning |
| `charter-planner-critic` | Adversarial pass during the planning phase: read contract draft + macro DAG, flag uncovered scope, orphan features, cyclic preconditions, budget sanity | Specialized adversarial prompt; same logic as Factory's plan-stress-test agent |
| `legacy evaluator persona` | Post-turn trajectory supervisor; absorbs the standalone intent-sentinel extension. Two prompt modes (§4.5). Invoked via `spawnRaw` so the prompt can embed live mission state (criteria status, last 3 verdicts, active feature) | Dynamic prompt + cheap model + steer-on-drift loop |

Each is a `*.md` file with frontmatter declaring:
```yaml
---
name: charter-verifier
description: Contract-aware verifier for pi-charter criteria.
scope: internal
tools: [read, grep, find, ls, bash, charter_record_evidence, charter_handoff_apply]
model: openai-codex/gpt-5.5
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are the mission verifier. Read the criterion under test...
```

At extension startup, pi-charter emits:
```ts
pi.events.emit(SUBAGENT_REGISTER_PERSONA_DIR_EVENT, {
  extensionId: "pi-charter",
  path: path.join(__dirname, "../agents"),
  scope: "internal",
});
// also re-emitted on every session_start for restart safety
```

### 4.2 Which uses `spawn` vs `spawnRaw` inside pi-charter

| pi-charter internal use | Surface | Why |
|---|---|---|
| Verifier run on a criterion | LLM-callable `subagent({agent: "charter-verifier", task: ...})` tool, invoked by the host agent itself | Stable prompt, override-friendly, source-controlled. No extension-side `spawn` call needed — the agent decides when to delegate. |
| Planner-critic during planning | LLM-callable `subagent({agent: "charter-planner-critic", task: ...})` tool, invoked by the host agent itself | Same reasoning |
| Post-turn evaluator (charter-scoped or free-form) | `subagentApi.spawnRaw({systemPrompt: buildEvaluatorPrompt(charter?, recentEvents, contractDigest?), prompt: ..., model: "haiku-tier"})` via the `SUBAGENT_EXPOSE_API_EVENT`-captured handle | System prompt embeds live state; can't be a static file. Falls back to in-process `complete()` if pi-subagents is not installed. |
| Charter trigger fired on `feature_completed` etc. | Whatever the charter config's `triggers` block says — usually `subagent({agent: <persona>, ...})` invoked by the host agent | Persona name is charter-config driven; defaults to `charter-verifier` but user can swap to their own |
| Subagent handoff `charter_record action=handoff_apply` callback | Not a spawn — a tool call from inside the spawned persona back to pi-charter's tool surface | Reverse direction; same mechanism as any other tool call |

The legacy evaluator persona being `spawnRaw`-shaped is the key reason the `SUBAGENT_EXPOSE_API_EVENT` surface exists at all. If we only had stable-prompt persona spawn (via the LLM `subagent` tool), the evaluator system prompt would need to live as a template file with placeholder substitution — that's just `spawnRaw` with extra steps, so we publish the `spawnRaw` capability directly through the exposed-API event.

In pi-charter today, `deleted evaluator service` works without `spawnRaw` — it calls `complete()` from `@earendil-works/pi-ai` directly. The `subagentApi.spawnRaw` path is the **upgrade path**: when pi-subagents is present, the evaluator gets a proper isolated child run with tool access, hooks, and per-spawn telemetry. When pi-subagents is absent, the evaluator still functions, just without those affordances.

### 4.3 Per-mission persona overrides

The persona resolver checks `<mission-dir>/agents/<name>.md` first. So:

```
<project>/.pi/charters/<charterId>/
  charter.md                  (## Objective + ## Criteria + ## Scope and constraints)
  plan/
  state.json
  agents/
    charter-verifier.md    ← overrides bundled charter-verifier for THIS mission only
```

Used rarely — mostly when a single mission has unique verification needs (e.g. a frontend mission needs a verifier that runs Playwright; a library mission doesn't). Most missions use the bundled persona unchanged.

### 4.4 Trigger config refers to personas by name

Mission config has a `triggers` block:

```jsonc
{
  "triggers": {
    "feature_completed": {
      "chain": [
        { "agent": "charter-verifier", "task": "Verify criteria fulfilled by feature {featureId}" }
      ]
    },
    "milestone_gate": {
      "chain": [
        { "agent": "charter-verifier", "task": "Verify all criteria for milestone {milestoneId}" },
        { "agent": "qa", "task": "Runtime validate milestone {milestoneId} outcomes" }
      ]
    },
    "evaluator_drifting": {
      "agent": "oracle",
      "task": "Mission {charterId} is drifting: {reason}. Recommend one corrective action."
    }
  }
}
```

The default trigger config ships with `"charter-verifier"` and the user's own `qa` / `oracle` personas. Users edit per mission to swap.

pi-charter builds the `subagent.spawn` argument from the trigger config + event payload (interpolating `{featureId}`, `{milestoneId}`, `{reason}` from the event). pi-subagents resolves the persona name through the search path.

### 4.5 `legacy evaluator persona` — the intent-sentinel fold

The standalone `intent-sentinel` extension absorbed into `pi-charter/agents/legacy evaluator persona.md` plus pi-charter runtime code that calls `spawnRaw` on each `turn_end`. ~1450 LOC of polished mechanics (cooldown, confidence threshold, repair-on-validation-error, memories, mute, per-session persistence, subagent-skip guard, JSON parser/validator, warning renderer) port wholesale.

Two prompt modes selected at spawn time:

| Mode | Active when | Inputs in system prompt | Drift definition |
|---|---|---|---|
| **mission-scoped** | A mission is `active` | objective, active feature(s), criteria status snapshot, last 3 verdicts, recent evidence ledger, contract digest | Drift against typed contract — every steer must cite either a criterion ID, a feature ID, or be suppressed |
| **free-form** | No active mission | Latest user msg, workflow files (WORKFLOW.md / AGENTS.md), recent task_manage context | Drift against inferred intent (today's intent-sentinel behavior, preserved verbatim) |

Hard separation of concerns:

- **Evaluator owns trajectory supervision** ("is the agent doing the right work?"). Soft, cheap model, runs every N turns, can be wrong without disaster.
- **Verifier owns completion gating** ("is the work actually done?"). Hard, deterministic, runs on demand, must be correct.

The evaluator never gates `review → completed`. It only steers during `active`. The verifier + hooks decide done.

Steer constraint: when in mission-scoped mode, every emitted steer must cite either a `criterionId`, a `featureId`, or `"no active mission — free-form mode"`. Steers without citation are dropped at validation time. Makes wrong steers easier to spot and undo.

### 4.6 Memories — pinned to mission entities when present

intent-sentinel's free-text memories (with stable IDs, age tracking, and explicit forget actions) carry over. New capability when mission-scoped: a memory can optionally pin to a `criterionId` or `featureId`. When the bound entity is verified / completed / removed, the memory auto-forgets. In free-form mode, memories behave exactly as today (session-scoped, time-aged, manual forget).

Persistence:
- mission-scoped → `<project>/.pi/charters/<charterId>/evaluator-memories.json`
- free-form → `~/.pi/sentinel/<sessionId>.json` (today's path)

The runtime picks based on whether a mission is `active`. Switching mid-session (mission gets paused) flips back to free-form storage; on resume, mission-scoped memories return from disk.

---

## 5. The metadata passthrough — cross-layer tagging without coupling

The earlier draft of this design floated `callerMissionId` as a named parameter on the spawn surface. **That's wrong** — it pushes pi-charter' vocabulary into pi-subagents.

The correct mechanism is an opaque metadata bag:

```ts
subagent.spawn({
  agent: "charter-verifier",
  task: `Verify criterion ${criterion.id}`,
  metadata: {
    "pi-charter.charterId": mission.id,
    "pi-charter.criterionId": criterion.id,
    "pi-charter.featureId": feature.id,
  },
});
```

pi-subagents:
- never reads `metadata` keys
- never validates `metadata` shape
- stamps `metadata` onto every `subagent:*` hook event payload
- stamps `metadata` into session log entries (for debugging)
- never injects `metadata` into the child's system prompt or context

**Key namespacing convention:** flat string keys, prefixed with `<extensionId>.`. `pi-charter.charterId`, `pi-qa.runId`, `pi-research.queryId`. Prevents collisions when multiple extensions tag the same spawn.

When the spawn completes, pi-subagents emits `subagent:completed` with metadata intact. pi-charter' hook subscriber reads `metadata["pi-charter.charterId"]`, looks up the mission, applies the handoff envelope, records evidence. **pi-subagents never imports the word "mission."**

Same pattern as HTTP request IDs, OpenTelemetry baggage, git note refs — a passthrough bag the substrate doesn't interpret.

---

## 6. Important hard rules

### 6.1 `spawnRaw` is published via event payload, never as an LLM tool

The root LLM still uses **only** the tool-form `subagent({agent: "...", task: "..."})`. The `spawnRaw` function reference reaches pi-charter as a property on the `SubagentExposedAPI` bag delivered through `SUBAGENT_EXPOSE_API_EVENT`. It is never registered as a pi tool; the LLM cannot call it. Reason: if `spawnRaw` were tool-callable, root could bypass persona conventions, ship raw system prompts of arbitrary length, and circumvent the role-topology guard. Extensions calling `spawnRaw` are TypeScript code with explicit author intent; LLMs calling it would be a security hole.

### 6.2 `subagent:register-persona-dir` event is startup-only

Extensions emit the registration event during their initialization (and re-emit on `session_start` for restart safety). No dynamic re-registration mid-session — that would create resolver-cache invalidation problems. If an extension wants dynamic personas, it uses `spawnRaw` instead.

### 6.3 `context: "fresh"` is hardcoded for extension spawns

`SpawnRawInput` doesn't include a `context` field. The LLM-callable `subagent({...})` tool does expose `context` (for `main` → `main` self-forks), but the only valid value when extensions invoke `spawnRaw` via the exposed-API event handle is implicit `fresh`. `fork` is `main` → `main` self-fork only and not reachable through `spawnRaw`.

### 6.4 No charter vocabulary in pi-subagents source

Forbidden tokens in pi-subagents codebase: `charter`, `mission`, `charterId`, `goal`, `goalId`, `criterion`, `criterionId`, `feature` (as a domain noun; `agent feature flag` etc. is fine). Enforce with a CI grep step. Event constants (`SUBAGENT_REGISTER_PERSONA_DIR_EVENT`, etc.) MUST use neutral names like `subagent:register-persona-dir`, never `subagent:register-charter-personas`. Event payload field names MUST be neutral (`extensionId`, `path`, `metadata`, etc.) — charter-specific keys live only INSIDE the opaque `metadata` bag, prefixed with `pi-charter.` per §5.

### 6.5 Persona name uniqueness is enforced on subscribe

Two extensions registering the same persona name fail loudly on the `subagent:register-persona-dir` subscribe handler, not silently at spawn time. pi-subagents emits `subagent:register-persona-dir-error` carrying `{extensionId, conflictingExtensionId, personaName}`; the originating extension is responsible for failing its own startup if it sees an error on a name it tried to register. Renames are owner-side; user can always shadow via `~/.pi/agent/agents/<name>.md`.

### 6.6 Bundled personas declare their tools explicitly

`charter-verifier.md` has `tools: [read, grep, find, ls, bash, charter_record_evidence, charter_handoff_apply]` in frontmatter. pi-subagents enforces the allowlist when spawning. If pi-charter' tools aren't loaded (i.e. pi-charter not installed), the spawn fails — which is correct: there's no reason for the persona to run if its tools aren't there.

### 6.7 Mission tools, not goal tools

Every LLM-callable tool surface uses the `charter_*` prefix. Canonical surface is four tools: `charter_manage` (lifecycle FSM), `charter_plan` (planning DAG), `charter_record` (execution writes), and `charter_status` (read-only + `nextActions[]`). Older drafts showed flat per-verb tools (`charter_create`, `charter_record_evidence`, etc.); those now map onto the four-tool surface. **No `goal_*` tools.** The word "goal" survives only as a noun for the `objective` field inside a Charter. CI grep guards this in pi-charter source too.

---

## 7. Why this shape over alternatives

### A. Everything in one super-extension
Rejected. Three primitives (spawn, personas, mission+contract+macro DAG) in one extension is opaque to contributors, bloats the LLM tool surface (every new tool dilutes selection precision), and forces unrelated release cadences through one package. Subagent infra churns weekly on model changes; mission contracts churn quarterly. Bundling forces every change through one giant release.

### B. Workflows as a separate middle extension
Rejected after the user's clarification. Chain-of-personas is already the workflow primitive. A separate YAML workflow engine would be inventing a problem; the existing `subagent({chain:[...]})` with persona names IS the deterministic glue. If, in 6 months, you're authoring 20+ trigger configurations that aren't expressible as chains, that's the signal — until then, no middle layer.

### C. Bundled personas as in-memory definitions instead of files
Rejected. Files are version-controllable inside the extension repo, debuggable (`cat ~/.pi-extensions/pi-charter/agents/charter-verifier.md`), and user-shadowable. In-memory definitions hide the prompt in TypeScript source where it's invisible to users wanting to understand or override.

### D. Spawning with `callerMissionId` as a named parameter
Rejected. Forces pi-subagents to know about missions. Opaque `metadata` bag is the correct generalization — works for any future extension (`pi-qa.runId`, `pi-research.queryId`, etc.) without changing the spawn surface.

### E. `spawnRaw` as an LLM-callable tool
Rejected. See §6.1.

### F. Keep intent-sentinel as a separate extension
Rejected. Same primitive as the post-turn evaluator. Running both in parallel means two evaluators, two memory stores, two prompts disagreeing about whether the agent is on track. Worse, intent-sentinel would have *strictly less context* (inferred intent vs. declared contract) but equal authority to steer. Fold into `legacy evaluator persona` with two prompt modes (§4.5). Free-form mode preserves today's behavior verbatim for sessions without an active mission.

### G. Half-rename (tools renamed, kernel stays `Goal`)
Rejected. New contributors would see `Goal` in code, `mission` in tools, and lose half a day reconciling. Hook events would be the leakiest surface — external subscribers seeing `goal:before_complete` despite `pi-charter` branding everywhere else. Full rename is cheaper than partial (Option B).

---

## 8. The mission framing payoff

Factory's mission abstraction is "goal + plan + worker spawning + persistent root agent" in one box. Your pi setup, with this stack, decomposes that one box into:

| Factory primitive | pi equivalent |
|---|---|
| Mission orchestrator (Code Droid loop) | The main pi session itself — long-lived, **smart-Ralph loop** (agent IS the loop, no scheduler) |
| Mission control state | pi-charter' `state.json` + `feature-state.json` + `criterion-state.json` per mission dir |
| `mission.md` + AGENTS.md | pi-charter `charter.md` (§Objective + §Criteria) + project AGENTS.md |
| `features.json` | pi-charter' macro DAG (`plan/*.md` declarative + `plan.json` indexed sidecar) |
| Auto-spawned worker droid per feature with `skillName` | **No auto-spawn.** Agent picks next action each turn from `charter_status` drift views. When parallel or specialist work helps, agent itself calls `subagent({agent: <persona>, ...})` |
| Validation passes (scrutiny + user-testing) | Agent-invoked `charter-verifier` delegation + user-provided `qa` (no orchestrator-driven validator phase) |
| Handoff envelope | pi-charter evidence + handoff envelope, fed by `metadata["pi-charter.charterId"]` |
| Mission Control TUI | pi-charter status widget + `/charter status` |
| `progress_log.jsonl` | pi-charter `events.jsonl` (typed event log) + pi-subagents run history (already exists) |

**Three things this stack gets that Factory missions don't:**

1. **Live orchestrator.** Factory's mission orchestrator is a separate runtime; the main pi session is the orchestrator — inhabited, not run remotely. User can intervene at any point.
2. **Smart-Ralph loop instead of auto-spawn scheduler.** The agent reads `charter_status` (drift views + evaluator reason + ready-next advisory) and picks ONE action each turn: implement / verify / review-delegate / parallel-delegate / amend / complete / pause. No worker pool, no `worker_selected_feature` event, no scheduler to swap. Parallelism is opt-in via the agent's own `subagent({parallel: [...]})` call. (See v2-brainstorm.md §21 for the full reframe.)
3. **Bundled personas with file-shadow override.** Factory's worker personas are hardcoded; pi-charter' bundled `charter-verifier` ships sensible defaults AND users can drop their own `charter-verifier.md` per mission or globally.

**Bonus strategic benefit:** this design makes pi-subagents a **universal spawn substrate** for every future pi extension. pi-qa, pi-docs, pi-deep-research can all ship bundled internal personas via `registerPersonaDir`, use `spawn` for stable prompts and `spawnRaw` for dynamic ones, and tag spawns via `metadata`. pi-subagents stays unaware of any of them. The pattern proves itself once with pi-charter and pays dividends across the ecosystem.

---

## 9. Migration order

### Phase 0 — pi-subagents event-bus surfaces (1–2 days)
- Add `scope: "internal"` to role topology. **[DONE — commit `e35aed7` in pi-subagents]**
- Define + emit `SUBAGENT_EXPOSE_API_EVENT` carrying `{spawnRaw, list}` callable bag at extension startup and on `session_start`.
- Subscribe to `SUBAGENT_REGISTER_PERSONA_DIR_EVENT` / `SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT`; maintain an internal `Map<extensionId, RegisterPersonaDirPayload>`. Emit `subagent:register-persona-dir-error` on name collision.
- Add `metadata` passthrough field on existing `subagent:async-started` / `subagent:async-complete` event payloads. Future sync-delegation events follow the same shape.
- CI grep guard against charter/mission/goal vocabulary leakage (§6.4).

These four changes are small, additive, backward-compatible. Existing `subagent({agent, task})` calls keep working. No release coordination with pi-charter required.

### Phase 1 — pi-charter M1+M2 (3–5 days)
- Schema + planning + contract + verifier per v2-brainstorm.md §§1–17 + §18 + §19.
- Bundled `charter-verifier` and `charter-planner-critic` personas inside `pi-charter/agents/`.
- `registerPersonaDir` call at extension startup.
- Verifier integration via `subagent.spawn({agent: "charter-verifier", ...})`.
- v1 → v2 migration adapter: reads old `.pi/goals/goal-*.json`, writes new `.pi/charters/charter-*.json`. 2-week soft window.
- M1 ships with `verifier.kind: "manual"` only (you mark each criterion pass/fail). M2 adds command/prompt verifiers.

### Phase 2 — Triggers + handoff envelope (1–2 days)
- `triggers:` block in mission config.
- pi-charter' hook subscriber on `subagent:completed` with `metadata["pi-charter.*"]` routing.
- Subagent handoff via `charter_handoff_apply` tool call from inside spawned personas.

### Phase 3 — pi-charter M3: `legacy evaluator persona` + intent-sentinel fold (2–3 days)
- `legacy evaluator persona` built via `subagent.spawnRaw` with live state in system prompt.
- Two prompt modes (mission-scoped, free-form).
- Memory persistence (per-mission when scoped, per-session when free-form).
- Cadence + cache + plan-mode bypass per §5 of v2-brainstorm.md.
- Standalone `intent-sentinel` extension marked deprecated with a one-line notice; 2-week soft window; then removed from `agent/extensions/`.

Total ~1 week of focused work. Each phase is independently deployable.

---

## 10. Human-in-the-loop policy + session binding

> **Headline:** autonomous-first. Missions are designed to be spawned with a spec and run to completion without per-feature babysitting. Human gates exist but default ON only because that's the Factory-safe shape for unfamiliar users; orchestrated spawns flip them off.
>
> **HITL out-of-scope clarification:** per the locked decision, pi-charter itself is **headless**. The plan-approval and completion gates fire as hook events (`charter:before_lock_plan`, `charter:before_complete`); a bundled-but-optional TUI approver subscribes to those events to prompt the user. Single config (`~/.pi/agent/charter.config.json: tuiApprover: on|off`, default `on`) + env override (`PI_CHARTER_TUI=off`). No-TTY = fail-open + logged warning. The four-layer override stack below still applies for the *policy* (gate on/off), not for the prompting mechanism.

### 10.0 Session ↔ mission binding

See **v2-brainstorm.md §22** for the full design. Summary:

- **Per-project scoping.** Missions live under `<project>/.pi/charters/`, never `~/.pi/charters/`. Multiple missions per project allowed; `index.json` is the registry.
- **Two-file binding.** Forward: `<project>/.pi/charters/<charterId>/state.json.sessionId`. Reverse: `~/.pi/agent/sessions/<sessionId>/charter.json` (small `{charterId, projectRoot}` JSON).
- **No transcript pollution.** Binding is filesystem state, not a custom transcript message. Mission identity reaches the LLM via system-prompt injection on bound sessions.
- **Authority split.** Agent can call `charter_manage({action: 'create'})` (auto-binds calling session). Switching between existing charters is **user-only** via `/charter resume <id>` slash command or `pi --charter-resume <id>` CLI flag. There is **no `charter_claim` LLM tool**.
- **`/fork`.** User's `/fork` slash command produces a new sessionId with inherited history but no mission binding (fork's session metadata dir starts empty). Fork can read mission state, but `mission_*` writes error until the user runs `/charter resume <id>` in the fork — which then unbinds the parent and rebinds to the fork. One owner at a time.
- **Subagent children never bind.** Charter scope reaches children via the existing `metadata["pi-charter.charterId"]` passthrough. Only the session that called `charter_manage({action: 'create'})` writes a `~/.pi/agent/sessions/<sid>/charter.json`.

### 10.1 The three decision points and their defaults

| Decision point | Default | When the gate fires | Override |
|---|---|---|---|
| **Plan approval** (`planning → active`) | ON (Factory-safe) | After planner-critic returns; bundled TUI approver subscribes to `charter:before_lock_plan` and prompts | `PI_CHARTER_TUI=off` (per-session) or `charter.config.json { tuiApprover: off }` (global) |
| **Per-feature execution** | OFF (autonomous) | Never | (no toggle — smart-Ralph; agent is the loop) |
| **Charter completion** (`review → completed`) | per-criterion | When a criterion has `requireFreshEvidence` or `requireReviewSubagent` set inside `charter.md §Criteria` | Author the charter; no per-charter mode toggle |

### 10.2 Override precedence (lowest to highest)

```
1. Built-in default                        (Factory-safe: gate on)
2. Global config (~/.pi/agent/charter.config.json { tuiApprover: off })
3. Env var (per-session)                   PI_CHARTER_TUI=off
```

No per-call override on `charter_manage({action: 'create'})` — the agent surface stays slim, and spawners that need gate-off set `PI_CHARTER_TUI=off` in the child env. Mirrors `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_RUNTIME_MODE` patterns already in your stack.

### 10.3 Three modes of human involvement

- **Synchronous gate** — execution halts pending approval. Plan approval is this when ON.
- **Asynchronous supervision** — execution runs; human can intervene any time via hooks (`charter:before_complete` veto, `/charter pause`, `/charter amend-contract`).
- **No human involvement** — fully autonomous. Per-feature execution is this by default.

### 10.4 The asymmetric authority pattern (inherited from Codex `/goal`)

| Authority | Can do | Cannot do |
|---|---|---|
| **Model** | Propose-complete, record evidence, suggest contract amendments, call `charter_handoff_apply` | Auto-complete without verifier coverage; bypass `before_complete` hooks |
| **System** | Auto-pause on interrupt, enforce budget, gate completion via hooks, mute evaluator | Author contract content; decide objective |
| **Human** | Approve plan, dismiss handoff items, force-complete (with audit trail), amend contract | (no constraints — but force-complete is logged) |

This three-way split is what makes the autonomous-first defaults safe. The model never *unilaterally* closes a mission; the verifier + hooks must agree; the human can always intervene asynchronously without blocking execution mid-feature.

### 10.5 Plan-quality safeguard (M2 polish)

If `charter-planner-critic` returns confidence below a threshold while the bundled TUI approver is *off*, the runtime re-emits `charter:before_lock_plan` with a `lowConfidence: true` payload tag; subscribers (including the bundled approver, if it was only turned off globally and is still installed) can choose to force a one-time gate. Pattern: trust high-confidence plans, escalate low-confidence ones. Prevents the "vague spec → fabricated contract → autonomous failure" trap.

---

## 11. External orchestration boundary

> **Question from user:** *"How likely is this to clash with external orchestration systems (e.g. Symphony)? Should we keep missions a bit more slim?"*
>
> **Answer:** moderate clash risk on three primitives (status FSM, macro DAG, handoff envelope). Mitigation is **granularity-based, not feature-based** — pi-charter owns the **intra-mission** level; external orchestrators own **inter-mission**. Keep pi-charter full-featured but enforce a narrow surface (emit events, no cross-session UI, no scheduling).

The three nested grains:

```
Symphony (or other upstream)         — inter-mission orchestration
  └── pi-charter                    — intra-mission alignment + verification
        └── pi-dag-tasks (per exec)  — tactical turn-to-turn todos
```

Each layer owns its decomposition *at its grain*. No layer reaches across.

### 11.1 Three integration rules

1. **Mission scope is intra-spawn.** A mission corresponds to one spawned agent's work session(s). It doesn't model cross-spawn dependencies; that's the upstream orchestrator's job. pi-charter never schedules another mission, never decides when missions run, never decides retry policy across spawn boundaries.

   **Per-project filesystem scoping reinforces this.** Missions live under `<project>/.pi/charters/`, mirroring v1's `<cwd>/.pi/goals/` scoping. No global `~/.pi/charters/` registry. Two projects, two sets of missions, zero overlap. Worktrees inherit naturally (different cwd → different mission namespace). Cross-project discovery is out of scope; if wanted later, ships as a separate `pi missions ls --all` CLI walking known project roots.
2. **Upstream spec is authoritative when present on disk.** If `<charterDir>/charter.md` already exists when planning starts (Symphony wrote it before spawn), planning treats it as the charter and only fills in macro DAG + verifier hookups. No `charterPath` parameter on `charter_manage({action: 'create'})`; the file's presence is the signal. This prevents duplicate-charter drift — Symphony's spec IS the charter.
3. **pi-charter emits events; doesn't drive external systems.** External orchestrators read `mission:*` events as observations. pi-charter doesn't write to Symphony, doesn't know Symphony exists, doesn't expose webhooks. Integration is read-only-from-pi-charter'-side.

### 11.2 Surface-trimming rules (codifies "stay slim")

- **No cross-session mission management UI.** The widget shows the current session's mission. Cross-session views are explicitly the upstream orchestrator's job. (No "all missions across all projects" dashboard inside pi-charter.)
- **No scheduling.** pi-charter doesn't decide *when* missions run, when to retry, when to spawn a follow-up mission. The handoff envelope is the integration artifact; what happens after is upstream.
- **No substrate-injected wrap.** Mission creation only happens through an explicit caller — `charter_manage({action: 'create'})` tool (agent-initiated, fine), `/charter <objective>` or `/charter new` (user), or `pi --charter-objective` / `pi --charter-resume` CLI flag (registered via `pi.registerFlag()`). The agent calling `charter_manage({action: 'create'})` itself is *agent-initiated*, not auto-invocation. What's ruled out is pi-charter silently wrapping a session in a mission based on inferred intent.

### 11.3 `charter_manage({action: 'create'})` shape (replaces v1 `goal_create`)

Keep the surface minimal for both user and agent. Only inputs the caller could plausibly know:

```ts
charter_manage({
  action: 'create',
  objective: string,                          // required — the why
  budget?: { tokens?, wallclock?, turns? },   // optional — escape hatch; defaults from config
  idempotencyKey?: string,                    // optional — stable id for CLI retries
})
```

Dropped fields (do not re-add):
- ~~`contractDraft`~~ — inline drafts go through the planning phase + `charter_amend`.
- ~~`planDraft`~~ — planning produces the macro DAG; pre-populating defeats `charter-planner-critic`.
- ~~`autoApprovePlan`~~ — superseded by the headless-core + TUI approver model; knob lives in config + env.
- ~~`completionMode`~~ — completion strictness is per-criterion via flags inside `charter.md §Criteria`, not a per-charter toggle.

Three improvements over v1 `goal_create`:
- Upstream-spec acceptance via filesystem: Symphony writes `<charterDir>/charter.md` before spawn; planning sees the file and skips authoring. No tool parameter, no auto-detect, no copy heuristic in pi-charter.
- `objective` instead of overloading "goal" as both the kernel and the field.
- Minimal surface; the autonomous case `charter_manage({action: 'create', objective: "..."})` works as-is.

### 11.4 The biggest real risk: duplicate-contract drift

When Symphony already has a spec and pi-charter' planning phase authors a *second* contract in its own format, they can drift. Three mitigations, in order of cost:

1. **Cheapest:** Symphony writes `<charterDir>/charter.md` directly before spawn. pi-charter reads the file verbatim during planning; planning only fills in macro DAG + verifier hookups. **Default for orchestrated spawns.** No tool parameter needed.
2. **Medium:** Symphony emits a known schema (markdown frontmatter or YAML) that pi-charter understands natively. Document the schema, let Symphony emit it.
3. **Heavy:** Symphony writes directly to `<project>/.pi/charters/<charterId>/charter.md` before spawning the agent. `charter_manage({action: 'create'})` notices an existing charter and skips planning entirely.

For dogfooding, option 1 is enough.

---

## 12. The one risk worth naming

**You will be tempted to add a workflow layer later.** Once `triggers:` blocks in mission config start carrying chain-of-personas with conditionals, retries, and templated steps, they will look workflow-shaped. The temptation will be to lift them out into a YAML registry with a separate loader and tool surface.

Resist until at least three of these are true:

- You have 20+ distinct trigger configurations across missions.
- The same trigger configuration is reused across 3+ missions verbatim.
- Triggers need to be invoked from places other than mission events (CLI, hooks, scheduled tasks, file-changed events).
- Non-mission contexts genuinely want to run the same "recipes" (file save → reviewer; PR open → qa).

If all four are true, a workflow layer earns its rent and you can lift `triggers:` payloads into `~/.pi/agent/workflows/*.yaml` with a thin loader. Until then, **a trigger is just a `subagent` invocation in JSON inside the mission config**, and that's the right level of indirection.

---

## 13. One-paragraph TL;DR

Two extensions, strict dependency stack: **pi-subagents** (spawn + chain/parallel/swarm + personas + role topology with `root`/`subagent`/`internal` scopes + two TypeScript surfaces `spawn` and `spawnRaw` + `registerPersonaDir` for extension-bundled personas + opaque `metadata` passthrough on hook events) → **pi-charter** (durable charter = objective + Criteria + macro DAG; ships bundled `charter-verifier`, `charter-planner-critic`, and `legacy evaluator persona` personas via `registerPersonaDir`; uses `spawnRaw` for the dynamic post-turn evaluator which absorbs intent-sentinel as its free-form mode; tags spawns with `metadata["pi-charter.charterId"]`; reads back hook events to apply the handoff envelope; configurable `triggers:` block per charter). Tool surface is **four LLM tools** — `charter_manage` (lifecycle FSM: create/pause/resume/complete/force_complete/amend_contract), `charter_plan` (DAG editing: add_feature/update_feature/view), `charter_record` (writes: evidence/verify/handoff_apply), `charter_status` (read with drift views) — every return carries a `nextActions[]` list filtered by current state so the lifecycle FSM lives in tool returns, not in docs. Slash surface is one `/charter` tree (bare opens TUI; positional `/charter <objective>` shortcut; subcommands `new/ls/resume/clear/status/pause/resume/force-complete/untrust-evaluator`). CLI flags via `pi.registerFlag()`: `--charter-objective "<text>"` and `--charter-resume <id>`, both consumed by `session_start` before turn 1. No `--charter-spec` flag and no `charterPath` tool parameter — spec handling is plain English in the spawn prompt; the agent reads files with its standard tools, and Symphony can pre-write `<charterDir>/charter.md` directly when it has a real charter. No separate workflow extension — chains of personas already are workflows. No standalone intent-sentinel — folded into `legacy evaluator persona` with charter-scoped and free-form modes. No charter vocabulary in pi-subagents — CI grep enforced. The main pi session is the orchestrator; charters-as-infrastructure aren't needed because the host runtime already runs long. Autonomous-first defaults: plan-approval gate ships ON (Factory-safe) via a bundled TUI approver subscribing to `charter:before_lock_plan`; flipped OFF via `PI_CHARTER_TUI=off` for orchestrated spawns. Completion strictness lives per-criterion inside `charter.md §Criteria` (`requireFreshEvidence` / `requireReviewSubagent`), not as a per-charter toggle. `charter_manage({action:'create'})` takes only `{objective, budget?, idempotencyKey?}` — three optional fields, minimal surface. External orchestrators (Symphony) own the inter-charter grain; pi-charter owns intra-charter; pi-dag-tasks owns tactical — each grain decomposes its own work and emits events upward, never reaching across. Cost: one new extension (pi-charter replacing pi-goals v1) + ~1 week of pi-subagents API additions. Benefit: clean LLM tool surface, replaceable substrate, reusable spawn primitive for every future pi extension, sentinel mechanics carry over without code rewrite, and a sharp answer to "where does deterministic glue live" — answer: a `triggers:` JSON block in the charter config, pointing at bundled or user-supplied personas, spawned via pi-subagents' standard surface.
