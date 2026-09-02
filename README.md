# Yoto integration for Gladys Assistant

External integration that brings your [Yoto](https://yotoplay.com) players into
[Gladys Assistant](https://gladysassistant.com): battery, charging, volume,
card being played, ambient light, device temperature, Wi-Fi signal and online
state — one Gladys device per player, refreshed by polling.

Built from the official
[integration-template-js](https://github.com/GladysAssistant/integration-template-js).

## What you get

For each player of your Yoto account, a Gladys device with nine read-only
features:

| Feature            | Category                    | Unit | Source (`device.status`)   |
| ------------------ | --------------------------- | ---- | -------------------------- |
| Battery            | `battery` / `integer`       | %    | `batteryLevel`             |
| Charging           | `battery` / `charging`      | –    | `charging`                 |
| Volume             | `music` / `volume`          | %    | `userVolume` (or `volume`) |
| Playing            | `sensor` / `binary`         | –    | `cardInserted` > 0         |
| Card playing       | `text` / `text`             | –    | `activeCard` (title)       |
| Ambient light      | `light-sensor` / `integer`  | lux  | `als`                      |
| Device temperature | `device-temperature-sensor` | °C   | `temp` (device side)       |
| Wi-Fi signal       | `signal` / `integer`        | dBm  | `wifiStrength`             |
| Online             | `sensor` / `binary`         | –    | `device.online`            |

Everything is **read-only**: the public Yoto REST API reports the player
telemetry but does not expose the playback commands (play, pause, volume set),
which travel over the family MQTT channel. Features are therefore declared
`read_only: true` so the Gladys UI never offers a control that would do
nothing.

## Configuration

1. Create a free app on the [Yoto developer dashboard](https://dashboard.yoto.dev/)
   (public client, device code flow) and enable the scopes
   `family:devices:view`, `family:devices:control`, `family:library:view` and
   `offline_access`.
2. In Gladys, open the integration **Configuration** tab, paste the **Client ID**
   and save.
3. Click **Connect**: Yoto opens a page with a code to approve. Once approved,
   the players appear in the **Discovery** tab, ready to be added.
4. Adjust the **refresh interval** (`poll_frequency`, 30–3600 s, default 120 s)
   and, if needed, turn off _Ask the player to refresh before reading_.

The tokens are stored as Gladys config keys outside the `config_schema` (never
rendered in the UI), so nothing is written to disk and the link survives a
restart or an image update.

## How the refresh works

`poll_frequency` is published **on each device**, so the Gladys scheduler calls
`onPoll` at that interval, per player. One poll does:

1. `POST /device-v2/{deviceId}/command/status` — ask the player to report its
   status now (optional, `request_status_push`);
2. `GET /device-v2/{deviceId}/config` — read the `device.status` shadow;
3. publish only the values that **changed** (the host API rate-limits states at
   300/minute).

Changing the interval in the Configuration screen re-publishes the devices, so
the new value applies without recreating anything.

## Yoto API used

| Call                                        | Why                                    |
| ------------------------------------------- | -------------------------------------- |
| `POST login.yotoplay.com/oauth/device/code` | Start the account link (RFC 8628)      |
| `POST login.yotoplay.com/oauth/token`       | Get and refresh the tokens             |
| `GET /device-v2/devices/mine`               | List the players of the account        |
| `GET /device-v2/{id}/config`                | Settings + last reported status        |
| `POST /device-v2/{id}/command/status`       | Ask the player to report now           |
| `GET /card/{id}`                            | Card title (falls back to the card id) |

`GET /device-v2/{id}/status` is deliberately not used: Yoto deprecated it and it
needs an extra scope, while `/config` carries the same firmware status block.

## Project layout

```
index.js               SDK wiring: handlers, account link, lifecycle
src/config.js          defaults + normalization of the user config
src/yoto/auth.js       device code flow, token refresh, token storage
src/yoto/api.js        Yoto REST client
src/yoto/status.js     raw firmware status -> Gladys values (pure functions)
src/devices/player.js  one Yoto player -> one Gladys device + polling
src/devices/index.js   player registry (discovery, dispatch, caches)
test/                  node:test suite, no framework to install
```

## Development

```bash
npm install
npm test           # node:test
npm run lint       # ESLint
npm run format     # Prettier
```

Validate the integration exactly like the store indexer does, before tagging:

```bash
npx github:GladysAssistant/integration-store .
```

## Publishing

Open **Actions → Release → Run workflow** and pick `patch`, `minor` or `major`:
the workflow bumps `package.json` and the manifest (`version` +
`docker_image`), pushes the `vX.Y.Z` tag and builds the multi-arch image
(`linux/amd64` + `linux/arm64`) to `ghcr.io`. The decentralized indexer then
offers the update in Gladys.

Remember to replace `cover.png` (800×534 px, ≤ 150 KB): the bundled one is the
template's placeholder gradient.

## Notes

- Requires **Node.js ≥ 20** (built-in `fetch`, no HTTP dependency).
- This project is not affiliated with Yoto Ltd.

## License

Apache-2.0
