import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../index.js";
import { good } from "../testing/toy.js";
import { runConformance, type CheckName } from "./index.js";

// The toy adapter that follows the contract (testing/toy.ts), and one broken variant per check. Each variant must
// fail exactly its own check: that is what proves each check catches what it claims to.

const failedChecks = async (adapter: HarnessAdapter) =>
  [
    ...new Set(
      (await runConformance(adapter))
        .filter((r) => !r.passed)
        .map((r) => r.name),
    ),
  ].sort();

const broken: [CheckName, HarnessAdapter][] = [
  [
    "declaration",
    {
      ...good,
      id: "Bad_Id",
      // Its own targets field, so only the id is wrong.
      capabilities: () => {
        const { "targets.toy": own, ...fields } = good.capabilities().fields;
        return { fields: { ...fields, "targets.Bad_Id": own! } };
      },
    },
  ],
  [
    "complete-matrix",
    {
      ...good,
      capabilities: () => {
        const { skills: _missing, ...fields } = good.capabilities().fields;
        return { fields };
      },
    },
  ],
  [
    "complete-matrix",
    {
      ...good,
      capabilities: () => ({
        fields: { ...good.capabilities().fields, skills: { support: "none" } },
      }),
    },
  ],
  [
    "rejects-unsupported-ir",
    {
      ...good,
      compile: (input) =>
        good.compile({ ...input, ir: { ...input.ir, irVersion: 0 } }),
    },
  ],
  [
    "deterministic",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        return {
          ...output,
          files: {
            ...output.files,
            "nonce.txt": { content: String(Math.random()) },
          },
        };
      },
    },
  ],
  [
    "well-formed-output",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        return {
          ...output,
          files: { ...output.files, "../escape.md": { content: "x" } },
        };
      },
    },
  ],
  [
    "no-secret-leaks",
    {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        const leaked = JSON.stringify(input.ir.mcp.servers);
        return {
          ...output,
          files: { ...output.files, "servers.json": { content: leaked } },
        };
      },
    },
  ],
  [
    "no-silent-loss",
    {
      ...good,
      // Omits permission entries only: dropping secret entries too would also, rightly,
      // fail no-secret-leaks.
      compile: (input) => {
        const output = good.compile(input);
        const entries = output.report.entries.filter(
          (e) => !e.path.startsWith("permissions."),
        );
        return { ...output, report: { ...output.report, entries } };
      },
    },
  ],
  [
    "detect-not-installed",
    {
      ...good,
      detect: async () => {
        throw new Error("toy is not installed");
      },
    },
  ],
  [
    "no-writes",
    {
      ...good,
      compile: (input) => {
        writeFileSync("leak.txt", "written during compile");
        return good.compile(input);
      },
    },
  ],
];

describe("runConformance", () => {
  it("passes an adapter that follows the contract", async () => {
    const results = await runConformance(good);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(8);
  });

  it.each(broken)(
    "fails exactly %s for the adapter that breaks it",
    async (check, adapter) => {
      expect(await failedChecks(adapter)).toEqual([check]);
    },
  );

  it("restores the working directory", async () => {
    const before = process.cwd();
    await runConformance(broken.at(-1)![1]);
    expect(process.cwd()).toBe(before);
  });
});

describe("review fixes", () => {
  it("checks a degraded mode against the matrix for that detection (I6)", async () => {
    // In "lite" mode it drops instructions (native by default) and its matrix says so, but the
    // report omits them. Judged against the default matrix, nothing would be missing.
    const lite: HarnessAdapter = {
      ...good,
      capabilities: (detection) =>
        detection?.facts.lite === true ? { fields: {} } : good.capabilities(),
      compile: (input) =>
        input.detection.facts.lite === true
          ? { ...good.compile(input), files: {} }
          : good.compile(input),
    };
    const results = await runConformance(lite, {
      detection: { installed: true, facts: { lite: true } },
    });
    expect(results.filter((r) => !r.passed).map((r) => r.name)).toContain(
      "no-silent-loss",
    );
  });

  it("accepts a report worse than the matrix promises (I7)", async () => {
    const worse: HarnessAdapter = {
      ...good,
      // Promises advisory knowledge, but the toy's report says dropped.
      capabilities: () => ({
        fields: {
          ...good.capabilities().fields,
          knowledge: { support: "advisory", note: "as pointers" },
        },
      }),
    };
    expect(await failedChecks(worse)).toEqual([]);
  });

  it("lets a dropped server cover its secret-bearing children (I7)", async () => {
    const parentOnly: HarnessAdapter = {
      ...good,
      compile: (input) => {
        const output = good.compile(input);
        const entries = output.report.entries.filter(
          (e) => !/^mcp\.servers\.[^.]+\./.test(e.path),
        );
        return { ...output, report: { ...output.report, entries } };
      },
    };
    expect(await failedChecks(parentOnly)).toEqual([]);
  });
});

describe("runConformance under a runner without chdir", () => {
  it("reports a chdir failure as a failed no-writes check", async () => {
    const spy = vi.spyOn(process, "chdir").mockImplementation(() => {
      throw new TypeError("process.chdir() is not supported in workers");
    });
    try {
      const results = await runConformance(good);
      const noWrites = results.find((r) => r.name === "no-writes");
      expect(noWrites?.passed).toBe(false);
      expect(noWrites?.reason).toContain("vitest's forks pool");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("overlay blocks", () => {
  const withOverlay = (block: string, content: string): HarnessAdapter => ({
    ...good,
    activate: () => ({
      steps: [{ kind: "overlay", path: "AGENTS.md", content, block }],
    }),
  });

  it("rejects a bad block name and content holding its own markers", async () => {
    expect(await failedChecks(withOverlay("zzpersona", "fine\n"))).toEqual([]);
    expect(await failedChecks(withOverlay("Bad Block", "fine\n"))).toEqual([
      "well-formed-output",
    ]);
    expect(
      await failedChecks(
        withOverlay("zzpersona", "x\n<!-- zzpersona:end -->\n"),
      ),
    ).toEqual(["well-formed-output"]);
  });
});

describe("adapters for a file format (noBinary)", () => {
  const fileFormat: HarnessAdapter = {
    ...good,
    detect: async () => ({ installed: true, version: "n/a", facts: {} }),
  };
  const ran: string[] = [];
  const probing: HarnessAdapter = {
    ...good,
    detect: async (probe) => {
      await probe.run("toy", []);
      ran.push("toy");
      return { installed: true, version: "n/a", facts: {} };
    },
  };
  const failed = async (adapter: HarnessAdapter, noBinary?: boolean) =>
    (await runConformance(adapter, noBinary ? { noBinary } : {}))
      .filter((r) => !r.passed)
      .map((r) => r.name);

  it("expects installed without running anything", async () => {
    expect(await failed(fileFormat)).toEqual(["detect-not-installed"]);
    expect(await failed(fileFormat, true)).toEqual([]);
    expect(await failed(probing, true)).toEqual(["detect-not-installed"]);
  });
});
