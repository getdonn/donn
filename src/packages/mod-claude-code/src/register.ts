import type { H, Hook, Mod$, Next, On, Options } from "./api.js";
import { runCli, type CliResult } from "./cli.js";
import {
  bandText,
  commandText,
  launchedFrom,
  nudgeText,
  personaCommand,
  USAGE,
  type Here,
  type Launched,
} from "./decide.js";

// The zzpersona mod for Claude Code: the active persona in the band above the prompt, a nudge
// when this folder selects a different one, and /persona. It never changes the session's
// persona. See docs/planning/09-mod-claude-code.md.

declare const h: H;

const toHere = (result: CliResult): Here =>
  result.ok
    ? {
        kind: "persona",
        ...(result.json as { persona: string; source: never }),
      }
    : result.code === "no-persona"
      ? { kind: "none" }
      : { kind: "unavailable", reason: result.reason };

// Module state: the engine runs register (and session.start) again on a reload, so register
// resets it. Hooks are top-level functions, as the engine's static checks require.
let showBand = true;
let showNudge = true;
let launched: Launched | undefined;
let here: Here = { kind: "none" };
let nudged = false;

/** What this folder selects, asked once at start and again after a /persona command. */
async function refresh($: Mod$): Promise<void> {
  here = toHere(await runCli($, ["switch"], await $.session.cwd()));
  $.ui.invalidate("ui.render");
}

async function onStart($: Mod$, e: unknown, next: Next): Promise<unknown> {
  await $.command.register({
    name: "persona",
    description: "Show, list or switch zzpersona personas",
    argumentHint: "[list | switch <persona> [--default] | clear [--default]]",
  });
  // Literal names: the engine lists the variables a mod reads.
  launched = launchedFrom(
    await $.env.get("ZZPERSONA_PERSONA"),
    await $.env.get("ZZPERSONA_SOURCE"),
    await $.env.get("ZZPERSONA_PROJECT"),
  );
  // In the background: the session starts without waiting for the CLI.
  void refresh($).then(() => {
    const text = nudgeText(launched, here);
    if (showNudge && !nudged && text !== undefined) {
      nudged = true;
      $.ui.status(text);
    }
  });
  return next(e);
}

async function onBand($: Mod$, e: unknown, next: Next): Promise<unknown> {
  const text = showBand ? bandText(launched, here) : undefined;
  if (text === undefined) return next(e);
  const { Box, Text } = $.ui.resolve(e);
  return h(Box, null, h(Text, { dimColor: true }, text), await next(e));
}

async function onPersona($: Mod$, e: { args?: string }): Promise<unknown> {
  $.ui.status(undefined);
  const command = personaCommand(e.args ?? "");
  if ("usage" in command) return { text: USAGE };
  const result = await runCli($, command.argv, await $.session.cwd());
  if (command.form === "show") here = toHere(result);
  // A folder with no persona is an answer for `/persona`, not an error.
  const isAnswer = command.form === "show" && here.kind === "none";
  if (!result.ok && !isAnswer) return { text: `zzpersona: ${result.reason}` };
  if (command.form !== "show") await refresh($);
  const json = result.ok ? result.json : {};
  return { text: commandText(command.form, json, launched, here) };
}

export function register(on: On, options: Options = {}): void {
  showBand = options.band !== false;
  showNudge = options.nudge !== false;
  launched = undefined;
  here = { kind: "none" };
  nudged = false;
  on("session.start", onStart as Hook);
  on("ui.render", { component: "AbovePrompt" }, onBand as Hook);
  on("command.run", { command: "persona" }, onPersona as Hook);
}
