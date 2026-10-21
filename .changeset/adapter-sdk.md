---
"@zzpersona/adapter-sdk": minor
"@zzpersona/adapter-claude-code": minor
---

`@zzpersona/adapter-sdk`: the harness adapter contract (pure `compile` and `activate`, which
returns a plan of `launch`/`overlay` steps; `detect` through a probe), `defineAdapter`, compile
reports with "no silent loss" derived from each adapter's capability matrix and lock annotation,
`renderBuild`/`renderCapabilities`, and a framework-neutral conformance kit with a shared corpus
(`./conformance`, plus a vitest wrapper at `./conformance/vitest`). `@zzpersona/adapter-claude-code`:
the first adapter, compiling a resolved persona to a plugin, settings fragment, MCP config and
system prompt for the relaunch path, with `partial` and `relaunch-no-mcp` modes under managed
settings.
