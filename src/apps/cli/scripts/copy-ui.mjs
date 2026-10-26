// After tsc: copies the app's build (src/apps/ui/dist) into dist/ui, where the daemon's bridge
// serves it from, so the published @getdonn/cli carries the app (docs/planning/26-gui.md §4).
// turbo builds @getdonn/ui first: it is a dev dependency of this package.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exit, stderr } from "node:process";

const from = join(import.meta.dirname, "../../ui/dist");
const to = join(import.meta.dirname, "../dist/ui");

if (!existsSync(join(from, "index.html"))) {
  stderr.write(
    `copy-ui: ${from} has no index.html; build the app first: pnpm turbo run build --filter=@getdonn/cli\n`,
  );
  exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
