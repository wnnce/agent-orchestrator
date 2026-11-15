import React, { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlightHTML } from "@speed-highlight/core";
import { copyToClipboard } from "../../utils/clipboard";

// Comprehensive mapping from standard language identifiers and aliases
// to the 34 native parsers packaged in @speed-highlight/core
const LANGUAGE_ALIASES: Record<string, string> = {
  // Web & Scripting
  javascript: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "css",
  less: "css",

  // Systems & Backend
  python: "py",
  py: "py",
  python3: "py",
  py3: "py",
  go: "go",
  golang: "go",
  rust: "rs",
  rs: "rs",
  c: "c",
  cpp: "c",
  "c++": "c",
  cc: "c",
  cxx: "c",
  h: "c",
  hpp: "c",
  java: "java",
  lua: "lua",
  perl: "pl",
  pl: "pl",
  asm: "asm",
  assembly: "asm",

  // Shell & DevOps
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  fish: "bash",
  docker: "docker",
  dockerfile: "docker",
  make: "make",
  makefile: "make",
  git: "git",
  log: "log",

  // Data & Config
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  properties: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql",
  sqlite: "sql",
  csv: "csv",

  // Docs, Protocols & Utilities
  markdown: "md",
  md: "md",
  diff: "diff",
  patch: "diff",
  http: "http",
  regex: "regex",
  regexp: "regex",
  uri: "uri",
  url: "uri",
  todo: "todo",
  bf: "bf",
  brainfuck: "bf",
  text: "plain",
  txt: "plain",
  plain: "plain",
};

interface CodeBlockProps {
  language?: string;
  code: string;
}

export function CodeBlock({ language = "", code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string>("");

  const rawLang = (language || "").toLowerCase().trim().replace(/^language-/, "");
  const resolvedLang = LANGUAGE_ALIASES[rawLang] || rawLang || "plain";

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const res = await highlightHTML(code, resolvedLang);
        if (!cancelled) {
          setHighlightedHtml(res);
        }
      } catch (err) {
        try {
          const fallback = await highlightHTML(code, "plain");
          if (!cancelled) setHighlightedHtml(fallback);
        } catch {
          if (!cancelled) setHighlightedHtml("");
        }
      }
    }

    highlight();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedLang]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const success = await copyToClipboard(code);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (e) {
      console.error("Failed to copy code block:", e);
    }
  };

  return (
    <div className="relative group my-3 rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-code)] overflow-hidden font-mono text-xs shadow-xs">
      {/* Code Header Bar */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] text-[11px] text-[var(--text-muted)] select-none">
        <span className="font-semibold text-[var(--text-secondary)] lowercase font-mono">
          {rawLang || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          {copied ? (
            <Check className="w-3 h-3 text-emerald-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Speed-highlight rendered code */}
      <div className="p-3.5 overflow-x-auto leading-relaxed">
        {highlightedHtml ? (
          <div
            className="shj-lang font-mono text-[11.5px] whitespace-pre"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="!bg-transparent !p-0 !m-0 font-mono text-[11.5px]">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
