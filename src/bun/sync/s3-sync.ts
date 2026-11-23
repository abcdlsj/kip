/**
 * Incremental S3-compatible backup using Bun's native S3 client, plus unified
 * sync configuration and dispatch across S3 and Google Drive. Metadata,
 * sessions, and custom provider definitions sync; API keys never leave the
 * machine.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SyncConfig, SyncProvider } from "../../shared/types";
import type { KipDatabase } from "../storage/db";
import { getDataDir, getSessionDir } from "../storage/db";
import { getApiKey, setApiKey } from "../storage/keychain";
import {
  getGoogleDriveSettings,
  isGoogleDriveConnected,
  saveGoogleDriveSettings,
  testGoogleDriveConnection,
  triggerGoogleDriveSync,
} from "./gdrive-sync";
import {
  hash,
  localSessionFiles,
  mergeSnapshot,
  metadataSnapshot,
  settingKey,
  type Manifest,
  type SyncResult,
} from "./sync-common";

export type { SyncResult };

const ACCESS_KEY_ID = "s3.access-key-id";
const SECRET_ACCESS_KEY = "s3.secret-access-key";

export async function getSyncConfig(
  database: KipDatabase,
): Promise<SyncConfig> {
  const gdrive = getGoogleDriveSettings(database);
  return {
    provider: database.getSetting<SyncProvider>(settingKey("provider"), "s3"),
    enabled: database.getSetting(settingKey("enabled"), false),
    endpoint: database.getSetting(settingKey("endpoint"), ""),
    region: database.getSetting(settingKey("region"), "auto"),
    bucket: database.getSetting(settingKey("bucket"), ""),
    prefix: database.getSetting(settingKey("prefix"), "kip-sync/"),
    hasCredentials: (await getApiKey(ACCESS_KEY_ID)) !== null,
    googleClientId: gdrive.clientId,
    googleFolderName: gdrive.folderName,
    googleConnected: await isGoogleDriveConnected(),
    googleEmail: gdrive.email,
    lastSyncedAt: database.getSetting(settingKey("lastSyncedAt"), null),
  };
}

export async function updateSyncConfig(
  database: KipDatabase,
  input: {
    provider?: SyncProvider;
    enabled: boolean;
    endpoint?: string;
    region?: string;
    bucket?: string;
    prefix?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    googleFolderName?: string;
  },
): Promise<{ connected: boolean; error?: string }> {
  const provider: SyncProvider =
    input.provider ??
    database.getSetting<SyncProvider>(settingKey("provider"), "s3");
  database.setSetting(settingKey("provider"), provider);
  database.setSetting(settingKey("enabled"), input.enabled);

  if (provider === "google-drive") {
    await saveGoogleDriveSettings(database, {
      clientId: input.googleClientId,
      clientSecret: input.googleClientSecret,
      folderName: input.googleFolderName,
    });
    if (!(await isGoogleDriveConnected())) {
      return {
        connected: false,
        error: "Sign in with Google to connect Google Drive",
      };
    }
    return testGoogleDriveConnection(database);
  }

  const endpoint =
    input.endpoint ?? database.getSetting(settingKey("endpoint"), "");
  const region =
    input.region ?? database.getSetting(settingKey("region"), "auto");
  const bucket = input.bucket ?? database.getSetting(settingKey("bucket"), "");
  const prefix = normalizePrefix(
    input.prefix ?? database.getSetting(settingKey("prefix"), "kip-sync/"),
  );
  database.setSetting(settingKey("endpoint"), endpoint);
  database.setSetting(settingKey("region"), region);
  database.setSetting(settingKey("bucket"), bucket);
  database.setSetting(settingKey("prefix"), prefix);
  if (input.accessKeyId) await setApiKey(ACCESS_KEY_ID, input.accessKeyId);
  if (input.secretAccessKey)
    await setApiKey(SECRET_ACCESS_KEY, input.secretAccessKey);
  if (!endpoint || !bucket)
    return { connected: false, error: "Endpoint and bucket are required" };
  try {
    const client = await createClient(database);
    await client.write(`${prefix}.kip-probe`, String(Date.now()));
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

export async function triggerSync(database: KipDatabase): Promise<SyncResult> {
  const provider = database.getSetting<SyncProvider>(
    settingKey("provider"),
    "s3",
  );
  if (provider === "google-drive") {
    return triggerGoogleDriveSync(database);
  }
  return triggerS3Sync(database);
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
  return new Bun.S3Client({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
}

export async function triggerS3Sync(
  database: KipDatabase,
): Promise<SyncResult> {
  const client = await createClient(database);
  const prefix = normalizePrefix(
    database.getSetting(settingKey("prefix"), "kip-sync/"),
  );
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
    manifest.files[snapshotKey] = {
      sha256: hash(snapshot),
      updatedAt: Date.now(),
    };
    pushed += 1;
  }

  let pulled = 0;
  try {
    const list = await client.list({
      prefix: `${prefix}sessions/`,
      maxKeys: 1000,
    });
    for (const object of list.contents ?? []) {
      if (!object.key) continue;
      const relativeKey = object.key.slice(prefix.length);
      const workspaceId = relativeKey.split("/")[1];
      if (!workspaceId) continue;
      const thread = database
        .listThreads(workspaceId)
        .find(
          (item) =>
            basename(item.sessionFilePath) === basename(object.key ?? ""),
        );
      const targetDir = getSessionDir(workspaceId);
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, basename(object.key));
      const remoteEntry = manifest.files[relativeKey];
      const localExists = existsSync(target);
      const remoteNewer = remoteEntry
        ? remoteEntry.updatedAt > (thread?.updatedAt ?? 0)
        : false;
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

export function countLocalSessions(): number {
  const root = join(getDataDir(), "sessions");
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace);
    try {
      if (statSync(dir).isDirectory()) {
        count += readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length;
      }
    } catch {
      // Ignore directories that disappear during the scan.
    }
  }
  return count;
}
