// The R3-SPEC-3 "kept" K4 after the human verbs (G2 #29 of the 2026-10-20 audit; 05-holds §3.4 item 3 "K4 over a marker file", HLD-08,
// HLD-16, HLD-17, Table 4 `--restore`/`--park`/`--publish`; rulings R3-SPEC-3, R3-SPEC-6, R3-22): a K4 TAKE_TIP onto a markers record r
// whose TIP blob holds a restore-marker row keeps r ON_DISK CONFLICTED [markers, conflict] while the disk holds TIP, not r's own change
// (s2). `--restore` used to answer HOLD_RESTORED with nothing restored, and `--park` (after the row was removed) refreshed s2 := the disk
// and wrote A[p] back, losing r's own change from r. Now: while the row is there --restore and --publish are refused HOLD_GUARDS_REMAIN
// {markers}; once it is gone --park takes HLD-08's deferred OFF_DISK move (no write, s2 kept), and --restore / --publish move r OFF_DISK
// and restore its own change. Built from the audit probe scratchpad/audit/probes-p3engine/probe.keptMarkersK4.test.ts. Real git on
// file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { resolve, type ResolveResult, type ResolveVerb } from '../../src/engine/resolve.js';
import type { Oid } from '../../src/git/oid.js';
import { blobAt, heldSide, type HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blob, nr, P, prepIt, stages, withPeers } from '../helpers/holdOpsFixture.js';
import { t9 } from '../helpers/maskFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';

/**
 * 20 minutes, not R3-55's 10 (G2 ruling, stated, not a silent loosening): each test is a fresh clone pair, a K4 apply, a release
 * iteration and a resolve; on the loaded 16 GB PC of 2026-10-21 the setup alone took ~430 s and every variant passed its assertions
 * only past 600 s. A hang still fails, at 20 minutes.
 */
const T20 = { timeout: 20 * 60_000 };

/** A conflicted restore's rows on disk (apply.k4.p3.test.ts's ROWS): the markers record's held side is row 2 'two'. */
const ROWS = '1\n<<<<<<< cowork:disk\nTWO\n||||||| cowork:base\n2\n=======\ntwo\n>>>>>>> cowork:held\n3\n4\n5\n6\n7\n8\n9\n';
const TEAM = t9([2, 'TEAM2'], [8, '<<<<<<< cowork:team']);
const FIXED = t9([2, 'TEAM2'], [8, 'eight-fixed']);
const done = (code: string, id: string, created: string | null = null): ResolveResult => ({ kind: 'done', code, id, created });
const shape = (r: HoldRecord | undefined): unknown[] => [r?.residence, r?.state, (r?.guards ?? []).map((g) => g.name)];
const disk = async (p: PeerFixture): Promise<string> => (await readWork(p, P))!.toString('utf8');

/** The R3-SPEC-3 kept state: markers record r (held side row 2 'two'), then a teammate TIP with TEAM2 and a restore-marker row. */
async function keptState(fx: CoreFixture, p: PeerFixture): Promise<{ r: string; held: Oid }> {
  await writeWork(p, P, ROWS);
  const it0 = await prepIt(p, { holdPaths: [P] });
  const a = it0.A.get(P)!.oid;
  const held = await blob(p, t9([2, 'two']));
  const r = await p.core.holds.hold(nr({ guard: 'markers', origin: 'daemon', blobs: stages(a, held, await blob(p, t9([2, 'team']))) }));
  await fx.pushTeamChange({ [P]: buf(TEAM) });
  fx.advance(10_000);
  const ar = await applyStep(p.core, await prepIt(p, { forceFetch: true }));
  assert.ok(ar.written.includes(P), JSON.stringify(ar));
  assert.deepEqual(shape(p.core.holds.get(r)), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']], 'precondition: R3-SPEC-3 kept r ON_DISK with markers');
  assert.equal(blobAt(heldSide(p.core.holds.get(r)!), P), held, 'precondition: r keeps its own change');
  assert.equal(await disk(p), TEAM, 'precondition: the disk holds TIP');
  return { r, held };
}

/** The human removes TIP's restore-marker row; a materializing iteration and step 5R release `markers` (its PREDICATE). */
async function rowRemoved(fx: CoreFixture, p: PeerFixture, r: string): Promise<void> {
  await writeWork(p, P, FIXED);
  await prepIt(p);
  fx.advance(3_000);
  const it = await prepIt(p, { materialize: true });
  await recordStep(p.core, it, await applyStep(p.core, it));
  assert.deepEqual(shape(p.core.holds.get(r)), ['ON_DISK', 'CONFLICTED', ['conflict']], 'precondition: markers released, r still ON_DISK');
}

const hasTwo = (s: string): boolean => s.split('\n').includes('two');

const WHAT: Readonly<Record<'park' | 'restore' | 'publish', string>> = {
  park: 'once TIP\'s restore-marker row is gone, --park moves it OFF_DISK with no write and keeps its own change',
  restore: 'while TIP\'s restore-marker row is on the disk --restore is refused HOLD_GUARDS_REMAIN {markers} (nothing written); once it is gone --restore moves it OFF_DISK and restores its own change',
  publish: 'while TIP\'s restore-marker row is on the disk --publish is refused HOLD_GUARDS_REMAIN {markers}; once it is gone --publish restores its own change first',
};

for (const verb of ['park', 'restore', 'publish'] as const satisfies readonly ResolveVerb[]) {
  test(`G2 #29 --${verb}: a kept K4 (R3-SPEC-3: ON_DISK, its TIP write landed) — ${WHAT[verb]}`, T20, async () => {
    await withPeers(`kept-k4-${verb}`, {}, async (fx) => {
      const p = fx.peers[0]!;
      const { r, held } = await keptState(fx, p);
      if (verb !== 'park') {
        fx.advance(1_000);
        // The refusal is decided on the record alone (before the write gate): an iteration that materializes nothing is enough.
        const refused = await resolve(p.core, await prepIt(p, { materialize: false }), r, verb, HUMAN);
        assert.deepEqual(refused, { kind: 'refused', code: 'HOLD_GUARDS_REMAIN', params: { hid: r, guards: ['markers'] } }, `${verb}: never "its bytes are on the disk"`);
        assert.equal(await disk(p), TEAM, `${verb}: nothing written`);
        assert.deepEqual(shape(p.core.holds.get(r)), ['ON_DISK', 'CONFLICTED', ['markers', 'conflict']], `${verb}: r unchanged`);
      }
      await rowRemoved(fx, p, r);
      fx.advance(1_000);
      const res = await resolve(p.core, await prepIt(p, { holdPaths: [P] }), r, verb, HUMAN);
      if (verb === 'park') {
        assert.deepEqual(res, done('HOLD_PARKED', r));
        const x = p.core.holds.get(r)!;
        assert.deepEqual(shape(x), ['OFF_DISK', 'CONFLICTED', ['conflict']], 'HLD-08\'s deferred OFF_DISK move');
        assert.equal(blobAt(heldSide(x), P), held, 'its own change is kept (never refreshed from the TIP-holding disk)');
        assert.ok(x.displaced_by !== null, 'displaced by the K4\'s TIP write (R3-22)');
        assert.equal(await disk(p), FIXED, 'nothing written: the human\'s edit stays on the disk');
        // A later --restore of this OFF_DISK CONFLICTED stage record is the ordinary K4 restore (s1 → s2 merged onto the disk): the
        // --restore and --publish variants below cover it.
      } else {
        assert.deepEqual(res, done('RESTORE_MARKERS', r), `${verb}: its own change over the TIP's row 2 conflicts: restore markers`);
        const x = p.core.holds.get(r)!;
        assert.deepEqual(shape(x), ['ON_DISK', 'ACTIVE', ['markers']], `${verb}: restored, conflict released, markers added`);
        assert.ok(x.displaced_by !== null, `${verb}: the OFF_DISK move set the K4's displacement first (R3-22)`);
        const now = await disk(p);
        assert.ok(hasTwo(now) && now.includes('eight-fixed'), `${verb}: its own change merged over the human's edit: ${JSON.stringify(now)}`);
      }
    });
  });
}
