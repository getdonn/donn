import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES, bundleDigest } from "./bundle.js";
import {
  memoryStore,
  publishLayer,
  type LayerStore,
  type PublishOutcome,
} from "./engine.js";
import type { BundleFile, LayerVersion } from "./schemas.js";

const file = (path: string, text: string): BundleFile => ({
  path,
  content: Buffer.from(text).toString("base64"),
});

const layer = (name: string, extra = ""): string =>
  `apiVersion: donn/v0\nkind: Persona\nmetadata:\n  name: ${name}\n${extra}`;

const context = { subject: "alice", now: new Date("2026-10-22T12:00:00Z") };

/** A memory store that counts inserts. */
function counted(): LayerStore & { inserts: number } {
  const inner = memoryStore();
  const store = {
    inserts: 0,
    latest: (ref: string) => inner.latest(ref),
    refs: () => inner.refs(),
    insert: async (version: LayerVersion) => {
      store.inserts++;
      await inner.insert(version);
    },
  };
  return store;
}

const request = (source: string, baseVersion = 0, more = {}) => ({
  source,
  files: [] as BundleFile[],
  baseVersion,
  ...more,
});

async function publish(
  store: LayerStore,
  ref: string,
  body: unknown,
): Promise<PublishOutcome> {
  return publishLayer(store, ref, body, context);
}

/** The status and first problem code of an outcome. */
const codeOf = (outcome: PublishOutcome) =>
  "problem" in outcome
    ? [outcome.status, outcome.problem.problems?.[0]?.code]
    : [outcome.status];

const LOCKED_BASE = layer("base", "locks:\n  - mcp.gateway\n");
const WEB_WITH_GATEWAY = layer(
  "web",
  "extends:\n  - org/base\nmcp:\n  gateway: bifrost://corp\n",
);

describe("publishLayer", () => {
  it("publishes a first version", async () => {
    const store = counted();
    const source = layer("base");
    const files = [file("instructions/a.md", "hello")];
    const outcome = await publish(store, "org/base", {
      source: layer(
        "base",
        "instructions:\n  - id: a\n    file: ./instructions/a.md\n",
      ),
      files,
      baseVersion: 0,
    });
    expect(outcome.status).toBe(201);
    if (outcome.status !== 201) return;
    expect(outcome.inserted.version).toBe(1);
    expect(outcome.inserted.publishedBy).toBe("alice");
    expect(outcome.inserted.publishedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(outcome.inserted.digest).toBe(
      bundleDigest(outcome.inserted.source, files),
    );
    expect(outcome.result).toEqual({
      version: 1,
      digest: outcome.inserted.digest,
      broken: [],
    });
    expect(store.inserts).toBe(1);
    expect(source).toContain("base");
  });

  describe("problems insert nothing", () => {
    const cases: [
      string,
      string,
      unknown,
      (s: LayerStore) => Promise<void>,
      number,
      string,
    ][] = [
      [
        "bad YAML",
        "org/base",
        request("a: [unclosed"),
        async () => {},
        422,
        "invalid",
      ],
      [
        "a schema failure",
        "org/base",
        request("kind: Nope\n"),
        async () => {},
        422,
        "invalid",
      ],
      [
        "a control character in a path",
        "org/base",
        { ...request(layer("base")), files: [file("a\u0001.md", "x")] },
        async () => {},
        422,
        "invalid",
      ],
      [
        "a project ref",
        "project/x",
        request(layer("x")),
        async () => {},
        422,
        "not-publishable",
      ],
      [
        "a missing file",
        "org/base",
        request(layer("base", "instructions:\n  - id: a\n    file: ./a.md\n")),
        async () => {},
        422,
        "missing-file",
      ],
      [
        "an agent template folder that is not in the bundle",
        "org/base",
        request(
          layer(
            "base",
            "agents:\n  define:\n    rev:\n      template: ./tpl\n      target: local\n      path: agents/rev\n",
          ),
        ),
        async () => {},
        422,
        "missing-file",
      ],
      [
        "a path out of the layer",
        "org/base",
        { ...request(layer("base")), files: [file("../x.md", "x")] },
        async () => {},
        422,
        "path-escapes-layer",
      ],
      [
        "an oversized bundle",
        "org/base",
        {
          ...request(layer("base")),
          files: [
            {
              path: "big.bin",
              content: Buffer.alloc(MAX_BUNDLE_BYTES + 1).toString("base64"),
            },
          ],
        },
        async () => {},
        422,
        "bundle-too-large",
      ],
      [
        "a stale base",
        "org/base",
        request(layer("base", 'permissions:\n  allow:\n    - "Bash(ls)"\n'), 0),
        async (s) => {
          await publishLayer(s, "org/base", request(layer("base")), context);
        },
        409,
        "stale-base",
      ],
      [
        "an unpublished ancestor",
        "team/web",
        request(layer("web", "extends:\n  - org/base\n")),
        async () => {},
        422,
        "unpublished-ancestor",
      ],
      [
        "a lock violation",
        "team/web",
        request(WEB_WITH_GATEWAY),
        async (s) => {
          await publishLayer(s, "org/base", request(LOCKED_BASE), context);
        },
        422,
        "lock-violation",
      ],
    ];
    for (const [name, ref, body, seed, status, code] of cases) {
      it(name, async () => {
        const store = counted();
        await seed(store);
        const before = store.inserts;
        const outcome = await publish(store, ref, body);
        expect(codeOf(outcome)).toEqual([status, code]);
        expect(store.inserts).toBe(before);
      });
    }
  });

  it("names the locking layer in a lock violation", async () => {
    const store = counted();
    await publish(store, "org/base", request(LOCKED_BASE));
    const outcome = await publish(store, "team/web", request(WEB_WITH_GATEWAY));
    expect("problem" in outcome && outcome.problem.problems?.[0]?.ref).toBe(
      "team/web",
    );
    expect("problem" in outcome && outcome.problem.detail).toContain(
      "org/base",
    );
  });

  it("breaks-descendants refuses, force publishes and reports broken", async () => {
    const store = counted();
    await publish(store, "org/base", request(layer("base")));
    await publish(store, "team/web", request(WEB_WITH_GATEWAY));
    const refused = await publish(store, "org/base", request(LOCKED_BASE, 1));
    expect(codeOf(refused)).toEqual([422, "breaks-descendants"]);
    expect(store.inserts).toBe(2);
    const forced = await publish(
      store,
      "org/base",
      request(LOCKED_BASE, 1, { force: true }),
    );
    expect(forced.status).toBe(201);
    expect(forced.status === 201 && forced.broken).toEqual(["team/web"]);
    expect(forced.status === 201 && forced.result).toMatchObject({
      version: 2,
      broken: ["team/web"],
    });
  });

  it("an already-broken descendant is not counted", async () => {
    const store = counted();
    await publish(store, "org/base", request(layer("base")));
    await publish(store, "team/web", request(WEB_WITH_GATEWAY));
    await publish(store, "org/base", request(LOCKED_BASE, 1, { force: true }));
    const outcome = await publish(
      store,
      "org/base",
      request(
        layer(
          "base",
          'permissions:\n  allow:\n    - "Bash(ls)"\nlocks:\n  - mcp.gateway\n',
        ),
        2,
      ),
    );
    expect(outcome.status).toBe(201);
    expect(outcome.status === 201 && outcome.broken).toEqual([]);
  });

  it("unchanged returns 200 and inserts nothing", async () => {
    const store = counted();
    await publish(store, "org/base", request(layer("base")));
    const outcome = await publish(store, "org/base", request(layer("base"), 1));
    expect(outcome.status).toBe(200);
    expect(outcome.status === 200 && outcome.result).toMatchObject({
      unchanged: true,
      version: 1,
    });
    expect(store.inserts).toBe(1);
  });

  it("a dry run ignores the base", async () => {
    const store = counted();
    await publish(store, "org/base", request(layer("base")));
    const outcome = await publish(
      store,
      "org/base",
      request(layer("base", 'permissions:\n  allow:\n    - "Bash(ls)"\n'), 0, {
        dryRun: true,
      }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.status === 200 && outcome.result).toMatchObject({
      dryRun: true,
      broken: [],
    });
    expect(store.inserts).toBe(1);
  });

  it("an invalid request is a problem", async () => {
    for (const body of [null, "x", {}]) {
      const outcome = await publish(counted(), "org/base", body);
      expect(codeOf(outcome)).toEqual([422, "invalid"]);
    }
  });

  it("a store error propagates", async () => {
    const failure = new Error("database is down");
    const store: LayerStore = {
      latest: () => Promise.reject(failure),
      refs: () => Promise.resolve([]),
      insert: () => Promise.reject(new Error("must not insert")),
    };
    await expect(
      publish(store, "org/base", request(layer("base"))),
    ).rejects.toBe(failure);
  });
});

describe("the store contract", () => {
  it("memoryStore refuses a version that is not latest + 1", async () => {
    const store = memoryStore();
    const v1 = (
      (await publishLayer(
        store,
        "org/base",
        request(layer("base")),
        context,
      )) as {
        inserted: LayerVersion;
      }
    ).inserted;
    await expect(store.insert(v1)).rejects.toThrow(/version 1/);
    expect(store.versions("org/base")).toHaveLength(1);
  });

  it("an unlocked race stores one version at most", async () => {
    const inner = memoryStore();
    // A store whose reads return a snapshot after a macrotask, as a database's do.
    const slow: LayerStore = {
      latest: (ref) => {
        const snapshot = inner.latest(ref);
        return new Promise((done) => setImmediate(() => done(snapshot)));
      },
      refs: () => inner.refs(),
      insert: (version) => inner.insert(version),
    };
    const results = await Promise.allSettled([
      publishLayer(slow, "org/base", request(layer("base")), context),
      publishLayer(
        slow,
        "org/base",
        request(layer("base", 'permissions:\n  allow:\n    - "Bash(ls)"\n')),
        context,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(inner.versions("org/base")).toHaveLength(1);
  });

  it("reads each ref at most once per publish", async () => {
    const inner = memoryStore();
    await publishLayer(inner, "org/base", request(layer("base")), context);
    await publishLayer(inner, "team/web", request(WEB_WITH_GATEWAY), context);
    const reads = new Map<string, number>();
    const counting: LayerStore = {
      latest: (ref) => {
        reads.set(ref, (reads.get(ref) ?? 0) + 1);
        return inner.latest(ref);
      },
      refs: () => inner.refs(),
      insert: (version) => inner.insert(version),
    };
    await publishLayer(
      counting,
      "org/base",
      request(layer("base", 'permissions:\n  allow:\n    - "Bash(ls)"\n'), 1),
      context,
    );
    expect(Math.max(...reads.values())).toBe(1);
  });
});
