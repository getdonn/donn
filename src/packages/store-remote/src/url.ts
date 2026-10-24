import { routePath } from "@getdonn/registry-api";
import { RegistryError } from "./error.js";

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The registry's base URL: scheme and host lower-cased, a trailing slash, the path prefix kept.
 * `https:` only, except loopback hosts where `http:` is allowed. Credentials, query and fragment
 * are dropped, so nothing secret rides in the URL.
 */
export function normaliseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegistryError("insecure-url", "the registry URL is not a URL");
  }
  const loopback = LOOPBACK.has(parsed.hostname);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback)
  ) {
    throw new RegistryError(
      "insecure-url",
      "the registry URL must be https:// (http:// is allowed only for 127.0.0.1, ::1 and localhost)",
    );
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

/** A route under `base` (from `normaliseUrl`): the leading `/` is dropped so a path prefix stays. */
export function routeUrl(
  base: string,
  template: string,
  params: Record<string, string>,
): URL {
  return new URL(routePath(template, params).replace(/^\//, ""), base);
}
