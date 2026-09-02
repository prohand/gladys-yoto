// -----------------------------------------------------------------------------
// Entry point of the Yoto external integration for Gladys Assistant.
//
// It wires the SDK to the Yoto cloud:
//   1. instantiate the SDK (connection, auth, reconnection: handled for you);
//   2. register the handlers BEFORE connect();
//   3. connect, link the Yoto account, publish the discovered players.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import {
  TokenStore,
  YotoAuthError,
  exchangeAuthorizationCode,
  pollDeviceToken,
  requestDeviceCode,
  startBrowserAuthorization,
} from './src/yoto/auth.js';
import { YotoApi } from './src/yoto/api.js';
import { PlayerRegistry } from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Tokens live in the Gladys config (keys outside the config_schema: never
// rendered in the UI), so nothing has to be written to disk.
const tokenStore = new TokenStore({
  onTokensChanged: (tokens) => gladys.setConfig(tokens),
});

const api = new YotoApi(tokenStore, () => config.client_id);
const registry = new PlayerRegistry(api);

// Guard for the linking flow: one pending link at a time, and it must stop
// when the user reconnects or the container shuts down.
let pendingLink = null;

// --- Account linking: the "Connect" button of the `oauth2` field ------------
// Yoto deprecated the device code grant, so the flow is the browser one it now
// recommends: Gladys opens login.yotoplay.com, the user signs in, Yoto redirects
// back to the Gladys callback, and onOAuthCallback below trades the code (with
// the PKCE verifier) for the tokens. A core that gives us no redirect URI falls
// back to the device code flow.
gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
  try {
    if (!config.client_id) {
      throw new YotoAuthError('Fill in your Yoto Client ID and save the configuration first.');
    }
    return redirectUri ? startBrowserLink(redirectUri) : await startDeviceLink();
  } catch (err) {
    // Gladys only shows a generic "could not start the connection" to the user:
    // spell out the real reason in the logs AND in the connection badge, which
    // is the one place of the Configuration screen that can carry a message.
    logger.error(`Could not start the Yoto sign-in: ${err.message}`);
    await reportDisconnected({
      en: `Could not start the Yoto sign-in: ${err.message}`,
      fr: `Impossible de lancer la connexion Yoto : ${err.message}`,
    });
    throw err;
  }
});

/** Browser flow (recommended by Yoto): return the sign-in URL, wait for the callback. */
function startBrowserLink(redirectUri) {
  const flow = startBrowserAuthorization(config.client_id, redirectUri);
  pendingLink?.cancel();
  pendingLink = { mode: 'browser', ...flow, cancel: () => {} };
  // The callback URL must be declared on the Yoto app: show it, otherwise the
  // user only gets Yoto's "Callback URL mismatch" page with no way back.
  logger.info(`Yoto sign-in started, callback URL to allow on the Yoto app: ${redirectUri}`);
  return flow.url;
}

/** Device code flow, kept for cores without a redirect URI (and older Yoto apps). */
async function startDeviceLink() {
  logger.warn('No redirect URL from Gladys: falling back to the deprecated device code flow');
  const flow = await requestDeviceCode(config.client_id);
  logger.info(`Yoto pairing started, code ${flow.user_code} (valid ${flow.expires_in}s)`);

  const link = { mode: 'device', cancelled: false };
  pendingLink?.cancel();
  link.cancel = () => (link.cancelled = true);
  pendingLink = link;

  // Do NOT await: the handler must resolve with the URL right away, the user
  // approves it in the browser meanwhile.
  waitForApproval(flow, link).catch((err) => {
    logger.error('Yoto pairing failed', err);
    reportDisconnected(
      err instanceof YotoAuthError
        ? { en: `Yoto pairing failed: ${err.message}`, fr: `Liaison Yoto échouée : ${err.message}` }
        : {
            en: 'Yoto pairing failed, check the integration logs.',
            fr: 'Liaison Yoto échouée, consultez les logs.',
          },
    );
  });

  return flow.verification_uri_complete;
}

// --- Account linking: Yoto redirected back to Gladys -------------------------
gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
  const link = pendingLink;
  if (!link || link.mode !== 'browser') {
    throw new Error('No Yoto sign-in is in progress, click Connect again.');
  }
  // The `state` we generated came back untouched: the code answers OUR request.
  if (state !== link.state) {
    throw new Error('Unexpected state in the Yoto callback, click Connect again.');
  }
  pendingLink = null;
  try {
    const tokens = await exchangeAuthorizationCode({
      clientId: config.client_id,
      code,
      verifier: link.verifier,
      redirectUri: redirectUri ?? link.redirectUri,
    });
    await tokenStore.update(tokens);
    logger.info('Yoto account linked');
    await initializeAccount();
  } catch (err) {
    logger.error(`Yoto token exchange failed: ${err.message}`);
    await reportDisconnected({
      en: `Yoto sign-in failed: ${err.message}`,
      fr: `Connexion Yoto échouée : ${err.message}`,
    });
    throw err;
  }
});

async function waitForApproval(flow, link) {
  const tokens = await pollDeviceToken(config.client_id, flow.device_code, {
    interval: flow.interval,
    expiresIn: flow.expires_in,
    shouldStop: () => link.cancelled,
  });
  if (!tokens) {
    logger.info('Yoto pairing cancelled');
    return;
  }
  await tokenStore.update(tokens);
  logger.info('Yoto account linked');
  await initializeAccount();
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the players of the Yoto account');
  await registry.refresh();
  await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(gladys, config));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  try {
    await registry.poll(gladys, device, config);
  } catch (err) {
    await handleYotoError(err, `Polling ${device.external_id} failed`);
    throw err; // the SDK acks the poll as failed, the error shows in Gladys
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  const players = await registry.refresh();
  await gladys.setConnectionStatus(true);
  if (players.length === 0) {
    return {
      en: 'Connected to Yoto, but this account has no player.',
      fr: 'Connexion à Yoto réussie, mais aucun lecteur sur ce compte.',
    };
  }
  const names = players.map((player) => player.name).join(', ');
  return {
    en: `Connected to Yoto: ${players.length} player(s) — ${names}.`,
    fr: `Connexion à Yoto réussie : ${players.length} lecteur(s) — ${names}.`,
  };
});

gladys.onAction('refresh_now', async () => {
  if (registry.players.size === 0) {
    await registry.refresh();
  }
  const count = await registry.pollAll(gladys, config);
  return {
    en: `${count} player(s) refreshed.`,
    fr: `${count} lecteur(s) rafraîchi(s).`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previous = config;
  config = normalizeConfig(newConfig);
  // The tokens travel in the same config object (they are stored there).
  tokenStore.restore(newConfig);

  // A new Client ID invalidates the tokens issued for the previous app.
  if (previous.client_id && previous.client_id !== config.client_id) {
    logger.info('Client ID changed -> the Yoto account must be linked again');
    pendingLink?.cancel();
    await tokenStore.clear();
    await reportDisconnected({
      en: 'Client ID changed, please connect your Yoto account again.',
      fr: 'Client ID modifié, reconnectez votre compte Yoto.',
    });
    return;
  }

  if (tokenStore.linked) {
    // poll_frequency is carried by the devices themselves: re-publish them so
    // the scheduler picks up the new interval. publishDiscoveredDevices is
    // idempotent (upsert by external_id).
    await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(gladys, config));
  }
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under `gladys-sdk`): these
// handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    const raw = await gladys.getConfig();
    config = normalizeConfig(raw);
    tokenStore.restore(raw);
    // Gladys may have missed states published while we were disconnected:
    // start from a clean cache so the next poll republishes everything.
    registry.clearCache();
    await initializeAccount();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await handleYotoError(err, 'Initialization failed');
  }
});

gladys.on('disconnected', () => {
  logger.warn('Disconnected from Gladys, polling is suspended until reconnection');
});

/**
 * Read the Yoto account and publish its players. Called after a connection to
 * Gladys and right after a successful pairing.
 */
async function initializeAccount() {
  if (!config.client_id) {
    await reportDisconnected({
      en: 'Fill in your Yoto Client ID, then connect your account.',
      fr: 'Renseignez votre Client ID Yoto, puis connectez votre compte.',
    });
    return;
  }
  if (!tokenStore.linked) {
    await reportDisconnected({
      en: 'No Yoto account linked yet: click Connect.',
      fr: 'Aucun compte Yoto lié : cliquez sur Connecter.',
    });
    return;
  }

  try {
    await registry.refresh();
    await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(gladys, config));
    // Application-level status, shown in the Configuration screen: an
    // integration can be RUNNING and still disconnected from its cloud.
    await gladys.setConnectionStatus(true);
  } catch (err) {
    logger.error('Could not read the Yoto account', err);
    await handleYotoError(err, 'Could not read the Yoto account');
  }
}

/**
 * Turn any failure into something the user can act on: an expired link asks
 * for a new pairing, anything else reports the service as unreachable.
 */
async function handleYotoError(err, context) {
  logger.error(`${context}: ${err.message}`);
  if (err instanceof YotoAuthError && err.needsRelink) {
    await reportDisconnected({
      en: 'The Yoto link expired, please connect your account again.',
      fr: 'La liaison Yoto a expiré, reconnectez votre compte.',
    });
    return;
  }
  await reportDisconnected({
    en: 'Cannot reach the Yoto service, check the integration logs.',
    fr: 'Service Yoto injoignable, consultez les logs de l’intégration.',
  });
}

function reportDisconnected(message) {
  return gladys.setConnectionStatus(false, message).catch(() => {});
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  pendingLink?.cancel();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Yoto integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
