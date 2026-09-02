// -----------------------------------------------------------------------------
// Player registry.
//
// Unlike a template with hard-coded devices, the devices here are DISCOVERED:
// the list comes from the Yoto account, so a player added (or renamed) in the
// Yoto app shows up on the next scan.
//
// The registry owns what has to survive between two polls: the known players,
// the last published values (rate-limit friendly), the card-title cache and
// the date of the last poll of each player (Gladys never ticks slower than a
// minute: a longer interval is enforced here).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { gladysPollFrequency } from '../config.js';
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
    this.lastPollAt.set(device.external_id, Date.now());
    await pollPlayer(gladys, player, config, {
      api: this.api,
      cache: this.cache,
      cardTitles: this.cardTitles,
    });
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
      this.lastPollAt.set(playerExternalIds(gladys, player.deviceId).device, Date.now());
      await pollPlayer(gladys, player, config, {
        api: this.api,
        cache: this.cache,
        cardTitles: this.cardTitles,
      });
    }
    return this.players.size;
  }

  /** Values must be re-published after a reconnection: Gladys may have missed them. */
  clearCache() {
    this.cache.clear();
    // Same reason: the next tick must poll instead of waiting for the interval.
    this.lastPollAt.clear();
  }
}

export { DEVICE_TYPE };
