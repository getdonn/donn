import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import {
  bundleLayer,
  createClient,
  pull,
  readIndex,
  recordPublished,
  RegistryError,
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

/** A registry failure as a CliError: each problem as `<code>: <message>`, with its hint. */
function fail(error: unknown): never {
  if (!(error instanceof RegistryError)) throw error;
  const problems =
    error.problems !== undefined && error.problems.length > 0
      ? error.problems.map(({ code, message }) => ({
          code,
          message,
          ...(HINTS[code] !== undefined && { hint: HINTS[code] }),
        }))
      : [
          {
            code: error.code,
            message: error.message,
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

export async function loginCommand(
  io: CliIo,
  urlArg: string,
  options: JsonOption & { tokenStdin?: boolean },
): Promise<number> {
  const home = homeOf(io);
  const url = checkedUrl(urlArg);
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
  const store = await saveToken(io, home, url, token);
  const file = join(home, "config.yaml");
  const content = await configWithRegistry(file, url);
  await fsStep(file, () => writeFileAtomic(file, content));
  print(io, options.json, `logged in to ${url} as ${who.subject}`, {
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
    print(io, options.json, `${who.subject} at ${url}`, {
      loggedIn: true,
      url,
      subject: who.subject,
      org: who.org,
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
          `${{ added: "+", removed: "-", changed: "~" }[c.change]} ${c.path}`,
      );
      if (result.broken.length > 0) {
        lines.push(`would break: ${result.broken.join(", ")}`);
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
    fail(error);
  }
  return 0;
}
