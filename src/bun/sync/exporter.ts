/**
 * Portable exports. Markdown is for humans; the JSON bundle is a complete
 * restorable snapshot. Credentials are never included in either format.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Utils } from "electrobun/bun";
import type { ChatTurn } from "../../shared/types";
import type { KipDatabase } from "../storage/db";
import { getDataDir, getSessionDir } from "../storage/db";
import { userHome } from "../system/platform";
import { projectSessionTurns } from "../agent/session-bridge";
import { SessionManager } from "@earendil-works/pi-coding-agent";

interface BackupBundle {
  format: "kip-backup";
  version: 1;
  exportedAt: number;
  metadata: {
    workspaces: unknown[];
    threads: unknown[];
    providers: unknown[];
    settings: Record<string, unknown>;
  };
  sessions: Array<{ workspaceId: string; fileName: string; content: string }>;
}

async function pickDirectory(): Promise<string | null> {
  const paths = await Utils.openFileDialog({
    startingFolder: userHome(),
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });
  return paths.find((path) => path.trim().length > 0) ?? null;
}

export async function exportThreadMarkdown(
  database: KipDatabase,
  threadId: string,
): Promise<string | null> {
  const thread = database.getThread(threadId);
  if (!thread) throw new Error("Thread not found");
  const workspace = database.getWorkspace(thread.workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const directory = await pickDirectory();
  if (!directory) return null;

  let turns: ChatTurn[] = [];
  if (thread.sessionFilePath && existsSync(thread.sessionFilePath)) {
    const manager = SessionManager.open(
      thread.sessionFilePath,
      undefined,
      workspace.rootPath,
    );
    turns = projectSessionTurns(manager.getBranch(), workspace.rootPath);
  }

  const lines: string[] = [
    `# ${thread.title}`,
    "",
    `- Workspace: \`${workspace.rootPath}\``,
    `- Model: \`${thread.modelProvider}/${thread.modelId}\``,
    `- Exported: ${new Date().toISOString()}`,
    "",
  ];
  for (const turn of turns) {
    lines.push(turn.role === "user" ? "## You" : "## Kip", "");
    for (const block of turn.blocks) {
      if (block.type === "text") lines.push(block.text, "");
      else if (block.type === "thinking")
        lines.push(
          "<details><summary>Reasoning</summary>",
          "",
          block.thinking,
          "",
          "</details>",
          "",
        );
      else lines.push(`- \`${block.summaryLabel}\``, "");
    }
  }

  const safeName =
    thread.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "thread";
  const target = join(directory, `${safeName}.md`);
  await Bun.write(target, lines.join("\n"));
  return target;
}

export async function exportBackupBundle(
  database: KipDatabase,
): Promise<string | null> {
  const directory = await pickDirectory();
  if (!directory) return null;
  const sessions: BackupBundle["sessions"] = [];
  for (const workspace of database.listWorkspaces()) {
    for (const thread of database.listThreads(workspace.id)) {
      if (!thread.sessionFilePath || !existsSync(thread.sessionFilePath))
        continue;
      sessions.push({
        workspaceId: workspace.id,
        fileName: basename(thread.sessionFilePath),
        content: readFileSync(thread.sessionFilePath, "utf8"),
      });
    }
  }
  const settings: Record<string, unknown> = {};
  for (const key of [
    "theme",
    "approvalPolicy",
    "defaultProvider",
    "defaultModelId",
    "defaultThinkingLevel",
    "sidebarCollapsed",
  ]) {
    settings[key] = database.getSetting(key, null);
  }
  const bundle: BackupBundle = {
    format: "kip-backup",
    version: 1,
    exportedAt: Date.now(),
    metadata: {
      workspaces: database.listWorkspaces(),
      threads: database.db.query("SELECT * FROM threads").all(),
      providers: database.listProviders(),
      settings,
    },
    sessions,
  };
  const target = join(
    directory,
    `kip-backup-${new Date().toISOString().slice(0, 10)}.json`,
  );
  await Bun.write(target, JSON.stringify(bundle, null, 2));
  return target;
}

export async function importBackupBundle(
  database: KipDatabase,
): Promise<{ importedThreads: number }> {
  const paths = await Utils.openFileDialog({
    startingFolder: userHome(),
    canChooseFiles: true,
    canChooseDirectory: false,
    allowsMultipleSelection: false,
    allowedFileTypes: "json",
  });
  const filePath = paths.find((path) => path.trim().length > 0);
  if (!filePath) return { importedThreads: 0 };
  const bundle = JSON.parse(readFileSync(filePath, "utf8")) as BackupBundle;
  if (bundle.format !== "kip-backup") throw new Error("Not a Kip backup");

  const workspaces = bundle.metadata.workspaces as Array<{
    id: string;
    name: string;
    rootPath: string;
    lastOpenedAt?: number;
  }>;
  const workspaceMap = new Map<string, string>();
  for (const workspace of workspaces) {
    if (!existsSync(workspace.rootPath)) continue;
    const stored = database.upsertWorkspace(
      workspace.id,
      workspace.name,
      workspace.rootPath,
      workspace.lastOpenedAt,
    );
    workspaceMap.set(workspace.id, stored.id);
  }

  const threads = bundle.metadata.threads as Array<{
    id: string;
    workspace_id: string;
    title: string;
    session_file_path: string;
    model_provider: string;
    model_id: string;
    thinking_level: string;
    updated_at: number;
  }>;
  let imported = 0;
  for (const row of threads) {
    const mappedId = workspaceMap.get(row.workspace_id);
    const workspace = mappedId ? database.getWorkspace(mappedId) : null;
    if (!workspace) continue;
    const sessionDir = getSessionDir(workspace.id);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, basename(row.session_file_path));
    const payload = bundle.sessions.find(
      (session) => session.fileName === basename(row.session_file_path),
    );
    if (payload) await Bun.write(sessionFile, payload.content);
    if (!database.getThread(row.id)) {
      database.createThread({
        id: row.id,
        workspaceId: workspace.id,
        title: row.title,
        sessionFilePath: sessionFile,
        modelProvider: row.model_provider,
        modelId: row.model_id,
        thinkingLevel: row.thinking_level as never,
      });
      imported += 1;
    }
  }

  for (const provider of bundle.metadata.providers as Array<{
    id: string;
    displayName: string;
    protocol: string;
    baseUrl: string;
    models: unknown[];
  }>) {
    database.saveProvider({
      id: provider.id,
      displayName: provider.displayName,
      protocol: provider.protocol as never,
      baseUrl: provider.baseUrl,
      models: provider.models as never,
    });
  }

  if (!existsSync(getDataDir())) mkdirSync(getDataDir(), { recursive: true });
  return { importedThreads: imported };
}
