import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys, createFakeYotoApi } from './helpers/fakeGladys.js';
import { PlayerRegistry } from '../src/devices/index.js';
import { buildPlayerDevice, FEATURE, playerExternalIds } from '../src/devices/player.js';
import { normalizeConfig } from '../src/config.js';

const CONFIG = normalizeConfig({ client_id: 'abc', poll_frequency: 180 });

const PLAYER = { deviceId: 'y2abc123', name: 'Chambre de Léa', online: true };

const STATUS = {
  y2abc123: {
    online: true,
    status: {
      batteryLevel: 87,
      charging: 0,
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

test('buildPlayerDevice carries the poll frequency of the config', () => {
  const gladys = createFakeGladys();
  const device = buildPlayerDevice(gladys, PLAYER, CONFIG);
  assert.equal(device.poll_frequency, 180);
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
  await registry.poll(gladys, device, CONFIG);

  assert.equal(gladys.published.length, afterFirstPoll, 'nothing changed: nothing republished');
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
