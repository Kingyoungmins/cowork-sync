// test/integration/claude.hookRead.saves.test.ts — Task 8's hookRead.saves cell (06 test 46 hook half, CCI-55,
// INV-CCI-SHORTREAD, O-STAGED hook half, glossary §26 W1/W3): in-place and atomic-replace saves of the 1.3 MB
// BOM+CRLF fixture during 500 hold→settle pairs and 50 TXN open/close cycles — no git argv names the working
// file, loose objects are unchanged by hook reads, an unstable pre-image is the second read, the mutant sites
// M40/M41 break exactly those two assertions, and real Node saves (rename replace) race the reads with no EPERM
// while no hook read is in progress. The default arms' failure bounds are measured (see B1/B3), never loose. 06 test
// 46's budget itself — ≥ 3,000 real atomic-replace saves per arm every 1–5 s against a daemon-off control of equal
// length, daemon-attributable failures ≤ 3 — is the soak arm at the end of this file: gated by COWORK_SOAK=1 on
// windows-latest and run in the Plan 5 exit run (R-F2-6); its budget arithmetic is a default-suite cell (F2 #18, #36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { shortRead, DiskSnapshots, type DiskSnapshot, type ShortRead } from '../../src/claude/daemon/hookRead.js';
import { LeaseTable, type Txn } from '../../src/claude/daemon/leases.js';
import type { Oid } from '../../src/git/oid.js';
import { realFs, type Fs, type FsLstat } from '../../src/ports/fs.js';
import { seededRandom, type Random } from '../../src/ports/random.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';
import { makeSnapFixture } from '../helpers/snapFixture.js';

const T10 = { timeout: 10 * 60_000 };
const CAP = 67_108_864;                                     // the 64 MB disk-snapshot cap
const BIG = generateBigBomCrlf(26_436, seededRandom('hookread-saves'));   // ≈ 1.3 MB, deterministic
// The default arms' save-failure bounds, B = max(2 × observedMax, observedMax + 10) over the clean code's runs on a heavily
// loaded Windows 11 PC (F2 #18, #36; logs t8a-leases-I9-measure-5d8e65d-5runs.log, -run3-rerun.log, -I9-green-fixed-x3.log):
// test 1 failed 3, 4, 4, 1 times on 5d8e65d and 29 times in a later run of this file → B1 = 58 (was 250); a read handle
// held ≈ 5× longer (the I-9 mutant) fails it 242 times. Test 3's racing arm is load-sensitive (a slower read holds its
// handle longer): 25–145 of 500 on 5d8e65d, up to 223 later; the formula gives 446, a loosening, so B3 stays at the old
// 250 — which the 5× mutant still exceeds (468–491 of 500).
const B1 = 58;
const B3 = 250;

/** FaultFs plus the bytes of every readFile of the probed file (the spy that records read-2). */
class RecordingFs implements Fs {
  readonly reads: Buffer[] = [];
  constructor(private readonly inner: Fs) { }
  async readFile(p: string): Promise<Buffer> { const b = await this.inner.readFile(p); this.reads.push(b); return b; }
  async lstat(p: string): Promise<FsLstat | null> { return this.inner.lstat(p); }
  async writeFile(p: string, d: Buffer): Promise<void> { return this.inner.writeFile(p, d); }
  async rename(f: string, t: string): Promise<void> { return this.inner.rename(f, t); }
  async link(e: string, n: string): Promise<void> { return this.inner.link(e, n); }
  async unlink(p: string): Promise<void> { return this.inner.unlink(p); }
  async writeFileExclusive(p: string, d: Buffer, m?: number): Promise<void> { return this.inner.writeFileExclusive(p, d, m); }
  async rmdir(p: string): Promise<void> { return this.inner.rmdir(p); }
  async appendFile(p: string, d: Buffer): Promise<void> { return this.inner.appendFile(p, d); }
  async chmod(p: string, m: number): Promise<void> { return this.inner.chmod(p, m); }
  async stat(p: string) { return this.inner.stat(p); }
  async mkdirp(p: string, m?: number): Promise<void> { return this.inner.mkdirp(p, m); }
  async readdir(p: string): Promise<string[]> { return this.inner.readdir(p); }
  async rmrf(p: string): Promise<void> { return this.inner.rmrf(p); }
  async realpath(p: string): Promise<string> { return this.inner.realpath(p); }
  async freeBytes(d: string): Promise<number | null> { return this.inner.freeBytes(d); }
}

const openTxnOf = (toolUseId: string): Omit<Txn, 'kind' | 'openMono'> =>
  ({ toolUseId, seatId: 's1', agentId: null, sessionId: 's1', tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null });

/** The i-th save's bytes: BIG with a fixed-width tag overwriting a varying in-bounds row (mtime always moves). */
const variant = (base: Buffer, i: number): Buffer => {
  const v = Buffer.from(base);
  v.write(`S${i}`.padEnd(8, '.'), 100 + (i % 12_000) * 100, 'utf8');
  return v;
};

/** Whether a hash-object argv carries the working file as an operand (M40's in-place hash): `--path=big.py` is not one. */
const namesWorkFile = (args: readonly string[]): boolean =>
  args.slice(1).filter((a) => !a.startsWith('--')).some((a) => a.includes('big.py'));

test('hookRead.saves: in-place and atomic-replace saves of the 1.3 MB BOM+CRLF file during 500 hold→settle pairs and 50 TXN cycles — no git argv names the working file, loose objects unchanged, unstable pre-images are the second read', T10, async () => {
  const s = await makeSnapFixture('hookread-saves', { files: { 'big.py': BIG, 'src/a.txt': Buffer.from('one\n') } });
  try {
    const trace = new TraceRecorder();
    const clock = new VirtualClock({ startMono: 0 });
    const fsRec = new RecordingFs(s.fs);
    const snaps = new DiskSnapshots(s.repo, fsRec, s.stage, CAP);
    const leases = new LeaseTable(clock, trace, snaps);
    const abs = s.abs('big.py');
    let side = 0;                                          // the deterministic leg's own save index
    const saveSide = async (): Promise<void> => { await fsp.writeFile(abs, variant(BIG, 500_000 + side++)); };
    // The editor's saves: even i in place, odd i by rename replace (MoveFileEx). On Windows a rename replace of a
    // file an in-process read holds open fails EPERM — counted, and fatal only when it happens with no read in
    // flight (the plan's guard: no EPERM while no hook read is in progress).
    const flight = { on: false };
    let failures = 0;
    let midRead = 0;
    const save = async (i: number): Promise<void> => {
      try {
        if (i % 2 === 0) { await fsp.writeFile(abs, variant(BIG, i)); return; }
        const tmp = `${abs}.save`;
        await fsp.writeFile(tmp, variant(BIG, i));
        await fsp.rename(tmp, abs);
      } catch (e) {
        failures += 1;
        if (flight.on) midRead += 1;
        if (i % 2 === 0 || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      }
    };

    const loose0 = await s.loose();
    const objects0 = await s.objects();
    s.calls.length = 0;                                    // drop the fixture's own setup calls: only hook settles remain
    let settled = 0;
    let unstables = 0;
    let skipped = 0;
    let lastOid: string | null = null;
    let last: DiskSnapshot | null = null;                  // the release contract: only the newest snapshot is kept

    for (let i = 0; i < 500; i++) {
      if (i === 250) s.fs.interpose('lstat', abs, saveSide, 3);   // a save right before lstat 1/2/3 of the next read → re-read then unstable
      const w = save(i);                                          // the editor's save races the gate's read
      w.catch(() => undefined);                                   // a counted EPERM is not an unhandled rejection
      const before = fsRec.reads.length;
      flight.on = true;                                           // exactly the read's open window: an EPERM now is the guard's subject
      const read = await shortRead(fsRec, abs);
      flight.on = false;
      await w;
      if (read.kind === 'missing' || read.kind === 'unreadable') { skipped += 1; continue; }
      if (read.kind === 'unstable') {
        unstables += 1;
        assert.ok(read.bytes.equals(fsRec.reads[before + 1]!), `save ${i}: the unstable pre-image is the second read`);
      }
      const h = snaps.hold('big.py', read);                       // the gate's hold: memory only, no git
      clock.advance(1 + (i % 5));                                 // the virtual 1–5 ms between Pre and reply
      const snap = await snaps.settle(h);                         // after the reply: the stdin route-(b) hash
      assert.equal(typeof snap.oid, 'string', `save ${i}: the settle made an oid`);
      lastOid = snap.oid;
      if (last !== null) await snaps.release(last);              // the previous snapshot's reference is returned
      last = snap;
      settled += 1;
      if (i % 10 === 9) {                                         // 50 TXN cycles: open, close read (take), release
        leases.openTxn(openTxnOf(`tx${i}`));
        assert.equal(leases.txnOpen(), true, `tx${i}: the TXN is open`);
        const close = await snaps.take('big.py', await shortRead(fsRec, abs));
        await snaps.release(close);                               // the close snapshot is released
        leases.release(`tx${i}`, 'post');
        assert.equal(leases.txnOpen(), false, `tx${i}: the release closed it`);
      }
    }

    console.log(JSON.stringify({ hookReadSaves: 'test 1', failures, midRead, settled, skipped, unstables, B1 }));   // calibration
    assert.equal(settled + skipped, 500);
    assert.ok(settled >= 450, `the reads kept landing: ${settled}`);
    assert.ok(unstables >= 1, `the racing saves produced at least one unstable read (got ${unstables})`);
    assert.equal(failures, midRead, 'every save failure happened while a hook read was in flight');
    assert.ok(failures <= B1, `a save fails only against an in-flight read, at most B1 = ${B1} of 500: ${failures}`);
    // No git process names the working file: the only s.repo calls are the settles, and none carries the abs
    // path, the repo path, or -w.
    // Every settle that did not hit the (path, sha) cache hashed: a save an in-flight read made fail EPERM
    // leaves the previous bytes, whose entry the cache dedupes — fewer calls than settles is correct.
    assert.ok(s.calls.length >= 250, `the settles hashed: ${s.calls.length}`);
    for (const c of s.calls) {
      assert.equal(c.args[0], 'hash-object', `a hook read's git call: ${c.args.join(' ')}`);
      assert.ok(!c.args.includes('-w'), `no -w on a hook read: ${c.args.join(' ')}`);
      assert.ok(!namesWorkFile(c.args), `no argv names the working file: ${c.args.join(' ')}`);
    }
    assert.deepEqual(await s.loose(), loose0, 'loose-object count and bytes unchanged by 500 settles');
    assert.equal((await s.objects()).size, objects0.size, 'no object was written by a hook read');
    assert.equal(snaps.bytesHeld(), 0, 'every settle dropped its hold');
    const cached = snaps.get('big.py', lastOid as Oid);
    assert.ok(cached !== null, 'the last snapshot is cached by oid');
    assert.equal(cached, last, 'and it is the one snapshot still referenced');
    assert.equal(snaps.stats().entries, 1, 'every earlier snapshot was evicted at its release');
    await snaps.release(cached!);
    assert.equal(snaps.get('big.py', lastOid as Oid), null, 'release drops the entries and byOid rows');
    await snaps.drain();
    assert.deepEqual(snaps.stats(), { heldBytes: 0, memBytes: 0, entries: 0, spilled: 0, pending: 0 }, 'nothing is left');
  } finally {
    await s.cleanup();
  }
});

test('mutant M40 names the working file in the settle argv and M41 writes the object; a clean settle does neither', T10, async () => {
  const s = await makeSnapFixture('hookread-saves-mutants', { files: { 'big.py': BIG } });
  const prev = process.env['COWORK_TEST_MUTANT'];
  try {
    const mk = (): DiskSnapshots => new DiskSnapshots(s.repo, s.fs, s.stage, CAP);
    const prev = process.env['COWORK_TEST_MUTANT'];
    /** A settle of fresh bytes per arm: a one-line tag edits the fixture's second row so no (path, sha) cache hits. */
    const settleOnce = (tag: string): Promise<unknown> => {
      const bytes = Buffer.from(BIG);
      bytes.write(`${tag}\r\n`, BIG.indexOf('\n', 1) + 1, 'utf8');      // row 2: "S:<tag>"
      const stat = {} as FsLstat;                                       // settle never reads the stat
      return mk().settle({ path: 'big.py', bytes, stat, unstable: false, size: bytes.length });
    };

    process.env['COWORK_TEST_MUTANT'] = 'M40';
    s.calls.length = 0;
    await settleOnce('m40');
    assert.ok(s.calls.some((c) => namesWorkFile(c.args)), `M40's settle argv names the working file: ${s.calls.map((c) => c.args.join(' ')).join(' | ')}`);

    process.env['COWORK_TEST_MUTANT'] = 'M41';
    const loose0 = await s.loose();
    s.calls.length = 0;
    await settleOnce('m41');
    assert.ok(s.calls.some((c) => c.args.includes('-w')), `M41 passes -w: ${s.calls.map((c) => c.args.join(' ')).join(' | ')}`);
    const loose1 = await s.loose();
    assert.ok(loose1.count > loose0.count || loose1.size > loose0.size, 'M41 wrote the loose object the clean settle must not');

    process.env['COWORK_TEST_MUTANT'] = '';
    const looseClean0 = await s.loose();
    s.calls.length = 0;
    await settleOnce('clean');
    assert.ok(s.calls.length >= 1 && !s.calls.some((c) => c.args.includes('-w') || namesWorkFile(c.args)), 'a clean settle: stdin, no -w, no working file');
    assert.deepEqual(await s.loose(), looseClean0, 'a clean settle writes no object');
  } finally {
    if (prev === undefined) delete process.env['COWORK_TEST_MUTANT']; else process.env['COWORK_TEST_MUTANT'] = prev;
    await s.cleanup();
  }
});

test('real atomic-replace saves (Node rename replace): none fails with no hook read in progress; saves and reads racing keep both sides landing', T10, async () => {
  const s = await makeSnapFixture('hookread-saves-rename', { files: { 'big.py': Buffer.from('rename\n'.repeat(8_192), 'utf8') } });
  try {
    const abs = s.abs('big.py');
    const one = (i: number): Buffer => Buffer.from(`rename ${i}\n`.repeat(8_192), 'utf8');
    const saveOnce = async (i: number): Promise<boolean> => {
      const tmp = `${abs}.save`;
      try {
        await fsp.writeFile(tmp, one(i));
        await fsp.rename(tmp, abs);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
        throw e;
      }
    };

    // The control arm (the plan's ≤ 1 per 1,000 budget): 3,000 saves with no hook read in progress.
    let controlFailures = 0;
    for (let i = 0; i < 3_000; i++) if (!(await saveOnce(i))) controlFailures += 1;
    assert.equal(controlFailures, 0, 'no save fails with no hook read in progress');

    // The concurrent arm (W1): saves and hook reads race. On this platform a replace collides with an
    // in-flight read's open handle (EPERM, counted): both sides keep landing, and the failures stay under the measured
    // bound B3 (a longer-held read handle exceeds it). 06 test 46's budget itself is the soak arm below.
    let successes = 0;
    let reads = 0;
    for (let i = 0; i < 500; i++) {
      const w = saveOnce(3_000 + i);
      w.catch(() => undefined);                                 // the failure is counted below, not unhandled
      const read = await shortRead(s.fs, abs);
      await w;
      if (read.kind === 'ok' || read.kind === 'unstable') reads += 1;
      if (await w) successes += 1;
    }
    console.log(JSON.stringify({ hookReadSaves: 'test 3', failures: 500 - successes, reads, controlFailures, B3 }));   // calibration
    assert.ok(reads >= 450, `the hook reads kept landing: ${reads}`);
    assert.ok(500 - successes <= B3, `the saves kept landing: at most B3 = ${B3} of 500 fail against the racing reads: ${500 - successes}`);
  } finally {
    await s.cleanup();
  }
});

// ---- 06 test 46's budget: the arithmetic (default suite) and the soak arm (COWORK_SOAK=1, windows-latest) ----------

/** 06 test 46 / plan:2960 / glossary §26.1 W3: ≥ 3,000 saves per arm; daemon-attributable failures (the daemon arm's
 *  minus the daemon-off control's) ≤ 3 (≤ 1 per 1,000); no daemon-arm EPERM while no hook read is in progress. */
function saveBudgetVerdict(r: { saves: number; daemonFailures: number; controlFailures: number; outsideRead: number }): { pass: boolean; attributable: number; why: string[] } {
  const attributable = r.daemonFailures - r.controlFailures;
  const why: string[] = [];
  if (r.saves < 3_000) why.push(`${r.saves} saves per arm < 3,000`);
  if (attributable > 3) why.push(`${attributable} daemon-attributable save failures > 3 (≤ 1 per 1,000)`);
  if (r.outsideRead !== 0) why.push(`${r.outsideRead} daemon-arm EPERM with no hook read in progress`);
  return { pass: why.length === 0, attributable, why };
}

test('the 06 test 46 budget arithmetic', () => {
  assert.deepEqual(saveBudgetVerdict({ saves: 3_000, daemonFailures: 4, controlFailures: 1, outsideRead: 0 }), { pass: true, attributable: 3, why: [] });
  assert.equal(saveBudgetVerdict({ saves: 3_000, daemonFailures: 5, controlFailures: 1, outsideRead: 0 }).pass, false, '4 attributable > 3');
  assert.equal(saveBudgetVerdict({ saves: 3_000, daemonFailures: 0, controlFailures: 0, outsideRead: 1 }).pass, false, 'an EPERM outside a read');
  assert.equal(saveBudgetVerdict({ saves: 2_999, daemonFailures: 0, controlFailures: 0, outsideRead: 0 }).pass, false, 'fewer than 3,000 saves per arm');
});

/** A uniform integer in [lo, hi] from a seeded Random (4 bytes per draw). */
const uniform = (rnd: Random, lo: number, hi: number): number => lo + Math.floor((Buffer.from(rnd.bytes(4)).readUInt32LE(0) / 0x1_0000_0000) * (hi - lo + 1));

/** An Fs over the fixture's that tracks the readFile calls of one file: in flight now, and started so far. */
class OverlapFs implements Fs {
  inFlight = 0;
  started = 0;
  constructor(private readonly inner: Fs, private readonly probed: string) { }
  async readFile(p: string): Promise<Buffer> {
    if (p !== this.probed) return this.inner.readFile(p);
    this.inFlight += 1;
    this.started += 1;
    try {
      return await this.inner.readFile(p);
    } finally {
      this.inFlight -= 1;
    }
  }
  async lstat(p: string): Promise<FsLstat | null> { return this.inner.lstat(p); }
  async writeFile(p: string, d: Buffer): Promise<void> { return this.inner.writeFile(p, d); }
  async rename(f: string, t: string): Promise<void> { return this.inner.rename(f, t); }
  async link(e: string, n: string): Promise<void> { return this.inner.link(e, n); }
  async unlink(p: string): Promise<void> { return this.inner.unlink(p); }
  async writeFileExclusive(p: string, d: Buffer, m?: number): Promise<void> { return this.inner.writeFileExclusive(p, d, m); }
  async rmdir(p: string): Promise<void> { return this.inner.rmdir(p); }
  async appendFile(p: string, d: Buffer): Promise<void> { return this.inner.appendFile(p, d); }
  async chmod(p: string, m: number): Promise<void> { return this.inner.chmod(p, m); }
  async stat(p: string) { return this.inner.stat(p); }
  async mkdirp(p: string, m?: number): Promise<void> { return this.inner.mkdirp(p, m); }
  async readdir(p: string): Promise<string[]> { return this.inner.readdir(p); }
  async rmrf(p: string): Promise<void> { return this.inner.rmrf(p); }
  async realpath(p: string): Promise<string> { return this.inner.realpath(p); }
  async freeBytes(d: string): Promise<number | null> { return this.inner.freeBytes(d); }
}

const SOAK_SAVES = 3_000;
const SOAK_PAIRS = 500;
const SOAK_TXNS = 50;
const SOAK_SKIP: string | false = process.env['COWORK_SOAK'] !== '1'
  ? 'COWORK_SOAK=1 only — the Plan 5 exit run on windows-latest (R-F2-6)'
  : process.platform !== 'win32' ? 'windows only (MoveFileEx replace, glossary §26 W3)' : false;

test('06 test 46 soak arm: 3,000 real atomic-replace saves per arm every 1–5 s, the daemon arm under 500 Pre/Post pairs and 50 TXNs, against a daemon-off control of equal length (budget ≤ 3 attributable failures)', { skip: SOAK_SKIP, timeout: 5 * 3_600_000 }, async () => {
  const s = await makeSnapFixture('hookread-soak', { files: { 'big.py': BIG, 'control.py': BIG } });
  try {
    const t0 = Date.now();
    const clock = new VirtualClock({ startMono: 0 });
    const snaps = new DiskSnapshots(s.repo, s.fs, s.stage, CAP);
    const leases = new LeaseTable(clock, new TraceRecorder(), snaps);
    const bigAbs = s.abs('big.py');
    const fs = new OverlapFs(s.fs, bigAbs);
    const loose0 = await s.loose();
    s.calls.length = 0;
    // Both arms' save schedules are fixed up front: gaps uniform in [1,000, 5,000] ms, one seeded stream per arm.
    const gapsOf = (arm: string): number[] => {
      const rnd = seededRandom(`hookread-soak-${arm}`);
      return Array.from({ length: SOAK_SAVES }, () => uniform(rnd, 1_000, 5_000));
    };
    const daemonGaps = gapsOf('daemon');
    const controlGaps = gapsOf('control');
    const duration = daemonGaps.reduce((a, b) => a + b, 0);

    interface ArmResult { attempted: number; failures: Map<string, number>; outsideRead: number; lines: string[]; }
    const saveArm = async (path: string, gaps: readonly number[], overlapOf: ((at: { inFlight: number; started: number }) => boolean) | null): Promise<ArmResult> => {
      const abs = s.abs(path);
      const r: ArmResult = { attempted: 0, failures: new Map(), outsideRead: 0, lines: [] };
      for (let i = 0; i < gaps.length; i++) {
        await sleep(gaps[i]!);
        await fsp.writeFile(`${abs}.save`, variant(BIG, i));
        const before = { inFlight: fs.inFlight, started: fs.started };
        r.attempted += 1;
        try {
          await fsp.rename(`${abs}.save`, abs);                  // MoveFileEx replace on Windows
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
          r.failures.set(code, (r.failures.get(code) ?? 0) + 1);
          const overlap = overlapOf === null ? false : overlapOf(before) || fs.inFlight > 0 || fs.started > before.started;
          if (overlapOf !== null && code === 'EPERM' && !overlap) r.outsideRead += 1;
          r.lines.push(JSON.stringify({ arm: path, save: i, code, overlap, msSinceStart: Date.now() - t0 }));
        }
      }
      return r;
    };

    // The daemon arm's load: 500 Pre/Post pairs and 50 TXNs at instants uniform over the arm's duration, each closed
    // 1–5 s later (real time), all on big.py, through the production read/snapshot/lease calls.
    const loadRnd = seededRandom('hookread-soak-load');
    const events = [
      ...Array.from({ length: SOAK_PAIRS }, (_, i) => ({ at: uniform(loadRnd, 0, duration - 1), kind: 'pair' as const, id: `tu${i}`, hold: uniform(loadRnd, 1_000, 5_000) })),
      ...Array.from({ length: SOAK_TXNS }, (_, i) => ({ at: uniform(loadRnd, 0, duration - 1), kind: 'txn' as const, id: `tx${i}`, hold: uniform(loadRnd, 1_000, 5_000) })),
    ].sort((a, b) => a.at - b.at);
    const snapshotOf = async (read: ShortRead): Promise<void> => {
      if (read.kind === 'unreadable') return;
      await snaps.release(await snaps.take('big.py', read));
    };
    const pair = async (id: string, holdMs: number): Promise<void> => {
      const pre = await shortRead(fs, bigAbs);                     // the gate's Pre read
      const h = pre.kind === 'ok' || pre.kind === 'unstable' ? snaps.hold('big.py', pre) : null;
      leases.acquireInflight({ toolUseId: id, seatId: 's1', agentId: null, sessionId: 's1', path: 'big.py', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: h, view: null, tentative: null });
      if (h !== null) leases.setPre(id, await snaps.settle(h));    // after the reply
      await sleep(holdMs);
      await snapshotOf(await shortRead(fs, bigAbs));              // the Post's post-image
      leases.release(id, 'post');
    };
    const txn = async (id: string, holdMs: number): Promise<void> => {
      leases.openTxn(openTxnOf(id));
      await sleep(holdMs);
      await snapshotOf(await shortRead(fs, bigAbs));              // the TXN close read
      leases.release(id, 'post');
    };
    const load = async (): Promise<void> => {
      const running: Array<Promise<void>> = [];
      for (const ev of events) {
        const wait = ev.at - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
        running.push(ev.kind === 'pair' ? pair(ev.id, ev.hold) : txn(ev.id, ev.hold));
      }
      await Promise.all(running);
    };

    const [daemon, control] = await Promise.all([
      saveArm('big.py', daemonGaps, (at) => at.inFlight > 0),
      saveArm('control.py', controlGaps, null),
      load(),
    ]);
    const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
    const verdict = saveBudgetVerdict({ saves: Math.min(daemon.attempted, control.attempted), daemonFailures: sum(daemon.failures), controlFailures: sum(control.failures), outsideRead: daemon.outsideRead });
    console.log(JSON.stringify({
      soak: '06 test 46', platform: `${process.platform} ${process.arch}`, savesPerArm: { daemon: daemon.attempted, control: control.attempted },
      control: Object.fromEntries(control.failures), daemon: Object.fromEntries(daemon.failures), attributable: verdict.attributable,
      outsideRead: daemon.outsideRead, reads: fs.started, pairs: SOAK_PAIRS, txns: SOAK_TXNS, durationMs: Date.now() - t0, verdict: verdict.why,
    }));
    for (const line of [...daemon.lines, ...control.lines]) console.log(line);

    assert.equal(daemon.attempted, SOAK_SAVES);
    assert.equal(control.attempted, SOAK_SAVES);
    assert.ok(verdict.pass, verdict.why.join('; '));
    for (const c of s.calls) {
      assert.ok(!c.args.includes('-w'), `no -w on a hook read: ${c.args.join(' ')}`);
      assert.ok(!namesWorkFile(c.args), `no argv names the working file: ${c.args.join(' ')}`);
    }
    assert.deepEqual(await s.loose(), loose0, 'loose objects unchanged by the hook reads');
    assert.equal(snaps.bytesHeld(), 0, 'every hold ended');
    await snaps.drain();
    assert.equal(snaps.stats().entries, 0, 'every snapshot was released');
  } finally {
    await s.cleanup();
  }
});
