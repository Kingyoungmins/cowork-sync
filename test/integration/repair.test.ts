// The DAT-08 disk repair on an EngineCore over a real clone (Plan 3 Task 7; 03-data §3.2 "Disk repair", DAT-08, I-DAT-04, K8,
// D-01; Review Focus 2, 3 and 5 shapes; rulings R3-23, R3-34, R3-36): a path whose materialized S_raw[p] differs from S_disk[p]
// only by form (a Write that dropped the BOM, a CRLF file whose endings went LF) is written back to S_disk[p] through
// Writer.writeLocal (origin repair:<p>) at the first materializing iteration after two detection ticks that saw p's stat and
// detection id unchanged; the private-index entry and the stat cache follow, so the file is never re-read or re-hashed while it
// stays idle. Never under FREEZE, over a kept push intent or a stranded restore, on a canon-refused path or one held under
// eol-bom. The clone runs core.autocrlf=true and stores the fixtures as given (BOM + CRLF, cp949 + CRLF, MIXED). Git is never
// mocked.
//
// "A materializing iteration" is prepareIteration(core, n, {materialize: true, forceFetch: false, holdPaths: repairDue(core)})
// followed by repairStep(core, it); "a tick" is the same with materialize: false; both after advance(2_500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareIteration, type IterationCtx } from '../../src/engine/core.js';
import { repairDue, repairStep } from '../../src/engine/dataRecords.js';
import { restart } from '../../src/engine/restart.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import type { WriteLocalResult } from '../../src/engine/writer.js';
import { gitCallsOf, makeCores, readWork, workPath, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { recordLog } from '../helpers/holdOpsFixture.js';
import type { LogRecorder } from '../helpers/publishHelpers.js';
import { restartCore } from '../helpers/startFixture.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const BIG = 'big.py';
const LEGACY = 'legacy.txt';
const MIXED = 'mixed.txt';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CRLF = Buffer.from('\r\n', 'latin1');
const BIG_BYTES = generateBigBomCrlf(26_436, seededRandom('t7-repair'));
/** 40 cp949 rows (가나 = B0 A1 B3 AA), CRLF. */
const LEGACY_BYTES = Buffer.concat(Array.from({ length: 40 }, (_, k) => Buffer.concat([Buffer.from([0xb0, 0xa1, 0xb3, 0xaa]), Buffer.from(` row ${k + 1}`, 'latin1'), CRLF])));
/** A MIXED stored form: rows 1–3 end CRLF, rows 4–20 LF. */
const MIXED_BYTES = Buffer.from(Array.from({ length: 20 }, (_, k) => `mixed ${k + 1}${k < 3 ? '\r\n' : '\n'}`).join(''), 'latin1');
const FILES: Record<string, Buffer> = { [BIG]: BIG_BYTES, [LEGACY]: LEGACY_BYTES, [MIXED]: MIXED_BYTES };

/** big.py without its BOM (a Write that dropped it), optionally with row `row` (1-based) replaced. */
function bomless(row?: number, text = 'edited row'): Buffer {
  const rows = BIG_BYTES.subarray(3).toString('latin1').split('\r\n');
  if (row !== undefined) rows[row - 1] = `# ${text} ${row}`;
  return Buffer.from(rows.join('\r\n'), 'latin1');
}
/** LF endings for every CRLF of b. */
const toLf = (b: Buffer): Buffer => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

interface Calls { local: Array<{ path: string; expected: string; target: string; origin: string; result: WriteLocalResult['kind'] }>; }

/** makeCores + bootstrap with the repair fixtures on an autocrlf=true peer; a writeLocal spy and a log recorder installed. */
async function withRepair(label: string, fn: (fx: CoreFixture, p: PeerFixture, calls: Calls, log: LogRecorder) => Promise<void>): Promise<void> {
  const fx = await makeCores(label, { n: 1, autocrlf: [true], files: FILES });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES, 'checked out byte-identical');
    const calls = spyWriteLocal(p);
    const log = recordLog(p);
    await fn(fx, p, calls, log);
  } finally {
    setCrashHandler(null);
    fx.scheduler.onYield = null;
    await fx.cleanup();
  }
}

/** Records every Writer.writeLocal call of the peer's (current) core and its result. */
function spyWriteLocal(p: PeerFixture): Calls {
  const calls: Calls = { local: [] };
  const w = p.core.writer;
  const orig = w.writeLocal.bind(w);
  w.writeLocal = async (path, expected, target, origin, humanEvidence) => {
    const res = await orig(path, expected, target, origin, humanEvidence);
    calls.local.push({ path, expected, target, origin, result: res.kind });
    return res;
  };
  return calls;
}

let n = 0;

/** advance(2_500), one prepared iteration (materializing or a tick, holdPaths = repairDue) and repairStep. */
async function step(fx: CoreFixture, p: PeerFixture, materialize: boolean): Promise<{ it: IterationCtx; repaired: string[] }> {
  fx.advance(2_500);
  const r = await prepareIteration(p.core, ++n, { materialize, forceFetch: false, holdPaths: repairDue(p.core) });
  assert.ok(r.ok, `prepareIteration: ${JSON.stringify(r)}`);
  return { it: r.it, repaired: await repairStep(p.core, r.it) };
}
const mat = (fx: CoreFixture, p: PeerFixture): Promise<{ it: IterationCtx; repaired: string[] }> => step(fx, p, true);
const tick = (fx: CoreFixture, p: PeerFixture): Promise<{ it: IterationCtx; repaired: string[] }> => step(fx, p, false);

/** A Write that drops big.py's BOM, then the materializing iteration that shows it and two unchanged ticks: big.py is due. */
async function dropBomUntilDue(fx: CoreFixture, p: PeerFixture): Promise<{ sRaw: Oid; sDisk: Oid }> {
  await writeWork(p, BIG, bomless());
  const { it } = await mat(fx, p);
  const sRaw = it.mat!.sRawMap.get(BIG)!.oid;
  const sDisk = it.mat!.sDiskMap.get(BIG)!.oid;
  assert.notEqual(sRaw, sDisk, 'precondition: S_raw[big.py] ≠ S_disk[big.py]');
  await tick(fx, p);
  await tick(fx, p);
  assert.deepEqual([...repairDue(p.core)], [BIG], 'due after two unchanged ticks');
  return { sRaw, sDisk };
}

const repairEvents = (fx: CoreFixture): Array<{ path: string; from: string; to: string }> =>
  fx.trace.ofKind('repair').map((e) => ({ path: e.path, from: e.from, to: e.to }));
const repairedLines = (log: LogRecorder): Array<Record<string, unknown>> => log.lines.filter((l) => l.code === 'EOL_REPAIRED').map((l) => ({ ...l.params }));
const renamesOf = (p: PeerFixture, path: string, from = 0): string[] => p.fs.calls.slice(from).filter((c) => c.startsWith(`rename ${workPath(p, path)} -> `));

test('a Write that drops the BOM of the 1.3 MB BOM+CRLF fixture is repaired at the first materializing iteration after two unchanged ticks, byte-identical to the stored form', T10, async () => {
  await withRepair('t7-repair-bom', async (fx, p, calls, log) => {
    await writeWork(p, BIG, bomless());
    const first = await mat(fx, p);
    const sRaw = first.it.mat!.sRawMap.get(BIG)!.oid;
    const sDisk = first.it.mat!.sDiskMap.get(BIG)!.oid;
    assert.notEqual(sRaw, sDisk, 'iteration 1 materializes S_raw[big.py] ≠ S_disk[big.py]');
    assert.equal(sDisk, first.it.A.get(BIG)!.oid, 'canon restores the stored form');
    assert.deepEqual(first.repaired, []);
    assert.deepEqual(calls.local, [], 'iteration 1 writes nothing');
    assert.equal(repairDue(p.core).size, 0);
    assert.deepEqual((await tick(fx, p)).repaired, []);
    assert.equal(repairDue(p.core).size, 0, 'one unchanged tick is not enough');
    assert.deepEqual((await tick(fx, p)).repaired, [], 'a tick never writes');
    assert.deepEqual([...repairDue(p.core)], [BIG]);
    const { repaired } = await mat(fx, p);
    assert.deepEqual(repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES, 'byte-identical to the stored form');
    assert.deepEqual(repairEvents(fx), [{ path: BIG, from: sRaw, to: sDisk }]);
    assert.equal(fx.trace.ofKind('repair')[0]!.peer, p.core.peerId);
    assert.deepEqual(calls.local, [{ path: BIG, expected: sRaw, target: sDisk, origin: `repair:${BIG}`, result: 'WRITTEN' }]);
    // Final review F1: the write is recorded (R3-36) and forgotten once the private-index entry holds it — it is never a materialized
    // delta, so a lingering entry would let a later stale save of the same blob (here A[big.py]) pass as observed (HLD-26, HLD-27).
    assert.equal(p.core.observed.peek(BIG, sDisk), false, 'no lingering ObservedWrites entry for the repaired write (F1)');
    assert.deepEqual(repairedLines(log), [{ path: BIG, bom: true, eol: 'CRLF' }], 'exactly one EOL_REPAIRED');
    assert.equal(p.core.holdCode, null, 'log only (R-27)');
    assert.equal(repairDue(p.core).size, 0);
  });
});

test('after the repair the next 100 idle ticks copy and hash nothing for big.py', T10, async () => {
  await withRepair('t7-repair-idle', async (fx, p) => {
    const { sDisk } = await dropBomUntilDue(fx, p);
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    const gitFrom = gitCallsOf(p).length;
    const fsFrom = p.fs.calls.length;
    for (let k = 0; k < 100; k++) {
      const { it, repaired } = await tick(fx, p);
      assert.deepEqual(repaired, []);
      assert.equal(it.tick?.dirty.has(BIG), false, `idle tick ${k + 1}: clean`);
    }
    const git = gitCallsOf(p).slice(gitFrom);
    const names = (c: (typeof git)[number]): boolean => c.args.some((a) => a.includes(BIG)) || (c.opts.stdin !== undefined && Buffer.from(c.opts.stdin).includes(BIG));
    assert.deepEqual(git.filter((c) => c.args[0] === 'hash-object' && names(c)), [], 'no hash-object of big.py');
    assert.deepEqual(git.filter((c) => c.args[0] === 'add' && names(c)), [], 'no add of big.py');
    assert.deepEqual(p.fs.calls.slice(fsFrom).filter((c) => c.startsWith('readFile ') && c.includes(BIG)), [], 'no read of big.py');
    const { it } = await mat(fx, p);
    assert.equal(it.mat!.sRawMap.get(BIG)!.oid, sDisk, 'the private index holds S_disk[big.py] (setEntry)');
  });
});

test('a cp949 CRLF file whose endings a Write flipped to LF is repaired back to CRLF with every multibyte byte unchanged', T10, async () => {
  await withRepair('t7-repair-cp949', async (fx, p, _calls, log) => {
    assert.deepEqual(await readWork(p, LEGACY), LEGACY_BYTES);
    await writeWork(p, LEGACY, toLf(LEGACY_BYTES));
    const { it } = await mat(fx, p);
    assert.notEqual(it.mat!.sRawMap.get(LEGACY)!.oid, it.mat!.sDiskMap.get(LEGACY)!.oid);
    await tick(fx, p);
    await tick(fx, p);
    assert.deepEqual((await mat(fx, p)).repaired, [LEGACY]);
    assert.deepEqual(await readWork(p, LEGACY), LEGACY_BYTES, 'CRLF back, every cp949 byte unchanged');
    assert.deepEqual(repairedLines(log), [{ path: LEGACY, bom: false, eol: 'CRLF' }]);
  });
});

test('an edit during the two quiet ticks restarts the count', T10, async () => {
  await withRepair('t7-repair-restart-count', async (fx, p, calls) => {
    await writeWork(p, BIG, bomless());
    await mat(fx, p);
    await tick(fx, p);
    await writeWork(p, BIG, bomless(7));
    const edited = await tick(fx, p);
    assert.ok(edited.it.tick?.changed.has(BIG), 'the tick shows big.py changed');
    assert.equal(repairDue(p.core).size, 0);
    assert.deepEqual((await mat(fx, p)).repaired, [], 'the next materialization starts a new count');
    assert.equal(repairDue(p.core).size, 0);
    await tick(fx, p);
    assert.equal(repairDue(p.core).size, 0);
    await tick(fx, p);
    assert.deepEqual([...repairDue(p.core)], [BIG]);
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), Buffer.concat([BOM, bomless(7)]), 'the edited row 7 kept, the BOM back');
    assert.equal(calls.local.length, 1);
  });
});

test('no repair while any FREEZE reason is set; the repair runs at the first materializing iteration after the lift', T10, async () => {
  await withRepair('t7-repair-freeze', async (fx, p, calls) => {
    await dropBomUntilDue(fx, p);
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['MASS'] } });
    const fsFrom = p.fs.calls.length;
    const frozen = await mat(fx, p);
    assert.deepEqual(frozen.it.freeze, ['MASS']);
    assert.deepEqual(frozen.repaired, []);
    assert.deepEqual(calls.local, [], 'no writeLocal call');
    assert.deepEqual(renamesOf(p, BIG, fsFrom), [], 'no rename of big.py');
    assert.deepEqual(repairEvents(fx), []);
    assert.deepEqual([...repairDue(p.core)], [BIG], 'still due');
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: [] } });
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES);
  });
});

test('a canon-refused path and a path held under eol-bom are never repaired', T10, async () => {
  await withRepair('t7-repair-refused', async (fx, p, calls) => {
    assert.deepEqual(await readWork(p, MIXED), MIXED_BYTES);
    const mixedNow = toLf(MIXED_BYTES);   // rows 1–3 change their endings: canon of a MIXED ref refuses
    const legacyNow = toLf(LEGACY_BYTES);
    await writeWork(p, MIXED, mixedNow);
    await writeWork(p, LEGACY, legacyNow);
    const { it } = await mat(fx, p);
    assert.ok(it.mat!.canonRefused.has(MIXED), 'precondition: canon refuses mixed.txt');
    const raw = it.mat!.sRawMap.get(LEGACY)!.oid;
    assert.notEqual(raw, it.mat!.sDiskMap.get(LEGACY)!.oid, 'precondition: legacy.txt would be a repair candidate');
    await p.core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [LEGACY], blobs: { h0: { [LEGACY]: it.A.get(LEGACY)!.oid }, h1: { [LEGACY]: raw } },
      guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null,
    });
    for (let k = 0; k < 5; k++) {
      for (const s of [await tick(fx, p), await tick(fx, p), await mat(fx, p)]) {
        assert.deepEqual(s.repaired, []);
        assert.deepEqual([...repairDue(p.core)].filter((x) => x === MIXED || x === LEGACY), [], `round ${k + 1}`);
      }
    }
    assert.deepEqual(calls.local, [], 'no writeLocal names them');
    assert.deepEqual(await readWork(p, MIXED), mixedNow);
    assert.deepEqual(await readWork(p, LEGACY), legacyNow);
  });
});

test('a repair is postponed while a push intent is kept and while a path is stranded', T10, async () => {
  await withRepair('t7-repair-postponed', async (fx, p, calls) => {
    // A kept push intent (the only record of a push that may have landed, R3-23), with the state's own oids.
    await dropBomUntilDue(fx, p);
    const view = p.core.view!;
    await p.core.commit({ intent: { kind: 'push', bnew: view.laB, c: null, lease_board: ABSENT, lease_code: ABSENT, cs_ids: [], writer_seq: 1, op_ids: [] }, t: new Map([['P', view.base]]) });
    assert.deepEqual((await mat(fx, p)).repaired, []);
    assert.deepEqual(calls.local, []);
    assert.deepEqual([...repairDue(p.core)], [BIG], 'still due');
    assert.deepEqual(await readWork(p, BIG), bomless());
    await p.core.commit({ intent: { kind: 'none' }, t: new Map() });
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES);

    // A stranded restore (P2-STRANDED): a local write of mixed.txt whose link and relink fail leaves its .old at its intent
    // name; the third failure is the next sweep's (prepareIteration), the one after that restores it.
    await writeWork(p, LEGACY, toLf(LEGACY_BYTES));
    await mat(fx, p);
    await tick(fx, p);
    await tick(fx, p);
    assert.deepEqual([...repairDue(p.core)], [LEGACY]);
    const mixedA = p.core.view!.base;
    const aMixed = (await p.core.repo.readTreeMap(mixedA)).get(MIXED)!.oid;
    const other = await p.core.repo.hashBytes(Buffer.from('other\n', 'latin1'), true);
    p.fs.addRule({ op: 'link', pathIncludes: workPath(p, MIXED), code: 'EPERM', times: 3 });
    assert.deepEqual(await p.core.writer.writeLocal(MIXED, aMixed, other, 'test-strand'), { kind: 'LOCKED' });
    assert.deepEqual(p.core.writer.strandedPaths(), [MIXED], 'precondition: a stranded restore');
    calls.local.length = 0;
    const stranded = await mat(fx, p);
    assert.deepEqual(p.core.writer.strandedPaths(), [MIXED], 'still stranded after the iteration\'s sweep');
    assert.deepEqual(stranded.repaired, []);
    assert.deepEqual(calls.local, [], 'no repair write while a restore is stranded');
    assert.deepEqual([...repairDue(p.core)], [LEGACY], 'still due');
    const after = await mat(fx, p);
    assert.deepEqual(p.core.writer.strandedPaths(), [], 'the sweep restored it');
    assert.deepEqual(after.repaired, [LEGACY]);
    assert.deepEqual(await readWork(p, LEGACY), LEGACY_BYTES);
    assert.deepEqual(await readWork(p, MIXED), MIXED_BYTES, 'the stranded file is back');
  });
});

test('a share-read lock on big.py makes the repair\'s writeLocal LOCKED: nothing is written and big.py stays due until the lock is released', T10, async () => {
  await withRepair('t7-repair-locked', async (fx, p, calls, log) => {
    await dropBomUntilDue(fx, p);
    const release = p.fs.holdLock(workPath(p, BIG), 'share-read');
    const locked = await mat(fx, p);
    assert.deepEqual(locked.repaired, []);
    assert.deepEqual(calls.local.map((c) => c.result), ['LOCKED']);
    assert.deepEqual(await readWork(p, BIG), bomless(), 'disk bytes unchanged');
    assert.deepEqual(repairEvents(fx), [], 'no trace');
    assert.deepEqual(repairedLines(log), [], 'no log');
    assert.deepEqual([...repairDue(p.core)], [BIG], 'still due');
    release();
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES);
    assert.equal(repairedLines(log).length, 1);
  });
});

test('a writer MISMATCH writes and logs nothing, and a later BOM drop is a new episode that logs EOL_REPAIRED again', T10, async () => {
  await withRepair('t7-repair-mismatch', async (fx, p, calls, log) => {
    await dropBomUntilDue(fx, p);
    // The writer's first read of big.py (its pre-image DISK_EQ) meets a file whose row 9 an editor just rewrote.
    const abs = workPath(p, BIG);
    p.fs.interpose('readFile', abs, async () => {
      await writeFile(abs, bomless(9, 'editor row'));
    });
    const missed = await mat(fx, p);
    assert.deepEqual(missed.repaired, []);
    assert.deepEqual(calls.local.map((c) => c.result), ['MISMATCH']);
    assert.deepEqual(repairEvents(fx), [], 'no repair trace');
    assert.deepEqual(repairedLines(log), [], 'no log line');
    assert.equal(repairDue(p.core).size, 0, 'the episode ended');
    assert.deepEqual(await readFile(abs), bomless(9, 'editor row'), 'the editor\'s bytes are on disk');
    assert.ok((await tick(fx, p)).it.tick?.changed.has(BIG), 'the edit is a change');
    await mat(fx, p);
    assert.equal(repairDue(p.core).size, 0);
    await tick(fx, p);
    assert.equal(repairDue(p.core).size, 0);
    await tick(fx, p);
    assert.deepEqual([...repairDue(p.core)], [BIG], 'two more unchanged ticks after the next materialization');
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(await readWork(p, BIG), Buffer.concat([BOM, bomless(9, 'editor row')]));
    assert.equal(repairedLines(log).length, 1);
    // A second episode: the BOM dropped again.
    await writeWork(p, BIG, bomless(9, 'editor row'));
    await mat(fx, p);
    await tick(fx, p);
    await tick(fx, p);
    assert.deepEqual((await mat(fx, p)).repaired, [BIG]);
    assert.deepEqual(repairedLines(log), [{ path: BIG, bom: true, eol: 'CRLF' }, { path: BIG, bom: true, eol: 'CRLF' }], '2 lines for 2 episodes');
  });
});

test('a kill at apply.group.phase1 inside the repair\'s writeLocal leaves big.py with the BOM-less or the repaired bytes after restart, and the next due iteration completes the repair', T10, async () => {
  await withRepair('t7-repair-kill', async (fx, p) => {
    await dropBomUntilDue(fx, p);
    let hits = 0;
    setCrashHandler((name) => {
      if (name === 'apply.group.phase1' && ++hits === 1) throw new KilledAt(name);
    });
    await assert.rejects(mat(fx, p), (e: unknown) => e instanceof KilledAt && e.point === 'apply.group.phase1');
    setCrashHandler(null);
    assert.equal(p.core.view!.intent.kind, 'local', 'the repair\'s local intent is journaled');
    // A process restart: a fresh core over the same clone, restart() rolls the journaled local intent back.
    await restartCore(p);
    await restart(p.core);
    const disk = await readWork(p, BIG);
    assert.ok(disk !== null && (disk.equals(bomless()) || disk.equals(BIG_BYTES)), 'one of the two blobs, never torn');
    assert.equal(p.core.view!.intent.kind, 'none');
    // The next due iteration (a new episode: the restarted core remembers nothing) completes the repair.
    await mat(fx, p);
    await tick(fx, p);
    await tick(fx, p);
    assert.deepEqual([...repairDue(p.core)], disk!.equals(BIG_BYTES) ? [] : [BIG]);
    await mat(fx, p);
    assert.deepEqual(await readWork(p, BIG), BIG_BYTES, 'repaired');
  });
});
