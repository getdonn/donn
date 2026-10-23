# 21 — Managed settings

> Status: design, 2026-10-23. Phase 3, the open-source half of sub-project E (Claude Code
> enforcement; see `18-registry-contract.md` → "Phase 3 decomposition"). The server half, which
> serves bundles and builds MDM packages, is the private repo's spec 04. Builds on `02` (locks),
> `03` Appendix A ("Enterprise enforcement maps onto managed settings"), `05` (adapter SDK) and
> `18`–`20` (registry). Built as a `gh stack`: layer 0 is this spec and its plan.

## Intent

Locks are enforced today when a layer is published and when a persona resolves; on the developer's
machine they are advice. Claude Code's managed settings can enforce most of them for real. This spec
compiles the locks of the org layer (optionally down to a business area or team) into a **managed
policy bundle**, installs it on one machine with an explicit `sudo`, and checks that what is
installed is what was compiled and is current. An organisation without MDM or a gateway gets real
enforcement from the open-source CLI alone; an organisation with MDM gets the same bundle packaged
for its MDM by the control plane (private spec 04).

## Facts this design rests on

From the Claude Code docs (`managed-settings`, `server-managed-settings`, `settings`,
`managed-mcp`, `memory`, `plugins/org`; read 2026-10-23):

- Managed policy files live in a system folder: macOS `/Library/Application Support/ClaudeCode/`,
  Linux and WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`. `managed-settings.json`
  is read first, then every `*.json` in `managed-settings.d/` in alphabetical order: a later single
  value replaces an earlier one, lists are combined without duplicates, nested blocks merge per key.
  Files are watched; most edits apply without a restart.
- Managed sources rank: remote (the claude.ai console) > MDM (macOS `com.anthropic.claudecode`
  profile, Windows `HKLM\SOFTWARE\Policies\ClaudeCode` `Settings`) > the policy files > HKCU. By
  default only the highest source that delivers a policy applies (`managedSourcesBehavior:
  "first-wins"`); `"merge"`, set in the highest source, applies all of them.
- `managed-mcp.json` (same folder) takes exclusive control of MCP: only its servers and
  `managedMcpServers` load; plugin servers are blocked and `--mcp-config` exits at startup.
  `managedMcpServers` (managed settings, Claude Code 2.1.259+) adds `http`/`sse` servers on
  `https://` URLs without exclusive control, with no `env`, headers helper or `${VAR}`.
- Managed lists (`permissions.allow|deny|ask`) merge with lower scopes: lower scopes can add rules,
  never remove managed ones. Managed-only switches: `allowManagedPermissionRulesOnly`,
  `allowManagedHooksOnly`, `allowManagedMcpServersOnly`, `disableSideloadFlags`,
  `strictKnownMarketplaces`, `deniedModels` and others. `claudeMd` (managed only) carries
  organisation instructions users cannot exclude; Claude Code delivers them as a message after the
  system prompt.
- Managed files are readable by every user. Hooks delivered from the console need each developer's
  approval. There is no API for console-managed settings and no machine-readable view of the
  effective managed settings (`/status` and `claude doctor` are for people).

## Decisions (and the alternatives rejected)

| Decision | Rejected | Why |
|---|---|---|
| The open-source CLI compiles, installs on one machine and checks; the private control plane serves bundles and builds MDM packages | Everything open source; compile only, the rest private | Matches spec 18's split ("OSS compile, private packaging"); a free user without MDM still gets real enforcement |
| A bundle carries the locks of the org layer, or of the chain from the org down to a business area or team (`--layer`) | Org only; any layer including projects | MDM tools target groups of machines; project layers belong to a repo, not a machine |
| Strict switches: a small harness-neutral `policy` block plus a raw `targets.claude-code.managed` passthrough | Only one of the two | The core stays harness-neutral (Codex has a managed requirements file too); Claude-only keys appear often and stay out of the schema |
| A bundle is a folder with a manifest; `check` compares the machine against it | One JSON document; a privileged background helper | Only a folder carries hook scripts and local MCP servers; the manifest gives `check` and later drift (D) something to compare; a root service is a new security surface |
| Only locked values enter the bundle | The whole resolved chain | A managed list cannot be shortened below it, so anything in the bundle is locked in effect; unlocked values stay persona defaults |

## 1. The `policy` block and the passthrough

New in `@zzpersona/spec`, persona files only (not the user overlay):

```yaml
policy:
  permissions: exclusive        # only the policy's permission rules count
  hooks: exclusive              # only the policy's hooks run
  mcp: exclusive                # only the policy's MCP servers load
  bypassPermissions: disabled   # the bypass mode cannot be entered

targets:
  claude-code:
    managed:                    # raw Claude Code managed keys, applied last
      strictKnownMarketplaces: []
      deniedModels: ["claude-haiku-*"]
```

- `policy` keys are optional; each takes exactly the one value shown. Unknown keys are a schema error.
- `policy` and `targets.claude-code.managed` may be set only by `org/`, `area/` and `team/` layers
  (the kind is the ref's prefix). A `project/` layer that sets either fails resolution
  (`policy-in-lower-layer`, naming the layer); the user overlay cannot carry them at all.
- Both merge down the chain, the lower layer winning per key, and both count as locked: a layer
  below the one that set a key cannot change it.
- The IR gains `policy` (an object, default `{}`); `IR_VERSION` does not change (an added optional
  field with a default). `targets.claude-code.managed` stays inside `targets`; the Claude Code
  adapter's persona compile ignores it (it is added to the keys the adapter consumes instead of
  writing to `settings.json`).

## 2. Compiling a bundle

`compileManaged(chain, { os })` in `@zzpersona/adapter-claude-code`, pure: it takes the resolved
chain (the IR of the deepest layer plus the locks each layer declared) and returns
`{ files: Record<string, Uint8Array>, manifest, report }`. Only locks declared in the chain count.

| Locked path | Managed setting | Notes |
|---|---|---|
| `permissions.deny`, `ask`, `allow`, or rules in them | `permissions.deny`, `ask`, `allow` | Lower scopes may add, never remove |
| `hooks.<event>`, `hooks.<event>[id]` | managed `hooks` (`pre-tool-use` → `PreToolUse`, as the adapter maps today) | A `run` that names a file in the personas root is copied to `zzpersona/hooks/<id>` and referenced by its installed absolute path for `os`; a command `run` is used as is |
| `mcp.servers[name]`, `http`/`sse` on `https://`, no `env`/headers | `managedMcpServers` | Non-exclusive |
| `mcp.servers[name]`, stdio, or with `env`/headers | `managed-mcp.json` | Only with `policy.mcp: exclusive`; otherwise **refused** (`managed-mcp-needs-exclusive`) |
| Any value containing `secret://` | — | **Refused** (`managed-secret`): managed files are readable by every user |
| `instructions`, `instructions[id]` | `claudeMd`: the locked fragments' text, in contract order, joined by a blank line | Delivered as guidance, not system prompt (report note) |
| `mcp.gateway`, `skills`, `knowledge`, `secrets.providers` | — | **Advisory**: enforced at publish and resolve, not by Claude Code |
| `policy.permissions: exclusive` | `allowManagedPermissionRulesOnly: true` | |
| `policy.hooks: exclusive` | `allowManagedHooksOnly: true` | |
| `policy.mcp: exclusive` | `allowManagedMcpServersOnly: true` and `managed-mcp.json` (with the locked servers, possibly `{}`) | |
| `policy.bypassPermissions: disabled` | `permissions.disableBypassPermissionsMode: "disable"` | |
| `targets.claude-code.managed.<key>` | `<key>`, applied last | Checked against a known-key list in the adapter; an unknown key is **refused** (`managed-unknown-key`) |

- **Files.** `managed-settings.d/50-zzpersona.json` (always), `managed-mcp.json` (only as above),
  `zzpersona/hooks/<id>` (locked script hooks), `zzpersona/manifest.json`.
- **Deterministic.** Keys sorted, no timestamps: the same inputs give the same bytes and digest.
- **Manifest.** `{ format: 1, zzpersona: <cli version>, os, layers: [{ ref, version?, digest }],
  files: { <path>: <sha256> }, minClaudeCode: <version>, report }`. `minClaudeCode` is the highest
  version any used key needs (a table in the adapter: `managedMcpServers` 2.1.259, `deniedModels`
  2.1.283, …; unknown → no floor).
- **Report.** Every lock gets one entry, `enforced`, `advisory` (with the reason) or `refused`
  (which fails the build). Warnings when the policy weakens zzpersona's own launches:
  `disableSideloadFlags` or a `managed-mcp.json` → relaunch runs in partial mode;
  `allowManagedHooksOnly` → persona plugin hooks are dropped; console delivery of hooks needs each
  developer's approval.
- **Adapter SDK.** An optional `managed?` capability on the adapter contract (`compileManaged`),
  and a `managed enforcement` row in the capability matrix (`zzpersona capabilities`,
  `docs/capabilities.md`): Claude Code yes, others "advisory only".

## 3. CLI

All support `--json`.

| Command | Does |
|---|---|
| `zzpersona managed build [--layer <ref>] [--os macos\|linux\|windows] [--out <dir>] [--from-registry]` | Resolves `--layer` (an `org/`, `area/` or `team/` ref; default: the only `org/` layer in the store, else `--layer` is required) with its ancestors and writes the bundle folder (default `./zzpersona-managed/`). `--os` defaults to the current OS. `--from-registry` downloads the bundle from the registry route (§4) instead of compiling locally. Prints the report; exits non-zero on any refusal |
| `sudo zzpersona managed install <dir> [--yes]` | Verifies the manifest digests and that `os` matches; prints the plan (files written, replaced, removed); asks unless `--yes`; writes each file atomically (temp then rename), owner root (Administrators on Windows), 0644, hooks 0755. Removes files a previous zzpersona install owned that the new bundle lacks (from the installed manifest) |
| `sudo zzpersona managed uninstall [--yes]` | Removes exactly the files the installed manifest lists |
| `zzpersona managed check` | Reports one state (below); exit 0 only for `current`. No privileges needed |

- Without admin rights, `install`/`uninstall` exit with the exact command to re-run.
- `install` never touches `managed-settings.json`, other drop-ins, or a `managed-mcp.json` that
  zzpersona did not install; if one blocks the install it refuses and names the file.
- **`check` states:** `current` (files match the manifest; the manifest matches a fresh compile of
  the latest layers — from the registry when configured, else the local store), `stale` (newer
  layers exist), `edited` (a file's digest differs), `missing` (nothing installed), `ignored` (a
  higher-ranked source exists — the macOS profile in `/Library/Managed Preferences/`, the Windows
  `HKLM` value, or `~/.claude/remote-settings.json` — and `managedSourcesBehavior` there is not
  `"merge"`), `overridden` (a later drop-in replaces one of our single values). Several may apply;
  the most severe is the state, all are listed.
- `doctor` runs `check` (a finding when not `current`); `status` shows one `managed:` line.
- **One injectable root.** The system folder, the macOS managed-preferences folder, the registry
  reader and the home folder come from one place; tests point them at temp folders. No test writes a
  real system folder, needs root, or reads the real profile, registry or `~/.claude`.

## 4. Registry contract

`GET /v1/managed/bundle?layer=<ref>&os=<os>&format=<format>[&include=all|files]` in
`@zzpersona/registry-api`, bearer token, any principal that may view the layer. `include` applies to
the script formats only (`files` leaves out the settings drop-in, for use beside a profile or
registry value).

- `format=bundle` (default): `200 { manifest, files: { <path>: <base64> } }`, the output of
  `compileManaged` on the server's layers. Required of every server; the mock implements it and the
  conformance kit checks it (digest equals a local compile of the same layers).
- Other formats are named in the contract — `console`, `mobileconfig`, `reg`, `script-macos`,
  `script-linux`, `script-windows` — and answered with their media type; a server that does not
  build them answers `501 format-unsupported`. The mock answers 501.
- Problems: `404 not-found` (unknown layer), `422 managed-refused` (`detail` names the path and
  code from the report), `422 managed-needs-files` (`console` asked for a bundle that has files),
  `400 invalid-request` (bad `os`, `format` or `include`, or a format that does not fit `os`).

## 5. Stack and testing

| Layer | Contents |
|---|---|
| 0 `spec` | this spec and its plan |
| 1 `policy` | `policy` and `targets.claude-code.managed` in `@zzpersona/spec`; the resolver's layer-kind rule and lock semantics; fixtures |
| 2 `compile` | `compileManaged`, the known-key and version tables, the report, the manifest; adapter SDK `managed?`; capability matrix row |
| 3 `build` | `zzpersona managed build` (local and `--from-registry` against the mock) |
| 4 `install` | `install`, `uninstall`, `check`; `doctor` and `status` lines |
| 5 `registry` | the route in `@zzpersona/registry-api`, the mock, the conformance kit, OpenAPI; real Claude Code e2e; docs; changesets |

- **Compile:** golden bundles per OS in `test/golden/managed/`, one case per table row; refusals
  (`managed-secret`, `managed-mcp-needs-exclusive`, `managed-unknown-key`,
  `policy-in-lower-layer`); report entries and the partial-mode warnings; building twice gives the
  same digest.
- **Install and check:** against temp roots — replacing an earlier bundle removes only its own
  files; org files are never touched; no admin rights → the exact command; every `check` state from
  planted fixtures.
- **Real Claude Code (`ZZP_E2E_MANAGED=1`):** a Linux container with Claude Code installed; `managed
  install` a bundle; `claude doctor` reports no invalid managed entries and `claude mcp list` shows
  the locked servers (neither needs a login); the container is removed.
- **Smoke before the final review:** on the developer's Mac in a herdr pane, with permission first
  (it needs `sudo` to write `/Library/Application Support/ClaudeCode/`), removed afterwards.

## Non-goals

Pushing to the claude.ai console (no API); signing profiles; a privileged background helper;
enforcement for other harnesses (they report "advisory only"); locking skills through managed
plugins (later, with a published org marketplace); drift reporting to the control plane (D).

## Open questions

None.

## Amendments from implementation (2026-10-23)

Decisions made while building layers 1 to 5; the sections above stand as written except where
these say otherwise.

1. **Hooks.** A hook's `run` is always a script file (the schema has no command form), so the bundle
   always copies it; the "a command `run` is used as is" case of §2 does not exist. POSIX hook
   commands are single-quoted (`'` escaped as `'\''`); on Windows they are double-quoted and a
   basename containing `"`, `$`, a backtick or `%` is refused.
2. **Value paths** in the report and in locks use the resolver's dotted forms: `mcp.servers.<name>`
   and `secrets.providers.<name>` (not `mcp.servers[name]`).
3. **Provenance.** `ManagedInput.provenance` (from `ResolveResult.provenance`) names the layer that
   set a `policy` or `targets.claude-code.managed` key; an equal re-set of a policy key is a no-op,
   so it keeps the first layer.
4. **The passthrough is not "applied last over everything".** A passthrough key (or nested key) that
   would replace a compiled value, or that sits at or below a compiled `managedMcpServers.<name>`
   (including servers compiled into `managed-mcp.json`), is refused with a fifth code,
   `managed-passthrough-conflict`. Lists still combine; non-colliding keys still apply.
5. **Headers.** A server with literal `headers` stays on `managed-mcp.json` (it needs
   `policy.mcp: exclusive`), although Claude Code's docs allow literal headers in
   `managedMcpServers`; this is deliberately conservative.
6. **Secret scan.** It covers every IR value that can hold a reference (MCP server fields and the
   passthrough values). Instruction text, permission rules and hook script bytes are never resolved
   and are not scanned.
7. **`gateway://` servers.** A locked `gateway://` server is advisory; under `policy.mcp: exclusive`
   its reason says sessions will not load it.
8. **`build`.** A local layer with a missing referenced file fails (`managed-layer-files`), as publish
   would. Registry-cached layers are re-hashed, and a mismatch with the index digest fails
   (`managed-cache-mismatch`, suggesting `zzpersona pull`). The empty-chain notice is also `notice`
   in `--json`.
9. **`install`.** It refuses a parent path blocked by a file, a symlinked root or zzpersona folder
   (always) and, when root, a root, folder, manifest or `pending.json` that is not root-owned or is
   group/other-writable, all before any write. `zzpersona/pending.json` (old paths, new paths and
   earlier pending paths) is written before the first write and removed after the manifest; while it
   exists, `install` and `uninstall` treat its paths as owned and `check` reports `edited` ("an
   interrupted install"). A file at a zzpersona path whose bytes equal the bundle's is adopted.
10. **`check`, `status`, `doctor`.** When the manifest's deepest layer is not in the store, freshness
    is skipped with the note `cannot check for newer layers: <ref> is not in the store` (the state is
    unaffected). A present but unreadable MDM profile counts as winning (`ignored`). `status` omits
    the `managed:` line when nothing is installed (its `--json` always has `managed`); `doctor`
    skips the check when nothing is installed.
11. **Capability matrix.** The `policy` row: native for Claude Code through the managed bundle,
    advisory for the other built-in adapters. `FIXED_CAPABILITY_FIELDS` gained `policy`, so a
    third-party adapter must declare that row.
12. **Registry route (§4), as built.** (`invalid` means a 422 bad bundle; `invalid-request` a 400 bad
    query.) The client schemas are tolerant and the conformance kit holds
    servers to strict copies. New problem codes: `invalid-request` (400), `managed-refused` (422;
    one problem per refused entry, `path` and `ref` set, message `<path>: <code>: <reason>`),
    `managed-needs-files` and `format-unsupported` (501). Checks run in this order: token (401),
    parameters (400), unknown layer (404), format (501), compile (422). The mock and the kit take
    `managed?: ManagedCompiler` because `@zzpersona/registry-api` depends on no adapter; the kit
    skips its bundle case without one and compares `manifest.files` and the file bytes with a
    local compile of the same published layers. Layers are read through virtual folders
    `.registry/<ref>/@`, as the CLI's cache mount does, so two layers may each bundle a same-named
    file. `--from-registry` rejects any file key that is absolute, has `..`, a backslash or a drive
    letter, any file whose sha256 differs from the manifest, any file the manifest does not list,
    and a missing `zzpersona/manifest.json`, before writing anything; a registry that answers
    `format-unsupported` gives `not supported by this registry: --from-registry`.
13. **Real Claude Code (§5), as run.** `ZZP_E2E_MANAGED=1` builds a Linux bundle on the host, runs
    a `node:26-slim` container with the repo mounted read-only and Claude Code 2.1.309 installed
    inside, runs `managed install --yes` as root, and checks `managed check`, `claude mcp list`
    (shows the locked server) and `claude doctor` (no installation issues; it needs neither a TTY
    nor a login). `claude doctor` does not itself list managed settings, so the files, `check` and
    `mcp list` carry the assertion.
14. **Older registries and manifest bytes (fix round 1).** A bare 404 (no `ref` on the problem) from
    `--from-registry` is read as a registry without the route and reports `not supported by this
    registry`; a 404 that names a `ref` is a missing layer. The bytes sent for
    `zzpersona/manifest.json` must parse to exactly the manifest object the digests were checked
    against, and file keys that differ only in case are refused (also by `writeBundle` and
    `readBundle`).

## Amendments from the final review (2026-10-23)

15. **A lower layer's passthrough never widens a higher layer's lock.** A
    `targets.claude-code.managed` key set by a layer below a declared lock (or a `policy` key) that
    covers the matching section is refused with `managed-passthrough-conflict`, the reason naming
    the lock (or `policy.<key>: <value>`) and its layer. "Below" is the key's provenance layer
    coming after the lock's in `ir.layers`; the same layer or one above may set it. The mapping:
    `permissions.allow` → a lock on `permissions.allow` or `permissions`, or `policy.permissions`
    (`deny` and `ask` may always grow: they only tighten); `managedMcpServers`, `allowedMcpServers`,
    `deniedMcpServers`, `allowManagedMcpServersOnly` → a lock on `mcp.servers` or `mcp`, or
    `policy.mcp`, and a `deniedMcpServers` entry naming a server locked above (by `serverName`, a
    `serverUrl` pattern matching its URL, or its `serverCommand`); `hooks` (not a known key today)
    → any `hooks` lock or `policy.hooks`; `claudeMd`, `claudeMdExcludes` → a lock on
    `instructions`; any key → a lock on `targets`, `targets.claude-code`,
    `targets.claude-code.managed` or the key itself. A replacement (amendment 4) is reported first.
    `managedSourcesBehavior` in the passthrough is still written but reported `advisory`: Claude
    Code reads it from the highest managed source, so the policy files cannot make a console or MDM
    policy merge with them.
16. **Earlier values our drop-in replaces.** `managed-settings.json` and drop-ins named before
    `50-zzpersona.json` are read first, so our single values replace theirs. Not a refusal:
    `install`'s plan lists `replaces <key> from <file>` (and `--json` a `replaces` array), and
    `check` adds a note finding per value (state unaffected). After applying, `install` runs `check`
    and prints its state and findings when they are not `current` (exit stays 0); `--json` carries
    `check`. `check`'s human output prints notes (`note: …`) even when `current`.
17. **`stale` compares with the pulled layers.** §3's "from the registry when configured" is not
    built: `check`, `doctor` and `status` never go to the network. With a registry configured, the
    `stale` detail ends `; compared with the layers pulled locally; run zzpersona pull for the
    latest`, and a `current` result carries that sentence as a note.
18. **What counts as a higher source delivering a policy.** In `remote-settings.json` and the MDM
    policy, only recognised settings keys count (the adapter's known managed keys plus ordinary
    settings such as `hooks` and `model`; never `managedSourcesBehavior` or
    `wslInheritsWindowsSettings` alone). `remote-settings.json` may be a bare settings object or a
    `{ "settings": { … } }` wrapper; wrapper metadata (`checksum`, timestamps) never counts.
19. **Other review fixes.** `managed build --out` refuses a path in or under any policy folder
    (resolved through symbolic links) and replaces an existing folder only when it holds exactly
    its manifest and the files that manifest lists. `uninstall` removes `managed-settings.d` and the
    policy folder itself when they are left empty. `--from-registry` refuses a bundle whose
    `manifest.os` differs from `--os` or whose deepest layer differs from `--layer`, and compares
    `zzpersona/manifest.json` with the manifest as the registry sent it (before tolerant parsing),
    so a newer server's extra manifest field is not tampering. The conformance kit's unknown-layer
    case requires `ref` on the problem. When locks exist but Claude Code enforces none of them,
    `build` says `nothing in <ref> and its ancestors is enforced by Claude Code; the bundle enforces
    nothing`. The capability matrix's `policy` row for Codex and `agents-md` is `none` ("not
    rendered; enforced only by managed bundles for Claude Code"), replacing amendment 11's
    "advisory".
