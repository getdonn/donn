import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "./context.js";
import { selectPersona } from "./select.js";
import { projectKey, writeState } from "./state.js";
import { quietIo, seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const select = async (cwd: string, arg?: string) =>
  selectPersona(arg, await createContext(quietIo({ cwd, home: s.home })));

describe("selectPersona", () => {
  it("prefers argument, then switch, then project, then default", async () => {
    const key = await projectKey(join(s.repo, ".donn"));
    await writeState(s.home, {
      version: 1,
      default: "team/payments",
      projects: { [key]: "org/base" },
    });
    expect(await select(s.repo, "area/fintech")).toEqual({
      ref: "area/fintech",
      source: "argument",
    });
    expect(await select(s.repo)).toEqual({
      ref: "org/base",
      source: "switch",
      project: key,
    });
    await writeState(s.home, {
      version: 1,
      default: "team/payments",
      projects: {},
    });
    expect(await select(s.repo)).toMatchObject({
      ref: "project/persona",
      source: "project",
    });
    expect(await select(s.root)).toEqual({
      ref: "team/payments",
      source: "default",
    });
  });

  it("suggests donn switch when nothing applies", async () => {
    const error = await select(s.root).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "no-persona" });
    expect((error as Error).message).toContain("donn switch");
  });

  it("strips .yaml and suggests a case-insensitive match", async () => {
    expect(await select(s.repo, "team/payments.yaml")).toMatchObject({
      ref: "team/payments",
    });
    const error = await select(s.repo, "Team/Payments").catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "unknown-persona",
      details: { suggestion: "team/payments" },
    });
    expect((error as Error).message).toContain("did you mean team/payments?");
  });

  it("explains a switched persona that no longer exists", async () => {
    writeFileSync(
      join(s.home, "state.json"),
      JSON.stringify({ version: 1, default: "team/gone", projects: {} }),
    );
    const r = await zz(["resolve", "--json"], { cwd: s.root, home: s.home });
    expect(r.code).toBe(1);
    const error = JSON.parse(r.stdout).error;
    expect(error).toMatchObject({ code: "stale-switch", ref: "team/gone" });
  });
});
