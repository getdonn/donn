import type { CompileInput, Detection, Step } from "@zzpersona/adapter-sdk";

type LaunchStep = Extract<Step, { kind: "launch" }>;
import { corpus } from "@zzpersona/adapter-sdk/conformance";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import adapter from "./index.js";

const entry = (name: string) => corpus.find((e) => e.name === name)!;
const detection: Detection = { installed: true, version: "0.163.0", facts: {} };
function build(
  name: string,
  overrides: Partial<CompileInput> = {},
  passthrough: string[] = [],
) {
  const { personaId, ir, texts } = entry(name);
  const input = { personaId, ir, texts, detection, ...overrides };
  const output = adapter.compile(input);
  const plan = adapter.activate({
    ir: input.ir,
    output,
    buildDir: "/BUILD",
    detection,
    cwd: "/PROJECT",
    passthrough,
  });
  const step = plan.steps[0] as LaunchStep;
  return { output, step };
}
/** The values of every `-c key=value` override, parsed as Codex would. */
const overrides = (args: string[]) =>
  args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
const parsed = (args: string[]) =>
  overrides(args).map((o) => parse(o) as Record<string, unknown>);
const outcome = (output: ReturnType<typeof build>["output"], path: string) =>
  output.report.entries.find((e) => e.path === path);

describe("the Codex launch", () => {
  it("starts with the sandbox and approval defaults and the instructions", () => {
    const { step, output } = build("full");
    expect(step.command).toBe("codex");
    expect(step.args.slice(0, 4)).toEqual([
      "-s",
      "workspace-write",
      "-a",
      "on-request",
    ]);
    const instructions = parsed(step.args).find(
      (o) => "developer_instructions" in o,
    )!;
    const file = output.files["instructions.md"];
    expect(
      file && "content" in file && instructions.developer_instructions,
    ).toBe(file && "content" in file ? file.content : undefined);
    expect(String(instructions.developer_instructions)).toMatch(
      /^## zzpersona persona: project\/checkout-api\n/,
    );
    expect(String(instructions.developer_instructions)).toContain(
      "## Tool rules",
    );
  });

  it("forwards MCP secrets by name and never puts them in args", () => {
    const { step, output } = build("full");
    const server = parsed(step.args).find((o) => "mcp_servers" in o)!
      .mcp_servers as Record<string, Record<string, unknown>>;
    expect(server["payments-schema"]).toEqual({
      command: "npx",
      args: ["-y", "@corp/payments-schema-mcp"],
      env_vars: ["SCHEMA_TOKEN"],
    });
    expect(output.secretEnv).toEqual({
      SCHEMA_TOKEN: "secret://vault/payments/schema-token",
    });
    expect(step.args.join(" ")).not.toContain("secret://");
    expect(outcome(output, "mcp.servers.jira")?.outcome).toBe("dropped");
  });

  it("drops a server whose secret cannot be forwarded", () => {
    const { step, output } = build("kitchen-sink");
    expect(step.args.join(" ")).not.toContain("secret://");
    expect(outcome(output, "mcp.servers.db")?.outcome).toBe("dropped");
    expect(outcome(output, "mcp.servers.remote")?.outcome).toBe("dropped");
  });

  it("drops the second server sharing a variable name for a different secret", () => {
    const { ir } = entry("minimal");
    const { step, output } = build("minimal", {
      ir: {
        ...ir,
        mcp: {
          servers: {
            a: { command: "a", env: { TOKEN: "secret://env/A", MODE: "x" } },
            b: { command: "b", env: { TOKEN: "secret://env/B" } },
            c: { command: "c", env: { TOKEN: "secret://env/A" } },
          },
        },
      },
    });
    const names = parsed(step.args).flatMap((o) =>
      "mcp_servers" in o ? Object.keys(o.mcp_servers as object) : [],
    );
    expect(names).toEqual(["a", "c"]);
    expect(outcome(output, "mcp.servers.b")?.reason).toBe(
      "another MCP server already uses TOKEN for a different secret; Codex forwards variables by name",
    );
    const a = parsed(step.args).find(
      (o) => "mcp_servers" in o && "a" in (o.mcp_servers as object),
    )!.mcp_servers as Record<string, Record<string, unknown>>;
    expect(a.a).toEqual({
      command: "a",
      env: { MODE: "x" },
      env_vars: ["TOKEN"],
    });
  });

  it("approves MCP tools the persona allows", () => {
    const { ir } = entry("minimal");
    const { step } = build("minimal", {
      ir: {
        ...ir,
        mcp: { servers: { zz: { command: "node" } } },
        permissions: {
          allow: ["mcp__zz__ping", "Read(./**)"],
          deny: [],
          ask: [],
        },
      },
    });
    expect(overrides(step.args)).toContain(
      'mcp_servers.zz.tools.ping.approval_mode="approve"',
    );
  });

  it("applies targets.codex and reports a looser setting", () => {
    const { ir } = entry("minimal");
    const { step, output } = build("minimal", {
      ir: {
        ...ir,
        targets: {
          codex: {
            sandbox: "danger-full-access",
            approval: "never",
            model: "o9",
            bogus: 1,
          },
        },
      },
    });
    expect(step.args.slice(0, 4)).toEqual([
      "-s",
      "danger-full-access",
      "-a",
      "never",
    ]);
    expect(step.args).toContain("-m");
    expect(outcome(output, "targets.codex.sandbox")).toMatchObject({
      outcome: "advisory",
      reason: "looser than zzpersona's default",
    });
    expect(outcome(output, "targets.codex.approval")?.outcome).toBe("advisory");
    expect(outcome(output, "targets.codex.bogus")?.outcome).toBe("dropped");
  });

  it("drops skills and hooks with their reasons", () => {
    const { output } = build("full");
    expect(
      output.report.entries.find((e) => e.path.startsWith("skills["))?.reason,
    ).toBe("Codex has no per-launch skill root");
    const kitchen = build("kitchen-sink").output;
    expect(
      kitchen.report.entries.find((e) => e.path.startsWith("hooks."))?.reason,
    ).toBe(
      "untrusted hooks do not run, and zzpersona never bypasses Codex's hook trust",
    );
  });

  it("ignores other harnesses' targets", () => {
    const { output } = build("full");
    expect(
      output.report.entries.some((e) =>
        e.path.startsWith("targets.claude-code"),
      ),
    ).toBe(false);
  });

  it("passes passthrough arguments last", () => {
    const { step } = build("minimal", {}, ["exec", "hi"]);
    expect(step.args.slice(-2)).toEqual(["exec", "hi"]);
  });
});
