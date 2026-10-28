# Sticky Port for Local Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `local` agent keeps one port per machine across runs and sync restarts, set with
`donn agent run <name> --port <n>`, so a tunnel and a webhook URL pointed at it keep working.

**Architecture:** The port is stored on the agent's entry in `~/.donn/agents/index.json`
(`agent/registry.ts`). A new `agent/port.ts` validates, picks, checks and stores it
(`choosePort`). Every start of a `local` agent — foreground, `--dev`, the daemon's run and its
restart after a sync — calls `choosePort` and passes the port to `eve start`/`eve dev`. The flag
reaches the daemon as `port` on `POST /agents/run`. `agent list --json` and `status --json` show
the stored port.

**Tech Stack:** TypeScript, Node 26 (`node:net` for the port check), commander, zod 4, vitest.

**Spec:** `docs/planning/25-agent-runner.md`, section "Amendment: a sticky port for local agents
(2026-10-28)" (and §3–§4, which it amends).

## Global Constraints

- A port is an integer from 1024 to 65535 inclusive; nothing else is accepted or stored.
- The agent listens on `127.0.0.1` only; the check binds `127.0.0.1` only.
- Only `local` agents get a sticky port. `self-host` keeps `eve start --port 0`; `vercel` under
  `--dev` keeps `eve dev` without `--port`.
- A port is stored only after the check passes; donn never moves a stored port on its own.
- Error codes, messages and fixes, verbatim:
  - `invalid-port`: `--port must be an integer from 1024 to 65535`
  - `port-in-use`: `port <port> is in use by another process`, details `{ port, fix: "donn agent run <name> --port <other>" }`
  - `port-local-only`: `<name> targets <target>: --port applies to local agents only`, details `{ target }`
  - `agent-running`: `<name> is running on port <current>; stop it to change its port`, details `{ port: <current>, fix: "donn agent stop <name>" }`
- Text copy, verbatim: the first-pick note `port <port> is kept for <name>; a tunnel can point at
  it`; the old-daemon warning `warning: the daemon ignored --port (it runs an older donn); run
  donn daemon install again`; the socket's refusal reason `port must be an integer from 1024 to
  65535`.
- Tests never touch the real home, keychain or a real eve outside `DONN_E2E=1`; binding real
  `127.0.0.1` sockets in the test process is allowed.
- Prettier width 80 (`pnpm format`); every command keeps `--json`; commit trailers as in
  `CLAUDE.md` plus `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GmLJYkbT5dYe37adTR8fab`, signed off (`-s`).

## Review Focus

1. Two projects' agents with the same stored port: the second start fails `port-in-use` and its
   stored port is unchanged (Task 1 test "a taken stored port is refused and kept").
2. An index written by an older donn (no `port`) or holding `"port": "abc"` / `80`: read as no
   port, every entry still loads (Task 1 test "a bad stored port reads as none").
3. `donn agent create` run again for an agent that already has a port keeps it (Task 1 test
   "recordCreated keeps an entry's port").
4. `--port` equal to the running agent's port prints "already running", not `agent-running`
   (Task 3 test "the same port while running is already running").
5. A sync restart reuses the stored port even when the agent was first started with no
   `--port` (Task 3 test "a restart after a sync keeps the port").

---

### Task 1: Store, pick and check a port

**Files:**
- Modify: `src/apps/cli/src/agent/registry.ts`
- Create: `src/apps/cli/src/agent/port.ts`
- Test: `src/apps/cli/src/agent/registry.test.ts`, `src/apps/cli/src/agent/port.test.ts`

**Interfaces:**
- Produces (registry.ts): `CreatedAgent` gains `port?: number`; the `Index` entry schema gains
  `port: z.number().int().min(1024).max(65535).optional().catch(undefined)`;
  `storedPort(home: string, project: string, name: string): Promise<number | undefined>`;
  `recordPort(home: string, project: string, name: string, port: number): Promise<void>` (sets
  the port on the entry under the index lock, adding `{ project, name, port }` when there is no
  entry).
- Produces (port.ts): `PORT_RANGE = { min: 1024, max: 65535 }`;
  `parsePort(text: string): number` (throws `invalid-port`; accepts only `/^\d+$/` in range);
  `isPort(value: unknown): value is number`;
  `freePort(): Promise<number>` (listen on `127.0.0.1:0`, read the port, close);
  `assertPortFree(port: number, name: string): Promise<void>` (listen on `127.0.0.1:<port>`,
  close; `EADDRINUSE` → `port-in-use`);
  `choosePort(home: string, project: string, name: string, requested?: number): Promise<{ port: number; picked: boolean }>`
  — `requested ?? stored ?? freePort()`, then `assertPortFree`, then `recordPort`; `picked` is
  true only when neither `requested` nor a stored port existed.

- [ ] **Step 1: Write the failing tests** (temp home via `mkdtemp`, as `registry.test.ts` does)

```ts
// registry.test.ts
it("stores a port and reads it back", async () => {
  await recordCreated(home, { project: "/r", name: "a" });
  await recordPort(home, "/r", "a", 8787);
  expect(await storedPort(home, "/r", "a")).toBe(8787);
  expect(await listCreated(home)).toEqual([{ project: "/r", name: "a", port: 8787 }]);
});
it("records a port for an agent missing from the index", async () => {
  await recordPort(home, "/r", "b", 9000);
  expect(await storedPort(home, "/r", "b")).toBe(9000);
});
it("a bad stored port reads as none", async () => {
  // write index.json by hand: ports "abc", 80 and 70000 on three entries, one valid entry
  // expect listCreated to return all four, with port undefined on the three bad ones
});
it("recordCreated keeps an entry's port", async () => {
  await recordPort(home, "/r", "a", 8787);
  await recordCreated(home, { project: "/r", name: "a" });
  expect(await storedPort(home, "/r", "a")).toBe(8787);
});

// port.test.ts
it.each(["0", "80", "1023", "65536", "70000", "8787x", "-1", "", "87.5"])(
  "parsePort refuses %j", (text) => {
    expect(() => parsePort(text)).toThrow("--port must be an integer from 1024 to 65535");
  });
it("parsePort accepts the range's ends", () => {
  expect(parsePort("1024")).toBe(1024);
  expect(parsePort("65535")).toBe(65535);
});
it("freePort finds a port that is free", async () => {
  const port = await freePort();
  await expect(assertPortFree(port, "a")).resolves.toBeUndefined();
});
it("assertPortFree refuses a bound port", async () => {
  // hold a net.Server on 127.0.0.1:<freePort()>; expect code "port-in-use",
  // message "port <p> is in use by another process", details.fix "donn agent run a --port <other>"
});
it("choosePort picks, stores and then reuses a port", async () => {
  const first = await choosePort(home, "/r", "a");
  expect(first.picked).toBe(true);
  const again = await choosePort(home, "/r", "a");
  expect(again).toEqual({ port: first.port, picked: false });
});
it("choosePort with a requested port replaces the stored one", async () => { /* picked false */ });
it("a taken stored port is refused and kept", async () => {
  // recordPort(8xxx = a port held by a test server); choosePort(home,"/r","a") rejects
  // port-in-use; storedPort still that port
});
it("a taken requested port is refused and never stored", async () => {
  // stored A (free); requested B (held) → port-in-use; storedPort still A
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @getdonn/cli exec vitest run src/agent/registry.test.ts src/agent/port.test.ts`
Expected: FAIL (`recordPort`, `storedPort`, `./port.js` not found).

- [ ] **Step 3: Implement the registry changes and `agent/port.ts`** with the Interfaces above.
`assertPortFree` listens with `{ host: "127.0.0.1", port, exclusive: true }` and closes before
resolving; any listen error other than `EADDRINUSE` is rethrown.

- [ ] **Step 4: Run the tests and see them pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(cli): store and check a sticky port for an agent`

### Task 2: The foreground run, `--dev` and the `--port` flag

**Files:**
- Modify: `src/apps/cli/src/agent/run.ts`, `src/apps/cli/src/cli.ts` (the `agent run` command,
  ~line 688), `src/apps/cli/src/commands/agent.ts` (only if `RunOptions` is re-declared there)
- Test: `src/apps/cli/src/agent/run.test.ts`

**Interfaces:**
- Consumes: Task 1's `choosePort`, `parsePort`.
- Produces: `StartOptions.port?: number` (absent → `"0"`, as today); `RunOptions.port?: number`;
  `RunRequest.port?: number`; `assertPortTarget(name: string, target: string, port?: number): void`
  (throws `port-local-only` when `port !== undefined && target !== "local"`);
  `keptNote(port: number, name: string): string` returning the first-pick note copy.

- [ ] **Step 1: Write the failing tests** (fake spawn, as the existing `startAgent` tests do)

```ts
it("starts eve on the given port", async () => {
  // startAgent(..., { ..., port: 8787 }) → spawn args include ["--port", "8787"]
});
it("maps eve's EADDRINUSE before it listens to port-in-use", async () => {
  // fake eve prints "Error: listen EADDRINUSE: address already in use 127.0.0.1:8787" and
  // exits 1 → rejects with code "port-in-use", details.port 8787
});
it("a foreground local run stores a picked port and says so once", async () => {
  // run(io, "kody", {}) twice without a daemon (temp home, created local agent):
  // the same --port both times; stdout of the first has keptNote(port, "kody"), the second not
});
it("a foreground --port replaces the stored port", async () => { /* index holds the new one */ });
it("--dev passes the stored port to eve dev", async () => {
  // args ["exec", "eve", "dev", "--port", "<port>"]
});
it("--port is refused for a self-host or vercel agent", async () => {
  // code "port-local-only", message "kody targets self-host: --port applies to local agents only"
});
it("a self-host run keeps --port 0 and stores nothing", async () => {});
it("the CLI refuses --port 80", async () => {
  // donn agent run kody --port 80 --json → envelope code "invalid-port", exit 1, nothing spawned
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @getdonn/cli exec vitest run src/agent/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `startAgent`: `"--port", String(options.port ?? 0)`. On an early exit, if any line of the
    tail matches `/EADDRINUSE/`, throw `port-in-use` (Global Constraints copy, `<name>` =
    `options.name`) instead of `eve-failed`.
  - `cli.ts`: `.option("--port <n>", "keep the agent on this port (local agents; 1024-65535)")`;
    parse with `parsePort` in the action so a bad value fails before anything runs.
  - `foreground`: after `runEnvironment` (which gives `agent.target`), call
    `assertPortTarget`; for `local`, `choosePort(ctx.home, root, name, options.port)` and pass
    `port`; when `picked`, write `keptNote` to stdout after `printStarted` (stderr under
    `--json`).
  - `dev`: same, appending `"--port", String(port)` for `local` only.

- [ ] **Step 4: Run the tests and see them pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(cli): donn agent run --port and a sticky port in the foreground`

### Task 3: The daemon

**Files:**
- Modify: `src/apps/cli/src/daemon/agents.ts`, `src/apps/cli/src/daemon/server.ts`
  (`agentRequest`), `src/apps/cli/src/daemon/client.ts` (`runAgent`),
  `src/apps/cli/src/agent/run.ts` (`agentControl`, the daemon branch of `run`)
- Test: `src/apps/cli/src/daemon-agents.test.ts`, `src/apps/cli/src/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1's `choosePort`, `storedPort`; Task 2's `RunRequest.port`, `assertPortTarget`,
  `keptNote`.
- Produces: `DaemonClient.runAgent(project, name, env?, port?: number)` (sends `port` when set);
  `agentRequest` returns `{ project, name, env?, port? }`, refusing a bad `port` with the reason
  copy; `agentControl(...).run(project, name, request)` passes `request.port`.

- [ ] **Step 1: Write the failing tests** (`agentRunner` with fake spawns; the socket through the
  test daemon, as the existing tests do)

```ts
it("a first daemon run stores a port and a second run reuses it", async () => {});
it("a restart after a sync keeps the port", async () => {
  // run with no port; sync writes a file; the restarted agent's spawn args carry the same --port
});
it("--port through the daemon replaces the stored port", async () => {});
it("a taken port through the daemon is never stored", async () => {});
it("a restart that meets a taken port is a sync failure", async () => {
  // after the stop, a test server takes the port; syncFailures() has { name, project,
  // code: "port-in-use" } and an agent.sync-failed event was emitted
});
it("a different --port while running is agent-running", async () => {
  // donn agent run kody --port <other> → code "agent-running", fix "donn agent stop kody"
});
it("the same port while running is already running", async () => {});
it("POST /agents/run refuses port 80", async () => {
  // 400 with "port must be an integer from 1024 to 65535"
});
it("warns when the daemon ignores --port", async () => {
  // io.agents.run returns an agent whose url has another port → stderr has the old-daemon
  // warning copy
});
it("says the port is kept on a daemon run that picked one", async () => {});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `pnpm --filter @getdonn/cli exec vitest run src/daemon-agents.test.ts src/daemon.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `launch`: after `runEnvironment` (its `agent.target`), `assertPortTarget`; for `local`,
    `choosePort(options.home, root, name, request.port)` and pass `port` to `startAgent`.
  - `restart`: catch `begin`'s rejection; when its code is `port-in-use`, `failures.set(k, {
    name, project, code })`, log `agent <name> in <project> sync failed: port-in-use`, and emit
    `agent.sync-failed`. Other codes stay as today.
  - `run` (CLI, daemon branch): when `options.port` is set and the agent is already running,
    compare with `Number(new URL(on.url).port)`: equal → "already running" as today, else
    `agent-running`. Before `control.run`, read `storedPort(ctx.home, root, name)`; after it,
    print `keptNote` when there was none, and the old-daemon warning when `options.port` is set
    and the URL's port differs.

- [ ] **Step 4: Run the tests and see them pass**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(cli): the daemon keeps an agent's port across runs and restarts`

### Task 4: The port in `agent list` and `status`, docs and release

**Files:**
- Modify: `src/apps/cli/src/agent/list.ts` (`AgentRow`, `CreatedRow`, `agentStates`,
  `createdAgentRows`), `src/packages/cli-schemas/src/agents.ts` (`AgentListOutput`),
  `src/packages/cli-schemas/src/sessions.ts` (`CreatedAgent`), `src/apps/cli/src/agent.e2e.test.ts`
- Create: `.changeset/agent-port.md`
- Test: the existing list/status tests (`src/apps/cli/src/agent/*.test.ts`,
  `src/apps/cli/src/daemon-agents.test.ts`)

**Interfaces:**
- Consumes: Task 1's `listCreated` (with `port`).
- Produces: `port?: number` on `AgentRow`, `CreatedRow`, `AgentListOutput` rows
  (`z.number().int().optional()`) and the status `CreatedAgent` schema — the stored port, set
  whether or not the agent runs.

- [ ] **Step 1: Write the failing tests**

```ts
it("agent list --json shows the stored port of a stopped agent", async () => {
  // recordPort(home, root, "kody", 8787); list --json row has port 8787 and no url;
  // AgentListOutput.parse(output) succeeds
});
it("status --json shows an agent's stored port", async () => { /* schema-checked */ });
it("an agent with no stored port has no port field", async () => {});
```

- [ ] **Step 2: Run the tests and see them fail.** Run the touched test files. Expected: FAIL.

- [ ] **Step 3: Implement** the rows (read `listCreated(ctx.home)` once in `agentStates`) and the
  schemas. Text output (`createdLine`) is unchanged.

- [ ] **Step 4: Real eve and release.**
  - `agent.e2e.test.ts` (`DONN_E2E=1` only): run the created agent, stop it, run it again; both
    URLs have the same port, equal to `storedPort`.
  - `.changeset/agent-port.md`: `"@getdonn/cli": minor` and `"@getdonn/cli-schemas": minor`,
    one paragraph naming `--port`, the sticky port and `port` in the JSON.
  - If `src/apps/cli/src/desktop-fixtures.test.ts` fixtures change, regenerate with
    `DONN_UPDATE_FIXTURES=1`.

- [ ] **Step 5: Full check.** Run: `pnpm turbo run build check-types lint test && pnpm format:check`.
  Expected: all green.

- [ ] **Step 6: Commit** — `feat(cli): the stored port in agent list and status`

### After the tasks

Smoke before the final review (spec §8, amendment): kody in `~/Repos/donn-kody-smoke2` through
the develop CLI wrapper and a daemon on its temp home, a cloudflared tunnel to the stored port,
the App's webhook pointed at it; edit the persona so the daemon syncs and restarts kody; a new
PR comment mention still gets an answer with no webhook URL change.
