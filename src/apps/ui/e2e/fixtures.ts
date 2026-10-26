import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

// A daemon per worker on a temporary home, seeded as the CLI's tests are
// (src/apps/cli/src/test/seed.ts: resolver fixture 002 across the personas root and a
// project), started by the built `donn ui --no-open --json`. Each test gets a fresh sign-in URL.
// Never the real home: DONN_HOME and HOME both point into the temp folder.

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../cli/dist/bin.js");
const UI = join(HERE, "../../cli/dist/ui/index.html");
const FIXTURE = join(
  HERE,
  "../../../packages/resolver/fixtures/002-full-stack/personas",
);

export interface Donn {
  root: string;
  home: string;
  /** A project the daemon knows (recorded in ui.json). */
  repo: string;
  /** A second project, not yet known: for "Add project…". */
  other: string;
  /** What the fake `$VISUAL` was started with, one line per start (its argv). */
  editorLog: string;
  /** The personas folder (org/, area/, team/). */
  personas: string;
  /** Runs the built CLI against the temp home. */
  cli(args: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  /** A new `donn ui` URL, with a one-time code. */
  url(): string;
  /**
   * Registers a running session, as `donn claude|codex` does (src/apps/cli/src/session.ts): a
   * launch record whose process is this worker, which is alive. Returns its folder.
   */
  session(launched: {
    harness: "claude-code" | "codex";
    persona: string;
    project: string;
  }): string;
}

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A project folder with fixture 002's project persona and the files it names. */
function project(dir: string) {
  cpSync(
    join(FIXTURE, "project/checkout-api.yaml"),
    join(dir, ".donn/persona.yaml"),
  );
  // An agent, an MCP server naming one secret twice and a default model, for each group.
  appendFileSync(
    join(dir, ".donn/persona.yaml"),
    `agents:
  define:
    bot: { template: "eve:blank", target: local }
models:
  default: anthropic/claude-opus-4.5
mcp:
  servers:
    ledger:
      command: ledger-mcp
      env: { PRIMARY: "secret://vault/ledger", REPLICA: "secret://vault/ledger" }
`,
  );
  put(
    join(dir, ".donn/instructions/checkout-overview.md"),
    "Checkout overview text.",
  );
  put(join(dir, ".donn/hooks/format.sh"), "#!/bin/sh\nexit 0\n");
}

/** An executable that appends its arguments, space-joined, to `log`; returns its path. */
function editor(root: string, log: string) {
  const script = join(root, "fake-editor.sh");
  put(script, `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(script, 0o755);
  return script;
}

function seed(): Omit<Donn, "cli" | "url" | "session"> {
  // Resolved: macOS's tmpdir is a symlink, and the daemon reports real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "donn-ui-e2e-")));
  const home = join(root, "home");
  const personas = join(root, "personas");
  const repo = join(root, "checkout-api");
  const other = join(root, "other-service");
  for (const layer of ["org", "area", "team"]) {
    cpSync(join(FIXTURE, layer), join(personas, layer), { recursive: true });
  }
  cpSync(join(FIXTURE, "user/overrides.yaml"), join(home, "overrides.yaml"));
  put(join(home, "config.yaml"), `personas: ${personas}\n`);
  // A gateway for model calls, set by the org layer.
  appendFileSync(
    join(personas, "org/base.yaml"),
    "models:\n  gateway: { type: vercel-ai-gateway }\n",
  );
  put(join(personas, "org/instructions/conduct.md"), "Review kindly.");
  put(join(personas, "org/hooks/block-prod-db.sh"), "#!/bin/sh\nexit 0\n");
  put(
    join(personas, "team/skills/run-payment-sim/SKILL.md"),
    "---\nname: run-payment-sim\ndescription: Runs the payment simulator.\n---\nRun pnpm sim.\n",
  );
  project(repo);
  project(other);
  put(join(home, "ui.json"), `${JSON.stringify({ projects: [repo] })}\n`);
  mkdirSync(join(root, "user-home"), { recursive: true });
  const editorLog = join(root, "editor-argv.txt");
  return { root, home, repo, other, editorLog, personas };
}

export const test = base.extend<{ signIn: string }, { donn: Donn }>({
  donn: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures it needs from this
    async ({}, use) => {
      if (!existsSync(BIN) || !existsSync(UI)) {
        throw new Error(
          "the built CLI with its app is missing: pnpm turbo run build --filter=@getdonn/cli",
        );
      }
      const seeded = seed();
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        DONN_HOME: seeded.home,
        HOME: join(seeded.root, "user-home"),
        // The bridge opens files with $VISUAL (never $EDITOR): a script that records its argv.
        VISUAL: editor(seeded.root, seeded.editorLog),
        TMPDIR: process.env.TMPDIR,
      };
      const cli: Donn["cli"] = (args) => {
        const r = spawnSync(process.execPath, [BIN, ...args], {
          cwd: seeded.repo,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      };
      const url = () => {
        const r = cli(["ui", "--no-open", "--json"]);
        if (r.status !== 0) {
          throw new Error(
            `donn ui failed (${r.status}): ${r.stdout}${r.stderr}`,
          );
        }
        return (JSON.parse(r.stdout) as { url: string }).url;
      };
      let sessions = 0;
      const session: Donn["session"] = (launched) => {
        const dir = join(seeded.home, "sessions", `e2e-${++sessions}`);
        put(
          join(dir, "launched.json"),
          `${JSON.stringify({
            ...launched,
            source: "switch",
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })}\n`,
        );
        return dir;
      };
      try {
        await use({ ...seeded, cli, url, session });
      } finally {
        cli(["daemon", "stop"]);
        rmSync(seeded.root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  signIn: async ({ donn }, use) => {
    await use(donn.url());
  },
});

export { expect } from "@playwright/test";
