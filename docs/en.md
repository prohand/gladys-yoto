# Yoto integration

This integration brings the state of your **Yoto** players into Gladys:
battery, charging, volume, card being played, ambient light, device
temperature, Wi-Fi signal and online state.

## What you get

One Gladys device per Yoto player on the account, with nine read-only sensors.
The public Yoto API reports the player telemetry but not the playback commands
(play, pause, volume), so nothing is controllable from Gladys — the features are
declared read-only rather than showing a button that would do nothing.

## Requirements

A free app on the Yoto developer dashboard:

1. Open <https://dashboard.yoto.dev/> and create a **public client** app.
2. Enable the scopes `family:devices:view`, `family:devices:control`,
   `family:library:view` and `offline_access`.
3. Copy the **Client ID**.

Yoto deprecated the _device code_ flow: the integration uses the browser flow
Yoto now recommends (authorization code + PKCE), so the app also needs the
Gladys callback URL in its **Allowed callback URLs** — see below.

## Configuration

1. Open the **Configuration** tab of the integration.
2. Paste the **Yoto Client ID** and save.
3. Click **Connect** a first time, then open the integration logs: the line
   `Yoto sign-in started, callback URL to allow on the Yoto app: …` gives the
   exact URL to paste in the **Allowed callback URLs** of your Yoto app.
4. Click **Connect** again: sign in on the Yoto page, Yoto redirects back to
   Gladys and the connection badge turns green.
5. The players show up in the **Discovery** tab, ready to be added.

Settings:

- **Refresh interval** (`poll_frequency`) — 30 to 3600 seconds, 120 by default.
  This is how often each player is read. The Yoto API is a cloud API: stay
  above 60 seconds unless you really need more. Gladys schedules on fixed ticks
  (60 seconds at the slowest), so a value between 30 and 59 seconds is served by
  the 30-second tick, and anything above 60 seconds is honoured by the
  integration itself. A change applies immediately, without recreating any
  device.
- **Ask the player to refresh before reading** — sends a status request to the
  player before each poll, so the values read are fresh instead of the last ones
  it reported. Turn it off if your Yoto app lacks the `family:devices:control`
  scope.

The tokens are kept by Gladys internally (never shown in the UI): the link
survives a restart or an image update.

## Actions

- **Test the connection** — queries the Yoto account and shows how many players
  were found, with their names.
- **Refresh all players now** — polls every player immediately, without waiting
  for the next cycle.

## Troubleshooting

- **"No Yoto account linked yet: click Connect"** — the Client ID is set but the
  account was never linked, or the link expired.
- **"The Yoto link expired, please connect your account again"** — the token was
  revoked (password change, app deleted on the Yoto side). Click **Connect**
  again.
- **Yoto answers "Callback URL mismatch"** — the URL shown on that Yoto page is
  the Gladys callback: add it to the **Allowed callback URLs** of your Yoto app,
  then click **Connect** again.
- **"Could not start the Yoto sign-in: …"** — the reason is spelled out in the
  message and in the logs. `unauthorized_client` on the device code endpoint
  means the Yoto app has no device code grant: Yoto deprecated it, update
  Gladys so the browser flow is used.
- **"No Yoto sign-in is in progress"** — the integration restarted between the
  click on **Connect** and the return from Yoto; click **Connect** again.
- **Stale or missing values** — a player that is off or offline reports nothing:
  the integration keeps the last known state and the "Online" sensor drops to 0.
  Sensors a model does not have (temperature on a Yoto Mini, for instance) are
  simply not published.
- **401/403 errors in the logs** — the scopes of your Yoto app are incomplete.
  Check them on the developer dashboard, then link the account again.

The integration logs everything it does: read the logs from the Gladys UI (or
`docker logs` on the host) with `LOG_LEVEL=debug` for the full detail.
