import type { SecretContext } from "@zzpersona/secrets";
import type { CliIo } from "./cli.js";

/** The context secret backends run in: the user's environment and the secret probe. */
export function secretContext(io: CliIo): SecretContext {
  const probe = io.secretProbe ?? io.probe;
  return { env: io.env, platform: probe.platform, run: probe.run };
}
