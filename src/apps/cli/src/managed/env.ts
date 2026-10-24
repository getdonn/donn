import { existsSync, rmSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { MANAGED_ROOTS } from "@getdonn/adapter-claude-code";
import type { ManagedOs } from "@getdonn/adapter-sdk";
import type { CliIo } from "../cli.js";
import { defaultOs } from "./build.js";

// Everything `managed install|uninstall|check` reads or writes outside the bundle comes from
// here: the system folder, the MDM reader, the remote-settings cache, the admin test and the
// confirmation prompt. Tests replace any of it through `CliIo.managed`; bin.ts never sets it.
// See docs/planning/21-managed-settings.md, section 3 ("One injectable root").

export interface ManagedEnv {
  os: ManagedOs;
  /** The policy folder Claude Code reads (MANAGED_ROOTS[os]). */
  root: string;
  /** Root on POSIX; on Windows, allowed to write the policy folder. */
  isAdmin(): boolean;
  /** True when policy folders must be root's (running as root on POSIX). */
  strict(): boolean;
  /** lstat of a path (owner uid, permission bits), or undefined when it does not exist. */
  inspect(path: string): Promise<PathInfo | undefined>;
  /**
   * Parsed MDM policy (macOS profile via `plutil -convert json -o -`, Windows `reg query`), or
   * undefined when there is none. Throws when one is present but cannot be read or parsed.
   */
  mdmPolicy(): Promise<Record<string, unknown> | undefined>;
  /** `<CLAUDE_CONFIG_DIR or ~/.claude>/remote-settings.json` */
  remoteSettingsFile: string;
  /** Asks a yes/no question; undefined when there is no terminal to ask on. */
  confirm(question: string): Promise<boolean | undefined>;
  /** Called before each policy file is written; tests throw from it to simulate a crash. */
  onWrite?(path: string): void;
}

export interface PathInfo {
  kind: "dir" | "file" | "symlink" | "other";
  uid: number;
  /** Permission bits (mode & 0o7777). */
  mode: number;
}

async function lstatInfo(path: string): Promise<PathInfo | undefined> {
  try {
    const info = await lstat(path);
    return {
      kind: info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "dir"
          : info.isFile()
            ? "file"
            : "other",
      uid: info.uid,
      mode: info.mode & 0o7777,
    };
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return undefined;
    throw error;
  }
}

export const MACOS_PROFILE =
  "/Library/Managed Preferences/com.anthropic.claudecode.plist";
export const WINDOWS_KEY = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** `plutil -convert json -o - <plist>` output as an object, or undefined. */
export function parsePlutilJson(
  stdout: string,
): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

/** The `Settings` value (REG_SZ or REG_EXPAND_SZ, JSON) from `reg query ... /v Settings`. */
export function parseRegQuery(
  stdout: string,
): Record<string, unknown> | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+Settings\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (match) return parsePlutilJson(match[1]!.trim());
  }
  return undefined;
}

/** Windows: can this process create a file in the root (or the folder that would hold it)? */
function canWriteRoot(root: string): boolean {
  let dir = root;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  const probe = join(dir, `.donn-admin-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** A yes/no question on the terminal; undefined when stdin is not one. */
async function promptYesNo(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function managedEnv(io: CliIo): ManagedEnv {
  const seam = io.managed ?? {};
  const os = seam.os ?? defaultOs();
  const root = seam.root ?? MANAGED_ROOTS[os];
  const configDir =
    io.env.CLAUDE_CONFIG_DIR || join(io.env.HOME ?? homedir(), ".claude");
  return {
    os,
    root,
    strict:
      seam.strict ??
      (() => process.platform !== "win32" && process.getuid?.() === 0),
    inspect: seam.inspect ?? lstatInfo,
    ...(seam.onWrite && { onWrite: seam.onWrite }),
    isAdmin:
      seam.isAdmin ??
      (() =>
        os === "windows" ? canWriteRoot(root) : process.getuid?.() === 0),
    mdmPolicy:
      seam.mdmPolicy ??
      (async () => {
        if (os === "macos") {
          if (!existsSync(MACOS_PROFILE)) return undefined;
          const r = await io.probe.run("plutil", [
            "-convert",
            "json",
            "-o",
            "-",
            MACOS_PROFILE,
          ]);
          const policy =
            r.exitCode === 0 ? parsePlutilJson(r.stdout) : undefined;
          if (policy === undefined) {
            throw new Error(`plutil could not read ${MACOS_PROFILE}`);
          }
          return policy;
        }
        if (os === "windows") {
          const r = await io.probe.run("reg", [
            "query",
            WINDOWS_KEY,
            "/v",
            "Settings",
          ]);
          // Exit 1: no Settings value. Anything else that does not parse is a broken policy.
          if (r.exitCode !== 0) return undefined;
          const policy = parseRegQuery(r.stdout);
          if (policy === undefined) {
            throw new Error(`${WINDOWS_KEY} Settings is not a JSON object`);
          }
          return policy;
        }
        return undefined;
      }),
    remoteSettingsFile:
      seam.remoteSettingsFile ?? join(configDir, "remote-settings.json"),
    confirm: seam.confirm ?? promptYesNo,
  };
}
