import type { ReportEntry } from "@getdonn/adapter-sdk";
import type { ResolvedPersona } from "@getdonn/spec";
import { EveCompileError } from "./errors.js";
import { propertyKey, SecretNames, valueExpression } from "./env.js";

// `agent/lib/donn/config.ts` and `agent/sandbox.ts`. See docs/planning/24-adapter-eve.md,
// section 2, and spikes/eve-slots/FINDINGS.md (Q4, Q6) for the shapes eve 0.83.2 accepts.

export const CONFIG_FILE = "agent/lib/donn/config.ts";
export const SANDBOX_FILE = "agent/sandbox.ts";

/** The provider name that keeps eve from treating a gateway as a known provider. */
const GATEWAY_NAME = "donn-gateway";

export const SANDBOX_TS = `import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.environment();
export default defineSandbox(() => environment.open({ networkPolicy: "allow-all" }));
`;

export interface ConfigResult {
  content: string;
  /** Env names this file's output relies on, for `env.ts`. */
  envNames: string[];
  /** Env groups of which any one variable satisfies the need (a world's connection string). */
  envAnyOf: string[][];
  /** The direct secret map this file adds (`AI_GATEWAY_API_KEY`), beside the numbered ones. */
  secretEnv: Record<string, `secret://${string}`>;
  entries: ReportEntry[];
}

const object = (entries: [string, string][], indent: string) =>
  `{\n${entries.map(([k, v]) => `${indent}  ${propertyKey(k)}: ${v},`).join("\n")}\n${indent}}`;

/** The agent's model id: its own `model`, else `models.default`; neither is a refusal. */
function modelId(ir: ResolvedPersona, agent: string): string {
  const id = ir.agents[agent]!.model ?? ir.models.default;
  if (id === undefined) {
    throw new EveCompileError(
      "model-needs-gateway",
      `no model for agent "${agent}": set agents.${agent}.model or models.default (and models.gateway unless the model is anthropic/ or openai/)`,
    );
  }
  return id;
}

export function configFile(
  ir: ResolvedPersona,
  agent: string,
  secrets: SecretNames,
): ConfigResult {
  const id = modelId(ir, agent);
  const target = ir.agents[agent]!.target;
  const { gateway } = ir.models;
  const imports: string[] = [];
  const setup: string[] = [];
  const envNames: string[] = [];
  const envAnyOf: string[][] = [];
  const secretEnv: ConfigResult["secretEnv"] = {};
  const entries: ReportEntry[] = [];
  let model: string;
  // Anything but a plain string id is a model object, which gets the missing-env guard.
  let guarded = true;
  const contextWindow = (ir.targets.eve ?? {}).contextWindow;
  const validWindow =
    typeof contextWindow === "number" &&
    Number.isInteger(contextWindow) &&
    contextWindow > 0;
  const modelPath = ir.agents[agent]!.model
    ? `agents.${agent}.model`
    : "models.default";

  if (gateway === undefined) {
    const [provider, ...rest] = id.split("/");
    const bare = rest.join("/");
    if ((provider !== "anthropic" && provider !== "openai") || bare === "") {
      throw new EveCompileError(
        "model-needs-gateway",
        `set models.gateway, or use an anthropic/ or openai/ model (model "${id}" for agent "${agent}")`,
      );
    }
    imports.push(`import { ${provider} } from "eve/models/${provider}";`);
    model = `${provider}(${JSON.stringify(bare)})`;
    // A local run can use the credentials `eve /login` stored.
    if (target !== "local")
      envNames.push(
        provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
      );
  } else if (gateway.type === "vercel-ai-gateway") {
    model = JSON.stringify(id);
    guarded = false;
    if (gateway.apiKey !== undefined) {
      secretEnv.AI_GATEWAY_API_KEY = gateway.apiKey as `secret://${string}`;
    }
    // On Vercel, OIDC stands in for the key.
    if (gateway.apiKey !== undefined || target !== "vercel")
      envNames.push("AI_GATEWAY_API_KEY");
    if (gateway.headers !== undefined) {
      entries.push({
        path: "models.gateway.headers",
        outcome: "dropped",
        reason:
          "the Vercel AI Gateway is addressed by its model id and takes no custom headers here",
      });
    }
  } else {
    const options: [string, string][] = [];
    if (gateway.type === "openai-compatible") {
      imports.push(
        'import { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
      );
    } else {
      imports.push('import { createAnthropic } from "@ai-sdk/anthropic";');
    }
    // A name keeps eve from taking an OpenAI-compatible endpoint for the OpenAI provider and
    // adding built-in tools the gateway may reject. The anthropic form is the one the spike built.
    if (gateway.type === "openai-compatible") {
      if (!validWindow) {
        throw new EveCompileError(
          "context-window-required",
          "set targets.eve.contextWindow: eve cannot look up a custom gateway's model in the AI Gateway catalog",
        );
      }
      options.push(["name", JSON.stringify(GATEWAY_NAME)]);
    } else if (!validWindow && contextWindow === undefined) {
      entries.push({
        path: modelPath,
        outcome: "advisory",
        reason:
          "eve looks the model up in the AI Gateway catalog at build (it needs the network); if the catalog lacks it, set targets.eve.contextWindow",
      });
    }
    options.push(["baseURL", valueExpression(gateway.baseURL!, secrets)]);
    if (gateway.apiKey !== undefined)
      options.push(["apiKey", valueExpression(gateway.apiKey, secrets)]);
    const headers = Object.entries(gateway.headers ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (headers.length > 0) {
      options.push([
        "headers",
        object(
          headers.map(([k, v]): [string, string] => [
            k,
            valueExpression(v, secrets),
          ]),
          "  ",
        ),
      ]);
    }
    if (gateway.type === "openai-compatible")
      options.push(["includeUsage", "true"]);
    const factory =
      gateway.type === "openai-compatible"
        ? "createOpenAICompatible"
        : "createAnthropic";
    setup.push(`const gateway = ${factory}(${object(options, "")});`);
    model = `gateway(${JSON.stringify(id)})`;
  }

  const donn: [string, string][] = [["model", "model"]];
  if (validWindow) {
    donn.push(["modelContextWindowTokens", String(contextWindow)]);
  } else if (contextWindow !== undefined) {
    entries.push({
      path: "targets.eve.contextWindow",
      outcome: "dropped",
      reason: `contextWindow must be a positive integer, not ${JSON.stringify(contextWindow)}`,
    });
  }
  if (ir.agents[agent]!.world === "postgres") {
    donn.push([
      "experimental",
      '{ workflow: { world: "@workflow/world-postgres" } }',
    ]);
    // The world reads WORKFLOW_POSTGRES_URL and falls back to DATABASE_URL.
    envAnyOf.push(["WORKFLOW_POSTGRES_URL", "DATABASE_URL"]);
  }

  const content = [
    "// Generated by donn; edit the persona, not this file.",
    ...(guarded
      ? [
          'import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";',
        ]
      : []),
    // Loading env.ts warns about missing variables; the guard below refuses to call the model.
    guarded ? 'import { missingEnv } from "./env";' : 'import "./env";',
    ...imports,
    "",
    ...setup,
    ...(guarded
      ? [
          `const base = ${model};`,
          "",
          "// eve builds the agent without the run-time environment, so a missing variable fails",
          "// here, at the first model call, naming every one.",
          "const guard: LanguageModelMiddleware = {",
          "  wrapGenerate: async ({ doGenerate }) => {",
          "    refuseWhenMissing();",
          "    return doGenerate();",
          "  },",
          "  wrapStream: async ({ doStream }) => {",
          "    refuseWhenMissing();",
          "    return doStream();",
          "  },",
          "};",
          "function refuseWhenMissing(): void {",
          "  const missing = missingEnv();",
          "  if (missing.length > 0) {",
          "    throw new Error(",
          '      `donn: missing environment variables: ${missing.join(", ")}`,',
          "    );",
          "  }",
          "}",
          // eve's own providers may return a plain model id.
          'const model =\n  typeof base === "string"\n    ? base\n    : wrapLanguageModel({ model: base, middleware: guard });',
        ]
      : [`const model = ${model};`]),
    "",
    "// eve accepts exactly these keys; `agent.ts` spreads this object into defineAgent.",
    `export const donn = {\n${donn
      .map(([k, v]) => (k === v ? `  ${k},` : `  ${k}: ${v},`))
      .join("\n")}\n};`,
    "",
  ].join("\n");
  return { content, envNames, envAnyOf, secretEnv, entries };
}
