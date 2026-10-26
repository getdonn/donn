import adapter, { portability, TEMPLATES_AT } from "@getdonn/adapter-eve";
import type { TemplateInfo, VercelService } from "@getdonn/adapter-sdk";
import type { CliIo } from "../cli.js";
import { CliError } from "../errors.js";
import { templateDigest } from "./digest.js";
import { archiveCommit, extractDir, type TarFile } from "./tar.js";
import { newestFirst } from "./versions.js";

// `eve:<slug>` templates: the tag's tarball from codeload, one directory of it, verified
// against the adapter's table before anything is written. See docs/planning/25-agent-runner.md.

const REPO = "https://github.com/vercel/eve";

/** A template as `donn agent templates` lists it. */
export interface TemplateRow {
  slug: string;
  title: string;
  /** The Vercel-only services its code uses (the adapter's table). */
  services: VercelService[];
  /** Off Vercel (local or self-host), the adapter reports a blocking portability entry. */
  vercelOnly: boolean;
  /** Kept in eve's repository at the adapter's tag (`repoPath`); `blank` is eve init's. */
  inRepo: boolean;
}

/** The adapter's templates, then `blank` (spec 26, 2026-10-25: the builder reads this). */
export function templateRows(): TemplateRow[] {
  return [
    ...adapter.templates().map((t) => ({
      slug: t.slug,
      title: t.title,
      services: [...t.services],
      vercelOnly: (["local", "self-host"] as const).some((target) =>
        portability(`eve:${t.slug}`, target).some((e) => e.blocking),
      ),
      inRepo: t.repoPath !== undefined,
    })),
    {
      slug: "blank",
      title: "Blank agent",
      services: [],
      vercelOnly: false,
      inRepo: false,
    },
  ];
}
const NEAREST_TAGS = 5;

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
  return tags.sort(newestFirst).slice(0, NEAREST_TAGS);
}

/** The commit a tag points at (the peeled line when the tag is annotated). */
async function tagCommit(io: CliIo, version: string): Promise<string> {
  const tag = `eve@${version}`;
  const result = await io.probe.run("git", [
    "ls-remote",
    "--tags",
    REPO,
    `refs/tags/${tag}`,
  ]);
  if (result.exitCode !== 0) {
    throw new CliError(
      "template-fetch-failed",
      `could not read the commit of tag ${tag}: ${result.stderr.trim().split("\n").slice(-3).join("\n") || `git exited ${result.exitCode}`}`,
      { tag },
    );
  }
  let sha: string | undefined;
  for (const line of result.stdout.split("\n")) {
    const [first, ref] = line.split("\t");
    if (ref === `refs/tags/${tag}^{}`) return first ?? "";
    if (ref === `refs/tags/${tag}`) sha = first;
  }
  if (!sha) {
    throw new CliError(
      "template-fetch-failed",
      `git ls-remote did not list tag ${tag}`,
      { tag },
    );
  }
  return sha;
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
  version: string = TEMPLATES_AT,
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
  const gz = new Uint8Array(await response.arrayBuffer());
  const expected = await tagCommit(io, version);
  const actual = archiveCommit(gz);
  if (actual !== expected) {
    throw new CliError(
      "template-commit-mismatch",
      `the archive for eve@${version} was not made from the tag's commit`,
      { tag: `eve@${version}`, expected, actual },
    );
  }
  const files = extractDir(gz, `${row.repoPath}/`);
  if (files.size === 0) {
    throw new CliError(
      "template-not-at-version",
      `eve@${version} has no ${row.repoPath} directory`,
      { version, repoPath: row.repoPath, tags: await nearestTags(io, version) },
    );
  }
  if (row.digest === undefined) {
    throw new CliError(
      "template-digest-missing",
      `the templates table has no digest for ${slug}, so it cannot be verified`,
      { slug },
    );
  }
  const digest = templateDigest(files);
  if (digest !== row.digest) {
    throw new CliError(
      "template-digest-mismatch",
      `template ${slug} at eve@${version} does not match the digest this donn release knows`,
      { expected: row.digest, actual: digest },
    );
  }
  return files;
}
