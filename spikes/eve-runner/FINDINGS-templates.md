# eve runner spike, templates half (spec 25, layer 1)

Throwaway spike, run 2026-10-25 against `eve@0.83.2` (tag `eve@0.83.2`, commit
`9f73f9dbe5841253657b9037614cb43887937fe8`), Node 26.12.0, pnpm 12.14.0 (and pnpm 11.25.0 where a
template's `packageManager` selects it), Docker 28.3.3. The runtime half is `FINDINGS-runtime.md`.

Layout: `templates/digest.mjs` (template digest from a directory or straight from the tarball),
`templates/kody-slots.mjs` (compiles donn's slots into a copy of kody with the built adapter),
`templates/fixtures/` (recorded eve output for fake-eve tests), `templates/work/` (gitignored).
`eve init` and install experiments ran in the session scratchpad, outside any workspace (T3).

**Verdict: spec 25 holds in outline; seven details change** (marked CHANGED/NEW). Most
important: `eve init` edits an ancestor workspace (T3); `--ignore-workspace` breaks template
installs (T4).

## T1. Tarball at a tag. CONFIRMED

- `curl -sSL 'https://codeload.github.com/vercel/eve/tar.gz/refs/tags/eve@0.83.2'`: 11,448,051
  bytes, 1.34 s, top dir `eve-eve-0.83.2/`. The API form
  `api.github.com/repos/vercel/eve/tarball/eve@0.83.2` (60/h unauthenticated) 302s to
  `legacy.tar.gz`, top dir `vercel-eve-9f73f9d/`; byte-different, same files, so digest content
  not archives.
- The first entry is a pax global header: `52 comment=9f73f9dbe5841253657b9037614cb43887937fe8`,
  which can be checked against the tag SHA.
- With no dependency: `node:zlib` gunzip takes 51 ms; a ~50-line ustar/pax reader scans the
  archive in 14 ms. The repo has no tar package (`tar` 7.5.22 brings 5 deps; `nanotar` 0.3.0 and
  `modern-tar` 0.8.6 have none). The reader must refuse anything outside
  `<top>/apps/templates/<dir>/`, `..`, absolute paths, and any type but `0` or `5`.
- Tags: 213 `eve@*` tags vs 260 npm versions; all of 0.80.0–0.83.2 are tagged. The untagged ones
  are old (0.2–0.9, 0.51.1, 0.52.x, 0.6.0 betas). Cheapest listing: `git ls-remote --tags
  https://github.com/vercel/eve 'refs/tags/eve@0.83.*'` (0.36 s, no auth). The tags are
  lightweight.
- **Impact:** §2 step 4 as written; the extractor lives in the CLI with no new dependency;
  `template-not-at-version` lists the nearest tags via `git ls-remote`.

## T2. Template digest. NEW

Definition: regular files only, POSIX relative paths, lines
`<path>\0<644|755>\0<sha256 hex>\n` sorted by code unit, digest `sha256-<hex of sha256(lines)>`.
Symlinks, hard links and devices are refused, and nothing is excluded. Tarball (both forms) and
system-`tar` extraction agree:

| repoPath | files | digest |
|---|---|---|
| `eve-chat-template` | 117 | `sha256-f505db3dea24e2d6e5d3e318f6e386dc5981c27f3ecf558452f3f634b4172f1d` |
| `eve-coding-agent-template` | 21 | `sha256-55c8800e30fcd72e0429981b333f1850ac589da87587c3b879d01355a50c4201` |
| `eve-company-brain-template` | 39 | `sha256-3286c1dc6b6830c3a34e6d8440fdacfd5490d818ffc464519462990f3369ba97` |
| `eve-discord-agent-template` | 20 | `sha256-82a7cce4ce80dabb6c14c4996d4f11f9502797c5bcd18eb797c2c970f3dc9e8c` |
| `eve-llm-council-template` | 30 | `sha256-5bbc9205570883efab83b2f88e226dd0d4b107a36e4b1249c494974b1715b49a` |
| `eve-slack-agent-template` | 14 | `sha256-485a00d2717bcdfb804dec8fb2fc6ace74413857ec9ea7876ecb9060f7af0ee8` |
| `eve-voice-template` | 63 | `sha256-70d1e5d0723f84093eb379569abd15cba37e6450520db1f8632cc4b9936da637` |
| `personal-agent-template` | 180 | `sha256-780bf87a0a36f5f39aeb3a07f567b9b1a589d3607733a63d5a4a6d6fa843d4fe` |

- The 660 entries hold 485 files and 175 directories: no symlinks, `.git` or `node_modules`.
- Executable: `eve-chat-template/scripts/setup.sh` and `eve-voice-template/scripts/setup.sh`.
- Lockfiles: `pnpm-lock.yaml` only. Every template has its own `pnpm-workspace.yaml`
  (`allowBuilds`, `minimumReleaseAgeExclude`).
- `packageManager`: `pnpm@11.25.0` in seven, `pnpm@12.7.0` in company-brain (pnpm 12 switches to
  it).
- `.env.example` in chat, coding-agent, company-brain, voice and personal; `.npmrc` in chat and
  voice; `vercel.json` in discord.
- Templates pin eve from `^0.66.3` to `^0.83.0`, so after the re-pin the lockfile is stale and the
  first install must not be frozen.
- **Impact:** the templates table gains a `digest` per row. `create` hashes while extracting,
  before writing, and refuses `template-digest-mismatch`. Path templates have no digest.

## T3. `eve:blank` via `eve init`. CHANGED

- **Existing-package form** (`package.json` only): `eve init . --non-interactive` exits 0 in
  ~2 s. It creates `agent/agent.ts` (`model: "openai/gpt-6-luna-fast"`, `reasoning: "high"`),
  `agent/channels/eve.ts` (`vercelOidc()`, `localDev()`, `placeholderAuth()`) and
  `agent/instructions.md`. It adds `@vercel/connect 2.5.2`, `ai ^7.0.137`, `eve ^0.83.2` and
  `zod 4.5.4`, and writes `pnpm-workspace.yaml` (`minimumReleaseAge: 0`,
  `minimumReleaseAgeStrict: true`, `allowBuilds: {esbuild: true, sharp: false}`). It sets
  `engines.node: "24.x"` and installs. stdout is human text plus a long agent-building brief, not
  NDJSON.
- **Ancestor edits.** It edits the nearest ancestor workspace. In this repo it changed the root
  `package.json` engines to `24.x`, added `spikes/eve-runner/templates/work/*` and `sharp: false`
  to the root `pnpm-workspace.yaml`, and installed into the root lockfile (reverted).
  Reproduced with a fake outer workspace, even with the agent's own `pnpm-workspace.yaml`
  written first. Source: `dist/src/setup/scaffold/workspace-root.js`, where
  `findAncestorPnpmWorkspaceRoot` starts at `dirname(projectRoot)`. There is no flag.
- **Other cases.** `agent/` already present: exit 1, "An eve project already exists". No
  `package.json`: the full scaffold (`.gitignore`, `.vercelignore`, `AGENTS.md`, `CLAUDE.md`,
  `README.md`, `tsconfig.json` with `skipLibCheck: true`, scripts) and a `.git` with "Initial
  commit from eve". A staging dir with no ancestor `package.json` or `pnpm-workspace.yaml`
  touches nothing outside.
- **Impact:** run `eve init` in a fresh temp staging dir (check that no ancestor workspace file
  exists), keep the existing-package form, and move the result into `path`. Never run
  `eve init` or `add` inside the user's repo when an ancestor workspace doesn't already claim
  the agent.

## T4. Install isolation. CHANGED

- Slack template in a fake outer pnpm workspace, eve re-pinned to 0.83.2, plus `ai ^7.0.152` and
  `@ai-sdk/openai-compatible ^3`. Plain `pnpm install` in the agent dir: exit 0 (pnpm v11.25.0
  via `packageManager`), outer untouched; the template's own workspace file is nearest.
- `pnpm install --ignore-workspace` with a lockfile present: exit 1,
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION … eve@0.83.2 was published at 2026-10-24T19:46:20Z,
  within the minimumReleaseAge cutoff`. The template's excludes are ignored, and pnpm 11+
  defaults to one day.
- `pnpm add @workflow/world-postgres@^5`: exit 1,
  `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cbor-extract@2.2.2` (installed anyway), and
  every later `pnpm install` exits 1 (pnpm 11.25 and 12.14). `--config.strict-dep-builds=false`
  gives exit 0 with a warning (both versions, frozen or not); `cbor-extract: false` under
  `allowBuilds` gives exit 0 and also unblocks `eve add` (`failureCode: "pnpm_build_policy"`
  otherwise).
- **Impact:** drop `--ignore-workspace` when the agent has its own `pnpm-workspace.yaml` (write
  `packages: ["."]` if missing). Handle cbor-extract with the flag or an `allowBuilds` entry
  (record it in the manifest as an edit to a template-owned file) rather than mapping the error
  code. The first install is not frozen.

## T5. `eve add` and the question protocol. CHANGED

- **Command.** `eve add [item] [--non-interactive] [--answer key=<JSON>]… [--skip-install]
  [--skip-setup] [-o] [-y]`.
- **Registry.** `eve registry list --json` has 113 items: 27 channels, 51 connections, 11 tools,
  9 instrumentation, 8 extensions, 6 memory. It has **no templates, and no template declares a
  setup step**. READMEs describe `eve add channel/…`, `eve link` and `vercel env pull`, and chat
  and voice ship Vercel-only `scripts/setup.sh` (vercel link, Blob, Neon, OAuth). The
  coding-agent README warns against `eve add channel/github`, which would overwrite its channel.
- **Recorded exchange** (`fixtures/eve-add-github-exit2.{stdout,stderr}`,
  `fixtures/eve-add-github-prerequisite.out`). `eve add channel/github --non-interactive` exits
  2. stdout carries `{"version":1,"type":"progress",…}` plus plain-text lines. stderr carries
  spinner text plus `{"version":1,"type":"blocked","item":"channel/github","installed":true,
  "status":"input_required","question":{"key":"github-events","message":"What should this
  GitHub App respond to?","required":true,"kind":"multi-select","options":[{"id","label",
  "hint"}…],"recommended":["issue_comment","pull_request_review_comment"]},"next":{"command":
  "eve","args":["add","channel/github","--non-interactive","--skip-install","--answer",
  "github-events=<JSON value>"]}}`. Answering it gives exit 2 with
  `"status":"prerequisite_required","prerequisite":{"kind":"command","code":
  "vercel-project-link","message":"GitHub setup requires a linked Vercel project. Run `eve
  link`, then retry.","command":"eve link"}`, even on the portable path.
- **Wire types** (`setup-question-wire.d.ts`, `registry-setup-protocol.d.ts`, protocol v2):
  - Kinds: `confirm`, `text`, `environment` (`variable`, `sensitive: true`), `select`,
    `multi-select` and `editable-select`. Each has `key`, `message` and `required`; options are
    `{id,label,hint?,disabled?,locked?}`, plus `recommended`.
  - Blockers: `input_required` (optional `issue.code: "invalid_answer"`) and
    `prerequisite_required`.
  - Outcomes: `failed` (`failureCode`, `rolledBack`, exit 1) and `completed` (`facts`,
    `deploymentRequired?`).
  - Exit codes: 0, 1, 2.
- **Impact:**
  - Parse JSON lines from both streams and skip non-JSON.
  - Adopt eve's field names; a secret is `kind: "environment"` plus `variable`.
  - Pass eve's `next` through as `continue`.
  - Handle `prerequisite_required`: run `eve link` for `vercel` targets, report it otherwise.
  - Drop §2 step 8, or replace it with an explicit `--add <item>` pass-through.

## T6. kody-eve-template as a path template. CONFIRMED (builds), NEW (portability gap)

- **Source.** The eve docs manifest at the tag (`apps/docs/lib/templates/manifest.ts`, 24 slugs)
  gives every template `github: {owner, repo, ref, pathPrefix?}`. Kody is
  `vercel-labs/kody-eve-template`, ref `main`, MIT (© 2026 Vercel), with no tags. HEAD
  `0c5b823dbd5e162f12d0a160032a0f6ffbb78a88` (2026-10-23). Its title is "GitHub Project
  Maintainer" (weekly digest email, PR summaries, @mentions, Linear), not a dedicated PR
  reviewer.
- **Build.** Copied with `git archive` (no `.git`); `kody-slots.mjs` compiled the slots.
  `patchAgentTs` ok; it wrote `lib/donn/config.ts`, `lib/donn/env.ts` and
  `instructions/donn.md`, and no `sandbox.ts` (kody has one). `pnpm add eve@0.83.2
  @ai-sdk/openai-compatible@^3 --config.strict-dep-builds=false` exits 0. With the
  `.env.example` placeholders, `eve info` reports `ready`: instructions `instructions.ts
  (system), instructions/donn.md (system)`, model `donn-gateway/stub-model`, 4 skills, subagent
  `researcher`, schedule `weekly-digest`. `eve build --skip-sandbox-prewarm` exits 0 (5.4 s,
  17.2 MB); `tsc` exits 0.
- **Failures.** Without env, evaluation fails (`LINEAR_CONNECTOR environment variable is not
  set`); `RESEND_FROM_ADDRESS` is read at build. With prewarm, the build fails: `failed to
  initialize sandbox template "root" on provider "vercel" … link your Vercel project`.
- **What kody uses:**
  - `@vercel/connect` (GitHub credentials, and the GitHub Tools extension through a connector)
  - a pinned `VercelSandbox`
  - the GitHub checkout
  - `vercelOidc()`
  - Linear through Connect
  - Resend, Redis and Vercel Blob
  - a subagent model `openai/gpt-5.6-terra`
- **Gap.** The adapter's portability report for this path template has only the generic
  route-auth blocking entry.
- **Impact:** the smoke works as a path template. For self-host the user replaces `sandbox.ts`,
  the GitHub credentials (App id, key, secret) and the Linear/Resend connections, or targets
  Vercel. Settle the deferred minor: a path template gets `portability-unknown`, or `create`
  runs a cheap scan (`eve/sandbox/vercel`, `@vercel/connect`, `vercelOidc`, `githubChannel`,
  subagent `model:`). `create` and `doctor` pass the agent's env to `eve build` and `info`.

## T7. GitHub Actions one-shot. YES WITH GLUE

- **Proof.** Copy of `spikes/eve-slots/proj`, Docker sandbox, stub gateway. `eve dev --no-ui
  --port 4811` (`NODE_ENV=development`) plus `eve remote invoke --url http://127.0.0.1:4811 "Say
  hi"` exits 0 in 0.83 s with `{"status":"ready","outcome":{"status":"completed",
  "message":"done"},"resume":{…}}` (`fixtures/eve-remote-invoke.json`). The stub saw a tool
  round trip. Per `docs/reference/cli.md`, invoke emits JSON after completion or a blocking
  input or authorization event; paused exits 3, failure exits 1.
- **Credentials.** `credentials.installationToken` (string or lazy, skips the App JWT) plus a
  custom `webhookVerifier` (`public/channels/github/auth.d.ts`), so `GITHUB_TOKEN` fits.
- **Checkout.** It needs a firewall-capable backend (`checkout.d.ts`), so it won't run on runner
  Docker. A just-bash sandbox can mount the runner's checkout read-only
  (`docs/sandbox/just-bash.mdx`: `MountableFs` + `OverlayFs({readOnly: true, root})`).
- **Glue:** `eve build --skip-sandbox-prewarm` and `eve start` (or `eve dev --no-ui`) in the
  background with a just-bash `sandbox.ts` mounting `$GITHUB_WORKSPACE`, then `eve remote invoke
  --url http://127.0.0.1:<port> "<task>"` (route auth via `-H`), then `gh pr comment`.
  Alternative: POST `$GITHUB_EVENT_PATH` to `/eve/v1/github` with token credentials and a
  loopback verifier. That keeps the reply logic, but there is no wait for channel sessions.
- **Not proved:** an actual Actions run; route auth under `eve start`; just-bash with an absolute
  host path.
- **Impact:** a later spec adds the target as a generated workflow plus a just-bash sandbox
  file; layers 2–4 don't depend on it.

## T8. Other notes on spec 25

- **Gallery.** 24 slugs in the docs manifest (spec 24 counted 20), 8 in the repo. The manifest's
  `github` field is the machine-readable source for out-of-repo templates, but its ref is `main`,
  so digests would need a chosen commit.
- **`packageManager`.** "The package manager the lockfile names" is in practice
  `packageManager`, which pnpm honours.
- **Node engines.** `eve init` forces `engines.node: "24.x"`; Node 26 gets a warning, not a
  failure.
- **`.gitignore`.** Templates' files already list most of §2 step 7's entries; append only the
  missing ones.
- **`--yes`.** Confirmed: it accepts eve's `recommended`.
- **Exit codes.** `eve add` uses 0/1/2; `remote invoke` adds 3 (paused).
- **Port overlap.** For about 10 s this spike's stub on `127.0.0.1:4010` overlapped the runtime
  fork's stub on `*:4010`.
