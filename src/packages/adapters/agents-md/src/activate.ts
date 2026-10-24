import type { ActivateInput, ActivationPlan } from "@getdonn/adapter-sdk";
import { BLOCK_FILE } from "./compile.js";

// One overlay step: the block, merged between donn markers in the repo's AGENTS.md.

export function activate({ output }: ActivateInput): ActivationPlan {
  const file = output.files[BLOCK_FILE];
  const content = file && "content" in file ? file.content : "";
  return {
    steps: [{ kind: "overlay", path: "AGENTS.md", content, block: "donn" }],
  };
}
