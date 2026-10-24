import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOverlay, ExecutorError, OverlayMarkersError } from "./index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "donn-overlay-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BEGIN =
  "<!-- donn:begin — generated; edit the source, not this block -->";
const END = "<!-- donn:end -->";
const step = (content = "Persona text.\n") =>
  ({
    kind: "overlay",
    path: "AGENTS.md",
    content,
    block: "donn",
  }) as const;
const file = () => join(root, "AGENTS.md");
const read = () => readFileSync(file(), "utf8");
const put = (text: string) => writeFileSync(file(), text);
const run = (mode: "write" | "check" | "remove", s = step()) =>
  applyOverlay(s, root, { mode });

describe("applyOverlay, block mode", () => {
  it("creates a missing file with only the block", async () => {
    expect(await run("write")).toEqual({ path: file(), status: "created" });
    expect(read()).toBe(`${BEGIN}\nPersona text.\n${END}\n`);
  });

  it("appends after a blank line when there are no markers", async () => {
    put("# Repo rules\n\nBe nice.\n");
    expect((await run("write")).status).toBe("updated");
    expect(read()).toBe(
      `# Repo rules\n\nBe nice.\n\n${BEGIN}\nPersona text.\n${END}\n`,
    );
  });

  it("appends after a file without a trailing newline", async () => {
    put("# Repo rules");
    await run("write");
    expect(read()).toBe(`# Repo rules\n\n${BEGIN}\nPersona text.\n${END}\n`);
  });

  it("replaces only the block and preserves text outside it byte for byte", async () => {
    const before = "# Rules\t \n\n";
    const after = "\n## More  \nTail without newline";
    put(`${before}${BEGIN}\nOld.\n${END}${after}`);
    expect((await run("write")).status).toBe("updated");
    expect(read()).toBe(`${before}${BEGIN}\nPersona text.\n${END}${after}`);
    expect((await run("write")).status).toBe("unchanged");
  });

  it("keeps CRLF line endings", async () => {
    put("# Rules\r\n");
    await run("write", step("One.\nTwo.\n"));
    expect(read()).toBe(
      `# Rules\r\n\r\n${BEGIN}\r\nOne.\r\nTwo.\r\n${END}\r\n`,
    );
  });

  it("counts only whole-line markers", async () => {
    put(`Mention ${END} inline, and ${BEGIN} too.\n`);
    await run("write");
    expect(read().startsWith(`Mention ${END} inline`)).toBe(true);
    expect(read().endsWith(`${BEGIN}\nPersona text.\n${END}\n`)).toBe(true);
  });

  it("refuses malformed markers, naming the line, and writes nothing", async () => {
    for (const text of [
      `a\n${BEGIN}\nb\n`,
      `a\nb\n${END}\n`,
      `${BEGIN}\nx\n${END}\n${BEGIN}\ny\n${END}\n`,
    ]) {
      put(text);
      const error = await run("write").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OverlayMarkersError);
      expect((error as OverlayMarkersError).line).toBeGreaterThan(0);
      expect(read()).toBe(text);
    }
  });

  it("checks without writing", async () => {
    expect((await run("check")).status).toBe("stale");
    expect(existsSync(file())).toBe(false);
    await run("write");
    expect((await run("check")).status).toBe("unchanged");
    expect((await run("check", step("Changed.\n"))).status).toBe("stale");
    expect(read()).toContain("Persona text.");
  });

  it("removes the block, and the file when nothing else remains", async () => {
    put("# Rules\n");
    await run("write");
    expect((await run("remove")).status).toBe("removed");
    expect(read()).toBe("# Rules\n");
    expect((await run("remove")).status).toBe("unchanged");
    rmSync(file());
    await run("write");
    expect((await run("remove")).status).toBe("removed");
    expect(existsSync(file())).toBe(false);
  });

  it("writes through a symlinked AGENTS.md", async () => {
    mkdirSync(join(root, "shared"));
    writeFileSync(join(root, "shared/AGENTS.md"), "# Shared\n");
    symlinkSync("shared/AGENTS.md", file());
    await run("write");
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "shared/AGENTS.md"), "utf8")).toContain(
      "Persona text.",
    );
  });

  it("refuses content that holds its own markers, writing nothing", async () => {
    put("# Rules\n");
    await expect(run("write", step(`x\n${END}\n`))).rejects.toBeInstanceOf(
      ExecutorError,
    );
    expect(read()).toBe("# Rules\n");
  });

  it("refuses to write through a link to a file outside the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "donn-outside-"));
    try {
      writeFileSync(join(outside, "bashrc"), "export A=1\n");
      symlinkSync(join(outside, "bashrc"), file());
      await expect(run("write")).rejects.toThrow(/outside the project/);
      expect(readFileSync(join(outside, "bashrc"), "utf8")).toBe(
        "export A=1\n",
      );
      expect((await run("check")).status).toBe("stale");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the root", async () => {
    await expect(
      applyOverlay({ ...step(), path: "../AGENTS.md" }, root, {
        mode: "write",
      }),
    ).rejects.toBeInstanceOf(ExecutorError);
  });
});

describe("applyOverlay, whole-file mode", () => {
  it("owns the whole file", async () => {
    const whole = {
      kind: "overlay",
      path: "notes.md",
      content: "All.\n",
    } as const;
    expect((await applyOverlay(whole, root, { mode: "write" })).status).toBe(
      "created",
    );
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("All.\n");
    expect((await applyOverlay(whole, root, { mode: "check" })).status).toBe(
      "unchanged",
    );
    expect((await applyOverlay(whole, root, { mode: "remove" })).status).toBe(
      "removed",
    );
    expect(existsSync(join(root, "notes.md"))).toBe(false);
  });
});
