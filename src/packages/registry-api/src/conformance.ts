import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES, bundleDigest } from "./bundle.js";
import { ROUTES, routePath } from "./routes.js";
import {
  ConformanceSchemas,
  type BundleFile,
  type ProblemCode,
  type PublishRequest,
} from "./schemas.js";

/** What `start` may be asked for; a real server may ignore it and skip the cases that need it. */
export interface StartOptions {
  /** Minimum seconds between login polls. */
  loginInterval?: number;
  /** Seconds a login lasts. */
  loginExpiresIn?: number;
}

export interface RegistryUnderTest {
  url: string;
  token: string;
  stop(): Promise<void>;
  /** false: the registry has no identity provider (sign-in routes answer 404). */
  signIn?: boolean;
  /** A valid token with no grants. Without it the role cases are skipped. */
  limitedToken?: string;
  /**
   * Finish the login at `verifyUrl` as `identity`, as the person would in the browser. Without it
   * the sign-in cases are skipped.
   */
  completeLogin?(
    verifyUrl: string,
    identity: { email: string; groups?: string[] },
  ): Promise<void>;
  /** Refuse the login at `verifyUrl`; without it the refused-login case is skipped. */
  refuseLogin?(verifyUrl: string, reason: string): Promise<void>;
  /** true: `start` honours `loginInterval` and `loginExpiresIn`; else those cases are skipped. */
  supportsLoginTiming?: boolean;
}

type RouteName = keyof typeof ROUTES;

/** The strict schema the kit holds each route's success answer to. */
const STRICT_RESPONSES = {
  whoami: ConformanceSchemas.Whoami,
  listLayers: z.array(ConformanceSchemas.LayerSummary),
  getVersion: ConformanceSchemas.LayerVersion,
  publish: ConformanceSchemas.PublishResult,
  startLogin: ConformanceSchemas.LoginStart,
  pollLogin: ConformanceSchemas.LoginToken,
} as const satisfies Record<RouteName, z.ZodType>;

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const file = (path: string, text: string): BundleFile => ({
  path,
  content: Buffer.from(text).toString("base64"),
});

/** A layer's YAML; `extra` is appended as top-level keys. */
const layer = (name: string, extra = ""): string =>
  `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: ${name}\n${extra}`;

/**
 * The registry contract as a vitest suite: every route, every problem code and every publish
 * rule from docs/planning/18-registry-contract.md. Each case starts a fresh registry and checks
 * every response against the contract's schemas. The mock runs it here; the real server runs it
 * against itself.
 */
export function registryConformance(
  start: (options?: StartOptions) => Promise<RegistryUnderTest>,
): void {
  describe("registry conformance", () => {
    let registry: RegistryUnderTest;
    beforeEach(async () => {
      registry = await start();
    });
    afterEach(async () => {
      await registry.stop();
    });

    /** Replace the registry under test with one started with `options`. */
    async function restart(options: StartOptions): Promise<void> {
      await registry.stop();
      registry = await start(options);
    }

    /** Call a route; the response must parse as its schema (success) or as a Problem. */
    async function call(
      name: RouteName,
      params: Record<string, string> = {},
      body?: unknown,
      token: string | null = registry.token,
    ): Promise<Answer> {
      const route = ROUTES[name];
      const response = await fetch(
        registry.url + routePath(route.path, params),
        {
          method: route.method,
          headers: {
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const parsed: unknown = await response.json();
      if ((route.statuses as readonly number[]).includes(response.status)) {
        expect(STRICT_RESPONSES[name].safeParse(parsed).error).toBeUndefined();
      } else {
        expect(response.headers.get("content-type")).toContain(
          "application/problem+json",
        );
        const problem = ConformanceSchemas.Problem.safeParse(parsed);
        expect(problem.error).toBeUndefined();
        expect(problem.data?.status).toBe(response.status);
      }
      if (name === "getVersion" && response.status === 200) {
        // Every version a registry serves must hash to the digest it names.
        const version = parsed as {
          source: string;
          files: BundleFile[];
          digest: string;
        };
        expect(bundleDigest(version.source, version.files)).toBe(
          version.digest,
        );
      }
      return { status: response.status, body: parsed };
    }

    /** A raw request; the answer must be a Problem. */
    async function raw(
      method: string,
      path: string,
      body?: string,
    ): Promise<Answer> {
      const response = await fetch(registry.url + path, {
        method,
        headers: {
          authorization: `Bearer ${registry.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      });
      const parsed: unknown = await response.json();
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(
        ConformanceSchemas.Problem.safeParse(parsed).error,
      ).toBeUndefined();
      return { status: response.status, body: parsed };
    }

    const publish = (
      ref: string,
      source: string,
      files: BundleFile[] = [],
      baseVersion = 0,
      extra: Partial<PublishRequest> = {},
    ) => call("publish", { ref }, { source, files, baseVersion, ...extra });

    const expectProblem = (
      answer: Answer,
      status: number,
      code: ProblemCode,
    ) => {
      expect(answer.status).toBe(status);
      expect(
        (answer.body.problems ?? []).map((p: { code: string }) => p.code),
      ).toContain(code);
    };

    describe("auth and reads", () => {
      it("answers 401 unauthorized without a token or with a wrong one, on every route", async () => {
        const params = { ref: "org/base", version: "1" };
        const body = { source: layer("base"), files: [], baseVersion: 0 };
        for (const name of Object.keys(ROUTES) as RouteName[]) {
          if ("auth" in ROUTES[name]) continue; // the sign-in routes take no token
          const request = name === "publish" ? body : undefined;
          expectProblem(
            await call(name, params, request, null),
            401,
            "unauthorized",
          );
          expectProblem(
            await call(name, params, request, "wrong-token"),
            401,
            "unauthorized",
          );
        }
      });

      it("whoami names the caller", async () => {
        const answer = await call("whoami");
        expect(answer.status).toBe(200);
        expect(answer.body.subject).toEqual(expect.any(String));
        expect(answer.body.org).toEqual(expect.any(String));
      });

      it("listLayers is empty, then lists a published layer", async () => {
        expect((await call("listLayers")).body).toEqual([]);
        const published = await publish("org/base", layer("base"));
        expect((await call("listLayers")).body).toEqual([
          { ref: "org/base", version: 1, digest: published.body.digest },
        ]);
      });

      it("getVersion answers by number and by latest", async () => {
        const source = layer("base");
        const files = [file("instructions/a.md", "hello")];
        await publish("org/base", source, files);
        const one = await call("getVersion", { ref: "org/base", version: "1" });
        const latest = await call("getVersion", {
          ref: "org/base",
          version: "latest",
        });
        expect(one.status).toBe(200);
        expect(one.body).toMatchObject({
          ref: "org/base",
          version: 1,
          source,
          files,
        });
        expect(latest.body).toEqual(one.body);
      });

      it("lists and gets a nested ref by its URL-encoded path", async () => {
        const published = await publish("team/a/b", layer("b"), [
          file("instructions/a.md", "nested"),
        ]);
        expect(published.status).toBe(201);
        expect((await call("listLayers")).body).toEqual([
          { ref: "team/a/b", version: 1, digest: published.body.digest },
        ]);
        const got = await call("getVersion", {
          ref: "team/a/b",
          version: "latest",
        });
        expect(got.status).toBe(200);
        expect(got.body).toMatchObject({ ref: "team/a/b", version: 1 });
      });

      it("answers 404 not-found for an unknown ref or version", async () => {
        await publish("org/base", layer("base"));
        expectProblem(
          await call("getVersion", { ref: "org/nope", version: "1" }),
          404,
          "not-found",
        );
        expectProblem(
          await call("getVersion", { ref: "org/nope", version: "latest" }),
          404,
          "not-found",
        );
        expectProblem(
          await call("getVersion", { ref: "org/base", version: "9" }),
          404,
          "not-found",
        );
      });
    });

    describe("publish results", () => {
      it("publishes a new ref as version 1 with 201", async () => {
        const answer = await publish("org/base", layer("base"));
        expect(answer.status).toBe(201);
        expect(answer.body).toMatchObject({ version: 1, broken: [] });
      });

      it("answers 200 unchanged for the same bundle", async () => {
        const first = await publish("org/base", layer("base"));
        const again = await publish("org/base", layer("base"), [], 1);
        expect(again.status).toBe(200);
        expect(again.body).toEqual({
          unchanged: true,
          version: 1,
          digest: first.body.digest,
        });
        expect((await call("listLayers")).body).toHaveLength(1);
      });

      it("publishes a changed bundle as the next version", async () => {
        await publish("org/base", layer("base"));
        const next = await publish(
          "org/base",
          layer("base", "extends: []\n"),
          [],
          1,
        );
        expect(next.status).toBe(201);
        expect(next.body.version).toBe(2);
      });

      it("answers 409 stale-base when baseVersion is not the latest", async () => {
        await publish("org/base", layer("base"));
        await publish("org/base", layer("base", "extends: []\n"), [], 1);
        expectProblem(
          await publish("org/base", layer("base", "extends: []\n# x\n"), [], 1),
          409,
          "stale-base",
        );
      });

      it("answers 409 stale-base for a new ref with a non-zero baseVersion", async () => {
        expectProblem(
          await publish("org/base", layer("base"), [], 3),
          409,
          "stale-base",
        );
      });
    });

    describe("bundle problems", () => {
      it("refuses bad YAML and a schema failure as invalid", async () => {
        expectProblem(
          await publish("org/base", "kind: [unclosed\n"),
          422,
          "invalid",
        );
        expectProblem(
          await publish("org/base", layer("base", "bogus: true\n")),
          422,
          "invalid",
        );
      });

      it("refuses project and user refs as not-publishable", async () => {
        for (const ref of ["project/x", "user/x"]) {
          expectProblem(await publish(ref, layer("x")), 422, "not-publishable");
        }
      });

      it("refuses a referenced file that is not in the bundle as missing-file", async () => {
        const source = layer(
          "base",
          "instructions:\n  - id: conduct\n    file: ./instructions/conduct.md\n",
        );
        const answer = await publish("org/base", source);
        expectProblem(answer, 422, "missing-file");
        expect(answer.body.problems[0].path).toBe("instructions/conduct.md");
        expectProblem(
          await publish(
            "org/base",
            layer("base", "skills:\n  include:\n    - ./skills/x\n"),
          ),
          422,
          "missing-file",
        );
        expect(
          (
            await publish(
              "org/base",
              layer("base", "skills:\n  include:\n    - ./skills/x\n"),
              [file("skills/x/SKILL.md", "skill")],
            )
          ).status,
        ).toBe(201);
      });

      it("refuses file paths that leave the layer's folder as path-escapes-layer", async () => {
        for (const path of [
          "../outside.md",
          "a/../../outside.md",
          "/etc/passwd",
        ]) {
          expectProblem(
            await publish("org/base", layer("base"), [file(path, "x")]),
            422,
            "path-escapes-layer",
          );
        }
      });

      it("refuses a bundle over MAX_BUNDLE_BYTES as bundle-too-large", async () => {
        const big = {
          path: "big.bin",
          content: Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString("base64"),
        };
        expectProblem(
          await publish("org/base", layer("base"), [big]),
          422,
          "bundle-too-large",
        );
      });
    });

    describe("resolution problems", () => {
      it("refuses a layer whose parent is not published as unpublished-ancestor", async () => {
        const answer = await publish(
          "team/web",
          layer("web", "extends:\n  - org/base\n"),
        );
        expectProblem(answer, 422, "unpublished-ancestor");
        expect(answer.body.problems[0].ref).toBe("org/base");
      });

      it("refuses a change to a locked path as lock-violation naming the layer and path", async () => {
        await publish(
          "org/base",
          layer(
            "base",
            "locks:\n  - permissions.deny\npermissions:\n  deny:\n    - Bash(rm:*)\n",
          ),
        );
        const answer = await publish(
          "team/web",
          layer(
            "web",
            "extends:\n  - org/base\npermissions:\n  remove:\n    deny:\n      - Bash(rm:*)\n",
          ),
        );
        expectProblem(answer, 422, "lock-violation");
        // The wording is the server's own; the fields are the contract.
        expect(answer.body.problems[0].ref).toBe("team/web");
        expect(answer.body.problems[0].path).toMatch(/^permissions\.deny/);
      });
    });

    describe("check order", () => {
      it("answers 409 stale-base before ancestor and lock checks", async () => {
        await publish("org/base", layer("base"));
        expectProblem(
          await publish(
            "team/web",
            layer("web", "extends:\n  - org/missing\n"),
            [],
            4,
          ),
          409,
          "stale-base",
        );
        await publish(
          "org/locked",
          layer(
            "locked",
            "locks:\n  - permissions.deny\npermissions:\n  deny:\n    - Bash(rm:*)\n",
          ),
        );
        expectProblem(
          await publish(
            "team/web",
            layer(
              "web",
              "extends:\n  - org/locked\npermissions:\n  remove:\n    deny:\n      - Bash(rm:*)\n",
            ),
            [],
            4,
          ),
          409,
          "stale-base",
        );
      });

      it("answers 409 for an identical re-publish with a stale base, 200 with the current one", async () => {
        await publish("org/base", layer("base"));
        expectProblem(
          await publish("org/base", layer("base"), [], 0),
          409,
          "stale-base",
        );
        expect((await publish("org/base", layer("base"), [], 1)).status).toBe(
          200,
        );
      });

      it("refuses a hook script without ./ that is not in the bundle", async () => {
        const source = layer(
          "base",
          "hooks:\n  stop:\n    - id: h\n      run: hooks/h.sh\n",
        );
        const answer = await publish("org/base", source);
        expectProblem(answer, 422, "missing-file");
        expect(answer.body.problems[0].path).toBe("hooks/h.sh");
      });

      it("refuses a file path with a control character as invalid", async () => {
        expectProblem(
          await publish("org/base", layer("base"), [file("a\nb.md", "x")]),
          422,
          "invalid",
        );
      });
    });

    describe("descendants and dry runs", () => {
      const web = layer(
        "web",
        "extends:\n  - org/base\nmcp:\n  gateway: https://gateway.example/mcp\n",
      );
      const lockedBase = layer("base", "locks:\n  - mcp.gateway\n");

      it("refuses a parent change that breaks a published child unless forced", async () => {
        await publish("org/base", layer("base"));
        await publish("team/web", web);
        const refused = await publish("org/base", lockedBase, [], 1);
        expectProblem(refused, 422, "breaks-descendants");
        expect(
          refused.body.problems.map((p: { ref: string }) => p.ref),
        ).toContain("team/web");
        const layers = (await call("listLayers")).body as {
          ref: string;
          version: number;
        }[];
        expect(layers.find((l) => l.ref === "org/base")?.version).toBe(1);

        const forced = await publish("org/base", lockedBase, [], 1, {
          force: true,
        });
        expect(forced.status).toBe(201);
        expect(forced.body).toMatchObject({ version: 2, broken: ["team/web"] });
      });

      it("does not count a child that was already broken", async () => {
        await publish("org/base", layer("base"));
        await publish("team/web", web);
        await publish("org/base", lockedBase, [], 1, { force: true });
        const again = await publish(
          "org/base",
          layer(
            "base",
            "locks:\n  - mcp.gateway\ninstructions:\n  - id: a\n    inline: hi\n",
          ),
          [],
          2,
        );
        expect(again.status).toBe(201);
        expect(again.body.broken).toEqual([]);
      });

      it("stores nothing on dryRun and returns diff and broken", async () => {
        await publish("org/base", layer("base"));
        await publish("team/web", web);
        const before = (await call("listLayers")).body;

        const dry = await publish("org/base", lockedBase, [], 1, {
          dryRun: true,
        });
        expect(dry.status).toBe(200);
        expect(dry.body.dryRun).toBe(true);
        expect(dry.body.broken).toEqual(["team/web"]);
        expect(dry.body.diff).toEqual([
          expect.objectContaining({
            path: "locks[mcp.gateway]",
            change: "added",
          }),
        ]);
        expect((await call("listLayers")).body).toEqual(before);

        const fresh = await publish("org/other", layer("other"), [], 0, {
          dryRun: true,
        });
        expect(fresh.body).toEqual({ dryRun: true, diff: [], broken: [] });
        expect((await call("listLayers")).body).toEqual(before);
      });
    });

    describe("hardening", () => {
      it("refuses non-canonical base64 as invalid, naming the file", async () => {
        for (const content of ["YQ", "Y Q=="]) {
          const answer = await publish("org/base", layer("base"), [
            { path: "a.md", content },
          ]);
          expectProblem(answer, 422, "invalid");
          expect(answer.body.problems[0].path).toBe("a.md");
        }
      });

      it("refuses malformed refs as invalid, never 500", async () => {
        for (const ref of ["org", "Team/x", "team/", "team/x/", "team/../x"]) {
          expectProblem(await publish(ref, layer("x")), 422, "invalid");
        }
        for (const ref of ["project/x", "user/x"]) {
          expectProblem(await publish(ref, layer("x")), 422, "not-publishable");
        }
      });

      it("answers an unknown route with 404 not-found", async () => {
        expectProblem(await raw("GET", "/v1/nope"), 404, "not-found");
      });

      it("refuses a body that is not a JSON object as invalid", async () => {
        const path = routePath(ROUTES.publish.path, { ref: "org/base" });
        for (const body of ["not json", "[]", '"x"']) {
          expectProblem(await raw("POST", path, body), 422, "invalid");
        }
      });

      it("answers a malformed % sequence in the ref with 404 not-found", async () => {
        expectProblem(
          await raw("GET", "/v1/layers/%E0%A4%A/versions/1"),
          404,
          "not-found",
        );
      });

      // A race can show a missing lock, never prove there is none: run several at once.
      it("lets exactly one of five concurrent publishes from one base win", async () => {
        await publish("org/base", layer("base"));
        const answers = await Promise.all(
          ["ls", "pwd", "date", "id", "env"].map((command) =>
            publish(
              "org/base",
              layer("base", `permissions:\n  allow:\n    - Bash(${command})\n`),
              [],
              1,
            ),
          ),
        );
        expect(answers.filter((a) => a.status === 201)).toHaveLength(1);
        for (const answer of answers.filter((a) => a.status !== 201)) {
          expectProblem(answer, 409, "stale-base");
        }
        const listed = (await call("listLayers")).body as { version: number }[];
        expect(listed.map((l) => l.version)).toEqual([2]);
      });
    });

    describe("sign-in", () => {
      const ann = { email: "ann@acme.test", groups: ["leads"] };
      const startLogin = () => call("startLogin", {}, undefined, null);
      const poll = (login: { loginId: string; pollSecret: string }) =>
        call(
          "pollLogin",
          { loginId: login.loginId },
          { pollSecret: login.pollSecret },
          null,
        );

      it("answers 404 not-found on the sign-in routes when the registry has no sign-in", async (ctx) => {
        if (registry.signIn !== false) return ctx.skip();
        expectProblem(await startLogin(), 404, "not-found");
      });

      it("starts a login with an 8-character code and a verify URL", async (ctx) => {
        if (!registry.completeLogin) return ctx.skip();
        const answer = await startLogin();
        expect(answer.status).toBe(201);
        expect(() => new URL(answer.body.verifyUrl)).not.toThrow();
        expect(answer.body.code).toHaveLength(8);
      });

      it("answers 428 authorization-pending until the person finishes", async (ctx) => {
        if (!registry.completeLogin) return ctx.skip();
        const login = (await startLogin()).body;
        expectProblem(await poll(login), 428, "authorization-pending");
      });

      it("answers 429 slow-down when polled inside the interval", async (ctx) => {
        if (!registry.completeLogin || !registry.supportsLoginTiming) {
          return ctx.skip();
        }
        await restart({ loginInterval: 30 });
        const login = (await startLogin()).body;
        expectProblem(await poll(login), 428, "authorization-pending");
        expectProblem(await poll(login), 429, "slow-down");
      });

      it("answers 410 login-expired once the login has expired", async (ctx) => {
        if (!registry.completeLogin || !registry.supportsLoginTiming) {
          return ctx.skip();
        }
        await restart({ loginExpiresIn: 1 });
        const login = (await startLogin()).body;
        await new Promise((done) => setTimeout(done, 1200));
        expectProblem(await poll(login), 410, "login-expired");
      });

      it("answers 404 for an unknown login and for a wrong poll secret", async (ctx) => {
        if (!registry.completeLogin) return ctx.skip();
        const login = (await startLogin()).body;
        expectProblem(
          await poll({ loginId: "nope", pollSecret: login.pollSecret }),
          404,
          "not-found",
        );
        expectProblem(
          await poll({ loginId: login.loginId, pollSecret: "wrong" }),
          404,
          "not-found",
        );
      });

      it("gives a finished login a session token, once", async (ctx) => {
        if (!registry.completeLogin) return ctx.skip();
        const login = (await startLogin()).body;
        await registry.completeLogin(login.verifyUrl, ann);
        const done = await poll(login);
        expect(done.status).toBe(200);
        expect(done.body.subject).toBe(ann.email);
        const me = await call("whoami", {}, undefined, done.body.token);
        expect(me.status).toBe(200);
        expect(me.body.subject).toBe(ann.email);
        expect(me.body.kind).toBe("session");
        expect(me.body.expiresAt).toEqual(expect.any(String));
        expect(
          (await call("listLayers", {}, undefined, done.body.token)).status,
        ).toBe(200);
        expectProblem(await poll(login), 410, "login-expired");
      });

      it("answers 403 forbidden with the reason when the person is refused", async (ctx) => {
        if (!registry.completeLogin || !registry.refuseLogin) return ctx.skip();
        const login = (await startLogin()).body;
        await registry.refuseLogin(login.verifyUrl, "domain not allowed");
        const answer = await poll(login);
        expectProblem(answer, 403, "forbidden");
        expect(answer.body.detail).toContain("domain not allowed");
      });
    });

    describe("roles", () => {
      it("lets a token without grants read and dry-run but not publish", async (ctx) => {
        const limited = registry.limitedToken;
        if (limited === undefined) return ctx.skip();
        const me = await call("whoami", {}, undefined, limited);
        expect(me.status).toBe(200);
        expect(me.body.roles).toEqual([]);
        expect((await call("listLayers", {}, undefined, limited)).status).toBe(
          200,
        );

        const body = { source: layer("base"), files: [], baseVersion: 0 };
        const refused = await call(
          "publish",
          { ref: "org/base" },
          body,
          limited,
        );
        expectProblem(refused, 403, "forbidden");
        expect(refused.body.problems[0].ref).toBe("org/base");
        expect(refused.body.problems[0].message).toContain("org/base");
        expect((await call("listLayers")).body).toEqual([]);

        const dry = await call(
          "publish",
          { ref: "org/base" },
          { ...body, dryRun: true },
          limited,
        );
        expect(dry.status).toBe(200);
        expect(dry.body.dryRun).toBe(true);
      });
    });

    describe("digest", () => {
      it("stores the digest of the canonical manifest", async () => {
        const source = layer("base");
        const files = [file("b.md", "b"), file("a.md", "a")];
        const answer = await publish("org/base", source, files);
        expect(answer.body.digest).toBe(bundleDigest(source, files));
        const stored = await call("getVersion", {
          ref: "org/base",
          version: "1",
        });
        expect(stored.body.digest).toBe(bundleDigest(source, files));
      });
    });
  });
}
