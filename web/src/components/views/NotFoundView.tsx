import React from "react";
import { ArrowLeft, Home } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { ROUTES } from "../../routes";

export function NotFoundView() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const handleGoBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(ROUTES.root);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center p-6 bg-[var(--bg-canvas)] text-[var(--text-primary)] font-sans select-text">
      <div className="max-w-md w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 text-center space-y-5">
        <div className="space-y-2">
          <div className="text-4xl font-mono font-bold tracking-tight text-[var(--text-primary)]">
            404
          </div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">
            页面不存在
          </h1>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            未找到路径{" "}
            <code className="px-1.5 py-0.5 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] font-mono text-[11px] text-[var(--text-primary)] break-all">
              {pathname}
            </code>
            ，请检查地址是否正确或返回主页。
          </p>
        </div>

        <div className="flex items-center justify-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={handleGoBack}
            className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium border border-[var(--border-default)] bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回上一页</span>
          </button>
          <button
            type="button"
            onClick={() => navigate(ROUTES.root)}
            className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 transition-opacity cursor-pointer inline-flex items-center gap-1.5"
          >
            <Home className="w-3.5 h-3.5" />
            <span>返回主页</span>
          </button>
        </div>
      </div>
    </div>
  );
}
