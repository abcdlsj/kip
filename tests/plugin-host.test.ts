/**
 * The plugin host: the shipped catalog, the permission gate, and the pieces of
 * the gemini2api sidecar that do not need the network (cookies, config, key).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKETPLACE, MARKETPLACE_NOTICE, findMarketplaceEntry } from "../src/shared/marketplace";
import { defaultPluginRegistry } from "../src/bun/plugins/registry";
import { geminiModelName } from "../src/shared/plugins/gemini2api";
import { KipDatabase } from "../src/bun/storage/db";
import { gemini2apiPlugin, providerModelsFrom } from "../src/bun/plugins/gemini2api";
import {
  acceptPlugin,
  isPluginAccepted,
  marketEntryFor,
  pluginDataDir,
  toPluginSummary,
} from "../src/bun/plugins/registry";
import {
  apiKey,
  firefoxRoots,
  platformKey,
  readFirefoxCookies,
  savedCookies,
  saveCookies,
  status,
  writeConfig,
} from "../src/bun/plugins/gemini2api/service";

let dir = "";
let db: KipDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kip-plugins-"));
  process.env.KIP_DATA_DIR = dir;
  process.env.KIP_KEYCHAIN = "file";
  db = new KipDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.KIP_KEYCHAIN;
  rmSync(dir, { recursive: true, force: true });
});

describe("Plugin catalog", () => {
  test("ships the plugins that live in this repository", () => {
    expect(MARKETPLACE.map((entry) => entry.id).sort()).toEqual(["gemini2api", "warren-title"]);
    expect(findMarketplaceEntry("gemini2api")?.builtin).toBe(true);
    expect(findMarketplaceEntry("gemini2api")?.window).toBe(true);
    expect(findMarketplaceEntry("gemini2api")?.permissions).toContain("process");
    expect(MARKETPLACE_NOTICE).toContain("responsible");
  });

  test("every registered plugin is in the catalog", () => {
    for (const plugin of defaultPluginRegistry.list()) {
      expect(findMarketplaceEntry(plugin.id)).toBeDefined();
    }
  });

  test("a plugin's summary carries its catalog entry", () => {
    const summary = toPluginSummary(db, gemini2apiPlugin);
    expect(summary.market).toEqual(marketEntryFor(gemini2apiPlugin));
    expect(summary.hasWindow).toBe(true);
    // Declared permissions are not accepted until the user says so.
    expect(summary.accepted).toBe(false);
  });
});

describe("Permission gate", () => {
  test("a plugin with permissions must be accepted before it runs", () => {
    expect(isPluginAccepted(db, gemini2apiPlugin)).toBe(false);
    expect(toPluginSummary(db, gemini2apiPlugin).accepted).toBe(false);

    acceptPlugin(db, gemini2apiPlugin);

    expect(isPluginAccepted(db, gemini2apiPlugin)).toBe(true);
    expect(toPluginSummary(db, gemini2apiPlugin).accepted).toBe(true);
  });

  test("acceptance is remembered in the database, not in memory", () => {
    acceptPlugin(db, gemini2apiPlugin);
    expect(db.getSetting<string>(`plugin.gemini2api.acceptedAt`, "")).not.toBe("");
  });

  test("each plugin gets its own data directory", () => {
    expect(pluginDataDir("gemini2api")).toBe(join(dir, "plugins", "gemini2api"));
  });
});

describe("gemini2api sidecar (offline parts)", () => {
  test("names the artifact for this platform", () => {
    expect(platformKey()).toMatch(/^(macos|win|linux)-(arm64|x64)$/);
  });

  test("a fresh data directory has no binary and no cookies", () => {
    const dataDir = pluginDataDir("gemini2api");
    const state = status(dataDir, {});
    expect(state.installed).toBe(false);
    expect(state.binaryPath).toBeNull();
    expect(savedCookies(dataDir)).toBeNull();
  });

  test("a manual binary path counts as installed", () => {
    const dataDir = pluginDataDir("gemini2api");
    const manual = join(dir, "my-gemini2api");
    writeFileSync(manual, "#!/bin/sh\n", { mode: 0o755 });
    expect(status(dataDir, { binaryPath: manual }).installed).toBe(true);
  });

  test("the generated key is stable and long enough", () => {
    const dataDir = pluginDataDir("gemini2api");
    const first = apiKey(dataDir);
    expect(first.startsWith("kip-")).toBe(true);
    expect(first.length).toBeGreaterThan(30);
    expect(apiKey(dataDir)).toBe(first);
  });

  test("writes a config the server can read, without leaking extra keys", () => {
    const dataDir = pluginDataDir("gemini2api");
    saveCookies(dataDir, {
      profile: "/tmp/firefox",
      cookies: {
        "__Secure-1PSID": "psid-value",
        "__Secure-1PSIDTS": "psidts-value",
        SID: "sid-value",
      },
    });
    writeConfig(dataDir, 8791);
    const config = readFileSync(join(dataDir, "config.yaml"), "utf8");
    expect(config).toContain('secure_1psid: "psid-value"');
    expect(config).toContain('secure_1psidts: "psidts-value"');
    expect(config).toContain('"SID": "sid-value"');
    expect(config).toContain(`api_key: ${JSON.stringify(apiKey(dataDir))}`);
    expect(config).toContain("port: 8791");
    expect(config).toContain('host: 127.0.0.1');
    // Cookies never appear twice: they live in cookies.json and are rendered here.
    expect(config.match(/secure_1psid:/g)?.length).toBe(1);
  });
});

describe("Firefox cookies", () => {
  function firefoxFixture(): { root: string; expected: number } {
    const root = join(dir, "Firefox");
    const profile = join(root, "Profiles", "kip.default");
    mkdirSync(profile, { recursive: true });
    const cookiesPath = join(profile, "cookies.sqlite");
    const database = new Database(cookiesPath, { create: true });
    database.exec("create table moz_cookies (host text, name text, value text)");
    const insert = database.prepare("insert into moz_cookies values (?, ?, ?)");
    insert.run(".google.com", "__Secure-1PSID", "psid");
    insert.run(".google.com", "__Secure-1PSIDTS", "psidts");
    insert.run(".google.com", "SID", "sid");
    insert.run(".google.com", "_ga", "analytics");
    insert.run(".google.com", "_ga_CUSTOM123", "analytics-ga4");
    insert.run("example.com", "unrelated", "x");
    database.close();
    return { root, expected: 3 };
  }

  test("reads Google cookies from a Firefox profile and drops analytics", () => {
    const { root, expected } = firefoxFixture();
    const jar = readFirefoxCookies([root]);
    expect(Object.keys(jar.cookies)).toHaveLength(expected);
    expect(jar.cookies["__Secure-1PSID"]).toBe("psid");
    expect(jar.cookies["_ga"]).toBeUndefined();
    expect(jar.cookies["_ga_CUSTOM123"]).toBeUndefined();
    expect(jar.profile.endsWith("kip.default")).toBe(true);
  });

  test("reads cookies from an open WAL-mode Firefox database", () => {
    const root = join(dir, "Firefox-WAL");
    const profile = join(root, "Profiles", "live.default");
    mkdirSync(profile, { recursive: true });
    const cookiesPath = join(profile, "cookies.sqlite");
    const live = new Database(cookiesPath, { create: true });
    try {
      live.exec("PRAGMA journal_mode = WAL;");
      live.exec("create table moz_cookies (host text, name text, value text)");
      live
        .prepare("insert into moz_cookies values (?, ?, ?)")
        .run(".google.com", "__Secure-1PSID", "live-psid");
      const jar = readFirefoxCookies([root]);
      expect(jar.cookies["__Secure-1PSID"]).toBe("live-psid");
    } finally {
      live.close();
    }
  });

  test("a profile without a Gemini session is refused", () => {
    const root = join(dir, "empty-firefox");
    mkdirSync(join(root, "Profiles", "x.default"), { recursive: true });
    const database = new Database(join(root, "Profiles", "x.default", "cookies.sqlite"), {
      create: true,
    });
    database.exec("create table moz_cookies (host text, name text, value text)");
    database.close();
    expect(() => readFirefoxCookies([root])).toThrow(/No Firefox profile/);
  });

  test("default roots exist per platform", () => {
    const roots = firefoxRoots();
    expect(roots.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      expect(roots[0] ?? "").toContain("Library/Application Support/Firefox");
    }
    if (process.platform === "win32") {
      expect((roots[0] ?? "").toLowerCase()).toContain("mozilla");
    }
  });
});

describe("gemini2api model list", () => {
  const health = { server: "gemini2api", api: { context_window: 225_000 } };
  const model = (id: string, temporary?: boolean) => ({
    id,
    context_window: 225_000,
    gemini: temporary === undefined ? {} : { temporary },
  });

  test("a plain listing gets one temporary twin per model", () => {
    const models = providerModelsFrom([model("gemini-a"), model("gemini-b")], health);
    expect(models.map((item) => item.id)).toEqual([
      "gemini-a",
      "gemini-a-temp",
      "gemini-b",
      "gemini-b-temp",
    ]);
    expect(models[1]?.displayName).toBe("Gemini A (Temporary)");
  });

  test("a listing that already carries temporary entries is not doubled", () => {
    const models = providerModelsFrom(
      [model("gemini-a"), model("gemini-a-temp", true)],
      health,
    );
    expect(models.map((item) => item.id)).toEqual(["gemini-a", "gemini-a-temp"]);
  });

  test("an old server that does not mark temporary entries still yields one each", () => {
    // This is what produced 12 entries with duplicate `-temp` ids in the picker.
    const models = providerModelsFrom([model("gemini-a"), model("gemini-a-temp")], health);
    expect(models.map((item) => item.id)).toEqual(["gemini-a", "gemini-a-temp"]);
    expect(new Set(models.map((item) => item.id)).size).toBe(models.length);
  });
});

describe("gemini2api model names", () => {
  test("SKUs read like the product, not like ids", () => {
    expect(geminiModelName("gemini-neon")).toBe("Gemini Neon");
    expect(geminiModelName("gemini-4-hydrogen")).toBe("Gemini 4 Hydrogen");
    expect(geminiModelName("gemini-auto")).toBe("Gemini Auto");
  });

  test("temporary variants say so, however the server spells them", () => {
    expect(geminiModelName("gemini-neon-temp")).toBe("Gemini Neon (Temporary)");
    expect(geminiModelName("gemini-neon (temporary)")).toBe("Gemini Neon (Temporary)");
    expect(geminiModelName("gemini-neon", true)).toBe("Gemini Neon (Temporary)");
    expect(geminiModelName("gemini-4-hydrogen-temp")).toBe("Gemini 4 Hydrogen (Temporary)");
  });

  test("provider models carry the pretty name and its temporary twin", () => {
    const models = providerModelsFrom(
      [{ id: "gemini-4-hydrogen", gemini: {} }],
      { server: "gemini2api" },
    );
    expect(models.map((model) => model.displayName)).toEqual([
      "Gemini 4 Hydrogen",
      "Gemini 4 Hydrogen (Temporary)",
    ]);
  });
});
