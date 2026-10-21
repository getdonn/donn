# 05 — Adapter SDK and the Claude Code adapter

> Status: design, 2026-10-21. Phase 1, first spec. Covers `@zzpersona/adapter-sdk` and
> `@zzpersona/adapter-claude-code`. The CLI's plan executor gets its own spec next. Agreed in
> conversation section by section; this document is the reviewable record. Placeholder name
> `zzpersona` per `00-handoff.md` → "Naming".

## Intent

Phase 1's goal (`04`): a solo developer defines personas and switches between them in Claude
Code, and it is better than shell aliases. The SDK is the contract every harness adapter
implements. Today only we write adapters, but third parties will want to write their own to
fit internal harnesses and practices, so the contract must be open to them from the start.

Success:
- The Claude Code adapter turns any resolved persona into a build that the verified relaunch
  path (`spikes/claude-code/FINDINGS.md`) launches correctly.
- Nothing is lost silently: every IR value the harness cannot honor appears in the compile
  report, checked mechanically.
- A third party can write an adapter against the published SDK and prove it with the same
  conformance kit we use.
- The contract demonstrably fits the next two adapters (`agents-md`, `codex`) on paper before
  it is frozen.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Adapters are TypeScript packages loaded in-process, with a **data-only** contract | Any-language executables over stdio from day one; TypeScript with no openness | Data in and data out keeps a later subprocess bridge possible for other languages without changing the contract, without paying for process plumbing now |
| `compile` and `activate` are **pure**; `activate` returns a **plan** of steps the CLI carries out | Imperative adapters that write files and launch processes (the `03` sketch); a launch-only plan | Pure adapters are testable and safe to load from third parties; the CLI owns side effects consistently and can show them with `--dry-run`; a step list covers both relaunch and file overlay |
| `deactivate()` and `current()` leave the adapter | Keep them per adapter, as `03` sketched | Undoing an overlay is generic (the CLI finds its markers); which persona is live is CLI state |
| "No silent loss" is derived from the capability matrix and checked by the conformance kit | Trust each adapter's report | The guarantee is the product; it must not depend on each adapter remembering |
| Adapters are loaded only when named: first-party built in, third-party listed in config | Auto-discover packages by naming convention | An adapter is code running in the CLI; only explicitly listed code runs |

## 1. The adapter interface

```ts
interface HarnessAdapter {
  apiVersion: 1;                        // stamped by defineAdapter()
  id: string;                           // kebab-case, e.g. "claude-code"
  irVersions: readonly number[];        // IR versions accepted, e.g. [0]
  capabilities(): CapabilityMatrix;     // static (section 2)
  detect(probe: Probe): Promise<Detection>;
  compile(input: CompileInput): CompileOutput;     // pure, synchronous
  activate(input: ActivateInput): ActivationPlan;  // pure, synchronous
}
```

### detect

The only method that observes the machine, and only through the `Probe` the CLI passes in:

```ts
interface Probe {
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string | undefined>;   // undefined when absent
  platform: NodeJS.Platform;
}
interface Detection {
  installed: boolean;
  version?: string;
  /** Adapter-specific facts that change compile or activate, e.g. managed-settings restrictions. */
  facts: Record<string, string | number | boolean>;
}
```

Tests pass a fake probe. `detect` never throws for "not installed"; it returns `installed: false`.

*Amended 2026-10-21 (implementation plan, Task 1):* `Probe` gains
`listDir(path): Promise<string[] | undefined>`, needed to read `managed-settings.d/`. And
`ActivateInput` (below) gains `ir: ResolvedPersona` and `output: CompileOutput`: `activate` must
know what `compile` produced, e.g. whether `system-prompt.md` exists, to choose its flags.

### compile

```ts
interface CompileInput {
  personaId: Ref;                       // e.g. "project/checkout-api"
  ir: ResolvedPersona;
  detection: Detection;
  /** Text of every file the IR references by path (instruction files), keyed by
   *  personas-root-relative path. The CLI reads them before compiling. */
  texts: Record<string, string>;
}
interface CompileOutput {
  /** Build-dir-relative paths. */
  files: Record<string, FileEntry>;
  /** Placeholder env var → secret ref. Files contain `${NAME}`, never values. */
  secretEnv: Record<string, `secret://${string}`>;
  report: CompileReport;                // section 2
}
type FileEntry =
  | { content: string; mode?: 0o600 | 0o644 | 0o755 }
  /** Copied by the CLI from a personas-root-relative path (a file or a directory): skills,
   *  hook scripts. Keeps compile pure without loading whole skill trees into memory. */
  | { copyFrom: string; mode?: 0o600 | 0o644 | 0o755 };
```

*Refined while writing this spec:* the conversation's section 1 had no way for a pure `compile`
to obtain instruction file text or skill directories. `texts` and `copyFrom` close that gap
without giving adapters file access.

### activate

```ts
interface ActivateInput {
  buildDir: string;                     // absolute; the CLI wrote `files` here
  detection: Detection;
  cwd: string;                          // the project directory
  passthrough: string[];                // extra args the user gave after `--`
}
interface ActivationPlan { steps: Step[] }
type Step =
  | { kind: "launch"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "overlay"; path: string; content: string };    // project-relative
```

The CLI writes builds to `~/.zzpersona/build/<persona>/<adapter>/` (directory `0700`), adds an
ownership marker to every overlay and refuses to overwrite a file it does not own, resolves
`secretEnv` refs just before a `launch` and adds them to its `env`, then carries out the steps
in order. New step kinds (a `notify` for the mod, a `settings-local` for in-session
permissions) can be added later without breaking adapters that don't emit them.

## 2. Capability matrix and compile report

```ts
type Support = "native" | "approximated" | "advisory" | "none";
//  native        same meaning, enforced by the harness
//  approximated  expressed with different semantics
//  advisory      rendered as instruction text the model may ignore
//  none          dropped

type CapabilityField =
  | "instructions" | "skills" | "mcp.servers" | "knowledge" | "secrets"
  | "permissions.allow" | "permissions.deny" | "permissions.ask"
  | `hooks.${HookEvent}` | `targets.${string}`;

interface CapabilityMatrix {
  fields: Partial<Record<CapabilityField, { support: Support; note?: string }>>;  // absent = "none"
}

interface CompileReport {
  adapter: string;
  irVersion: number;
  mode?: string;                        // set when detection changed the strategy
  entries: ReportEntry[];               // lossy items only
}
interface ReportEntry {
  path: string;                         // IR path grammar from @zzpersona/spec
  outcome: "approximated" | "advisory" | "dropped";
  reason: string;
  lock?: { path: string; layer: Ref };  // added by the SDK, never by the adapter
}
```

- **Required entries.** `requiredEntries(matrix, ir)` lists, for every IR value under a field
  whose support is not `native`, the entry a report must contain (`dropped` for `none`, else
  the support level). Adapters supply reasons and may add entries for anything else they lose
  (a skill from an unsupported source, a server form the harness lacks).
- **Locks.** `annotateLocks(report, ir)` marks every entry whose path a lock covers, using
  `lockCovers` from the spec. The CLI highlights these ("policy from org/base is only advisory
  in agents-md"); `--strict` makes them errors.
- **Docs.** The published capability table is generated from each adapter's matrix.

## 3. Conformance kit

Exported as `@zzpersona/adapter-sdk/conformance`.

- `runConformance(adapter, options) → Promise<CheckResult[]>` is framework-neutral: each result
  is `{ name, corpusEntry?, passed, reason? }`. `conformanceSuite(adapter)` wraps it as vitest
  tests (vitest is an optional peer dependency).
- **Corpus** shipped with the kit: `minimal` (fixture 001's shape), `full` (fixture 002's
  resolved IR, copied by a generator script, with a test that fails if it drifts from the
  resolver fixture), and `kitchen-sink` (every hook event, every MCP server form, secret refs,
  a lock on each field, long instructions). Each entry comes with the `texts` its file
  references need.
- **Checks**, per corpus entry:
  1. Declaration: kebab-case `id`, known matrix fields, an unsupported `irVersion` rejected with
     `UnsupportedIrVersionError` rather than compiled.
  2. Determinism: compiling twice and activating twice give deep-equal results.
  3. Well-formed output: relative file paths without `..`, valid modes, `copyFrom` paths inside
     the personas root, overlay paths inside the project, `launch` has a command.
  4. No secret leaks: no `secret://` string in any file content or launch argument; every
     secret ref in the IR is in `secretEnv` or reported `dropped`.
  5. No silent loss: the report contains every `requiredEntries` item; its paths exist in the
     IR; its lock annotations match the kit's own.
  6. `detect` with a fake "not installed" probe returns `installed: false` without throwing.
- **Golden builds.** `renderBuild(output, plan)` renders files, report and plan as stable text;
  each adapter keeps one golden file per corpus entry (as `explain.txt` does for the resolver).
- **Not enforceable in-process:** that `compile` and `activate` truly avoid I/O. The kit catches
  the symptoms (non-determinism; nothing written to a temporary working directory) and the rule
  is part of the documented contract.

## 4. Packaging and loading

- `@zzpersona/adapter-sdk` (`src/packages/adapter-sdk/`): types; `defineAdapter()`, which stamps
  `apiVersion` and validates the declaration; `requiredEntries()`; `annotateLocks()`;
  `renderBuild()`; error classes; the `./conformance` subpath. Depends only on
  `@zzpersona/spec`.
- `@zzpersona/adapter-claude-code` (`src/packages/adapters/claude-code/`): default export is a
  `defineAdapter({...})`.
- `ADAPTER_API_VERSION = 1`. The CLI refuses an adapter with another major version. Separately,
  each adapter's `irVersions` lets the IR evolve independently.
- Loading, explicit only: first-party adapters from a built-in id → package map (CLI
  dependencies); third-party ones from `adapters:` in `~/.zzpersona/config.yaml` (package name
  or local path), loaded with `import()`. No scanning of `node_modules`.
- Per-harness settings: an adapter reads `ir.targets[<its id>]`; no spec change is needed for a
  third-party adapter to get its own settings block.

## 5. The Claude Code adapter

Grounded in `spikes/claude-code/FINDINGS.md` (Claude Code v2.1.306).

### detect

- `claude --version` → `installed`, `version`.
- Managed settings, read through the probe (macOS `/Library/Application Support/ClaudeCode/`,
  Linux `/etc/claude-code/`): `managed-settings.json` and `managed-settings.d/*.json` for
  `disableSideloadFlags`; presence of `managed-mcp.json`. Recorded as `facts.sideloadBlocked`
  and `facts.managedMcp`.

### compile (mode `relaunch`)

| IR | Build output | Support |
|---|---|---|
| `instructions` | `system-prompt.md`: fragments in order, inline text or `texts[file]`, separated by blank lines | native |
| `skills` | local sources: `plugin/skills/<name>/` via `copyFrom`. `registry://` sources: reported `dropped` (no registry in v0) | native |
| `hooks.*` | `plugin/hooks/hooks.json` with events mapped (`pre-tool-use` → `PreToolUse`, …, all nine); scripts via `copyFrom` into `plugin/hooks/scripts/`, invoked as `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/<file>` | native |
| `mcp.servers` | `mcp.json`. `command` and `url` forms map directly; `secret://` env values become `${ZZP_SECRET_<n>}` in `secretEnv`. `gateway://` refs: reported `dropped` until gateway resolution exists | native |
| `permissions.*` | `settings.json` → `permissions.allow/deny/ask` | native |
| `secrets` | refs become `${ZZP_SECRET_<n>}` placeholders (Claude Code expands `${VAR}` in MCP config); the CLI supplies values as launch env | native |
| `targets.claude-code` | `settings.json` leaves (e.g. `model`, `outputStyle`), except adapter keys below | native |
| `knowledge` | appended to `system-prompt.md` as a "Knowledge sources" list of pointers | advisory |
| whole persona | `plugin/.claude-plugin/plugin.json`, plugin name `zzp-<personaId with / → ->` | — |

Adapter keys in `targets.claude-code` (consumed, not written to settings): `strictMcp` (default
`true`; `false` omits `--strict-mcp-config` so the user's own MCP servers stay visible).

### Degraded modes, from detection

- `sideloadBlocked` (`disableSideloadFlags`): `--plugin-dir` and `--mcp-config` are rejected,
  but `--settings` and `--append-system-prompt-file` still work. Mode `partial`: launch with
  instructions and permissions only; skills, hooks and MCP servers reported `dropped` with the
  reason. (The full marketplace path is Phase 3.)
- `managedMcp` (`managed-mcp.json` present): `--mcp-config` and `--strict-mcp-config` make
  Claude Code exit, so omit both. Mode `relaunch-no-mcp`; MCP servers reported `dropped`.

### activate

One `launch` step:

```
claude --plugin-dir <buildDir>/plugin --settings <buildDir>/settings.json
       --mcp-config <buildDir>/mcp.json --strict-mcp-config
       --append-system-prompt-file <buildDir>/system-prompt.md  <passthrough…>
```

minus whatever the mode forbids. The CLI adds the resolved secret env vars.

## 6. The contract on paper: next adapters

**`agents-md`** (Phase 2): `compile` → one `AGENTS.md` content string: instructions, then
advisory sections rendering permissions ("Never run: …"), MCP servers and knowledge as text.
Matrix: `instructions` native; `permissions.*` and `knowledge` advisory; everything else none.
`activate` → one `overlay` step writing `AGENTS.md` at the project root. Fits, with the open
question below about repos that already have their own `AGENTS.md`.

**`codex`** (Phase 2): `compile` → `developer-instructions.md`, plus MCP servers rendered as
`-c mcp_servers.<n>={…}` arguments; secrets as env placeholders. Matrix: `instructions` and
`mcp.servers` native; `permissions.*` approximated (approval policy and sandbox, not per-rule).
`activate` → one `launch` step: `codex -c developer_instructions=… -c mcp_servers.…`. Fits, with
the open question below about long instructions on the command line.

Both fit without changing sections 1–4, which is the point of checking now.

## Testing

- `adapter-sdk`: unit tests for `requiredEntries`, `annotateLocks`, `renderBuild`,
  `defineAdapter`. The conformance kit is tested against a toy adapter that passes and a set of
  deliberately broken toy adapters, one per check, each of which must fail exactly that check.
- `adapter-claude-code`: `conformanceSuite(adapter)`; golden `renderBuild` files for each corpus
  entry in each mode (`relaunch`, `partial`, `relaunch-no-mcp`); `detect` against fake probes.
  An opt-in end-to-end test (`ZZP_E2E=1`) launches real `claude -p` against the `full` build,
  as the spike did, and checks the codewords.

## Non-goals (this spec)

The CLI and its plan executor (next spec); in-session switching and the mod; the marketplace
activation path; gateway resolution; implementing `agents-md` or `codex`; skill registries.

## Open questions

1. **`agents-md` and an existing `AGENTS.md`.** An overlay is a whole file, and the CLI refuses
   to overwrite a file it doesn't own. Should overlays support a managed block (persona text
   between markers inside the repo's own file)? Decide when building `agents-md`.
2. **Codex instruction length.** `-c developer_instructions=…` puts the whole text on the
   command line. Check whether Codex has a file-based option before building `codex`; if not,
   measure the practical limit.
3. **Plugin name.** `zzp-<personaId>` makes skills show as `zzp-project-checkout-api:<skill>`.
   Readable enough, or use the persona's `metadata.name`, which is not guaranteed unique?
4. **Hook script paths.** Copying scripts into the build keeps builds self-contained but means
   a script edit needs a rebuild; the daemon's watchers (Phase 2) would make that automatic.

## Amendments from implementation and review (2026-10-21)

Made while building this spec (`docs/plans/2026-10-21-adapter-sdk.md`) and fixing a whole-branch
review. Each overrides the section it names.

- **§1 `capabilities(detection?)`.** With a detection, an adapter returns the matrix for the mode
  that detection puts it in (Claude Code `partial` declares skills, hooks, MCP servers and secrets
  `none`). The conformance kit judges each mode against its own matrix; with a single static
  matrix, a degraded mode that forgot to report its losses passed every check.
- **§2 `requiredEntries(adapterId, matrix, ir)`.** The adapter id is needed so only
  `targets.<own id>` counts as loss. Secret locations are found anywhere in a server definition
  (env, headers, args, url), not only env.
- **§3 conformance.** `./conformance` exports `runConformance` and the corpus; the vitest wrapper
  is `./conformance/vitest`, so teams on other runners never load vitest. `no-silent-loss`
  accepts an entry that is at least as lossy as required (`approximated` < `advisory` <
  `dropped`) and lets an entry for a parent path (a dropped server) cover its children. The
  `kitchen-sink` entry locks three fields, not every field, and puts secret refs in env, args,
  headers and targets.
- **§3, new SDK helper `isContainedPath(path)`.** Rejects empty, absolute (POSIX, drive letter,
  UNC, root-relative Windows) and `..` paths. Adapters must reject `copyFrom` sources that fail it
  (`AdapterInputError`); the CLI must still re-check real paths, symlinks included, when copying.
- **§5 settings.** `targets.claude-code.permissions` may set keys such as `defaultMode`, but never
  `allow`, `deny` or `ask`; those come only from the persona's `permissions` and any in targets
  are reported `dropped`. Without this, any layer could silently replace org-locked rules.
  Secret refs inside `targets.claude-code` are reported `dropped` and left out of
  `settings.json`.
- **§5 hook scripts** are named `<event>-<id>-<basename>`: hook ids are unique per event only.
- **§5 flag order** is `--plugin-dir`, `--mcp-config` (+ `--strict-mcp-config`), `--settings`,
  `--append-system-prompt-file`, passthrough. `--mcp-config` takes several files, so a
  non-variadic flag must follow it or a positional prompt is read as a config file.
