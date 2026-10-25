import { describe, expect, it } from "vitest";
import { templates } from "./templates.js";

describe("templates", () => {
  const all = templates();

  it("lists the eight templates of eve's repository", () => {
    expect(all.map((t) => t.slug).sort()).toEqual([
      "eve-chat-template",
      "eve-coding-agent-template",
      "eve-company-brain-template",
      "eve-discord-agent",
      "eve-llm-council-template",
      "eve-slack-agent",
      "eve-voice-template",
      "personal-agent-template",
    ]);
  });

  it("gives the gallery slug and the directory for the two renamed ones", () => {
    const by = Object.fromEntries(all.map((t) => [t.slug, t]));
    expect(by["eve-slack-agent"]!.repoPath).toBe(
      "apps/templates/eve-slack-agent-template",
    );
    expect(by["eve-discord-agent"]!.repoPath).toBe(
      "apps/templates/eve-discord-agent-template",
    );
    expect(by["personal-agent-template"]!.repoPath).toBe(
      "apps/templates/personal-agent-template",
    );
  });

  it("records the services read from the code", () => {
    const by = Object.fromEntries(all.map((t) => [t.slug, t.services]));
    expect(by["eve-coding-agent-template"]).toEqual([
      "connect",
      "sandbox",
      "ai-gateway",
      "github-checkout",
    ]);
    expect(by["eve-discord-agent"]).toContain("daemons");
    expect(by["eve-voice-template"]).toEqual(["ai-gateway"]);
  });

  it("carries the sha256 digest of each template directory at the pinned tag", () => {
    const digests = Object.fromEntries(
      all.map((t) => [t.repoPath!.split("/").pop(), t.digest]),
    );
    expect(digests).toEqual({
      "eve-chat-template":
        "sha256-f505db3dea24e2d6e5d3e318f6e386dc5981c27f3ecf558452f3f634b4172f1d",
      "eve-coding-agent-template":
        "sha256-55c8800e30fcd72e0429981b333f1850ac589da87587c3b879d01355a50c4201",
      "eve-company-brain-template":
        "sha256-3286c1dc6b6830c3a34e6d8440fdacfd5490d818ffc464519462990f3369ba97",
      "eve-discord-agent-template":
        "sha256-82a7cce4ce80dabb6c14c4996d4f11f9502797c5bcd18eb797c2c970f3dc9e8c",
      "eve-llm-council-template":
        "sha256-5bbc9205570883efab83b2f88e226dd0d4b107a36e4b1249c494974b1715b49a",
      "eve-slack-agent-template":
        "sha256-485a00d2717bcdfb804dec8fb2fc6ace74413857ec9ea7876ecb9060f7af0ee8",
      "eve-voice-template":
        "sha256-70d1e5d0723f84093eb379569abd15cba37e6450520db1f8632cc4b9936da637",
      "personal-agent-template":
        "sha256-780bf87a0a36f5f39aeb3a07f567b9b1a589d3607733a63d5a4a6d6fa843d4fe",
    });
  });

  it("returns fresh copies", () => {
    templates()[0]!.services.push("drive");
    expect(templates()[0]!.services).not.toContain("drive");
  });
});
