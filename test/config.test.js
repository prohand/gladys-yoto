import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  DEFAULT_CONFIG,
  GLADYS_POLL_FREQUENCIES_MS,
  gladysPollFrequency,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({ client_id: 'abc123', poll_frequency: 300 });
  assert.equal(config.client_id, 'abc123');
  assert.equal(config.poll_frequency, 300);
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '600' });
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig clamps the poll frequency to the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 30);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ poll_frequency: 'oops' }).poll_frequency, 120);
});

test('normalizeConfig trims the client id pasted from the Yoto dashboard', () => {
  assert.equal(normalizeConfig({ client_id: '  abc123 ' }).client_id, 'abc123');
});

test('request_status_push is on unless explicitly disabled', () => {
  assert.equal(normalizeConfig().request_status_push, true);
  assert.equal(normalizeConfig({ request_status_push: true }).request_status_push, true);
  assert.equal(normalizeConfig({ request_status_push: false }).request_status_push, false);
  assert.equal(normalizeConfig({ request_status_push: 'false' }).request_status_push, false);
});

test('the poll frequency published on a device is one Gladys accepts', () => {
  // Anything else is refused by the core: "invalid poll frequency".
  for (const seconds of [30, 45, 60, 120, 300, 3600]) {
    assert.ok(
      GLADYS_POLL_FREQUENCIES_MS.includes(gladysPollFrequency(seconds)),
      `${seconds}s must map to a scheduled Gladys frequency`,
    );
  }
});

test('the device tick is the closest one that is not slower than asked', () => {
  assert.equal(gladysPollFrequency(30), 30000);
  assert.equal(gladysPollFrequency(45), 30000);
  assert.equal(gladysPollFrequency(60), 60000);
  // Gladys schedules nothing slower than a minute: longer intervals land on
  // the 60 s tick and are enforced by the registry.
  assert.equal(gladysPollFrequency(120), 60000);
  assert.equal(gladysPollFrequency(3600), 60000);
});

test('the device tick never goes below the fastest Gladys frequency', () => {
  assert.equal(gladysPollFrequency(0), 1000);
  assert.equal(gladysPollFrequency('oops'), 60000); // falls back on the default
});
