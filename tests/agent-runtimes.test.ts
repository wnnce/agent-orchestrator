import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/domain/errors.ts";
import type { ProjectConfig, SessionRoute } from "../src/domain/types.ts";
import { MemoryEventHub } from "../src/events/hub.ts";
import { Logger } from "../src/observability/logger.ts";
import { MemoryStore } from "../src/persistence/store.ts";
import { FakeRuntime, type AgentRuntime } from "../src/runtime/runtime.ts";
import { AgentRuntimes, normalizeRuntimeName } from "../src/session/agents.ts";
import { SessionEvents } from "../src/session/events.ts";

/** A fake runtime under another name, as a runtime factory would create it. */
function namedRuntime(name: string): AgentRuntime {
  return Object.assign(new FakeRuntime(), { name });
}

const project: ProjectConfig = {
  id: "agents",
  displayName: "Agents",
  description: "test",
  routing: { projectId: "agents" },
  repository: { url: "", baseBranch: "main" },
  runtime: { type: "fake", model: "project-model", reasoningEffort: "high" },
};

function agentRuntimes(available: string[] = ["other"]) {
  const store = new MemoryStore();
  const created: string[] = [];
  const agents = new AgentRuntimes({
    project,
    defaultRuntime: new FakeRuntime(),
    runtimeFactory: (type) => {
      if (!available.includes(type)) throw new Error(`unknown runtime ${type}`);
      created.push(type);
      return namedRuntime(type);
    },
    readOnly: false,
    events: new SessionEvents(store, new MemoryEventHub(store)),
    logger: new Logger({ sink: () => {} }),
    toolsFor: () => ({ specs: [], call: async () => ({ ok: true, text: "" }) }),
    onEvent: async () => {},
  });
  return { agents, created };
}

function route(fields: Partial<SessionRoute>): SessionRoute {
  return {
    sessionId: "ses_1",
    projectId: project.id,
    projectRuntimeId: `project-runtime:${project.id}`,
    runtimeSessionId: null,
    configRevision: 1,
    status: "active",
    lastActiveAt: new Date().toISOString(),
    ...fields,
  };
}

describe("agent runtime settings", () => {
  test("runtime names are trimmed and lowercased; blank and unknown mean none asked", () => {
    expect(normalizeRuntimeName("  Other ")).toBe("other");
    expect(normalizeRuntimeName("  ")).toBeUndefined();
    expect(normalizeRuntimeName("unknown")).toBeUndefined();
    expect(normalizeRuntimeName(undefined)).toBeUndefined();
  });

  test("the default runtime inherits the project's model and effort", () => {
    const { agents } = agentRuntimes();
    for (const runtime of [undefined, "", "FAKE ", "unknown"]) {
      const settings = agents.settingsFor({ runtime });
      expect(settings.runtime).toBe(agents.default);
      expect(settings.model).toBe("project-model");
      expect(settings.reasoningEffort).toBe("high");
    }
    expect(agents.settingsFor({ model: " custom " }).model).toBe("custom");
  });

  test("another runtime does not inherit the project's model", () => {
    const { agents, created } = agentRuntimes();
    const settings = agents.settingsFor({ runtime: " Other" });
    expect(settings.runtime.name).toBe("other");
    expect(settings.model).toBeUndefined();
    expect(settings.reasoningEffort).toBeUndefined();
    expect(agents.settingsFor({ runtime: "other", model: "m" }).model).toBe("m");
    expect(created).toEqual(["other"]);
  });

  test("asking for a runtime that is not available is an error", () => {
    const { agents } = agentRuntimes();
    expect(() => agents.settingsFor({ runtime: "missing" })).toThrow(ValidationError);
  });

  test("a stored session whose runtime is gone runs on the default with the project's model", () => {
    const { agents } = agentRuntimes();
    const settings = agents.settingsForRoute(route({ runtime: "missing", model: "old-model" }));
    expect(settings.runtime).toBe(agents.default);
    expect(settings.model).toBe("project-model");
    const kept = agents.settingsForRoute(route({ runtime: "other", model: "old-model" }));
    expect(kept.runtime.name).toBe("other");
    expect(kept.model).toBe("old-model");
  });
});
