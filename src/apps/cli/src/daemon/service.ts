import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Probe } from "@zzpersona/adapter-sdk";
import type { CliIo } from "../cli.js";
import { homeOf } from "../context.js";
import { CliError } from "../errors.js";
import { currentUid } from "./paths.js";

// The daemon as a login service: a launchd agent on macOS, a systemd user unit on Linux.
// launchctl and systemctl run through the injected probe. See docs/planning/16-daemon-service.md §1.

export interface ServiceSpec {
  command: string[];
  env: Record<string, string>;
  log: string;
}

export interface ServiceManager {
  kind: "launchd" | "systemd";
  label: string;
  /** The service file. */
  path: string;
  /** The service file's text; pure. */
  render(spec: ServiceSpec): string;
  /** Write the file and (re)load it. */
  install(spec: ServiceSpec): Promise<void>;
  /** Unload the service (not loaded is fine) and remove its file. */
  uninstall(): Promise<void>;
  start(): Promise<void>;
  loaded(): Promise<boolean>;
}

const LABEL = "zzpersona.daemon";
/** How long a reinstall waits for launchd to let go of the old job. */
const UNLOAD_WAIT_MS = 5_000;
const UNLOAD_POLL_MS = 50;
const UNIT = "zzpersona-daemon";

type ServiceIo = Pick<CliIo, "env" | "probe">;

/** The manager tests inject, else the platform's. */
export const serviceOf = (io: CliIo): ServiceManager | undefined =>
  io.service ?? serviceManager(io);

/** The platform's manager, or undefined on Windows (or without a HOME to put the file in). */
export function serviceManager(io: ServiceIo): ServiceManager | undefined {
  const home = io.env.HOME;
  if (io.probe.platform === "win32" || !home) return undefined;
  // Test-only: a scratch label, so the e2e never touches the real service.
  const override = io.env.ZZPERSONA_SERVICE_LABEL;
  return io.probe.platform === "darwin"
    ? launchd(io.probe, home, override ?? LABEL)
    : systemd(
        io.probe,
        io.env.XDG_CONFIG_HOME || join(home, ".config"),
        override ?? UNIT,
      );
}

export interface InstalledService {
  /** The `zzpersona` the file runs ("" when the file names none). */
  command: string;
  /** The file's environment. */
  env: Record<string, string>;
}

/** What the installed file runs, or undefined when no file. */
export async function installedService(
  manager: ServiceManager,
): Promise<InstalledService | undefined> {
  const text = await readFile(manager.path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  if (manager.kind === "launchd") {
    const command =
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
        text,
      )?.[1];
    const vars =
      /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
        text,
      )?.[1] ?? "";
    const env: Record<string, string> = {};
    for (const [, key, value] of vars.matchAll(
      /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g,
    )) {
      env[xmlUnescape(key!)] = xmlUnescape(value!);
    }
    return { command: command === undefined ? "" : xmlUnescape(command), env };
  }
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const [, quoted] of text.matchAll(/^Environment=(".*")$/gm)) {
    const pair = unitUnescape(firstUnitWord(quoted!));
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { command: unitUnescape(firstUnitWord(line)), env };
}

/** The installed file's command path, or undefined when no file. */
export async function installedCommand(
  manager: ServiceManager,
): Promise<string | undefined> {
  return (await installedService(manager))?.command;
}

/** The home the installed service's daemon serves: its ZZPERSONA_HOME, else the default home. */
export function serviceHome(io: CliIo, installed: InstalledService): string {
  return homeOf({
    ...io,
    env: { ...io.env, ZZPERSONA_HOME: installed.env.ZZPERSONA_HOME },
  });
}

/** The service, when its file is installed for `home`; else undefined. */
export async function serviceFor(
  io: CliIo,
  home: string,
): Promise<
  { manager: ServiceManager; installed: InstalledService } | undefined
> {
  const manager = serviceOf(io);
  const installed = manager && (await installedService(manager));
  if (!manager || !installed || serviceHome(io, installed) !== home)
    return undefined;
  return { manager, installed };
}

async function writeServiceFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o644 });
  await chmod(path, 0o644);
}

async function run(probe: Probe, command: string, args: string[]) {
  const result = await probe.run(command, args);
  if (result.exitCode !== 0) {
    const said = result.stderr.trim() || `exit code ${result.exitCode}`;
    throw new CliError(
      "service",
      `${command} ${args.join(" ")} failed: ${said}`,
      { command: [command, ...args], exitCode: result.exitCode },
    );
  }
}

// launchd

const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnescape = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function launchd(probe: Probe, home: string, label: string): ServiceManager {
  const path = join(home, "Library/LaunchAgents", `${label}.plist`);
  const domain = `gui/${currentUid()}`;
  const target = `${domain}/${label}`;
  const string = (value: string, indent: string) =>
    `${indent}<string>${xmlEscape(value)}</string>\n`;
  const render = (spec: ServiceSpec) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n',
      '<plist version="1.0">\n',
      "<dict>\n",
      "\t<key>Label</key>\n",
      string(label, "\t"),
      "\t<key>ProgramArguments</key>\n",
      "\t<array>\n",
      ...spec.command.map((arg) => string(arg, "\t\t")),
      "\t</array>\n",
      "\t<key>EnvironmentVariables</key>\n",
      "\t<dict>\n",
      ...Object.entries(spec.env).flatMap(([key, value]) => [
        `\t\t<key>${xmlEscape(key)}</key>\n`,
        string(value, "\t\t"),
      ]),
      "\t</dict>\n",
      "\t<key>RunAtLoad</key>\n",
      "\t<true/>\n",
      "\t<key>KeepAlive</key>\n",
      "\t<dict>\n",
      "\t\t<key>SuccessfulExit</key>\n",
      "\t\t<false/>\n",
      "\t</dict>\n",
      "\t<key>ProcessType</key>\n",
      string("Background", "\t"),
      "\t<key>StandardOutPath</key>\n",
      string(spec.log, "\t"),
      "\t<key>StandardErrorPath</key>\n",
      string(spec.log, "\t"),
      "</dict>\n",
      "</plist>\n",
    ].join("");
  const unload = () => probe.run("launchctl", ["bootout", target]);
  const loaded = async () =>
    (await probe.run("launchctl", ["print", target])).exitCode === 0;
  return {
    kind: "launchd",
    label,
    path,
    render,
    install: async (spec) => {
      await writeServiceFile(path, render(spec));
      // Not loaded, or loaded but broken: either way bootstrap decides. bootout returns before
      // the job is gone, and a bootstrap too soon fails: wait until print no longer finds it.
      await unload();
      const deadline = Date.now() + UNLOAD_WAIT_MS;
      while (await loaded()) {
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, UNLOAD_POLL_MS));
      }
      await run(probe, "launchctl", ["bootstrap", domain, path]);
    },
    uninstall: async () => {
      await unload();
      await rm(path, { force: true });
    },
    start: () => run(probe, "launchctl", ["kickstart", target]),
    loaded,
  };
}

// systemd

/** A unit file value: `%` specifiers doubled; `$` doubled where ExecStart would expand it. */
const unitEscape = (value: string, exec: boolean) => {
  let out = value.replace(/%/g, "%%");
  if (exec) out = out.replace(/\$/g, "$$$$");
  return out;
};
const unitQuote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const unitUnescape = (value: string) =>
  value.replace(/\$\$/g, "$").replace(/%%/g, "%");

/** The first word of an ExecStart line, its quotes and backslash escapes undone. */
function firstUnitWord(line: string): string {
  if (!line.startsWith('"')) return line.split(/\s/)[0] ?? "";
  let word = "";
  for (let i = 1; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") word += line[++i] ?? "";
    else if (c === '"') break;
    else word += c;
  }
  return word;
}

function systemd(probe: Probe, config: string, stem: string): ServiceManager {
  const unit = `${stem}.service`;
  const path = join(config, "systemd/user", unit);
  const systemctl = (...args: string[]) => ["--user", ...args];
  const execWord = (word: string) => {
    const escaped = unitEscape(word, true);
    return /[\s"'\\]/.test(escaped) ? unitQuote(escaped) : escaped;
  };
  const render = (spec: ServiceSpec) =>
    [
      "[Unit]\n",
      "Description=zzpersona daemon\n",
      "\n",
      "[Service]\n",
      `ExecStart=${spec.command.map(execWord).join(" ")}\n`,
      ...Object.entries(spec.env).map(
        ([key, value]) =>
          `Environment=${unitQuote(`${key}=${unitEscape(value, false)}`)}\n`,
      ),
      "Restart=on-failure\n",
      "\n",
      "[Install]\n",
      "WantedBy=default.target\n",
    ].join("");
  const unload = () =>
    probe.run("systemctl", systemctl("disable", "--now", unit));
  return {
    kind: "systemd",
    label: stem,
    path,
    render,
    install: async (spec) => {
      await writeServiceFile(path, render(spec));
      await unload();
      await run(probe, "systemctl", systemctl("daemon-reload"));
      await run(probe, "systemctl", systemctl("enable", "--now", unit));
    },
    uninstall: async () => {
      await unload();
      await rm(path, { force: true });
      await run(probe, "systemctl", systemctl("daemon-reload"));
    },
    start: () => run(probe, "systemctl", systemctl("start", unit)),
    loaded: async () =>
      (await probe.run("systemctl", systemctl("is-enabled", unit))).exitCode ===
      0,
  };
}
