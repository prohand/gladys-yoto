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
  constructor(tokenStore, getClientId) {
    this.tokenStore = tokenStore;
    this.getClientId = getClientId;
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
   * no value of its own. Needs the `family:devices:control` scope.
   */
  async requestStatusPush(deviceId) {
    await this.#request('POST', `/device-v2/${encodeURIComponent(deviceId)}/command/status`, {});
  }

  async #request(method, path, body) {
    const token = await this.tokenStore.getAccessToken(this.getClientId());
    const url = `${BASE_URL}${path}`;
    logger.debug(`${method} ${path}`);

    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      // The token was accepted at refresh time but is refused here: either it
      // was revoked, or the app lacks the scope. Both need the user.
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
