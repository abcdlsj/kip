declare module "highlight.js/lib/core" {
  interface HighlightResult {
    value: string;
  }
  type LanguageFn = (hljs?: unknown) => unknown;
  const hljs: {
    highlight(
      code: string,
      options: { language: string; ignoreIllegals?: boolean },
    ): HighlightResult;
    getLanguage(name: string): unknown;
    registerLanguage(name: string, language: LanguageFn): void;
  };
  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  const grammar: (hljs?: unknown) => unknown;
  export default grammar;
}
