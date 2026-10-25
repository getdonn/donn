import adapter from "@getdonn/adapter-eve";
import type { TemplateInfo } from "@getdonn/adapter-sdk";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { templateDigest } from "./digest.js";
import { extractDir, type TarFile } from "./tar.js";

// `eve:<slug>` templates: the tag's tarball from codeload, one directory of it, verified
// against the adapter's table before anything is written. See docs/planning/25-agent-runner.md.

const REPO = "https://github.com/vercel/eve";
const NEAREST_TAGS = 5;

const byVersionDesc = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (y?.[i] ?? 0) - (x?.[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** The tagged versions with the same major.minor, newest first. */
async function nearestTags(io: CliIo, version: string): Promise<string[]> {
  const [major, minor] = version.split(".");
  const result = await io.probe.run("git", [
    "ls-remote",
    "--tags",
    REPO,
    `refs/tags/eve@${major}.${minor}.*`,
  ]);
  if (result.exitCode !== 0) return [];
  const tags = result.stdout
    .split("\n")
    .map((line) => /refs\/tags\/eve@(\d+\.\d+\.\d+)$/.exec(line)?.[1])
    .filter((tag): tag is string => tag !== undefined);
  return tags.sort(byVersionDesc).slice(0, NEAREST_TAGS);
}

const notInRepo = (slug: string) =>
  new CliError(
    "template-not-in-repo",
    `template ${slug} is not in the vercel/eve repository`,
    {
      slug,
      fix: "clone the template's own repository and create the agent from that local clone as a path template",
    },
  );

export async function fetchTemplate(
  io: CliIo,
  slug: string,
  version: string,
  table: TemplateInfo[] = adapter.templates(),
): Promise<Map<string, TarFile>> {
  const row = table.find((template) => template.slug === slug);
  if (!row?.repoPath) throw notInRepo(slug);
  const url = `https://codeload.github.com/vercel/eve/tar.gz/refs/tags/eve@${version}`;
  const fetcher = io.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new CliError(
      "template-fetch-failed",
      `could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      { url },
    );
  }
  if (response.status === 404) {
    const tags = await nearestTags(io, version);
    throw new CliError(
      "template-not-at-version",
      `eve has no tag eve@${version}`,
      {
        version,
        tags,
        fix:
          tags.length > 0
            ? `use a tagged version, for example ${tags[0]}`
            : "use a version the vercel/eve repository tags",
      },
    );
  }
  if (!response.ok) {
    throw new CliError(
      "template-fetch-failed",
      `downloading ${url} answered ${response.status}`,
      { url, status: response.status },
    );
  }
  const files = extractDir(
    new Uint8Array(await response.arrayBuffer()),
    `${row.repoPath}/`,
  );
  if (files.size === 0) {
    throw new CliError(
      "template-not-at-version",
      `eve@${version} has no ${row.repoPath} directory`,
      { version, repoPath: row.repoPath, tags: await nearestTags(io, version) },
    );
  }
  if (row.digest !== undefined) {
    const actual = templateDigest(files);
    if (actual !== row.digest) {
      throw new CliError(
        "template-digest-mismatch",
        `template ${slug} at eve@${version} does not match the digest this donn release knows`,
        { expected: row.digest, actual },
      );
    }
  }
  return files;
}
