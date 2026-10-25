// Throwaway: a template digest computed two ways, from an extracted directory and straight from
// the GitHub tarball (node:zlib + a minimal ustar/pax reader, no dependencies). Both must agree.
//
//   node digest.mjs dir <templateDir>
//   node digest.mjs tar <eve.tar.gz> <templatesPrefix>      (e.g. apps/templates)
//
// Digest: sha256 over sorted lines `<posix path>\0<644|755>\0<sha256 hex of content>\n`, regular
// files only; a symlink, hard link or device anywhere in the template is refused.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const line = (p, exec, content) => `${p}\0${exec ? "755" : "644"}\0${sha(content)}\n`;
const digest = (lines) =>
  "sha256-" +
  createHash("sha256")
    .update(lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(""))
    .digest("hex");

function fromDir(root) {
  const lines = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) lines.push(line(r, (st.mode & 0o111) !== 0, readFileSync(join(root, r))));
      else throw new Error(`refused: ${r} is not a regular file`);
    }
  };
  walk("");
  return { files: lines.length, digest: digest(lines) };
}

// Yields { path, type, mode, data } for each entry, applying pax `path`/`size` overrides.
function* entries(buf) {
  let off = 0;
  let pax = {};
  const str = (o, n) => buf.toString("utf8", o, o + n).replace(/\0.*$/s, "");
  const oct = (o, n) => parseInt(str(o, n).trim() || "0", 8);
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) return;
    const type = String.fromCharCode(buf[off + 156] || 48);
    let size = oct(off + 124, 12);
    if (pax.size) size = Number(pax.size);
    const prefix = str(off + 345, 155);
    let path = (prefix ? `${prefix}/` : "") + str(off, 100);
    if (pax.path) path = pax.path;
    const mode = oct(off + 100, 8);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const rec = {};
      let s = data.toString("utf8");
      while (s.length) {
        const sp = s.indexOf(" ");
        const len = Number(s.slice(0, sp));
        const kv = s.slice(sp + 1, len - 1);
        const eq = kv.indexOf("=");
        rec[kv.slice(0, eq)] = kv.slice(eq + 1);
        s = s.slice(len);
      }
      if (type === "x") pax = rec;
      continue;
    }
    pax = {};
    yield { path, type, mode, data };
  }
}

function fromTar(file, prefix) {
  const t0 = performance.now();
  const buf = gunzipSync(readFileSync(file));
  const t1 = performance.now();
  const byTemplate = new Map();
  let top;
  for (const e of entries(buf)) {
    top ??= e.path.split("/")[0];
    const want = `${top}/${prefix}/`;
    if (!e.path.startsWith(want)) continue;
    const rest = e.path.slice(want.length);
    const [tpl, ...p] = rest.split("/");
    const rel = p.join("/").replace(/\/$/, "");
    if (!tpl || !rel) continue;
    if (!byTemplate.has(tpl)) byTemplate.set(tpl, []);
    if (e.type === "5") continue;
    if (e.type !== "0" && e.type !== "\0") throw new Error(`refused: ${e.path} type ${e.type}`);
    byTemplate.get(tpl).push(line(rel, (e.mode & 0o111) !== 0, e.data));
  }
  const t2 = performance.now();
  for (const [tpl, lines] of [...byTemplate].sort())
    console.log(`${tpl}\t${lines.length} files\t${digest(lines)}`);
  console.error(`gunzip ${(t1 - t0).toFixed(0)} ms, scan ${(t2 - t1).toFixed(0)} ms, top ${top}`);
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "dir") {
  const r = fromDir(a);
  console.log(`${r.files} files\t${r.digest}`);
} else fromTar(a, b);
