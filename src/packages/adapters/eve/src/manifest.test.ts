import { describe, expect, it } from "vitest";
import { COPY_PENDING, manifestFiles } from "./manifest.js";

describe("manifestFiles", () => {
  it("hashes content with sha256: and marks copied directories", () => {
    const files = manifestFiles(
      {
        "agent/lib/donn/config.ts": { content: "a" },
        "agent/skills/donn-x": { copyFrom: "team/skills/x" },
        "agent/instructions/donn.md": { content: "b", mode: 0o644 },
      },
      (s) => `h(${s})`,
    );
    expect(files).toEqual({
      "agent/instructions/donn.md": "sha256:h(b)",
      "agent/lib/donn/config.ts": "sha256:h(a)",
      "agent/skills/donn-x": COPY_PENDING,
    });
    expect(Object.keys(files)).toEqual([...Object.keys(files)].sort());
  });
});
