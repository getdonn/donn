import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Ref } from "@zzpersona/spec";

/**
 * <home>/build/<slug>-<hash8>/<adapter>. The hash covers the project directory too: every
 * repo's project persona is `project/persona`, and two repos must not share a build.
 */
export function buildDirFor(
  personaId: Ref,
  projectDir: string | undefined,
  adapter: string,
  home: string,
): string {
  const hash8 = createHash("sha256")
    .update(`${personaId}\n${projectDir ?? ""}`)
    .digest("hex")
    .slice(0, 8);
  return join(
    home,
    "build",
    `${personaId.replaceAll("/", "-")}-${hash8}`,
    adapter,
  );
}
