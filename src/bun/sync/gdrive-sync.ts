/**
 * Incremental Google Drive sync using OAuth 2.0 loopback + PKCE and the Drive
 * REST API v3 (`drive.file` scope — Kip can only see files it created).
 * Tokens stay in the system keychain and never enter SQLite or sync payloads.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Utils } from "electrobun/bun";
import type { KipDatabase } from "../storage/db";
import { getSessionDir } from "../storage/db";
import { deleteApiKey, getApiKey, setApiKey } from "../storage/keychain";
import {
  hash,
  localSessionFiles,
  mergeSnapshot,
  metadataSnapshot,
  settingKey,
  type Manifest,
  type SyncResult,
} from "./sync-common";

const CLIENT_SECRET_KEY = "gdrive.client-secret";
const ACCESS_TOKEN_KEY = "gdrive.access-token";
const REFRESH_TOKEN_KEY = "gdrive.refresh-token";

const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");
const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  trashed?: boolean;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function isGoogleDriveConnected(): Promise<boolean> {
  return (await getApiKey(REFRESH_TOKEN_KEY)) !== null;
}

export function getGoogleDriveSettings(database: KipDatabase): {
  clientId: string;
  folderName: string;
  email: string | null;
} {
  return {
    clientId: database.getSetting(settingKey("gdrive.clientId"), ""),
    folderName: database.getSetting(settingKey("gdrive.folderName"), "Kip Sync"),
    email: database.getSetting<string | null>(settingKey("gdrive.email"), null),
  };
}

export async function saveGoogleDriveSettings(
  database: KipDatabase,
  input: {
    clientId?: string;
    clientSecret?: string;
    folderName?: string;
  },
): Promise<void> {
  if (input.clientId !== undefined) {
    database.setSetting(settingKey("gdrive.clientId"), input.clientId.trim());
  }
  if (input.clientSecret?.trim()) {
    await setApiKey(CLIENT_SECRET_KEY, input.clientSecret.trim());
  }
  if (input.folderName !== undefined) {
    const cleaned = input.folderName.trim() || "Kip Sync";
    const previous = database.getSetting(settingKey("gdrive.folderName"), "Kip Sync");
    database.setSetting(settingKey("gdrive.folderName"), cleaned);
    if (cleaned !== previous) {
      database.setSetting(settingKey("gdrive.folderId"), "");
    }
  }
}

export async function disconnectGoogleDrive(database: KipDatabase): Promise<void> {
  await Promise.all([
    deleteApiKey(ACCESS_TOKEN_KEY),
    deleteApiKey(REFRESH_TOKEN_KEY),
  ]);
  database.setSetting(settingKey("gdrive.email"), null);
  database.setSetting(settingKey("gdrive.tokenExpiresAt"), 0);
  database.setSetting(settingKey("gdrive.folderId"), "");
}

export async function connectGoogleDrive(
  database: KipDatabase,
  input: { clientId: string; clientSecret?: string; folderName?: string },
): Promise<{ connected: boolean; email?: string | null; error?: string }> {
  const clientId = input.clientId.trim();
  if (!clientId) {
    return { connected: false, error: "Google OAuth Client ID is required" };
  }
  await saveGoogleDriveSettings(database, input);
  const clientSecret = input.clientSecret?.trim() || (await getApiKey(CLIENT_SECRET_KEY)) || "";

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));

  let resolveCode!: (result: { code?: string; error?: string }) => void;
  const codePromise = new Promise<{ code?: string; error?: string }>((resolve) => {
    resolveCode = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (returnedState !== state) {
        resolveCode({ error: "OAuth state mismatch" });
        return htmlResponse("Authentication failed", "State mismatch. You can close this tab.");
      }
      if (error || !code) {
        resolveCode({ error: error ?? "Authorization was cancelled" });
        return htmlResponse("Authentication cancelled", "You can close this tab and return to Kip.");
      }
      resolveCode({ code });
      return htmlResponse("Connected to Kip", "Google Drive is now linked. You can close this tab.");
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const authUrl = new URL(OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const timeout = setTimeout(() => {
    resolveCode({ error: "Sign-in timed out after 3 minutes" });
  }, OAUTH_TIMEOUT_MS);

  try {
    Utils.openExternal(authUrl.toString());
    const result = await codePromise;
    if (result.error || !result.code) {
      return { connected: false, error: result.error ?? "Sign-in failed" };
    }

    const body = new URLSearchParams({
      code: result.code,
      client_id: clientId,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);

    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return {
        connected: false,
        error: tokenJson.error_description ?? tokenJson.error ?? "Token exchange failed",
      };
    }

    await setApiKey(ACCESS_TOKEN_KEY, tokenJson.access_token);
    if (tokenJson.refresh_token) {
      await setApiKey(REFRESH_TOKEN_KEY, tokenJson.refresh_token);
    }
    const expiresAt = Date.now() + Math.max(60, (tokenJson.expires_in ?? 3600) - 60) * 1000;
    database.setSetting(settingKey("gdrive.tokenExpiresAt"), expiresAt);

    let email: string | null = null;
    try {
      const infoRes = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { email?: string };
        email = info.email ?? null;
      }
    } catch {
      // Email lookup is informational only.
    }
    database.setSetting(settingKey("gdrive.email"), email);
    return { connected: true, email };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Google sign-in failed",
    };
  } finally {
    clearTimeout(timeout);
    server.stop(true);
  }
}

function htmlResponse(title: string, message: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf9f6;color:#18181b}
.card{max-width:360px;text-align:center;padding:28px;border-radius:14px;border:1px solid #e4e4e7;background:#fff}
h1{font-size:16px;margin:0 0 8px}p{font-size:13px;color:#52525b;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function getValidAccessToken(database: KipDatabase): Promise<string> {
  const expiresAt = database.getSetting<number>(settingKey("gdrive.tokenExpiresAt"), 0);
  const existing = await getApiKey(ACCESS_TOKEN_KEY);
  if (existing && Date.now() < expiresAt) return existing;

  const refreshToken = await getApiKey(REFRESH_TOKEN_KEY);
  const clientId = database.getSetting(settingKey("gdrive.clientId"), "");
  if (!refreshToken || !clientId) {
    throw new Error("Google Drive is not connected");
  }
  const clientSecret = (await getApiKey(CLIENT_SECRET_KEY)) ?? "";
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? "Failed to refresh Google Drive token");
  }
  await setApiKey(ACCESS_TOKEN_KEY, json.access_token);
  const nextExpiry = Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000;
  database.setSetting(settingKey("gdrive.tokenExpiresAt"), nextExpiry);
  return json.access_token;
}

async function driveJson<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google Drive error (${response.status}): ${text.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

async function findOrCreateFolder(
  token: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const parentClause = parentId ? ` and '${escapeQuery(parentId)}' in parents` : " and 'root' in parents";
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeQuery(name)}' and trashed=false${parentClause}`;
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const list = await driveJson<{ files?: DriveFile[] }>(token, url);
  const found = list.files?.[0];
  if (found) return found.id;

  const created = await driveJson<DriveFile>(token, `${DRIVE_FILES_URL}?fields=id,name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  return created.id;
}

async function ensureRootFolder(database: KipDatabase, token: string): Promise<string> {
  const folderName = database.getSetting(settingKey("gdrive.folderName"), "Kip Sync") || "Kip Sync";
  const cachedId = database.getSetting(settingKey("gdrive.folderId"), "");
  if (cachedId) {
    try {
      const meta = await driveJson<DriveFile>(
        token,
        `${DRIVE_FILES_URL}/${encodeURIComponent(cachedId)}?fields=id,name,trashed`,
      );
      if (meta.id && !meta.trashed && meta.name === folderName) return meta.id;
    } catch {
      // Cached folder was deleted or inaccessible; re-create below.
    }
  }
  const id = await findOrCreateFolder(token, folderName);
  database.setSetting(settingKey("gdrive.folderId"), id);
  return id;
}

async function listFolderFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken = "";
  while (true) {
    const q = `'${escapeQuery(folderId)}' in parents and trashed=false`;
    const params = new URLSearchParams({
      q,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await driveJson<{ files?: DriveFile[]; nextPageToken?: string }>(
      token,
      `${DRIVE_FILES_URL}?${params.toString()}`,
    );
    if (page.files) all.push(...page.files);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return all;
}

async function downloadFile(token: string, fileId: string): Promise<Buffer> {
  const response = await fetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`Failed to download file from Google Drive (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadFile(
  token: string,
  name: string,
  parentId: string,
  content: Buffer | string,
  mimeType: string,
  existingFileId?: string,
): Promise<string> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (existingFileId) {
    const updated = await driveJson<DriveFile>(
      token,
      `${DRIVE_UPLOAD_URL}/${encodeURIComponent(existingFileId)}?uploadType=media&fields=id`,
      {
        method: "PATCH",
        headers: { "Content-Type": mimeType },
        body: new Uint8Array(bytes),
      },
    );
    return updated.id;
  }

  const boundary = `kip_${crypto.randomUUID().replaceAll("-", "")}`;
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const multipart = Buffer.concat([prefix, bytes, suffix]);

  const created = await driveJson<DriveFile>(
    token,
    `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(multipart),
    },
  );
  return created.id;
}

export async function testGoogleDriveConnection(
  database: KipDatabase,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const token = await getValidAccessToken(database);
    await ensureRootFolder(database, token);
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : "Google Drive connection failed",
    };
  }
}

export async function triggerGoogleDriveSync(database: KipDatabase): Promise<SyncResult> {
  const token = await getValidAccessToken(database);
  const rootFolderId = await ensureRootFolder(database, token);
  const rootFiles = await listFolderFiles(token, rootFolderId);
  const byName = new Map(rootFiles.map((file) => [file.name, file]));

  const manifestFile = byName.get("manifest.json");
  let remote: Manifest | null = null;
  if (manifestFile) {
    try {
      const text = (await downloadFile(token, manifestFile.id)).toString("utf8");
      remote = JSON.parse(text) as Manifest;
    } catch {
      remote = null;
    }
  }

  const manifest: Manifest = remote ?? {
    version: 1,
    deviceId: crypto.randomUUID(),
    syncedAt: 0,
    files: {},
  };

  const sessionsFolderId =
    byName.get("sessions")?.mimeType === FOLDER_MIME
      ? byName.get("sessions")!.id
      : await findOrCreateFolder(token, "sessions", rootFolderId);
  const remoteSessions = await listFolderFiles(token, sessionsFolderId);
  const remoteSessionByName = new Map(remoteSessions.map((file) => [file.name, file]));

  let pushed = 0;
  const locals = localSessionFiles(database);
  for (const file of locals) {
    const digest = hash(file.content);
    if (manifest.files[file.key]?.sha256 === digest) continue;
    const driveName = `${file.workspaceId}__${file.fileName}`;
    const existing = remoteSessionByName.get(driveName);
    const id = await uploadFile(
      token,
      driveName,
      sessionsFolderId,
      file.content,
      "application/x-ndjson",
      existing?.id,
    );
    remoteSessionByName.set(driveName, { id, name: driveName });
    manifest.files[file.key] = { sha256: digest, updatedAt: file.updatedAt };
    pushed += 1;
  }

  const snapshot = metadataSnapshot(database);
  const snapshotKey = "metadata/snapshot.json";
  const snapshotFile = byName.get("snapshot.json");
  if (manifest.files[snapshotKey]?.sha256 !== hash(snapshot)) {
    await uploadFile(
      token,
      "snapshot.json",
      rootFolderId,
      snapshot,
      "application/json",
      snapshotFile?.id,
    );
    manifest.files[snapshotKey] = { sha256: hash(snapshot), updatedAt: Date.now() };
    pushed += 1;
  }

  let pulled = 0;
  for (const remoteFile of remoteSessions) {
    const sepIndex = remoteFile.name.indexOf("__");
    if (sepIndex <= 0) continue;
    const workspaceId = remoteFile.name.slice(0, sepIndex);
    const fileName = remoteFile.name.slice(sepIndex + 2);
    if (!fileName) continue;
    const relativeKey = `sessions/${workspaceId}/${fileName}`;
    const thread = database
      .listThreads(workspaceId)
      .find((item) => basename(item.sessionFilePath) === fileName);
    const targetDir = getSessionDir(workspaceId);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, fileName);
    const remoteEntry = manifest.files[relativeKey];
    const localExists = existsSync(target);
    const remoteNewer = remoteEntry ? remoteEntry.updatedAt > (thread?.updatedAt ?? 0) : false;
    if (localExists && !remoteNewer) continue;
    const body = await downloadFile(token, remoteFile.id);
    await Bun.write(target, body);
    if (localExists) continue;
    if (!thread) continue;
    database.updateThread(thread.id, { sessionFilePath: target });
    pulled += 1;
  }

  if (snapshotFile && manifest.files[snapshotKey]?.sha256 === hash(snapshot)) {
    try {
      const remoteSnapshot = JSON.parse(
        (await downloadFile(token, snapshotFile.id)).toString("utf8"),
      ) as { workspaces?: unknown[]; threads?: unknown[] };
      pulled += mergeSnapshot(database, remoteSnapshot);
    } catch {
      // Metadata merge is opportunistic; session recovery remains authoritative.
    }
  }

  manifest.syncedAt = Date.now();
  await uploadFile(
    token,
    "manifest.json",
    rootFolderId,
    JSON.stringify(manifest, null, 2),
    "application/json",
    manifestFile?.id,
  );
  database.setSetting(settingKey("lastSyncedAt"), manifest.syncedAt);
  return { pushed, pulled, syncedAt: manifest.syncedAt };
}
