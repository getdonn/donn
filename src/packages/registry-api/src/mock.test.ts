import { describe, expect, it } from "vitest";
import { registryConformance } from "./conformance.js";
import { startMockRegistry } from "./mock.js";

registryConformance(async (options) => {
  const mock = await startMockRegistry(options);
  return {
    url: mock.url,
    token: mock.token,
    stop: mock.stop,
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
