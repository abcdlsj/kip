/**
 * Read the Gemini session cookies out of a signed-in Firefox profile.
 *
 * This is the single implementation of that job. Kip's gemini2api plugin copies
 * this file verbatim (see its `vendor/cookies.pin.json`); edit it here, not in
 * the copy. It has no dependencies and uses only Node/Bun built-ins, so both a
 * Bun test and a desktop app can load it.
 *
 * Firefox stores cookie values in clear, which is why this is the reliable
 * source. Chromium-based browsers encrypt them, and Device Bound Session
 * Credentials bind the session to the browser that created it.
 */

import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Every Google cookie the browser holds; two PSID values are not enough any more. */
const GOOGLE_HOSTS = [".google.com", "accounts.google.com", "gemini.google.com"];
const DROPPED_COOKIES = new Set(["_ga", "_gcl_au", "_ga_WC57KJ50ZZ"]);

export interface CookieJar {
  /** The Firefox profile directory the cookies came from. */
  profile: string;
  /** Cookie name to value, analytics dropped. */
  cookies: Record<string, string>;
}

/** The default Firefox profile roots on this platform. */
export function firefoxRoots(): string[] {
  if (process.platform === "darwin") {
    return [join(homedir(), "Library", "Application Support", "Firefox")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return [join(appData, "Mozilla", "Firefox")];
  }
  // Distribution packages keep their own root and a flat profile layout.
  return [
    join(homedir(), ".mozilla", "firefox"),
    join(homedir(), "snap", "firefox", "common", ".mozilla", "firefox"),
    join(homedir(), ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ];
}

/** Every Firefox profile that holds a cookie database, unreadable ones included. */
export function firefoxProfiles(roots: string[] = firefoxRoots()): string[] {
  const seen = new Set<string>();
  const profiles: string[] = [];
  for (const root of roots) {
    const profilesDir = join(root, "Profiles");
    for (const [base, candidates] of [
      [profilesDir, safeReaddir(profilesDir)],
      [root, safeReaddir(root)],
    ] as const) {
      for (const name of candidates) {
        const dir = join(base, name);
        if (!existsSync(join(dir, "cookies.sqlite"))) continue;
        let canonical = dir;
        try {
          canonical = realpathSync(dir);
        } catch {
          // Keep the original path if realpath fails.
        }
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        profiles.push(dir);
      }
    }
  }
  return profiles;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Firefox keeps cookie values in clear; copy the database before reading it. */
function cookiesFromProfile(profile: string): Record<string, string> {
  const temp = mkdtempSync(join(tmpdir(), "gemini-cookies-"));
  try {
    const source = join(profile, "cookies.sqlite");
    if (!existsSync(source)) return {};
    const target = join(temp, "cookies.sqlite");
    copyFileSync(source, target);
    // Copy `-wal` so uncommitted writes are visible, but skip `-shm`: it belongs
    // to Firefox's live process (and can be locked on Windows), and SQLite
    // rebuilds it cleanly on this private copy.
    try {
      copyFileSync(`${source}-wal`, `${target}-wal`);
    } catch {
      // No WAL, or Firefox checkpointed it away between the two reads.
    }
    const database = new Database(target);
    try {
      const rows = database
        .query<{ name: string; value: string }, string[]>(
          `select name, value from moz_cookies where host in (${GOOGLE_HOSTS.map(() => "?").join(",")})`,
        )
        .all(...GOOGLE_HOSTS);
      const cookies: Record<string, string> = {};
      for (const row of rows) {
        if (!row.value || DROPPED_COOKIES.has(row.name) || row.name.startsWith("_ga")) continue;
        cookies[row.name] = row.value;
      }
      return cookies;
    } finally {
      database.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * The profile with the most Google cookies, provided it actually holds a Gemini
 * session. Unreadable profiles are skipped rather than failing the whole read.
 */
export function readFirefoxCookies(roots: string[] = firefoxRoots()): CookieJar {
  let best: CookieJar | null = null;
  for (const profile of firefoxProfiles(roots)) {
    let cookies: Record<string, string> = {};
    try {
      cookies = cookiesFromProfile(profile);
    } catch {
      // A profile whose database cannot be read is simply not a candidate.
      continue;
    }
    if (!cookies["__Secure-1PSID"]) continue;
    if (!best || Object.keys(cookies).length > Object.keys(best.cookies).length) {
      best = { profile, cookies };
    }
  }
  if (!best) {
    throw new Error(
      "No Firefox profile has a Gemini session. Sign in to gemini.google.com in Firefox, then try again.",
    );
  }
  return best;
}
