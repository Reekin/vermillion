type Refresh = (signal: AbortSignal, consumePending: () => void) => Promise<void>;

/** Each flight owns its cancellation and cleanup, including after a target switch. */
export const createCoalescedRefresh = () => {
  let current: { abort: AbortController; pending?: Refresh; promise: Promise<void> } | undefined;
  return {
    request(run: Refresh): Promise<void> {
      if (current) {
        current.pending = run;
        return current.promise;
      }
      const flight = { abort: new AbortController(), pending: run as Refresh | undefined, promise: Promise.resolve() };
      current = flight;
      flight.promise = (async () => {
        try {
          while (flight.pending && !flight.abort.signal.aborted) {
            const next = flight.pending;
            flight.pending = undefined;
            await next(flight.abort.signal, () => { flight.pending = undefined; });
          }
        } catch (error) {
          if (!flight.abort.signal.aborted) throw error;
        } finally {
          if (current === flight) current = undefined;
        }
      })();
      return flight.promise;
    },
    cancel(): void {
      current?.abort.abort();
      current = undefined;
    }
  };
};
