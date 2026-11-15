import { Pool } from "pg";
import {
  normalizeCodexMessage,
  extractFinalTextFromTurnItems,
} from "../src/runtime/codex-normalizer.ts";
import { isCanonicalEventType } from "../src/domain/events.ts";

const databaseUrl =
  process.env.DATABASE_URL || "postgres://postgres:123456@postgres:5432/orchestrator";

async function main() {
  console.log("Connecting to database:", databaseUrl.replace(/:[^:@]+@/, ":***@"));
  const pool = new Pool({ connectionString: databaseUrl });

  const totalBeforeRes = await pool.query("SELECT count(*) FROM events");
  console.log(`Total events before migration: ${totalBeforeRes.rows[0].count}`);

  // 1. Migrate turn.completed / turn.failed / turn.interrupted to canonical payload
  const turnEventsRes = await pool.query(
    "SELECT event_id, type, turn_id, payload FROM events WHERE type IN ('turn.completed', 'turn.failed', 'turn.interrupted')",
  );

  let updatedTurns = 0;
  for (const row of turnEventsRes.rows) {
    const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
    if (payload.turn || !payload.finalText) {
      const finalText =
        extractFinalTextFromTurnItems(payload.turn?.items ?? payload.items) || payload.finalText;
      const canonicalPayload = {
        turnId: row.turn_id || payload.turnId || payload.turn?.id || "",
        status:
          row.type === "turn.completed"
            ? "completed"
            : row.type === "turn.interrupted"
              ? "interrupted"
              : "failed",
        runtimeTurnId: payload.turn?.id || payload.runtimeTurnId || undefined,
        finalText: finalText || undefined,
        durationMs: payload.turn?.durationMs ?? payload.durationMs ?? undefined,
        metadata: {
          migratedFromLegacy: true,
          itemCount: Array.isArray(payload.turn?.items) ? payload.turn.items.length : 0,
        },
      };

      await pool.query("UPDATE events SET payload = $1::jsonb WHERE event_id = $2", [
        JSON.stringify(canonicalPayload),
        row.event_id,
      ]);
      updatedTurns++;
    }
  }
  console.log(`Updated ${updatedTurns} turn lifecycle events to canonical schema.`);

  // 2. Normalize all events with raw nested payload.item
  const rawItemEventsRes = await pool.query(
    "SELECT event_id, session_id, type, payload FROM events WHERE payload->'item' IS NOT NULL",
  );
  console.log(`Found ${rawItemEventsRes.rows.length} events with raw payload.item to normalize.`);

  let normalizedCount = 0;
  for (const row of rawItemEventsRes.rows) {
    const normalized = normalizeCodexMessage("item/completed", row.payload, row.session_id);
    const eventType = normalized.type || row.type;
    await pool.query(
      "UPDATE events SET type = $1, payload = $2::jsonb WHERE event_id = $3",
      [eventType, JSON.stringify(normalized.payload), row.event_id],
    );
    normalizedCount++;
  }
  console.log(`Normalized ${normalizedCount} raw item events to canonical types and payloads.`);

  // 3. Delete non-canonical leftover events (e.g. mcpServer.startupStatus.updated, thread.*, etc.)
  const deleteRes = await pool.query(
    "DELETE FROM events WHERE type NOT IN (" +
      "'session.started', 'session.closed', 'session.suspended', 'session.renamed', 'session.archived', " +
      "'turn.queued', 'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted', " +
      "'agent.reasoning', 'agent.reasoning.delta', 'agent.reasoning.completed', " +
      "'agent.message.delta', 'agent.message.completed', " +
      "'command.started', 'command.output', 'command.completed', " +
      "'tool.call.started', 'tool.called', " +
      "'mcp_call.started', 'mcp_call.completed', " +
      "'file_change.started', 'file_change.completed', " +
      "'artifact.created', 'notification.queued', 'compaction.completed', 'approval.requested', 'approval.resolved'" +
    ")",
  );
  console.log(`Deleted ${deleteRes.rowCount} non-canonical events.`);

  // 4. Verification
  const totalAfterRes = await pool.query("SELECT count(*) FROM events");
  console.log(`Total events remaining in database: ${totalAfterRes.rows[0].count}`);

  const distinctTypesRes = await pool.query(
    "SELECT type, count(*) FROM events GROUP BY type ORDER BY count(*) DESC",
  );
  console.log("\nDistinct event types in database after migration:");
  let allCanonical = true;
  for (const r of distinctTypesRes.rows) {
    const isCanonical = isCanonicalEventType(r.type);
    console.log(`  - ${r.type.padEnd(28)}: ${r.count} ${isCanonical ? "✅ canonical" : "❌ non-canonical"}`);
    if (!isCanonical) allCanonical = false;
  }

  // Verify none have payload.item remaining
  const lingeringItemsRes = await pool.query(
    "SELECT count(*) FROM events WHERE payload->'item' IS NOT NULL",
  );
  console.log(`Events with raw payload.item remaining: ${lingeringItemsRes.rows[0].count}`);

  if (allCanonical && lingeringItemsRes.rows[0].count === "0") {
    console.log("\n🎉 ALL EVENTS AND PAYLOADS ARE 100% CANONICAL!");
  } else {
    console.warn("\n⚠️ Issues remain.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
