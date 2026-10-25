import { posix } from "node:path";
import { z } from "zod";

export const API_VERSION = "donn/v0";
export const IR_VERSION = 0;

export const LAYERS = ["org", "area", "team", "project", "user"] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

// Harness-neutral hook events. Adapters map these to native names (pre-tool-use → PreToolUse)
// and report events their harness lacks.
export const HOOK_EVENTS = [
  "session-start",
  "session-end",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "stop",
  "subagent-stop",
  "pre-compact",
  "notification",
] as const;
export const HookEvent = z.enum(HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEvent>;

/** Lowercase kebab-case identifier: instruction, hook and knowledge ids, skill names. */
export const Id = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase kebab-case");

/** A persona reference: `<layer>/<name>`, optionally with further `/` segments. */
export const Ref = z
  .string()
  .regex(
    new RegExp(`^(${LAYERS.join("|")})(/[a-z0-9]+(-[a-z0-9]+)*)+$`),
    "must be <layer>/<name> with a known layer",
  );
export type Ref = z.infer<typeof Ref>;

/** MCP server names are keys in harness config, so allow what harnesses allow. */
export const ServerName = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** An instruction fragment's content: exactly one of a file path or inline text. */
export function withInstructionSource<T extends z.ZodRawShape>(shape: T) {
  return z.union([
    z.strictObject({ ...shape, file: z.string().min(1) }),
    z.strictObject({ ...shape, inline: z.string().min(1) }),
  ]);
}

export const McpServer = z.union([
  z.strictObject({ ref: z.string().regex(/^gateway:\/\/.+/) }),
  z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    url: z.url(),
    transport: z.enum(["http", "sse"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type McpServer = z.infer<typeof McpServer>;

export const Hook = z.strictObject({
  id: Id,
  run: z.string().min(1),
  matcher: z.string().min(1).optional(),
});
export type Hook = z.infer<typeof Hook>;

export const KnowledgePointer = z.strictObject({
  id: Id,
  source: z.string().min(1),
});
export type KnowledgePointer = z.infer<typeof KnowledgePointer>;

/** Provider config is provider-specific; only `type` is common. */
export const SecretProvider = z.looseObject({ type: z.string().min(1) });
export type SecretProvider = z.infer<typeof SecretProvider>;

/** Per-harness escape hatch: opaque to the core, owned by each adapter. */
export const Targets = z.record(
  z.string().min(1),
  z.record(z.string(), z.unknown()),
);
export type Targets = z.infer<typeof Targets>;

/**
 * Harness-neutral enforcement, set only by org/area/team layers. Each key takes exactly one value;
 * absent means "not enforced". See docs/planning/21-managed-settings.md.
 */
export const Policy = z.strictObject({
  permissions: z.literal("exclusive").optional(),
  hooks: z.literal("exclusive").optional(),
  mcp: z.literal("exclusive").optional(),
  bypassPermissions: z.literal("disabled").optional(),
});
export type Policy = z.infer<typeof Policy>;

export const Labels = z.record(z.string(), z.string());

/**
 * Where model calls go, when not straight to the provider. `baseURL` belongs to the endpoint
 * types; the Vercel AI Gateway is addressed by name. See docs/planning/23-models-and-agents.md.
 */
export const ModelGateway = z
  .strictObject({
    type: z.enum(["openai-compatible", "anthropic", "vercel-ai-gateway"]),
    baseURL: z.url().optional(),
    apiKey: z
      .string()
      .regex(/^secret:\/\//, "must be a secret:// ref")
      .optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((gateway, ctx) => {
    const named = gateway.type === "vercel-ai-gateway";
    if (named && gateway.baseURL !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: "not allowed for vercel-ai-gateway",
      });
    } else if (!named && gateway.baseURL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: `required for ${gateway.type}`,
      });
    }
  });
export type ModelGateway = z.infer<typeof ModelGateway>;

export const Models = z.strictObject({
  gateway: ModelGateway.optional(),
  default: z.string().min(1).optional(),
});
export type Models = z.infer<typeof Models>;

/** An agent's name: an Id, within eve's own name limit. */
export const AgentName = Id.max(64);
export type AgentName = z.infer<typeof AgentName>;

export const AgentTarget = z.enum(["local", "self-host", "vercel"]);
export type AgentTarget = z.infer<typeof AgentTarget>;

/** A project-relative directory: stays inside the project and outside `.donn/`. */
export const AgentPath = z.string().refine((value) => {
  const path = posix.normalize(value);
  return (
    !posix.isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith("../") &&
    path !== ".donn" &&
    !path.startsWith(".donn/")
  );
}, "must stay inside the project and outside .donn/");
export type AgentPath = z.infer<typeof AgentPath>;

/** An environment variable name for an agent; `DONN_` is donn's own. */
export const EnvName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be UPPER_SNAKE_CASE")
  .refine((name) => !name.startsWith("DONN_"), "the DONN_ prefix is reserved");
export type EnvName = z.infer<typeof EnvName>;

const EVE_TEMPLATE = /^eve:[a-z0-9]+(-[a-z0-9]+)*$/;

/** `eve:<slug>`, or a path relative to the persona file. */
export const AgentTemplate = z.string().refine((value) => {
  if (value.startsWith("eve:")) return EVE_TEMPLATE.test(value);
  if (value === "") return false;
  const path = posix.normalize(value);
  return !posix.isAbsolute(path) && path !== ".." && !path.startsWith("../");
}, "must be eve:<slug> or a relative path inside the personas root");
export type AgentTemplate = z.infer<typeof AgentTemplate>;
