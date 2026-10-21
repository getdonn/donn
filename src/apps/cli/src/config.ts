import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CliError } from "./errors.js";

// <home>/config.yaml. See docs/planning/06-cli-core-loop.md, section 1.

const Config = z.strictObject({ personas: z.string().min(1).optional() });
export type Config = z.infer<typeof Config>;

/** ~ means the user's home directory; a relative path is relative to <home>. */
function expand(path: string, home: string, env: NodeJS.ProcessEnv): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(env.HOME ?? homedir(), path.slice(1));
  }
  return resolve(home, path);
}

export async function loadConfig(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<Config> {
  const file = join(home, "config.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = Config.safeParse(parse(text) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new CliError(
      "invalid-config",
      `invalid ${file}: ${issues.join("; ")}`,
      { file, issues },
    );
  }
  const { personas } = parsed.data;
  return personas === undefined
    ? {}
    : { personas: expand(personas, home, env) };
}
