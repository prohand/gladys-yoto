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
import { ConnectionStatus } from './src/connectionStatus.js';
import { createRetry } from './src/retry.js';
import { SCENE_ACTION, playerStatusOutputs } from './src/scenes.js';
import {
  WIDGET,
  WIDGET_ACTION_REFRESH,
  buildPlayerContent,
  buildPlayersContent,
} from './src/widgets.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Tokens live in the Gladys config (keys outside the config_schema: never
// rendered in the UI), so nothing has to be written to disk. A failed write
// does not fail the call that refreshed the token (the new one is in memory
// and works): the TokenStore logs it and retries it on the next poll.
const tokenStore = new TokenStore({
  onTokensChanged: (tokens) => gladys.setConfig(tokens),
});

const api = new YotoApi(tokenStore, () => config.client_id);
const registry = new PlayerRegistry(api, { isLinked: () => tokenStore.linked });
const connectionStatus = new ConnectionStatus(gladys);

// The start-up read of the account, retried after 1, 5 then every 15 minutes
// while it fails (container started before the network): it is what fills
// the Discovery tab.
const accountInitialization = createRetry(initializeAccount, {
  onError: (err) => logger.error(`Yoto account initialization failed: ${err.message}`),
});

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
    await accountInitialization.run();
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
  await accountInitialization.run();
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the players of the Yoto account');
  await registry.refresh();
  await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(gladys, config));
  await connectionStatus.connected();
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  try {
    // A token write that failed earlier is retried here, even while no
    // account is linked (a cleared link must reach Gladys too).
    await tokenStore.persistIfPending();
    const snapshot = await registry.poll(gladys, device, config);
    if (snapshot) {
      // Yoto answered: a badge left red by an earlier failure turns green.
      await connectionStatus.connected();
    }
  } catch (err) {
    await handleYotoError(err, `Polling ${device.external_id} failed`);
    throw err; // the SDK acks the poll as failed, the error shows in Gladys
  }
});

// --- The user added (or updated) a player in Gladys --------------------------
// States sent before the device existed were dropped by the core: read the
// player now, with every value republished.
async function readNewDevice(device) {
  registry.forgetDevice(device.external_id);
  if (!tokenStore.linked) {
    return;
  }
  try {
    if (await registry.poll(gladys, device, config)) {
      await connectionStatus.connected();
    }
  } catch (err) {
    logger.warn(`First read of ${device.external_id} failed: ${err.message}`);
  }
}
gladys.onDeviceCreated(readNewDevice);
gladys.onDeviceUpdated(readNewDevice);

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  const players = await registry.refresh();
  await connectionStatus.connected();
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
  const count = await refreshAllPlayers();
  return {
    en: `${count} player(s) refreshed.`,
    fr: `${count} lecteur(s) rafraîchi(s).`,
  };
});

/** Read every player now, interval or not; returns how many were read. */
async function refreshAllPlayers() {
  if (registry.players.size === 0) {
    await registry.refresh();
  }
  return registry.pollAll(gladys, config);
}

// --- Dashboard widgets (Gladys >= 5.1) ---------------------------------------
// The content is drawn from the snapshots of the last polls: opening a
// dashboard costs no Yoto call. The registry nudges both widgets when a poll
// changes what they show.
gladys.onWidgetGet(WIDGET.PLAYERS, async () => {
  if (registry.players.size === 0 && tokenStore.linked) {
    await registry.refresh();
  }
  return buildPlayersContent([...registry.players.values()], registry.snapshots);
});

gladys.onWidgetGet(WIDGET.PLAYER, async ({ settings }) => {
  const player = await registry.resolvePlayer(gladys, settings.player);
  return buildPlayerContent(gladys, player, player && registry.snapshots.get(player.deviceId));
});

gladys.onWidgetAction(WIDGET.PLAYERS, async (actionKey) => {
  assertWidgetAction(actionKey);
  const count = await readYoto(refreshAllPlayers(), 'Widget refresh failed');
  return {
    en: `${count} player(s) refreshed.`,
    fr: `${count} lecteur(s) rafraîchi(s).`,
  };
});

gladys.onWidgetAction(WIDGET.PLAYER, async (actionKey, params, { settings }) => {
  assertWidgetAction(actionKey);
  const player = await findPlayerOrThrow(settings.player);
  await readYoto(registry.pollOne(gladys, player, config), 'Widget refresh failed');
  return { en: `${player.name} refreshed.`, fr: `${player.name} rafraîchi.` };
});

function assertWidgetAction(actionKey) {
  if (actionKey !== WIDGET_ACTION_REFRESH) {
    throw new Error(`Unknown widget action "${actionKey}"`);
  }
}

// --- Scene actions (Gladys >= 5.1) -------------------------------------------
// The scene triggers are fired by the registry itself, on the poll that sees
// the transition (card started/stopped, battery low).
gladys.onSceneAction(SCENE_ACTION.GET_PLAYER_STATUS, async (fields) => {
  const player = await findPlayerOrThrow(fields.player);
  // Always a fresh reading: a scene asking "is it charging?" must not get the
  // answer of the last poll, up to an hour old.
  const snapshot = await readYoto(
    registry.pollOne(gladys, player, config),
    'Scene action get_player_status failed',
  );
  return playerStatusOutputs(snapshot);
});

gladys.onSceneAction(SCENE_ACTION.REFRESH_PLAYERS, async () => {
  const count = await readYoto(refreshAllPlayers(), 'Scene action refresh_players failed');
  return { count };
});

/** The player chosen in a `source: "devices"` select, or a readable error. */
async function findPlayerOrThrow(externalId) {
  const player = await withYotoErrors(
    registry.resolvePlayer(gladys, externalId),
    'Could not read the Yoto account',
  );
  if (!player) {
    throw new Error('This Yoto player is no longer on the account.');
  }
  return player;
}

/** Report a Yoto failure in the connection badge, then let it fail the caller. */
async function withYotoErrors(promise, context) {
  try {
    return await promise;
  } catch (err) {
    await handleYotoError(err, context);
    throw err;
  }
}

/**
 * Same, for a call that really READ the Yoto cloud: its success turns the badge
 * green again. (Resolving a player can be answered from memory, which proves
 * nothing about Yoto: it goes through withYotoErrors only.)
 */
async function readYoto(promise, context) {
  const result = await withYotoErrors(promise, context);
  await connectionStatus.connected();
  return result;
}

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
    accountInitialization.cancel();
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
  // A new connection: the badge Gladys shows may no longer be the last one we sent.
  connectionStatus.reset();
  try {
    const raw = await gladys.getConfig();
    config = normalizeConfig(raw);
    tokenStore.restore(raw);
    await tokenStore.persistIfPending();
    // Gladys may have missed states published while we were disconnected:
    // start from a clean cache so the next poll republishes everything.
    registry.clearCache();
    await accountInitialization.run();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await handleYotoError(err, 'Initialization failed');
  }
});

gladys.on('disconnected', () => {
  logger.warn('Disconnected from Gladys, polling is suspended until reconnection');
  // Nothing could be published meanwhile; the reconnection starts a new read.
  accountInitialization.cancel();
});

/**
 * Read the Yoto account and publish its players. Called (through
 * accountInitialization, which retries it) after a connection to Gladys and
 * right after a successful pairing.
 * @returns {Promise<boolean>} false when it failed and is worth retrying
 */
async function initializeAccount() {
  if (!config.client_id) {
    await reportDisconnected({
      en: 'Fill in your Yoto Client ID, then connect your account.',
      fr: 'Renseignez votre Client ID Yoto, puis connectez votre compte.',
    });
    return true;
  }
  if (!tokenStore.linked) {
    await reportDisconnected({
      en: 'No Yoto account linked yet: click Connect.',
      fr: 'Aucun compte Yoto lié : cliquez sur Connecter.',
    });
    return true;
  }

  try {
    await registry.refresh();
    await gladys.publishDiscoveredDevices(registry.buildDiscoveredDevices(gladys, config));
    // Application-level status, shown in the Configuration screen: an
    // integration can be RUNNING and still disconnected from its cloud.
    await connectionStatus.connected();
    return true;
  } catch (err) {
    await handleYotoError(err, 'Could not read the Yoto account');
    // A dead link needs the user, not another try; anything else (network
    // not up yet, Yoto down) is retried with a backoff.
    const retry = !(err instanceof YotoAuthError && err.needsRelink);
    if (retry) {
      logger.info('The Yoto account will be read again later');
    }
    return !retry;
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
  return connectionStatus.disconnected(message);
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  pendingLink?.cancel();
  accountInitialization.cancel();
});

// A promise rejected with no handler (a fire-and-forget nudge, a callback of
// the SDK) would otherwise crash the whole container on Node's default
// policy, taking every player down for one failed call. Log it and carry on;
// errors that leave the process in an unknown state (uncaughtException) still
// crash it, which is what the supervisor's restart is for.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Yoto integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
