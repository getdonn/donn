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
