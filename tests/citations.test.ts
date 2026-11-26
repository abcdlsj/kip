import { describe, expect, test } from "bun:test";
import {
  domainOfUrl,
  extractCitations,
  extractElicitations,
  mergeCitations,
  parseReplyContent,
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

  test("extracts multiline ElicitationsGroup follow-ups and cleans CJK wraps", () => {
    const input = `这里是今天的新闻汇总。

<ElicitationsGroup message="如果想深挖其中某条动态：">
   <Elicitation label="展开看看 Claude Ship 和 AWS 决策模型的技术细节"
 query="展开介绍一下 Anthropic Claude Ship、AWS Strands Decider v2 和星辰
 4.1 的核心技术细节与适用场景。"/>
   <Elicitation label="复盘黄仁勋被调查及复职英伟达 CEO 的来龙去脉"
 query="梳理一下最近英伟达调查黄仁勋以及董事会恢复其 CEO 职务的完整经过和
 市场反应。"/>
   <Elicitation label="查看 TGA 2026 最佳独立游戏等完整提名与看点" query="
 帮我查一下 TGA 2026 最佳独立游戏、最佳动作游戏等完整提名名单和主要看点。
 "/>
 </ElicitationsGroup>

Sources:
- [1] [Tech News](https://news.example.com/ai)`;

    const parsed = parseReplyContent(input);
    expect(parsed.body).toBe("这里是今天的新闻汇总。");
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]?.domain).toBe("news.example.com");
    expect(parsed.elicitations).toEqual({
      message: "如果想深挖其中某条动态：",
      items: [
        {
          label: "展开看看 Claude Ship 和 AWS 决策模型的技术细节",
          query:
            "展开介绍一下 Anthropic Claude Ship、AWS Strands Decider v2 和星辰 4.1 的核心技术细节与适用场景。",
        },
        {
          label: "复盘黄仁勋被调查及复职英伟达 CEO 的来龙去脉",
          query:
            "梳理一下最近英伟达调查黄仁勋以及董事会恢复其 CEO 职务的完整经过和市场反应。",
        },
        {
          label: "查看 TGA 2026 最佳独立游戏等完整提名与看点",
          query:
            "帮我查一下 TGA 2026 最佳独立游戏、最佳动作游戏等完整提名名单和主要看点。",
        },
      ],
    });
  });

  test("extractElicitations leaves plain replies untouched", () => {
    const plain = "Just a normal answer with <div>html</div>.";
    expect(extractElicitations(plain)).toEqual({
      body: plain,
      elicitations: null,
    });
  });
});
