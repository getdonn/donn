import type { SecretBackend } from "./secrets.js";

// secret://keychain/<service>/<account>: the operating system's own secret store, read with
// the command it ships. See docs/planning/08-cli-reach.md, section 2.

const USAGE = "keychain refs are secret://<provider>/<service>/<account>";

/** The last path segment is the account; everything before it is the service. */
export function keychainParts(
  path: string,
): { service: string; account: string } | undefined {
  const slash = path.lastIndexOf("/");
  if (slash <= 0 || slash === path.length - 1) return undefined;
  return { service: path.slice(0, slash), account: path.slice(slash + 1) };
}

const firstLine = (text: string) => text.split("\n")[0]!.trim();

export interface KeychainContext {
  platform: string;
  /** Runs a command, writing `input` to its stdin. Never throws for a missing command: 127. */
  run(
    command: string,
    args: string[],
    input?: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function keychainSupported(platform: string): boolean {
  return platform === "darwin" || platform === "linux";
}

/** security exits 44 for a missing item (and says so on stderr); secret-tool's exit 1 only counts when quiet. */
const isMissing = (
  platform: string,
  r: { exitCode: number; stderr: string },
) =>
  platform === "darwin"
    ? r.exitCode === 44
    : r.exitCode === 1 && r.stderr.trim() === "";

type Result = { exitCode: number; stdout: string; stderr: string };

function fail(command: string, result: Result): never {
  if (result.exitCode === 124) {
    throw new Error(
      `timed out waiting for ${command} (was a keychain prompt left open?)`,
    );
  }
  if (result.exitCode === 127) {
    throw new Error(
      command === "secret-tool"
        ? "secret-tool is not installed (install libsecret-tools)"
        : `${command} is not installed`,
    );
  }
  throw new Error(
    `${command} exited ${result.exitCode}: ${firstLine(result.stderr)}`,
  );
}

function commandFor(platform: string): string {
  if (!keychainSupported(platform)) {
    throw new Error(`keychain is not supported on ${platform}`);
  }
  return platform === "darwin" ? "security" : "secret-tool";
}

/** The stored value, or undefined when there is no such item. */
export async function getKeychainItem(
  ctx: KeychainContext,
  service: string,
  account: string,
): Promise<string | undefined> {
  const command = commandFor(ctx.platform);
  const args =
    ctx.platform === "darwin"
      ? ["find-generic-password", "-s", service, "-a", account, "-w"]
      : ["lookup", "service", service, "account", account];
  const result = await ctx.run(command, args);
  if (result.exitCode === 0) return result.stdout.replace(/\n$/, "");
  // secret-tool exits 1 for "not found" and for real failures (no D-Bus, a locked keyring):
  // only a quiet exit 1 means the item is missing.
  if (isMissing(ctx.platform, result)) {
    return undefined;
  }
  return fail(command, result);
}

/** `security -i` reads quoted words, so none of these can be escaped safely: refuse them. */
function checkQuotable(name: string, text: string): void {
  if (/["\\\n\r]/.test(text)) {
    throw new Error(
      `keychain ${name} must not contain a quote, a backslash or a newline`,
    );
  }
}

/** Stores a value. It goes to the command's stdin, so it never shows up in `ps`. */
export async function setKeychainItem(
  ctx: KeychainContext,
  service: string,
  account: string,
  value: string,
): Promise<void> {
  const command = commandFor(ctx.platform);
  checkQuotable("service", service);
  checkQuotable("account", account);
  checkQuotable("value", value);
  const result =
    ctx.platform === "darwin"
      ? await ctx.run(
          command,
          ["-i"],
          `add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`,
        )
      : await ctx.run(
          command,
          [
            "store",
            "--label=donn registry",
            "service",
            service,
            "account",
            account,
          ],
          value,
        );
  if (result.exitCode !== 0) fail(command, result);
}

/** Removes an item. False when it was not there. */
export async function deleteKeychainItem(
  ctx: KeychainContext,
  service: string,
  account: string,
): Promise<boolean> {
  const command = commandFor(ctx.platform);
  const args =
    ctx.platform === "darwin"
      ? ["delete-generic-password", "-s", service, "-a", account]
      : ["clear", "service", service, "account", account];
  const result = await ctx.run(command, args);
  if (result.exitCode === 0) return true;
  if (isMissing(ctx.platform, result)) {
    return false;
  }
  return fail(command, result);
}

export const keychainBackend: SecretBackend = {
  type: "keychain",
  async resolve(path, _config, ctx) {
    const parts = keychainParts(path);
    if (!parts) throw new Error(USAGE);
    return getKeychainItem(ctx, parts.service, parts.account);
  },
};
