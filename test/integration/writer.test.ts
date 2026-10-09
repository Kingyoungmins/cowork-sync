// The two-phase verifying writer (01-engine §3.11 writer protocol, ROLLBACK, round trip, ring, writeLocal, gate
// queries; ENG-31…ENG-35, ENG-37, ENG-38; glossary §26.1 W4, §26.2 item 7; rulings R-36, P2-EXECBIT, P2-CARRY,
// P2-DOTGIT, P2-INTENTREACH, P2-RINGNAMES, P2-ORPHANS, P2-BESTEFFORT-ROLLBACK, P2-NOFOLLOW, P2-COPYSTAT, P2-STRANDED,
// P2-NARROW, P2-NARROW-DELETE). Real git on a file:// clone; the working tree is touched only through the Fs port (a
// FaultFs over the real disk), so every rename, link and exclusive create is visible in FaultFs.calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import { AttrCache } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG } from '../../src/data/config.js';
import type { FilterSet } from '../../src/data/filters.js';
import { TEMP_PATTERNS, wildmatch } from '../../src/data/scope.js';
import { humanOnlyAttribution } from '../../src/engine/deps.js';
import { DiskEq } from '../../src/engine/diskEq.js';
import type { Meta } from '../../src/engine/meta.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { DELETE_CONFIRM_MS, Snapshotter, type TickInput } from '../../src/engine/snapshot.js';
import { StateStore, type Intent, type StateView } from '../../src/engine/state.js';
import {
  LOCAL_INTENT_KEEP, MAX_REMERGE, PATH_BUSY_WAIT_MS, RING_KEEP_MS, Writer, localIntentKeep, narrowToStranded,
  type GroupResult, type Remerge, type WriteEntry, type WriteGroup, type WriterDeps,
} from '../../src/engine/writer.js';
import { enc } from '../../src/git/enc.js';
import { mergeFile } from '../../src/git/merge.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { realFs, type Fs } from '../../src/ports/fs.js';
import { nullLog, type Log, type LogParam } from '../../src/ports/log.js';
import type { Scheduler } from '../../src/ports/scheduler.js';
import { noTrace } from '../../src/ports/trace.js';
import type { FaultFs } from '../sim/faultfs.js';
import { makeSnapFixture, type SnapFixture } from '../helpers/snapFixture.js';

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const SEVEN = 'a1\na2\na3\na4\na5\na6\na7\n';
const FILES: Record<string, Buffer> = Object.fromEntries(Object.entries({
  'README.md': 'readme\n',
  'src/a.txt': SEVEN,
  'src/b.txt': 'b1\nb2\n',
  'src/c.txt': 'c1\nc2\n',
  'docs/d.txt': 'd1\n',
  'src/r1.txt': SEVEN,
  'src/r2.txt': SEVEN,
  'src/r3.txt': SEVEN,
  'src/r4.txt': SEVEN,
  'src/r5.txt': SEVEN,
}).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));

/** A scheduler whose yield point runs an optional hook (the SIM interleaving point between P1 and P2). */
interface HookScheduler extends Scheduler { hook: ((name: string) => Promise<void>) | null; }
function hookScheduler(): HookScheduler {
  const s: HookScheduler = {
    hook: null,
    schedule() {
      throw new Error('the writer schedules nothing');
    },
    async yieldPoint(name: string) {
      if (s.hook !== null) await s.hook(name);
    },
  };
  return s;
}

interface W {
  s: SnapFixture;
  /** The FaultFs under the writer (rules, locks, calls). */
  ffs: FaultFs;
  snap: Snapshotter;
  diskEq: DiskEq;
  deps: WriterDeps;
  writer: Writer;
  privateIndex: string;
  sched: HookScheduler;
  journal: Intent[];
  phantoms: Array<{ path: string; target: TreeEntry }>;
  late: Array<{ path: string; bytes: Buffer }>;
  frozen: { on: boolean };
  /** A new Writer over the same deps (what a restarted daemon builds). */
  fresh(over?: Partial<WriterDeps>): Writer;
}

interface WOpts {
  files?: Record<string, Buffer>;
  filter?: boolean;
  drivers?: string[];
  filtered?: (p: string) => boolean;
  /** isText for DiskEq and the writer (default: every path is text). */
  text?: (p: string) => boolean;
  filters?: FilterSet;
  mode?: 'link' | 'copy';
  /** Wraps the fixture's FaultFs for the writer (and DiskEq, Snapshotter). */
  wrap?: (ffs: FaultFs, s: SnapFixture) => Fs;
  clock?: (s: SnapFixture) => Clock;
  journal?: (s: SnapFixture) => (intent: Intent) => Promise<void>;
  beforeWriter?: (s: SnapFixture) => Promise<void>;
}

async function withWriter(label: string, o: WOpts, fn: (w: W) => Promise<void>): Promise<void> {
  const s = await makeSnapFixture(label, { files: o.files ?? FILES, filter: o.filter ?? false, drivers: o.drivers ?? [] });
  try {
    const fs = o.wrap !== undefined ? o.wrap(s.fs, s) : s.fs;
    const privateIndex = join(s.f.paths.coworkDir, 'main.index');
    const filters: FilterSet = o.filters ?? { drivers: [...(o.drivers ?? [])], fingerprint: {}, overCap: null };
    const snap = new Snapshotter({
      repo: s.repo, fs, clock: s.clock, trace: noTrace, peer: PEER, privateIndex,
      scratch: { detect: join(s.tmp, 'detect.index'), canon: join(s.tmp, 'canon.index') },
      stage: s.stage, statCache: s.statCache, attribution: humanOnlyAttribution, filters,
    });
    await snap.reseed((await s.repo.readCommit(s.head)).tree);
    const diskEq = new DiskEq({
      repo: s.repo, fs, stage: s.stage, statCache: s.statCache, cmpIndex: join(s.tmp, 'cmp.index'), addIndex: join(s.tmp, 'add.index'),
      isFiltered: o.filtered ?? (() => false), isText: o.text ?? (() => true), mutants: new Set(), filters, isCarried: (p) => snap.isCarried(p),
    });
    if (o.beforeWriter !== undefined) await o.beforeWriter(s);
    const journal: Intent[] = [];
    const phantoms: Array<{ path: string; target: TreeEntry }> = [];
    const late: Array<{ path: string; bytes: Buffer }> = [];
    const frozen = { on: false };
    const sched = hookScheduler();
    const bound = o.journal?.(s);
    const deps: WriterDeps = {
      repo: s.repo, fs, clock: o.clock?.(s) ?? s.clock, scheduler: sched, trace: noTrace, log: nullLog, peer: PEER,
      workTree: s.f.paths.workTree, tmpDir: s.tmp, privateIndex, stage: s.stage, statCache: s.statCache, diskEq, snapshot: snap,
      isFiltered: o.filtered ?? (() => false), isText: o.text ?? (() => true),
      mode: o.mode ?? 'link',
      journal: async (intent) => {
        journal.push(intent);
        if (bound !== undefined) await bound(intent);
      },
      frozen: () => frozen.on,
      onPhantom: async (path, target) => {
        phantoms.push({ path, target });
      },
      onLateWrite: async (path, copy) => {
        late.push({ path, bytes: await fsp.readFile(copy) });
      },
    };
    const w: W = {
      s, ffs: s.fs, snap, diskEq, deps, writer: new Writer(deps), privateIndex, sched, journal, phantoms, late, frozen,
      fresh: (over) => new Writer({ ...deps, ...(over ?? {}) }),
    };
    await fn(w);
  } finally {
    setCrashHandler(null);
    await s.cleanup();
  }
}

function aEntry(w: W, path: string): TreeEntry {
  const e = w.s.A.get(path);
  assert.ok(e, `A has ${path}`);
  return e;
}

async function blob(w: W, bytes: string | Buffer): Promise<Oid> {
  return w.s.repo.hashBytes(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes, true);
}

async function modify(w: W, path: string, bytes: string | Buffer, slot: number, mode: TreeEntry['mode'] = '100644'): Promise<WriteEntry> {
  const a = aEntry(w, path);
  return { path, kind: 'modify', slot, target: { path, mode, oid: await blob(w, bytes) }, sRaw: a, sDisk: a };
}

async function create(w: W, path: string, bytes: string | Buffer, slot: number, mode: TreeEntry['mode'] = '100644'): Promise<WriteEntry> {
  return { path, kind: 'create', slot, target: { path, mode, oid: await blob(w, bytes) }, sRaw: null, sDisk: null };
}

function del(w: W, path: string, slot: number): WriteEntry {
  const a = aEntry(w, path);
  return { path, kind: 'delete', slot, target: null, sRaw: a, sDisk: a };
}

/** merge-file(base S_disk[p], ours found, theirs target): the caller's Remerge (01-engine §3.11 P1). */
function realRemerge(w: W): Remerge {
  return async (e, found) => {
    if (e.sDisk === null || e.target === null) return null;
    const r = await mergeFile(w.s.repo, found.oid, e.sDisk.oid, e.target.oid);
    if (r.rc !== 0) return null;
    return { path: e.path, mode: e.target.mode, oid: await w.s.repo.hashBytes(r.out, true) };
  };
}

function applyIntent(w: W, groups: readonly WriteGroup[]): Intent {
  return { kind: 'apply', tip: w.s.head, board: w.s.head, groups: groups.map((g) => ({ n: g.n, entries: g.entries.map((e) => ({ path: e.path, kind: e.kind, slot: e.slot })) })) };
}

function targetsOf(groups: readonly WriteGroup[]): Map<string, TreeEntry | null> {
  return new Map(groups.flatMap((g) => g.entries.map((e) => [e.path, e.target] as const)));
}

async function read(w: W, path: string): Promise<string | null> {
  try {
    return await fsp.readFile(w.s.abs(path), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function ino(w: W, path: string): Promise<bigint> {
  return (await fsp.lstat(w.s.abs(path), { bigint: true })).ino;
}

/** Writer files left in tmp/ (.new, .old, .redo). */
async function leftovers(w: W, ext: RegExp = /\.(new|old|redo)$/): Promise<string[]> {
  return (await fsp.readdir(w.s.tmp)).filter((n) => ext.test(n)).sort();
}

function deferred(n: number, reason: GroupResult['reason']): GroupResult {
  return { n, outcome: 'deferred', reason, written: [], deleted: [], phantoms: [], stranded: false };
}

/** An error shaped like Node's own fs errors. */
function errnoError(code: string, syscall: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: p });
}

/** The Fs `inner` with the members in `over` replaced (every other member bound to inner). */
function overrideFs(inner: Fs, over: Partial<Fs>): Fs {
  return new Proxy(inner, {
    get(t, k) {
      if (typeof k === 'string' && k in over) return (over as Record<string, unknown>)[k];
      const v: unknown = Reflect.get(t, k, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/**
 * A nearly full volume over the FaultFs: every byte written into a working file or a writer temp file (.new, .old,
 * .redo) counts against `free.n`, an unlink gives the file's size back. An exclusive create larger than what is
 * left creates a partial file of what is left, then fails ENOSPC in its write, as a real full disk does.
 */
function tinyVolume(free: { n: number }): (ffs: FaultFs, s: SnapFixture) => Fs {
  return (ffs, s) => {
    const counted = (p: string): boolean => /\.(new|old|redo)$/.test(p) || (p.startsWith(s.f.paths.workTree) && !p.slice(s.f.paths.workTree.length).split(/[\\/]/).includes('.git'));
    return overrideFs(ffs, {
      async writeFileExclusive(p: string, d: Buffer): Promise<void> {
        if (counted(p) && d.length > free.n) {
          const n = free.n;
          await ffs.writeFileExclusive(p, d.subarray(0, n));
          free.n -= n;
          throw errnoError('ENOSPC', 'write', p);
        }
        await ffs.writeFileExclusive(p, d);
        if (counted(p)) free.n -= d.length;
      },
      async writeFile(p: string, d: Buffer): Promise<void> {
        const before = counted(p) ? ((await realFs.lstat(p))?.size ?? 0) : 0;
        if (counted(p) && d.length > free.n + before) throw errnoError('ENOSPC', 'write', p);
        await ffs.writeFile(p, d);
        if (counted(p)) free.n -= d.length - before;
      },
      async unlink(p: string): Promise<void> {
        const st = await realFs.lstat(p);
        await ffs.unlink(p);
        if (counted(p) && st !== null && st.isFile) free.n += st.size;
      },
    });
  };
}

/** A gitdir on another volume than the work tree: a hard link from tmp/ to anywhere outside tmp/ fails EXDEV. */
function crossVolume(ffs: FaultFs, s: SnapFixture): Fs {
  return overrideFs(ffs, {
    async link(a: string, b: string): Promise<void> {
      if (!b.startsWith(s.tmp)) throw errnoError('EXDEV', 'link', a);
      await ffs.link(a, b);
    },
  });
}

/** Writer files and moved-aside holders in tmp/ (ring-<k>.*, orphan-<k>.*). */
async function tmpNames(w: W, re: RegExp): Promise<string[]> {
  return (await fsp.readdir(w.s.tmp)).filter((n) => re.test(n)).sort();
}

test('a modify, a create into a new directory and a delete are written in one group, round-tripped into the private index and marked clean, and the emptied directory is removed', async () => {
  await withWriter('w-basic', {}, async (w) => {
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'new/sub/n.txt', 'N\n', 1), del(w, 'docs/d.txt', 2)] };
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, { n: 0, outcome: 'written', reason: null, written: [g.entries[0]!.target, g.entries[1]!.target], deleted: ['docs/d.txt'], phantoms: [], stranded: false });
    assert.equal(await read(w, 'src/a.txt'), 'A\n');
    assert.equal(await read(w, 'new/sub/n.txt'), 'N\n');
    assert.equal(await read(w, 'docs/d.txt'), null);
    assert.equal(await realFs.lstat(w.s.abs('docs')), null, 'the emptied parent directory is removed');
    const idx = await w.s.repo.listIndex(w.privateIndex);
    assert.equal(idx.get('src/a.txt')?.oid, g.entries[0]!.target!.oid, 'round trip: the private index holds M_disk[p]');
    assert.equal(idx.get('new/sub/n.txt')?.oid, g.entries[1]!.target!.oid);
    assert.equal(idx.has('docs/d.txt'), false, 'a deletion is force-removed from the private index');
    for (const p of ['src/a.txt', 'new/sub/n.txt']) {
      const ce = w.s.statCache.get(p);
      assert.equal(ce?.state, 'clean', `${p}: a passing round trip marks the stat cache clean`);
      assert.deepEqual(ce?.stat, await realFs.lstat(w.s.abs(p)), `${p}: with the post-write lstat`);
    }
    assert.equal(w.s.statCache.get('src/a.txt')?.id, g.entries[0]!.target!.oid);
    // The .old files of the modify and the delete stay in the ring (>= 2 s); no .new is left.
    assert.deepEqual(await leftovers(w, /\.new$/), []);
    assert.equal((await leftovers(w, /\.old$/)).length, 2);
    assert.deepEqual(w.journal, [], 'applyGroups journals nothing: the caller journaled the apply intent');
  });
});

test('a 3-path group is written all or none: a share-read lock on one path defers the group as locked, writes nothing and links every .old back', async () => {
  await withWriter('w-locked', {}, async (w) => {
    const paths = ['src/a.txt', 'src/b.txt', 'src/c.txt'];
    const g: WriteGroup = { n: 0, entries: [await modify(w, paths[0]!, 'A\n', 0), await modify(w, paths[1]!, 'B\n', 1), await modify(w, paths[2]!, 'C\n', 2)] };
    const before = await Promise.all(paths.map(async (p) => ({ bytes: await read(w, p), ino: await ino(w, p) })));
    const release = w.ffs.holdLock(w.s.abs('src/c.txt'), 'share-read');
    w.ffs.calls.length = 0;
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'locked'));
    for (const [i, p] of paths.entries()) {
      assert.equal(await read(w, p), before[i]!.bytes, `${p}: bytes untouched`);
      assert.equal(await ino(w, p), before[i]!.ino, `${p}: the same file, linked back from its .old`);
    }
    const linkedBack = w.ffs.calls.filter((c) => c.startsWith('link ') && c.includes('.old -> ')).map((c) => c.slice(c.indexOf(' -> ') + 4));
    assert.deepEqual(linkedBack, [w.s.abs('src/a.txt'), w.s.abs('src/b.txt')], 'the two renamed paths are linked back');
    assert.equal(w.ffs.calls.filter((c) => c.startsWith('link ') && c.includes('.new -> ')).length, 0, 'no .new reached a target');
    assert.deepEqual(await leftovers(w), [], 'no .new, .old or .redo is left');
    assert.equal(await w.writer.pathState('src/b.txt'), 'pending');
    release();
    const [r2] = await w.writer.applyGroups([g], realRemerge(w));
    assert.equal(r2?.outcome, 'written');
    assert.deepEqual(await Promise.all(paths.map((p) => read(w, p))), ['A\n', 'B\n', 'C\n']);
    assert.equal(await w.writer.pathState('src/b.txt'), 'idle');
  });
});

test('P0 smudges a whole group in one cat-file --batch --filters call', async () => {
  await withWriter('w-smudge', {}, async (w) => {
    const g0: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/n1.txt', 'N1\n', 1), await modify(w, 'src/b.txt', 'B\n', 2), del(w, 'src/c.txt', 3)] };
    const g1: WriteGroup = { n: 1, entries: [await modify(w, 'docs/d.txt', 'D\n', 0), await create(w, 'docs/n2.txt', 'N2\n', 1)] };
    w.s.calls.length = 0;
    const res = await w.writer.applyGroups([g0, g1], realRemerge(w));
    assert.deepEqual(res.map((r) => r.outcome), ['written', 'written']);
    const smudges = w.s.calls.filter((c) => c.args[0] === 'cat-file' && c.args.includes('--filters'));
    assert.equal(smudges.length, 2, 'one call per group');
    for (const c of smudges) assert.deepEqual(c.args, ['cat-file', '--batch', '--filters']);
    const lines = smudges.map((c) => (c.opts.stdin as Buffer).toString('utf8').trimEnd().split('\n'));
    assert.deepEqual(lines, [
      [`${g0.entries[0]!.target!.oid} src/a.txt`, `${g0.entries[1]!.target!.oid} src/n1.txt`, `${g0.entries[2]!.target!.oid} src/b.txt`],
      [`${g1.entries[0]!.target!.oid} docs/d.txt`, `${g1.entries[1]!.target!.oid} docs/n2.txt`],
    ], 'every create/modify path of the group, "<oid> <path>"');
    for (const c of smudges) assert.equal(c.opts.cwd, w.s.f.paths.workTree, 'filters run at the repository root (glossary §25 F12)');
    for (const c of smudges) assert.equal(c.opts.workTree, undefined);
  });
});

test('a create into an existing file defers race and leaves the local bytes untouched', async () => {
  await withWriter('w-race', {}, async (w) => {
    await w.s.write('src/new.txt', 'local bytes\n');
    const st = await realFs.lstat(w.s.abs('src/new.txt'));
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/new.txt', 'team bytes\n', 1)] };
    w.ffs.calls.length = 0;
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'race'));
    assert.equal(await read(w, 'src/new.txt'), 'local bytes\n');
    assert.deepEqual(await realFs.lstat(w.s.abs('src/new.txt')), st, 'not even its stat changed');
    assert.equal(await read(w, 'src/a.txt'), SEVEN, 'the rest of the group is rolled back');
    const touching = w.ffs.calls.filter((c) => c.includes(w.s.abs('src/new.txt')) && !c.startsWith('lstat '));
    assert.deepEqual(touching, [], 'the local file is only lstat-ed');
    assert.deepEqual(await leftovers(w), []);
  });
});

test('a write interposed between P1 and P2 is re-merged up to 3 times or defers mismatch, and the human bytes survive on disk or in the merge', async () => {
  const human = (v: number): string => `h${v}\na2\na3\na4\na5\na6\na7\n`;   // the human edits line 1
  const TEAM = 'a1\na2\na3\na4\na5\na6\nT7\n';                            // the incoming change is on line 7
  const merged = (v: number): string => `h${v}\na2\na3\na4\na5\na6\nT7\n`;
  await withWriter('w-remerge', {}, async (w) => {
    // `extra` more human saves land after the first `extra` re-merges (each just before the next P1 check).
    const run = async (path: string, extra: number): Promise<{ r: GroupResult; calls: number }> => {
      await w.s.write(path, human(1));
      let v = 1;
      let calls = 0;
      const remerge: Remerge = async (e, found) => {
        calls++;
        assert.equal(e.target?.oid, await blob(w, TEAM), 'every re-merge merges the incoming M_disk[p]');
        assert.equal(found.oid, await blob(w, human(v)), 'found = the current disk bytes in stored form');
        const m = await realRemerge(w)(e, found);
        if (calls <= extra) await w.s.write(path, human(++v));
        return m;
      };
      const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, path, TEAM, 0)] }], remerge);
      return { r: r!, calls };
    };
    // One save before P1: one re-merge, the merge is written.
    let x = await run('src/r1.txt', 0);
    assert.equal(x.calls, 1);
    assert.equal(x.r.outcome, 'written');
    assert.equal(await read(w, 'src/r1.txt'), merged(1));
    assert.deepEqual(x.r.written.map((e) => e.oid), [await blob(w, merged(1))], 'the written entry is the merge');
    // A save after each of the first two re-merges: three re-merges, the third merge is written.
    x = await run('src/r2.txt', 2);
    assert.equal(x.calls, MAX_REMERGE);
    assert.equal(x.r.outcome, 'written');
    assert.equal(await read(w, 'src/r2.txt'), merged(3));
    // A save after each of the three re-merges: the fourth check fails and the group defers mismatch; the last
    // human bytes stay on disk.
    x = await run('src/r3.txt', 3);
    assert.equal(x.calls, MAX_REMERGE, 'never more than 3 re-merges');
    assert.deepEqual(x.r, deferred(0, 'mismatch'));
    assert.equal(await read(w, 'src/r3.txt'), human(4));
    // A conflicting save (the same line as the team's): no merge, mismatch, the human bytes on disk.
    await w.s.write('src/r4.txt', 'a1\na2\na3\na4\na5\na6\nH7\n');
    const [c] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/r4.txt', TEAM, 0)] }], realRemerge(w));
    assert.deepEqual(c, deferred(0, 'mismatch'));
    assert.equal(await read(w, 'src/r4.txt'), 'a1\na2\na3\na4\na5\na6\nH7\n');
    // A save between P1 and P2 (yieldPoint apply.beforePhase2: p is at its .old): P2 finds the new file, the group
    // defers race, and the human bytes stay on disk; the .old (S_raw bytes, in git) goes to the ring.
    w.sched.hook = async (name) => {
      if (name === 'apply.beforePhase2') await w.s.write('src/r5.txt', human(9));
    };
    const [d] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/r5.txt', TEAM, 0)] }], realRemerge(w));
    w.sched.hook = null;
    assert.deepEqual(d, deferred(0, 'race'));
    assert.equal(await read(w, 'src/r5.txt'), human(9));
    assert.deepEqual(await leftovers(w, /\.(new|redo)$/), []);
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(await leftovers(w), [], 'the ring deletes every unchanged .old after 2 s');
    assert.deepEqual(w.late, []);
  });
});

test('rollback restores the exact .old bytes, also for an already linked path', async () => {
  await withWriter('w-rollback', {}, async (w) => {
    const paths = ['src/a.txt', 'src/b.txt', 'src/c.txt'];
    const g: WriteGroup = { n: 0, entries: [await modify(w, paths[0]!, 'A\n', 0), await modify(w, paths[1]!, 'B\n', 1), await modify(w, paths[2]!, 'C\n', 2)] };
    const before = await Promise.all(paths.map(async (p) => ({ bytes: await fsp.readFile(w.s.abs(p)), ino: await ino(w, p) })));
    // a and b get linked; the link of c fails EBUSY: a and b are already linked when the group rolls back.
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/c.txt'), code: 'EBUSY', times: 1 });
    w.ffs.calls.length = 0;
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'locked'));
    for (const [i, p] of paths.entries()) {
      assert.ok((await fsp.readFile(w.s.abs(p))).equals(before[i]!.bytes), `${p}: the exact .old bytes`);
      assert.equal(await ino(w, p), before[i]!.ino, `${p}: the .old itself is linked back`);
    }
    const redo = w.ffs.calls.filter((c) => c.startsWith('rename ') && c.endsWith('.redo'));
    assert.deepEqual(redo.map((c) => c.slice('rename '.length, c.indexOf(' -> '))), [w.s.abs('src/a.txt'), w.s.abs('src/b.txt')], 'a linked path goes to .redo first');
    assert.deepEqual(await leftovers(w), []);
    // Someone wrote a after its link: the rollback leaves a as written and restores the rest.
    w.ffs.interpose('link', w.s.abs('src/c.txt'), async () => {
      await w.s.write('src/a.txt', 'human after the link\n');
    });
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/c.txt'), code: 'EBUSY', times: 1 });
    const [r2] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r2, deferred(0, 'locked'));
    assert.equal(await read(w, 'src/a.txt'), 'human after the link\n');
    assert.ok((await fsp.readFile(w.s.abs('src/b.txt'))).equals(before[1]!.bytes));
    assert.ok((await fsp.readFile(w.s.abs('src/c.txt'))).equals(before[2]!.bytes));
    assert.deepEqual(await leftovers(w, /\.(new|redo)$/), []);
  });
});

test('no rename onto an existing target is ever issued', async () => {
  const violations: string[] = [];
  /** The FaultFs with a rename that first checks its destination (FaultFs.interpose sees only the source). */
  const guard = (ffs: FaultFs): Fs => new Proxy(ffs, {
    get(t, k) {
      if (k === 'rename') {
        return async (from: string, to: string) => {
          if ((await realFs.lstat(to)) !== null) violations.push(`${from} -> ${to}`);
          return t.rename(from, to);
        };
      }
      const v: unknown = Reflect.get(t, k, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  await withWriter('w-norename', { wrap: guard }, async (w) => {
    const ok: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/n.txt', 'N\n', 1), del(w, 'docs/d.txt', 2)] };
    assert.equal((await w.writer.applyGroups([ok], realRemerge(w)))[0]?.outcome, 'written');
    // The same names again while the ring still holds the first .old files.
    const again: WriteGroup = { n: 0, entries: [await modify(w, 'src/b.txt', 'B\n', 0)] };
    assert.equal((await w.writer.applyGroups([again], realRemerge(w)))[0]?.outcome, 'written');
    // A rollback with a linked path (rename p -> .redo) and a renamed one (link .old back).
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r2.txt'), code: 'EBUSY', times: 1 });
    const rb: WriteGroup = { n: 1, entries: [await modify(w, 'src/r1.txt', 'R1\n', 0), await modify(w, 'src/r2.txt', 'R2\n', 1)] };
    assert.deepEqual((await w.writer.applyGroups([rb], realRemerge(w)))[0], deferred(1, 'locked'));
    // A local write and the ring sweep.
    assert.deepEqual(await w.writer.writeLocal('src/c.txt', aEntry(w, 'src/c.txt').oid, await blob(w, 'C\n'), 'test'), { kind: 'WRITTEN' });
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    const renames = w.ffs.calls.filter((c) => c.startsWith('rename '));
    assert.ok(renames.length >= 6, `renames were issued (${renames.length})`);
    for (const c of renames) {
      const to = c.slice(c.indexOf(' -> ') + 4);
      assert.ok(to.startsWith(w.s.tmp) && /\.(old|redo)$/.test(to), `only into the writer's own tmp names: ${c}`);
    }
    assert.deepEqual(violations, []);
  });
});

test('with setNoHardLinks the copy fallback creates exclusively and rolls back by exclusive create from .old', async () => {
  await withWriter('w-copy', { mode: 'copy' }, async (w) => {
    const workTree = w.s.f.paths.workTree;
    assert.equal(await Writer.probeMode(w.ffs, w.s.tmp, workTree), 'link');
    w.ffs.setNoHardLinks(true);
    assert.equal(await Writer.probeMode(w.ffs, w.s.tmp, workTree), 'copy');
    assert.deepEqual(await leftovers(w, /probe/), [], 'the probe cleans up');
    assert.deepEqual((await fsp.readdir(workTree)).filter((n) => n.includes('probe')), [], 'also in the work tree');
    w.ffs.calls.length = 0;
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/n.txt', 'N\n', 1)] };
    assert.equal((await w.writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
    assert.equal(await read(w, 'src/a.txt'), 'A\n');
    assert.equal(await read(w, 'src/n.txt'), 'N\n');
    const excl = w.ffs.calls.filter((c) => c.startsWith('writeFileExclusive ')).map((c) => c.slice('writeFileExclusive '.length)).filter((p) => !p.startsWith(w.s.tmp));
    assert.deepEqual(excl, [w.s.abs('src/a.txt'), w.s.abs('src/n.txt')], 'one exclusive create per written path');
    // An existing target at a create defers race.
    await w.s.write('src/local.txt', 'mine\n');
    assert.deepEqual((await w.writer.applyGroups([{ n: 1, entries: [await create(w, 'src/local.txt', 'theirs\n', 0)] }], realRemerge(w)))[0], deferred(1, 'race'));
    assert.equal(await read(w, 'src/local.txt'), 'mine\n');
    // A rollback after one path was written: exclusive creates from the .old bytes.
    const before = await Promise.all(['src/b.txt', 'src/c.txt'].map((p) => fsp.readFile(w.s.abs(p))));
    w.ffs.addRule({ op: 'writeFileExclusive', pathIncludes: w.s.abs('src/c.txt'), code: 'EBUSY', times: 1 });
    w.ffs.calls.length = 0;
    const rb: WriteGroup = { n: 2, entries: [await modify(w, 'src/b.txt', 'B\n', 0), await modify(w, 'src/c.txt', 'C\n', 1)] };
    assert.deepEqual((await w.writer.applyGroups([rb], realRemerge(w)))[0], deferred(2, 'locked'));
    assert.ok((await fsp.readFile(w.s.abs('src/b.txt'))).equals(before[0]!));
    assert.ok((await fsp.readFile(w.s.abs('src/c.txt'))).equals(before[1]!));
    const i = w.ffs.calls.findIndex((c) => c.startsWith(`rename ${w.s.abs('src/b.txt')} -> `) && c.endsWith('.redo'));
    assert.ok(i >= 0, 'the written path goes to .redo');
    assert.ok(w.ffs.calls.slice(i).includes(`writeFileExclusive ${w.s.abs('src/b.txt')}`), 'and comes back by an exclusive create');
    assert.ok(w.ffs.calls.slice(i).includes(`writeFileExclusive ${w.s.abs('src/c.txt')}`));
    assert.deepEqual(w.ffs.calls.filter((c) => c.startsWith('link ')), [], 'the copy writer never links');
    assert.deepEqual(await leftovers(w, /\.(new|redo)$/), []);
  });
});

test('a written path that cannot round-trip calls onPhantom and is reported', async () => {
  const files: Record<string, Buffer> = {
    '.gitattributes': Buffer.from('*.sec filter=secret\n'),
    'good.sec': Buffer.from('g=@@SECRET@@\n'),
    'bad.sec': Buffer.from('b=@@SECRET@@\n'),
    'plain.txt': Buffer.from('p\n'),
  };
  await withWriter('w-phantom', { files, filter: true, drivers: ['secret'], filtered: (p) => p.endsWith('.sec') }, async (w) => {
    // bad.sec's incoming blob already holds this clone's canary: the smudge leaves it, the clean replaces it, so the
    // disk can never hash back to M_disk[p] (a filter that is not the inverse of its smudge for this blob).
    const good = await modify(w, 'good.sec', 'g=@@SECRET@@ v2\n', 0);
    const bad = await modify(w, 'bad.sec', `b=${w.s.f.peer.canary} v2\n`, 1);
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [good, bad] }], realRemerge(w));
    assert.equal(r?.outcome, 'written');
    assert.deepEqual(r?.phantoms, ['bad.sec']);
    assert.deepEqual(r?.written, [good.target], 'only the verified path counts as written');
    assert.deepEqual(w.phantoms, [{ path: 'bad.sec', target: bad.target }]);
    assert.equal(w.s.statCache.get('good.sec')?.state, 'clean');
    assert.notEqual(w.s.statCache.get('bad.sec')?.state, 'clean', 'a phantom is never marked clean');
    assert.ok((await read(w, 'good.sec'))?.includes(w.s.f.peer.canary), 'the smudge filter ran on the .new bytes');
  });
});

test('a write into a .old within 2 s reaches onLateWrite with the late bytes, then the .old is deleted', async () => {
  await withWriter('w-ring', {}, async (w) => {
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await modify(w, 'src/b.txt', 'B\n', 1)] };
    const rename = new Map<string, string>();
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.equal(r?.outcome, 'written');
    for (const c of w.ffs.calls.filter((x) => x.startsWith('rename '))) rename.set(c.slice('rename '.length, c.indexOf(' -> ')), c.slice(c.indexOf(' -> ') + 4));
    const oldA = rename.get(w.s.abs('src/a.txt'));
    const oldB = rename.get(w.s.abs('src/b.txt'));
    assert.ok(oldA !== undefined && oldB !== undefined);
    // An editor's handle on a's old file: its next write lands in the .old.
    await fsp.appendFile(oldA, 'late line\n');
    w.s.clock.advance(RING_KEEP_MS - 1);
    await w.writer.sweepRing();
    assert.equal(w.late.length, 0, 'nothing before 2 s');
    assert.ok((await realFs.lstat(oldA)) !== null && (await realFs.lstat(oldB)) !== null, 'both .old kept');
    w.s.clock.advance(1);
    await w.writer.sweepRing();
    assert.deepEqual(w.late.map((l) => [l.path, l.bytes.toString('utf8')]), [['src/a.txt', `${SEVEN}late line\n`]], 'the late bytes, read from a stage copy');
    assert.equal(await realFs.lstat(oldA), null, 'then the .old is deleted');
    assert.equal(await realFs.lstat(oldB), null, 'an unchanged .old is deleted without a record');
    assert.equal(await realFs.lstat(w.s.stage.abs('src/a.txt')), null, 'the stage copy is removed');
    assert.equal(await read(w, 'src/a.txt'), 'A\n', 'the written file is untouched');
  });
});

function sampleMeta(branch: string, h: Oid): Meta {
  return {
    v: 1, proto: 1, peer_id: PEER, epoch: EPOCH, seq_next: 1, branch, enc: enc(branch),
    pinned: { url: 'file:///remote.git', identity: [h] }, H_adopt: h, EPOCH_BASE: h,
    expected_epoch: { symref: `refs/heads/${branch}`, head: h, stash: null },
    freeze_reasons: [], config_detail: [], incident: null, nonretryable: null, rejections: null, throttle: null,
    pending: {}, displaced: [], fold_board: null, fold_verified: null, checkpoint_mismatch: false, outbox: [],
    cs_human_next: 1, incident_next: 1,
  };
}

test('writeLocal returns WRITTEN, MISMATCH, LOCKED, COLLISION, FROZEN, DEFERRED and PHANTOM as ENG-37 says and never changes A', async () => {
  // A journal bound to a real state ref, keeping a local intent's blobs under journal/keep/local-intent (P2-INTENTREACH).
  let view: StateView | null = null;
  const kept: Array<Set<string>> = [];
  let store: StateStore | null = null;
  const journal = (s: SnapFixture) => async (intent: Intent): Promise<void> => {
    assert.ok(store !== null && view !== null);
    const keep = new Map(view.keep);
    if (intent.kind === 'local') keep.set(LOCAL_INTENT_KEEP, await s.repo.mktree(localIntentKeep(intent)));
    else keep.delete(LOCAL_INTENT_KEEP);
    view = await store.commit(view, { intent, keep });
    const k = view.keep.get(LOCAL_INTENT_KEEP);
    if (k !== undefined) kept.push(new Set((await s.repo.run(['ls-tree', '-z', '--name-only', k])).stdout.toString('utf8').split('\0').filter((x) => x.length > 0)));
  };
  const beforeWriter = async (s: SnapFixture): Promise<void> => {
    store = new StateStore({ repo: s.repo, refs: refNames('main', RELEASE_NAMESPACE), trace: noTrace, peer: () => PEER });
    const tree = (await s.repo.readCommit(s.head)).tree;
    const laB = await s.repo.commitTree({ tree, parents: [s.head], subject: 'board', trailers: [] });
    view = await store.create({ laC: s.head, laB, base: tree, snap: tree, meta: sampleMeta('main', s.head) });
  };
  let lowSpace = false;
  const wrap = (ffs: FaultFs): Fs => new Proxy(ffs, {
    get(t, k) {
      if (k === 'freeBytes') return async (dir: string) => (lowSpace ? 1 : t.freeBytes(dir));
      const v: unknown = Reflect.get(t, k, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  await withWriter('w-local', { journal, beforeWriter, wrap }, async (w) => {
    const v0 = view!;
    const index0 = await w.s.repo.listIndex(w.privateIndex);
    const a = aEntry(w, 'src/a.txt');
    // WRITTEN: the pre-image is DISK_EQ(path, expected); the intent is journaled first and cleared after.
    const newA = await blob(w, 'local A\n');
    assert.deepEqual(await w.writer.writeLocal('src/a.txt', a.oid, newA, 'resolve'), { kind: 'WRITTEN' });
    assert.equal(await read(w, 'src/a.txt'), 'local A\n');
    assert.deepEqual(w.journal, [{ kind: 'local', origin: 'resolve', entries: [{ path: 'src/a.txt', expected: a.oid, target: newA, slot: 0 }] }, { kind: 'none' }]);
    assert.deepEqual(kept, [new Set([a.oid, newA].sort())], 'the journaled state keeps both blobs reachable');
    assert.deepEqual(localIntentKeep(w.journal[0]!).map((e) => e.oid), [a.oid, newA].sort());
    // A local write is a local edit: A, LA_C, LA_B, the private index and the stat cache stay as they were, so the
    // next snapshot picks it up and publishes it through every gate.
    const v1 = view!;
    assert.deepEqual([v1.base, v1.laC, v1.laB, v1.snap], [v0.base, v0.laC, v0.laB, v0.snap]);
    assert.deepEqual(await w.s.repo.listIndex(w.privateIndex), index0);
    assert.notEqual(w.s.statCache.get('src/a.txt')?.state, 'clean');
    // MISMATCH(found): the disk changed since the caller looked; nothing is written, found = the disk's blob.
    await w.s.write('src/b.txt', 'human b\n');
    assert.deepEqual(await w.writer.writeLocal('src/b.txt', aEntry(w, 'src/b.txt').oid, await blob(w, 'local b\n'), 'resolve'),
      { kind: 'MISMATCH', found: await blob(w, 'human b\n') });
    assert.equal(await read(w, 'src/b.txt'), 'human b\n');
    // LOCKED: a share-read holder refuses the rename.
    const release = w.ffs.holdLock(w.s.abs('src/c.txt'), 'share-read');
    assert.deepEqual(await w.writer.writeLocal('src/c.txt', aEntry(w, 'src/c.txt').oid, await blob(w, 'local c\n'), 'resolve'), { kind: 'LOCKED' });
    release();
    assert.equal(await read(w, 'src/c.txt'), 'c1\nc2\n');
    // COLLISION: a create (expected ABSENT) into an existing file.
    await w.s.write('src/mine.txt', 'mine\n');
    assert.deepEqual(await w.writer.writeLocal('src/mine.txt', ABSENT, await blob(w, 'theirs\n'), 'resolve'), { kind: 'COLLISION' });
    assert.equal(await read(w, 'src/mine.txt'), 'mine\n');
    // FROZEN unless the request carries human evidence of a typed acting verb.
    w.frozen.on = true;
    const before = w.journal.length;
    assert.deepEqual(await w.writer.writeLocal('src/r1.txt', aEntry(w, 'src/r1.txt').oid, await blob(w, 'R1\n'), 'auto-park'), { kind: 'FROZEN' });
    assert.equal(w.journal.length, before, 'nothing journaled');
    assert.deepEqual(await w.writer.writeLocal('src/r1.txt', aEntry(w, 'src/r1.txt').oid, await blob(w, 'R1\n'), 'resolve', true), { kind: 'WRITTEN' });
    w.frozen.on = false;
    // DEFERRED: a dotgit alias is never looked at; a full disk defers disk_low.
    w.ffs.calls.length = 0;
    assert.deepEqual(await w.writer.writeLocal('GIT~1/config', ABSENT, await blob(w, 'x\n'), 'resolve'), { kind: 'DEFERRED', reason: 'unmaterializable' });
    assert.deepEqual(w.ffs.calls.filter((c) => c.toLowerCase().includes('git~1')), []);
    lowSpace = true;
    assert.deepEqual(await w.writer.writeLocal('src/r2.txt', aEntry(w, 'src/r2.txt').oid, await blob(w, 'R2\n'), 'resolve'), { kind: 'DEFERRED', reason: 'disk_low' });
    lowSpace = false;
    assert.equal(await read(w, 'src/r2.txt'), SEVEN);
    // writeLocalGroup is all or none: one locked path keeps the other's bytes too; a delete is a local write too.
    const rel2 = w.ffs.holdLock(w.s.abs('src/r4.txt'), 'share-read');
    assert.deepEqual(await w.writer.writeLocalGroup([
      { path: 'src/r3.txt', expected: aEntry(w, 'src/r3.txt').oid, target: await blob(w, 'R3\n') },
      { path: 'src/r4.txt', expected: aEntry(w, 'src/r4.txt').oid, target: 'DELETE' },
    ], 'resolve'), { kind: 'LOCKED' });
    rel2();
    assert.deepEqual([await read(w, 'src/r3.txt'), await read(w, 'src/r4.txt')], [SEVEN, SEVEN]);
    assert.deepEqual(await w.writer.writeLocalGroup([
      { path: 'src/r3.txt', expected: aEntry(w, 'src/r3.txt').oid, target: await blob(w, 'R3\n') },
      { path: 'src/r4.txt', expected: aEntry(w, 'src/r4.txt').oid, target: 'DELETE' },
    ], 'resolve'), { kind: 'WRITTEN' });
    assert.deepEqual([await read(w, 'src/r3.txt'), await read(w, 'src/r4.txt')], ['R3\n', null]);
    // Every local intent was cleared again; A never moved.
    assert.equal(view!.intent.kind, 'none');
    assert.deepEqual([view!.base, view!.laC, view!.laB], [v0.base, v0.laC, v0.laB]);
  });
  // PHANTOM: a written path that cannot round-trip (see the onPhantom test).
  const files: Record<string, Buffer> = { '.gitattributes': Buffer.from('*.sec filter=secret\n'), 'bad.sec': Buffer.from('b=@@SECRET@@\n') };
  await withWriter('w-local-phantom', { files, filter: true, drivers: ['secret'], filtered: (p) => p.endsWith('.sec') }, async (w) => {
    const target = await blob(w, `b=${w.s.f.peer.canary} v2\n`);
    assert.deepEqual(await w.writer.writeLocal('bad.sec', aEntry(w, 'bad.sec').oid, target, 'resolve'), { kind: 'PHANTOM' });
    assert.deepEqual(w.phantoms.map((p) => p.path), ['bad.sec']);
  });
});

test('pathState waits up to 250 ms for an in-flight group, then answers busy', async () => {
  // The writer's clock sleeps in real time here, so the 250 ms bound is measured.
  const clock = (s: SnapFixture): Clock => ({ monoMs: () => s.clock.monoMs(), wallMs: () => s.clock.wallMs(), sleep: (ms) => realClock.sleep(ms) });
  await withWriter('w-pathstate', { clock }, async (w) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const atGate = new Promise<void>((r) => {
      reached = r;
    });
    w.sched.hook = async (name) => {
      if (name !== 'apply.beforePhase2') return;
      reached();
      await gate;
    };
    const g0: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] };
    const g1: WriteGroup = { n: 1, entries: [await modify(w, 'src/c.txt', 'C\n', 0)] };
    const run = w.writer.applyGroups([g0, g1], realRemerge(w));
    await atGate; // group 0 is between P1 and P2
    assert.equal(await w.writer.pathState('src/b.txt'), 'idle', 'not part of the apply');
    assert.equal(await w.writer.pathState('src/c.txt'), 'applying', 'a later group of the apply, nothing moved yet');
    let t0 = realClock.monoMs();
    assert.equal(await w.writer.pathState('src/a.txt'), 'busy');
    const waited = realClock.monoMs() - t0;
    assert.ok(waited >= PATH_BUSY_WAIT_MS - 15 && waited < PATH_BUSY_WAIT_MS + 1_500, `waited ${waited} ms`);
    // A group that ends inside the wait: its P2 link fails, the rollback needs no git, the answer is its outcome.
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/a.txt'), code: 'EBUSY', times: 1 });
    t0 = realClock.monoMs();
    const asked = w.writer.pathState('src/a.txt');
    setTimeout(release, 30);
    assert.equal(await asked, 'pending');
    assert.ok(realClock.monoMs() - t0 < PATH_BUSY_WAIT_MS, 'answered when the group ended');
    const res = await run;
    assert.deepEqual(res.map((r) => [r.outcome, r.reason]), [['deferred', 'locked'], ['written', null]]);
    assert.equal(await w.writer.pathState('src/a.txt'), 'pending');
    assert.equal(await w.writer.pathState('src/c.txt'), 'idle');
  });
});

test('a kill at each of apply.group.phase1, apply.group.mid, apply.group.phase2 and apply.between_groups leaves files that rollbackIntent restores', async () => {
  const cases = [
    { point: 'apply.group.phase1', complete: [] as number[], rolledBack: [0, 1] },
    { point: 'apply.group.mid', complete: [] as number[], rolledBack: [0, 1] },
    { point: 'apply.group.phase2', complete: [0], rolledBack: [1] },
    { point: 'apply.between_groups', complete: [0], rolledBack: [1] },
  ];
  for (const c of cases) {
    await withWriter(`w-kill-${c.point.split('.').pop()}`, {}, async (w) => {
      const g0: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'docs/n.txt', 'N\n', 1), del(w, 'src/b.txt', 2)] };
      const g1: WriteGroup = { n: 1, entries: [await modify(w, 'src/c.txt', 'C\n', 0)] };
      const groups = [g0, g1];
      const original = { 'src/a.txt': await read(w, 'src/a.txt'), 'docs/n.txt': null, 'src/b.txt': await read(w, 'src/b.txt'), 'src/c.txt': await read(w, 'src/c.txt') };
      const written = { 'src/a.txt': 'A\n', 'docs/n.txt': 'N\n', 'src/b.txt': null, 'src/c.txt': 'C\n' };
      setCrashHandler((name) => {
        if (name === c.point) throw new KilledAt(name);
      });
      await assert.rejects(w.writer.applyGroups(groups, realRemerge(w)), (e: unknown) => e instanceof KilledAt && e.point === c.point);
      setCrashHandler(null);
      // A restart: a new writer, the journaled intent and its targets.
      const report = await w.fresh().rollbackIntent(applyIntent(w, groups), targetsOf(groups));
      assert.deepEqual([report.complete, report.rolledBack], [c.complete, c.rolledBack], c.point);
      const g0Done = c.complete.includes(0);
      for (const p of ['src/a.txt', 'docs/n.txt', 'src/b.txt'] as const) {
        assert.equal(await read(w, p), g0Done ? written[p] : original[p], `${c.point}: group 0 all or none (${p})`);
      }
      assert.equal(await read(w, 'src/c.txt'), original['src/c.txt'], `${c.point}: group 1 never started`);
      // A complete group's .old files are left for the restart's many-candidates step; nothing else is left.
      const oldFiles = report.leftoverOld.map((l) => l.path).sort();
      assert.deepEqual(oldFiles, g0Done ? ['src/a.txt', 'src/b.txt'] : []);
      for (const l of report.leftoverOld) assert.ok((await realFs.lstat(l.file)) !== null && l.file.startsWith(w.s.tmp));
      assert.deepEqual(await leftovers(w, /\.(new|redo)$/), [], `${c.point}: no .new or .redo left`);
      assert.equal((await leftovers(w, /\.old$/)).length, report.leftoverOld.length);
    });
  }
  // A local intent killed inside P2 rolls back the same way.
  await withWriter('w-kill-local', {}, async (w) => {
    const entries = [
      { path: 'src/a.txt', expected: aEntry(w, 'src/a.txt').oid, target: await blob(w, 'A\n') },
      { path: 'src/c.txt', expected: aEntry(w, 'src/c.txt').oid, target: await blob(w, 'C\n') },
    ];
    setCrashHandler((name) => {
      if (name === 'apply.group.mid') throw new KilledAt(name);
    });
    await assert.rejects(w.writer.writeLocalGroup(entries, 'resolve'), KilledAt);
    setCrashHandler(null);
    const intent = w.journal[0];
    assert.equal(intent?.kind, 'local');
    assert.equal(w.journal.length, 1, 'a killed local write leaves its intent journaled');
    const targets = new Map(entries.map((e) => [e.path, { path: e.path, mode: '100644' as const, oid: e.target }]));
    const report = await w.fresh().rollbackIntent(intent!, targets);
    assert.deepEqual([report.complete, report.rolledBack, report.leftoverOld], [[], [0], []]);
    assert.deepEqual([await read(w, 'src/a.txt'), await read(w, 'src/c.txt')], [SEVEN, 'c1\nc2\n']);
  });
});

test('a group holding a carried or dotgit-alias path, or a path DISK_EQ refuses, is deferred without any look at that path', async () => {
  await withWriter('w-carried', { filtered: (p) => p === 'src/b.txt', filters: { drivers: [], fingerprint: {}, overCap: 99 } }, async (w) => {
    for (const [alias, needle] of [['.GIT/hooks/post-checkout', '.GIT'], ['GIT~1/config', 'GIT~1'], ['src/x\u{fffd}.txt', '\u{fffd}']] as const) {
      w.ffs.calls.length = 0;
      const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, alias, 'evil\n', 1)] };
      assert.deepEqual((await w.writer.applyGroups([g], realRemerge(w)))[0], deferred(0, 'unmaterializable'), alias);
      assert.deepEqual(w.ffs.calls.filter((c) => c.includes(needle)), [], `${alias} is never looked at`);
      assert.deepEqual(w.ffs.calls.filter((c) => c.startsWith('rename ')), [], 'nothing moved');
    }
    // DISK_EQ refuses a filtered path under an over-cap filter set (P2-DRIVERCAP): the group defers filter_failure.
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await modify(w, 'src/b.txt', 'B\n', 1)] };
    assert.deepEqual((await w.writer.applyGroups([g], realRemerge(w)))[0], deferred(0, 'filter_failure'));
    assert.equal(await read(w, 'src/a.txt'), SEVEN);
    assert.deepEqual(await leftovers(w), []);
  });
});

test('final review minor: a creation of a filtered path is refused like a modify (P2-DRIVERCAP / P2-SNAPFILTERS): under an over-cap or unknown driver the group defers filter_failure and nothing reaches p (its smudge ran without required=true and may be the stored form)', async () => {
  const cases: Array<[string, FilterSet]> = [['over-cap', { drivers: [], fingerprint: {}, overCap: 99 }], ['unknown', { drivers: [], fingerprint: {}, overCap: null }]];
  for (const [label, filters] of cases) {
    await withWriter(`w-create-filtered-${label}`, { filtered: (p) => p === 'src/new.sec', filters }, async (w) => {
      if (label === 'unknown') await fsp.writeFile(w.s.abs('.git/info/attributes'), 'src/new.sec filter=undiscovered\n');
      const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/new.sec', 'STORED FORM\n', 1)] };
      assert.deepEqual((await w.writer.applyGroups([g], realRemerge(w)))[0], deferred(0, 'filter_failure'), label);
      assert.equal(await read(w, 'src/new.sec'), null, `${label}: nothing at p`);
      assert.equal(await read(w, 'src/a.txt'), SEVEN, `${label}: the group is whole`);
      assert.deepEqual(await leftovers(w), []);
    });
  }
});

test('on a core.fileMode=true volume a 100755 target gets the owner-exec bit and a 100644 target clears it (P2-EXECBIT)', {
  skip: process.platform === 'win32' ? 'POSIX legs only: Windows has no owner-exec bit and git clones it with core.fileMode=false' : false,
}, async () => {
  for (const mode of ['link', 'copy'] as const) {
    await withWriter(`w-exec-${mode}`, { mode }, async (w) => {
      assert.equal(await w.s.repo.configGet('core.filemode'), 'true');
      const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', SEVEN, 0, '100755'), await create(w, 'run.sh', 'echo\n', 1, '100755')] };
      assert.equal((await w.writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
      for (const p of ['src/a.txt', 'run.sh']) assert.equal(((await realFs.lstat(w.s.abs(p)))!.mode & 0o100) !== 0, true, `${mode}: ${p} is executable`);
      const back: WriteEntry = { path: 'src/a.txt', kind: 'modify', slot: 0, target: { path: 'src/a.txt', mode: '100644', oid: aEntry(w, 'src/a.txt').oid }, sRaw: g.entries[0]!.target, sDisk: g.entries[0]!.target };
      assert.equal((await w.writer.applyGroups([{ n: 1, entries: [back] }], realRemerge(w)))[0]?.outcome, 'written');
      assert.equal(((await realFs.lstat(w.s.abs('src/a.txt')))!.mode & 0o111), 0, `${mode}: 100644 clears it`);
    });
  }
});

test('final review minor (ledger Task 10:207): the exec bit follows the user\'s umask — under umask 077 a 100755 target is 0o700, never a fixed 0o755, in link and copy mode and for a copy-mode relink', {
  skip: process.platform === 'win32' ? 'POSIX legs only: Windows has no owner-exec bit and git clones it with core.fileMode=false' : false,
}, async () => {
  const before = process.umask(0o077);
  try {
    for (const mode of ['link', 'copy'] as const) {
      await withWriter(`w-exec-umask-${mode}`, { mode }, async (w) => {
        const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', SEVEN, 0, '100755'), await create(w, 'run.sh', 'echo\n', 1, '100755')] };
        assert.equal((await w.writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
        for (const p of ['src/a.txt', 'run.sh']) assert.equal((await realFs.lstat(w.s.abs(p)))!.mode & 0o777, 0o700, `${mode}: ${p} is 0o700 under umask 077`);
      });
    }
  } finally {
    process.umask(before);
  }
});

test('with core.fileMode false the writer never changes a mode', async () => {
  await withWriter('w-noexec', { beforeWriter: async (s) => { await s.repo.run(['config', 'core.filemode', 'false']); } }, async (w) => {
    w.ffs.calls.length = 0;
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0, '100755'), await create(w, 'run.sh', 'echo\n', 1, '100755')] };
    assert.equal((await w.writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
    assert.deepEqual(w.ffs.calls.filter((c) => c.startsWith('chmod ')), []);
  });
});

// ---- fix round 1 (rulings P2-RINGNAMES, P2-ORPHANS, P2-BESTEFFORT-ROLLBACK, P2-NOFOLLOW, P2-COPYSTAT) ----

test('two local writes 100 ms apart keep the first .old for 2 s, and a late write into it reaches onLateWrite (P2-RINGNAMES)', async () => {
  await withWriter('w-ringnames', {}, async (w) => {
    const t0 = w.s.clock.monoMs();
    assert.deepEqual(await w.writer.writeLocal('src/a.txt', aEntry(w, 'src/a.txt').oid, await blob(w, 'local A\n'), 'resolve'), { kind: 'WRITTEN' });
    const first = join(w.s.tmp, 'L.0.old');
    assert.ok((await realFs.lstat(first)) !== null, 'the first local write keeps its .old at tmp/L.0.old');
    // An editor's handle on the old file, held over the rename: its next write lands in the .old.
    const handle = await fsp.open(first, 'r+');
    try {
      w.s.clock.advance(100);
      assert.deepEqual(await w.writer.writeLocal('src/b.txt', aEntry(w, 'src/b.txt').oid, await blob(w, 'local b\n'), 'resolve'), { kind: 'WRITTEN' });
      const slots = w.journal.flatMap((j) => (j.kind === 'local' ? [j.entries.map((e) => e.slot)] : []));
      assert.deepEqual(slots, [[0], [1]], 'local slots come from one monotonic counter per Writer, journaled in the intent');
      assert.ok((await realFs.lstat(first)) !== null, 'the second local write leaves the first .old alone');
      await handle.write(Buffer.from('late\n', 'utf8'), 0, 5, Buffer.byteLength(SEVEN));
    } finally {
      await handle.close();
    }
    w.s.clock.advance(RING_KEEP_MS - 1 - (w.s.clock.monoMs() - t0));
    await w.writer.sweepRing();
    assert.equal(w.late.length, 0, 'nothing before 2 s');
    assert.ok((await realFs.lstat(first)) !== null, 'the .old is kept for 2 s');
    w.s.clock.advance(1);
    await w.writer.sweepRing();
    assert.deepEqual(w.late.map((l) => [l.path, l.bytes.toString('utf8')]), [['src/a.txt', `${SEVEN}late\n`]], 'the late bytes reach onLateWrite');
    assert.equal(await realFs.lstat(first), null);
  });
});

test('a young ring .old whose name a new group needs is moved aside, never deleted, and a late write into it still reaches onLateWrite (P2-RINGNAMES)', async () => {
  await withWriter('w-ringaside', {}, async (w) => {
    assert.equal((await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] }], realRemerge(w)))[0]?.outcome, 'written');
    const old0 = join(w.s.tmp, '0.0.old');
    const handle = await fsp.open(old0, 'r+');
    try {
      w.s.clock.advance(100);
      // The same temp name tmp/0.0.* again, 100 ms later.
      assert.equal((await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/b.txt', 'B\n', 0)] }], realRemerge(w)))[0]?.outcome, 'written');
      assert.equal((await tmpNames(w, /\.old$/)).length, 2, 'both .old files exist: the first one was moved aside');
      await handle.write(Buffer.from('late\n', 'utf8'), 0, 5, Buffer.byteLength(SEVEN));
    } finally {
      await handle.close();
    }
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(w.late.map((l) => [l.path, l.bytes.toString('utf8')]), [['src/a.txt', `${SEVEN}late\n`]]);
    assert.deepEqual(await tmpNames(w, /\.(old|new|redo)$/), []);
  });
});

test('an orphan temp file left by an earlier run is moved aside and ringed: never deleted at once, never a permanent race (P2-ORPHANS)', async () => {
  await withWriter('w-orphan', {}, async (w) => {
    await fsp.writeFile(join(w.s.tmp, '0.0.old'), 'orphan of an earlier run\n');
    await fsp.writeFile(join(w.s.tmp, '0.1.new'), 'stale new\n');
    await fsp.writeFile(join(w.s.tmp, '0.2.new'), 'stale new, written to later\n');
    const logged: Array<{ code: string; params: Readonly<Record<string, LogParam>> }> = [];
    const log: Log = {
      write(_level, code, params) {
        logged.push({ code, params: params ?? {} });
      },
    };
    const writer = w.fresh({ log });
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await modify(w, 'src/b.txt', 'B\n', 1), await modify(w, 'src/c.txt', 'C\n', 2)] };
    const [r] = await writer.applyGroups([g], realRemerge(w));
    assert.equal(r?.outcome, 'written', 'the temp names are free again');
    assert.deepEqual([await read(w, 'src/a.txt'), await read(w, 'src/b.txt'), await read(w, 'src/c.txt')], ['A\n', 'B\n', 'C\n']);
    const orphans = await tmpNames(w, /^orphan-/);
    assert.equal(orphans.length, 3);
    const kept = await Promise.all(orphans.map((n) => fsp.readFile(join(w.s.tmp, n), 'utf8')));
    assert.deepEqual([...kept].sort(), ['orphan of an earlier run\n', 'stale new\n', 'stale new, written to later\n'], 'every holder kept its bytes');
    const nameOf = (bytes: string): string => {
      const i = kept.indexOf(bytes);
      assert.ok(i >= 0, `an orphan holds ${JSON.stringify(bytes)}`);
      return orphans[i] as string;
    };
    const oldOrphan = nameOf('orphan of an earlier run\n');
    const changedNew = nameOf('stale new, written to later\n');
    assert.ok(oldOrphan.endsWith('.old') && changedNew.endsWith('.new'));
    // A write into the orphan .old: it is kept as it is (P2-STRANDED keeps every orphan .old; no record could name it).
    await fsp.appendFile(join(w.s.tmp, oldOrphan), 'late\n');
    w.s.clock.advance(RING_KEEP_MS - 1);
    await writer.sweepRing();
    assert.equal((await tmpNames(w, /^orphan-/)).length, 3, 'no orphan is resolved inside its 2 s window');
    // A write into one orphan .new inside its window: a changed pathless orphan is kept and logged (no record could name its bytes).
    await fsp.appendFile(join(w.s.tmp, changedNew), 'late\n');
    w.s.clock.advance(1);
    await writer.sweepRing();
    assert.deepEqual(await tmpNames(w, /^orphan-/), [changedNew, oldOrphan].sort(), 'the unchanged orphan .new is deleted after 2 s; the changed orphan .new and the orphan .old are kept');
    assert.equal(await fsp.readFile(join(w.s.tmp, changedNew), 'utf8'), 'stale new, written to later\nlate\n', 'the changed orphan .new keeps its bytes');
    assert.deepEqual(logged.filter((l) => l.code === 'RING_ORPHAN_CHANGED').map((l) => l.params), [{ file: join(w.s.tmp, changedNew) }], 'RING_ORPHAN_CHANGED names the changed orphan');
    assert.deepEqual(w.late, [], 'a changed pathless orphan never reaches onLateWrite');
    assert.deepEqual(await leftovers(w, /^\d.*\.(new|old|redo)$/), []);
  });
});

test('a copy-mode rollback on a full disk unlinks the .new files first and restores every file (P2-BESTEFFORT-ROLLBACK)', async () => {
  const target = (i: number): string => `R${i}-target\n`;   // 10 bytes each; the originals are 21 bytes
  const paths = ['src/r1.txt', 'src/r2.txt', 'src/r3.txt'];
  await withWriter('w-enospc', { mode: 'copy', wrap: tinyVolume({ n: 41 }) }, async (w) => {
    const g: WriteGroup = { n: 0, entries: await Promise.all(paths.map((p, i) => modify(w, p, target(i + 1), i))) };
    w.ffs.addRule({ op: 'writeFileExclusive', pathIncludes: w.s.abs('src/r3.txt'), code: 'ENOSPC', times: 1 });
    w.ffs.calls.length = 0;
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'disk_low'));
    for (const p of paths) assert.equal(await read(w, p), SEVEN, `${p}: restored`);
    const fail = w.ffs.calls.indexOf(`writeFileExclusive ${w.s.abs('src/r3.txt')}`);
    const firstRestore = w.ffs.calls.indexOf(`writeFileExclusive ${w.s.abs('src/r1.txt')}`, fail);
    const unlinkNew = w.ffs.calls.indexOf(`unlink ${join(w.s.tmp, '0.2.new')}`, fail);
    assert.ok(fail >= 0 && unlinkNew > fail && firstRestore > unlinkNew, 'the .new files go before the first restore, so their space comes back');
    assert.deepEqual(await leftovers(w), []);
  });
  // A disk too full even then: the partial file of the failed restore is removed, its .old kept, and the next sweep
  // restores it once space came back.
  await withWriter('w-enospc2', { mode: 'copy', wrap: tinyVolume({ n: 40 }) }, async (w) => {
    const g: WriteGroup = { n: 0, entries: await Promise.all(paths.map((p, i) => modify(w, p, target(i + 1), i))) };
    w.ffs.addRule({ op: 'writeFileExclusive', pathIncludes: w.s.abs('src/r3.txt'), code: 'ENOSPC', times: 1 });
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, { ...deferred(0, 'disk_low'), stranded: true }, 'the group reports its stranded restore (P2-STRANDED)');
    assert.equal(await read(w, 'src/r1.txt'), null, 'no partial file is left at r1');
    assert.equal(await fsp.readFile(join(w.s.tmp, '0.0.old'), 'utf8'), SEVEN, 'r1 keeps its .old');
    assert.deepEqual([await read(w, 'src/r2.txt'), await read(w, 'src/r3.txt')], [SEVEN, SEVEN], 'every other path is restored');
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt']);
    await w.writer.sweepRing();
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'restored at the next sweep');
    assert.deepEqual(w.writer.strandedPaths(), [], 'the sweep reports it restored: the caller may clear the intent it kept');
    assert.deepEqual(await leftovers(w), []);
  });
});

test("a rollback step a share-read holder refuses still links every other .old back, defers the group and keeps the earlier groups' results (P2-BESTEFFORT-ROLLBACK)", async () => {
  await withWriter('w-rb-holder', {}, async (w) => {
    const g0: WriteGroup = { n: 0, entries: [await modify(w, 'docs/d.txt', 'D\n', 0)] };
    const g1: WriteGroup = { n: 1, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await modify(w, 'src/b.txt', 'B\n', 1), await modify(w, 'src/c.txt', 'C\n', 2)] };
    const before = await Promise.all(['src/a.txt', 'src/c.txt'].map(async (p) => ({ bytes: await read(w, p), ino: await ino(w, p) })));
    // After a and b are linked, an Excel-like holder opens b; then c's link fails.
    const held = { release: (): void => {} };
    w.ffs.interpose('link', w.s.abs('src/c.txt'), async () => {
      held.release = w.ffs.holdLock(w.s.abs('src/b.txt'), 'share-read');
    });
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/c.txt'), code: 'EBUSY', times: 1 });
    const res = await w.writer.applyGroups([g0, g1], realRemerge(w));
    held.release();
    assert.deepEqual(res.map((r) => [r.n, r.outcome, r.reason]), [[0, 'written', null], [1, 'deferred', 'locked']], 'no throw: the earlier group keeps its result');
    assert.equal(await read(w, 'docs/d.txt'), 'D\n');
    for (const [i, p] of ['src/a.txt', 'src/c.txt'].entries()) {
      assert.equal(await read(w, p), before[i]!.bytes, `${p}: restored`);
      assert.equal(await ino(w, p), before[i]!.ino, `${p}: its .old linked back`);
    }
    assert.equal(await read(w, 'src/b.txt'), 'B\n', 'the held path stays as written');
    assert.deepEqual(await leftovers(w, /\.(new|redo)$/), []);
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(await leftovers(w), [], "b's .old went to the ring");
    assert.deepEqual(w.late, []);
  });
});

test('the link stat is taken at once and a failing .new unlink is not fatal: a later failure still restores the first path', async () => {
  await withWriter('w-linkstat', {}, async (w) => {
    const paths = ['src/a.txt', 'src/b.txt', 'src/c.txt'];
    const g: WriteGroup = { n: 0, entries: [await modify(w, paths[0]!, 'A\n', 0), await modify(w, paths[1]!, 'B\n', 1), await modify(w, paths[2]!, 'C\n', 2)] };
    const before = await Promise.all(paths.map(async (p) => ({ bytes: await read(w, p), ino: await ino(w, p) })));
    w.ffs.addRule({ op: 'unlink', pathIncludes: join(w.s.tmp, '0.0.new'), code: 'EPERM', times: 1 });
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/c.txt'), code: 'EBUSY', times: 1 });
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'locked'));
    for (const [i, p] of paths.entries()) {
      assert.equal(await read(w, p), before[i]!.bytes, `${p}: restored`);
      assert.equal(await ino(w, p), before[i]!.ino, `${p}: its .old linked back`);
    }
    assert.deepEqual(await leftovers(w), []);
  });
});

test('a create, modify or delete beneath a symlinked or junction directory is deferred unmaterializable and nothing outside the work tree is touched (P2-NOFOLLOW)', async () => {
  await withWriter('w-nofollow', {}, async (w) => {
    const outside = join(w.s.f.root, 'outside');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(join(outside, 'd.txt'), 'd1\n');
    // The tracked directory docs/ becomes a link to a directory outside the work tree (a junction on Windows).
    await fsp.rm(w.s.abs('docs'), { recursive: true });
    await fsp.symlink(outside, w.s.abs('docs'), process.platform === 'win32' ? 'junction' : 'dir');
    const look = async (): Promise<string[]> => Promise.all((await fsp.readdir(outside)).sort().map(async (n) => `${n}=${await fsp.readFile(join(outside, n), 'utf8')}`));
    const before = await look();
    const beneath = `${w.s.abs('docs')}${sep}`;
    w.ffs.calls.length = 0;
    const groups: WriteGroup[] = [
      { n: 0, entries: [await create(w, 'docs/evil.txt', 'evil\n', 0)] },
      { n: 1, entries: [await modify(w, 'docs/d.txt', 'D\n', 0)] },
      { n: 2, entries: [del(w, 'docs/d.txt', 0)] },
      { n: 3, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'docs/x/y.txt', 'y\n', 1)] },
    ];
    for (const g of groups) assert.deepEqual((await w.writer.applyGroups([g], realRemerge(w)))[0], deferred(g.n, 'unmaterializable'), JSON.stringify(g.entries.map((e) => e.path)));
    assert.equal(await read(w, 'src/a.txt'), SEVEN, 'the rest of the group is untouched');
    assert.deepEqual(await w.writer.writeLocal('docs/d.txt', aEntry(w, 'docs/d.txt').oid, await blob(w, 'local d\n'), 'resolve'), { kind: 'DEFERRED', reason: 'unmaterializable' });
    // A restart's rollback of an intent naming a path beneath the link never relinks its .old through it.
    await fsp.writeFile(join(w.s.tmp, '7.0.old'), 'g\n');
    const intent: Intent = { kind: 'apply', tip: w.s.head, board: w.s.head, groups: [{ n: 7, entries: [{ path: 'docs/gone.txt', kind: 'modify', slot: 0 }] }] };
    const report = await w.fresh().rollbackIntent(intent, new Map([['docs/gone.txt', { path: 'docs/gone.txt', mode: '100644' as const, oid: await blob(w, 'G\n') }]]));
    assert.deepEqual(report, { complete: [], rolledBack: [7], leftoverOld: [{ path: 'docs/gone.txt', file: join(w.s.tmp, '7.0.old') }] });
    assert.deepEqual(await look(), before, 'nothing outside the work tree changed');
    assert.deepEqual(w.ffs.calls.filter((c) => c.includes(beneath)), [], 'no call names a path beneath the link');
  });
});

test("an RT failure leaves the group's .old files in the ring, and the next group with the same temp name is written", async () => {
  await withWriter('w-rtfail', {}, async (w) => {
    const g0: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] };
    const target = g0.entries[0]!.target!.oid;
    let thrown = 0;
    const flaky = new Proxy(w.diskEq, {
      get(t, k) {
        if (k === 'eq') {
          return async (path: string, x: TreeEntry | typeof ABSENT, sRaw: TreeEntry | null) => {
            if (x !== ABSENT && x.oid === target && thrown === 0) {
              thrown++;
              throw errnoError('EIO', 'read', path);
            }
            return t.eq(path, x, sRaw);
          };
        }
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const writer = w.fresh({ diskEq: flaky });
    const [r] = await writer.applyGroups([g0], realRemerge(w));
    assert.equal(thrown, 1, 'the round trip failed');
    assert.equal(r?.outcome, 'written', 'the bytes are on disk: the group is reported, nothing is thrown');
    assert.equal(await read(w, 'src/a.txt'), 'A\n');
    assert.notEqual(w.s.statCache.get('src/a.txt')?.state, 'clean', 'an unverified write is never marked clean');
    const g1: WriteGroup = { n: 0, entries: [await modify(w, 'src/b.txt', 'B\n', 0)] };
    assert.equal((await writer.applyGroups([g1], realRemerge(w)))[0]?.outcome, 'written', 'the same temp name is free for the next group');
    assert.equal((await tmpNames(w, /\.old$/)).length, 2, "a's .old was in the ring and moved aside");
    w.s.clock.advance(RING_KEEP_MS);
    await writer.sweepRing();
    assert.deepEqual(await tmpNames(w, /\.(old|new|redo)$/), []);
  });
});

test('in copy mode the .old is compared by size and mtime only: a rename that changes the file id (FAT32, exFAT) still writes (P2-COPYSTAT)', async () => {
  /** lstat of a .old reports another file id than the file had before its rename. */
  const newId = (ffs: FaultFs): Fs => overrideFs(ffs, {
    async lstat(p: string) {
      const st = await ffs.lstat(p);
      return st !== null && p.endsWith('.old') ? { ...st, ino: st.ino + 7n } : st;
    },
  });
  await withWriter('w-copystat', { mode: 'copy', wrap: newId }, async (w) => {
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] }], realRemerge(w));
    assert.equal(r?.outcome, 'written');
    assert.equal(await read(w, 'src/a.txt'), 'A\n');
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(w.late, [], 'nor is the changed file id a late write');
    assert.deepEqual(await leftovers(w), []);
  });
  await withWriter('w-copystat-link', { mode: 'link', wrap: newId }, async (w) => {
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] }], realRemerge(w));
    assert.deepEqual(r, deferred(0, 'mismatch'), 'link mode keeps the file-id check');
    assert.equal(await read(w, 'src/a.txt'), SEVEN);
  });
});

test('probeMode probes a hard link from tmp/ into the work tree: EXDEV there selects the copy fallback, and the write succeeds', async () => {
  await withWriter('w-xdev', { wrap: crossVolume }, async (w) => {
    const workTree = w.s.f.paths.workTree;
    w.ffs.addRule({ op: 'link', pathIncludes: '~cowork-link-probe', code: 'EXDEV', times: 1 });
    assert.equal(await Writer.probeMode(w.ffs, w.s.tmp, workTree), 'copy', 'a FaultFs EXDEV on the work-tree probe');
    // The gitdir on another volume: every link out of tmp/ fails EXDEV.
    const mode = await Writer.probeMode(w.deps.fs, w.s.tmp, workTree);
    assert.equal(mode, 'copy');
    const writer = w.fresh({ mode });
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/n.txt', 'N\n', 1)] };
    assert.equal((await writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
    assert.deepEqual([await read(w, 'src/a.txt'), await read(w, 'src/n.txt')], ['A\n', 'N\n']);
    // A user file with the probe's name is never touched; a hard link a crashed probe left is removed.
    const mine = join(workTree, '~cowork-link-probe.tmp');
    await fsp.writeFile(mine, 'mine\n');
    const st = await realFs.lstat(mine);
    await fsp.writeFile(join(w.s.tmp, 'link-probe.a'), 'cowork link probe\n');
    await fsp.link(join(w.s.tmp, 'link-probe.a'), join(workTree, '~cowork-link-probe-1.tmp'));
    assert.equal(await Writer.probeMode(w.ffs, w.s.tmp, workTree), 'link');
    assert.deepEqual(await realFs.lstat(mine), st, 'the user file is untouched');
    assert.deepEqual((await fsp.readdir(workTree)).filter((n) => n.startsWith('~cowork')), ['~cowork-link-probe.tmp']);
    assert.deepEqual(await tmpNames(w, /probe/), []);
    for (const n of ['~cowork-link-probe.tmp', '~cowork-link-probe-1.tmp']) assert.ok(TEMP_PATTERNS.some((p) => wildmatch(p, n, true)), `${n} is a temp name D6 never admits`);
  });
});

test('a link-mode .new is written by an exclusive create (with fsync) before it is linked into place', async () => {
  await withWriter('w-fsync', {}, async (w) => {
    w.ffs.calls.length = 0;
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await create(w, 'src/n.txt', 'N\n', 1)] };
    assert.equal((await w.writer.applyGroups([g], realRemerge(w)))[0]?.outcome, 'written');
    for (const [slot, p] of [[0, 'src/a.txt'], [1, 'src/n.txt']] as const) {
      const nw = join(w.s.tmp, `0.${slot}.new`);
      const made = w.ffs.calls.indexOf(`writeFileExclusive ${nw}`);
      const linked = w.ffs.calls.indexOf(`link ${nw} -> ${w.s.abs(p)}`);
      assert.ok(made >= 0 && linked > made, `${p}: written and synced before the link`);
    }
    assert.deepEqual(w.ffs.calls.filter((c) => c.startsWith('writeFile ') && c.endsWith('.new')), [], 'never a plain write without fsync');
  });
});

test('the writer refuses symlink (120000) and gitlink (160000) entries: the group defers unmaterializable untouched', async () => {
  await withWriter('w-modes', {}, async (w) => {
    const symlink: WriteEntry = { path: 'src/l', kind: 'create', slot: 1, target: { path: 'src/l', mode: '120000', oid: await blob(w, 'a.txt') }, sRaw: null, sDisk: null };
    const gitlink: WriteEntry = { ...(await modify(w, 'src/b.txt', 'B\n', 1)), sRaw: { path: 'src/b.txt', mode: '160000', oid: w.s.head } };
    for (const bad of [symlink, gitlink]) {
      const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), bad] };
      w.ffs.calls.length = 0;
      const [r] = await w.writer.applyGroups([g], realRemerge(w));
      assert.deepEqual(r, deferred(0, 'unmaterializable'), bad.path);
      assert.deepEqual(w.ffs.calls, [], 'nothing is looked at, moved or written (no fs call, no git call)');
    }
    assert.equal(await read(w, 'src/a.txt'), SEVEN);
    assert.equal(await realFs.lstat(w.s.abs('src/l')), null);
    // writeLocal of a path the private index holds as a symlink.
    await w.s.repo.editIndex(w.privateIndex, [{ path: 'src/c.txt', mode: '120000', oid: await blob(w, 'a.txt') }]);
    assert.deepEqual(await w.writer.writeLocal('src/c.txt', aEntry(w, 'src/c.txt').oid, await blob(w, 'C\n'), 'resolve'), { kind: 'DEFERRED', reason: 'unmaterializable' });
    assert.equal(await read(w, 'src/c.txt'), 'c1\nc2\n');
  });
});

test('a re-merge of a filtered or -text path is fed the raw disk blob: canon runs only on text, unfiltered paths (D1 step 1)', async () => {
  const CRLF = 'c1\r\nc2\r\nc3\r\nc4\r\nc5\r\nc6\r\nc7\r\n';
  const files: Record<string, Buffer> = { ...FILES, 'src/f.txt': Buffer.from(CRLF), 'src/bin.txt': Buffer.from(CRLF), 'src/t.txt': Buffer.from(CRLF) };
  await withWriter('w-canonskip', { files, filtered: (p) => p === 'src/f.txt', text: (p) => p !== 'src/bin.txt' }, async (w) => {
    const human = 'h1\nc2\nc3\nc4\nc5\nc6\nc7\n';   // saved with LF endings over a CRLF-stored file
    const seen = new Map<string, Oid>();
    const remerge: Remerge = async (e, found) => {
      seen.set(e.path, found.oid);
      return null;
    };
    for (const p of ['src/f.txt', 'src/bin.txt', 'src/t.txt']) {
      await w.s.write(p, human);
      const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, p, CRLF.replace('c7', 'T7'), 0)] }], remerge);
      assert.deepEqual(r, deferred(0, 'mismatch'), p);
    }
    assert.equal(seen.get('src/f.txt'), await blob(w, human), 'filtered: found is the raw blob, never canon');
    assert.equal(seen.get('src/bin.txt'), await blob(w, human), '-text: found is the raw blob, never canon');
    assert.equal(seen.get('src/t.txt'), await blob(w, human.replace(/\n/g, '\r\n')), 'text, unfiltered: canon to the stored CRLF form');
  });
});

// ---- fix round 2 (ruling P2-STRANDED) ----

/** Five seconds of loop iterations: the clock advances 1 s before each sweep. */
async function sweepFor5s(w: W, writer: Writer): Promise<void> {
  for (let t = 0; t < 5; t++) {
    w.s.clock.advance(1_000);
    await writer.sweepRing();
  }
}

test('a stranded restore keeps the apply intent journaled (GroupResult.stranded), and after a restart rollbackIntent restores p before the same n.slot is applied again (P2-STRANDED)', async () => {
  await withWriter('w-strand-apply', {}, async (w) => {
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/r1.txt', 'R1-target\n', 0)] };
    // The caller (Task 13) journaled J before applyGroups; its ENG-36 update clears J unless a group is stranded.
    let journaled: Intent = applyIntent(w, [g]);
    // P2's link fails EPERM, and so do the rollback's relink of the .old and the next sweep's retry.
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 3 });
    const [r] = await w.writer.applyGroups([g], realRemerge(w));
    assert.deepEqual(r, { ...deferred(0, 'locked'), stranded: true }, 'the group reports its stranded restore');
    if (r?.stranded !== true) journaled = { kind: 'none' };
    const old = join(w.s.tmp, '0.0.old');
    assert.equal(await read(w, 'src/r1.txt'), null, 'p is absent');
    assert.equal(await fsp.readFile(old, 'utf8'), SEVEN, 'its .old keeps the bytes at the intent name');
    await w.writer.sweepRing();
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt'], 'the retry failed: still stranded, the caller keeps J');
    // The daemon dies here. The restart reads the still-journaled J and rolls it back with a fresh Writer first
    // (ENG-53 step 4), then applies as usual.
    assert.equal(journaled.kind, 'apply', 'J is still journaled');
    const fresh = w.fresh();
    const report = await fresh.rollbackIntent(journaled, targetsOf([g]));
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] });
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'p is restored from its .old');
    assert.equal(await realFs.lstat(old), null);
    const [r2] = await fresh.applyGroups([g], realRemerge(w));
    assert.equal(r2?.outcome, 'written', 'the same n.slot is free and written');
    assert.equal(await read(w, 'src/r1.txt'), 'R1-target\n');
    await sweepFor5s(w, fresh);
    assert.deepEqual(await tmpNames(w, /\.(old|new|redo)$/), []);
  });
  // Applied in the other order (the same n.slot before anything resolved the stranded .old): the fresh Writer knows
  // no path for it, so it is moved aside and kept, never deleted.
  await withWriter('w-strand-orphan', {}, async (w) => {
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/r1.txt', 'R1-target\n', 0)] }], realRemerge(w));
    assert.equal(r?.stranded, true);
    const fresh = w.fresh();
    const [r2] = await fresh.applyGroups([{ n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0)] }], realRemerge(w));
    assert.equal(r2?.outcome, 'written');
    const kept = await tmpNames(w, /^orphan-.*\.old$/);
    assert.equal(kept.length, 1, 'the stranded .old was moved aside');
    await sweepFor5s(w, fresh);
    assert.deepEqual(await tmpNames(w, /^orphan-/), kept, 'still on disk after 5 s of sweeps');
    assert.equal(await fsp.readFile(join(w.s.tmp, kept[0]!), 'utf8'), SEVEN, "r1's bytes are intact");
  });
});

test('a stranded local write keeps its local intent journaled and defers later local writes until a sweep restores p and clears it; a restart restores p from the kept intent (P2-STRANDED)', async () => {
  await withWriter('w-strand-local', {}, async (w) => {
    const r1 = aEntry(w, 'src/r1.txt').oid;
    const target = await blob(w, 'R1-local\n');
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 3 });
    assert.deepEqual(await w.writer.writeLocal('src/r1.txt', r1, target, 'resolve'), { kind: 'LOCKED' });
    const kept: Intent = { kind: 'local', origin: 'resolve', entries: [{ path: 'src/r1.txt', expected: r1, target, slot: 0 }] };
    assert.deepEqual(w.journal, [kept], 'no {kind: none} while its restore is stranded');
    assert.equal(await read(w, 'src/r1.txt'), null);
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt']);
    // A new local intent would replace the kept one: while the retry still fails, a local write is deferred unjournaled.
    const r2 = aEntry(w, 'src/r2.txt').oid;
    const t2 = await blob(w, 'R2-local\n');
    assert.deepEqual(await w.writer.writeLocal('src/r2.txt', r2, t2, 'resolve'), { kind: 'DEFERRED', reason: 'locked' });
    assert.deepEqual(w.journal, [kept]);
    assert.equal(await read(w, 'src/r2.txt'), SEVEN);
    // The next sweep restores p and clears the kept intent.
    await w.writer.sweepRing();
    assert.equal(await read(w, 'src/r1.txt'), SEVEN);
    assert.deepEqual(w.writer.strandedPaths(), []);
    assert.deepEqual(w.journal, [kept, { kind: 'none' }]);
    assert.deepEqual(await w.writer.writeLocal('src/r2.txt', r2, t2, 'resolve'), { kind: 'WRITTEN' });
    assert.deepEqual(w.journal.slice(2).map((j) => j.kind), ['local', 'none']);
  });
  await withWriter('w-strand-local-restart', {}, async (w) => {
    const target = await blob(w, 'R1-local\n');
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    assert.deepEqual(await w.writer.writeLocal('src/r1.txt', aEntry(w, 'src/r1.txt').oid, target, 'resolve'), { kind: 'LOCKED' });
    const intent = w.journal[w.journal.length - 1];
    assert.equal(intent?.kind, 'local', 'the local intent is still journaled when the daemon dies');
    const report = await w.fresh().rollbackIntent(intent!, new Map([['src/r1.txt', { path: 'src/r1.txt', mode: '100644' as const, oid: target }]]));
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] });
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'p is restored from its .old');
    assert.deepEqual(await leftovers(w), []);
  });
});

test('an orphan .old is moved aside and never deleted, whether its path is unknown or known from rollbackIntent, while an orphan .new is ring-deleted (P2-STRANDED)', async () => {
  await withWriter('w-orphan-kept', {}, async (w) => {
    await fsp.writeFile(join(w.s.tmp, '0.0.old'), 'orphan of an earlier run\n');
    await fsp.writeFile(join(w.s.tmp, '0.1.new'), 'stale new\n');
    await fsp.writeFile(join(w.s.tmp, '7.0.old'), 'known old\n');
    const writer = w.fresh();
    // A restart's rollbackIntent hands tmp/7.0.old over with its path (a complete group: p holds its target).
    const intent: Intent = { kind: 'apply', tip: w.s.head, board: w.s.head, groups: [{ n: 7, entries: [{ path: 'src/c.txt', kind: 'modify', slot: 0 }] }] };
    const report = await writer.rollbackIntent(intent, new Map([['src/c.txt', aEntry(w, 'src/c.txt')]]));
    assert.deepEqual(report, { complete: [7], rolledBack: [], leftoverOld: [{ path: 'src/c.txt', file: join(w.s.tmp, '7.0.old') }] });
    // Later groups need all three names (nothing resolved tmp/7.0.old in between).
    const res = await writer.applyGroups([
      { n: 0, entries: [await modify(w, 'src/a.txt', 'A\n', 0), await modify(w, 'src/b.txt', 'B\n', 1)] },
      { n: 7, entries: [await modify(w, 'src/r1.txt', 'R1\n', 0)] },
    ], realRemerge(w));
    assert.deepEqual(res.map((r) => r.outcome), ['written', 'written']);
    const moved = await tmpNames(w, /^orphan-/);
    assert.equal(moved.length, 3, 'every holder was moved aside');
    await sweepFor5s(w, writer);
    const left = await tmpNames(w, /^orphan-/);
    assert.deepEqual(left, moved.filter((n) => n.endsWith('.old')), 'both orphan .old files are still on disk after 5 s of sweeps; the orphan .new is deleted');
    const bytes = (await Promise.all(left.map((n) => fsp.readFile(join(w.s.tmp, n), 'utf8')))).sort();
    assert.deepEqual(bytes, ['known old\n', 'orphan of an earlier run\n']);
    assert.deepEqual(w.late, []);
    assert.deepEqual(await leftovers(w, /^\d.*\.(new|old|redo)$/), [], "the written groups' own .old files are ring-deleted as usual");
  });
});

// ---- fix round 3 (ruling P2-NARROW) ----

test('the caller keeps only the stranded groups (narrowToStranded): after the user edits a written modify, a restart leaves the written group and its create alone and restores the stranded path (P2-NARROW)', async () => {
  await withWriter('w-narrow-apply', {}, async (w) => {
    const g0: WriteGroup = { n: 0, entries: [await create(w, 'src/n.txt', 'N\n', 0), await modify(w, 'src/a.txt', 'A\n', 1)] };
    const g1: WriteGroup = { n: 1, entries: [await modify(w, 'src/r1.txt', 'R1-target\n', 0)] };
    // The caller (Task 13) journaled J = both groups before applyGroups.
    const J = applyIntent(w, [g0, g1]);
    // r1's P2 link fails EPERM, and so do the rollback's relink of its .old and the next sweep's retry.
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 3 });
    const res = await w.writer.applyGroups([g0, g1], realRemerge(w));
    assert.deepEqual(res.map((r) => [r.n, r.outcome, r.reason, r.stranded]), [[0, 'written', null, false], [1, 'deferred', 'locked', true]]);
    // Its ENG-36 update moves A for group 0 and keeps ONLY the narrowed intent.
    const kept = narrowToStranded(J, res);
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt'], 'the retry failed: still stranded');
    // The user edits the written modify; then the daemon dies and the restart rolls back the kept intent.
    await fsp.writeFile(w.s.abs('src/a.txt'), 'human edit\n');
    const report = await w.fresh().rollbackIntent(kept, targetsOf([g0, g1]));
    assert.equal(await read(w, 'src/n.txt'), 'N\n', "the written group's create survives the restart");
    assert.equal(await read(w, 'src/a.txt'), 'human edit\n', "the user's edit survives");
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'the stranded path is restored from its .old');
    assert.deepEqual(report, { complete: [], rolledBack: [1], leftoverOld: [] });
    assert.deepEqual(await leftovers(w), []);
    assert.deepEqual(kept, applyIntent(w, [g1]), 'only the stranded group is kept, its entries in full');
    assert.deepEqual(Writer.narrowToStranded(J, res), kept, 'Writer.narrowToStranded is the same narrowing');
    assert.deepEqual(narrowToStranded(J, res.map((r) => ({ ...r, stranded: false }))), { kind: 'none' }, 'no stranded group: nothing is kept');
    const local: Intent = { kind: 'local', origin: 'resolve', entries: [{ path: 'src/r1.txt', expected: aEntry(w, 'src/r1.txt').oid, target: g1.entries[0]!.target!.oid, slot: 0 }] };
    assert.deepEqual(narrowToStranded(local, [{ ...deferred(0, 'locked'), stranded: true }]), local, 'a local intent is one group (n = 0)');
    assert.deepEqual(narrowToStranded(local, [deferred(0, 'locked')]), { kind: 'none' });
  });
});

test('a stranded local write keeps only its stranded entries journaled: a restart leaves a file the user created at its rolled-back create alone and restores the stranded path (P2-NARROW)', async () => {
  await withWriter('w-narrow-local', {}, async (w) => {
    const r1 = aEntry(w, 'src/r1.txt').oid;
    const n = await blob(w, 'N\n');
    const t1 = await blob(w, 'R1-local\n');
    // r1's P2 link fails EPERM, and so does the rollback's relink of its .old; the create before it is linked, then removed.
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    assert.deepEqual(await w.writer.writeLocalGroup([
      { path: 'src/n.txt', expected: ABSENT, target: n },
      { path: 'src/r1.txt', expected: r1, target: t1 },
    ], 'resolve'), { kind: 'LOCKED' });
    assert.equal(await read(w, 'src/n.txt'), null, 'the rolled-back create is gone');
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt']);
    // The user creates src/n.txt by hand with the same bytes; then the daemon dies.
    await fsp.writeFile(w.s.abs('src/n.txt'), 'N\n');
    const last = w.journal[w.journal.length - 1];
    assert.ok(last !== undefined && last.kind === 'local', 'a local intent is still journaled');
    const report = await w.fresh().rollbackIntent(last, new Map<string, TreeEntry | null>([
      ['src/n.txt', { path: 'src/n.txt', mode: '100644', oid: n }],
      ['src/r1.txt', { path: 'src/r1.txt', mode: '100644', oid: t1 }],
    ]));
    assert.equal(await read(w, 'src/n.txt'), 'N\n', "the user's file survives the restart");
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'the stranded path is restored from its .old');
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] });
    assert.deepEqual(await leftovers(w), []);
    const full: Intent = { kind: 'local', origin: 'resolve', entries: [
      { path: 'src/n.txt', expected: ABSENT, target: n, slot: 0 },
      { path: 'src/r1.txt', expected: r1, target: t1, slot: 1 },
    ] };
    assert.deepEqual(w.journal, [full, { kind: 'local', origin: 'resolve', entries: [{ path: 'src/r1.txt', expected: r1, target: t1, slot: 1 }] }],
      'the kept local intent is narrowed to its stranded entry, never cleared while the restore is stranded');
  });
});

// ---- fix round 4 (ruling P2-NARROW-DELETE) ----

/** What a restart (Task 15) passes rollbackIntent for a journaled local intent: each entry's target as a blob entry, 'DELETE' as null. */
function localTargets(intent: Intent): Map<string, TreeEntry | null> {
  assert.equal(intent.kind, 'local', 'a local intent is journaled');
  if (intent.kind !== 'local') return new Map();
  return new Map(intent.entries.map((e) => [e.path, e.target === 'DELETE' ? null : { path: e.path, mode: '100644' as const, oid: e.target }] as const));
}

/**
 * The next snapshot after the restart: two detection ticks DELETE_CONFIRM_MS apart (the deletion rule) and a
 * materialize stage no removal of `path`, which keeps its A entry in S_raw.
 */
async function assertNoRemovalStaged(w: W, path: string): Promise<void> {
  const inp: TickInput = {
    A: w.s.A, aTree: (await w.s.repo.readCommit(w.s.head)).tree, epochBase: w.s.head, skip: new Set(),
    scope: {
      attrs: await new AttrCache(w.s.repo, w.s.fs).snapshot(w.s.head, w.s.A.keys()), config: DEFAULT_TEAM_CONFIG,
      mergeDrivers: new Set(), localOnlyPaths: new Set(), hooksPathDir: null,
    },
  };
  const t1 = await w.snap.tick(inp);
  assert.equal(t1.excluded.get(path), undefined, `${path}: no deletion is pending at the first tick`);
  w.s.clock.advance(DELETE_CONFIRM_MS);
  const t2 = await w.snap.tick(inp);
  assert.equal(t2.dirty.get(path), undefined, `${path}: no removal is staged a second later`);
  const m = await w.snap.materialize(inp);
  assert.deepEqual(m.sRawMap.get(path), aEntry(w, path), `${path} keeps its A entry in S_raw`);
}

const D = 'docs/d.txt';

/**
 * writeLocalGroup([<other> p, delete d]): p's P2 link fails EPERM once (the rollback puts a modify back; a create was
 * never linked), and the rollback's relink of d's .old fails EPERM once, so d is the only stranded entry. Then the
 * daemon dies, and the restart rolls back the last journaled intent with a fresh Writer (ENG-53 step 4).
 */
async function strandedDeleteBeside(other: 'modify' | 'create'): Promise<void> {
  await withWriter(`w-narrow-delete-${other}`, {}, async (w) => {
    const d = aEntry(w, D).oid;
    const p = other === 'modify' ? 'src/a.txt' : 'src/n.txt';
    const expected = other === 'modify' ? aEntry(w, p).oid : ABSENT;
    const t = await blob(w, other === 'modify' ? 'A-local\n' : 'N\n');
    const before = other === 'modify' ? SEVEN : null;
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs(p), code: 'EPERM', times: 1 });
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs(D), code: 'EPERM', times: 1 });
    assert.deepEqual(await w.writer.writeLocalGroup([
      { path: p, expected, target: t },
      { path: D, expected: d, target: 'DELETE' },
    ], 'resolve'), { kind: 'LOCKED' });
    assert.deepEqual(w.writer.strandedPaths(), [D]);
    assert.equal(await read(w, D), null, 'd is absent, its .old kept at its intent name');
    assert.equal(await read(w, p), before, `the rollback undid ${p}`);
    const last = w.journal[w.journal.length - 1]!;
    const report = await w.fresh().rollbackIntent(last, localTargets(last));
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] }, 'the kept group is rolled back, never read as complete');
    assert.equal(await read(w, D), 'd1\n', 'd is restored from its .old');
    assert.equal(await read(w, p), before);
    assert.deepEqual(await leftovers(w), []);
    await assertNoRemovalStaged(w, D);
    assert.deepEqual(w.journal, [
      { kind: 'local', origin: 'resolve', entries: [{ path: p, expected, target: t, slot: 0 }, { path: D, expected: d, target: 'DELETE', slot: 1 }] },
      { kind: 'local', origin: 'resolve', entries: [{ path: D, expected: d, target: d, slot: 1 }] },
    ], 'the kept intent holds d as a restore: target = expected');
  });
}

test('a stranded delete beside a restored modify stays journaled as a restore (target := expected): a restart relinks its .old instead of reading the group complete, and the next snapshot stages no removal (P2-NARROW-DELETE)', async () => {
  await strandedDeleteBeside('modify');
});

test('a stranded delete beside a rolled-back create stays journaled as a restore (target := expected): a restart relinks its .old instead of reading the group complete, and the next snapshot stages no removal (P2-NARROW-DELETE)', async () => {
  await strandedDeleteBeside('create');
});

test('a lone stranded local delete is journaled again as a restore (target := expected), and a restart relinks its .old (P2-NARROW-DELETE)', async () => {
  // P1's .old stat check fails (the rename changed the file id) and the rollback's relink fails EPERM once. The
  // narrowed intent has as many entries as the journaled one, and its converted entry is still journaled.
  const newId = (ffs: FaultFs): Fs => overrideFs(ffs, {
    async lstat(p: string) {
      const st = await ffs.lstat(p);
      return st !== null && p.endsWith('.old') ? { ...st, ino: st.ino + 7n } : st;
    },
  });
  await withWriter('w-narrow-delete-lone', { wrap: newId }, async (w) => {
    const d = aEntry(w, D).oid;
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs(D), code: 'EPERM', times: 1 });
    assert.deepEqual(await w.writer.writeLocal(D, d, 'DELETE', 'resolve'), { kind: 'DEFERRED', reason: 'mismatch' });
    assert.deepEqual(w.writer.strandedPaths(), [D]);
    assert.equal(await read(w, D), null);
    const last = w.journal[w.journal.length - 1]!;
    const report = await w.fresh().rollbackIntent(last, localTargets(last));
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] }, 'the kept one-entry intent is rolled back, never read as complete');
    assert.equal(await read(w, D), 'd1\n', 'd is restored from its .old');
    assert.deepEqual(await leftovers(w), []);
    await assertNoRemovalStaged(w, D);
    assert.deepEqual(w.journal, [
      { kind: 'local', origin: 'resolve', entries: [{ path: D, expected: d, target: 'DELETE', slot: 0 }] },
      { kind: 'local', origin: 'resolve', entries: [{ path: D, expected: d, target: d, slot: 0 }] },
    ], 'a one-entry kept intent is journaled again when its delete becomes a restore');
  });
});

// ---- final review fix group FB ----

test('final review FB-1: a local write frees its temp names before its intent is journaled: a stale tmp/L.0.old an earlier Writer left is moved aside, so a restart after a kill right after the journal never reads it as this intent\'s .old (no leftover, a path deleted meanwhile is not brought back with its bytes)', async () => {
  for (const deletedMeanwhile of [false, true]) {
    let kill = true;
    await withWriter(`w-fb1-local-${deletedMeanwhile ? 'deleted' : 'present'}`, {
      journal: () => async (intent) => {
        if (kill && intent.kind === 'local') {
          kill = false;
          throw new KilledAt('test.after_journal');
        }
      },
    }, async (w) => {
      // An earlier daemon's local write left its ring .old at tmp/L.0.old (an unlink that kept failing, then a crash).
      const stale = join(w.s.tmp, 'L.0.old');
      await fsp.writeFile(stale, 'the bytes of another path\n');
      const b = aEntry(w, 'src/b.txt').oid;
      const target = await blob(w, 'b1\nB2\n');
      // A fresh daemon's first local write (slot 0 again) is killed right after its intent is journaled.
      await assert.rejects(w.fresh().writeLocal('src/b.txt', b, target, 'resolve'), KilledAt);
      const intent = w.journal[w.journal.length - 1]!;
      assert.equal(intent.kind, 'local');
      assert.equal(await read(w, 'src/b.txt'), 'b1\nb2\n', 'nothing was written');
      if (deletedMeanwhile) await fsp.unlink(w.s.abs('src/b.txt'));
      const report = await w.fresh().rollbackIntent(intent, localTargets(intent));
      assert.deepEqual(report.leftoverOld, [], 'no stale file is reported as this intent\'s .old');
      assert.equal(await read(w, 'src/b.txt'), deletedMeanwhile ? null : 'b1\nb2\n', 'p is as the user left it (never relinked from another path\'s bytes)');
      const kept = await tmpNames(w, /^orphan-.*\.old$/);
      assert.equal(kept.length, 1, 'the stale .old was moved aside to an orphan name, never deleted');
      assert.equal(await fsp.readFile(join(w.s.tmp, kept[0]!), 'utf8'), 'the bytes of another path\n');
    });
  }
});

test('final review FB-1: Writer.reserve frees every temp name of the groups before the caller journals them: a stale .old at an intent name goes to an orphan name, a young ring .old to a ring name (its late write still reaches onLateWrite); a holder that refuses the move returns false and keeps the file', async () => {
  await withWriter('w-fb1-reserve', {}, async (w) => {
    // A young ring .old at 0.0.old (an earlier group in this run) and a stale .old of an earlier run at 0.1.old.
    const first = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/a.txt', 'A1\n', 0)] }], realRemerge(w));
    assert.equal(first[0]?.outcome, 'written');
    await fsp.writeFile(join(w.s.tmp, '0.1.old'), 'stale bytes of an earlier run\n');
    const g: WriteGroup = { n: 0, entries: [await modify(w, 'src/b.txt', 'B1\n', 0), await modify(w, 'src/c.txt', 'C1\n', 1)] };
    assert.equal(await w.writer.reserve([g]), true);
    assert.deepEqual(await tmpNames(w, /^0\.[01]\.(new|old|redo)$/), [], 'every temp name of the group is free');
    const ring = await tmpNames(w, /^ring-.*\.old$/);
    assert.equal(ring.length, 1, 'the ring .old keeps its ring entry under a ring name');
    await fsp.writeFile(join(w.s.tmp, ring[0]!), 'a late write\n');
    const orphans = await tmpNames(w, /^orphan-.*\.old$/);
    assert.equal(orphans.length, 1, 'the stale .old is kept under an orphan name');
    // The journaled intent then rolls back to nothing of another path (a kill at apply.intent).
    const report = await w.fresh().rollbackIntent(applyIntent(w, [g]), targetsOf([g]));
    assert.deepEqual(report, { complete: [], rolledBack: [0], leftoverOld: [] });
    w.s.clock.advance(RING_KEEP_MS);
    await w.writer.sweepRing();
    assert.deepEqual(w.late.map((l) => [l.path, l.bytes.toString('utf8')]), [['src/a.txt', 'a late write\n']], 'the moved ring entry still reaches onLateWrite');
    // A holder that refuses the move (EBUSY): reserve answers false and the file stays where it is.
    await fsp.writeFile(join(w.s.tmp, '0.0.old'), 'held\n');
    w.ffs.addRule({ op: 'rename', pathIncludes: join(w.s.tmp, '0.0.old'), code: 'EBUSY', times: 1 });
    assert.equal(await w.writer.reserve([g]), false);
    assert.equal(await fsp.readFile(join(w.s.tmp, '0.0.old'), 'utf8'), 'held\n');
  });
});

test('final review FB-3: a stranded restore whose .old vanished (AV quarantine, a cleaned tmp/) restores p from the pre-image blob; a failing restore keeps the entry stranded (the kept intent stays journaled); something now at p ends it untouched', async () => {
  await withWriter('w-fb3-apply', {}, async (w) => {
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/r1.txt', 'R1-target\n', 0)] }], realRemerge(w));
    assert.equal(r?.stranded, true);
    assert.equal(await read(w, 'src/r1.txt'), null);
    await fsp.unlink(join(w.s.tmp, '0.0.old'));
    // The first sweep's restore from the blob fails (a holder on p): still stranded.
    w.ffs.addRule({ op: 'writeFileExclusive', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 1 });
    await w.writer.sweepRing();
    assert.deepEqual(w.writer.strandedPaths(), ['src/r1.txt'], 'a failed restore keeps the entry: p stays covered');
    assert.equal(await read(w, 'src/r1.txt'), null);
    await w.writer.sweepRing();
    assert.deepEqual(w.writer.strandedPaths(), []);
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'p is restored from its pre-image blob');
  });
  await withWriter('w-fb3-local', {}, async (w) => {
    const t = await blob(w, 'R1-local\n');
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    assert.deepEqual(await w.writer.writeLocal('src/r1.txt', aEntry(w, 'src/r1.txt').oid, t, 'resolve'), { kind: 'LOCKED' });
    assert.deepEqual(w.journal.map((j) => j.kind), ['local']);
    await fsp.unlink(join(w.s.tmp, 'L.0.old'));
    await w.writer.sweepRing();
    assert.equal(await read(w, 'src/r1.txt'), SEVEN, 'p is restored from the expected blob');
    assert.deepEqual(w.writer.strandedPaths(), []);
    assert.deepEqual(w.journal.map((j) => j.kind), ['local', 'none'], 'the kept local intent is cleared only once p is back');
  });
  await withWriter('w-fb3-exists', {}, async (w) => {
    w.ffs.addRule({ op: 'link', pathIncludes: w.s.abs('src/r1.txt'), code: 'EPERM', times: 2 });
    const [r] = await w.writer.applyGroups([{ n: 0, entries: [await modify(w, 'src/r1.txt', 'R1-target\n', 0)] }], realRemerge(w));
    assert.equal(r?.stranded, true);
    await fsp.unlink(join(w.s.tmp, '0.0.old'));
    await fsp.writeFile(w.s.abs('src/r1.txt'), 'the user wrote p meanwhile\n');
    await w.writer.sweepRing();
    assert.deepEqual(w.writer.strandedPaths(), []);
    assert.equal(await read(w, 'src/r1.txt'), 'the user wrote p meanwhile\n', 'never overwritten');
  });
});
