# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Fixed

- The connection badge turns green again at the next successful read after a transient error, instead of staying red until "Test the connection".
- A container started before the network was up never published the players to the Discovery tab: the Yoto account is now read again after 1, 5, then every 15 minutes until it succeeds.
- An access token Yoto refuses before its expiry (HTTP 401) is refreshed and the call replayed once; a new link is only asked for when Yoto refuses the refresh too.
- A refreshed token that could not be saved in Gladys is saved again on the next poll, and saving the Configuration screen no longer brings back an older token than the one in use (Yoto rotates the refresh token: the old one asked for a new link after a restart). A new Client ID still empties the tokens.
- A player removed from the Yoto account but still in Gladys no longer re-reads the whole account every minute (once per configured interval), and no Yoto call is attempted while no account is linked (it logged an error every minute per device).
- The status request sent to a player before a read now waits one second for its answer to reach the cloud; read at once, it was a wasted call.
- A card title Yoto failed to return is asked again after 10 minutes instead of showing the card id until the next restart.
- An unhandled promise rejection is logged instead of crashing the container.

### Changed

- Node.js 22 or later is required (`engines`); CI tests on Node 22 and 24 and builds the Docker image on pull requests.
- The Docker image fails its build when `npm ci` fails (no more `npm install` fallback) and drops the npm cache.
- Dependabot also proposes updates of the Docker base image.

## [2.2.0] - 2026-10-07

### Fixed

- A poll no longer fails when saving a refreshed Yoto token in Gladys fails: the new token is in memory and valid.

### Changed

- CI runs the store admission checks on pull requests; Dependabot proposes npm and GitHub Actions updates.
- Every release publishes a GitHub Release.

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- A player added in Gladys after a first read ("Refresh now", a widget, a scene) now gets all its values at once: it is read when Gladys creates it, with every value republished.
- Stable values (Online, volume…) are republished once an hour, so Gladys no longer shows them as "no recent value".
- A value whose publication failed is retried on the next poll instead of waiting for it to change.
- The Release workflow re-runs Prettier on the manifest after `jq`, so a release no longer leaves `main` with a failing CI format check.

## [2.0.1] - 2026-09-27

### Fixed

- Sortir "Charging" de la catégorie batterie

## [2.0.0] - 2026-09-23

### Added

- Widgets, déclencheurs et actions de scène de Gladys 5.1

## [1.1.1] - 2026-09-02

First public release.

### Added

- Intégration externe Yoto pour Gladys Assistant
- Nouvelle image de couverture de l'intégration

### Fixed

- Passer au flux navigateur PKCE, Yoto a abandonné le device code
- Publier une fréquence de polling acceptée par Gladys
- Utiliser des catégories de feature connues de Gladys
- Set min/max on the Card playing text feature
- Considérer le lecteur branché comme "en charge"

[Unreleased]: https://github.com/prohand/gladys-yoto/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-yoto/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/prohand/gladys-yoto/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/prohand/gladys-yoto/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-yoto/compare/v1.1.1...v2.0.0
[1.1.1]: https://github.com/prohand/gladys-yoto/releases/tag/v1.1.1
