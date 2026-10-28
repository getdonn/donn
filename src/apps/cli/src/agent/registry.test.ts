import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetCreated,
  listCreated,
  recordCreated,
  recordPort,
  storedPort,
} from "./registry.js";

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

  it("stores a port and reads it back", async () => {
    await recordCreated(home, { project: "/r", name: "a" });
    await recordPort(home, "/r", "a", 8787);
    expect(await storedPort(home, "/r", "a")).toBe(8787);
    expect(await listCreated(home)).toEqual([
      { project: "/r", name: "a", port: 8787 },
    ]);
  });

  it("records a port for an agent missing from the index", async () => {
    await recordPort(home, "/r", "b", 9000);
    expect(await storedPort(home, "/r", "b")).toBe(9000);
  });

  it("a bad stored port reads as none", async () => {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(
      join(home, "agents", "index.json"),
      JSON.stringify({
        agents: [
          { project: "/r", name: "a", port: "abc" },
          { project: "/r", name: "b", port: 80 },
          { project: "/r", name: "c", port: 70000 },
          { project: "/r", name: "d", port: 8787 },
        ],
      }),
    );
    const agents = await listCreated(home);
    expect(agents).toHaveLength(4);
    expect(agents.map((a) => a.port)).toEqual([
      undefined,
      undefined,
      undefined,
      8787,
    ]);
    expect(await storedPort(home, "/r", "a")).toBeUndefined();
  });

  it("recordCreated keeps an entry's port", async () => {
    await recordPort(home, "/r", "a", 8787);
    await recordCreated(home, { project: "/r", name: "a" });
    expect(await storedPort(home, "/r", "a")).toBe(8787);
  });
});
