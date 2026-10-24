// Builds dist/mod: the plugin directory Claude Code loads. One bundled hooks module with no
// imports, plus the manifest. See docs/planning/09-mod-claude-code.md, section 1.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist/mod");
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);

await rm(out, { recursive: true, force: true });
await build({
  entryPoints: [join(root, "src/register.ts")],
  outfile: join(out, "hooks/register.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  external: ["claude-code"],
  logLevel: "warning",
});

const manifest = {
  name: "donn",
  version,
  author: { name: "donn" },
  license: "Apache-2.0",
  description:
    "Shows the active donn persona above the prompt, nudges when this folder uses another, and adds /persona",
  userConfig: {
    nudge: {
      type: "boolean",
      title: "Nudge",
      description: "Say when this folder uses a different persona",
      default: true,
    },
    band: {
      type: "boolean",
      title: "Band",
      description: "Show the active persona above the prompt",
      default: true,
    },
  },
};
await mkdir(join(out, ".claude-plugin"), { recursive: true });
await writeFile(
  join(out, ".claude-plugin/plugin.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  join(out, "hooks/hooks.json"),
  `${JSON.stringify({ modules: ["./register.js"] }, null, 2)}\n`,
);
