import React, { useMemo } from "react";
import { Streamdown, type Components } from "streamdown";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { ZoomableCanvas } from "./ZoomableCanvas";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function extractCodeText(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join("");
  if (node && typeof node === "object" && node.props && node.props.children) {
    return extractCodeText(node.props.children);
  }
  return String(node ?? "");
}

const customComponents: Components = {
  inlineCode({ children, ...props }: any) {
    return (
      <code
        className="px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] font-mono text-[11.5px] text-[var(--text-primary)]"
        {...props}
      >
        {children}
      </code>
    );
  },
  code({ node, className: codeClass, children, ...props }: any) {
    const match = /language-(\w+)/.exec(codeClass || "");
    const lang = match ? match[1] : "";
    const codeString = extractCodeText(children).replace(/\n$/, "");

    if (lang === "mermaid") {
      return <MermaidBlock code={codeString} />;
    }

    if (match || codeString.includes("\n")) {
      return <CodeBlock language={lang} code={codeString} />;
    }

    return (
      <code
        className="px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] font-mono text-[11.5px] text-[var(--text-primary)]"
        {...props}
      >
        {children}
      </code>
    );
  },
  table({ children }: any) {
    return (
      <div className="overflow-x-auto my-3 border border-[var(--border-default)] rounded-[var(--radius-sm)]">
        <table className="w-full border-collapse text-xs font-mono">{children}</table>
      </div>
    );
  },
  thead({ children }: any) {
    return (
      <thead className="bg-[var(--bg-table-header)] border-b border-[var(--border-default)]">
        {children}
      </thead>
    );
  },
  th({ children }: any) {
    return (
      <th className="px-3 py-2 text-left font-semibold text-[var(--text-primary)] border-r border-[var(--border-subtle)] last:border-r-0">
        {children}
      </th>
    );
  },
  td({ children }: any) {
    return (
      <td className="px-3 py-1.5 text-[var(--text-secondary)] border-t border-[var(--border-subtle)] border-r last:border-r-0">
        {children}
      </td>
    );
  },
  a({ href, children }: any) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-500 hover:text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400 font-medium"
      >
        {children}
      </a>
    );
  },
  blockquote({ children }: any) {
    return (
      <blockquote className="border-l-2 border-[var(--border-strong)] pl-3.5 my-2.5 text-xs text-[var(--text-muted)] italic">
        {children}
      </blockquote>
    );
  },
  ul({ children }: any) {
    return <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>;
  },
  ol({ children }: any) {
    return <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>;
  },
  p({ children }: any) {
    return <p className="my-1.5 leading-relaxed">{children}</p>;
  },
  h1({ children }: any) {
    return (
      <h1 className="text-base font-bold tracking-tight text-[var(--text-primary)] mt-3.5 mb-1.5 font-mono">
        {children}
      </h1>
    );
  },
  h2({ children }: any) {
    return (
      <h2 className="text-sm font-semibold tracking-tight text-[var(--text-primary)] mt-3 mb-1 font-mono">
        {children}
      </h2>
    );
  },
  h3({ children }: any) {
    return (
      <h3 className="text-xs font-semibold text-[var(--text-primary)] mt-2.5 mb-1 font-mono">
        {children}
      </h3>
    );
  },
  hr() {
    return <hr className="my-3 border-t border-[var(--border-default)]" />;
  },
  img({ src, alt }: any) {
    return (
      <div className="my-3 border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden bg-[var(--bg-surface)]">
        {alt && (
          <div className="px-3 py-1 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between text-[11px] font-mono text-[var(--text-muted)] select-none">
            <span className="truncate max-w-sm">{alt}</span>
          </div>
        )}
        <ZoomableCanvas initialHeight="min-h-[220px] h-[320px]">
          <img
            src={src}
            alt={alt}
            className="max-h-[300px] max-w-none object-contain pointer-events-none select-none rounded-[var(--radius-xs)] shadow-sm"
          />
        </ZoomableCanvas>
      </div>
    );
  },
};

export function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  return (
    <div
      className={`prose prose-sm max-w-none text-[var(--text-primary)] leading-relaxed break-words dark:prose-invert font-sans ${className}`}
    >
      <Streamdown components={customComponents}>
        {content || ""}
      </Streamdown>
    </div>
  );
}
