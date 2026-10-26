import { z } from "zod";
import { ROUTES } from "./routes.js";
import {
  BundleFile,
  ConformanceSchemas,
  LayerRef,
  LoginPoll,
  MANAGED_FORMATS,
  MANAGED_INCLUDES,
  MANAGED_OSES,
  PublishRequest,
  Role,
} from "./schemas.js";

// The document describes servers exactly, so responses come from the strict copies.
const SCHEMAS = {
  LayerRef,
  BundleFile,
  Whoami: ConformanceSchemas.Whoami,
  LayerSummary: ConformanceSchemas.LayerSummary,
  LayerVersion: ConformanceSchemas.LayerVersion,
  PublishRequest,
  Change: ConformanceSchemas.Change,
  PublishResult: ConformanceSchemas.PublishResult,
  Problem: ConformanceSchemas.Problem,
  Role,
  LoginStart: ConformanceSchemas.LoginStart,
  LoginPoll,
  LoginToken: ConformanceSchemas.LoginToken,
  ManagedBundleResponse: ConformanceSchemas.ManagedBundleResponse,
} as const;

const json = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>;
  return rest;
};

const ERRORS: Record<number, string> = {
  401: "Missing or refused token",
  403: "The caller lacks the role the request needs (forbidden), or a sign-in was refused",
  404: "Unknown ref or version",
  409: "baseVersion is not the latest version",
  410: "The sign-in expired, was refused or was already redeemed (login-expired)",
  422: "The bundle or its place in the layer graph is refused",
  428: "The sign-in is not finished yet (authorization-pending)",
  429: "Polled faster than the login's interval (slow-down)",
};

/** Answers only some routes can give. */
const EXTRA_ERRORS: Partial<
  Record<keyof typeof ROUTES, Record<number, string>>
> = {
  managedBundle: {
    400: "A query parameter is missing or invalid (invalid-request)",
    501: "The server does not build the requested managed format (format-unsupported)",
  },
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
  loginId: {
    name: "loginId",
    in: "path",
    required: true,
    description: "The loginId from POST /v1/auth/logins.",
    schema: { type: "string" },
  },
  version: {
    name: "version",
    in: "path",
    required: true,
    description: "A version number, or `latest`.",
    schema: { type: "string", pattern: "^([1-9][0-9]*|latest)$" },
  },
};

const QUERY_PARAMS: Record<string, Record<string, unknown>> = {
  layer: {
    name: "layer",
    in: "query",
    required: true,
    description:
      "The org/, area/ or team/ layer to build the managed bundle for.",
    schema: { $ref: "#/components/schemas/LayerRef" },
  },
  os: {
    name: "os",
    in: "query",
    required: true,
    description: "The operating system the bundle is for.",
    schema: { type: "string", enum: [...MANAGED_OSES] },
  },
  format: {
    name: "format",
    in: "query",
    required: false,
    description:
      "The output format; `bundle` (the default) is required of every server, the others may answer 501.",
    schema: { type: "string", enum: [...MANAGED_FORMATS], default: "bundle" },
  },
  include: {
    name: "include",
    in: "query",
    required: false,
    description:
      "For the script formats: `files` leaves out the settings drop-in.",
    schema: { type: "string", enum: [...MANAGED_INCLUDES], default: "all" },
  },
};

const ROUTE_SCHEMA_NAME: Record<keyof typeof ROUTES, string | undefined> = {
  whoami: "Whoami",
  listLayers: undefined,
  getVersion: "LayerVersion",
  managedBundle: "ManagedBundleResponse",
  publish: "PublishResult",
  startLogin: "LoginStart",
  pollLogin: "LoginToken",
};

const REQUEST_SCHEMA_NAME: Partial<Record<keyof typeof ROUTES, string>> = {
  publish: "PublishRequest",
  pollLogin: "LoginPoll",
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
    for (const [status, description] of Object.entries({
      ...ERRORS,
      ...EXTRA_ERRORS[name],
    })) {
      responses[status] = {
        description,
        content: {
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/Problem" },
          },
        },
      };
    }
    const parameters = [
      ...[...route.path.matchAll(/\{(\w+)\}/g)].map((m) => PARAMS[m[1]!]!),
      ...("query" in route ? route.query.map((q) => QUERY_PARAMS[q]!) : []),
    ];
    paths[route.path] = {
      [route.method.toLowerCase()]: {
        operationId: name,
        security: "auth" in route ? [] : [{ bearer: [] }],
        ...(parameters.length > 0 ? { parameters } : {}),
        ...("request" in route
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      $ref: `#/components/schemas/${REQUEST_SCHEMA_NAME[name]!}`,
                    },
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
      title: "donn registry",
      version: "0.1.0",
      description:
        "Publish layers and pull exactly what was published. Generated from @getdonn/registry-api.",
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
