import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_FLOOR, meetsFloor, parseGitVersion, type GitVersion } from '../../src/git/version.js';

test('GIT_FLOOR is 2.43.0 (glossary §18)', () => {
  assert.deepEqual({ ...GIT_FLOOR }, { major: 2, minor: 43, patch: 0, raw: '2.43.0' });
  assert.ok(Object.isFrozen(GIT_FLOOR));
});

test('parseGitVersion reads the real outputs of `git version`', () => {
  const cases: Array<[string, GitVersion]> = [
    ['git version 2.55.0.windows.3\n', { major: 2, minor: 55, patch: 0, raw: '2.55.0.windows.3' }],
    ['git version 2.55.0.windows.3\r\n', { major: 2, minor: 55, patch: 0, raw: '2.55.0.windows.3' }],
    ['git version 2.43.0\n', { major: 2, minor: 43, patch: 0, raw: '2.43.0' }],
    ['git version 2.39.3 (Apple Git-146)\n', { major: 2, minor: 39, patch: 3, raw: '2.39.3 (Apple Git-146)' }],
    ['git version 2.44.0-rc1\n', { major: 2, minor: 44, patch: 0, raw: '2.44.0-rc1' }],
    ['git version 2.45\n', { major: 2, minor: 45, patch: 0, raw: '2.45' }],
    ['\uFEFF  git version 2.47.1\nsecond line ignored\n', { major: 2, minor: 47, patch: 1, raw: '2.47.1' }],
    ['git version 10.0.12', { major: 10, minor: 0, patch: 12, raw: '10.0.12' }],
  ];
  for (const [stdout, expected] of cases) {
    assert.deepEqual(parseGitVersion(stdout), expected, JSON.stringify(stdout));
  }
});

test('parseGitVersion throws on anything that is not `git version <n>.<n>[.<n>]`', () => {
  for (const bad of ['', '\n', 'git version\n', 'git version abc\n', 'version 2.43.0\n', 'gitversion 2.43.0', 'git version .43.0', 'git version 2\n']) {
    assert.throws(() => parseGitVersion(bad), Error, JSON.stringify(bad));
  }
});

test('meetsFloor compares (major, minor, patch) against 2.43.0', () => {
  const v = (major: number, minor: number, patch: number): GitVersion => ({ major, minor, patch, raw: `${major}.${minor}.${patch}` });
  assert.equal(meetsFloor(v(2, 43, 0)), true);
  assert.equal(meetsFloor(v(2, 43, 5)), true);
  assert.equal(meetsFloor(v(2, 55, 0)), true);
  assert.equal(meetsFloor(v(3, 0, 0)), true);
  assert.equal(meetsFloor(v(2, 42, 99)), false);
  assert.equal(meetsFloor(v(2, 9, 0)), false);
  assert.equal(meetsFloor(v(1, 99, 99)), false);
  assert.equal(meetsFloor(parseGitVersion('git version 2.39.3 (Apple Git-146)')), false);
  assert.equal(meetsFloor(parseGitVersion('git version 2.55.0.windows.3')), true);
});
