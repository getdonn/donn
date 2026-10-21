// Regenerates src/conformance/corpus/full.json from resolver fixture 002, so the conformance
// corpus's "full" entry is the real resolved output of the 02-persona-spec example.
// Usage: pnpm corpus:update (after a change to that fixture).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parse } from "yaml";

const here = import.meta.dirname;
const fixture = join(here, "../../resolver/fixtures/002-full-stack/case.yaml");
const target = join(here, "../src/conformance/corpus/full.json");
const resolved = parse(readFileSync(fixture, "utf8")).expect.resolved;
writeFileSync(target, `${JSON.stringify(resolved, null, 2)}\n`);
process.stdout.write(`wrote ${target}\n`);
