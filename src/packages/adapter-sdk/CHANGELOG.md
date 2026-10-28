# @getdonn/adapter-sdk

## 0.7.0

### Minor Changes

- 28bcda1: Subagents go through the gateway. With `models.gateway`, `lib/donn/config.ts` exports `donnSubagent`, one entry per `agent/subagents/<name>/agent.ts` (`model` and `modelContextWindowTokens`, the keys eve takes on a subagent), and `patchSubagentTs` makes the edit that spreads it last in each subagent, keeping the subagent's own model for when there is no gateway. The report carries one advisory per routed subagent naming the model it replaces. `targets.eve.subagents.<name>.model` picks another model of the same gateway; an override for no subagent, or without a gateway, is reported. A subagent `agent.ts` the edit cannot recognise, or whose spread a later `model` overrides, is `agent-ts-unrecognised`, naming the file; one donn edited before (the new optional `project.edited`) that no longer routes is reported as bypassing the gateway instead, and nested or other subagent modules are reported as not routed. Without a gateway nothing changes. `AgentCompileInput.project` gains optional `texts`, the template-owned files whose content the compile reads. llm-council's subagent portability entry is no longer blocking when a gateway is set.

## 0.6.0

### Minor Changes

- c4fd06d: The eve adapter writes a donn-owned `agent/channels/eve.ts` (a bearer `DONN_ROUTE_TOKEN` plus `localDev()`) for the local and self-host targets when the template has no route auth of its own, and the route-auth portability entry follows (advisory, or blocking with the lines to add by hand). The Postgres world is opt-in (`world: postgres`). Templates carry a `sha256-` digest, path templates report `portability-unknown`, and `AgentCompileInput.project` gains `hasRouteAuth`. The SDK exports `satisfiesRange`.

### Patch Changes

- Updated dependencies [c4fd06d]
  - @getdonn/spec@0.5.0

## 0.5.0

### Minor Changes

- 0a8ed7a: `@getdonn/adapter-sdk` gains the `AgentAdapter` contract, its conformance kit and `PortabilityService`. `@getdonn/adapter-eve` is new: it compiles a persona into the files of an eve agent (instructions, skills, MCP connections and model routing through a gateway), with an ownership manifest and a portability report per template.
  
  `docs/capabilities.md` and `donn capabilities --markdown` list the agent adapters beside the harnesses.
- 4e51f5d: Personas can declare `models` (gateway routing, lockable) and `agents`; every harness adapter reports `models` (not yet supported). See docs/planning/23-models-and-agents.md.
  
  A layer that uses a path agent template now publishes that template folder with it (missing or escaping folders are refused). Header names in `models.gateway.headers` and in MCP url-server `headers` must be valid HTTP header names.

### Patch Changes

- Updated dependencies [4e51f5d]
  - @getdonn/spec@0.4.0

## 0.4.1

### Patch Changes

- 14c7f82: First npm release.
- Updated dependencies [14c7f82]
  - @getdonn/spec@0.3.1

## 0.4.0

### Minor Changes

- 035af67: Renamed from zzpersona to donn. Run `donn migrate` once on a machine that ran zzpersona.

### Patch Changes

- Updated dependencies [035af67]
  - @getdonn/spec@0.3.0

## 0.3.0

### Minor Changes

- d221b8b: Optional `managed?: ManagedCompiler` on the adapter contract, with `ManagedInput`, `ManagedResult`,
  `ManagedManifest` and the report types. `FIXED_CAPABILITY_FIELDS` gained `policy`, so a third-party
  adapter's conformance-kit `complete-matrix` check fails until it declares a `policy` row.

### Patch Changes

- Updated dependencies [d221b8b]
  - @zzpersona/spec@0.2.0

## 0.2.0

### Minor Changes

- 07ec8c0: The `agents-md` adapter. `zzpersona write [--check | --remove]` renders the repo's project persona
  (without the user overlay, switches or default) into a marked block of `<repo>/AGENTS.md`, leaving
  everything outside the block byte for byte; `--check` fails in CI when the block is stale. The
  block carries instructions, knowledge pointers and tool rules as guidance, and the report lists
  what an `AGENTS.md` cannot carry. The SDK's overlay steps gain an optional `block`, the executor
  `applyOverlay`, and the conformance kit a `noBinary` option for file-format adapters.
- 9114c9e: The capability matrix. `zzpersona capabilities [--harness <id>] [--detect] [--markdown] [--json]`
  shows what each harness carries (native, approximated, advisory, none) and why, and
  `docs/capabilities.md` publishes it, kept current by a test (`pnpm docs:capabilities`).
  
  **Breaking for third-party adapters:** the conformance kit's new `complete-matrix` check requires
  a matrix to declare every field (`capabilityFields(id)`) and a `note` on every field that is not
  native. `requiredEntries` now returns each entry's `reason`, taken from the note; capability
  entries gain an optional `caveat`. agents-md now reports dropped secrets as secrets.

## 0.1.0

### Minor Changes

- 3ff16cd: `@zzpersona/adapter-sdk`: the harness adapter contract (pure `compile` and `activate`, which
  returns a plan of `launch`/`overlay` steps; `detect` through a probe), `defineAdapter`, compile
  reports with "no silent loss" derived from each adapter's capability matrix and lock annotation,
  `renderBuild`/`renderCapabilities`, and a framework-neutral conformance kit with a shared corpus
  (`./conformance`, plus a vitest wrapper at `./conformance/vitest`). `@zzpersona/adapter-claude-code`:
  the first adapter, compiling a resolved persona to a plugin, settings fragment, MCP config and
  system prompt for the relaunch path, with `partial` and `relaunch-no-mcp` modes under managed
  settings.

### Patch Changes

- 9d21335: Reach. Third-party adapters and secret providers load from `adapters:` and `secretProviders:` in
  `config.yaml` (packages from `~/.zzpersona/adapters`, or paths), only when a command needs one;
  `compile --harness <id>` works with any loaded adapter and `doctor` checks every listed plugin.
  `@zzpersona/secrets` gains `SecretContext`, `defineSecretProvider` and a built-in `keychain`
  provider (macOS `security`, Linux `secret-tool`), with `doctor` printing the command that stores a
  missing item. `zzpersona diff [a] <b>` shows what changes between two personas, with provenance.
  Hardening: class-based adapters keep their methods, an SDK-owned `Platform` type, conformance
  reports a missing `chdir`, `strictMcp` must be a boolean, later managed-settings drop-ins win, no
  empty objects in settings.json, concurrent switches no longer lose entries, `switch` and `init`
  edge cases, error envelopes always carry a message, and project files may link elsewhere in their
  repo.
