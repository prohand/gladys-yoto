import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTERY_LOW_THRESHOLD,
  SCENE_TRIGGER,
  detectSceneEvents,
  nextBatteryLowLatch,
  playerStatusOutputs,
} from '../src/scenes.js';
import { createFakeGladys, createFakeYotoApi } from './helpers/fakeGladys.js';
import { PlayerRegistry } from '../src/devices/index.js';
import { playerExternalIds } from '../src/devices/player.js';
import { normalizeConfig } from '../src/config.js';

const DEVICE = 'ext:yoto:yoto-player:y2abc123';

function snapshot(overrides = {}) {
  return {
    deviceId: 'y2abc123',
    name: 'Chambre de Léa',
    online: true,
    batteryLevel: 80,
    charging: false,
    volume: 40,
    playing: false,
    cardId: null,
    cardTitle: null,
    ambientLight: 100,
    deviceTemperature: 29,
    wifiStrength: -58,
    batteryLowLatched: false,
    ...overrides,
  };
}

const PLAYING = { playing: true, cardId: 'h2Fbz', cardTitle: 'Histoires du soir' };

test('nothing fires on the first reading: a restart must not replay events', () => {
  assert.deepEqual(detectSceneEvents(undefined, snapshot(PLAYING), DEVICE), []);
});

test('card_started carries the player and the card', () => {
  const events = detectSceneEvents(snapshot(), snapshot(PLAYING), DEVICE);
  assert.deepEqual(events, [
    {
      key: SCENE_TRIGGER.CARD_STARTED,
      data: {
        player: DEVICE,
        player_name: 'Chambre de Léa',
        card_id: 'h2Fbz',
        card_title: 'Histoires du soir',
      },
    },
  ]);
});

test('the same card on two polls fires only once', () => {
  assert.deepEqual(detectSceneEvents(snapshot(PLAYING), snapshot(PLAYING), DEVICE), []);
});

test('a card swapped for another one is a new start', () => {
  const next = snapshot({ playing: true, cardId: 'k9Zz', cardTitle: 'Comptines' });
  const events = detectSceneEvents(snapshot(PLAYING), next, DEVICE);
  assert.deepEqual(
    events.map((event) => [event.key, event.data.card_title]),
    [[SCENE_TRIGGER.CARD_STARTED, 'Comptines']],
  );
});

test('card_stopped names the card that was playing', () => {
  const events = detectSceneEvents(snapshot(PLAYING), snapshot(), DEVICE);
  assert.deepEqual(events, [
    {
      key: SCENE_TRIGGER.CARD_STOPPED,
      data: {
        player: DEVICE,
        player_name: 'Chambre de Léa',
        card_id: 'h2Fbz',
        card_title: 'Histoires du soir',
      },
    },
  ]);
});

test('a player going offline (playing unknown) is not a stop', () => {
  const offline = snapshot({ online: false, playing: null, cardId: null });
  assert.deepEqual(detectSceneEvents(snapshot(PLAYING), offline, DEVICE), []);
});

test('battery_low fires once when crossing the threshold on battery', () => {
  const low = snapshot({ batteryLevel: BATTERY_LOW_THRESHOLD - 1 });
  const events = detectSceneEvents(snapshot(), low, DEVICE);
  assert.deepEqual(events, [
    {
      key: SCENE_TRIGGER.BATTERY_LOW,
      data: { player: DEVICE, player_name: 'Chambre de Léa', battery: BATTERY_LOW_THRESHOLD - 1 },
    },
  ]);

  // Latched: the following polls stay quiet, even on a level wobbling around
  // the threshold.
  const latched = { ...low, batteryLowLatched: nextBatteryLowLatch(snapshot(), low) };
  assert.equal(latched.batteryLowLatched, true);
  const wobble = snapshot({ batteryLevel: BATTERY_LOW_THRESHOLD + 1 });
  const wobbleLatched = { ...wobble, batteryLowLatched: nextBatteryLowLatch(latched, wobble) };
  assert.equal(wobbleLatched.batteryLowLatched, true);
  const lowAgain = snapshot({ batteryLevel: BATTERY_LOW_THRESHOLD - 2 });
  assert.deepEqual(detectSceneEvents(wobbleLatched, lowAgain, DEVICE), []);
});

test('battery_low re-arms once the player is plugged in', () => {
  const latched = snapshot({ batteryLevel: 15, batteryLowLatched: true });
  const plugged = snapshot({ batteryLevel: 16, charging: true });
  assert.equal(nextBatteryLowLatch(latched, plugged), false);
});

test('a low battery on power is not low', () => {
  const plugged = snapshot({ batteryLevel: 5, charging: true });
  assert.deepEqual(detectSceneEvents(snapshot(), plugged, DEVICE), []);
});

test('an unknown battery level never fires', () => {
  assert.deepEqual(detectSceneEvents(snapshot(), snapshot({ batteryLevel: null }), DEVICE), []);
});

test('get_player_status outputs are flat scalars', () => {
  const outputs = playerStatusOutputs(snapshot({ ...PLAYING, deviceTemperature: null }));
  assert.deepEqual(outputs, {
    player_name: 'Chambre de Léa',
    online: true,
    battery: 80,
    charging: false,
    volume: 40,
    playing: true,
    card_title: 'Histoires du soir',
    temperature: null,
    wifi_signal: -58,
  });
  for (const value of Object.values(outputs)) {
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
  }
});

// --- Registry wiring ---------------------------------------------------------

const PLAYER = { deviceId: 'y2abc123', name: 'Chambre de Léa', online: true };
const CONFIG = normalizeConfig({ client_id: 'abc', request_status_push: false });

function yotoStatus(status) {
  return { y2abc123: { online: true, status, config: {} } };
}

test('the registry fires the events of a transition seen between two polls', async () => {
  const gladys = createFakeGladys();
  const statuses = yotoStatus({ batteryLevel: 80, powerSrc: 0, cardInserted: 0 });
  const api = createFakeYotoApi({
    devices: [PLAYER],
    statuses,
    cardTitles: { h2Fbz: 'Histoires du soir' },
  });
  const registry = new PlayerRegistry(api);
  await registry.refresh();

  await registry.pollOne(gladys, PLAYER, CONFIG);
  assert.deepEqual(gladys.sceneEvents, [], 'the first reading is the baseline');

  Object.assign(
    statuses,
    yotoStatus({ batteryLevel: 80, powerSrc: 0, cardInserted: 1, activeCard: 'h2Fbz' }),
  );
  await registry.pollOne(gladys, PLAYER, CONFIG);
  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGER.CARD_STARTED,
      data: {
        player: playerExternalIds(gladys, PLAYER.deviceId).device,
        player_name: 'Chambre de Léa',
        card_id: 'h2Fbz',
        card_title: 'Histoires du soir',
      },
    },
  ]);
  assert.ok(gladys.widgetRefreshes.includes('players'), 'the widgets are nudged');
  assert.ok(gladys.widgetRefreshes.includes('player'));
});

test('an unchanged poll neither fires an event nor nudges the widgets', async () => {
  const gladys = createFakeGladys();
  const api = createFakeYotoApi({
    devices: [PLAYER],
    statuses: yotoStatus({ batteryLevel: 80, powerSrc: 0, cardInserted: 0 }),
  });
  const registry = new PlayerRegistry(api);
  await registry.pollOne(gladys, PLAYER, CONFIG);
  gladys.widgetRefreshes.length = 0;
  await registry.pollOne(gladys, PLAYER, CONFIG);
  assert.deepEqual(gladys.sceneEvents, []);
  assert.deepEqual(gladys.widgetRefreshes, []);
});

test('a refused scene event never fails the poll', async () => {
  const gladys = createFakeGladys({ failSceneEvents: true });
  const statuses = yotoStatus({ batteryLevel: 80, powerSrc: 0 });
  const api = createFakeYotoApi({ devices: [PLAYER], statuses });
  const registry = new PlayerRegistry(api);
  await registry.pollOne(gladys, PLAYER, CONFIG);
  Object.assign(statuses, yotoStatus({ batteryLevel: 10, powerSrc: 0 }));
  const result = await registry.pollOne(gladys, PLAYER, CONFIG);
  assert.equal(result.batteryLevel, 10);
});

test('a reconnection does not replay the events', async () => {
  const gladys = createFakeGladys();
  const statuses = yotoStatus({ cardInserted: 1, activeCard: 'h2Fbz' });
  const api = createFakeYotoApi({ devices: [PLAYER], statuses });
  const registry = new PlayerRegistry(api);
  await registry.pollOne(gladys, PLAYER, CONFIG);
  registry.clearCache();
  await registry.pollOne(gladys, PLAYER, CONFIG);
  assert.deepEqual(gladys.sceneEvents, []);
});
