import { describe, expect, test } from "bun:test";
import { stripKipNotes, titleFromPrompt } from "../src/bun/agent/session-bridge";

describe("thread titles", () => {
  test("keeps short prompts intact", () => {
    expect(titleFromPrompt("Explain this codebase")).toBe("Explain this codebase");
  });

  test("prefers the instruction after then", () => {
    expect(
      titleFromPrompt(
        "Read README.md and docs/DEVELOPMENT_PLAN.md, then summarize Kip in three short bullets. Do not run shell commands.",
      ),
    ).toBe("Summarize Kip in three short bullets");
  });

  test("strips code fence noise", () => {
    expect(titleFromPrompt("```ts\nconst x = 1\n``` fix the type error")).toBe("Fix the type error");
  });

  test("falls back for empty prompts", () => {
    expect(titleFromPrompt("   ")).toBe("New Thread");
  });
});

describe("kip notes", () => {
  test("hides notes Kip prepended to a prompt", () => {
    expect(stripKipNotes("[Kip note] The user undid a.ts.\n\nNow add tests")).toBe("Now add tests");
    expect(stripKipNotes("Plain prompt")).toBe("Plain prompt");
  });
});
