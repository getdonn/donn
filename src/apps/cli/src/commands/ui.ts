import { request } from "node:http";
import type { CliIo } from "../cli.js";
import { loadConfig } from "../config.js";
import { homeOf } from "../context.js";
import { ensureDaemon } from "../daemon/autostart.js";
import { connectDaemon } from "../daemon/client.js";
import { updateFix } from "../daemon/service.js";
import { CliError } from "../errors.js";
import { cliVersion } from "./daemon.js";
import { defaultOpenBrowser } from "./registry.js";

// donn ui: the daemon's loopback bridge serves the app; this asks for its port and a one-time
// sign-in code and opens them in the browser. See docs/planning/26-gui.md §1.

export interface UiOptions {
  /** commander's `--no-open` sets this to false. */
  open?: boolean;
  port?: string;
  json?: boolean;
}

const BUILD_FIX = "pnpm --filter @getdonn/ui build";

function parsePort(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1024 || port > 65535) {
    throw new CliError(
      "usage",
      `--port must be a whole number from 1024 to 65535, not ${text}`,
    );
  }
  return port;
}

/** Whether the bridge serves the app: false when it answers 503 `ui-not-built`. */
function appBuilt(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/",
        headers: { host: `127.0.0.1:${port}` },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== 503);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(true));
    req.end();
  });
}

export async function uiCommand(
  io: CliIo,
  options: UiOptions,
): Promise<number> {
  const port = parsePort(options.port);
  const home = homeOf(io);
  const config = await loadConfig(home, io.env, io.passwdHome);
  await ensureDaemon(io, home, config);
  const client = await connectDaemon(home, {
    version: cliVersion(),
    warn: (message) => io.stderr.write(`${message}\n`),
    fix: () => updateFix(io, home),
  });
  if (client === undefined) {
    throw new CliError("daemon", "daemon: not running", {
      fix: "donn daemon start",
    });
  }
  const opened = await client.openUi(port);
  if (!(await appBuilt(opened.port))) {
    io.stderr.write(
      `donn: the app is not built, so the page will not load; ${BUILD_FIX}\n`,
    );
  }
  const base = `http://127.0.0.1:${opened.port}/`;
  const url = `${base}#t=${opened.code}`;
  if (options.json) {
    if (options.open !== false) {
      await (io.openBrowser ?? defaultOpenBrowser)(url).catch(() => {});
    }
    io.stdout.write(`${JSON.stringify({ url, port: opened.port }, null, 2)}\n`);
    return 0;
  }
  if (options.open === false) {
    io.stdout.write(
      `donn ui at ${url}\nopen it in a browser on this machine; the code works once and expires in 60 s\n`,
    );
    return 0;
  }
  await (io.openBrowser ?? defaultOpenBrowser)(url).catch(() => {});
  io.stdout.write(`donn ui at ${base} (opened in your browser)\n`);
  return 0;
}
