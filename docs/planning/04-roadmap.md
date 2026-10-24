# 04 — Roadmap

> Status: draft v0, 2026-10-20. Slices `03-architecture.md` into phases. Sized for 1 engineer
> at the start growing to 3. Durations are rough and assume part-time; treat them as ordering,
> not commitments. Each phase ends with an **exit question** — if the answer is no, stop and
> rethink before spending the next phase.
> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).

## Phase 0 — Spikes and the IR (serial, 1 person)

Goal: de-risk the two things everything else depends on — the Claude Code activation story and
the resolver's merge semantics — and freeze a v0 IR.

Work:
- `spikes/claude-code/`: run the five spikes in `03` Appendix A. Outputs: a written decision on
  activation strategy, and a confirmed list of what the plugin can/cannot carry on the current
  Claude Code build.
- `spikes/agents-md/`: how Codex / Copilot / others read `AGENTS.md`; confirm the lowest common
  denominator target is viable.
- `packages/spec`: zod schema for `Persona` and `ResolvedPersona` (IR), JSON Schema export,
  `irVersion`.
- `packages/resolver`: DAG + C3 linearization + per-field merge rules from `02` + locks +
  provenance. **Heavy test suite here**: a fixtures directory of persona stacks with expected
  resolved output and expected warnings/errors. This test suite is the real spec.
- Pick the name; register npm scope, GitHub org, domain. **Blocks npm publishing below**, nothing
  else: bootstrap and build under the `zzpersona` placeholder with every package
  `"private": true` (see `00-handoff.md` → "Naming"). Hatrack is taken (2026-10-20).
  *2026-10-23: named **donn**; npm org `@getdonn`, GitHub org `getdonn` and `getdonn.dev` are
  registered. The rename and first publish remain.*
- Repo bootstrap: turborepo, pnpm, vitest, changesets, CI. Once named, publish the scope to npm
  (even at 0.0.x) so the enterprise boundary is real before the private repo exists.

Exit question: *Can I write the org → area → team → project → user example from `02` as fixtures,
and does `resolve --explain` produce output a reviewer would trust?*

## Phase 1 — OSS v0: one harness, end to end (1 → 2 people)

Goal: a solo developer can define personas and switch between them in Claude Code, and it is
better than shell aliases.

Work:
- `packages/adapter-sdk`: `HarnessAdapter` interface, `CompileReport`, capability-matrix types,
  shared conformance tests every adapter must pass.
- `packages/adapters/claude-code`: compile → {plugin, settings fragment, mcp.json,
  system-prompt.md}; local marketplace generation; `activate()` per the chosen strategy.
- `packages/store-local`, `packages/secrets` (env + 1Password CLI to start).
  > Amended 2026-10-21 (`08`): built-ins are env and the OS keychain; 1Password and other
  > vendors become secret provider packages loaded like adapters.
- `apps/cli`: `init`, `resolve [--explain] [--json]`, `compile`, `switch`, `claude` (relaunch
  wrapper), `doctor`, `diff <a> <b>`.
- `packages/mod-claude-code`: status line / band with active persona, cwd-mismatch nudge,
  `/persona list|switch` (switch does what the spike said is acceptable, then instructs the user).
- `apps/docs`: spec reference generated from the schema, getting-started, "why not aliases."
- Dogfood across 3+ personal contexts for several weeks before announcing.

Parallel seam once the IR is frozen: person A on adapter + mod, person B on CLI + store + secrets
+ docs. Both consume `spec`/`resolver` and should not need to change them often; if they do, that
is a signal the IR was frozen too early.

Exit question: *Do I switch personas more than once a day without thinking about it, and did at
least one outside user file an issue describing a team problem?*

## Phase 2 — Multi-harness + daemon (2–3 people)

Goal: prove the spec is actually harness-neutral, and remove the terminal as a prerequisite.

Work:
- `adapters/agents-md` (generic LCD — cheap, covers several tools, forces the honest-loss story).
- One **real** second adapter with native MCP + permissions: Codex or Cursor, whichever the spike
  showed has the richer surface. Antigravity and Gemini CLI follow the same pattern afterward.
  *Amended 2026-10-21: the agents-md spike points to **Codex**. It takes instructions, MCP
  servers and approval policy per launch (relaunch, as for Claude Code); Copilot CLI is a close
  third. Cursor was not probed.*
- Fill the capability matrix from real adapters, not guesses; publish it in the docs — it is a
  marketing asset ("here is exactly what each tool can and cannot enforce").
- `apps/daemon` (`donnd`): local API, cache, pre-build, watchers, harness detection, service
  install. CLI and mod become daemon clients with in-process fallback.
- `switch --harness all` with per-harness results.
  *2026-10-22: built as spec 17: one choice for every harness (already true of `state.json`), and
  `switch` reports per harness after saving; `--harness <id>` limits the report.*
- Optional, if someone wants it: `apps/desktop` tray client (Tauri). Explicitly not before the
  daemon exists.

Parallel seam: A on adapters, B on daemon, C on docs/DX/community + starting Phase 3 design.

Exit question: *Does a persona authored once produce a usable setup in two harnesses, with a loss
report people find credible rather than alarming?*

## Phase 3 — Enterprise alpha: publish, lock, see (2–3 people, private repo)

Goal: a team lead can publish a persona, an org can lock parts of it, and a platform team can see
who is running what. Build only the slice a design-partner asks for.

Work:
- `control-plane`: Postgres, persona registry + versions, publish API with server-side lock
  enforcement, OIDC, RBAC (view / publish / lock per layer path), append-only audit.
- `packages/store-remote` (OSS client) + `donn login|publish|pull`.
- Drift: daemon reports local-vs-published; console shows it per team.
- Claude Code enforcement path: compile org locks → `managed-settings.d/donn.json` +
  `managed-mcp.json` bundle for the customer's MDM. (Other harnesses: whatever their managed
  surface is, or "advisory only" in the report.)
- Gateway adapter v1: Bifrost (2026-10-22: renamed "Gateway adapter v1: Bifrost and LiteLLM", see spec 18) — resolve `gateway://` refs, pull allowed-tool sets into policy.
- `console`: minimal — personas, versions, locks, drift, audit. Ugly is fine.
- `deploy`: Dockerfile, Helm chart, air-gapped install doc.
- Licensing: pick the mechanism (license key checked offline, seat count) — keep it boring.

*Amended 2026-10-22:* Phase 3 is built ahead of a design partner, aimed at one known organisation
once most of it is complete, replacing "build only the slice a design-partner asks for". Spec
`18-registry-contract.md` splits it into A-H (registry contract and client, control plane core,
identity, drift, Claude Code enforcement, gateway adapter, deploy, console); A is built first.

Parallel seam: A control-plane + policy, B console + deploy, C stays on OSS (adapters, daemon,
community) so the funnel does not stall while the paid tier is built.

Exit question: *Is there one organization (even a friend's 10-person team) that would deploy this
and let us watch?*

## Track: agents and the GUI (added 2026-10-24)

Starts after the first `npm publish`; runs beside Phase 3 and does not block the control plane.
Specs `23`–`26`.

Work, in order:
- `23` — `models` and `agents` in the spec and resolver; `models` in the capability matrix.
- `24` — `adapters/eve`: the `AgentAdapter` contract, the compile into an eve extension, the
  ownership manifest, the portability report.
- `25` — `donn agent` (create, sync, run, build, deploy, env, exec); local, self-host and Vercel
  targets; a spike on a GitHub Actions target.
- `26` — the GUI (`donn ui` and the Tauri desktop app). Its bridge and non-agent screens can start
  in parallel with `23`; the agents screen follows `25`'s create layer.

Private repo, later: agent governance in the control plane and console (who may create and deploy
which agents, against which gateway; an inventory of running agents).

Exit question: *Does a team run a PR reviewer built from its persona, self-hosted or on Vercel,
and keep it after the first month?*

## Phase 4 — Harden and decide (ongoing)

Only after Phase 3 has a design partner:
- SaaS vs. self-hosted-only decision (architecture already keeps `org_id` everywhere).
- "Persona as MCP endpoint" — the daemon-hosted per-persona MCP aggregator parked in `03`. Could
  be the second product; could be the thing that makes the first one indispensable. Decide with
  data.
- Knowledge layer beyond pointers, only if a paying customer asks.
- IDE extensions (VS Code first) as daemon clients.
- Skills portability / harness-neutral skill manifest, if adapters keep fighting skill formats.

## Dependency graph (what blocks what)

```
spec ─┬─► resolver ─┬─► adapter-sdk ─┬─► adapters/claude-code ─► mod-claude-code
      │             │                ├─► adapters/agents-md
      │             │                └─► adapters/<second>
      │             ├─► cli ◄── store-local, secrets
      │             └─► daemon ◄── adapters, store-*
      └─► store-remote ─► control-plane ─► console, deploy, gateway-integrations
```

Critical path: `spec → resolver → adapter-sdk → adapters/claude-code`. One person, serial, and
worth doing slowly. Everything to the right of `adapter-sdk` fans out.

## Team-shape notes

- Until the IR is frozen, more people slow things down. Bring engineer #2 in at the start of
  Phase 1 on the CLI/store side, where the interface to `resolver` is stable and narrow.
- Engineer #3 is most valuable at Phase 2 (second adapter *or* daemon) or Phase 3 (control
  plane). Do not add a third person to the same package as the first two.
- Whoever owns `spec`/`resolver` also owns the fixture suite and the `irVersion` bump policy.
  That is the de facto architect role.
- Community/docs is a real job from Phase 1 on; rotate it rather than letting it default to the
  founder.

## What we are explicitly *not* doing before Phase 3 has a partner

- Any SaaS hosting, billing, or multi-tenancy work.
- A vector store or document ingestion of any kind.
- IDE extensions beyond compiled config files.
- Marketing site beyond a README and the docs.
