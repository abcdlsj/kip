/**
 * The managed sidecar end to end, against a stub that speaks just enough of the
 * gateway's HTTP surface. No Google account and no network: this checks that Kip
 * writes a config, starts the process, waits for health, reads models, and stops.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKey,
  ensureRunning,
  health,
  preferredPort,
  refreshSavedCookiesFromCache,
  savedCookies,
  saveCookies,
  status,
  stop,
} from "../src/bun/plugins/gemini2api/service";
import { createGeminiPage } from "../src/bun/plugins/gemini2api/page";
import { getApiKey, setApiKey } from "../src/bun/storage/keychain";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-sidecar-"));
  process.env.KIP_DATA_DIR = dir;
  process.env.KIP_KEYCHAIN = "file";
});

afterEach(async () => {
  await stop();
  delete process.env.KIP_KEYCHAIN;
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
  // Two processes, like PyInstaller's bootloader plus its child: a plain kill of
  // the launcher would leave the server running.
  writeFileSync(
    launcher,
    `#!/bin/sh\n"${process.execPath}" "${script}" &\nchild=$!\nwait $child\n`,
    { mode: 0o755 },
  );
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

  test("keeps the configured port, and never treats an empty field as port 0", () => {
    expect(preferredPort({})).toBe(8790);
    expect(preferredPort({ port: "" })).toBe(8790);
    expect(preferredPort({ port: "0" })).toBe(8790);
    expect(preferredPort({ port: "9001" })).toBe(9001);
    expect(preferredPort({ port: "nope" })).toBe(8790);
  });

  test("a managed instance adopts the key Kip already holds for the provider", async () => {
    if (process.platform === "win32") return;
    await setApiKey("gemini2api", "stored-key");
    const dataDir = join(dir, "plugin-key");
    saveCookies(dataDir, {
      profile: "/tmp/firefox",
      cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
    });

    const started = await ensureRunning(dataDir, { binaryPath: stubBinary() });
    try {
      expect(started.key).toBe("stored-key");
      expect(await getApiKey("gemini2api")).toBe("stored-key");
      expect(readFileSync(join(dataDir, "config.yaml"), "utf8")).toContain(
        'api_key: "stored-key"',
      );
      expect((await health(started.port, "stored-key"))?.server).toBe("gemini2api");
    } finally {
      await stop();
    }
  });

  test("reuses the rotated session cookie gemini2api cached last run", () => {
    const dataDir = join(dir, "plugin-rotate");
    saveCookies(dataDir, {
      profile: "/tmp/firefox",
      cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "stale" },
    });
    mkdirSync(join(dataDir, "state"), { recursive: true });
    writeFileSync(
      join(dataDir, "state", ".cached_cookies_psid.json"),
      JSON.stringify([
        { name: "__Secure-1PSID", value: "psid" },
        { name: "__Secure-1PSIDTS", value: "fresh" },
      ]),
    );

    expect(refreshSavedCookiesFromCache(dataDir)).toBe(true);
    expect(savedCookies(dataDir)?.cookies["__Secure-1PSIDTS"]).toBe("fresh");
    // Second call is a no-op: nothing changed.
    expect(refreshSavedCookiesFromCache(dataDir)).toBe(false);
  });

  test("refuses to start when nothing is installed", async () => {
    await expect(ensureRunning(join(dir, "missing"), {})).rejects.toThrow(/not installed/);
  });

  test.skipIf(process.platform === "win32")(
    "fails immediately when the binary crashes during startup",
    async () => {
      const dataDir = join(dir, "plugin-crash");
      saveCookies(dataDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid" },
      });
      const crasher = join(dir, "crash-gemini2api");
      writeFileSync(crasher, "#!/bin/sh\necho 'boom on startup' >&2\nexit 2\n", { mode: 0o755 });

      const startedAt = Date.now();
      await expect(ensureRunning(dataDir, { binaryPath: crasher })).rejects.toThrow(
        /exited during startup \(code 2\).*boom on startup/,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    },
  );

  test.skipIf(process.platform === "win32")(
    "deduplicates concurrent starts onto one process",
    async () => {
      const dataDir = join(dir, "plugin-concurrent");
      saveCookies(dataDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
      });
      const binary = stubBinary();

      const [first, second] = await Promise.all([
        ensureRunning(dataDir, { binaryPath: binary }),
        ensureRunning(dataDir, { binaryPath: binary }),
      ]);
      expect(first.port).toBe(second.port);
      expect(first.key).toBe(second.key);
    },
  );
});

describe("gemini2api window", () => {
  test("uses a server the user already runs instead of starting a second client", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/health") {
          return Response.json({
            server: "gemini2api",
            version: "9.9.9",
            key_required: false,
            accounts: { firefox: { signed_in: true, status: "AVAILABLE" } },
          });
        }
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "gemini-stub", name: "gemini-stub" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const dataDir = join(dir, "plugin");
    const controller = createGeminiPage({
      pluginId: "gemini2api",
      dataDir,
      values: () => ({ host: "127.0.0.1", port: String(server.port) }),
      emit: () => {},
    });
    try {
      const snapshot = (await controller.state()) as {
        running: boolean;
        external: boolean;
        health: { accounts: Array<{ signedIn: boolean }> } | null;
        models: Array<{ id: string }>;
        error: { message: string; hint: string | null } | null;
      };
      expect(snapshot.running).toBe(true);
      expect(snapshot.external).toBe(true);
      expect(snapshot.health?.accounts[0]?.signedIn).toBe(true);
      expect(snapshot.models.map((model) => model.id)).toEqual(["gemini-stub"]);

      await controller.act("start");
      const afterStart = (await controller.state()) as typeof snapshot;
      expect(afterStart.error?.message).toContain("already running");
      expect(afterStart.error?.hint).toContain("Detect");
      // Nothing was spawned: the managed handle is still empty.
      expect(status(dataDir, {}).running).toBe(false);

      await controller.act("stop");
      const afterStop = (await controller.state()) as typeof snapshot;
      expect(afterStop.error?.message).toContain("was not started by Kip");
    } finally {
      server.stop(true);
      await controller.dispose?.();
    }
  });

  test("a failed start explains what to do about the session", async () => {
    const dataDir = join(dir, "plugin-fail");
    saveCookies(dataDir, { profile: "/tmp/firefox", cookies: { "__Secure-1PSID": "stale" } });
    const fakeBinary = join(dir, "fake-gemini2api");
    writeFileSync(
      fakeBinary,
      '#!/bin/sh\necho "RuntimeError: no account signed in: every client fell back to a guest session." >&2\nexit 3\n',
      { mode: 0o755 },
    );

    if (process.platform === "win32") return;
    const controller = createGeminiPage({
      pluginId: "gemini2api",
      dataDir,
      values: () => ({ binaryPath: fakeBinary, host: "127.0.0.1", port: "1" }),
      emit: () => {},
    });
    try {
      await controller.act("start");
      const snapshot = (await controller.state()) as {
        error: { message: string; hint: string | null } | null;
      };
      expect(snapshot.error?.message).toContain("exited during startup");
      expect(snapshot.error?.hint).toContain("Use Firefox session");
      expect(snapshot.error?.hint).toContain("Detect");
    } finally {
      await controller.dispose?.();
    }
  });
});

describe("gemini2api process tree", () => {
  test.skipIf(process.platform === "win32")(
    "Stop ends the child process too, not just the launcher",
    async () => {
      const dataDir = join(dir, "plugin-tree");
      saveCookies(dataDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
      });
      const binary = stubBinary();
      const started = await ensureRunning(dataDir, { binaryPath: binary });
      expect((await health(started.port, started.key))?.server).toBe("gemini2api");

      await stop();
      await Bun.sleep(500);

      expect(await health(started.port, started.key)).toBeNull();
      const leftover = Bun.spawnSync(["pgrep", "-f", "stub-gemini2api.ts"]);
      expect(leftover.stdout.toString().trim()).toBe("");
    },
  );
});
