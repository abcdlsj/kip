/** Lazily created Shiki highlighter shared by all code blocks. */
import { createHighlighter, type Highlighter } from "shiki/bundle/web";

const LANGS = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["vitesse-light", "vitesse-dark"],
      langs: LANGS,
    });
  }
  return highlighterPromise;
}

/** Code blocks follow the app theme instead of staying dark in light mode. */
export function currentShikiTheme(): "vitesse-light" | "vitesse-dark" {
  return document.documentElement.dataset.theme === "dark" ? "vitesse-dark" : "vitesse-light";
}

/** Short fence names models often use. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  golang: "go",
};

export function normalizeLanguage(language: string | undefined): string {
  if (!language) return "text";
  const raw = language.replace(/^language-/, "").toLowerCase();
  const value = ALIASES[raw] ?? raw;
  return LANGS.includes(value) ? value : "text";
}
