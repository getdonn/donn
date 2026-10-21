import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seed, zz, type Seeded } from "./test/seed.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  put(
    join(s.personas, "team/platform.yaml"),
    [
      "apiVersion: zzpersona/v0",
      "kind: Persona",
      "metadata: { name: platform }",
      "extends: [org/base]",
      "permissions:",
      '  deny: ["Bash(kubectl delete:*)"]',
      "targets:",
      "  claude-code: { model: opus }",
      "",
    ].join("\n"),
  );
});
afterEach(() => s.cleanup());

const run = (args: string[], cwd = s.root) =>
  zz(["diff", ...args], { cwd, home: s.home });

describe("zzpersona diff", () => {
  it("prints each difference with its layers", async () => {
    const r = await run(["team/payments", "team/platform", "--no-overlay"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      /^team\/payments → team\/platform {3}\(\d+ differences\)$/,
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^\+ permissions\.deny\[Bash\(kubectl delete:\*\)\] +team\/platform$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^- mcp\.servers\.payments-schema +team\/payments$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^~ targets\.claude-code\.model +sonnet → opus +team\/payments → team\/platform$/,
      ),
    );
  });

  it("starts from the persona used here when given one persona", async () => {
    const r = await run(["team/platform", "--json"], s.repo);
    expect(r.code, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({
      from: "project/persona",
      to: "team/platform",
    });
    expect(body.changes.length).toBeGreaterThan(0);
    expect(body.changes[0]).toHaveProperty("path");
    expect(body.changes[0]).toHaveProperty("change");
  });

  it("says so when there are no differences", async () => {
    const r = await run(["team/payments", "team/payments"]);
    expect(r.stdout).toBe("no differences\n");
  });

  it("reports an unknown persona", async () => {
    const r = await run(["team/payments", "team/nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("unknown-persona");
  });
});
