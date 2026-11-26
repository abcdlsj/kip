import { describe, expect, test } from "bun:test";
import {
  domainOfUrl,
  extractCitations,
  mergeCitations,
} from "../src/shared/citations";

describe("citation extraction", () => {
  test("extracts trailing Sources markdown links and strips the footer from body", () => {
    const input = [
      "Today's weather in Shanghai is sunny [1](https://weather.example.com/sh).",
      "",
      "Sources:",
      "- [1] [Shanghai Weather](https://weather.example.com/sh)",
      "- [2] [China Meteorological Administration](https://www.cma.gov.cn/en/)",
    ].join("\n");

    const { body, sources } = extractCitations(input);
    expect(body).toBe(
      "Today's weather in Shanghai is sunny [1](https://weather.example.com/sh).",
    );
    expect(sources).toEqual([
      {
        id: 1,
        title: "Shanghai Weather",
        url: "https://weather.example.com/sh",
        domain: "weather.example.com",
      },
      {
        id: 2,
        title: "China Meteorological Administration",
        url: "https://www.cma.gov.cn/en/",
        domain: "cma.gov.cn",
      },
    ]);
  });

  test("resolves legacy inline [cite: N] markers against extracted sources", () => {
    const input = [
      "Gemini supports search grounding [cite: 1, 2].",
      "",
      "Sources:",
      "- [1] [Google AI](https://ai.google.dev)",
      "- [2] [Docs](https://docs.example.org/search)",
    ].join("\n");

    const { body, sources } = extractCitations(input);
    expect(body).toBe(
      "Gemini supports search grounding [1](https://ai.google.dev) [2](https://docs.example.org/search).",
    );
    expect(sources).toHaveLength(2);
  });

  test("leaves ordinary prose lists untouched when bullets are not citation links", () => {
    const input = "Sources:\n- local file a.ts\n- local file b.ts";
    const { body, sources } = extractCitations(input);
    expect(body).toBe(input);
    expect(sources).toEqual([]);
  });

  test("deduplicates merged citations by URL", () => {
    const merged = mergeCitations([
      [
        {
          id: 1,
          title: "A",
          url: "https://a.com",
          domain: domainOfUrl("https://a.com"),
        },
      ],
      [
        { id: 1, title: "A dup", url: "https://a.com", domain: "a.com" },
        { id: 2, title: "B", url: "https://b.com", domain: "b.com" },
      ],
    ]);
    expect(merged.map((s) => s.url)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});
