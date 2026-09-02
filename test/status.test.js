import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, isPlaying, parseTemperaturePair } from '../src/yoto/status.js';

// A realistic `device.status` block, as the firmware reports it.
const RAW_STATUS = {
  batteryLevel: 87,
  charging: 1,
  volume: 8,
  userVolume: 42,
  cardInserted: 1,
  activeCard: 'h2Fbz',
  als: 120,
  temp: '31:29',
  wifiStrength: -58,
  nightlightMode: 'off',
  updatedAt: '2026-09-02T10:00:00.000Z',
};

test('parseStatus maps the raw firmware keys', () => {
  const status = parseStatus(RAW_STATUS);
  assert.equal(status.batteryLevel, 87);
  assert.equal(status.isCharging, true);
  assert.equal(status.cardInserted, 1);
  assert.equal(status.activeCard, 'h2Fbz');
  assert.equal(status.ambientLight, 120);
  assert.equal(status.deviceTemperature, 29);
  assert.equal(status.wifiStrength, -58);
});

test('parseStatus prefers the volume set by the user over the system one', () => {
  assert.equal(parseStatus(RAW_STATUS).volume, 42);
  assert.equal(parseStatus({ volume: 8 }).volume, 8);
});

test('parseStatus returns null for values the player did not report', () => {
  const status = parseStatus({});
  assert.equal(status.batteryLevel, null);
  assert.equal(status.isCharging, null);
  assert.equal(status.volume, null);
  assert.equal(status.deviceTemperature, null);
  assert.equal(status.activeCard, null);
});

test('parseStatus treats "none" as no card playing', () => {
  assert.equal(parseStatus({ activeCard: 'none' }).activeCard, null);
  assert.equal(parseStatus({ activeCard: '' }).activeCard, null);
});

test('isPlaying covers physical, remote and streaming cards', () => {
  assert.equal(isPlaying(parseStatus({ cardInserted: 0 })), false);
  assert.equal(isPlaying(parseStatus({ cardInserted: 1 })), true);
  assert.equal(isPlaying(parseStatus({ cardInserted: 2 })), true);
  assert.equal(isPlaying(parseStatus({ cardInserted: 3 })), true);
  assert.equal(isPlaying(parseStatus({})), null);
});

test('parseTemperaturePair handles the "battery:device" string and its quirks', () => {
  assert.deepEqual(parseTemperaturePair('31:29'), {
    batteryTemperature: 31,
    deviceTemperature: 29,
  });
  // "0" and "notSupported" mean "unknown", never a real 0 °C reading.
  assert.deepEqual(parseTemperaturePair('0:notSupported'), {
    batteryTemperature: null,
    deviceTemperature: null,
  });
  assert.deepEqual(parseTemperaturePair(undefined), {
    batteryTemperature: null,
    deviceTemperature: null,
  });
});
