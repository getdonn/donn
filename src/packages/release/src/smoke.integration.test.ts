import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { packAll } from "./pack.js";
import { listWorkspaces, publicPackages } from "./packages.js";
import { realRunner } from "./run.js";
import { smoke } from "./smoke.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Real packing and a real npm install (third-party deps come from npmjs).
describe.skipIf(!process.env["DONN_RELEASE_SMOKE"])("smoke (real)", () => {
  it("installs the packed tarballs and runs every step", async () => {
    const all = await listWorkspaces(ROOT, realRunner);
    const tarballs = await packAll(ROOT, publicPackages(all), realRunner);
    await smoke({ root: ROOT, source: { tarballs }, run: realRunner });
  }, 600_000);
});
