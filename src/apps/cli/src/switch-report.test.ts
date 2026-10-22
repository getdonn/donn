import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonRequest } from "./daemon/client.js";
import { startDaemon, type Daemon } from "./daemon/server.js";
import { createSession } from "./session.js";
import { projectKey, readState } from "./state.js";
import { abandonedWork } from "./startup.js";
import { limits, reportLines } from "./switch-report.js";
import { installedProbe, seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
const daemons: Daemon[] = [];
beforeEach(() => {
  s = seed();
});
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  s.cleanup();
});

const FIXTURES = join(import.meta.dirname, "test/plugins");
const put = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const configure = (lines: string) =>
  put(join(s.home, "config.yaml"), `personas: ${s.personas}\n${lines}\n`);
/** team/payments compiles once its overview file exists. */
const payments = () =>
  put(join(s.personas, "team/instructions/overview.md"), "Payments overview.");

interface Harness {
  id: string;
  status: string;
  dropped: string[];
  approximated: string[];
  sessions?: { count: number; persona: string; fix: string };
  message?: string;
  fix?: string;
}
const run = async (
  args: string[],
  options: { probe?: Probe; cwd?: string } = {},
) =>
  zz(args, {
    cwd: options.cwd ?? s.repo,
    home: s.home,
    ...(options.probe && { probe: options.probe }),
  });
const harnesses = async (args: string[], options: { probe?: Probe } = {}) => {
  const r = await run([...args, "--json"], options);
  expect(r.code, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { harnesses?: Harness[] }).harnesses;
};
const only = (command: string): Probe => ({
  ...installedProbe,
  run: async (cmd, args) =>
    cmd === command
      ? installedProbe.run(cmd, args)
      : { exitCode: 127, stdout: "", stderr: "" },
});

describe("zzpersona switch: the per-harness report", () => {
  it("reports ok and drops per installed harness", async () => {
    const r = await run(["switch", "project/persona"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`project/persona is now used for ${s.repo}`);
    expect(lines).toContain(
      "claude-code  drops skills (1), mcp (1) · approximates knowledge (3)",
    );
    expect(lines).toContain(
      "codex        drops mcp (2), skills (2), hooks (2) · approximates knowledge (3), permissions (8)",
    );
    const json = await harnesses(["switch", "project/persona"]);
    expect(json?.find((h) => h.id === "codex")).toEqual({
      id: "codex",
      status: "drops",
      dropped: ["mcp (2)", "skills (2)", "hooks (2)"],
      approximated: ["knowledge (3)", "permissions (8)"],
    });
  });

  it("skips a harness that is not installed", async () => {
    const json = await harnesses(["switch", "project/persona"], {
      probe: only("claude"),
    });
    expect(json?.map((h) => h.id)).toEqual(["claude-code"]);
  });

  it("a failing adapter does not undo the switch", async () => {
    configure(`adapters: [${join(FIXTURES, "throwing-adapter")}]`);
    const r = await run(["switch", "project/persona"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("throwing     error boom");
    expect(r.stdout).toContain("claude-code  drops");
    const key = await projectKey(join(s.repo, ".zzpersona"));
    expect((await readState(s.home)).projects[key]).toBe("project/persona");
  });

  it("--harness limits the report", async () => {
    const json = await harnesses([
      "switch",
      "project/persona",
      "--harness",
      "codex",
    ]);
    expect(json?.map((h) => h.id)).toEqual(["codex"]);
    const r = await run([
      "switch",
      "project/persona",
      "--harness",
      "nope",
      "--json",
    ]);
    expect(JSON.parse(r.stdout).error.code).toBe("unknown-harness");
    expect(r.code).toBe(1);
  });

  it("an unknown --harness saves nothing", async () => {
    const r = await run(["switch", "project/persona", "--harness", "nope"]);
    expect(r.code).toBe(1);
    expect((await readState(s.home)).projects).toEqual({});
  });

  it("a broken config adapter does not fail the switch", async () => {
    configure(`adapters: [${join(FIXTURES, "moved-away")}]`);
    const r = await run(["switch", "project/persona"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^plugins +error /m);
    expect(r.stdout).toContain("claude-code  drops");
    const key = await projectKey(join(s.repo, ".zzpersona"));
    expect((await readState(s.home)).projects[key]).toBe("project/persona");
  });

  it("only approximating is ok, not drops", async () => {
    const lines = reportLines(
      [
        {
          id: "claude-code",
          status: "ok",
          dropped: [],
          approximated: ["knowledge (1)"],
        },
      ],
      "team/x",
    );
    expect(lines).toEqual(["claude-code  ok · approximates knowledge (1)"]);
  });

  it("lists agents-md last", async () => {
    expect((await run(["write"])).code).toBe(0);
    const json = await harnesses(["switch", "project/persona"]);
    expect(json?.map((h) => h.id)).toEqual([
      "claude-code",
      "codex",
      "agents-md",
    ]);
  });

  it("agents-md says what AGENTS.md carries", async () => {
    payments();
    expect(
      (await harnesses(["switch", "team/payments"]))?.map((h) => h.id),
    ).not.toContain("agents-md");
    expect((await run(["write"])).code).toBe(0);
    const shared = (await harnesses(["switch", "team/payments"]))?.find(
      (h) => h.id === "agents-md",
    );
    expect(shared).toMatchObject({ status: "shared" });
    expect((await run(["switch", "team/payments"])).stdout).toContain(
      "agents-md    AGENTS.md carries project/persona (shared); team/payments applies to zzpersona launches only\n",
    );
    expect(
      (await harnesses(["switch", "project/persona"]))?.find(
        (h) => h.id === "agents-md",
      ),
    ).toMatchObject({ status: "ok" });
    put(
      join(s.repo, ".zzpersona/instructions/checkout-overview.md"),
      "Changed overview text.",
    );
    const stale = (await harnesses(["switch", "project/persona"]))?.find(
      (h) => h.id === "agents-md",
    );
    expect(stale).toMatchObject({ status: "ok", fix: "zzpersona write" });
    expect((await run(["switch", "project/persona"])).stdout).toContain(
      "agents-md    carries project/persona — zzpersona write\n",
    );
  });

  it("agents-md does not suggest a write that would be refused", async () => {
    expect((await run(["write"])).code).toBe(0);
    put(
      join(s.home, "personas/mine.yaml"),
      "apiVersion: zzpersona/v0\nkind: Persona\nmetadata: { name: mine }\n",
    );
    const file = join(s.repo, ".zzpersona/persona.yaml");
    const text = readFileSync(file, "utf8");
    writeFileSync(
      file,
      text.replace("extends:\n", "extends:\n  - user/mine\n"),
    );
    put(
      join(s.repo, ".zzpersona/instructions/checkout-overview.md"),
      "Changed overview text.",
    );
    const r = await run(["switch", "project/persona"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^agents-md {4}carries project\/persona$/m);
  });

  it("times out a harness that never settles; the others report", async () => {
    configure(`adapters: [${join(FIXTURES, "hanging-adapter")}]`);
    limits.harnessMs = 100;
    const before = abandonedWork();
    try {
      const r = await run(["switch", "project/persona"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^hanging +error timed out after 0\.1s$/m);
      // The hung work may hold a handle: bin.ts ends the process once the report is out.
      expect(abandonedWork()).toBe(before + 1);
      expect(r.stdout).toContain("claude-code  drops");
    } finally {
      limits.harnessMs = 5000;
    }
  });

  describe("sessions", () => {
    const daemon = async () => {
      const d = await startDaemon({
        home: s.home,
        env: {},
        version: "9.9.9",
        pollMs: 50,
        probe: installedProbe,
      });
      daemons.push(d);
      return d;
    };
    const session = (harness: "claude-code" | "codex", persona: string) =>
      createSession(
        s.home,
        undefined,
        { persona, source: "argument", harness, project: s.repo },
        process.pid,
      );

    it("counts sessions here on another persona", async () => {
      payments();
      await session("claude-code", "project/persona");
      await session("codex", "project/persona");
      await session("claude-code", "team/payments");
      await daemon();
      const r = await run(["switch", "team/payments"]);
      expect(r.stdout).toContain(
        "· 1 session here still runs project/persona: /persona use team/payments",
      );
      expect(r.stdout).toContain(
        "· 1 session here still runs project/persona: relaunch with zzpersona codex",
      );
      const json = await harnesses(["switch", "team/payments"]);
      expect(json?.find((h) => h.id === "claude-code")?.sessions).toEqual({
        count: 1,
        persona: "project/persona",
        fix: "/persona use team/payments",
      });
    });

    it("counts a session launched from a symlinked checkout", async () => {
      const link = join(s.root, "link-to-repo");
      symlinkSync(s.repo, link);
      await createSession(
        s.home,
        undefined,
        {
          persona: "team/other",
          source: "argument",
          harness: "claude-code",
          project: link,
        },
        process.pid,
      );
      await daemon();
      const json = await harnesses(["switch", "project/persona"]);
      expect(json?.find((h) => h.id === "claude-code")?.sessions).toMatchObject(
        { count: 1, persona: "team/other" },
      );
    });

    it("a default switch counts no sessions", async () => {
      payments();
      await session("claude-code", "project/persona");
      await daemon();
      expect((await run(["write"])).code).toBe(0);
      const json = await harnesses(["switch", "team/payments", "--default"]);
      expect(json?.some((h) => h.sessions !== undefined)).toBe(false);
      expect(json?.map((h) => h.id)).not.toContain("agents-md");
    });

    it("no daemon, no sessions", async () => {
      await session("claude-code", "team/other");
      const json = await harnesses(["switch", "project/persona"]);
      expect(json?.some((h) => h.sessions !== undefined)).toBe(false);
    });

    it("a refusing daemon leaves out sessions", async () => {
      await session("claude-code", "team/other");
      const d = await daemon();
      writeFileSync(join(s.home, "daemon/token"), "wrong-token\n");
      const r = await run(["switch", "project/persona", "--json"]);
      expect(r.code, r.stderr).toBe(0);
      const json = JSON.parse(r.stdout) as { harnesses: Harness[] };
      expect(json.harnesses.some((h) => h.sessions !== undefined)).toBe(false);
      expect(d.token).not.toBe("wrong-token");
    });

    it("switch through /run reports", async () => {
      const d = await daemon();
      const started = Date.now();
      const res = await daemonRequest(
        d.socket,
        d.token,
        "POST",
        "/run",
        10_000,
        { argv: ["switch", "project/persona", "--json"], cwd: s.repo },
      );
      expect(res.status).toBe(200);
      const body = res.body as { exitCode: number; stdout: string };
      expect(body.exitCode).toBe(0);
      expect(JSON.parse(body.stdout).harnesses.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });

  it("prints resolve warnings once", async () => {
    const r = await run(["switch", "project/persona"]);
    const counts = new Map<string, number>();
    for (const line of r.stderr.split("\n").filter(Boolean))
      counts.set(line, (counts.get(line) ?? 0) + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });

  it("clearing reports for the persona that now applies", async () => {
    payments();
    await run(["switch", "team/payments"]);
    const r = await run(["switch", "--clear"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`cleared the switch for ${s.repo}`);
    expect(r.stdout).toContain("claude-code  drops");
    const json = await harnesses(["switch", "--clear"]);
    expect(json).toBeUndefined();
  });

  it("clearing prints a stray-layer warning once", async () => {
    payments();
    mkdirSync(join(s.personas, "user"));
    await run(["switch", "team/payments"]);
    const r = await run(["switch", "--clear"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr.match(/is ignored/g)).toHaveLength(1);
  });

  it("clearing to nothing reports nothing", async () => {
    const outside = join(s.root, "elsewhere");
    mkdirSync(outside);
    payments();
    await run(["switch", "team/payments"], { cwd: outside });
    const r = await run(["switch", "--clear", "--json"], { cwd: outside });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).harnesses).toBeUndefined();
  });

  it("show forms report nothing", async () => {
    for (const args of [["switch"], ["switch", "--default"]]) {
      const r = await run([...args, "--json"]);
      expect(JSON.parse(r.stdout).harnesses, args.join(" ")).toBeUndefined();
    }
  });
});
