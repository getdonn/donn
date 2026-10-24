import { conformanceSuite } from "@getdonn/adapter-sdk/conformance/vitest";
import adapter from "./index.js";

// The shared conformance kit, in each mode detection can put the adapter in.
conformanceSuite(adapter);
conformanceSuite(adapter, {
  detection: { installed: true, facts: { sideloadBlocked: true } },
});
conformanceSuite(adapter, {
  detection: { installed: true, facts: { managedMcp: true } },
});
