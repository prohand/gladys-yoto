// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys >= 5.1).
//
// Two widgets, both built from the snapshots the registry keeps after each
// poll — opening a dashboard never costs a Yoto API call:
//
//   players  every player of the account in one card: what it plays, its
//            battery, online or not
//   player   one player (chosen in the widget settings): live battery,
//            volume and temperature tiles, a 24 h battery curve, the playback
//            and power state
//
// The content is declarative (the core renders it, theme and dark mode
// included): texts are sent in English and French, the core picks the user's
// language. The tiles and the chart are bound to the device features, so they
// follow the published states in real time with no nudge.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE, playerExternalIds } from './devices/player.js';
import { BATTERY_LOW_THRESHOLD } from './scenes.js';

/** Keys declared in the manifest: they are forever, never rename them. */
export const WIDGET = {
  PLAYERS: 'players',
  PLAYER: 'player',
};

/** Key of the "Refresh" button action, the same on both widgets. */
export const WIDGET_ACTION_REFRESH = 'refresh';

// The snapshots only move on a poll (120 s by default): the registry nudges
// the widgets when something changed, this TTL is only the safety net.
const CONTENT_TTL_SECONDS = 120;

// Card-list "list" display shows at most 8 rows.
const MAX_LISTED_PLAYERS = 8;

const REFRESH_BUTTON = {
  type: 'button',
  label: { en: 'Refresh', fr: 'Rafraîchir' },
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: WIDGET_ACTION_REFRESH },
};

/**
 * Content of the "players" widget.
 * @param {object[]} players known players ({ deviceId, name })
 * @param {Map<string, object>} snapshots Yoto deviceId -> last snapshot
 */
export function buildPlayersContent(players, snapshots) {
  if (players.length === 0) {
    return {
      ttl_seconds: CONTENT_TTL_SECONDS,
      components: [
        {
          type: 'text',
          text: {
            en: 'No Yoto player on this account yet.',
            fr: 'Aucun lecteur Yoto sur ce compte pour le moment.',
          },
        },
        REFRESH_BUTTON,
      ],
    };
  }

  const items = players.slice(0, MAX_LISTED_PLAYERS).map((player) => {
    const snapshot = snapshots.get(player.deviceId);
    return {
      title: truncate(player.name, 60),
      subtitle: playingLabel(snapshot, 60),
      badge: batteryBadge(snapshot),
      description: describe(snapshot),
    };
  });

  return {
    ttl_seconds: CONTENT_TTL_SECONDS,
    components: [{ type: 'card-list', display: 'list', items }, REFRESH_BUTTON],
  };
}

/**
 * Content of the "player" widget.
 * @param {object} gladys the SDK instance (builds the feature external ids)
 * @param {object|null} player the player chosen in the settings, null if unknown
 * @param {object|undefined} snapshot its last snapshot
 */
export function buildPlayerContent(gladys, player, snapshot) {
  if (!player) {
    return {
      ttl_seconds: CONTENT_TTL_SECONDS,
      components: [
        {
          type: 'text',
          text: {
            en: 'This Yoto player is no longer on the account: pick another one in the widget settings.',
            fr: 'Ce lecteur Yoto n’est plus sur le compte : choisissez-en un autre dans les réglages du widget.',
          },
        },
      ],
    };
  }

  const ids = playerExternalIds(gladys, player.deviceId);
  return {
    ttl_seconds: CONTENT_TTL_SECONDS,
    components: [
      {
        type: 'value',
        label: { en: 'Battery', fr: 'Batterie' },
        icon: 'battery',
        device_feature: ids.feature(FEATURE.BATTERY),
      },
      {
        type: 'value',
        label: { en: 'Volume', fr: 'Volume' },
        icon: 'volume-2',
        device_feature: ids.feature(FEATURE.VOLUME),
      },
      {
        type: 'value',
        label: { en: 'Temperature', fr: 'Température' },
        icon: 'thermometer',
        device_feature: ids.feature(FEATURE.TEMPERATURE),
      },
      {
        type: 'chart',
        title: { en: 'Battery (24 h)', fr: 'Batterie (24 h)' },
        chart_type: 'line',
        device_features: [ids.feature(FEATURE.BATTERY)],
        interval: 'last-day',
      },
      { type: 'status', items: statusItems(snapshot) },
      REFRESH_BUTTON,
    ],
  };
}

/** Rows of the "player" widget status list. */
function statusItems(snapshot) {
  if (!snapshot) {
    return [
      {
        label: { en: 'State', fr: 'État' },
        value: { en: 'Waiting for the first reading', fr: 'En attente de la première lecture' },
        icon: 'clock',
        color: WIDGET_COLORS.NEUTRAL,
      },
    ];
  }
  const items = [
    {
      label: { en: 'Playing', fr: 'Lecture' },
      value: playingLabel(snapshot, 40),
      icon: snapshot.playing ? 'play' : 'pause',
      color: snapshot.playing ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL,
    },
    {
      label: { en: 'Power', fr: 'Alimentation' },
      value:
        snapshot.charging === null
          ? { en: 'Unknown', fr: 'Inconnue' }
          : snapshot.charging
            ? { en: 'Plugged in', fr: 'Sur secteur' }
            : { en: 'On battery', fr: 'Sur batterie' },
      icon: snapshot.charging ? 'battery-charging' : 'battery',
      color: snapshot.charging ? WIDGET_COLORS.SUCCESS : batteryColor(snapshot.batteryLevel),
    },
    {
      label: { en: 'Connection', fr: 'Connexion' },
      value:
        snapshot.online === false ? { en: 'Offline', fr: 'Hors ligne' } : onlineLabel(snapshot),
      icon: snapshot.online === false ? 'wifi-off' : 'wifi',
      color: snapshot.online === false ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
  ];
  return items;
}

/** "Online · -58 dBm", or plain "Online" when the signal is unknown. */
function onlineLabel(snapshot) {
  if (snapshot.wifiStrength === null) {
    return { en: 'Online', fr: 'En ligne' };
  }
  return {
    en: `Online · ${snapshot.wifiStrength} dBm`,
    fr: `En ligne · ${snapshot.wifiStrength} dBm`,
  };
}

/** What the player is playing, for a subtitle or a status row. */
function playingLabel(snapshot, maxLength) {
  if (!snapshot) {
    return { en: 'Not read yet', fr: 'Pas encore lu' };
  }
  if (snapshot.online === false) {
    return { en: 'Offline', fr: 'Hors ligne' };
  }
  if (snapshot.playing) {
    return truncate(snapshot.cardTitle ?? snapshot.cardId ?? '?', maxLength);
  }
  return { en: 'Nothing playing', fr: 'Rien en lecture' };
}

/** Battery badge of a list row: the level, colored by how urgent it is. */
function batteryBadge(snapshot) {
  if (!snapshot || snapshot.batteryLevel === null) {
    return undefined;
  }
  const plug = snapshot.charging ? ' ⚡' : '';
  return {
    text: `${snapshot.batteryLevel} %${plug}`,
    color: snapshot.charging ? WIDGET_COLORS.SUCCESS : batteryColor(snapshot.batteryLevel),
  };
}

function batteryColor(level) {
  if (level === null || level === undefined) {
    return WIDGET_COLORS.NEUTRAL;
  }
  if (level < BATTERY_LOW_THRESHOLD) {
    return WIDGET_COLORS.DANGER;
  }
  if (level < 50) {
    return WIDGET_COLORS.WARNING;
  }
  return WIDGET_COLORS.SUCCESS;
}

/** Detail panel of a list row: every value the player reported, one per line. */
function describe(snapshot) {
  if (!snapshot) {
    return undefined;
  }
  const lines = { en: [], fr: [] };
  const add = (en, fr) => {
    lines.en.push(en);
    lines.fr.push(fr);
  };
  if (snapshot.volume !== null)
    add(`Volume: ${snapshot.volume} %`, `Volume : ${snapshot.volume} %`);
  if (snapshot.charging !== null) {
    add(
      snapshot.charging ? 'Plugged in' : 'On battery',
      snapshot.charging ? 'Sur secteur' : 'Sur batterie',
    );
  }
  if (snapshot.deviceTemperature !== null) {
    add(
      `Temperature: ${snapshot.deviceTemperature} °C`,
      `Température : ${snapshot.deviceTemperature} °C`,
    );
  }
  if (snapshot.ambientLight !== null) {
    add(`Ambient light: ${snapshot.ambientLight} lx`, `Luminosité : ${snapshot.ambientLight} lx`);
  }
  if (snapshot.wifiStrength !== null) {
    add(`Wi-Fi: ${snapshot.wifiStrength} dBm`, `Wi-Fi : ${snapshot.wifiStrength} dBm`);
  }
  if (lines.en.length === 0) {
    return undefined;
  }
  return { en: lines.en.join('\n'), fr: lines.fr.join('\n') };
}

function truncate(text, maxLength) {
  const value = String(text);
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
