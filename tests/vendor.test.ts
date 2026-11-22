/**
 * The gemini2api cookie reader is owned by the gemini2api repository and synced
 * here by `bun run sync:cookies`. A hand edit would silently drift, so the pin is
 * checked in CI.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const VENDOR = "src/bun/plugins/gemini2api/vendor/cookies.ts";
const PIN = "src/bun/plugins/gemini2api/vendor/cookies.pin.json";

describe("vendored plugin code", () => {
  test("the cookie reader matches its pin", () => {
    const pin = JSON.parse(readFileSync(PIN, "utf8")) as {
      source: string;
      ref: string;
      sha256: string;
    };
    const actual = createHash("sha256").update(readFileSync(VENDOR)).digest("hex");
    expect(actual).toBe(pin.sha256);
    // Pinned to a commit, not a branch: a branch would move under us.
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.source).toContain(pin.ref);
    expect(pin.source).toContain("integrations/kip/cookies.ts");
  });
});
