// -----------------------------------------------------------------------------
// Yoto authentication: OAuth 2.0 authorization code flow with PKCE.
//
// Yoto DEPRECATED the device authorization grant (RFC 8628): an app created
// today on dashboard.yoto.dev has no `device_code` grant, and the endpoint
// answers `HTTP 403 unauthorized_client`. The flow Yoto recommends now is the
// browser one — the user signs in on login.yotoplay.com and the provider
// redirects back with a code, which a public client exchanges for tokens using
// a PKCE verifier instead of a client secret.
//
// Gladys drives that round trip for us: an `oauth2` config field gives the
// integration a `redirect_uri` (onOAuthAuthorizeUrl) and relays the callback
// (onOAuthCallback). The device flow is kept as a fallback for the (older)
// cores that do not provide a redirect URI, and for apps that still have the
// grant enabled.
//
// Endpoints (public, documented on https://yoto.dev):
//   GET  https://login.yotoplay.com/authorize
//   POST https://login.yotoplay.com/oauth/token
//   POST https://login.yotoplay.com/oauth/device/code   (deprecated by Yoto)
//
// Tokens are NOT written to disk: they are stored back as Gladys config keys
// outside the `config_schema` (never rendered in the UI), so a container
// restart or an image update keeps the account linked.
// -----------------------------------------------------------------------------

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'yoto-auth' });

export const LOGIN_URL = 'https://login.yotoplay.com';
export const AUTHORIZE_URL = `${LOGIN_URL}/authorize`;
export const DEVICE_CODE_URL = `${LOGIN_URL}/oauth/device/code`;
export const TOKEN_URL = `${LOGIN_URL}/oauth/token`;
export const AUDIENCE = 'https://api.yotoplay.com';

// `offline_access` is what gets us a refresh token: without it the link would
// die a few hours later and the user would have to reconnect by hand.
export const SCOPES =
  'family:devices:view family:devices:control family:library:view offline_access';

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const HTTP_TIMEOUT_MS = 15_000;

// Refresh a bit before the real expiry: a token that expires mid-request would
// surface as a spurious 401.
const EXPIRY_MARGIN_SECONDS = 60;

/** Raised when the user must (re)link their account: nothing retryable left. */
export class YotoAuthError extends Error {
  constructor(message, { needsRelink = false } = {}) {
    super(message);
    this.name = 'YotoAuthError';
    this.needsRelink = needsRelink;
  }
}

/**
 * Start a browser sign-in: generate the PKCE pair and the anti-CSRF `state`,
 * and build the Yoto authorization URL Gladys will open in the user browser.
 *
 * `redirectUri` is the callback Gladys exposes: it MUST be registered as an
 * allowed callback URL on the Yoto app, otherwise Yoto answers "Callback URL
 * mismatch" instead of showing the sign-in page.
 * @returns {{ url: string, state: string, verifier: string, redirectUri: string }}
 */
export function startBrowserAuthorization(clientId, redirectUri) {
  if (!redirectUri) {
    throw new YotoAuthError('Gladys did not provide a redirect URL for the Yoto sign-in');
  }
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = randomUUID();
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    audience: AUDIENCE,
    scope: SCOPES,
    response_type: 'code',
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  }).toString();
  return { url: url.toString(), state, verifier, redirectUri };
}

/**
 * Last step of the browser flow: trade the authorization code (plus the PKCE
 * verifier, which replaces the client secret of a confidential client) for the
 * access and refresh tokens.
 * @returns {Promise<object>} the token payload
 */
export async function exchangeAuthorizationCode({ clientId, code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const payload = await postForm(TOKEN_URL, body, 'token exchange');
  if (!payload.access_token) {
    throw new YotoAuthError('Yoto returned no access token');
  }
  return payload;
}

/**
 * Step 1 of the device flow: ask Yoto for a user code.
 * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string,
 *                     verification_uri_complete: string, expires_in: number, interval: number }>}
 */
export async function requestDeviceCode(clientId) {
  const body = new URLSearchParams({ client_id: clientId, scope: SCOPES, audience: AUDIENCE });
  const payload = await postForm(DEVICE_CODE_URL, body, 'device code request', {
    // Yoto deprecated this grant: a recent app simply does not have it, and the
    // raw "unauthorized_client" would send the user hunting for a typo in their
    // Client ID instead of pointing at the flow itself.
    unauthorized_client:
      'this Yoto app has no device code grant (Yoto deprecated it) — update Gladys so the browser sign-in is used',
  });
  if (!payload.device_code || !payload.user_code) {
    throw new YotoAuthError('Yoto returned no device code');
  }
  return {
    ...payload,
    // Yoto always sends it, but the fallback keeps the UI usable if it stops.
    verification_uri_complete:
      payload.verification_uri_complete ??
      `${payload.verification_uri}?user_code=${encodeURIComponent(payload.user_code)}`,
    expires_in: Number(payload.expires_in ?? 300),
    interval: Number(payload.interval ?? 5),
  };
}

/**
 * Step 2: poll the token endpoint until the user approves the code, the code
 * expires, or `shouldStop()` asks us to give up (config changed, shutdown).
 * @returns {Promise<object|null>} the token payload, or null when we stopped early
 */
export async function pollDeviceToken(clientId, deviceCode, options = {}) {
  const { interval = 5, expiresIn = 300, shouldStop = () => false, sleep = defaultSleep } = options;
  const deadline = Date.now() + expiresIn * 1000;
  let delayMs = interval * 1000;

  while (Date.now() < deadline) {
    if (shouldStop()) {
      return null;
    }
    await sleep(delayMs);

    const body = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
      audience: AUDIENCE,
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = await readJson(response);

    if (response.ok) {
      return payload;
    }
    // The two "keep waiting" answers of RFC 8628. `slow_down` means we poll
    // too fast: the server asks for 5 more seconds between attempts.
    if (payload.error === 'authorization_pending') {
      continue;
    }
    if (payload.error === 'slow_down') {
      delayMs += 5000;
      continue;
    }
    if (payload.error === 'expired_token') {
      throw new YotoAuthError('The Yoto code expired before it was approved', {
        needsRelink: true,
      });
    }
    throw new YotoAuthError(`Yoto refused the authorization: ${describeError(payload)}`, {
      needsRelink: payload.error === 'access_denied',
    });
  }
  throw new YotoAuthError('The Yoto code expired before it was approved', { needsRelink: true });
}

/**
 * Holds the tokens in memory and refreshes them on demand.
 *
 * `onTokensChanged` is how they survive a restart: the integration passes a
 * callback writing them into the Gladys config (`gladys.setConfig`).
 */
export class TokenStore {
  constructor({ onTokensChanged } = {}) {
    this.onTokensChanged = onTokensChanged;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    // Shared promise: concurrent polls of several players must trigger ONE
    // refresh, not one per device.
    this.refreshPromise = null;
  }

  /** Load the tokens read from the Gladys config at startup (no write back). */
  restore({ access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt } = {}) {
    this.accessToken = accessToken ?? null;
    this.refreshToken = refreshToken ?? null;
    this.expiresAt = Number(expiresAt ?? 0);
  }

  /** Store a fresh token payload coming from Yoto, and persist it. */
  async update(payload) {
    this.accessToken = payload.access_token ?? null;
    // A refresh response may omit the refresh token: keep the current one.
    this.refreshToken = payload.refresh_token ?? this.refreshToken;
    this.expiresAt = Date.now() + Number(payload.expires_in ?? 3600) * 1000;
    if (this.onTokensChanged) {
      await this.onTokensChanged({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        expires_at: this.expiresAt,
      });
    }
  }

  /** Forget everything (invalid refresh token: the user must link again). */
  async clear() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    if (this.onTokensChanged) {
      await this.onTokensChanged({ access_token: '', refresh_token: '', expires_at: 0 });
    }
  }

  get linked() {
    return Boolean(this.refreshToken);
  }

  /** Return a usable access token, refreshing it when it is about to expire. */
  async getAccessToken(clientId) {
    if (this.accessToken && Date.now() < this.expiresAt - EXPIRY_MARGIN_SECONDS * 1000) {
      return this.accessToken;
    }
    if (!this.refreshToken) {
      throw new YotoAuthError('No Yoto account linked yet', { needsRelink: true });
    }
    this.refreshPromise = this.refreshPromise ?? this.#refresh(clientId);
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async #refresh(clientId) {
    logger.debug('Refreshing the Yoto access token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: clientId,
      audience: AUDIENCE,
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      // A rejected refresh token never becomes valid again: drop it so the UI
      // asks for a new link instead of retrying forever.
      if (payload.error === 'invalid_grant') {
        await this.clear();
        throw new YotoAuthError('The Yoto link was revoked, please connect again', {
          needsRelink: true,
        });
      }
      throw new YotoAuthError(`Token refresh failed: ${describeError(payload)}`);
    }
    await this.update(payload);
    return this.accessToken;
  }
}

async function postForm(url, body, what, hints = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const hint = hints[payload.error];
    throw new YotoAuthError(
      `Yoto ${what} failed (HTTP ${response.status}): ${hint ?? describeError(payload)}`,
    );
  }
  return payload;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function describeError(payload) {
  return payload.error_description ?? payload.error ?? 'unknown error';
}

function base64Url(buffer) {
  return buffer.toString('base64url');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
