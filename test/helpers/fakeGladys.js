// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device layer relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishChangedStates / forgetPublishedStates -> the SDK's deduplication,
//                                      reproduced in memory (see below)
//   - publishNowPlaying / artworkKey -> the SDK's now-playing diff (texts,
//                                      artwork key), reproduced in memory
//   - publishSceneEvent             -> record the scene events
//   - requestWidgetRefresh          -> record the widget nudges
// This lets us test the wiring logic (discovery payloads, dispatch,
// deduplication) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

import { artworkKey } from '@gladysassistant/integration-sdk';

// The keys of a `nowPlaying` snapshot this integration sends, and the music
// feature type each one feeds (the SDK accepts more: position, duration…).
const NOW_PLAYING_TYPES = {
  playback_state: 'playback_state',
  title: 'title',
  artist: 'artist',
  artwork_url: 'artwork',
};
const NOW_PLAYING_TEXT_TYPES = ['title', 'artist', 'artwork'];

export function createFakeGladys({ failSceneEvents = false } = {}) {
  const published = [];
  const sceneEvents = [];
  const widgetRefreshes = [];
  // Last value Gladys accepted per feature, as the SDK remembers it.
  const publishedStates = new Map();
  const changedStatesCalls = [];
  // Last now-playing values published per device, as the SDK remembers them.
  const nowPlaying = new Map();
  const nowPlayingCalls = [];
  const artworkUrls = new Map();

  return {
    published,
    sceneEvents,
    widgetRefreshes,
    publishedStates,
    changedStatesCalls,
    nowPlayingCalls,
    artworkUrls,

    externalIds(type, platformId) {
      const device = `ext:yoto:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, value) {
      published.push({ featureExternalId, state: value });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.text !== undefined ? { text: state.text } : state.state,
        });
      }
    },

    // Same rules as the SDK 0.15 method: an entry equal (same state, same
    // text) to the last value ACCEPTED for its feature is skipped, within the
    // call too; `heartbeat` re-sends an unchanged value that old; a value is
    // remembered only if publishStates (overridable by a test) accepted it.
    async publishChangedStates(states, { heartbeat } = {}) {
      changedStatesCalls.push({ states, heartbeat });
      const now = Date.now();
      const previous = new Map();
      const changed = states.filter(({ device_feature_external_id: id, state, text }) => {
        const last = previous.has(id) ? previous.get(id) : publishedStates.get(id);
        previous.set(id, { state, text, at: now });
        return (
          last === undefined ||
          last.state !== state ||
          last.text !== text ||
          (heartbeat !== undefined && now - last.at >= heartbeat)
        );
      });
      for (let start = 0; start < changed.length; start += 100) {
        const batch = changed.slice(start, start + 100);
        batch.forEach(({ device_feature_external_id: id, state, text }) =>
          publishedStates.set(id, { state, text, at: now }),
        );
        try {
          await this.publishStates(batch);
        } catch (err) {
          batch.forEach(({ device_feature_external_id: id }) => publishedStates.delete(id));
          throw err;
        }
      }
      return { success: true, count: changed.length };
    },

    // The SDK calls it itself when Gladys creates, updates or deletes a
    // device; a test plays that part by calling it.
    forgetPublishedStates(externalId) {
      if (externalId === undefined) {
        publishedStates.clear();
        nowPlaying.clear();
        return;
      }
      nowPlaying.delete(externalId);
      for (const id of [...publishedStates.keys()]) {
        if (id === externalId || id.startsWith(`${externalId}:`)) {
          publishedStates.delete(id);
        }
      }
    },

    artworkKey(url) {
      const key = artworkKey(url);
      artworkUrls.set(key, url);
      return key;
    },

    // Same rules as the SDK 0.16 method, for the keys this integration sends:
    // an absent key is "unchanged", only the values that moved since the last
    // snapshot ACCEPTED for the device are published, in one batch; texts go
    // as `text`, `artwork_url` becomes its key (null: an empty artwork).
    async publishNowPlaying(deviceExternalId, values, { featureExternalIds = {} } = {}) {
      nowPlayingCalls.push({ deviceExternalId, values, featureExternalIds });
      const previous = nowPlaying.get(deviceExternalId) ?? {};
      const next = { ...previous };
      const states = [];
      for (const [key, value] of Object.entries(values)) {
        const type = NOW_PLAYING_TYPES[key];
        if (type === undefined) {
          throw new Error(`publishNowPlaying: unknown key "${key}"`);
        }
        let normalized = value;
        if (key === 'artwork_url') {
          normalized = value === null ? '' : this.artworkKey(value);
        }
        next[type] = normalized;
        if (previous[type] === normalized) {
          continue;
        }
        const state = {
          device_feature_external_id: featureExternalIds[type] ?? `${deviceExternalId}:${type}`,
        };
        if (NOW_PLAYING_TEXT_TYPES.includes(type)) {
          state.text = normalized;
        } else {
          state.state = normalized;
        }
        states.push(state);
      }
      if (states.length === 0) {
        return { success: true, count: 0 };
      }
      await this.publishStates(states);
      nowPlaying.set(deviceExternalId, next);
      return { success: true, count: states.length };
    },

    async publishSceneEvent(key, data) {
      if (failSceneEvents) {
        throw new Error('429 too many events');
      }
      sceneEvents.push({ key, data });
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },
  };
}

/**
 * Stand-in for the Yoto REST client: canned answers, and a log of the calls so
 * a test can assert that a status push was requested (or not).
 */
export function createFakeYotoApi({
  devices = [],
  statuses = {},
  cardTitles = {},
  cards = {},
} = {}) {
  const calls = [];

  return {
    calls,

    async listDevices() {
      calls.push({ method: 'listDevices' });
      return devices;
    },

    async getDeviceConfig(deviceId) {
      calls.push({ method: 'getDeviceConfig', deviceId });
      return statuses[deviceId] ?? { online: true, status: {}, config: {} };
    },

    async requestStatusPush(deviceId) {
      calls.push({ method: 'requestStatusPush', deviceId });
    },

    // `cards` gives a full card (title, author, coverUrl), `cardTitles` a
    // title alone; a card in neither is a failed request.
    async getCard(cardId) {
      calls.push({ method: 'getCard', cardId });
      if (cardId in cards) {
        return { title: null, author: null, coverUrl: null, ...cards[cardId] };
      }
      if (!(cardId in cardTitles)) {
        throw new Error('card not found');
      }
      return { title: cardTitles[cardId], author: null, coverUrl: null };
    },
  };
}
