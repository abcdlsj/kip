import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
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
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [code, lang, streaming]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-4 overflow-hidden rounded-[10px] border hairline bg-[var(--bg-code)]">
      <div className="flex h-8 items-center justify-between border-b hairline px-3">
        <span className="text-meta uppercase tracking-[0.06em] text-[var(--text-muted)]">
          {lang === "text" ? "code" : lang}
        </span>
        <button
          onClick={copy}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-secondary)]"
          aria-label="Copy code"
        >
          {copied ? <Check size={13} strokeWidth={1.5} /> : <Copy size={13} strokeWidth={1.5} />}
        </button>
      </div>
      {html ? (
        <div
          className="selectable overflow-x-auto p-4 text-[12.5px] leading-relaxed [&_pre]:!bg-transparent [&_code]:font-[var(--font-mono)]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="selectable overflow-x-auto p-4 font-[var(--font-mono)] text-[12.5px] leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
