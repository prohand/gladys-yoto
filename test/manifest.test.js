// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// what the code actually does — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

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

test('the account is linked through the account_link flow', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'account');
  assert.ok(field, 'the Yoto account must be linkable from the Configuration screen');
  // Yoto never redirects back to a local Gladys: `account_link` + device code
  // flow, hence a handler for the authorize URL and none for a callback.
  assert.equal(field.type, 'account_link');
  assert.ok(indexSource.includes('gladys.onOAuthAuthorizeUrl('));
});

test('the Client ID is required: nothing works without a Yoto app', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'client_id');
  assert.ok(field?.required, 'client_id must be required');
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
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
