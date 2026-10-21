// Spike: does Claude Code hot-reload a settings file passed with --settings mid-session?
// Throwaway. Usage: node settings-reload.mjs <scratch-dir> [flag|local]
// flag:  the rules live in a file passed with --settings (default)
// local: control, the rules live in <cwd>/.claude/settings.local.json, documented to hot-reload
// One headless session, two turns. Between them, the --settings file gains a deny rule.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scratch, mode = "flag"] = process.argv.slice(2);
const cwd = join(scratch, `reload-cwd-${mode}`);
mkdirSync(join(cwd, ".claude"), { recursive: true });
const settingsPath =
  mode === "local" ? join(cwd, ".claude", "settings.local.json") : join(scratch, "reload-settings.json");

const writeSettings = (deny) =>
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(echo:*)"], deny } }, null, 2));
writeSettings([]);

const claude = spawn(
  "claude",
  ["-p", "--model", "haiku", ...(mode === "flag" ? ["--settings", settingsPath] : []),
   "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
  { cwd, stdio: ["pipe", "pipe", "inherit"] },
);
const say = (text) =>
  claude.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);

const results = [];
const turn = (text) =>
  new Promise((done) => {
    pending = done;
    say(text);
  });
let pending;
createInterface({ input: claude.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "result") pending?.(msg);
});

const one = await turn("Run the bash command `echo zz-one` and report its output in one line.");
results.push(one);
writeSettings(["Bash(echo zz-two:*)"]);
await new Promise((r) => setTimeout(r, 3000));
const two = await turn("Run the bash command `echo zz-two` and report its output, or the error, in one line.");
results.push(two);
claude.stdin.end();

for (const [i, r] of results.entries()) {
  const denied = (r.permission_denials ?? []).map((d) => d.tool_input?.command);
  console.log(`turn ${i + 1}: denials=${JSON.stringify(denied)} | ${r.result.replace(/\s+/g, " ").trim()}`);
}
