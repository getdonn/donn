# eve runner spike (spec 25, layer 1)

Throwaway spike, run 2026-10-25 against `eve@0.83.2` (tag `eve@0.83.2`, commit 9f73f9d), Node
26.12, pnpm 12.14 (11.25 where a template selects it), Docker 28.3.3. Two halves, run in
parallel:

- `FINDINGS-templates.md`: tarballs at a tag, template digests, `eve init`, install isolation,
  `eve add` and its question protocol, `kody-eve-template` as a path template, the GitHub
  Actions one-shot question (T1–T8).
- `FINDINGS-runtime.md`: `eve build` + `eve start` with one turn through a stub gateway, route
  auth, the local world, the self-host image with the Docker sandbox and the Postgres world, the
  GitHub checkout on Docker, exit codes and NDJSON (R1–R6).

**Verdict: the production path works.** One turn reached the stub gateway with the configured
key and headers under `eve start`, on the host and from a container. What changed in spec 25
(amended in place on 2026-10-25, with `23`, `24` and `26`):

| Finding | Where | Change |
|---|---|---|
| Route auth fails closed under `eve start`; `localDev()` opens only under `eve dev` | R1 | The adapter writes a donn-owned `agent/channels/eve.ts` (bearer `DONN_ROUTE_TOKEN`) for `local` and `self-host` |
| `NODE_ENV=test` (or `EVE_MOCK_AUTHORED_MODELS=1`) mocks the model | R1 | `run`'s child env: `NODE_ENV=production`, strip `EVE_DEV`, `EVE_MOCK_AUTHORED_MODELS`, `VITEST` |
| `eve init` edits the nearest ancestor pnpm workspace, no flag | T3 | Run it in a temporary staging directory, then move the result |
| `--ignore-workspace` drops the template's pnpm settings | T4, R6 | Install in place; add `allowBuilds: { cbor-extract: false }` and the pinned eve to `minimumReleaseAgeExclude` |
| The Docker sandbox template is prepared at build, never in production | R3 | `build` runs `eve build` on the host; the image copies `.output/` and the `docker` CLI; two images |
| The Postgres world needs a database and a schema bootstrap | R3 | Self-host defaults to the local world; `world: postgres` is opt-in (maintainer's decision) |
| Only `eve add` asks questions; no template has a setup step | T5, R5 | The question protocol and `donn agent add` move to `26` (maintainer's decision) |
| Path templates' services are unknown to the report | T6 | Path templates compile with `portability-unknown` |
| `.eve/` holds build and world state | R2 | Added to the agent's `.gitignore` |
| `eve link`/`deploy` need the Vercel CLI | R5 | `create --target vercel` adds `vercel` as a pinned dev dependency |
| GitHub Actions one-shot | T7 | Yes, with glue (`eve remote invoke`, a just-bash sandbox, `gh pr comment`); a later spec |

Template digests for the templates table are in `FINDINGS-templates.md` T2. Recordings for the
fake-eve fixtures: `templates/fixtures/` and `runtime/recordings/`.
