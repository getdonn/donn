# 08 — CLI reach: plugins, keychain, diff, and hardening

> Status: design, 2026-10-21. Phase 1, fourth spec. Agreed in conversation section by section.
> Builds on `05-adapter-sdk.md`, `06-cli-core-loop.md` and `07-cli-daily-use.md`. The Claude
> Code mod (status line, nudge, in-session switch) gets its own spec next. Built as a
> `gh stack`: layer 0 is this spec and its plan.

## Intent

Spec 07 made the CLI pleasant for one person on one machine. This spec makes it reach further:
adapters and secret providers that someone else wrote, secrets kept in the operating system's
own store instead of exported variables, a way to see what changes between two personas, and
the deferred minors that matter now that other people's code can plug in.

Done means: a `secret://keychain/...` ref resolves at launch with nothing to install; an
adapter written outside this repo loads from config and passes the conformance kit; and
`zzpersona diff` answers "what changes if I switch to b?" field by field, with provenance.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Built-in providers are `env` and the OS `keychain`; everything else is a provider package | 1Password CLI built in (as `04` planned) | A built-in vendor provider favours one commercial product and ships code most users don't want. The OS store needs nothing installed |
| Secret providers are plugins, loaded exactly like adapters | Built-ins only; a fixed list of vendor backends | One mechanism, one trust model; third parties write their own; 1Password, Vault and AWS SM become packages |
| Plugin packages resolve from `~/.zzpersona/adapters/` | From the personas folder's `package.json`; local paths only | Predictable, kept apart from the CLI's own dependencies, survives CLI upgrades; a personas repo stays plain YAML |
| Plugins load lazily: only when a command needs one that isn't built in | Load every listed plugin at start-up | A broken plugin breaks only the commands that use it; `doctor` loads them all |
| `diff` compares two resolved personas | Compare one persona across git revisions (`--against`) | Answers the daily question (switching); the revision form is a review tool that matters with shared repos and needs git plumbing — open question |
| Windows `keychain` (Credential Manager) waits for Windows support | PowerShell `CredRead` now; a native keyring library | The CLI doesn't run on Windows yet; a native dependency cuts against keeping dependencies light |

## 1. Plugins: third-party adapters and secret providers

`~/.zzpersona/config.yaml` gains two optional lists:

```yaml
personas: ~/personas
adapters: [acme-zzp-cursor, ~/src/my-adapter]
secretProviders: [zzp-provider-1password]
```

**Entries.** An entry starting with `.`, `/` or `~` is a **path**, resolved against the folder
that holds `config.yaml`. Anything else is a **package name**, resolved as Node resolves an
import from `<home>/adapters/` (both lists share that folder). Installing:
`npm install --prefix ~/.zzpersona/adapters <package>`. Nothing is discovered by scanning; only
listed entries are ever imported (`05` §4).

**Adapter contract.** The default export is a `defineAdapter({...})` (`05`). Refused when its
`apiVersion` is not `ADAPTER_API_VERSION`, when its id is a built-in id (`claude-code`), or when
two listed adapters declare the same id.

**Provider contract.** `@zzpersona/secrets` exports `defineSecretProvider({ type, resolve })`,
which validates the declaration and stamps `apiVersion: 1` (`SECRET_PROVIDER_API_VERSION`). The
default export of a provider package is one. Refused on another `apiVersion`, a built-in `type`
(`env`, `keychain`) or a duplicate `type`.

```ts
interface SecretContext {
  env: NodeJS.ProcessEnv;
  /** The CLI's probe runner. Never throws for a missing command: exit code 127. */
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
interface SecretBackend {
  type: string;
  resolve(path: string, config: Record<string, unknown>, ctx: SecretContext): Promise<string | undefined>;
}
```

`resolve`'s third parameter changes from `env` to `ctx` (nothing is published yet). The
all-or-nothing `SecretResolutionError` and the rule that values reach only a launch step's
environment are unchanged (`06` §2); a backend that throws becomes a failure for that ref with
the error's message, never its stack.

**Loading is lazy.** Built-ins are checked first. Listed adapters are imported only when
`--harness` names an id that is not built in; listed providers only when a persona's provider
`type` is not built in. A failure is `plugin-load` naming the entry and the reason:

- not installed → the exact `npm install --prefix <home>/adapters <name>` command;
- the path does not exist;
- no default export, or not a `defineAdapter`/`defineSecretProvider` result;
- `apiVersion` mismatch, built-in id/type, duplicate id/type;
- `--harness <id>` names no loaded adapter → `unknown-harness` listing built-in and loaded ids.

**What a third-party adapter can do.** `zzpersona compile --harness <id>` works with any loaded
adapter. `zzpersona claude` stays Claude Code only; a general launcher is an open question.

**Trust.** A listed plugin runs with your permissions inside the CLI, like any npm package you
install. `doctor` shows exactly what each entry resolved to.

## 2. The built-in `keychain` provider

`secret://keychain/<service>/<account>`: the last path segment is the account, everything
before it the service (`secret://keychain/acme/github/token` → service `acme/github`, account
`token`). Like `env`, the provider name `keychain` needs no declaration; `{ type: keychain }`
under another name also works. No options.

| Platform | Command (via `ctx.run`) | Not found |
|---|---|---|
| macOS | `security find-generic-password -s <service> -a <account> -w` | exit 44 |
| Linux | `secret-tool lookup service <service> account <account>` | exit 1 and empty output |
| other | — | `keychain is not supported on <platform>` |

One trailing newline is stripped; an empty result counts as not found. Failure reasons (never
values): `not found in the keychain`; `secret-tool is not installed (install libsecret-tools)`
on exit 127; otherwise `<command> exited <code>: <first stderr line>`. A ref with fewer than two
path segments is `keychain refs are secret://<provider>/<service>/<account>`.

`zzpersona` never writes secrets. For a missing keychain secret, `doctor`'s fix is the command
that stores it, which prompts for the value so it stays out of shell history:

- macOS: `security add-generic-password -s <service> -a <account> -w`
- Linux: `secret-tool store --label=<service> service <service> account <account>`

The first read may raise macOS's "allow access" dialog for `security`; *Always Allow* stops it
recurring. `doctor`'s fix text says so.

**Windows** (Credential Manager) is not supported yet: no built-in command prints a stored
secret. When Windows support lands, `keychain` gains a `win32` branch using PowerShell and
`CredRead`, with the same ref shape, so persona files work unchanged.

## 3. `zzpersona diff`

```
zzpersona diff <a> <b>      what changes from a to b
zzpersona diff <b>          from the persona `zzpersona claude` would use here (07 §1) to b
```

Both are resolved as a launch would resolve them, user overlay included. No provider is called:
the resolved persona holds secret refs, never values, so `diff` works with no secrets set up.

**Comparison** is a pure `diff(a, b)` in `@zzpersona/resolver`, next to `explain()`, over the
paths provenance already uses (`mcp.gateway`, `permissions.deny[Bash(rm -rf:*)]`,
`instructions[conduct]`): the union of both personas' provenance paths, each value compared
structurally. Each difference is `added` (only in b), `removed` (only in a) or `changed`, with
the layer that set it on each side. `metadata` is skipped; locks are compared by path.

Plain output, sorted by path:

```
team/payments → team/platform   (3 differences)
+ permissions.deny[Bash(kubectl delete:*)]     team/platform
- mcp.servers.payments-db                      team/payments
~ targets.claude-code.model  sonnet → opus     org/base → team/platform
```

Scalars print inline; objects and multi-line text print `(changed)`. Identical personas print
`no differences`. Exit 0 whether or not they differ; resolution errors use the usual envelopes.

`--json`: `{ "from", "to", "changes": [{ "path", "change", "from"?, "to"?, "fromLayer"?,
"toLayer"? }] }` with full values.

## 4. Hardening

Fixed (one failing-first test each):

| Minor | Fix |
|---|---|
| `defineAdapter` and the conformance kit spread the declaration, so a class-based adapter loses its prototype methods | Build the adapter from its named fields; methods are kept |
| `Probe.platform: NodeJS.Platform` puts `@types/node` in the public types | An SDK-owned `Platform` string union |
| `runConformance`'s `chdir` throws outside `outcome()` under vitest's threads pool | Reported as a failed no-writes check naming the `forks` pool requirement |
| `targets.claude-code.strictMcp: "false"` (a string) counts as true | Must be a boolean; otherwise `AdapterInputError` |
| Any `managed-settings.d` drop-in with `disableSideloadFlags: true` counts, even if a later one sets `false` | Merge `managed-settings.json`, then drop-ins in name order; the last value wins |
| Removing the only secret from a `targets` env block leaves `"env": {}` | Empty objects are dropped |
| Concurrent `switch` commands can lose an entry | Re-read `state.json` immediately before writing |
| `switch --default project/persona` is accepted, then stale outside projects | Refused: `invalid-default` |
| `switch --default` without a persona shows the project switch; `switch --clear <persona>` ignores the persona | Shows the default; the extra argument is refused (`usage`) |
| `doctor --fix` removes switches for unmounted volumes or branches without `.zzpersona` | Removes an entry only when its repo folder is gone; otherwise warns |
| A combined `init` that half fails doesn't report the half that succeeded | The error's details carry `created`/`updated` so far |
| A quoted `~/p/` keeps its trailing slash, so re-running `init` is refused | `expandPath` strips trailing slashes |
| `init --force` cannot repair an unparseable `config.yaml` | With `--force`, an unparseable config is replaced |
| A project file symlinked to `../AGENTS.md` is refused by `readText` containment | The project mount's containment root is the repo root (the parent of `.zzpersona`) |
| `--json` envelopes of `CliError` have no message | Every envelope carries `message` |
| An old `claude` hides doctor's managed-settings degraded-mode warning | Version and mode reported independently |
| An empty `ZZPERSONA_HOME` skips doctor's writability check of the fallback home | The fallback home is checked |
| `switch` on a read-only home shows a stack trace | A `filesystem` envelope, as `init` gives |

Not fixed, with the reason:

- **Windows** (`claude.cmd` shim, `~\`, backslashes in hook script names): one Windows project
  later.
- **`writeBuild` check-then-copy gap**: needs a local attacker who can already write to the
  personas folder.
- **Blank lines from an empty instruction**: cosmetic.
- **`team/platform-payments` and `team/platform/payments` share a plugin name**: moves to the
  mod spec, where the folder-of-plugins switch makes it matter.

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `sdk-hardening` | `defineAdapter` keeps methods; `Platform`; conformance `chdir` report |
| 2 `claude-code-hardening` | `strictMcp`, `managed-settings.d` order, no empty `env` |
| 3 `secrets` | `SecretContext`, `defineSecretProvider`, `keychain` |
| 4 `plugins` | config lists, path and package resolution, lazy loading, `plugin-load`, `compile --harness <third-party>` |
| 5 `diff` | `diff()` with fixtures; `zzpersona diff` |
| 6 `cli-hardening` | the CLI rows of section 4 |
| 7 `doctor-e2e` | doctor's `plugins` check and keychain fix hints; e2e; changeset; CLAUDE.md |

Testing:

- **Plugins:** a fixture adapter written as a class loads from a path and passes
  `runConformance`; a fixture package in a temporary `<home>/adapters/node_modules` loads by
  name; a missing package gets the exact install hint; `apiVersion` mismatch, built-in id,
  duplicate id and unknown provider type each fail; a broken listed adapter does not affect
  `zzpersona claude`.
- **Keychain:** a fake `run` covers every exit code on both platforms and the bad-ref case;
  opt-in `ZZP_E2E=1` on macOS stores a throwaway item, resolves it through
  `zzpersona claude --dry-run`, then deletes it.
- **diff:** resolver fixture pairs (keyed-list entries, a lock, a target setting, identical
  personas); CLI tests for both forms, `--json`, and an unknown persona.
- **Hardening:** one failing-first test per fixed row.

## Non-goals (this spec)

1Password and any other provider package; Windows; `launch --harness`; `diff --against`; the
mod; `overlay` execution; publishing (blocked on the name).

## Open questions

1. **A general launcher.** `zzpersona launch --harness <id>` running any adapter's activation
   plan, once a second adapter exists to prove the plan executor is general.
2. **`diff --against <rev>`.** Compare a persona across git revisions of the personas folder,
   for reviewing changes to a shared personas repo.
3. **Windows `keychain`.** PowerShell `CredRead`, as above.
4. **Plugin trust.** Anything listed runs with your permissions. A pinned-hash check (a
   lockfile for `<home>/adapters`) before import matters once teams share configs.
