import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { buildPlayerContent, buildPlayersContent, WIDGET_ACTION_REFRESH } from '../src/widgets.js';
import { FEATURE, playerExternalIds } from '../src/devices/player.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const PLAYER = { deviceId: 'y2abc123', name: 'Chambre de Léa' };

const SNAPSHOT = {
  deviceId: 'y2abc123',
  name: 'Chambre de Léa',
  online: true,
  batteryLevel: 15,
  charging: false,
  volume: 40,
  playing: true,
  cardId: 'h2Fbz',
  cardTitle: 'Histoires du soir, avec un titre bien plus long que ce que la carte peut afficher',
  ambientLight: 100,
  deviceTemperature: 29,
  wifiStrength: -58,
};

// validateWidgetContent is the SDK copy of the core checks: [] means the core
// renders the content exactly as sent, nothing truncated nor dropped.
function assertRenderedAsSent(content) {
  assert.deepEqual(validateWidgetContent(JSON.parse(JSON.stringify(content))), []);
}

test('players widget: one row per player, battery badge colored by urgency', () => {
  const content = buildPlayersContent([PLAYER], new Map([[PLAYER.deviceId, SNAPSHOT]]));
  assertRenderedAsSent(content);
  const list = content.components.find((component) => component.type === 'card-list');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].title, 'Chambre de Léa');
  assert.equal(list.items[0].badge.text, '15 %');
  assert.equal(list.items[0].badge.color, 'danger');
  assert.ok(list.items[0].subtitle.length <= 60, 'long card titles are cut, not dropped');
});

test('players widget: a player not read yet and an empty account still render', () => {
  assertRenderedAsSent(buildPlayersContent([PLAYER], new Map()));
  assertRenderedAsSent(buildPlayersContent([], new Map()));
});

test('players widget: never more rows than the list display holds', () => {
  const players = Array.from({ length: 12 }, (_, index) => ({
    deviceId: `p${index}`,
    name: `Lecteur ${index}`,
  }));
  const content = buildPlayersContent(players, new Map());
  assertRenderedAsSent(content);
  assert.equal(content.components[0].items.length, 8);
});

test('player widget: live tiles and chart bound to the device features', () => {
  const gladys = createFakeGladys();
  const content = buildPlayerContent(gladys, PLAYER, SNAPSHOT);
  assertRenderedAsSent(content);
  const ids = playerExternalIds(gladys, PLAYER.deviceId);
  const bound = content.components
    .filter((component) => component.type === 'value')
    .map((component) => component.device_feature);
  assert.deepEqual(bound, [
    ids.feature(FEATURE.BATTERY),
    ids.feature(FEATURE.VOLUME),
    ids.feature(FEATURE.TEMPERATURE),
  ]);
  const chart = content.components.find((component) => component.type === 'chart');
  assert.deepEqual(chart.device_features, [ids.feature(FEATURE.BATTERY)]);
  const button = content.components.find((component) => component.type === 'button');
  assert.equal(button.action.key, WIDGET_ACTION_REFRESH);
});

test('player widget: offline, not read yet and removed players still render', () => {
  const gladys = createFakeGladys();
  const offline = { ...SNAPSHOT, online: false, playing: null, charging: null, wifiStrength: null };
  assertRenderedAsSent(buildPlayerContent(gladys, PLAYER, offline));
  assertRenderedAsSent(buildPlayerContent(gladys, PLAYER, undefined));
  assertRenderedAsSent(buildPlayerContent(gladys, null, undefined));
});
