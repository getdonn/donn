# 12 — The Codex adapter and `donn codex`

> Status: design, 2026-10-21. Phase 2, second spec: the real second harness. Builds on
> `spikes/codex/FINDINGS.md` (Codex CLI 0.163.0, probed in `exec` and the TUI), `05-adapter-sdk.md`
> and the Claude Code launch path (`06`, `10`). Built as a `gh stack`: layer 0 is this spec and its
> plan.
> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).

## Intent

A persona authored once launches Codex as well as Claude Code: `donn codex` starts Codex with
the persona's instructions, MCP servers and secrets, sensible sandbox defaults, and a report that
says exactly what Codex cannot take. This is Phase 2's exit question in practice: two harnesses,
one persona, a loss report people find credible.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| Relaunch model: everything as `-c` overrides on the command line | A `-p` profile file in `~/.codex`; `CODEX_HOME` | Nothing written to the user's Codex config; `CODEX_HOME` moves the login (spike) |
| Instructions through `developer_instructions` | `model_instructions_file` | The latter replaces Codex's own base instructions (spike) |
| Permissions: `-s workspace-write -a on-request` by default, MCP tool allow rules exact, shell/file rules as guidance; `targets.codex` overrides | Derive the sandbox from the rules; drop permissions entirely | Codex has no per-rule allow/deny on the command line; a derived sandbox guesses wrong silently; dropping leaves the persona no say in safety |
| Skills and hooks dropped | Install a plugin into `~/.codex`; pass `--dangerously-bypass-hook-trust` | No per-launch skill root; the bypass trusts the repo's hooks too |
| Two servers needing one variable name with different secrets: the second is dropped | Give both the first secret; fail the launch | Never hand a server the wrong secret; one conflict should not block the session |

## 1. The adapter (`@getdonn/adapter-codex`)

**Compile** writes `instructions.md` to the build (header naming the persona and its layers,
instructions, `## Knowledge sources`, `## Tool rules` guidance as `agents-md` renders it) and a
report. `secretEnv` maps each secret-holding environment variable to its ref.

**MCP servers** become `-c mcp_servers.<name>=<inline table>` in `activate`:

- stdio: `command`, `args`, plain environment values as `env={…}`, secret values forwarded by
  name with `env_vars=[…]` (the CLI puts the resolved values in the launch environment);
- URL servers: `url=…`;
- gateway refs: dropped (as Claude Code);
- a server whose secret variable name another server already uses with a different ref: dropped,
  reason `another MCP server already uses <VAR> for a different secret; Codex forwards variables by name`.

**Permissions:** an allow rule `mcp__<server>__<tool>` becomes
`-c mcp_servers.<server>.tools.<tool>.approval_mode="approve"` (native); every other rule is
rendered as guidance and reported `approximated`.

**Activate** returns one launch step:

```
codex -s <sandbox> -a <approval> -c developer_instructions="<instructions.md>" \
      [-c mcp_servers.<name>={…}]… [-c mcp_servers.<s>.tools.<t>.approval_mode="approve"]… \
      [-m <model>] <passthrough>
```

`sandbox` defaults to `workspace-write`, `approval` to `on-request`; `targets.codex.sandbox`,
`targets.codex.approval` and `targets.codex.model` override them. A sandbox of
`danger-full-access` or an approval of `never` is reported `advisory` ("looser than donn's
default"). Every `-c` value is encoded as TOML (basic strings with quotes, backslashes, control
characters and newlines escaped; inline tables), because Codex parses `-c` values as TOML.

| Field | Codex |
|---|---|
| instructions, mcp.servers, secrets, `targets.codex` | native |
| permissions | approximated (MCP tool allow rules exact) |
| knowledge | advisory |
| skills | dropped: "Codex has no per-launch skill root" |
| hooks | dropped: "untrusted hooks do not run, and donn never bypasses Codex's hook trust" |

**Detect:** `codex --version` (exit 127: not installed).

## 2. The CLI

**`donn codex [persona] [--dry-run] [--json] [--no-overlay] [-- <codex args>]`** selects the
persona as `donn claude` does, resolves secrets into the launch environment, writes the build,
and launches `codex` with the passthrough arguments last. `codex` missing: `codex-not-installed`.

**`launch.ts`:** the steps both launch commands share (prepare the build, the `DONN_*`
variables, secrets, write the build, run the plan) move out of `claude.ts`; `claude` keeps its
session folder, mode facts and managed-settings hint on top. No behaviour change, covered by the
existing `claude` tests.

**`compile --harness codex`** dry-runs the build. **`doctor`** gains a `codex` check: `ok` with
version and path; `warn` older than 0.163.0; `ok` "not installed (optional)" when absent.

No live switching or mod for Codex (it has no mod system).

## 3. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `adapter` | `@getdonn/adapter-codex`, TOML encoding, golden builds, conformance |
| 2 `launch` | `launch.ts` from `claude.ts`, no behaviour change |
| 3 `cli` | `donn codex`, `compile --harness codex`, doctor's `codex` check |
| 4 `e2e-docs` | opt-in e2e with real Codex; README, changeset, CLAUDE.md, the spec 05 note |

- **Adapter:** golden launch arguments per corpus entry; TOML escaping (quotes, backslashes,
  newlines, Unicode); MCP allow rules → per-tool approval; the shared-variable conflict; the
  `targets.codex` overrides and the looser-than-default note; the conformance kit.
- **CLI:** `--dry-run`/`--json` plans; secrets in the launch environment (recorded `runPlan`);
  passthrough last; `codex-not-installed`; doctor's three states.
- **Opt-in e2e (`DONN_E2E=1`, skipped without Codex):** `donn codex -- exec
  --skip-git-repo-check "<prompt>"` in a scratch repo; one call checks the instruction codeword,
  the probe MCP tool's answer, and that the secret reached the server (value never printed).

## Non-goals

Live switching or a mod for Codex; skills and hooks; `--harness all`; Windows.

## Open questions

1. Whether Codex's `env` table expands `${VAR}` from the launch environment (would lift the
   shared-variable limit).
2. A trust flow for persona hooks.
3. Persona skills through a Codex plugin (writes `~/.codex`).

## Amendments from implementation (2026-10-21)

Made while building this spec (`docs/plans/2026-10-21-codex.md`). Each overrides the section it
names.

- **§1 report:** an unknown `targets.codex` key is reported `dropped`; a sandbox or approval value
  outside the listed ones fails the compile (`AdapterInputError`).
- **§1 MCP servers:** a stdio server with a secret in `args`, or a URL server with a secret header,
  is dropped (a secret is only forwarded by name through `env_vars`); plain URL headers are dropped
  one by one until Codex's header support is spiked.
- **§2 `launch.ts`:** the hooks are `beforeRun(build, ctx, selection)` (returns a cleanup) and
  `afterRun(code, elapsedMs)`, which carries `claude`'s managed-settings hint.
- Verified (e2e, Codex 0.163.0): the instruction, the probe MCP tool's answer and the secret
  (by name) all reached Codex. `codex exec` runs with approval `never` whatever `-a` says (it is
  non-interactive); the sandbox still applies.
- **§1 MCP servers (final review):** Codex splits `-c` keys on every dot, quoted or not, so only
  bare keys go into `-c` paths: a tool allow rule whose tool name is not bare stays guidance
  (`approximated`), and `mcp__<server>__*` becomes `default_tools_approval_mode="approve"`. A URL
  server whose URL is a secret is dropped. Secrets reach Codex's own environment under their
  names, so a server whose secret variable is one Codex or zzpersona reads (`PATH`, `HOME`,
  proxies, `CODEX_*`, `OPENAI_*`, `ZZPERSONA_*`, …) is dropped.
- **§2 passthrough:** Codex refuses `-s`, `-a` or `-m` twice, so they are set through
  `targets.codex`, not after `--`.

Open question 4 (from the final review): those secret variables also reach the shell commands
Codex runs, unless its `shell_environment_policy` filters them; check before relying on it.
