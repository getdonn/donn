import { z } from "zod";
import { ROUTES } from "./routes.js";
import {
  BundleFile,
  Change,
  LayerRef,
  LayerSummary,
  LayerVersion,
  Problem,
  PublishRequest,
  PublishResult,
  Whoami,
} from "./schemas.js";

const SCHEMAS = {
  LayerRef,
  BundleFile,
  Whoami,
  LayerSummary,
  LayerVersion,
  PublishRequest,
  Change,
  PublishResult,
  Problem,
} as const;

const json = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>;
  return rest;
};

const ERRORS: Record<number, string> = {
  401: "Missing or refused token",
  404: "Unknown ref or version",
  409: "baseVersion is not the latest version",
  422: "The bundle or its place in the layer graph is refused",
};

const PARAMS: Record<string, Record<string, unknown>> = {
  ref: {
    name: "ref",
    in: "path",
    required: true,
    description:
      "A layer ref such as team/web, URL-encoded as one path segment (team%2Fweb).",
    schema: { $ref: "#/components/schemas/LayerRef" },
  },
  version: {
    name: "version",
    in: "path",
    required: true,
    description: "A version number, or `latest`.",
    schema: { type: "string", pattern: "^([1-9][0-9]*|latest)$" },
  },
};

const ROUTE_SCHEMA_NAME: Record<keyof typeof ROUTES, string | undefined> = {
  whoami: "Whoami",
  listLayers: undefined,
  getVersion: "LayerVersion",
  publish: "PublishResult",
};

/** The OpenAPI 3.1 document for `ROUTES`, built from the zod schemas. */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, route] of Object.entries(ROUTES) as [
    keyof typeof ROUTES,
    (typeof ROUTES)[keyof typeof ROUTES],
  ][]) {
    const schemaName = ROUTE_SCHEMA_NAME[name];
    const ok = {
      description: "Success",
      content: {
        "application/json": {
          schema:
            schemaName === undefined
              ? {
                  type: "array",
                  items: { $ref: "#/components/schemas/LayerSummary" },
                }
              : { $ref: `#/components/schemas/${schemaName}` },
        },
      },
    };
    const responses: Record<string, unknown> = {};
    for (const status of route.statuses) responses[String(status)] = ok;
    for (const [status, description] of Object.entries(ERRORS)) {
      responses[status] = {
        description,
        content: {
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/Problem" },
          },
        },
      };
    }
    const parameters = [...route.path.matchAll(/\{(\w+)\}/g)].map(
      (m) => PARAMS[m[1]!]!,
    );
    paths[route.path] = {
      [route.method.toLowerCase()]: {
        operationId: name,
        security: [{ bearer: [] }],
        ...(parameters.length > 0 ? { parameters } : {}),
        ...("request" in route
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PublishRequest" },
                  },
                },
              },
            }
          : {}),
        responses,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "zzpersona registry",
      version: "0.1.0",
      description:
        "Publish layers and pull exactly what was published. Generated from @zzpersona/registry-api.",
    },
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: Object.fromEntries(
        Object.entries(SCHEMAS).map(([name, schema]) => [name, json(schema)]),
      ),
    },
  };
}
