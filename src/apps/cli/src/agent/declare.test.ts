import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { addedLines, declareAgent, writeDeclaration } from "./declare.js";

const PERSONA = `# Project persona: comments and blank lines survive.
apiVersion: donn/v0
kind: Persona
metadata:
  name: checkout # the repo

extends: [team/payments]   # flow style stays

# Agents this repo runs.
agents:
  define:
    other: { template: "eve:blank", target: local } # keep me
`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "donn-declare-"));
  file = join(dir, "persona.yaml");
  writeFileSync(file, PERSONA);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("declareAgent", () => {
  it("adds agents.define.<name> and keeps every other byte", async () => {
    const { before, after } = await declareAgent(
      file,
      "reviewer",
      {
        template: "eve:eve-chat-template",
        target: "self-host",
        path: "bots/r",
      },
      { dryRun: false },
    );
    expect(before).toBe(PERSONA);
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(after).toBe(
      `${PERSONA}    reviewer:\n      template: eve:eve-chat-template\n      target: self-host\n      path: bots/r\n`,
    );
  });

  it("adds the entry after the last item, not after comments that lead the next section", async () => {
    const text = `${PERSONA.replace(" # keep me", "")}    # retired: old-bot\n\n# Models every agent uses.\nmodels:\n  default: gpt-5\n`;
    writeFileSync(file, text);
    const { after } = await declareAgent(
      file,
      "x",
      { template: "eve:blank", target: "local" },
      { dryRun: false },
    );
    expect(after).toBe(
      text.replace(
        "target: local }\n",
        "target: local }\n    x:\n      template: eve:blank\n      target: local\n",
      ),
    );
  });

  it("creates the agents block when there is none", async () => {
    writeFileSync(file, "# top\napiVersion: donn/v0 # v\nkind: Persona\n");
    const { after } = await declareAgent(
      file,
      "x",
      { template: "eve:blank", target: "local" },
      { dryRun: false },
    );
    expect(after).toBe(
      "# top\napiVersion: donn/v0 # v\nkind: Persona\nagents:\n  define:\n    x:\n      template: eve:blank\n      target: local\n",
    );
  });

  it("adds to a flow-style agents.define in flow style", async () => {
    writeFileSync(
      file,
      "kind: Persona\nagents: { define: { a: { template: eve:blank, target: local } } } # mine\n",
    );
    const { after } = await declareAgent(
      file,
      "b",
      { template: "eve:blank", target: "vercel" },
      { dryRun: false },
    );
    expect(after).toBe(
      "kind: Persona\nagents: { define: { a: { template: eve:blank, target: local }, b: { template: eve:blank, target: vercel } } } # mine\n",
    );
  });

  it("writes nothing under dryRun, and nothing when the check refuses", async () => {
    const { after } = await declareAgent(
      file,
      "x",
      { template: "eve:blank", target: "local" },
      { dryRun: true },
    );
    expect(after).toContain("    x:\n");
    expect(readFileSync(file, "utf8")).toBe(PERSONA);

    const refused = declareAgent(
      file,
      "x",
      { template: "eve:blank", target: "local" },
      {
        dryRun: false,
        check: async () => {
          throw new CliError("agent-locked", "locked", { layer: "org/base" });
        },
      },
    );
    await expect(refused).rejects.toMatchObject({ code: "agent-locked" });
    expect(readFileSync(file, "utf8")).toBe(PERSONA);
  });

  it("refuses a persona file that does not parse", async () => {
    writeFileSync(file, "a: [\n");
    await expect(
      declareAgent(
        file,
        "x",
        { template: "eve:blank", target: "local" },
        { dryRun: false },
      ),
    ).rejects.toMatchObject({ code: "invalid-persona-file" });
  });
});

describe("writeDeclaration", () => {
  const agent = { template: "eve:blank", target: "local" as const };

  it("writes a dry run's edit", async () => {
    const edit = await declareAgent(file, "kody", agent, { dryRun: true });
    expect(readFileSync(file, "utf8")).toBe(PERSONA);
    await writeDeclaration({ file, ...edit });
    expect(readFileSync(file, "utf8")).toBe(edit.after);
  });

  it("refuses when the file changed since it was read, writing nothing", async () => {
    const edit = await declareAgent(file, "kody", agent, { dryRun: true });
    writeFileSync(file, `${PERSONA}# edited meanwhile\n`);
    const error = await writeDeclaration({ file, ...edit }).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("persona-changed");
    expect(readFileSync(file, "utf8")).toBe(`${PERSONA}# edited meanwhile\n`);
  });
});

describe("addedLines", () => {
  it("returns the lines between the common head and tail", () => {
    expect(addedLines("a\nb\nc\n", "a\nb\nx\ny\nc\n")).toEqual(["x", "y"]);
    expect(addedLines("a\n", "a\nb\n")).toEqual(["b"]);
  });
});
