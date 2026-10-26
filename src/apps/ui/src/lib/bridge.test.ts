import { describe, expect, it } from "vitest";
import { CliFailure, createBridge } from "./bridge";
import type { DaemonEvent, EventSource } from "./events";

// The typed client over the bridge (docs/planning/26-gui.md §2, §4): each run's stdout parsed
// with its command's schema from @getdonn/cli-schemas, a failed run's error envelope as a
// CliFailure, the bridge's own refusals likewise, and a 401 ending the session. The bridge is a
// fake fetch answering as bridge.ts does.

const ORIGIN = "http://127.0.0.1:4321";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

type Handler = (body: unknown) => { status: number; body: unknown };

function fakeBridge(routes: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({
      method,
      path: url.pathname,
      auth: new Headers(init?.headers).get("authorization"),
      body,
    });
    const handler = routes[`${method} ${url.pathname}`];
    const answer = handler
      ? handler(body)
      : { status: 404, body: { error: { code: "not-found", message: "no" } } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetch: fetch as typeof globalThis.fetch };
}

/** `POST /v1/run` answering with this run result. */
const ran =
  (exitCode: number, stdout: unknown, stderr = ""): Handler =>
  () => ({
    status: 200,
    body: {
      exitCode,
      stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
      stderr,
    },
  });

/** An event source the test drives. */
function fakeEvents() {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const opens = new Set<() => void>();
  const source: EventSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onOpen(listener) {
      opens.add(listener);
      return () => opens.delete(listener);
    },
  };
  return {
    source,
    emit: (event: DaemonEvent) => listeners.forEach((l) => l(event)),
    reopen: () => opens.forEach((l) => l()),
    get listening() {
      return listeners.size;
    },
  };
}

function client(
  routes: Record<string, Handler>,
  extra: { onUnauthorized?: () => void; events?: EventSource } = {},
) {
  const fake = fakeBridge(routes);
  const bridge = createBridge({
    base: ORIGIN,
    token: () => "tok",
    fetch: fake.fetch,
    events: extra.events ?? fakeEvents().source,
    ...(extra.onUnauthorized && { onUnauthorized: extra.onUnauthorized }),
  });
  return { bridge, seen: fake.seen };
}

const LIST = {
  personas: [{ ref: "team/payments-backend", layer: "team" }],
};

describe("run", () => {
  it("sends the command with --json and the token, and parses with the schema", async () => {
    const { bridge, seen } = client({ "POST /v1/run": ran(0, LIST) });

    const out = await bridge.run("list", []);

    expect(out).toEqual(LIST);
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/v1/run",
        auth: "Bearer tok",
        body: { argv: ["list", "--json"] },
      },
    ]);
  });

  it("splits a two-word command and passes the cwd", async () => {
    const { bridge, seen } = client({
      "POST /v1/run": ran(0, { agents: [] }),
    });
    await bridge
      .run("agent list", ["--project", "/repo"], "/repo")
      .catch(() => undefined);
    expect(seen[0]!.body).toEqual({
      argv: ["agent", "list", "--project", "/repo", "--json"],
      cwd: "/repo",
    });
  });

  it("output the schema refuses is a bad-output CliFailure", async () => {
    const { bridge } = client({
      "POST /v1/run": ran(0, { personas: [{ ref: 1 }] }),
    });
    const error = await bridge.run("list", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliFailure);
    expect(error).toMatchObject({ code: "bad-output" });
  });

  it("a failed run throws its error envelope as a CliFailure", async () => {
    const { bridge } = client({
      "POST /v1/run": ran(1, {
        error: {
          code: "no-persona",
          message: "no persona selected",
          fix: "donn switch <persona>",
        },
      }),
    });
    const error = await bridge.run("resolve", [], "/repo").catch((e) => e);
    expect(error).toBeInstanceOf(CliFailure);
    expect(error).toMatchObject({
      code: "no-persona",
      message: "no persona selected",
      details: { fix: "donn switch <persona>" },
      exitCode: 1,
    });
  });

  it("a failed run without an envelope fails with its stderr", async () => {
    const { bridge } = client({
      "POST /v1/run": ran(3, "", "boom\nlast line\n"),
    });
    const error = await bridge.run("status", []).catch((e) => e);
    expect(error).toMatchObject({
      code: "cli-failed",
      message: "last line",
      exitCode: 3,
    });
  });

  it("the bridge's own refusal is a CliFailure with its details", async () => {
    const { bridge } = client({
      "POST /v1/run": () => ({
        status: 403,
        body: {
          error: {
            code: "unknown-project",
            message: "not a project donn knows: /x",
            details: { project: "/x", fix: "pick the project in the app" },
          },
        },
      }),
    });
    const error = await bridge.run("resolve", [], "/x").catch((e) => e);
    expect(error).toMatchObject({
      code: "unknown-project",
      message: "not a project donn knows: /x",
      details: { project: "/x", fix: "pick the project in the app" },
      status: 403,
    });
  });

  it("a 401 ends the session", async () => {
    let ended = 0;
    const { bridge } = client(
      {
        "POST /v1/run": () => ({
          status: 401,
          body: { error: { code: "unauthorized", message: "missing" } },
        }),
      },
      { onUnauthorized: () => ended++ },
    );
    const error = await bridge.run("list", []).catch((e) => e);
    expect(error).toMatchObject({ code: "unauthorized", status: 401 });
    expect(ended).toBe(1);
  });
});

describe("projects, open", () => {
  it("lists, adds and opens", async () => {
    const { bridge, seen } = client({
      "GET /v1/projects": () => ({
        status: 200,
        body: { projects: ["/a", "/b"] },
      }),
      "POST /v1/projects": (body) => ({
        status: 200,
        body: {
          path: (body as { path: string }).path,
          projects: ["/a", "/b", "/c"],
        },
      }),
      "POST /v1/open": (body) => ({
        status: 200,
        body: { opened: (body as { path: string }).path },
      }),
    });

    expect(await bridge.projects()).toEqual(["/a", "/b"]);
    expect(await bridge.addProject("/c")).toEqual({
      path: "/c",
      projects: ["/a", "/b", "/c"],
    });
    expect(await bridge.open("/c/.donn/persona.yaml")).toEqual({
      opened: "/c/.donn/persona.yaml",
    });
    expect(seen.map((s) => [s.method, s.path, s.body, s.auth])).toEqual([
      ["GET", "/v1/projects", undefined, "Bearer tok"],
      ["POST", "/v1/projects", { path: "/c" }, "Bearer tok"],
      ["POST", "/v1/open", { path: "/c/.donn/persona.yaml" }, "Bearer tok"],
    ]);
  });

  it("a refused add is a CliFailure", async () => {
    const { bridge } = client({
      "POST /v1/projects": () => ({
        status: 400,
        body: {
          error: {
            code: "not-a-project",
            message: "not a donn project (no .donn/persona.yaml): /tmp",
            details: { path: "/tmp", fix: "donn init --extends <persona>" },
          },
        },
      }),
    });
    await expect(bridge.addProject("/tmp")).rejects.toMatchObject({
      code: "not-a-project",
      details: { fix: "donn init --extends <persona>" },
    });
  });
});

describe("job", () => {
  it("follows its own job's events, including ones before its id came back", async () => {
    const events = fakeEvents();
    const { bridge, seen } = client(
      {
        "POST /v1/jobs": () => {
          // Answered after the job started: its first line is already out.
          events.emit({ type: "job.progress", id: "j1", line: "early" });
          return { status: 202, body: { id: "j1" } };
        },
      },
      { events: events.source },
    );

    const handle = await bridge.job(["pull"]);
    const lines: string[] = [];
    handle.on((event) => {
      if (event.type === "job.progress") lines.push(event.line);
    });
    events.emit({ type: "job.progress", id: "other", line: "not mine" });
    events.emit({ type: "job.progress", id: "j1", line: "late" });
    events.emit({
      type: "job.done",
      id: "j1",
      exitCode: 0,
      stdout: '{"pulled":[]}',
    });

    expect(handle.id).toBe("j1");
    expect(seen[0]!.body).toEqual({ argv: ["pull", "--json"] });
    expect(await handle.done).toEqual({
      exitCode: 0,
      stdout: '{"pulled":[]}',
    });
    expect(lines).toEqual(["early", "late"]);
    expect(events.listening).toBe(0);
  });

  it("a question is answered as a new job", async () => {
    const events = fakeEvents();
    const { bridge, seen } = client(
      {
        "POST /v1/jobs": () => ({ status: 202, body: { id: "j1" } }),
        "POST /v1/jobs/j1/answer": () => ({ status: 202, body: { id: "j2" } }),
      },
      { events: events.source },
    );
    const handle = await bridge.job(["agent", "create", "bot"], "/repo");
    const question = { key: "github.app", kind: "confirm", message: "Use?" };
    events.emit({
      type: "job.question",
      id: "j1",
      question,
      continue: ["agent", "add"],
    });
    events.emit({ type: "job.done", id: "j1", exitCode: 2, stdout: "{}" });

    expect(await handle.done).toEqual({
      exitCode: 2,
      stdout: "{}",
      question,
    });
    const next = await handle.answer("github.app", true);
    expect(next.id).toBe("j2");
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      [
        "/v1/jobs",
        { argv: ["agent", "create", "bot", "--json"], cwd: "/repo" },
      ],
      ["/v1/jobs/j1/answer", { key: "github.app", value: true }],
    ]);
  });

  it("a stream that reconnects asks for the job, so a missed done still ends it", async () => {
    const events = fakeEvents();
    const { bridge } = client(
      {
        "POST /v1/jobs": () => ({ status: 202, body: { id: "j1" } }),
        "GET /v1/jobs/j1": () => ({
          status: 200,
          body: {
            id: "j1",
            state: "done",
            exitCode: 0,
            stdout: "{}",
            stderr: "",
          },
        }),
      },
      { events: events.source },
    );
    const handle = await bridge.job(["pull"]);
    events.reopen();
    expect(await handle.done).toEqual({ exitCode: 0, stdout: "{}" });
  });
});
