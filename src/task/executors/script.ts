import { spawn } from "node:child_process";
import { Logger } from "../../observability/logger.ts";
import type {
  ITaskExecutor,
  TaskDefinition,
  TaskExecutionContext,
  TaskRunResult,
} from "../types.ts";

export interface ScriptTaskExecutorOptions {
  readonly getWorkdir?: ((projectId: string) => string | undefined) | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

/**
 * Local shell script task executor.
 * Suitable for periodic automation, backup, data synchronization, and scripts.
 */
export class ScriptTaskExecutor implements ITaskExecutor {
  readonly type = "script";

  constructor(
    private readonly options: ScriptTaskExecutorOptions = {},
    private readonly logger = new Logger(),
  ) {}

  canHandle(task: TaskDefinition): boolean {
    return task.type === "script" || Boolean(task.command);
  }

  async execute(context: TaskExecutionContext): Promise<TaskRunResult> {
    const started = Date.now();
    const command = context.task.command;

    if (!command || command.trim() === "") {
      return {
        success: false,
        durationMs: 0,
        stateBefore: context.stateBefore,
        stateAfter: context.stateBefore,
        error: `Script task "${context.task.taskKey}" has no executable "command" specified`,
      };
    }

    const workdir =
      (this.options.getWorkdir ? this.options.getWorkdir(context.task.projectId) : undefined) ??
      process.cwd();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TASK_KEY: context.task.taskKey,
      TASK_ID: context.task.taskId,
      PROJECT_ID: context.task.projectId,
      TASK_STATE: JSON.stringify(context.stateBefore),
    };

    return new Promise<TaskRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const isUnix = process.platform !== "win32";
      const child = spawn("sh", ["-c", command], {
        cwd: workdir,
        env,
        detached: isUnix,
      });

      const killProcess = (signal: NodeJS.Signals = "SIGTERM") => {
        if (child.pid) {
          if (isUnix) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch {
              // process might already be gone
            }
          }
          try {
            child.kill(signal);
          } catch {
            // ignore
          }
        }
      };

      const timeoutMs = context.task.timeoutMs ?? this.options.defaultTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcess("SIGTERM");
          setTimeout(() => killProcess("SIGKILL"), 500);
        }, timeoutMs);
      }

      if (context.signal) {
        context.signal.addEventListener("abort", () => {
          killProcess("SIGKILL");
        });
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - started;

        if (timedOut) {
          resolve({
            success: false,
            durationMs,
            stateBefore: context.stateBefore,
            stateAfter: context.stateBefore,
            error: `Script execution timed out after ${timeoutMs}ms`,
            actionsSummary: {
              command,
              stdout,
              stderr,
              timedOut: true,
            },
          });
          return;
        }

        const success = code === 0;

        // Attempt to parse trailing JSON state output from stdout
        let stateAfter = context.stateBefore;
        try {
          const lines = stdout.trim().split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]?.trim();
            if (line && line.startsWith("{") && line.endsWith("}")) {
              const parsed = JSON.parse(line) as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                stateAfter = {
                  ...context.stateBefore,
                  ...(parsed as Record<string, unknown>),
                };
                break;
              }
            }
          }
        } catch {
          // Output is not JSON, retain previous state
        }

        if (context.updateState && stateAfter !== context.stateBefore) {
          context.updateState(stateAfter);
        }

        const error = !success
          ? stderr.trim() || `Script process exited with code ${code ?? -1}`
          : undefined;

        resolve({
          success,
          durationMs,
          stateBefore: context.stateBefore,
          stateAfter,
          ...(error !== undefined ? { error } : {}),
          actionsSummary: {
            command,
            exitCode: code ?? -1,
            stdout,
            stderr,
          },
        });
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - started;
        const msg = err.message || String(err);
        this.logger.error("script process spawn failed", {
          taskKey: context.task.taskKey,
          error: msg,
        });

        resolve({
          success: false,
          durationMs,
          stateBefore: context.stateBefore,
          stateAfter: context.stateBefore,
          error: msg,
          actionsSummary: {
            command,
            error: msg,
          },
        });
      });
    });
  }
}
