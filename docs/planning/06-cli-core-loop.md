# 06 — CLI core loop: store, secrets, executor, and `donn claude`

> Status: design, 2026-10-21. Phase 1, second spec. Agreed in conversation section by section.
> Covers `@getdonn/store-local`, `@getdonn/secrets`, `@getdonn/executor` and the first
> commands of `@getdonn/cli`. Spec 07 adds `init`, `switch` (+ `state.json`), `doctor`,
> `diff` and the 1Password provider. Built as a `gh stack`: layer 0 is this spec and its plan.
> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).

## Intent

The Phase 1 exit question (`04`): *do I switch personas more than once a day without thinking
about it?* That needs one command that turns personas on disk into a correctly configured
Claude Code session. Success: in a repo whose `.donn/persona.yaml` extends a team persona
from your personas folder, `donn claude` launches Claude Code with that persona's
instructions, skills, hooks, MCP servers and permissions, using the relaunch path verified in
`spikes/claude-code` and built by the adapter from `05`.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Split the CLI into this core loop (06) and the remaining commands (07) | One CLI spec | Four mostly independent pieces; the loop is the "better than aliases" moment and should land first |
| Personas live in one git personas folder, plus the project's `.donn/`, plus `~/.donn/` | Several registered folders; only `~/.donn/` | One folder needs no cross-folder conflict rule and still models a team publishing a shared persona |
| One virtual root, **mounted by layer** (first path segment) | Absolute paths in the IR; copying sources into a staging folder per run | Resolver, IR and adapters stay unchanged and machine-independent; containment is checked per mount in one place |
| No persona argument means the nearest project persona | Always require a name; remember the last one | Natural in a repo; "last used" can silently pick the wrong persona and belongs with `switch` in 07 |
| Unresolvable secrets stop the launch | Launch anyway with a warning | A Claude Code session whose MCP server silently lacks its token is worse than no session |
| Executor is its own package | Inside the CLI | The daemon (Phase 2) will run the same plans |

## 1. Config and `@getdonn/store-local`

`~/.donn/config.yaml` (the whole directory moves with `DONN_HOME`), owned and
zod-validated by the CLI:

```yaml
personas: ~/personas   # the personas folder, a git checkout; needed for org/area/team refs
```

`store-local` never reads config; it receives mounts:

```ts
interface Mounts {
  personas?: string;   // ~/personas
  project?: string;    // <repo>/.donn, when inside a project
  user: string;        // ~/.donn
}
function createLocalStore(mounts: Mounts): LocalStore;

interface LocalStore extends PersonaSource {            // load(ref) feeds resolve()
  physicalPath(virtualPath: string): string | undefined; // undefined when the mount is absent
  readText(virtualPath: string): Promise<string>;        // instruction files → compile's `texts`
  list(): Promise<Ref[]>;
}
function findProject(cwd: string): string | undefined;   // nearest .donn/persona.yaml, walking up
```

*Refined 2026-10-21 (implementation plan):* `physicalPath(virtualPath): string | undefined`
became `locate(virtualPath): { path: string; root: string } | undefined`, because the executor's
containment check needs the mount root as well as the path. `strayLayerDirs()` reports the
ignored `project/` and `user/` folders for the CLI's warning.

| Virtual path | Physical location |
|---|---|
| `org/…`, `area/…`, `team/…` | `<personas>/org/…` etc. |
| `project/persona` (the fixed project ref) | `<repo>/.donn/persona.yaml` |
| `project/…` (other files) | `<repo>/.donn/…` |
| `user/overrides` (the overlay) | `~/.donn/overrides.yaml` |
| `user/…` (other files) | `~/.donn/personas/…` |

A ref `R` is the file at the physical path of virtual path `R.yaml`. A missing file returns
`undefined` (the resolver reports `missing-ref`); invalid YAML throws `StoreError` naming the
file and line; a ref whose mount is absent (e.g. `team/x` with no `personas:`) throws
`StoreError` naming the config key to set. `findProject` stops at the first match walking up,
so a nested project wins. `list()` ignores `project/` and `user/` folders inside the personas
folder (they are mounted elsewhere) and the CLI warns about them. No git commands: keeping the
personas folder current is `git pull` in Phase 1, the daemon's job later.

## 2. `@getdonn/secrets`

Refs are `secret://<provider>/<path>`. The provider name is looked up in the resolved
`secrets.providers`; its `type` picks the backend.

```yaml
secrets:
  providers:
    local: { type: env }      # secret://local/SCHEMA_TOKEN → $SCHEMA_TOKEN
```

- Phase 1 ships one backend, `env`: the path is an environment variable name. A provider named
  `env` needs no declaration (`secret://env/GITHUB_TOKEN`).
- Any other type fails with "provider type `<type>` is not supported yet".

```ts
interface SecretBackend {
  type: string;
  resolve(path: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string | undefined>;
}
function resolveSecrets(
  refs: string[],
  providers: ResolvedPersona["secrets"]["providers"],
  options?: { backends?: SecretBackend[]; env?: NodeJS.ProcessEnv },
): Promise<Record<string, string>>;   // ref → value
```

`resolveSecrets` collects every failure (undeclared provider, unsupported type, unset
variable, malformed ref) and throws one `SecretResolutionError` listing each ref and reason.
Values only ever reach a `launch` step's env: never a file, a log, an error message or `--json`
output (which shows refs and placeholder names only).

## 3. `@getdonn/executor`

```ts
function nodeProbe(): Probe;
function buildDirFor(personaId: Ref, projectDir: string | undefined, adapter: string, home: string): string;
function writeBuild(output: CompileOutput, options: { buildDir: string; store: LocalStore }): Promise<void>;
function runPlan(plan: ActivationPlan, options: { secretEnv: Record<string, string>; env?: NodeJS.ProcessEnv }): Promise<number>;
```

- **Probe.** `run` uses `execFile` with a 10 s timeout; a missing command returns exit code
  `127`, never throws. This becomes the documented `Probe.run` contract in the SDK (amends
  `05` §1). `readFile`/`listDir` return `undefined` for absent paths.
- **Build location.** `<home>/build/<slug>-<hash8>/<adapter>/`: slug is the persona id with `/`
  → `-`; `hash8` is the first 8 hex characters of SHA-256 over the persona id and the project
  directory (every repo's project persona is `project/persona`, and two repos must not share a
  build). `<home>/build/` is `0700`.
- **`writeBuild`** writes a temporary sibling directory and swaps it in, so a failed build
  never leaves a partial one. `copyFrom` sources go through the store; the real path (symlinks
  followed) of the source, and of every entry inside a copied directory, must stay inside the
  real path of its mount, or the build fails. `overlay` steps are refused ("not supported
  until the agents-md adapter").
- *Amended 2026-10-21 (whole-stack review):* the build directory is a **symlink** to a version
  directory (`<buildDir>.v-<random>`). `writeBuild` writes the new version, then, under a
  per-build `mkdir` lock (`<buildDir>.lock`, owner pid recorded, a dead owner's lock taken over,
  30 s timeout), atomically repoints the symlink and removes the previous version. Two
  concurrent builds of one persona no longer crash, and the build directory is never missing
  while a session starts. Filesystem errors become `ExecutorError`s naming the source.
- *Amended 2026-10-24:* the replaced version is kept, behind a `<buildDir>.prev` symlink, until
  the next swap, so a reader that resolved the link just before a swap does not lose the
  directory mid-read (`donn doctor --fix` leaves it alone). "Never missing" holds on Linux; on
  macOS a lookup racing the `rename(2)` of the symlink can briefly fail (measured: about 1% of
  lookups during back-to-back swaps, none on Linux), so readers there should tolerate a
  transient `ENOENT` during a rebuild.
- **`runPlan`** spawns each `launch` step with `stdio: "inherit"`, env = current env + step env +
  resolved secrets, and the step's `cwd`; forwards `SIGINT`/`SIGTERM`; resolves to the child's
  exit code.

## 4. `@getdonn/cli` (`src/apps/cli`)

The `donn` binary, built on `commander`. Every command runs through
`createCli({ env, cwd, stdout, stderr, probe })` so tests run in-process.

**Choosing a persona.** No argument → `project/persona` from `findProject(cwd)`, or an error
listing available personas. A full ref (`team/payments`) is used as is. A bare name
(`payments`) resolves if exactly one listed ref ends with `/payments`; otherwise an error lists
the candidates. The overlay `~/.donn/overrides.yaml` applies when present; `--no-overlay`
skips it.

| Command | Does | `--json` |
|---|---|---|
| `donn resolve [persona] [--explain]` | Prints a summary (name, layers, warning count); `--explain` prints `explain()` | the `ResolveResult` |
| `donn compile [persona] [--harness claude-code] [--dry-run]` | Detects, compiles, writes the build; prints its directory and the compile report. `--dry-run` writes nothing | `{ buildDir, report, secretRefs, plan }` |
| `donn claude [persona] [--mode partial\|relaunch-no-mcp] [--dry-run] [-- args…]` | Resolve → detect → compile → write → resolve secrets → launch `claude`; args after `--` pass through | implies `--dry-run`; prints the plan as JSON |

- `--harness` accepts only `claude-code` in Phase 1 (the first-party adapter map; third-party
  loading from config is spec 07).
- `--mode` overrides detection's managed-settings facts. Policy delivered by MDM, registry or
  server is invisible to `detect`; if `claude` exits non-zero within 5 s of starting, the CLI
  prints: "If Claude Code said flags are disabled by managed settings, retry with
  `--mode partial`."
- `--dry-run` prints `renderBuild` output and writes or launches nothing.
- Errors print one message (resolver errors in `explain`'s wording) and exit `1`; once `claude`
  is launched, its exit code is ours. With `--json`, errors are `{ "error": { "code", … } }` on
  stdout. Resolver warnings and compile-report entries go to stderr, so piped `--json` stays
  clean. Plain text, no colors.
- Dogfooding while packages are private: `pnpm --filter @getdonn/cli link --global`, or a
  root `donn` script.

## Testing

- `store-local`: mount mapping table, missing and invalid files, absent mounts, `findProject`
  nesting, `list()` ignoring stray `project/`/`user/` folders.
- `secrets`: every failure kind collected into one error; values never in messages.
- `executor`: `nodeProbe` on a missing command returns 127; build dir hashing separates two
  projects; atomic replacement; containment rejects an escaping `copyFrom` and an escaping
  symlink inside a copied directory; `runPlan` passes env and returns the exit code (run against
  `node -e`).
- `cli`: commands in-process against a temporary `DONN_HOME` and a personas folder seeded
  from resolver fixture `002`, with a fake probe; persona selection rules; `--json` shapes and
  error envelopes. Opt-in `DONN_E2E=1`: the built binary runs `donn claude --dry-run`, then
  a one-turn `-p` launch against real `claude`.

## Non-goals (this spec)

`init`, `switch`/`state.json`, `doctor`, `diff`, the 1Password provider, third-party adapter
loading, `overlay` execution, colors, the daemon, in-session switching.

## Open questions

1. **Hook scripts in a replaced build.** A running session's hooks point into the build
   directory; rebuilding the same persona mid-session swaps their scripts. Same persona, so
   usually harmless; revisit with in-session switching.
2. **Bare-name matching.** Last-segment matching is simple; if personas folders grow, a
   `metadata.name` lookup may read better. Revisit with real use.
