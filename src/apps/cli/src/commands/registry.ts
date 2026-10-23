import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import {
  bundleLayer,
  createClient,
  pollLogin,
  pull,
  readIndex,
  recordPublished,
  RegistryError,
  startLogin,
  type PullChange,
} from "@zzpersona/store-remote";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext, homeOf } from "../context.js";
import { CliError } from "../errors.js";
import { fsStep, writeFileAtomic } from "../fs.js";
import {
  checkedUrl,
  clientFor,
  deleteToken,
  readToken,
  saveToken,
} from "../registry.js";

// login, logout, whoami, pull and publish. See docs/planning/18-registry-contract.md, section 4.

const HINTS: Record<string, string> = {
  "stale-base": "zzpersona pull, then publish again",
  "breaks-descendants": "--force",
};

/** The role a `forbidden` message names: `… needs <role> on <ref>`. */
function grantHint(problem: { message: string; ref?: string }): string {
  const match = /needs (\S+) on (\S+)\s*$/.exec(problem.message);
  const role = match?.[1];
  const ref = problem.ref ?? match?.[2];
  return clean(
    `ask a registry admin for ${role !== undefined ? `${role} on ` : ""}${ref ?? "this layer"}`,
  );
}

/** Server text for a terminal: control characters (escapes, newlines, bells) dropped. */
export function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

/** A sign-in code as people compare it: XXXX-XXXX, the way the confirm page shows it. */
function showCode(code: string): string {
  const plain = clean(code);
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
}

/** A registry failure as a CliError: each problem as `<code>: <message>`, with its hint. */
export function fail(
  error: unknown,
  options: { grantHint?: boolean } = {},
): never {
  if (!(error instanceof RegistryError)) throw error;
  const problems =
    error.problems !== undefined && error.problems.length > 0
      ? error.problems.map((p) => ({
          code: clean(p.code),
          message: clean(p.message),
          ...(p.code === "forbidden" && options.grantHint
            ? { hint: grantHint(p) }
            : HINTS[p.code] !== undefined && { hint: HINTS[p.code] }),
        }))
      : [
          {
            code: error.code,
            message: clean(error.message),
            ...(HINTS[error.code] !== undefined && { hint: HINTS[error.code] }),
          },
        ];
  const text = problems
    .map(
      (p) =>
        `${p.code}: ${p.message}${p.hint !== undefined ? `\n  hint: ${p.hint}` : ""}`,
    )
    .join("\n");
  throw new CliError(problems[0]!.code, text, { problems });
}

const print = (
  io: CliIo,
  json: boolean | undefined,
  text: string,
  data: object,
) => io.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);

async function readAllStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/** A line from the terminal without echoing it; undefined when stdin is not a terminal. */
async function promptHidden(question: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return undefined;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let line = "";
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          done();
          resolve(line);
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new CliError("cancelled", "cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function configWithRegistry(file: string, url: string): Promise<string> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  const doc = parseDocument(text ?? "");
  if (
    doc.errors.length > 0 ||
    !(doc.contents === null || isMap(doc.contents))
  ) {
    throw new CliError("invalid-config", `${file} is not valid; fix it first`, {
      file,
    });
  }
  doc.setIn(["registry", "url"], url);
  return doc.toString();
}

export interface JsonOption {
  json?: boolean;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** The command that opens `href` in the browser. No shell is involved on any platform. */
export function openerCommand(
  platform: string,
  href: string,
): [string, string[]] {
  if (platform === "darwin") return ["open", [href]];
  if (platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", href]];
  }
  return ["xdg-open", [href]];
}

/** Open `href` in the person's browser; never throws and never waits for it. */
async function defaultOpenBrowser(href: string): Promise<void> {
  const [command, args] = openerCommand(process.platform, href);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The link is printed anyway.
  }
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

async function saveLogin(
  io: CliIo,
  home: string,
  url: string,
  token: string,
): Promise<"keychain" | "file"> {
  const store = await saveToken(io, home, url, token);
  const file = join(home, "config.yaml");
  const content = await configWithRegistry(file, url);
  await fsStep(file, () => writeFileAtomic(file, content));
  return store;
}

/** Sign in through the browser: start, show the link and code, poll until confirmed. */
async function browserLogin(
  io: CliIo,
  url: string,
  options: JsonOption & { browser?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const now = io.now ?? Date.now;
  // Ctrl-C is ours only while we wait; other commands keep the default.
  const own = io.signal === undefined ? new AbortController() : undefined;
  const signal = io.signal ?? own!.signal;
  const onSigint = () => own?.abort();
  if (own) process.once("SIGINT", onSigint);
  try {
    let login;
    try {
      login = await startLogin(url, { signal });
    } catch (error) {
      // A route that takes no token cannot answer 401 on purpose: registries before
      // control plane 0.2 check auth before routing, so 401 here means no sign-in.
      if (signal.aborted) return cancelled(io);
      if (
        error instanceof RegistryError &&
        (error.code === "not-found" || error.code === "unauthorized")
      ) {
        throw new CliError(
          "no-sign-in",
          `this registry has no sign-in; use zzpersona login ${url} --token-stdin`,
          { hint: "--token-stdin" },
        );
      }
      fail(error);
    }
    // The link is the server's word: it must lead back to the registry we asked.
    let link: URL;
    try {
      link = new URL(login.verifyUrl);
    } catch {
      link = new URL("about:blank");
    }
    const registryUrl = new URL(url);
    if (
      link.origin !== registryUrl.origin ||
      link.protocol !== registryUrl.protocol
    ) {
      throw new CliError(
        "registry-protocol",
        `registry-protocol: the registry sent a sign-in link for another site (${clean(link.protocol === registryUrl.protocol ? link.origin : link.href.slice(0, 80))})`,
      );
    }
    io.stderr.write(
      `Open ${link.href} and confirm the code ${showCode(login.code)}\n`,
    );
    const skipBrowser = options.browser === false || (io.env.CI ?? "") !== "";
    if (!skipBrowser) {
      // Fire and forget: the link is already printed, whatever the opener does.
      void (io.openBrowser ?? defaultOpenBrowser)(link.href).catch(() => {});
    }
    const started = now();
    // At least a second between polls, whatever the registry asks for.
    let interval = Math.max(1, login.interval);
    for (;;) {
      const remaining = login.expiresIn * 1000 - (now() - started);
      if (remaining <= 0) {
        throw new CliError(
          "login-expired",
          `login timed out; run zzpersona login ${url} again`,
        );
      }
      // Never sleep past the end: there is always a last poll before expiry.
      const wait = Math.min(interval * 1000, remaining);
      await (io.sleep ? io.sleep(wait) : abortableSleep(wait, signal));
      if (signal.aborted) return cancelled(io);
      try {
        const session = await pollLogin(url, login.loginId, login.pollSecret, {
          signal,
        });
        await saveLogin(io, home, url, session.token);
        print(
          io,
          options.json,
          `logged in to ${url} as ${clean(session.subject)} (session until ${clean(dayOf(session.expiresAt))})`,
          { url, subject: session.subject, expiresAt: session.expiresAt },
        );
        return 0;
      } catch (error) {
        if (signal.aborted) return cancelled(io);
        if (error instanceof RegistryError) {
          if (error.code === "authorization-pending") continue;
          if (error.code === "slow-down") {
            interval += 5;
            continue;
          }
          fail(error);
        }
        throw error;
      }
    }
  } finally {
    if (own) process.off("SIGINT", onSigint);
  }
}

function cancelled(io: CliIo): number {
  io.stderr.write("cancelled\n");
  return 130;
}

export async function loginCommand(
  io: CliIo,
  urlArg: string,
  options: JsonOption & {
    token?: boolean;
    tokenStdin?: boolean;
    browser?: boolean;
  },
): Promise<number> {
  const home = homeOf(io);
  const url = checkedUrl(urlArg);
  if (!options.token && !options.tokenStdin) {
    return browserLogin(io, url, options);
  }
  const raw = options.tokenStdin
    ? await (io.stdin ?? readAllStdin)()
    : await (io.readSecret ?? promptHidden)("Registry token: ");
  if (raw === undefined) {
    throw new CliError(
      "token-required",
      "no terminal to ask for the token; pipe it in with --token-stdin",
      { hint: "--token-stdin" },
    );
  }
  const token = raw.trim();
  if (token === "") {
    throw new CliError("token-required", "the token is empty", {
      hint: "--token-stdin",
    });
  }
  let who;
  try {
    who = await createClient({ url, token }).whoami();
  } catch (error) {
    fail(error);
  }
  const store = await saveLogin(io, home, url, token);
  print(io, options.json, `logged in to ${url} as ${clean(who.subject)}`, {
    url,
    subject: who.subject,
    org: who.org,
    tokenStore: store,
  });
  return 0;
}

export async function logoutCommand(
  io: CliIo,
  options: JsonOption,
): Promise<number> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  const removed = await deleteToken(io, home, config.registry?.url ?? "");
  print(io, options.json, removed ? "logged out" : "not logged in", {
    loggedOut: removed,
  });
  return 0;
}

export async function whoamiCommand(
  io: CliIo,
  options: JsonOption,
): Promise<number> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  const url =
    config.registry === undefined ? undefined : checkedUrl(config.registry.url);
  const token = url === undefined ? undefined : await readToken(io, home, url);
  if (url === undefined || token === undefined) {
    print(io, options.json, "not logged in", { loggedIn: false });
    return 0;
  }
  try {
    const who = await createClient({ url, token }).whoami();
    const lines = [`${clean(who.subject)} at ${url}`];
    if (who.kind === "session" && who.expiresAt !== undefined) {
      lines.push(`session until ${clean(dayOf(who.expiresAt))}`);
    }
    if (who.roles !== undefined) {
      lines.push(
        who.roles.length === 0
          ? "roles: none"
          : `roles: ${who.roles.map((r) => `${clean(r.role)} ${clean(r.path)}`).join(", ")}`,
      );
    }
    print(io, options.json, lines.join("\n"), {
      loggedIn: true,
      url,
      ...who,
    });
  } catch (error) {
    fail(error);
  }
  return 0;
}

function changeLine({ ref, from, to }: PullChange): string {
  if (to === undefined) return `${ref} removed`;
  return from === undefined ? `${ref} new @${to}` : `${ref} ${from} → ${to}`;
}

export async function pullCommand(
  io: CliIo,
  options: JsonOption,
): Promise<number> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  const { client, url } = await clientFor(io, home, config);
  let changes: PullChange[];
  try {
    changes = await pull(
      home,
      client,
      url,
      () => new Date((io.now ?? Date.now)()),
    );
  } catch (error) {
    fail(error);
  }
  print(
    io,
    options.json,
    changes.length === 0 ? "up to date" : changes.map(changeLine).join("\n"),
    { changes },
  );
  return 0;
}

export async function publishCommand(
  io: CliIo,
  ref: string,
  options: JsonOption & { dryRun?: boolean; force?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const config = await loadConfig(home, io.env);
  // The local folders only, never the cache: what is published is what is on disk.
  const { store: local } = await createContext(io, { local: true });
  const { client, url } = await clientFor(io, home, config);
  try {
    const { source, files } = await bundleLayer(local, ref);
    const index = await readIndex(home);
    const baseVersion =
      index?.url === url ? (index.layers[ref]?.version ?? 0) : 0;
    const result = await client.publish(ref, {
      source,
      files,
      baseVersion,
      ...(options.dryRun && { dryRun: true }),
      ...(options.force && { force: true }),
    });
    if ("dryRun" in result) {
      const lines = result.diff.map(
        (c) =>
          `${{ added: "+", removed: "-", changed: "~" }[c.change]} ${clean(c.path)}`,
      );
      if (result.broken.length > 0) {
        lines.push(`would break: ${clean(result.broken.join(", "))}`);
      }
      print(
        io,
        options.json,
        [`${ref}: dry run, nothing published`, ...lines].join("\n"),
        { ref, ...result },
      );
      return 0;
    }
    // The registry accepted the publish: whatever happens to the local cache, this is a success,
    // and a retry would only meet stale-base.
    let cacheUpdated = true;
    try {
      const published = await client.getVersion(ref, result.version);
      await recordPublished(home, url, published, AbortSignal.timeout(5000));
    } catch {
      cacheUpdated = false;
      io.stderr.write(
        "warning: the local cache was not updated; run zzpersona pull\n",
      );
    }
    print(
      io,
      options.json,
      "unchanged" in result
        ? `${ref} unchanged @${result.version}`
        : `published ${ref} @${result.version}`,
      { ref, ...result, cacheUpdated },
    );
  } catch (error) {
    fail(error, { grantHint: true });
  }
  return 0;
}
