/**
 * Optional automatic thread-title plugin backed by the Warren Cloudflare
 * Workers AI title service (https://title.warrenai.xyz) or a self-hosted
 * compatible worker URL.
 *
 * Off by default until the user enables it in Settings -> Plugins. Sends only
 * the clipped conversation excerpt and a random per-device UUID for daily
 * quota enforcement (50/day per device on the hosted endpoint).
 */
import type { PluginProbeResult } from "../../shared/types";
import type { TitleGenerationInput, TitlePlugin, TitlePluginContext } from "./types";

export const DEFAULT_TITLE_WORKER_URL = "https://title.warrenai.xyz";
const PROBE_TIMEOUT_MS = 8_000;
const TITLE_TIMEOUT_MS = 12_000;

interface HealthResponse {
  ok?: boolean;
  service?: string;
  model?: string;
  limits?: {
    deviceDaily?: number;
    ipDaily?: number;
  };
}

interface TitleResponse {
  title?: string;
  error?: string;
}

function resolveBaseUrl(values: Record<string, string>): { url: string } | { error: string } {
  const raw = (values.endpoint ?? "").trim();
  const candidate = raw || DEFAULT_TITLE_WORKER_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "Endpoint must be a valid http:// or https:// URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "Endpoint must use http:// or https://." };
  }
  const normalized = parsed.toString().replace(/\/+$/, "").replace(/\/v1\/title$/, "");
  return { url: normalized };
}

export const warrenTitlePlugin: TitlePlugin = {
  id: "warren-title",
  kind: "title",
  label: "AI Thread Titles",
  description:
    "Names new threads automatically via the free Warren Cloudflare Workers AI service (50 titles/day per device) or a self-hosted worker. Falls back to local titles when off or rate-limited.",
  defaultEnabled: false,
  fields: [
    {
      name: "endpoint",
      label: "Service URL",
      kind: "text",
      optional: true,
      placeholder: DEFAULT_TITLE_WORKER_URL,
      help: "Leave blank to use the free hosted service, or point at your own TitleService worker.",
    },
  ],

  async probe(values: Record<string, string>): Promise<PluginProbeResult> {
    const resolved = resolveBaseUrl(values);
    if ("error" in resolved) {
      return { ok: false, error: resolved.error };
    }
    try {
      const response = await fetch(`${resolved.url}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, error: `Health check returned HTTP ${response.status}.` };
      }
      const body = (await response.json()) as HealthResponse;
      if (!body.ok || body.service !== "warren-title") {
        return {
          ok: false,
          error: "This URL responded, but it is not a Warren Title Service endpoint.",
        };
      }
      const daily = body.limits?.deviceDaily;
      const details: Array<{ label: string; value: string }> = [];
      if (body.model) details.push({ label: "Model", value: body.model });
      if (daily) details.push({ label: "Limit", value: `${daily}/day per device` });
      return {
        ok: true,
        summary: daily
          ? `Reachable · up to ${daily} titles/day per device`
          : "Reachable",
        details,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not reach ${resolved.url}: ${message}` };
    }
  },

  async generateTitle(
    input: TitleGenerationInput,
    values: Record<string, string>,
    context: TitlePluginContext,
  ): Promise<string | null> {
    const resolved = resolveBaseUrl(values);
    if ("error" in resolved) return null;
    if (!input.messages.some((m) => m.role === "user" && m.content.trim())) {
      return null;
    }

    try {
      const response = await fetch(`${resolved.url}/v1/title`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": context.deviceId,
          "X-App": "kip",
        },
        body: JSON.stringify({
          mode: input.mode,
          messages: input.messages,
        }),
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as TitleResponse;
      const title = typeof body.title === "string" ? body.title.trim() : "";
      return title || null;
    } catch {
      return null;
    }
  },
};
