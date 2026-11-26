/**
 * Lightweight ANSI syntax highlighter for Kip TUI Markdown code blocks.
 * Reuses `highlight.js/lib/core` (already bundled via Pi) with Kip's warm
 * Obsidian / Alabaster syntax palette and zero filesystem theme lookups.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export interface SyntaxTheme {
  keyword: (text: string) => string;
  string: (text: string) => string;
  number: (text: string) => string;
  func: (text: string) => string;
  type: (text: string) => string;
  comment: (text: string) => string;
  operator: (text: string) => string;
  addition: (text: string) => string;
  deletion: (text: string) => string;
  plain: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
}

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

let registered = false;

function ensureLanguagesRegistered(): void {
  if (registered) return;
  registered = true;
  for (const [name, grammar] of Object.entries(LANGUAGES)) {
    if (!hljs.getLanguage(name)) {
      hljs.registerLanguage(name, grammar);
    }
  }
}

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
  toml: "ini",
  html: "xml",
  htm: "xml",
  svg: "xml",
  md: "markdown",
  cs: "csharp",
  kt: "kotlin",
  docker: "dockerfile",
  make: "makefile",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  h: "c",
  patch: "diff",
};

function resolveLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  ensureLanguagesRegistered();
  const normalized = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!normalized) return undefined;
  const candidate = LANG_ALIASES[normalized] ?? normalized;
  return hljs.getLanguage(candidate) ? candidate : undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
};

function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#x27|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, dec?: string, hex?: string) => {
      if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[match] ?? match;
    },
  );
}

function buildScopeMap(
  theme: SyntaxTheme,
): Record<string, (text: string) => string> {
  return {
    keyword: theme.keyword,
    "selector-tag": theme.keyword,
    "meta-keyword": theme.keyword,
    tag: theme.keyword,
    name: theme.keyword,
    string: theme.string,
    regexp: theme.string,
    "template-variable": theme.string,
    "meta-string": theme.string,
    addition: theme.addition,
    deletion: theme.deletion,
    number: theme.number,
    literal: theme.number,
    symbol: theme.number,
    bullet: theme.number,
    function: theme.func,
    title: theme.func,
    section: theme.func,
    "selector-id": theme.func,
    type: theme.type,
    class: theme.type,
    built_in: theme.type,
    builtin: theme.type,
    attr: theme.type,
    attribute: theme.type,
    "selector-class": theme.type,
    comment: theme.comment,
    doctag: theme.comment,
    quote: theme.comment,
    meta: theme.comment,
    operator: theme.operator,
    punctuation: theme.operator,
    variable: theme.plain,
    params: theme.plain,
    property: theme.plain,
    subst: theme.plain,
    emphasis: theme.italic,
    strong: theme.bold,
  };
}

function pickScopeFormatter(
  scopes: Array<string | undefined>,
  map: Record<string, (text: string) => string>,
  fallback: (text: string) => string,
): (text: string) => string {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i];
    if (!scope) continue;
    if (map[scope]) return map[scope]!;
    const dot = scope.indexOf(".");
    if (dot !== -1 && map[scope.slice(0, dot)]) {
      return map[scope.slice(0, dot)]!;
    }
    const dash = scope.indexOf("-");
    if (dash !== -1 && map[scope.slice(0, dash)]) {
      return map[scope.slice(0, dash)]!;
    }
  }
  return fallback;
}

function extractHljsScope(tag: string): string | undefined {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  for (const part of raw.split(/\s+/)) {
    if (part.startsWith("hljs-")) {
      return part.slice("hljs-".length);
    }
  }
  return undefined;
}

function renderHljsHtmlToAnsi(
  html: string,
  map: Record<string, (text: string) => string>,
  fallback: (text: string) => string,
): string {
  let out = "";
  let buf = "";
  const scopes: Array<string | undefined> = [];

  const flush = () => {
    if (!buf) return;
    const decoded = decodeHtmlEntities(buf);
    const fmt = pickScopeFormatter(scopes, map, fallback);
    // Format each line independently so ANSI state never leaks across wrapped lines.
    out += decoded
      .split("\n")
      .map((line) => (line ? fmt(line) : line))
      .join("\n");
    buf = "";
  };

  let idx = 0;
  while (idx < html.length) {
    if (html.startsWith("<span", idx)) {
      const next = html[idx + 5];
      if (next === ">" || next === " " || next === "\t" || next === "\n") {
        const end = html.indexOf(">", idx + 5);
        if (end !== -1) {
          flush();
          scopes.push(extractHljsScope(html.slice(idx, end + 1)));
          idx = end + 1;
          continue;
        }
      }
    }
    if (html.startsWith("</span>", idx)) {
      flush();
      if (scopes.length > 0) scopes.pop();
      idx += "</span>".length;
      continue;
    }
    buf += html[idx]!;
    idx += 1;
  }
  flush();
  return out;
}

/**
 * Highlights a fenced code block into ANSI-styled lines.
 * Falls back to `theme.plain` when no known language is declared so prose
 * inside unlabeled fences is never mis-highlighted.
 */
export function highlightCodeBlock(
  code: string,
  lang: string | undefined,
  theme: SyntaxTheme,
): string[] {
  const resolved = resolveLanguage(lang);
  if (!resolved) {
    return code.split("\n").map((line) => (line ? theme.plain(line) : ""));
  }
  try {
    const html = hljs.highlight(code, {
      language: resolved,
      ignoreIllegals: true,
    }).value;
    const scopeMap = buildScopeMap(theme);
    return renderHljsHtmlToAnsi(html, scopeMap, theme.plain).split("\n");
  } catch {
    return code.split("\n").map((line) => (line ? theme.plain(line) : ""));
  }
}
