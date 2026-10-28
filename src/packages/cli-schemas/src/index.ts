import type { z } from "zod";
import {
  AgentAddOutput,
  AgentBuildOutput,
  AgentCreateOutput,
  AgentDeployOutput,
  AgentEnvOutput,
  AgentListOutput,
  AgentLogsOutput,
  AgentRunOutput,
  AgentStopOutput,
  AgentSyncOutput,
  AgentTemplatesOutput,
  AgentVendorOutput,
} from "./agents.js";
import { CapabilitiesOutput } from "./capabilities.js";
import { DoctorOutput } from "./doctor.js";
import { ManagedBuildOutput, ManagedCheckOutput } from "./managed.js";
import {
  CompileOutput,
  DiffOutput,
  ListOutput,
  ResolveOutput,
  SwitchOutput,
  WriteOutput,
} from "./personas.js";
import {
  LoginOutput,
  LogoutOutput,
  PublishOutput,
  PullOutput,
  WhoamiOutput,
} from "./registry.js";
import { StatusOutput } from "./sessions.js";

// The `--json` output of the donn CLI as zod schemas, for the GUI's bridge and app
// (docs/planning/26-gui.md section 4). Private; no Node built-ins, so the app can bundle it.

export * from "./agents.js";
export * from "./capabilities.js";
export * from "./common.js";
export * from "./doctor.js";
export * from "./errors.js";
export * from "./managed.js";
export * from "./personas.js";
export * from "./registry.js";
export * from "./sessions.js";

/**
 * Each allowlisted command's `--json` stdout, keyed by the command path with spaces
 * (`"agent list"`). A command with several shapes is a union of them. `resolve --explain` is not
 * a key: under `--json` it prints what `resolve` does. Typed per key, so the app's client
 * infers each command's result.
 */
export const COMMAND_OUTPUTS = {
  list: ListOutput,
  switch: SwitchOutput,
  resolve: ResolveOutput,
  compile: CompileOutput,
  capabilities: CapabilitiesOutput,
  diff: DiffOutput,
  status: StatusOutput,
  doctor: DoctorOutput,
  whoami: WhoamiOutput,
  login: LoginOutput,
  logout: LogoutOutput,
  pull: PullOutput,
  publish: PublishOutput,
  write: WriteOutput,
  "managed build": ManagedBuildOutput,
  "managed check": ManagedCheckOutput,
  "agent list": AgentListOutput,
  "agent create": AgentCreateOutput,
  "agent sync": AgentSyncOutput,
  "agent env": AgentEnvOutput,
  "agent run": AgentRunOutput,
  "agent stop": AgentStopOutput,
  "agent build": AgentBuildOutput,
  "agent deploy": AgentDeployOutput,
  "agent logs": AgentLogsOutput,
  "agent add": AgentAddOutput,
  "agent templates": AgentTemplatesOutput,
  "agent vendor": AgentVendorOutput,
} satisfies Record<string, z.ZodType>;

/** A command the UI runs, by its `COMMAND_OUTPUTS` key. */
export type CommandName = keyof typeof COMMAND_OUTPUTS;

/** What `command` prints under `--json`, parsed. */
export type CommandOutput<C extends CommandName> = z.infer<
  (typeof COMMAND_OUTPUTS)[C]
>;
