// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device layer relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
// This lets us test the wiring logic (discovery payloads, dispatch,
// deduplication) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];

  return {
    published,

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
