import React, { useEffect, useState } from "react";
import {
  FolderKanban,
  GitBranch,
  Wrench,
  ArrowRight,
} from "lucide-react";
import { generatePath, useNavigate } from "react-router";
import { projectsApi } from "../../api";
import { useCurrentProject } from "../../layouts/ProjectLayout";
import { ROUTES } from "../../routes";
import type { ProjectSkill } from "../../types";

export function ProjectInfoView() {
  const activeProject = useCurrentProject();
  const activeProjectId = activeProject.projectId;
  const navigate = useNavigate();

  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);

  useEffect(() => {
    if (!activeProjectId) return;
    setLoadingSkills(true);
    projectsApi.listSkills(activeProjectId)
      .then(setSkills)
      .catch((err) => console.error("Failed to fetch skills:", err))
      .finally(() => setLoadingSkills(false));
  }, [activeProjectId]);

  const handleEnterSessions = () => {
    navigate(generatePath(ROUTES.sessions, { projectId: activeProjectId }));
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[var(--bg-canvas)] select-text">
      {/* Project Overview Header */}
      <div className="px-6 py-6 border-b border-[var(--border-default)] bg-[var(--bg-header)]">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {activeProject?.displayName || activeProjectId || "Project Overview"}
              </h1>
              <span className="px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-xs text-[var(--text-muted)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)]">
                {activeProjectId}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
              {activeProject?.summary || "No project description provided."}
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleEnterSessions}
              className="px-3.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--primary)] text-[var(--text-inverted)] hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
            >
              <span>View Sessions</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Body: Vercel-Style Flat Information Sections */}
      <div className="max-w-5xl mx-auto w-full px-6 py-6 space-y-8">
        {/* Section 1: Metadata Grid */}
        <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden">
          <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
            Project Specification & Metadata
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[var(--border-default)]">
            <div className="p-4 space-y-3">
              <div>
                <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Git Repository
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {activeProject?.repository ? (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-xs)] font-mono text-xs bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] break-all">
                      <GitBranch className="w-3 h-3 text-[var(--text-muted)]" />
                      {activeProject.repository}
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">None configured</span>
                  )}
                </div>
              </div>

              <div>
                <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Routing Keywords
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {activeProject?.keywords && activeProject.keywords.length > 0 ? (
                    activeProject.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="px-2 py-0.5 rounded-[var(--radius-xs)] font-mono text-xs bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-secondary)]"
                      >
                        #{kw}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">No keywords defined</span>
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Configuration Directory
                </span>
                <span className="mt-1.5 font-mono text-xs text-[var(--text-secondary)] block truncate">
                  projects/{activeProjectId}
                </span>
              </div>

              <div>
                <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-mono block">
                  Routing Hints
                </span>
                <span className="mt-1.5 text-xs text-[var(--text-secondary)] block">
                  {activeProject?.routingHints?.join(", ") || "Standard multi-project routing"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Loaded Skills Table */}
        <div className="border border-[var(--border-default)] rounded-[var(--radius-sm)] overflow-hidden">
          <div className="px-4 py-2.5 bg-[var(--bg-table-header)] border-b border-[var(--border-default)] flex items-center justify-between">
            <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider font-mono">
              Loaded Skills ({skills.length})
            </span>
            <span className="text-[11px] text-[var(--text-muted)] font-mono">
              .skills/*
            </span>
          </div>

          {loadingSkills ? (
            <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
              Scanning project skills...
            </div>
          ) : skills.length === 0 ? (
            <div className="p-6 text-center text-xs text-[var(--text-muted)] font-mono">
              No custom skills detected in this project's .skills directory.
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-default)]">
              {skills.map((skill) => (
                <div key={skill.id} className="p-4 hover:bg-[var(--bg-surface-hover)] transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Wrench className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        <span className="font-semibold text-xs text-[var(--text-primary)] font-mono">
                          {skill.name || skill.id}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-[var(--radius-xs)] bg-[var(--bg-surface-elevated)] border border-[var(--border-default)] text-[var(--text-muted)]">
                          {skill.id}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        {skill.description || "No description in SKILL.md"}
                      </p>
                    </div>

                    <span className="font-mono text-[11px] text-[var(--text-muted)] shrink-0 hidden md:inline truncate max-w-xs">
                      {skill.skillFilePath}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
