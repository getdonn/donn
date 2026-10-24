import { PersonaDocument, type Persona, type Ref } from "@getdonn/spec";
import { ResolveError } from "./errors.js";

/** Where persona documents come from: a directory, git, or the control plane. */
export interface PersonaSource {
  /** The raw parsed document for `ref`, or undefined if no persona has that ref. */
  load(ref: Ref): Promise<unknown>;
  /** The virtual folder this layer's relative paths resolve against; default posix.dirname(ref). */
  dir?(ref: Ref): string;
}

export async function loadDocument(
  source: PersonaSource,
  ref: Ref,
  from?: Ref,
): Promise<PersonaDocument> {
  const raw = await source.load(ref);
  if (raw === undefined) {
    throw new ResolveError(
      "missing-ref",
      from === undefined ? { ref } : { ref, from },
    );
  }
  const parsed = PersonaDocument.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    throw new ResolveError("invalid-persona", { layer: ref, issues });
  }
  return parsed.data;
}

/** Load `target` and every ancestor. Fails on a missing ref, an invalid file, or a cycle. */
export async function loadGraph(
  source: PersonaSource,
  target: Ref,
): Promise<Map<Ref, Persona>> {
  const personas = new Map<Ref, Persona>();
  const stack: Ref[] = [];

  const visit = async (ref: Ref, from?: Ref): Promise<void> => {
    const onStack = stack.indexOf(ref);
    if (onStack !== -1)
      throw new ResolveError("cycle", {
        cycle: [...stack.slice(onStack), ref],
      });
    if (personas.has(ref)) return;
    const doc = await loadDocument(source, ref, from);
    if (doc.kind !== "Persona") {
      throw new ResolveError("invalid-persona", {
        layer: ref,
        issues: ["expected kind: Persona"],
      });
    }
    stack.push(ref);
    for (const parent of doc.extends ?? []) await visit(parent, ref);
    stack.pop();
    personas.set(ref, doc);
  };

  await visit(target);
  return personas;
}

/**
 * Merge order for `target`, root first. `extends` lists parents in ascending precedence (later
 * wins), so C3 runs on the reversed parent list and its result is reversed back. See
 * fixtures/README.md, rule 1.
 */
export function linearize(personas: Map<Ref, Persona>, target: Ref): Ref[] {
  const memo = new Map<Ref, Ref[]>();
  const mro = (ref: Ref): Ref[] => {
    const cached = memo.get(ref);
    if (cached) return cached;
    const parents = [...(personas.get(ref)?.extends ?? [])].reverse();
    const result = [ref, ...c3Merge([...parents.map(mro), parents], ref)];
    memo.set(ref, result);
    return result;
  };
  return [...mro(target)].reverse();
}

function c3Merge(sequences: Ref[][], persona: Ref): Ref[] {
  const lists = sequences.map((s) => [...s]).filter((s) => s.length > 0);
  const merged: Ref[] = [];
  while (lists.length > 0) {
    const head = lists
      .map((list) => list[0]!)
      .find((candidate) =>
        lists.every((list) => !list.slice(1).includes(candidate)),
      );
    if (head === undefined)
      throw new ResolveError("linearization-conflict", { persona });
    merged.push(head);
    for (const list of lists) if (list[0] === head) list.shift();
    for (let i = lists.length - 1; i >= 0; i--)
      if (lists[i]!.length === 0) lists.splice(i, 1);
  }
  return merged;
}
