import { z } from "zod";
import {
  API_VERSION,
  Hook,
  HOOK_EVENTS,
  HookEvent,
  Id,
  withInstructionSource,
  KnowledgePointer,
  Labels,
  McpServer,
  Ref,
  SecretProvider,
  ServerName,
  Targets,
} from "./common.js";

// Persona source files as authors write them. These schemas check shape only. Semantic rules
// (lock paths exist, user layer declares no locks, replace targets exist) belong to the resolver,
// which reports them with the offending layer. See resolver/fixtures/README.md.

const Position = z
  .string()
  .regex(
    /^(append|prepend|replace\([a-z0-9]+(-[a-z0-9]+)*\))$/,
    "append | prepend | replace(<id>)",
  );

export const InstructionFragment = withInstructionSource({
  id: Id,
  position: Position.optional(),
});
export type InstructionFragment = z.infer<typeof InstructionFragment>;

const RuleList = z.array(z.string().min(1));

const Permissions = z.strictObject({
  allow: RuleList.optional(),
  deny: RuleList.optional(),
  ask: RuleList.optional(),
  remove: z
    .strictObject({
      allow: RuleList.optional(),
      deny: RuleList.optional(),
      ask: RuleList.optional(),
    })
    .optional(),
});

const HookRemoval = z
  .string()
  .regex(
    new RegExp(`^(${HOOK_EVENTS.join("|")})\\[[a-z0-9]+(-[a-z0-9]+)*\\]$`),
    "<event>[<id>]",
  );

const Hooks = z.strictObject({
  ...Object.fromEntries(
    HookEvent.options.map((event) => [event, z.array(Hook).optional()]),
  ),
  remove: z.array(HookRemoval).optional(),
}) as z.ZodType<Partial<Record<HookEvent, Hook[]>> & { remove?: string[] }>;

/** Everything a layer can contribute. Shared by Persona and PersonaOverlay. */
const LayerBody = {
  instructions: z.array(InstructionFragment).optional(),
  skills: z
    .strictObject({
      include: z.array(z.string().min(1)).optional(),
      exclude: z.array(Id).optional(),
    })
    .optional(),
  mcp: z
    .strictObject({
      gateway: z
        .string()
        .regex(/^[a-z][a-z0-9+.-]*:\/\/.+/, "must be a URI")
        .optional(),
      servers: z.record(ServerName, McpServer).optional(),
      remove: z.array(ServerName).optional(),
    })
    .optional(),
  permissions: Permissions.optional(),
  hooks: Hooks.optional(),
  knowledge: z.array(KnowledgePointer).optional(),
  secrets: z
    .strictObject({
      providers: z.record(ServerName, SecretProvider).optional(),
    })
    .optional(),
  targets: Targets.optional(),
};

export const Persona = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("Persona"),
  metadata: z.strictObject({
    name: z.string().min(1),
    version: z.int().positive().optional(),
    description: z.string().optional(),
    labels: Labels.optional(),
  }),
  extends: z.array(Ref).optional(),
  locks: z.array(z.string().min(1)).optional(),
  ...LayerBody,
});
export type Persona = z.infer<typeof Persona>;

/** The user overlay: merged last, cannot name itself, inherit, or lock. */
export const PersonaOverlay = z.strictObject({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("PersonaOverlay"),
  ...LayerBody,
});
export type PersonaOverlay = z.infer<typeof PersonaOverlay>;

export const PersonaDocument = z.discriminatedUnion("kind", [
  Persona,
  PersonaOverlay,
]);
export type PersonaDocument = z.infer<typeof PersonaDocument>;
