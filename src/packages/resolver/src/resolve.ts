import type { Ref, ResolveResult } from "@zzpersona/spec";
import { ResolveError } from "./errors.js";
import {
  linearize,
  loadDocument,
  loadGraph,
  type PersonaSource,
} from "./graph.js";
import { Merge } from "./merge.js";

export interface ResolveOptions {
  source: PersonaSource;
  /** The user's PersonaOverlay, merged after the whole stack. */
  overlay?: Ref;
}

/**
 * Flatten `target` and its ancestors into the harness-neutral IR, with provenance for every
 * value and warnings for anything a reviewer should see. Throws ResolveError when the stack
 * cannot be resolved.
 */
export async function resolve(
  target: Ref,
  { source, overlay }: ResolveOptions,
): Promise<ResolveResult> {
  const personas = await loadGraph(source, target);
  const layers = linearize(personas, target);
  const merge = new Merge();
  for (const ref of layers) merge.apply(ref, personas.get(ref)!);

  if (overlay !== undefined) {
    const doc = await loadDocument(source, overlay);
    if (doc.kind !== "PersonaOverlay") {
      throw new ResolveError("invalid-persona", {
        layer: overlay,
        issues: ["expected kind: PersonaOverlay"],
      });
    }
    merge.apply(overlay, doc);
    layers.push(overlay);
  }

  return merge.finish(layers, target, personas.get(target)!.metadata);
}
