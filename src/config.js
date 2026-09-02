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
