// Final review FB-5, item 3 (the not_converged backstop in loop.ts): a non-terminal ON_DISK CONFLICTED `conflict`
// record resets its path to A[p] in every P (MASK step 4), so the path is listed in not_converged as blocked_publish with
// guard conflict (a teammate reverting TIP to A, or a manual resolution, leaves LOCAL on disk with no write to move the
// record OFF_DISK; Plan 3 moves it); an OFF_DISK record masks nothing and is not listed. Real git, Engines over file://.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEngines } from '../helpers/engineFixture.js';
import { buf } from '../helpers/publishHelpers.js';

test('final review FB-5 (backstop): an ON_DISK CONFLICTED conflict record shows its path in not_converged as blocked_publish{guard: conflict}; once OFF_DISK it is not listed', async () => {
  await withEngines('loop-conflict-guard', { n: 1, files: { 'README.md': buf('# conflict guard\n'), 'x.txt': buf('x\n') } }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await fx.rounds(1);
    const a = (await p.core.repo.readTreeMap(p.core.view!.base)).get('x.txt')!.oid;
    const local = await p.core.repo.hashBytes(buf('x, the displaced local version\n'), true);
    const id = await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['x.txt'],
      blobs: { s1: { 'x.txt': a }, s2: { 'x.txt': local }, s3: { 'x.txt': a } },
      guard: 'conflict', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false,
    });
    await fx.rounds(1);
    const s = await p.engine.inspect();
    assert.deepEqual(s.notConvergedWhy?.['x.txt'], { cause: 'blocked_publish', guard: 'conflict' }, 'the masked path is visible');
    assert.ok(s.notConverged.includes('x.txt'));
    await p.core.holds.transition(id, { residence: 'OFF_DISK' });
    await fx.rounds(1);
    const s2 = await p.engine.inspect();
    assert.equal(s2.notConvergedWhy?.['x.txt'], undefined, 'an OFF_DISK record masks nothing and is not listed');
    assert.equal(s2.notConverged.includes('x.txt'), false);
  });
});
