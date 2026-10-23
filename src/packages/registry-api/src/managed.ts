import type {
  ManagedCompiler,
  ManagedLayer,
  ManagedOs,
  ManagedResult,
} from "@zzpersona/adapter-sdk";
import { resolve, type PersonaSource } from "@zzpersona/resolver";
import type { Ref } from "@zzpersona/spec";

// Resolve a layer and compile its chain's locks to a managed policy bundle. Shared by the CLI,
// the mock registry and the control plane; the caller supplies the layers (with digests) and a
// way to read files. See docs/planning/21-managed-settings.md, sections 2 to 4.

export interface CompileFromSource {
  source: PersonaSource;
  /** The deepest layer: an org, area or team ref. */
  ref: Ref;
  os: ManagedOs;
  /** The chain, root first, with versions and digests, copied into the manifest. */
  layers: ManagedLayer[];
  /** The CLI (or server) version recorded in the manifest. */
  zzpersona: string;
  /** Reads a personas-root-relative file named by the IR; the caller enforces containment. */
  readFile(path: string): Promise<Uint8Array>;
}

export async function compileFromSource(
  compiler: ManagedCompiler,
  { source, ref, os, layers, zzpersona, readFile }: CompileFromSource,
): Promise<ManagedResult> {
  const { ir, provenance } = await resolve(ref, { source });
  const wanted = compiler.inputs(ir);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts: Record<string, string> = {};
  for (const path of wanted.texts) {
    texts[path] = decoder.decode(await readFile(path));
  }
  const scripts: Record<string, Uint8Array> = {};
  for (const path of wanted.scripts) scripts[path] = await readFile(path);
  return compiler.compile({
    ir,
    layers,
    os,
    zzpersona,
    texts,
    scripts,
    provenance,
  });
}
