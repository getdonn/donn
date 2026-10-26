import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test-only: `eve add channel/github --non-interactive` as eve 0.83.2 printed it, copied from
// spikes/eve-runner/runtime/recordings/add-* and spikes/eve-runner/templates/fixtures/
// eve-add-github-prerequisite.out (FINDINGS-runtime.md R5, FINDINGS-templates.md T5). The events
// come on both streams, mixed with text; `github-prerequisite.mixed.txt` is one capture of both.

const HERE = dirname(fileURLToPath(import.meta.url));

export type RecordedLine = { line: string; stream: "stdout" | "stderr" };

/** The lines of one recorded stream. */
export function recorded(
  file: string,
  stream: "stdout" | "stderr",
): RecordedLine[] {
  return readFileSync(join(HERE, file), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => ({ line, stream }));
}

/** Exit 2: the multi-select question `github-events`, its event on stderr. */
export const INPUT_REQUIRED: RecordedLine[] = [
  ...recorded("input-required.stdout.txt", "stdout"),
  ...recorded("input-required.stderr.txt", "stderr"),
];

/** Exit 2, after `--answer 'github-events=["pull_request"]'`: `eve link` first. */
export const PREREQUISITE: RecordedLine[] = [
  ...recorded("prerequisite.stdout.txt", "stdout"),
  ...recorded("prerequisite.stderr.txt", "stderr"),
];

/** Exit 1: pnpm's build-script policy stopped the install; rolled back. */
export const FAILED_BUILD_POLICY: RecordedLine[] = recorded(
  "failed-build-policy.stdout.ndjson",
  "stdout",
);

/** The prerequisite, its event on stdout this time (one capture of both streams). */
export const PREREQUISITE_MIXED: RecordedLine[] = recorded(
  "github-prerequisite.mixed.txt",
  "stdout",
);

/**
 * Exit 0. Not recorded (the spike never got past `eve link`): built from eve 0.83.2's
 * `HeadlessSetupEvent` (`cli/commands/setup-headless.ts`), with the facts eve logs as text.
 */
export const COMPLETED: RecordedLine[] = [
  { line: "GitHub App: donn-kody", stream: "stdout" },
  {
    line: '{"version":1,"type":"completed","item":"channel/github","completedItems":["channel/github"]}',
    stream: "stdout",
  },
];

/**
 * Exit 2. Not recorded: a secret question as eve 0.83.2 reports it headless (`withAnswers` in
 * `setup/ask.ts`): a `prerequisite_required` of kind `environment` whose code is the key.
 */
export const SECRET_PREREQUISITE: RecordedLine[] = [
  {
    line: '{"version":1,"type":"blocked","item":"channel/github","installed":true,"completedItems":[],"status":"prerequisite_required","prerequisite":{"kind":"environment","code":"github-private-key","message":"Set GITHUB_APP_PRIVATE_KEY, then retry setup.","variable":"GITHUB_APP_PRIVATE_KEY","sensitive":true},"next":{"command":"eve","args":["add","channel/github","--non-interactive","--skip-install","--answer","github-events=[\\"pull_request\\"]"]}}',
    stream: "stderr",
  },
];

/** Exit 2. Not recorded: the wire's own `environment` question (`setup-question-wire.ts`). */
export const SECRET_QUESTION: RecordedLine[] = [
  {
    line: '{"version":1,"type":"blocked","item":"channel/github","installed":true,"completedItems":[],"status":"input_required","question":{"key":"github-webhook-secret","message":"GitHub webhook secret","required":true,"kind":"environment","variable":"GITHUB_WEBHOOK_SECRET","sensitive":true},"next":{"command":"eve","args":["add","channel/github","--non-interactive","--skip-install"]}}',
    stream: "stderr",
  },
];
