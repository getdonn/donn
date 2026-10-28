# @getdonn/adapter-eve

## 0.3.0

### Minor Changes

- 28bcda1: Subagents go through the gateway. With `models.gateway`, `lib/donn/config.ts` exports `donnSubagent`, one entry per `agent/subagents/<name>/agent.ts` (`model` and `modelContextWindowTokens`, the keys eve takes on a subagent), and `patchSubagentTs` makes the edit that spreads it last in each subagent, keeping the subagent's own model for when there is no gateway. The report carries one advisory per routed subagent naming the model it replaces. `targets.eve.subagents.<name>.model` picks another model of the same gateway; an override for no subagent, or without a gateway, is reported. A subagent `agent.ts` the edit cannot recognise, or whose spread a later `model` overrides, is `agent-ts-unrecognised`, naming the file; one donn edited before (the new optional `project.edited`) that no longer routes is reported as bypassing the gateway instead, and nested or other subagent modules are reported as not routed. Without a gateway nothing changes. `AgentCompileInput.project` gains optional `texts`, the template-owned files whose content the compile reads. llm-council's subagent portability entry is no longer blocking when a gateway is set.

### Patch Changes

- Updated dependencies [28bcda1]
  - @getdonn/adapter-sdk@0.7.0

## 0.2.0

### Minor Changes

- c4fd06d: The eve adapter writes a donn-owned `agent/channels/eve.ts` (a bearer `DONN_ROUTE_TOKEN` plus `localDev()`) for the local and self-host targets when the template has no route auth of its own, and the route-auth portability entry follows (advisory, or blocking with the lines to add by hand). The Postgres world is opt-in (`world: postgres`). Templates carry a `sha256-` digest, path templates report `portability-unknown`, and `AgentCompileInput.project` gains `hasRouteAuth`. The SDK exports `satisfiesRange`.

### Patch Changes

- 1bd509f: The adapter exports `TEMPLATES_AT`, the eve tag its template digests were computed at.
- Updated dependencies [c4fd06d]
- Updated dependencies [c4fd06d]
  - @getdonn/adapter-sdk@0.6.0
  - @getdonn/spec@0.5.0

## 0.1.0

### Minor Changes

- 0a8ed7a: `@getdonn/adapter-sdk` gains the `AgentAdapter` contract, its conformance kit and `PortabilityService`. `@getdonn/adapter-eve` is new: it compiles a persona into the files of an eve agent (instructions, skills, MCP connections and model routing through a gateway), with an ownership manifest and a portability report per template.
  
  `docs/capabilities.md` and `donn capabilities --markdown` list the agent adapters beside the harnesses.

### Patch Changes

- Updated dependencies [0a8ed7a]
- Updated dependencies [4e51f5d]
  - @getdonn/adapter-sdk@0.5.0
  - @getdonn/spec@0.4.0
