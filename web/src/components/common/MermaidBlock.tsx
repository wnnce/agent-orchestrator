import React, { useMemo, useState } from "react";
import { Copy, Check, AlertCircle, Eye, Code } from "lucide-react";
import { renderMermaidSVG } from "beautiful-mermaid";
import { useTheme } from "../../context/ThemeContext";
import { ZoomableCanvas } from "./ZoomableCanvas";
import { copyToClipboard } from "../../utils/clipboard";

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const { theme } = useTheme();
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);

  const isDark = theme === "dark" || theme === "cyber";

  // High-contrast, theme-synchronized diagram palette
  // Directly controls event message labels, lines, borders, and actors
  const themeColors = useMemo(() => {
    return isDark
      ? {
          bg: "#000000",
          fg: "#ededed",
          muted: "#ededed", // High-contrast readable event/message text (avoids 40% faint gray)
          line: "#71717a",  // Zinc-500: crisp connector & lifelines
          accent: "#60a5fa", // Blue-400: sharp visible arrowheads
          surface: "#111111", // Distinct node card background
          border: "#333333",  // Clear border stroke
        }
      : {
          bg: "#ffffff",
          fg: "#171717",
          muted: "#171717", // High-contrast deep text for event/messages
          line: "#a1a1aa",  // Zinc-400
          accent: "#2563eb", // Blue-600
          surface: "#f5f5f5",
          border: "#d4d4d8",
        };
  }, [isDark]);

  const { svgHtml, error } = useMemo(() => {
    try {
      const svg = renderMermaidSVG(code.trim(), {
        ...themeColors,
        transparent: true,
        font: "Inter",
      });
      return { svgHtml: svg, error: null };
    } catch (err: any) {
      console.warn("beautiful-mermaid render error:", err);
      return { svgHtml: "", error: err?.message || "Failed to render Mermaid diagram" };
    }
  }, [code, themeColors]);

  // Enhance SVG with 2x native base DPI resolution and geometric vector precision
  const enhancedSvgHtml = useMemo(() => {
    if (!svgHtml) return "";
    return svgHtml.replace(
      /<svg\s([^>]*?)width="([\d.]+)"\s+height="([\d.]+)"/,
      (_match: string, prefix: string, w: string, h: string) => {
        const nw = (parseFloat(w) * 2).toFixed(1);
        const nh = (parseFloat(h) * 2).toFixed(1);
        return `<svg ${prefix}width="${nw}" height="${nh}" shape-rendering="geometricPrecision" text-rendering="geometricPrecision"`;
      }
    );
  }, [svgHtml]);

  const handleCopy = async (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      const success = await copyToClipboard(code);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (e) {
      console.error("Failed to copy mermaid diagram:", e);
    }
  };

  if (error || showCode) {
    return (
      <div className="my-3 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] overflow-hidden text-xs font-mono">
        <div className="px-3.5 py-1.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between select-none">
          <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
            {error ? (
              <span className="text-amber-500 flex items-center gap-1 text-[11px]">
                <AlertCircle className="w-3.5 h-3.5" />
                Mermaid Syntax Error
              </span>
            ) : (
              <span className="text-[11px]">Mermaid Source</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!error && (
              <button
                type="button"
                onClick={() => setShowCode(false)}
                className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer text-[11px]"
              >
                <Eye className="w-3 h-3" />
                <span>Preview</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer text-[11px]"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </div>
        <pre className="p-3.5 overflow-x-auto text-[11px] text-[var(--text-secondary)] leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-3 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] overflow-hidden text-xs">
      <div className="px-3.5 py-1.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between select-none">
        <span className="text-[11px] font-mono text-[var(--text-muted)] font-medium">
          Diagram (Mermaid)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCode(true)}
            className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-[11px] font-mono"
            title="View Mermaid Source"
          >
            <Code className="w-3 h-3" />
            <span>Source</span>
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-[11px] font-mono"
            title="Copy Diagram Code"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <ZoomableCanvas initialHeight="min-h-[280px] h-[380px]" initialScale={0.75}>
        <div
          className="mermaid-diagram-viewer flex items-center justify-center p-6 [&>svg]:max-w-none [&>svg]:h-auto [&_svg]:[shape-rendering:geometricPrecision] [&_svg]:[text-rendering:geometricPrecision]"
          dangerouslySetInnerHTML={{ __html: enhancedSvgHtml }}
        />
      </ZoomableCanvas>
    </div>
  );
}
