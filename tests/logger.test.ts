import { expect, test } from "bun:test";
import { Logger } from "../src/observability/logger.ts";

test("logger emits structured redacted JSON", () => {
  const lines: string[] = [];
  const logger = new Logger({ sink: (line) => lines.push(line), level: "debug" });
  logger.info("request completed", {
    requestId: "req_1",
    authorization: "Bearer secret",
    nested: { apiKey: "hidden", count: 2 },
  });
  const record = JSON.parse(lines[0] ?? "{}");
  expect(record.message).toBe("request completed");
  expect(record.requestId).toBe("req_1");
  expect(record.authorization).toBe("[REDACTED]");
  expect(record.nested.apiKey).toBe("[REDACTED]");
});

test("logger level comes from options rather than LOG_LEVEL", () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  try {
    const lines: string[] = [];
    const logger = new Logger({ sink: (line) => lines.push(line), level: "debug" });
    logger.child({ projectId: "test-project" }).debug("yaml log level");
    new Logger({ sink: (line) => lines.push(line) }).info("default log level");
    expect(lines).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});
