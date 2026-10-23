# 02 — Persona Spec and Merge Semantics

> Status: draft v0, 2026-10-20. The merge rules are the important part; the YAML shape is negotiable.

## Goals

- **Declarative.** A persona is data, not a script.
- **Composable.** Personas inherit via `extends`; the stack resolves deterministically.
- **Harness-neutral.** Nothing in the spec is Claude-Code-specific; compilers own that.
- **Governable.** Higher layers can *lock* values so lower layers cannot override them.
- **Diffable / reviewable.** Plain files, git-friendly, no generated noise checked in.

## Layers

Conventional layer order, lowest precedence first:

```
org  →  business-area  →  team  →  project  →  user
```

Layers are a convention, not a hard rule: `extends` is an arbitrary DAG. The resolver
linearizes it (C3-style, like Python MRO) so a persona that extends two parents gets a stable,
predictable order. Cycles are an error.

Where personas live (v0):

| Layer | Location |
|---|---|
| org / business-area / team | a personas repo (git), or the control plane in the paid tier |
| project | `<repo>/.hatrack/persona.yaml` |
| user | `~/.hatrack/personas/*.yaml` and `~/.hatrack/overrides.yaml` |

## Shape (v0)

```yaml
apiVersion: hatrack/v0
kind: Persona
metadata:
  name: payments-platform
  version: 3            # bumped on publish; informational for local files
  description: Payments platform team, backend services
  labels: { area: fintech, team: payments }

extends:
  - org/base
  - area/fintech

instructions:                 # ordered fragments → CLAUDE.md / AGENTS.md
  - id: payments-overview
    file: ./instructions/overview.md
    position: append          # prepend | append | replace(<id>)
  - id: coding-standards
    inline: |
      Use the shared error envelope. Never log PANs.

skills:
  include:
    - registry://org/skills/pr-review@^2
    - ./skills/run-payment-sim
  exclude:
    - org/skills/frontend-storybook   # inherited from org/base, not relevant here

mcp:
  gateway: bifrost://corp          # optional; names below resolve through it
  servers:
    jira: { ref: gateway://jira }                      # by name via gateway
    payments-schema:
      command: npx
      args: ["-y", "@corp/payments-schema-mcp"]
      env: { SCHEMA_TOKEN: "secret://vault/payments/schema-token" }
  remove: [figma]                  # inherited, not wanted

permissions:
  allow:
    - "Bash(pnpm test:*)"
    - "Read(./**)"
  deny:
    - "Bash(rm -rf:*)"
  ask:
    - "Bash(git push:*)"

hooks:
  pre-tool-use:
    - id: block-prod-db
      run: ./hooks/block-prod-db.sh
      matcher: "Bash"

knowledge:                       # pointers only; never copies
  - id: payments-runbooks
    source: mcp://confluence?space=PAY
  - id: schema-docs
    source: https://docs.corp/payments/schema

secrets:                         # references only; resolution is the client's job
  providers:
    vault: { type: hashicorp-vault, address: https://vault.corp }

locks:                           # fields lower layers may NOT change
  - permissions.deny
  - mcp.gateway
  - hooks.pre-tool-use[block-prod-db]

targets:                         # per-compiler escape hatch
  claude-code:
    model: sonnet
```

## Merge semantics

The single most important design decision. Default rule per field type:

| Field | Type | Merge rule |
|---|---|---|
| `metadata` | object | child wins; `labels` shallow-merged |
| `instructions` | ordered list | **concatenate in layer order** (org first); `position: replace(<id>)` swaps an ancestor's fragment in place; `prepend` moves ahead of all inherited fragments |
| `skills.include` | set | union, keyed by name; child version constraint wins on conflict |
| `skills.exclude` | set | removes from the union *at that layer and below*; a child can re-include |
| `mcp.gateway` | scalar | child wins (unless locked) |
| `mcp.servers` | map | shallow merge by key; child entry **replaces** the whole server object (no deep merge of `env`/`args` — too surprising) |
| `mcp.remove` | set | deletes keys inherited so far; child can re-add |
| `permissions.allow` | set | union |
| `permissions.deny` | set | **union, and deny beats allow** at every layer |
| `permissions.ask` | set | union; `deny` > `ask` > `allow` on conflict |
| `hooks.*` | list keyed by id | union by id; child with same id replaces; `remove: [id]` deletes |
| `knowledge` | list keyed by id | union by id; child replaces |
| `secrets.providers` | map | shallow merge by key |
| `locks` | set | union; a lock applies to **every layer below the one that declared it** |
| `targets.<name>` | object | deep merge; child wins per leaf |

Principles behind the table:

1. **Security-relevant sets only grow.** `deny`, `locks`, and `hooks` added by a parent cannot
   be removed by a child unless the parent did not lock them *and* the child uses an explicit
   `remove`. The resolver reports every such removal as a warning so it shows up in review.
2. **Replace, don't deep-merge, opaque objects.** MCP server definitions are replaced whole.
   Deep-merging `args` arrays produces nonsense.
3. **Explicit beats implicit.** Every removal needs an explicit `exclude`/`remove`. Absence of a
   key in a child never deletes anything.
4. **Order is part of the contract.** `instructions` order is deterministic and visible in
   `hatrack resolve --explain`.

## Locks

A `locks` entry is a path (or `list[id]` selector). Any layer *below* the declaring layer that
attempts to change that path fails resolution with an error naming both layers. This is the
mechanism by which an org baseline becomes policy rather than suggestion. In the paid tier the
control plane enforces locks server-side at publish time; in OSS it is enforced at resolve time
on the client (i.e., advisory — a user can edit the file). That gap *is* the enterprise upsell.

## Resolution algorithm

```
resolve(persona P):
  1. load P and all ancestors; build DAG; error on cycle or missing ref
  2. linearize (C3) → [org/base, area/fintech, ..., P, user-overrides]
  3. acc = empty
     for layer in order:
       for each field: acc[field] = merge(field, acc[field], layer[field])
       check: layer does not touch any path locked by an earlier layer → else error
       record provenance: which layer contributed each value
  4. validate acc against schema
  5. return { resolved, provenance, warnings }
```

`provenance` is what makes `--explain` and drift detection possible: every resolved value knows
which layer set it.

## Compile targets

> Amended 2026-10-20: the original table sent `instructions` to a plugin-scoped `CLAUDE.md` and
> `permissions` / `statusLine` to the plugin's `settings.json`. Research in `03-architecture.md`
> Appendix A showed a plugin cannot carry any of these. Table corrected below; Appendix A is
> authoritative for the Claude Code adapter.

A compiler (now: adapter, see `03`) is a pure function `resolved → file tree`. v0 target:
**claude-code**. The build is a plugin **plus** a settings fragment **plus** an instructions file.

| Resolved field | Claude Code output |
|---|---|
| `instructions` | `system-prompt.md` (via `--append-system-prompt-file`) and a plugin `SessionStart` hook (`additionalContext`, 10k-char cap) |
| `skills` | plugin `skills/<name>/SKILL.md` (copied or symlinked) |
| `mcp.servers` | plugin `.mcp.json` and a standalone `mcp.json` for `--mcp-config` (gateway refs resolved) |
| `permissions` | settings fragment (`--settings` or `.claude/settings.local.json`) → `permissions` |
| `hooks` | plugin `hooks/hooks.json` + scripts |
| `targets.claude-code.*` | settings fragment leaves (e.g. `model`); `statusLine` is drawn by the mod, not settings |
| whole persona | `plugin.json` + a local marketplace entry so `claude` can enable it by name |

Secret references (`secret://...`) are resolved by the CLI at compile time via the configured
provider and written **only** to the generated, gitignored output — never into persona files.

Later targets, cheapest first: `agents-md` (Codex / Copilot / several others), `cursor`,
`gemini-cli`. Each target owns its own lossy-mapping rules and reports what it dropped.

## Switching

`hatrack switch <persona>` (and `/persona switch` in the mod):

1. resolve + compile to `~/.hatrack/build/<persona>/`
2. point the harness at it via the adapter's `activate()` (for Claude Code: relaunch wrapper as
   the deterministic path, in-session plugin toggle + `/reload-plugins --force` as best effort —
   see `03` Appendix A)
3. write `~/.hatrack/state.json` so the status line and `doctor` know

> Amended 2026-10-20: step 2 was "mechanism TBD"; step 3 said `~/.hatrack/current`. Aligned with
> `03-architecture.md` ("Data flows → Switch" and Appendix A).

Project auto-detection: if the cwd (or a parent) contains `.hatrack/persona.yaml` and it is not
the current persona, the mod shows a one-line nudge. Never auto-switch silently.

## Open questions

- **Switch mechanism in Claude Code.** Mostly answered in `03` Appendix A (relaunch primary,
  in-session toggle best effort); the remaining spikes are listed there.
- **Adding to a locked set** (added 2026-10-20). The example locks `permissions.deny`. Does that
  forbid a lower layer from *adding* a deny, or only from removing/changing inherited entries?
  "Fails on any change" reads as the former, which is probably not intended for grow-only sets.
- **Where explicit removals live** (added 2026-10-20). Principle 1 allows removing an unlocked
  `deny` or hook via explicit `remove`, but the shape has no `permissions.remove`, and `hooks`
  `remove: [id]` has no defined position (per event? top-level?).
- **Linearization direction** (added 2026-10-20). Standard C3 puts the child first; merging needs
  root-first (org → … → P). Specify "reverse of C3 MRO" explicitly and cover diamonds in fixtures.

> Amended 2026-10-20: the resolver fixture suite
> (`src/packages/resolver/fixtures/README.md` → "Proposed rule decisions") proposes answers to the
> three questions above plus eight related ambiguities, checked against Claude Code's own
> settings layering as precedent. Notably, Python's first-parent-wins C3 makes this doc's own
> example (`extends: [org/base, area/fintech]`) unresolvable, so the fixtures treat `extends`
> order as ascending precedence (later parent wins).
>
> Accepted 2026-10-20 after review against Claude Code: (a) reusing an inherited instruction id
> replaces it in place (override by name, as everywhere else), so `replace(<id>)` is only for a
> new id; (b) explicit `remove` of unlocked deny/hook entries stays, deliberately looser than
> Claude Code; (c) lock violations fail resolution except in the user overlay, where the entry
> is dropped with a warning. Fold these into the merge table above when the resolver lands.
- **Instruction fragment size.** Concatenation can blow up context. Do we need a budget
  (`maxInstructionTokens`) with a warning, or leave it to the user?
- **Skills registry.** `registry://` implies a registry. v0: git URLs and local paths only.
- **Version pinning for `extends`.** Local git = commit SHA. Control plane = published version.
  Do project files pin ancestors (`org/base@7`) or float? Lean: float locally, pin on publish.
  *Decided 2026-10-22 (`18`):* ancestors float to the latest published version; there are no pins.
  Publishing a parent is checked against its published descendants (`breaks-descendants`), so a
  baseline change reaches every team on its next pull. Pins can come later if asked for.
- **Is `user` a layer or an overlay?** Treat it as the last layer but forbid it from declaring
  `locks` — a user should never be able to lock anything for themselves.
- **Provenance format.** JSON sidecar next to the build, consumed by `--explain` and by the
  paid tier's drift detection.

> **Amendment 2026-10-23 (spec 21):** persona files gain a `policy` block (and
> `targets.claude-code.managed` is treated like it): settable only by `org/`, `area/` and `team/`
> layers, implicitly locked per key by the layer that first sets it. See `21-managed-settings.md` §1.
