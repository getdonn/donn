import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES, bundleDigest } from "@zzpersona/registry-api";
import { createLocalStore } from "@zzpersona/store-local";
import { bundleLayer } from "./bundle.js";
import { RegistryError } from "./client.js";
import { cleanupTemps, persona, put, temp } from "./testing/helpers.js";

cleanupTemps();

function setup() {
  const root = temp();
  const personas = join(root, "personas");
  mkdirSync(personas, { recursive: true });
  return {
    root,
    personas,
    store: createLocalStore({ personas, user: join(root, "home") }),
  };
}

const code = async (promise: Promise<unknown>) =>
  ((await promise.catch((e: unknown) => e)) as RegistryError).code;

describe("bundleLayer", () => {
  it("bundles the YAML and every referenced file, skill folders recursively", async () => {
    const { personas, store } = setup();
    const yaml = persona(
      "acme",
      [
        "instructions:",
        "  - id: c",
        "    file: instructions/c.md",
        "skills:",
        "  include:",
        "    - skills/review",
        "    - https://example.com/skills/x",
        "hooks:",
        "  session-start:",
        "    - id: start",
        "      run: hooks/start.sh",
        "",
      ].join("\n"),
    );
    put(join(personas, "org/acme.yaml"), yaml);
    put(join(personas, "org/instructions/c.md"), "conduct");
    put(join(personas, "org/skills/review/SKILL.md"), "skill");
    put(join(personas, "org/skills/review/refs/deep/a.txt"), "deep");
    put(join(personas, "org/hooks/start.sh"), "#!/bin/sh\n");
    put(join(personas, "org/unreferenced.txt"), "x");
    const bundle = await bundleLayer(store, "org/acme");
    expect(bundle.source).toBe(yaml);
    expect(bundle.files.map((f) => f.path)).toEqual([
      "hooks/start.sh",
      "instructions/c.md",
      "skills/review/SKILL.md",
      "skills/review/refs/deep/a.txt",
    ]);
    expect(
      Buffer.from(bundle.files[1]!.content, "base64").toString("utf8"),
    ).toBe("conduct");
    expect(bundleDigest(bundle.source, bundle.files)).toMatch(/^sha256:/);
  });

  it("bundles binary files as raw bytes", async () => {
    const { personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "instructions:\n  - id: c\n    file: b.bin\n"),
    );
    const bytes = Buffer.from([0, 255, 128, 10, 13]);
    put(join(personas, "org/b.bin"), bytes as unknown as string);
    const bundle = await bundleLayer(store, "org/acme");
    expect(Buffer.from(bundle.files[0]!.content, "base64")).toEqual(bytes);
  });

  it("bundling refuses a symlink out of the layer", async () => {
    const { root, personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "instructions:\n  - id: c\n    file: leak.md\n"),
    );
    put(join(root, "outside.md"), "secret");
    symlinkSync(join(root, "outside.md"), join(personas, "org/leak.md"));
    await expect(bundleLayer(store, "org/acme")).rejects.toMatchObject({
      code: "path-escapes-layer",
    });
  });

  it("refuses a symlink inside a skill folder that leaves the layer", async () => {
    const { root, personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "skills:\n  include:\n    - skills/s\n"),
    );
    put(join(personas, "org/skills/s/SKILL.md"), "ok");
    put(join(root, "outside.md"), "secret");
    symlinkSync(join(root, "outside.md"), join(personas, "org/skills/s/x.md"));
    expect(await code(bundleLayer(store, "org/acme"))).toBe(
      "path-escapes-layer",
    );
  });

  it("refuses ../ and absolute referenced paths", async () => {
    const { personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "instructions:\n  - id: c\n    file: ../x.md\n"),
    );
    expect(await code(bundleLayer(store, "org/acme"))).toBe(
      "path-escapes-layer",
    );
  });

  it("a missing referenced file is missing-file", async () => {
    const { personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "instructions:\n  - id: c\n    file: nope.md\n"),
    );
    expect(await code(bundleLayer(store, "org/acme"))).toBe("missing-file");
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "skills:\n  include:\n    - skills/none\n"),
    );
    expect(await code(bundleLayer(store, "org/acme"))).toBe("missing-file");
  });

  it("a referenced path with a control character is invalid", async () => {
    const { personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", 'instructions:\n  - id: c\n    file: "a\\nb.md"\n'),
    );
    expect(await code(bundleLayer(store, "org/acme"))).toBe("invalid");
  });

  it("over MAX_BUNDLE_BYTES is bundle-too-large", async () => {
    const { personas, store } = setup();
    put(
      join(personas, "org/acme.yaml"),
      persona("a", "instructions:\n  - id: c\n    file: big.bin\n"),
    );
    put(
      join(personas, "org/big.bin"),
      Buffer.alloc(MAX_BUNDLE_BYTES + 1) as unknown as string,
    );
    expect(await code(bundleLayer(store, "org/acme"))).toBe("bundle-too-large");
  });

  it("project/ and user/ refs are not-publishable", async () => {
    const { store } = setup();
    expect(await code(bundleLayer(store, "project/persona"))).toBe(
      "not-publishable",
    );
    expect(await code(bundleLayer(store, "user/me"))).toBe("not-publishable");
  });

  it("an absent layer is not-found and bad YAML is invalid", async () => {
    const { personas, store } = setup();
    expect(await code(bundleLayer(store, "org/ghost"))).toBe("not-found");
    put(join(personas, "org/bad.yaml"), "kind: Nope\n");
    expect(await code(bundleLayer(store, "org/bad"))).toBe("invalid");
  });
});
