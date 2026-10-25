import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetCreated, listCreated, recordCreated } from "./registry.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "donn-agents-index-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the created-agents index", () => {
  it("records each agent once, lists and forgets them", async () => {
    expect(await listCreated(home)).toEqual([]);
    await recordCreated(home, { project: "/r", name: "a" });
    await recordCreated(home, { project: "/r", name: "a" });
    await recordCreated(home, { project: "/r", name: "b" });
    expect(await listCreated(home)).toEqual([
      { project: "/r", name: "a" },
      { project: "/r", name: "b" },
    ]);
    await forgetCreated(home, { project: "/r", name: "a" });
    expect(await listCreated(home)).toEqual([{ project: "/r", name: "b" }]);
  });
});
