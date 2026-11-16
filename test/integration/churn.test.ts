// The churn guard on EngineCores over real clones (Plan 3 Task 7; 03-data §3.8, DAT-39, F-DAT-04, I-DAT-20 record half; glossary
// §20 data numbers, §26.1 W6; rulings R3-35, D-20): churnStep observes every changed LIVE `modify` path at every detection tick
// (next bytes = the tick's stage copy, prev = the previous observation or, first, the private-index blob), and a path rewritten
// wholesale at three consecutive ticks with no hook attribution becomes one ON_DISK PATCH `generated?` (GENERATED_SUSPECT) whose
// content is the stage copy by route (b) -w — the only object the guard writes. Git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { applyStep } from '../../src/engine/apply.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { pathIsFiltered, pathIsText, type IterationCtx } from '../../src/engine/core.js';
import { CHURN_DIFF_MAX_BYTES } from '../../src/data/churn.js';
import { churnStep } from '../../src/engine/dataRecords.js';
import { recordStep } from '../../src/engine/holdSteps.js';
import { publishStep } from '../../src/engine/publish.js';
import { maskReason, type MaskInputs } from '../../src/holds/mask.js';
import { guardName, isTerminal, makeGuard, type HoldRecord } from '../../src/holds/record.js';
import { seededRandom } from '../../src/ports/random.js';
import { gitCallsOf, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { hashTestSide, remoteLive } from '../helpers/dataRecordsFixture.js';
import { prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { buf, captureReady, prep } from '../helpers/publishHelpers.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const GEN = 'gen/api.ts';
const USE = 'src/use.ts';
const BIG = 'big.py';
const H100 = 'gen/h100.ts';
const IMG = 'img.bin';

/** n rows `export const v<i> = <i>;`, the first `count` of them replaced by fresh round-`round` text (round 0: none). */
function gen(n: number, round = 0, count = 0): Buffer {
  return buf(Array.from({ length: n }, (_, k) => (k < count && round > 0 ? `export const v${k + 1} = ${round * 1_000 + k + 1}; // gen ${round}\n` : `export const v${k + 1} = ${k + 1};\n`)).join(''));
}
const BIG_BYTES = generateBigBomCrlf(26_436, seededRandom('t7-churn'));
/** The fixture with row `row` (0-based) replaced by `# autosave <round>`; BOM and CRLF kept. */
function typed(round: number, row = 1_000): Buffer {
  const rows = BIG_BYTES.toString('latin1').split('\r\n');
  rows[row] = `# autosave ${round}`;
  return Buffer.from(rows.join('\r\n'), 'latin1');
}
/**
 * 100 LF rows `row <i>`, row 50 ending in the digit of round `round`; with `nul`, row 1 holds a NUL (a binary file, DAT-04).
 * A round changes one byte of one row: 1 % of the rows, far below the 20 % ratio, so only the binary rule can qualify it.
 */
function hundredRows(round: number, nul: boolean): Buffer {
  return buf(Array.from({ length: 100 }, (_, k) => (k === 0 && nul ? 'row 1 \0\n' : k === 49 ? `row 50 ${round % 10}\n` : `row ${k + 1}\n`)).join(''));
}
const img = (round: number): Buffer => hundredRows(round, true);
const TXT = 'rows.txt';
const GEN3 = 'gen/c.ts';
const FILES: Record<string, Buffer> = {
  'README.md': buf('# churn fixture\n'),
  [GEN]: gen(50),
  [USE]: buf(Array.from({ length: 10 }, (_, k) => `use ${k + 1}\n`).join('')),
  [BIG]: BIG_BYTES,
  [H100]: gen(100),
  [IMG]: img(0),
  [TXT]: hundredRows(0, false),
  [GEN3]: gen(50),
};

/** A qualifying rewrite of gen/api.ts (30 of its 50 rows replaced by fresh text) for round `round` ≥ 1. */
const rewrite = (p: PeerFixture, round: number): Promise<void> => writeWork(p, GEN, gen(50, round, 30));

/** advance(2_500), then a tick-only iteration (no materialization) and churnStep. */
async function tick(fx: CoreFixture, p: PeerFixture, ms = 2_500): Promise<{ it: IterationCtx; r: { created: string[]; released: string[] } }> {
  fx.advance(ms);
  const it = await prepIt(p, { materialize: false });
  return { it, r: await churnStep(p.core, it) };
}

/** The non-terminal records carrying `generated?` (any argument) over `path`. */
function generated(p: PeerFixture, path = GEN): HoldRecord[] {
  return p.core.holds.nonTerminal().filter((r) => r.paths.includes(path) && r.guards.some((g) => guardName(g) === 'generated?'));
}

test('a file rewritten wholesale at three consecutive ticks becomes one ON_DISK PATCH generated? with GENERATED_SUSPECT {id, path: \'gen/api.ts\', excludeLine: \'"gen/api.ts"\'}', T10, async () => {
  await withPeers('t7-churn-three', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const a0 = (await prepIt(p, { materialize: false })).A.get(GEN)!.oid;
    const mats: Array<IterationCtx['mat']> = [];
    for (const round of [1, 2]) {
      await rewrite(p, round);
      const { it, r } = await tick(fx, p);
      mats.push(it.mat);
      assert.deepEqual(r, { created: [], released: [] }, `tick ${round} creates nothing`);
    }
    assert.equal(p.core.holdCode, null);
    await rewrite(p, 3);
    const { it, r } = await tick(fx, p);
    mats.push(it.mat);
    assert.equal(r.created.length, 1, 'tick 3 creates the record');
    const id = r.created[0]!;
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state], ['PATCH', 'ON_DISK', 'ACTIVE']);
    assert.deepEqual(rec.guards, [{ name: 'generated?', class: 'DECISION', owner: 'DAT' }]);
    assert.equal(rec.local_only, false);
    assert.deepEqual(rec.paths, [GEN]);
    assert.equal('h1' in rec.blobs ? rec.blobs.h0[GEN] : null, a0, 'h0 = A[gen/api.ts]');
    assert.equal('h1' in rec.blobs ? rec.blobs.h1[GEN] : null, await hashTestSide(p, GEN, (await readWork(p, GEN))!), 'h1 = the tick-3 bytes');
    assert.equal(rec.origin, 'human');
    assert.deepEqual(rec.cs_ids, []);
    assert.deepEqual(p.core.holdCode, { code: 'GENERATED_SUSPECT', params: { id, path: GEN, excludeLine: '"gen/api.ts"' } });
    assert.deepEqual(mats, [null, null, null], 'no iteration materialized');
    assert.deepEqual(generated(p).map((x) => x.id), [id]);
  });
});

test('two rewrites, an unchanged tick, then one rewrite create no record; three further consecutive rewrites do', T10, async () => {
  await withPeers('t7-churn-chain', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    let round = 0;
    const step = async (write: boolean): Promise<string[]> => {
      if (write) await rewrite(p, ++round);
      return (await tick(fx, p)).r.created;
    };
    // A tick at which the path did not change breaks the chain: r1, r2, unchanged, r3, unchanged, r4, r5 never make three.
    for (const w of [true, true, false, true, false, true, true]) assert.deepEqual(await step(w), [], `round ${round}`);
    assert.deepEqual(generated(p), []);
    // r6 is the third consecutive rewrite.
    const created = await step(true);
    assert.equal(created.length, 1, 'three consecutive rewrites');
    assert.deepEqual(generated(p).map((x) => x.id), created);
  });
  await withPeers('t7-churn-quiet', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    for (const round of [1, 2]) {
      await rewrite(p, round);
      assert.deepEqual((await tick(fx, p)).r.created, []);
    }
    // r3 written with an mtime of "now": the next tick excludes it (quiet), which neither extends nor clears the history.
    fx.advance(2_500);
    await writeFile(workPath(p, GEN), gen(50, 3, 30));
    const now = p.clock.wallMs() / 1_000;
    await utimes(workPath(p, GEN), now, now);
    const quiet = await prepIt(p, { materialize: false });
    assert.equal(quiet.tick?.excluded.get(GEN), 'quiet', 'precondition: the tick excludes gen/api.ts as quiet');
    assert.deepEqual(await churnStep(p.core, quiet), { created: [], released: [] }, 'a quiet tick does not extend the history');
    // The next tick reads r3: the third consecutive rewrite (r1, r2 kept through the quiet tick).
    const { r } = await tick(fx, p);
    assert.equal(r.created.length, 1, 'the quiet tick did not clear the history');
  });
});

test('rewriting 19 of 100 rows at 20 consecutive ticks creates no record; rewriting 20 of 100 creates one at the third', T10, async () => {
  await withPeers('t7-churn-ratio', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    let round = 0;
    for (let k = 0; k < 20; k++) {
      await writeWork(p, H100, gen(100, ++round, 19));
      assert.deepEqual((await tick(fx, p)).r.created, [], `19 of 100 at tick ${k + 1}`);
    }
    assert.deepEqual(generated(p, H100), []);
    for (let k = 1; k <= 3; k++) {
      await writeWork(p, H100, gen(100, ++round, 20));
      const { r } = await tick(fx, p);
      assert.equal(r.created.length, k === 3 ? 1 : 0, `20 of 100 at tick ${k}`);
    }
    assert.equal(generated(p, H100).length, 1);
  });
});

test('a binary file changed by one byte at three consecutive ticks becomes a record', T10, async () => {
  await withPeers('t7-churn-binary', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    for (let round = 1; round <= 3; round++) {
      // img.bin and rows.txt have the same 100 rows and the same one-byte change; only img.bin has a NUL (row 1).
      await writeWork(p, IMG, img(round));
      await writeWork(p, TXT, hundredRows(round, false));
      const { it, r } = await tick(fx, p);
      assert.ok(it.tick?.changed.has(IMG) && it.tick.changed.has(TXT), `tick ${round} saw both changes`);
      assert.equal(r.created.length, round === 3 ? 1 : 0, `tick ${round}`);
    }
    const [rec] = generated(p, IMG);
    assert.ok(rec !== undefined, 'one generated? record over img.bin');
    assert.equal(p.core.holdCode?.code, 'GENERATED_SUSPECT');
    assert.deepEqual(generated(p, TXT), [], 'the NUL-free twin rewrites 1 % of its rows: no record');
  });
});

test('the first observation of a chain compares with the private-index blob: a small first change, then two wholesale rewrites, create no record; a third rewrite does', T10, async () => {
  await withPeers('t7-churn-first-prev', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    // Round 1 rewrites 1 of 100 rows against the clean file (the private-index blob): 0.01. Rounds 2–4 rewrite 30 of 100.
    const created: number[] = [];
    for (const [round, count] of [[1, 1], [2, 30], [3, 30], [4, 30]] as const) {
      await writeWork(p, H100, gen(100, round, count));
      created.push((await tick(fx, p)).r.created.length);
    }
    assert.deepEqual(created, [0, 0, 0, 1], 'the 1 % first change keeps rounds 1–3 from qualifying; rounds 2–4 do');
  });
});

test('a materializing iteration neither resets a churn chain nor starts one from the materialized blob', T10, async () => {
  await withPeers('t7-churn-materialize', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    let round = 0;
    /** One qualifying rewrite of `path`, an iteration that materializes or not, churnStep. */
    const step = async (path: string, rows: number, materialize: boolean): Promise<{ it: IterationCtx; created: string[] }> => {
      await writeWork(p, path, gen(rows, ++round, 30));
      fx.advance(2_500);
      const it = await prepIt(p, { materialize });
      if (materialize) assert.ok(it.mat !== null && it.mat.sRawMap.has(path), `precondition: round ${round} materialized ${path}`);
      return { it, created: (await churnStep(p.core, it)).created };
    };
    // A: the second observation of the chain lands on a materializing iteration (its stage copy is gone by then).
    const a = [await step(GEN, 50, false), await step(GEN, 50, true), await step(GEN, 50, false)].map((s) => s.created.length);
    assert.deepEqual(a, [0, 0, 1], 'tick, materialize, tick: the record at the third');
    // B: the first observation lands on a materializing iteration, whose private index already holds the new bytes.
    const b = [await step(H100, 100, true), await step(H100, 100, false), await step(H100, 100, false)].map((s) => s.created.length);
    assert.deepEqual(b, [0, 0, 1], 'materialize, tick, tick: the record at the third');
    // C: the third observation lands on a materializing iteration: the record's h1 is the materialized S_raw blob.
    const c = [await step(GEN3, 50, false), await step(GEN3, 50, false), await step(GEN3, 50, true)];
    assert.deepEqual(c.map((s) => s.created.length), [0, 0, 1], 'tick, tick, materialize: the record at the third');
    const rec = p.core.holds.get(c[2]!.created[0]!)!;
    const h1 = 'h1' in rec.blobs ? rec.blobs.h1[GEN3] : null;
    assert.equal(h1, c[2]!.it.mat!.sRawMap.get(GEN3)!.oid, 'h1 = the materialized S_raw blob');
    assert.equal(h1, await hashTestSide(p, GEN3, (await readWork(p, GEN3))!), 'h1 = the round bytes');
  });
});

test('a change for which AttributionPort.hookAttributed answers true breaks the chain', T10, async () => {
  await withPeers('t7-churn-attributed', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    let changes = 0;
    p.deps.attribution = { ...humanOnlyAttribution, hookAttributed: (path) => path === GEN && ++changes === 2 };
    await prepIt(p, { materialize: false });
    const created: string[][] = [];
    for (let round = 1; round <= 5; round++) {
      await rewrite(p, round);
      created.push((await tick(fx, p)).r.created);
    }
    assert.deepEqual(created.map((c) => c.length), [0, 0, 0, 0, 1], 'no record after tick 3, one after tick 5');
    assert.equal(changes, 5, 'one attribution question per observed change');
  });
});

test('while the record is non-terminal, or carries generated?:exclude, no second record is created', T10, async () => {
  await withPeers('t7-churn-once', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    let round = 0;
    for (let k = 0; k < 3; k++) {
      await rewrite(p, ++round);
      await tick(fx, p);
    }
    const [rec] = generated(p);
    assert.ok(rec !== undefined);
    /** A qualifying rewrite and a tick whose churnStep must not look at gen/api.ts: no stage-copy read, no git call naming it. */
    const unobserved = async (k: number): Promise<void> => {
      await rewrite(p, ++round);
      fx.advance(2_500);
      const it = await prepIt(p, { materialize: false });
      assert.ok(it.tick?.changed.has(GEN), `precondition: tick ${k} changed gen/api.ts`);
      const fsFrom = p.fs.calls.length;
      const gitFrom = gitCallsOf(p).length;
      assert.deepEqual(await churnStep(p.core, it), { created: [], released: [] });
      assert.deepEqual(p.fs.calls.slice(fsFrom).filter((c) => c.includes(p.core.stage.abs(GEN))), [], `tick ${k}: no stage-copy read`);
      assert.deepEqual(gitCallsOf(p).slice(gitFrom).filter((c) => c.args.includes(GEN)), [], `tick ${k}: no git call for gen/api.ts`);
    };
    const head = p.core.holds.head();
    for (let k = 0; k < 10; k++) await unobserved(k);
    assert.equal(p.core.holds.head(), head, '10 more qualifying ticks: no registry commit');
    await p.core.holds.transition(rec.id, { guards: [makeGuard('generated?:exclude')] });
    const head2 = p.core.holds.head();
    for (let k = 0; k < 10; k++) await unobserved(k);
    assert.equal(p.core.holds.head(), head2, 'generated?:exclude: no registry commit either');
    assert.equal(p.core.holds.nonTerminal().filter((r) => r.paths.includes(GEN)).length, 1, 'F-DAT-04: one record');
  });
});

test('the record masks gen/api.ts whole and no pushed live tree carries a generated byte of it', T10, async () => {
  await withPeers('t7-churn-mask', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const it0 = await prepIt(p, { materialize: false });
    const a0 = it0.A.get(GEN)!.oid;
    await writeWork(p, USE, buf('use 1 edited\nuse 2\nuse 3\nuse 4\nuse 5\nuse 6\nuse 7\nuse 8\nuse 9\nuse 10\n'));
    let it = it0;
    for (let round = 1; round <= 3; round++) {
      await rewrite(p, round);
      it = (await tick(fx, p)).it;
    }
    assert.equal(generated(p).length, 1);
    const inp: MaskInputs = {
      A: it.A, scope: (q) => it.scope(q).cls, records: p.core.holds.maskingRecords(),
      mergeable: (q) => pathIsText(p.core, q) && !pathIsFiltered(p.core, q),
    };
    assert.equal(maskReason(GEN, inp), 'whole_path_guard');
    assert.deepEqual([...p.core.cs.openPaths()].sort(), [GEN, USE], 'the human CS holds both paths');
    // The generator stops; 20 s later the human CS closes and its pair is captured; the window publishes what it may.
    fx.advance(20_000);
    const cap = await prep(p, true);
    const pair = await captureReady(p, cap);
    assert.ok(pair.paths.includes(GEN) && pair.paths.includes(USE));
    assert.notEqual((await p.core.repo.readTreeMap(pair.R)).get(GEN)?.oid, a0, 'precondition: the captured R holds generated bytes of gen/api.ts');
    for (let w = 0; w < 3; w++) {
      fx.advance(6_000);
      await publishStep(p.core, await prep(p));
      assert.equal((await remoteLive(fx, p)).get(GEN), a0, `window ${w + 1}: the live tree keeps A[gen/api.ts]`);
    }
  });
});

test('a generated? record whose path the iteration scope reports UNMANAGED ends SUBSUMED', T10, async () => {
  await withPeers('t7-churn-unmanaged', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    let it: IterationCtx | null = null;
    for (let round = 1; round <= 3; round++) {
      await rewrite(p, round);
      it = (await tick(fx, p)).it;
    }
    const [rec] = generated(p);
    assert.ok(rec !== undefined && it !== null);
    const at = it;
    const r = await churnStep(p.core, { ...at, scope: (q) => (q === GEN ? { cls: 'UNMANAGED', reason: null } : at.scope(q)) });
    assert.deepEqual(r, { created: [], released: [rec.id] });
    const after = p.core.holds.get(rec.id)!;
    assert.equal(after.state, 'SUBSUMED');
    assert.ok(isTerminal(after));
  });
});

test('F-DAT-04: a generator rewriting gen/api.ts every 2 s on two peers for 60 virtual s gives one generated? record per peer and the live chain never changes gen/api.ts', T10, async () => {
  await withPeers('t7-churn-fdat04', { n: 2, files: FILES }, async (fx) => {
    const l0 = (await prep(fx.peers[0]!)).A.get(GEN)!.oid;
    for (const p of fx.peers) await prepIt(p, { materialize: false });
    for (let round = 1; round <= 30; round++) {
      for (const p of fx.peers) await rewrite(p, round + (p === fx.peers[0] ? 0 : 500));
      fx.advance(2_000);
      for (const p of fx.peers) {
        const it = await prepIt(p, { materialize: false, forceFetch: true });
        await churnStep(p.core, it);
        await publishStep(p.core, it);
      }
      assert.equal((await remoteLive(fx, fx.peers[0]!)).get(GEN), l0, `round ${round}: the remote live tip keeps L0's gen/api.ts`);
    }
    for (const p of fx.peers) assert.equal(generated(p).length, 1, `${p.name}: exactly one non-terminal generated? record`);
  });
});

test('a human typing with autosave into the 1.3 MB fixture never creates a generated? record', T10, async () => {
  await withPeers('t7-churn-typing', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    for (let round = 1; round <= 30; round++) {
      await writeWork(p, BIG, typed(round));
      const { it, r } = await tick(fx, p, 2_000);
      assert.ok(it.tick?.changed.has(BIG), `round ${round}: the tick saw the save`);
      assert.deepEqual(r.created, []);
    }
    assert.deepEqual(generated(p, BIG), []);
  });
});

/** A CSV of n rows (about 82 bytes each), row `edit` (0-based) carrying `# autosave <round>` when round > 0. */
function csv(n: number, round = 0, edit = 60_000): Buffer {
  return buf(Array.from({ length: n }, (_, k) => `${k},customer-${k},${k * 7},2026-10-09,region-${k % 17},status-ok,notes for row ${k}${k === edit && round > 0 ? ` # autosave ${round}` : ''}\n`).join(''));
}
const CSV = 'data/big.csv';

test('a one-row autosave into a 120,000-row CSV beyond the diff caps never creates a generated? record: the observation keeps prev whatever its size and scores the true share', T10, async () => {
  const base = csv(120_000);
  assert.ok(base.length > CHURN_DIFF_MAX_BYTES, `the file is beyond the byte cap (${base.length} bytes)`);
  await withPeers('t7-churn-bigcsv', { files: { 'README.md': buf('# big csv\n'), [CSV]: base } }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    for (let round = 1; round <= 5; round++) {
      await writeWork(p, CSV, csv(120_000, round));
      const { it, r } = await tick(fx, p, 2_000);
      assert.ok(it.tick?.changed.has(CSV), `round ${round}: the tick saw the save`);
      assert.deepEqual(r.created, [], `round ${round}: one row of 120,000 is not a rewrite`);
    }
    assert.deepEqual(generated(p, CSV), []);
    assert.equal(p.core.holdCode, null);
  });
});

test('churn observation writes no object; the record\'s content is the only -w', T10, async () => {
  await withPeers('t7-churn-w6', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await prepIt(p, { materialize: false });
    const from = gitCallsOf(p).length;
    for (const round of [1, 2]) {
      await rewrite(p, round);
      await tick(fx, p);
    }
    await rewrite(p, 3);
    fx.advance(2_500);
    const it = await prepIt(p, { materialize: false });
    const before = gitCallsOf(p).slice(from);
    const writes = (calls: ReturnType<typeof gitCallsOf>): ReturnType<typeof gitCallsOf> => calls.filter((c) => (c.args[0] === 'hash-object' && c.args.includes('-w')) || c.args[0] === 'add');
    assert.deepEqual(writes(before), [], 'no hash-object -w and no add over the ticks before the record');
    const at = gitCallsOf(p).length;
    const r = await churnStep(p.core, it);
    assert.equal(r.created.length, 1);
    // The registry commit writes its own metadata (route (c) record blobs, trees, the commit); the only object made from a
    // working file's bytes is the route (b) -w of the stage copy.
    const created = gitCallsOf(p).slice(at);
    const routeB = created.filter((c) => c.args[0] === 'hash-object' && c.args.includes('-w') && c.args.some((x) => x.startsWith('--path=')));
    assert.equal(routeB.length, 1, 'exactly one route (b) hash-object -w');
    assert.ok(routeB[0]!.args.includes(`--path=${GEN}`), '--path=gen/api.ts');
    assert.equal(routeB[0]!.args[routeB[0]!.args.length - 1], p.core.stage.abs(GEN), 'of the stage copy');
    assert.deepEqual(created.filter((c) => c.args[0] === 'add'), [], 'no route (a)');
  });
});

test('Task EF (item 3): a generated? record created on a tick-only iteration survives that iteration\'s R1 (recordStep) and later tick-only ones — the last materialized S_disk still holds A\'s gen/api.ts, not current for the path — and R1 decides on it again once an iteration materializes the path: ACTIVE with the generated bytes on disk, GONE once the file is A\'s again', T10, async () => {
  await withPeers('t-ef-churn-r1', { files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    /** One iteration of the loop's steps 3 D (churnStep) and 5 (applyStep, recordStep: R1's one call site), 2.5 s later. */
    const iteration = async (materialize: boolean): Promise<IterationCtx> => {
      fx.advance(2_500);
      const it = await prepIt(p, { materialize });
      await churnStep(p.core, it);
      await recordStep(p.core, it, await applyStep(p.core, it));
      return it;
    };
    await prepIt(p, { materialize: true });   // a running peer has a last materialized S_disk, here with gen/api.ts = A's
    for (const round of [1, 2, 3]) {
      await rewrite(p, round);
      const it = await iteration(false);
      assert.equal(it.mat, null, `round ${round}: no materialization`);
    }
    const created = p.core.holds.all().filter((r) => r.paths.includes(GEN) && r.guards.some((g) => guardName(g) === 'generated?'));
    assert.equal(created.length, 1, 'the third rewrite created the record');
    const id = created[0]!.id;
    const state = (): string => p.core.holds.get(id)!.state;
    assert.equal(state(), 'ACTIVE', 'R1 in the creating iteration does not read the stale S_disk as GONE');
    for (let i = 0; i < 3; i++) await iteration(false);
    assert.equal(state(), 'ACTIVE', 'nor in later tick-only iterations');
    // A materializing iteration: S_disk holds the generated bytes; R1 keeps the record ACTIVE.
    const m = await iteration(true);
    assert.ok(m.mat !== null && m.mat.sDiskMap.get(GEN)!.oid === (p.core.holds.get(id)!.blobs as { h1: Record<string, string> }).h1[GEN]);
    assert.equal(state(), 'ACTIVE');
    // The human puts A's bytes back: tick-only, S_disk is not current for the path (no verdict yet); materialized → GONE.
    await writeWork(p, GEN, gen(50));
    await iteration(false);
    assert.equal(state(), 'ACTIVE', 'no verdict from the stale S_disk');
    await iteration(true);
    assert.equal(state(), 'GONE', 'the held change is no longer on the materialized disk');
  });
});
