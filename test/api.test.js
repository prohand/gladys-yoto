import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YotoApi, STATUS_PUSH_SETTLE_MS, BASE_URL } from '../src/yoto/api.js';
import { TokenStore, YotoAuthError, TOKEN_URL } from '../src/yoto/auth.js';

/** Replace global fetch with a queue of canned answers, and log the requests. */
function mockFetch(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, authorization: options.headers?.authorization });
    const answer = answers.shift();
    if (!answer) {
      throw new Error(`unexpected request to ${url}`);
    }
    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status ?? 200,
      json: async () => answer.body ?? {},
    };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function linkedStore() {
  const store = new TokenStore();
  store.restore({
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_at: Date.now() + 3_600_000,
  });
  return store;
}

const DEVICES = { body: { devices: [{ deviceId: 'y2abc123', name: 'Salon' }] } };

test('a 401 refreshes the token and replays the call once', async () => {
  // A token Yoto revoked before its expiry used to ask the user for a new
  // link, although the refresh token still worked.
  const fetchMock = mockFetch([
    { status: 401 },
    { body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } },
    DEVICES,
  ]);
  try {
    const store = linkedStore();
    const api = new YotoApi(store, () => 'client-1');
    const devices = await api.listDevices();
    assert.equal(devices[0].deviceId, 'y2abc123');
    assert.deepEqual(
      fetchMock.calls.map((call) => call.url),
      [`${BASE_URL}/device-v2/devices/mine`, TOKEN_URL, `${BASE_URL}/device-v2/devices/mine`],
    );
    assert.equal(fetchMock.calls[2].authorization, 'Bearer at-2');
    assert.equal(store.linked, true);
  } finally {
    fetchMock.restore();
  }
});

test('a 401 whose refresh Yoto refuses asks for a new link', async () => {
  const fetchMock = mockFetch([{ status: 401 }, { status: 403, body: { error: 'invalid_grant' } }]);
  try {
    const store = linkedStore();
    const api = new YotoApi(store, () => 'client-1');
    await assert.rejects(
      () => api.listDevices(),
      (err) => err instanceof YotoAuthError && err.needsRelink,
    );
    assert.equal(store.linked, false);
  } finally {
    fetchMock.restore();
  }
});

test('a 401 is replayed only once', async () => {
  const fetchMock = mockFetch([
    { status: 401 },
    { body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } },
    { status: 401 },
  ]);
  try {
    const api = new YotoApi(linkedStore(), () => 'client-1');
    await assert.rejects(() => api.listDevices(), YotoAuthError);
    assert.equal(fetchMock.calls.length, 3, 'no refresh loop');
  } finally {
    fetchMock.restore();
  }
});

test('a 403 (missing scope) is not worth a refresh', async () => {
  const fetchMock = mockFetch([{ status: 403 }]);
  try {
    const api = new YotoApi(linkedStore(), () => 'client-1');
    await assert.rejects(
      () => api.getCardTitle('h2Fbz'),
      (err) => err instanceof YotoAuthError && !err.needsRelink,
    );
    assert.equal(fetchMock.calls.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test('a status request waits for the report to land before the shadow is read', async () => {
  // Read right after the request, the shadow still held the previous report:
  // the request was a wasted call.
  const fetchMock = mockFetch([{ status: 204 }]);
  const sleeps = [];
  try {
    const api = new YotoApi(linkedStore(), () => 'client-1', {
      sleep: async (ms) => sleeps.push(ms),
    });
    await api.requestStatusPush('y2abc123');
    assert.equal(fetchMock.calls[0].method, 'POST');
    assert.deepEqual(sleeps, [STATUS_PUSH_SETTLE_MS]);
    assert.ok(STATUS_PUSH_SETTLE_MS >= 500 && STATUS_PUSH_SETTLE_MS <= 2000);
  } finally {
    fetchMock.restore();
  }
});

test('a refused status request does not wait', async () => {
  const fetchMock = mockFetch([{ status: 403 }]);
  const sleeps = [];
  try {
    const api = new YotoApi(linkedStore(), () => 'client-1', {
      sleep: async (ms) => sleeps.push(ms),
    });
    await assert.rejects(() => api.requestStatusPush('y2abc123'));
    assert.deepEqual(sleeps, []);
  } finally {
    fetchMock.restore();
  }
});
