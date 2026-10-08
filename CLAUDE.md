# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) that brings [Yoto](https://yotoplay.com) players
into Gladys: one read-only device per player (battery, charging, volume, playing, card playing,
ambient light, device temperature, Wi-Fi signal, online). Gladys 5.1+ adds two widgets, three
scene triggers and two scene actions. It talks to the Yoto cloud with the user's own Yoto app
(Client ID from dashboard.yoto.dev) and OAuth tokens.

## Commands

```bash
npm install
npm test                                   # node --test (built-in runner)
node --test test/auth.test.js              # one file
node --test --test-name-pattern "PKCE"     # one test by name
npm run lint                               # eslint .
npm run format:check                       # prettier --check . (CI gate)
npm run format                             # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, tags, builds). The release rewrites the
manifest with `jq`: run `npm run format` afterwards or CI fails.

## Architecture

```
index.js               SDK wiring: OAuth flows, handlers, widgets, scene actions
src/config.js          defaults, poll interval clamp, Gladys tick choice (gladysPollFrequency)
src/yoto/auth.js       PKCE browser flow, deprecated device-code fallback, TokenStore
src/yoto/api.js        Yoto REST client (devices, device config, card titles, status push)
src/yoto/status.js     parse the raw device status into plain values
src/devices/index.js   PlayerRegistry: players, snapshots, poll schedule, scene triggers
src/devices/player.js  device payload, pollPlayer(), StateCache (skip unchanged values)
src/connectionStatus.js connection badge: remembers the last state, sends only changes
src/retry.js           start-up account read retried with backoff (1, 5, then 15 min)
src/scenes.js          scene trigger/action keys and outputs
src/widgets.js         widgets `players` and `player`
```

### Invariants worth knowing

- **Account linking is the browser PKCE flow** (`onOAuthAuthorizeUrl` → Yoto login →
  `onOAuthCallback`). The `state` must match the pending link; the callback URL must be allowed
  on the user's Yoto app (it is logged). The device-code flow is only a fallback for cores that
  give no redirect URI — Yoto deprecated it.
- **Tokens live in the Gladys config, outside `config_schema`** (`access_token`,
  `refresh_token`, `expires_at`), written with `gladys.setConfig()` and never shown in the UI.
  Nothing is written to disk. `TokenStore` shares one refresh promise between concurrent polls.
  A new Client ID clears the tokens.
- **Polling**: devices carry `should_poll: true` and the slowest Gladys tick not above the
  configured interval (`gladysPollFrequency`; Gladys only accepts 1 s to 60 s, any other value
  rejects the whole discovery). The registry skips polls inside the configured interval.
- **Unchanged values are not re-published** (`StateCache`) — except once an hour
  (`STATE_HEARTBEAT_MS`), so Gladys never shows a stable value as stale. A value is recorded only
  after Gladys accepted it. The cache is cleared on every `connected`, and per device on
  `onDeviceCreated` / `onDeviceUpdated` (states sent before the device existed were dropped).
- **Widgets read the snapshots of the last polls**: opening a dashboard costs no Yoto call. Scene
  action `get_player_status` always reads fresh.
- **Scene triggers fire on transitions** seen by a poll (card started/stopped, battery low once
  until charged), never on the first read. Keys are stored by users: never rename them.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys). Charging is `input/binary`, not a
  battery category (a battery category fired false low-battery alerts).
- User-facing messages are bilingual `{ en, fr }`; errors also go to the connection badge
  (`handleYotoError`), the only place the Configuration screen shows a message.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` in sync with `DEFAULT_CONFIG`,
the bounds, the action handlers and the widget/scene keys (`gladys_version >=5.1.0`).

## Testing

No network: the Yoto API and auth endpoints are stubbed (`globalThis.fetch`);
`test/helpers/fakeGladys.js` stands in for the SDK.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why**. User docs in `docs/en.md`
and `docs/fr.md`, kept in sync. The container rootfs is read-only: write nothing.
