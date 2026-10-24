import { conformanceSuite } from "@getdonn/adapter-sdk/conformance/vitest";
import adapter from "./index.js";

// The shared conformance kit.
conformanceSuite(adapter);
