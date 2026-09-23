// -----------------------------------------------------------------------------
// Scene triggers and scene actions (Gladys >= 5.1).
//
// A device feature already carries every VALUE of a player (battery, volume,
// playing…): a scene can trigger on those with the standard device triggers.
// What a feature cannot carry is an EVENT with its details — "the card
// 'Bedtime stories' just started on Léa's player" — and an OPERATION with a
// result — "read this player now and tell me its battery". That is what this
// module adds:
//
//   triggers  card_started   a card (or a stream) starts on a player
//             card_stopped   the player stops playing
//             battery_low    the battery drops under BATTERY_LOW_THRESHOLD %
//   actions   get_player_status  read one player now, return its values
//             refresh_players    read every player now
//
// Events are computed by comparing two snapshots of the same player: one
// event per transition, never one per poll, and nothing on the first reading
// after a start (a restart must not replay "card started" on every player).
// -----------------------------------------------------------------------------

/** Keys declared in the manifest: they are forever, never rename them. */
export const SCENE_TRIGGER = {
  CARD_STARTED: 'card_started',
  CARD_STOPPED: 'card_stopped',
  BATTERY_LOW: 'battery_low',
};

export const SCENE_ACTION = {
  GET_PLAYER_STATUS: 'get_player_status',
  REFRESH_PLAYERS: 'refresh_players',
};

/** Under this level (%), a player not on power fires battery_low. */
export const BATTERY_LOW_THRESHOLD = 20;

/**
 * Hysteresis: the battery must climb back above threshold + margin (or the
 * player be plugged in) before battery_low can fire again, so a level
 * wobbling around 20 % does not fire every poll.
 */
const BATTERY_LOW_REARM_MARGIN = 5;

/**
 * Events between two snapshots of the same player.
 *
 * @param {object|undefined} previous last snapshot (undefined on the first reading)
 * @param {object} current new snapshot (see buildSnapshot in devices/player.js)
 * @param {string} deviceExternalId Gladys external_id of the player: the value
 *   the `player` filter of the scene editor compares against
 * @returns {{ key: string, data: object }[]}
 */
export function detectSceneEvents(previous, current, deviceExternalId) {
  if (!previous) {
    return [];
  }
  const events = [];
  const base = { player: deviceExternalId, player_name: current.name };

  // A new card id while playing is a start, whether the player was idle or
  // another card was playing (card swapped without stopping in between).
  if (current.playing === true && current.cardId && current.cardId !== previous.cardId) {
    events.push({
      key: SCENE_TRIGGER.CARD_STARTED,
      data: { ...base, card_id: current.cardId, card_title: current.cardTitle ?? current.cardId },
    });
  }

  if (previous.playing === true && current.playing === false) {
    events.push({
      key: SCENE_TRIGGER.CARD_STOPPED,
      data: {
        ...base,
        card_id: previous.cardId,
        card_title: previous.cardTitle ?? previous.cardId,
      },
    });
  }

  // The latch is carried by the registry from one snapshot to the next.
  if (isBatteryLow(current) && previous.batteryLowLatched !== true) {
    events.push({
      key: SCENE_TRIGGER.BATTERY_LOW,
      data: { ...base, battery: current.batteryLevel },
    });
  }

  return events;
}

function isBatteryLow(snapshot) {
  return (
    snapshot.batteryLevel !== null &&
    snapshot.batteryLevel !== undefined &&
    snapshot.batteryLevel < BATTERY_LOW_THRESHOLD &&
    snapshot.charging !== true
  );
}

/**
 * Carry the battery_low latch from one snapshot to the next: set when the
 * battery is low, cleared once the player is plugged in or the level is back
 * above threshold + margin.
 */
export function nextBatteryLowLatch(previous, current) {
  if (isBatteryLow(current)) {
    return true;
  }
  if (current.charging === true) {
    return false;
  }
  if (
    current.batteryLevel !== null &&
    current.batteryLevel >= BATTERY_LOW_THRESHOLD + BATTERY_LOW_REARM_MARGIN
  ) {
    return false;
  }
  return previous?.batteryLowLatched === true;
}

/**
 * Outputs of the get_player_status scene action: the scalars the manifest
 * declares, `null` when the player did not report the value.
 */
export function playerStatusOutputs(snapshot) {
  return {
    player_name: snapshot.name,
    online: snapshot.online,
    battery: snapshot.batteryLevel,
    charging: snapshot.charging,
    volume: snapshot.volume,
    playing: snapshot.playing,
    card_title: snapshot.cardTitle ?? '',
    temperature: snapshot.deviceTemperature,
    wifi_signal: snapshot.wifiStrength,
  };
}
