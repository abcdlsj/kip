/**
 * The managed sidecar end to end, against a stub that speaks just enough of the
 * gateway's HTTP surface. No Google account and no network: this checks that Kip
 * writes a config, starts the process, waits for health, reads models, and stops.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKey,
  ensureRunning,
  health,
  savedCookies,
  saveCookies,
  status,
  stop,
} from "../src/bun/plugins/gemini2api/service";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-sidecar-"));
  process.env.KIP_DATA_DIR = dir;
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the frozen binary: same env contract, same two endpoints. */
function stubBinary(): string {
  const script = join(dir, "stub-gemini2api.ts");
  writeFileSync(
    script,
    `
const port = Number(process.env.PORT);
const key = process.env.API_KEY ?? "";
const authorized = (request: Request) =>
  !key || request.headers.get("authorization") === \`Bearer \${key}\`;
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (!authorized(request)) return new Response("no", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        server: "gemini2api",
        version: "9.9.9",
        key_required: true,
        accounts: { stub: { signed_in: true, status: "AVAILABLE" } },
        api: { context_window: 1000 },
      });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [
          { id: "gemini-stub", name: "gemini-stub", gemini: { display_name: "gemini-stub" } },
          { id: "gemini-stub-temp", name: "gemini-stub-temp", gemini: { temporary: true } },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
`,
  );
  const launcher = join(dir, "stub-gemini2api");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  return launcher;
}

describe("gemini2api sidecar", () => {
  test.skipIf(process.platform === "win32")(
    "starts the binary with a generated config and stops it again",
    async () => {
      const dataDir = join(dir, "plugin");
      saveCookies(dataDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts", SID: "sid" },
      });
      const binary = stubBinary();

      const started = await ensureRunning(dataDir, { binaryPath: binary });
      try {
        expect(started.port).toBeGreaterThan(0);
        expect(started.key).toBe(apiKey(dataDir));
        expect(started.baseUrl).toBe(`http://127.0.0.1:${started.port}/v1`);

        const body = await health(started.port, started.key);
        expect(body?.server).toBe("gemini2api");
        expect(body?.version).toBe("9.9.9");

        const models = await fetch(`${started.baseUrl}/models`, {
          headers: { authorization: `Bearer ${started.key}` },
        }).then((response) => response.json() as Promise<{ data: Array<{ id: string }> }>);
        expect(models.data.map((model) => model.id)).toContain("gemini-stub");

        const config = readFileSync(join(dataDir, "config.yaml"), "utf8");
        expect(config).toContain('secure_1psid: "psid"');
        expect(config).toContain(`port: ${started.port}`);
        expect(config).toContain(`api_key: ${JSON.stringify(started.key)}`);
        expect(config).toContain(`state_dir: ${JSON.stringify(join(dataDir, "state"))}`);
        expect(status(dataDir, { binaryPath: binary }).running).toBe(true);
        expect(savedCookies(dataDir)?.cookies["SID"]).toBe("sid");
      } finally {
        await stop();
      }

      expect(status(dataDir, { binaryPath: binary }).running).toBe(false);
      expect(await health(started.port, started.key)).toBeNull();
    },
  );

  test("refuses to start when nothing is installed", async () => {
    await expect(ensureRunning(join(dir, "missing"), {})).rejects.toThrow(/not installed/);
  });
});
