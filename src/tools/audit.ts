/** Keeps audit rows small: long strings and collections are cut, binary data summarized. */
export function sanitizeAuditPayload(
  value: unknown,
  maxStringLength = 4096,
  maxDepth = 5,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > maxStringLength) {
      return `${value.slice(0, maxStringLength)}... [Truncated ${value.length - maxStringLength} chars]`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    return `[Binary data: ${value.byteLength} bytes]`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (maxDepth <= 0) return "[Max Depth Reached]";

  if (Array.isArray(value)) {
    const maxItems = 100;
    const items = value
      .slice(0, maxItems)
      .map((item) => sanitizeAuditPayload(item, maxStringLength, maxDepth - 1));
    if (value.length > maxItems) {
      items.push(`[Truncated ${value.length - maxItems} items]`);
    }
    return items;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    const maxKeys = 100;
    for (let i = 0; i < Math.min(entries.length, maxKeys); i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [k, v] = entry;
      result[k] = sanitizeAuditPayload(v, maxStringLength, maxDepth - 1);
    }
    if (entries.length > maxKeys) {
      result["_truncated_keys"] = `[Truncated ${entries.length - maxKeys} keys]`;
    }
    return result;
  }

  return String(value);
}
