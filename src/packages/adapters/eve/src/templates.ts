import type { TemplateInfo, VercelService } from "@getdonn/adapter-sdk";

// The template table: which Vercel-only services each template's code uses. Read from the
// templates in `vercel/eve` `apps/templates/` at tag eve@0.83.2, commit
// 9f73f9dbe5841253657b9037614cb43887937fe8 (docs/planning/24-adapter-eve.md, section 5).
// Re-read it when `frameworkRange` moves. The six gallery templates in the repository carry
// their eve.dev gallery slug; two directories end in `-template` where the slug does not, hence
// `repoPath`. The other fourteen gallery templates live in their own repositories and have no
// row (they compile with a `portability-unknown` advisory).
//
// What counts as "uses": the template's own files name the service. The default sandbox every
// eve agent has is not a use (it runs on Docker outside Vercel and is not template code), so
// `sandbox` is listed only for a template that authors a Vercel sandbox. No in-repo template
// uses Vercel Drive (no `drive` in any source file); the first memory-using template,
// eve-chat-template, uses Vercel Blob (EVE_MEMORY_BLOB_*), which is not a listed service.

/** The Connect providers a template's code reaches, each with its own self-host replacement. */
export type ConnectProvider =
  "github" | "github-user" | "slack" | "discord" | "mcp";

/** What the table knows about a template beyond `TemplateInfo`. */
export interface TemplateFacts {
  services: VercelService[];
  /** The Connect providers (when `services` has `connect`). */
  connect: ConnectProvider[];
  /** The Vercel sandbox uses a domain allow-list or credential transform (Docker has neither). */
  sandboxNetworkPolicy: boolean;
  /** Subagents (`agent/subagents/*`) name their own AI Gateway models; only the top agent.ts is patched. */
  subagentModels: boolean;
  /** `agent.ts` carries `modelOptions.providerOptions.anthropic`, which only Anthropic models read. */
  anthropicModelOptions: boolean;
}

interface Row {
  slug: string;
  title: string;
  /** Directory under the repository root, when it differs from the slug. */
  dir?: string;
  /** `sha256-<hex>` of the template directory (spikes/eve-runner/FINDINGS-templates.md, T2). */
  digest: string;
  facts: TemplateFacts;
}

const REPO_ROOT = "apps/templates";
const none = (): Omit<TemplateFacts, "services"> => ({
  connect: [],
  sandboxNetworkPolicy: false,
  subagentModels: false,
  anthropicModelOptions: false,
});

const ROWS: Row[] = [
  {
    slug: "eve-chat-template",
    title: "Chat",
    digest:
      "sha256-f505db3dea24e2d6e5d3e318f6e386dc5981c27f3ecf558452f3f634b4172f1d",
    facts: {
      ...none(),
      // connect: agent/channels/slack.ts connectSlackCredentials(); agent/connections/{linear,
      //   notion,sentry}.ts auth: connect(...) from @vercel/connect/eve.
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-sonnet-5"` (a gateway string).
      services: ["connect", "ai-gateway"],
      connect: ["slack", "mcp"],
    },
  },
  {
    slug: "eve-coding-agent-template",
    title: "Coding Agent on Slack",
    digest:
      "sha256-55c8800e30fcd72e0429981b333f1850ac589da87587c3b879d01355a50c4201",
    facts: {
      ...none(),
      // connect: channels/github.ts connectGitHubCredentials(), channels/slack.ts
      //   connectSlackCredentials(), lib/github.ts GITHUB_CONNECTOR.
      // sandbox: agent/sandbox.ts VercelSandbox.environment(); lib/github.ts brokerGitHubLease
      //   calls setNetworkPolicy({ allow: { "*": [], ...rules } }), a domain allow-list with
      //   credential transforms, which Docker cannot do.
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-opus-5.5"`.
      // github-checkout: channels/github.ts is githubChannel(); hooks/reset-github-egress.ts
      //   resets "The GitHub channel's checkout" token egress.
      services: ["connect", "sandbox", "ai-gateway", "github-checkout"],
      connect: ["github", "slack"],
      sandboxNetworkPolicy: true,
    },
  },
  {
    slug: "eve-company-brain-template",
    title: "Company Brain",
    digest:
      "sha256-3286c1dc6b6830c3a34e6d8440fdacfd5490d818ffc464519462990f3369ba97",
    facts: {
      ...none(),
      // connect: channels/slack.ts connectSlackCredentials(). Its sandbox
      //   (sandbox/sandbox.ts) is JustBashSandbox, not a Vercel service.
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-sonnet-5"`.
      services: ["connect", "ai-gateway"],
      connect: ["slack"],
    },
  },
  {
    slug: "eve-voice-template",
    title: "Voice",
    digest:
      "sha256-70d1e5d0723f84093eb379569abd15cba37e6450520db1f8632cc4b9936da637",
    facts: {
      ...none(),
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-haiku-5.5"`. No Connect, sandbox
      //   or daemon file; its eve channel allows vercelOidc() (route auth, always reported).
      services: ["ai-gateway"],
    },
  },
  {
    slug: "eve-slack-agent",
    title: "Slack Assistant",
    dir: "eve-slack-agent-template",
    digest:
      "sha256-485a00d2717bcdfb804dec8fb2fc6ace74413857ec9ea7876ecb9060f7af0ee8",
    facts: {
      ...none(),
      // connect: channels/slack.ts connectSlackCredentials().
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-sonnet-5"`.
      services: ["connect", "ai-gateway"],
      connect: ["slack"],
    },
  },
  {
    slug: "eve-discord-agent",
    title: "Discord Agent",
    dir: "eve-discord-agent-template",
    digest:
      "sha256-82a7cce4ce80dabb6c14c4996d4f11f9502797c5bcd18eb797c2c970f3dc9e8c",
    facts: {
      ...none(),
      // connect: channels/discord.ts and tools/read_recent_messages.ts (connectDiscordCredentials,
      //   getToken from @vercel/connect).
      // daemons: vercel.json `"daemons"` with root `daemon` (the gateway relay, daemon/main.ts).
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-sonnet-5"`.
      services: ["connect", "daemons", "ai-gateway"],
      connect: ["discord"],
    },
  },
  {
    slug: "eve-llm-council-template",
    title: "LLM Council",
    digest:
      "sha256-5bbc9205570883efab83b2f88e226dd0d4b107a36e4b1249c494974b1715b49a",
    facts: {
      ...none(),
      // ai-gateway: agent/agent.ts and the four subagents/*/agent.ts name gateway strings
      //   ("anthropic/claude-opus-5", "spacexai/grok-4.7", "moonshotai/kimi-k3",
      //   "openai/gpt-5.6-sol"); only the top-level model is replaced by lib/donn/config.ts.
      services: ["ai-gateway"],
      subagentModels: true,
    },
  },
  {
    slug: "personal-agent-template",
    title: "Personal Agent",
    digest:
      "sha256-780bf87a0a36f5f39aeb3a07f567b9b1a589d3607733a63d5a4a6d6fa843d4fe",
    facts: {
      ...none(),
      // connect: channels/slack.ts connectSlackCredentials(); connections/linear.ts connect();
      //   tools/github.ts getToken() + UserAuthorizationRequiredError from @vercel/connect
      //   (per-user OAuth, not a GitHub App).
      // anthropicModelOptions: agent/agent.ts modelOptions.providerOptions.anthropic.thinking.
      // ai-gateway: agent/agent.ts `model: "anthropic/claude-sonnet-4.6"`.
      services: ["connect", "ai-gateway"],
      connect: ["slack", "mcp", "github-user"],
      anthropicModelOptions: true,
    },
  },
];

/** The known templates, by slug. */
export function templateFacts(slug: string): TemplateFacts | undefined {
  return ROWS.find((row) => row.slug === slug)?.facts;
}

/** The templates of eve's repository at the pinned tag, with the services their code uses. */
export function templates(): TemplateInfo[] {
  return ROWS.map(({ slug, title, dir, digest, facts }) => ({
    slug,
    title,
    repoPath: `${REPO_ROOT}/${dir ?? slug}`,
    digest,
    services: [...facts.services],
  }));
}
