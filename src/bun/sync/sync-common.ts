/**
 * Shared incremental sync primitives used by both S3 and Google Drive sync.
 * Metadata, sessions, and custom provider definitions sync; API keys never
 * leave the machine.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { KipDatabase } from "../storage/db";
import { getSessionDir } from "../storage/db";

export interface SyncResult {
  pushed: number;
  pulled: number;
  syncedAt: number;
}

export interface Manifest {
  version: 1;
  deviceId: string;
  syncedAt: number;
  files: Record<string, { sha256: string; updatedAt: number }>;
}

export interface LocalSessionFile {
  key: string;
  workspaceId: string;
  fileName: string;
  path: string;
  content: Buffer;
  updatedAt: number;
}

export function settingKey(key: string): string {
  return `sync.${key}`;
}

export function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function localSessionFiles(database: KipDatabase): LocalSessionFile[] {
  const files: LocalSessionFile[] = [];
  for (const workspace of database.listWorkspaces()) {
    for (const thread of database.listThreads(workspace.id)) {
      if (!thread.sessionFilePath || !existsSync(thread.sessionFilePath))
        continue;
      try {
        const content = readFileSync(thread.sessionFilePath);
        const fileName = basename(thread.sessionFilePath);
        files.push({
          key: `sessions/${workspace.id}/${fileName}`,
          workspaceId: workspace.id,
          fileName,
          path: thread.sessionFilePath,
          content,
          updatedAt: thread.updatedAt,
        });
      } catch {
        // Skip unreadable session files without breaking the whole sync.
      }
    }
  }
  return files;
}

export function metadataSnapshot(database: KipDatabase): string {
  return JSON.stringify({
    workspaces: database.listWorkspaces(),
    threads: database.db.query("SELECT * FROM threads").all(),
    providers: database.listProviders(),
    settings: {
      theme: database.getSetting("theme", "system"),
      approvalPolicy: database.getSetting("approvalPolicy", "read-only-auto"),
      defaultProvider: database.getSetting("defaultProvider", ""),
      defaultModelId: database.getSetting("defaultModelId", ""),
      defaultThinkingLevel: database.getSetting(
        "defaultThinkingLevel",
        "medium",
      ),
      sidebarCollapsed: database.getSetting("sidebarCollapsed", false),
    },
    exportedAt: Date.now(),
  });
}

export function mergeSnapshot(
  database: KipDatabase,
  snapshot: {
    workspaces?: unknown[];
    threads?: unknown[];
  },
): number {
  let merged = 0;
  const workspaceMap = new Map<string, string>();
  for (const raw of snapshot.workspaces ?? []) {
    const workspace = raw as { id?: string; name?: string; rootPath?: string };
    if (!workspace.name || !workspace.rootPath) continue;
    if (!existsSync(workspace.rootPath)) continue;
    const stored = database.upsertWorkspace(
      workspace.id ?? crypto.randomUUID(),
      workspace.name,
      workspace.rootPath,
    );
    if (workspace.id) workspaceMap.set(workspace.id, stored.id);
  }
  for (const raw of snapshot.threads ?? []) {
    const row = raw as {
      id?: string;
      workspace_id?: string;
      title?: string;
      session_file_path?: string;
      model_provider?: string;
      model_id?: string;
      thinking_level?: string;
      approval_policy?: string | null;
      updated_at?: number;
    };
    if (!row.id || !row.workspace_id || !row.title) continue;
    const mappedId = workspaceMap.get(row.workspace_id);
    const workspace = mappedId
      ? database.getWorkspace(mappedId)
      : database.getWorkspace(row.workspace_id);
    if (!workspace) continue;
    if (database.getThread(row.id)) continue;
    if (!row.session_file_path) continue;
    const directory = getSessionDir(workspace.id);
    mkdirSync(directory, { recursive: true });
    const target = join(directory, basename(row.session_file_path));
    if (!existsSync(target)) continue;
    database.createThread({
      id: row.id,
      workspaceId: workspace.id,
      title: row.title,
      sessionFilePath: target,
      modelProvider: row.model_provider ?? "",
      modelId: row.model_id ?? "",
      thinkingLevel: (row.thinking_level ?? "medium") as never,
      approvalPolicy: (row.approval_policy ?? null) as never,
    });
    merged += 1;
  }
  return merged;
}
