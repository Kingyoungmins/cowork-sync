// INV-NOLOSS under a share-none lock (EF4 D2-1, class noloss-formatter-lock, seeds meas-holds-48 / -97; 11-testing §3.4 INV-NOLOSS,
// §3.5 F-FS-1, TST-07; glossary §21 INV-NOLOSS "an undisplaced edit still on its author's disk"; 05-holds §7 P7 (FileShare.None locks in
// the INV-NOLOSS generator), HLD-32; 01-engine §3.8 step 4, ENG-24; rulings R3-48 and Task 15 fix round 1's allowance list).
//
// p0 edits fmt/m05.py and another program takes it with no read sharing before p0's next tick: every staged read of it is refused
// (ENG-24 UNREADABLE, a per-loop exclusion: S_pub[p] := A[p], the path never enters the dirty set, so it is in no CS and no pair), and
// from 60 s its `unreadable` PIN holds h0 = h1 = A[p] (HLD-32: h1 is the blob the private index still holds; Task EF item 2). The
// marker's only copy is the author's working file, untouched. INV-NOLOSS must count it there while the lock holds and until p0's first
// iteration after the release; that iteration reads the file into the open human CS, and the CS's close publishes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import { isTerminal } from '../../src/holds/record.js';
import { alone, engineAt, has, holdsOf, okOrFail, play, SIM_TIMEOUT, type Step } from '../helpers/holdsScript.js';
import { judge } from '../helpers/nolossPlants.js';
import { holdsSetup } from '../sim/generators.js';
import { runSim, type SimContext } from '../sim/harness.js';
import { findMarkers, MarkerModel, type MarkerOwner } from '../sim/markers.js';
import { locateMarker, oracleNoloss, type NolossFound } from '../sim/oracleNoloss.js';

const NS = RELEASE_NAMESPACE;
const LOCKED = 'fmt/m05.py';

test('INV-NOLOSS counts a marker on its author\'s disk in a file held without read sharing: p0 edits fmt/m05.py, a share-none lock takes it before p0\'s next tick, and through 70 virtual s of p0 iterations (no CS, no pair, an unreadable PIN with h1 = A from 60 s) the marker is author_disk by the lock; after unlock it counts until p0\'s next iteration (a cold oracle, which never saw the lock, refuses it), that iteration puts it in the open CS, and the CS\'s close publishes it', { timeout: SIM_TIMEOUT }, async () => {
  const s = holdsSetup('holds-nl-sharenone', { script: [] });
  const markers = s.markers;
  const at = new Map<string, NolossFound | null>();
  const facts = new Map<string, unknown>();
  let m = '';
  let owner: MarkerOwner | null = null;
  // One cache for every probe: locateMarker then keeps the lock it saw between probes, as the run's oracleNoloss does.
  const warm = {};
  const locate = (ctx: SimContext): Promise<NolossFound | null> => locateMarker(ctx, NS, m, owner!, warm);
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_own', peer: 0, params: { path: LOCKED, row: 3, text: '    v4 = 4 p0 under a lock' } },
    { kind: 'lock_share_none', peer: 0, params: { path: LOCKED } },
    ...alone(0, 1),
    {
      probe: 'held', run: async (ctx) => {
        const e = [...ctx.opLog].reverse().find((x) => x.kind === 'edit_own' && x.peer === 'p0')!;
        m = findMarkers(Buffer.from(e.detail, 'latin1')).at(-1)!;
        owner = markers.live().get(m) ?? null;
        assert.ok(owner !== null && owner.path === LOCKED, `${m} is p0's obligation at ${LOCKED}`);
        // The ratified engine behaviour the oracle has to allow for (ENG-24): the unreadable path is in no open CS (and the detail below
        // shows no ready pair carries the marker: authorCounts asks 'open CS' and 'ready' before the lock).
        const p0 = engineAt(ctx, 0);
        facts.set('heldOpen', p0.core.cs.openPaths().has(LOCKED));
        at.set('held', await locate(ctx));
      },
    },
    ...alone(0, 28),
    {
      probe: 'pin', run: async (ctx) => {
        const pins = (await holdsOf(ctx, 0)).filter((r) => r.kind === 'PIN' && has(r, 'unreadable') && r.paths.includes(LOCKED) && !isTerminal(r));
        const sides = pins[0]?.blobs as { h0: Record<string, string>; h1: Record<string, string> } | undefined;
        const h1 = sides?.h1[LOCKED];
        const h1Bytes = h1 === undefined || h1 === 'ABSENT' ? null : (await ctx.git.run(['cat-file', 'blob', h1], { class: 'local', cwd: ctx.peers[0]!.dir })).stdout;
        facts.set('pin', { n: pins.length, h0EqH1: sides !== undefined && sides.h0[LOCKED] === h1, h1HasMarker: h1Bytes !== null && findMarkers(h1Bytes).includes(m) });
        at.set('pin', await locate(ctx));
      },
    },
    { kind: 'unlock', peer: 0 },
    {
      probe: 'released', run: async (ctx) => {
        at.set('released', await locate(ctx));
        // A cold oracle never saw the lock: its first check grants no post-release window (Task 15 fix round 1: strict first check).
        const mm = new MarkerModel(markers.run);
        mm.noteEdit(owner!.peer, owner!.path, [m], [], true, () => false);
        facts.set('releasedCold', await judge(oracleNoloss(mm, NS), ctx));
      },
    },
    ...alone(0, 1),
    { probe: 'captured', run: async (ctx) => { at.set('captured', await locate(ctx)); } },
    { rounds: 12 },
    { probe: 'published', run: async (ctx) => { at.set('published', await locate(ctx)); } },
  ];
  const options = { ...s.options, generator: play(steps, markers) };
  delete options.quiescence;
  const r = await runSim({ ...s.tuple, ops: steps.length }, s.factory, [oracleNoloss(markers, NS)], options);
  okOrFail(r);
  assert.equal(facts.get('heldOpen'), false, `${LOCKED} is in no open CS of p0 while it is unreadable`);
  assert.match(at.get('held')?.detail ?? '', /^author_disk p0:fmt\/m05\.py \(share-none lock/, JSON.stringify(at.get('held')));
  assert.deepEqual(facts.get('pin'), { n: 1, h0EqH1: true, h1HasMarker: false }, 'one unreadable PIN, h0 = h1 = A[p]: the record does not hold the marker');
  assert.match(at.get('pin')?.detail ?? '', /^author_disk p0:fmt\/m05\.py \(share-none lock/, JSON.stringify(at.get('pin')));
  assert.match(at.get('released')?.detail ?? '', /^author_disk p0:fmt\/m05\.py \(share-none lock released, no iteration of its author since\)$/, JSON.stringify(at.get('released')));
  assert.match(String(facts.get('releasedCold')), new RegExp(`^INV-NOLOSS: marker ${m} \\(author p0, path fmt/m05\\.py, written at step \\d+\\) is in no location`));
  assert.match(at.get('captured')?.detail ?? '', /^author_disk p0:fmt\/m05\.py \(open CS\)$/, JSON.stringify(at.get('captured')));
  assert.equal(at.get('published')?.at, 'live', JSON.stringify(at.get('published')));
});
