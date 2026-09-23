// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device layer relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishSceneEvent             -> record the scene events
//   - requestWidgetRefresh          -> record the widget nudges
// This lets us test the wiring logic (discovery payloads, dispatch,
// deduplication) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys({ failSceneEvents = false } = {}) {
  const published = [];
  const sceneEvents = [];
  const widgetRefreshes = [];

  return {
    published,
    sceneEvents,
    widgetRefreshes,

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
          state: state.state,
        });
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
