import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys, createFakeYotoApi } from './helpers/fakeGladys.js';
import { PlayerRegistry } from '../src/devices/index.js';
import {
  buildPlayerDevice,
  FEATURE,
  playerExternalIds,
  StateCache,
  STATE_HEARTBEAT_MS,
  CARD_TITLE_RETRY_MS,
} from '../src/devices/player.js';
import { normalizeConfig } from '../src/config.js';

const CONFIG = normalizeConfig({ client_id: 'abc', poll_frequency: 180 });

const PLAYER = { deviceId: 'y2abc123', name: 'Chambre de Léa', online: true };

const STATUS = {
  y2abc123: {
    online: true,
    status: {
      batteryLevel: 87,
      charging: 0,
      powerSrc: 0,
      userVolume: 42,
      cardInserted: 1,
      activeCard: 'h2Fbz',
      als: 120,
      temp: '31:29',
      wifiStrength: -58,
    },
    config: {},
  },
};

function stateOf(gladys, key) {
  const id = `${playerExternalIds(gladys, PLAYER.deviceId).device}:${key}`;
  return gladys.published.filter((entry) => entry.featureExternalId === id).pop()?.state;
}

test('buildPlayerDevice asks Gladys to poll it on an accepted frequency', () => {
  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  // 180 s is not a frequency Gladys schedules: the device rides the 60 s tick
  // and the registry skips the ticks in between.
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 60000);
  assert.equal(device.name, 'Chambre de Léa');
});

test('every feature is read-only and has a unique external id', () => {
  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  const ids = device.features.map((feature) => feature.external_id);
  assert.equal(new Set(ids).size, ids.length);
  for (const feature of device.features) {
    assert.equal(feature.read_only, true, `${feature.name} must be read-only`);
    assert.ok(feature.external_id.includes(PLAYER.deviceId), 'ids must carry the Yoto device id');
  }
});

test('only the battery level sits in the battery category', () => {
  // The weekly battery check of Gladys reads EVERY feature of the battery
  // category as a percentage, whatever its type: a 0/1 "charging" feature
  // there made a plugged player report "battery under 10 % (current: 1 %)".
  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  const battery = device.features.filter(
    (feature) => feature.category === DEVICE_FEATURE_CATEGORIES.BATTERY,
  );
  assert.deepEqual(
    battery.map((feature) => feature.type),
    [DEVICE_FEATURE_TYPES.BATTERY.INTEGER],
  );
});

test('every feature uses a category, a type and a unit Gladys knows', () => {
  // Gladys refuses the whole discovery payload with "unknown category" (400)
  // when a single feature carries a constant that does not exist — a typo or
  // an SDK constant we imagined, like the absent SENSOR category.
  const categories = new Set(Object.values(DEVICE_FEATURE_CATEGORIES));
  const types = new Set(
    Object.values(DEVICE_FEATURE_TYPES).flatMap((group) => Object.values(group)),
  );
  const units = new Set(Object.values(DEVICE_FEATURE_UNITS));

  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  for (const feature of device.features) {
    assert.ok(
      categories.has(feature.category),
      `${feature.name}: unknown category ${feature.category}`,
    );
    assert.ok(types.has(feature.type), `${feature.name}: unknown type ${feature.type}`);
    if (feature.unit !== undefined) {
      assert.ok(units.has(feature.unit), `${feature.name}: unknown unit ${feature.unit}`);
    }
  }
});

test('every feature carries the min/max Gladys stores as NOT NULL', () => {
  // The core refuses the whole device with 422 UNPROCESSABLE_ENTITY
  // ("t_device_feature.min cannot be null") when a single feature omits them,
  // text features included.
  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  for (const feature of device.features) {
    assert.equal(typeof feature.min, 'number', `${feature.name}: min must be a number`);
    assert.equal(typeof feature.max, 'number', `${feature.name}: max must be a number`);
    assert.ok(feature.min <= feature.max, `${feature.name}: min must not exceed max`);
  }
});

test('the registry discovers one Gladys device per Yoto player', async () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(
    createFakeYotoApi({
      devices: [PLAYER, { deviceId: 'y2def456', name: 'Salon', online: false }],
    }),
  );
  await registry.refresh();
  const devices = registry.buildDiscoveredDevices(gladys, CONFIG);
  assert.equal(devices.length, 2);
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Chambre de Léa', 'Salon'],
  );
});

test('polling publishes the player telemetry', async () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(
    createFakeYotoApi({
      devices: [PLAYER],
      statuses: STATUS,
      cardTitles: { h2Fbz: 'Le Gruffalo' },
    }),
  );
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);

  assert.equal(stateOf(gladys, FEATURE.BATTERY), 87);
  assert.equal(stateOf(gladys, FEATURE.CHARGING), 0);
  assert.equal(stateOf(gladys, FEATURE.VOLUME), 42);
  assert.equal(stateOf(gladys, FEATURE.PLAYING), 1);
  assert.equal(stateOf(gladys, FEATURE.ONLINE), 1);
  assert.equal(stateOf(gladys, FEATURE.AMBIENT_LIGHT), 120);
  assert.equal(stateOf(gladys, FEATURE.TEMPERATURE), 29);
  assert.equal(stateOf(gladys, FEATURE.WIFI), -58);
  assert.deepEqual(stateOf(gladys, FEATURE.CARD), { text: 'Le Gruffalo' });
});

test('a player left on its dock with a full battery is published as charging', async () => {
  // The firmware clears `charging` once the battery is full, so the plug
  // (`powerSrc`) is what tells the player apart from one running on battery —
  // the Yoto app shows "Charged" here, Gladys used to show "Not charging".
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(
    createFakeYotoApi({
      devices: [PLAYER],
      statuses: {
        y2abc123: {
          online: true,
          status: { ...STATUS.y2abc123.status, batteryLevel: 100, charging: 0, powerSrc: 2 },
          config: {},
        },
      },
      cardTitles: { h2Fbz: 'Le Gruffalo' },
    }),
  );
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);

  assert.equal(stateOf(gladys, FEATURE.CHARGING), 1);
  assert.equal(stateOf(gladys, FEATURE.BATTERY), 100);
});

test('polling does not republish values that did not change', async () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(
    createFakeYotoApi({
      devices: [PLAYER],
      statuses: STATUS,
      cardTitles: { h2Fbz: 'Le Gruffalo' },
    }),
  );
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);
  const afterFirstPoll = gladys.published.length;
  registry.lastPollAt.clear(); // the interval is not what is tested here
  await registry.poll(gladys, device, CONFIG);

  assert.equal(gladys.published.length, afterFirstPoll, 'nothing changed: nothing republished');
});

test('a Gladys tick landing before the configured interval is skipped', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api);
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  // CONFIG asks for 180 s, Gladys ticks every 60 s: only the first read hits
  // the Yoto cloud.
  await registry.poll(gladys, device, CONFIG);
  await registry.poll(gladys, device, CONFIG);

  assert.equal(api.calls.filter((call) => call.method === 'getDeviceConfig').length, 1);
});

test('a tick firing slightly early still polls (scheduler drift)', () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(createFakeYotoApi({ devices: [PLAYER] }));
  const externalId = playerExternalIds(gladys, PLAYER.deviceId).device;
  const start = Date.now();
  registry.lastPollAt.set(externalId, start);

  assert.equal(registry.isDue(externalId, CONFIG, start + 120_000), false);
  // 180 s minus the 5 s tolerance: the tick must not be pushed to 240 s.
  assert.equal(registry.isDue(externalId, CONFIG, start + 179_000), true);
  assert.equal(registry.isDue(externalId, CONFIG, start + 180_000), true);
});

test('"refresh now" reads every player whatever the interval', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api);
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);
  await registry.pollAll(gladys, CONFIG);

  assert.equal(api.calls.filter((call) => call.method === 'getDeviceConfig').length, 2);
});

test('a reconnection re-arms the poll instead of waiting for the interval', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api);
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);
  registry.clearCache();
  await registry.poll(gladys, device, CONFIG);

  assert.equal(api.calls.filter((call) => call.method === 'getDeviceConfig').length, 2);
});

test('the card title falls back to the card id when the library is not readable', async () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(
    createFakeYotoApi({ devices: [PLAYER], statuses: STATUS, cardTitles: {} }),
  );
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, CONFIG);

  assert.deepEqual(stateOf(gladys, FEATURE.CARD), { text: 'h2Fbz' });
});

test('the status push is skipped when the user disabled it', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api);
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];

  await registry.poll(gladys, device, { ...CONFIG, request_status_push: false });

  assert.equal(
    api.calls.some((call) => call.method === 'requestStatusPush'),
    false,
  );
});

test('polling an unknown device refreshes the player list once', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api);
  // No refresh() yet: the device was created before a restart.
  const device = { external_id: playerExternalIds(gladys, PLAYER.deviceId).device };

  await registry.poll(gladys, device, CONFIG);

  assert.equal(api.calls.filter((call) => call.method === 'listDevices').length, 1);
  assert.equal(stateOf(gladys, FEATURE.BATTERY), 87);
});

test('polling a device removed from the Yoto account stays silent', async () => {
  const gladys = createFakeGladys();
  const registry = new PlayerRegistry(createFakeYotoApi({ devices: [] }));
  await registry.poll(gladys, { external_id: 'ext:yoto:yoto-player:gone' }, CONFIG);
  assert.equal(gladys.published.length, 0);
});

test('a player removed from the account re-reads the account once per interval, not per tick', async () => {
  // Only a successful lookup used to record the poll: a device still in Gladys
  // whose player left the account listed the whole account every minute.
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [] });
  let clock = 1_000_000;
  const registry = new PlayerRegistry(api, { now: () => clock });
  const device = { external_id: 'ext:yoto:yoto-player:gone' };

  await registry.poll(gladys, device, CONFIG);
  clock += 60_000;
  await registry.poll(gladys, device, CONFIG);
  clock += 60_000;
  await registry.poll(gladys, device, CONFIG);
  assert.equal(api.calls.filter((call) => call.method === 'listDevices').length, 1);

  clock += 60_000; // 180 s: the configured interval elapsed
  await registry.poll(gladys, device, CONFIG);
  assert.equal(api.calls.filter((call) => call.method === 'listDevices').length, 2);
});

test('no Yoto call is made while no account is linked', async () => {
  // Every tick used to fail with "No Yoto account linked yet", logged as an
  // error once a minute per device.
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS });
  const registry = new PlayerRegistry(api, { isLinked: () => false });
  const device = { external_id: playerExternalIds(gladys, PLAYER.deviceId).device };

  assert.equal(await registry.poll(gladys, device, CONFIG), null);
  assert.equal(api.calls.length, 0);
  assert.equal(gladys.published.length, 0);
});

test('a card title Yoto failed to give is asked again after a while, not forever', async () => {
  const gladys = createFakeGladys();
  const cardTitles = {};
  const api = createFakeYotoApi({ devices: [PLAYER], statuses: STATUS, cardTitles });
  let clock = 1_000_000;
  const registry = new PlayerRegistry(api, { now: () => clock });
  await registry.refresh();
  const titleCalls = () => api.calls.filter((call) => call.method === 'getCardTitle').length;

  await registry.pollAll(gladys, CONFIG);
  assert.deepEqual(stateOf(gladys, FEATURE.CARD), { text: 'h2Fbz' });

  cardTitles.h2Fbz = 'Le Gruffalo'; // Yoto answers again
  clock += CARD_TITLE_RETRY_MS - 1;
  await registry.pollAll(gladys, CONFIG);
  assert.equal(titleCalls(), 1, 'a failure is not retried on every poll');

  clock += 1;
  await registry.pollAll(gladys, CONFIG);
  assert.equal(titleCalls(), 2);
  assert.deepEqual(stateOf(gladys, FEATURE.CARD), { text: 'Le Gruffalo' });

  clock += CARD_TITLE_RETRY_MS;
  await registry.pollAll(gladys, CONFIG);
  assert.equal(titleCalls(), 2, 'a title Yoto gave is kept for good');
});

function registryWithPlayer() {
  return new PlayerRegistry(
    createFakeYotoApi({
      devices: [PLAYER],
      statuses: STATUS,
      cardTitles: { h2Fbz: 'Le Gruffalo' },
    }),
  );
}

test('a device created after a first read gets every value again', async () => {
  const gladys = createFakeGladys();
  const registry = registryWithPlayer();
  await registry.refresh();
  // "Refresh now" read the player before the user added its device: Gladys
  // dropped those states.
  await registry.pollAll(gladys, CONFIG);
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];
  const before = gladys.published.length;

  registry.forgetDevice(device.external_id);
  await registry.poll(gladys, device, CONFIG);

  assert.ok(gladys.published.length - before >= 9, 'every feature published again');
});

test('an unchanged value is republished once the heartbeat elapsed', () => {
  const cache = new StateCache();
  assert.equal(cache.changed('f', 1, 0), true);
  cache.remember('f', 1, 0);
  assert.equal(cache.changed('f', 1, STATE_HEARTBEAT_MS - 1), false);
  assert.equal(cache.changed('f', 1, STATE_HEARTBEAT_MS), true);
  assert.equal(cache.changed('f', 2, 1), true);
});

test('a failed publication is retried on the next poll', async () => {
  const gladys = createFakeGladys();
  const registry = registryWithPlayer();
  await registry.refresh();
  const device = registry.buildDiscoveredDevices(gladys, CONFIG)[0];
  const publishStates = gladys.publishStates;
  gladys.publishStates = async () => {
    throw new Error('Gladys unreachable');
  };
  await assert.rejects(() => registry.poll(gladys, device, CONFIG));
  gladys.publishStates = publishStates;
  registry.lastPollAt.clear();
  await registry.poll(gladys, device, CONFIG);
  assert.equal(stateOf(gladys, FEATURE.BATTERY), 87);
});
