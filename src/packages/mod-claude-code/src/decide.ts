// What the mod shows and says, as pure functions of the launch variables and the CLI's --json
// output. See docs/planning/09-mod-claude-code.md, sections 2 and 3.

export type Source = "argument" | "switch" | "project" | "default";
const SOURCES: readonly string[] = ["argument", "switch", "project", "default"];

/** The persona `zzpersona claude` launched this session with, from its environment. */
export interface Launched {
  persona: string;
  source: Source;
  project?: string;
}

/** What this folder selects, from `zzpersona switch --json`. */
export type Here =
  | { kind: "persona"; persona: string; source: Source; project?: string }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string };

export type Form = "show" | "list" | "switch" | "use" | "clear";

/** What `zzpersona live` reports (docs/planning/10-live-switching.md §2). */
export interface LiveState {
  persona: string;
  previous: string;
  launched: string;
  instructions: string;
  held: ("mcp" | "permissions")[];
  stricter: boolean;
  plugin: string;
  appliedAt: string;
}

/** A live persona other than the launched one; switching back clears it. */
const activeLive = (live: LiveState | undefined) =>
  live !== undefined && live.persona !== live.launched ? live : undefined;

const LAYER_ORDER: readonly string[] = [
  "org",
  "area",
  "team",
  "project",
  "user",
];

export const USAGE =
  "usage: /persona [list | switch <persona> [--default] | use <persona> | clear [--default]]";

export function launchedFrom(
  persona: string | undefined,
  source: string | undefined,
  project: string | undefined,
): Launched | undefined {
  if (!persona || !source || !SOURCES.includes(source)) return undefined;
  return {
    persona,
    source: source as Source,
    ...(project ? { project } : {}),
  };
}

/** A selection only the default made says nothing about this folder. */
const folderSpecific = (here: Here): here is Here & { kind: "persona" } =>
  here.kind === "persona" && here.source !== "default";

const HELD_BAND = {
  "mcp,permissions": "MCP and permissions",
  mcp: "MCP",
  permissions: "permissions",
} as Record<string, string>;

export function bandText(
  launched: Launched | undefined,
  here: Here,
  live?: LiveState,
): string | undefined {
  const switched = activeLive(live);
  if (switched) {
    const held = HELD_BAND[switched.held.join(",")];
    return `persona ${switched.persona} · live${held ? ` · ${held} from ${switched.launched}` : ""}`;
  }
  if (launched) return `persona ${launched.persona} · ${launched.source}`;
  if (folderSpecific(here))
    return `persona none · this folder uses ${here.persona}`;
  return undefined;
}

export function nudgeText(
  current: Launched | undefined,
  here: Here,
  live?: LiveState,
): string | undefined {
  // After a live switch the session runs the live persona.
  const switched = activeLive(live);
  const launched =
    switched && current ? { ...current, persona: switched.persona } : current;
  if (here.kind === "unavailable")
    return `zzpersona unavailable: ${here.reason}`;
  if (!folderSpecific(here)) return undefined;
  if (!launched) {
    return `this folder uses ${here.persona}; start with zzpersona claude to load it`;
  }
  if (here.persona === launched.persona) return undefined;
  return `this folder uses ${here.persona} (${here.source}); this session runs ${launched.persona}. /persona switch ${here.persona}, then relaunch`;
}

/** `/persona <args>` → the CLI arguments to run, or the usage line. */
export function personaCommand(
  args: string,
): { form: Form; argv: string[] } | { usage: string } {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const isDefault = words.includes("--default");
  const [verb, ...rest] = words.filter((w) => w !== "--default");
  const flag = isDefault ? ["--default"] : [];
  if (verb === undefined && !isDefault)
    return { form: "show", argv: ["switch"] };
  if (verb === "list" && rest.length === 0 && !isDefault)
    return { form: "list", argv: ["list"] };
  // A ref never starts with "-": `/persona switch --clear` must not reach the CLI as a flag.
  if (
    verb === "use" &&
    rest.length === 1 &&
    !isDefault &&
    !rest[0]!.startsWith("-")
  )
    return { form: "use", argv: ["live", rest[0]!] };
  if (verb === "switch" && rest.length === 1 && !rest[0]!.startsWith("-"))
    return { form: "switch", argv: ["switch", rest[0]!, ...flag] };
  if (verb === "clear" && rest.length === 0)
    return { form: "clear", argv: ["switch", "--clear", ...flag] };
  return { usage: USAGE };
}

const repoOf = (project: string) => project.replace(/\/\.zzpersona\/?$/, "");

function folderLine(here: Here, now = false): string {
  const uses = now ? "now uses" : "uses";
  if (here.kind === "persona")
    return `this folder ${uses} ${here.persona} (${here.source})`;
  if (here.kind === "none") return "this folder uses no persona";
  return `zzpersona unavailable: ${here.reason}`;
}

type Json = Record<string, unknown>;

/** The text `/persona` prints for a successful CLI call. */
export function commandText(
  form: Form,
  json: unknown,
  launched: Launched | undefined,
  here: Here,
): string {
  const data = (json ?? {}) as Json;
  if (form === "show") {
    if (!launched)
      return `this session runs no persona (it was not started by zzpersona claude)\n${folderLine(here)}`;
    const session = `this session runs ${launched.persona} (${launched.source})`;
    return here.kind === "persona" && here.persona === launched.persona
      ? `${session}, which this folder uses`
      : `${session}\n${folderLine(here)}`;
  }
  if (form === "list") {
    const personas = (data.personas ?? []) as { ref: string; layer: string }[];
    // Inheritance order, as `zzpersona list` prints it; unknown layers last.
    const rank = (layer: string) => {
      const i = LAYER_ORDER.indexOf(layer);
      return i === -1 ? LAYER_ORDER.length : i;
    };
    const layers = [...new Set(personas.map((p) => p.layer))].sort(
      (a, b) => rank(a) - rank(b),
    );
    return layers
      .flatMap((layer) => [
        `${layer}:`,
        ...personas
          .filter((p) => p.layer === layer)
          .map((p) => {
            const marks = [
              ...(launched?.persona === p.ref ? ["this session"] : []),
              ...(here.kind === "persona" && here.persona === p.ref
                ? ["this folder"]
                : []),
            ];
            return `  ${p.ref}${marks.length ? `  (${marks.join(", ")})` : ""}`;
          }),
      ])
      .join("\n");
  }
  if (form === "switch") {
    const persona = String(data.persona);
    const saved =
      data.scope === "project" && typeof data.project === "string"
        ? `${persona} is now used for ${repoOf(data.project)}.`
        : `${persona} is now your default.`;
    if (launched?.persona === persona || data.scope !== "project") return saved;
    return [
      saved,
      `This session still runs ${launched?.persona ?? "no persona"}. To apply it, exit and run:`,
      "  zzpersona claude",
      // Verified (spikes/mod-smoke): a resumed session keeps the system prompt it began with.
      "(zzpersona claude -- --continue keeps this conversation, but not the new persona's instructions.)",
    ].join("\n");
  }
  const cleared =
    data.persona === null || data.persona === undefined
      ? "nothing to clear"
      : `cleared ${data.scope === "project" ? "this project's switch" : "your default"} (${String(data.persona)})`;
  return `${cleared}\n${folderLine(here, here.kind === "persona")}`;
}

/** The system prompt section a live switch adds; none once back on the launched persona. */
export function liveSection(
  live: LiveState,
):
  { id: "zzpersona:live-persona"; text: string; scope: "session" } | undefined {
  if (!activeLive(live)) return undefined;
  return {
    id: "zzpersona:live-persona",
    scope: "session",
    text: [
      `The persona for this session is now ${live.persona}. Disregard the section headed`,
      `"## zzpersona persona: ${live.launched}"; the instructions below replace it.`,
      "",
      live.instructions.trimEnd(),
    ].join("\n"),
  };
}

const HELD_TEXT = { mcp: "MCP servers", permissions: "permissions" };

/** What `/persona use` and `/persona switch` print after a live switch. */
export function liveText(live: LiveState, saved?: string): string {
  return [
    ...(saved ? [saved] : []),
    `${live.persona} is now live in this session (skills, hooks, agents, instructions).`,
    ...(live.held.length > 0
      ? [
          `Still from ${live.launched} until you relaunch: ${live.held.map((h) => HELD_TEXT[h]).join(", ")}.`,
          "To apply those too, exit and run: zzpersona claude",
        ]
      : []),
    ...(live.stricter
      ? [
          `${live.persona} denies more than ${live.launched}; those rules apply after a relaunch.`,
        ]
      : []),
  ].join("\n");
}
