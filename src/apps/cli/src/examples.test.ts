import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zz } from "./test/seed.js";

// The repo's examples/ (a demo project and its personas) must keep resolving and compiling:
// README.md points people at them.

const EXAMPLES = join(import.meta.dirname, "../../../../examples");
const DEMO_APP = join(EXAMPLES, "demo-app");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "zzp-examples-"));
  writeFileSync(
    join(home, "config.yaml"),
    `personas: ${join(EXAMPLES, "personas")}\n`,
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const compile = (persona?: string) =>
  zz(["compile", ...(persona ? [persona] : []), "--dry-run", "--json"], {
    cwd: DEMO_APP,
    home,
  });

describe("examples/", () => {
  it.each(["org/acme", "team/web"])("compiles %s", async (ref) => {
    const r = await compile(ref);
    expect(r.code, r.stderr).toBe(0);
  });

  it("compiles the demo project's persona through every layer", async () => {
    const r = await zz(["resolve", "--json"], { cwd: DEMO_APP, home });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).ir.layers).toEqual([
      "org/acme",
      "team/web",
      "project/persona",
    ]);
    const built = await compile();
    expect(built.code, built.stderr).toBe(0);
  });
});
