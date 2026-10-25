import {
  lockCovers,
  parsePath,
  type McpServer,
  type ModelGateway,
  type ResolveResult,
} from "@getdonn/spec";

// Renders a ResolveResult for a human reviewer: every resolved value on its own line with the
// layer that set it and any lock that covers it, then the warnings. Plain text, no colors; the
// CLI owns terminal concerns. The rendering of every fixture is pinned by its explain.txt.

interface Row {
  label: string;
  value: string;
  /** Provenance path for the layer column and lock notes; omitted for rows that carry their own. */
  path?: string;
  layer?: string;
  notes?: string[];
}

interface Section {
  title: string;
  rows: Row[];
  /** Values longer than this are cut with "…" so the layer column stays aligned. */
  maxValue?: number;
}

const MAX_VALUE = 44;

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const show = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

function serverSummary(server: McpServer): { value: string; notes: string[] } {
  if ("ref" in server) return { value: server.ref, notes: [] };
  if ("url" in server) {
    return {
      value: server.url,
      notes: server.transport ? [`transport: ${server.transport}`] : [],
    };
  }
  const env = Object.keys(server.env ?? {});
  return {
    value: [server.command, ...(server.args ?? [])].join(" "),
    notes: env.length > 0 ? [`env: ${env.join(", ")}`] : [],
  };
}

function gatewayRow(gateway: ModelGateway): Row {
  const headers = Object.keys(gateway.headers ?? {});
  return {
    label: "gateway",
    value: [gateway.type, gateway.baseURL].filter(Boolean).join(" "),
    path: "models.gateway",
    notes: [
      ...(headers.length > 0 ? [`headers: ${headers.join(", ")}`] : []),
      ...(gateway.apiKey === undefined ? [] : [`apiKey: ${gateway.apiKey}`]),
    ],
  };
}

function targetRows(value: unknown, keys: string[]): Row[] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      targetRows(child, [...keys, key]),
    );
  }
  return [
    {
      label: keys.join("."),
      value: show(value),
      path: `targets.${keys.join(".")}`,
    },
  ];
}

export function explain({
  ir,
  provenance,
  warnings,
  history,
}: ResolveResult): string {
  const target = provenance["metadata.name"];
  const targetIndex = ir.layers.indexOf(target ?? "");
  const locks = ir.locks.map((lock) => ({
    ...lock,
    parsed: parsePath(lock.path)!,
  }));

  const lockNotes = (path: string): string[] => {
    const parsed = parsePath(path);
    if (!parsed) return [];
    // Locks are written against the persona (`agents.define.<name>`); agent rows carry the IR path.
    const agent = /^agents\.([^.[]+)$/.exec(path);
    const lockable = agent ? parsePath(`agents.define.${agent[1]}`) : parsed;
    if (!lockable) return [];
    return locks
      .filter((lock) => lockCovers(lock.parsed, lockable))
      .map((lock) => `locked: ${lock.path} by ${lock.layer}`);
  };

  /** What a surviving value displaced: a fragment it swapped out, the layer it overrode, or a
   * removal it came back from. */
  const historyNotes = (path: string): string[] => {
    const final = provenance[path];
    const entries = history.filter((h) => h.path === path);
    const override = entries.findLast(
      (h) => h.kind === "override" && h.layer === final,
    );
    const removal = entries.findLast((h) => h.kind === "remove");
    const swapped = history.findLast(
      (h) => h.kind === "remove" && h.replacedBy === path,
    );
    return [
      ...(swapped ? [`replaces ${swapped.path} from ${swapped.from}`] : []),
      ...(override ? [`overrides ${override.from}`] : []),
      ...(removal && !override
        ? [`re-added after removal by ${removal.layer}`]
        : []),
    ];
  };

  // Values deleted and never set again: nothing else in the output would show them.
  const removed = [
    ...new Map(
      history
        .filter((h) => h.kind === "remove" && provenance[h.path] === undefined)
        .map((h) => [h.path, h]),
    ).values(),
  ];

  const { metadata } = ir;
  const sections: Section[] = [
    {
      title: "labels",
      rows: Object.entries(metadata.labels).map(([key, value]) => ({
        label: key,
        value,
        path: `metadata.labels.${key}`,
      })),
    },
    {
      title: "instructions",
      rows: ir.instructions.map((i) => ({
        label: i.id,
        value:
          "file" in i
            ? `file ${i.file}`
            : `inline "${i.inline.trim().split("\n")[0]}"`,
        path: `instructions[${i.id}]`,
      })),
    },
    {
      title: "skills",
      rows: ir.skills.map((s) => ({
        label: s.name,
        value: s.source,
        path: `skills[${s.name}]`,
      })),
    },
    {
      title: "mcp",
      rows: [
        ...(ir.mcp.gateway === undefined
          ? []
          : [{ label: "gateway", value: ir.mcp.gateway, path: "mcp.gateway" }]),
        ...Object.entries(ir.mcp.servers).map(([name, server]) => ({
          label: name,
          ...serverSummary(server),
          path: `mcp.servers.${name}`,
        })),
      ],
    },
    {
      title: "models",
      rows: [
        ...(ir.models.gateway === undefined
          ? []
          : [gatewayRow(ir.models.gateway)]),
        ...(ir.models.default === undefined
          ? []
          : [
              {
                label: "default",
                value: ir.models.default,
                path: "models.default",
              },
            ]),
      ],
    },
    {
      title: "permissions",
      rows: (["deny", "ask", "allow"] as const).flatMap((list) =>
        ir.permissions[list].map((rule) => ({
          label: list,
          value: rule,
          path: `permissions.${list}[${rule}]`,
        })),
      ),
    },
    {
      title: "hooks",
      rows: Object.entries(ir.hooks).flatMap(([event, hooks]) =>
        (hooks ?? []).map((hook) => ({
          label: event,
          value: `${hook.id} → ${hook.run}`,
          path: `hooks.${event}[${hook.id}]`,
          notes: hook.matcher === undefined ? [] : [`matcher: ${hook.matcher}`],
        })),
      ),
    },
    {
      title: "knowledge",
      rows: ir.knowledge.map((k) => ({
        label: k.id,
        value: k.source,
        path: `knowledge[${k.id}]`,
      })),
    },
    {
      title: "secrets",
      rows: Object.entries(ir.secrets.providers).map(
        ([name, { type, ...config }]) => ({
          label: name,
          value: [
            type,
            ...Object.entries(config).map(([k, v]) => `${k}=${show(v)}`),
          ].join(" "),
          path: `secrets.providers.${name}`,
        }),
      ),
    },
    {
      title: "targets",
      rows: Object.entries(ir.targets).flatMap(([harness, config]) =>
        targetRows(config, [harness]),
      ),
    },
    {
      title: "agents",
      maxValue: Infinity,
      rows: Object.entries(ir.agents).map(([name, agent]) => ({
        label: name,
        value: `${agent.template} → ${agent.target} at ${agent.path}`,
        path: `agents.${name}`,
        notes: [
          ...(agent.model === undefined ? [] : [`model: ${agent.model}`]),
          ...(Object.keys(agent.env).length === 0
            ? []
            : [`env: ${Object.keys(agent.env).join(", ")}`]),
        ],
      })),
    },
    {
      title: "removed",
      rows: removed.map((h) => ({
        label: h.path,
        value: "",
        layer: `removed by ${h.layer}`,
        notes: [
          `set by ${h.from}`,
          ...(h.replacedBy ? [`replaced by ${h.replacedBy}`] : []),
        ],
      })),
    },
    {
      title: "locks",
      rows: ir.locks.map((lock) => ({
        label: lock.path,
        value: "",
        layer: lock.layer,
      })),
    },
    {
      title: "warnings",
      maxValue: Infinity,
      rows: warnings.map((w) => ({
        label: w.code,
        value: w.path,
        layer: `from ${w.layer}`,
      })),
    },
  ];

  const header = [
    metadata.name,
    metadata.version === undefined ? "" : ` v${metadata.version}`,
    metadata.description === undefined ? "" : ` — ${metadata.description}`,
  ].join("");

  const layerWidth = Math.max(...ir.layers.map((layer) => layer.length));
  const layerRows = ir.layers.map((layer, i) => {
    const role =
      i === targetIndex ? "target" : i > targetIndex ? "overlay" : "";
    const number = String(i + 1).padStart(String(ir.layers.length).length);
    return `  ${number}  ${layer.padEnd(layerWidth)}  ${role}`.trimEnd();
  });

  const out = [header, "", "layers (merge order)", ...layerRows];
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    out.push(
      "",
      `${section.title} (${section.rows.length})`,
      ...renderRows(section),
    );
  }
  return `${out.join("\n")}\n`;

  function renderRows({ rows, maxValue = MAX_VALUE }: Section): string[] {
    const filled = rows.map((row) => ({
      ...row,
      value: truncate(row.value, maxValue),
      layer: row.layer ?? provenance[row.path ?? ""] ?? "?",
      notes: [
        ...(row.notes ?? []),
        ...(row.path
          ? [...historyNotes(row.path), ...lockNotes(row.path)]
          : []),
      ],
    }));
    const width = (pick: (row: (typeof filled)[number]) => string) =>
      Math.max(...filled.map((row) => pick(row).length));
    const [label, value, layer] = [
      width((r) => r.label),
      width((r) => r.value),
      width((r) => r.layer),
    ];
    return filled.map((row) =>
      [
        "  ",
        row.label.padEnd(label),
        "  ",
        value === 0 ? "" : `${row.value.padEnd(value)}  `,
        row.layer.padEnd(layer),
        row.notes.length > 0 ? `  ${row.notes.join("; ")}` : "",
      ]
        .join("")
        .trimEnd(),
    );
  }
}
