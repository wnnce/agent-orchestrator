import React, { useState, useRef, useEffect, useCallback } from "react";
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2, Move } from "lucide-react";

interface ZoomableCanvasProps {
  children: React.ReactNode;
  className?: string;
  minScale?: number;
  maxScale?: number;
  initialScale?: number;
  initialHeight?: string;
  allowFullscreen?: boolean;
}

export function ZoomableCanvas({
  children,
  className = "",
  minScale = 0.2,
  maxScale = 5,
  initialScale = 1,
  initialHeight = "h-[340px]",
  allowFullscreen = true,
}: ZoomableCanvasProps) {
  const [scale, setScale] = useState(initialScale);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastTouchDistRef = useRef<number | null>(null);

  // Reset to initial centered state
  const handleReset = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  // Zoom by step centered around container center
  const handleZoomStep = (factor: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    setScale((prevScale) => {
      const nextScale = Math.min(Math.max(prevScale * factor, minScale), maxScale);
      const ratio = nextScale / prevScale;
      setTranslate((prev) => ({
        x: cx - (cx - prev.x) * ratio,
        y: cy - (cy - prev.y) * ratio,
      }));
      return nextScale;
    });
  };

  // Trackpad / Wheel Handler:
  // - 2-finger slide (no ctrlKey): PAN / TRANSLATE canvas smoothly
  // - Pinch-to-zoom (ctrlKey / metaKey): ZOOM in/out centered around cursor
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Trackpad pinch-to-zoom or Ctrl/Cmd + wheel zoom
      if (e.ctrlKey || e.metaKey) {
        const rect = container.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        // Exponential smooth zoom factor based on pinch gesture velocity
        const zoomFactor = Math.pow(0.995, e.deltaY);

        setScale((prevScale) => {
          const nextScale = Math.min(Math.max(prevScale * zoomFactor, minScale), maxScale);
          const ratio = nextScale / prevScale;
          setTranslate((prevTranslate) => ({
            x: cursorX - (cursorX - prevTranslate.x) * ratio,
            y: cursorY - (cursorY - prevTranslate.y) * ratio,
          }));
          return nextScale;
        });
      } else {
        // Trackpad 2-finger slide or normal mouse wheel: PAN the canvas in 2D
        setTranslate((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [minScale, maxScale]);

  // Mouse drag & pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - translate.x,
      y: e.clientY - translate.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setTranslate({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch drag & pinch-to-zoom
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0]!;
      setIsDragging(true);
      dragStartRef.current = {
        x: touch.clientX - translate.x,
        y: touch.clientY - translate.y,
      };
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0]!;
      const t2 = e.touches[1]!;
      lastTouchDistRef.current = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0]!;
      setTranslate({
        x: touch.clientX - dragStartRef.current.x,
        y: touch.clientY - dragStartRef.current.y,
      });
    } else if (e.touches.length === 2 && lastTouchDistRef.current !== null) {
      const t1 = e.touches[0]!;
      const t2 = e.touches[1]!;
      const newDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const factor = newDist / lastTouchDistRef.current;
      lastTouchDistRef.current = newDist;

      setScale((prev) => Math.min(Math.max(prev * factor, minScale), maxScale));
    }
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
    lastTouchDistRef.current = null;
  };

  // Handle ESC key to exit fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  const canvasContent = (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onDoubleClick={handleReset}
      className={`relative w-full overflow-hidden select-none cursor-grab active:cursor-grabbing bg-[var(--bg-canvas)] ${
        isFullscreen ? "h-full flex-1" : initialHeight
      } ${className}`}
    >
      {/* Zoomable & Pannable Viewport (No will-change to allow browser vector re-rasterization) */}
      <div
        className="w-full h-full flex items-center justify-center [transform:translateZ(0)]"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <div className="pointer-events-auto max-w-none">{children}</div>
      </div>

      {/* Direct Frameless Icon Buttons (No Card / Pill Wrapper) */}
      <div
        className="absolute bottom-2.5 right-2.5 z-10 flex items-center gap-0.5 pointer-events-auto select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => handleZoomStep(0.8)}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={handleReset}
          className="px-1 h-6 flex items-center justify-center text-[10px] font-mono rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
          title="Reset to 100% and Center (Double-click canvas)"
        >
          {Math.round(scale * 100)}%
        </button>

        <button
          type="button"
          onClick={() => handleZoomStep(1.2)}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={handleReset}
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
          title="Reset View"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>

        {allowFullscreen && (
          <button
            type="button"
            onClick={() => setIsFullscreen((prev) => !prev)}
            className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
            title={isFullscreen ? "Exit Fullscreen (Esc)" : "Expand Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-[var(--bg-canvas)] flex flex-col overflow-hidden animate-in fade-in-50 duration-150">
        <div className="h-10 px-4 bg-[var(--bg-header)] border-b border-[var(--border-default)] flex items-center justify-between select-none">
          <span className="text-xs font-mono text-[var(--text-primary)] font-medium flex items-center gap-1.5">
            <Move className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span>Interactive Diagram Canvas</span>
          </span>
          <button
            type="button"
            onClick={() => setIsFullscreen(false)}
            className="px-2.5 py-1 text-xs font-mono rounded-[var(--radius-sm)] bg-[var(--bg-surface-hover)] hover:bg-[var(--border-strong)] text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            Exit (Esc)
          </button>
        </div>
        <div className="flex-1 relative overflow-hidden">{canvasContent}</div>
      </div>
    );
  }

  return canvasContent;
}
