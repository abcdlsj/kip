/**
 * Local metadata store. Kip keeps mutable metadata in SQLite under ~/.kip and
 * leaves transcripts to Pi's JSONL session files.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalPolicy,
  FileChange,
  ProviderModel,
  ProviderProtocol,
  ProviderRecord,
  ThemeMode,
  ThinkingLevel,
  ThreadMode,
  ThreadSummary,
  Workspace,
} from "../../shared/types";

const DEFAULT_SETTINGS: Record<string, unknown> = {
  theme: "system",
  approvalPolicy: "read-only-auto",
  defaultProvider: "",
  defaultModelId: "",
  defaultThinkingLevel: "medium",
  sidebarCollapsed: false,
  cliTuiLayout: "inline",
};

interface WorkspaceRow {
  id: string;
  name: string;
  root_path: string;
  last_opened_at: number;
}

interface ThreadRow {
  id: string;
  workspace_id: string;
  title: string;
  session_file_path: string;
  model_provider: string;
  model_id: string;
  thinking_level: ThinkingLevel;
  mode: ThreadMode;
  approval_policy: ApprovalPolicy | null;
  updated_at: number;
}

interface RunChangesRow {
  id: string;
  thread_id: string;
  before_tree: string;
  after_tree: string;
  files_json: string;
  reverted: number;
  created_at: number;
}

export interface StoredRunChanges {
  id: string;
  threadId: string;
  beforeTree: string;
  afterTree: string;
  files: FileChange[];
  createdAt: number;
}

function toStoredRunChanges(row: RunChangesRow): StoredRunChanges {
  let files: FileChange[] = [];
  try {
    const parsed = JSON.parse(row.files_json) as unknown;
    if (Array.isArray(parsed)) files = parsed as FileChange[];
  } catch {
    files = [];
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    beforeTree: row.before_tree,
    afterTree: row.after_tree,
    files,
    createdAt: row.created_at,
  };
}

interface ProviderRow {
  id: string;
  display_name: string;
  base_url: string;
  api_protocol: ProviderProtocol;
  models_json: string;
}

export function getDataDir(): string {
  return process.env.KIP_DATA_DIR ?? join(homedir(), ".kip");
}

export function getSessionDir(workspaceId: string): string {
  return join(getDataDir(), "sessions", workspaceId);
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "sessions"), { recursive: true, mode: 0o700 });
  return dir;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export class KipDatabase {
  readonly db: Database;

  constructor(path = join(ensureDataDir(), "kip.sqlite")) {
    this.db = new Database(path, { create: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        last_opened_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        session_file_path TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        thinking_level TEXT NOT NULL DEFAULT 'medium',
        mode TEXT NOT NULL DEFAULT 'agent',
        approval_policy TEXT DEFAULT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated
        ON threads(workspace_id, is_archived, updated_at DESC);

      CREATE TABLE IF NOT EXISTS kv_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_providers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_protocol TEXT NOT NULL DEFAULT 'openai-completions',
        models_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_changes (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        before_tree TEXT NOT NULL,
        after_tree TEXT NOT NULL,
        files_json TEXT NOT NULL,
        reverted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_run_changes_thread
        ON run_changes(thread_id, reverted, created_at DESC);
    `);
    this.ensureMigrations();
    this.seedSettings();
    this.ensureScratchpad();
  }

  private ensureMigrations(): void {
    const columns = this.db
      .query<{ name: string }, []>("PRAGMA table_info(threads)")
      .all()
      .map((col) => col.name);
    if (!columns.includes("approval_policy")) {
      this.db.exec(
        "ALTER TABLE threads ADD COLUMN approval_policy TEXT DEFAULT NULL",
      );
    }
    // Threads predate Chat mode; every existing one is an agent thread.
    if (!columns.includes("mode")) {
      this.db.exec(
        "ALTER TABLE threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'agent'",
      );
    }

    // Earlier builds hardcoded supportsVision: false everywhere with no UI toggle.
    // Backfill existing provider models once so vision works out of the box while
    // respecting any explicit false saved afterwards.
    const migratedVision = this.db
      .query<{ value_json: string }, [string]>(
        "SELECT value_json FROM kv_settings WHERE key = ?",
      )
      .get("migration.defaultVisionV1");
    if (!migratedVision) {
      const rows = this.db
        .query<{ id: string; models_json: string }, []>(
          "SELECT id, models_json FROM custom_providers",
        )
        .all();
      const update = this.db.prepare(
        "UPDATE custom_providers SET models_json = ? WHERE id = ?",
      );
      for (const row of rows) {
        const models = this.parseModels(row.models_json);
        let changed = false;
        const next = models.map((model) => {
          if (model.supportsVision === false) {
            changed = true;
            return { ...model, supportsVision: true };
          }
          return model;
        });
        if (changed) {
          update.run(JSON.stringify(next), row.id);
        }
      }
      this.db
        .prepare(
          "INSERT OR REPLACE INTO kv_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("migration.defaultVisionV1", JSON.stringify(true), Date.now());
    }
  }

  private seedSettings(): void {
    const now = Date.now();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO kv_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
    );
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insert.run(key, JSON.stringify(value), now);
    }
  }

  private ensureScratchpad(): void {
    const row = this.db.query("SELECT id FROM workspaces LIMIT 1").get();
    if (row) return;
    const root = join(getDataDir(), "scratchpad");
    mkdirSync(root, { recursive: true });
    this.createWorkspace("Scratchpad", root);
  }

  close(): void {
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best-effort flush before closing.
    }
    this.db.close();
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .query<{ value_json: string }, [string]>(
        "SELECT value_json FROM kv_settings WHERE key = ?",
      )
      .get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO kv_settings (key, value_json, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .query<WorkspaceRow, []>(
        "SELECT * FROM workspaces ORDER BY last_opened_at DESC",
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      gitBranch: null,
      dirtyFiles: 0,
      lastOpenedAt: row.last_opened_at,
    }));
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?")
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      gitBranch: null,
      dirtyFiles: 0,
      lastOpenedAt: row.last_opened_at,
    };
  }

  findWorkspaceByPath(rootPath: string): Workspace | null {
    const row = this.db
      .query<WorkspaceRow, [string]>(
        "SELECT * FROM workspaces WHERE root_path = ?",
      )
      .get(rootPath);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      gitBranch: null,
      dirtyFiles: 0,
      lastOpenedAt: row.last_opened_at,
    };
  }

  upsertWorkspace(
    id: string,
    name: string,
    rootPath: string,
    lastOpenedAt = Date.now(),
  ): Workspace {
    const existing = this.findWorkspaceByPath(rootPath);
    if (existing) return existing;
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path",
      )
      .run(id, name, rootPath, lastOpenedAt, now);
    return {
      id,
      name,
      rootPath,
      gitBranch: null,
      dirtyFiles: 0,
      lastOpenedAt,
    };
  }

  createWorkspace(name: string, rootPath: string): Workspace {
    const now = Date.now();
    const id = newId("ws");
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, name, rootPath, now, now);
    return {
      id,
      name,
      rootPath,
      gitBranch: null,
      dirtyFiles: 0,
      lastOpenedAt: now,
    };
  }

  touchWorkspace(id: string): void {
    this.db
      .prepare("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  removeWorkspace(id: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  listThreads(workspaceId: string): ThreadSummary[] {
    const rows = this.db
      .query<ThreadRow, [string]>(
        "SELECT * FROM threads WHERE workspace_id = ? AND is_archived = 0 ORDER BY updated_at DESC",
      )
      .all(workspaceId);
    return rows.map((row) => this.toThreadSummary(row));
  }

  getThread(id: string): ThreadSummary | null {
    const row = this.db
      .query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?")
      .get(id);
    return row ? this.toThreadSummary(row) : null;
  }

  createThread(input: {
    id: string;
    workspaceId: string;
    title: string;
    sessionFilePath: string;
    modelProvider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    mode?: ThreadMode;
    approvalPolicy?: ApprovalPolicy | null;
  }): ThreadSummary {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO threads (id, workspace_id, title, session_file_path, model_provider, model_id, thinking_level, mode, approval_policy, updated_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.id,
        input.workspaceId,
        input.title,
        input.sessionFilePath,
        input.modelProvider,
        input.modelId,
        input.thinkingLevel,
        input.mode ?? "agent",
        input.approvalPolicy ?? null,
        now,
        now,
      );
    const thread = this.getThread(input.id);
    if (!thread) throw new Error("Failed to persist thread");
    return thread;
  }

  updateThread(
    id: string,
    patch: Partial<{
      title: string;
      modelProvider: string;
      modelId: string;
      thinkingLevel: ThinkingLevel;
      mode: ThreadMode;
      approvalPolicy: ApprovalPolicy | null;
      sessionFilePath: string;
    }>,
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.modelProvider !== undefined) {
      sets.push("model_provider = ?");
      values.push(patch.modelProvider);
    }
    if (patch.modelId !== undefined) {
      sets.push("model_id = ?");
      values.push(patch.modelId);
    }
    if (patch.thinkingLevel !== undefined) {
      sets.push("thinking_level = ?");
      values.push(patch.thinkingLevel);
    }
    if (patch.mode !== undefined) {
      sets.push("mode = ?");
      values.push(patch.mode);
    }
    if (patch.approvalPolicy !== undefined) {
      sets.push("approval_policy = ?");
      values.push(patch.approvalPolicy);
    }
    if (patch.sessionFilePath !== undefined) {
      sets.push("session_file_path = ?");
      values.push(patch.sessionFilePath);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    this.db
      .prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  touchThread(id: string): void {
    this.db
      .prepare("UPDATE threads SET updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  deleteThread(id: string): void {
    this.db.prepare("DELETE FROM run_changes WHERE thread_id = ?").run(id);
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  addRunChanges(input: StoredRunChanges): void {
    this.db
      .prepare(
        "INSERT INTO run_changes (id, thread_id, before_tree, after_tree, files_json, reverted, created_at) " +
          "VALUES (?, ?, ?, ?, ?, 0, ?)",
      )
      .run(
        input.id,
        input.threadId,
        input.beforeTree,
        input.afterTree,
        JSON.stringify(input.files),
        input.createdAt,
      );
  }

  /** The newest run in a thread whose changes have not been undone. */
  latestRunChanges(threadId: string): StoredRunChanges | null {
    const row = this.db
      .query<RunChangesRow, [string]>(
        "SELECT * FROM run_changes WHERE thread_id = ? AND reverted = 0 ORDER BY created_at DESC LIMIT 1",
      )
      .get(threadId);
    return row ? toStoredRunChanges(row) : null;
  }

  getRunChanges(id: string): StoredRunChanges | null {
    const row = this.db
      .query<RunChangesRow, [string]>("SELECT * FROM run_changes WHERE id = ?")
      .get(id);
    return row ? toStoredRunChanges(row) : null;
  }

  markRunReverted(id: string): void {
    this.db.prepare("UPDATE run_changes SET reverted = 1 WHERE id = ?").run(id);
  }

  listProviders(): ProviderRecord[] {
    const rows = this.db
      .query<ProviderRow, []>(
        "SELECT * FROM custom_providers ORDER BY created_at ASC",
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      protocol: row.api_protocol,
      baseUrl: row.base_url,
      hasApiKey: false,
      models: this.parseModels(row.models_json),
    }));
  }

  getProvider(id: string): ProviderRecord | null {
    const row = this.db
      .query<ProviderRow, [string]>(
        "SELECT * FROM custom_providers WHERE id = ?",
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      protocol: row.api_protocol,
      baseUrl: row.base_url,
      hasApiKey: false,
      models: this.parseModels(row.models_json),
    };
  }

  saveProvider(input: {
    id: string;
    displayName: string;
    protocol: ProviderProtocol;
    baseUrl: string;
    models: ProviderModel[];
  }): ProviderRecord {
    this.db
      .prepare(
        "INSERT INTO custom_providers (id, display_name, base_url, api_protocol, models_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, base_url = excluded.base_url, " +
          "api_protocol = excluded.api_protocol, models_json = excluded.models_json",
      )
      .run(
        input.id,
        input.displayName,
        input.baseUrl,
        input.protocol,
        JSON.stringify(input.models),
        Date.now(),
      );
    const provider = this.getProvider(input.id);
    if (!provider) throw new Error("Failed to persist provider");
    return provider;
  }

  deleteProvider(id: string): void {
    this.db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id);
  }

  private parseModels(json: string): ProviderModel[] {
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? (parsed as ProviderModel[]) : [];
    } catch {
      return [];
    }
  }

  private toThreadSummary(row: ThreadRow): ThreadSummary {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      sessionFilePath: row.session_file_path,
      modelProvider: row.model_provider,
      modelId: row.model_id,
      thinkingLevel: row.thinking_level,
      mode: row.mode === "chat" ? "chat" : "agent",
      approvalPolicy: row.approval_policy ?? null,
      updatedAt: row.updated_at,
      isRunning: false,
    };
  }
}

export type { ApprovalPolicy, ThemeMode };
