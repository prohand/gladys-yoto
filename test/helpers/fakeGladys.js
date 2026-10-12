// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device layer relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishChangedStates / forgetPublishedStates -> the SDK's deduplication,
//                                      reproduced in memory (see below)
//   - publishSceneEvent             -> record the scene events
//   - requestWidgetRefresh          -> record the widget nudges
// This lets us test the wiring logic (discovery payloads, dispatch,
// deduplication) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys({ failSceneEvents = false } = {}) {
  const published = [];
  const sceneEvents = [];
  const widgetRefreshes = [];
  // Last value Gladys accepted per feature, as the SDK remembers it.
  const publishedStates = new Map();
  const changedStatesCalls = [];

  return {
    published,
    sceneEvents,
    widgetRefreshes,
    publishedStates,
    changedStatesCalls,

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
        return;
      }
      for (const id of [...publishedStates.keys()]) {
        if (id === externalId || id.startsWith(`${externalId}:`)) {
          publishedStates.delete(id);
        }
      }
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
export function createFakeYotoApi({ devices = [], statuses = {}, cardTitles = {} } = {}) {
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

    async getCardTitle(cardId) {
      calls.push({ method: 'getCardTitle', cardId });
      if (!(cardId in cardTitles)) {
        throw new Error('card not found');
      }
      return cardTitles[cardId];
    },
  };
}
