import type { PortabilityEntry, ReportEntry } from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import type { ConnectProvider, TemplateFacts } from "./templates.js";
import { templateFacts } from "./templates.js";

// The portability report: what a template's Vercel-only services need at a target other than
// Vercel. See docs/planning/24-adapter-eve.md, section 5. At `vercel` everything is fine and
// there are no entries.

type Target = PortabilityEntry["target"];

/** The template name of a `eve:<slug>` template; `undefined` for a path template. */
function eveSlug(template: string): string | undefined {
  return template.startsWith("eve:")
    ? template.slice("eve:".length)
    : undefined;
}

/** `eve:blank` and path templates have no services; a known slug has a row. */
export function isKnownTemplate(template: string): boolean {
  const slug = eveSlug(template);
  return (
    slug === undefined || slug === "blank" || templateFacts(slug) !== undefined
  );
}

/** The report entry for a template with no row. A warning, never an error. */
export function unknownTemplateEntry(
  agent: string,
  template: string,
): ReportEntry {
  return {
    path: `agents.${agent}.template`,
    outcome: "advisory",
    reason: `portability-unknown: ${template} is not in the adapter's template table (only the templates of eve's repository are), so its use of Vercel-only services is not checked; only route auth is reported`,
  };
}

const CONNECT: Record<ConnectProvider, { instead: string; env?: string[] }> = {
  github: {
    instead:
      "Bring a GitHub App: set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET",
    env: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
  },
  slack: {
    instead: "Bring a Slack app: set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET",
    env: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  },
  discord: {
    instead:
      "Bring a Discord app: set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY",
    env: ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"],
  },
  "github-user": {
    instead:
      "Per-user GitHub sign-in uses Vercel Connect; off Vercel replace tools/github.ts with your own OAuth or token flow",
  },
  mcp: {
    instead:
      "Authorize the template's MCP connections yourself: replace the Vercel Connect auth in agent/connections/ with a token or OAuth of your own",
  },
};

const NO_EQUIVALENT =
  "No self-hosted equivalent in eve; pick another template or target";

/** The entries for a template's facts at a target. Ordered by service, then provider. */
export function portabilityFor(
  facts: Pick<TemplateFacts, "services"> &
    Partial<Omit<TemplateFacts, "services">>,
  target: Target,
): PortabilityEntry[] {
  if (target === "vercel") return [];
  const has = (s: TemplateFacts["services"][number]) =>
    facts.services.includes(s);
  const entries: PortabilityEntry[] = [];
  const add = (
    service: PortabilityEntry["service"],
    instead: string,
    blocking: boolean,
    env?: string[],
  ) =>
    entries.push({ target, service, instead, blocking, ...(env && { env }) });

  if (has("connect"))
    for (const provider of facts.connect ?? []) {
      const { instead, env } = CONNECT[provider];
      add("connect", instead, true, env);
    }
  if (has("sandbox")) {
    if (facts.sandboxNetworkPolicy)
      add(
        "sandbox",
        "The template's sandbox uses a domain allow-list or credential transform, which Docker does not support (it accepts only allow-all and deny-all); give the sandbox another network policy or run on Vercel",
        true,
      );
    else
      add("sandbox", "Runs on Docker; `donn doctor` checks the daemon", false);
  }
  if (has("github-checkout"))
    add(
      "github-checkout",
      "The GitHub channel checks the repository out into the sandbox only on a firewall-capable backend (Vercel). Here the agent gets the pull request's diff in context but not the repository's files",
      false,
    );
  if (has("ai-gateway"))
    add(
      "ai-gateway",
      "The template's model string is replaced by lib/donn/config.ts",
      false,
    );
  if (facts.subagentModels)
    add(
      "ai-gateway",
      "This template's subagents call the Vercel AI Gateway directly (agent/subagents/*/agent.ts): set AI_GATEWAY_API_KEY, or point each subagent's model at your gateway",
      true,
      ["AI_GATEWAY_API_KEY"],
    );
  if (has("drive")) add("drive", NO_EQUIVALENT, true);
  if (has("daemons")) add("daemons", NO_EQUIVALENT, true);
  add(
    "route-auth",
    "Configure Basic, JWT or OIDC auth for the agent's routes",
    true,
  );
  return entries;
}

/**
 * The portability entries of a template (`eve:<slug>`, `eve:blank` or a path) at a target.
 * `eve:blank`, path templates and unknown slugs list no services, so only route auth is
 * reported; compile adds `unknownTemplateEntry` for an unknown slug.
 */
export function portability(
  template: string,
  target: Target,
): PortabilityEntry[] {
  const slug = eveSlug(template);
  const facts = (slug !== undefined && templateFacts(slug)) || {
    services: [],
  };
  return portabilityFor(facts, target);
}

/**
 * Compile-report advisories that depend on the persona's model: a template whose `agent.ts`
 * holds Anthropic-only `modelOptions` keeps them when donn replaces `model`.
 */
export function templateModelEntries(
  agent: string,
  template: string,
  ir: ResolvedPersona,
): ReportEntry[] {
  const slug = eveSlug(template);
  if (slug === undefined || !templateFacts(slug)?.anthropicModelOptions)
    return [];
  const { gateway } = ir.models;
  const id = ir.agents[agent]?.model ?? ir.models.default ?? "";
  const anthropic =
    gateway === undefined
      ? id.startsWith("anthropic/")
      : gateway.type === "anthropic" ||
        (gateway.type === "vercel-ai-gateway" && id.startsWith("anthropic/"));
  if (anthropic) return [];
  return [
    {
      path: `agents.${agent}.template`,
      outcome: "advisory",
      reason:
        "the template's modelOptions.providerOptions.anthropic (thinking) applies only to Anthropic models; it is ignored otherwise",
    },
  ];
}
