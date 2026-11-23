/**
 * Quiet GitHub Releases check plus optional self-update.
 *
 * The check itself never installs anything. On a direct (dmg) install a newer
 * release is downloaded and staged in the background; the app only replaces
 * itself when the user confirms the restart in the sidebar. Homebrew installs
 * are told to run `brew upgrade --cask kip` instead, so the versioned Caskroom
 * directory never drifts from what brew believes is installed.
 */
import type { UpdateInstallSource, UpdateStatus } from "../../shared/types";

const DEFAULT_REPO = "abcdlsj/kip";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: Array<{
    name?: unknown;
    browser_download_url?: unknown;
    size?: unknown;
  }>;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

/** Platform piece that stages and applies the new bundle. */
export interface UpdateInstaller {
  readonly source: UpdateInstallSource;
  /** Downloads and verifies the release; resolves once it can be applied. */
  prepare(
    assets: ReleaseAsset[],
    version: string,
    onProgress: (percent: number) => void,
  ): Promise<void>;
  /** Replaces the bundle and relaunches. Returns false when it could not start. */
  apply(): Promise<boolean>;
}

export interface UpdateCheckerOptions {
  /** Version of the running app, e.g. "0.2.2". */
  currentVersion: string;
  repo?: string;
  intervalMs?: number;
  initialDelayMs?: number;
  fetchImpl?: typeof fetch;
  installer?: UpdateInstaller;
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
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
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

function readAssets(raw: GitHubRelease["assets"]): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: ReleaseAsset[] = [];
  for (const asset of raw) {
    if (
      typeof asset?.name !== "string" ||
      typeof asset.browser_download_url !== "string"
    )
      continue;
    assets.push({
      name: asset.name,
      url: asset.browser_download_url,
      size: typeof asset.size === "number" ? asset.size : 0,
    });
  }
  return assets;
}

export class UpdateChecker {
  private readonly currentRaw: string;
  private readonly current: Version | null;
  private readonly repo: string;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly installer: UpdateInstaller | undefined;
  private readonly onStatus: ((status: UpdateStatus) => void) | undefined;

  private status: UpdateStatus;
  private etag: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<UpdateStatus> | null = null;
  /** Version whose bundle was already handed to the installer. */
  private preparedFor: string | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.currentRaw = options.currentVersion.trim();
    this.current = parseVersion(this.currentRaw);
    this.repo = options.repo ?? DEFAULT_REPO;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.installer = options.installer;
    this.onStatus = options.onStatus;
    this.status = {
      current: this.currentRaw,
      latest: null,
      available: false,
      state: "idle",
      installSource: this.installer?.source ?? "manual",
      progress: 0,
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

  /** Installs the staged bundle and quits; the user starts this from the prompt. */
  async applyUpdate(): Promise<boolean> {
    if (this.status.state !== "ready" || !this.installer) return false;
    return this.installer.apply();
  }

  private async runCheck(): Promise<UpdateStatus> {
    if (!this.current) return this.statusSnapshot();
    const busy =
      this.status.state === "downloading" || this.status.state === "ready";
    if (!busy) this.publish({ state: "checking" });

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
        this.settleCheck();
        return this.statusSnapshot();
      }
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

      const release = (await response.json()) as GitHubRelease;
      const etag = response.headers.get("etag");
      if (etag) this.etag = etag;

      const tag = typeof release.tag_name === "string" ? release.tag_name : "";
      const latest = parseVersion(tag);
      const releaseUrl =
        typeof release.html_url === "string" ? release.html_url : null;
      if (!latest || release.draft === true || release.prerelease === true) {
        this.publish({
          state: "idle",
          available: false,
          latest: null,
          releaseUrl,
          progress: 0,
          checkedAt: Date.now(),
        });
        this.preparedFor = null;
        return this.statusSnapshot();
      }

      const version = latest.join(".");
      const available = isNewerVersion(latest, this.current);
      this.publish({
        available,
        latest: version,
        releaseUrl,
        checkedAt: Date.now(),
        state: available ? "available" : "idle",
        ...(available ? {} : { progress: 0 }),
      });
      if (!available) {
        this.preparedFor = null;
        return this.statusSnapshot();
      }

      const installer = this.installer;
      if (installer?.source === "direct" && this.preparedFor !== version) {
        this.preparedFor = version;
        void this.prepareUpdate(installer, readAssets(release.assets), version);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Update check failed: ${message}`);
      this.settleCheck();
    }
    return this.statusSnapshot();
  }

  /** A finished check must not overwrite a download already in progress. */
  private settleCheck(): void {
    if (this.status.state !== "checking") return;
    this.publish({ state: this.status.available ? "available" : "idle" });
  }

  private async prepareUpdate(
    installer: UpdateInstaller,
    assets: ReleaseAsset[],
    version: string,
  ): Promise<void> {
    this.publish({ state: "downloading", progress: 0 });
    try {
      await installer.prepare(assets, version, (percent) => {
        if (
          this.status.latest !== version ||
          this.status.state !== "downloading"
        )
          return;
        this.publish({ progress: percent });
      });
      if (this.status.latest !== version) return;
      this.publish({ state: "ready", progress: 100 });
      console.log(`Kip ${version} is staged; waiting for the restart prompt.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Update download failed: ${message}`);
      this.preparedFor = null;
      // No usable asset: leave the arrow pointing at the release page instead
      // of spinning forever on a download that cannot succeed.
      this.publish({
        state: "available",
        progress: 0,
        installSource: "manual",
      });
    }
  }

  private publish(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.statusSnapshot());
  }
}
