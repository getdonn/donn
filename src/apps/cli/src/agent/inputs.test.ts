import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext, resolvePersona } from "../context.js";
import { quietIo, seed, type Seeded } from "../test/seed.js";
import { compileInputs } from "./inputs.js";

let s: Seeded;
beforeEach(() => {
  s = seed();
});
afterEach(() => s.cleanup());

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe("compileInputs", () => {
  it("collects texts, the template's paths and its sandbox and route-auth facts", async () => {
    const persona = join(s.repo, ".donn/persona.yaml");
    put(
      persona,
      "apiVersion: donn/v0\nkind: Persona\nmetadata: { name: p }\nextends: [team/payments]\nagents:\n  define:\n    a: { template: eve:blank, target: local }\n",
    );
    put(join(s.personas, "team/skills/run-payment-sim/scripts/sim.sh"), "run");
    put(join(s.personas, "team/instructions/overview.md"), "Payments.");
    const dir = join(s.repo, "agents/a");
    for (const file of [
      "package.json",
      "agent/agent.ts",
      "agent/sandbox/index.ts",
      "agent/channels/eve.ts",
      "agent/lib/donn/config.ts",
      "node_modules/eve/index.js",
      "agent/tools/node_modules/x.js",
      ".output/server/index.mjs",
      ".eve/state.json",
      ".git/HEAD",
    ])
      put(join(dir, file), "x");
    put(
      join(dir, ".donn/agent.json"),
      JSON.stringify({
        agent: "a",
        persona: "project/persona",
        adapter: "eve",
        frameworkVersion: "0.83.2",
        template: "eve:blank",
        target: "local",
        path: "agents/a",
        files: { "agent/lib/donn/config.ts": "sha256:00" },
        agentTs: "patched",
        edits: [],
        state: "complete",
      }),
    );
    const io = quietIo({ cwd: s.repo, home: s.home });
    const ctx = await createContext(io);
    const { ir } = await resolvePersona(
      ctx,
      { ref: "project/persona", source: "project" },
      false,
    );
    const input = await compileInputs(ctx, ir, "a", dir, "0.83.2");
    expect(input).toMatchObject({
      personaId: "project/persona",
      agent: "a",
      frameworkVersion: "0.83.2",
      project: { hasSandbox: true, hasRouteAuth: true },
    });
    expect(input.project.existing).toEqual([
      "agent/agent.ts",
      "agent/channels/eve.ts",
      "agent/sandbox/index.ts",
      "package.json",
    ]);
    expect(input.texts).toMatchObject({
      "org/instructions/conduct.md": "Review kindly.",
      "team/skills/run-payment-sim/SKILL.md": expect.stringContaining(
        "description: Runs the payment simulator.",
      ),
      "team/skills/run-payment-sim/scripts/sim.sh": "run",
    });
  });

  it("finds neither fact in a template without them", async () => {
    const persona = join(s.repo, ".donn/persona.yaml");
    put(
      persona,
      "apiVersion: donn/v0\nkind: Persona\nmetadata: { name: p }\nagents:\n  define:\n    a: { template: eve:blank, target: local }\n",
    );
    const dir = join(s.repo, "agents/a");
    put(join(dir, "agent/sandboxes.ts"), "x");
    put(join(dir, "agent/channels/eve-like.ts"), "x");
    const ctx = await createContext(quietIo({ cwd: s.repo, home: s.home }));
    const { ir } = await resolvePersona(
      ctx,
      { ref: "project/persona", source: "project" },
      false,
    );
    const input = await compileInputs(ctx, ir, "a", dir, "0.83.2");
    expect(input.project).toMatchObject({
      hasSandbox: false,
      hasRouteAuth: false,
    });
  });
});
