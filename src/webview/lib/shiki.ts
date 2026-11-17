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

export function currentShikiTheme(): "vitesse-dark" {
  return "vitesse-dark";
}

export function normalizeLanguage(language: string | undefined): string {
  if (!language) return "text";
  const value = language.replace(/^language-/, "").toLowerCase();
  return LANGS.includes(value) ? value : "text";
}
