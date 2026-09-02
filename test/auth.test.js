import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenStore,
  YotoAuthError,
  exchangeAuthorizationCode,
  requestDeviceCode,
  pollDeviceToken,
  startBrowserAuthorization,
  AUTHORIZE_URL,
  SCOPES,
  TOKEN_URL,
} from '../src/yoto/auth.js';

/** Replace global fetch with a queue of canned answers, and log the requests. */
function mockFetch(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options.body?.toString() });
    const answer = answers.shift();
    if (!answer) {
      throw new Error(`unexpected request to ${url}`);
    }
    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const noSleep = async () => {};

test('startBrowserAuthorization builds a PKCE authorization URL', () => {
  const flow = startBrowserAuthorization('client-1', 'https://gladys.local/oauth/callback');
  const url = new URL(flow.url);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://gladys.local/oauth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'), 'a PKCE challenge is mandatory');
  assert.equal(url.searchParams.get('state'), flow.state);
  assert.equal(url.searchParams.get('scope'), SCOPES);
  // The challenge travels, the verifier never leaves the integration.
  assert.ok(!flow.url.includes(flow.verifier));
});

test('startBrowserAuthorization draws a new verifier and state every time', () => {
  const first = startBrowserAuthorization('client-1', 'https://gladys.local/oauth/callback');
  const second = startBrowserAuthorization('client-1', 'https://gladys.local/oauth/callback');
  assert.notEqual(first.verifier, second.verifier);
  assert.notEqual(first.state, second.state);
});

test('startBrowserAuthorization refuses to run without a redirect URL', () => {
  assert.throws(
    () => startBrowserAuthorization('client-1', undefined),
    (err) => err instanceof YotoAuthError,
  );
});

test('exchangeAuthorizationCode sends the code and the PKCE verifier', async () => {
  const fetchMock = mockFetch([
    { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
  ]);
  try {
    const tokens = await exchangeAuthorizationCode({
      clientId: 'client-1',
      code: 'auth-code',
      verifier: 'the-verifier',
      redirectUri: 'https://gladys.local/oauth/callback',
    });
    assert.equal(tokens.refresh_token, 'rt');
    const body = new URLSearchParams(fetchMock.calls[0].body);
    assert.equal(fetchMock.calls[0].url, TOKEN_URL);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'auth-code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(body.get('redirect_uri'), 'https://gladys.local/oauth/callback');
  } finally {
    fetchMock.restore();
  }
});

test('exchangeAuthorizationCode surfaces the reason Yoto refused the code', async () => {
  const fetchMock = mockFetch([
    {
      status: 403,
      body: { error: 'invalid_grant', error_description: 'Invalid authorization code' },
    },
  ]);
  try {
    await assert.rejects(
      () =>
        exchangeAuthorizationCode({
          clientId: 'client-1',
          code: 'stale',
          verifier: 'v',
          redirectUri: 'https://gladys.local/oauth/callback',
        }),
      (err) => err instanceof YotoAuthError && err.message.includes('Invalid authorization code'),
    );
  } finally {
    fetchMock.restore();
  }
});

test('requestDeviceCode explains that Yoto deprecated the device code grant', async () => {
  const fetchMock = mockFetch([
    {
      status: 403,
      body: { error: 'unauthorized_client', error_description: 'Unauthorized or unknown client' },
    },
  ]);
  try {
    await assert.rejects(
      () => requestDeviceCode('client-1'),
      (err) => err instanceof YotoAuthError && err.message.includes('device code grant'),
    );
  } finally {
    fetchMock.restore();
  }
});

test('requestDeviceCode asks for the offline_access scope', async () => {
  const fetchMock = mockFetch([
    {
      body: {
        device_code: 'dev-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://login.yotoplay.com/activate',
        verification_uri_complete: 'https://login.yotoplay.com/activate?user_code=ABCD-1234',
        expires_in: 300,
        interval: 5,
      },
    },
  ]);
  try {
    const flow = await requestDeviceCode('client-1');
    assert.equal(flow.user_code, 'ABCD-1234');
    assert.equal(flow.interval, 5);
    assert.ok(fetchMock.calls[0].body.includes('client_id=client-1'));
    assert.ok(SCOPES.includes('offline_access'));
  } finally {
    fetchMock.restore();
  }
});

test('requestDeviceCode builds the approval URL when Yoto omits it', async () => {
  const fetchMock = mockFetch([
    {
      body: {
        device_code: 'dev-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://login.yotoplay.com/activate',
      },
    },
  ]);
  try {
    const flow = await requestDeviceCode('client-1');
    assert.equal(
      flow.verification_uri_complete,
      'https://login.yotoplay.com/activate?user_code=ABCD-1234',
    );
  } finally {
    fetchMock.restore();
  }
});

test('pollDeviceToken waits while the user has not approved yet', async () => {
  const fetchMock = mockFetch([
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 429, body: { error: 'slow_down' } },
    { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
  ]);
  try {
    const tokens = await pollDeviceToken('client-1', 'dev-code', { sleep: noSleep });
    assert.equal(tokens.access_token, 'at');
    assert.equal(fetchMock.calls.length, 3);
  } finally {
    fetchMock.restore();
  }
});

test('pollDeviceToken asks for a new link when the code expires', async () => {
  const fetchMock = mockFetch([{ status: 400, body: { error: 'expired_token' } }]);
  try {
    await assert.rejects(
      () => pollDeviceToken('client-1', 'dev-code', { sleep: noSleep }),
      (err) => err instanceof YotoAuthError && err.needsRelink,
    );
  } finally {
    fetchMock.restore();
  }
});

test('pollDeviceToken gives up when the pairing is cancelled', async () => {
  const fetchMock = mockFetch([]);
  try {
    const tokens = await pollDeviceToken('client-1', 'dev-code', {
      sleep: noSleep,
      shouldStop: () => true,
    });
    assert.equal(tokens, null);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('TokenStore persists the tokens through the callback', async () => {
  const saved = [];
  const store = new TokenStore({ onTokensChanged: (tokens) => saved.push(tokens) });
  await store.update({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  assert.equal(store.linked, true);
  assert.equal(saved[0].refresh_token, 'rt');
  assert.ok(saved[0].expires_at > Date.now());
});

test('TokenStore reuses a valid access token without calling Yoto', async () => {
  const fetchMock = mockFetch([]);
  try {
    const store = new TokenStore();
    store.restore({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000 });
    assert.equal(await store.getAccessToken('client-1'), 'at');
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('TokenStore refreshes an expired access token once for concurrent callers', async () => {
  const fetchMock = mockFetch([
    { body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } },
  ]);
  try {
    const store = new TokenStore();
    store.restore({ access_token: 'old', refresh_token: 'rt', expires_at: Date.now() - 1000 });
    const [first, second] = await Promise.all([
      store.getAccessToken('client-1'),
      store.getAccessToken('client-1'),
    ]);
    assert.equal(first, 'new-at');
    assert.equal(second, 'new-at');
    assert.equal(fetchMock.calls.length, 1, 'one refresh, not one per caller');
    assert.equal(fetchMock.calls[0].url, TOKEN_URL);
  } finally {
    fetchMock.restore();
  }
});

test('TokenStore drops a revoked refresh token and asks for a new link', async () => {
  const fetchMock = mockFetch([{ status: 403, body: { error: 'invalid_grant' } }]);
  try {
    const store = new TokenStore();
    store.restore({ access_token: 'old', refresh_token: 'rt', expires_at: 0 });
    await assert.rejects(
      () => store.getAccessToken('client-1'),
      (err) => err instanceof YotoAuthError && err.needsRelink,
    );
    assert.equal(store.linked, false, 'a revoked token must not be retried forever');
  } finally {
    fetchMock.restore();
  }
});

test('TokenStore refuses to work without a linked account', async () => {
  const store = new TokenStore();
  await assert.rejects(
    () => store.getAccessToken('client-1'),
    (err) => err instanceof YotoAuthError && err.needsRelink,
  );
});
