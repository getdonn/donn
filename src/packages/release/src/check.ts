import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PublicPackage, Workspace } from "./packages.js";
import type { TarballContents } from "./tarball.js";

export const REPOSITORY_URL = "git+https://github.com/getdonn/donn.git";

const REQUIRED = ["package.json", "README.md", "LICENSE", "NOTICE"];
const ALWAYS_ALLOWED = new Set([...REQUIRED, "CHANGELOG.md"]);
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const LOCAL = /^(workspace|link|file):/;

type Json = Record<string, unknown>;

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

function targets(manifest: Json): string[] {
  const bin = manifest["bin"];
  return [
    ...strings(manifest["exports"]),
    ...strings(manifest["main"]),
    ...strings(bin),
  ]
    .filter((t) => !t.includes("*"))
    .map(norm);
}

/** Problems with a packed tarball; empty when it is fit to publish. */
export function checkTarball(
  contents: TarballContents,
  pkg: PublicPackage,
  all: Workspace[],
): string[] {
  const problems: string[] = [];
  const files = new Set(contents.files);

  for (const f of REQUIRED) {
    if (!files.has(f)) problems.push(`missing ${f}`);
  }

  const extras = (
    Array.isArray(pkg.manifest["files"]) ? pkg.manifest["files"] : []
  )
    .filter((f): f is string => typeof f === "string")
    .map(norm)
    .filter((f) => f !== "dist");
  for (const f of contents.files) {
    const allowed =
      ALWAYS_ALLOWED.has(f) ||
      (f.startsWith("dist/") && !f.endsWith(".map")) ||
      extras.some((e) => f === e || f.startsWith(`${e}/`));
    if (!allowed) problems.push(`unexpected file ${f}`);
  }

  if (!files.has("package.json")) return problems;
  let packed: Json;
  try {
    packed = JSON.parse(
      readFileSync(join(contents.dir, "package", "package.json"), "utf8"),
    ) as Json;
  } catch (err) {
    return [...problems, `package.json unreadable: ${(err as Error).message}`];
  }

  for (const field of DEP_FIELDS) {
    const block = packed[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === "string" && LOCAL.test(spec)) {
        problems.push(`${field}.${name} is still ${spec}`);
      }
      const dep = all.find((w) => w.name === name);
      if (field !== "devDependencies" && dep?.private) {
        problems.push(`${field}.${name} is a private package`);
      }
    }
  }

  for (const t of new Set(targets(packed))) {
    if (!files.has(t)) problems.push(`target ${t} is not in the tarball`);
  }

  const repo = packed["repository"];
  const url = repo && typeof repo === "object" ? (repo as Json)["url"] : repo;
  if (url !== REPOSITORY_URL) {
    problems.push(
      `repository.url is ${JSON.stringify(url)}, expected ${REPOSITORY_URL}`,
    );
  }
  return problems;
}
