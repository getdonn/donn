// The Claude Code managed settings keys `targets.claude-code.managed` may pass through, and the
// Claude Code version each one needs. From code.claude.com/docs/en/managed-settings and
// /managed-mcp (read 2026-10-23). A key not listed here is refused (managed-unknown-key): a typo
// in a policy must fail the build, not silently enforce nothing.

export const KNOWN_MANAGED_KEYS: ReadonlySet<string> = new Set([
  // Managed-only switches and enforcement keys.
  "allowAllClaudeAiMcps",
  "allowClaudeInChromeWithManagedMcp",
  "allowedChannelPlugins",
  "allowedMcpServers",
  "allowManagedHooksOnly",
  "allowManagedMcpServersOnly",
  "allowManagedPermissionRulesOnly",
  "blockedMarketplaces",
  "channelsEnabled",
  "claudeMd",
  "deniedMcpServers",
  "deniedModels",
  "disableCommandPluginSources",
  "disableSideloadFlags",
  "forceRemoteSettingsRefresh",
  "managedMcpServers",
  "managedSourcesBehavior",
  "pluginSuggestionMarketplaces",
  "pluginTrustMessage",
  "strictKnownMarketplaces",
  "strictPluginOnlyCustomization",
  // Ordinary settings an organisation commonly enforces.
  "apiKeyHelper",
  "availableModels",
  "claudeMdExcludes",
  "cleanupPeriodDays",
  "enabledPlugins",
  "env",
  "extraKnownMarketplaces",
  "forceLoginMethod",
  "forceLoginOrgUUID",
  "permissions",
  "sandbox",
]);

/** The lowest Claude Code version that reads each key; a key not listed adds no floor. */
export const MIN_CLAUDE_CODE: Readonly<Record<string, string>> = {
  disableSideloadFlags: "2.1.193",
  managedSourcesBehavior: "2.1.242",
  managedMcpServers: "2.1.259",
  claudeMd: "2.1.260",
  deniedModels: "2.1.283",
};

const parts = (version: string) => version.split(".").map(Number);

function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest floor among `keys`, or undefined when none has one. */
export function minClaudeCode(keys: Iterable<string>): string | undefined {
  let floor: string | undefined;
  for (const key of keys) {
    const version = Object.hasOwn(MIN_CLAUDE_CODE, key)
      ? MIN_CLAUDE_CODE[key]
      : undefined;
    if (
      version !== undefined &&
      (floor === undefined || compareVersions(version, floor) > 0)
    ) {
      floor = version;
    }
  }
  return floor;
}
