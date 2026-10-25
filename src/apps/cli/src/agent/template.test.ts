import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { quietIo } from "../test/seed.js";
import { tarball } from "../test/tarball.js";
import { archiveCommit, extractDir } from "./tar.js";
import { templateDigest } from "./digest.js";
import { fetchTemplate } from "./template.js";
import { pinEve } from "./pin.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const COMMIT = "9f73f9dbe5841253657b9037614cb43887937fe8";
const PREFIX = "apps/templates/tpl/";

const fixture = () =>
  tarball({
    top: "eve-eve-0.83.2",
    comment: COMMIT,
    entries: [
      { name: "README.md", data: "root" },
      { name: "apps/", type: "5" },
      { name: "apps/templates/", type: "5" },
      { name: "apps/templates/tpl/", type: "5" },
      { name: "apps/templates/tpl/package.json", data: "{}\n" },
      { name: "apps/templates/tpl/scripts/", type: "5" },
      {
        name: "apps/templates/tpl/scripts/setup.sh",
        data: "#!/bin/sh\n",
        mode: 0o755,
      },
      { name: "apps/templates/other/x.txt", data: "no" },
    ],
  });

const expectedDigest =
  "sha256-" +
  sha(
    `package.json\x00644\x00${sha("{}\n")}\n` +
      `scripts/setup.sh\x00755\x00${sha("#!/bin/sh\n")}\n`,
  );

async function code(run: () => unknown): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("extractDir", () => {
  it("returns only the template's files, with modes, and the pax commit", () => {
    const files = extractDir(fixture(), PREFIX);
    expect([...files.keys()].sort()).toEqual([
      "package.json",
      "scripts/setup.sh",
    ]);
    expect(files.get("scripts/setup.sh")?.mode).toBe(0o755);
    expect(files.get("package.json")?.mode).toBe(0o644);
    expect(new TextDecoder().decode(files.get("package.json")?.data)).toBe(
      "{}\n",
    );
    expect(archiveCommit(fixture())).toBe(COMMIT);
  });

  it("reads a pax path override", () => {
    const gz = tarball({
      top: "t",
      entries: [
        {
          name: "short",
          paxPath: "apps/templates/tpl/long/name.txt",
          data: "x",
        },
      ],
    });
    expect([...extractDir(gz, PREFIX).keys()]).toEqual(["long/name.txt"]);
  });

  it("has no commit without a pax global header", () => {
    expect(archiveCommit(tarball({ top: "t", entries: [] }))).toBeUndefined();
  });

  it.each([
    [
      "a symlink",
      { name: "apps/templates/tpl/l", type: "2", linkname: "/etc" },
    ],
    ["a hard link", { name: "apps/templates/tpl/h", type: "1", linkname: "x" }],
    ["a .. name", { name: "apps/templates/tpl/../../evil", data: "x" }],
  ])("refuses %s", async (_label, entry) => {
    const gz = tarball({ top: "t", entries: [entry] });
    const error = await code(() => extractDir(gz, PREFIX));
    expect(error.code).toBe("template-unsafe-entry");
    expect(error.details.entry).toBeTypeOf("string");
  });

  it("refuses an absolute name", async () => {
    const gz = tarball({ entries: [{ name: "/etc/passwd", data: "x" }] });
    expect((await code(() => extractDir(gz, PREFIX))).code).toBe(
      "template-unsafe-entry",
    );
  });

  it("ignores a symlink outside the template", () => {
    const gz = tarball({
      top: "t",
      entries: [
        { name: "elsewhere/link", type: "2", linkname: "x" },
        { name: "apps/templates/tpl/a", data: "a" },
      ],
    });
    expect([...extractDir(gz, PREFIX).keys()]).toEqual(["a"]);
  });
});

describe("templateDigest", () => {
  it("is the sorted lines of path, mode and content hash", () => {
    expect(templateDigest(extractDir(fixture(), PREFIX))).toBe(expectedDigest);
  });
});

const row = (
  digest: string,
  repoPath: string | null = "apps/templates/tpl",
) => [
  {
    slug: "tpl",
    title: "Tpl",
    ...(repoPath !== null && { repoPath }),
    services: [],
    digest,
  },
];

function ioWith(
  response: () => Response,
  probeOut = "",
  tagOut = `${COMMIT}\trefs/tags/eve@0.83.2\n`,
  tagExit = 0,
) {
  const urls: string[] = [];
  const calls: string[][] = [];
  const io = {
    ...quietIo({ cwd: "/", home: "/" }),
    probe: {
      run: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        const exact = args.at(-1) === "refs/tags/eve@0.83.2";
        return {
          exitCode: exact ? tagExit : 0,
          stdout: exact ? tagOut : probeOut,
          stderr: exact && tagExit ? "fatal: unable to access" : "",
        };
      },
    },
    fetch: (async (url: string | URL | Request) => {
      urls.push(String(url));
      return response();
    }) as typeof fetch,
  };
  return { io: io as never, urls, calls };
}

describe("fetchTemplate", () => {
  it("downloads the tag's tarball and verifies the digest", async () => {
    const gz = fixture();
    const { io, urls } = ioWith(() => new Response(gz));
    const files = await fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest));
    expect(urls).toEqual([
      "https://codeload.github.com/vercel/eve/tar.gz/refs/tags/eve@0.83.2",
    ]);
    expect([...files.keys()].sort()).toEqual([
      "package.json",
      "scripts/setup.sh",
    ]);
  });

  it("defaults to the version the digests were computed at", async () => {
    const { io, urls } = ioWith(() => new Response(fixture()));
    await fetchTemplate(io, "tpl", undefined, row(expectedDigest));
    expect(urls[0]).toMatch(/eve@0\.83\.2$/);
  });

  it("prefers a peeled tag line", async () => {
    const { io } = ioWith(
      () => new Response(fixture()),
      "",
      `deadbeef\trefs/tags/eve@0.83.2\n${COMMIT}\trefs/tags/eve@0.83.2^{}\n`,
    );
    await fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest));
  });

  it("refuses an archive whose commit is not the tag's", async () => {
    const { io } = ioWith(
      () => new Response(fixture()),
      "",
      "abc123\trefs/tags/eve@0.83.2\n",
    );
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest)),
    );
    expect(error.code).toBe("template-commit-mismatch");
    expect(error.details).toEqual({
      tag: "eve@0.83.2",
      expected: "abc123",
      actual: COMMIT,
    });
  });

  it("refuses an archive with no pax commit", async () => {
    const gz = tarball({
      top: "t",
      entries: [{ name: "apps/templates/tpl/a", data: "a" }],
    });
    const { io } = ioWith(() => new Response(gz));
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest)),
    );
    expect(error.code).toBe("template-commit-mismatch");
  });

  it("fails when the tag's commit cannot be read", async () => {
    const { io } = ioWith(() => new Response(fixture()), "", "", 128);
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest)),
    );
    expect(error.code).toBe("template-fetch-failed");
  });

  it("refuses a row with no digest", async () => {
    const { io } = ioWith(() => new Response(fixture()));
    const [r] = row(expectedDigest);
    const { digest: _digest, ...noDigest } = r!;
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", [noDigest]),
    );
    expect(error.code).toBe("template-digest-missing");
  });

  it("refuses a digest that differs from the table", async () => {
    const { io } = ioWith(() => new Response(fixture()));
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", row("sha256-0")),
    );
    expect(error.code).toBe("template-digest-mismatch");
    expect(error.details).toMatchObject({
      expected: "sha256-0",
      actual: expectedDigest,
    });
  });

  it("lists the nearest tags on a 404", async () => {
    const { io, calls } = ioWith(
      () => new Response("nope", { status: 404 }),
      `aaa\trefs/tags/eve@0.83.0\nbbb\trefs/tags/eve@0.83.2\nccc\trefs/tags/eve@0.83.10\n`,
    );
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.9", row(expectedDigest)),
    );
    expect(error.code).toBe("template-not-at-version");
    expect(error.details.tags).toEqual(["0.83.10", "0.83.2", "0.83.0"]);
    expect(calls[0]).toEqual([
      "git",
      "ls-remote",
      "--tags",
      "https://github.com/vercel/eve",
      "refs/tags/eve@0.83.*",
    ]);
  });

  it("says a row without repoPath is not in the repository", async () => {
    const { io } = ioWith(() => new Response(fixture()));
    const error = await code(() =>
      fetchTemplate(io, "tpl", "0.83.2", row(expectedDigest, null)),
    );
    expect(error.code).toBe("template-not-in-repo");
    expect(error.details.fix).toMatch(/local clone/);
  });

  it("does not know kody-eve-template", async () => {
    const { io, urls } = ioWith(() => new Response(fixture()));
    const error = await code(() =>
      fetchTemplate(io, "kody-eve-template", "0.83.2"),
    );
    expect(error.code).toBe("template-not-in-repo");
    expect(urls).toEqual([]);
  });
});

describe("pinEve", () => {
  const npm = (stdout: string, exitCode = 0, stderr = "") =>
    ({
      ...quietIo({ cwd: "/", home: "/" }),
      probe: { run: async () => ({ exitCode, stdout, stderr }) },
    }) as never;
  const RANGE = ">=0.83.2 <0.84.0";

  it("picks the newest version in the range", async () => {
    const versions = JSON.stringify(["0.82.0", "0.83.0", "0.83.2", "0.84.0"]);
    expect(await pinEve(npm(versions), RANGE)).toBe("0.83.2");
  });

  it("accepts a single version as a string", async () => {
    expect(await pinEve(npm('"0.83.4"'), RANGE)).toBe("0.83.4");
  });

  it("takes an override inside the range, refuses one outside", async () => {
    expect(await pinEve(npm("[]"), RANGE, "0.83.3")).toBe("0.83.3");
    const error = await code(() => pinEve(npm("[]"), RANGE, "0.84.0"));
    expect(error.code).toBe("framework-version");
  });

  it("fails with the stderr tail when npm fails", async () => {
    const error = await code(() => pinEve(npm("", 1, "boom"), RANGE));
    expect(error.message).toMatch(/boom/);
  });

  it("fails when nothing satisfies", async () => {
    const error = await code(() => pinEve(npm('["0.80.0"]'), RANGE));
    expect(error.code).toBe("framework-version");
  });
});
