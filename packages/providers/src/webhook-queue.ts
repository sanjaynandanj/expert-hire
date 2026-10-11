/** Queue submission is an optimization: persisted work remains recoverable by a sweep. */
export async function enqueuePersistedJobs(ids: string[], enqueue: (id: string) => Promise<unknown>, report: (id: string, error: unknown) => void, timeoutMs = 3_000): Promise<void> {
  await Promise.all(ids.map(async (id) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => enqueue(id)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Durable queue submission timed out.")), timeoutMs); timer.unref(); })
      ]);
    } catch (error) {
      report(id, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
export const enqueuePersistedWebhooks = enqueuePersistedJobs;
