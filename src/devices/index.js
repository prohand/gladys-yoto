// -----------------------------------------------------------------------------
// Player registry.
//
// Unlike a template with hard-coded devices, the devices here are DISCOVERED:
// the list comes from the Yoto account, so a player added (or renamed) in the
// Yoto app shows up on the next scan.
//
// The registry owns what has to survive between two polls: the known players,
// the last published values (rate-limit friendly), the card-title cache, the
// date of the last poll of each player (Gladys never ticks slower than a
// minute: a longer interval is enforced here) and the last snapshot of each
// player — the dashboard widgets are drawn from it, and comparing two
// snapshots is what fires the scene triggers.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
import { detectSceneEvents, nextBatteryLowLatch } from '../scenes.js';
import { WIDGET } from '../widgets.js';
import {
  buildPlayerDevice,
  playerExternalIds,
  pollPlayer,
  StateCache,
  DEVICE_TYPE,
} from './player.js';

const logger = createLogger({ name: 'registry' });

export class PlayerRegistry {
  /** @param {import('../yoto/api.js').YotoApi} api */
  constructor(api) {
    this.api = api;
    /** @type {Map<string, object>} Yoto deviceId -> player */
    this.players = new Map();
    this.cache = new StateCache();
    this.cardTitles = new Map();
    /** @type {Map<string, number>} Gladys external_id -> date of the last poll */
    this.lastPollAt = new Map();
    /** @type {Map<string, object>} Yoto deviceId -> last snapshot (see buildSnapshot) */
    this.snapshots = new Map();
  }

  /** Re-read the player list from the Yoto account. */
  async refresh() {
    const players = await this.api.listDevices();
    this.players = new Map(players.map((player) => [player.deviceId, player]));
    logger.info(`${players.length} Yoto player(s) found on the account`);
    return players;
  }

  /** Discovery payload for Gladys: one device per player. */
  buildDiscoveredDevices(gladys, config) {
    return [...this.players.values()].map((player) => buildPlayerDevice(gladys, player, config));
  }

  /**
   * Route a Gladys device back to its Yoto player. External ids are built by
   * the SDK (`ext:<selector>:yoto-player:<deviceId>`), so the match is done on
   * the id we would build for each known player — never by parsing the string.
   */
  findPlayer(gladys, externalId) {
    for (const player of this.players.values()) {
      if (playerExternalIds(gladys, player.deviceId).device === externalId) {
        return player;
      }
    }
    return null;
  }

  /**
   * Poll one device asked by the Gladys scheduler. A device created before a
   * restart can be polled before any scan happened: refresh the list once
   * before giving up.
   */
  async poll(gladys, device, config) {
    if (!this.isDue(device.external_id, config)) {
      logger.debug(`${device.external_id}: too early, the configured interval is not elapsed yet`);
      return;
    }
    let player = this.findPlayer(gladys, device.external_id);
    if (!player) {
      await this.refresh();
      player = this.findPlayer(gladys, device.external_id);
    }
    if (!player) {
      logger.warn(`No Yoto player matches ${device.external_id} (removed from the account?)`);
      return;
    }
    await this.pollOne(gladys, player, config);
  }

  /**
   * Gladys ticks the device at most every 60 s (its slowest scheduled
   * frequency), so an interval above one minute has to be enforced here: the
   * ticks landing before the configured interval are simply skipped.
   *
   * The tolerance absorbs the drift of the core scheduler: a tick firing a few
   * milliseconds late must not push a 120 s interval to the next 60 s tick,
   * which would turn it into 180 s.
   */
  isDue(externalId, config, now = Date.now()) {
    const last = this.lastPollAt.get(externalId);
    if (last === undefined) {
      return true;
    }
    const tick = gladysPollFrequency(config.poll_frequency);
    const tolerance = Math.min(5000, tick / 2);
    return now - last >= config.poll_frequency * 1000 - tolerance;
  }

  /** Poll every known player (manifest action "refresh_now"), interval or not. */
  async pollAll(gladys, config) {
    for (const player of this.players.values()) {
      await this.pollOne(gladys, player, config);
    }
    return this.players.size;
  }

  /**
   * Read one player now, interval or not, and propagate the result: states
   * to its device, scene events for what changed since the last reading,
   * and a refresh nudge to the widgets when their content moved.
   * @returns {Promise<object>} the new snapshot
   */
  async pollOne(gladys, player, config) {
    const externalId = playerExternalIds(gladys, player.deviceId).device;
    this.lastPollAt.set(externalId, Date.now());
    const snapshot = await pollPlayer(gladys, player, config, {
      api: this.api,
      cache: this.cache,
      cardTitles: this.cardTitles,
    });

    const previous = this.snapshots.get(player.deviceId);
    snapshot.batteryLowLatched = nextBatteryLowLatch(previous, snapshot);
    this.snapshots.set(player.deviceId, snapshot);

    for (const event of detectSceneEvents(previous, snapshot, externalId)) {
      // A scene event is a bonus on top of the states: a refused event
      // (rate limit, core without scene support) must never fail the poll.
      try {
        await gladys.publishSceneEvent(event.key, event.data);
        logger.info(`${player.name}: scene event ${event.key}`);
      } catch (err) {
        logger.warn(`${player.name}: scene event ${event.key} refused: ${err.message}`);
      }
    }

    if (widgetContentChanged(previous, snapshot)) {
      this.requestWidgetRefresh(gladys);
    }
    return snapshot;
  }

  /**
   * The player behind a Gladys external_id — what a `source: "devices"`
   * select of a widget or a scene action hands over. A player added since the
   * last scan is found by re-reading the account once.
   */
  async resolvePlayer(gladys, externalId) {
    const player = this.findPlayer(gladys, externalId);
    if (player || !externalId) {
      return player;
    }
    await this.refresh();
    return this.findPlayer(gladys, externalId);
  }

  /** "Re-pull me now" to both widgets: fire-and-forget, rate-limited core-side. */
  requestWidgetRefresh(gladys) {
    for (const key of Object.values(WIDGET)) {
      try {
        gladys.requestWidgetRefresh(key);
      } catch (err) {
        logger.debug(`Widget refresh nudge for ${key} failed: ${err.message}`);
      }
    }
  }

  /** Values must be re-published after a reconnection: Gladys may have missed them. */
  clearCache() {
    this.cache.clear();
    // Same reason: the next tick must poll instead of waiting for the interval.
    this.lastPollAt.clear();
  }
}

/**
 * True when what the widgets DRAW from the snapshot moved. The live tiles and
 * the chart follow the device states on their own: only the text parts
 * (playing, power, connection, battery badge) need a nudge.
 */
function widgetContentChanged(previous, current) {
  if (!previous) {
    return true;
  }
  return [
    'online',
    'batteryLevel',
    'charging',
    'playing',
    'cardId',
    'cardTitle',
    'wifiStrength',
  ].some((key) => previous[key] !== current[key]);
}

export { DEVICE_TYPE };
