import { gunzipSync } from "node:zlib";
import { CliError } from "../errors.js";

// A minimal ustar/pax reader for GitHub's tag tarballs: no dependency, and it refuses
// anything but files and directories. See spikes/eve-runner/FINDINGS-templates.md, T1.

export interface TarFile {
  data: Uint8Array;
  mode: 0o644 | 0o755;
}

interface Entry {
  path: string;
  type: string;
  mode: number;
  data: Uint8Array;
}

const decoder = new TextDecoder();

function text(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

const octal = (buf: Uint8Array, offset: number, length: number): number =>
  parseInt(text(buf, offset, length).trim() || "0", 8);

function paxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let rest = decoder.decode(data);
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    const length = Number(rest.slice(0, space));
    if (space < 1 || !Number.isInteger(length) || length < space + 2) break;
    const record = rest.slice(space + 1, length - 1);
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(length);
  }
  return records;
}

/** Every entry, with pax `path`/`size` applied, plus the global header's `comment`. */
function read(gz: Uint8Array): { entries: Entry[]; comment?: string } {
  const buf = gunzipSync(gz);
  const entries: Entry[] = [];
  let comment: string | undefined;
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= buf.length;) {
    if (buf.subarray(at, at + 512).every((byte) => byte === 0)) break;
    const type = String.fromCharCode(buf[at + 156] || 48);
    const size = pax.size ? Number(pax.size) : octal(buf, at + 124, 12);
    const prefix = text(buf, at + 345, 155);
    const name = (prefix ? `${prefix}/` : "") + text(buf, at, 100);
    const mode = octal(buf, at + 100, 8);
    const data = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const records = paxRecords(data);
      if (type === "x") pax = records;
      else comment = records.comment ?? comment;
      continue;
    }
    entries.push({ path: pax.path ?? name, type, mode, data });
    pax = {};
  }
  return { entries, ...(comment !== undefined && { comment }) };
}

/** The commit a GitHub tarball was made from (its pax global header `comment`). */
export function archiveCommit(gz: Uint8Array): string | undefined {
  return read(gz).comment;
}

const unsafe = (entry: string, why: string) =>
  new CliError("template-unsafe-entry", `${why}: ${entry}`, { entry });

/**
 * The files under `prefix` (relative to the archive's top directory, e.g.
 * `apps/templates/eve-chat-template/`), keyed by path below it. Refuses `..` and absolute
 * names anywhere, and any entry inside the prefix that is not a file or a directory.
 */
export function extractDir(
  gz: Uint8Array,
  prefix: string,
): Map<string, TarFile> {
  const { entries } = read(gz);
  const files = new Map<string, TarFile>();
  const wanted = prefix.endsWith("/") ? prefix : `${prefix}/`;
  let top: string | undefined;
  for (const entry of entries) {
    const name = entry.path;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw unsafe(name, "unsafe path in the template archive");
    }
    top ??= name.split("/")[0];
    const start = `${top}/${wanted}`;
    if (!name.startsWith(start)) continue;
    if (entry.type === "5") continue;
    if (entry.type !== "0") {
      throw unsafe(name, `unsupported entry type ${entry.type}`);
    }
    files.set(name.slice(start.length), {
      data: entry.data,
      mode: entry.mode & 0o111 ? 0o755 : 0o644,
    });
  }
  return files;
}
