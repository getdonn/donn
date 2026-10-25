import { HOOK_EVENTS, type ResolvedPersona } from "@getdonn/spec";
import { FIXED_CAPABILITY_FIELDS, type HarnessAdapter } from "./types.js";

export const ADAPTER_API_VERSION = 1;

/** The adapter's declaration is invalid: a bad id, no IR versions, an unknown capability. */
export class AdapterDeclarationError extends Error {
  override name = "AdapterDeclarationError";
}

/** The CLI handed the adapter input it cannot use, e.g. a missing instruction file text. */
export class AdapterInputError extends Error {
  override name = "AdapterInputError";
}

export class UnsupportedIrVersionError extends Error {
  override name = "UnsupportedIrVersionError";
  constructor(
    readonly adapter: string,
    readonly irVersion: number,
  ) {
    super(`adapter ${adapter} does not accept IR version ${irVersion}`);
  }
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...FIXED_CAPABILITY_FIELDS,
  ...HOOK_EVENTS.map((event) => `hooks.${event}`),
]);

export const isCapabilityField = (field: string) =>
  KNOWN_FIELDS.has(field) || /^targets\.[^.]+$/.test(field);

/** Stamp the contract version on an adapter and check its declaration. */
export function defineAdapter(
  declaration: Omit<HarnessAdapter, "apiVersion">,
): HarnessAdapter {
  const fail = (problem: string) => {
    throw new AdapterDeclarationError(`adapter ${declaration.id}: ${problem}`);
  };
  if (!KEBAB.test(declaration.id)) fail("id must be lowercase kebab-case");
  if (declaration.irVersions.length === 0)
    fail("must accept at least one IR version");
  for (const field of Object.keys(declaration.capabilities().fields)) {
    if (!isCapabilityField(field)) fail(`unknown capability field "${field}"`);
  }
  return withApiVersion(declaration);
}

/**
 * The adapter as a plain object built from its named fields. A spread would drop the methods
 * of a class-based adapter, which live on its prototype.
 */
function withApiVersion(
  declaration: Omit<HarnessAdapter, "apiVersion">,
): HarnessAdapter {
  return {
    apiVersion: ADAPTER_API_VERSION,
    id: declaration.id,
    irVersions: declaration.irVersions,
    capabilities: declaration.capabilities.bind(declaration),
    detect: declaration.detect.bind(declaration),
    compile: declaration.compile.bind(declaration),
    activate: declaration.activate.bind(declaration),
    // A plain data object: its methods take no `this`.
    ...(declaration.managed && { managed: declaration.managed }),
  };
}

/** Adapters call this first in compile(): an unknown IR shape must not be compiled. */
export function assertIrVersion(
  adapter: HarnessAdapter,
  ir: ResolvedPersona,
): void {
  if (!adapter.irVersions.includes(ir.irVersion)) {
    throw new UnsupportedIrVersionError(adapter.id, ir.irVersion);
  }
}
