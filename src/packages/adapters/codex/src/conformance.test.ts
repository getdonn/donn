import { conformanceSuite } from "@zzpersona/adapter-sdk/conformance/vitest";
import adapter from "./index.js";

// The shared conformance kit.
conformanceSuite(adapter);
