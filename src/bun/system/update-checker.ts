/**
 * Quiet GitHub Releases check. It only reports whether a newer stable release
 * exists; installing stays with the release page and the Homebrew cask, so Kip
 * never replaces itself behind the user's back.
 */
import type { UpdateStatus } from "../../shared/types";

const DEFAULT_REPO = "abcdlsj/kip";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export interface UpdateCheckerOptions {
  /** Version of the running app, e.g. "0.2.2". */
  currentVersion: string;
  repo?: string;
  intervalMs?: number;
  initialDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Called after every state change; the Bun side pushes it to the view. */
  onStatus?: (status: UpdateStatus) => void;
}

type Version = [number, number, number];

/** Accepts "0.2.2", "v0.2.2", and suffixed forms like "v0.2.2-3-gabc". */
export function parseVersion(raw: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

export function isNewerVersion(latest: Version, current: Version): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = latest[index] as number;
    const right = current[index] as number;
    if (left !== right) return left > right;
  }
  return false;
}

export class UpdateChecker {
  private readonly currentRaw: string;
  private readonly current: Version | null;
  private readonly repo: string;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onStatus: ((status: UpdateStatus) => void) | undefined;

  private status: UpdateStatus;
  private etag: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<UpdateStatus> | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.currentRaw = options.currentVersion.trim();
    this.current = parseVersion(this.currentRaw);
    this.repo = options.repo ?? DEFAULT_REPO;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onStatus = options.onStatus;
    this.status = {
      current: this.currentRaw,
      latest: null,
      available: false,
      state: "idle",
      releaseUrl: null,
      checkedAt: null,
    };
  }

  /** Checks once after `initialDelayMs`, then every `intervalMs`. */
  start(): void {
    if (this.started || !this.current) return;
    this.started = true;
    const schedule = (delay: number): void => {
      this.timer = setTimeout(() => {
        void this.check().finally(() => {
          if (this.started) schedule(this.intervalMs);
        });
      }, delay);
    };
    schedule(this.initialDelayMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  statusSnapshot(): UpdateStatus {
    return { ...this.status };
  }

  /** Never throws: network and API failures are logged and leave the state as is. */
  check(): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(): Promise<UpdateStatus> {
    if (!this.current) return this.statusSnapshot();
    const wasAvailable = this.status.available;
    const settledState = wasAvailable ? "available" : "idle";
    this.publish({ state: "checking" });

    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${this.repo}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `Kip/${this.currentRaw}`,
            ...(this.etag ? { "If-None-Match": this.etag } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (response.status === 304) {
        this.publish({ state: settledState });
        return this.statusSnapshot();
      }
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

      const release = (await response.json()) as GitHubRelease;
      const etag = response.headers.get("etag");
      if (etag) this.etag = etag;

      const tag = typeof release.tag_name === "string" ? release.tag_name : "";
      const latest = parseVersion(tag);
      const releaseUrl = typeof release.html_url === "string" ? release.html_url : null;
      if (!latest || release.draft === true || release.prerelease === true) {
        this.publish({ state: "idle", available: false, latest: null, releaseUrl, checkedAt: Date.now() });
        return this.statusSnapshot();
      }

      const available = isNewerVersion(latest, this.current);
      this.publish({
        state: available ? "available" : "idle",
        available,
        latest: latest.join("."),
        releaseUrl,
        checkedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Update check failed: ${message}`);
      this.publish({ state: settledState });
    }
    return this.statusSnapshot();
  }

  private publish(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.statusSnapshot());
  }
}
