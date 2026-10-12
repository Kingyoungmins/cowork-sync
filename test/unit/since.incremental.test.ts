// T-F04-incremental (10-product §7; FEAT-F04-07; F04-a Task A2): the accumulator fed in any split equals the batch report,
// canonical JSON byte-equal. A 3,000-height SIM board (test/helpers/sbF04.ts sbRandom, folded in memory) is reduced in 2,000
// fast-check splits; at the first cut the accumulator is also finished (it must equal the batch over that prefix) and then
// pushed further, so a finish never disturbs the running accumulator (the daemon's recap reads it mid-stream).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { sinceFinish, sinceInit, sincePush, type MyRecord, type SinceAcc, type SinceReport, type SinceStep } from '../../src/since/report.js';
import { batchReport, sbPeerIds, sbRandom, sbSteps } from '../helpers/sbF04.js';

const SEED = 'f04-incremental';
const HEIGHT = 3_000;
const canon = (r: SinceReport): string => canonicalJson(r as unknown as Json);

const sim = sbSteps(SEED, sbRandom(SEED, HEIGHT));
const steps: readonly SinceStep[] = sim.steps;
const you = sbPeerIds(SEED, ['b', 'c', 'a', 'd']).get('a')!.peer;
const mine: readonly MyRecord[] = [
  { id: '01HZ00000000000000000000A1', paths: ['src/ui/app.ts', 'lib/one.ts'], state: 'ACTIVE', offer: 'none' },
  { id: '01HZ00000000000000000000A2', paths: ['docs/guide.md'], state: 'GONE', offer: 'none' },
];
/** Range shapes: a middle anchor, the whole board, a capped range (cap at finish) and an anchor near the tip. */
const CONFIGS: ReadonlyArray<{ from: number; capFrom: number | null }> = [
  { from: 1_200, capFrom: null },
  { from: -1, capFrom: null },
  { from: 100, capFrom: 1_700 },
  { from: 2_990, capFrom: null },
];
const batch = CONFIGS.map((c) => canon(batchReport(sim.start, steps, { from: c.from, you, mine, capFrom: c.capFrom })));

test('the 3,000-height SIM board has every kind of fact the F04-a report reads', () => {
  assert.equal(steps.length, HEIGHT + 1);
  const r = JSON.parse(batch[1]!) as SinceReport;
  const events = new Set(r.events.map((e) => e.code));
  for (const code of ['UI_SINCE_EV_JOIN', 'UI_SINCE_EV_REJOIN', 'UI_SINCE_EV_LEAVE', 'UI_SINCE_EV_FREEZE', 'UI_SINCE_EV_UNFREEZE', 'UI_SINCE_EV_INCIDENT']) {
    assert.ok(events.has(code), code);
  }
  assert.equal(r.saves.length, 10);
  assert.ok(r.team.length >= 3, 'three teammates published');
  assert.ok(r.you.touches.length > 0, 'touches of my paths');
  // Change-sets over 256 paths (no Cowork-CS-Paths) and board-only trailer repeats (live code unchanged) are on the board.
  const unlisted = steps.filter((s, h) => h > 0 && s.data.liveCode !== steps[h - 1]!.data.liveCode && s.data.cs.some((t) => !s.data.csPaths.has(t.csId)));
  const boardOnly = steps.filter((s, h) => h > 0 && s.data.liveCode === steps[h - 1]!.data.liveCode && s.data.cs.length > 0);
  assert.ok(unlisted.length >= 10 && boardOnly.length >= 10, `${unlisted.length} unlisted, ${boardOnly.length} board-only`);
  const big = unlisted.find((s) => s.data.writer!.peer !== you)!.data;
  const around = batchReport(sim.start, steps.slice(0, big.height + 1), { from: big.height - 1, you });
  assert.deepEqual(around.team.map((t) => t.areas.find((a) => a.params['area'] === '…')?.params['paths']), [big.cs.find((t) => !big.csPaths.has(t.csId))!.paths]);
  const capped = JSON.parse(batch[2]!) as SinceReport;
  assert.equal(capped.truncatedFrom, 1_700);
  assert.ok(capped.events.every((e) => (e.params['h'] as number) > 1_700));
});

test('T-F04-incremental: 2,000 random splits of a 3,000-height SIM board — the accumulator equals the batch report, canonical JSON byte-equal', () => {
  const split = fc.record({
    config: fc.integer({ min: 0, max: CONFIGS.length - 1 }),
    cuts: fc.uniqueArray(fc.integer({ min: 1, max: steps.length - 1 }), { maxLength: 8 }),
  });
  fc.assert(fc.property(split, ({ config, cuts }) => {
    const { from, capFrom } = CONFIGS[config]!;
    const points = [...cuts].sort((x, y) => x - y);
    let acc: SinceAcc = sinceInit(sim.start, from, you, mine);
    let done = 0;
    for (const k of [...points, steps.length]) {
      for (let i = done; i < k; i++) acc = sincePush(acc, steps[i]!);
      if (done === 0 && k < steps.length) {
        // Finished mid-stream: the report of the prefix, and the accumulator goes on unchanged.
        assert.equal(canon(sinceFinish(acc, capFrom)), canon(batchReport(sim.start, steps.slice(0, k), { from, you, mine, capFrom })));
      }
      done = k;
    }
    assert.equal(canon(sinceFinish(acc, capFrom)), batch[config]);
  }), { numRuns: 2_000, seed: 0x5f04 });
});
