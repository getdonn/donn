import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockRegistry } from "@zzpersona/registry-api/mock";
import {
  cacheFolder,
  pull,
  readIndex,
  recordPublished,
  type CacheIndex,
} from "./cache.js";
import { createClient, type RegistryClient } from "./client.js";
import { cleanupTemps, file, persona, temp } from "./testing/helpers.js";

cleanupTemps();

let registry: Awaited<ReturnType<typeof startMockRegistry>>;
let client: RegistryClient;
let calls: string[];
beforeEach(async () => {
  registry = await startMockRegistry();
  const real = createClient({ url: registry.url, token: registry.token });
  calls = [];
  const counting: RegistryClient = {
    whoami: () => real.whoami(),
    listLayers: () => {
      calls.push("list");
      return real.listLayers();
    },
    getVersion: (ref, version) => {
      calls.push(`get ${ref}@${version}`);
      return real.getVersion(ref, version);
    },
    publish: (ref, body) => real.publish(ref, body),
  };
  client = counting;
});
afterEach(async () => {
  await registry.stop();
});

const publish = (ref: string, text: string, base: number) =>
  client.publish(ref, {
    source: persona(ref.replace("/", "-")),
    files: [file("notes.txt", text)],
    baseVersion: base,
  });

describe("pull", () => {
  it("writes layer.yaml and files, and an index", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    const changes = await pull(
      home,
      client,
      registry.url,
      () => new Date("2026-01-02T03:04:05Z"),
    );
    expect(changes).toEqual([{ ref: "org/acme", to: 1 }]);
    const folder = cacheFolder(home, "org/acme", 1);
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(folder, "layer.yaml"), "utf8")).toContain("kind");
    const index = (await readIndex(home))!;
    expect(index.pulledAt).toBe("2026-01-02T03:04:05.000Z");
    expect(index.layers["org/acme"]?.version).toBe(1);
  });

  it("pull fetches only changed digests", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    await publish("team/web", "w", 0);
    await pull(home, client, registry.url);
    calls.length = 0;
    expect(await pull(home, client, registry.url)).toEqual([]);
    expect(calls).toEqual(["list"]);
    await publish("org/acme", "two", 1);
    calls.length = 0;
    expect(await pull(home, client, registry.url)).toEqual([
      { ref: "org/acme", from: 1, to: 2 },
    ]);
    expect(calls).toEqual(["list", "get org/acme@2"]);
  });

  it("pull removes refs the registry no longer lists", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    await pull(home, client, registry.url);
    const gone = {
      ...client,
      listLayers: () => Promise.resolve([]),
    } as RegistryClient;
    expect(await pull(home, gone, registry.url)).toEqual([
      { ref: "org/acme", from: 1 },
    ]);
    expect((await readIndex(home))!.layers).toEqual({});
    expect(existsSync(cacheFolder(home, "org/acme", 1))).toBe(false);
  });

  it("a changed URL clears the cache", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    await pull(home, client, registry.url);
    const empty = {
      ...client,
      listLayers: () => Promise.resolve([]),
    } as RegistryClient;
    const changes = await pull(home, empty, "https://other.example/");
    expect(changes).toEqual([{ ref: "org/acme", from: 1 }]);
    const index = (await readIndex(home))!;
    expect(index.url).toBe("https://other.example/");
    expect(index.layers).toEqual({});
    expect(existsSync(cacheFolder(home, "org/acme", 1))).toBe(false);
  });

  it("an interrupted pull leaves the old cache", async () => {
    const home = temp();
    await publish("org/a", "a1", 0);
    await publish("org/b", "b1", 0);
    await pull(home, client, registry.url);
    const before = readFileSync(
      join(home, "cache/registry/index.json"),
      "utf8",
    );
    await publish("org/a", "a2", 1);
    await publish("org/b", "b2", 1);
    let n = 0;
    const flaky = {
      ...client,
      getVersion: (ref, version) => {
        if (++n === 2) return Promise.reject(new Error("boom"));
        return client.getVersion(ref, version);
      },
    } as RegistryClient;
    await expect(pull(home, flaky, registry.url)).rejects.toThrow("boom");
    expect(readFileSync(join(home, "cache/registry/index.json"), "utf8")).toBe(
      before,
    );
    expect(existsSync(cacheFolder(home, "org/a", 1))).toBe(true);
    expect(existsSync(cacheFolder(home, "org/b", 1))).toBe(true);
    expect(existsSync(cacheFolder(home, "org/a", 2))).toBe(false);
    const tmps = () =>
      readdirSync(join(home, "cache/registry")).filter((n) =>
        n.startsWith(".tmp-"),
      );
    expect(tmps().length).toBeGreaterThan(0);
    await pull(home, client, registry.url);
    expect(tmps()).toEqual([]);
    expect((await readIndex(home))!.layers["org/b"]?.version).toBe(2);
  });

  it("old versions are removed once the index moves past them", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    await pull(home, client, registry.url);
    await publish("org/acme", "two", 1);
    await pull(home, client, registry.url);
    expect(existsSync(cacheFolder(home, "org/acme", 1))).toBe(false);
    expect(existsSync(cacheFolder(home, "org/acme", 2))).toBe(true);
  });

  it("refuses a version whose digest does not match the listing", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    const lying = {
      ...client,
      getVersion: async (ref, version) => ({
        ...(await client.getVersion(ref, version)),
        files: [file("notes.txt", "tampered")],
      }),
    } as RegistryClient;
    await expect(pull(home, lying, registry.url)).rejects.toMatchObject({
      code: "registry-protocol",
    });
    expect(await readIndex(home)).toBeUndefined();
  });
});

describe("recordPublished", () => {
  it("adds the published version to the cache and index", async () => {
    const home = temp();
    await publish("org/acme", "one", 0);
    await pull(home, client, registry.url);
    await publish("org/acme", "two", 1);
    await recordPublished(
      home,
      registry.url,
      await client.getVersion("org/acme", 2),
    );
    const index = (await readIndex(home)) as CacheIndex;
    expect(index.layers["org/acme"]?.version).toBe(2);
    expect(
      readFileSync(join(cacheFolder(home, "org/acme", 2), "notes.txt"), "utf8"),
    ).toBe("two");
    expect(existsSync(cacheFolder(home, "org/acme", 1))).toBe(false);
  });
});
