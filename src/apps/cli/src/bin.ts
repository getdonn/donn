#!/usr/bin/env node
import { nodeProbe } from "@zzpersona/executor";
import { createCli } from "./cli.js";

const cli = createCli({
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  probe: nodeProbe(),
});
process.exitCode = await cli.run(process.argv.slice(2));
