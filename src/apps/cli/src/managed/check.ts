import { readFile } from "node:fs/promises";
import { KNOWN_MANAGED_KEYS } from "@getdonn/adapter-claude-code";
import type { ManagedManifest } from "@getdonn/adapter-sdk";
import type { Context } from "../context.js";
import { CliError, errorText } from "../errors.js";
import { buildBundle } from "./build.js";
import { MANIFEST_PATH, sha256 } from "./bundle-io.js";
import {
  asObject,
  differing,
  earlierReplaced,
  policyFiles,
  readJson,
  SETTINGS_PATH,
} from "./drop-ins.js";
import { MACOS_PROFILE, WINDOWS_KEY, type ManagedEnv } from "./env.js";
import { readInstalled, readPending, under } from "./install.js";

// donn managed check: is what the policy folder holds what donn installed, is it what
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
  /** What to do about it, when the state's general advice does not fit. */
  fix?: string;
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

/**
 * Settings keys that make a managed source deliver a policy: the managed keys the adapter knows
 * and the ordinary settings an organisation sets (code.claude.com/docs/en/settings). Anything
 * else (a cache's checksum or timestamps, a key from a newer Claude Code) is not counted.
 */
const SETTINGS_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_MANAGED_KEYS,
  "hooks",
  "disableAllHooks",
  "model",
  "statusLine",
  "outputStyle",
  "companyAnnouncements",
  "includeCoAuthoredBy",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "alwaysThinkingEnabled",
  "spinnerTipsEnabled",
]);

/**
 * `ignored`: a higher-ranked managed source (remote, then MDM) delivers a policy, and the
 * highest source that says anything does not set `managedSourcesBehavior: "merge"`. Claude Code
 * then uses that source alone and skips the policy files.
 */
const delivers = (p: Record<string, unknown> | undefined | null) =>
  p !== undefined &&
  p !== null &&
  Object.keys(p).some((k) => SETTINGS_KEYS.has(k) && !CONTROL_KEYS.has(k));

/** The settings in a remote-settings cache: a bare settings object or `{ settings: {…}, … }`. */
async function readRemote(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  const file = await readJson(path);
  return asObject(file?.settings) ?? file;
}

async function ignoredBy(env: ManagedEnv): Promise<Finding | undefined> {
  const mdmName =
    env.os === "windows"
      ? `the MDM policy (${WINDOWS_KEY} Settings)`
      : `the MDM profile (${MACOS_PROFILE})`;
  const sources = [
    {
      name: `the server-managed settings cache (${env.remoteSettingsFile})`,
      policy: await readRemote(env.remoteSettingsFile),
    },
    { name: mdmName, policy: await env.mdmPolicy().catch(() => null) },
  ];
  // A profile Claude Code cannot read stops it from starting; either way, it is not our files.
  const broken = sources.find((s) => s.policy === null);
  const remote = sources[0]!;
  if (broken && !delivers(remote.policy)) {
    return {
      state: "ignored",
      detail: `MDM profile present but unreadable: ${broken.name}`,
    };
  }
  const delivering = sources.find((s) => delivers(s.policy));
  if (delivering === undefined) return undefined;
  // Claude Code reads the behavior from the highest source carrying it or a policy key.
  const decider = sources.find(
    (s) =>
      delivers(s.policy) ||
      (s.policy != null && "managedSourcesBehavior" in s.policy),
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

/** `overridden`: a drop-in read after ours sets one of our single values to something else. */
async function overriddenBy(
  root: string,
  ours: Record<string, unknown>,
): Promise<Finding[]> {
  return (await differing(root, await policyFiles(root, "after"), ours)).map(
    ({ file, key }) => ({
      state: "overridden",
      detail: `${file} replaces ${key}`,
    }),
  );
}

const PULLED_NOTE =
  "compared with the layers pulled locally; run donn pull for the latest";

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
  let pulled: boolean;
  try {
    const ctx = await context();
    pulled = ctx.config.registry !== undefined;
    // Built elsewhere (say, by an admin for many machines): nothing here to compare with.
    if (!(await ctx.store.list()).includes(ref)) {
      return {
        state: "current",
        detail: `cannot check for newer layers: ${ref} is not in the store`,
      };
    }
    const result = await buildBundle(ctx, {
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
        detail: `${ref} no longer compiles to a bundle (${refused.length} refused: ${refused.map((e) => e.path).join(", ")}); run donn managed build`,
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
  // No network in check: with a registry, "fresh" means the layers last pulled.
  const local = pulled ? PULLED_NOTE : undefined;
  if (paths.length === 0) return local && { state: "current", detail: local };
  return {
    state: "stale",
    detail: `a fresh compile of ${ref} differs in ${paths.join(", ")}${local ? `; ${local}` : ""}`,
  };
}

/**
 * The state of the managed policy on this machine. Throws `managed-newer-format` when a newer
 * donn installed it. `context` is only created when something is installed.
 */
export async function checkManaged(
  context: Context | (() => Promise<Context>),
  env: ManagedEnv,
): Promise<CheckResult> {
  const lazy = typeof context === "function" ? context : async () => context;
  let installed;
  let pending;
  try {
    installed = await readInstalled(env.root);
    pending = await readPending(env.root);
  } catch (error) {
    if (error instanceof CliError && error.code === "managed-bad-installed") {
      const path = String(error.details.path);
      return {
        state: "edited",
        findings: [
          {
            state: "edited",
            detail: error.message,
            fix: `remove ${path} by hand, then remove or reinstall the files it listed`,
          },
        ],
      };
    }
    throw error;
  }
  const interrupted: Finding[] =
    pending === undefined
      ? []
      : [
          {
            state: "edited",
            detail:
              "an interrupted install; re-run donn managed install or uninstall",
          },
        ];
  if (installed === undefined && pending !== undefined) {
    return { state: "edited", findings: interrupted };
  }
  if (installed === undefined) {
    return {
      state: "missing",
      findings: [
        { state: "missing", detail: `nothing installed in ${env.root}` },
      ],
    };
  }
  const findings: Finding[] = [...interrupted];
  const ignored = await ignoredBy(env);
  if (ignored) findings.push(ignored);
  findings.push(...(await editedFiles(env.root, installed.files)));
  const ours = await readJson(under(env.root, SETTINGS_PATH));
  if (ours !== undefined) {
    findings.push(...(await overriddenBy(env.root, ours)));
    // Claude Code reads ours later, so ours wins; a note, not a state.
    for (const { key, file } of await earlierReplaced(env.root, ours)) {
      findings.push({
        state: "current",
        detail: `${SETTINGS_PATH} replaces ${key} from ${file}`,
      });
    }
  }
  const stale = await staleness(lazy, installed);
  if (stale) findings.push(stale);
  // Stable sort: most severe first, each state's findings in the order found.
  findings.sort(
    (a, b) => CHECK_STATES.indexOf(a.state) - CHECK_STATES.indexOf(b.state),
  );
  return { state: findings[0]?.state ?? "current", findings };
}
