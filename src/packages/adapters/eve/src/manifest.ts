import type { AgentCompileOutput } from "@getdonn/adapter-sdk";

// The `files` map of the ownership manifest (`.donn/agent.json`). See
// docs/planning/24-adapter-eve.md, section 4.

/**
 * The manifest value of a `copyFrom` entry (a skill directory). The compile has no file
 * contents for it, so the CLI (spec 25) copies the directory first, then replaces this entry
 * with one `sha256:<hex>` entry per copied file (`agent/skills/donn-x/SKILL.md`, …).
 */
export const COPY_PENDING = "copy";

/**
 * The manifest's `files`: each output path to `sha256:<hex>` of its content, hashed with
 * `hash` (a hex digest; the adapter does no I/O and brings no crypto of its own), or
 * `COPY_PENDING` for a copied entry. Keys are sorted, so the manifest is stable.
 */
export function manifestFiles(
  files: AgentCompileOutput["files"],
  hash: (content: string) => string,
): Record<string, string> {
  const entries = Object.keys(files)
    .sort()
    .map((path) => {
      const file = files[path]!;
      return [
        path,
        "content" in file ? `sha256:${hash(file.content)}` : COPY_PENDING,
      ] as const;
    });
  return Object.fromEntries(entries);
}
