import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { EASE_OUT_EXPO } from "../../utils/motion";

export type ResizeEdge = "left" | "right" | "top" | "bottom";

export interface ResizablePaneProps {
  /** Which edge of this pane carries the drag resize handle. */
  edge: ResizeEdge;
  /** Default size in pixels (width for left/right, height for top/bottom). */
  defaultSize: number;
  /** Minimum allowed size in pixels. */
  minSize: number;
  /** Maximum allowed size in pixels. */
  maxSize: number;
  /** Optional localStorage key to persist user-resized dimension across reloads. */
  storageKey?: string;
  /** Whether the pane is visible; toggles with a smooth slide animation. Defaults to true. */
  open?: boolean;
  /** Optional callback fired whenever size changes. */
  onSizeChange?: (size: number) => void;
  /** Optional className for the inner content container. */
  className?: string;
  children: React.ReactNode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredSize(
  storageKey: string | undefined,
  defaultSize: number,
  minSize: number,
  maxSize: number,
): number {
  if (!storageKey || typeof window === "undefined") {
    return clamp(defaultSize, minSize, maxSize);
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return clamp(defaultSize, minSize, maxSize);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return clamp(defaultSize, minSize, maxSize);
    return clamp(parsed, minSize, maxSize);
  } catch {
    return clamp(defaultSize, minSize, maxSize);
  }
}

export function ResizablePane({
  edge,
  defaultSize,
  minSize,
  maxSize,
  storageKey,
  open = true,
  onSizeChange,
  className = "",
  children,
}: ResizablePaneProps) {
  const isHorizontal = edge === "left" || edge === "right";
  const [size, setSize] = useState<number>(() =>
    readStoredSize(storageKey, defaultSize, minSize, maxSize),
  );
  const [isDragging, setIsDragging] = useState(false);

  const dragStartRef = useRef<{ pointer: number; size: number } | null>(null);
  const latestSizeRef = useRef(size);
  latestSizeRef.current = size;

  const commitSize = useCallback(
    (next: number, persist = false) => {
      const clamped = clamp(next, minSize, maxSize);
      setSize(clamped);
      onSizeChange?.(clamped);
      if (persist && storageKey && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(storageKey, String(clamped));
        } catch {
          /* ignore storage quota/privacy errors */
        }
      }
    },
    [minSize, maxSize, onSizeChange, storageKey],
  );

  // Re-clamp if min/max constraints change dynamically
  useEffect(() => {
    setSize((prev) => clamp(prev, minSize, maxSize));
  }, [minSize, maxSize]);

  useEffect(() => {
    if (!isDragging) return;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const currentPointer = isHorizontal ? e.clientX : e.clientY;
      const delta = currentPointer - start.pointer;
      const signedDelta = edge === "right" || edge === "bottom" ? delta : -delta;
      commitSize(start.size + signedDelta, false);
    };

    const handlePointerUp = () => {
      dragStartRef.current = null;
      setIsDragging(false);
      if (storageKey && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(storageKey, String(latestSizeRef.current));
        } catch {
          /* ignore */
        }
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isDragging, isHorizontal, edge, commitSize, storageKey]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragStartRef.current = {
      pointer: isHorizontal ? e.clientX : e.clientY,
      size: latestSizeRef.current,
    };
    setIsDragging(true);
  };

  const handleDoubleClick = () => {
    commitSize(defaultSize, true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 16;
    if (isHorizontal) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        commitSize(size + (edge === "right" ? step : -step), true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        commitSize(size + (edge === "right" ? -step : step), true);
      }
    } else {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        commitSize(size + (edge === "bottom" ? step : -step), true);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        commitSize(size + (edge === "bottom" ? -step : step), true);
      }
    }
    if (e.key === "Home") {
      e.preventDefault();
      commitSize(defaultSize, true);
    }
  };

  const handlePositionClass =
    edge === "right"
      ? "top-0 bottom-0 right-0 w-1.5 cursor-col-resize"
      : edge === "left"
        ? "top-0 bottom-0 left-0 w-1.5 cursor-col-resize"
        : edge === "bottom"
          ? "left-0 right-0 bottom-0 h-1.5 cursor-row-resize"
          : "left-0 right-0 top-0 h-1.5 cursor-row-resize";

  const indicatorClass =
    edge === "right"
      ? "top-0 bottom-0 right-0 w-[2px]"
      : edge === "left"
        ? "top-0 bottom-0 left-0 w-[2px]"
        : edge === "bottom"
          ? "left-0 right-0 bottom-0 h-[2px]"
          : "left-0 right-0 top-0 h-[2px]";

  const animatedDimension = isHorizontal
    ? {
        initial: { width: 0, opacity: 0 },
        animate: { width: size, opacity: 1 },
        exit: { width: 0, opacity: 0 },
      }
    : {
        initial: { height: 0, opacity: 0 },
        animate: { height: size, opacity: 1 },
        exit: { height: 0, opacity: 0 },
      };

  const innerStyle: React.CSSProperties = isHorizontal
    ? { width: size, minWidth: size }
    : { height: size, minHeight: size };

  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          key={`resizable-pane-${edge}`}
          initial={animatedDimension.initial}
          animate={animatedDimension.animate}
          exit={animatedDimension.exit}
          transition={{ duration: isDragging ? 0 : 0.22, ease: EASE_OUT_EXPO }}
          className={`relative shrink-0 overflow-hidden flex ${
            isHorizontal ? "h-full" : "w-full"
          }`}
        >
          <div
            style={innerStyle}
            className={`flex flex-col overflow-hidden ${
              isHorizontal ? "h-full" : "w-full"
            } ${className}`}
          >
            {children}
          </div>

          {/* Drag Resize Handle */}
          <div
            role="separator"
            tabIndex={0}
            aria-orientation={isHorizontal ? "vertical" : "horizontal"}
            aria-valuenow={size}
            aria-valuemin={minSize}
            aria-valuemax={maxSize}
            title="拖拽调整尺寸，双击恢复默认"
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            className={`group/resize absolute z-30 select-none touch-none outline-none ${handlePositionClass}`}
          >
            <span
              className={`absolute transition-colors duration-150 ${indicatorClass} ${
                isDragging
                  ? "bg-[var(--border-focus)]"
                  : "bg-transparent group-hover/resize:bg-[var(--border-focus)]/45 group-focus-visible/resize:bg-[var(--border-focus)]"
              }`}
            />
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
