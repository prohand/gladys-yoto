// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// what the code actually does — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTION, SCENE_TRIGGER, playerStatusOutputs } from '../src/scenes.js';
import { WIDGET } from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

/** The minimum of the `gladys_version` range, as [major, minor, patch] numbers. */
function minimumGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

/** True when the manifest floor is at least `major.minor.patch` (compared as numbers). */
function floorAtLeast(major, minor, patch = 0) {
  const floor = minimumGladysVersion();
  const wanted = [major, minor, patch];
  for (let index = 0; index < 3; index += 1) {
    if (floor[index] !== wanted[index]) {
      return floor[index] > wanted[index];
    }
  }
  return true;
}

// The store vocabulary: unknown keys are silently DROPPED by the indexer, so a
// typo would cost the shelf without any error.
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

test('every manifest action has a handler registered in index.js', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      indexSource.includes(`gladys.onAction('${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the poll frequency is declared and bounded', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'poll_frequency');
  assert.ok(field, 'poll_frequency must be configurable: it drives the whole refresh loop');
  assert.equal(field.type, 'number');
  assert.equal(field.min, 30);
  assert.equal(field.max, 3600);
  // src/config.js clamps to the very same bounds.
  assert.ok(field.default >= field.min && field.default <= field.max);
});

test('the account is linked through the browser OAuth2 flow', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'account');
  assert.ok(field, 'the Yoto account must be linkable from the Configuration screen');
  // Yoto deprecated the device code grant: the flow is the browser one, so
  // Gladys hands us a redirect URI and relays the callback back to us.
  assert.equal(field.type, 'oauth2');
  assert.ok(indexSource.includes('gladys.onOAuthAuthorizeUrl('));
  assert.ok(indexSource.includes('gladys.onOAuthCallback('), 'the callback must be handled');
});

test('the Client ID is required: nothing works without a Yoto app', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'client_id');
  assert.ok(field?.required, 'client_id must be required');
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.equal(new Set(manifest.categories).size, manifest.categories.length);
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category "${category}"`);
  }
  assert.ok(
    floorAtLeast(4, 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the search keywords follow the store rules', () => {
  // 1-10 unique terms of 2-30 characters, compared trimmed and lowercased.
  const { keywords } = manifest;
  assert.ok(Array.isArray(keywords) && keywords.length >= 1 && keywords.length <= 10);
  const normalized = keywords.map((keyword) => keyword.trim().toLowerCase());
  assert.equal(new Set(normalized).size, keywords.length, 'keywords must be unique');
  for (const keyword of normalized) {
    assert.ok(keyword.length >= 2 && keyword.length <= 30, `"${keyword}": 2 to 30 characters`);
  }
});

test('the integration is worldwide: no countries declared', () => {
  // Yoto players are sold in many countries and the Yoto cloud serves them
  // all: a `countries` list would hide the integration from the others.
  assert.equal(manifest.countries, undefined);
});

test('keywords, countries and music require Gladys >= 5.3.0', () => {
  if (['keywords', 'countries', 'music'].some((field) => manifest[field] !== undefined)) {
    assert.ok(floorAtLeast(5, 3), `got "${manifest.gladys_version}", the fields need 5.3.0`);
  }
});

test('the players are declared as music players, with no catalog operation', () => {
  // A Yoto player plays cards: its now playing (the card, its cover) is
  // published, but the REST API can neither browse, search nor queue — and
  // declaring an operation would show a panel that does nothing.
  assert.equal(manifest.type, 'device', 'music is accepted on device integrations only');
  assert.deepEqual(manifest.music, {});
  assert.ok(!/onMusic(Browse|Search|Play|QueueGet|QueuePlay)\(/.test(indexSource));
});

test('the integration declares itself as a cloud one', () => {
  // The Yoto API is a cloud API: there is no LAN protocol to prefer, so no
  // "Prefer the local connection" toggle and no transport badge to publish.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the manifest version matches the docker image tag', () => {
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the indexer and the published image must stay in lockstep',
  );
});

test('widgets, scene triggers and scene actions require Gladys >= 5.1.0', () => {
  assert.ok(floorAtLeast(5, 1), `got "${manifest.gladys_version}", the capabilities need 5.1.0`);
});

test('every manifest widget is served in index.js, and only those', () => {
  const keys = manifest.widgets.map((widget) => widget.key);
  assert.deepEqual(keys.sort(), Object.values(WIDGET).sort());
  for (const key of keys) {
    const constant = Object.keys(WIDGET).find((name) => WIDGET[name] === key);
    assert.ok(indexSource.includes(`gladys.onWidgetGet(WIDGET.${constant},`), `${key}: no content`);
    assert.ok(
      indexSource.includes(`gladys.onWidgetAction(WIDGET.${constant},`),
      `${key}: no action`,
    );
  }
});

test('every manifest scene action has a handler, and only those', () => {
  const keys = manifest.scene_actions.map((action) => action.key);
  assert.deepEqual(keys.sort(), Object.values(SCENE_ACTION).sort());
  for (const name of Object.keys(SCENE_ACTION)) {
    assert.ok(
      indexSource.includes(`gladys.onSceneAction(SCENE_ACTION.${name},`),
      `${SCENE_ACTION[name]}: no handler`,
    );
  }
});

test('the scene triggers declared are the ones the registry fires', () => {
  const keys = manifest.scene_triggers.map((trigger) => trigger.key);
  assert.deepEqual(keys.sort(), Object.values(SCENE_TRIGGER).sort());
  for (const trigger of manifest.scene_triggers) {
    // The `player` filter compares against the device external_id the
    // registry puts in every event.
    assert.ok(trigger.fields.some((field) => field.key === 'player' && field.source === 'devices'));
    assert.ok(trigger.variables.some((variable) => variable.key === 'player_name'));
  }
});

test('get_player_status declares exactly the outputs the handler returns', () => {
  const action = manifest.scene_actions.find(
    (entry) => entry.key === SCENE_ACTION.GET_PLAYER_STATUS,
  );
  const returned = Object.keys(playerStatusOutputs({ name: 'x' }));
  assert.deepEqual(action.outputs.map((output) => output.key).sort(), returned.sort());
});

// Gladys speaks English, French, German and Spanish: every text a user reads
// carries the four, and the store limits apply to each language.
const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** Every multi-language object of the manifest, with the path that leads to it. */
function multiLanguageTexts(node, path = '') {
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => multiLanguageTexts(child, `${path}[${index}]`));
  }
  if (node && typeof node === 'object') {
    if (typeof node.en === 'string') {
      return [{ path, text: node }];
    }
    return Object.entries(node).flatMap(([key, child]) =>
      multiLanguageTexts(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

test('every manifest text is written in English, French, German and Spanish', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 50, 'the walk must find the manifest texts');
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text), LANGUAGES, `${path} must carry exactly ${LANGUAGES}`);
    for (const language of LANGUAGES) {
      assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('the store length limits hold in every language', () => {
  const within = (text, min, max, what) => {
    for (const language of LANGUAGES) {
      const { length } = text[language];
      assert.ok(length >= min && length <= max, `${what}.${language}: ${length} characters`);
    }
  };
  within(manifest.description, 10, 100, 'description');
  for (const field of manifest.config_schema.filter((entry) => entry.type === 'section')) {
    within(field.description, 1, 1000, `${field.key}.description`);
  }
  for (const widget of manifest.widgets) {
    within(widget.label, 3, 30, `${widget.key}.label`);
    within(widget.description, 1, 100, `${widget.key}.description`);
  }
});
