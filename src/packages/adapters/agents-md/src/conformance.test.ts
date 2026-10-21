import { conformanceSuite } from "@zzpersona/adapter-sdk/conformance/vitest";
import adapter from "./index.js";

// The shared conformance kit. AGENTS.md is a file format: there is no program to detect.
conformanceSuite(adapter, { noBinary: true });
