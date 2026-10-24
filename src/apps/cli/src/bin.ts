#!/usr/bin/env node
import { nodeProbe } from "@getdonn/executor";
import { createCli } from "./cli.js";
import { abandonedWork, workingDir } from "./startup.js";

const here = workingDir();
if ("error" in here) {
  process.stderr.write(`error: ${here.error}\n`);
  process.exit(1);
}

const cli = createCli({
  env: process.env,
  cwd: here.cwd,
  stdout: process.stdout,
  stderr: process.stderr,
  probe: nodeProbe(),
  // A keychain read can wait on macOS's "allow access" dialog: give the user time to answer.
  secretProbe: nodeProbe({ timeoutMs: 300_000 }),
});
process.exitCode = await cli.run(process.argv.slice(2));
// Abandoned work (a harness past its time limit) may hold a handle; don't wait for it.
if (abandonedWork() > 0) process.stdout.write("", () => process.exit());
