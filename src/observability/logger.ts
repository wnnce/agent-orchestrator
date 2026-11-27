import { activeTraceIds } from "./tracing.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

export type LogEntryListener = (entry: LogEntry) => void;

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
  onEntry?: LogEntryListener | undefined;
  captureAllLevels?: boolean | undefined;
  listenerFields?: LogFields | undefined;
}

export class Logger {
  private readonly service: string;
  private readonly minimum: number;
  private readonly sink: LogSink;
  private readonly fields: LogFields;
  private readonly onEntry?: LogEntryListener | undefined;
  private readonly captureAllLevels: boolean;
  private readonly listenerFields: LogFields;

  constructor(options: LoggerOptions = {}) {
    this.service = options.service ?? "agent-orchestrator";
    this.minimum = levels[options.level ?? "info"];
    this.sink = options.sink ?? ((line) => console.log(line));
    this.fields = options.fields ?? {};
    this.onEntry = options.onEntry;
    this.captureAllLevels = options.captureAllLevels ?? false;
    this.listenerFields = options.listenerFields ?? {};
  }

  child(fields: LogFields): Logger {
    return new Logger({
      service: this.service,
      level: this.levelName(),
      sink: this.sink,
      fields: { ...this.fields, ...fields },
      ...(this.onEntry ? { onEntry: this.onEntry } : {}),
      captureAllLevels: this.captureAllLevels,
      listenerFields: this.onEntry ? { ...this.listenerFields, ...fields } : {},
    });
  }

  /**
   * Derives a child logger that also forwards sanitized structured entries to `onEntry`
   * while continuing to write to the parent sink.
   */
  withListener(
    fields: LogFields,
    onEntry: LogEntryListener,
    options: { captureAllLevels?: boolean | undefined } = {},
  ): Logger {
    return new Logger({
      service: this.service,
      level: this.levelName(),
      sink: this.sink,
      fields: { ...this.fields, ...fields },
      onEntry,
      captureAllLevels: options.captureAllLevels ?? true,
      listenerFields: {},
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
    const shouldWriteSink = levels[level] >= this.minimum;
    const shouldNotifyListener =
      this.onEntry !== undefined && (this.captureAllLevels || shouldWriteSink);

    if (!shouldWriteSink && !shouldNotifyListener) return;

    const timestamp = new Date().toISOString();
    const sanitizedCallFields = sanitize(fields) as Record<string, unknown>;

    if (shouldWriteSink) {
      this.sink(
        JSON.stringify({
          timestamp,
          level,
          service: this.service,
          ...activeTraceIds(),
          message,
          ...(sanitize(this.fields) as Record<string, unknown>),
          ...sanitizedCallFields,
        }),
      );
    }

    if (shouldNotifyListener && this.onEntry) {
      const mergedEntryFields: Record<string, unknown> = {
        ...(sanitize(this.listenerFields) as Record<string, unknown>),
        ...sanitizedCallFields,
      };
      this.onEntry({
        timestamp,
        level,
        message,
        ...(Object.keys(mergedEntryFields).length > 0 ? { fields: mergedEntryFields } : {}),
      });
    }
  }

  private levelName(): LogLevel {
    return (Object.entries(levels).find(([, value]) => value === this.minimum)?.[0] ??
      "info") as LogLevel;
  }
}
