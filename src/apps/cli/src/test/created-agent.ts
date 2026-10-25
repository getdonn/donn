import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Probe } from "@getdonn/adapter-sdk";
import { expect } from "vitest";
import { fakeEve, type FakeEve } from "./fake-eve.js";
import { zz, type Seeded } from "./seed.js";

// Test-only: a seeded project whose persona declares agent `kody` on a path template, and a
// way to create it with a fake eve, for the commands that work on a created agent.

/** The secret values the persona's refs resolve to, from the env provider. */
export const SECRETS = { GATEWAY_KEY: "sk-gw-SECRET", API_TOKEN: "tok-SECRET" };

export const AGENT_PERSONA = (target = "local") => `apiVersion: donn/v0
kind: Persona
metadata:
  name: checkout-api
extends:
  - team/payments
instructions:
  - id: checkout-overview
    position: replace(payments-overview)
    inline: Checkout overview.
models:
  gateway:
    type: openai-compatible
    baseURL: https://llm.corp/v1
    apiKey: secret://env/GATEWAY_KEY
  default: gpt-5
agents:
  define:
    kody:
      template: ./templates/kody
      target: ${target}
      env:
        GREETING: hello
        API_TOKEN: secret://env/API_TOKEN
targets:
  eve:
    contextWindow: 128000
`;

/**
 * Answers `npm view eve versions`, `npm view vercel version` and `docker` (one line per entry of
 * `containers`, each a container state such as `running` or `exited`, as `docker ps -a --format
 * {{.State}}` prints); anything else fails. `docker` records each call in `dockerCalls`.
 */
export function agentProbe(containers: string[] = []): Probe & {
  dockerCalls: string[][];
} {
  const dockerCalls: string[][] = [];
  return {
    dockerCalls,
    platform: process.platform,
    readFile: async () => undefined,
    listDir: async () => undefined,
    run: async (command, args) => {
      if (command === "npm" && args[1] === "eve")
        return { exitCode: 0, stdout: '["0.83.2"]', stderr: "" };
      if (command === "npm" && args[1] === "vercel")
        return { exitCode: 0, stdout: "50.1.0\n", stderr: "" };
      if (command === "docker") {
        dockerCalls.push(args);
        return {
          exitCode: 0,
          stdout: containers.map((c) => `${c}\n`).join(""),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
    },
  };
}

/** A fake eve whose installs succeed, for `create`. */
export function installingEve(): FakeEve {
  return fakeEve({
    replies: [
      {
        when: (c) => c.command === "pnpm",
        effect: (c) => {
          mkdirSync(join(c.cwd, "node_modules/eve"), { recursive: true });
        },
      },
    ],
  });
}

/** Writes the persona and the template of agent `kody` into the seeded repo. */
export function agentProject(s: Seeded, target = "local"): void {
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(s.repo, path)), { recursive: true });
    writeFileSync(join(s.repo, path), text);
  };
  put(".donn/persona.yaml", AGENT_PERSONA(target));
  put(".donn/templates/kody/package.json", '{ "name": "kody" }\n');
  put(
    ".donn/templates/kody/agent/agent.ts",
    'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-6-luna-fast" });\n',
  );
}

/** Creates agent `kody` in the seeded repo (see agentProject). */
export async function createAgent(s: Seeded): Promise<void> {
  const r = await zz(["agent", "create", "kody", "--project", s.repo], {
    cwd: s.root,
    home: s.home,
    env: SECRETS,
    probe: agentProbe(),
    spawn: installingEve(),
  });
  expect(r.stderr).not.toContain("error");
  expect(r.code).toBe(0);
}

/** The lines `eve start` prints once it listens. */
export const START_LINES = (port = 61131) => [
  `➜ Listening on: http://127.0.0.1:${port}/`,
  `[START] server listening at http://127.0.0.1:${port}/`,
];
