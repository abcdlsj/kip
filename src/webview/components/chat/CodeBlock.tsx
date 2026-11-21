import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { currentShikiTheme, getHighlighter, normalizeLanguage } from "../../lib/shiki";

interface CodeBlockProps {
  code: string;
  language?: string;
  streaming?: boolean;
}

export function CodeBlock({ code, language, streaming = false }: CodeBlockProps) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lang = normalizeLanguage(language);

  useEffect(() => {
    let cancelled = false;
    const render = () => {
      void getHighlighter()
        .then((highlighter) => {
          if (cancelled) return;
          const loaded = highlighter.getLoadedLanguages();
          const useLang = lang === "text" || loaded.includes(lang) ? lang : "text";
          setHtml(
            highlighter.codeToHtml(code, {
              lang: useLang,
              theme: currentShikiTheme(),
            }),
          );
        })
        .catch(() => setHtml(""));
    };

    if (streaming) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(render, 180);
    } else {
      render();
    }
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [code, lang, streaming]);

  useEffect(() => {
    if (streaming) return;
    const observer = new MutationObserver(() => {
      void getHighlighter().then((highlighter) => {
        const loaded = highlighter.getLoadedLanguages();
        const useLang = lang === "text" || loaded.includes(lang) ? lang : "text";
        setHtml(
          highlighter.codeToHtml(code, { lang: useLang, theme: currentShikiTheme() }),
        );
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [code, lang, streaming]);

  const copy = async () => {
    const ok = await copyText(code);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/code my-4 overflow-hidden rounded-[12px] border border-[var(--code-border)] bg-[var(--bg-code-block)]">
      <div className="flex h-8 items-center justify-between border-b border-[var(--code-border)] px-3">
        <span className="font-mono text-[11.5px] text-[var(--code-muted)]">
          {lang === "text" ? "code" : lang}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className={`btn-ghost h-6 gap-1 rounded-[6px] px-1.5 text-[11.5px] transition-opacity ${
            copied
              ? "text-[var(--status-ok)] opacity-100"
              : "text-[var(--code-muted)] opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100"
          }`}
          aria-label="Copy code"
        >
          {copied ? <Check size={12} strokeWidth={1.7} /> : <Copy size={12} strokeWidth={1.5} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {html ? (
        <div
          className="selectable thin-scroll overflow-x-auto px-4 py-3 text-[13px] leading-[1.6] text-[var(--code-text)] [&_pre]:!bg-transparent [&_code]:font-mono"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="selectable thin-scroll overflow-x-auto px-4 py-3 font-mono text-[13px] leading-[1.6] text-[var(--code-text)]">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
