import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import { startMockRegistry } from "@zzpersona/registry-api/mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCli, type CliIo } from "./cli.js";
import { clean, openerCommand } from "./commands/registry.js";
import { installedProbe, NO_MANAGED_ROOT, safeManaged } from "./test/seed.js";

const EXAMPLES = join(import.meta.dirname, "../../../../examples/personas");
const noKeychain: Probe = { ...installedProbe, platform: "win32" };
const DAY = 24 * 60 * 60 * 1000;

let registry: Awaited<ReturnType<typeof startMockRegistry>>;
let roots: string[] = [];
let opens: string[] = [];
/** What the running command has printed so far. */
let live = { stdout: "", stderr: "" };
/** Everything every command printed, for the leak scan. */
const outputs: string[] = [];

const openBrowser = async (url: string) => {
  opens.push(url);
};

beforeEach(async () => {
  opens = [];
  registry = await startMockRegistry();
});
afterEach(async () => {
  await registry.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface Machine {
  home: string;
  cwd: string;
}

function machine(withRegistry = false): Machine {
  const root = mkdtempSync(join(tmpdir(), "zzp-login-"));
  roots.push(root);
  const home = join(root, "home");
  const personas = join(root, "personas");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  cpSync(EXAMPLES, personas, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `personas: ${personas}\n${withRegistry ? `registry:\n  url: ${registry.url}\n` : ""}`,
  );
  return { home, cwd };
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  m: Machine,
  argv: string[],
  io: Partial<CliIo> = {},
): Promise<Out> {
  live = { stdout: "", stderr: "" };
  const { env, ...rest } = io;
  const cli = createCli({
    env: { ZZPERSONA_NO_DAEMON: "1", ZZPERSONA_HOME: m.home, ...env },
    cwd: m.cwd,
    stdout: { write: (s: string) => (live.stdout += s) },
    stderr: { write: (s: string) => (live.stderr += s) },
    probe: installedProbe,
    secretProbe: noKeychain,
    managed: safeManaged(),
    ...rest,
  });
  const code = await cli.run(argv);
  outputs.push(live.stdout, live.stderr);
  return { code, ...live };
}

/** The verify URL the running login printed. */
const shownUrl = () =>
  /Open (\S+) and confirm the code/.exec(live.stderr)?.[1] ?? "";

/** A sleep that finishes the login as alice on its first call. */
const finishOnFirstSleep =
  (seen: number[] = [], groups?: string[]) =>
  async (ms: number) => {
    seen.push(ms);
    if (seen.length === 1) {
      registry.completeLogin(shownUrl(), {
        email: "alice@corp.com",
        ...(groups && { groups }),
      });
    }
  };

const tokenFile = (m: Machine) => join(m.home, "registry-token");
const configText = (m: Machine) =>
  readFileSync(join(m.home, "config.yaml"), "utf8");

describe("login through the browser", () => {
  it("signs in through the browser", async () => {
    const m = machine();
    const inputs: string[] = [];
    const r = await run(m, ["login", registry.url], {
      openBrowser,
      sleep: finishOnFirstSleep(),
      secretProbe: { ...installedProbe, platform: "darwin" },
      runInput: async (_c, _a, input) => {
        inputs.push(input ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(r.code, r.stderr).toBe(0);
    const match = /Open (\S+) and confirm the code (\S+)/.exec(r.stderr)!;
    expect(match).not.toBeNull();
    // Shown as XXXX-XXXX, as the confirm page shows it (spec 20 §1).
    expect(match[2]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(match[2]!.replace("-", "")).toBe(
      match[1]!.split("/").pop()!.replace("-", ""),
    );
    expect(opens).toEqual([match[1]]);
    expect(match[1]).toMatch(new RegExp(`^${registry.url}/login/`));
    expect(r.stdout).toMatch(
      new RegExp(
        `^logged in to ${registry.url}/ as alice@corp.com \\(session until \\d{4}-\\d\\d-\\d\\d\\)\\n$`,
      ),
    );
    expect(inputs.some((i) => i.includes("zzp_"))).toBe(true);
    expect(configText(m)).toContain(`${registry.url}/`);
  });

  it("backs off on slow-down", async () => {
    await registry.stop();
    registry = await startMockRegistry({ loginInterval: 1 });
    const m = machine();
    const seen: number[] = [];
    const r = await run(m, ["login", registry.url, "--no-browser"], {
      sleep: async (ms) => {
        seen.push(ms);
        // Polls 1 and 2 come at once (the second is too soon: slow-down); the third waits it out.
        if (seen.length === 2) {
          registry.completeLogin(shownUrl(), { email: "alice@corp.com" });
        }
        if (seen.length === 3) await new Promise((r) => setTimeout(r, 1100));
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toEqual([1000, 1000, 6000]);
  });

  it("an expired or refused login stores nothing", async () => {
    const m = machine();
    const refused = await run(m, ["login", registry.url, "--no-browser"], {
      sleep: async () =>
        registry.refuseLogin(shownUrl(), "alice is not in the payments group"),
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("alice is not in the payments group");

    const expired = await run(m, ["login", registry.url, "--no-browser"], {
      sleep: async () => {},
      now: (() => {
        let t = Date.now();
        return () => (t += 400_000);
      })(),
    });
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain(
      `login timed out; run zzpersona login ${registry.url}/ again`,
    );
    expect(existsSync(tokenFile(m))).toBe(false);
    expect(configText(m)).not.toContain("registry:");

    await registry.stop();
    registry = await startMockRegistry({ loginExpiresIn: 1 });
    const gone = await run(
      m,
      ["login", registry.url, "--no-browser", "--json"],
      {
        sleep: () => new Promise((r) => setTimeout(r, 1200)),
      },
    );
    expect(gone.code).toBe(1);
    expect(JSON.parse(gone.stdout).error.code).toBe("login-expired");
    expect(existsSync(tokenFile(m))).toBe(false);
    expect(configText(m)).not.toContain("registry:");
  });

  it("Ctrl-C stops with 130 and stores nothing", async () => {
    const m = machine();
    const controller = new AbortController();
    const r = await run(m, ["login", registry.url, "--no-browser"], {
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(r.code).toBe(130);
    expect(existsSync(tokenFile(m))).toBe(false);
    expect(configText(m)).not.toContain("registry:");
  });

  it("the browser is optional", async () => {
    const flag = await run(machine(), ["login", registry.url, "--no-browser"], {
      openBrowser,
      sleep: finishOnFirstSleep(),
    });
    expect(flag.code, flag.stderr).toBe(0);
    expect(flag.stderr).toContain("and confirm the code");

    const ci = await run(machine(), ["login", registry.url], {
      openBrowser,
      env: { CI: "true" },
      sleep: finishOnFirstSleep(),
    });
    expect(ci.code, ci.stderr).toBe(0);
    expect(ci.stderr).toContain("and confirm the code");
    expect(opens).toEqual([]);

    const failing = await run(machine(), ["login", registry.url], {
      openBrowser: async () => {
        throw new Error("no display");
      },
      sleep: finishOnFirstSleep(),
    });
    expect(failing.code, failing.stderr).toBe(0);
    expect(failing.stderr).toContain("and confirm the code");
    expect(failing.stdout).toContain("logged in to");
  });

  it("login never prints the token or poll secret", async () => {
    const stored: string[] = [];
    const io = {
      secretProbe: { ...installedProbe, platform: "darwin" as const },
      runInput: async (_c: string, _a: string[], input?: string) => {
        if (input) stored.push(input);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      sleep: finishOnFirstSleep(),
    };
    const text = await run(
      machine(),
      ["login", registry.url, "--no-browser"],
      io,
    );
    const json = await run(
      machine(),
      ["login", registry.url, "--no-browser", "--json"],
      { ...io, sleep: finishOnFirstSleep() },
    );
    const token = /zzp_[0-9a-f]+/.exec(stored.join(" "))![0];
    for (const r of [text, json]) {
      expect(r.stdout + r.stderr).not.toContain(token);
      expect(r.stdout + r.stderr).not.toMatch(/zzp_/);
    }
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["expiresAt", "subject", "url"]);
    expect(parsed.subject).toBe("alice@corp.com");
    // stderr stays text in JSON mode: the code line only
    expect(json.stderr).toContain("and confirm the code");
  });

  it("a registry without sign-in points to --token-stdin", async () => {
    await registry.stop();
    registry = await startMockRegistry({ signIn: false });
    const m = machine();
    const r = await run(m, ["login", registry.url, "--no-browser"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "this registry has no sign-in; use zzpersona login",
    );
    expect(r.stderr).toContain("--token-stdin");
    expect(configText(m)).not.toContain("registry:");
  });

  it("a registry that answers 401 to everything is read as no sign-in", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader("content-type", "application/problem+json");
      res.end(
        JSON.stringify({
          type: "urn:zzpersona:problem:unauthorized",
          title: "Unauthorized",
          status: 401,
          detail: "missing or refused token",
          problems: [
            { code: "unauthorized", message: "missing or refused token" },
          ],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const m = machine();
    const r = await run(m, ["login", url, "--no-browser"]);
    server.close();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "this registry has no sign-in; use zzpersona login",
    );
    expect(r.stderr).toContain("--token-stdin");
    expect(configText(m)).not.toContain("registry:");
  });

  it("--token prompts for a pasted token as before", async () => {
    const m = machine();
    const prompts: string[] = [];
    const r = await run(m, ["login", registry.url, "--token"], {
      readSecret: async (p) => {
        prompts.push(p);
        return `${registry.token}\n`;
      },
    });
    expect(r.code, r.stderr).toBe(0);
    expect(prompts).toEqual(["Registry token: "]);
    expect(r.stdout).toBe(`logged in to ${registry.url}/ as mock-user\n`);
    const piped = await run(
      machine(),
      ["login", registry.url, "--token-stdin"],
      {
        stdin: async () => registry.token,
      },
    );
    expect(piped.code, piped.stderr).toBe(0);
  });
});

/** Sign in as alice and return her machine. */
async function aliceMachine(): Promise<Machine> {
  const m = machine();
  const r = await run(m, ["login", registry.url, "--no-browser"], {
    sleep: finishOnFirstSleep(),
  });
  expect(r.code, r.stderr).toBe(0);
  return m;
}

describe("a signed-in session", () => {
  it("whoami shows the session and roles", async () => {
    registry.grant("user:alice@corp.com", "publish", "team/payments");
    registry.grant("user:alice@corp.com", "lock", "org");
    const m = await aliceMachine();
    const r = await run(m, ["whoami"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`alice@corp.com at ${registry.url}/`);
    expect(lines[1]).toMatch(/^session until \d{4}-\d\d-\d\d$/);
    expect(lines[2]).toBe("roles: publish team/payments, lock org");

    const json = await run(m, ["whoami", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      loggedIn: true,
      subject: "alice@corp.com",
      kind: "session",
      roles: [
        { role: "publish", path: "team/payments" },
        { role: "lock", path: "org" },
      ],
    });
  });

  it("whoami says roles: none when there are none", async () => {
    const m = await aliceMachine();
    const r = await run(m, ["whoami"]);
    expect(r.stdout).toContain("roles: none");
  });

  it("whoami of a service token prints no session line", async () => {
    const m = machine(true);
    const r = await run(m, ["whoami"], {
      env: { ZZPERSONA_REGISTRY_TOKEN: registry.token },
    });
    expect(r.stdout).not.toContain("session until");
  });

  it("publish forbidden hints the grant", async () => {
    const m = await aliceMachine();
    const r = await run(m, ["publish", "org/acme"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("forbidden:");
    expect(r.stderr).toContain(
      "hint: ask a registry admin for publish on org/acme",
    );
  });

  it("doctor warns when the session ends within 2 days", async () => {
    const m = await aliceMachine();
    const checkOf = async (now: number) => {
      const r = await run(m, ["doctor", "--json"], { now: () => now });
      return (
        JSON.parse(r.stdout).checks as {
          id: string;
          status: string;
          message: string;
          fix?: string;
        }[]
      ).find((c) => c.id === "registry-token")!;
    };
    const soon = await checkOf(Date.now() + 29 * DAY);
    expect(soon.status).toBe("warn");
    expect(soon.message).toMatch(/^session ends \d{4}-\d\d-\d\d/);
    expect(`${soon.message} ${soon.fix}`).toContain(
      `zzpersona login ${registry.url}/`,
    );
    const later = await checkOf(Date.now() + 10 * DAY);
    expect(later.message).toContain("accepted as alice@corp.com");
  });
});

/** A registry whose sign-in start answers with `verifyUrl`, whatever it is. */
async function lyingRegistry(linkFor: string | ((origin: string) => string)) {
  let origin = "";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/auth/logins") {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          loginId: "l1",
          verifyUrl: typeof linkFor === "string" ? linkFor : linkFor(origin),
          code: "ABCD2345",
          pollSecret: "secret-1",
          interval: 1,
          expiresIn: 600,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  origin = url;
  return { url, stop: () => server.close() };
}

describe("the sign-in link", () => {
  it("refuses a sign-in link for another site", async () => {
    for (const link of [
      "https://evil.example.com/login/ABCD2345",
      "file:///etc/passwd",
      "-oProxyCommand=x",
      'blob:HTTPSORIGIN/x" &calc',
    ]) {
      const fake = await lyingRegistry((o) => link.replace("HTTPSORIGIN", o));
      const m = machine();
      const r = await run(m, ["login", fake.url], {
        openBrowser,
        sleep: async () => {
          throw new Error("must not poll");
        },
      });
      fake.stop();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        "registry-protocol: the registry sent a sign-in link for another site",
      );
      expect(r.stderr).not.toContain("confirm the code");
      expect(r.stdout + r.stderr).not.toContain("secret-1");
      expect(opens).toEqual([]);
      expect(existsSync(tokenFile(m))).toBe(false);
      expect(configText(m)).not.toContain("registry:");
    }
  });

  it("opens only the parsed link", async () => {
    const fake = await lyingRegistry((o) => `${o}/login/a b&calc`);
    const r = await run(machine(), ["login", fake.url], {
      openBrowser,
      sleep: async () => {
        throw new Error("stop");
      },
    }).catch((e: unknown) => e);
    fake.stop();
    void r;
    expect(opens).toEqual([`${fake.url}/login/a%20b&calc`]);
  });

  it("clean strips bidi controls", () => {
    expect(clean("ann\u202Eevil\u2066x\u2069\u202A")).toBe("annevilx");
  });

  it("the Windows opener uses rundll32", () => {
    const href = "https://reg.example.com/login/ABCD2345";
    expect(openerCommand("win32", href)).toEqual([
      "rundll32",
      ["url.dll,FileProtocolHandler", href],
    ]);
    expect(openerCommand("darwin", href)).toEqual(["open", [href]]);
    expect(openerCommand("linux", href)).toEqual(["xdg-open", [href]]);
  });

  it("sleeps at least one second, and sleeps no longer than what is left", async () => {
    const seen: number[] = [];
    const first = await run(
      machine(),
      ["login", registry.url, "--no-browser"],
      {
        sleep: async (ms) => {
          seen.push(ms);
          if (seen.length === 1) {
            registry.completeLogin(shownUrl(), { email: "alice@corp.com" });
          }
        },
      },
    );
    expect(first.code, first.stderr).toBe(0);
    expect(seen[0]).toBe(1000);

    await registry.stop();
    registry = await startMockRegistry({ loginExpiresIn: 3 });
    const left: number[] = [];
    let t = 1_000_000;
    await run(machine(), ["login", registry.url, "--no-browser"], {
      now: () => t,
      sleep: async (ms) => {
        left.push(ms);
        t += 2500;
      },
    });
    // 3 s total: 1 s, then 1 s, then only the last 1 s... never beyond expiry.
    expect(left.every((ms) => ms <= 3000)).toBe(true);
    expect(left[1]).toBe(500);
  });

  it("a refused login shows only the server's reason", async () => {
    const r = await run(machine(), ["login", registry.url, "--no-browser"], {
      sleep: async () => registry.refuseLogin(shownUrl(), "not in the group"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not in the group");
    expect(r.stderr).not.toContain("ask a registry admin");
  });

  it("server text is printed without control characters", async () => {
    await registry.stop();
    registry = await startMockRegistry({ subject: "mallory\u001b[2J\u0007" });
    const m = machine(true);
    const r = await run(m, ["whoami"], {
      env: { ZZPERSONA_REGISTRY_TOKEN: registry.token },
    });
    expect(r.stdout).toContain("mallory[2J at");
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it("doctor shows the session end when it is far off", async () => {
    const m = await aliceMachine();
    const r = await run(m, ["doctor", "--json"]);
    const check = (
      JSON.parse(r.stdout).checks as { id: string; message: string }[]
    ).find((c) => c.id === "registry-token")!;
    expect(check.message).toMatch(/session until \d{4}-\d\d-\d\d/);
    // Never the real policy folder, profile or ~/.claude: the test seam's root.
    const managed = (
      JSON.parse(r.stdout).checks as { id: string; message: string }[]
    ).find((c) => c.id === "managed")!;
    expect(managed.message).toContain(NO_MANAGED_ROOT);
  });
});

/** A registry whose publish answers `status` with `body`, whatever was sent. */
async function publishRegistry(status: number, body: unknown) {
  const server = createServer((req, res) => {
    req.resume();
    res.statusCode = status;
    res.setHeader(
      "content-type",
      status === 200 ? "application/json" : "application/problem+json",
    );
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const m = machine();
  writeFileSync(
    join(m.home, "config.yaml"),
    `${readFileSync(join(m.home, "config.yaml"), "utf8")}registry:\n  url: ${url}\n`,
  );
  return { m, stop: () => server.close() };
}

describe("server text in publish output", () => {
  it("the forbidden hint has no escape sequences", async () => {
    const fake = await publishRegistry(403, {
      type: "about:blank",
      title: "forbidden",
      status: 403,
      detail: "no",
      problems: [
        {
          code: "forbidden",
          ref: "team/x\u001b[2J",
          message: "bob may not publish: needs pub\u001b[2Jlish on team/x",
        },
      ],
    });
    const r = await run(fake.m, ["publish", "org/acme"], {
      env: { ZZPERSONA_REGISTRY_TOKEN: "tok-9f3a" },
    });
    fake.stop();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("hint: ask a registry admin for pub[2Jlish on");
    expect(r.stderr).not.toContain("\u001b");
  });

  it("a dry-run diff path has no escape sequences", async () => {
    const fake = await publishRegistry(200, {
      dryRun: true,
      diff: [{ path: "instructions\u001b[2J", change: "added" }],
      broken: [],
    });
    const r = await run(fake.m, ["publish", "org/acme", "--dry-run"], {
      env: { ZZPERSONA_REGISTRY_TOKEN: "tok-9f3a" },
    });
    fake.stop();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("+ instructions[2J");
    expect(r.stdout).not.toContain("\u001b");
  });
});
