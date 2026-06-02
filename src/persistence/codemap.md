# src/persistence/

## Responsibility
Persistence-adjacent configuration loading for pi-charter's global user config. The folder currently contains only `charter-config.ts`, which reads `charter-config.json` from Pi's agent state directory and normalizes it into an in-memory `CharterConfig` object.

## Design
- Schema validation uses TypeBox (`CharterConfigFileSchema`) with `additionalProperties: false` at both the top level and `personas` level.
- Accepted file shape: optional `personas` overrides for `plannerCritic`, `reviewer`, `qa`, and `readinessProbe`; optional `qaDir`; optional `policy` of `"interactive" | "autonomous"`.
- Runtime shape fills defaults for all fields: blank persona names, `qaDir: "docs/qa"`, and `policy: "interactive"`.
- `globalConfigPath()` resolves via `getAgentDir()` to `<agentDir>/charter-config.json`; the code comments state this honors `$PI_CODING_AGENT_DIR` and otherwise falls back to `~/.pi/agent`.
- `readConfigFile()` is synchronous, treats `ENOENT` as absent config, throws path-specific errors for malformed JSON, and reports the first TypeBox schema error path for invalid config.

## Flow
1. A caller invokes `loadCharterConfig()`.
2. `globalConfigPath()` builds `<getAgentDir()>/charter-config.json`.
3. `readConfigFile()` parses and validates the JSON file, or returns `undefined` when the file is absent.
4. `normalizeConfig()` merges optional file values over `DEFAULT_CHARTER_CONFIG` and returns a complete `CharterConfig`.
5. `resolvePersona(role, config)` is a simple accessor over `config.personas[role]`.

## Integration
- Depends on Node `fs`/`path`, `@earendil-works/pi-coding-agent` `getAgentDir()`, and TypeBox validation.
- This module does not read or write project charter workspaces under `<projectDir>/.pi/charters/<charterId>/`; those workspace sidecars live elsewhere in `src/infrastructure/store.ts` and related application services.
- Current `src/` runtime code has no imports of `loadCharterConfig()` or `resolvePersona()`; the loader is covered by `tests/config-loader.test.ts`.
- The config is global user-agent state, not a per-project `.pi/charters` sidecar and not part of the Objective/Milestone/VAL runtime records.

## Vestigial / tech-debt
- `charter-config.ts:81` `resolvePersona()` and `charter-config.ts:85` `loadCharterConfig()` are exported but currently unwired from `src/` runtime code; only tests import the loader.
