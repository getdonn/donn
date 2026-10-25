import type { PortabilityEntry } from "@getdonn/adapter-sdk";
import { describe, expect, it } from "vitest";
import { isKnownTemplate, portability, portabilityFor } from "./portability.js";
import { templates } from "./templates.js";

const targets = ["local", "self-host"] as const;
const find = (entries: PortabilityEntry[], service: string, text?: string) =>
  entries.filter(
    (e) => e.service === service && (!text || e.instead.includes(text)),
  );

describe("portability", () => {
  it("reports nothing on vercel", () => {
    for (const { slug } of templates())
      expect(portability(`eve:${slug}`, "vercel")).toEqual([]);
    expect(portability("eve:blank", "vercel")).toEqual([]);
  });

  for (const target of targets) {
    describe(target, () => {
      it("blank and path templates carry route auth only", () => {
        for (const template of ["eve:blank", "./my-template"]) {
          const entries = portability(template, target);
          expect(entries.map((e) => e.service)).toEqual(["route-auth"]);
          expect(entries[0]).toMatchObject({
            target,
            blocking: true,
            instead: expect.stringContaining("Basic, JWT or OIDC"),
          });
        }
      });

      it("connect: a GitHub App and a Slack app of your own, blocking", () => {
        const entries = portability("eve:eve-coding-agent-template", target);
        const github = find(entries, "connect", "GitHub App");
        expect(github).toEqual([
          expect.objectContaining({
            blocking: true,
            env: [
              "GITHUB_APP_ID",
              "GITHUB_APP_PRIVATE_KEY",
              "GITHUB_WEBHOOK_SECRET",
            ],
          }),
        ]);
        expect(find(entries, "connect", "Slack")[0]).toMatchObject({
          blocking: true,
          env: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
        });
      });

      it("sandbox: Docker, blocking only with a domain allow-list or credential transform", () => {
        const coding = find(
          portability("eve:eve-coding-agent-template", target),
          "sandbox",
        );
        expect(coding).toHaveLength(1);
        expect(coding[0]).toMatchObject({ blocking: true });
        expect(coding[0]!.instead).toContain("allow-all");
        // company-brain authors a sandbox, but a local one.
        const plain = portability("eve:eve-company-brain-template", target);
        expect(find(plain, "sandbox")).toEqual([]);
      });

      it("github-checkout does not block", () => {
        const entries = find(
          portability("eve:eve-coding-agent-template", target),
          "github-checkout",
        );
        expect(entries).toEqual([expect.objectContaining({ blocking: false })]);
        expect(entries[0]!.instead).toContain("diff");
      });

      it("ai-gateway does not block and points at lib/donn/config.ts", () => {
        const entries = find(
          portability("eve:eve-voice-template", target),
          "ai-gateway",
        );
        expect(entries).toEqual([expect.objectContaining({ blocking: false })]);
        expect(entries[0]!.instead).toContain("lib/donn/config.ts");
      });

      it("daemons block, with no self-hosted equivalent", () => {
        const entries = find(
          portability("eve:eve-discord-agent", target),
          "daemons",
        );
        expect(entries).toEqual([expect.objectContaining({ blocking: true })]);
        expect(entries[0]!.instead).toContain("No self-hosted equivalent");
      });

      it("drive blocks (no in-repo template uses it, so test the table)", () => {
        const entries = portabilityFor(
          { services: ["drive"], connect: [], sandboxNetworkPolicy: false },
          target,
        );
        expect(entries.find((e) => e.service === "drive")).toMatchObject({
          blocking: true,
          instead: expect.stringContaining("No self-hosted equivalent"),
        });
      });

      it("every entry names its target and is deterministic", () => {
        for (const { slug } of templates()) {
          const a = portability(`eve:${slug}`, target);
          expect(a.every((e) => e.target === target)).toBe(true);
          expect(portability(`eve:${slug}`, target)).toEqual(a);
        }
      });
    });
  }

  it("an unknown slug is not known; it still carries route auth", () => {
    expect(isKnownTemplate("eve:kody-eve-template")).toBe(false);
    expect(isKnownTemplate("eve:blank")).toBe(true);
    expect(isKnownTemplate("./path")).toBe(true);
    expect(isKnownTemplate("eve:eve-chat-template")).toBe(true);
    expect(
      portability("eve:kody-eve-template", "self-host").map((e) => e.service),
    ).toEqual(["route-auth"]);
  });
});
