import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "@getdonn/resolver";
import { createLocalStore } from "@getdonn/store-local";
import { cacheFolder, type CacheIndex } from "./cache.js";
import { withRegistry } from "./mount.js";
import { cleanupTemps, persona, put, temp } from "./testing/helpers.js";

cleanupTemps();

const withInstr = (name: string) =>
  persona(name, `instructions:\n  - id: c\n    file: instructions/c.md\n`);

/** Seed a cache folder the way pull would. */
function seed(home: string, ref: string, version: number, text: string) {
  const folder = cacheFolder(home, ref, version, "sha256:x");
  put(join(folder, "layer.yaml"), text);
  return folder;
}

function setup() {
  const root = temp();
  const home = join(root, "home");
  const personas = join(root, "personas");
  const local = createLocalStore({ personas, user: home });
  const index: CacheIndex = {
    url: "https://reg.example/",
    pulledAt: "2026-01-01T00:00:00.000Z",
    layers: {},
  };
  return { home, personas, local, index };
}

describe("withRegistry", () => {
  it("a published layer wins over a local one and warns once", async () => {
    const { home, personas, local, index } = setup();
    put(join(personas, "org/acme.yaml"), persona("local"));
    put(join(personas, "org/same.yaml"), persona("same"));
    seed(home, "org/acme", 3, persona("published"));
    seed(home, "org/same", 1, persona("same"));
    index.layers["org/acme"] = { version: 3, digest: "sha256:x" };
    index.layers["org/same"] = { version: 1, digest: "sha256:x" };
    const shadows: [string, number][] = [];
    const store = withRegistry(local, home, index, (ref, v) =>
      shadows.push([ref, v]),
    );
    const doc = (await store.load("org/acme")) as {
      metadata: { name: string };
    };
    expect(doc.metadata.name).toBe("published");
    await store.load("org/acme");
    await store.load("org/same");
    expect(shadows).toEqual([["org/acme", 3]]);
  });

  it("a published layer with no local copy does not warn", async () => {
    const { home, local, index } = setup();
    seed(home, "org/acme", 1, persona("published"));
    index.layers["org/acme"] = { version: 1, digest: "sha256:x" };
    const shadows: string[] = [];
    const store = withRegistry(local, home, index, (ref) => shadows.push(ref));
    expect(await store.load("org/acme")).toBeDefined();
    expect(shadows).toEqual([]);
  });

  it("refs not in the index come from the local store", async () => {
    const { home, personas, local, index } = setup();
    put(join(personas, "org/acme.yaml"), persona("local"));
    const store = withRegistry(local, home, index, () => {});
    expect(
      ((await store.load("org/acme")) as { metadata: { name: string } })
        .metadata.name,
    ).toBe("local");
    expect(store.published("org/acme")).toBeUndefined();
    expect(store.dir?.("org/acme")).toBe("org");
  });

  it("two published layers bundling the same relative path keep their own files", async () => {
    const { home, local, index } = setup();
    for (const [ref, text] of [
      ["org/a", "from a"],
      ["org/b", "from b"],
    ] as const) {
      const folder = seed(home, ref, 1, withInstr(ref.slice(4)));
      put(join(folder, "instructions/c.md"), text);
      index.layers[ref] = { version: 1, digest: "sha256:x" };
    }
    const store = withRegistry(local, home, index, () => {});
    expect(await store.readText(".registry/org/a/@/instructions/c.md")).toBe(
      "from a",
    );
    expect(await store.readText(".registry/org/b/@/instructions/c.md")).toBe(
      "from b",
    );
    const resolved = await resolve("org/a", { source: store });
    expect(resolved.ir.instructions).toMatchObject([
      { file: ".registry/org/a/@/instructions/c.md" },
    ]);
    const location = store.locate(".registry/org/b/@/instructions/c.md");
    expect(location).toEqual({
      path: join(
        cacheFolder(home, "org/b", 1, "sha256:x"),
        "instructions/c.md",
      ),
      root: cacheFolder(home, "org/b", 1, "sha256:x"),
    });
  });

  it("nested published refs keep their own files", async () => {
    const { home, local, index } = setup();
    for (const [ref, rel, text] of [
      ["team/platform", "skills/review/SKILL.md", "outer"],
      ["team/platform/skills", "review/SKILL.md", "inner"],
    ] as const) {
      const folder = seed(home, ref, 1, persona("x"));
      put(join(folder, rel), text);
      index.layers[ref] = { version: 1, digest: "sha256:x" };
    }
    const store = withRegistry(local, home, index, () => {});
    expect(
      await store.readText(
        `${store.dir!("team/platform")}/skills/review/SKILL.md`,
      ),
    ).toBe("outer");
    expect(
      await store.readText(
        `${store.dir!("team/platform/skills")}/review/SKILL.md`,
      ),
    ).toBe("inner");
    expect(
      store.locate(".registry/team/platform/skills/@/review/SKILL.md")?.root,
    ).toBe(cacheFolder(home, "team/platform/skills", 1, "sha256:x"));
  });

  it("a published layer extends a local one through the same store", async () => {
    const { home, personas, local, index } = setup();
    put(join(personas, "team/web.yaml"), persona("web"));
    seed(
      home,
      "org/acme",
      1,
      persona("acme").replace("metadata:", "extends: []\nmetadata:"),
    );
    index.layers["org/acme"] = { version: 1, digest: "sha256:x" };
    const store = withRegistry(local, home, index, () => {});
    expect((await resolve("team/web", { source: store })).ir.layers).toEqual([
      "team/web",
    ]);
  });

  it("refuses to read outside the version folder", async () => {
    const { home, local, index } = setup();
    seed(home, "org/a", 1, persona("a"));
    index.layers["org/a"] = { version: 1, digest: "sha256:x" };
    put(join(home, "secret.txt"), "no");
    const store = withRegistry(local, home, index, () => {});
    expect(
      store.locate(".registry/org/a/@/../../../secret.txt"),
    ).toBeUndefined();
    await expect(
      store.readText(".registry/org/a/@/../../../secret.txt"),
    ).rejects.toThrow();
  });

  it("list includes published refs once", async () => {
    const { home, personas, local, index } = setup();
    put(join(personas, "org/acme.yaml"), persona("local"));
    put(join(personas, "team/web.yaml"), persona("web"));
    seed(home, "org/acme", 1, persona("p"));
    seed(home, "area/ops", 1, persona("ops"));
    index.layers["org/acme"] = { version: 1, digest: "sha256:x" };
    index.layers["area/ops"] = { version: 1, digest: "sha256:x" };
    const store = withRegistry(local, home, index, () => {});
    expect(await store.list()).toEqual(["area/ops", "org/acme", "team/web"]);
  });

  it("published() names the version", () => {
    const { home, local, index } = setup();
    index.layers["org/acme"] = { version: 7, digest: "sha256:x" };
    const store = withRegistry(local, home, index, () => {});
    expect(store.published("org/acme")).toBe(7);
    expect(store.dir?.("org/acme")).toBe(".registry/org/acme/@");
  });

  it("strayLayerDirs delegates to the local store", async () => {
    const { home, personas, local, index } = setup();
    put(join(personas, "user/x.yaml"), persona("x"));
    const store = withRegistry(local, home, index, () => {});
    expect(await store.strayLayerDirs()).toEqual(await local.strayLayerDirs());
  });
});
