// Plan 5 Task 5 (A5-13): the fixtures' per-peer engineDeps option binds claude/attribution/lease per peer and changes
// nothing when absent — every peer keeps noClaude, humanOnlyAttribution and alwaysLeased by identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alwaysLeased } from '../../src/ports/lease.js';
import { humanOnlyAttribution, noClaude } from '../../src/engine/deps.js';
import { makeEngines } from '../helpers/engineFixture.js';
import { makeCores } from '../helpers/coreFixture.js';

test('A5-13: makeCores engineDeps binds per peer and keeps the defaults when absent', async () => {
  const fx = await makeCores('a513-cores', { n: 2, engineDeps: (p) => ({ lease: { idleMs: () => (p === 0 ? 7 : 11) } }) });
  try {
    assert.equal(fx.peers[0]!.deps.lease.idleMs(), 7);
    assert.equal(fx.peers[1]!.deps.lease.idleMs(), 11);
    // the un-named ports keep the defaults
    for (const p of fx.peers) {
      assert.equal(p.deps.claude, noClaude);
      assert.equal(p.deps.attribution, humanOnlyAttribution);
      // Plan 3's ports are untouched by the engineDeps assignment
      assert.equal(fx.peers[0]!.deps.editCheck, fx.peers[1]!.deps.editCheck);
    }
  } finally { await fx.cleanup(); }
});

test('A5-13: without the option every peer keeps noClaude / humanOnlyAttribution / alwaysLeased by identity', async () => {
  const fx = await makeEngines('a513-default', { n: 2 });
  try {
    for (const p of fx.peers) {
      assert.equal(p.deps.claude, noClaude);
      assert.equal(p.deps.attribution, humanOnlyAttribution);
      assert.equal(p.deps.lease, alwaysLeased);
    }
  } finally { await fx.cleanup(); }
});
