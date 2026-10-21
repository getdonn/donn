import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { CliError } from "./errors.js";

// <home>/config.yaml. See docs/planning/06-cli-core-loop.md, section 1.

const Config = z.strictObject({
  personas: z.string().min(1).optional(),
  /** Third-party adapters: package names (from <home>/adapters) or paths. See spec 08 §1. */
  adapters: z.array(z.string().min(1)).optional(),
  /** Secret provider packages, listed the same way. */
  secretProviders: z.array(z.string().min(1)).optional(),
});
export type Config = z.infer<typeof Config>;

/** ~ means the user's home directory; a relative path is relative to `base`. */
export function expandPath(
  path: string,
  base: string,
  env: NodeJS.ProcessEnv,
): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(env.HOME ?? homedir(), path.slice(1));
  }
  return resolve(base, path);
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
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const line = error.linePos?.[0].line;
    throw new CliError(
      "invalid-config",
      `invalid YAML in ${file}${line ? ` at line ${line}` : ""}: ${error.message}`,
      { file, ...(line !== undefined && { line }) },
    );
  }
  const parsed = Config.safeParse(raw ?? {});
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
  const { personas, ...plugins } = parsed.data;
  return {
    ...plugins,
    ...(personas !== undefined && {
      personas: expandPath(personas, home, env),
    }),
  };
}
