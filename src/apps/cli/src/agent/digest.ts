import { createHash } from "node:crypto";
import type { TarFile } from "./tar.js";

/**
 * A template's digest: sha256 over the sorted lines `<path>\0<644|755>\0<sha256 hex>\n`,
 * as `sha256-<hex>` (spikes/eve-runner/FINDINGS-templates.md, T2).
 */
export function templateDigest(files: Map<string, TarFile>): string {
  const lines = [...files].map(
    ([path, file]) =>
      `${path}\0${file.mode.toString(8)}\0${createHash("sha256").update(file.data).digest("hex")}\n`,
  );
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `sha256-${createHash("sha256").update(lines.join("")).digest("hex")}`;
}
