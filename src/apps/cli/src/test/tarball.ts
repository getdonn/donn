import { gzipSync } from "node:zlib";

// A minimal ustar + gzip writer for fixtures. Not a general tar: just what the extractor reads.

export interface TarEntry {
  name: string;
  data?: string | Uint8Array;
  mode?: number;
  /** Typeflag: "0" file (default), "5" directory, "2" symlink, "1" hard link. */
  type?: string;
  linkname?: string;
  /** A pax `path` record for this entry (the ustar name is then a stand-in). */
  paxPath?: string;
}

const enc = new TextEncoder();

function field(value: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(enc.encode(value).subarray(0, length));
  return out;
}

function header(
  name: string,
  size: number,
  mode: number,
  type: string,
  linkname = "",
): Uint8Array {
  const block = new Uint8Array(512);
  block.set(field(name, 100), 0);
  block.set(field(mode.toString(8).padStart(7, "0"), 8), 100);
  block.set(field("0000000", 8), 108);
  block.set(field("0000000", 8), 116);
  block.set(field(size.toString(8).padStart(11, "0"), 12), 124);
  block.set(field("00000000000", 12), 136);
  block.fill(0x20, 148, 156);
  block.set(field(type, 1), 156);
  block.set(field(linkname, 100), 157);
  block.set(field("ustar", 6), 257);
  block.set(field("00", 2), 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(field(sum.toString(8).padStart(6, "0") + "\0 ", 8), 148);
  return block;
}

function pad(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

function paxRecords(records: Record<string, string>): Uint8Array {
  let text = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let length = enc.encode(body).length + 1;
    while (enc.encode(`${length}${body}`).length !== length) length += 1;
    text += `${length}${body}`;
  }
  return enc.encode(text);
}

/** A gzipped tar: optional pax global header, then the entries under `top/`. */
export function tarball(options: {
  top?: string;
  comment?: string;
  entries: TarEntry[];
}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const add = (...parts: Uint8Array[]) => chunks.push(...parts);
  if (options.comment) {
    const data = paxRecords({ comment: options.comment });
    add(header("pax_global_header", data.length, 0o666, "g"), pad(data));
  }
  for (const entry of options.entries) {
    const name = options.top ? `${options.top}/${entry.name}` : entry.name;
    const type = entry.type ?? "0";
    const data =
      typeof entry.data === "string"
        ? enc.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    if (entry.paxPath) {
      const pax = paxRecords({ path: `${options.top}/${entry.paxPath}` });
      add(header("PaxHeader", pax.length, 0o644, "x"), pad(pax));
    }
    const mode = entry.mode ?? (type === "5" ? 0o755 : 0o644);
    const size = type === "0" ? data.length : 0;
    add(
      header(name, size, mode, type, entry.linkname),
      pad(data.subarray(0, size)),
    );
  }
  add(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    tar.set(chunk, at);
    at += chunk.length;
  }
  return gzipSync(tar);
}
