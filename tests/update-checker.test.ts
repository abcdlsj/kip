import { describe, expect, test } from "bun:test";
import { isNewerVersion, parseVersion, UpdateChecker } from "../src/bun/system/update-checker";

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
