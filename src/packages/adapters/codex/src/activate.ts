import type { ActivateInput, ActivationPlan } from "@getdonn/adapter-sdk";
import { INSTRUCTIONS, LAUNCH, type LaunchSpec } from "./compile.js";
import { tomlKey, tomlString, tomlValue } from "./toml.js";

// One launch step: `codex` with the persona as `-c` overrides. No shell runs it, so arguments
// are not shell-quoted; Codex parses each `-c` value as TOML.

const text = (input: ActivateInput, path: string) => {
  const file = input.output.files[path];
  return file && "content" in file ? file.content : "";
};

export function activate(input: ActivateInput): ActivationPlan {
  const spec = JSON.parse(text(input, LAUNCH)) as LaunchSpec;
  const args = [
    "-s",
    spec.sandbox,
    "-a",
    spec.approval,
    "-c",
    `developer_instructions=${tomlString(text(input, INSTRUCTIONS))}`,
  ];
  for (const name of Object.keys(spec.servers).sort()) {
    args.push(
      "-c",
      `mcp_servers.${tomlKey(name)}=${tomlValue(spec.servers[name]!)}`,
    );
  }
  for (const [server, tool] of spec.approvals) {
    args.push(
      "-c",
      tool === "*"
        ? `mcp_servers.${tomlKey(server)}.default_tools_approval_mode="approve"`
        : `mcp_servers.${tomlKey(server)}.tools.${tomlKey(tool)}.approval_mode="approve"`,
    );
  }
  if (spec.model) args.push("-m", spec.model);
  return {
    steps: [
      {
        kind: "launch",
        command: "codex",
        args: [...args, ...input.passthrough],
        env: {},
        cwd: input.cwd,
      },
    ],
  };
}
