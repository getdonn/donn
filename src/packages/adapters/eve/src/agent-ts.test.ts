import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createdAgentTs, patchAgentTs } from "./agent-ts.js";

const dir = new URL("../test/fixtures/agent-ts/", import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");

const IMPORT = 'import { donn } from "./lib/donn/config";';

function patched(source: string): string {
  const result = patchAgentTs(source);
  if (!result.ok) throw new Error(`refused: ${result.hint}`);
  return result.text;
}

describe("createdAgentTs", () => {
  it("is the minimal agent that spreads donn", () => {
    expect(createdAgentTs()).toBe(
      'import { defineAgent } from "eve";\nimport { donn } from "./lib/donn/config";\n\nexport default defineAgent({ ...donn });\n',
    );
  });
});

describe("patchAgentTs on the templates' real agent.ts (eve@0.83.2)", () => {
  it("has a fixture for every template in the repository", () => {
    expect(fixtures).toHaveLength(8);
  });

  for (const name of fixtures) {
    it(`${name}: golden output`, () => {
      expect(patched(read(name))).toMatchSnapshot();
    });

    it(`${name}: imports donn, spreads it last, drops model, is idempotent`, () => {
      const text = patched(read(name));
      expect(text).toContain(IMPORT);
      expect(text).not.toMatch(/^\s*model:/m);
      expect(text).toMatch(/\.\.\.donn,?\s*\}\);\n$/);
      expect(patched(text)).toBe(text);
    });
  }
});

describe("patchAgentTs edits only its spans", () => {
  it("keeps comments, other properties and line endings", () => {
    const source = [
      'import { defineAgent } from "eve";',
      "",
      "// A comment above.",
      "export default defineAgent({",
      '  model: "anthropic/claude-sonnet-5", // the model',
      '  reasoning: "medium",',
      "  // kept",
      "  compaction: { thresholdPercent: 0.7 }",
      "});",
      "// tail",
      "",
    ].join("\r\n");
    const text = patched(source);
    expect(text).toBe(
      [
        'import { defineAgent } from "eve";',
        IMPORT,
        "",
        "// A comment above.",
        "export default defineAgent({",
        '  reasoning: "medium",',
        "  // kept",
        "  compaction: { thresholdPercent: 0.7 },",
        "  ...donn,",
        "});",
        "// tail",
        "",
      ].join("\r\n"),
    );
  });

  it("removes a model line cleanly under CRLF", () => {
    const text = patched(
      'import { defineAgent } from "eve";\r\nexport default defineAgent({\r\n  model: "x",\r\n  a: 1,\r\n});\r\n',
    );
    expect(text).toContain("defineAgent({\r\n  a: 1,\r\n  ...donn,\r\n});");
  });

  it("handles an empty object", () => {
    expect(
      patched(
        'import { defineAgent } from "eve";\nexport default defineAgent({});\n',
      ),
    ).toBe(
      `import { defineAgent } from "eve";\n${IMPORT}\nexport default defineAgent({ ...donn });\n`,
    );
  });

  it("handles an inline object with a trailing comma", () => {
    expect(
      patched(
        'import { defineAgent } from "eve";\nexport default defineAgent({ a: 1, });\n',
      ),
    ).toContain("defineAgent({ a: 1, ...donn, });");
  });

  it("removes a model that is not the first property, and a string-keyed one", () => {
    const text = patched(
      'import { defineAgent } from "eve";\nexport default defineAgent({\n  a: 1,\n  "model": openai("x"),\n  b: 2,\n});\n',
    );
    expect(text).toContain("  a: 1,\n  b: 2,\n  ...donn,\n});");
    expect(text).not.toContain("model");
  });

  it("removes a model that is the last property", () => {
    const text = patched(
      'import { defineAgent } from "eve";\nexport default defineAgent({\n  a: 1,\n  model: "x",\n});\n',
    );
    expect(text).toContain("  a: 1,\n  ...donn,\n});");
  });

  it("only adds what is missing", () => {
    const importOnly = `import { defineAgent } from "eve";\n${IMPORT}\nexport default defineAgent({ a: 1 });\n`;
    expect(patched(importOnly)).toContain("{ a: 1, ...donn }");
    const spreadOnly =
      'import { defineAgent } from "eve";\nexport default defineAgent({ a: 1, ...donn });\n';
    expect(patched(spreadOnly)).toBe(
      `import { defineAgent } from "eve";\n${IMPORT}\nexport default defineAgent({ a: 1, ...donn });\n`,
    );
  });

  it("returns an already patched file unchanged", () => {
    const done = `import { defineAgent } from "eve";\n${IMPORT}\n\nexport default defineAgent({ reasoning: "low", ...donn });\n`;
    expect(patched(done)).toBe(done);
  });

  it("accepts a type-annotated file", () => {
    const text = patched(
      'import { defineAgent } from "eve";\nconst x: number = 1;\nexport default defineAgent({ model: "a", n: x as number });\n',
    );
    expect(text).toContain("n: x as number, ...donn");
  });
});

describe("patchAgentTs refusals", () => {
  const eve = 'import { defineAgent } from "eve";\n';
  const cases: Record<string, string> = {
    "two defineAgent calls": `${eve}const a = defineAgent({});\nexport default defineAgent({});\n`,
    "a non-literal argument": `${eve}const c = {};\nexport default defineAgent(c);\n`,
    "no default export": `${eve}export const agent = defineAgent({});\n`,
    "defineAgent under another name": `import { defineAgent as da } from "eve";\nexport default da({});\n`,
    "defineAgent not from eve": `import { defineAgent } from "./mine";\nexport default defineAgent({});\n`,
    "a default export that is a variable": `${eve}const a = defineAgent({});\nexport default a;\n`,
    "a wrapped call": `${eve}export default defineAgent({}) as unknown;\n`,
    "two arguments": `${eve}export default defineAgent({}, {});\n`,
    "a different donn binding": `${eve}const donn = 1;\nexport default defineAgent({});\n`,
    "a syntax error": `${eve}export default defineAgent({;\n`,
  };
  for (const [name, source] of Object.entries(cases)) {
    it(`refuses ${name}, with the two lines to add by hand`, () => {
      const result = patchAgentTs(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("agent-ts-unrecognised");
      expect(result.hint).toContain(IMPORT);
      expect(result.hint).toContain("...donn");
    });
  }
});
