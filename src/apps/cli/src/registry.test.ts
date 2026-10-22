import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivationPlan, Probe } from "@zzpersona/adapter-sdk";
import { startMockRegistry } from "@zzpersona/registry-api/mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedProbe, zz, type RunResult } from "./test/seed.js";

const EXAMPLES = join(import.meta.dirname, "../../../../examples/personas");
const TOKEN = "tok-leak-check-9f3a";
const WRONG = "wrong-leak-check-77c1";

let registry: Awaited<ReturnType<typeof startMockRegistry>>;
let roots: string[] = [];
const hanging: Server[] = [];
/** Everything every command printed, for the leak scan at the end. */
const output: string[] = [];

beforeEach(async () => {
  registry = await startMockRegistry({ token: TOKEN });
});
afterAll(() => {
  for (const server of hanging) server.close();
});
afterEach(async () => {
  await registry.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const NORMALISED = () => `${registry.url}/`;

/** A secret probe on a platform with no keychain, so tokens go to the 0600 file. */
const noKeychain: Probe = { ...installedProbe, platform: "win32" };

interface Machine {
  root: string;
  home: string;
  personas: string;
  cwd: string;
}

/** A home with a copy of examples/personas and a config naming `url` (when given). */
function machine(url: string | null = registry.url): Machine {
  const root = mkdtempSync(join(tmpdir(), "zzp-registry-"));
  roots.push(root);
  const home = join(root, "home");
  const personas = join(root, "personas");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  cpSync(EXAMPLES, personas, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `personas: ${personas}\n${url === null ? "" : `registry:\n  url: ${url}\n`}`,
  );
  return { root, home, personas, cwd };
}

type Extra = Parameters<typeof zz>[1];

/** Run the CLI as this machine; the token comes from the environment unless `token` is false. */
async function run(
  m: Machine,
  argv: string[],
  extra: Partial<Extra> & { token?: string | false } = {},
): Promise<RunResult> {
  const { token = TOKEN, env, ...rest } = extra;
  const r = await zz(argv, {
    cwd: m.cwd,
    home: m.home,
    secretProbe: noKeychain,
    ...rest,
    env: {
      ...(token !== false && { ZZPERSONA_REGISTRY_TOKEN: token }),
      ...env,
    },
  });
  output.push(r.stdout, r.stderr);
  return r;
}

const recorder = () => {
  const plans: ActivationPlan[] = [];
  return {
    plans,
    runPlan: async (plan: ActivationPlan) => {
      plans.push(plan);
      return 0;
    },
  };
};

const edit = (m: Machine, file: string, from: string, to: string) => {
  const path = join(m.personas, file);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
};

const index = (m: Machine) =>
  JSON.parse(
    readFileSync(join(m.home, "cache/registry/index.json"), "utf8"),
  ) as {
    url: string;
    pulledAt: string;
    layers: Record<string, { version: number }>;
  };

describe("login, logout, whoami", () => {
  it("login checks the token and saves the URL", async () => {
    const m = machine(null);
    const r = await run(m, ["login", registry.url, "--token-stdin"], {
      token: false,
      stdin: async () => TOKEN,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`logged in to ${NORMALISED()} as mock-user\n`);
    const config = readFileSync(join(m.home, "config.yaml"), "utf8");
    expect(config).toContain(NORMALISED());
    expect(config).toContain("personas:");
  });

  it("a refused token saves nothing", async () => {
    const m = machine(null);
    const r = await run(m, ["login", registry.url, "--token-stdin", "--json"], {
      token: false,
      stdin: async () => WRONG,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("unauthorized");
    expect(existsSync(join(m.home, "registry-token"))).toBe(false);
    expect(readFileSync(join(m.home, "config.yaml"), "utf8")).not.toContain(
      "registry:",
    );
  });

  it("login trims a piped token", async () => {
    const m = machine(null);
    const r = await run(m, ["login", registry.url, "--token-stdin"], {
      token: false,
      stdin: async () => `  ${TOKEN} \n\n`,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(m.home, "registry-token"), "utf8").trim()).toBe(
      TOKEN,
    );
  });

  it("login without a terminal or --token-stdin hints --token-stdin", async () => {
    const m = machine(null);
    const r = await run(m, ["login", registry.url, "--json"], {
      token: false,
      readSecret: async () => undefined,
    });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.hint).toBe("--token-stdin");
  });

  it("login refuses an http URL that is not loopback", async () => {
    const m = machine(null);
    const r = await run(m, ["login", "http://registry.example.com"], {
      token: false,
      stdin: async () => TOKEN,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("must be https://");
  });

  it("login stores the token in the keychain on darwin and linux, else a 0600 file", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const m = machine(null);
      const calls: { command: string; args: string[]; input?: string }[] = [];
      const r = await run(m, ["login", registry.url, "--token-stdin"], {
        token: false,
        stdin: async () => TOKEN,
        secretProbe: { ...installedProbe, platform },
        runInput: async (command, args, input) => {
          calls.push({ command, args, ...(input !== undefined && { input }) });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      expect(r.code, r.stderr).toBe(0);
      const file = join(m.home, "registry-token");
      if (platform === "win32") {
        expect(calls).toEqual([]);
        expect(readFileSync(file, "utf8").trim()).toBe(TOKEN);
        if (process.platform !== "win32") {
          expect(statSync(file).mode & 0o777).toBe(0o600);
        }
        continue;
      }
      expect(existsSync(file)).toBe(false);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call!.command).toBe(
        platform === "darwin" ? "security" : "secret-tool",
      );
      // The token goes to stdin, never argv.
      expect(call!.args.join(" ")).not.toContain(TOKEN);
      expect(call!.input).toContain(TOKEN);
      const everything = `${call!.args.join(" ")} ${call!.input}`;
      expect(everything).toContain("zzpersona-registry");
      expect(everything).toContain(NORMALISED());
    }
  });

  it("falls back to the file when the keychain fails", async () => {
    const m = machine(null);
    const r = await run(m, ["login", registry.url, "--token-stdin"], {
      token: false,
      stdin: async () => TOKEN,
      secretProbe: { ...installedProbe, platform: "linux" },
      runInput: async () => ({ exitCode: 127, stdout: "", stderr: "" }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(m.home, "registry-token"), "utf8").trim()).toBe(
      TOKEN,
    );
  });

  it("logout removes the token and keeps the cache", async () => {
    const m = machine();
    await run(m, ["publish", "org/acme"]);
    expect((await run(m, ["pull"])).code).toBe(0);
    writeFileSync(join(m.home, "registry-token"), `${TOKEN}\n`);
    const r = await run(m, ["logout"], { token: false });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(m.home, "registry-token"))).toBe(false);
    expect(existsSync(join(m.home, "cache/registry/index.json"))).toBe(true);
    expect(readFileSync(join(m.home, "config.yaml"), "utf8")).toContain(
      "registry:",
    );
    expect((await run(m, ["whoami"], { token: false })).stdout).toBe(
      "not logged in\n",
    );
  });

  it("whoami prints not logged in when there is no token", async () => {
    const m = machine(null);
    const r = await run(m, ["whoami", "--json"], { token: false });
    expect(JSON.parse(r.stdout)).toEqual({ loggedIn: false });
  });

  it("whoami prints the subject and URL", async () => {
    const m = machine();
    const r = await run(m, ["whoami"]);
    expect(r.stdout).toBe(`mock-user at ${NORMALISED()}\n`);
  });
});

/** A registry that answers every request with a 422 that echoes the bearer token back. */
async function echoRegistry(token: string): Promise<string> {
  const server = createHttp((_req, res) => {
    res.writeHead(422, { "content-type": "application/problem+json" });
    res.end(
      JSON.stringify({
        type: "about:blank",
        title: "Invalid",
        status: 422,
        detail: `saw Bearer ${token}`,
        problems: [{ code: "invalid", message: `bad Bearer ${token}` }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hanging.push(server as unknown as Server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("echoing registry", () => {
  it("publish and login never print a token the server echoes", async () => {
    const url = await echoRegistry(TOKEN);
    for (const json of [false, true]) {
      const flag = json ? ["--json"] : [];
      const m = machine(url);
      const publish = await run(m, ["publish", "org/acme", ...flag]);
      expect(publish.code).toBe(1);
      const login = await run(m, ["login", url, "--token-stdin", ...flag], {
        token: false,
        stdin: async () => TOKEN,
      });
      expect(login.code).toBe(1);
      for (const r of [publish, login]) {
        expect(r.stdout).not.toContain(TOKEN);
        expect(r.stderr).not.toContain(TOKEN);
        expect(`${r.stdout}${r.stderr}`).toContain("bad Bearer");
      }
    }
  });
});

describe("pull and publish", () => {
  it("pull prints changes", async () => {
    const author = machine();
    expect((await run(author, ["publish", "org/acme"])).code).toBe(0);

    const m = machine();
    expect((await run(m, ["pull"])).stdout).toBe("org/acme new @1\n");
    expect((await run(m, ["pull"])).stdout).toBe("up to date\n");
    expect((await run(m, ["pull", "--json"])).stdout).toBe(
      `${JSON.stringify({ changes: [] }, null, 2)}\n`,
    );

    edit(author, "org/acme.yaml", "Never paste", "Do not paste");
    expect((await run(author, ["publish", "org/acme"])).stdout).toBe(
      "published org/acme @2\n",
    );
    expect((await run(m, ["pull"])).stdout).toBe("org/acme 1 → 2\n");

    // The registry drops a ref the cache still holds.
    const current = index(m);
    current.layers["team/web"] = {
      version: 1,
      digest: `sha256:${"0".repeat(64)}`,
    } as never;
    writeFileSync(
      join(m.home, "cache/registry/index.json"),
      JSON.stringify(current),
    );
    const json = await run(m, ["pull", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      changes: [{ ref: "team/web", from: 1 }],
    });
  });

  it("publish then resolve uses the published layer", async () => {
    const m = machine();
    expect((await run(m, ["publish", "org/acme"])).stdout).toBe(
      "published org/acme @1\n",
    );
    expect((await run(m, ["publish", "org/acme"])).stdout).toBe(
      "org/acme unchanged @1\n",
    );

    const before = await run(m, ["resolve", "team/web", "--json"]);
    expect(before.code, before.stderr).toBe(0);
    expect(JSON.parse(before.stdout).builtFrom).toEqual({ "org/acme": 1 });
    expect(before.stderr).toBe("");

    edit(m, "org/acme.yaml", "Never paste", "Do not paste");
    const after = await run(m, ["resolve", "team/web", "--json"]);
    expect(after.stdout).toContain("Never paste");
    expect(after.stdout).not.toContain("Do not paste");
    expect(
      after.stderr.split("org/acme: using published @1; local copy differs")
        .length - 1,
    ).toBe(1);

    const local = await run(m, ["resolve", "team/web", "--json", "--local"]);
    expect(local.stderr).toBe("");
    expect(local.stdout).toContain("Do not paste");
    expect(JSON.parse(local.stdout).builtFrom).toEqual({});
  });

  it("--local reaches compile and diff", async () => {
    const m = machine();
    await run(m, ["publish", "org/acme"]);
    edit(m, "org/acme.yaml", "Never paste", "Do not paste");
    for (const argv of [
      ["compile", "team/web", "--dry-run", "--local"],
      ["diff", "team/web", "org/acme", "--local"],
    ]) {
      const r = await run(m, argv);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).not.toContain("local copy differs");
    }
    const mounted = await run(m, ["diff", "team/web", "org/acme"]);
    expect(mounted.stderr).toContain("local copy differs");
  });

  it("publish problems print with codes and hints", async () => {
    const a = machine();
    const b = machine();
    await run(a, ["publish", "org/acme"]);
    edit(a, "org/acme.yaml", "Never paste", "Do not paste");
    await run(a, ["publish", "org/acme"]);

    // b has never pulled: its base is 0, the registry is at 2.
    edit(b, "org/acme.yaml", "Never paste", "Paste freely");
    const stale = await run(b, ["publish", "org/acme"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("stale-base:");
    expect(stale.stderr).toContain("zzpersona pull, then publish again");

    expect((await run(a, ["publish", "team/web"])).code).toBe(0);
    // org/acme now locks permissions.allow, which team/web sets: web would break.
    edit(a, "org/acme.yaml", "  - permissions.deny", "  - permissions.allow");
    const breaks = await run(a, ["publish", "org/acme", "--json"]);
    expect(breaks.code).toBe(1);
    const error = JSON.parse(breaks.stdout).error;
    expect(error.code).toBe("breaks-descendants");
    expect(error.problems[0].hint).toBe("--force");
    const text = await run(a, ["publish", "org/acme"]);
    expect(text.stderr).toContain("breaks-descendants:");
    expect(text.stderr).toContain("--force");
    expect((await run(a, ["publish", "org/acme", "--force"])).code).toBe(0);
  });

  it("publish --dry-run prints the diff and the cache is unchanged", async () => {
    const m = machine();
    await run(m, ["publish", "org/acme"]);
    const before = readFileSync(
      join(m.home, "cache/registry/index.json"),
      "utf8",
    );
    edit(m, "org/acme.yaml", "Never paste", "Do not paste");
    const r = await run(m, ["publish", "org/acme", "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("dry run");
    expect(r.stdout).toContain("~ ");
    expect(
      readFileSync(join(m.home, "cache/registry/index.json"), "utf8"),
    ).toBe(before);
    expect(registry.layers().find((l) => l.ref === "org/acme")!.version).toBe(
      1,
    );
  });

  it("publish project/persona is not-publishable", async () => {
    const m = machine();
    const r = await run(m, ["publish", "project/persona"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not-publishable:");
  });

  it("publish without a registry or a token explains how to log in", async () => {
    const none = await run(machine(null), ["publish", "org/acme"]);
    expect(none.stderr).toContain("no registry configured");
    const noToken = await run(machine(), ["publish", "org/acme"], {
      token: false,
    });
    expect(noToken.stderr).toContain("not logged in");
  });
});

describe("freshness", () => {
  /** A machine whose cache holds org/acme @1 pulled at `t0`, with @2 now on the registry. */
  async function staleMachine(t0: number) {
    const author = machine();
    await run(author, ["publish", "org/acme"]);
    const m = machine();
    await run(m, ["pull"], { now: () => t0 });
    edit(author, "org/acme.yaml", "Never paste", "Do not paste");
    await run(author, ["publish", "org/acme"]);
    return m;
  }

  it("freshness pulls a stale cache before claude", async () => {
    const t0 = Date.parse("2026-10-22T10:00:00Z");
    const m = await staleMachine(t0);
    const soon = recorder();
    const fresh = await run(m, ["claude", "team/web"], {
      runPlan: soon.runPlan,
      now: () => t0 + 5 * 60_000,
    });
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(index(m).layers["org/acme"]!.version).toBe(1);

    const late = recorder();
    const r = await run(m, ["claude", "team/web"], {
      runPlan: late.runPlan,
      now: () => t0 + 20 * 60_000,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(late.plans).toHaveLength(1);
    expect(index(m).layers["org/acme"]!.version).toBe(2);
    expect(r.stderr).not.toContain("registry");
  });

  it("registry.maxAge sets how old the cache may be", async () => {
    const t0 = Date.parse("2026-10-22T10:00:00Z");
    const m = await staleMachine(t0);
    writeFileSync(
      join(m.home, "config.yaml"),
      `personas: ${m.personas}\nregistry:\n  url: ${registry.url}\n  maxAge: 30\n`,
    );
    await run(m, ["claude", "team/web"], {
      runPlan: recorder().runPlan,
      now: () => t0 + 20 * 60_000,
    });
    expect(index(m).layers["org/acme"]!.version).toBe(1);
    await run(m, ["claude", "team/web"], {
      runPlan: recorder().runPlan,
      now: () => t0 + 31 * 60_000,
    });
    expect(index(m).layers["org/acme"]!.version).toBe(2);
  });

  it("freshness costs at most 1 s against a hanging registry", async () => {
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hanging.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const m = machine(url);
    mkdirSync(join(m.home, "cache/registry"), { recursive: true });
    writeFileSync(
      join(m.home, "cache/registry/index.json"),
      JSON.stringify({
        url: `${url}/`,
        pulledAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        layers: {},
      }),
    );
    const rec = recorder();
    const started = Date.now();
    const r = await run(m, ["claude", "team/web"], { runPlan: rec.runPlan });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.code, r.stderr).toBe(0);
    expect(rec.plans).toHaveLength(1);
    expect(r.stderr).toContain(
      "registry unreachable; using cached layers from 2h ago\n",
    );
  });

  it("freshness without a token", async () => {
    // `switch` runs the same freshness step as claude without claude's own advisory lines,
    // so stderr can be compared exactly.
    const m = machine();
    const r = await run(m, ["switch", "team/web"], { token: false });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe(
      `not logged in to ${NORMALISED()}; using cached layers\n`,
    );
    const rec = recorder();
    const c = await run(machine(), ["claude", "team/web"], {
      runPlan: rec.runPlan,
      token: false,
    });
    expect(c.code, c.stderr).toBe(0);
    expect(rec.plans).toHaveLength(1);
    expect(c.stderr).toContain(
      `not logged in to ${NORMALISED()}; using cached layers\n`,
    );
    // No registry at all: the freshness step says nothing.
    const bare = await run(machine(null), ["switch", "team/web"], {
      token: false,
    });
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stderr).toBe("");
  });

  it("freshness with a refused token says so", async () => {
    const m = machine();
    const r = await run(m, ["switch", "team/web"], { token: WRONG });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe(
      `registry refused the token for ${NORMALISED()}; using cached layers \u2014 zzpersona login ${NORMALISED()}\n`,
    );
  });

  it("--json and --dry-run never pull", async () => {
    const t0 = Date.parse("2026-10-22T10:00:00Z");
    const m = await staleMachine(t0);
    const late = () => t0 + 60 * 60_000;
    for (const argv of [
      ["claude", "team/web", "--json"],
      ["claude", "team/web", "--dry-run"],
      ["codex", "team/web", "--json"],
      ["switch", "team/web", "--json"],
      ["resolve", "team/web", "--json"],
    ]) {
      const r = await run(m, argv, { now: late });
      expect(r.code, `${argv.join(" ")}: ${r.stderr}`).toBe(0);
      expect(index(m).layers["org/acme"]!.version).toBe(1);
    }
    const sw = await run(m, ["switch", "team/web", "--json"], { now: late });
    expect(JSON.parse(sw.stdout).builtFrom).toEqual({ "org/acme": 1 });
  });

  it("switch pulls a stale cache", async () => {
    const t0 = Date.parse("2026-10-22T10:00:00Z");
    const m = await staleMachine(t0);
    const r = await run(m, ["switch", "team/web"], {
      now: () => t0 + 60 * 60_000,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(index(m).layers["org/acme"]!.version).toBe(2);
  });
});

describe("doctor", () => {
  it("doctor reports registry, token and cache age", async () => {
    const m = machine();
    await run(m, ["publish", "org/acme"]);
    await run(m, ["pull"]);
    const r = await run(m, ["doctor", "--json"]);
    const checks = JSON.parse(r.stdout).checks as {
      id: string;
      status: string;
      message: string;
    }[];
    const byId = (id: string) => checks.find((c) => c.id === id)!;
    expect(byId("registry").status).toBe("ok");
    expect(byId("registry-token")).toMatchObject({ status: "ok" });
    expect(byId("registry-token").message).toContain("mock-user");
    expect(byId("registry-cache").status).toBe("ok");
    expect(byId("registry-cache").message).toContain("1 layers");

    const refused = await run(m, ["doctor", "--json"], { token: WRONG });
    const bad = (
      JSON.parse(refused.stdout).checks as { id: string; status: string }[]
    ).find((c) => c.id === "registry-token")!;
    expect(bad.status).toBe("error");

    const bare = await run(machine(null), ["doctor", "--json"]);
    expect(bare.stdout).not.toContain('"id": "registry');
  });
});

describe("secrets", () => {
  it("the token never reaches output", () => {
    expect(output.length).toBeGreaterThan(20);
    for (const text of output) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(WRONG);
    }
  });
});
