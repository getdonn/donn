import type { ResolvedPersona } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import { runConformance } from "./conformance/index.js";
import { good } from "./testing/toy.js";
import {
  ADAPTER_API_VERSION,
  AdapterDeclarationError,
  assertIrVersion,
  defineAdapter,
  UnsupportedIrVersionError,
  type CapabilityMatrix,
  type HarnessAdapter,
} from "./index.js";

const declaration = (overrides: Partial<HarnessAdapter> = {}) => ({
  id: "toy",
  irVersions: [0],
  capabilities: (): CapabilityMatrix => ({
    fields: { instructions: { support: "native" } },
  }),
  detect: async () => ({ installed: true, facts: {} }),
  compile: () => ({
    files: {},
    secretEnv: {},
    report: { adapter: "toy", irVersion: 0, entries: [] },
  }),
  activate: () => ({ steps: [] }),
  ...overrides,
});

const matrix =
  (field: string): (() => CapabilityMatrix) =>
  () =>
    ({ fields: { [field]: { support: "native" } } }) as CapabilityMatrix;

/** An adapter written as a class: its methods live on the prototype and use `this`. */
class ClassAdapter {
  readonly inner = good;
  readonly id = good.id;
  readonly irVersions = good.irVersions;
  capabilities(...args: Parameters<HarnessAdapter["capabilities"]>) {
    return this.inner.capabilities(...args);
  }
  detect(...args: Parameters<HarnessAdapter["detect"]>) {
    return this.inner.detect(...args);
  }
  compile(...args: Parameters<HarnessAdapter["compile"]>) {
    return this.inner.compile(...args);
  }
  activate(...args: Parameters<HarnessAdapter["activate"]>) {
    return this.inner.activate(...args);
  }
}

describe("defineAdapter", () => {
  it("keeps the methods of a class-based adapter", async () => {
    const adapter = defineAdapter(new ClassAdapter());
    expect(adapter.capabilities()).toEqual(good.capabilities());
    expect(typeof adapter.compile).toBe("function");
    const results = await runConformance(adapter);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it("stamps the contract version", () => {
    const adapter = defineAdapter(declaration());
    expect(adapter.apiVersion).toBe(1);
    expect(ADAPTER_API_VERSION).toBe(1);
    expect(adapter.id).toBe("toy");
  });

  it("rejects an id that is not kebab-case", () => {
    expect(() => defineAdapter(declaration({ id: "Claude_Code" }))).toThrow(
      AdapterDeclarationError,
    );
  });

  it("rejects an adapter that accepts no IR version", () => {
    expect(() => defineAdapter(declaration({ irVersions: [] }))).toThrow(
      AdapterDeclarationError,
    );
  });

  it("rejects unknown capability fields and accepts hook events and targets", () => {
    expect(() =>
      defineAdapter(declaration({ capabilities: matrix("permissions.denny") })),
    ).toThrow(AdapterDeclarationError);
    expect(() =>
      defineAdapter(
        declaration({ capabilities: matrix("hooks.pre-tool-uze") }),
      ),
    ).toThrow(AdapterDeclarationError);
    expect(() =>
      defineAdapter(
        declaration({ capabilities: matrix("hooks.pre-tool-use") }),
      ),
    ).not.toThrow();
    expect(() =>
      defineAdapter(declaration({ capabilities: matrix("targets.anything") })),
    ).not.toThrow();
  });
});

describe("assertIrVersion", () => {
  it("throws UnsupportedIrVersionError for an IR version the adapter does not accept", () => {
    const adapter = defineAdapter(declaration());
    const ir = { irVersion: 99 } as unknown as ResolvedPersona;
    let error: unknown;
    try {
      assertIrVersion(adapter, ir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsupportedIrVersionError);
    expect(error).toMatchObject({ irVersion: 99, adapter: "toy" });
  });

  it("accepts a supported IR version", () => {
    const adapter = defineAdapter(declaration());
    expect(() =>
      assertIrVersion(adapter, { irVersion: 0 } as unknown as ResolvedPersona),
    ).not.toThrow();
  });
});
