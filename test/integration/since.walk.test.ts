// The catch-up walker over a real board (F04-a Task A2; 10-product §3.9a "Reads", "Limits", §7 T-F04-golden and T-F04-cap;
// FEAT-F04-02, -06, -08): walkSince reads the board through 8a's batched reader from the checkpoint at or below the range
// (less 1,024 heights for "my paths"), folds every commit with foldCommit and feeds the pure core; its report equals the
// in-memory batch over the same SB-F04 script (test/helpers/sbF04.ts). Also resolveSinceAnchor (the §3.9a anchor table).
// Env switch: COWORK_PERF_REFERENCE=1 (set only on the Windows reference laptop) turns T-F04-cap's p95 ≤ 2 s into a hard
// assertion; without it the p95 is reported via t.diagnostic only (see PERF_REFERENCE below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { READ_BATCH_MAX } from '../../src/board/batchRead.js';
import { enc } from '../../src/git/enc.js';
import { parseOid } from '../../src/git/oid.js';
import { MY_PATHS_LOOKBACK, type SinceReport } from '../../src/since/report.js';
import { resolveSinceAnchor, SINCE_CAP_HEIGHTS, sinceAnchors, walkSince } from '../../src/since/walk.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';
import {
  batchReport, joinDraft, LOOP, SAVE_C, SAVE_C0FFEE01, saveDraft, SB_MINE, SB_SEED, sbF04, sbF04ARejoins, sbF04Golden, sbF04Peers, sbPeerIds, sbRandom, sbSteps,
  sbWrite, type SbAction, type SbF04Variant,
} from '../helpers/sbF04.js';
import { spyRepo, type Call } from '../helpers/vizBatchRead.js';

const canon = (r: SinceReport): string => canonicalJson(r as unknown as Json);
const A = sbF04Peers().a.peer;

/** The suffixes 8a's readBoardCommits names after a board oid on --batch-check stdin (no live commit: withLive is off). */
const BOARD_NAME = /^[0-9a-f]{40}(?:\^\{tree\}|:ops\.jsonl|:protocol\.json|:held|:checkpoint|:checkpoint\/state\.json)?$/;

/** Every git call is a local read of the board: the ref, the first-parent chain and the batched board objects. */
function assertBoardReadsOnly(calls: readonly Call[], board: ReadonlySet<string>): void {
  for (const c of calls) {
    const kind = `${c.args[0]} ${c.args[1]}`;
    assert.ok(['for-each-ref --format=%(objectname) %(refname)', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch'].includes(kind), kind);
    if (kind !== 'cat-file --batch-check') continue;
    for (const name of c.stdin.split('\n').filter((l) => l.length > 0)) {
      assert.match(name, BOARD_NAME);
      assert.ok(board.has(name.slice(0, 40)), `${name} names a board commit`);
    }
  }
}

test('T-F04-golden through walkSince: SB-F04 written to a clone gives the golden report for every variant, byte-equal to the in-memory batch', async () => {
  const fx = await makeRepoFixture('since-walk-golden');
  try {
    const variants: Array<[string, SbF04Variant, typeof SB_MINE]> = [
      ['main', {}, []],
      ['touch', { aCsAt8: true }, []],
      ['repeat', { boardOnlyRepeat: true, aCsAt8: true }, []],
      ['big', { bigGroupOfC: true, aCsAt8: true }, []],
      ['cfirst', { cFirst: true }, []],
      ['records', { cOnMyRecords: true }, SB_MINE],
    ];
    for (const [branch, v, mine] of variants) {
      const w = await sbWrite(fx, SB_SEED, sbF04(v), branch);
      assert.equal(w.tip().height, 30);
      assert.equal(w.peer('a').peer, A, 'BoardWriter and the twin draw the same peer ids');
      const { repo, calls } = spyRepo(fx);
      const got = await walkSince(repo, branch, { from: 10, to: 30, you: A, mine });
      const sim = sbSteps(SB_SEED, sbF04(v));
      assert.deepEqual(got.report, sbF04Golden(v), branch);
      assert.equal(canon(got.report), canon(batchReport(sim.start, sim.steps, { from: 10, you: A, mine })), branch);
      // A joined at 4; C's save at 20 is found by any prefix of 7 or more hex digits of its commit, in either case (as
      // sinceAnchors compares them, final review M8).
      assert.equal(got.joinHeight, 4);
      assert.deepEqual(got.saves(SAVE_C.slice(0, 8)), [20]);
      assert.deepEqual(got.saves(SAVE_C), [20]);
      assert.deepEqual(got.saves(SAVE_C.slice(0, 8).toUpperCase()), [20]);
      assert.deepEqual(got.saves(SAVE_C.toUpperCase()), [20]);
      assert.deepEqual(got.saves('deadbee'), []);
      // Board reads only: one round (31 commits), no live commit, no blob or tree outside the board commits' entries.
      const chain = (await fx.repo.run(['rev-list', '--first-parent', w.tip().oid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
      assertBoardReadsOnly(calls, new Set(chain));
      assert.equal(calls.filter((c) => c.args[0] === 'cat-file' && c.args[1] === '--batch').length, 1);
    }
  } finally {
    await fx.cleanup();
  }
});

test('walkSince below the tip reads the chain at height `to`; a malformed board commit in the range folds as a no-op and the walk goes on', async () => {
  const fx = await makeRepoFixture('since-walk-edges');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    const below = await walkSince(fx.repo, 'main', { from: 10, to: 22, you: A, mine: [] });
    const golden = sbF04Golden({});
    assert.deepEqual(below.report, { ...golden, to: 22, events: [] });
    assert.deepEqual(below.saves(SAVE_C.slice(0, 7)), [20]);

    // Height 16 (a filler) replaced by a board commit whose ops.jsonl is over 64 KiB (readBoardCommits: ops_too_large).
    const actions = sbF04({ aCsAt8: true });
    const w = await sbWrite(fx, SB_SEED, actions.slice(0, 16), 'broken');
    await w.malformed('board_ops_too_large');
    const rest = actions.slice(17);
    const join25 = rest.findIndex((a) => a.kind === 'join');
    await w.commitMany(rest.slice(0, join25).map((a) => (a as Extract<SbAction, { kind: 'commit' }>).c));
    await w.join('b', { newEpoch: true });
    await w.commitMany(rest.slice(join25 + 1).map((a) => (a as Extract<SbAction, { kind: 'commit' }>).c));
    assert.equal(w.tip().height, 30);
    const got = await walkSince(fx.repo, 'broken', { from: 10, to: 30, you: A, mine: [] });
    assert.deepEqual(got.report, sbF04Golden({ aCsAt8: true }));
    const twin = sbSteps(SB_SEED, actions.map((a, h) => (h === 16 ? { kind: 'commit', c: { writer: null } } : a)));
    assert.equal(canon(got.report), canon(batchReport(twin.start, twin.steps, { from: 10, you: A })));
  } finally {
    await fx.cleanup();
  }
});

test('walkSince with o.tip reads the chain of that tip, not the board ref read again: a ref rewritten after sinceAnchors read it changes nothing (final review M3)', async () => {
  const fx = await makeRepoFixture('since-walk-tip');
  try {
    const w = await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    const anchors = (await sinceAnchors(fx.repo, 'main', A))!;
    assert.deepEqual([anchors.tip, anchors.tipOid], [30, w.tip().oid]);
    // The board ref is rewritten to height 22 of the same chain (an incident rewrite fetched in between).
    const chain = (await fx.repo.run(['rev-list', '--first-parent', w.tip().oid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    await fx.repo.run(['update-ref', `refs/cowork-remote/${enc('main')}/board`, chain[30 - 22]!]);
    const { repo, calls } = spyRepo(fx);
    const got = await walkSince(repo, 'main', { from: 10, to: anchors.tip, you: A, mine: [], tip: { oid: anchors.tipOid, height: anchors.tip } });
    assert.deepEqual(got.report, sbF04Golden({}));
    assert.deepEqual(calls.filter((c) => c.args[0] === 'for-each-ref'), [], 'the board ref is not read again');
    // Without the tip the walk reads the moved ref: height 30 is above its tip now.
    await assert.rejects(walkSince(fx.repo, 'main', { from: 10, to: 30, you: A, mine: [] }), RangeError);
    // A tip below `to` is refused like the ref's.
    await assert.rejects(walkSince(fx.repo, 'main', { from: 10, to: 30, you: A, mine: [], tip: { oid: parseOid(chain[30 - 22]!), height: 22 } }), RangeError);
  } finally {
    await fx.cleanup();
  }
});

test('sinceAnchors: the default search stops at this peer\'s newest join, the join commit included; wholeChain (a save: anchor) reads down to B0 and keeps the newest join; save prefixes compare case-insensitively (final review I1, M6)', async () => {
  const fx = await makeRepoFixture('since-walk-anchors');
  try {
    // A rejoins in a new epoch at 25 (above C's save at 20); B saves c0ffee01… at 27 (above the join).
    await sbWrite(fx, SB_SEED, sbF04ARejoins({ save27: true }), 'main');
    const near = (await sinceAnchors(fx.repo, 'main', A))!;
    assert.deepEqual([near.tip, near.joinHeight], [30, 25]);
    assert.deepEqual(near.saves('c0ffee0'), [27], 'C\'s save at 20 lies below the join: not searched');
    // Lowercasing is sinceAnchors' own (resolveSinceAnchor lowercases too, so the CLI rows cannot tell).
    assert.deepEqual(near.saves('C0FFEE01'), [27]);
    assert.deepEqual(near.saveCommits('C0FFEE0'), [SAVE_C0FFEE01]);
    const all = (await sinceAnchors(fx.repo, 'main', A, { wholeChain: true }))!;
    assert.deepEqual([all.tip, all.joinHeight], [30, 25], 'the newest join, not A\'s first one at 4');
    assert.deepEqual(all.saves('c0ffee0'), [20, 27]);
    assert.deepEqual(all.saves('C0FFEE00'), [20]);
    assert.deepEqual(all.saveCommits('C0FFEE0'), [SAVE_C, SAVE_C0FFEE01]);
    const tipOnly = (await sinceAnchors(fx.repo, 'main', A, { tipOnly: true }))!;
    assert.deepEqual([tipOnly.tip, tipOnly.joinHeight, tipOnly.saves('c0ffee0')], [30, null, []]);

    // The join one height above the save (21): the default search does not reach the save; the whole chain does.
    const above = sbF04({});
    above[21] = { kind: 'join', name: 'a', newEpoch: true };
    await sbWrite(fx, SB_SEED, above, 'above');
    const ab = (await sinceAnchors(fx.repo, 'above', A))!;
    assert.deepEqual([ab.joinHeight, ab.saves(SAVE_C.slice(0, 8))], [21, []]);
    assert.deepEqual((await sinceAnchors(fx.repo, 'above', A, { wholeChain: true }))!.saves(SAVE_C.slice(0, 8)), [20]);
    // A's join in the save's own commit (20): the default search includes the join commit, so the save is found.
    const same = sbF04({});
    same[20] = { kind: 'commit', c: { writer: 'a', ops: [joinDraft('A'), saveDraft(SAVE_C)] } };
    await sbWrite(fx, SB_SEED, same, 'same');
    const sm = (await sinceAnchors(fx.repo, 'same', A))!;
    assert.deepEqual([sm.joinHeight, sm.saves(SAVE_C.slice(0, 8))], [20, [20]]);
  } finally {
    await fx.cleanup();
  }
});

test('walkSince refuses a range it cannot read: `to` above the tip, `from` above `to`, a branch without a board', async () => {
  const fx = await makeRepoFixture('since-walk-refuse');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    await assert.rejects(walkSince(fx.repo, 'main', { from: 10, to: 31, you: A, mine: [] }), RangeError);
    await assert.rejects(walkSince(fx.repo, 'main', { from: 12, to: 11, you: A, mine: [] }), RangeError);
    await assert.rejects(walkSince(fx.repo, 'main', { from: 1.5, to: 11, you: A, mine: [] }), RangeError);
    await assert.rejects(walkSince(fx.repo, 'nothing-here', { from: 0, to: 0, you: A, mine: [] }), /no board/);
    // from −1 is the whole board.
    const all = await walkSince(fx.repo, 'main', { from: -1, to: 30, you: A, mine: [] });
    assert.equal(all.report.from, -1);
    assert.deepEqual(all.report.events.map((e) => [e.code, e.params['h']]), [
      ['UI_SINCE_EV_JOIN', 0], ['UI_SINCE_EV_JOIN', 1], ['UI_SINCE_EV_JOIN', 4], ['UI_SINCE_EV_REJOIN', 25], ['UI_SINCE_EV_FREEZE', 30],
    ]);
  } finally {
    await fx.cleanup();
  }
});

/** The nearest-rank percentile of samples. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Timed walks of T-F04-cap after one warm-up: ≥ 20, so the nearest-rank p95 is not the slowest walk (a max-of-N gate). */
const CAP_TIMED_RUNS = 20;
/** FEAT-F04-08: CLI p95 SHOULD be ≤ 2 s at the cap on the Windows reference laptop. */
const CAP_P95_REFERENCE_MS = 2_000;
/**
 * COWORK_PERF_REFERENCE=1 marks a run on the Windows reference laptop (10-product §3.9a, FEAT-F04-08): only there is the
 * p95 budget a hard assertion. Everywhere else (the six CI legs, a loaded dev machine) the p95 and every sample are
 * reported through t.diagnostic, beside the brief's "2× in CI" figure, and never fail the test (controller ruling, F04-a
 * Task A2 fix round 1: a shared CI runner's wall clock is not the reference). The functional assertions of every walk
 * (report bytes, truncatedFrom, ≤ 5 cat-file --batch processes) hold unconditionally.
 */
const PERF_REFERENCE = process.env['COWORK_PERF_REFERENCE'] === '1';

test('T-F04-cap: 6,200 heights after the anchor — the report covers (to − 5,000, to] with truncatedFrom set, ≤ 5 cat-file --batch processes; p95 of 20 timed walks ≤ 2 s asserted with COWORK_PERF_REFERENCE=1 (the Windows reference), reported otherwise', { timeout: 600_000 }, async (t) => {
  const fx = await makeRepoFixture('since-walk-cap');
  try {
    const seed = 'f04-cap';
    const from = 100;
    const to = from + 6_200;
    const actions = sbRandom(seed, to, { freshEpochs: false });
    const w = await sbWrite(fx, seed, actions, 'main');
    assert.equal(w.tip().height, to);
    const you = sbPeerIds(seed, ['b', 'c', 'a', 'd']).get('a')!.peer;
    const mine = [{ id: '01HZ00000000000000000000C1', paths: [LOOP, 'docs/guide.md'], state: 'PARKED', offer: 'none' }];
    const sim = sbSteps(seed, actions);
    const expected = batchReport(sim.start, sim.steps, { from, you, mine, capFrom: to - SINCE_CAP_HEIGHTS });

    const samples: number[] = [];
    for (let run = 0; run <= CAP_TIMED_RUNS; run++) {
      const { repo, calls } = spyRepo(fx);
      const t0 = performance.now();
      const got = await walkSince(repo, 'main', { from, to, you, mine });
      const ms = performance.now() - t0;
      if (run > 0) samples.push(ms);   // run 0 warms the object store's pack index and the module
      const batches = calls.filter((c) => c.args[0] === 'cat-file' && c.args[1] === '--batch');
      assert.ok(batches.length <= 5, `${batches.length} cat-file --batch processes (⌈(${SINCE_CAP_HEIGHTS} + ${MY_PATHS_LOOKBACK} + 257) / ${READ_BATCH_MAX}⌉ = 5)`);
      assert.equal(got.report.from, from);
      assert.equal(got.report.to, to);
      assert.equal(got.report.truncatedFrom, to - SINCE_CAP_HEIGHTS);
      for (const row of [...got.report.saves, ...got.report.events]) assert.ok((row.params['h'] as number) > to - SINCE_CAP_HEIGHTS, JSON.stringify(row));
      assert.equal(canon(got.report), canon(expected));
      assert.ok(got.report.team.length > 0 && got.report.events.length > 0 && got.report.saves.length === 10 && got.report.you.touches.length > 0);
    }
    // A p95 that is the slowest sample is a max-of-N gate: one GC pause or slow spawn decides it.
    assert.ok(Math.ceil(0.95 * samples.length) < samples.length, `p95 over ${samples.length} timed samples is the slowest one (nearest rank ${Math.ceil(0.95 * samples.length)})`);
    const p95 = percentile(samples, 95);
    t.diagnostic(`walkSince over ${to - from} heights (capped to ${SINCE_CAP_HEIGHTS}), ${samples.length} timed walks: ${samples.map((s) => Math.round(s)).join(', ')} ms; `
      + `p95 ${Math.round(p95)} ms (reference budget ${CAP_P95_REFERENCE_MS} ms, ${PERF_REFERENCE ? 'asserted: COWORK_PERF_REFERENCE=1' : 'not asserted: COWORK_PERF_REFERENCE unset'}; `
      + `2× = ${2 * CAP_P95_REFERENCE_MS} ms ${p95 <= 2 * CAP_P95_REFERENCE_MS ? 'met' : 'exceeded'})`);
    if (PERF_REFERENCE) assert.ok(p95 <= CAP_P95_REFERENCE_MS, `p95 ${Math.round(p95)} ms > ${CAP_P95_REFERENCE_MS} ms on the reference`);
  } finally {
    await fx.cleanup();
  }
});

test('resolveSinceAnchor: #<n> below the tip, save:<hex prefix> of one effective save (ambiguous: AMBIGUOUS_ID), the default join height; anything else RF_SINCE_ANCHOR', () => {
  const saves = (p: string): readonly number[] => (SAVE_C.startsWith(p) ? [20] : p === 'abcdef0' ? [7, 9] : []);
  const ctx = { tip: 30, joinHeight: 4, saves };
  const refuse = { refuse: 'RF_SINCE_ANCHOR' };
  assert.deepEqual(resolveSinceAnchor('#17', ctx), { from: 17 });
  assert.deepEqual(resolveSinceAnchor('#0', ctx), { from: 0 });
  assert.deepEqual(resolveSinceAnchor('#29', ctx), { from: 29 });
  for (const v of ['#30', '#999999', '#017', '#12345678901', '#-1', '#', '#1.5', '# 3', '17']) assert.deepEqual(resolveSinceAnchor(v, ctx), refuse, v);
  assert.deepEqual(resolveSinceAnchor(`save:${SAVE_C.slice(0, 8)}`, ctx), { from: 20 });
  assert.deepEqual(resolveSinceAnchor(`save:${SAVE_C.slice(0, 7)}`, ctx), { from: 20 });
  assert.deepEqual(resolveSinceAnchor(`save:${SAVE_C.slice(0, 8).toUpperCase()}`, ctx), { from: 20 });
  assert.deepEqual(resolveSinceAnchor('save:abcdef0', ctx), { refuse: 'AMBIGUOUS_ID' });
  for (const v of ['save:deadbee', 'save:c0ffe', 'save:', `save:${'a'.repeat(65)}`, 'save:zzzzzzz', 'save:c0ffee00 ', 'last-run', 'away', '', 'since', 'join']) {
    assert.deepEqual(resolveSinceAnchor(v, ctx), refuse, JSON.stringify(v));
  }
  assert.deepEqual(resolveSinceAnchor(null, ctx), { from: 4 });
  assert.deepEqual(resolveSinceAnchor(null, { ...ctx, joinHeight: null }), refuse);
});
