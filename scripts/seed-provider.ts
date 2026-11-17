/**
 * Local development helper: seeds a provider and its key into ~/.kip without a
 * GUI. Secrets come from the environment or, only when KIP_SEED_KEY_FROM_PI=1,
 * from the local Pi profile. Nothing is printed except provider metadata.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { KipDatabase } from "../src/bun/storage/db";
import { setApiKey } from "../src/bun/storage/keychain";
import type { ProviderProtocol } from "../src/shared/types";

const id = process.env.KIP_SEED_PROVIDER_ID ?? "local";
const baseUrl = process.env.KIP_SEED_BASE_URL ?? "http://localhost:11434/v1";
const protocol = (process.env.KIP_SEED_PROTOCOL ?? "openai-completions") as ProviderProtocol;
const displayName = process.env.KIP_SEED_DISPLAY_NAME ?? id;
const modelIds = (process.env.KIP_SEED_MODELS ?? "llama3.1")
  .split(/[\n,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
const contextWindow = Number(process.env.KIP_SEED_CONTEXT_WINDOW ?? 200_000);
const reasoning = process.env.KIP_SEED_REASONING === "1";

let apiKey = process.env.KIP_SEED_API_KEY ?? "";
if (!apiKey && process.env.KIP_SEED_KEY_FROM_PI === "1") {
  const auth = JSON.parse(
    readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
  ) as { commandcode?: { access?: string } };
  apiKey = auth.commandcode?.access ?? "";
}
if (!apiKey) {
  console.error("Set KIP_SEED_API_KEY or KIP_SEED_KEY_FROM_PI=1.");
  process.exit(1);
}
if (modelIds.length === 0) {
  console.error("Set KIP_SEED_MODELS to one or more comma-separated model ids.");
  process.exit(1);
}

const db = new KipDatabase();
db.saveProvider({
  id,
  displayName,
  protocol,
  baseUrl,
  models: modelIds.map((modelId) => ({
    id: modelId,
    displayName: modelId.split("/").pop() ?? modelId,
    contextWindow,
    maxOutputTokens: 65_536,
    supportsVision: false,
    supportsReasoning: reasoning,
  })),
});
await setApiKey(id, apiKey);
db.setSetting("defaultProvider", id);
db.setSetting("defaultModelId", modelIds[0]);

const workspaceRoot = process.env.KIP_SEED_WORKSPACE ?? process.cwd();
if (!db.findWorkspaceByPath(workspaceRoot)) {
  const workspace = db.createWorkspace(basename(workspaceRoot), workspaceRoot);
  db.touchWorkspace(workspace.id);
}
console.log(`Seeded provider ${id} with ${modelIds.length} model(s).`);
db.close();
