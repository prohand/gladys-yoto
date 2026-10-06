# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.
- `CLAUDE.md`: guide for contributors and coding agents (commands, architecture, invariants).

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

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

[Unreleased]: https://github.com/prohand/gladys-yoto/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/prohand/gladys-yoto/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-yoto/compare/v1.1.1...v2.0.0
[1.1.1]: https://github.com/prohand/gladys-yoto/releases/tag/v1.1.1
