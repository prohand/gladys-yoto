import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetry, RETRY_DELAYS_MS } from '../src/retry.js';

/** Timers held by hand: a test fires them when it wants. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeoutFn: (callback, delay) => {
      const id = next++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn: (id) => pending.delete(id),
    scheduled: () => [...pending.values()].map((timer) => timer.delay),
    async fire() {
      const [[id, timer]] = pending;
      pending.delete(id);
      await timer.callback();
    },
  };
}

test('the backoff is 1, 5 then 15 minutes, repeated until the read succeeds', async () => {
  // A container started before the network used to publish nothing to the
  // Discovery tab until its next restart.
  assert.deepEqual(RETRY_DELAYS_MS, [60_000, 300_000, 900_000]);
  const timers = fakeTimers();
  const outcomes = [false, false, false, false, true];
  let calls = 0;
  const retry = createRetry(async () => outcomes[calls++], timers);

  assert.equal(await retry.run(), false);
  const seen = [];
  while (timers.pending.size > 0) {
    seen.push(...timers.scheduled());
    await timers.fire();
  }
  assert.deepEqual(seen, [60_000, 300_000, 900_000, 900_000]);
  assert.equal(calls, 5);
  assert.equal(retry.pending, false, 'nothing scheduled once it succeeded');
});

test('a task that throws is retried too', async () => {
  const timers = fakeTimers();
  const errors = [];
  const retry = createRetry(
    async () => {
      throw new Error('getaddrinfo EAI_AGAIN');
    },
    { ...timers, onError: (err) => errors.push(err.message) },
  );
  await retry.run();
  assert.equal(retry.pending, true);
  assert.deepEqual(errors, ['getaddrinfo EAI_AGAIN']);
});

test('cancel() clears the timer, even for an attempt still in flight', async () => {
  const timers = fakeTimers();
  const retry = createRetry(async () => false, timers);
  await retry.run();
  retry.cancel();
  assert.equal(timers.pending.size, 0);

  let release;
  const slow = createRetry(() => new Promise((resolve) => (release = resolve)), timers);
  const running = slow.run();
  slow.cancel(); // shutdown while the read is running
  release(false);
  await running;
  assert.equal(timers.pending.size, 0, 'a stopped retry schedules nothing');
});

test('run() again restarts the backoff with a single timer', async () => {
  const timers = fakeTimers();
  const retry = createRetry(async () => false, timers);
  await retry.run();
  await timers.fire(); // now at the 5-minute step
  await retry.run();
  assert.deepEqual(timers.scheduled(), [60_000]);
});
