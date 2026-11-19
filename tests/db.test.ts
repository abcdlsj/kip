import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KipDatabase } from "../src/bun/storage/db";

let dir = "";
let db: KipDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-db-"));
  process.env.KIP_DATA_DIR = dir;
  db = new KipDatabase();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("KipDatabase", () => {
  test("creates a scratchpad workspace and default settings", () => {
    const workspaces = db.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.name).toBe("Scratchpad");
    expect(existsSync(join(dir, "scratchpad"))).toBe(true);
    expect(db.getSetting("approvalPolicy", "")).toBe("read-only-auto");
    expect(db.getSetting("theme", "")).toBe("system");
  });

  test("creates, updates, and removes workspaces", () => {
    const workspace = db.createWorkspace("Demo", join(dir, "demo"));
    expect(db.getWorkspace(workspace.id)?.name).toBe("Demo");
    db.setSetting("defaultProvider", "demo-provider");
    expect(db.getSetting("defaultProvider", "")).toBe("demo-provider");
    db.removeWorkspace(workspace.id);
    expect(db.getWorkspace(workspace.id)).toBeNull();
  });

  test("persists thread metadata with thinking level", () => {
    const workspace = db.listWorkspaces()[0]!;
    const thread = db.createThread({
      id: "th_test",
      workspaceId: workspace.id,
      title: "New Thread",
      sessionFilePath: join(dir, "th_test.jsonl"),
      modelProvider: "p",
      modelId: "m",
      thinkingLevel: "high",
    });
    expect(thread.thinkingLevel).toBe("high");
    expect(thread.approvalPolicy).toBeNull();
    db.updateThread("th_test", { title: "Refactor parser", approvalPolicy: "full-auto" });
    expect(db.getThread("th_test")?.title).toBe("Refactor parser");
    expect(db.getThread("th_test")?.approvalPolicy).toBe("full-auto");
    db.updateThread("th_test", { approvalPolicy: null });
    expect(db.getThread("th_test")?.approvalPolicy).toBeNull();
    expect(db.listThreads(workspace.id)).toHaveLength(1);
    db.deleteThread("th_test");
    expect(db.getThread("th_test")).toBeNull();
  });

  test("stores provider definitions without credentials", () => {
    const provider = db.saveProvider({
      id: "local",
      displayName: "Local",
      protocol: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      models: [
        {
          id: "llama",
          displayName: "Llama",
          contextWindow: 8192,
          maxOutputTokens: 2048,
          supportsVision: false,
          supportsReasoning: false,
        },
      ],
    });
    expect(provider.models[0]?.id).toBe("llama");
    expect(db.getProvider("local")?.protocol).toBe("openai-completions");
    db.deleteProvider("local");
    expect(db.getProvider("local")).toBeNull();
  });
});
