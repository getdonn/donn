#!/usr/bin/env node
import { nodeProbe } from "@zzpersona/executor";
import { createCli } from "./cli.js";

const cli = createCli({
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  probe: nodeProbe(),
  // A keychain read can wait on macOS's "allow access" dialog: give the user time to answer.
  secretProbe: nodeProbe({ timeoutMs: 300_000 }),
});
process.exitCode = await cli.run(process.argv.slice(2));
