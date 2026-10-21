import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalStore, findProject, StoreError } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "zzp-store-"));
  dirs.push(dir);
  return dir;
}

function put(path: string, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const persona = (name: string) =>
  `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: ${name}\n`;

function mounts() {
  const root = temp();
  return {
    personas: join(root, "personas"),
    project: join(root, "repo", ".zzpersona"),
    user: join(root, "home"),
  };
}

describe("locate", () => {
  it("maps each layer to its mount", () => {
    const m = mounts();
    mkdirSync(m.personas, { recursive: true });
    const store = createLocalStore(m);
    expect(store.locate("team/payments.yaml")).toEqual({
      path: join(m.personas, "team/payments.yaml"),
      root: m.personas,
    });
    expect(store.locate("org/hooks/x.sh")).toEqual({
      path: join(m.personas, "org/hooks/x.sh"),
      root: m.personas,
    });
    expect(store.locate("project/persona.yaml")).toEqual({
      path: join(m.project, "persona.yaml"),
      root: m.project,
    });
    expect(store.locate("project/instructions/a.md")).toEqual({
      path: join(m.project, "instructions/a.md"),
      root: m.project,
    });
    expect(store.locate("user/overrides.yaml")).toEqual({
      path: join(m.user, "overrides.yaml"),
      root: m.user,
    });
    expect(store.locate("user/hooks/x.sh")).toEqual({
      path: join(m.user, "personas/hooks/x.sh"),
      root: join(m.user, "personas"),
    });
  });

  it("returns undefined for project paths outside a project", () => {
    const { personas, user } = mounts();
    expect(
      createLocalStore({ personas, user }).locate("project/persona.yaml"),
    ).toBeUndefined();
  });
});

describe("load", () => {
  it("parses a persona and returns undefined for a missing one", async () => {
    const m = mounts();
    put(join(m.personas, "team/payments.yaml"), persona("payments"));
    const store = createLocalStore(m);
    expect(await store.load("team/payments")).toMatchObject({
      metadata: { name: "payments" },
    });
    expect(await store.load("team/nope")).toBeUndefined();
  });

  it("reports invalid YAML with the file and line", async () => {
    const m = mounts();
    const file = join(m.personas, "team/bad.yaml");
    put(file, "apiVersion: zzpersona/v0\nkind: [unclosed\n");
    const error = await createLocalStore(m)
      .load("team/bad")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ file });
    expect((error as StoreError).line).toBeGreaterThan(0);
  });

  it("names the config key when the personas mount is absent", async () => {
    const { user } = mounts();
    const error = await createLocalStore({ user })
      .load("team/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ configKey: "personas" });
  });

  it("names the configured path when the personas folder does not exist", async () => {
    const m = mounts();
    const error = await createLocalStore(m)
      .load("team/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).message).toContain(m.personas);
  });
});

describe("readText", () => {
  it("reads through the mount and names both paths when missing", async () => {
    const m = mounts();
    put(join(m.project, "instructions/a.md"), "hello");
    const store = createLocalStore(m);
    expect(await store.readText("project/instructions/a.md")).toBe("hello");
    const error = await store
      .readText("project/instructions/b.md")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).message).toContain("project/instructions/b.md");
    expect((error as Error).message).toContain(
      join(m.project, "instructions/b.md"),
    );
  });
});

describe("list", () => {
  it("lists personas from every mount, ignoring stray layer folders", async () => {
    const m = mounts();
    put(join(m.personas, "org/base.yaml"), persona("base"));
    put(join(m.personas, "team/payments.yaml"), persona("payments"));
    put(join(m.personas, "team/x/nested.yaml"), persona("nested"));
    put(join(m.personas, "org/hooks/x.sh"), "echo");
    put(join(m.personas, "user/stray.yaml"), persona("stray"));
    put(join(m.personas, "project/stray.yaml"), persona("stray"));
    put(join(m.user, "personas/me.yaml"), persona("me"));
    put(join(m.project, "persona.yaml"), persona("p"));
    const store = createLocalStore(m);
    expect(await store.list()).toEqual([
      "org/base",
      "project/persona",
      "team/payments",
      "team/x/nested",
      "user/me",
    ]);
    expect((await store.strayLayerDirs()).sort()).toEqual([
      join(m.personas, "project"),
      join(m.personas, "user"),
    ]);
  });
});

describe("findProject", () => {
  it("finds the nearest .zzpersona/persona.yaml walking up", () => {
    const root = temp();
    put(join(root, "repo/.zzpersona/persona.yaml"), persona("repo"));
    put(join(root, "repo/a/.zzpersona/persona.yaml"), persona("a"));
    mkdirSync(join(root, "repo/a/b"), { recursive: true });
    mkdirSync(join(root, "repo/c"), { recursive: true });
    expect(findProject(join(root, "repo/a/b"))).toBe(
      join(root, "repo/a/.zzpersona"),
    );
    expect(findProject(join(root, "repo/c"))).toBe(
      join(root, "repo/.zzpersona"),
    );
    expect(findProject(root)).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("list() names a configured personas folder that does not exist (I3)", async () => {
    const m = mounts();
    const error = await createLocalStore(m)
      .list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).message).toContain(m.personas);
  });
});

describe("hardening (spec 07)", () => {
  it("lists symlinked personas and only real personas", async () => {
    const m = mounts();
    put(join(m.personas, "team/source/real.yaml"), persona("real"));
    mkdirSync(join(m.personas, "team"), { recursive: true });
    symlinkSync(
      join(m.personas, "team/source/real.yaml"),
      join(m.personas, "team/linked.yaml"),
    );
    put(join(m.personas, "team/skills/x/data.yaml"), "foo: 1\n");
    put(
      join(m.personas, "team/overlay.yaml"),
      "apiVersion: zzpersona/v0\nkind: PersonaOverlay\n",
    );
    expect(await createLocalStore(m).list()).toEqual([
      "team/linked",
      "team/source/real",
    ]);
  });

  it("lists a file that does not parse, so loading it reports the error", async () => {
    const m = mounts();
    put(join(m.personas, "team/broken.yaml"), "kind: [unclosed\n");
    const store = createLocalStore(m);
    expect(await store.list()).toEqual(["team/broken"]);
    await expect(store.load("team/broken")).rejects.toThrow(StoreError);
  });

  it("refuses an instruction file that resolves outside its mount", async () => {
    const m = mounts();
    const outside = join(dirname(m.project), "..", "outside.md");
    put(outside, "private");
    put(join(m.project, "instructions/inside-target.md"), "fine");
    mkdirSync(join(m.project, "instructions"), { recursive: true });
    symlinkSync(outside, join(m.project, "instructions/leak.md"));
    symlinkSync(
      join(m.project, "instructions/inside-target.md"),
      join(m.project, "instructions/ok.md"),
    );
    const store = createLocalStore(m);
    const error = await store
      .readText("project/instructions/leak.md")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as Error).message).toContain("outside");
    expect(await store.readText("project/instructions/ok.md")).toBe("fine");
  });
});
