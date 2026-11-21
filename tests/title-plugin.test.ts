import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KipDatabase } from "../src/bun/storage/db";
import {
  generateTitleWithPlugins,
  getOrCreatePluginDeviceId,
  isPluginEnabled,
  PluginRegistry,
  savePluginValues,
  setPluginEnabled,
} from "../src/bun/plugins/registry";
import { warrenTitlePlugin } from "../src/bun/plugins/warren-title";

function fakeTitleServer(options: {
  service?: string;
  status?: number;
  title?: string;
} = {}) {
  const requests: Array<{ deviceId: string | null; app: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: options.service ?? "warren-title",
          model: "@cf/qwen/qwen3-30b-a3b-fp8",
          limits: { deviceDaily: 50, ipDaily: 300 },
        });
      }
      if (url.pathname === "/v1/title" && request.method === "POST") {
        requests.push({
          deviceId: request.headers.get("x-device-id"),
          app: request.headers.get("x-app"),
          body: await request.json(),
        });
        if (options.status && options.status !== 200) {
          return Response.json({ error: "rate limited" }, { status: options.status });
        }
        return Response.json({
          title: options.title ?? "Implement plugins tab",
          quota: { limit: 50, remaining: 49, resetAt: "2026-11-22T00:00:00.000Z" },
        });
      }
      return new Response("{}", { status: 404 });
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, requests };
}

describe("warren-title plugin", () => {
  test("probe verifies warren-title health metadata", async () => {
    const mock = fakeTitleServer();
    try {
      const ok = await warrenTitlePlugin.probe({ endpoint: mock.baseUrl }, {});
      expect(ok.ok).toBe(true);
      expect(ok.summary).toContain("50 titles/day");
      expect(ok.details?.some((d) => d.label === "Model")).toBe(true);
    } finally {
      mock.server.stop(true);
    }
  });

  test("probe rejects unrelated services", async () => {
    const mock = fakeTitleServer({ service: "other-service" });
    try {
      const res = await warrenTitlePlugin.probe({ endpoint: mock.baseUrl }, {});
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not a Warren Title Service");
    } finally {
      mock.server.stop(true);
    }
  });

  test("generateTitle sends X-Device-Id and X-App and falls back cleanly on 429", async () => {
    const okMock = fakeTitleServer({ title: "修复侧边栏标题" });
    try {
      const title = await warrenTitlePlugin.generateTitle(
        {
          mode: "initial",
          messages: [
            { role: "user", content: "修复侧边栏标题显示" },
            { role: "assistant", content: "正在检查 Sidebar.tsx" },
          ],
        },
        { endpoint: okMock.baseUrl },
        { deviceId: "kip-device-1234" },
      );
      expect(title).toBe("修复侧边栏标题");
      expect(okMock.requests[0]?.deviceId).toBe("kip-device-1234");
      expect(okMock.requests[0]?.app).toBe("kip");
    } finally {
      okMock.server.stop(true);
    }

    const limitedMock = fakeTitleServer({ status: 429 });
    try {
      const title = await warrenTitlePlugin.generateTitle(
        { mode: "initial", messages: [{ role: "user", content: "Hello" }] },
        { endpoint: limitedMock.baseUrl },
        { deviceId: "kip-device-1234" },
      );
      expect(title).toBeNull();
    } finally {
      limitedMock.server.stop(true);
    }
  });

  test("registry keeps title plugin disabled by default and persists toggle & device ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kip-title-plugin-"));
    const db = new KipDatabase(join(dir, "kip.sqlite"));
    const mock = fakeTitleServer({ title: "Add plugins page" });
    const registry = new PluginRegistry([warrenTitlePlugin]);
    try {
      expect(isPluginEnabled(db, warrenTitlePlugin)).toBe(false);
      savePluginValues(db, warrenTitlePlugin, { endpoint: mock.baseUrl });

      // Disabled plugin makes no network call.
      const skipped = await generateTitleWithPlugins(
        db,
        { mode: "initial", messages: [{ role: "user", content: "Add a plugins page" }] },
        registry,
      );
      expect(skipped).toBeNull();
      expect(mock.requests).toHaveLength(0);

      // Enabling persists and generates a stable device ID.
      setPluginEnabled(db, warrenTitlePlugin, true);
      expect(isPluginEnabled(db, warrenTitlePlugin)).toBe(true);
      const id1 = getOrCreatePluginDeviceId(db, warrenTitlePlugin);
      const id2 = getOrCreatePluginDeviceId(db, warrenTitlePlugin);
      expect(id1).toBe(id2);

      const generated = await generateTitleWithPlugins(
        db,
        { mode: "initial", messages: [{ role: "user", content: "Add a plugins page" }] },
        registry,
      );
      expect(generated).toBe("Add plugins page");
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.deviceId).toBe(id1);
    } finally {
      mock.server.stop(true);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
