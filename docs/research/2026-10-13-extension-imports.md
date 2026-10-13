# Extension import profiling

## Cause and fix

Pi 1.2.0's bundled loader uses jiti virtual modules for host peers. Charter's TypeScript imports stay in that loader, but `pi-extension-utils`' compiled JS root is imported natively. Its `logger -> utils-config -> config` path imports `getAgentDir` from a private coding-agent installation; pane utilities also import a private TUI. Native resolution bypasses Pi's virtual modules, loading another host and dependency graph.

`JITI_DEBUG=1` showed filesystem cache hits and 0.1–0.7 ms per Charter source transform, but a native import of `pi-extension-utils/dist/src/index.js`. Rebuilding Charter to JS would not fix this resolution boundary.

Use `pi-extension-utils/pi` from version 0.7.10. This API-identical TypeScript entry keeps transitive imports inside jiti and host peer resolution. The ordinary Node compiled root remains available. No Charter build, lazy feature registration, or prompt/tool changes are needed.

## Evidence

Isolation: run from `/tmp`, unset `PI_PACKAGE_DIR` and `FO_CODING_AGENT_DIR`, add `--no-extensions -e <source-checkout>`. Successful requests used `--provider openai-codex --model gpt-5.5`; the default Anthropic account was out of extra usage.

```sh
env -u PI_PACKAGE_DIR -u FO_CODING_AGENT_DIR PI_TIMING=1 \
  ~/.bun/bin/pi -p --no-session --no-tools --no-extensions \
  -e "$HOME/Programming_local/Projects/pi-extensions/pi-charter" \
  --provider openai-codex --model gpt-5.5 'Reply exactly: ok'
```

For CPU profiles, prefix the CLI path with `node --cpu-prof --cpu-prof-dir=<artifact-directory>`. For loader cache/native-import evidence add `JITI_DEBUG=1`.

Observed module import times (ms):

| Configuration | Runs |
|---|---|
| Initial dev checkout, original root import | 1194; CPU-profile run 1099 |
| Root import with locally rebuilt utils, successful requests | 3666 first run; 897, 1038 warm |
| Published utils 0.7.10 `/pi`, Pi 1.2.0 | 352 first run; 55, 61 warm |
| Published utils 0.7.10 `/pi`, fo 0.1.2 / Pi 0.87.1 | 62, 37, 37 |

Warm Pi import median fell from 967.5 to 58 ms (94%). Published-package `createAgentSessionRuntime` was 460 first run, then 141/145 ms, versus 970/1134 ms warm with the original root import.

CPU profiles contained 195 distinct sampled script URLs before and 97 after; sampled private Charter `node_modules/@earendil-works/` URLs fell from 31 to zero. These are sampled script counts, not an exhaustive module inventory. Before included local coding-agent, typebox, undici, yaml, highlighted syntax, lockfile and process-spawn dependencies. The after profile had no sampled private host URLs.

An independent Node `registerHooks({ load })` probe counted unique native load URLs across successful CLI requests: 3297 with the compiled root versus 81 with `/pi`; private Charter `node_modules/@earendil-works/` native load URLs fell from 2208 to zero. This probe counts native imports (including builtins), not jiti's VM-evaluated TypeScript modules. It confirms the duplicate host graph rather than relying only on CPU sampling.

`bun run ci` passed (typecheck and 116 tests). Shared utils typecheck, 131 tests, build, tarball source/declaration checks and its automated npm release passed. A fresh source copy installed with `npm install --omit=dev --ignore-scripts` (no build) loaded on both hosts: Pi import 252 ms, fo 49 ms. Read-only Charter-list journeys used `--tools charter --mode json` instead of `--no-tools`; events confirmed a successful `charter` call on Pi (49 ms import) and fo's successful `run` wrapper calling `charter` (52 ms import). Existing Charter lifecycle, rendering and guard tests remain unchanged.

## Pattern for other extensions

Raise the utils dependency floor to `^0.7.10`, update the repository lockfile, and change runtime imports to `pi-extension-utils/pi`. Match test-mock specifiers to runtime imports; type-only imports may remain on the compiled root because both entries share declarations. Reprofile with each repository's original dependencies, then run its existing gates and both host journeys. Do not prebuild TypeScript or delay tool/prompt registration to address this cause.
