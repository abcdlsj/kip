/**
 * Tests for local gateway process supervision (GatewayWatchdog), orchestrator
 * stall/failure recovery, restart-storm protection, plugin window visibility,
 * and isolation of remote/external providers.
 *
 * Uses only local fake HTTP servers and stub binaries — never real network,
 * real sidecar binaries, or system keychains.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayWatchdog,
  classifyGatewayFailure,
  type WatchdogTimer,
} from "../src/bun/plugins/gemini2api/watchdog";
import {
  gemini2apiPlugin,
  resetGeminiWatchdog,
} from "../src/bun/plugins/gemini2api";
import {
  saveCookies,
  stop as stopSidecar,
} from "../src/bun/plugins/gemini2api/service";
import {
  PluginRegistry,
  acceptPlugin,
  beforeGatewayAttempt,
  gatewayRequestPolicy,
  onGatewayRequestFailure,
  onGatewayRequestSuccess,
  pluginDataDir,
  savePluginValues,
} from "../src/bun/plugins/registry";
import type { GatewayPlugin, GatewayStatusNotice } from "../src/bun/plugins/types";
import { KipDatabase } from "../src/bun/storage/db";
import { setApiKey } from "../src/bun/storage/keychain";
import { CliRuntime } from "../src/cli/runtime";
import { ModelRegistry } from "../src/bun/agent/model-registry";
import { KipOrchestrator } from "../src/bun/agent/pi-orchestrator";
import type { AgentStreamEvent } from "../src/shared/types";
import type { GeminiPageState } from "../src/shared/plugins/gemini2api";

interface ScheduledTimer {
  run: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

function watchdogHarness(overrides: {
  busy?: boolean;
  isProcessRunning?: boolean;
  checkHealth?: () => Promise<boolean>;
  restartProcess?: () => Promise<void>;
  maxRestarts?: number;
  windowMs?: number;
  backoffMs?: number[];
  probeIntervalMs?: number;
  probeFailureThreshold?: number;
} = {}) {
  let clock = 1_000_000;
  const timers: ScheduledTimer[] = [];
  const logs: string[] = [];
  const stateChanges: string[] = [];
  let restarts = 0;

  const state = {
    busy: overrides.busy ?? false,
    isProcessRunning: overrides.isProcessRunning ?? true,
    checkHealth: overrides.checkHealth ?? (async () => true),
    restartProcess:
      overrides.restartProcess ??
      (async () => {
        restarts += 1;
        state.isProcessRunning = true;
      }),
  };

  const watchdog = new GatewayWatchdog({
    label: "gemini2api",
    busy: () => state.busy,
    isProcessRunning: () => state.isProcessRunning,
    checkHealth: () => state.checkHealth(),
    restartProcess: () => state.restartProcess(),
    log: (line) => logs.push(line),
    maxRestarts: overrides.maxRestarts ?? 3,
    windowMs: overrides.windowMs ?? 5 * 60_000,
    backoffMs: overrides.backoffMs ?? [0, 2_000, 5_000],
    probeIntervalMs: overrides.probeIntervalMs ?? 60_000,
    probeFailureThreshold: overrides.probeFailureThreshold ?? 2,
    now: () => clock,
    schedule: (run, ms): WatchdogTimer => {
      const entry: ScheduledTimer = {
        ms,
        cancelled: false,
        fired: false,
        run: () => {
          entry.fired = true;
          run();
        },
      };
      timers.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  });

  watchdog.subscribe(() => stateChanges.push(watchdog.getSnapshot().state));

  const liveTimers = () =>
    timers.filter((item) => !item.cancelled && !item.fired);

  return {
    watchdog,
    state,
    logs,
    stateChanges,
    timers,
    liveTimers,
    restarts: () => restarts,
    advance: (ms: number) => {
      clock += ms;
    },
    fireNext: async () => {
      const next = liveTimers()[0];
      if (!next) throw new Error("No live timer to fire");
      clock += next.ms;
      next.run();
      await Bun.sleep(0);
    },
  };
}

describe("GatewayWatchdog unit behavior", () => {
  test("classifies transport/stall/502-504 as restart, 500 as check_health, and auth/4xx/abort as ignore", () => {
    expect(classifyGatewayFailure("Request timed out.", "timeout")).toBe(
      "restart",
    );
    expect(
      classifyGatewayFailure("Local gateway stream timed out (no data)", "stall"),
    ).toBe("restart");
    expect(classifyGatewayFailure("Connection error (ECONNREFUSED)")).toBe(
      "restart",
    );
    expect(classifyGatewayFailure("socket hang up / ECONNRESET")).toBe(
      "restart",
    );
    expect(classifyGatewayFailure("502 Bad Gateway")).toBe("restart");
    expect(classifyGatewayFailure("503 Service Unavailable")).toBe("restart");
    expect(classifyGatewayFailure("504 Gateway Timeout")).toBe("restart");

    expect(classifyGatewayFailure("500 Internal Server Error")).toBe(
      "check_health",
    );

    expect(classifyGatewayFailure("401 Unauthorized")).toBe("ignore");
    expect(classifyGatewayFailure("no Gemini account is signed in")).toBe(
      "ignore",
    );
    expect(classifyGatewayFailure("429 Too Many Requests")).toBe("ignore");
    expect(classifyGatewayFailure("400 invalid request")).toBe("ignore");
    expect(classifyGatewayFailure("Retry cancelled")).toBe("ignore");
    expect(classifyGatewayFailure("Request was aborted")).toBe("ignore");
  });

  test("restarts on stall/transport failure, ignores auth/4xx, and checks /health on 500", async () => {
    const h = watchdogHarness({ backoffMs: [0, 0, 0] });
    h.watchdog.markHealthy();

    // Auth error must never restart the sidecar.
    const authRes = await h.watchdog.handleRequestFailure({
      kind: "unknown",
      message: "401 Unauthorized",
      willRetry: false,
    });
    expect(authRes.recovered).toBe(false);
    expect(h.restarts()).toBe(0);

    // 500 with healthy /health must not restart.
    const healthy500 = await h.watchdog.handleRequestFailure({
      kind: "server_error",
      message: "500 Internal Server Error",
      willRetry: true,
    });
    expect(healthy500.recovered).toBe(false);
    expect(h.restarts()).toBe(0);

    // 500 when /health fails DOES restart.
    h.state.checkHealth = async () => false;
    const unhealthy500 = await h.watchdog.handleRequestFailure({
      kind: "server_error",
      message: "500 Internal Server Error",
      willRetry: true,
    });
    expect(unhealthy500.recovered).toBe(true);
    expect(h.restarts()).toBe(1);

    // Stall restarts immediately even if /health still answers OK.
    h.state.checkHealth = async () => true;
    const notices: GatewayStatusNotice[] = [];
    const stallRes = await h.watchdog.handleRequestFailure(
      {
        kind: "stall",
        message: "Local gateway timed out waiting for response",
        willRetry: true,
      },
      (n) => notices.push(n),
    );
    expect(stallRes.recovered).toBe(true);
    expect(h.restarts()).toBe(2);
    expect(notices.map((n) => n.phase)).toEqual(["restarting", "recovered"]);
  });

  test("deduplicates concurrent recoveries onto one restart", async () => {
    let release!: () => void;
    let calls = 0;
    const h = watchdogHarness({
      backoffMs: [0],
      restartProcess: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    h.watchdog.markHealthy();

    const noticesA: GatewayStatusNotice[] = [];
    const noticesB: GatewayStatusNotice[] = [];
    const first = h.watchdog.recover("stall A", (n) => noticesA.push(n));
    const second = h.watchdog.recover("stall B", (n) => noticesB.push(n));

    expect(calls).toBe(1);
    expect(h.watchdog.getSnapshot().state).toBe("restarting");

    release();
    const [resA, resB] = await Promise.all([first, second]);
    expect(resA.recovered).toBe(true);
    expect(resB.recovered).toBe(true);
    expect(calls).toBe(1);
    expect(h.watchdog.getSnapshot().restartCount).toBe(1);
    expect(noticesB.some((n) => n.phase === "recovered")).toBe(true);
  });

  test("enforces restart budget + backoff to prevent restart storms, then recovers after window or reset", async () => {
    const h = watchdogHarness({
      maxRestarts: 2,
      windowMs: 60_000,
      backoffMs: [0, 3_000],
      probeIntervalMs: 0,
    });
    h.watchdog.markHealthy();

    // 1st restart: 0ms backoff
    const r1 = await h.watchdog.recover("hang 1");
    expect(r1.recovered).toBe(true);
    expect(h.restarts()).toBe(1);

    // 2nd restart: 3000ms backoff
    const r2Promise = h.watchdog.recover("hang 2");
    expect(h.liveTimers()).toHaveLength(1);
    expect(h.liveTimers()[0]!.ms).toBe(3_000);
    await h.fireNext();
    const r2 = await r2Promise;
    expect(r2.recovered).toBe(true);
    expect(h.restarts()).toBe(2);

    // 3rd attempt within 60s window hits degraded limit and aborts retries.
    const notices: GatewayStatusNotice[] = [];
    const r3 = await h.watchdog.recover("hang 3", (n) => notices.push(n));
    expect(r3.recovered).toBe(false);
    expect(r3.abortRetry).toBe(true);
    expect(h.restarts()).toBe(2);
    expect(h.watchdog.getSnapshot().state).toBe("degraded");
    expect(h.watchdog.getSnapshot().nextRetryAt).not.toBeNull();
    expect(notices[0]?.phase).toBe("degraded");

    // Advancing past the sliding window expires earlier restarts.
    h.advance(61_000);
    const r4 = await h.watchdog.recover("hang 4");
    expect(r4.recovered).toBe(true);
    expect(h.restarts()).toBe(3);

    // Manual resetBudget also clears degraded state immediately.
    const r5Promise = h.watchdog.recover("hang 5");
    await h.fireNext();
    await r5Promise;
    const degradedAgain = await h.watchdog.recover("hang 6");
    expect(degradedAgain.abortRetry).toBe(true);
    h.watchdog.resetBudget();
    const afterReset = await h.watchdog.recover("hang 7");
    expect(afterReset.recovered).toBe(true);
  });

  test("active probe restarts a hung process after threshold, skips when busy, and never fights intentional stop", async () => {
    const h = watchdogHarness({
      backoffMs: [0],
      probeIntervalMs: 10_000,
      probeFailureThreshold: 2,
    });
    h.watchdog.markHealthy();

    // Busy run: probe skips without touching health.
    let probed = 0;
    h.state.busy = true;
    h.state.checkHealth = async () => {
      probed += 1;
      return false;
    };
    await h.fireNext();
    expect(probed).toBe(0);
    expect(h.restarts()).toBe(0);

    // Idle + process alive + /health fails once -> unhealthy, no restart yet.
    h.state.busy = false;
    await h.fireNext();
    expect(probed).toBe(1);
    expect(h.watchdog.getSnapshot().state).toBe("unhealthy");
    expect(h.restarts()).toBe(0);

    // Second consecutive failure -> restarts.
    await h.fireNext();
    expect(probed).toBe(2);
    expect(h.restarts()).toBe(1);
    expect(h.watchdog.getSnapshot().state).toBe("healthy");

    // Process exited unexpectedly while idle -> immediate recovery.
    h.state.isProcessRunning = false;
    h.watchdog.handleUnexpectedExit(137);
    await Bun.sleep(0);
    expect(h.restarts()).toBe(2);

    // Intentional stop (Stop button / idle pause) cancels probe and ignores exits.
    h.watchdog.markStopped();
    expect(h.liveTimers()).toHaveLength(0);
    h.watchdog.handleUnexpectedExit(0);
    await Bun.sleep(0);
    expect(h.restarts()).toBe(2);
    expect(h.watchdog.getSnapshot().state).toBe("stopped");
  });
});

let tempDirs: string[] = [];
let servers: Array<ReturnType<typeof Bun.serve>> = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function freePort(): number {
  const held = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = held.port as number;
  held.stop(true);
  return port;
}

/**
 * Writes a fake PyInstaller-like launcher + Bun server that tracks how many
 * times it has been booted and changes its `/v1/chat/completions` behavior by
 * boot number:
 * - "hang-then-ok": boot 1 hangs forever (0 bytes, `/health` still OK!); boot 2+ streams SSE reply
 * - "crash-then-ok": boot 1 immediately crashes when `/v1/chat/completions` arrives; boot 2+ streams SSE reply
 * - "always-hang": hangs on every boot (to test restart-storm exhaustion)
 */
function writeFaultySidecarBinary(
  dir: string,
  behavior: "hang-then-ok" | "crash-then-ok" | "always-hang",
): { binary: string; bootFile: string; pidsFile: string } {
  const bootFile = join(dir, "boot-count.txt");
  const pidsFile = join(dir, "boot-pids.txt");
  const script = join(dir, `stub-sidecar-${behavior}.ts`);

  writeFileSync(
    script,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const port = Number(process.env.PORT);
const key = process.env.API_KEY ?? "";
const bootFile = ${JSON.stringify(bootFile)};
const pidsFile = ${JSON.stringify(pidsFile)};
const behavior = ${JSON.stringify(behavior)};

const boot = (existsSync(bootFile) ? Number(readFileSync(bootFile, "utf8").trim()) : 0) + 1;
writeFileSync(bootFile, String(boot));
appendFileSync(pidsFile, String(process.pid) + "\\n");

const authorized = (req: Request) =>
  !key || req.headers.get("authorization") === \`Bearer \${key}\`;

function sseReply(text: string): Response {
  const chunk1 = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gemini-stub",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  const chunk2 = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gemini-stub",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const body = \`data: \${chunk1}\\n\\ndata: \${chunk2}\\n\\ndata: [DONE]\\n\\n\`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    if (!authorized(req)) return new Response("unauthorized", { status: 401 });
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        server: "gemini2api",
        version: "9.9.9",
        key_required: Boolean(key),
        chats: boot === 1 && behavior !== "crash-then-ok" ? 2 : 0,
        accounts: { firefox: { signed_in: true, status: "AVAILABLE" } },
        api: { context_window: 128000 },
      });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "gemini-stub", name: "gemini-stub" }],
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      if (behavior === "always-hang" || (behavior === "hang-then-ok" && boot === 1)) {
        // Real incident reproduction: accept connection, send 0 bytes forever.
        return new Promise<Response>(() => {});
      }
      if (behavior === "crash-then-ok" && boot === 1) {
        // Simulate sudden process crash mid-request (connection reset / refused).
        setTimeout(() => process.exit(1), 5);
        return new Promise<Response>(() => {});
      }
      return sseReply(\`Recovered on boot #\${boot}\`);
    }
    return new Response("not found", { status: 404 });
  },
});
`,
  );

  const binary = join(dir, `launcher-${behavior}`);
  // Two-process tree (shell parent + bun child) matching PyInstaller's bootloader + child.
  writeFileSync(
    binary,
    `#!/bin/sh\n"${process.execPath}" "${script}" &\nchild=$!\nwait $child\n`,
    { mode: 0o755 },
  );
  return { binary, bootFile, pidsFile };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  process.env.KIP_KEYCHAIN = "file";
  resetGeminiWatchdog();
});

afterEach(async () => {
  await stopSidecar();
  resetGeminiWatchdog();
  for (const s of servers) s.stop(true);
  servers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  delete process.env.KIP_DATA_DIR;
  delete process.env.KIP_KEYCHAIN;
});

describe("gateway watchdog end-to-end recovery", () => {
  test.skipIf(process.platform === "win32")(
    "restarts a hung sidecar (/health OK, 0-byte completions) so Pi's retry hits the fresh process and succeeds",
    async () => {
      const dataDir = makeTempDir("kip-gw-hang-data-");
      const projectDir = makeTempDir("kip-gw-hang-proj-");
      const binDir = makeTempDir("kip-gw-hang-bin-");
      process.env.KIP_DATA_DIR = dataDir;

      // Fast timeout & short retry backoff keep the test snappy while exercising
      // the exact stall -> auto_retry_start -> kill/restart -> retry path.
      mkdirSync(join(dataDir, "agent"), { recursive: true });
      writeFileSync(
        join(dataDir, "agent", "settings.json"),
        JSON.stringify({
          httpIdleTimeoutMs: 450,
          retry: {
            enabled: true,
            maxRetries: 2,
            baseDelayMs: 100,
            provider: { maxRetries: 0 },
          },
        }),
      );

      const port = freePort();
      const { binary, bootFile, pidsFile } = writeFaultySidecarBinary(
        binDir,
        "hang-then-ok",
      );

      const pluginDir = pluginDataDir("gemini2api");
      saveCookies(pluginDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
      });

      const setup = new KipDatabase();
      acceptPlugin(setup, gemini2apiPlugin);
      savePluginValues(setup, gemini2apiPlugin, {
        host: "127.0.0.1",
        port: String(port),
        binaryPath: binary,
      });
      setup.saveProvider({
        id: "gemini2api",
        displayName: "gemini2api",
        protocol: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [
          {
            id: "gemini-stub",
            displayName: "Gemini Stub",
            contextWindow: 128_000,
            maxOutputTokens: 8_000,
            supportsVision: false,
            supportsReasoning: false,
          },
        ],
      });
      setup.close();
      await setApiKey("gemini2api", "sk-local-test");

      const events: AgentStreamEvent[] = [];
      const runtime = await CliRuntime.create({
        cwd: projectDir,
        ephemeral: true,
        continueLast: false,
        chat: true,
        onEvent: (_threadId, event) => events.push(event),
      });

      try {
        await runtime.orchestrator.sendPrompt({
          threadId: runtime.thread.id,
          text: "hello after hang",
        });
        await Bun.sleep(100);
      } finally {
        await runtime.dispose();
      }

      const text = events
        .filter((e): e is Extract<AgentStreamEvent, { kind: "text_delta" }> => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      const gatewayEvents = events.filter(
        (e): e is Extract<AgentStreamEvent, { kind: "gateway_status" }> =>
          e.kind === "gateway_status",
      );
      const retryEnd = events.find((e) => e.kind === "retry_end");
      const turnErrors = events.filter((e) => e.kind === "turn_error");

      expect(text).toContain("Recovered on boot #2");
      expect(gatewayEvents.map((e) => e.phase)).toEqual([
        "restarting",
        "recovered",
      ]);
      expect(retryEnd).toMatchObject({ attempt: 1, success: true });
      expect(turnErrors).toHaveLength(0);
      expect(readFileSync(bootFile, "utf8").trim()).toBe("2");

      // Old sidecar child process must be gone (killed via process group).
      const pids = readFileSync(pidsFile, "utf8")
        .trim()
        .split("\n")
        .map(Number);
      expect(pids).toHaveLength(2);
      expect(isPidAlive(pids[0]!)).toBe(false);
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    "restarts a sidecar that crashes mid-request (connection dropped/refused) and completes the turn",
    async () => {
      const dataDir = makeTempDir("kip-gw-crash-data-");
      const projectDir = makeTempDir("kip-gw-crash-proj-");
      const binDir = makeTempDir("kip-gw-crash-bin-");
      process.env.KIP_DATA_DIR = dataDir;

      mkdirSync(join(dataDir, "agent"), { recursive: true });
      writeFileSync(
        join(dataDir, "agent", "settings.json"),
        JSON.stringify({
          httpIdleTimeoutMs: 2_000,
          retry: {
            enabled: true,
            maxRetries: 2,
            baseDelayMs: 100,
            provider: { maxRetries: 0 },
          },
        }),
      );

      const port = freePort();
      const { binary, bootFile } = writeFaultySidecarBinary(
        binDir,
        "crash-then-ok",
      );

      const pluginDir = pluginDataDir("gemini2api");
      saveCookies(pluginDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
      });

      const setup = new KipDatabase();
      acceptPlugin(setup, gemini2apiPlugin);
      savePluginValues(setup, gemini2apiPlugin, {
        host: "127.0.0.1",
        port: String(port),
        binaryPath: binary,
      });
      setup.saveProvider({
        id: "gemini2api",
        displayName: "gemini2api",
        protocol: "openai-completions",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [
          {
            id: "gemini-stub",
            displayName: "Gemini Stub",
            contextWindow: 128_000,
            maxOutputTokens: 8_000,
            supportsVision: false,
            supportsReasoning: false,
          },
        ],
      });
      setup.close();
      await setApiKey("gemini2api", "sk-local-test");

      const events: AgentStreamEvent[] = [];
      const runtime = await CliRuntime.create({
        cwd: projectDir,
        ephemeral: true,
        continueLast: false,
        chat: true,
        onEvent: (_threadId, event) => events.push(event),
      });

      try {
        await runtime.orchestrator.sendPrompt({
          threadId: runtime.thread.id,
          text: "hello after crash",
        });
        await Bun.sleep(100);
      } finally {
        await runtime.dispose();
      }

      const text = events
        .filter((e): e is Extract<AgentStreamEvent, { kind: "text_delta" }> => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      expect(text).toContain("Recovered on boot #2");
      expect(events.filter((e) => e.kind === "turn_error")).toHaveLength(0);
      expect(readFileSync(bootFile, "utf8").trim()).toBe("2");
    },
    30_000,
  );

  test("stops retrying immediately once a local gateway exhausts its restart budget", async () => {
    const dataDir = makeTempDir("kip-gw-storm-data-");
    const projectDir = makeTempDir("kip-gw-storm-proj-");
    process.env.KIP_DATA_DIR = dataDir;

    mkdirSync(join(dataDir, "agent"), { recursive: true });
    writeFileSync(
      join(dataDir, "agent", "settings.json"),
      JSON.stringify({
        httpIdleTimeoutMs: 2_000,
        retry: {
          enabled: true,
          maxRetries: 5,
          baseDelayMs: 80,
          provider: { maxRetries: 0 },
        },
      }),
    );

    // Fake HTTP server that accepts connections and hangs forever (0 bytes).
    let requestHits = 0;
    const hanging = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [] });
        }
        requestHits += 1;
        return new Promise<Response>(() => {});
      },
    });
    servers.push(hanging);

    const db = new KipDatabase();
    db.saveProvider({
      id: "local-mock",
      displayName: "Local Mock",
      protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:${hanging.port}/v1`,
      models: [
        {
          id: "mock-1",
          displayName: "Mock 1",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
    });
    const workspace = db.createWorkspace("ws", projectDir);
    const thread = db.createThread({
      id: "thr_storm_test",
      workspaceId: workspace.id,
      title: "Storm Test",
      sessionFilePath: "",
      modelProvider: "local-mock",
      modelId: "mock-1",
      thinkingLevel: "medium",
      mode: "chat",
    });
    await setApiKey("local-mock", "sk-test");
    const registry = await ModelRegistry.create(db);

    let restartCalls = 0;
    const wd = new GatewayWatchdog({
      label: "local-mock",
      busy: () => false,
      isProcessRunning: () => true,
      checkHealth: async () => true,
      restartProcess: async () => {
        restartCalls += 1;
      },
      log: () => {},
      maxRestarts: 2,
      windowMs: 60_000,
      backoffMs: [0, 0],
      probeIntervalMs: 0,
    });
    wd.markHealthy();

    const events: AgentStreamEvent[] = [];
    const orchestrator = new KipOrchestrator(
      db,
      registry,
      (_id, ev) => events.push(ev),
      {
        providerActivity: {
          requestPolicy: (pid) =>
            pid === "local-mock"
              ? { firstByteTimeoutMs: 250, streamIdleTimeoutMs: 250 }
              : null,
          beforeAttempt: async (pid, opts) => {
            if (pid !== "local-mock") return;
            const res = await wd.waitForReady(opts?.signal);
            if (res?.abortRetry) throw new Error(res.message);
            if (wd.getSnapshot().state === "degraded") {
              throw new Error("local-mock degraded");
            }
          },
          onFailure: (pid, failure, report) =>
            pid === "local-mock"
              ? wd.handleRequestFailure(failure, report)
              : undefined,
        },
      },
    );

    try {
      await orchestrator.sendPrompt({ threadId: thread.id, text: "hang" });
      await Bun.sleep(100);
    } finally {
      await orchestrator.shutdown();
      db.close();
      wd.dispose();
    }

    // With maxRestarts=2, attempts 1 & 2 trigger restarts, attempt 3 hits degraded
    // and aborts Pi's remaining retry budget (does NOT send 6 requests!).
    expect(restartCalls).toBe(2);
    expect(requestHits).toBe(3);
    const degraded = events.find(
      (e) => e.kind === "gateway_status" && e.phase === "degraded",
    );
    expect(degraded).toBeDefined();
    const turnErrors = events.filter((e) => e.kind === "turn_error");
    expect(turnErrors).toHaveLength(1);
    expect(
      turnErrors[0] && "message" in turnErrors[0] && turnErrors[0].message,
    ).toContain("automatic restarts");
  }, 20_000);

  test("never touches remote API providers or external user-run gemini2api servers", async () => {
    const dataDir = makeTempDir("kip-gw-remote-data-");
    const projectDir = makeTempDir("kip-gw-remote-proj-");
    process.env.KIP_DATA_DIR = dataDir;

    mkdirSync(join(dataDir, "agent"), { recursive: true });
    writeFileSync(
      join(dataDir, "agent", "settings.json"),
      JSON.stringify({
        httpIdleTimeoutMs: 350,
        retry: {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 50,
          provider: { maxRetries: 0 },
        },
      }),
    );

    // 1. Remote provider (no gateway plugin): zero gateway_status events, policy is null.
    const remoteServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: [] });
        }
        return new Promise<Response>(() => {});
      },
    });
    servers.push(remoteServer);

    const setup = new KipDatabase();
    setup.saveProvider({
      id: "openai-remote",
      displayName: "OpenAI Remote",
      protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:${remoteServer.port}/v1`,
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
    });
    expect(gatewayRequestPolicy(setup, "openai-remote")).toBeNull();
    expect(
      await onGatewayRequestFailure(setup, "openai-remote", {
        kind: "timeout",
        message: "Request timed out.",
        willRetry: true,
      }),
    ).toBeUndefined();
    setup.close();
    await setApiKey("openai-remote", "sk-remote");

    const events: AgentStreamEvent[] = [];
    const runtime = await CliRuntime.create({
      cwd: projectDir,
      ephemeral: true,
      continueLast: false,
      chat: true,
      onEvent: (_threadId, event) => events.push(event),
    });
    try {
      await runtime.orchestrator.sendPrompt({
        threadId: runtime.thread.id,
        text: "remote hang",
      });
      await Bun.sleep(100);
    } finally {
      await runtime.dispose();
    }

    expect(events.some((e) => e.kind === "gateway_status")).toBe(false);
    expect(events.some((e) => e.kind === "retry_start")).toBe(true);
    expect(events.some((e) => e.kind === "turn_error")).toBe(true);

    // 2. External user-run gemini2api server: Kip detects it as external and never restarts it.
    const extServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/health") {
          return Response.json({
            server: "gemini2api",
            version: "9.9.9",
            key_required: false,
            accounts: { firefox: { signed_in: true, status: "AVAILABLE" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(extServer);

    const extCtx = {
      pluginId: "gemini2api",
      dataDir: join(dataDir, "plugins", "gemini2api"),
      values: () => ({ host: "127.0.0.1", port: String(extServer.port) }),
    };
    await gemini2apiPlugin.beforeRequest?.(extCtx);
    try {
      expect(gemini2apiPlugin.requestPolicy?.(extCtx)).toBeNull();
      const failureRes = await gemini2apiPlugin.onRequestFailure?.(extCtx, {
        kind: "timeout",
        message: "Request timed out.",
        willRetry: true,
      });
      expect(failureRes).toEqual({ recovered: false });
    } finally {
      gemini2apiPlugin.afterRequest?.(extCtx);
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")(
    "exposes watchdog state in plugin window and supports manual restart action",
    async () => {
      const dataDir = makeTempDir("kip-gw-page-data-");
      const binDir = makeTempDir("kip-gw-page-bin-");
      process.env.KIP_DATA_DIR = dataDir;

      const port = freePort();
      const { binary, bootFile } = writeFaultySidecarBinary(
        binDir,
        "hang-then-ok",
      );
      const pluginDir = join(dataDir, "plugins", "gemini2api");
      saveCookies(pluginDir, {
        profile: "/tmp/firefox",
        cookies: { "__Secure-1PSID": "psid", "__Secure-1PSIDTS": "psidts" },
      });

      const controller = gemini2apiPlugin.page!({
        pluginId: "gemini2api",
        dataDir: pluginDir,
        values: () => ({
          host: "127.0.0.1",
          port: String(port),
          binaryPath: binary,
        }),
        emit: () => {},
      });

      try {
        await controller.act("start");
        const started = (await controller.state()) as GeminiPageState;
        expect(started.running).toBe(true);
        expect(started.health?.chats).toBe(2);
        expect(started.watchdog?.state).toBe("healthy");
        expect(readFileSync(bootFile, "utf8").trim()).toBe("1");

        await controller.act("restart");
        const restarted = (await controller.state()) as GeminiPageState;
        expect(restarted.running).toBe(true);
        expect(restarted.health?.chats).toBe(0);
        expect(restarted.watchdog?.state).toBe("healthy");
        expect(readFileSync(bootFile, "utf8").trim()).toBe("2");

        await controller.act("stop");
        const stopped = (await controller.state()) as GeminiPageState;
        expect(stopped.running).toBe(false);
        expect(stopped.watchdog?.state).toBe("stopped");
      } finally {
        await controller.dispose?.();
      }
    },
    20_000,
  );

  test("recovers from ConnectionRefused on a closed port and mid-stream stall via fake HTTP servers", async () => {
    const dataDir = makeTempDir("kip-gw-refused-data-");
    const projectDir = makeTempDir("kip-gw-refused-proj-");
    process.env.KIP_DATA_DIR = dataDir;

    mkdirSync(join(dataDir, "agent"), { recursive: true });
    writeFileSync(
      join(dataDir, "agent", "settings.json"),
      JSON.stringify({
        httpIdleTimeoutMs: 5_000,
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: 60,
          provider: { maxRetries: 0 },
        },
      }),
    );

    // Reserve a port, immediately close it so attempt #1 gets ECONNREFUSED;
    // when watchdog restarts, start a healthy HTTP server on that same port.
    const port = freePort();
    let stage: "refused" | "mid-stall" | "ok" = "refused";
    let activeServer: ReturnType<typeof Bun.serve> | null = null;

    const startServer = (mode: "mid-stall" | "ok") => {
      activeServer?.stop(true);
      activeServer = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(req) {
          if (new URL(req.url).pathname.endsWith("/models")) {
            return Response.json({ object: "list", data: [] });
          }
          if (mode === "mid-stall") {
            // Send SSE headers + first chunk, then hang silently forever.
            const stream = new ReadableStream({
              start(controller) {
                const chunk = JSON.stringify({
                  id: "c1",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "mock-1",
                  choices: [{ index: 0, delta: { role: "assistant", content: "partial..." }, finish_reason: null }],
                });
                controller.enqueue(new TextEncoder().encode(`data: ${chunk}\n\n`));
              },
            });
            return new Response(stream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          const c1 = JSON.stringify({
            id: "c2",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-1",
            choices: [{ index: 0, delta: { role: "assistant", content: "Healthy after recovery" }, finish_reason: null }],
          });
          const c2 = JSON.stringify({
            id: "c2",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          return new Response(`data: ${c1}\n\ndata: ${c2}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      servers.push(activeServer);
    };

    const db = new KipDatabase();
    db.saveProvider({
      id: "local-mock",
      displayName: "Local Mock",
      protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [
        {
          id: "mock-1",
          displayName: "Mock 1",
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
    });
    const workspace = db.createWorkspace("ws", projectDir);
    const thread = db.createThread({
      id: "thr_refused_test",
      workspaceId: workspace.id,
      title: "Refused Test",
      sessionFilePath: "",
      modelProvider: "local-mock",
      modelId: "mock-1",
      thinkingLevel: "medium",
      mode: "chat",
    });
    await setApiKey("local-mock", "sk-test");
    const registry = await ModelRegistry.create(db);

    let restartCount = 0;
    const wd = new GatewayWatchdog({
      label: "local-mock",
      busy: () => false,
      isProcessRunning: () => activeServer !== null,
      checkHealth: async () => activeServer !== null,
      restartProcess: async () => {
        restartCount += 1;
        if (stage === "refused") {
          stage = "mid-stall";
          startServer("mid-stall");
        } else {
          stage = "ok";
          startServer("ok");
        }
      },
      log: () => {},
      maxRestarts: 3,
      windowMs: 60_000,
      backoffMs: [0, 0, 0],
      probeIntervalMs: 0,
    });
    wd.markHealthy();

    const events: AgentStreamEvent[] = [];
    const orchestrator = new KipOrchestrator(
      db,
      registry,
      (_id, ev) => events.push(ev),
      {
        providerActivity: {
          requestPolicy: (pid) =>
            pid === "local-mock"
              ? { firstByteTimeoutMs: 1_000, streamIdleTimeoutMs: 250 }
              : null,
          beforeAttempt: async (pid, opts) => {
            if (pid !== "local-mock") return;
            await wd.waitForReady(opts?.signal);
          },
          onFailure: (pid, failure, report) =>
            pid === "local-mock"
              ? wd.handleRequestFailure(failure, report)
              : undefined,
          onSuccess: (pid) => {
            if (pid === "local-mock") wd.markHealthy();
          },
        },
      },
    );

    try {
      // Attempt 1: ConnectionRefused -> restart #1 brings up mid-stall server
      // Attempt 2: SSE headers + partial chunk, then 250ms stream idle stall -> restart #2 brings up healthy server
      // Attempt 3: succeeds cleanly!
      await orchestrator.sendPrompt({ threadId: thread.id, text: "recover twice" });
      await Bun.sleep(100);
    } finally {
      await orchestrator.shutdown();
      db.close();
      wd.dispose();
    }

    const text = events
      .filter((e): e is Extract<AgentStreamEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.delta)
      .join("");
    expect(restartCount).toBe(2);
    expect(text).toContain("Healthy after recovery");
    expect(events.filter((e) => e.kind === "turn_error")).toHaveLength(0);
    expect(events.find((e) => e.kind === "retry_end")).toMatchObject({
      success: true,
    });
  }, 20_000);

  test("registry hooks remain backward compatible for plugins that omit watchdog hooks", async () => {
    const dataDir = makeTempDir("kip-gw-compat-");
    process.env.KIP_DATA_DIR = dataDir;
    const db = new KipDatabase();

    const minimalPlugin: GatewayPlugin = {
      id: "legacy-gw",
      kind: "gateway",
      label: "Legacy",
      description: "Minimal gateway without watchdog hooks",
      providerId: "legacy-gw",
      fields: [],
      probe: async () => ({ ok: true }),
    };
    const registry = new PluginRegistry([minimalPlugin]);

    try {
      expect(gatewayRequestPolicy(db, "legacy-gw", registry)).toBeNull();
      await beforeGatewayAttempt(db, "legacy-gw", { registry });
      expect(
        await onGatewayRequestFailure(
          db,
          "legacy-gw",
          { kind: "timeout", message: "Request timed out.", willRetry: true },
          { registry },
        ),
      ).toBeUndefined();
      onGatewayRequestSuccess(db, "legacy-gw", registry);
      expect(existsSync(dataDir)).toBe(true);
    } finally {
      db.close();
    }
  });
});
