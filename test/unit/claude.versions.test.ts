import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionPolicy, semverCompare } from '../../src/claude/daemon/versions.js';

test('semverCompare: numeric cores, prerelease before release, semver §11 identifier order', () => {
  assert.equal(semverCompare('0.6.0', '0.6.0'), 0);
  assert.ok(semverCompare('0.6.1', '0.6.0') > 0);
  assert.ok(semverCompare('0.10.0', '0.9.0') > 0);          // numeric, not lexical
  assert.ok(semverCompare('1.0.0-rc.1', '1.0.0') < 0);       // prerelease orders before the release
  assert.ok(semverCompare('1.0.0-rc.2', '1.0.0-rc.11') < 0); // numeric identifiers compare numerically
  assert.ok(semverCompare('1.0.0-alpha', '1.0.0-alpha.1') < 0); // fewer fields is lower
  assert.ok(semverCompare('1.0.0-alpha', '1.0.0-beta') < 0);    // alphanumeric lexically
  assert.ok(semverCompare('1.0.0-1', '1.0.0-alpha') < 0);       // numeric < alphanumeric
  assert.throws(() => semverCompare('banana', '1.0.0'), TypeError);
});

test('VersionPolicy.judge: the six pinned cases', () => {
  const own = new VersionPolicy({ pluginVersion: '0.6.0', hookProto: 3 });
  assert.equal(own.judge('0.6.1', 3), 'serve_then_drain');        // newer caller
  assert.equal(own.judge('0.6.0', 3), 'serve');                    // same version, current proto
  assert.equal(own.judge('0.5.9', 2), 'serve');                    // older version, previous proto
  assert.equal(own.judge('0.5.0', 1), 'restart_required');         // proto two behind
  const rc = new VersionPolicy({ pluginVersion: '1.0.0', hookProto: 3 });
  assert.equal(rc.judge('1.0.0-rc.1', 3), 'serve');                // 1.0.0-rc.1 < 1.0.0 → not newer
  assert.equal(own.judge('0.6.0', 4), 'serve');                    // caller newer proto is fine
});

test('judge is total: an unparsable version is restart_required, never a throw (R-F2-14; F2 #46, #101)', () => {
  const own = new VersionPolicy({ pluginVersion: '0.6.0', hookProto: 3 });
  for (const v of ['not-semver', '', '0.2.0+build.1', '1.2']) {
    assert.equal(own.judge(v, 3), 'restart_required', JSON.stringify(v));
  }
  // An unparsable own version is the same verdict for every caller (the daemon cannot order the two).
  assert.equal(new VersionPolicy({ pluginVersion: 'dev', hookProto: 3 }).judge('0.6.0', 3), 'restart_required');
});
