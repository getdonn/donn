# zzpersona (name TBD)

A persona compiler and control plane for AI coding harnesses. A **persona** is a declarative,
composable bundle (instructions, skills, MCP servers, permissions, hooks, knowledge pointers,
secret refs) that inherits through org → area → team → project → user layers and compiles to each
harness's native config. Claude Code is the first harness.

Personal project; planning lives in `docs/planning/` (start with `00-handoff.md`). Nothing is
published to npm yet, so you run it from a checkout.

## Install from a checkout

Requires pnpm (it downloads the Node version the repo develops on) and, for the Claude Code
pieces, Claude Code itself.

```sh
pnpm install
pnpm build

# Put `zzpersona` on PATH. pnpm 12 keeps global binaries in ~/Library/pnpm/bin (macOS);
# `pnpm setup` adds that to your shell config. If it reports an existing pnpm section from an
# older pnpm, run `pnpm setup --force`. Then open a new shell.
pnpm setup
pnpm add --global "link:$PWD/src/apps/cli"   # a link: later builds take effect without reinstalling

zzpersona doctor                              # checks the setup, says what to fix
```

`zzpersona` must be a real executable on `PATH`, not a shell alias: the Claude Code mod and
`zzpersona claude` start programs without a shell.

## Examples

`examples/` has a demo project with org, team and project personas to try everything on; see
[`examples/README.md`](examples/README.md).

## First use

```sh
zzpersona init --personas ~/personas          # a personas folder with a starter org/base
cd <a repo> && zzpersona init --extends org/base   # give the repo a project persona
zzpersona claude                              # launch Claude Code with the persona

zzpersona mod install                         # the Claude Code mod: band, nudge, /persona
```

Inside a `zzpersona claude` session: `/persona`, `/persona list`, `/persona use <persona>` (this
session only) and `/persona switch <persona>` (remembered for the folder, and applied now).

Every command takes `--json`. `zzpersona --help` lists them.

## Shared `AGENTS.md`

Tools that read a repo's `AGENTS.md` (Codex, Copilot CLI, and Claude Code when there is no
`CLAUDE.md`) can get the project persona too, through a generated block you commit:

```sh
zzpersona write              # render project/persona into a marked block of <repo>/AGENTS.md
zzpersona write --check      # in CI: exit 1 when the block is out of date
zzpersona write --remove     # take the block out again
```

Everything outside the block is left as you wrote it. The block carries instructions, knowledge
pointers and tool rules as guidance; the report lists what an `AGENTS.md` cannot carry (skills, MCP
servers, hooks, enforced permissions).

## Codex

`zzpersona codex` launches Codex CLI with a persona, the way `zzpersona claude` launches Claude
Code. Nothing is written to `~/.codex`: everything goes on the command line as `-c` overrides.

```sh
zzpersona codex                     # the project persona (or your switch or default)
zzpersona codex team/payments -- exec "fix the failing test"   # arguments after -- go to codex
zzpersona compile --harness codex   # see the build and the report without launching
```

Carried over: instructions (as developer instructions, on top of Codex's own), knowledge pointers,
MCP servers, with secrets resolved into the launch environment and forwarded by name, and
MCP tool allow rules (`mcp__<server>__<tool>` runs without asking; `mcp__<server>__*` approves the whole server). Codex runs with
`-s workspace-write -a on-request` unless the persona sets `targets.codex.sandbox`, `.approval`
or `.model` (set them there: Codex refuses `-s`, `-a` or `-m` a second time after `--`).
Other permission rules are guidance in the instructions, not enforced. Skills and
hooks do not carry over: Codex has no per-launch skill folder, and it does not run hooks it has
not been told to trust. The report lists each one. (`codex exec` is non-interactive, so Codex
runs it with approval `never`; the sandbox still applies.)

## Keeping sessions current

```sh
zzpersona daemon start    # a background process, per ZZPERSONA_HOME
zzpersona status          # the sessions it knows of, and whether each is current
zzpersona daemon stop
```

With the daemon running, edit a persona and your running Claude Code sessions pick it up on their
next turn. MCP servers, permissions and settings still need a relaunch. Codex sessions cannot be
updated in place: they show as stale.

With the daemon running, `/persona` in the Claude Code mod goes through it too: faster, and it works
where policy stops the mod from running programs. Without the daemon the mod runs `zzpersona` as
before.

## What each harness can carry

`zzpersona capabilities` shows, per harness, which persona fields are carried natively,
approximated, advisory or not at all, and why. The same matrix is published in
[`docs/capabilities.md`](docs/capabilities.md).

## Two Claude Code installs?

`zzpersona claude` runs the `claude` that `PATH` finds, which may not be the one your shell's
`claude` alias runs. `zzpersona doctor` names the binary it checked.

## Developing

```sh
pnpm turbo run build check-types lint test
pnpm format:check
ZZP_E2E=1 pnpm --filter @zzpersona/cli exec vitest run src/e2e.test.ts   # real claude, opt-in
```

Conventions (gitflow, stacked PRs, changesets) are in `CLAUDE.md`.
