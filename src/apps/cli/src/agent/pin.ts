import { satisfiesRange } from "@getdonn/adapter-sdk";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { newestFirst } from "./versions.js";

const STABLE = /^\d+\.\d+\.\d+$/;

/**
 * The eve version to pin: the newest published release inside the adapter's range, or
 * `override` when it is inside the range too.
 */
export async function pinEve(
  io: CliIo,
  range: string,
  override?: string,
): Promise<string> {
  if (override !== undefined) {
    if (!satisfiesRange(override, range)) {
      throw new CliError(
        "framework-version",
        `eve ${override} is outside the range this donn compiles for (${range})`,
        { version: override, range },
      );
    }
    return override;
  }
  const result = await io.probe.run("npm", [
    "view",
    "eve",
    "versions",
    "--json",
  ]);
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
    throw new CliError(
      "framework-version",
      `could not list eve's versions: ${tail || `npm exited ${result.exitCode}`}`,
      { exitCode: result.exitCode },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  const versions = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (v): v is string => typeof v === "string" && STABLE.test(v),
  );
  const pick = versions
    .filter((version) => satisfiesRange(version, range))
    .sort(newestFirst)[0];
  if (!pick) {
    throw new CliError(
      "framework-version",
      `no published eve version satisfies ${range}`,
      { range },
    );
  }
  return pick;
}
