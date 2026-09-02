// -----------------------------------------------------------------------------
// Player registry.
//
// Unlike a template with hard-coded devices, the devices here are DISCOVERED:
// the list comes from the Yoto account, so a player added (or renamed) in the
// Yoto app shows up on the next scan.
//
// The registry owns what has to survive between two polls: the known players,
// the last published values (rate-limit friendly) and the card-title cache.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
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
    let player = this.findPlayer(gladys, device.external_id);
    if (!player) {
      await this.refresh();
      player = this.findPlayer(gladys, device.external_id);
    }
    if (!player) {
      logger.warn(`No Yoto player matches ${device.external_id} (removed from the account?)`);
      return;
    }
    await pollPlayer(gladys, player, config, {
      api: this.api,
      cache: this.cache,
      cardTitles: this.cardTitles,
    });
  }

  /** Poll every known player (manifest action "refresh_now"). */
  async pollAll(gladys, config) {
    for (const player of this.players.values()) {
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
  }
}

export { DEVICE_TYPE };
