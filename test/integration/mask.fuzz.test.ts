// 05 P1 / TC-HLD-01 `exp_j_fuzz` (Plan 3 Task 14; 05-holds §7 P1, §3.4 items 1–2, HLD-13, HLD-15, HLD-42; 11-testing TC-HLD-01, X-05; rulings
// R3-50 (M19), R3-55). P1 is a test of the engine function, not an oracle: maskEntries and ChangeSets.composeP run on one real clone
// (makeRepoFixture: a temp root with a space and Hangul; git is never mocked). Each trial: a 40-row LF file A_old; a team edit set E_t
// (A_new = A_old + E_t) and a local edit set E_l on rows ≥ 2 unchanged rows apart; a non-empty held subset H ⊆ E_l recorded as one
// ON_DISK revert-style PATCH (H0 = A_old, H1 = A_old + H); and in 1 trial of 5 a team edit identical to one held edit. Then
// maskEntries(S_disk = A_new + E_l) == A_new + (E_l − H), and composeP of one ready pair (R = S_disk, A_cap = A_new) gives the same P.
// Under M19 (step 5 from the unrebased pair) the property fails and shrinks to a counterexample with an identical team edit: the
// unrebased reverse merge takes the team's identical row back to A_old. `npm test` runs the first 100 trials, `npm run test:sim`
// (TEST_SIM_FULL=1) all 1,000 (R3-55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { ChangeSets, HUMAN_CS_QUIET_MS } from '../../src/holds/changesets.js';
import { maskEntries, type MaskOptions } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import type { TreeMap } from '../../src/git/repo.js';
import { inputs, pair, record, tmap, ulidOf, PEER } from '../helpers/maskFixture.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: the full 1,000 trials only under `npm run test:sim`. */
const FULL = process.env['TEST_SIM_FULL'] === '1';
const RUNS = FULL ? 1_000 : 100;
const SEED = 0x5031;
const PATH = 'p1/forty.txt';
const ROWS = 40;
/**
 * Plan 3 Task 16 (the Task 14 carry): the 100-trial form ran 592 s of a 600 s cap under `npm test`'s load, so it gets its own SIM
 * timeout (30 min, holdsScript's SIM_TIMEOUT) instead of the 10-minute default; the 1,000-trial form keeps 120 min.
 */
const TFULL = { timeout: (FULL ? 120 : 30) * 60_000 };

interface Trial {
  rows: number[];                 // every edited row, ascending, pairwise ≥ 3 apart (≥ 2 unchanged rows between)
  team: boolean[];                // row k is a team edit (else a local one)
  held: boolean[];                // a local row k is held (one forced)
  identical: boolean;             // 1 trial in 5: the team also makes the first held edit, identically
  tag: number;
}

/** Spaced rows: a start in 1..4 and gaps of 3..7, kept ≤ 40. */
const spaced = fc.tuple(fc.integer({ min: 1, max: 4 }), fc.array(fc.integer({ min: 3, max: 7 }), { minLength: 1, maxLength: 9 }))
  .map(([start, gaps]) => gaps.reduce<number[]>((acc, g) => [...acc, acc[acc.length - 1]! + g], [start]).filter((r) => r <= ROWS))
  .filter((rows) => rows.length >= 2);

const trial: fc.Arbitrary<Trial> = spaced.chain((rows) => fc.record({
  rows: fc.constant(rows),
  team: fc.array(fc.boolean(), { minLength: rows.length, maxLength: rows.length }),
  drawn: fc.array(fc.boolean(), { minLength: rows.length, maxLength: rows.length }),
  mustLocal: fc.integer({ min: 0, max: rows.length - 1 }),
  fifth: fc.integer({ min: 0, max: 4 }),
  tag: fc.integer({ min: 0, max: 9_999 }),
}).map(({ rows: rs, team, drawn, mustLocal, fifth, tag }): Trial => {
  // At least one local held edit: row `mustLocal` is local and held whatever was drawn for it.
  const t = team.map((x, k) => x && k !== mustLocal);
  const held = drawn.map((h, k) => !t[k] && (h || k === mustLocal));
  return { rows: rs, team: t, held, identical: fifth === 0, tag };
}));

const text = (edits: ReadonlyMap<number, string>): string =>
  Array.from({ length: ROWS }, (_, k) => `${edits.get(k + 1) ?? `row ${k + 1}`}\n`).join('');

/** The trial's edit sets: E_t (with the identical held edit when drawn), E_l and H. */
function sets(t: Trial): { Et: Map<number, string>; El: Map<number, string>; H: Map<number, string> } {
  const Et = new Map<number, string>();
  const El = new Map<number, string>();
  const H = new Map<number, string>();
  t.rows.forEach((r, k) => {
    if (t.team[k]) Et.set(r, `team edit ${r} t${t.tag}`);
    else {
      El.set(r, `local edit ${r} t${t.tag}`);
      if (t.held[k]) H.set(r, `local edit ${r} t${t.tag}`);
    }
  });
  if (t.identical) {
    const [h, s] = [...H][0]!;
    Et.set(h, s);   // the team made the held edit too, byte for byte
  }
  return { Et, El, H };
}
const merged = (...ms: ReadonlyArray<ReadonlyMap<number, string>>): Map<number, string> => new Map(ms.flatMap((m) => [...m]));

/** One trial against the engine's MASK and composeP; returns null when both give A_new + (E_l − H), else what differed. */
async function runTrial(f: RepoFixture, scratch: string, t: Trial, o: MaskOptions): Promise<string | null> {
  const { repo } = f;
  const { Et, El, H } = sets(t);
  const blob = (s: string) => repo.hashBytes(Buffer.from(s, 'utf8'), true);
  const aOld = await blob(text(new Map()));
  const aNew = await blob(text(Et));
  const sDisk = await blob(text(merged(Et, El)));
  const want = await blob(text(merged(Et, new Map([...El].filter(([r]) => !H.has(r))))));
  const r = record(pair(aOld, await blob(text(H)), PATH), { id: ulidOf(1), paths: [PATH], guards: ['revert'] });
  const A = tmap({ [PATH]: aNew });
  const X = tmap({ [PATH]: sDisk });
  const mask = (Y: TreeMap) => maskEntries(repo, Y, inputs(A, [r]), new RebaseCache(repo, () => true), o);
  const m = await mask(X);
  const got = m.entries.get(PATH)?.oid;
  if (got !== want) return `maskEntries(S_disk) = ${got}, want A_new + (E_l − H) = ${want}`;
  // composeP of one ready pair (R = S_disk, A_cap = A_new): a closed human CS captured from S_disk over A_new.
  const clock = new VirtualClock();
  const cs = new ChangeSets(PEER, clock);
  cs.observe([PATH]);
  clock.advance(HUMAN_CS_QUIET_MS);
  const cap = await cs.capture(repo, X, A, join(scratch, 'fuzz.index'), new Set(), []);
  if (cap === null || cap.pairs.length !== 1) return `capture gave ${JSON.stringify(cap?.pairs ?? null)}`;
  const comp = await cs.composeP(repo, A, mask, []);
  const p = comp.P.get(PATH)?.oid;
  return p === want ? null : `composeP's P = ${p}, want ${want}`;
}

async function withFixture(label: string, fn: (f: RepoFixture, scratch: string) => Promise<void>): Promise<void> {
  const f = await makeRepoFixture(label, { files: { 'README.md': Buffer.from('fuzz\n', 'utf8') } });
  try {
    const scratch = join(f.paths.coworkDir, 'tmp');
    await mkdir(scratch, { recursive: true });
    await fn(f, scratch);
  } finally {
    await f.cleanup();
  }
}

test(`05 P1 / TC-HLD-01 exp_j_fuzz: 1,000 fast-check trials (seed 0x5031, numRuns 1,000, shrinking on) on one real repo — a 40-row LF file, a team edit set E_t and a local edit set E_l on rows ≥ 2 apart, a held subset H ⊆ E_l recorded as one ON_DISK revert-style PATCH (H0 = A_old, H1 = A_old + H), and in 1 trial of 5 a team edit identical to one held edit — give maskEntries(S_disk = A_new + E_l) == A_new + (E_l − H) and composeP of one ready pair (R = S_disk, A_cap = A_new) the same P; with M19 on the property fails and shrinks to a counterexample containing an identical team edit`, TFULL, async (tc) => {
  tc.diagnostic(`${RUNS} trials (${FULL ? 'TEST_SIM_FULL=1: all' : 'npm test: the first 100'}, R3-55)`);
  await withFixture('mask-fuzz', async (f, scratch) => {
    let identical = 0;
    await fc.assert(fc.asyncProperty(trial, async (t) => {
      if (t.identical) identical++;
      const why = await runTrial(f, scratch, t, {});
      assert.equal(why, null, `trial ${JSON.stringify(t)}: ${why}`);
    }), { seed: SEED, numRuns: RUNS, endOnFailure: true });
    assert.ok(identical >= RUNS / 10, `about 1 trial in 5 has an identical team edit (${identical} of ${RUNS})`);
    // M19 (step 5 from the unrebased pair, R3-50): the same property, same seed, fails and shrinks to an identical team edit.
    const out = await fc.check(fc.asyncProperty(trial, async (t) => (await runTrial(f, scratch, t, { m19: true })) === null), { seed: SEED, numRuns: RUNS });
    assert.ok(out.failed, 'M19 fails 05 P1');
    const [cx] = out.counterexample!;
    assert.equal(cx.identical, true, `the shrunk counterexample has an identical team edit: ${JSON.stringify(cx)}`);
  });
});
