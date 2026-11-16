// EF4 round 2 K-4 (ruling R3-EF4-16; HLD-53 across applies, R3-EF4-4; final review FB-6): an FB-6 'unmaterializable' DEFERRAL — a path
// whose whole-path edit git for Windows cannot build while TIP holds a root drive-prefix name (`a:b.txt`), deferred in its write group —
// is still deferred for HLD-53's chain. meta.pending stores it under the not-applicable reason string 'unmaterializable', so incomingBase
// used to leave it out of the pathChains walk, and a CS C below LA_C that CHANGED it (and declared README.md without changing it) stopped
// counting at the next apply: README.md left the closure C formed at the previous apply and was written alone (INV-GROUP (iii) once the
// oracle carries C by its changed paths). Its rows now join the chain's wants (not the base): C counts and the closure stays whole.
// Real git on a win32 receiver (the refusal is git for Windows'); skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { makeCores, readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
const FILES: Record<string, Buffer> = {
  'README.md': buf('# apply fixture\n'),
  'notes.md': buf('# Notes\n\nalpha\n'),
  'x.txt': buf('x1\n'),
};
let iter = 0;

async function prep(p: PeerFixture): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++iter, { materialize: 'auto', forceFetch: true });
  assert.ok(r.ok, `prepareIteration failed: ${JSON.stringify(r)}`);
  return r.it;
}

async function apply(fx: CoreFixture, p: PeerFixture): Promise<ApplyReport> {
  fx.advance(10_000);
  return applyStep(p.core, await prep(p));
}

const show = (r: ApplyReport): string => JSON.stringify({
  written: r.written, deferred: [...r.deferred], notApplicable: [...r.notApplicable], closures: r.closures,
  incoming: r.incoming.map((c) => `${c.commit.slice(0, 8)}:${c.paths.join('|')}`),
});

test('an FB-6 unmaterializable deferral keeps the CS that changed it in the next apply\'s closure range (R3-EF4-16)', {
  skip: process.platform !== 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (FB-6): win32 only' : false,
  timeout: 10 * 60_000,
}, async () => {
  const fx = await makeCores('k4-fb6chain', { n: 1, files: FILES, platform: 'win32' });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    // TIP gains `a:b.txt` (never indexable here) and x.txt.
    await fx.pushTeamChange({ 'a:b.txt': buf('ab\n'), 'x.txt': buf('x7\n') });
    await apply(fx, p);
    await writeWork(p, 'notes.md', buf('# Notes\n\nalpha\nlocal line\n'));
    await prep(p);
    // C changes notes.md (a D9 concat over a TIP holding a:b.txt: FB-6 defers it 'unmaterializable') and declares README.md unchanged.
    const C = await fx.pushTeamChange({ 'notes.md': buf('# Notes\n\nalpha\nteam line\n'), 'README.md': FILES['README.md']! });
    // D changes README.md only.
    await fx.pushTeamChange({ 'README.md': buf('# apply fixture v2\n') });
    const n = await apply(fx, p);
    assert.ok(n.incoming.some((c) => c.commit === C.live), `C is incoming at N: ${show(n)}`);
    assert.deepEqual(n.closures.map((c) => c.paths), [['README.md', 'notes.md']], `N: C ties README.md to the FB-6 deferral: ${show(n)}`);
    assert.deepEqual(p.core.view!.meta.pending, { 'README.md': 'closure', 'notes.md': 'unmaterializable' });
    // An unrelated change moves TIP; LA_C is now D, C lies below it and changed only the still-deferred notes.md.
    await fx.pushTeamChange({ 'x.txt': buf('x8\n') });
    const n1 = await apply(fx, p);
    assert.ok(n1.incoming.some((c) => c.commit === C.live), `N+1: C (below LA_C, it changed the still-deferred notes.md) still counts: ${show(n1)}`);
    assert.ok(!n1.written.includes('README.md'), `N+1: README.md is not written apart from notes.md: ${show(n1)}`);
    assert.equal(n1.deferred.get('README.md'), 'closure', show(n1));
    assert.deepEqual(n1.closures.map((c) => c.paths), [['README.md', 'notes.md']], `N+1: the closure stays whole: ${show(n1)}`);
    assert.ok(n1.written.includes('x.txt'), `N+1: the unrelated path is written: ${show(n1)}`);
    assert.deepEqual(await readWork(p, 'README.md'), FILES['README.md'], 'README.md keeps A on disk');
  } finally {
    await fx.cleanup();
  }
});
