# Vendoring a Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `donn agent vendor <source>` copies an eve template from a folder or a git URL into
`.donn/templates/<name>` with a recorded source, and `donn agent create --template <source>`
vendors on the way.

**Architecture:** A new `agent/vendor.ts` parses a source, stages a filtered copy in a temporary
folder (a folder copy, or a shallow `git fetch` into a temporary repository), checks it is an eve
template and digests it (`stageVendor`); `commitVendor` moves a staged copy into
`.donn/templates/<name>` and updates `.donn/templates/sources.json`. The `vendor` command calls
both; `create` stages first, compiles from the staged copy, and commits it with the persona edit.
`agent templates` reads `sources.json`.

**Tech Stack:** TypeScript, Node 26 (`node:fs/promises`), the user's `git` via `io.probe.run`,
commander, zod 4, vitest.

**Spec:** `docs/planning/25-agent-runner.md`, section "Amendment: vendoring a template
(2026-10-28)" (and §2, which it amends).

## Global Constraints

- The persona schema (`AgentTemplate`) is unchanged: a declared template is `eve:<slug>` or a
  relative path inside the persona folder.
- Vendored templates live in `<project>/.donn/templates/<name>/`; the record is
  `<project>/.donn/templates/sources.json`.
- A template name is an agent-name slug (`Id` from `@getdonn/spec`), else `invalid-template-name`.
- Copied files: those `notTemplate` (in `agent/files.ts`) keeps; links stay links; a folder that is
  a git checkout also drops what `git ls-files -co --exclude-standard` leaves out.
- An eve template: a `package.json` listing `eve` in `dependencies` or `devDependencies`, and an
  `agent/` folder.
- Git runs as `git -C <dir> …` through `io.probe.run`; donn never handles a token and never prints a
  URL's credentials (strip `user:pass@` from any URL it prints).
- Error codes, verbatim: `vendor-source-not-found`, `vendor-not-eve-template`,
  `vendor-source-inside`, `vendor-name-taken`, `vendor-local-edits` (fix `--force`),
  `vendor-fetch-failed`, `git-not-installed`, `invalid-template-name`.
- Nothing is written under `.donn/templates/` until a staged copy is complete (stage, then move).
- Tests never touch the real home, keychain, network or a real eve; git sources in tests are local
  bare repositories over `file://`.
- Prettier width 80 (`pnpm format`); every command keeps `--json`; commits signed off (`-s`) with
  the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GmLJYkbT5dYe37adTR8fab`.

## Review Focus

1. A template folder with an `.env` holding real values and a `node_modules`: neither lands in the
   repo (Task 1 test "leaves out .env and node_modules").
2. A git URL with credentials (`https://user:token@host/repo.git`) that fails: the error and the
   record never show the token (Task 1 test "never prints a URL's credentials").
3. Refreshing a vendored copy someone edited: refused without `--force`, the edit kept (Task 2
   test "refuses to refresh an edited copy").
4. `create --template <outside folder>` stopped by a blocking portability entry: nothing written
   under `.donn/templates/` and the persona untouched (Task 3 test "a stopped create vendors
   nothing").
5. `--template ~/x` where `~` is the user's home from `io.env.HOME`, not the literal folder `~`
   (Task 1 test "expands ~/").

---

### Task 1: Parse, stage and check a template source

**Files:**
- Create: `src/apps/cli/src/agent/vendor.ts`
- Test: `src/apps/cli/src/agent/vendor.test.ts`

**Interfaces:**
- Produces:
  - `type VendorSource = { kind: "dir"; dir: string; given: string } | { kind: "git"; url: string; ref?: string; given: string }`
  - `parseVendorSource(given: string, cwd: string, home: string): VendorSource` — git when it
    starts with `https://`, `http://`, `ssh://`, `file://` or matches `^[^/@\s]+@[^:\s]+:`; a
    `#<ref>` suffix splits off the ref; else a folder (`~/` expanded with `home`, relative resolved
    against `cwd`).
  - `defaultTemplateName(source: VendorSource): string` — last path segment, `.git` removed.
  - `redactUrl(url: string): string` — removes `user[:pass]@` from a URL.
  - `interface StagedVendor { name: string; dir: string; source: string; ref?: string; commit?: string; dirty?: boolean; digest: string; files: string[] }`
  - `stageVendor(io: CliIo, source: VendorSource, options: { name?: string; stagingBase?: string }): Promise<StagedVendor>`
    — the caller removes `dir`. Validates the name (`invalid-template-name`), copies (folder: via
    `git -C <dir> ls-files -co --exclude-standard -z` when `git -C <dir> rev-parse
    --show-toplevel` succeeds, else a walk; both filtered by `notTemplate`; git: `git init` a temp
    folder, `git -C <tmp> fetch --depth 1 <url> <ref?>`, `git -C <tmp> checkout FETCH_HEAD`, then
    the folder rules on the checkout), records `commit` (`git rev-parse HEAD`) and, for a folder
    checkout, `dirty` (non-empty `git status --porcelain`), checks it is an eve template, and
    computes `digest` with `templateDigest` over the staged files (mode 755 when executable).
  - `vendorDigest(dir: string): Promise<string>` — the same digest over a folder already in place
    (Task 2 compares it with the record).

- [ ] **Step 1: Write the failing tests** (fixtures built in a temp folder; a bare repo made with
  `git init --bare` and pushed to from a work tree)

```ts
it("parses folders and git URLs", () => {
  expect(parseVendorSource("~/x", "/cwd", "/home/u")).toEqual({ kind: "dir", dir: "/home/u/x", given: "~/x" });
  expect(parseVendorSource("../x", "/a/b", "/h")).toMatchObject({ kind: "dir", dir: "/a/x" });
  expect(parseVendorSource("https://h/o/r.git#v1", "/c", "/h")).toEqual({ kind: "git", url: "https://h/o/r.git", ref: "v1", given: "https://h/o/r.git#v1" });
  expect(parseVendorSource("git@github.com:o/r.git", "/c", "/h")).toMatchObject({ kind: "git" });
});
it("expands ~/", () => { /* stageVendor of "~/tpl" with io.env.HOME = <tmp home> finds <tmp home>/tpl */ });
it("names a template after its source", () => {
  // "/x/kody-eve-template" → "kody-eve-template"; "https://h/o/kody.git#main" → "kody"
});
it("stages a folder template and digests it", async () => { /* files listed, digest "sha256-…" */ });
it("leaves out .env and node_modules", async () => {
  // source has .env, .env.local, .env.example, node_modules/x, .output/y, agent/a.ts:
  // staged files are .env.example, agent/a.ts, package.json
});
it("drops what a checkout's .gitignore ignores and notes uncommitted changes", async () => {
  // source is a git work tree with .gitignore "dist/" and an uncommitted edit: dist/ missing,
  // commit set, dirty true
});
it.each(["main", "v1", "<commit sha>"])("stages a git source at %s", async (ref) => { /* commit equals that ref's sha */ });
it("refuses a folder that is not an eve template", async () => { /* code vendor-not-eve-template, nothing staged left */ });
it("refuses a missing folder", async () => { /* vendor-source-not-found */ });
it("refuses a bad name", async () => { /* --name "Kody!" → invalid-template-name */ });
it("reports a failed fetch", async () => { /* file:///nope → vendor-fetch-failed with git's exit code */ });
it("never prints a URL's credentials", async () => {
  // https://user:secret@127.0.0.1:1/r.git → vendor-fetch-failed; JSON.stringify(error) has no "secret"
});
it("says when git is missing", async () => { /* io.probe.run returns exitCode 127 for git → git-not-installed */ });
```

- [ ] **Step 2: Run them and see them fail.** Run:
  `pnpm --filter @getdonn/cli exec vitest run src/agent/vendor.test.ts`. Expected: FAIL (no module).

- [ ] **Step 3: Implement `agent/vendor.ts`** with the Interfaces above. Reuse `notTemplate`,
  `listFiles` (`agent/files.ts`) and `templateDigest` (`agent/digest.ts`). Copy with
  `fs.cp(..., { verbatimSymlinks: true })` per file, or the existing staging pattern in
  `agent/materialise.ts`.

- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(cli): stage a template from a folder or a git URL`

### Task 2: The record, refresh and `donn agent vendor`

**Files:**
- Modify: `src/apps/cli/src/agent/vendor.ts`, `src/apps/cli/src/cli.ts` (an `agent vendor`
  command beside `agent templates`), `src/apps/cli/src/commands/agent.ts`
  (`agentVendorCommand`), `src/packages/cli-schemas/src/agents.ts` (`AgentVendorOutput`)
- Test: `src/apps/cli/src/agent/vendor.test.ts`, `src/apps/cli/src/json-schemas.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseVendorSource`, `stageVendor`, `vendorDigest`, `StagedVendor`.
- Produces:
  - `const VendorRecord = z.object({ source: z.string(), ref: z.string().optional(), commit: z.string().optional(), dirty: z.boolean().optional(), digest: z.string(), vendoredAt: z.string() })`
  - `readVendored(donnDir: string): Promise<Record<string, VendorRecord>>` (an absent file → `{}`;
    an unreadable one → `invalid-vendor-record` naming the file)
  - `commitVendor(donnDir: string, staged: StagedVendor, options: { force?: boolean; now: () => number }): Promise<{ added: string[]; changed: string[]; removed: string[] }>`
    — refuses `vendor-name-taken` (folder exists, no record), `vendor-local-edits` (record exists,
    `vendorDigest` of the folder ≠ recorded digest, no `force`; fix `--force`); else moves the
    staged copy into place (old folder replaced) and writes `sources.json` (`{ "version": 1,
    "templates": { … } }`, keys sorted, 2-space JSON).
  - `assertNotInside(source: VendorSource, projectRoot: string, agentPaths: string[]): void` —
    `vendor-source-inside` for a folder under `<project>/.donn/templates` or an agent's folder.
  - `agentVendorCommand(io, source, options: { name?: string; force?: boolean; project?: string; json?: boolean })`
  - `AgentVendorOutput = z.strictObject({ template: z.strictObject({ name, path, source, ref?, commit?, digest }), added, changed, removed })`
- Text output: `vendored <name> into .donn/templates/<name> (<n> files)` or, on a refresh,
  `refreshed <name>: <a> added, <c> changed, <r> removed`, then the line `agents created from it
  before keep their files; only agents created from now on get this copy`.

- [ ] **Step 1: Write the failing tests**

```ts
it("vendors and records a template", async () => {
  // donn agent vendor <folder> --json in a temp project: .donn/templates/<name>/package.json exists;
  // sources.json templates[<name>] has source, digest, vendoredAt; output parses with AgentVendorOutput
});
it("refreshes a recorded template and reports the changes", async () => { /* added/changed/removed */ });
it("refuses to refresh an edited copy", async () => {
  // edit .donn/templates/<name>/agent/a.ts; vendor again → vendor-local-edits, fix "--force", edit kept
});
it("refreshes an edited copy with --force", async () => {});
it("never replaces a folder it did not vendor", async () => { /* existing .donn/templates/x, no record → vendor-name-taken */ });
it("refuses a source inside the project's templates", async () => { /* vendor-source-inside */ });
it("leaves .donn/templates as it was when staging fails", async () => {});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** the Interfaces; `agentVendorCommand` resolves the project like other
  agent commands (`projectContext`, `ctx.projectDir` is `.donn/`), stages, commits, removes the
  staging folder in `finally`.
- [ ] **Step 4: Run them and see them pass** (also `json-schemas.test.ts`).
- [ ] **Step 5: Commit** — `feat(cli): donn agent vendor records and refreshes a template`

### Task 3: `create --template <source>`

**Files:**
- Modify: `src/apps/cli/src/agent/create.ts` (`CreateOptions`, `templateSource`, `conflicts`, the
  declare step), `src/apps/cli/src/cli.ts` (`--template-name <name>` on `agent create`)
- Test: `src/apps/cli/src/agent/create.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseVendorSource`, `defaultTemplateName`, `stageVendor`; Task 2's
  `commitVendor`, `assertNotInside`.
- Produces: `CreateOptions.templateName?: string`; `isVendorSource(template: string): boolean` —
  true unless the value is `eve:…` or passes `AgentTemplate` from `@getdonn/spec`.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates an agent from a folder outside the project", async () => {
  // create kody --template <tmp>/kody-tpl --target local (fakes for eve, as the create tests do):
  // persona declares template: ./templates/kody-tpl; .donn/templates/kody-tpl and sources.json
  // exist; agents/kody holds the template's files
});
it("names the vendored template with --template-name", async () => {});
it("a dry run vendors nothing", async () => { /* --dry-run: no .donn/templates, persona unchanged */ });
it("a stopped create vendors nothing", async () => {
  // a blocking portability entry without --accept-portability → portability-blocking;
  // no .donn/templates, persona unchanged
});
it("compares a declared agent's template with the vendored path", async () => {
  // declared template ./templates/kody-tpl; --template <tmp>/kody-tpl → no conflict, nothing vendored;
  // --template <tmp>/other → agent-declared naming --template
});
```

- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** When the agent is not declared and `isVendorSource(options.template)`:
  stage (`stageVendor`, name `options.templateName ?? defaultTemplateName`), use the staged folder
  as the `{ kind: "path" }` template source for staging and the compile, declare
  `template: ./templates/<name>`, and call `commitVendor` in the same place the persona edit is
  written (after the reports; never under `--dry-run`). Remove the staging folder in `finally`. If
  the resolver needs the declared template to exist while checking the edit, commit the vendored
  copy just before the persona write and remove it again if that write fails; report this choice.
  For a declared agent, `conflicts` treats a vendor source as `project/templates/<name>` and
  vendors nothing.

- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** — `feat(cli): create vendors a template from outside the project`

### Task 4: `agent templates`, docs and release

**Files:**
- Modify: `src/apps/cli/src/commands/agent.ts` (`agentTemplatesCommand`), `src/apps/cli/src/cli.ts`
  (`--project <dir>` on `agent templates`), `src/packages/cli-schemas/src/agents.ts`
  (`AgentTemplatesOutput.vendored`), `src/apps/cli/README.md`, `docs/planning/25-agent-runner.md`
- Create: `.changeset/agent-vendor.md`
- Test: `src/apps/cli/src/json-schemas.test.ts` (or the existing templates test)

**Interfaces:**
- Consumes: Task 2's `readVendored`.
- Produces: `AgentTemplatesOutput` gains `vendored: z.array(z.strictObject({ name: z.string(), template: z.string(), source: z.string(), ref: z.string().optional(), commit: z.string().optional() }))`,
  always present (empty outside a project). Text output adds `./templates/<name>  vendored from
  <source>[#ref] (<commit 7>)` lines.

- [ ] **Step 1: Write the failing tests** — `agent templates --json` in a project with one vendored
  template lists it (schema-checked); outside a project `vendored` is `[]`; text output has the
  line.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Then the docs:
  - spec 25 amendment, "**`create`.**" paragraph: replace "An agent the persona already declares
    ignores `--template`, as before." with "For an agent the persona already declares,
    `--template` is compared as before, a vendor source counting as `./templates/<name>`; nothing
    is vendored."; and add `invalid-vendor-record` (an unreadable `sources.json`, naming the
    file) to its error list.
  - `src/apps/cli/README.md`: a `donn agent vendor <folder|git-url>` line next to `agent create`.
  - `.changeset/agent-vendor.md`: `"@getdonn/cli": minor`, `"@getdonn/cli-schemas": minor`, one
    paragraph.
- [ ] **Step 4: Full check.** Run `pnpm turbo run build check-types lint test && pnpm format:check`.
  Expected: all green.
- [ ] **Step 5: Commit** — `feat(cli): vendored templates in agent templates; docs`

### After the tasks

Smoke before the final review: with the branch's CLI and a temp `DONN_HOME`, in a new scratch
project, `donn agent create kody --template ~/Repos/kody-eve-template --target local` (gateway as in
`~/Repos/donn-kody-smoke2/.donn/persona.yaml`); check `.donn/templates/kody-eve-template`,
`sources.json` and the agent's files; then `donn agent vendor ~/Repos/kody-eve-template` refreshes
it with no changes reported, and `donn agent templates` lists it.
