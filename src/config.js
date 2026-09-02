// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills it in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// Two keys are NOT in the config_schema and never shown in the UI: the tokens
// obtained through the Yoto device code flow. They are written back with
// `gladys.setConfig()` — free internal storage, so nothing has to be persisted
// on disk.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  client_id: '', // Yoto app Client ID (dashboard.yoto.dev)
  poll_frequency: 120, // seconds, how often each player is polled
  request_status_push: true, // ask the player to push a fresh status before reading
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    client_id: String(raw.client_id ?? DEFAULT_CONFIG.client_id).trim(),
    // Config may arrive as strings from the form: force the types.
    poll_frequency: clampPollFrequency(raw.poll_frequency),
    // Anything but an explicit false (or 'false') means true.
    request_status_push: raw.request_status_push !== false && raw.request_status_push !== 'false',
  };
}

/**
 * Keep the poll frequency inside the bounds declared in the manifest: a value
 * typed before the manifest limits were tightened — or a corrupted one — must
 * never turn into a hammering loop on the Yoto cloud.
 */
function clampPollFrequency(value) {
  const seconds = Number(value ?? DEFAULT_CONFIG.poll_frequency);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CONFIG.poll_frequency;
  }
  return Math.min(3600, Math.max(30, Math.round(seconds)));
}

// Gladys does NOT schedule an arbitrary interval: a device is attached to one
// of these fixed ticks (milliseconds), and the core rejects the publication of
// any other value ("invalid poll frequency"). The slowest tick is one minute.
export const GLADYS_POLL_FREQUENCIES_MS = [1000, 2000, 10000, 15000, 30000, 60000];

/**
 * The Gladys tick a player is registered on: the slowest one that is not
 * slower than the interval the user asked for. Anything above 60 s lands on
 * the 60 s tick, and the registry then skips the ticks in between — that is
 * how a 5-minute interval stays a 5-minute interval on the Yoto cloud.
 * @param {number} seconds interval asked by the user (already clamped)
 * @returns {number} one of GLADYS_POLL_FREQUENCIES_MS
 */
export function gladysPollFrequency(seconds) {
  const wanted = Number(seconds) * 1000;
  if (!Number.isFinite(wanted)) {
    return gladysPollFrequency(DEFAULT_CONFIG.poll_frequency);
  }
  const allowed = [...GLADYS_POLL_FREQUENCIES_MS].sort((a, b) => a - b);
  return allowed.filter((tick) => tick <= wanted).pop() ?? allowed[0];
}
