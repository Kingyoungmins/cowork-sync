// test/unit/claude.hookRead.test.ts — short reads and disk snapshots (CCI-55, glossary §26.1 W1–W3, W6, 01 §3.8,
// REG-35, R5-26, A8-1, A8-7): the lstat-bracketed single read with one re-read, the unstable result's second bytes
// (unlike Plan 2's stagedRead), the memory-only hold and the stdin route-(b) settle without -w, the 64 MB cap with
// the spill under tmp/stage/, the W2 shrink rule, the EOL/BOM normalization, and the M40/M41 mutant sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { shortRead, DiskSnapshots, emptyOrShrunk, normalizedEqual, type DiskSnapshot, type HeldRead } from '../../src/claude/daemon/hookRead.js';
import { LeaseTable, type InflightLease } from '../../src/claude/daemon/leases.js';
import { C } from '../../src/claude/wire/constants.js';
import { stagedRead, StageDir } from '../../src/engine/stagedRead.js';
import { hashRouteBStdin, isFilterFailure } from '../../src/data/blobRoutes.js';
import { realFs, type Fs, type FsLstat } from '../../src/ports/fs.js';
import { GitRepo } from '../../src/git/repo.js';
import { ABSENT, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRunner } from '../../src/git/runner.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { makeTempRoot, testRunner } from '../helpers/tmp.js';
import { FaultFs } from '../sim/faultfs.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';

// A scripted Fs over realFs that records `lstat`/`readFile` calls and runs a hook after the n-th readFile.
class SeqFs implements Fs {
  readonly calls: string[] = [];
  private readonly afterRead: Array<{ n: number; fn: () => Promise<void> }> = [];
  private reads = 0;
  constructor(private readonly inner: Fs) { }
  onAfterRead(n: number, fn: () => Promise<void>): void { this.afterRead.push({ n, fn }); }
  async readFile(p: string): Promise<Buffer> {
    const b = await this.inner.readFile(p);
    this.calls.push(`readFile ${p}`);
    this.reads += 1;
    const h = this.afterRead.find((x) => x.n === this.reads);
    if (h !== undefined) await h.fn();
    return b;
  }
  async lstat(p: string): Promise<FsLstat | null> { this.calls.push(`lstat ${p}`); return this.inner.lstat(p); }
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

const B10 = Buffer.from('0123456789', 'utf8');
const B12 = Buffer.from('0123456789ab', 'utf8');
const B14 = Buffer.from('0123456789abcd', 'utf8');

async function tempFile(label: string, bytes: Buffer): Promise<{ root: string; abs: string; cleanup(): Promise<void> }> {
  const { root, cleanup } = await makeTempRoot(label);
  const abs = join(root, 'work', 'a.ts');
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return { root, abs, cleanup };
}

test('shortRead is one read call bracketed by lstat, with one re-read; never more than two readFile calls', async () => {
  const { abs, cleanup } = await tempFile('shortread-ok', B10);
  try {
    const fs = new SeqFs(realFs);
    const r = await shortRead(fs, abs);
    assert.deepEqual(fs.calls, [`lstat ${abs}`, `readFile ${abs}`, `lstat ${abs}`]);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.ok(r.bytes.equals(B10));
  } finally { await cleanup(); }
});

test('a changed (size, mtimeNs) at the second lstat buys exactly one re-read; stable then ok with the second bytes, changed again unstable with them', async () => {
  const { abs, cleanup } = await tempFile('shortread-re', B10);
  try {
    // One re-read, then stable: the file grows right after read 1 (before the second lstat).
    const fs = new SeqFs(realFs);
    fs.onAfterRead(1, async () => { await writeFile(abs, B12); });
    const r = await shortRead(fs, abs);
    assert.deepEqual(fs.calls, [`lstat ${abs}`, `readFile ${abs}`, `lstat ${abs}`, `readFile ${abs}`, `lstat ${abs}`]);
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') assert.ok(r.bytes.equals(B12), 'the result is the second read');
    assert.equal(fs.calls.filter((c) => c.startsWith('readFile')).length, 2, 'at most two readFile calls');

    // Changed again after the re-read: unstable, carrying the second read's bytes.
    const fs2 = new SeqFs(realFs);
    fs2.onAfterRead(1, async () => { await writeFile(abs, B12); });
    fs2.onAfterRead(2, async () => { await writeFile(abs, B14); });
    const r2 = await shortRead(fs2, abs);    assert.equal(r2.kind, 'unstable');
    if (r2.kind === 'unstable') assert.ok(r2.bytes.equals(B12), 'the unstable result carries the second read');
    assert.equal(fs2.calls.filter((c) => c.startsWith('readFile')).length, 2);
  } finally { await cleanup(); }
});

test('ENOENT is missing; EACCES and EBUSY are unreadable (06 §3.7.6)', async () => {
  const { root, abs, cleanup } = await tempFile('shortread-fault', B10);
  try {
    assert.deepEqual(await shortRead(realFs, join(root, 'work', 'gone.ts')), { kind: 'missing' });
    const fsL = new FaultFs(realFs);
    fsL.addRule({ op: 'lstat', pathIncludes: abs, code: 'EACCES', times: 1 });
    assert.deepEqual(await shortRead(fsL, abs), { kind: 'unreadable' });
    const fsR = new FaultFs(realFs);
    fsR.addRule({ op: 'readFile', pathIncludes: abs, code: 'EBUSY', times: 1 });
    assert.deepEqual(await shortRead(fsR, abs), { kind: 'unreadable' });
  } finally { await cleanup(); }
});

/** SeqFs whose n-th readFile (1-based, per instance) returns the bytes minus their last byte (lstat unchanged). */
class TrimFs extends SeqFs {
  private n = 0;
  constructor(inner: Fs, private readonly trimOn: ReadonlySet<number>) { super(inner); }
  override async readFile(p: string): Promise<Buffer> {
    const b = await super.readFile(p);
    this.n += 1;
    return this.trimOn.has(this.n) ? b.subarray(0, b.length - 1) : b;
  }
}

/** SeqFs whose readFile throws an errno error with `code` (a race between the lstat and the read). */
class ThrowReadFs extends SeqFs {
  constructor(inner: Fs, private readonly code: string) { super(inner); }
  override async readFile(p: string): Promise<Buffer> {
    this.calls.push(`readFile ${p}`);
    throw Object.assign(new Error(`${this.code}: illegal operation, read '${p}'`), { code: this.code, syscall: 'read', path: p });
  }
}

test("a directory, a symlink and a junction are unreadable: never read, never thrown (stagedRead's rule, R5-26)", async (t) => {
  const { root, abs, cleanup } = await tempFile('shortread-links', B10);
  try {
    const dir = join(root, 'work', 'd');
    await mkdir(dir, { recursive: true });
    await t.test('a directory', async () => {
      const fs = new SeqFs(realFs);
      assert.deepEqual(await shortRead(fs, dir), { kind: 'unreadable' });
      assert.deepEqual(fs.calls, [`lstat ${dir}`], 'one lstat, no readFile');
      assert.equal((await stagedRead(realFs, dir)).kind, 'unreadable', 'stagedRead parity');
    });
    await t.test('a file symlink', async (st) => {
      const link = join(root, 'work', 'file-link.ts');
      try {
        await symlink(abs, link, 'file');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') { st.skip('creating a file symlink needs a privilege on this PC'); return; }
        throw e;
      }
      const fs = new SeqFs(realFs);
      assert.deepEqual(await shortRead(fs, link), { kind: 'unreadable' }, 'the link is never followed');
      assert.deepEqual(fs.calls, [`lstat ${link}`], 'one lstat, no readFile');
      assert.equal((await stagedRead(realFs, link)).kind, 'unreadable', 'stagedRead parity');
    });
    await t.test('a junction (a directory symlink off Windows)', async () => {
      const link = join(root, 'work', 'dir-link');
      await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
      const fs = new SeqFs(realFs);
      assert.deepEqual(await shortRead(fs, link), { kind: 'unreadable' });
      assert.deepEqual(fs.calls, [`lstat ${link}`], 'one lstat, no readFile');
      assert.equal((await stagedRead(realFs, link)).kind, 'unreadable', 'stagedRead parity');
    });
  } finally { await cleanup(); }
});

test('a byte length that differs from the after-stat size is re-read once, then unstable', async () => {
  const { abs, cleanup } = await tempFile('shortread-len', B10);
  try {
    const both = new TrimFs(realFs, new Set([1, 2]));
    const r = await shortRead(both, abs);
    assert.equal(r.kind, 'unstable', 'short on both reads (lstats unchanged): unstable');
    if (r.kind === 'unstable') assert.ok(r.bytes.equals(B10.subarray(0, 9)), 'the unstable result carries the second read');
    assert.equal(both.calls.filter((c) => c.startsWith('readFile')).length, 2, 'at most two readFile calls');

    const first = new TrimFs(realFs, new Set([1]));
    const r2 = await shortRead(first, abs);
    assert.equal(r2.kind, 'ok', 'short on read 1 only: the re-read is whole');
    if (r2.kind === 'ok') assert.ok(r2.bytes.equals(B10), 'ok with the second read');
    assert.equal(first.calls.filter((c) => c.startsWith('readFile')).length, 2);
  } finally { await cleanup(); }
});

test('a readFile EISDIR or ELOOP race is unreadable', async () => {
  const { abs, cleanup } = await tempFile('shortread-race', B10);
  try {
    assert.deepEqual(await shortRead(new ThrowReadFs(realFs, 'EISDIR'), abs), { kind: 'unreadable' });
    assert.deepEqual(await shortRead(new ThrowReadFs(realFs, 'ELOOP'), abs), { kind: 'unreadable' });
  } finally { await cleanup(); }
});

test("an unstable read carries the second read's bytes, unlike Plan 2's stagedRead", async () => {
  const { abs, cleanup } = await tempFile('shortread-vs-staged', B10);
  try {
    // shortRead: changed after read 1 and after the re-read → unstable, with the second read's bytes.
    const fs = new SeqFs(realFs);
    fs.onAfterRead(1, async () => { await writeFile(abs, B12); });
    fs.onAfterRead(2, async () => { await writeFile(abs, B14); });
    const sr = await shortRead(fs, abs);
    assert.equal(sr.kind, 'unstable');
    if (sr.kind === 'unstable') assert.ok(sr.bytes.equals(B12), 'shortRead carries the second read');

    // stagedRead over the same script: unstable, but never with bytes (Plan 2's shape).
    const fs2 = new SeqFs(realFs);
    fs2.onAfterRead(1, async () => { await writeFile(abs, B12); });
    fs2.onAfterRead(2, async () => { await writeFile(abs, B14); });
    await writeFile(abs, B10);                                      // back to the start bytes for the second rig
    const st = await stagedRead(fs2, abs);
    assert.equal(st.kind, 'unstable');
    assert.equal(st.kind === 'unstable' ? 'bytes' in st : false, false, 'stagedRead carries no bytes');
  } finally { await cleanup(); }
});

const spyOn = (runner: GitRunner, seen: Array<{ args: string[]; opts: GitCallOptions }>): GitRunner => ({
  run(args, opts) {
    seen.push({ args: [...args], opts: { ...opts } });
    return runner.run(args, opts);
  },
});

async function looseCount(repo: GitRepo): Promise<number> {
  const out = (await repo.run(['count-objects', '-v'])).stdout.toString('utf8');
  const m = /^count: (\d+)$/m.exec(out);
  assert.ok(m, out);
  return Number(m[1]);
}

test('hold is memory only; settle hashes by route (b) from stdin without -w, exactly one call at the repo root', async () => {
  const f = await makeRepoFixture('hookread-settle', { autocrlf: false });
  try {
    const seen: Array<{ args: string[]; opts: GitCallOptions }> = [];
    const repo = new GitRepo(spyOn(f.runner, seen), f.paths, fixtureContext);
    const stage = new StageDir(realFs, join(f.paths.coworkDir, 'tmp', 'stage'));
    const snaps = new DiskSnapshots(repo, realFs, stage, 67_108_864);
    const bytes = Buffer.from('one\r\ntwo\r\nthree\r\n', 'utf8');
    const stat = await realFs.lstat(f.paths.workTree) as FsLstat;   // any real stat works: settle never stats
    const objects = await looseCount(f.repo);
    const h = snaps.hold('src/a.ts', { kind: 'ok', bytes, stat });
    assert.equal(snaps.bytesHeld(), bytes.length, 'the hold counts its bytes');
    assert.equal(seen.length, 0, 'hold spawns no git process');
    const s = await snaps.settle(h);
    assert.equal(snaps.bytesHeld(), 0, 'settle consumes its hold');
    assert.equal(seen.length, 1, 'exactly one git call');
    const call = seen[0]!;
    assert.equal(call.args[0], 'hash-object');
    assert.ok(call.args.includes('--stdin'));
    assert.ok(call.args.includes('--path=src/a.ts'));
    assert.ok(!call.args.includes('-w'), 'no object written on a hook read');
    assert.equal(call.opts.cwd, f.paths.workTree, 'run at the repository root');
    assert.equal(call.opts.class, 'attr');
    const want = (await testRunner().run(['hash-object', '--stdin', '--path=src/a.ts'], { class: 'attr', cwd: f.paths.workTree, stdin: bytes })).stdout.toString('utf8').trim();
    assert.equal(s.oid, want, 'the oid equals hash-object --path of the bytes');
    assert.ok(s.bytes !== null && s.bytes.equals(bytes), 'the bytes stay in memory');
    assert.equal(s.spill, null);
    assert.ok(s.oid !== ABSENT, 'a stageable path hashed to an oid');
    assert.equal(await f.repo.hasObject(s.oid as Oid, 'blob'), false, 'no object was stored');
    assert.equal(snaps.get('src/a.ts', s.oid) !== null, true, 'cached by (path, oid)');
    assert.equal(await looseCount(f.repo), objects, 'count-objects is unchanged');
  } finally { await f.cleanup(); }
});

test('hashRouteBStdin applies attributes and filters through --path and fails closed; write: true stores', async () => {
  // Attributes through --path: a CRLF file on a core.autocrlf=true clone is stored with LF rows.
  const f = await makeRepoFixture('hookread-routeb', { autocrlf: true });
  try {
    const crlf = Buffer.from('alpha\r\nbeta\r\n', 'utf8');
    const id = await hashRouteBStdin(f.repo, crlf, 'src/a.txt', true);
    assert.ok(!isFilterFailure(id));
    if (isFilterFailure(id)) return;
    const lf = await f.repo.hashBytes(Buffer.from('alpha\nbeta\n', 'utf8'), false);
    assert.equal(id, lf, 'the attribute driver normalized CRLF through --path');
    assert.notEqual(id, await f.repo.hashBytes(crlf, false), 'not the raw bytes');
    assert.equal(await f.repo.hasObject(id, 'blob'), true, 'write: true stored the object');
  } finally { await f.cleanup(); }

  // A failing required filter fails closed: a FilterFailure and no object.
  const g = await makeRepoFixture('hookread-filter', { autocrlf: false });
  try {
    await g.repo.run(['config', 'filter.bad.clean', 'node -e "process.exit(1)"']);
    await g.repo.run(['config', 'filter.bad.required', 'true']);
    await writeFile(join(g.paths.workTree, '.gitattributes'), '*.sec filter=bad\n');
    const bytes = Buffer.from('k=REAL v2\n', 'utf8');
    const r = await hashRouteBStdin(g.repo, bytes, 'keys.sec', false);
    assert.deepEqual(r, { failed: 'filter', path: 'keys.sec' });
    assert.equal(isFilterFailure(r), true);
  } finally { await g.cleanup(); }
});

test('DiskSnapshots keeps 64 MB in memory and spills the rest under tmp/stage/; release deletes the spill file', async () => {
  const f = await makeRepoFixture('hookread-spill', { autocrlf: false });
  try {
    const stage = new StageDir(realFs, join(f.paths.coworkDir, 'tmp', 'stage'));
    const snaps = new DiskSnapshots(f.repo, realFs, stage, 67_108_864);
    const MiB = 1024 * 1024;
    const stat = await realFs.lstat(f.paths.workTree) as FsLstat;
    const snaps6: Array<{ path: string; bytes: Buffer; s: Awaited<ReturnType<DiskSnapshots['settle']>> }> = [];
    for (let i = 0; i < 6; i++) {
      const bytes = Buffer.alloc(12 * MiB, i + 1);
      const h = snaps.hold(`src/g${i}.ts`, { kind: 'ok', bytes, stat });
      assert.ok(snaps.bytesHeld() <= 67_108_864 + bytes.length, 'the holds stay bounded by their own cap accounting');
      const s = await snaps.settle(h);
      assert.equal(snaps.bytesHeld(), 0, 'each settle consumes its hold');
      snaps6.push({ path: `src/g${i}.ts`, bytes, s });
    }
    for (let i = 0; i < 5; i++) {
      const e = snaps6[i]!;
      assert.ok(e.s.bytes !== null && e.s.bytes.equals(e.bytes), `${e.path} stayed in memory`);
      assert.equal(e.s.spill, null);
    }
    const last = snaps6[5]!;
    assert.equal(last.s.bytes, null, 'the sixth 12 MiB snapshot spilled');
    assert.ok(last.s.spill !== null && last.s.spill.startsWith(`${join(f.paths.coworkDir, 'tmp', 'stage')}/.cowork-snap-spill`), `spilled under tmp/stage: ${String(last.s.spill)}`);
    assert.ok((await snaps.bytesOf(last.s)).equals(last.bytes), 'bytesOf returns identical bytes');
    await snaps.release(last.s);
    assert.equal(snaps.get(last.path, last.s.oid), null, 'the cache entry went with the spill file');
    assert.equal(await realFs.lstat(last.s.spill!), null, 'the spill file is deleted');
  } finally { await f.cleanup(); }
});

// ---- DiskSnapshots ownership (06 §3.7.1, R5-26; F2 #47, #105, #75, #64) -------------------------------------------

/** A GitRunner answering `hash-object` from stdin in process (the git blob SHA-1 of the bytes) and recording each call:
 *  the cycle cells' fast hash (no git process). */
const fakeHashRunner = (seen: string[][]): GitRunner => ({
  run(args, opts) {
    seen.push([...args]);
    const bytes = opts.stdin ?? Buffer.alloc(0);
    const oid = createHash('sha1').update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex');
    return Promise.resolve({ code: 0, stdout: Buffer.from(`${oid}\n`, 'utf8'), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 });
  },
});

interface FakeSnaps { f: RepoFixture; snaps: DiskSnapshots; spillDir: string; seen: string[][]; stat: FsLstat; }

/** DiskSnapshots over a fixture repo whose git runner is fakeHashRunner. */
async function fakeSnaps(label: string, cap: number): Promise<FakeSnaps> {
  const f = await makeRepoFixture(label, { autocrlf: false });
  const seen: string[][] = [];
  const repo = new GitRepo(fakeHashRunner(seen), f.paths, fixtureContext);
  const stage = new StageDir(realFs, join(f.paths.coworkDir, 'tmp', 'stage'));
  const snaps = new DiskSnapshots(repo, realFs, stage, cap);
  const stat = await realFs.lstat(f.paths.workTree) as FsLstat;   // any real stat works: settle never stats
  return { f, snaps, spillDir: `${stage.root}/.cowork-snap-spill`, seen, stat };
}

/** The spill files on disk (an absent directory holds none). */
async function spillCount(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

const SEAT = 's'.repeat(32);
const inflOf = (toolUseId: string, preHeld: HeldRead | null): Omit<InflightLease, 'kind' | 'acquiredMono'> =>
  ({ toolUseId, seatId: SEAT, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld, view: null, tentative: null });

test('1,000 Pre/Post cycles keep held bytes, memory and spill files bounded and every image is deleted at release (06 §3.7.1)', async () => {
  const { f, snaps, spillDir, stat } = await fakeSnaps('hookread-cycles', 150 * 1024);
  try {
    const clock = new VirtualClock({ startMono: 0 });
    const leases = new LeaseTable(clock, new TraceRecorder(), snaps);
    /** 100 KiB, distinct per (cycle, side). */
    const distinct = (i: number, side: number): Buffer => {
      const b = Buffer.alloc(100 * 1024, 0x61 + (i % 26));
      b.writeUInt32BE(i, 0);
      b.writeUInt8(side, 4);
      return b;
    };
    let firstPreOid: OidOrAbsent | null = null;
    for (let i = 0; i < 1_000; i++) {
      const h = snaps.hold('src/a.ts', { kind: 'ok', bytes: distinct(i, 1), stat });      // the gate's Pre read
      leases.acquireInflight(inflOf(`tu${i}`, h));
      const pre = await snaps.settle(h);                                                  // after the reply
      if (i === 0) firstPreOid = pre.oid;
      leases.setPre(`tu${i}`, pre);
      const post = await snaps.take('src/a.ts', { kind: 'ok', bytes: distinct(i, 2), stat });   // the Post's post-image
      assert.ok(post.spill !== null, `cycle ${i}: the post-image spilled (100 + 100 KiB > the 150 KiB cap)`);
      await snaps.release(post);
      leases.release(`tu${i}`, 'post');
      assert.equal(snaps.bytesHeld(), 0, `cycle ${i}: no held bytes are left`);
      assert.equal(await spillCount(spillDir), 0, `cycle ${i}: no spill file is left`);
    }
    assert.equal(snaps.get('src/a.ts', firstPreOid!), null, 'the first pre-image is gone');
    await snaps.drain();
    assert.deepEqual(snaps.stats(), { heldBytes: 0, memBytes: 0, entries: 0, spilled: 0, pending: 0 });
  } finally { await f.cleanup(); }
});

test("two holders of identical bytes keep their own spill: releasing one never deletes the other's", async () => {
  const { f, snaps, stat } = await fakeSnaps('hookread-shared', 0);
  try {
    const B = Buffer.from('shared bytes\n'.repeat(64), 'utf8');
    const ok = { kind: 'ok' as const, bytes: B, stat };
    const a = await snaps.take('src/a.ts', ok);
    const b = await snaps.take('src/b.ts', ok);
    assert.ok(a.spill !== null && b.spill !== null, 'cap 0: both spilled');
    await snaps.release(a);
    assert.ok((await snaps.bytesOf(b)).equals(B), "releasing a never deletes b's bytes");
    assert.notEqual(a.spill, b.spill, 'one spill file per entry');
    const s1 = await snaps.take('src/c.ts', ok);
    const s2 = await snaps.take('src/c.ts', ok);
    assert.equal(s1, s2, 'the same (path, bytes) is one entry with two references');
    await snaps.release(s1);
    assert.ok((await snaps.bytesOf(s2)).equals(B), 'one reference is left: the bytes stay');
    await snaps.release(s2);
    assert.equal(await realFs.lstat(s2.spill!), null, 'the last release deletes its spill file');
    assert.equal(snaps.get('src/c.ts', s2.oid), null, 'and its cache rows');
    await snaps.release(s2);                                          // a released (stale) object: a no-op
    await snaps.release(b);
    await snaps.drain();
    assert.equal(snaps.stats().entries, 0);
  } finally { await f.cleanup(); }
});

test('concurrent settles of one read hash once and count its bytes once', async () => {
  const f = await makeRepoFixture('hookread-concurrent', { autocrlf: false });
  try {
    const seen: Array<{ args: string[]; opts: GitCallOptions }> = [];
    const repo = new GitRepo(spyOn(f.runner, seen), f.paths, fixtureContext);
    const stage = new StageDir(realFs, join(f.paths.coworkDir, 'tmp', 'stage'));
    const snaps = new DiskSnapshots(repo, realFs, stage, 67_108_864);
    const stat = await realFs.lstat(f.paths.workTree) as FsLstat;
    const bytes = Buffer.from('concurrent settles\n', 'utf8');
    const r = { kind: 'ok' as const, bytes, stat };
    const [x, y] = await Promise.all([snaps.settle(snaps.hold('src/a.ts', r)), snaps.settle(snaps.hold('src/a.ts', r))]);
    assert.equal(seen.length, 1, 'one git call for both settles');
    assert.equal(x, y, 'both settles got the same entry');
    assert.equal(snaps.bytesHeld(), 0, 'both holds were consumed');
    assert.equal(snaps.stats().memBytes, bytes.length, 'its bytes are counted once');
    await snaps.release(x);
    assert.equal(snaps.stats().memBytes, bytes.length, 'each settle got its own reference: one is left');
    await snaps.release(y);
    assert.deepEqual(snaps.stats(), { heldBytes: 0, memBytes: 0, entries: 0, spilled: 0, pending: 0 }, 'two releases free it');
  } finally { await f.cleanup(); }
});

test('a memory-held snapshot is evicted at its release (the cap is reusable)', async () => {
  const { f, snaps, stat } = await fakeSnaps('hookread-evict', 67_108_864);
  try {
    const MiB = 1024 * 1024;
    const six: DiskSnapshot[] = [];
    for (let i = 0; i < 6; i++) six.push(await snaps.settle(snaps.hold(`src/g${i}.ts`, { kind: 'ok', bytes: Buffer.alloc(12 * MiB, i + 1), stat })));
    assert.deepEqual(six.map((s) => s.spill === null), [true, true, true, true, true, false], 'five in memory, the sixth spilled');
    for (const s of six) await snaps.release(s);
    const seventh = await snaps.settle(snaps.hold('src/g6.ts', { kind: 'ok', bytes: Buffer.alloc(12 * MiB, 7), stat }));
    assert.equal(seventh.spill, null, 'the released memory is reusable: the seventh stays in memory');
    assert.ok(seventh.bytes !== null && seventh.bytes.length === 12 * MiB);
    await snaps.release(seventh);
    await snaps.drain();
    assert.deepEqual(snaps.stats(), { heldBytes: 0, memBytes: 0, entries: 0, spilled: 0, pending: 0 });
  } finally { await f.cleanup(); }
});

test('a non-stageable path counts against the cap', async () => {
  const { f, snaps, seen, stat } = await fakeSnaps('hookread-nonstage', 0);
  try {
    const s = await snaps.take('a\u{fffd}.ts', { kind: 'ok', bytes: B10, stat });
    assert.equal(seen.length, 0, 'no git process for a non-stageable path (W6)');
    assert.equal(s.oid, ABSENT);
    assert.ok(s.spill !== null, 'its bytes count against the cap and spill beyond it');
    assert.ok((await snaps.bytesOf(s)).equals(B10));
    await snaps.release(s);
    assert.equal(await realFs.lstat(s.spill!), null);
  } finally { await f.cleanup(); }
});

test('holds are per-call tokens: identical bytes count once, unhold is idempotent, a settle ends its hold', async () => {
  const { f, snaps, stat } = await fakeSnaps('hookread-holds', 67_108_864);
  try {
    const r = { kind: 'ok' as const, bytes: B10, stat };
    const h1 = snaps.hold('src/a.ts', r);
    const h2 = snaps.hold('src/a.ts', r);
    assert.notEqual(h1, h2, 'a new HeldRead per call');
    assert.equal(snaps.bytesHeld(), B10.length, 'identical (path, bytes) count once');
    snaps.unhold(h1);
    snaps.unhold(h1);                                                 // idempotent
    assert.equal(snaps.bytesHeld(), B10.length, "h2's hold still counts");
    const s = await snaps.settle(h2);
    assert.equal(snaps.bytesHeld(), 0, 'the settle ended the last hold');
    snaps.unhold(h2);                                                 // after its settle: a no-op
    assert.equal(snaps.bytesHeld(), 0);
    await snaps.release(s);
    assert.equal(snaps.stats().entries, 0);
  } finally { await f.cleanup(); }
});

test('retain keeps a snapshot past its first holder; a released one cannot be retained', async () => {
  const { f, snaps, stat } = await fakeSnaps('hookread-retain', 0);
  try {
    const s = await snaps.take('src/a.ts', { kind: 'ok', bytes: B12, stat });
    const kept = snaps.retain(s);                                     // e.g. Task 12's ViewBlobs keeps it past the lease
    assert.equal(kept, s);
    await snaps.release(s);                                           // the first holder's release
    assert.ok((await snaps.bytesOf(kept)).equals(B12), 'the retained reference keeps the spill');
    await snaps.release(kept);
    assert.equal(await realFs.lstat(s.spill!), null);
    assert.throws(() => snaps.retain(s), /released/, 'a stale snapshot is not retained');
    // The absence entry of a missing read is refcounted like the others.
    const m1 = await snaps.take('src/gone.ts', { kind: 'missing' });
    const m2 = await snaps.take('src/gone.ts', { kind: 'missing' });
    assert.equal(m1, m2);
    await snaps.release(m1);
    assert.equal(snaps.get('src/gone.ts', ABSENT), m2, 'one reference left');
    await snaps.release(m2);
    assert.equal(snaps.get('src/gone.ts', ABSENT), null);
  } finally { await f.cleanup(); }
});

test('a lease release returns its images; a setPre after the release frees the late snapshot', async () => {
  const { f, snaps, stat } = await fakeSnaps('hookread-lease', 67_108_864);
  try {
    const clock = new VirtualClock({ startMono: 0 });
    const leases = new LeaseTable(clock, new TraceRecorder(), snaps);
    const h = snaps.hold('src/a.ts', { kind: 'ok', bytes: B10, stat });
    leases.acquireInflight(inflOf('tu1', h));
    assert.equal(snaps.bytesHeld(), B10.length);
    leases.release('tu1', 'post');                                    // the Post lands before the gate settled its hold
    assert.equal(snaps.bytesHeld(), 0, 'the release returned the unsettled hold');
    const late = await snaps.settle(h);                               // the gate's late settle
    leases.setPre('tu1', late);                                       // the lease is gone: nobody owns the snapshot
    assert.equal(snaps.stats().entries, 0, 'the late snapshot was freed');

    // A lease with its pre set returns it at the backstop.
    const h2 = snaps.hold('src/a.ts', { kind: 'ok', bytes: B12, stat });
    leases.acquireInflight(inflOf('tu2', h2));
    leases.setPre('tu2', await snaps.settle(h2));
    assert.equal(snaps.stats().entries, 1);
    clock.advance(C.INFLIGHT_BACKSTOP_MS);
    assert.equal(leases.expire().expired.length, 1);
    assert.equal(snaps.stats().entries, 0, 'the backstop returned the pre-image');

    // A second setPre on one lease returns the lease's previous pre-image.
    const h3 = snaps.hold('src/a.ts', { kind: 'ok', bytes: B10, stat });
    leases.acquireInflight(inflOf('tu3', h3));
    leases.setPre('tu3', await snaps.settle(h3));
    leases.setPre('tu3', await snaps.take('src/a.ts', { kind: 'ok', bytes: B14, stat }));
    assert.equal(snaps.stats().entries, 1, 'the replaced pre-image was released');
    leases.releaseSeat(SEAT, { }, 'seat_end');
    assert.deepEqual(snaps.stats(), { heldBytes: 0, memBytes: 0, entries: 0, spilled: 0, pending: 0 }, 'a seat end returns every image');
  } finally { await f.cleanup(); }
});

test('emptyOrShrunk is the W2 rule', () => {
  const snap = (size: number): Parameters<typeof emptyOrShrunk>[1] => ({ path: 'p', oid: ABSENT, bytes: null, spill: null, size });
  const pre = snap(1_000);
  assert.equal(emptyOrShrunk(pre, snap(0)), true);
  assert.equal(emptyOrShrunk(pre, snap(499)), true);
  assert.equal(emptyOrShrunk(pre, snap(500)), false);
  assert.equal(emptyOrShrunk(pre, snap(1_200)), false);
  assert.equal(emptyOrShrunk(null, snap(0)), true);
  assert.equal(emptyOrShrunk(null, snap(10)), false);
});

test('normalizedEqual ignores EOL-only and BOM-only differences (A8-10)', () => {
  const bomCrlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf8')]);
  assert.equal(normalizedEqual(bomCrlf, Buffer.from('a\nb\n', 'utf8')), true);
  assert.equal(normalizedEqual(Buffer.from('a\r\nb\rc\n', 'utf8'), Buffer.from('a\nb\nc\n', 'utf8')), true, 'a lone CR is LF too');
  assert.equal(normalizedEqual(Buffer.from('a\nb\n', 'utf8'), Buffer.from('a\nc\n', 'utf8')), false);
});

test('mutant M40 hashes the working file in place; mutant M41 writes an object on a hook read', async () => {
  const f = await makeRepoFixture('hookread-mutants', { autocrlf: false });
  const prev = process.env['COWORK_TEST_MUTANT'];
  try {
    const seen: Array<{ args: string[]; opts: GitCallOptions }> = [];
    const mk = (): GitRepo => new GitRepo(spyOn(f.runner, seen), f.paths, fixtureContext);
    const abs = join(f.paths.workTree, 'src', 'a.txt');
    const bytes = Buffer.from('m0\n', 'utf8');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
    const stage = new StageDir(realFs, join(f.paths.coworkDir, 'tmp', 'stage'));
    const stat = await realFs.lstat(abs) as FsLstat;

    process.env['COWORK_TEST_MUTANT'] = 'M40';
    seen.length = 0;
    await new DiskSnapshots(mk(), realFs, stage, 67_108_864).settle(
      { path: 'src/a.txt', bytes, stat, unstable: false, size: bytes.length },
    );
    const m40 = seen[0]!;
    assert.ok(m40.args.includes('src/a.txt'), `M40's argv names the working file by its repo path: ${m40.args.join(' ')}`);

    process.env['COWORK_TEST_MUTANT'] = 'M41';
    seen.length = 0;
    await new DiskSnapshots(mk(), realFs, stage, 67_108_864).settle(
      { path: 'src/a.txt', bytes, stat, unstable: false, size: bytes.length },
    );
    assert.ok(seen[0]!.args.includes('-w'), `M41 passes -w: ${seen[0]!.args.join(' ')}`);

    process.env['COWORK_TEST_MUTANT'] = '';
    seen.length = 0;
    await new DiskSnapshots(mk(), realFs, stage, 67_108_864).settle(
      { path: 'src/a.txt', bytes, stat, unstable: false, size: bytes.length },
    );
    assert.ok(!seen[0]!.args.includes('-w') && !seen[0]!.args.includes('src/a.txt'), 'without a mutant: stdin, no -w, no working file');
  } finally {
    if (prev === undefined) delete process.env['COWORK_TEST_MUTANT']; else process.env['COWORK_TEST_MUTANT'] = prev;
    await f.cleanup();
  }
});
