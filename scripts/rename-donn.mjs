#!/usr/bin/env node
// One-off rename of the placeholder `zzpersona` (and `hatrack` in docs) to donn.
// Spec: docs/planning/22-rename-donn.md §1 (the mapping) and §2 (this script). Committed and
// deleted in the same layer.
//
//   node scripts/rename-donn.mjs          rename paths, then text; print the length-sensitive lines
//   node scripts/rename-donn.mjs --check  only list leftovers; exit 1 when there are any
//   --control-plane                       also apply rule 10 (the private repo only)
//   --protected                           list the untouched planning lines that hold an old name
//
// Acts on `git ls-files` only. Untouched: CHANGELOG.md files, docs/plans/, spikes/, spec 22,
// and in docs/planning/*.md the dated amendment and history blocks (see `protectedLines`).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CHECK = process.argv.includes("--check");
const SELF = "scripts/rename-donn.mjs";
const DATED = "> 2026-10-23: renamed zzpersona/hatrack → donn (spec 22).";

// §2.2, in order, so a longer form is never half-replaced.
const RULES = [
  ["@zzpersona/", "@getdonn/"],
  ["com.zzpersona.", "dev.getdonn."],
  ["zzpersona.daemon", "dev.getdonn.daemon"],
  ["zzpersona-daemon", "donn-daemon"],
  ["zzpersonad", "donnd"],
  ["zzpersona/v0", "donn/v0"],
  ["zzpersona-bundle/", "donn-bundle/"],
  ["zzpersona-registry", "donn-registry"],
  ["X-Zzpersona-", "X-Donn-"],
  ["Zzpersona", "Donn"],
  ["ZZPERSONA_", "DONN_"],
  ["ZZP_", "DONN_"],
  ["__Host-zzp_", "__Host-donn_"],
  ["zzp_", "donn_"],
  ["zzpd-", "donnd-"],
  ["zzp-", "donn-"],
  ["zzpersona", "donn"],
];

// §2.2 rule 9, docs only. `@hatrack/` and `HATRACK_` are the docs' spellings of `@zzpersona/` and
// `ZZPERSONA_` (03-architecture.md: "Every `hatrack` identifier below maps to the code
// placeholder"), so they follow §1's mapping for those.
const DOC_RULES = [
  ["@hatrack/", "@getdonn/"],
  ["HATRACK_", "DONN_"],
  ["hatrackd", "donnd"],
  ["Hatrack", "Donn"],
  ["hatrack", "donn"],
];

// §2.2 rule 10, the control plane only (its spec 05): `--control-plane` adds these last.
const CONTROL_PLANE_RULES = process.argv.includes("--control-plane")
  ? [
      ["@persona-ai/", "@getdonn/"],
      ["vendor/persona-ai", "vendor/donn"],
      ["persona-ai-control-plane", "donn-control-plane"],
    ]
  : [];

const LEFTOVER = /zzpersona|zzp[-_d]|ZZP_|ZZPERSONA|hatrack/i;

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const tracked = () => git("ls-files", "-z").split("\0").filter(Boolean);

const isDoc = (path) => path.endsWith(".md");
const isPlanning = (path) => /^docs\/planning\/[^/]+\.md$/.test(path);
const untouchedFile = (path) =>
  path === SELF ||
  path.split("/").pop() === "CHANGELOG.md" ||
  path.startsWith("docs/plans/") ||
  path.startsWith("spikes/") ||
  path === "docs/planning/22-rename-donn.md";

const isBinary = (buffer) => buffer.includes(0);

// --- untouched lines in docs/planning ------------------------------------------------------

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>/;
const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+\.)\s+/;
// A blockquote line that starts a new statement (status blocks stack several).
const QUOTE_STATEMENT =
  /^\s*>\s*(?:\*\*)?(?:Amended|Answered|Amendment|Added|Status:|Builds on|Purpose:|Working name|\d{4}-\d{2}-\d{2}:)/;
// A dated amendment: `*Amended …`, `> Amended …`, `- *Amended …`, `> **Amendment …`.
const AMENDED =
  /^\s*(?:>\s*)*(?:(?:[-*+]|\d+\.)\s+)?\*{0,2}(?:Amended|Answered|Amendment)\b/;
// The record of the old name itself, which a rename would turn into nonsense ("Donn is taken").
const NAME_HISTORY =
  /Hatrack(?:~~)? (?:is )?(?:taken|out)|~~Hatrack~~|Hatrack taken|Working name/;

/** Split a planning doc into blocks (paragraphs, list items, quote statements, fences). */
function blocks(lines) {
  const ids = [];
  let id = 0;
  let fenced = false;
  let previous = "blank";
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!fenced) id++;
      fenced = !fenced;
      ids.push(id);
      previous = fenced ? "fence" : "blank";
      if (!fenced) id++;
      continue;
    }
    if (fenced) {
      ids.push(id);
      continue;
    }
    const blank = /^\s*>?\s*$/.test(line);
    if (blank) {
      ids.push(-1);
      previous = "blank";
      continue;
    }
    const kind = QUOTE.test(line) ? "quote" : "text";
    const starts =
      previous === "blank" ||
      previous !== kind ||
      HEADING.test(line) ||
      LIST_ITEM.test(line) ||
      (kind === "quote" && QUOTE_STATEMENT.test(line));
    if (starts) id++;
    ids.push(id);
    previous = HEADING.test(line) ? "blank" : kind;
  }
  return ids;
}

/** Which lines of a file the rename leaves alone. */
function protectedLines(path, lines) {
  const mask = lines.map(() => untouchedFile(path));
  if (!isPlanning(path) || untouchedFile(path)) return mask;

  // Sections whose heading names an amendment, and 00-handoff.md's `## Naming`.
  let level = 0;
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (level && depth <= level) level = 0;
      const naming =
        path.endsWith("/00-handoff.md") &&
        depth === 2 &&
        /^Naming\b/.test(heading[2]);
      if (!level && (/Amendment/i.test(heading[2]) || naming)) level = depth;
    }
    if (level) mask[i] = true;
  });

  // Amendment paragraphs and the name's own history, as whole blocks.
  const ids = blocks(lines);
  // An amendment runs from its line to the end of its block (it may sit inside a list item);
  // a line of the name's history keeps its whole block.
  const keep = new Set();
  lines.forEach((line, i) => {
    if (ids[i] < 0) return;
    if (NAME_HISTORY.test(line)) keep.add(ids[i]);
    if (AMENDED.test(line)) {
      for (let j = i; j < lines.length && ids[j] === ids[i]; j++)
        mask[j] = true;
    }
  });
  ids.forEach((id, i) => {
    if (keep.has(id)) mask[i] = true;
  });
  lines.forEach((line, i) => {
    if (line === DATED) mask[i] = true;
  });
  return mask;
}

// --- check ---------------------------------------------------------------------------------

function check() {
  const found = [];
  for (const path of tracked()) {
    if (untouchedFile(path)) continue;
    if (LEFTOVER.test(path)) found.push(`${path}: (path)`);
    const buffer = readFileSync(path);
    if (isBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split("\n");
    const mask = protectedLines(path, lines);
    lines.forEach((line, i) => {
      if (!mask[i] && LEFTOVER.test(line)) {
        found.push(`${path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  for (const line of found) console.log(line);
  console.log(`${found.length} leftover(s)`);
  return found.length === 0 ? 0 : 1;
}

if (CHECK) process.exit(check());

// --protected: the untouched lines in docs/planning that hold an old name, for review.
if (process.argv.includes("--protected")) {
  for (const path of tracked().filter(isPlanning)) {
    if (untouchedFile(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    const mask = protectedLines(path, lines);
    lines.forEach((line, i) => {
      if (mask[i] && LEFTOVER.test(line))
        console.log(`${path}:${i + 1}: ${line}`);
    });
  }
  process.exit(0);
}

// --- paths ---------------------------------------------------------------------------------

const counts = new Map();
const apply = (text, rules, count = true) => {
  for (const [from, to] of rules) {
    const n = text.split(from).length - 1;
    if (n === 0) continue;
    text = text.split(from).join(to);
    if (count) counts.set(from, (counts.get(from) ?? 0) + n);
  }
  return text;
};

const moves = [];
for (const path of tracked()) {
  if (untouchedFile(path)) continue;
  const next = apply(path, [...RULES, ...CONTROL_PLANE_RULES], false);
  if (next === path) continue;
  mkdirSync(dirname(next), { recursive: true });
  git("mv", path, next);
  moves.push([path, next]);
}

// --- text ----------------------------------------------------------------------------------

const RENAMED = /zzp|ZZP|Zzp|hatrack|Hatrack|HATRACK/;
const LENGTH_SENSITIVE =
  /RegExp\(|\.length\b|\{\d+(?:,\d*)?\}|\.slice\(|\.substring\(|\.pad(?:Start|End)\(|"pattern"\s*:/;
const REGEX_LITERAL =
  /(?:^|[=(,:[!&|?{};]|\breturn|\bmatch)\s*\/(?![/*\s])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuvy]*/g;
const hasRegexLiteral = (line) =>
  [...line.matchAll(REGEX_LITERAL)].some((m) => RENAMED.test(m[1]));

const review = [];
let filesChanged = 0;
for (const path of tracked()) {
  if (untouchedFile(path)) continue;
  const buffer = readFileSync(path);
  if (isBinary(buffer)) continue;
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const mask = protectedLines(path, lines);
  const rules = [
    ...RULES,
    ...(isDoc(path) ? DOC_RULES : []),
    ...CONTROL_PLANE_RULES,
  ];
  const out = lines.map((line, i) => {
    if (mask[i]) return line;
    const next = apply(line, rules);
    if (
      next !== line &&
      !isDoc(path) &&
      (LENGTH_SENSITIVE.test(line) || hasRegexLiteral(line))
    ) {
      review.push(`${path}:${i + 1}\n  - ${line.trim()}\n  + ${next.trim()}`);
    }
    return next;
  });

  // Every other planning doc gains the dated note after its status block.
  if (isPlanning(path) && !out.includes(DATED)) {
    const title = out.findIndex((l) => l.startsWith("# "));
    let start = title + 1;
    while (start < out.length && out[start].trim() === "") start++;
    if (QUOTE.test(out[start] ?? "")) {
      let end = start;
      while (end + 1 < out.length && QUOTE.test(out[end + 1])) end++;
      out.splice(end + 1, 0, DATED);
    } else {
      out.splice(title + 1, 0, "", DATED);
    }
  }

  const next = out.join("\n");
  if (next !== text) {
    writeFileSync(path, next);
    filesChanged++;
  }
}

console.log(`# paths renamed: ${moves.length}`);
for (const [from, to] of moves) console.log(`  ${from} → ${to}`);
console.log(`\n# files changed: ${filesChanged}`);
console.log(`\n# replacements per rule`);
for (const [from, to] of [...RULES, ...DOC_RULES, ...CONTROL_PLANE_RULES]) {
  console.log(`  ${from} → ${to}: ${counts.get(from) ?? 0}`);
}
console.log(`\n# length-sensitive lines to review by hand: ${review.length}`);
for (const entry of review) console.log(entry);
