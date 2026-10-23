import { readdir, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { ManagedManifest } from "@zzpersona/adapter-sdk";
import type { Context } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { buildBundle } from "./build.js";
import { MANIFEST_PATH, sha256 } from "./bundle-io.js";
import { MACOS_PROFILE, WINDOWS_KEY, type ManagedEnv } from "./env.js";
import { readInstalled, SETTINGS_PATH, under } from "./install.js";

// zzpersona managed check: is what the policy folder holds what zzpersona installed, is it what
// the layers compile to today, and does Claude Code read it? See
// docs/planning/21-managed-settings.md, section 3 ("check states").

export type CheckState =
  "ignored" | "edited" | "overridden" | "stale" | "missing" | "current";

/** Most severe first. */
export const CHECK_STATES: readonly CheckState[] = [
  "ignored",
  "edited",
  "overridden",
  "stale",
  "missing",
  "current",
];

export interface Finding {
  state: CheckState;
  detail: string;
}

export interface CheckResult {
  state: CheckState;
  findings: Finding[];
}

/** Keys that steer how managed sources combine; a source with only these delivers no policy. */
const CONTROL_KEYS = new Set([
  "managedSourcesBehavior",
  "wslInheritsWindowsSettings",
]);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return asObject(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * `ignored`: a higher-ranked managed source (remote, then MDM) delivers a policy, and the
 * highest source that says anything does not set `managedSourcesBehavior: "merge"`. Claude Code
 * then uses that source alone and skips the policy files.
 */
async function ignoredBy(env: ManagedEnv): Promise<Finding | undefined> {
  const mdmName =
    env.os === "windows"
      ? `the MDM policy (${WINDOWS_KEY} Settings)`
      : `the MDM profile (${MACOS_PROFILE})`;
  const sources = [
    {
      name: `the server-managed settings cache (${env.remoteSettingsFile})`,
      policy: await readJson(env.remoteSettingsFile),
    },
    { name: mdmName, policy: await env.mdmPolicy() },
  ];
  const delivers = (p: Record<string, unknown> | undefined) =>
    p !== undefined && Object.keys(p).some((k) => !CONTROL_KEYS.has(k));
  const delivering = sources.find((s) => delivers(s.policy));
  if (delivering === undefined) return undefined;
  // Claude Code reads the behavior from the highest source carrying it or a policy key.
  const decider = sources.find(
    (s) =>
      delivers(s.policy) ||
      (s.policy !== undefined && "managedSourcesBehavior" in s.policy),
  )!;
  if (decider.policy?.managedSourcesBehavior === "merge") return undefined;
  return {
    state: "ignored",
    detail: `${delivering.name} delivers a policy without managedSourcesBehavior: "merge", so Claude Code ignores the policy files`,
  };
}

/** `edited`: every listed file must still hash as installed. */
async function editedFiles(
  root: string,
  files: Record<string, string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [path, expected] of Object.entries(files)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(under(root, path));
    } catch {
      findings.push({ state: "edited", detail: `${path} is missing` });
      continue;
    }
    if (sha256(bytes) !== expected) {
      findings.push({
        state: "edited",
        detail: `${path} was changed since it was installed`,
      });
    }
  }
  return findings;
}

/** Every single (non-list) value in `value`, as [dotted path, value]. */
function singleValues(
  value: Record<string, unknown>,
  prefix: string[] = [],
): [string[], unknown][] {
  return Object.entries(value).flatMap(([key, v]): [string[], unknown][] => {
    const path = [...prefix, key];
    if (Array.isArray(v)) return []; // lists combine across files
    const nested = asObject(v);
    return nested ? singleValues(nested, path) : [[path, v]];
  });
}

/** What `later` does to the value at `path`: undefined when it leaves it alone. */
function replaces(
  later: Record<string, unknown>,
  path: string[],
  ours: unknown,
) {
  let at: unknown = later;
  for (const key of path) {
    const object = asObject(at);
    if (object === undefined) return true; // a single value replaced our whole block
    if (!(key in object)) return false;
    at = object[key];
  }
  return !isDeepStrictEqual(at, ours);
}

/** `overridden`: a drop-in read after ours sets one of our single values to something else. */
async function overriddenBy(root: string): Promise<Finding[]> {
  const ours = await readJson(under(root, SETTINGS_PATH));
  if (ours === undefined) return [];
  const dir = under(root, "managed-settings.d");
  const ourName = SETTINGS_PATH.split("/")[1]!;
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".json") && !n.startsWith(".") && n > ourName)
    .sort();
  const values = singleValues(ours);
  const findings: Finding[] = [];
  for (const name of names) {
    const later = await readJson(under(dir, name));
    if (later === undefined) continue;
    for (const [path, value] of values) {
      if (replaces(later, path, value)) {
        findings.push({
          state: "overridden",
          detail: `managed-settings.d/${name} replaces ${path.join(".")}`,
        });
      }
    }
  }
  return findings;
}

/** `stale`: the installed files differ from a fresh compile of the manifest's deepest layer. */
async function staleness(
  context: () => Promise<Context>,
  installed: ManagedManifest,
): Promise<Finding | undefined> {
  const ref = installed.layers?.at(-1)?.ref;
  if (typeof ref !== "string") {
    return {
      state: "stale",
      detail: `${MANIFEST_PATH} names no layer, so it cannot be compared with a fresh compile`,
    };
  }
  let fresh: Record<string, string>;
  try {
    const result = await buildBundle(await context(), {
      layer: ref,
      os: installed.os,
      fromRegistry: false,
    });
    if (result.bundle === undefined) {
      const refused = result.report.entries.filter(
        (e) => e.outcome === "refused",
      );
      return {
        state: "stale",
        detail: `${ref} no longer compiles to a bundle (${refused.length} refused: ${refused.map((e) => e.path).join(", ")}); run zzpersona managed build`,
      };
    }
    fresh = result.bundle.manifest.files;
  } catch (error) {
    return {
      state: "stale",
      detail: `cannot compile ${ref} to compare: ${errorText(error)}`,
    };
  }
  const paths = [
    ...new Set([...Object.keys(fresh), ...Object.keys(installed.files)]),
  ]
    .filter((p) => fresh[p] !== installed.files[p])
    .sort();
  if (paths.length === 0) return undefined;
  return {
    state: "stale",
    detail: `a fresh compile of ${ref} differs in ${paths.join(", ")}`,
  };
}

/**
 * The state of the managed policy on this machine. Throws `managed-newer-format` when a newer
 * zzpersona installed it. `context` is only created when something is installed.
 */
export async function checkManaged(
  context: Context | (() => Promise<Context>),
  env: ManagedEnv,
): Promise<CheckResult> {
  const lazy = typeof context === "function" ? context : async () => context;
  let installed;
  try {
    installed = await readInstalled(env.root);
  } catch (error) {
    if (
      error instanceof CliError &&
      ["managed-bad-installed", "managed-foreign-path"].includes(error.code)
    ) {
      return {
        state: "edited",
        findings: [{ state: "edited", detail: error.message }],
      };
    }
    throw error;
  }
  if (installed === undefined) {
    return {
      state: "missing",
      findings: [
        { state: "missing", detail: `nothing installed in ${env.root}` },
      ],
    };
  }
  const findings: Finding[] = [];
  const ignored = await ignoredBy(env);
  if (ignored) findings.push(ignored);
  findings.push(...(await editedFiles(env.root, installed.files)));
  findings.push(...(await overriddenBy(env.root)));
  const stale = await staleness(lazy, installed);
  if (stale) findings.push(stale);
  // Stable sort: most severe first, each state's findings in the order found.
  findings.sort(
    (a, b) => CHECK_STATES.indexOf(a.state) - CHECK_STATES.indexOf(b.state),
  );
  return { state: findings[0]?.state ?? "current", findings };
}
