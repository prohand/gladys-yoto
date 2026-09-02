import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

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
