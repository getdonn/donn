import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import type { BundleFile } from "@zzpersona/registry-api";

const dirs: string[] = [];

/** Call once in a test file: temp dirs made by `temp()` are removed after each test. */
export function cleanupTemps(): void {
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
}

export function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "zzp-remote-"));
  dirs.push(dir);
  return dir;
}

export function put(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export const persona = (name: string, extra = ""): string =>
  `apiVersion: zzpersona/v0\nkind: Persona\nmetadata:\n  name: ${name}\n${extra}`;

export const file = (path: string, text: string): BundleFile => ({
  path,
  content: Buffer.from(text).toString("base64"),
});
