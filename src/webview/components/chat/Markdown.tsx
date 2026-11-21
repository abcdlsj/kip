import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface MarkdownProps {
  children: string;
  streaming?: boolean;
}

export function Markdown({ children, streaming = false }: MarkdownProps) {
  return (
    <div className="markdown-body selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children: preChildren }) => {
            const child = Children.toArray(preChildren)[0];
            if (!isValidElement(child)) return <pre>{preChildren}</pre>;
            const element = child as ReactElement<{ className?: string; children?: ReactNode }>;
            const className = element.props.className ?? "";
            const language = /language-([\w-]+)/.exec(className)?.[1];
            const code = String(element.props.children ?? "").replace(/\n$/, "");
            return <CodeBlock code={code} language={language} streaming={streaming} />;
          },
          code: ({ className, children: codeChildren }) => {
            if (className?.includes("language-")) {
              return <code className={className}>{codeChildren}</code>;
            }
            return <code>{codeChildren}</code>;
          },
          table: ({ children: tableChildren }) => (
            <div className="thin-scroll my-3 overflow-x-auto rounded-[10px] border hairline">
              <table>{tableChildren}</table>
            </div>
          ),
          a: ({ href, children: linkChildren }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
