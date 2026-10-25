# @getdonn/adapter-eve

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
