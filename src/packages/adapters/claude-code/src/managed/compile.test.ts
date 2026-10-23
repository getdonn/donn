import { createHash } from "node:crypto";
import {
  AdapterInputError,
  type ManagedInput,
  type ManagedOs,
  type ManagedResult,
} from "@zzpersona/adapter-sdk";
import { ResolvedPersona } from "@zzpersona/spec";
import { describe, expect, it } from "vitest";
import adapter, {
  compileManaged,
  MANAGED_ROOTS,
  managedInputs,
} from "../index.js";
import { compareVersions, minClaudeCode } from "./keys.js";

// The managed policy bundle, one case per row of docs/planning/21-managed-settings.md, section 2.
// Each bundle is compared per file with test/golden/managed/<case>/<os>/; regenerate with
// `vitest run -u` after an intended change.

const OSES: ManagedOs[] = ["macos", "linux", "windows"];
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const ir = (
  fields: Partial<Omit<ResolvedPersona, "irVersion">> = {},
): ResolvedPersona =>
  ResolvedPersona.parse({
    irVersion: 0,
    layers: ["org/acme", "area/fintech", "team/payments"],
    metadata: { name: "payments", labels: {} },
    instructions: [],
    skills: [],
    mcp: { servers: {} },
    permissions: { allow: [], deny: [], ask: [] },
    hooks: {},
    knowledge: [],
    secrets: { providers: {} },
    locks: [],
    targets: {},
    policy: {},
    ...fields,
  });

const SCRIPTS: Record<string, Uint8Array> = {
  "org/hooks/block-prod-db.sh": encode(
    "#!/bin/sh\necho 'no prod db' >&2\nexit 2\n",
  ),
  "team/hooks/audit.sh": encode("#!/bin/sh\nexit 0\n"),
  "project/hooks/format.sh": encode("#!/bin/sh\npnpm format\n"),
};
const TEXTS: Record<string, string> = {
  "org/instructions/conduct.md":
    "\n  Review code the way you would want yours reviewed.  \n\n",
};

const input = (
  persona: ResolvedPersona,
  overrides: Partial<ManagedInput> = {},
): ManagedInput => ({
  ir: persona,
  layers: [
    { ref: "org/acme", version: 3, digest: `sha256:${"a".repeat(64)}` },
    { ref: "area/fintech", digest: `sha256:${"b".repeat(64)}` },
    { ref: "team/payments", version: 1, digest: `sha256:${"c".repeat(64)}` },
  ],
  os: "macos",
  zzpersona: "0.12.0",
  texts: TEXTS,
  scripts: SCRIPTS,
  ...overrides,
});

const bundleOf = (result: ManagedResult) => {
  if (!result.bundle) {
    throw new Error(`refused: ${JSON.stringify(result.report.entries)}`);
  }
  return result.bundle;
};

const json = (result: ManagedResult, path: string): unknown => {
  const bytes = bundleOf(result).files[path];
  if (!bytes) throw new Error(`no file ${path}`);
  return JSON.parse(decode(bytes));
};

const settings = (result: ManagedResult) =>
  json(result, "managed-settings.d/50-zzpersona.json") as Record<
    string,
    unknown
  >;

/** Compiles `persona` for every OS and compares each file with its golden. */
async function goldens(name: string, persona: ResolvedPersona, extra = {}) {
  for (const os of OSES) {
    const { files } = bundleOf(
      compileManaged(input(persona, { os, ...extra })),
    );
    for (const path of Object.keys(files).sort()) {
      await expect(decode(files[path]!)).toMatchFileSnapshot(
        `../../test/golden/managed/${name}/${os}/${path}`,
      );
    }
  }
}

describe("compileManaged: permissions", () => {
  const persona = ir({
    permissions: {
      allow: ["Read(./**)"],
      deny: ["Bash(rm -rf:*)", "Read(./.env)"],
      ask: ["Bash(git push:*)"],
    },
    locks: [
      { path: "permissions.deny", layer: "org/acme" },
      { path: "permissions.ask", layer: "team/payments" },
    ],
  });

  it("locked permission rules reach the policy", async () => {
    const result = compileManaged(input(persona));
    expect(settings(result)).toEqual({
      permissions: {
        ask: ["Bash(git push:*)"],
        deny: ["Bash(rm -rf:*)", "Read(./.env)"],
      },
    });
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        path: "permissions.deny[Bash(rm -rf:*)]",
        layer: "org/acme",
        outcome: "enforced",
      }),
      expect.objectContaining({
        path: "permissions.deny[Read(./.env)]",
        layer: "org/acme",
        outcome: "enforced",
      }),
      expect.objectContaining({
        path: "permissions.ask[Bash(git push:*)]",
        layer: "team/payments",
        outcome: "enforced",
      }),
    ]);
    await goldens("permission-lists", persona);
  });

  it("a section lock takes every entry", async () => {
    const whole = ir({
      instructions: [
        { id: "org-conduct", file: "org/instructions/conduct.md" },
        { id: "team-style", inline: "Prefer small PRs.\n" },
      ],
      permissions: {
        allow: ["Read(./**)"],
        deny: ["Bash(rm -rf:*)"],
        ask: ["Bash(git push:*)"],
      },
      hooks: {
        "pre-tool-use": [
          {
            id: "block-prod-db",
            run: "org/hooks/block-prod-db.sh",
            matcher: "Bash",
          },
        ],
        stop: [{ id: "audit", run: "team/hooks/audit.sh" }],
      },
      locks: [
        { path: "permissions", layer: "org/acme" },
        { path: "hooks", layer: "org/acme" },
        { path: "instructions", layer: "org/acme" },
      ],
    });
    const result = compileManaged(input(whole));
    const policy = settings(result);
    expect(policy.permissions).toEqual({
      allow: ["Read(./**)"],
      ask: ["Bash(git push:*)"],
      deny: ["Bash(rm -rf:*)"],
    });
    expect(Object.keys(policy.hooks as object)).toEqual(["PreToolUse", "Stop"]);
    expect(policy.claudeMd).toBe(
      "Review code the way you would want yours reviewed.\n\nPrefer small PRs.",
    );
    expect(result.report.entries.map((e) => e.path)).toEqual([
      "instructions[org-conduct]",
      "instructions[team-style]",
      "permissions.allow[Read(./**)]",
      "permissions.deny[Bash(rm -rf:*)]",
      "permissions.ask[Bash(git push:*)]",
      "hooks.pre-tool-use[block-prod-db]",
      "hooks.stop[audit]",
    ]);
    await goldens("section-lock", whole);
  });

  it("an entry lock takes only that entry", async () => {
    const one = ir({
      ...persona,
      locks: [
        { path: "permissions.deny[Bash(rm -rf:*)]", layer: "area/fintech" },
      ],
    });
    const result = compileManaged(input(one));
    expect(settings(result)).toEqual({
      permissions: { deny: ["Bash(rm -rf:*)"] },
    });
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        path: "permissions.deny[Bash(rm -rf:*)]",
        layer: "area/fintech",
        outcome: "enforced",
      }),
    ]);
    await goldens("entry-lock", one);
  });
});

describe("compileManaged: hooks", () => {
  const persona = ir({
    hooks: {
      "pre-tool-use": [
        {
          id: "block-prod-db",
          run: "org/hooks/block-prod-db.sh",
          matcher: "Bash",
        },
      ],
      "post-tool-use": [
        {
          id: "format-on-write",
          run: "project/hooks/format.sh",
          matcher: "Edit|Write",
        },
      ],
    },
    locks: [{ path: "hooks.pre-tool-use[block-prod-db]", layer: "org/acme" }],
  });
  const script = "zzpersona/hooks/pre-tool-use-block-prod-db-block-prod-db.sh";

  it("locked hooks are copied and referenced by quoted absolute path", async () => {
    const result = compileManaged(input(persona));
    expect(settings(result)).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  "'/Library/Application Support/ClaudeCode/zzpersona/hooks/pre-tool-use-block-prod-db-block-prod-db.sh'",
              },
            ],
          },
        ],
      },
    });
    const { files } = bundleOf(result);
    expect(files[script]).toEqual(SCRIPTS["org/hooks/block-prod-db.sh"]);
    expect(Object.keys(files).filter((p) => p.includes("format"))).toEqual([]);

    const command = (os: ManagedOs) =>
      (
        settings(compileManaged(input(persona, { os }))).hooks as {
          PreToolUse: { hooks: { command: string }[] }[];
        }
      ).PreToolUse[0]!.hooks[0]!.command;
    expect(command("linux")).toBe(
      "'/etc/claude-code/zzpersona/hooks/pre-tool-use-block-prod-db-block-prod-db.sh'",
    );
    expect(command("windows")).toBe(
      '"C:\\Program Files\\ClaudeCode\\zzpersona\\hooks\\pre-tool-use-block-prod-db-block-prod-db.sh"',
    );
    await goldens("hooks", persona);
  });

  it("quotes hook paths so the shell expands nothing in them", () => {
    const tricky = (run: string) =>
      ir({
        hooks: { stop: [{ id: "odd", run }] },
        locks: [{ path: "hooks", layer: "org/acme" }],
      });
    const command = (run: string, os: ManagedOs) =>
      (
        settings(
          compileManaged(
            input(tricky(run), { os, scripts: { [run]: encode("x") } }),
          ),
        ).hooks as { Stop: { hooks: { command: string }[] }[] }
      ).Stop[0]!.hooks[0]!.command;
    expect(command("org/hooks/a$(id)`id`.sh", "macos")).toBe(
      "'/Library/Application Support/ClaudeCode/zzpersona/hooks/stop-odd-a$(id)`id`.sh'",
    );
    expect(command("org/hooks/it's.sh", "linux")).toBe(
      "'/etc/claude-code/zzpersona/hooks/stop-odd-it'\\''s.sh'",
    );
    expect(command("org/hooks/a-b.sh", "windows")).toBe(
      '"C:\\Program Files\\ClaudeCode\\zzpersona\\hooks\\stop-odd-a-b.sh"',
    );
    expect(command("org/hooks/a$b.sh", "linux")).toBe(
      "'/etc/claude-code/zzpersona/hooks/stop-odd-a$b.sh'",
    );
  });

  it("refuses a Windows hook name with a quote, $, backtick or %", () => {
    for (const char of ['"', "$", "`", "%"]) {
      const run = `org/hooks/a${char}b.sh`;
      const compileFor = () =>
        compileManaged(
          input(
            ir({
              hooks: { stop: [{ id: "odd", run }] },
              locks: [{ path: "hooks", layer: "org/acme" }],
            }),
            { os: "windows", scripts: { [run]: encode("x") } },
          ),
        );
      expect(compileFor, char).toThrow(AdapterInputError);
    }
  });

  it("throws AdapterInputError when a locked hook's script is missing", () => {
    expect(() => compileManaged(input(persona, { scripts: {} }))).toThrow(
      AdapterInputError,
    );
  });

  it("throws AdapterInputError for a hook outside the personas root", () => {
    const outside = ir({
      hooks: { stop: [{ id: "escape", run: "../escape.sh" }] },
      locks: [{ path: "hooks", layer: "org/acme" }],
    });
    expect(() =>
      compileManaged(
        input(outside, { scripts: { "../escape.sh": encode("x") } }),
      ),
    ).toThrow(AdapterInputError);
  });
});

describe("compileManaged: MCP servers", () => {
  const jira = { url: "https://jira.corp/mcp" };
  const events = { url: "https://events.corp/sse", transport: "sse" as const };
  const schema = {
    command: "npx",
    args: ["-y", "@corp/payments-schema-mcp"],
    env: { SCHEMA_URL: "https://schema.corp" },
  };

  it("a locked https server goes to managedMcpServers", async () => {
    const persona = ir({
      mcp: {
        servers: { jira, events, wiki: { url: "https://wiki.corp/mcp" } },
      },
      locks: [
        { path: "mcp.servers.jira", layer: "org/acme" },
        { path: "mcp.servers.events", layer: "team/payments" },
      ],
    });
    const result = compileManaged(input(persona));
    expect(settings(result)).toEqual({
      managedMcpServers: {
        events: { type: "sse", url: "https://events.corp/sse" },
        jira: { type: "http", url: "https://jira.corp/mcp" },
      },
    });
    expect(bundleOf(result).files["managed-mcp.json"]).toBeUndefined();
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        path: "mcp.servers.events",
        layer: "team/payments",
        outcome: "enforced",
      }),
      expect.objectContaining({
        path: "mcp.servers.jira",
        layer: "org/acme",
        outcome: "enforced",
      }),
    ]);
    await goldens("mcp-https", persona);
  });

  it("a locked stdio server needs exclusive mcp", () => {
    for (const server of [
      schema,
      { url: "https://jira.corp/mcp", headers: { "X-Team": "payments" } },
      { url: "http://localhost:3000/mcp" },
    ]) {
      const result = compileManaged(
        input(
          ir({
            mcp: { servers: { local: server } },
            locks: [{ path: "mcp.servers", layer: "org/acme" }],
          }),
        ),
      );
      expect(result.bundle).toBeUndefined();
      expect(result.report.entries).toEqual([
        expect.objectContaining({
          path: "mcp.servers.local",
          layer: "org/acme",
          outcome: "refused",
          code: "managed-mcp-needs-exclusive",
        }),
      ]);
    }
  });

  it("with policy.mcp exclusive, other servers go to managed-mcp.json", async () => {
    const persona = ir({
      mcp: {
        servers: {
          jira,
          schema,
          records: {
            url: "https://records.corp/mcp",
            headers: { "X-Team": "payments" },
          },
        },
      },
      locks: [{ path: "mcp", layer: "org/acme" }],
      policy: { mcp: "exclusive" },
    });
    const result = compileManaged(input(persona));
    expect(json(result, "managed-mcp.json")).toEqual({
      mcpServers: {
        records: {
          type: "http",
          url: "https://records.corp/mcp",
          headers: { "X-Team": "payments" },
        },
        schema: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@corp/payments-schema-mcp"],
          env: { SCHEMA_URL: "https://schema.corp" },
        },
      },
    });
    expect(settings(result)).toEqual({
      allowManagedMcpServersOnly: true,
      managedMcpServers: {
        jira: { type: "http", url: "https://jira.corp/mcp" },
      },
    });
    await goldens("mcp-exclusive", persona);
  });

  it("exclusive mcp with no locked servers writes an empty managed-mcp.json", async () => {
    const persona = ir({
      mcp: { servers: { jira } },
      policy: { mcp: "exclusive" },
    });
    const result = compileManaged(input(persona));
    expect(json(result, "managed-mcp.json")).toEqual({ mcpServers: {} });
    expect(decode(bundleOf(result).files["managed-mcp.json"]!)).toBe(
      '{\n  "mcpServers": {}\n}\n',
    );
    await goldens("mcp-exclusive-empty", persona);
  });

  it("says a locked gateway ref will not load while MCP is exclusive", () => {
    const servers = { jira: { ref: "gateway://jira" } };
    const reason = (policy: Partial<ResolvedPersona["policy"]>) =>
      compileManaged(
        input(
          ir({
            mcp: { servers },
            locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
            policy,
          }),
        ),
      ).report.entries.find((e) => e.path === "mcp.servers.jira")!;
    expect(reason({}).outcome).toBe("advisory");
    expect(reason({}).reason).not.toMatch(/exclusive/);
    expect(reason({ mcp: "exclusive" })).toMatchObject({
      outcome: "advisory",
      reason: expect.stringMatching(
        /sessions will not load it while policy\.mcp is exclusive/,
      ),
    });
  });

  it("refuses secret references", () => {
    const cases = {
      env: { command: "npx", env: { TOKEN: "secret://vault/jira" } },
      headers: {
        url: "https://jira.corp/mcp",
        headers: { Authorization: "Bearer secret://vault/jira" },
      },
      url: { url: "https://jira.corp/mcp?key=secret://vault/jira" },
    };
    for (const [name, server] of Object.entries(cases)) {
      const result = compileManaged(
        input(
          ir({
            mcp: { servers: { [name]: server } },
            locks: [{ path: "mcp.servers", layer: "org/acme" }],
            policy: { mcp: "exclusive" },
          }),
          { provenance: { "policy.mcp": "org/acme" } },
        ),
      );
      expect(result.bundle, name).toBeUndefined();
      expect(result.report.entries, name).toContainEqual(
        expect.objectContaining({
          path: `mcp.servers.${name}`,
          outcome: "refused",
          code: "managed-secret",
        }),
      );
    }
  });
});

describe("compileManaged: instructions", () => {
  it("locked instructions become claudeMd", async () => {
    const persona = ir({
      instructions: [
        { id: "org-conduct", file: "org/instructions/conduct.md" },
        { id: "team-free", inline: "Pick any style you like.\n" },
        {
          id: "org-security",
          inline: "\nNever paste credentials into prompts.\n",
        },
      ],
      locks: [
        { path: "instructions[org-security]", layer: "org/acme" },
        { path: "instructions[org-conduct]", layer: "org/acme" },
      ],
    });
    const result = compileManaged(input(persona));
    expect(settings(result)).toEqual({
      claudeMd:
        "Review code the way you would want yours reviewed.\n\nNever paste credentials into prompts.",
    });
    expect(result.report.entries.map((e) => e.path)).toEqual([
      "instructions[org-conduct]",
      "instructions[org-security]",
    ]);
    expect(result.report.entries[0]!.reason).toMatch(/guidance/);
    await goldens("instructions", persona);
  });

  it("throws AdapterInputError when a locked instruction file's text is missing", () => {
    const persona = ir({
      instructions: [
        { id: "org-conduct", file: "org/instructions/conduct.md" },
      ],
      locks: [{ path: "instructions", layer: "org/acme" }],
    });
    expect(() => compileManaged(input(persona, { texts: {} }))).toThrow(
      AdapterInputError,
    );
  });
});

describe("compileManaged: advisory", () => {
  it("gateway, skills, knowledge and providers are advisory", async () => {
    const persona = ir({
      mcp: { gateway: "bifrost://corp", servers: {} },
      skills: [{ name: "pr-review", source: "org/skills/pr-review" }],
      knowledge: [{ id: "pci-handbook", source: "mcp://confluence?space=PCI" }],
      secrets: { providers: { vault: { type: "hashicorp-vault" } } },
      metadata: { name: "payments", labels: { org: "acme" } },
      targets: { "claude-code": { model: "opus" } },
      locks: [
        { path: "mcp.gateway", layer: "org/acme" },
        { path: "skills", layer: "org/acme" },
        { path: "knowledge", layer: "area/fintech" },
        { path: "secrets.providers", layer: "org/acme" },
        { path: "metadata.labels.org", layer: "org/acme" },
        { path: "targets.claude-code.model", layer: "team/payments" },
        { path: "permissions.ask", layer: "team/payments" },
      ],
    });
    const result = compileManaged(input(persona));
    expect(settings(result)).toEqual({});
    expect(
      result.report.entries.map(({ path, layer, outcome }) => [
        path,
        layer,
        outcome,
      ]),
    ).toEqual([
      ["skills[pr-review]", "org/acme", "advisory"],
      ["mcp.gateway", "org/acme", "advisory"],
      ["knowledge[pci-handbook]", "area/fintech", "advisory"],
      ["secrets.providers.vault", "org/acme", "advisory"],
      ["metadata.labels.org", "org/acme", "advisory"],
      ["targets.claude-code.model", "team/payments", "advisory"],
      ["permissions.ask", "team/payments", "advisory"],
    ]);
    await goldens("advisory", persona);
  });
});

describe("compileManaged: policy and passthrough", () => {
  it("maps every policy key", async () => {
    const persona = ir({
      policy: {
        permissions: "exclusive",
        hooks: "exclusive",
        mcp: "exclusive",
        bypassPermissions: "disabled",
      },
    });
    const provenance = {
      "policy.permissions": "org/acme",
      "policy.hooks": "org/acme",
      "policy.mcp": "area/fintech",
      "policy.bypassPermissions": "team/payments",
    };
    const result = compileManaged(input(persona, { provenance }));
    expect(settings(result)).toEqual({
      allowManagedHooksOnly: true,
      allowManagedMcpServersOnly: true,
      allowManagedPermissionRulesOnly: true,
      permissions: { disableBypassPermissionsMode: "disable" },
    });
    expect(json(result, "managed-mcp.json")).toEqual({ mcpServers: {} });
    expect(
      result.report.entries.map(({ path, layer, outcome }) => [
        path,
        layer,
        outcome,
      ]),
    ).toEqual([
      ["policy.bypassPermissions", "team/payments", "enforced"],
      ["policy.hooks", "org/acme", "enforced"],
      ["policy.mcp", "area/fintech", "enforced"],
      ["policy.permissions", "org/acme", "enforced"],
    ]);
    await goldens("policy", persona, { provenance });
  });

  it("names the chain's root layer for policy without provenance", () => {
    const result = compileManaged(
      input(ir({ policy: { hooks: "exclusive" } })),
    );
    expect(result.report.entries).toEqual([
      expect.objectContaining({ path: "policy.hooks", layer: "org/acme" }),
    ]);
  });

  it("passes known managed keys through last", async () => {
    const persona = ir({
      permissions: { allow: [], deny: ["Bash(rm -rf:*)"], ask: [] },
      instructions: [{ id: "org-security", inline: "Be careful.\n" }],
      locks: [
        { path: "permissions.deny", layer: "org/acme" },
        { path: "instructions", layer: "org/acme" },
      ],
      policy: { bypassPermissions: "disabled" },
      targets: {
        "claude-code": {
          model: "opus",
          managed: {
            strictKnownMarketplaces: [],
            deniedModels: ["claude-haiku-*"],
            permissions: {
              deny: ["Bash(sudo:*)", "Bash(rm -rf:*)"],
              defaultMode: "default",
            },
          },
        },
      },
    });
    const provenance = {
      "policy.bypassPermissions": "org/acme",
      "targets.claude-code.managed.strictKnownMarketplaces": "org/acme",
      "targets.claude-code.managed.deniedModels": "area/fintech",
      "targets.claude-code.managed.permissions": "org/acme",
    };
    const result = compileManaged(input(persona, { provenance }));
    expect(settings(result)).toEqual({
      claudeMd: "Be careful.",
      deniedModels: ["claude-haiku-*"],
      permissions: {
        defaultMode: "default",
        deny: ["Bash(rm -rf:*)", "Bash(sudo:*)"],
        disableBypassPermissionsMode: "disable",
      },
      strictKnownMarketplaces: [],
    });
    expect(result.report.entries).toContainEqual(
      expect.objectContaining({
        path: "targets.claude-code.managed.deniedModels",
        layer: "area/fintech",
        outcome: "enforced",
      }),
    );
    expect(result.report.entries.map((e) => e.path)).not.toContain(
      "targets.claude-code.model",
    );
    await goldens("passthrough", persona, { provenance });
  });

  describe("a passthrough key never replaces a compiled value", () => {
    const collide = (
      fields: Partial<Omit<ResolvedPersona, "irVersion">>,
      managed: Record<string, unknown>,
    ) => {
      const key = Object.keys(managed)[0]!;
      return compileManaged(
        input(ir({ ...fields, targets: { "claude-code": { managed } } }), {
          provenance: {
            "policy.hooks": "org/acme",
            "policy.bypassPermissions": "org/acme",
            [`targets.claude-code.managed.${key}`]: "team/payments",
          },
        }),
      );
    };
    const refusal = (result: ManagedResult, key: string) => {
      expect(result.bundle).toBeUndefined();
      const entry = result.report.entries.find(
        (e) => e.path === `targets.claude-code.managed.${key}`,
      );
      expect(entry).toMatchObject({
        layer: "team/payments",
        outcome: "refused",
        code: "managed-passthrough-conflict",
      });
      return entry!.reason;
    };

    it("an org-locked server's URL", () => {
      const reason = refusal(
        collide(
          {
            mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
            locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
          },
          {
            managedMcpServers: {
              jira: { type: "http", url: "https://evil.example/mcp" },
            },
          },
        ),
        "managedMcpServers",
      );
      expect(reason).toContain("managedMcpServers.jira.url");
      expect(reason).toContain("mcp.servers.jira (org/acme)");
      expect(reason).toContain("team/payments");
    });

    it("claudeMd from locked instructions", () => {
      const reason = refusal(
        collide(
          {
            instructions: [{ id: "sec", inline: "Never X.\n" }],
            locks: [{ path: "instructions", layer: "org/acme" }],
          },
          { claudeMd: "" },
        ),
        "claudeMd",
      );
      expect(reason).toContain("instructions[sec] (org/acme)");
    });

    it("allowManagedHooksOnly from policy.hooks", () => {
      const reason = refusal(
        collide(
          { policy: { hooks: "exclusive" } },
          {
            allowManagedHooksOnly: false,
          },
        ),
        "allowManagedHooksOnly",
      );
      expect(reason).toContain("policy.hooks (org/acme)");
    });

    it("disableBypassPermissionsMode from policy.bypassPermissions", () => {
      const reason = refusal(
        collide(
          { policy: { bypassPermissions: "disabled" } },
          { permissions: { disableBypassPermissionsMode: "allow" } },
        ),
        "permissions",
      );
      expect(reason).toContain("permissions.disableBypassPermissionsMode");
      expect(reason).toContain("policy.bypassPermissions (org/acme)");
    });

    it("a key added inside a locked server", () => {
      const reason = refusal(
        collide(
          {
            mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
            locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
          },
          {
            managedMcpServers: {
              jira: { headers: { "X-Key": "issued-to-everyone" } },
            },
          },
        ),
        "managedMcpServers",
      );
      expect(reason).toContain("managedMcpServers.jira.headers");
      expect(reason).toContain("mcp.servers.jira (org/acme)");
    });

    it("an exclusive server compiled into managed-mcp.json", () => {
      const result = collide(
        {
          mcp: { servers: { local: { command: "npx", args: ["x"] } } },
          locks: [{ path: "mcp.servers.local", layer: "org/acme" }],
          policy: { mcp: "exclusive" },
        },
        {
          managedMcpServers: {
            local: { type: "http", url: "https://evil.example/mcp" },
          },
        },
      );
      const reason = refusal(result, "managedMcpServers");
      expect(reason).toContain("managedMcpServers.local");
      expect(reason).toContain("mcp.servers.local (org/acme)");
    });

    it("names the compiled sources when a whole container is replaced", () => {
      const permissions = refusal(
        collide(
          {
            permissions: { allow: [], deny: ["Bash(rm -rf:*)"], ask: [] },
            locks: [{ path: "permissions.deny", layer: "org/acme" }],
          },
          { permissions: "x" },
        ),
        "permissions",
      );
      expect(permissions).toContain(
        "permissions.deny[Bash(rm -rf:*)] (org/acme)",
      );
      const servers = refusal(
        collide(
          {
            mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
            locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
          },
          { managedMcpServers: [] },
        ),
        "managedMcpServers",
      );
      expect(servers).toContain("mcp.servers.jira (org/acme)");
      expect(servers).not.toContain("the compiled policy");
    });

    it("applies a new server name beside a locked one", () => {
      const result = collide(
        {
          mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
          locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
        },
        {
          managedMcpServers: {
            wiki: { type: "http", url: "https://wiki.corp/mcp" },
          },
        },
      );
      expect(settings(result)).toEqual({
        managedMcpServers: {
          jira: { type: "http", url: "https://jira.corp/mcp" },
          wiki: { type: "http", url: "https://wiki.corp/mcp" },
        },
      });
    });

    it("applies a key that collides with nothing, and an equal value", () => {
      const result = collide(
        {
          permissions: { allow: [], deny: ["Bash(rm -rf:*)"], ask: [] },
          locks: [{ path: "permissions.deny", layer: "org/acme" }],
          policy: { bypassPermissions: "disabled" },
        },
        {
          permissions: {
            defaultMode: "default",
            deny: ["Bash(sudo:*)"],
            disableBypassPermissionsMode: "disable",
          },
        },
      );
      expect(settings(result)).toEqual({
        permissions: {
          defaultMode: "default",
          deny: ["Bash(rm -rf:*)", "Bash(sudo:*)"],
          disableBypassPermissionsMode: "disable",
        },
      });
      expect(result.report.entries).toContainEqual(
        expect.objectContaining({
          path: "targets.claude-code.managed.permissions",
          outcome: "enforced",
        }),
      );
    });
  });

  describe("a passthrough key from below a lock never widens it", () => {
    /** `managed` set by the team (or `by`), under the org's locks and policy. */
    const below = (
      fields: Partial<Omit<ResolvedPersona, "irVersion">>,
      managed: Record<string, unknown>,
      by = "team/payments",
    ) =>
      compileManaged(
        input(ir({ ...fields, targets: { "claude-code": { managed } } }), {
          provenance: {
            "policy.permissions": "org/acme",
            "policy.mcp": "org/acme",
            "policy.hooks": "org/acme",
            ...Object.fromEntries(
              Object.keys(managed).map((key) => [
                `targets.claude-code.managed.${key}`,
                by,
              ]),
            ),
          },
        }),
      );
    const refused = (result: ManagedResult, key: string) => {
      expect(result.bundle).toBeUndefined();
      const entry = result.report.entries.find(
        (e) => e.path === `targets.claude-code.managed.${key}`,
      );
      expect(entry).toMatchObject({
        layer: "team/payments",
        outcome: "refused",
        code: "managed-passthrough-conflict",
      });
      expect(entry!.reason).toContain("team/payments");
      return entry!.reason;
    };
    const allow = { permissions: { allow: ["Bash(*)"] } };
    const READ = {
      permissions: { allow: ["Read"], deny: [], ask: [] },
    };
    const JIRA = {
      mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
    };
    const evil = {
      managedMcpServers: {
        evil: { type: "http", url: "https://evil.example/mcp" },
      },
    };

    it("permissions.allow under an allow lock, a permissions lock or exclusive permissions", () => {
      for (const path of ["permissions.allow", "permissions"]) {
        const reason = refused(
          below({ ...READ, locks: [{ path, layer: "org/acme" }] }, allow),
          "permissions",
        );
        expect(reason).toContain("permissions.allow");
        expect(reason).toContain(`${path} (org/acme)`);
      }
      const reason = refused(
        below({ ...READ, policy: { permissions: "exclusive" } }, allow),
        "permissions",
      );
      expect(reason).toContain("policy.permissions: exclusive (org/acme)");
    });

    it("managedMcpServers under exclusive MCP, an mcp.servers lock or an mcp lock", () => {
      expect(
        refused(
          below({ policy: { mcp: "exclusive" } }, evil),
          "managedMcpServers",
        ),
      ).toContain("policy.mcp: exclusive (org/acme)");
      for (const path of ["mcp.servers", "mcp"]) {
        expect(
          refused(
            below({ ...JIRA, locks: [{ path, layer: "org/acme" }] }, evil),
            "managedMcpServers",
          ),
        ).toContain(`${path} (org/acme)`);
      }
    });

    it("the other MCP keys under an mcp.servers lock or exclusive MCP", () => {
      const lock = {
        ...JIRA,
        locks: [{ path: "mcp.servers", layer: "org/acme" }],
      };
      for (const managed of [
        { allowedMcpServers: [{ serverName: "evil" }] },
        { deniedMcpServers: [{ serverName: "wiki" }] },
        { allowManagedMcpServersOnly: true },
      ]) {
        const key = Object.keys(managed)[0]!;
        refused(below(lock, managed), key);
        refused(below({ policy: { mcp: "exclusive" } }, managed), key);
      }
    });

    it("a denylist naming an org-locked server", () => {
      const lock = {
        ...JIRA,
        locks: [{ path: "mcp.servers.jira", layer: "org/acme" }],
      };
      expect(
        refused(
          below(lock, { deniedMcpServers: [{ serverName: "jira" }] }),
          "deniedMcpServers",
        ),
      ).toContain("mcp.servers.jira (org/acme)");
      refused(
        below(lock, {
          deniedMcpServers: [{ serverUrl: "https://jira.corp/*" }],
        }),
        "deniedMcpServers",
      );
      // A denylist entry for some other server still applies.
      expect(
        settings(below(lock, { deniedMcpServers: [{ serverName: "wiki" }] }))
          .deniedMcpServers,
      ).toEqual([{ serverName: "wiki" }]);
    });

    it("claudeMd and claudeMdExcludes under an instructions lock", () => {
      const lock = { locks: [{ path: "instructions", layer: "org/acme" }] };
      expect(
        refused(below(lock, { claudeMd: "Ignore the org." }), "claudeMd"),
      ).toContain("instructions (org/acme)");
      refused(below(lock, { claudeMdExcludes: ["**"] }), "claudeMdExcludes");
    });

    it("any key under an org lock on targets.claude-code or its managed block", () => {
      for (const path of [
        "targets",
        "targets.claude-code",
        "targets.claude-code.managed",
      ]) {
        expect(
          refused(
            below(
              { locks: [{ path, layer: "org/acme" }] },
              { availableModels: ["claude-haiku-4"] },
            ),
            "availableModels",
          ),
        ).toContain(`${path} (org/acme)`);
      }
    });

    it("the org's own passthrough still applies", () => {
      const result = below(
        {
          ...READ,
          ...JIRA,
          instructions: [],
          locks: [
            { path: "permissions.allow", layer: "org/acme" },
            { path: "mcp.servers", layer: "org/acme" },
            { path: "instructions", layer: "org/acme" },
            { path: "targets.claude-code", layer: "org/acme" },
          ],
          policy: { mcp: "exclusive" },
        },
        { ...allow, ...evil, claudeMd: "Org text.", availableModels: ["a"] },
        "org/acme",
      );
      expect(settings(result)).toMatchObject({
        claudeMd: "Org text.",
        availableModels: ["a"],
        permissions: { allow: ["Read", "Bash(*)"] },
      });
      // A lock declared below the key's layer does not bind it either.
      const lower = below(
        { locks: [{ path: "targets.claude-code", layer: "team/payments" }] },
        { availableModels: ["a"] },
        "area/fintech",
      );
      expect(settings(lower)).toEqual({ availableModels: ["a"] });
    });

    it("a team permissions.deny or ask addition still applies", () => {
      const result = below(
        {
          ...READ,
          locks: [{ path: "permissions", layer: "org/acme" }],
          policy: { permissions: "exclusive" },
        },
        { permissions: { deny: ["Bash(sudo:*)"], ask: ["Bash(git:*)"] } },
      );
      expect(settings(result)).toMatchObject({
        permissions: {
          allow: ["Read"],
          deny: ["Bash(sudo:*)"],
          ask: ["Bash(git:*)"],
        },
      });
    });
  });

  it("reports managedSourcesBehavior advisory: the policy files cannot set it", () => {
    const result = compileManaged(
      input(
        ir({
          targets: {
            "claude-code": { managed: { managedSourcesBehavior: "merge" } },
          },
        }),
      ),
    );
    expect(result.report.entries).toEqual([
      {
        path: "targets.claude-code.managed.managedSourcesBehavior",
        layer: "org/acme",
        outcome: "advisory",
        reason: expect.stringContaining("highest managed source"),
      },
    ]);
  });

  it("refuses unknown managed keys", () => {
    const result = compileManaged(
      input(
        ir({
          targets: {
            "claude-code": {
              managed: { deniedModels: [], allowEverything: true },
            },
          },
        }),
      ),
    );
    expect(result.bundle).toBeUndefined();
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        path: "targets.claude-code.managed.allowEverything",
        outcome: "refused",
        code: "managed-unknown-key",
      }),
      expect.objectContaining({
        path: "targets.claude-code.managed.deniedModels",
        outcome: "enforced",
      }),
    ]);
  });

  it("refuses secret references in managed keys", () => {
    const result = compileManaged(
      input(
        ir({
          targets: {
            "claude-code": {
              managed: { env: { JIRA_TOKEN: "secret://vault/jira" } },
            },
          },
        }),
      ),
    );
    expect(result.bundle).toBeUndefined();
    expect(result.report.entries).toEqual([
      expect.objectContaining({
        path: "targets.claude-code.managed.env",
        outcome: "refused",
        code: "managed-secret",
      }),
    ]);
  });
});

describe("compileManaged: report", () => {
  const codes = (result: ManagedResult) =>
    result.report.warnings.map((w) => w.code);

  it("warns when the policy weakens zzpersona launches", () => {
    expect(codes(compileManaged(input(ir())))).toEqual([]);
    expect(
      codes(
        compileManaged(
          input(
            ir({
              targets: {
                "claude-code": { managed: { disableSideloadFlags: true } },
              },
            }),
          ),
        ),
      ),
    ).toEqual(["partial-mode"]);
    expect(
      codes(compileManaged(input(ir({ policy: { mcp: "exclusive" } })))),
    ).toEqual(["partial-mode"]);
    expect(
      codes(compileManaged(input(ir({ policy: { hooks: "exclusive" } })))),
    ).toEqual(["plugin-hooks-dropped"]);
    expect(
      codes(
        compileManaged(
          input(
            ir({
              hooks: { stop: [{ id: "audit", run: "team/hooks/audit.sh" }] },
              locks: [{ path: "hooks.stop", layer: "team/payments" }],
            }),
          ),
        ),
      ),
    ).toEqual(["console-hooks-approval"]);
  });

  it("minClaudeCode is the highest floor among used keys", () => {
    const floor = (managed: Record<string, unknown>) =>
      bundleOf(
        compileManaged(input(ir({ targets: { "claude-code": { managed } } }))),
      ).manifest.minClaudeCode;
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{}, undefined],
      [{ availableModels: ["opus"] }, undefined],
      [{ disableSideloadFlags: true }, "2.1.193"],
      [{ managedSourcesBehavior: "merge" }, "2.1.242"],
      [{ managedMcpServers: {} }, "2.1.259"],
      [{ claudeMd: "x" }, "2.1.260"],
      [{ deniedModels: [] }, "2.1.283"],
      [{ disableSideloadFlags: true, claudeMd: "x" }, "2.1.260"],
      [
        { deniedModels: [], managedMcpServers: {}, disableSideloadFlags: true },
        "2.1.283",
      ],
    ];
    for (const [managed, expected] of cases) {
      expect(floor(managed), JSON.stringify(managed)).toBe(expected);
    }
    const servers = compileManaged(
      input(
        ir({
          mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
          locks: [{ path: "mcp", layer: "org/acme" }],
        }),
      ),
    );
    expect(bundleOf(servers).manifest.minClaudeCode).toBe("2.1.259");
  });

  it("is deterministic", () => {
    const persona = ir({
      permissions: { allow: [], deny: ["Bash(rm -rf:*)"], ask: [] },
      hooks: {
        "pre-tool-use": [
          {
            id: "block-prod-db",
            run: "org/hooks/block-prod-db.sh",
            matcher: "Bash",
          },
        ],
      },
      mcp: { servers: { jira: { url: "https://jira.corp/mcp" } } },
      locks: [
        { path: "permissions", layer: "org/acme" },
        { path: "hooks", layer: "org/acme" },
        { path: "mcp", layer: "org/acme" },
      ],
      policy: { mcp: "exclusive", hooks: "exclusive" },
    });
    const first = bundleOf(compileManaged(input(persona)));
    const second = bundleOf(compileManaged(input(persona)));
    expect(Object.keys(second.files)).toEqual(Object.keys(first.files));
    for (const [path, bytes] of Object.entries(first.files)) {
      expect(
        Buffer.from(second.files[path]!).equals(Buffer.from(bytes)),
        path,
      ).toBe(true);
    }

    const { manifest, files } = first;
    expect(Object.keys(files).sort()).toEqual([
      "managed-mcp.json",
      "managed-settings.d/50-zzpersona.json",
      "zzpersona/hooks/pre-tool-use-block-prod-db-block-prod-db.sh",
      "zzpersona/manifest.json",
    ]);
    expect(Object.keys(manifest.files).sort()).toEqual(
      Object.keys(files)
        .filter((path) => path !== "zzpersona/manifest.json")
        .sort(),
    );
    for (const [path, hash] of Object.entries(manifest.files)) {
      expect(hash).toBe(
        createHash("sha256").update(files[path]!).digest("hex"),
      );
    }
    expect(JSON.parse(decode(files["zzpersona/manifest.json"]!))).toEqual(
      manifest,
    );
    expect(manifest).toMatchObject({
      format: 1,
      zzpersona: "0.12.0",
      os: "macos",
      layers: input(persona).layers,
    });
  });

  it("writes sorted keys, two-space indent and a trailing newline", () => {
    const result = compileManaged(
      input(
        ir({
          targets: {
            "claude-code": {
              managed: {
                strictKnownMarketplaces: [],
                deniedModels: ["b", "a"],
              },
            },
          },
        }),
      ),
    );
    expect(
      decode(bundleOf(result).files["managed-settings.d/50-zzpersona.json"]!),
    ).toBe(
      '{\n  "deniedModels": [\n    "b",\n    "a"\n  ],\n  "strictKnownMarketplaces": []\n}\n',
    );
  });

  it("nothing locked builds an empty policy", () => {
    const result = compileManaged(input(ir()));
    expect(result.report).toEqual({ entries: [], warnings: [] });
    expect(
      decode(bundleOf(result).files["managed-settings.d/50-zzpersona.json"]!),
    ).toBe("{}\n");
  });
});

describe("managedInputs", () => {
  it("managedInputs lists only locked instruction files and hook scripts", () => {
    const persona = ir({
      instructions: [
        { id: "org-conduct", file: "org/instructions/conduct.md" },
        { id: "project-notes", file: "project/instructions/notes.md" },
        { id: "org-security", inline: "Never paste credentials.\n" },
      ],
      hooks: {
        "pre-tool-use": [
          { id: "block-prod-db", run: "org/hooks/block-prod-db.sh" },
        ],
        "post-tool-use": [{ id: "format", run: "project/hooks/format.sh" }],
      },
      locks: [
        { path: "instructions[org-conduct]", layer: "org/acme" },
        { path: "instructions[org-security]", layer: "org/acme" },
        { path: "hooks.pre-tool-use", layer: "org/acme" },
      ],
    });
    expect(managedInputs(persona)).toEqual({
      texts: ["org/instructions/conduct.md"],
      scripts: ["org/hooks/block-prod-db.sh"],
    });
  });
});

describe("managedInputs, contained", () => {
  it("never lists a hook run outside the personas root", () => {
    const persona = ir({
      hooks: {
        stop: [
          { id: "escape", run: "../escape.sh" },
          { id: "absolute", run: "/etc/passwd" },
          { id: "audit", run: "team/hooks/audit.sh" },
        ],
      },
      locks: [{ path: "hooks", layer: "org/acme" }],
    });
    expect(managedInputs(persona).scripts).toEqual(["team/hooks/audit.sh"]);
  });
});

describe("compareVersions", () => {
  it("compares numerically, segment by segment", () => {
    expect(compareVersions("2.1.99", "2.1.100")).toBeLessThan(0);
    expect(compareVersions("2.1.100", "2.1.99")).toBeGreaterThan(0);
    expect(compareVersions("2.1.259", "2.1.259")).toBe(0);
    expect(minClaudeCode(["claudeMd", "managedMcpServers"])).toBe("2.1.260");
  });
});

describe("the adapter", () => {
  it("exposes the managed compiler and its roots", () => {
    expect(MANAGED_ROOTS).toEqual({
      macos: "/Library/Application Support/ClaudeCode",
      linux: "/etc/claude-code",
      windows: "C:\\Program Files\\ClaudeCode",
    });
    expect(adapter.managed?.roots).toBe(MANAGED_ROOTS);
    expect(adapter.managed?.compile).toBe(compileManaged);
    expect(adapter.managed?.inputs).toBe(managedInputs);
  });

  it("declares policy native in its capability matrix", () => {
    expect(adapter.capabilities().fields.policy).toEqual({
      support: "native",
      note: "managed policy bundle",
    });
  });
});
