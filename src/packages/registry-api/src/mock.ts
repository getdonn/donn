import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { memoryStore, problemOf, publishLayer } from "./engine.js";
import type { LayerSummary, ProblemCode } from "./schemas.js";

// An in-memory registry that implements docs/planning/18-registry-contract.md §1-§2 on the
// publish engine (docs/planning/19-publish-engine.md). It is the
// reference for the conformance kit, and the server the client's tests run against.

/** A request body over this is refused before parsing, as bundle-too-large. */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

interface ProblemItem {
  code: ProblemCode;
  ref?: string;
  path?: string;
  message: string;
}

class Failure extends Error {
  constructor(
    readonly status: number,
    readonly problems: ProblemItem[],
  ) {
    super(problems.map((p) => p.message).join("; "));
  }
}

const refuse = (
  status: number,
  code: ProblemCode,
  message: string,
  rest = {},
) => new Failure(status, [{ code, message, ...rest }]);

interface Reply {
  status: number;
  body: unknown;
}

export interface MockRegistryOptions {
  token?: string;
  subject?: string;
  org?: string;
}

export interface MockRegistry {
  url: string;
  token: string;
  stop(): Promise<void>;
  /** The latest version of every published layer. */
  layers(): LayerSummary[];
}

export async function startMockRegistry(
  options: MockRegistryOptions = {},
): Promise<MockRegistry> {
  const token = options.token ?? "mock-token";
  const subject = options.subject ?? "mock-user";
  const org = options.org ?? "acme";
  const store = memoryStore();
  /** Publishes run one at a time, as the engine requires. */
  let queue: Promise<unknown> = Promise.resolve();

  const summaries = (): LayerSummary[] => store.summaries();

  async function publish(ref: string, body: unknown): Promise<Reply> {
    const run = queue.then(() =>
      publishLayer(store, ref, body, { subject, now: new Date() }),
    );
    queue = run.catch(() => undefined);
    const outcome = await run;
    if ("problem" in outcome) {
      throw new Failure(outcome.status, outcome.problem.problems ?? []);
    }
    return { status: outcome.status, body: outcome.result };
  }

  async function route(
    request: IncomingMessage,
    method: string,
    path: string,
  ): Promise<Reply> {
    if (request.headers.authorization !== `Bearer ${token}`) {
      throw refuse(401, "unauthorized", "missing or refused token");
    }
    if (method === "GET" && path === "/v1/whoami") {
      return { status: 200, body: { subject, org } };
    }
    if (method === "GET" && path === "/v1/layers") {
      return { status: 200, body: summaries() };
    }
    const match = /^\/v1\/layers\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(path);
    if (match) {
      let ref: string;
      try {
        ref = decodeURIComponent(match[1]!);
      } catch {
        throw refuse(404, "not-found", `no layer at ${match[1]!}`);
      }
      if (method === "GET" && match[2] !== undefined) {
        const versions = store.versions(ref);
        const wanted = match[2];
        const found =
          wanted === "latest"
            ? versions?.at(-1)
            : /^[1-9][0-9]*$/.test(wanted)
              ? versions?.[Number(wanted) - 1]
              : undefined;
        if (!found)
          throw refuse(404, "not-found", `${ref} @${wanted} is not published`, {
            ref,
          });
        return { status: 200, body: found };
      }
      if (method === "POST" && match[2] === undefined) {
        return publish(ref, await readJson(request));
      }
    }
    throw refuse(404, "not-found", `no route for ${method} ${path}`);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    route(request, request.method ?? "GET", url.pathname)
      .catch((error: unknown) => {
        if (error instanceof Failure) return error;
        throw error;
      })
      .then((result) => {
        const reply: Reply =
          result instanceof Failure
            ? {
                status: result.status,
                body: problemOf(result.status, result.problems),
              }
            : result;
        response.writeHead(reply.status, {
          "content-type":
            reply.status >= 400
              ? "application/problem+json"
              : "application/json",
        });
        response.end(JSON.stringify(reply.body));
      })
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/problem+json" });
        response.end(
          JSON.stringify({
            type: "about:blank",
            title: "Internal error",
            status: 500,
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    layers: summaries,
    stop: () =>
      new Promise<void>((resolveStop, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolveStop()));
      }),
  };
}

/** The JSON body, or a bundle-too-large failure when it passes MAX_BODY_BYTES. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw refuse(
        422,
        "bundle-too-large",
        `request body is over ${MAX_BODY_BYTES} bytes`,
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw refuse(422, "invalid", "request body is not JSON");
  }
}
