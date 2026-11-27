/**
 * Settles like `promise`, or rejects as soon as `signal` aborts, so code that ignores its
 * context's signal still cannot outlive it.
 */
export async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw toAbortError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(toAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" && reason ? reason : "aborted");
}
