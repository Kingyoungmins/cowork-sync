// The CS cache after Engine operations outside the iteration (G2 #24 of the 2026-10-20 audit; 05-holds HLD-36, glossary §9; rulings
// R3-40, R3-69): readCsCache accepts the cache cs/<enc(b)>.json only when it names the current state commit, and Engine.resolve and
// parkAllForStop commit state (a park's snap transition and withdrawal) without rewriting it, so a crash restart before the next
// state-committing iteration lost every open seat change-set's membership. They rewrite the cache now (Engine.cacheAfter), as finish()
// does after an iteration. Built from the audit probe scratchpad/audit/probes-lostpc2/cache.test.mts (there: `VERDICT park=true seat CS
// kept: false`). Engines on real clones of one file:// remote; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines } from '../helpers/engineFixture.js';
import { blob, nr, pair } from '../helpers/holdOpsFixture.js';
import { restartEngine } from '../helpers/loopHoldsFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';

const T14 = { timeout: 14 * 60_000 };
const P = 'src/t9.txt';
const SEAT = 'e'.repeat(32);
const leaveOpOf = (p: PeerFixture): string => `${p.core.peerId}/${p.core.view!.meta.epoch}/${p.core.view!.meta.seq_next}`;

for (const op of ['resolve --park', 'parkAllForStop'] as const) {
  test(`G2 #24: an open seat CS survives a crash restart right after ${op} committed state, and no recovered CS forms`, T14, async () => {
    await withEngines(`cs-cache-${op === 'parkAllForStop' ? 'stop' : 'park'}`, { n: 1, files: { 'README.md': buf('# cs cache\n'), [P]: buf(T9), 'seat1.txt': buf('s\n') } }, async (fx) => {
      await fx.startAll();
      const p = fx.peers[0]!;
      await fx.rounds(1);
      // An unrelated ON_DISK revert record over P (the probe's), then a seat's effect on another file: one open seat CS. (The probe's
      // extra rounds are dropped: an engine iteration costs about a minute on a loaded PC, and none is needed for the park or the cache.)
      await writeWork(p, P, t9([2, 'two']));
      const id = await p.core.holds.hold(nr({ paths: [P], blobs: pair(await blob(p, T9), await blob(p, t9([2, 'two'])), P) }));
      fx.advance(2_500);
      await p.engine.iterate();
      await writeWork(p, 'seat1.txt', 's seat\n');
      await fx.signal(0, { kind: 'effect', seat: SEAT, agent: null, toolUseId: 'toolu_g2cache', paths: ['seat1.txt'], turnOrigin: 'prompt' });
      const seatOpen = (): boolean => p.core.cs.table().cs.some((e) => e.cs_id === `${SEAT}/1` && e.state === 'open' && e.paths.includes('seat1.txt'));
      assert.ok(seatOpen(), `precondition: the seat CS is open ${JSON.stringify(p.core.cs.table().cs)}`);
      const commit0 = p.core.view!.commit;
      if (op === 'resolve --park') {
        assert.deepEqual(await fx.resolve(0, id, 'park'), { kind: 'done', code: 'HOLD_PARKED', id, created: null });
      } else {
        const res = await p.engine.parkAllForStop(leaveOpOf(p));
        assert.ok(res.parked.includes(id), JSON.stringify(res));
      }
      assert.notEqual(p.core.view!.commit, commit0, 'precondition: the operation committed state');
      await restartEngine(p);   // a crash: no iteration between the operation and the restart
      const after = p.core.cs.table().cs;
      assert.ok(seatOpen(), `the seat CS kept its membership: ${JSON.stringify(after.map((e) => [e.cs_id, e.kind, e.state, e.paths]))}`);
      assert.equal(after.some((e) => e.kind === 'recovered'), false, 'no recovered CS');
    });
  });
}
