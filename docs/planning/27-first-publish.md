# 27 — First npm publish

> Status: design, 2026-10-24. The rename is done (spec 22, release 0.13.0; repos in the `getdonn`
> org; control plane 0.5.0) and nothing is on npm yet. This spec makes the 13 runtime packages
> public on npm under Apache-2.0, published from GitHub Actions with trusted publishing and
> provenance, makes `getdonn/donn` public at the same time, and ships the result as release
> **0.14.0**. It unblocks the agents and GUI track (specs 23–26).

## Intent

After this spec, `npm i -g @getdonn/cli` is the install path, every `@getdonn/*` runtime package is
on npm with a provenance attestation linking it to the public `getdonn/donn` source, and the open
core boundary (`01`, `03` → "Enterprise") is real: the private control plane can depend on
published packages instead of a submodule. Every release from 0.14.0 on goes out the same way: a
tag on `main`, an approval, a CI publish that has been rehearsed against a local registry first.

## Facts this design rests on

From the npm docs (`trusted-publishers`, `generating-provenance-statements`; read 2026-10-24):

- Trusted publishing (OIDC, no token) needs npm CLI 11.5.1+ and Node 22.14.0+, a cloud-hosted
  runner (GitHub Actions or GitLab; not self-hosted), `permissions: id-token: write`, and a workflow
  file in `.github/workflows/` whose name, with `.yml`, is part of the trusted-publisher config
  (with an optional environment name). `repository.url` in `package.json` must match the repository
  exactly.
- Provenance is generated automatically under trusted publishing, but only for a **public package
  published from a public repository**: "Provenance generation is not supported for private
  repositories."
- A trusted publisher is configured per package from its settings page (or the CLI). The docs do
  not say whether a package must exist first; most third-party reports (2026) say it must, so the
  first version is published by hand. A new trusted-publisher configuration expires unless it is
  used within 2 days.
- An empty `NODE_AUTH_TOKEN` blocks OIDC: npm uses the empty value instead of falling back.
- After trusted publishing works, npm recommends setting each package's publishing access to
  "Require two-factor authentication and disallow tokens"; trusted publishers keep working.
- npm only puts a `LICENSE` into a tarball from the package's own folder, not the repo root.

From this repo (2026-10-24):

- 15 workspaces, all `"private": true`; 13 ship runtime code, `eslint-config` and
  `typescript-config` do not. `@getdonn/cli` depends on the other 12. Builds are `tsc` (the mod:
  esbuild); the CLI is not bundled.
- Every package says `"license": "Apache-2.0"`; there is no `LICENSE` file, no `repository`, no
  `publishConfig`, and no package README except `eslint-config`'s.
- `.changeset/config.json` has `"access": "restricted"`, which needs a paid npm org.
- There is no CI (`.github/workflows/` does not exist).
- The CLI finds the mod with `createRequire(import.meta.url).resolve(...)`, which works the same in
  an installed `node_modules` tree; `workspace:*` specifiers must be rewritten at pack time
  (`pnpm pack` does this).
- Whether pnpm 12's `publish` does OIDC itself is unconfirmed; `npm publish <tarball>` does.

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| The 13 runtime packages go public; `eslint-config`, `typescript-config` and the root stay private | All 15; a bundled CLI plus only the libraries others build on | The CLI installs as ordinary dependencies; the control plane and third-party adapters (`08`) need the libraries; config packages are tooling, not product |
| `getdonn/donn` goes public with the first publish, after an audit | Stay private (no provenance); private now, public later | Provenance needs a public repo; one transition instead of two; an "open source" package with private source is hollow; public repos get free rulesets |
| Every real version is published from CI with trusted publishing and provenance | First release by hand, trusted publishing from the next one | The versions people install first are the ones that most need provenance |
| First try configuring trusted publishers before the packages exist; if npm refuses, publish a `0.0.0` placeholder of each name by hand, configure, deprecate the placeholder | First release by hand; placeholders without trying | Placeholders are permanent registry noise; try the clean path first, at the cost of one experiment |
| A tag `vX.Y.Z` on `main` triggers `release.yml`; an approval-gated environment `npm`; our own publish script (pack with pnpm, publish with npm) | `changesets/action` (version PR, publish on merge); `changeset publish` in the tag workflow | Fits the existing gitflow release (`release/*` → `main`, hand-made tag); sidesteps pnpm's unconfirmed OIDC; skips what is already published, so a re-run resumes; the same script drives the rehearsal |
| A Verdaccio rehearsal of the whole release workflow, required on the `release/*` branch before every tag | Pack-and-install checks only; also installing from Verdaccio on the developer's Mac | Exercises the publish path and the re-run end to end without touching npm; the Mac move is a separate optional step |
| Apache-2.0, "Copyright 2026 The donn Authors", `NOTICE`, `AUTHORS`; contributions under the DCO | Copyright held by a person or a company; a CLA | Not tied to any employer or company; the enterprise code lives in a separate repo, so there is nothing a CLA would need to relicense |
| A bad publish is deprecated and fixed by a patch release, never unpublished | Unpublishing within npm's window | Unpublish breaks anyone who installed it and blocks the version number forever |

## 1. Package readiness

- The 13 runtime packages drop `"private": true`: `spec`, `resolver`, `adapter-sdk`,
  `adapter-claude-code`, `adapter-codex`, `adapter-agents-md`, `store-local`, `store-remote`,
  `secrets`, `executor`, `registry-api`, `mod-claude-code`, `cli`. `eslint-config`,
  `typescript-config` and the root `package.json` keep it.
- Each public package gets:
  - `"repository": { "type": "git", "url": "git+https://github.com/getdonn/donn.git",
    "directory": "<its folder>" }`
  - `"homepage": "https://getdonn.dev"`, `"bugs": "https://github.com/getdonn/donn/issues"`,
    `keywords`
  - `"publishConfig": { "access": "public" }`
  - `"engines": { "node": ">=24" }` (the CLI has it; the libraries get it too)
  - a short `README.md`: what the package is, who uses it directly, a link to the repo docs. The
    CLI's README is the user-facing install page.
- `.changeset/config.json`: `"access": "public"`.
- Root files: `LICENSE` (full Apache-2.0 text, "Copyright 2026 The donn Authors"), `NOTICE`
  ("donn / Copyright 2026 The donn Authors"), `AUTHORS` (Jacob Johnson), `CONTRIBUTING.md` (DCO
  `Signed-off-by`, the gitflow rules from `CLAUDE.md`, the release checklist from §5),
  `SECURITY.md` (report through GitHub private vulnerability reporting).
- `LICENSE` and `NOTICE` are copied into each tarball by the pack step (§2), not committed per
  package.
- The root README: install with `npm i -g @getdonn/cli`; running from a checkout moves to a
  "Contributing" section; a License section.
- One changeset: a patch for each public package, "First npm release." Released as 0.14.0. Versions
  stay independent per package; no code or command changes.

## 2. Release tooling: `src/packages/release`

A private workspace, `@getdonn/release`, so turbo lints, type-checks and tests it like any other
package. Node scripts with small testable modules; external commands run through one injectable
runner so tests use a fake `npm`/`pnpm`.

- **Package list.** Every workspace without `"private": true`, sorted by its `@getdonn/*`
  dependencies (`spec` first, `cli` last). A cycle is an error.
- **`pack`** (`pnpm pack:check` at the root runs it with `--check`). For each public package:
  `pnpm pack` into `dist-release/npm/` (gitignored) with `LICENSE` and `NOTICE` copied in for the
  pack and removed after. `--check` then reads each tarball and fails on:
  - a `workspace:`, `link:` or `file:` specifier left in `package.json`;
  - a missing `LICENSE`, `NOTICE`, `README.md` or `package.json`;
  - an `exports`, `bin` or `main` target that is not in the tarball;
  - anything outside `dist/` and the files above (except a package's declared extra `files`, such
    as `registry-api`'s `openapi.json`), source maps included;
  - `repository.url` not equal to `git+https://github.com/getdonn/donn.git`;
  - a dependency on a `@getdonn/*` package that is private.
- **`smoke`** (`pnpm release:smoke`). Installs `@getdonn/cli` into an empty `--prefix` with a
  throwaway `HOME` and `DONN_HOME`, either from the packed tarballs (default) or from a registry
  (`--registry <url>`), then runs: `donn --version` (equals the CLI's package version),
  `donn --json capabilities`, a flags-only `donn init`, `donn resolve` and `donn compile` on the
  result, `donn doctor --json` (it must answer valid JSON; findings about missing harnesses are
  expected), and `donn mod install --json` with a stub `claude` first on `PATH` that records its
  arguments and exits 0, asserting the mod's `plugin.json` landed under `$DONN_HOME/mod/plugin/`
  (this proves the CLI resolves `@getdonn/mod-claude-code` from an installed tree). It never
  touches the real home, a real harness or a service manager.
- **`publish`** (`--registry <url>`, `--dry-run`, `--json`). For each public package in order: if
  `npm view <name>@<version> version --registry <url>` answers, skip and say so; otherwise pack and
  `npm publish <tarball> --access public --registry <url>` (`--dry-run` passed through). It stops
  at the first failure; a re-run resumes because finished packages are skipped. Prints a summary:
  published, skipped, failed. It refuses to start with a dirty working tree, and when `CI` is set
  it refuses unless `npm --version` is at least 11.5.1 and `NODE_AUTH_TOKEN` is unset (not merely
  empty) for the npmjs registry.
- **`claim`** (local only, used only if §4 step 3 needs it). For each public package name not on
  npm: publish a `0.0.0` tarball with a `package.json` (name, version, license, repository) and a
  README ("Reserved. Releases come from https://github.com/getdonn/donn."), prompting for the npm
  2FA code. A second command, `claim --deprecate`, deprecates every `0.0.0` with "placeholder; use
  the latest version".

## 3. CI and the release workflow

- **`.github/workflows/ci.yml`**: on pull requests to `develop` and `main`, and pushes to both.
  GitHub-hosted `ubuntu-latest` and `macos-latest`; pnpm via `pnpm/action-setup`, Node from
  `devEngines`. Steps: `pnpm install --frozen-lockfile`, `build`, `test`, `lint`, `check-types`,
  `format:check`, `pack:check`, `release:smoke`. The opt-in `DONN_E2E` tests stay off (they need
  real `claude` and `codex`).
- **`.github/workflows/release.yml`**, two triggers:
  - **Tag `v*`.** Job `verify`: the tagged commit must be reachable from `origin/main`; then build,
    test, `pack:check`, `release:smoke`. Job `publish` (needs `verify`): `environment: npm`
    (required reviewer: the maintainer), `permissions: { id-token: write, contents: write }`, no
    `NODE_AUTH_TOKEN` anywhere, npm upgraded to a pinned version at least 11.5.1 when the bundled
    one is older; runs `publish --registry https://registry.npmjs.org --json`; then creates the
    GitHub Release for the tag with links to the changelogs.
  - **`workflow_dispatch` with input `target: verdaccio`.** The rehearsal, on any branch, no
    environment. Starts Verdaccio (pinned image) as a service container with no uplinks, so
    `@getdonn/*` never resolves to npmjs; writes a throwaway token for `localhost:4873`; runs
    `publish --registry http://localhost:4873`; runs `release:smoke --registry
    http://localhost:4873`; runs `publish` again and asserts every package was skipped.
- Each package's trusted publisher on npm: repository `getdonn/donn`, workflow `release.yml`,
  environment `npm`.

## 4. Going public: the audit and the runbook

**Audit** (on a feature branch, before the flip):

- `gitleaks` over the full history. A finding is rotated; rewriting history is a last resort (it
  breaks the control plane's submodule pins and every tag).
- Read `docs/`, `spikes/`, `examples/`, `CLAUDE.md`, `AGENTS.md` and the READMEs for personal or
  employer details, and for private control-plane details beyond "a private repo exists and
  depends on the published packages". Edit in place with dated notes where a planning doc changes.
- Accepted, not rewritten: commit author emails and the `Claude-Session:` trailers in history
  become public.

**Runbook.** Outward-facing steps (marked ⚑) run only on the maintainer's go-ahead at that step.

1. Merge §1–§3 and the audit fixes into `develop`. CI is green on both runners.
2. ⚑ Make `getdonn/donn` public. Turn on private vulnerability reporting. Create environment `npm`
   with the maintainer as required reviewer. `delete_branch_on_merge` stays off.
   *(amended 2026-10-24)* Restrict environment `npm` deployments to tags matching `v*`; add a tag
   ruleset on `v*` limiting create, update and delete to the maintainer; disallow admin bypass of
   the environment.
3. ⚑ npm: require 2FA for the `getdonn` org. For each of the 13 names, try adding the trusted
   publisher (`getdonn/donn`, `release.yml`, `npm`) before the package exists. If npm refuses, run
   `claim` locally, configure each trusted publisher, run `claim --deprecate`. Steps 3 to 5 finish
   within 2 days, or the trusted-publisher configurations expire and are recreated.
4. On `release/0.14.0`: `changeset version`; run the Verdaccio rehearsal; it must be green.
5. ⚑ PR `release/0.14.0` → `main` (merge commit), sync `main` → `develop` (merge commit; check
   `main` still exists), tag `v0.14.0` on `origin/main` and push it. Approve the `npm` environment
   when `verify` is green.
6. Verify: `npm view @getdonn/cli` shows 0.14.0's CLI version; in a clean folder,
   `npm i @getdonn/cli && npm audit signatures` reports verified attestations for all 13;
   `npm i -g @getdonn/cli && donn --version` works on a clean machine (CI or a temp prefix).
7. ⚑ Set each package's publishing access to "Require two-factor authentication and disallow
   tokens".
8. Amend `00-handoff.md` (Naming: published), `04-roadmap.md` (Phase 0's publish item; the agents
   and GUI track is unblocked) and the `CLAUDE.md` status in place with dated notes.

If a publish fails midway: fix forward and re-run the `publish` job (published packages are
skipped). If a published version is broken: `npm deprecate` it and release a patch.

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `packages` | §1: flags, metadata, READMEs, `LICENSE`/`NOTICE`/`AUTHORS`/`CONTRIBUTING.md`/`SECURITY.md`, changesets config, the changeset |
| 2 `tooling` | §2: `src/packages/release` with `pack`, `smoke`, `publish`, `claim` and their tests |
| 3 `ci` | §3: `ci.yml`, `release.yml` |
| 4 `audit` | §4's audit edits; root README |

- Unit tests (`src/packages/release`, fake runner): dependency order and cycle detection; every
  `--check` failure above, from fixture tarballs; `publish` skips what exists, stops at the first
  failure, resumes, and refuses on a dirty tree, old npm or a set `NODE_AUTH_TOKEN`; `claim` only
  claims missing names.
- In CI: `pack:check` and `release:smoke` on every PR; the Verdaccio rehearsal by hand on layer 3
  once CI exists, then on every `release/*` branch.
- The release checklist in `CONTRIBUTING.md`: `changeset version` on `release/x.y.z`, rehearsal
  green, PR to `main`, sync, tag, approve, verify.

## Non-goals

Moving the control plane from `vendor/donn` to npm dependencies (a private spec); rulesets for
`develop` and `main` (free once the repo is public; a follow-up); usedonn.com and the USPTO check; a
Homebrew formula or an unscoped `donn` alias; moving the developer's Mac from the pnpm link to the
npm package (optional, afterwards); publishing `eslint-config` or `typescript-config`.

## Open questions

None.

## Amendments from planning (2026-10-24)

- Verdaccio runs as a `docker run` step (a service container starts before checkout and cannot
  mount the config), with an npmjs uplink for everything except `@getdonn/*` (with none,
  third-party dependencies cannot install).
- The smoke test installs into a local `--prefix` with `npm install`, not `npm i -g` (a global
  install resolves each package's `@getdonn/*` dependencies from npm, where they are not yet).
- `@getdonn/release` is a private workspace.
- Each public package's `files` adds `NOTICE` (npm auto-includes only LICENSE) and
  `!dist/**/*.map` (declaration maps stay for in-repo use).
- `publish` requires `--registry`, refuses npmjs outside CI unless `--dry-run`, matches npmjs by
  URL hostname, and re-checks each tarball before publishing; `claim` lists without `--yes`,
  refuses under CI, and refuses unless npm's configured registry is npmjs.
- The smoke test compares `donn --version` to the workspace's `@getdonn/cli` version, installs
  exactly that version in registry mode, and scrubs inherited `DONN_*`, `XDG_*` and
  `CLAUDE_CONFIG_DIR`.
- No npm upgrade step in `release.yml`: Node 26.12.0 bundles npm 11.20.0; `publish` enforces
  ≥ 11.5.1.
- Runbook step 2 also: restrict environment `npm` deployments to tags matching `v*`; add a tag
  ruleset on `v*` limiting create, update and delete to the maintainer; disallow admin bypass of
  the environment. Reason: a `workflow_dispatch` on any branch, or a tag on a non-main commit, runs
  that ref's `release.yml`, and npm's trusted publisher matches the repo, workflow file and
  environment regardless of ref, so the environment's settings are the real gate.
