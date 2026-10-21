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

export const keychainBackend: SecretBackend = {
  type: "keychain",
  async resolve(path, _config, ctx) {
    const parts = keychainParts(path);
    if (!parts) throw new Error(USAGE);
    const { service, account } = parts;
    let command: string;
    let args: string[];
    let missing: number;
    if (ctx.platform === "darwin") {
      command = "security";
      args = ["find-generic-password", "-s", service, "-a", account, "-w"];
      missing = 44;
    } else if (ctx.platform === "linux") {
      command = "secret-tool";
      args = ["lookup", "service", service, "account", account];
      missing = 1;
    } else {
      throw new Error(`keychain is not supported on ${ctx.platform}`);
    }
    const result = await ctx.run(command, args);
    if (result.exitCode === 0) return result.stdout.replace(/\n$/, "");
    if (result.exitCode === missing) return undefined;
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
  },
};
