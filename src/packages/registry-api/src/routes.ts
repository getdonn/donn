import { z } from "zod";
import {
  LayerSummary,
  LayerVersion,
  PublishRequest,
  PublishResult,
  Whoami,
} from "./schemas.js";

interface Route {
  method: "GET" | "POST";
  /** `{name}` placeholders are filled by `routePath`, URL-encoded as one segment. */
  path: string;
  request?: z.ZodType;
  response: z.ZodType;
  /** Success statuses the route can answer. */
  statuses: readonly number[];
}

export const ROUTES = {
  whoami: {
    method: "GET",
    path: "/v1/whoami",
    response: Whoami,
    statuses: [200],
  },
  listLayers: {
    method: "GET",
    path: "/v1/layers",
    response: z.array(LayerSummary),
    statuses: [200],
  },
  getVersion: {
    method: "GET",
    path: "/v1/layers/{ref}/versions/{version}",
    response: LayerVersion,
    statuses: [200],
  },
  publish: {
    method: "POST",
    path: "/v1/layers/{ref}/versions",
    request: PublishRequest,
    response: PublishResult,
    statuses: [200, 201],
  },
} as const satisfies Record<string, Route>;

/** Fill a route template; every param is URL-encoded as one segment (`team/web` → `team%2Fweb`). */
export function routePath(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing route param: ${name}`);
    return encodeURIComponent(value);
  });
}
