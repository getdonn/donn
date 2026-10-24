import type { Detection, Platform, Probe } from "@getdonn/adapter-sdk";

// Installed version, plus file-based managed settings that change how we can launch. Policy
// delivered by MDM profile, registry or server-managed settings is invisible here; the CLI must
// surface Claude Code's own startup error for that case.

const MANAGED_DIRS: Partial<Record<Platform, string>> = {
  darwin: "/Library/Application Support/ClaudeCode",
  linux: "/etc/claude-code",
  win32: "C:\\Program Files\\ClaudeCode",
};

function parseJson(
  text: string | undefined,
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function managedFacts(probe: Probe) {
  const dir = MANAGED_DIRS[probe.platform];
  if (dir === undefined) return { sideloadBlocked: false, managedMcp: false };
  const sep = probe.platform === "win32" ? "\\" : "/";
  const at = (...parts: string[]) => [dir, ...parts].join(sep);

  const dropIns = ((await probe.listDir(at("managed-settings.d"))) ?? [])
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => at("managed-settings.d", name));
  const settings = await Promise.all(
    [at("managed-settings.json"), ...dropIns].map(async (path) =>
      parseJson(await probe.readFile(path)),
    ),
  );
  return {
    // Claude Code applies managed-settings.json, then the drop-ins in name order: last wins.
    sideloadBlocked: settings.reduce<boolean>(
      (blocked, s) =>
        typeof s?.disableSideloadFlags === "boolean"
          ? s.disableSideloadFlags
          : blocked,
      false,
    ),
    managedMcp: (await probe.readFile(at("managed-mcp.json"))) !== undefined,
  };
}

export async function detect(probe: Probe): Promise<Detection> {
  const facts = await managedFacts(probe);
  const result = await probe.run("claude", ["--version"]);
  if (result.exitCode !== 0) return { installed: false, facts };
  const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
  return { installed: true, ...(version !== undefined && { version }), facts };
}
