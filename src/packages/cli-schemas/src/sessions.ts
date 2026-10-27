import { z } from "zod";
import { AgentTarget, RecreateField } from "./common.js";
import { ManagedCheck } from "./managed.js";

const SessionBase = {
  dir: z.string(),
  harness: z.enum(["claude-code", "codex"]),
  project: z.string().optional(),
  /** The persona the session launched with. */
  launched: z.string(),
  /** The persona swapped in since, when there was a swap. */
  live: z.string().optional(),
  startedAt: z.string().optional(),
  /** What a relaunch would change that a swap cannot. */
  held: z.array(z.string()),
};

/** A created agent as `donn status` shows it: every agent made on this machine. */
const CreatedAgent = z.strictObject({
  name: z.string(),
  project: z.string(),
  target: z.union([AgentTarget, z.literal("-")]),
  state: z.enum(["created", "running", "built", "deployed", "unknown"]),
  current: z.boolean(),
  url: z.string().optional(),
  recreate: RecreateField.optional(),
  /** The code the daemon's last sync of it stopped with. */
  syncFailed: z.string().optional(),
});

/** `managed`: the managed-settings check, or the error the check ended with. */
const ManagedStatus = z.union([
  ManagedCheck,
  z.strictObject({
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);

/** `state.json`: the default and each project's switch, keyed by its `.donn` real path. */
const Switched = z.strictObject({
  default: z.string().optional(),
  projects: z.record(z.string(), z.string()),
  error: z.string().optional(),
});

/**
 * `donn status --json`, two shapes: with the daemon running (`daemon: true`, its own status and
 * its sessions with their refresh `state`), or without it (`daemon: false`, the sessions the
 * session registry shows).
 */
export const StatusOutput = z.union([
  z.strictObject({
    daemon: z.literal(true),
    version: z.string(),
    pid: z.number().int(),
    startedAt: z.string(),
    service: z.boolean(),
    watching: z.array(z.string()),
    sessions: z.array(
      z.strictObject({
        ...SessionBase,
        state: z.enum(["current", "refreshed", "stale", "refresh-failed"]),
        at: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
    syncFailed: z
      .array(
        z.strictObject({
          name: z.string(),
          project: z.string(),
          code: z.string(),
        }),
      )
      .optional(),
    agents: z.array(CreatedAgent),
    managed: ManagedStatus,
    switched: Switched,
  }),
  z.strictObject({
    daemon: z.literal(false),
    sessions: z.array(z.strictObject(SessionBase)),
    agents: z.array(CreatedAgent),
    managed: ManagedStatus,
    switched: Switched,
  }),
]);
export type StatusOutput = z.infer<typeof StatusOutput>;
