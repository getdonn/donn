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

  it("returns fresh copies", () => {
    templates()[0]!.services.push("drive");
    expect(templates()[0]!.services).not.toContain("drive");
  });
});
