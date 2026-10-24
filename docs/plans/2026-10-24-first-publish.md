# First npm publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 13 runtime packages are publishable (metadata, license, READMEs), a private
`@getdonn/release` workspace packs, checks, smoke-tests, publishes and claims them, CI and
`release.yml` run it, and the repo is audited for going public; the outward steps (flip, npm
setup, 0.14.0) follow as a runbook the controller runs with the user.

**Architecture:** A `gh stack` on `feature/spec-27-first-publish` (layer 0: spec and this plan).
Layers via `gh stack add feature/publish-<n>-<name>`: 1 `packages` (Task 1), 2 `tooling`
(Tasks 2–6), 3 `ci` (Task 7), 4 `audit` (Task 8). External commands in the tooling go through one
injectable `Runner`, so tests never call real `npm`, `pnpm` or a registry, except the opt-in
integration test in Task 4.

**Tech Stack:** TypeScript, Node 26, pnpm 12, turbo, vitest, changesets, GitHub Actions,
Verdaccio 6.10.7 (Docker), npm CLI ≥ 11.5.1 (Node 26.12.0 bundles 11.20.0). No new runtime
dependencies; tarballs are read with the system `tar`.

**Spec:** `docs/planning/27-first-publish.md`

## Global Constraints

- Public (drop `"private": true`): `@getdonn/spec`, `resolver`, `adapter-sdk`,
  `adapter-claude-code`, `adapter-codex`, `adapter-agents-md`, `store-local`, `store-remote`,
  `secrets`, `executor`, `registry-api`, `mod-claude-code`, `cli`. Private: `eslint-config`,
  `typescript-config`, `release`, the root.
- `repository.url` is exactly `git+https://github.com/getdonn/donn.git`, with `directory` set to
  the package's folder relative to the repo root (e.g. `src/packages/adapters/codex`).
- `homepage: "https://getdonn.dev"`, `bugs: "https://github.com/getdonn/donn/issues"`,
  `publishConfig: { "access": "public" }`, `engines: { "node": ">=24" }`.
- Copyright line, verbatim: `Copyright 2026 The donn Authors`. `NOTICE` is exactly
  `donn\nCopyright 2026 The donn Authors\n`.
- Placeholder README copy, verbatim: `Reserved. Releases come from https://github.com/getdonn/donn.`;
  deprecation message, verbatim: `placeholder; use the latest version`.
- The trusted publisher for every package: repository `getdonn/donn`, workflow `release.yml`,
  environment `npm`.
- Actions are pinned to commit SHAs with the tag in a comment: `actions/checkout`
  `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1), `pnpm/action-setup`
  `ea17c68df8912ef543352723c149a84f56e3d413` (v6.1.0), `actions/setup-node`
  `949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0). `setup-node` gets `node-version: 26.12.0`
  and **never** `registry-url` (it writes an `.npmrc` that references `NODE_AUTH_TOKEN`).
- Every layer passes `pnpm turbo run build check-types lint test` and `pnpm format:check`. Commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing in Tasks 1–8 pushes a
  tag, publishes to npm, or changes GitHub or npm settings; that is the runbook, run by the
  controller on the user's go-ahead.

## Review Focus

1. A `LICENSE`/`NOTICE` copy left in a package folder after a crash or Ctrl-C → the next run is not
   refused as a dirty tree, and the copy is removed → `.gitignore` entries (Task 1) and Task 3 test
   "copies are removed even when pack fails".
2. A real `pnpm pack` that leaves `workspace:*` in `peerDependencies` or `optionalDependencies`
   (not just `dependencies`) → `--check` reports it → Task 3 test "workspace: in any dependency
   field is reported".
3. A re-run after npm published a version but the job died before the summary (the registry answers
   `npm view` for it) → it is skipped, the rest go out → Task 5 test "a re-run skips what the
   registry already has".
4. `npm view` failing for a reason other than "not found" (network, 5xx, auth) → treated as an
   error that stops the run, never as "not published, go ahead" → Task 5 test "a view error that
   is not E404 stops the run".
5. `NODE_AUTH_TOKEN` set to an empty string in CI (the OIDC-blocking case) → refused just like a set
   token → Task 5 test "an empty NODE_AUTH_TOKEN is refused".

---

### Task 1: Package readiness (`feature/publish-1-packages`)

**Files:** Modify the 13 public `package.json` files; `.changeset/config.json` (`"access":
"public"`); `.gitignore` (add `dist-release/`, `src/**/LICENSE`, `src/**/NOTICE`). Create
`LICENSE` (the full Apache-2.0 text from https://www.apache.org/licenses/LICENSE-2.0.txt, with the
appendix's copyright line filled in as the Global Constraints line), `NOTICE`, `AUTHORS`
(`Jacob Johnson`), `CONTRIBUTING.md`, `SECURITY.md`, a `README.md` in each of the 13 packages, and
`.changeset/first-npm-release.md`.

- [ ] **Step 1:** Edit the 13 `package.json` files per Global Constraints (field order: after
  `license`, add `repository`, `homepage`, `bugs`, `keywords`; `engines` and `publishConfig` at the
  end). `keywords` always include `donn`, `persona`, `ai-coding`, plus 1–3 specific ones (e.g.
  `claude-code`, `codex`, `agents-md`, `mcp`).
- [ ] **Step 2:** Package READMEs: a title (`# @getdonn/<name>`), the package's `description`
  expanded to 1–3 sentences, "Who uses it directly" (end users: only `cli`; adapter authors:
  `adapter-sdk`, `spec`; the control plane: `registry-api`, `resolver`, `store-*`; otherwise
  "internal to the donn CLI; no stable API"), and a link to the repo README. The CLI's README is the
  install page: `npm i -g @getdonn/cli`, Node ≥ 24, `donn init`, `donn claude`, `donn mod install`,
  links to the docs.
- [ ] **Step 3:** `CONTRIBUTING.md`: DCO (`git commit -s`, the DCO 1.1 text linked from
  https://developercertificate.org), the gitflow and merge rules from `CLAUDE.md` → Conventions,
  `pnpm format` before committing, and the release checklist from spec §5 verbatim in order.
  `SECURITY.md`: report through GitHub private vulnerability reporting
  (`https://github.com/getdonn/donn/security/advisories/new`); supported versions: the latest
  release.
- [ ] **Step 4:** `.changeset/first-npm-release.md`: `patch` for each of the 13, body `First npm
  release.`
- [ ] **Step 5: Verify**: `pnpm -r exec node -e 'const p=require("./package.json");
  console.log(p.name, p.private===true, p.repository?.directory, p.publishConfig?.access)'` shows
  exactly the 13 public packages with their folder and `public`, the others `true`; then the
  pipeline and `pnpm format:check` pass.
- [ ] **Step 6: Commit** `chore: make the runtime packages publishable`.

### Task 2: `@getdonn/release`: workspace, runner, package list (`feature/publish-2-tooling`)

**Files:** Create `src/packages/release/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}`
(copy `src/packages/secrets`'s, `"private": true`, `"bin": { "donn-release": "dist/bin.js" }`, no
`exports`), `src/packages/release/src/{run.ts,packages.ts,errors.ts,bin.ts}`,
`src/packages/release/src/packages.test.ts`, `src/packages/release/src/testing/fake-runner.ts`.
Root `package.json` scripts: `"pack:check": "turbo run build && node src/packages/release/dist/bin.js pack --check"`,
`"release:smoke": "turbo run build && node src/packages/release/dist/bin.js smoke"`.

**Interfaces (produces):**
- `run.ts`: `type RunResult = { code: number; stdout: string; stderr: string }`;
  `type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit" }) => Promise<RunResult>`; `realRunner: Runner` (`spawn`, never a
  shell).
- `errors.ts`: `class ReleaseError extends Error { constructor(code: string, message: string) }`.
- `packages.ts`: `interface Workspace { name: string; version: string; dir: string; private:
  boolean; manifest: Record<string, unknown> }`; `listWorkspaces(root: string, run: Runner):
  Promise<Workspace[]>` (from `pnpm ls -r --json --depth -1`, then each `package.json`);
  `interface PublicPackage extends Workspace { deps: string[] }` (`@getdonn/*` names in
  `dependencies`, `peerDependencies`, `optionalDependencies`); `publicPackages(all: Workspace[]):
  PublicPackage[]`, dependency order, ties broken by name.
- `testing/fake-runner.ts`: `fakeRunner(handlers: Array<[match: (cmd: string, args: string[]) =>
  boolean, reply: RunResult | ((cmd, args, opts) => RunResult)]>): Runner & { calls: Array<{ cmd;
  args; opts }> }`; an unmatched call throws.
- `bin.ts`: subcommands `pack [--check]`, `smoke [--registry <url>]`, `publish [--registry <url>]
  [--dry-run] [--json]`, `claim [--deprecate]`, wired in Tasks 3–6; exit 1 with the
  `ReleaseError` message on failure, exit 2 on usage errors. Uses `node:util` `parseArgs`.

- [ ] **Step 1: Failing tests** in `packages.test.ts`: "orders by @getdonn dependencies"
  (fixtures `spec`; `resolver`→`spec`; `cli`→`resolver`,`spec` → `["spec","resolver","cli"]`);
  "private workspaces are left out"; "a cycle is an error" (`ReleaseError` code `cycle`, message
  names both packages); "peer and optional dependencies count".
- [ ] **Step 2: Run** `pnpm --filter @getdonn/release exec vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement** `run.ts`, `errors.ts`, `packages.ts`, the `bin.ts` skeleton.
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(release): workspace, runner and package order`.

### Task 3: `pack` and `--check`

**Files:** Create `src/packages/release/src/{pack.ts,check.ts,tarball.ts}`, tests
`pack.test.ts`, `check.test.ts`; wire `pack` in `bin.ts`.

**Interfaces:**
- Consumes: `Runner`, `PublicPackage`, `Workspace`, `ReleaseError`.
- Produces: `interface Packed { pkg: PublicPackage; tarball: string }`; `packAll(root: string,
  pkgs: PublicPackage[], run: Runner, outDir = join(root, "dist-release/npm")):
  Promise<Packed[]>`; `readTarball(tarball: string, run: Runner): Promise<{ dir: string; files:
  string[] }>` (extracts with `tar -xzf` into a temp dir; `files` relative to `package/`);
  `checkTarball(contents, pkg: PublicPackage, all: Workspace[]): string[]` (problem strings, empty
  when fine).

- [ ] **Step 1: Failing tests.** `pack.test.ts` (fake runner, temp repo): "copies LICENSE and NOTICE
  in for the pack"; "copies are removed even when pack fails"; "returns the tarball path pnpm
  printed" (`pnpm pack --pack-destination <outDir>`, cwd the package dir). `check.test.ts` (real
  `tar` on tarballs the test builds under `package/`), one test per spec §2 failure:
  "workspace: in any dependency field is reported" (also `link:` and `file:`), "a missing LICENSE,
  NOTICE, README.md or package.json is reported", "an exports/bin/main target missing from the
  tarball is reported" (nested `exports` conditions), "files outside dist and the allowed list are
  reported" (`src/x.ts`, `dist/x.js.map`; `openapi.json` allowed for a package whose `files` lists
  it), "a wrong repository.url is reported", "a dependency on a private @getdonn package is
  reported", "a good tarball has no problems".
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `pack --check` packs all, checks each, prints `ok <name>@<version>` or
  every problem, exits 1 if any.
- [ ] **Step 4: Run** the tests — PASS — then `pnpm pack:check` on the repo — Expected: 13 `ok`
  lines; `git status --porcelain` empty afterwards.
- [ ] **Step 5: Commit** `feat(release): pack and check tarballs`.

### Task 4: `smoke`

**Files:** Create `src/packages/release/src/smoke.ts`, `smoke.test.ts`,
`smoke.integration.test.ts` (runs only with `DONN_RELEASE_SMOKE=1`); wire `smoke` in `bin.ts`.

**Interfaces:** `smoke(opts: { root: string; source: { tarballs: Packed[] } | { registry: string
}; run: Runner }): Promise<void>`; throws `ReleaseError("smoke", "<step>: <detail>")`.

The steps, in order, with `HOME`, `DONN_HOME` and the `--prefix` under one `mkdtemp`, and `PATH` =
`<tmp>/stub-bin:<p>/node_modules/.bin:<original PATH>`:
1. Install into an empty `<p>` with a minimal `package.json`: `npm install --prefix <p> <all 13
   tarballs>` (not `-g`: a global install isolates each package's dependencies, so the CLI would
   look for `@getdonn/*` on npm, where they are not yet), or `npm install --prefix <p> @getdonn/cli
   --registry <url>`. Third-party dependencies come from npmjs (tarballs) or through the registry's
   proxy (Verdaccio).
2. `donn --version` equals the CLI tarball's or registry's `@getdonn/cli` version.
3. `donn capabilities --json` parses as JSON.
4. `donn init --personas <tmp>/personas --json`; `donn resolve org/base --json`;
   `donn compile org/base --json` (each parses; exit 0).
5. `donn doctor --json` parses as JSON (its exit code is ignored).
6. Write `<tmp>/stub-bin/claude` (`#!/bin/sh` appending `"$@"` to `<tmp>/claude.log`, `exit 0`,
   mode 755); `donn mod install --json` exits 0 and `$DONN_HOME/mod/plugin/.claude-plugin/plugin.json`
   exists.

- [ ] **Step 1: Failing tests** (fake runner): "runs the steps in order with the throwaway home"
  (asserts every call's `env.HOME`/`DONN_HOME` are under the temp dir, never `os.homedir()`); "a
  version mismatch fails with the step name"; "registry mode installs @getdonn/cli from the
  registry"; "a missing plugin.json fails".
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** the tests — PASS — then `DONN_RELEASE_SMOKE=1 pnpm --filter @getdonn/release
  exec vitest run smoke.integration` and `pnpm release:smoke` on the repo — Expected: exit 0.
- [ ] **Step 5: Commit** `feat(release): clean-install smoke test`.

### Task 5: `publish`

**Files:** Create `src/packages/release/src/publish.ts`, `publish.test.ts`; wire in `bin.ts`.

**Interfaces:** `interface PublishSummary { registry: string; dryRun: boolean; published: string[];
skipped: string[]; failed?: { name: string; error: string } }` (entries `name@version`);
`publish(opts: { root: string; registry: string; dryRun: boolean; env: NodeJS.ProcessEnv; run:
Runner }): Promise<PublishSummary>`. `--json` prints the summary; otherwise one line per package
(`published`, `skipped (already on <registry>)`, `failed: …`). Exit 1 when `failed` is set.

Order: guards, then for each package in `publicPackages` order: `npm view <name>@<version> version
--registry <r>` — exit 0 with output → skip; exit non-zero with `E404` in stderr → pack (Task 3's
`packAll` for that one package) and `npm publish <tarball> --access public --registry <r>`
(`--dry-run` appended when set); anything else → failed, stop.

Guards (each a `ReleaseError`): `git status --porcelain` non-empty → `dirty`; when `env.CI` is set:
`npm --version` < 11.5.1 → `npm-too-old`, and for `https://registry.npmjs.org` a
`NODE_AUTH_TOKEN` key present in `env` (any value, empty included) → `token-set`.

- [ ] **Step 1: Failing tests:** "publishes in dependency order"; "a re-run skips what the registry
  already has"; "stops at the first failure and reports it"; "a view error that is not E404 stops
  the run"; "--dry-run passes through to npm publish"; "a dirty tree is refused"; "npm 11.5.0 is
  refused under CI, 11.5.1 is accepted"; "an empty NODE_AUTH_TOKEN is refused"; "a token is allowed
  for a non-npmjs registry".
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(release): publish what the registry does not have`.

### Task 6: `claim`

**Files:** Create `src/packages/release/src/claim.ts`, `claim.test.ts`; wire in `bin.ts`.

**Interfaces:** `claim(opts: { root: string; deprecate: boolean; run: Runner }): Promise<{ claimed:
string[]; existing: string[]; deprecated: string[] }>`. Claim: for each public package whose
`npm view <name> name` is E404, write a temp folder with `package.json` (`name`, `version:
"0.0.0"`, `license`, `repository`, `description` from the real manifest) and the placeholder README,
then `npm publish <folder> --access public` with `stdio: "inherit"` (npm prompts for the 2FA code).
`--deprecate`: `npm deprecate <name>@0.0.0 "placeholder; use the latest version"` for every public
package that has a `0.0.0`.

- [ ] **Step 1: Failing tests:** "only names missing from npm are claimed"; "the placeholder carries
  the exact README and version 0.0.0"; "publish inherits stdio for the 2FA prompt"; "--deprecate
  deprecates only 0.0.0 with the exact message".
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS, then the pipeline.
- [ ] **Step 5: Commit** `feat(release): claim placeholder names`.

### Task 7: CI and the release workflow (`feature/publish-3-ci`)

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
`src/packages/release/verdaccio/config.yaml`.

- **`ci.yml`:** `on: pull_request` (branches `develop`, `main`) and `push` (same);
  `permissions: { contents: read }`; matrix `os: [ubuntu-latest, macos-latest]`; steps: checkout,
  `pnpm/action-setup`, `setup-node` (Global Constraints), `pnpm install --frozen-lockfile`,
  `pnpm turbo run build check-types lint test`, `pnpm format:check`, `pnpm pack:check`,
  `pnpm release:smoke`.
- **`release.yml`:** `on: push: tags: ["v*"]` and `workflow_dispatch` with input `target`
  (`type: choice`, options `[verdaccio]`); `concurrency: { group: release, cancel-in-progress:
  false }`; top-level `permissions: { contents: read }`.
  - Job `verify` (`if: github.event_name == 'push'`): checkout with `fetch-depth: 0`; `git fetch
    origin main` and `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` (fail with "the tag is
    not on main"); then the same install, pipeline, `pack:check` and `release:smoke` as CI
    (ubuntu only).
  - Job `publish` (`needs: verify`, `environment: npm`, `permissions: { id-token: write, contents:
    write }`): checkout, setup, install, build; `node src/packages/release/dist/bin.js publish
    --registry https://registry.npmjs.org --json > summary.json`; then `gh release create
    "$GITHUB_REF_NAME" --verify-tag --title "$GITHUB_REF_NAME" --notes-file <generated>` (notes: one
    line per published package linking `https://github.com/getdonn/donn/blob/<tag>/<dir>/CHANGELOG.md`),
    `GH_TOKEN: ${{ github.token }}`. No `NODE_AUTH_TOKEN`, no `registry-url`.
  - Job `rehearse` (`if: github.event_name == 'workflow_dispatch'`, ubuntu): checkout, setup,
    install, build; `docker run -d --name verdaccio -p 4873:4873 -v
    "$PWD/src/packages/release/verdaccio/config.yaml:/verdaccio/conf/config.yaml"
    verdaccio/verdaccio:6.10.7` and wait for `curl -sf http://localhost:4873/-/ping`; create a user
    with `curl -X PUT http://localhost:4873/-/user/org.couchdb.user:ci` (JSON name/password) and
    write the returned token to a temp `NPM_CONFIG_USERCONFIG` as `//localhost:4873/:_authToken=…`;
    run `publish --registry http://localhost:4873 --json` and assert 13 published; `smoke --registry
    http://localhost:4873`; `publish` again and assert `published` is empty and 13 skipped (`jq`).
- **`verdaccio/config.yaml`:** `storage: /verdaccio/storage`, `auth: htpasswd` (file under storage,
  `max_users: 10`), `uplinks: { npmjs: { url: https://registry.npmjs.org/ } }`,
  `packages: "@getdonn/*": { access: $all, publish: $authenticated }` (**no `proxy`**, so
  `@getdonn/*` never resolves to npmjs) and `"**": { access: $all, proxy: npmjs }` (third-party
  dependencies such as `zod` must install).
  Two deviations from spec §3, recorded in Task 8's amendment: Verdaccio runs as a `docker run` step
  (a service container starts before checkout and cannot mount the config), and it has an npmjs
  uplink for everything except `@getdonn/*` (with none, the CLI's third-party dependencies cannot
  install).

- [ ] **Step 1:** Write the three files.
- [ ] **Step 2: Lint:** `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12` —
  Expected: no output, exit 0.
- [ ] **Step 3: Run the rehearsal's local half:** start the same Verdaccio container locally, run the
  `rehearse` job's commands by hand against it, then `docker rm -f verdaccio` — Expected: 13
  published, smoke passes, 13 skipped.
- [ ] **Step 4: Commit** `ci: CI and the release workflow`. The first real CI run and the first
  `workflow_dispatch` rehearsal happen when the controller pushes the stack and opens the PRs
  (with the user's go-ahead).

### Task 8: Audit and docs (`feature/publish-4-audit`)

**Files:** Modify `README.md`; any file the audit finds; `docs/planning/27-first-publish.md` (an
"Amendments from planning (2026-10-24)" section: Verdaccio as a `docker run` step with an npmjs
uplink for everything but `@getdonn/*`; the smoke test installs into a local prefix, not `-g`;
`@getdonn/release` is private; anything else the build changed).

- [ ] **Step 1: Secrets scan:** `docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1
  git /repo --redact --report-path /repo/dist-release/gitleaks.json` — Expected: no leaks. Any
  finding goes to the controller (rotation is the user's call); do not rewrite history.
- [ ] **Step 2: Read-through** of `docs/`, `spikes/`, `examples/`, `CLAUDE.md`, `AGENTS.md` and
  every README for personal or employer details and for private control-plane detail beyond "a
  private repo exists and depends on the published packages". Make a list (file, line, why) for the
  controller; edit only what the user approves, with dated notes in planning docs.
- [ ] **Step 3: Root README:** install with `npm i -g @getdonn/cli` (Node ≥ 24); the current
  checkout instructions move under "Contributing" (linking `CONTRIBUTING.md`); a "License" section
  (Apache-2.0, `LICENSE`, `NOTICE`).
- [ ] **Step 4: Run** `pnpm format:check` and the pipeline — PASS.
- [ ] **Step 5: Commit** `docs: going public`.

## Runbook (controller, with the user)

Spec §4 steps 1–8, in order. Each ⚑ step is asked for at that step. In short: open the stack's PRs
and, when CI is green, run the rehearsal by `workflow_dispatch` on layer 3; merge bottom-up
(squash); ⚑ flip the repo public, private vulnerability reporting, environment `npm`; ⚑ npm org 2FA,
trusted publishers (or `donn-release claim` then `claim --deprecate`); `release/0.14.0` with
`changeset version` and a green rehearsal; ⚑ PR to `main`, sync, tag `v0.14.0`, approve `npm`;
verify (`npm view`, `npm audit signatures`, a clean `npm i -g`); ⚑ "Require two-factor
authentication and disallow tokens" per package; dated notes in `00-handoff.md`, `04-roadmap.md`,
`CLAUDE.md`, and memory.
