// -----------------------------------------------------------------------------
// Translate the RAW `device.status` block of the Yoto API into the values
// Gladys publishes.
//
// The firmware sends short keys, integers instead of booleans, KiB instead of
// bytes, and a `temp` field packing two readings in one string. Everything
// that has to know about those quirks lives here — pure functions, no I/O, so
// the device layer stays readable and the parsing is unit-tested.
//
// Every getter returns `null` when the player did not report the value: a
// missing value must NOT be published as 0 (a Yoto Mini has no battery
// temperature sensor, and 0 °C would look like a real reading).
// -----------------------------------------------------------------------------

/**
 * @param {object} raw the `device.status` block returned by /device-v2/{id}/config
 */
export function parseStatus(raw = {}) {
  const { deviceTemperature } = parseTemperaturePair(raw.temp);
  return {
    batteryLevel: asInteger(raw.batteryLevel),
    // `charging` is 1 only while the battery is actually being filled: the
    // firmware drops it back to 0 as soon as the battery is full, even with
    // the player still on its dock / USB cable.
    isCharging: asBoolean(raw.charging),
    // 0 = battery, 1 = v2 dock, 2 = USB-C, 3 = Qi dock. Anything but 0 means
    // the player is plugged in, which is what the Yoto app shows.
    powerSource: asInteger(raw.powerSrc),
    // `userVolume` is the level the user set; `volume` is the system one,
    // which the firmware also lowers on its own (night mode, volume limit).
    volume: asInteger(raw.userVolume ?? raw.volume),
    // 0 = nothing, 1 = physical card, 2 = card started remotely, 3 = streaming
    // (Yoto Radio…). Anything but 0 means the player has content loaded.
    cardInserted: asInteger(raw.cardInserted),
    activeCard: normalizeCardId(raw.activeCard),
    ambientLight: asInteger(raw.als),
    deviceTemperature,
    wifiStrength: asInteger(raw.wifiStrength),
    nightlightMode: raw.nightlightMode ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/**
 * True when the player is on external power — what a user calls "en charge".
 *
 * Taking `charging` alone makes Gladys say "not charging" on a player sitting
 * plugged on its dock with a full battery (the app says "Charged" there), so
 * the power source wins whenever the firmware reports it: `charging` only
 * distinguishes "filling up" from "full", both of which are plugged in.
 */
export function isCharging(status) {
  if (status.powerSource !== null && status.powerSource !== undefined) {
    return status.powerSource > 0 || status.isCharging === true;
  }
  return status.isCharging ?? null;
}

/** True when the player currently has a card (or a stream) loaded. */
export function isPlaying(status) {
  return status.cardInserted === null ? null : status.cardInserted > 0;
}

/**
 * `temp` is the string "{battery}:{device}", each side being an integer, "0"
 * when unknown, or "notSupported" on players without the sensor.
 */
export function parseTemperaturePair(value) {
  if (typeof value !== 'string' || !value.includes(':')) {
    return { batteryTemperature: null, deviceTemperature: null };
  }
  const [battery, device] = value.split(':');
  return {
    batteryTemperature: asTemperature(battery),
    deviceTemperature: asTemperature(device),
  };
}

function asTemperature(part) {
  const trimmed = String(part).trim();
  // "0" is the firmware's "I don't know", not a real 0 °C reading.
  if (trimmed === 'notSupported' || trimmed === '0' || trimmed === '') {
    return null;
  }
  return asInteger(trimmed);
}

/** The firmware sends "none" (or nothing) when no card is loaded. */
function normalizeCardId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'none' ? null : trimmed;
}

function asInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

/** The firmware uses 0/1 integers where JSON would use booleans. */
function asBoolean(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number !== 0 : null;
}
