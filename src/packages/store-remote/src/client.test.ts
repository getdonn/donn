import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMockRegistry } from "@zzpersona/registry-api/mock";
import { RegistryError, createClient } from "./client.js";
import { file, persona } from "./testing/helpers.js";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => {});
});

async function mock() {
  const registry = await startMockRegistry();
  stops.push(registry.stop);
  return registry;
}

async function fake(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stops.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("client", () => {
  it("each method parses", async () => {
    const registry = await mock();
    const client = createClient({ url: registry.url, token: registry.token });
    expect(await client.whoami()).toEqual({
      subject: "mock-user",
      org: "acme",
    });
    expect(await client.listLayers()).toEqual([]);
    const result = await client.publish("org/acme", {
      source: persona("acme"),
      files: [file("notes.txt", "hi")],
      baseVersion: 0,
    });
    expect(result).toMatchObject({ version: 1 });
    expect(await client.listLayers()).toHaveLength(1);
    const version = await client.getVersion("org/acme", 1);
    expect(version.files[0]?.path).toBe("notes.txt");
    expect((await client.getVersion("org/acme", "latest")).version).toBe(1);
  });

  it("a 422 becomes a RegistryError with code and problems", async () => {
    const registry = await mock();
    const client = createClient({ url: registry.url, token: registry.token });
    const error = await client
      .publish("org/acme", {
        source: persona("acme", "instructions:\n  - id: c\n    file: a.md\n"),
        files: [],
        baseVersion: 0,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("missing-file");
    expect((error as RegistryError).problems?.[0]?.path).toBe("a.md");
    expect((error as RegistryError).message).toContain("a.md");
  });

  it("a wrong token is unauthorized and a missing version not-found", async () => {
    const registry = await mock();
    const bad = createClient({ url: registry.url, token: "nope" });
    await expect(bad.whoami()).rejects.toMatchObject({ code: "unauthorized" });
    const client = createClient({ url: registry.url, token: registry.token });
    await expect(client.getVersion("org/x", 1)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("a server that never answers gives timeout", async () => {
    const url = await fake(() => {});
    const client = createClient({ url, token: "t", timeoutMs: 50 });
    await expect(client.whoami()).rejects.toMatchObject({ code: "timeout" });
  });

  it("an unreachable server gives unreachable", async () => {
    const registry = await mock();
    await registry.stop();
    const client = createClient({ url: registry.url, token: "t" });
    await expect(client.whoami()).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("a response with the wrong shape gives registry-protocol naming the route", async () => {
    const url = await fake((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
    });
    const client = createClient({ url, token: "t" });
    const error = (await client.whoami().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("registry-protocol");
    expect(error.message).toContain("GET /v1/whoami");
  });

  it("the token never appears in an error message", async () => {
    const token = "s3cret-token-value";
    const url = await fake((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(JSON.stringify(req.headers));
    });
    const problem = await fake((req, res) => {
      res.writeHead(500, { "content-type": "application/problem+json" });
      res.end(
        JSON.stringify({
          type: "about:blank",
          title: "Boom",
          status: 500,
          detail: JSON.stringify(req.headers),
        }),
      );
    });
    for (const base of [url, problem]) {
      const error = (await createClient({ url: base, token })
        .whoami()
        .catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(RegistryError);
      expect(error.message).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    }
  });

  it("the token never appears in problems or detail", async () => {
    const token = "tok-echo-4d2e";
    const url = await fake((_req, res) => {
      res.writeHead(422, { "content-type": "application/problem+json" });
      res.end(
        JSON.stringify({
          type: "about:blank",
          title: "Invalid",
          status: 422,
          detail: `request had Bearer ${token}`,
          problems: [{ code: "invalid", message: `bad Bearer ${token}` }],
        }),
      );
    });
    const client = createClient({ url, token });
    const error = await client.whoami().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryError);
    const e = error as RegistryError;
    expect(e.message).not.toContain(token);
    expect(e.problems).toHaveLength(1);
    for (const p of e.problems ?? []) expect(p.message).not.toContain(token);
    expect(JSON.stringify(e.problems)).not.toContain(token);
  });

  it("keeps the URL's path prefix", async () => {
    let seen = "";
    const url = await fake((req, res) => {
      seen = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ subject: "a", org: "b" }));
    });
    await createClient({ url: `${url}/zz`, token: "t" }).whoami();
    expect(seen).toBe("/zz/v1/whoami");
  });
});
