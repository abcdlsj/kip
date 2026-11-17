import { describe, expect, test } from "bun:test";
import { titleFromPrompt } from "../src/bun/agent/session-bridge";

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
