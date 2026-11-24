import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertTriangle, Info } from "lucide-react";

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "destructive";
}

type ConfirmContextType = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextType | null>(null);

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return context;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({
    title: "",
    description: "",
  });

  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setOptions(opts);
      setOpen(true);
      resolverRef.current = resolve;
    });
  }, []);

  const handleConfirm = () => {
    setOpen(false);
    resolverRef.current?.(true);
    resolverRef.current = null;
  };

  const handleCancel = () => {
    setOpen(false);
    resolverRef.current?.(false);
    resolverRef.current = null;
  };

  const isDestructive = options.variant === "destructive";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={open}
        onOpenChange={(val: boolean) => {
          if (!val) handleCancel();
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] animate-dialog-overlay" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 grid w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 gap-4 border border-[var(--border-default)] bg-[var(--bg-card)] p-5 shadow-2xl rounded-[var(--radius-md)] select-none animate-dialog-content">
            <div className="flex items-start gap-3">
              <div
                className={`w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 border ${
                  isDestructive
                    ? "bg-red-500/10 border-red-500/20 text-red-500"
                    : "bg-[var(--bg-surface-elevated)] border-[var(--border-default)] text-[var(--text-secondary)]"
                }`}
              >
                {isDestructive ? (
                  <AlertTriangle className="w-4 h-4" />
                ) : (
                  <Info className="w-4 h-4" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialog.Title className="text-sm font-semibold font-mono tracking-tight text-[var(--text-primary)] leading-tight">
                  {options.title}
                </AlertDialog.Title>
                <AlertDialog.Description className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed break-words">
                  {options.description}
                </AlertDialog.Description>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-subtle)]">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="h-7 px-3 text-xs font-mono font-medium rounded-[var(--radius-sm)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer leading-none"
                >
                  {options.cancelText || "Cancel"}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className={`h-7 px-3 text-xs font-mono font-medium rounded-[var(--radius-sm)] transition-colors cursor-pointer leading-none ${
                    isDestructive
                      ? "bg-red-600 hover:bg-red-700 text-white"
                      : "bg-[var(--text-primary)] text-[var(--bg-canvas)] hover:opacity-90"
                  }`}
                >
                  {options.confirmText || "Confirm"}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}
