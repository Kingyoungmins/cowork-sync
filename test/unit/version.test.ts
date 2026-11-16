import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLUGIN_VERSION } from '../../src/version.js';

test('PLUGIN_VERSION is a semver string equal to package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('package.json declares devDependencies only, ESM and the Node >=20.6 dev floor', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.deepEqual(pkg.engines, { node: '>=20.6' });
  // Plan 4 Task 1 (R4-09, R4-10): web-tree-sitter and the four grammar packages are devDependencies (exact versions; the
  // grammar spike test pins them against package-lock.json); esbuild bundles web-tree-sitter into dist/worker.js only.
  assert.deepEqual(Object.keys(pkg.devDependencies as object).sort(), [
    '@types/node', 'esbuild', 'fast-check', 'tree-sitter-c-sharp', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-typescript',
    'tsx', 'typescript', 'web-tree-sitter',
  ]);
});
