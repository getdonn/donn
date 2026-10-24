import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deleteKeychainItem,
  getKeychainItem,
  keychainSupported,
  setKeychainItem,
  type KeychainContext,
} from "@getdonn/secrets";
import type { LocalStore } from "@getdonn/store-local";
import {
  createClient,
  normaliseUrl,
  pull,
  readIndex,
  RegistryError,
  type RegistryClient,
  type RegistryStore,
} from "@getdonn/store-remote";
import type { Ref } from "@getdonn/spec";
import type { CliIo } from "./cli.js";
import { loadConfig, type Config } from "./config.js";
import { homeOf } from "./context.js";
import { CliError } from "./errors.js";
import { writeFileAtomic } from "./fs.js";

// Registry client plumbing for the CLI: where the token lives, the freshness pull, and which
// published versions a resolve used. See docs/planning/18-registry-contract.md, sections 3 and 4.

export const TOKEN_SERVICE = "donn-registry";
export const DEFAULT_MAX_AGE_MINUTES = 15;
const KEYCHAIN_TIMEOUT_MS = 300_000;

/** Spawn `command` with `input` on its stdin; 127 when it is missing, 124 when it times out. */
export function spawnWithInput(
  command: string,
  args: string[],
  input?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, KEYCHAIN_TIMEOUT_MS);
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { exitCode: 127, stdout: "", stderr: error.message }
          : { exitCode: 1, stdout, stderr: error.message },
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        timedOut
          ? {
              exitCode: 124,
              stdout,
              stderr: `${command} timed out after ${KEYCHAIN_TIMEOUT_MS / 1000}s`,
            }
          : { exitCode: code ?? 1, stdout, stderr },
      );
    });
    child.stdin.end(input ?? "");
  });
}

/** The keychain as the registry token uses it: the secret probe's platform, commands with stdin. */
export function keychainContext(io: CliIo): KeychainContext {
  return {
    platform: (io.secretProbe ?? io.probe).platform,
    run: io.runInput ?? spawnWithInput,
  };
}

const tokenFile = (home: string) => join(home, "registry-token");

/** The token: `DONN_REGISTRY_TOKEN`, then the keychain, then `<home>/registry-token`. */
export async function readToken(
  io: CliIo,
  home: string,
  url: string,
): Promise<string | undefined> {
  const fromEnv = io.env.DONN_REGISTRY_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const context = keychainContext(io);
  if (keychainSupported(context.platform)) {
    try {
      const stored = await getKeychainItem(
        context,
        TOKEN_SERVICE,
        normaliseUrl(url),
      );
      if (stored) return stored;
    } catch {
      // A broken keychain falls through to the file.
    }
  }
  try {
    return (await readFile(tokenFile(home), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Keychain on darwin and linux; a 0600 file when there is none or it fails. */
export async function saveToken(
  io: CliIo,
  home: string,
  url: string,
  token: string,
): Promise<"keychain" | "file"> {
  const context = keychainContext(io);
  if (keychainSupported(context.platform)) {
    try {
      await setKeychainItem(context, TOKEN_SERVICE, normaliseUrl(url), token);
      await rm(tokenFile(home), { force: true });
      return "keychain";
    } catch {
      // Fall back to the file; doctor warns about it.
    }
  }
  await writeFileAtomic(tokenFile(home), `${token}\n`, 0o600);
  return "file";
}

/** Remove the stored token from both places; true when there was one. */
export async function deleteToken(
  io: CliIo,
  home: string,
  url: string,
): Promise<boolean> {
  let removed = false;
  const context = keychainContext(io);
  if (keychainSupported(context.platform)) {
    try {
      removed = await deleteKeychainItem(
        context,
        TOKEN_SERVICE,
        normaliseUrl(url),
      );
    } catch {
      // Nothing to remove, or no keychain.
    }
  }
  try {
    await readFile(tokenFile(home));
    await rm(tokenFile(home), { force: true });
    removed = true;
  } catch {
    // no file
  }
  return removed;
}

/** `5m`, `3h`, `2d`. */
export function ageText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Pull when the cache is older than `registry.maxAge`, within `budgetMs` for the whole pull.
 * Quiet without a registry or when fresh; never an error: a missing token or a failed pull prints
 * one line and the cached layers stay in use.
 */
export async function ensureFresh(
  io: CliIo,
  ctx: { home: string; config: Config },
  options: { budgetMs: number },
): Promise<void> {
  const registry = ctx.config.registry;
  if (registry === undefined) return;
  let url: string;
  try {
    url = normaliseUrl(registry.url);
  } catch {
    return;
  }
  const now = io.now ?? Date.now;
  const index = await readIndex(ctx.home);
  const current = index?.url === url ? index : undefined;
  const maxAge = (registry.maxAge ?? DEFAULT_MAX_AGE_MINUTES) * 60_000;
  if (current !== undefined) {
    const pulled = Date.parse(current.pulledAt);
    if (Number.isFinite(pulled) && now() - pulled < maxAge) return;
  }
  const token = await readToken(io, ctx.home, url);
  if (token === undefined) {
    io.stderr.write(`not logged in to ${url}; using cached layers\n`);
    return;
  }
  const signal = AbortSignal.timeout(options.budgetMs);
  try {
    const client = createClient({
      url,
      token,
      signal,
      timeoutMs: options.budgetMs,
    });
    await pull(ctx.home, client, url, () => new Date(now()), signal);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "unauthorized") {
      io.stderr.write(
        `registry refused the token for ${url}; using cached layers \u2014 donn login ${url}\n`,
      );
      return;
    }
    const pulled = current && Date.parse(current.pulledAt);
    // A pulledAt of epoch 0 is an index made by publishing alone: nothing was ever pulled.
    io.stderr.write(
      pulled === undefined
        ? "registry unreachable; no cached layers\n"
        : pulled === 0
          ? "registry unreachable; no layers pulled yet\n"
          : Number.isFinite(pulled)
            ? `registry unreachable; using cached layers from ${ageText(now() - pulled)} ago\n`
            : "registry unreachable; no cached layers\n",
    );
  }
}

/** Load config and freshen: for commands that have not created their context yet. */
export async function freshen(
  io: CliIo,
  options: { budgetMs: number },
): Promise<void> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  await ensureFresh(io, { home, config }, options);
}

/** The published versions a resolve used: `{ ref: version }` for layers that came from the cache. */
export function builtFrom(
  store: LocalStore,
  layers: Ref[],
): Record<string, number> {
  const published = (store as Partial<RegistryStore>).published;
  const out: Record<string, number> = {};
  if (typeof published !== "function") return out;
  for (const ref of layers) {
    const version = published.call(store, ref);
    if (version !== undefined) out[ref] = version;
  }
  return out;
}

/** A client for the configured registry, or the error that says how to set one up. */
export async function clientFor(
  io: CliIo,
  home: string,
  config: Config,
): Promise<{ client: RegistryClient; url: string }> {
  if (config.registry === undefined) {
    throw new CliError(
      "no-registry",
      "no registry configured; run `donn login <url>`",
      { hint: "donn login <url> --token-stdin" },
    );
  }
  const url = checkedUrl(config.registry.url);
  const token = await readToken(io, home, url);
  if (token === undefined) {
    throw new CliError(
      "not-logged-in",
      `not logged in to ${url}; run \`donn login ${url}\``,
      { hint: `donn login ${url} --token-stdin` },
    );
  }
  return { client: createClient({ url, token }), url };
}

/** `normaliseUrl`, with its failure as a CliError. */
export function checkedUrl(url: string): string {
  try {
    return normaliseUrl(url);
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new CliError(error.code, error.message);
    }
    throw error;
  }
}
