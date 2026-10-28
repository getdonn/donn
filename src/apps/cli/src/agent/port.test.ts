import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPortFree,
  choosePort,
  freePort,
  isPort,
  parsePort,
} from "./port.js";
import { recordPort, storedPort } from "./registry.js";

let home: string;
const held: Server[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "donn-agent-port-"));
});
afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Hold a free port on 127.0.0.1 until the test ends. */
async function hold(): Promise<number> {
  const port = await freePort();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  held.push(server);
  return port;
}

describe("parsePort", () => {
  it.each(["0", "80", "1023", "65536", "70000", "8787x", "-1", "", "87.5"])(
    "refuses %j",
    (text) => {
      expect(() => parsePort(text)).toThrow(
        "--port must be an integer from 1024 to 65535",
      );
    },
  );
  it("accepts the range's ends", () => {
    expect(parsePort("1024")).toBe(1024);
    expect(parsePort("65535")).toBe(65535);
  });
  it("isPort checks the same range", () => {
    expect(isPort(8787)).toBe(true);
    expect(isPort(80)).toBe(false);
    expect(isPort("8787")).toBe(false);
  });
});

describe("free and taken ports", () => {
  it("freePort finds a port that is free", async () => {
    const port = await freePort();
    await expect(assertPortFree(port, "a")).resolves.toBeUndefined();
  });
  it("assertPortFree refuses a bound port", async () => {
    const port = await hold();
    await expect(assertPortFree(port, "a")).rejects.toMatchObject({
      code: "port-in-use",
      message: `port ${port} is in use by another process`,
      details: { port, fix: "donn agent run a --port <other>" },
    });
  });
});

describe("choosePort", () => {
  it("picks, stores and then reuses a port", async () => {
    const first = await choosePort(home, "/r", "a");
    expect(first.picked).toBe(true);
    expect(await storedPort(home, "/r", "a")).toBe(first.port);
    const again = await choosePort(home, "/r", "a");
    expect(again).toEqual({ port: first.port, picked: false });
  });
  it("a requested port replaces the stored one", async () => {
    const first = await choosePort(home, "/r", "a");
    const other = await freePort();
    const next = await choosePort(home, "/r", "a", other);
    expect(next).toEqual({ port: other, picked: false });
    expect(await storedPort(home, "/r", "a")).toBe(other);
    expect(other).not.toBe(first.port);
  });
  it("a taken stored port is refused and kept", async () => {
    const port = await hold();
    await recordPort(home, "/r", "a", port);
    await expect(choosePort(home, "/r", "a")).rejects.toMatchObject({
      code: "port-in-use",
    });
    expect(await storedPort(home, "/r", "a")).toBe(port);
  });
  it("a taken requested port is refused and never stored", async () => {
    const stored = await freePort();
    await recordPort(home, "/r", "a", stored);
    const taken = await hold();
    await expect(choosePort(home, "/r", "a", taken)).rejects.toMatchObject({
      code: "port-in-use",
    });
    expect(await storedPort(home, "/r", "a")).toBe(stored);
  });
});
