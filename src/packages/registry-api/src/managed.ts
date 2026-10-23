import type {
  ManagedCompiler,
  ManagedLayer,
  ManagedOs,
  ManagedResult,
} from "@zzpersona/adapter-sdk";
import { resolve, type PersonaSource } from "@zzpersona/resolver";
import { parse } from "yaml";
import { normalizeBundlePath } from "./bundle.js";
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

/** What a registry holds of a published layer: its YAML and the files beside it. */
export interface PublishedLayer {
  source: string;
  files: { path: string; content: string }[];
}

const REGISTRY_DIR = ".registry/";

/**
 * A `PersonaSource` and a file reader over published layers. Each layer gets its own virtual
 * folder (`.registry/<ref>/@`, as the CLI's cache mount does), so two layers can both bundle an
 * `instructions/conduct.md`; a file read can only reach the files the layer published.
 */
export function publishedSource(
  latest: (ref: string) => Promise<PublishedLayer | undefined>,
): { source: PersonaSource; readFile(path: string): Promise<Uint8Array> } {
  return {
    source: {
      load: async (ref) => {
        const found = await latest(ref);
        return found === undefined
          ? undefined
          : (parse(found.source) as unknown);
      },
      dir: (ref) => `${REGISTRY_DIR}${ref}/@`,
    },
    async readFile(path) {
      const segments = path.startsWith(REGISTRY_DIR)
        ? path.slice(REGISTRY_DIR.length).split("/")
        : [];
      const at = segments.indexOf("@");
      const found =
        at > 0 ? await latest(segments.slice(0, at).join("/")) : undefined;
      const tail =
        at > 0 ? normalizeBundlePath(segments.slice(at + 1).join("/")) : "";
      const file = found?.files.find(
        (f) => normalizeBundlePath(f.path) === tail,
      );
      if (file === undefined) {
        throw new Error(`${path} is not a file of a published layer`);
      }
      return new Uint8Array(Buffer.from(file.content, "base64"));
    },
  };
}
