import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStatus } from '../src/connectionStatus.js';

function fakeGladys({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    fail,
    async setConnectionStatus(connected, message) {
      calls.push({ connected, message });
      if (this.fail) {
        throw new Error('Gladys unreachable');
      }
    },
  };
}

const MESSAGE = { en: 'Cannot reach the Yoto service', fr: 'Service Yoto injoignable' };

test('a success after a failure turns the badge green again', async () => {
  // A transient Yoto error used to leave the badge red for good: only "Test
  // the connection" and the start-up read ever sent `true`.
  const gladys = fakeGladys();
  const status = new ConnectionStatus(gladys);
  await status.disconnected(MESSAGE);
  await status.connected();
  assert.deepEqual(
    gladys.calls.map((call) => call.connected),
    [false, true],
  );
});

test('repeated successes send "connected" once', async () => {
  const gladys = fakeGladys();
  const status = new ConnectionStatus(gladys);
  await status.connected();
  await status.connected();
  await status.connected();
  assert.equal(gladys.calls.length, 1);
});

test('a "connected" Gladys did not receive is sent again on the next success', async () => {
  const gladys = fakeGladys({ fail: true });
  const status = new ConnectionStatus(gladys);
  await status.connected();
  gladys.fail = false;
  await status.connected();
  assert.equal(gladys.calls.length, 2);
});

test('every failure is reported, and reset() resends the next state', async () => {
  const gladys = fakeGladys();
  const status = new ConnectionStatus(gladys);
  await status.disconnected(MESSAGE);
  await status.disconnected(MESSAGE);
  await status.connected();
  status.reset();
  await status.connected();
  assert.deepEqual(
    gladys.calls.map((call) => call.connected),
    [false, false, true, true],
  );
  assert.deepEqual(gladys.calls[0].message, MESSAGE);
});
