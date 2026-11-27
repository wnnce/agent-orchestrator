import { defineTool, z } from "../../../src/tools/index.ts";

/**
 * Example project-scoped custom tool.
 *
 * Files under `projects/<projectId>/tools/*.ts` are loaded automatically when the project starts
 * and exposed to the project's agents across all runtimes (Codex, Claude Code, Pi, ACP).
 */
export default defineTool({
  name: "get_current_time",
  description:
    "Return the current date and time in ISO-8601 and localized format for a given IANA timezone.",
  input: z.object({
    timezone: z
      .string()
      .trim()
      .min(1)
      .default("UTC")
      .describe('IANA timezone name, e.g. "UTC", "Asia/Shanghai", or "America/New_York"'),
  }),
  async run({ timezone }) {
    const now = new Date();
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        weekday: "long",
      });
    } catch {
      throw new Error(`Invalid IANA timezone: "${timezone}"`);
    }

    const parts = Object.fromEntries(
      formatter.formatToParts(now).map((part) => [part.type, part.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;

    return {
      timezone,
      iso: now.toISOString(),
      unixMs: now.getTime(),
      date,
      time,
      weekday: parts.weekday ?? "",
      formatted: `${date} ${time} (${timezone})`,
    };
  },
});
