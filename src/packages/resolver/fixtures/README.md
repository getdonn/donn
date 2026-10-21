# Resolver fixtures

These fixtures are the executable spec for `@zzpersona/resolver` (see `docs/planning/04-roadmap.md`,
Phase 0: "This test suite is the real spec"). Each directory is one case: a set of persona files
and the output the resolver must produce for them.

## Layout

```
<NNN-case-name>/
  case.yaml                 what to resolve and what to expect
  personas/<layer>/<name>.yaml
  explain.txt               golden output of explain() (resolving cases only)
```

`explain.txt` is generated: after an intended change to resolution or rendering, regenerate with
`pnpm --filter @zzpersona/resolver exec vitest run -u` and review the diff like any other change.
It is what a reviewer reads to judge whether the output is trustworthy (Phase 0 exit question).

The personas root is the case's `personas/` directory. A ref like `team/payments` is the file
`personas/team/payments.yaml`. The first path segment is the layer (`org`, `area`, `team`,
`project`, `user`); only `user` has special rules. Files referenced by personas (instruction
`.md`, hook scripts) do not exist: the resolver never reads them, it only normalizes their paths.

### `case.yaml`

```yaml
description: One sentence on what this case pins down.
resolve: project/checkout-api      # the target persona ref
overlay: user/overrides            # optional: a PersonaOverlay applied last
expect:
  resolved: { ... }                # IR fields to compare (see "Comparison")
  provenance: { ... }              # optional subset of path → layer
  warnings: [ ... ]                # required with `resolved`; [] for none
# or, for a case that must fail:
expect:
  error: { code: ..., ... }
```

### Comparison

- `resolved`: every top-level IR field listed must equal the actual field exactly. Fields not
  listed are not compared. `001` and `002` list every field; focused cases list only what they test.
- `provenance`: every listed path must map to the listed layer. Unlisted paths are not compared.
- `warnings`: compared as an unordered set on `{ code, path, layer }`.
- `error`: every listed key must match.

## Resolved IR shape (v0)

| Field | Shape | Order |
|---|---|---|
| `irVersion` | `0` | |
| `layers` | refs in merge order (root first), overlay last | merge order |
| `metadata` | `{ name, version?, description?, labels }` | |
| `instructions` | `[{ id, file \| inline }]` | contract order |
| `skills` | `[{ name, source }]` | sorted by name |
| `mcp` | `{ gateway?, servers: { <name>: <def> } }` | |
| `permissions` | `{ allow: [], deny: [], ask: [] }` | each sorted |
| `hooks` | `{ <event>: [{ id, run, matcher? }] }` | first appearance |
| `knowledge` | `[{ id, source }]` | first appearance |
| `secrets` | `{ providers: { <name>: <def> } }` | |
| `locks` | `[{ path, layer }]` | declaration order |
| `targets` | `{ <harness>: <object> }` | |

- File paths (`instructions[].file`, `hooks[].run`, local skill sources) are normalized to be
  relative to the personas root: `./hooks/x.sh` declared in `org/base.yaml` becomes `org/hooks/x.sh`.
- Skill `name` is the last path segment of the source without the version: both
  `registry://org/skills/pr-review@^2` and `./skills/pr-review` are `pr-review`.
- `secret://` and `gateway://` refs pass through untouched. Resolving them is not the resolver's job.

### Path syntax (provenance, locks, warnings, errors)

Dots for object keys, `[x]` for an entry in a keyed list or set: `mcp.gateway`,
`mcp.servers.jira`, `instructions[payments-overview]`, `skills[pr-review]`,
`permissions.deny[Bash(rm -rf:*)]`, `hooks.pre-tool-use[block-prod-db]`,
`targets.claude-code.model`. Locks use the same grammar.

## Codes

Warnings: `allow-shadowed-by-deny`, `ask-shadowed-by-deny`, `allow-shadowed-by-ask`,
`security-removal`, `remove-unmatched`, `overlay-lock-ignored`.

Errors: `missing-ref`, `cycle`, `linearization-conflict`, `replace-target-missing`,
`lock-violation`, `invalid-lock-path`, `user-layer-lock`, `invalid-persona` (a file that fails
the `@zzpersona/spec` schema; no fixture yet, since every fixture file must validate).

`@zzpersona/spec` is the source of truth for the IR shape, path grammar and codes above;
`src/fixtures.test.ts` validates every fixture against it, so this README and the spec cannot
silently drift.

## Proposed rule decisions (pending review)

`02-persona-spec.md` left these open or ambiguous. The fixtures commit to one answer each so they
can be exact. **Each is a proposal**; if one is rejected, change the rule here, in `02`, and in
the listed cases together.

Claude Code's own settings layering (managed → CLI → local → project → user) was used as
precedent, checked against code.claude.com/docs on 2026-10-20 (settings, permissions,
settings-reference, features-overview). Where a rule matches it, the rule says so. Claude Code
has fixed tiers rather than an `extends` graph, so rules 1–3, 6 and 8 have no precedent there.

1. **`extends` order is ascending precedence: later parents win.** The merge order is the C3
   linearization computed with the parent list reversed, then reversed back to put the root first.
   Python's rule (first parent wins) makes the `02` example itself unresolvable:
   `extends: [org/base, area/fintech]` with `area/fintech → org/base` would rank a parent above
   its own child. Listing an ancestor redundantly is fine as long as the order agrees with the
   hierarchy. *Cases: 002, 010, 011, 012.*
2. **A lock freezes the path's value as of the end of the declaring layer.** Every layer after it
   in merge order (not only its descendants) is checked. A layer that merged earlier than the
   locking layer is not a violation. *Cases: 076.*
3. **Restating the same value is not a change.** A lower layer that sets a locked scalar to the
   value it already has passes. *Cases: 071.*
4. **Locks on restrictive sets allow additions.** For `permissions.deny` and `permissions.ask`, a
   lock forbids removing entries but allows adding them, since adding only tightens. A lock on
   any other path forbids every change, including adding to `permissions.allow`.
   *Precedent:* `--disallowedTools` can add restrictions beyond managed settings, and under
   `allowManagedPermissionRulesOnly` lower-level `deny`/`ask` rules still apply while `allow`
   rules are dropped ("they only restrict, so they can't widen"). *Cases: 072, 073, 074.*
5. **Explicit removals:** `permissions.remove: { allow?, deny?, ask? }` and
   `hooks.remove: ["<event>[<id>]"]`, alongside the existing `mcp.remove` and `skills.exclude`.
   Removing a `deny`, `ask` or hook warns `security-removal`. Removing anything not present warns
   `remove-unmatched`. Within one layer, additions apply before removals. *Deliberately looser
   than Claude Code*, where lists from different files only ever merge and nothing can remove
   another file's entries: our layers have different owners, and an unlocked org default needs
   an explicit, reviewable way out. Locks are how a layer opts into Claude Code's strictness.
   *Cases: 032, 052, 060.*
6. **Prepends keep declaration order.** A layer's `prepend` fragments go ahead of everything
   inherited, as a block, in the order that layer declared them. *Cases: 020.*
7. **Reusing an inherited instruction id replaces that fragment in place.** This is the same
   override-by-name rule as skills, MCP servers, hooks and knowledge, and as Claude Code's skills,
   subagents and MCP servers. `replace(<id>)` is for swapping in a fragment under a new id.
   *Revised 2026-10-20: first draft made this an error.* *Cases: 021, 023.*
8. **`metadata` is not inherited**, except `labels`, which shallow-merge across all layers.
   `name`, `version` and `description` come from the target persona only; inheriting a parent's
   `version` would mislabel the child. *Cases: 063.*
9. **Exact-match conflicts are resolved in the IR; pattern overlaps are not.** If the identical
   rule string is in two lists, it stays only in the stronger one (`deny` > `ask` > `allow`) and a
   `*-shadowed-by-*` warning names the layer whose entry was dropped. Overlapping patterns
   (`Read(./**)` vs `Read(./.env)`) are left for the harness to evaluate. *Cases: 002, 050, 051.*
10. **The user overlay** (`kind: PersonaOverlay`) has no `metadata`, `extends` or `locks`, merges
   last, and is subject to every lock. Personas under `user/` can be targets but cannot declare
   `locks`. *Cases: 002, 077, 078.*
11. **Lock violations fail resolution, except in the user overlay**, where the offending entry is
   dropped with an `overlay-lock-ignored` warning and the rest of the overlay still applies. The
   overlay applies to every switch, so one stale line must not break them all; persona files
   (including `user/` personas) are authored deliberately and must fail loudly, as they will at
   publish. *Precedent:* under `allowManaged*Only`, Claude Code ignores lower-level rules and
   tells the developer rather than refusing to start. *Revised 2026-10-20.* *Cases: 070, 078.*
