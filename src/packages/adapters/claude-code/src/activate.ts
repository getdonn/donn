import type { ActivateInput, ActivationPlan } from "@zzpersona/adapter-sdk";

// One launch step: `claude` with the flags for whatever compile produced. The CLI adds the
// resolved secret env vars from output.secretEnv. See docs/planning/05-adapter-sdk.md, section 5.

export function activate({
  ir,
  output,
  buildDir,
  cwd,
  passthrough,
}: ActivateInput): ActivationPlan {
  const has = (path: string) => path in output.files;
  const at = (path: string) => `${buildDir}/${path}`;
  const hasPlugin = Object.keys(output.files).some((path) =>
    path.startsWith("plugin/"),
  );
  const strictMcp = ir.targets["claude-code"]?.strictMcp !== false;

  // --mcp-config takes several files, so a non-variadic flag (--settings, always present) must
  // follow it; otherwise a positional passthrough prompt would be read as another config file.
  const args = [
    ...(hasPlugin ? ["--plugin-dir", at("plugin")] : []),
    ...(has("mcp.json") ? ["--mcp-config", at("mcp.json")] : []),
    ...(has("mcp.json") && strictMcp ? ["--strict-mcp-config"] : []),
    "--settings",
    at("settings.json"),
    ...(has("system-prompt.md")
      ? ["--append-system-prompt-file", at("system-prompt.md")]
      : []),
    ...passthrough,
  ];
  return { steps: [{ kind: "launch", command: "claude", args, env: {}, cwd }] };
}
