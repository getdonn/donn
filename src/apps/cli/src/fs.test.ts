import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withFileLock } from "./fs.js";

// The directory lock: a long holder keeps it fresh.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "donn-fs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("renews a lock held with refreshMs, and removes it after", async () => {
  const lock = join(dir, "a.lock");
  const times: number[] = [];
  await withFileLock(
    lock,
    async () => {
      times.push(statSync(lock).mtimeMs);
      await new Promise((r) => setTimeout(r, 120));
      times.push(statSync(lock).mtimeMs);
    },
    { refreshMs: 20 },
  );
  expect(times[1]!).toBeGreaterThan(times[0]!);
  expect(() => statSync(lock)).toThrow();
});
