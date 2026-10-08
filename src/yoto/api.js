// -----------------------------------------------------------------------------
// Yoto REST client (https://api.yotoplay.com).
//
// Only three calls are needed to supervise players:
//   GET  /device-v2/devices/mine       -> the players of the family
//   GET  /device-v2/{deviceId}/config  -> settings + the `device.status` block
//                                         (the last telemetry the player
//                                         reported: battery, volume, card…)
//   POST /device-v2/{deviceId}/command/status -> ask the player to report NOW
//
// Why `/config` and not the documented `/device-v2/{id}/status`: that one is
// deprecated by Yoto and needs the extra `family:device-status:view` scope,
// while `/config` carries the very same firmware status block.
//
// Node 20+ ships `fetch`: no HTTP dependency.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { YotoAuthError } from './auth.js';

const logger = createLogger({ name: 'yoto-api' });

export const BASE_URL = 'https://api.yotoplay.com';
const HTTP_TIMEOUT_MS = 20_000;

// How long to wait after asking a player to report before reading its shadow.
// The player answers over MQTT in ~150 ms and the cloud then stores it: read
// right away, the shadow still holds the previous report and the request was a
// wasted call. One second covers the round trip with margin and stays small
// next to the polling interval (30 s at the fastest).
export const STATUS_PUSH_SETTLE_MS = 1000;

/** An error returned by the Yoto API itself (not a network/auth problem). */
export class YotoApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'YotoApiError';
    this.status = status;
  }
}

export class YotoApi {
  /**
   * @param {import('./auth.js').TokenStore} tokenStore
   * @param {() => string} getClientId returns the Client ID of the current config
   */
  constructor(tokenStore, getClientId, { sleep = defaultSleep } = {}) {
    this.tokenStore = tokenStore;
    this.getClientId = getClientId;
    this.sleep = sleep;
  }

  /** The players linked to the Yoto account. */
  async listDevices() {
    const payload = await this.#request('GET', '/device-v2/devices/mine');
    const devices = Array.isArray(payload.devices) ? payload.devices : [];
    return devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name || 'Yoto Player',
      deviceFamily: device.deviceFamily ?? null,
      deviceType: device.deviceType ?? null,
      online: Boolean(device.online),
    }));
  }

  /**
   * Settings + last reported status of one player.
   * @returns {Promise<{ online: boolean|null, status: object, config: object }>}
   */
  async getDeviceConfig(deviceId) {
    const payload = await this.#request('GET', `/device-v2/${encodeURIComponent(deviceId)}/config`);
    const device = payload.device ?? {};
    return {
      online: typeof device.online === 'boolean' ? device.online : null,
      status: device.status ?? {},
      config: device.config ?? {},
    };
  }

  /**
   * Title of a card, to show what is playing instead of a raw id. Needs the
   * `family:library:view` scope; the caller degrades to the id when it throws.
   */
  async getCardTitle(cardId) {
    const payload = await this.#request('GET', `/card/${encodeURIComponent(cardId)}`);
    const card = payload.card ?? payload;
    return card.title ?? card.metadata?.title ?? null;
  }

  /**
   * Ask the player to publish its current status right now. The player answers
   * over MQTT (~150 ms), which the cloud stores in the shadow we read next —
   * so this only makes the following `getDeviceConfig()` fresher, it returns
   * no value of its own. It resolves once that report had time to land
   * (STATUS_PUSH_SETTLE_MS): read at once, the shadow would still hold the
   * previous one. Needs the `family:devices:control` scope.
   */
  async requestStatusPush(deviceId) {
    await this.#request('POST', `/device-v2/${encodeURIComponent(deviceId)}/command/status`, {});
    await this.sleep(STATUS_PUSH_SETTLE_MS);
  }

  /**
   * One authenticated call. A 401 on a token we believed valid means Yoto
   * revoked it before its expiry (a session reset on its side): the refresh
   * token usually still works, so refresh once and replay the call before
   * asking the user for a new link. Only a refresh Yoto refuses
   * (`invalid_grant`, raised by the TokenStore) is a dead link on its own.
   */
  async #request(method, path, body) {
    const token = await this.tokenStore.getAccessToken(this.getClientId());
    const response = await this.#send(method, path, body, token);
    if (response.status !== 401) {
      return this.#read(response, path);
    }
    logger.debug(`${method} ${path}: access token refused, refreshing it once`);
    this.tokenStore.invalidate(token);
    const freshToken = await this.tokenStore.getAccessToken(this.getClientId());
    return this.#read(await this.#send(method, path, body, freshToken), path);
  }

  #send(method, path, body, token) {
    logger.debug(`${method} ${path}`);
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }

  async #read(response, path) {
    if (response.status === 401 || response.status === 403) {
      // 403: the app lacks the scope. 401 here comes after a successful
      // refresh: Yoto refuses even a brand-new token, which no further refresh
      // fixes — both need the user.
      throw new YotoAuthError(
        `Yoto refused the request on ${path} (HTTP ${response.status}): check the scopes of your Yoto app`,
        { needsRelink: response.status === 401 },
      );
    }
    if (!response.ok) {
      throw new YotoApiError(
        `Yoto API error on ${path} (HTTP ${response.status})`,
        response.status,
      );
    }
    if (response.status === 204) {
      return {};
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
