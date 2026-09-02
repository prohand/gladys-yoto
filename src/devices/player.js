// -----------------------------------------------------------------------------
// Device type: YOTO PLAYER
//
// One Gladys device per Yoto player, built from what the Yoto cloud reports.
// Everything here is READ-ONLY: the public Yoto REST API exposes the player
// telemetry (battery, volume, card, sensors) but not the playback commands —
// those travel over the family MQTT channel. The features are therefore
// declared `read_only: true` so the Gladys UI never shows a control that
// would silently do nothing.
//
// Refresh path: Gladys calls `onPoll` every `poll_frequency` seconds ->
// (optionally) ask the player to report -> read the shadow -> publish the
// values that CHANGED (the host API rate-limits states at 300/minute).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { parseStatus, isPlaying } from '../yoto/status.js';

export const DEVICE_TYPE = 'yoto-player';

const logger = createLogger({ name: DEVICE_TYPE });

// Feature keys, kept in one place so discovery and polling always agree.
export const FEATURE = {
  BATTERY: 'battery',
  CHARGING: 'charging',
  VOLUME: 'volume',
  PLAYING: 'playing',
  CARD: 'card',
  AMBIENT_LIGHT: 'ambient-light',
  TEMPERATURE: 'temperature',
  WIFI: 'wifi',
  ONLINE: 'online',
};

/** External ids of one player (`deviceId` is the id Yoto gives the hardware). */
export function playerExternalIds(gladys, deviceId) {
  return gladys.externalIds(DEVICE_TYPE, deviceId);
}

/**
 * Discovery payload of one player.
 * @param {object} player as returned by YotoApi.listDevices()
 * @param {object} config normalized integration config
 */
export function buildPlayerDevice(gladys, player, config) {
  const ids = playerExternalIds(gladys, player.deviceId);
  return {
    name: player.name,
    external_id: ids.device,
    // Gladys calls onPoll at this interval (seconds).
    poll_frequency: config.poll_frequency,
    features: [
      {
        name: 'Battery',
        external_id: ids.feature(FEATURE.BATTERY),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY,
        type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Charging',
        external_id: ids.feature(FEATURE.CHARGING),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY,
        type: DEVICE_FEATURE_TYPES.BATTERY.CHARGING,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Volume',
        external_id: ids.feature(FEATURE.VOLUME),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        // Read-only: the REST API reports the volume but does not set it.
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Playing',
        external_id: ids.feature(FEATURE.PLAYING),
        category: DEVICE_FEATURE_CATEGORIES.SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Card playing',
        external_id: ids.feature(FEATURE.CARD),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Ambient light',
        external_id: ids.feature(FEATURE.AMBIENT_LIGHT),
        category: DEVICE_FEATURE_CATEGORIES.LIGHT_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        // The player reports a raw ambient-light-sensor reading, close enough
        // to lux to be charted, so the unit stays informative.
        unit: DEVICE_FEATURE_UNITS.LUX,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Device temperature',
        external_id: ids.feature(FEATURE.TEMPERATURE),
        category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        unit: DEVICE_FEATURE_UNITS.CELSIUS,
        min: -10,
        max: 90,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Wi-Fi signal',
        external_id: ids.feature(FEATURE.WIFI),
        category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
        type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
        // Reported in dBm: -30 is excellent, below -80 is unusable.
        min: -100,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Online',
        external_id: ids.feature(FEATURE.ONLINE),
        category: DEVICE_FEATURE_CATEGORIES.SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/**
 * Read one player and publish what changed.
 *
 * @param {object} deps
 *   - api       : YotoApi
 *   - cache     : StateCache, so unchanged values are not re-published
 *   - cardTitles: Map<cardId, title>, so a card title is fetched once
 */
export async function pollPlayer(gladys, player, config, { api, cache, cardTitles }) {
  const ids = playerExternalIds(gladys, player.deviceId);

  if (config.request_status_push) {
    // Best effort: the player may be asleep or the app may lack the control
    // scope — we can still read the last status it reported.
    try {
      await api.requestStatusPush(player.deviceId);
    } catch (err) {
      logger.debug(`Status request refused for ${player.name}: ${err.message}`);
    }
  }

  const { online, status: raw } = await api.getDeviceConfig(player.deviceId);
  const status = parseStatus(raw);
  logger.debug(`${player.name}: ${JSON.stringify(status)}`);

  const numericStates = [
    [FEATURE.ONLINE, online === null ? null : Number(online)],
    [FEATURE.BATTERY, status.batteryLevel],
    [FEATURE.CHARGING, booleanToState(status.isCharging)],
    [FEATURE.VOLUME, status.volume],
    [FEATURE.PLAYING, booleanToState(isPlaying(status))],
    [FEATURE.AMBIENT_LIGHT, status.ambientLight],
    [FEATURE.TEMPERATURE, status.deviceTemperature],
    [FEATURE.WIFI, status.wifiStrength],
  ]
    .filter(([, value]) => value !== null)
    .map(([key, value]) => ({ device_feature_external_id: ids.feature(key), state: value }))
    .filter(({ device_feature_external_id: id, state }) => cache.changed(id, state));

  if (numericStates.length > 0) {
    await gladys.publishStates(numericStates);
  }

  await publishCardPlaying(gladys, ids, status, { api, cache, cardTitles });
}

/**
 * The text feature shows the title of the card being played — the id alone
 * ("h2Fbz") means nothing to a user. The title never changes for a given card,
 * so it is fetched once and memoized; without the library scope we degrade to
 * the id rather than losing the feature.
 */
async function publishCardPlaying(gladys, ids, status, { api, cache, cardTitles }) {
  const featureId = ids.feature(FEATURE.CARD);
  let text = '-';

  if (status.activeCard) {
    if (!cardTitles.has(status.activeCard)) {
      try {
        cardTitles.set(status.activeCard, await api.getCardTitle(status.activeCard));
      } catch (err) {
        logger.debug(`Card title unavailable for ${status.activeCard}: ${err.message}`);
        cardTitles.set(status.activeCard, null);
      }
    }
    text = cardTitles.get(status.activeCard) ?? status.activeCard;
  }

  if (cache.changed(featureId, text)) {
    await gladys.publishState(featureId, { text });
  }
}

function booleanToState(value) {
  return value === null ? null : Number(value);
}

/**
 * Remembers the last published value of each feature: polling a fleet of
 * players every minute would otherwise burn the 300 states/minute budget of
 * the host API with values that did not move.
 */
export class StateCache {
  constructor() {
    this.values = new Map();
  }

  changed(featureExternalId, value) {
    if (this.values.get(featureExternalId) === value) {
      return false;
    }
    this.values.set(featureExternalId, value);
    return true;
  }

  clear() {
    this.values.clear();
  }
}
