import type { Mod$ } from "./api.js";

// The daemon route for the mod's commands: `POST /run` over the daemon's socket, so /persona works
// where policy refuses the mod a process, and answers faster where the daemon runs. Never throws:
// any failure means "ask the CLI". See docs/planning/15-mod-transport.md, section 2.

export const DAEMON_TIMEOUT_MS = 1500;

export interface Output {
  exitCode: number;
  stdout: string;
}

/** The session's zzpersona home; literal names, as the engine lists the variables a mod reads. */
async function homeOf($: Mod$): Promise<string | undefined> {
  const home = await $.env.get("ZZPERSONA_HOME");
  if (home) return home;
  const user = await $.env.get("HOME");
  return user ? `${user}/.zzpersona` : undefined;
}

/** A file's trimmed text, or undefined when it is missing or empty. */
async function readText($: Mod$, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined);
  return text?.trim() || undefined;
}

/** One request; the reply's status, and its output when it is a well-formed 200. */
async function post(
  $: Mod$,
  socketPath: string,
  token: string,
  body: string,
): Promise<{ status: number; output?: Output }> {
  const reply = await $.http!.fetch("http://zzpersona/run", {
    method: "POST",
    socketPath,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body,
  });
  if (reply.status !== 200) return { status: reply.status };
  const json = JSON.parse(reply.text) as Partial<Output> | null;
  return typeof json?.exitCode === "number" && typeof json.stdout === "string"
    ? { status: 200, output: { exitCode: json.exitCode, stdout: json.stdout } }
    : { status: 200 };
}

async function ask(
  $: Mod$,
  argv: string[],
  cwd: string,
): Promise<Output | undefined> {
  const home = await homeOf($);
  if (home === undefined) return undefined;
  const socket =
    (await readText($, `${home}/daemon/where`)) ?? `${home}/daemon/sock`;
  // The token goes only to a socket: not a file, and not a link someone could point elsewhere.
  const stat = await $.fs.stat(socket).catch(() => undefined);
  if (stat?.kind !== "other" || stat.isLink) return undefined;
  const body = JSON.stringify({ argv, cwd });
  const tokenPath = `${home}/daemon/token`;
  let token = await readText($, tokenPath);
  if (token === undefined) return undefined;
  let reply = await post($, socket, token, body);
  if (reply.status === 401) {
    // A restarted daemon has a new token: read it again, once.
    token = await readText($, tokenPath);
    if (token === undefined) return undefined;
    reply = await post($, socket, token, body);
  }
  return reply.output;
}

/** The command's output from the daemon, or undefined when the daemon cannot answer. */
export async function viaDaemon(
  $: Mod$,
  argv: string[],
  cwd: string,
): Promise<Output | undefined> {
  // $.http.fetch has no timeout. A late answer settles nothing: the race is already decided.
  let expire!: (value: undefined) => void;
  const late = new Promise<undefined>((resolve) => (expire = resolve));
  let timer: { cancel(): void };
  // An older Claude Code has no $.clock, $.http or $.fs.stat: each call then throws, and the
  // daemon cannot answer, so no guard (the engine's checks want $ spelled $.noun.event(...)).
  try {
    timer = $.clock!.after(DAEMON_TIMEOUT_MS, () => expire(undefined));
  } catch {
    return undefined; // No timer, no daemon: an unanswered request would hang the command.
  }
  try {
    return await Promise.race([ask($, argv, cwd).catch(() => undefined), late]);
  } finally {
    timer.cancel();
  }
}
