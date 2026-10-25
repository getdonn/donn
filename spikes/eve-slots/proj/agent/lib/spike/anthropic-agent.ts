import { defineAgent } from "eve";
import * as donn from "./anthropic-config";

// type-check only: proves the anthropic form spreads into defineAgent
export const checked = defineAgent({ ...donn });
