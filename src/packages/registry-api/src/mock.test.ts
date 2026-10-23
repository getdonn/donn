import { createHash } from "node:crypto";
import type { ManagedCompiler } from "@zzpersona/adapter-sdk";
import { describe, expect, it } from "vitest";
import { registryConformance } from "./conformance.js";
import { startMockRegistry } from "./mock.js";

// A stand-in compiler: the bundle holds the chain and one locked instruction file; a layer
// that sets `policy.mcp: exclusive` is refused, to exercise the 422.
const compiler: ManagedCompiler = {
  roots: { macos: "/m", linux: "/l", windows: "C:\\w" },
  inputs: (ir) => ({
    texts: ir.instructions.map((f) => (f as { file: string }).file),
    scripts: [],
  }),
  compile: (input) => {
    if (input.ir.policy.mcp === "exclusive") {
      return {
        report: {
          entries: [
            {
              path: "mcp.servers.x",
              layer: input.layers.at(-1)!.ref,
              outcome: "refused",
              code: "managed-secret",
              reason: "holds a secret reference",
            },
          ],
          warnings: [],
        },
      };
    }
    const files: Record<string, Uint8Array> = {};
    for (const [path, text] of Object.entries(input.texts)) {
      files[`texts/${path.split("/").pop()}`] = new TextEncoder().encode(text);
    }
    const hashes = Object.fromEntries(
      Object.entries(files).map(([p, b]) => [
        p,
        createHash("sha256").update(b).digest("hex"),
      ]),
    );
    const manifest = {
      format: 1 as const,
      zzpersona: input.zzpersona,
      os: input.os,
      layers: input.layers,
      files: hashes,
      report: { entries: [], warnings: [] },
    };
    files["zzpersona/manifest.json"] = new TextEncoder().encode(
      JSON.stringify(manifest),
    );
    return { report: manifest.report, bundle: { files, manifest } };
  },
};

registryConformance(async (options) => {
  const mock = await startMockRegistry({ ...options, managed: compiler });
  return {
    url: mock.url,
    token: mock.token,
    stop: mock.stop,
    managed: compiler,
    limitedToken: mock.limitedToken(),
    completeLogin: (verifyUrl, identity) => {
      mock.completeLogin(verifyUrl, identity);
      return Promise.resolve();
    },
    refuseLogin: (verifyUrl, reason) => {
      mock.refuseLogin(verifyUrl, reason);
      return Promise.resolve();
    },
    supportsLoginTiming: true,
  };
});

describe("a mock without sign-in", () => {
  registryConformance(async () => {
    const mock = await startMockRegistry({ signIn: false });
    return { url: mock.url, token: mock.token, stop: mock.stop, signIn: false };
  });
});

describe("startMockRegistry", () => {
  it("uses the token it is given", async () => {
    const mock = await startMockRegistry({ token: "custom", subject: "ann" });
    try {
      expect(mock.token).toBe("custom");
      const response = await fetch(`${mock.url}/v1/whoami`, {
        headers: { authorization: "Bearer custom" },
      });
      expect(await response.json()).toEqual({
        subject: "ann",
        org: "acme",
        kind: "service",
        roles: [
          { role: "publish", path: "*" },
          { role: "lock", path: "*" },
        ],
      });
    } finally {
      await mock.stop();
    }
  });
});

describe("mock roles", () => {
  const layer = (extra = "") =>
    `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: x\n${extra}`;

  async function session(
    mock: Awaited<ReturnType<typeof startMockRegistry>>,
    email: string,
    groups: string[] = [],
  ): Promise<string> {
    const started = (await (
      await fetch(`${mock.url}/v1/auth/logins`, { method: "POST" })
    ).json()) as { loginId: string; verifyUrl: string; pollSecret: string };
    mock.completeLogin(started.verifyUrl, { email, groups });
    const done = (await (
      await fetch(`${mock.url}/v1/auth/logins/${started.loginId}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollSecret: started.pollSecret }),
      })
    ).json()) as { token: string };
    return done.token;
  }

  async function publish(
    mock: Awaited<ReturnType<typeof startMockRegistry>>,
    token: string,
    ref: string,
    source: string,
    baseVersion = 0,
  ) {
    const response = await fetch(
      `${mock.url}/v1/layers/${encodeURIComponent(ref)}/versions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ source, files: [], baseVersion }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        problems?: { code: string; message: string }[];
      },
    };
  }

  it("grants match by whole segment", async () => {
    const mock = await startMockRegistry();
    try {
      mock.grant("user:ann@acme.test", "publish", "team/pay");
      const token = await session(mock, "ann@acme.test");
      expect((await publish(mock, token, "team/pay", layer())).status).toBe(
        201,
      );
      expect((await publish(mock, token, "team/pay/sub", layer())).status).toBe(
        201,
      );
      const refused = await publish(mock, token, "team/payments", layer());
      expect(refused.status).toBe(403);
      expect(refused.body.problems?.[0]).toMatchObject({
        code: "forbidden",
        ref: "team/payments",
        message:
          "ann@acme.test may not publish team/payments: needs publish on team/payments",
      });
    } finally {
      await mock.stop();
    }
  });

  it("a locks change needs lock", async () => {
    const mock = await startMockRegistry();
    try {
      mock.grant("user:ann@acme.test", "publish", "org");
      const token = await session(mock, "ann@acme.test");
      expect((await publish(mock, token, "org/base", layer())).status).toBe(
        201,
      );
      const locked = layer("locks:\n  - mcp.gateway\n");
      const refused = await publish(mock, token, "org/base", locked, 1);
      expect(refused.status).toBe(403);
      expect(refused.body.problems?.[0]?.message).toBe(
        "ann@acme.test may not publish org/base: needs lock on org/base",
      );
      mock.grant("user:ann@acme.test", "lock", "org/base");
      expect((await publish(mock, token, "org/base", locked, 1)).status).toBe(
        201,
      );
      // The same locks again, in another order, is no change.
      const same = layer("locks:\n  - mcp.gateway\n  - mcp.gateway\n");
      expect((await publish(mock, token, "org/base", same, 2)).status).not.toBe(
        403,
      );
    } finally {
      await mock.stop();
    }
  });

  it("group grants apply to a session whose identity has the group", async () => {
    const mock = await startMockRegistry();
    try {
      mock.grant("group:leads", "publish", "area");
      const lead = await session(mock, "lee@acme.test", ["leads"]);
      const other = await session(mock, "bob@acme.test", ["devs"]);
      expect((await publish(mock, lead, "area/web", layer())).status).toBe(201);
      expect((await publish(mock, other, "area/web", layer(), 1)).status).toBe(
        403,
      );
      const me = (await (
        await fetch(`${mock.url}/v1/whoami`, {
          headers: { authorization: `Bearer ${lead}` },
        })
      ).json()) as { roles: unknown };
      expect(me.roles).toEqual([{ role: "publish", path: "area" }]);
    } finally {
      await mock.stop();
    }
  });
});

describe("mock managed bundle", () => {
  const doc = (name: string, extra = "") =>
    `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: ${name}\n${extra}`;

  async function seed(mock: Awaited<ReturnType<typeof startMockRegistry>>) {
    const send = async (ref: string, source: string, files: object[] = []) =>
      fetch(`${mock.url}/v1/layers/${encodeURIComponent(ref)}/versions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${mock.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ source, files, baseVersion: 0 }),
      });
    await send(
      "org/acme",
      doc(
        "acme",
        "instructions:\n  - id: conduct\n    file: ./conduct.md\nlocks:\n  - instructions[conduct]\n",
      ),
      [
        {
          path: "conduct.md",
          content: Buffer.from("Review kindly.").toString("base64"),
        },
      ],
    );
    await send("team/web", doc("web", "extends: [org/acme]\n"));
    await send(
      "team/bad",
      doc("bad", "extends: [org/acme]\npolicy:\n  mcp: exclusive\n"),
    );
  }

  const get = async (
    mock: Awaited<ReturnType<typeof startMockRegistry>>,
    query: string,
    token: string | null = mock.token,
  ) => {
    const response = await fetch(`${mock.url}/v1/managed/bundle?${query}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      body: (await response.json()) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  };

  it("answers the bundle for a chain, with the published versions and digests", async () => {
    const mock = await startMockRegistry({ managed: compiler });
    try {
      await seed(mock);
      const answer = await get(mock, "layer=team%2Fweb&os=linux");
      expect(answer.status).toBe(200);
      const [acme, web] = mock.layers().filter((l) => l.ref !== "team/bad");
      expect(answer.body.manifest.layers).toEqual([
        { ref: "org/acme", version: 1, digest: acme!.digest },
        { ref: "team/web", version: 1, digest: web!.digest },
      ]);
      expect(answer.body.manifest.os).toBe("linux");
      expect(
        Buffer.from(answer.body.files["texts/conduct.md"], "base64").toString(),
      ).toBe("Review kindly.");
      expect(Object.keys(answer.body.files)).toContain(
        "zzpersona/manifest.json",
      );
    } finally {
      await mock.stop();
    }
  });

  it("refuses with 422 managed-refused naming the path and code", async () => {
    const mock = await startMockRegistry({ managed: compiler });
    try {
      await seed(mock);
      const answer = await get(mock, "layer=team%2Fbad&os=linux");
      expect(answer.status).toBe(422);
      expect(answer.body.problems[0]).toMatchObject({
        code: "managed-refused",
        ref: "team/bad",
        path: "mcp.servers.x",
      });
      expect(answer.body.detail).toContain("mcp.servers.x");
      expect(answer.body.detail).toContain("managed-secret");
    } finally {
      await mock.stop();
    }
  });

  it("answers 501 format-unsupported for other formats and without a compiler", async () => {
    const mock = await startMockRegistry({ managed: compiler });
    const bare = await startMockRegistry();
    try {
      await seed(mock);
      await seed(bare);
      const console_ = await get(
        mock,
        "layer=team%2Fweb&os=linux&format=console",
      );
      expect(console_.status).toBe(501);
      expect(console_.body.problems[0].code).toBe("format-unsupported");
      const none = await get(bare, "layer=team%2Fweb&os=linux");
      expect(none.status).toBe(501);
      expect(none.body.problems[0].code).toBe("format-unsupported");
    } finally {
      await mock.stop();
      await bare.stop();
    }
  });

  it("answers 400 invalid-request, 404 not-found and 401", async () => {
    const mock = await startMockRegistry({ managed: compiler });
    try {
      await seed(mock);
      for (const query of [
        "layer=team%2Fweb&os=beos",
        "layer=team%2Fweb",
        "os=linux",
        "layer=team%2Fweb&os=linux&format=zip",
        "layer=team%2Fweb&os=linux&include=some",
        "layer=project%2Fx&os=linux",
      ]) {
        const answer = await get(mock, query);
        expect([query, answer.status]).toEqual([query, 400]);
        expect(answer.body.problems[0].code).toBe("invalid-request");
      }
      const missing = await get(mock, "layer=team%2Fnope&os=linux");
      expect(missing.status).toBe(404);
      expect(missing.body.problems[0]).toMatchObject({
        code: "not-found",
        ref: "team/nope",
      });
      expect((await get(mock, "layer=team%2Fweb&os=linux", null)).status).toBe(
        401,
      );
    } finally {
      await mock.stop();
    }
  });
});
