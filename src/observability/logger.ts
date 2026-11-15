export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const secretKey = /(token|secret|password|authorization|cookie|private.?key|api.?key)/i;

function sanitize(value: unknown, key?: string): unknown {
  if (key && secretKey.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export interface LoggerOptions {
  service?: string;
  level?: LogLevel;
  sink?: LogSink;
  fields?: LogFields;
}

export class Logger {
  private readonly service: string;
  private readonly minimum: number;
  private readonly sink: LogSink;
  private readonly fields: LogFields;

  constructor(options: LoggerOptions = {}) {
    this.service = options.service ?? "agent-orchestrator";
    this.minimum = levels[options.level ?? "info"];
    this.sink = options.sink ?? ((line) => console.log(line));
    this.fields = options.fields ?? {};
  }

  child(fields: LogFields): Logger {
    return new Logger({
      service: this.service,
      level: this.levelName(),
      sink: this.sink,
      fields: { ...this.fields, ...fields },
    });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (levels[level] < this.minimum) return;
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: this.service,
        message,
        ...(sanitize(this.fields) as Record<string, unknown>),
        ...(sanitize(fields) as Record<string, unknown>),
      }),
    );
  }

  private levelName(): LogLevel {
    return (Object.entries(levels).find(([, value]) => value === this.minimum)?.[0] ??
      "info") as LogLevel;
  }
}
