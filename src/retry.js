// -----------------------------------------------------------------------------
// Retry with backoff for the start-up read of the Yoto account.
//
// The container often starts before the network is usable (DNS not ready,
// Yoto briefly down). That read is what publishes the players to the Discovery
// tab: failed once and never retried, the tab stayed empty until the next
// restart or a manual scan. It is retried after 1, 5 then every 15 minutes
// until it succeeds.
// -----------------------------------------------------------------------------

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * @param {() => Promise<boolean>} task resolves true when done (nothing to
 *   retry), false to be tried again later; a rejection counts as false
 * @param {object} [options]
 *   - delays      : backoff in ms, the last one repeats
 *   - setTimeoutFn / clearTimeoutFn: injectable for the tests
 *   - onError     : called with an error the task threw
 * @returns {{ run: () => Promise<boolean>, cancel: () => void, readonly pending: boolean }}
 */
export function createRetry(task, options = {}) {
  const {
    delays = RETRY_DELAYS_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError = () => {},
  } = options;
  let timer = null;
  let attempt = 0;
  // Bumped by run() and cancel(): an attempt still in flight when the retry is
  // restarted or stopped (shutdown) must not schedule anything afterwards.
  let generation = 0;

  function cancel() {
    generation += 1;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  async function attemptOnce(current) {
    timer = null;
    let done = false;
    try {
      done = await task();
    } catch (err) {
      onError(err);
    }
    if (current !== generation) {
      return done;
    }
    if (done) {
      attempt = 0;
      return true;
    }
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    timer = setTimeoutFn(() => attemptOnce(current), delay);
    return false;
  }

  return {
    /** Run now (a new connection, a fresh link): restarts the backoff from the start. */
    run() {
      cancel();
      attempt = 0;
      return attemptOnce(generation);
    },
    cancel,
    get pending() {
      return timer !== null;
    },
  };
}
