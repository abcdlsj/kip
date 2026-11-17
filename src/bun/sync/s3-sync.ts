/**
 * Incremental S3-compatible backup using Bun's native S3 client. Metadata,
 * sessions, and custom provider definitions sync; API keys never leave the
 * machine.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SyncConfig } from "../../shared/types";
import type { KipDatabase } from "../storage/db";
import { getSessionDir } from "../storage/db";
import { getApiKey, setApiKey } from "../storage/keychain";

const ACCESS_KEY_ID = "s3.access-key-id";
const SECRET_ACCESS_KEY = "s3.secret-access-key";

export interface SyncResult {
  pushed: number;
  pulled: number;
  syncedAt: number;
}

interface Manifest {
  version: 1;
  deviceId: string;
  syncedAt: number;
  files: Record<string, { sha256: string; updatedAt: number }>;
}

function settingKey(key: string): string {
  return `sync.${key}`;
}

export async function getSyncConfig(database: KipDatabase): Promise<SyncConfig> {
  return {
    enabled: database.getSetting(settingKey("enabled"), false),
    endpoint: database.getSetting(settingKey("endpoint"), ""),
    region: database.getSetting(settingKey("region"), "auto"),
    bucket: database.getSetting(settingKey("bucket"), ""),
    prefix: database.getSetting(settingKey("prefix"), "kip-sync/"),
    hasCredentials: (await getApiKey(ACCESS_KEY_ID)) !== null,
    lastSyncedAt: database.getSetting(settingKey("lastSyncedAt"), null),
  };
}

export async function updateSyncConfig(
  database: KipDatabase,
  input: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  },
): Promise<{ connected: boolean; error?: string }> {
  database.setSetting(settingKey("enabled"), input.enabled);
  database.setSetting(settingKey("endpoint"), input.endpoint);
  database.setSetting(settingKey("region"), input.region);
  database.setSetting(settingKey("bucket"), input.bucket);
  database.setSetting(settingKey("prefix"), normalizePrefix(input.prefix));
  if (input.accessKeyId) await setApiKey(ACCESS_KEY_ID, input.accessKeyId);
  if (input.secretAccessKey) await setApiKey(SECRET_ACCESS_KEY, input.secretAccessKey);
  if (!input.endpoint || !input.bucket) return { connected: false, error: "Endpoint and bucket are required" };
  try {
    const client = await createClient(database);
    await client.write(`${normalizePrefix(input.prefix)}.kip-probe`, String(Date.now()));
    return { connected: true };
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  if (!trimmed) return "kip-sync/";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

async function createClient(database: KipDatabase) {
  const endpoint = database.getSetting(settingKey("endpoint"), "");
  const region = database.getSetting(settingKey("region"), "auto");
  const bucket = database.getSetting(settingKey("bucket"), "");
  const accessKeyId = await getApiKey(ACCESS_KEY_ID);
  const secretAccessKey = await getApiKey(SECRET_ACCESS_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Sync is not configured");
  }
  return new Bun.S3Client({ endpoint, region, bucket, accessKeyId, secretAccessKey });
}

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function localSessionFiles(database: KipDatabase): Array<{
  key: string;
  path: string;
  content: Buffer;
  updatedAt: number;
}> {
  const files: Array<{ key: string; path: string; content: Buffer; updatedAt: number }> = [];
  for (const workspace of database.listWorkspaces()) {
    for (const thread of database.listThreads(workspace.id)) {
      if (!thread.sessionFilePath || !existsSync(thread.sessionFilePath)) continue;
      try {
        const content = readFileSync(thread.sessionFilePath);
        files.push({
          key: `sessions/${workspace.id}/${basename(thread.sessionFilePath)}`,
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

function metadataSnapshot(database: KipDatabase): string {
  return JSON.stringify({
    workspaces: database.listWorkspaces(),
    threads: database.db.query("SELECT * FROM threads").all(),
    providers: database.listProviders(),
    settings: {
      theme: database.getSetting("theme", "system"),
      approvalPolicy: database.getSetting("approvalPolicy", "read-only-auto"),
      defaultProvider: database.getSetting("defaultProvider", ""),
      defaultModelId: database.getSetting("defaultModelId", ""),
      defaultThinkingLevel: database.getSetting("defaultThinkingLevel", "medium"),
      sidebarCollapsed: database.getSetting("sidebarCollapsed", false),
    },
    exportedAt: Date.now(),
  });
}

export async function triggerS3Sync(database: KipDatabase): Promise<SyncResult> {
  const client = await createClient(database);
  const prefix = normalizePrefix(database.getSetting(settingKey("prefix"), "kip-sync/"));
  const manifestKey = `${prefix}manifest.json`;
  let remote: Manifest | null = null;
  try {
    const text = await client.file(manifestKey).text();
    remote = JSON.parse(text) as Manifest;
  } catch {
    remote = null;
  }

  const manifest: Manifest = remote ?? {
    version: 1,
    deviceId: crypto.randomUUID(),
    syncedAt: 0,
    files: {},
  };
  let pushed = 0;
  const locals = localSessionFiles(database);
  for (const file of locals) {
    const digest = hash(file.content);
    if (manifest.files[file.key]?.sha256 === digest) continue;
    await client.write(`${prefix}${file.key}`, file.content);
    manifest.files[file.key] = { sha256: digest, updatedAt: file.updatedAt };
    pushed += 1;
  }

  const snapshot = metadataSnapshot(database);
  const snapshotKey = `${prefix}metadata/snapshot.json`;
  if (manifest.files[snapshotKey]?.sha256 !== hash(snapshot)) {
    await client.write(snapshotKey, snapshot);
    manifest.files[snapshotKey] = { sha256: hash(snapshot), updatedAt: Date.now() };
    pushed += 1;
  }

  let pulled = 0;
  try {
    const list = await client.list({ prefix: `${prefix}sessions/`, maxKeys: 1000 });
    for (const object of list.contents ?? []) {
      if (!object.key) continue;
      const relativeKey = object.key.slice(prefix.length);
      const workspaceId = relativeKey.split("/")[1];
      if (!workspaceId) continue;
      const thread = database.listThreads(workspaceId).find(
        (item) => basename(item.sessionFilePath) === basename(object.key ?? ""),
      );
      const targetDir = getSessionDir(workspaceId);
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, basename(object.key));
      const remoteEntry = manifest.files[relativeKey];
      const localExists = existsSync(target);
      const remoteNewer = remoteEntry ? remoteEntry.updatedAt > (thread?.updatedAt ?? 0) : false;
      if (localExists && !remoteNewer) continue;
      const body = await client.file(object.key).arrayBuffer();
      await Bun.write(target, body);
      if (localExists) continue;
      if (!thread) continue;
      database.updateThread(thread.id, { sessionFilePath: target });
      pulled += 1;
    }
  } catch {
    // A missing sessions prefix simply means there is nothing to pull yet.
  }

  if (manifest.files[snapshotKey]?.sha256 === hash(snapshot)) {
    try {
      const remoteSnapshot = JSON.parse(
        await client.file(snapshotKey).text(),
      ) as { workspaces?: unknown[]; threads?: unknown[] };
      pulled += mergeSnapshot(database, remoteSnapshot);
    } catch {
      // Metadata merge is opportunistic; session recovery remains authoritative.
    }
  }

  manifest.syncedAt = Date.now();
  await client.write(manifestKey, JSON.stringify(manifest, null, 2));
  database.setSetting(settingKey("lastSyncedAt"), manifest.syncedAt);
  return { pushed, pulled, syncedAt: manifest.syncedAt };
}

function mergeSnapshot(
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
      updated_at?: number;
    };
    if (!row.id || !row.workspace_id || !row.title) continue;
    const mappedId = workspaceMap.get(row.workspace_id);
    const workspace = mappedId ? database.getWorkspace(mappedId) : database.getWorkspace(row.workspace_id);
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
    });
    merged += 1;
  }
  return merged;
}

export function countLocalSessions(): number {
  const root = join(process.env.KIP_DATA_DIR ?? `${Bun.env.HOME}/.kip`, "sessions");
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace);
    try {
      if (statSync(dir).isDirectory()) count += readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
    } catch {
      // Ignore directories that disappear during the scan.
    }
  }
  return count;
}
