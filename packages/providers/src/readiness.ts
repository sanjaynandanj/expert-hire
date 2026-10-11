/** Bound callers while sharing at most one outstanding operation per dependency.
 * A timeout cannot cancel an underlying driver operation. Keep it shared until it
 * settles so subsequent probes cannot accumulate queries during an outage.
 */
export function createReadinessProbe(check: () => Promise<unknown>, timeoutMs = 3_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Readiness timeout must be between 1 and 30000 milliseconds.");
  let inFlight: Promise<unknown> | null = null;
  return async function probe(): Promise<void> {
    if (!inFlight) {
      const operation = Promise.resolve().then(check);
      inFlight = operation;
      const clear = () => { if (inFlight === operation) inFlight = null; };
      void operation.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inFlight, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Readiness dependency probe timed out.")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
}
