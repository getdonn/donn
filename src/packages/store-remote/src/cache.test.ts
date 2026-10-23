import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleDigest } from "@zzpersona/registry-api";
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
    managedBundle: (query) => real.managedBundle(query),
  };
  client = counting;
});
afterEach(async () => {
  await registry.stop();
});

/** The cache folder of a version the mock holds. */
const fold = async (home: string, ref: string, version: number) =>
  cacheFolder(
    home,
    ref,
    version,
    (await client.getVersion(ref, version)).digest,
  );

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
    const folder = await fold(home, "org/acme", 1);
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
    expect(existsSync(await fold(home, "org/acme", 1))).toBe(false);
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
    expect(existsSync(await fold(home, "org/acme", 1))).toBe(false);
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
    expect(existsSync(await fold(home, "org/a", 1))).toBe(true);
    expect(existsSync(await fold(home, "org/b", 1))).toBe(true);
    expect(existsSync(await fold(home, "org/a", 2))).toBe(false);
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
    expect(existsSync(await fold(home, "org/acme", 1))).toBe(false);
    expect(existsSync(await fold(home, "org/acme", 2))).toBe(true);
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
      readFileSync(join(await fold(home, "org/acme", 2), "notes.txt"), "utf8"),
    ).toBe("two");
    expect(existsSync(await fold(home, "org/acme", 1))).toBe(false);
  });
});

describe("locking and folders", () => {
  it("two concurrent pulls both succeed and the index names existing folders", async () => {
    const home = temp();
    await publish("org/a", "a1", 0);
    await publish("team/b", "b1", 0);
    await Promise.all([
      pull(home, client, registry.url),
      pull(home, client, registry.url),
      pull(home, client, registry.url),
    ]);
    const index = (await readIndex(home))!;
    expect(Object.keys(index.layers)).toHaveLength(2);
    for (const [ref, { version, digest }] of Object.entries(index.layers)) {
      expect(
        existsSync(join(cacheFolder(home, ref, version, digest), "layer.yaml")),
      ).toBe(true);
    }
    expect(existsSync(join(home, "cache/registry/.lock"))).toBe(false);
  });

  it("a stale lock from a dead pid is taken over", async () => {
    const home = temp();
    await publish("org/a", "a1", 0);
    const root = join(home, "cache/registry");
    mkdirSync(root, { recursive: true });
    // A pid beyond any real one is not alive.
    writeFileSync(join(root, ".lock"), "2147483646");
    expect(await pull(home, client, registry.url)).toHaveLength(1);
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });

  it("a held lock times out with the caller's signal", async () => {
    const home = temp();
    const root = join(home, "cache/registry");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".lock"), String(process.pid));
    await expect(
      pull(home, client, registry.url, undefined, AbortSignal.timeout(150)),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      recordPublished(
        home,
        registry.url,
        await (async () => {
          await publish("org/a", "x", 0);
          return client.getVersion("org/a", 1);
        })(),
        AbortSignal.timeout(100),
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(existsSync(join(root, ".lock"))).toBe(true);
  });

  it("sweeps index.json.tmp-* leftovers while holding the lock", async () => {
    const home = temp();
    const root = join(home, "cache/registry");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.json.tmp-1-abcd"), "{");
    await pull(home, client, registry.url);
    expect(existsSync(join(root, "index.json.tmp-1-abcd"))).toBe(false);
  });

  it("refs org/a and org/a/1 coexist across pulls", async () => {
    const home = temp();
    await publish("org/a", "A1", 0);
    await publish("org/a/1", "N1", 0);
    await pull(home, client, registry.url);
    await publish("org/a", "A2", 1);
    await pull(home, client, registry.url);
    const index = (await readIndex(home))!;
    const nested = index.layers["org/a/1"]!;
    expect(
      readFileSync(
        join(
          cacheFolder(home, "org/a/1", nested.version, nested.digest),
          "notes.txt",
        ),
        "utf8",
      ),
    ).toBe("N1");
    const top = index.layers["org/a"]!;
    expect(top.version).toBe(2);
    expect(
      readFileSync(
        join(cacheFolder(home, "org/a", 2, top.digest), "notes.txt"),
        "utf8",
      ),
    ).toBe("A2");
  });

  it("a changed digest for the same version installs a new folder", async () => {
    const home = temp();
    await publish("org/a", "one", 0);
    await pull(home, client, registry.url);
    const first = (await readIndex(home))!.layers["org/a"]!;
    const real = await client.getVersion("org/a", 1);
    const changed = file("notes.txt", "other");
    const rewritten = {
      ...client,
      listLayers: () =>
        Promise.resolve([
          {
            ref: "org/a",
            version: 1,
            digest: bundleDigest(real.source, [changed]),
          },
        ]),
      getVersion: () =>
        Promise.resolve({
          ...real,
          files: [changed],
          digest: bundleDigest(real.source, [changed]),
        }),
    } as RegistryClient;
    await pull(home, rewritten, registry.url);
    const second = (await readIndex(home))!.layers["org/a"]!;
    expect(second.digest).not.toBe(first.digest);
    const dir = cacheFolder(home, "org/a", 1, second.digest);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("other");
    expect(existsSync(cacheFolder(home, "org/a", 1, first.digest))).toBe(false);
  });
});
