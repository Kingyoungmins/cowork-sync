// The hold-transition rows of `/cowork since` (Plan 3 Task 19; 10-product §3.9a section 2 (b), FEAT-F04-06…-08,
// T-F04-golden's hold rows; X-12, F-P3-4): this peer's hold records whose effective `hold` op in the range moved them to
// PARKED (UI_SINCE_PARKED), offer=returned (UI_SINCE_RETURNED) or SUBSUMED (UI_SINCE_SUBSUMED), derived by the pure core
// from the fold's FoldState.holds before and after each board commit (FoldedHold.owner = this peer). Fixtures: SB-F04's
// `holds` variant and sbRandom's `holds` option (test/helpers/sbF04.ts); the read test writes the twin's commits, held/
// entries included, through foldBoard's importBoard (sbImport) and walks them with walkSince.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { sinceFinish, sinceInit, sincePush, type SinceAcc, type SinceReport, type SinceRow } from '../../src/since/report.js';
import { walkSince } from '../../src/since/walk.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';
import {
  batchReport, holdDraft, SB_HOLDS, SB_SEED, sbF04, sbF04Golden, sbF04Peers, sbHoldRows, sbImport, sbPeerIds, sbRandom, sbSteps, sbWrite, type SbAction,
} from '../helpers/sbF04.js';
import { spyRepo, type Call } from '../helpers/vizBatchRead.js';

const canon = (r: SinceReport): string => canonicalJson(r as unknown as Json);
const HOLD_CODES = ['UI_SINCE_PARKED', 'UI_SINCE_RETURNED', 'UI_SINCE_SUBSUMED'];
const A = sbF04Peers().a.peer;

/** The hold_id of an ops.jsonl line (test-side parse), else null. */
function holdIdOf(line: string | undefined): string | null {
  if (line === undefined) return null;
  const v: unknown = JSON.parse(line);
  const id = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['hold_id'] : undefined;
  return typeof id === 'string' ? id : null;
}

/** SB-F04 with the hold chains (and any other variant flags), folded in memory, reported for from 10 to 30, you = A. */
function holdsReport(from = 10): SinceReport {
  const sim = sbSteps(SB_SEED, sbF04({ holds: true }));
  return batchReport(sim.start, sim.steps, { from, you: A });
}

test('a hold op in the range that moves this peer\'s record to PARKED gives one UI_SINCE_PARKED row in section 2, with no cause, whether S6 or a human parked it', () => {
  const sim = sbSteps(SB_SEED, sbF04({ holds: true }));
  // The board really holds both parks as effective ops: r1 ACTIVE → PARKED at 21 (S6's form), r2 CONFLICTED → PARKED at
  // 24 (a human's --park of a conflicted record; a local_only stub).
  const before = (h: number, hid: string): string | undefined => sim.steps[h - 1]!.after.holds[hid]?.state;
  const after = (h: number, hid: string): string | undefined => sim.steps[h]!.after.holds[hid]?.state;
  assert.deepEqual([before(21, SB_HOLDS.r1), after(21, SB_HOLDS.r1)], ['ACTIVE', 'PARKED']);
  assert.deepEqual([before(24, SB_HOLDS.r2), after(24, SB_HOLDS.r2)], ['CONFLICTED', 'PARKED']);
  assert.equal(sim.steps[24]!.after.holds[SB_HOLDS.r2]!.local_only, true);
  assert.ok(sim.steps[21]!.verdicts.every((v) => v.type === 'hold' && v.verdict === 'effective'));

  const r = batchReport(sim.start, sim.steps, { from: 10, you: A });
  const parked = r.you.records.filter((x) => x.code === 'UI_SINCE_PARKED');
  // One row per parking op in the range: r5's park at 9 is at or below from, and r5's op at 27 keeps it PARKED.
  assert.deepEqual(parked.map((x) => [x.params['h'], x.params['hid']]), [[21, SB_HOLDS.r1], [24, SB_HOLDS.r2]]);
  // No cause: both rows carry the same keys, none of which says who parked or why (the op carries no cause).
  for (const x of parked) {
    assert.deepEqual(Object.keys(x.params).sort(), ['h', 'hid', 'n', 'path']);
    assert.equal(x.csIds, undefined);
  }
  assert.deepEqual(parked, sbHoldRows().filter((x) => x.code === 'UI_SINCE_PARKED'));
  // Section 2 holds them (you.records); no other section gains a row from a hold op.
  const plain = sbSteps(SB_SEED, sbF04({}));
  const without = batchReport(plain.start, plain.steps, { from: 10, you: A });
  assert.deepEqual({ ...r, you: { ...r.you, records: [] } }, without);
  assert.deepEqual(r, sbF04Golden({ holds: true }));
});

test('offer=returned gives UI_SINCE_RETURNED and SUBSUMED gives UI_SINCE_SUBSUMED; a teammate\'s record and a transition outside the range give no row', () => {
  const r = holdsReport();
  assert.deepEqual(r.you.records, sbHoldRows());
  assert.deepEqual(r.you.records.map((x) => [x.code, x.params['h'], x.params['hid']]), [
    ['UI_SINCE_PARKED', 21, SB_HOLDS.r1],
    ['UI_SINCE_RETURNED', 21, SB_HOLDS.r3],
    ['UI_SINCE_PARKED', 24, SB_HOLDS.r2],
    ['UI_SINCE_SUBSUMED', 24, SB_HOLDS.r4],
  ]);
  // B's record rB was parked at 19 and SUBSUMED at 28, and B's op at 19 set offer=returned on A's r3 (not B's record:
  // folded 'type', so A's r3 turns returned only at 21): no row for any of them.
  assert.ok(r.you.records.every((x) => x.params['hid'] !== SB_HOLDS.rB));
  assert.ok(!r.you.records.some((x) => x.params['h'] === 19 || x.params['h'] === 28));
  // A transition at or below from is outside the range: from 21 drops the rows at 21 and keeps those at 24; from −1 adds
  // r5's park at 9.
  assert.deepEqual(holdsReport(21).you.records, sbHoldRows().filter((x) => x.params['h'] === 24));
  const whole = holdsReport(-1).you.records;
  assert.deepEqual(whole.map((x) => [x.code, x.params['h'], x.params['hid']]).slice(0, 1), [['UI_SINCE_PARKED', 9, SB_HOLDS.r5]]);
  assert.deepEqual(whole.slice(1), sbHoldRows());
  // Extra commits at 29 and 30 (from 28):
  // - at 29: hid created directly PARKED with offer=returned, and hid2 created directly SUBSUMED (moved there from no
  //   record: their rows); r3, already returned, moved to PARKED (the state moved, the offer did not); r4 SUBSUMED → GONE
  //   (no row); hid3 created ACTIVE (no row);
  // - at 30: r4 GONE → SUBSUMED (terminal → terminal back to SUBSUMED: a row); hid2 SUBSUMED → SUBSUMED (it stays: no row);
  //   and two chained ops on hid3 in the one commit, ACTIVE → PARKED at rev 2, then PARKED with offer=returned at rev 3:
  //   the record is judged once for the commit, so exactly one PARKED and one RETURNED row.
  const actions: SbAction[] = sbF04({ holds: true });
  const hid = '01JB00000000000000000000C1';
  const hid2 = '01JB00000000000000000000C2';
  const hid3 = '01JB00000000000000000000C3';
  actions[29] = { kind: 'commit', c: { writer: 'a', ops: [
    holdDraft({ hid, rev: 1, prev: null, state: 'PARKED', offer: 'returned', paths: ['src/new.ts', 'src/a.ts'] }),
    holdDraft({ hid: SB_HOLDS.r3, rev: 3, prev: 2, state: 'PARKED', offer: 'returned', paths: ['src/engine/fold.ts'] }),
    holdDraft({ hid: SB_HOLDS.r4, rev: 3, prev: 2, state: 'GONE', paths: ['README.md'] }),
    holdDraft({ hid: hid2, rev: 1, prev: null, state: 'SUBSUMED', paths: ['lib/two.ts'] }),
    holdDraft({ hid: hid3, rev: 1, prev: null, state: 'ACTIVE', paths: ['lib/three.ts'] }),
  ] } };
  actions[30] = { kind: 'commit', c: { writer: 'a', ops: [
    holdDraft({ hid: SB_HOLDS.r4, rev: 4, prev: 3, state: 'SUBSUMED', paths: ['README.md'] }),
    holdDraft({ hid: hid2, rev: 2, prev: 1, state: 'SUBSUMED', paths: ['lib/two.ts'] }),
    holdDraft({ hid: hid3, rev: 2, prev: 1, state: 'PARKED', paths: ['lib/three.ts'] }),
    holdDraft({ hid: hid3, rev: 3, prev: 2, state: 'PARKED', offer: 'returned', paths: ['lib/three.ts'] }),
  ] } };
  const sim = sbSteps(SB_SEED, actions);
  // The fold applied every op of 29 and 30 (a rejected op would give "no row" for free).
  for (const h of [29, 30]) {
    assert.deepEqual(sim.steps[h]!.verdicts.map((v) => `${v.type} ${v.verdict}`), sim.steps[h]!.verdicts.map(() => 'hold effective'), `height ${h}`);
  }
  assert.equal(sim.steps[29]!.verdicts.length, 5);
  assert.equal(sim.steps[30]!.verdicts.length, 4);
  const at = (h: number, id: string): [number, string, string] | undefined => {
    const x = sim.steps[h]!.after.holds[id];
    return x === undefined ? undefined : [x.rev, x.state, x.offer];
  };
  assert.deepEqual([at(29, hid2), at(30, hid2)], [[1, 'SUBSUMED', 'none'], [2, 'SUBSUMED', 'none']]);
  assert.deepEqual([at(29, hid3), at(30, hid3)], [[1, 'ACTIVE', 'none'], [3, 'PARKED', 'returned']]);
  assert.deepEqual([at(29, SB_HOLDS.r4), at(30, SB_HOLDS.r4)], [[3, 'GONE', 'none'], [4, 'SUBSUMED', 'none']]);
  const late = batchReport(sim.start, sim.steps, { from: 28, you: A }).you.records;
  assert.deepEqual(late, [
    { code: 'UI_SINCE_PARKED', params: { h: 29, hid, path: 'src/a.ts', n: 2 } },
    { code: 'UI_SINCE_RETURNED', params: { h: 29, hid, path: 'src/a.ts', n: 2 } },
    // r3: already returned, now PARKED: the state moved, the offer did not.
    { code: 'UI_SINCE_PARKED', params: { h: 29, hid: SB_HOLDS.r3, path: 'src/engine/fold.ts', n: 1 } },
    { code: 'UI_SINCE_SUBSUMED', params: { h: 29, hid: hid2, path: 'lib/two.ts', n: 1 } },
    // r4: SUBSUMED at 24, GONE at 29 (no row), SUBSUMED again at 30 (terminal → terminal: it moved to SUBSUMED).
    { code: 'UI_SINCE_SUBSUMED', params: { h: 30, hid: SB_HOLDS.r4, path: 'README.md', n: 1 } },
    // hid2 SUBSUMED → SUBSUMED at 30: no row. hid3: two ops in one commit, one row per move.
    { code: 'UI_SINCE_PARKED', params: { h: 30, hid: hid3, path: 'lib/three.ts', n: 1 } },
    { code: 'UI_SINCE_RETURNED', params: { h: 30, hid: hid3, path: 'lib/three.ts', n: 1 } },
  ]);
});

/** The random hold board of the split test: 1,500 heights of sbRandom with hold chains, folded in memory. */
const SEED = 'f04-holds';
const HEIGHT = 1_500;
const rnd = sbSteps(SEED, sbRandom(SEED, HEIGHT, { holds: true }));
const rndYou = sbPeerIds(SEED, ['b', 'c', 'a', 'd']).get('a')!.peer;
const CONFIGS: ReadonlyArray<{ from: number; capFrom: number | null }> = [
  { from: 600, capFrom: null },
  { from: -1, capFrom: null },
  { from: 50, capFrom: 900 },
  { from: 1_480, capFrom: null },
];
const rndBatch = CONFIGS.map((c) => canon(batchReport(rnd.start, rnd.steps, { from: c.from, you: rndYou, capFrom: c.capFrom })));

test('the accumulator fed in any split equals the batch report, canonical JSON byte-equal, with the hold rows present', () => {
  // The rows are there: every kind, only this peer's records (owner at the row's height), each at an effective hold op
  // that names the row's record.
  const whole = JSON.parse(rndBatch[1]!) as SinceReport;
  for (const code of HOLD_CODES) assert.ok(whole.you.records.filter((x) => x.code === code).length >= 5, code);
  for (const x of whole.you.records) {
    const s = rnd.steps[x.params['h'] as number]!;
    const hid = x.params['hid'] as string;
    assert.equal(s.after.holds[hid]!.owner, rndYou);
    assert.ok(s.verdicts.some((v) => v.type === 'hold' && v.verdict === 'effective' && holdIdOf(s.data.opsLines[v.line]) === hid), `${hid} at ${x.params['h']}`);
  }
  // And they are exactly the moves an independent before/after comparison finds: every record of this peer whose state
  // became PARKED or SUBSUMED, or whose offer became returned, between the fold states at h − 1 and h (from −1: every h).
  const key = (h: number, hid: string, code: string): string => `${String(h).padStart(5, '0')} ${hid} ${code}`;
  const moves: string[] = [];
  rnd.steps.forEach((s, h) => {
    const before = (h === 0 ? rnd.start : rnd.steps[h - 1]!.after).holds;
    for (const [hid, now] of Object.entries(s.after.holds)) {
      if (now.owner !== rndYou) continue;
      const was = Object.prototype.hasOwnProperty.call(before, hid) ? before[hid] : undefined;
      if (now.state === 'PARKED' && was?.state !== 'PARKED') moves.push(key(h, hid, 'UI_SINCE_PARKED'));
      if (now.state === 'SUBSUMED' && was?.state !== 'SUBSUMED') moves.push(key(h, hid, 'UI_SINCE_SUBSUMED'));
      if (now.offer === 'returned' && was?.offer !== 'returned') moves.push(key(h, hid, 'UI_SINCE_RETURNED'));
    }
  });
  const rows = whole.you.records.map((x) => key(x.params['h'] as number, x.params['hid'] as string, x.code));
  assert.deepEqual([...rows].sort(), moves.sort());
  assert.deepEqual(rows.map((k) => k.slice(0, 5)), rows.map((k) => k.slice(0, 5)).sort(), 'rows in board order');
  // Teammates' records moved too (rows of theirs would show here), and some hold ops folded as no-ops.
  const others = rnd.steps.filter((s, h) => h > 0 && Object.entries(s.after.holds).some(([id, x]) => x.owner !== rndYou && x.state === 'PARKED' && rnd.steps[h - 1]!.after.holds[id]?.state !== 'PARKED'));
  assert.ok(others.length >= 5, `${others.length} teammate parks`);
  assert.ok(rnd.steps.some((s) => s.verdicts.some((v) => v.type === 'hold' && v.verdict === 'rejected')));
  const capped = JSON.parse(rndBatch[2]!) as SinceReport;
  assert.ok(capped.you.records.length > 0 && capped.you.records.every((x) => (x.params['h'] as number) > 900));

  // SB-F04 with the holds: every single cut of the 31 steps.
  const sb = sbSteps(SB_SEED, sbF04({ holds: true }));
  const sbBatch = canon(batchReport(sb.start, sb.steps, { from: 10, you: A }));
  for (let k = 1; k < sb.steps.length; k++) {
    let acc: SinceAcc = sinceInit(sb.start, 10, A, []);
    for (let i = 0; i < k; i++) acc = sincePush(acc, sb.steps[i]!);
    assert.equal(canon(sinceFinish(acc, null)), canon(batchReport(sb.start, sb.steps.slice(0, k), { from: 10, you: A })));
    for (let i = k; i < sb.steps.length; i++) acc = sincePush(acc, sb.steps[i]!);
    assert.equal(canon(sinceFinish(acc, null)), sbBatch, `cut at ${k}`);
  }

  // The random board: fast-check splits, each finished mid-stream once (the accumulator goes on unchanged).
  const split = fc.record({
    config: fc.integer({ min: 0, max: CONFIGS.length - 1 }),
    cuts: fc.uniqueArray(fc.integer({ min: 1, max: rnd.steps.length - 1 }), { maxLength: 8 }),
  });
  fc.assert(fc.property(split, ({ config, cuts }) => {
    const { from, capFrom } = CONFIGS[config]!;
    const points = [...cuts].sort((x, y) => x - y);
    let acc: SinceAcc = sinceInit(rnd.start, from, rndYou, []);
    let done = 0;
    for (const k of [...points, rnd.steps.length]) {
      for (let i = done; i < k; i++) acc = sincePush(acc, rnd.steps[i]!);
      if (done === 0 && k < rnd.steps.length) {
        assert.equal(canon(sinceFinish(acc, capFrom)), canon(batchReport(rnd.start, rnd.steps.slice(0, k), { from, you: rndYou, capFrom })));
      }
      done = k;
    }
    assert.equal(canon(sinceFinish(acc, capFrom)), rndBatch[config]);
  }), { numRuns: 300, seed: 0x5f19 });
});

/** The suffixes readBoardCommits names after a board oid on --batch-check stdin (no live commit: withLive is off). */
const BOARD_NAME = /^[0-9a-f]{40}(?:\^\{tree\}|:ops\.jsonl|:protocol\.json|:held|:checkpoint|:checkpoint\/state\.json)?$/;

/** Every 40-hex object id a call names in its argv or stdin. */
function oidsOf(c: Call): string[] {
  return [...c.args, ...c.stdin.split('\n')].flatMap((x) => x.match(/[0-9a-f]{40}/g) ?? []);
}

test('the hold rows read board commits only: no live-code tree or blob is read, and the held/ tree is read for entry names only', async () => {
  const fx = await makeRepoFixture('since-holds-reads');
  try {
    const sim = sbSteps(SB_SEED, sbF04({ holds: true }));
    // BoardWriter writes no held/ tree, so the twin's commits go through importBoard (held/<id>/h1/held.txt per record).
    await assert.rejects(sbWrite(fx, SB_SEED, sbF04({ holds: true })), /held\//);
    const { L0, oids } = await sbImport(fx, sim);
    assert.equal(oids.length, 31);
    const tip = oids[30]!;
    const rev = async (spec: string): Promise<Oid> => parseOid((await fx.repo.run(['rev-parse', '--verify', spec])).stdout.toString('utf8'));
    // What must never be read: the held/<id>/ subtrees and their blobs, and the live code commit's tree and blobs.
    const heldIds = sim.steps[30]!.data.heldIds;
    assert.deepEqual([...heldIds], [SB_HOLDS.r1, SB_HOLDS.r3, SB_HOLDS.r4, SB_HOLDS.r5, SB_HOLDS.rB].sort());
    const forbidden = new Set<string>([await rev(`${L0}^{tree}`), await rev(`${L0}:README.md`)]);
    for (const id of heldIds) {
      forbidden.add(await rev(`${tip}:held/${id}`));
      forbidden.add(await rev(`${tip}:held/${id}/h1/held.txt`));
    }
    const heldTree = await rev(`${tip}:held`);

    const { repo, calls } = spyRepo(fx);
    const got = await walkSince(repo, 'main', { from: 10, to: 30, you: A, mine: [] });
    // The rows are there, as in the twin: the held/ tree was read (else every mirrored op folds 'held_subtree').
    assert.deepEqual(got.report.you.records, sbHoldRows());
    assert.deepEqual(got.report.you.records, batchReport(sim.start, sim.steps, { from: 10, you: A }).you.records);

    const chain = new Set(oids.map(String));
    // The objects the --batch-check calls resolved from board names (their `<oid> <type> <size>` output lines).
    const resolved = new Set<string>();
    let heldTreeRead = false;
    let batchLines = 0;
    for (const c of calls) {
      const kind = `${c.args[0]} ${c.args[1]}`;
      assert.ok(['for-each-ref --format=%(objectname) %(refname)', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch'].includes(kind), kind);
      for (const oid of oidsOf(c)) {
        assert.ok(!forbidden.has(oid), `${kind} names ${oid}, a held/ entry or the live code`);
        assert.notEqual(oid, String(L0), `${kind} names the live code commit`);
      }
      if (kind === 'cat-file --batch-check') {
        for (const name of c.stdin.split('\n').filter((l) => l.length > 0)) {
          assert.match(name, BOARD_NAME);
          assert.ok(chain.has(name.slice(0, 40)), `${name} names a board commit`);
        }
        for (const out of c.stdout.toString('utf8').split('\n')) {
          const m = /^([0-9a-f]{40}) [a-z]+ \d+$/.exec(out);
          if (m !== null) resolved.add(m[1]!);
        }
      }
      if (kind === 'cat-file --batch') {
        // Objects by id only, never a <rev>:<path> name (so no held/<id>/... entry read by path), and only objects a
        // board name resolved to: a commit, its tree, ops.jsonl, protocol.json, held/ itself or the checkpoint.
        for (const line of c.stdin.split('\n').filter((l) => l.length > 0)) {
          assert.match(line, /^[0-9a-f]{40}$/, `cat-file --batch reads ${line}`);
          assert.ok(resolved.has(line), `cat-file --batch reads ${line}, which no board name resolved to`);
          batchLines++;
        }
        if (c.stdin.split('\n').includes(heldTree)) heldTreeRead = true;
      }
    }
    assert.ok(batchLines > 0);
    assert.ok(heldTreeRead, 'the held/ tree object itself is read (its entry names)');
  } finally {
    await fx.cleanup();
  }
});

// Row shape guard for the catalogs (Plan 7 renders these codes): each hold row is {code, params {h, hid, path, n}}.
test('every hold row of the random board has the params h, hid, path (its first path) and n (its path count) and no csIds', () => {
  const whole = JSON.parse(rndBatch[1]!) as SinceReport;
  const shape = (x: SinceRow): void => {
    assert.ok(HOLD_CODES.includes(x.code));
    assert.deepEqual(Object.keys(x).sort(), ['code', 'params']);
    assert.deepEqual(Object.keys(x.params).sort(), ['h', 'hid', 'n', 'path']);
    const rec = rnd.steps[x.params['h'] as number]!.after.holds[x.params['hid'] as string]!;
    assert.equal(x.params['path'], rec.paths[0] ?? null);
    assert.equal(x.params['n'], rec.paths.length);
  };
  assert.ok(whole.you.records.length >= 15, `${whole.you.records.length} rows`);
  whole.you.records.forEach(shape);
});
