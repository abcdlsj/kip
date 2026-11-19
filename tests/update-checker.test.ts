import { describe, expect, test } from "bun:test";
import {
  isNewerVersion,
  parseVersion,
  UpdateChecker,
  type UpdateInstaller,
} from "../src/bun/system/update-checker";

function releaseResponse(body: unknown, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.etag) headers.set("etag", init.etag);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The DOM `fetch` also carries `preconnect`; the checker only calls it. */
const asFetch = (impl: FetchImpl): typeof fetch => impl as unknown as typeof fetch;

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/abcdlsj/kip/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  };
}

describe("version parsing", () => {
  test("accepts plain, v-prefixed, and suffixed versions", () => {
    expect(parseVersion("0.2.2")).toEqual([0, 2, 2]);
    expect(parseVersion("v0.2.2")).toEqual([0, 2, 2]);
    expect(parseVersion("v0.2.2-3-gabc1234-dirty")).toEqual([0, 2, 2]);
    expect(parseVersion("1.10.0+build.5")).toEqual([1, 10, 0]);
  });

  test("rejects anything that is not three numbers", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("0.2")).toBeNull();
    expect(parseVersion("v0.2.x")).toBeNull();
    expect(parseVersion("abc3.1.5")).toBeNull();
  });

  test("compares numerically, not lexically", () => {
    expect(isNewerVersion([0, 2, 10], [0, 2, 9])).toBe(true);
    expect(isNewerVersion([0, 10, 0], [0, 9, 9])).toBe(true);
    expect(isNewerVersion([1, 0, 0], [0, 90, 0])).toBe(true);
    expect(isNewerVersion([0, 2, 2], [0, 2, 2])).toBe(false);
    expect(isNewerVersion([0, 2, 1], [0, 2, 2])).toBe(false);
  });
});

describe("update checker", () => {
  test("reports a newer stable release and its page", async () => {
    const seen: string[] = [];
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async (_input, init) => {
        seen.push(String(new Headers(init?.headers).get("user-agent")));
        return releaseResponse(release("v0.3.0"), { etag: '"abc"' });
      }),
    });

    const status = await checker.check();
    expect(status.state).toBe("available");
    expect(status.available).toBe(true);
    expect(status.current).toBe("0.2.2");
    expect(status.latest).toBe("0.3.0");
    expect(status.releaseUrl).toBe("https://github.com/abcdlsj/kip/releases/tag/v0.3.0");
    expect(status.checkedAt).toBeGreaterThan(0);
    expect(seen).toEqual(["Kip/0.2.2"]);
  });

  test("stays quiet when the release is not newer", async () => {
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async () => releaseResponse(release("v0.2.2"))),
    });

    const status = await checker.check();
    expect(status.state).toBe("idle");
    expect(status.available).toBe(false);
    expect(status.latest).toBe("0.2.2");
  });

  test("ignores drafts and prereleases", async () => {
    for (const extra of [{ draft: true }, { prerelease: true }]) {
      const checker = new UpdateChecker({
        currentVersion: "0.2.2",
        fetchImpl: asFetch(async () => releaseResponse(release("v9.0.0", extra))),
      });
      const status = await checker.check();
      expect(status.available).toBe(false);
      expect(status.latest).toBeNull();
    }
  });

  test("sends the ETag and keeps the last answer on 304", async () => {
    const tags: Array<string | null> = [];
    let call = 0;
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async (_input, init) => {
        tags.push(new Headers(init?.headers).get("if-none-match"));
        call += 1;
        if (call === 1) return releaseResponse(release("v0.3.0"), { etag: '"abc"' });
        return releaseResponse(null, { status: 304 });
      }),
    });

    await checker.check();
    const status = await checker.check();
    expect(tags).toEqual([null, '"abc"']);
    expect(status.state).toBe("available");
    expect(status.latest).toBe("0.3.0");
  });

  test("keeps the previous state when the network fails", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const checker = new UpdateChecker({
        currentVersion: "0.2.2",
        fetchImpl: asFetch(async () => {
          throw new Error("offline");
        }),
      });

      const status = await checker.check();
      expect(status.state).toBe("idle");
      expect(status.available).toBe(false);
      expect(warnings).toEqual(["Update check failed: offline"]);
    } finally {
      console.warn = warn;
    }
  });

  test("survives a non-OK GitHub answer and an unparseable tag", async () => {
    const failing = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async () => releaseResponse({ message: "rate limited" }, { status: 403 })),
    });
    expect((await failing.check()).available).toBe(false);

    const weird = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async () => releaseResponse(release("nightly"))),
    });
    const status = await weird.check();
    expect(status.available).toBe(false);
    expect(status.latest).toBeNull();
  });

  test("skips the network entirely without a usable version", async () => {
    let called = false;
    const checker = new UpdateChecker({
      currentVersion: "dev",
      fetchImpl: asFetch(async () => {
        called = true;
        return releaseResponse(release("v0.3.0"));
      }),
    });

    const status = await checker.check();
    expect(called).toBe(false);
    expect(status.state).toBe("idle");
  });
});

describe("self-update", () => {
  const dmg = {
    name: "stable-macos-arm64-Kip.dmg",
    url: "https://example.invalid/Kip.dmg",
    size: 1024,
  };

  function fakeInstaller(source: "direct" | "homebrew", fail = false) {
    const calls = { prepare: 0, apply: 0 };
    const installer: UpdateInstaller = {
      source,
      prepare: async (_assets, _version, onProgress) => {
        calls.prepare += 1;
        onProgress(50);
        if (fail) throw new Error("dmg download failed");
        onProgress(99);
      },
      apply: async () => {
        calls.apply += 1;
        return true;
      },
    };
    return { installer, calls };
  }

  async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function fetchWithAssets(): typeof fetch {
    return asFetch(async () =>
      releaseResponse({ ...release("v0.3.0"), assets: [dmg] }),
    );
  }

  test("a dmg install downloads in the background and waits for a restart", async () => {
    const { installer, calls } = fakeInstaller("direct");
    const states: string[] = [];
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: fetchWithAssets(),
      installer,
      onStatus: (status) => states.push(status.state),
    });

    await checker.check();
    await waitFor(() => checker.statusSnapshot().state === "ready");

    const status = checker.statusSnapshot();
    expect(status.available).toBe(true);
    expect(status.installSource).toBe("direct");
    expect(status.latest).toBe("0.3.0");
    expect(status.progress).toBe(100);
    expect(calls.prepare).toBe(1);
    expect(states).toContain("downloading");
    expect(states).toContain("ready");

    expect(await checker.applyUpdate()).toBe(true);
    expect(calls.apply).toBe(1);
  });

  test("a Homebrew install never stages a bundle", async () => {
    const { installer, calls } = fakeInstaller("homebrew");
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: fetchWithAssets(),
      installer,
    });

    await checker.check();
    const status = checker.statusSnapshot();
    expect(status.state).toBe("available");
    expect(status.installSource).toBe("homebrew");
    expect(calls.prepare).toBe(0);
    expect(await checker.applyUpdate()).toBe(false);
    expect(calls.apply).toBe(0);
  });

  test("a failed download falls back to the available state", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const { installer } = fakeInstaller("direct", true);
      const checker = new UpdateChecker({
        currentVersion: "0.2.2",
        fetchImpl: fetchWithAssets(),
        installer,
      });

      await checker.check();
      await waitFor(() => checker.statusSnapshot().state === "available");
      expect(checker.statusSnapshot().progress).toBe(0);
      expect(warnings).toEqual(["Update download failed: dmg download failed"]);
    } finally {
      console.warn = warn;
    }
  });

  test("without an installer the release page is the only action", async () => {
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: fetchWithAssets(),
    });
    await checker.check();
    const status = checker.statusSnapshot();
    expect(status.state).toBe("available");
    expect(status.installSource).toBe("manual");
    expect(await checker.applyUpdate()).toBe(false);
  });

  test("going back to the current version clears the staged update", async () => {
    const { installer } = fakeInstaller("direct");
    let newer = true;
    const checker = new UpdateChecker({
      currentVersion: "0.2.2",
      fetchImpl: asFetch(async () => releaseResponse({ ...release(newer ? "v0.3.0" : "v0.2.2"), assets: [dmg] })),
      installer,
    });

    await checker.check();
    await waitFor(() => checker.statusSnapshot().state === "ready");

    newer = false;
    const status = await checker.check();
    expect(status.state).toBe("idle");
    expect(status.available).toBe(false);
    expect(status.progress).toBe(0);
  });
});
