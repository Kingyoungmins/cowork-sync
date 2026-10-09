// The snapshot: detection ticks by staged reads (no object written), materialize, reseed (01-engine §3.8; ENG-23…ENG-27;
// glossary §26.1 W1–W3, W6; rulings R-07, R-10, R-25, R-38; Review Focus 1). Real git on file:// clones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import { AttrCache } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG } from '../../src/data/config.js';
import type { FilterSet } from '../../src/data/filters.js';
import type { ScopeInputs } from '../../src/data/scope.js';
import { humanOnlyAttribution, type AttributionPort } from '../../src/engine/deps.js';
import { Snapshotter, UNTRACKED_RESCAN_MS, type Materialized, type TickInput, type TickResult } from '../../src/engine/snapshot.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import type { TreeEntry, TreeMap } from '../../src/git/repo.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { realFs, type Fs, type FsLstat } from '../../src/ports/fs.js';
import { noTrace } from '../../src/ports/trace.js';
import { IndexRefusedPathError } from '../../src/engine/treeEdit.js';
import { makeSnapFixture, type SnapFixture } from '../helpers/snapFixture.js';

interface Snap { s: SnapFixture; snap: Snapshotter; inp: TickInput; privateIndex: string; tree: Oid; }
/** Snapshotter overrides: attribution, the FilterSet (default: the fixture's drivers), the platform and the Fs. */
interface SnapOpts { attribution?: AttributionPort; filters?: FilterSet; platform?: NodeJS.Platform; fs?: Fs; }

async function scopeInputs(s: SnapFixture): Promise<ScopeInputs> {
  return {
    attrs: await new AttrCache(s.repo, s.fs).snapshot(s.head, s.A.keys()),
    config: DEFAULT_TEAM_CONFIG,
    mergeDrivers: new Set(),
    localOnlyPaths: new Set(),
    hooksPathDir: null,
  };
}

const PRIVATE_INDEX = (s: SnapFixture): string => join(s.f.paths.coworkDir, 'main.index');

function makeSnap(s: SnapFixture, o: SnapOpts = {}, drivers: readonly string[] = []): Snapshotter {
  return new Snapshotter({
    repo: s.repo, fs: o.fs ?? s.fs, clock: s.clock, trace: noTrace, peer: '0123456789abcdef0123456789abcdef',
    privateIndex: PRIVATE_INDEX(s), scratch: { detect: join(s.tmp, 'detect.index'), canon: join(s.tmp, 'canon.index') },
    stage: s.stage, statCache: s.statCache, attribution: o.attribution ?? humanOnlyAttribution,
    filters: o.filters ?? { drivers: [...drivers], fingerprint: {}, overCap: null },
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
  });
}

async function snapFor(s: SnapFixture, o: SnapOpts = {}, drivers: readonly string[] = []): Promise<Snap> {
  const snap = makeSnap(s, o, drivers);
  const tree = (await s.repo.readCommit(s.head)).tree;
  await snap.reseed(tree);
  const inp: TickInput = { A: s.A, aTree: tree, epochBase: s.head, scope: await scopeInputs(s), skip: new Set() };
  return { s, snap, inp, privateIndex: PRIVATE_INDEX(s), tree };
}

/** A tree entry for treeWith: a path (a Buffer: path bytes that need not be UTF-8) and, optionally, its body. */
type Extra = string | Buffer | { path: string | Buffer; body: string };

/**
 * A tree holding A plus the given entries, and its map, for paths a checkout cannot make. Built in a scratch index
 * with core.protectNTFS=false: git otherwise ignores `aux.c`, `trail.`, `a:b` and `GIT~1/x` in update-index (and
 * read-tree refuses them), as a teammate's commit can contain them. The body defaults to `body of <path>\n`.
 */
async function treeWith(s: SnapFixture, extra: readonly Extra[], label: string): Promise<{ tree: Oid; A: TreeMap }> {
  const index = join(s.tmp, `${label}.index`);
  const opts = { indexFile: index, config: { 'core.protectNTFS': 'false' } };
  await s.repo.run(['read-tree', (await s.repo.readCommit(s.head)).tree], { ...opts, class: 'refupdate' });
  const recs: Buffer[] = [];
  for (const x of extra) {
    const p = typeof x === 'string' || Buffer.isBuffer(x) ? x : x.path;
    const raw = typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
    const body = typeof x === 'string' || Buffer.isBuffer(x) ? Buffer.concat([Buffer.from('body of '), raw, Buffer.from('\n')]) : Buffer.from(x.body);
    const oid = await s.repo.hashBytes(body, true);
    recs.push(Buffer.concat([Buffer.from(`100644 ${oid}\t`), raw, Buffer.from([0])]));
  }
  await s.repo.run(['update-index', '--add', '-z', '--index-info'], { ...opts, class: 'refupdate', stdin: Buffer.concat(recs) });
  const tree = parseOid((await s.repo.run(['write-tree'], opts)).stdout.toString('utf8'));
  const A = await s.repo.readTreeMap(tree);
  assert.equal(A.size, s.A.size + extra.length, 'every extra entry is in the tree');
  return { tree, A };
}

/** An Fs whose lstat reports the owner/group/other exec bits for the files in `exec` (an emulated chmod +x). */
function execBitsFs(exec: ReadonlySet<string>): Fs {
  return {
    ...realFs,
    async lstat(p: string): Promise<FsLstat | null> {
      const st = await realFs.lstat(p);
      return st !== null && exec.has(p) ? { ...st, mode: st.mode | 0o111 } : st;
    },
  };
}

function reads(s: SnapFixture): string[] {
  return s.fs.calls.filter((c) => c.startsWith('readFile ') && c.startsWith(`readFile ${s.f.paths.workTree}`) && !c.includes(s.stage.root));
}

async function stageFiles(s: SnapFixture): Promise<string[]> {
  const all = await fsp.readdir(s.stage.root, { recursive: true, withFileTypes: true });
  return all.filter((d) => d.isFile()).map((d) => d.name);
}

function gitCalls(s: SnapFixture): string[] {
  return s.fs.calls.filter((c) => c.startsWith('git '));
}

function reset(s: SnapFixture): void {
  s.fs.calls.length = 0;
  s.calls.length = 0;
}

const FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('# fixture\n'),
  'src/a.txt': Buffer.from('one\ntwo\nthree\n'),
  'src/b.txt': Buffer.from('alpha\nbeta\n'),
  'src/c.txt': Buffer.from('gamma\n'),
  'src/d.txt': Buffer.from('delta\n'),
  'big.txt': Buffer.from('0123456789\n'.repeat(100)),
};

async function withSnap(label: string, fn: (t: Snap) => Promise<void>, opts: Parameters<typeof makeSnapFixture>[1] = {}, snapOpts: SnapOpts = {}): Promise<void> {
  const s = await makeSnapFixture(label, { files: FILES, ...opts });
  try {
    await fn(await snapFor(s, snapOpts, opts.drivers ?? []));
  } finally {
    setCrashHandler(null);
    await s.cleanup();
  }
}

function blobOf(m: TreeMap, p: string): Oid {
  const e = m.get(p);
  assert.ok(e, `tree has ${p}`);
  return e.oid;
}

test('a tick on an unchanged tree reads no file and spawns no git', async () => {
  await withSnap('snap-unchanged', async ({ s, snap, inp }) => {
    const first = await snap.tick(inp);
    assert.equal(first.failed, false);
    assert.equal(first.dirty.size, 0, 'the checkout equals S_raw');
    assert.equal(reads(s).length, Object.keys(FILES).length, 'the first tick after a reseed stage-reads every tracked path once');
    for (let i = 0; i < 3; i++) {
      s.clock.advance(2_500);
      reset(s);
      const r = await snap.tick(inp);
      assert.deepEqual(gitCalls(s), [], 'no git spawned');
      assert.deepEqual(reads(s), [], 'no file read');
      assert.equal(s.fs.calls.filter((c) => c.startsWith('readFile ')).length, 0);
      assert.equal(r.dirty.size, 0);
      assert.equal(r.changed.size, 0);
      assert.equal(r.excluded.size, 0);
      assert.equal(r.failed, false);
    }
    assert.deepEqual(await stageFiles(s), [], 'clean stage copies are deleted at once');
  });
});

test('an edit is detected by id at the tick and its blob is written only at materialize', async () => {
  await withSnap('snap-edit', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const bytes = Buffer.from('one\nTWO\nthree\n');
    await s.write('src/a.txt', bytes);
    const id = await s.repo.hashBytes(bytes, false);
    const before = await s.loose();
    reset(s);
    const r = await snap.tick(inp);
    assert.deepEqual(r.dirty.get('src/a.txt'), { kind: 'modify', mode: '100644', id });
    assert.deepEqual([...r.changed], ['src/a.txt']);
    assert.equal(await s.repo.hasObject(id, 'blob'), false, 'the tick wrote no object');
    assert.deepEqual(await s.loose(), before);
    assert.equal(s.statCache.get('src/a.txt')?.state, 'dirty');
    assert.equal(s.statCache.get('src/a.txt')?.id, id);
    assert.deepEqual(reads(s), [`readFile ${s.abs('src/a.txt')}`], 'only the stat-changed path is read');
    // Cumulative until materialized; an unchanged tick reports no change.
    s.clock.advance(2_500);
    const again = await snap.tick(inp);
    assert.ok(again.dirty.has('src/a.txt'));
    assert.equal(again.changed.size, 0);
    // A further edit of a dirty path is a change at its tick.
    const bytes2 = Buffer.from('one\nTWO\nTHREE\n');
    await s.write('src/a.txt', bytes2);
    const id2 = await s.repo.hashBytes(bytes2, false);
    const r2 = await snap.tick(inp);
    assert.deepEqual(r2.dirty.get('src/a.txt'), { kind: 'modify', mode: '100644', id: id2 });
    assert.deepEqual([...r2.changed], ['src/a.txt']);

    const m = await snap.materialize(inp);
    assert.equal(blobOf(m.sRawMap, 'src/a.txt'), id2, 'the materialized blob is the tick id');
    assert.equal(blobOf(m.sDiskMap, 'src/a.txt'), id2);
    assert.equal(await s.repo.hasObject(id2, 'blob'), true);
    assert.equal(await s.repo.hasObject(id, 'blob'), false, 'the superseded tick id never became an object');
    assert.equal(snap.last(), m);
    assert.equal(s.statCache.get('src/a.txt')?.state, 'clean');
    assert.deepEqual(await fsp.readdir(s.stage.root, { recursive: true }).then((l) => l.filter((n) => n.endsWith('a.txt'))), []);
    const after = await snap.tick(inp);
    assert.equal(after.dirty.size, 0);
    assert.equal(after.changed.size, 0);
    // S_raw is in the private index.
    assert.equal((await s.repo.listIndex(join(s.f.paths.coworkDir, 'main.index'))).get('src/a.txt')?.oid, id2);
  });
});

test('the quiet period skips an mtime under 300 ms old; a future mtime needs 300 ms \u{394}mono of unchanged stat', async () => {
  await withSnap('snap-quiet', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const p = s.abs('src/b.txt');
    await fsp.writeFile(p, 'alpha\nBETA\n');
    const young = (s.clock.wall - 100) / 1_000;
    await fsp.utimes(p, young, young);
    reset(s);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/b.txt'), 'quiet');
    assert.equal(r.dirty.has('src/b.txt'), false);
    assert.deepEqual(reads(s), [], 'a path inside the quiet window is not read');
    s.clock.advance(150); // 250 ms old
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/b.txt'), 'quiet');
    s.clock.advance(100); // 350 ms old
    r = await snap.tick(inp);
    assert.equal(r.excluded.has('src/b.txt'), false);
    assert.equal(r.dirty.get('src/b.txt')?.kind, 'modify');

    // A future mtime: the stat must stay unchanged for 300 ms of mono time.
    const q = s.abs('src/c.txt');
    await fsp.writeFile(q, 'GAMMA\n');
    const future = (s.clock.wall + 3_600_000) / 1_000;
    await fsp.utimes(q, future, future);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/c.txt'), 'quiet');
    s.clock.advance(200);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/c.txt'), 'quiet');
    // The stat changes during the wait: the 300 ms restart.
    await fsp.writeFile(q, 'GAMMA2\n');
    await fsp.utimes(q, future + 1, future + 1);
    s.clock.advance(200);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/c.txt'), 'quiet', '400 ms since first seen, but only 0 ms with this stat');
    s.clock.advance(250);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/c.txt'), 'quiet');
    s.clock.advance(100);
    r = await snap.tick(inp);
    assert.equal(r.excluded.has('src/c.txt'), false);
    assert.equal(r.dirty.get('src/c.txt')?.id, await s.repo.hashBytes(Buffer.from('GAMMA2\n'), false));
  });
});

test('a deletion is staged only after two reads at least 1 s apart', async () => {
  await withSnap('snap-delete', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await fsp.rm(s.abs('src/d.txt'));
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending');
    assert.equal(r.dirty.has('src/d.txt'), false);
    s.clock.advance(600);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending', '600 ms is not enough');
    s.clock.advance(400);
    r = await snap.tick(inp);
    assert.deepEqual(r.dirty.get('src/d.txt'), { kind: 'remove', mode: '100644', id: null });
    assert.deepEqual([...r.changed], ['src/d.txt']);
    assert.equal(r.excluded.has('src/d.txt'), false);
    const m = await snap.materialize(inp);
    assert.equal(m.sRawMap.has('src/d.txt'), false);
    assert.equal(m.sDiskMap.has('src/d.txt'), false);
    const after = await snap.tick(inp);
    assert.equal(after.dirty.size, 0);
  });
  // A hook-attributed removal needs no second read.
  const attributed: AttributionPort = { removalAttributed: (p) => p === 'src/c.txt', shrinkAttributed: () => true };
  await withSnap('snap-delete-attr', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await fsp.rm(s.abs('src/c.txt'));
    const r = await snap.tick(inp);
    assert.equal(r.dirty.get('src/c.txt')?.kind, 'remove');
  }, {}, { attribution: attributed });
});

test('a removal needs two consecutive absences: seeing the path present in between restarts the 1 s confirmation', async () => {
  await withSnap('snap-delete-reset', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const p = s.abs('src/d.txt');
    await fsp.rm(p);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending', 'first absence');
    // The file is back (inside the quiet window, so it is not read): present, so the absence streak ends.
    s.clock.advance(500);
    await fsp.writeFile(p, 'delta\n');
    const young = (s.clock.wall - 100) / 1_000;
    await fsp.utimes(p, young, young);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'quiet', 'observed present');
    assert.equal(s.statCache.get('src/d.txt')?.missingSinceMono, undefined, 'a present observation clears the pending deletion');
    // Gone again 1.1 s after the first absence: a new streak, not a confirmation.
    s.clock.advance(600);
    await fsp.rm(p);
    r = await snap.tick(inp);
    assert.equal(r.dirty.has('src/d.txt'), false, 'two non-consecutive absences never confirm a removal');
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending');
    s.clock.advance(1_000);
    r = await snap.tick(inp);
    assert.deepEqual(r.dirty.get('src/d.txt'), { kind: 'remove', mode: '100644', id: null }, 'two consecutive absences 1 s apart');
  });
});

test('an atomic save (temp file + rename over) between two ticks never stages a removal', async () => {
  await withSnap('snap-atomic', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const p = s.abs('src/a.txt');
    const tmp = s.abs('src/.a.txt.tmp~');
    const seen: TickResult[] = [];
    for (let i = 0; i < 8; i++) {
      const body = Buffer.from(`one\nsave ${i}\nthree\n`);
      if (i % 4 === 0) {
        // (1) The whole save between two ticks: temp file, then rename over the target.
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, p);
        await s.settle('src/a.txt');
      } else if (i % 4 === 1) {
        // (2) The save lands inside the staged read, between its first lstat and the read.
        s.fs.interpose('readFile', p, async () => {
          await fsp.writeFile(tmp, body);
          await fsp.rename(tmp, p);
          await s.settle('src/a.txt');
        });
        await s.write('src/a.txt', `one\npre ${i}\nthree\n`);
      } else if (i % 4 === 2) {
        // (3) An editor that deletes the target before renaming the temp file over it; a tick falls in the gap.
        await fsp.writeFile(tmp, body);
        await fsp.rm(p);
        seen.push(await snap.tick(inp));
        s.clock.advance(1_500);
        await fsp.rename(tmp, p);
        await s.settle('src/a.txt');
      } else {
        // (4) The rename lands between the read and the lstat after it.
        let armed = false;
        s.fs.interpose('readFile', p, async () => {
          armed = true;
        });
        s.fs.interpose('lstat', p, async () => {
          if (!armed) return;
          armed = false;
          await fsp.writeFile(tmp, body);
          await fsp.rename(tmp, p);
          await s.settle('src/a.txt');
        }, 10);
        await s.write('src/a.txt', `one\npre ${i}\nthree\n`);
      }
      s.clock.advance(2_500);
      seen.push(await snap.tick(inp));
      s.clock.advance(2_500);
      seen.push(await snap.tick(inp));
      const r = seen[seen.length - 1]!;
      assert.deepEqual(r.dirty.get('src/a.txt'), { kind: 'modify', mode: '100644', id: await s.repo.hashBytes(body, false) }, `save ${i}`);
    }
    for (const r of seen) assert.notEqual(r.dirty.get('src/a.txt')?.kind, 'remove');
    assert.ok(seen.some((r) => r.excluded.get('src/a.txt') === 'deletion_pending'), 'the delete-then-rename gap was observed');
  });
});

test('a shrink over 50 % or to 0 bytes needs two ticks at least 1 s apart with the same stat', async () => {
  await withSnap('snap-shrink', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    // To 0 bytes.
    await s.write('big.txt', Buffer.alloc(0));
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('big.txt'), 'shrink');
    assert.equal(r.dirty.has('big.txt'), false);
    s.clock.advance(500);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('big.txt'), 'shrink', 'not yet 1 s');
    s.clock.advance(500);
    r = await snap.tick(inp);
    assert.equal(r.excluded.has('big.txt'), false);
    assert.equal(r.dirty.get('big.txt')?.id, await s.repo.hashBytes(Buffer.alloc(0), false));

    // A > 50 % shrink whose stat changes before the second look starts over.
    await s.write('src/a.txt', 'a'.repeat(400));
    s.clock.advance(1_000);
    await snap.tick(inp);
    await s.write('src/a.txt', 'a'.repeat(150));
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/a.txt'), 'shrink');
    s.clock.advance(800);
    await s.write('src/a.txt', 'a'.repeat(140));
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/a.txt'), 'shrink');
    s.clock.advance(800);
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/a.txt'), 'shrink', 'only 800 ms with this stat');
    s.clock.advance(300);
    r = await snap.tick(inp);
    assert.equal(r.dirty.get('src/a.txt')?.id, await s.repo.hashBytes(Buffer.from('a'.repeat(140)), false));

    // A shrink of at most 50 % publishes at once.
    await s.write('src/b.txt', 'alpha\n');
    r = await snap.tick(inp);
    assert.equal(r.dirty.get('src/b.txt')?.kind, 'modify');
  });
  // Without attribution a stable shrink stays excluded.
  const noShrink: AttributionPort = { removalAttributed: () => false, shrinkAttributed: () => false };
  await withSnap('snap-shrink-noattr', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await s.write('big.txt', Buffer.alloc(0));
    await snap.tick(inp);
    s.clock.advance(5_000);
    const r = await snap.tick(inp);
    assert.equal(r.excluded.get('big.txt'), 'shrink');
  }, {}, { attribution: noShrink });
});

test('a share-none lock makes the path unreadable before any git call; after unlock it is detected next tick', async () => {
  await withSnap('snap-lock', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await s.write('src/a.txt', 'one\nA\nthree\n');
    await s.write('src/b.txt', 'alpha\nB\n');
    await s.write('src/c.txt', 'gamma!\n');
    await s.write('src/n.txt', 'new file\n');
    await fsp.rm(s.abs('src/d.txt'));
    const release = s.fs.holdLock(s.abs('src/b.txt'), 'share-none');
    reset(s);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/b.txt'), 'unreadable');
    assert.equal(r.dirty.has('src/b.txt'), false);
    const CONTENT = new Set(['git add', 'git update-index', 'git hash-object', 'git diff-files']);
    const firstGit = s.fs.calls.findIndex((c) => CONTENT.has(c));
    const bOpen = s.fs.calls.indexOf(`readFile ${s.abs('src/b.txt')}`);
    assert.ok(bOpen >= 0 && firstGit > bOpen, 'b is refused at its open, before any content git call');
    assert.ok(s.fs.calls.slice(firstGit).every((c) => !c.startsWith('readFile ') || c.includes(s.stage.root)), 'every staged read of the tick precedes its first content git call');
    assert.ok(!s.calls.some((c) => c.args.join(' ').includes('b.txt') || (c.opts.stdin?.toString('utf8') ?? '').includes('src/b.txt')), 'no git call names b');
    assert.equal(r.dirty.get('src/a.txt')?.kind, 'modify');
    assert.equal(r.dirty.get('src/c.txt')?.kind, 'modify');
    assert.equal(r.dirty.get('src/n.txt')?.kind, 'new');
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending');
    s.clock.advance(1_200);
    r = await snap.tick(inp);
    assert.equal(r.dirty.get('src/d.txt')?.kind, 'remove');
    assert.equal(r.excluded.get('src/b.txt'), 'unreadable', 'still held');
    release();
    s.clock.advance(2_500);
    r = await snap.tick(inp);
    assert.equal(r.excluded.has('src/b.txt'), false);
    assert.deepEqual(r.dirty.get('src/b.txt'), { kind: 'modify', mode: '100644', id: await s.repo.hashBytes(Buffer.from('alpha\nB\n'), false) });
    assert.deepEqual([...r.changed], ['src/b.txt']);
  });
});

test('a failing required clean filter excludes the path, blocks publishing for the loop and stores no plaintext object', async () => {
  await withSnap('snap-filter', async ({ s, snap, inp }) => {
    const canary = Buffer.from(s.f.peer.canary, 'latin1');
    const plaintextObjects = async (): Promise<number> => {
      const r = await s.f.repo.run(['cat-file', '--batch-all-objects', '--batch']);
      return r.stdout.includes(canary) ? 1 : 0;
    };
    const t0 = await snap.tick(inp);
    assert.equal(t0.dirty.size, 0, 'the smudged checkout cleans back to S_raw');
    assert.match(await fsp.readFile(s.f.peer.filterCountFile, 'utf8'), /^clean keys\.sec$/m, 'the counting filter ran on the stage copy');
    const working = await s.f.repo.configGet('filter.secret.clean');
    assert.ok(working !== null);
    await s.f.repo.run(['config', 'filter.secret.clean', 'node -e "process.exit(3)"']);
    await s.write('keys.sec', `k=${s.f.peer.canary} v2\n`);
    await s.write('src/a.txt', 'one\nedited\nthree\n');
    const before = await s.loose();
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('keys.sec'), 'filter_failure');
    assert.equal(r.publishBlocked, true, 'nothing is published this loop');
    assert.equal(r.failed, false);
    assert.equal(r.dirty.has('keys.sec'), false);
    assert.equal(r.dirty.get('src/a.txt')?.kind, 'modify');
    assert.deepEqual(await s.loose(), before);
    const m = await snap.materialize(inp);
    assert.equal(blobOf(m.sRawMap, 'keys.sec'), blobOf(s.A, 'keys.sec'), 'the failing path keeps its entry');
    assert.equal(await plaintextObjects(), 0, 'no object holds the plaintext');
    // The next loop is a new decision: the filter still fails, the block holds again.
    s.clock.advance(2_500);
    r = await snap.tick(inp);
    assert.equal(r.publishBlocked, true);
    // The filter works again: the path is detected and nothing blocks.
    await s.f.repo.run(['config', 'filter.secret.clean', working]);
    s.clock.advance(2_500);
    r = await snap.tick(inp);
    assert.equal(r.publishBlocked, false);
    assert.equal(r.excluded.has('keys.sec'), false);
    assert.equal(r.dirty.get('keys.sec')?.kind, 'modify');
    await snap.materialize(inp);
    assert.equal(await plaintextObjects(), 0, 'the clean form replaced the canary');
  }, { filter: true, drivers: ['secret'], files: { ...FILES, '.gitattributes': Buffer.from('*.sec filter=secret\n'), 'keys.sec': Buffer.from('k=@@SECRET@@\n') } });
});

const SEC_FILES: Record<string, Buffer> = {
  ...FILES,
  '.gitattributes': Buffer.from('*.sec filter=secret\n'),
  'keys.sec': Buffer.from('k=@@SECRET@@\n'),
  'more.sec': Buffer.from('m=@@SECRET@@\n'),
};

test('an over-cap driver set or an unknown driver fails closed: every filtered path is a filter_failure exclusion and publishing is blocked', async () => {
  const filtered = ['keys.sec', 'more.sec'];
  const check = async ({ s, snap, inp }: Snap, label: string): Promise<void> => {
    reset(s);
    const t0 = await snap.tick(inp);
    for (const p of filtered) assert.equal(t0.excluded.get(p), 'filter_failure', `${label}: ${p} at the first tick`);
    assert.equal(t0.publishBlocked, true, `${label}: nothing publishes this loop`);
    await s.write('keys.sec', `k=${s.f.peer.canary} v3\n`);
    await s.write('fresh.sec', `f=${s.f.peer.canary}\n`);
    await s.write('src/a.txt', 'one\nTWO\nthree\n');
    s.clock.advance(2_500);
    const r = await snap.tick(inp);
    for (const p of [...filtered, 'fresh.sec']) {
      assert.equal(r.excluded.get(p), 'filter_failure', `${label}: ${p}`);
      assert.equal(r.dirty.has(p), false, `${label}: ${p} is not dirty`);
    }
    assert.equal(r.publishBlocked, true, `${label}: still blocked`);
    assert.equal(r.failed, false);
    assert.equal(r.dirty.get('src/a.txt')?.kind, 'modify', `${label}: unfiltered paths are still detected`);
    const named = (c: { args: string[]; opts: { stdin?: Buffer } }): boolean =>
      c.args.some((a) => a.includes('.sec')) || (c.opts.stdin?.toString('utf8') ?? '').includes('.sec');
    assert.ok(!s.calls.some((c) => c.args[0] !== 'check-attr' && named(c)), `${label}: a filtered path is never hashed or staged`);
    assert.deepEqual(reads(s).filter((c) => c.includes('.sec')), [], `${label}: a filtered path is never read`);
    const m = await snap.materialize(inp);
    for (const p of filtered) assert.equal(blobOf(m.sRawMap, p), blobOf(s.A, p), `${label}: ${p} keeps its S_raw entry`);
    assert.equal(m.sRawMap.has('fresh.sec'), false);
  };
  await withSnap('snap-overcap', (t) => check(t, 'overCap'), { filter: true, drivers: ['secret'], files: SEC_FILES },
    { filters: { drivers: ['secret'], fingerprint: {}, overCap: 65 } });
  // A filter attribute naming a driver outside the discovered set (git would run it without required=true).
  await withSnap('snap-unknown-driver', (t) => check(t, 'unknown driver'), { filter: true, drivers: ['secret'], files: SEC_FILES },
    { filters: { drivers: ['other'], fingerprint: {}, overCap: null } });
});

test('a filter that fails at materialize keeps the path dirty with its S_raw entry, blocks publishing and stores no plaintext (broken and unset driver)', async () => {
  for (const variant of ['broken', 'unset'] as const) {
    await withSnap(`snap-matfilter-${variant}`, async ({ s, snap, inp }) => {
      const canary = Buffer.from(s.f.peer.canary, 'latin1');
      const plaintextObjects = async (): Promise<number> => {
        const r = await s.f.repo.run(['cat-file', '--batch-all-objects', '--batch']);
        return r.stdout.includes(canary) ? 1 : 0;
      };
      await snap.tick(inp);
      await s.write('keys.sec', `k=${s.f.peer.canary} ${variant}\n`);
      const r = await snap.tick(inp);
      assert.equal(r.dirty.get('keys.sec')?.kind, 'modify', 'detected while the filter works');
      assert.equal(r.publishBlocked, false);
      if (variant === 'broken') await s.f.repo.run(['config', 'filter.secret.clean', 'node -e "process.exit(3)"']);
      else await s.f.repo.run(['config', '--unset', 'filter.secret.clean']); // required=true still comes from the driver set
      const m = await snap.materialize(inp);
      assert.equal(m.publishBlocked, true, `${variant}: nothing publishes this loop`);
      assert.equal(m.excluded.get('keys.sec'), 'filter_failure');
      assert.equal(blobOf(m.sRawMap, 'keys.sec'), blobOf(s.A, 'keys.sec'), 'keys.sec keeps its S_raw entry');
      assert.equal(s.statCache.get('keys.sec')?.state, 'dirty');
      assert.equal(await plaintextObjects(), 0, 'no object holds the plaintext');
      const again = await snap.tick(inp);
      assert.equal(again.dirty.get('keys.sec')?.kind, 'modify', 'still dirty: the next materialize tries again');
    }, { filter: true, drivers: ['secret'], files: SEC_FILES });
  }
});

test('new files go through admitNew: a .swp and a .env are NOT_ADMITTED, an ordinary file is dirty new', async () => {
  await withSnap('snap-new', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await s.write('src/.a.txt.swp', 'vim swap\n');
    await s.write('.env', 'TOKEN=x\n');
    await s.write('docs/\u{c0c8} notes.md', 'new\r\nfile\r\n');
    const before = await s.loose();
    const r = await snap.tick(inp);
    assert.equal(r.notAdmitted.get('src/.a.txt.swp'), 'temp');
    assert.equal(r.notAdmitted.get('.env'), 'secret-like');
    assert.equal(r.dirty.has('src/.a.txt.swp'), false);
    assert.equal(r.dirty.has('.env'), false);
    const lf = await s.repo.hashBytes(Buffer.from('new\nfile\n'), false);
    assert.deepEqual(r.dirty.get('docs/\u{c0c8} notes.md'), { kind: 'new', mode: '100644', id: lf }, 'DAT-07: a CRLF new file is hashed with autocrlf=input');
    assert.ok(r.changed.has('docs/\u{c0c8} notes.md'));
    assert.deepEqual(reads(s).filter((c) => c.includes('.env') || c.includes('.swp')), [], 'a not-admitted file is never read');
    assert.deepEqual(await s.loose(), before);
    const m = await snap.materialize(inp);
    assert.equal(blobOf(m.sRawMap, 'docs/\u{c0c8} notes.md'), lf);
    assert.equal(blobOf(m.sDiskMap, 'docs/\u{c0c8} notes.md'), lf, 'a new path is not canon-transformed');
    assert.equal(m.sRawMap.has('.env'), false);
    // Once materialized the path is tracked: unchanged, it reads clean.
    const after = await snap.tick(inp);
    assert.equal(after.dirty.size, 0);
    assert.equal(after.notAdmitted.get('.env'), 'secret-like', 'still reported every tick');
    // A dirty new file deleted before it was materialized just leaves the dirty set.
    await s.write('scratch.txt', 'tmp\n');
    const r2 = await snap.tick(inp);
    assert.equal(r2.dirty.get('scratch.txt')?.kind, 'new');
    await fsp.rm(s.abs('scratch.txt'));
    const r3 = await snap.tick(inp);
    assert.equal(r3.dirty.has('scratch.txt'), false);
    assert.ok(r3.changed.has('scratch.txt'));
  });
});

test('a CRLF rewrite of an LF-stored file on an autocrlf=false repo gives S_disk == A while S_raw differs', async () => {
  await withSnap('snap-crlf', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    await s.write('src/a.txt', 'one\r\ntwo\r\nthree\r\n');
    const r = await snap.tick(inp);
    assert.equal(r.dirty.get('src/a.txt')?.kind, 'modify');
    const m = await snap.materialize(inp);
    assert.notEqual(blobOf(m.sRawMap, 'src/a.txt'), blobOf(s.A, 'src/a.txt'), 'S_raw keeps the CRLF bytes');
    assert.equal(blobOf(m.sDiskMap, 'src/a.txt'), blobOf(s.A, 'src/a.txt'), 'canon restores the stored LF form');
    assert.equal(m.canonRefused.size, 0);
    assert.notEqual(m.sRaw, m.sDisk);
    // The private index keeps S_raw.
    assert.equal((await s.repo.listIndex(join(s.f.paths.coworkDir, 'main.index'))).get('src/a.txt')?.oid, blobOf(m.sRawMap, 'src/a.txt'));
  }, { autocrlf: false });
});

test('a MIXED ref with a changed ending lands in canonRefused', async () => {
  await withSnap('snap-mixed', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    // Row 1 keeps its text but its ending changes from CRLF to LF.
    await s.write('mixed.txt', 'a\nb\nc\r\n');
    await s.write('mixed2.txt', 'a\r\nb\nc\r\nnew row\n');
    await snap.tick(inp);
    const m = await snap.materialize(inp);
    assert.deepEqual([...m.canonRefused], ['mixed.txt']);
    assert.equal(blobOf(m.sDiskMap, 'mixed2.txt'), blobOf(m.sRawMap, 'mixed2.txt'), 'only a new row: canon passes unchanged');
    assert.equal(blobOf(m.sDiskMap, 'mixed.txt'), blobOf(m.sRawMap, 'mixed.txt'), 'a refused path keeps its S_raw entry');
  }, { files: { ...FILES, 'mixed.txt': Buffer.from('a\r\nb\nc\r\n'), 'mixed2.txt': Buffer.from('a\r\nb\nc\r\n') } });
});

test('160000 and 120000 entries are forced to A at materialize', async () => {
  await withSnap('snap-special', async ({ s, snap, inp, privateIndex }) => {
    const target = await s.repo.hashBytes(Buffer.from('src/a.txt'), true);
    const otherTarget = await s.repo.hashBytes(Buffer.from('elsewhere'), true);
    const gitlinkA = parseOid('1'.repeat(40));
    const gitlinkDrift = parseOid('2'.repeat(40));
    const gitlinkMod = parseOid('3'.repeat(40));
    const scratch = join(s.tmp, 'special.index');
    const SPECIAL = ['vendor/sub', 'vendor/mod', 'link'];
    const withSpecial = (sub: Oid, link: Oid): Map<string, TreeEntry> => new Map([...s.A,
      ['vendor/sub', { path: 'vendor/sub', mode: '160000', oid: sub }],
      ['vendor/mod', { path: 'vendor/mod', mode: '160000', oid: gitlinkMod }],
      ['link', { path: 'link', mode: '120000', oid: link }]]);
    const aMap = withSpecial(gitlinkA, target);
    const aTree = await s.repo.writeTreeMap(aMap, join(s.tmp, 'special-a.index'));
    const driftTree = await s.repo.writeTreeMap(withSpecial(gitlinkDrift, otherTarget), scratch);
    // A checked-out submodule: vendor/mod is a directory on disk (lstat sees a directory where a file "was").
    await fsp.mkdir(s.abs('vendor/mod'), { recursive: true });
    await fsp.writeFile(s.abs('vendor/mod/.git'), 'gitdir: ../../.git/modules/mod\n');
    // The private index drifted (a submodule checkout, a placeholder edit); A keeps the shared values.
    await snap.reseed(driftTree);
    const ainp: TickInput = { ...inp, A: aMap, aTree };
    const seen: TickResult[] = [await snap.tick(ainp)];
    await s.write('src/a.txt', 'one\nspecial\nthree\n');
    // Three ticks 1.1 s apart: long enough for the two-read deletion rule to confirm a removal of a missing entry.
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_100);
      seen.push(await snap.tick(ainp));
    }
    for (const r of seen) {
      for (const p of SPECIAL) {
        assert.equal(r.dirty.has(p), false, `UNMANAGED ${p} is never staged (as a removal or otherwise)`);
        assert.equal(r.excluded.has(p), false, `UNMANAGED ${p} is never a deletion candidate`);
      }
      assert.ok(![...r.dirty.keys()].some((p) => p.startsWith('vendor/')), 'nothing inside the submodule directory');
    }
    assert.equal(seen[1]?.dirty.get('src/a.txt')?.kind, 'modify');
    const m = await snap.materialize(ainp);
    for (const p of SPECIAL) assert.deepEqual(m.sRawMap.get(p), aMap.get(p), `${p} is A's entry in S_raw`);
    assert.deepEqual(m.sDiskMap.get('vendor/sub'), aMap.get('vendor/sub'));
    const idx = await s.repo.listIndex(privateIndex);
    assert.equal(idx.get('vendor/sub')?.oid, gitlinkA);
    assert.equal(idx.get('vendor/mod')?.oid, gitlinkMod);
    assert.equal(idx.get('link')?.oid, target);
  });
});

test('tracked paths that fail validPathSyntax or decode with U+FFFD are carried through and every other change is still detected', async () => {
  await withSnap('snap-carry-syntax', async ({ s, snap, inp }) => {
    const nfd = '.claude/cafe\u{301}.md'; // NFD, under the QUARANTINED .claude/
    const colon = '.claude/12:30.md';
    const plain = 'docs/12:30-notes.md'; // D5 row 1a
    // The last one is a path whose bytes are not UTF-8: git lists it, Node decodes it with U+FFFD.
    const { tree, A } = await treeWith(s, [nfd, colon, plain, Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74])], 'carry-syntax');
    const fffd = 'bad\u{fffd}.txt';
    assert.ok(A.has(fffd), 'the raw path decodes with U+FFFD');
    const CARRIED = [nfd, colon, plain, fffd];
    // The NFD file exists on disk (a read would stage it under an invalid name); the others do not.
    await fsp.mkdir(s.abs('.claude'), { recursive: true });
    await fsp.writeFile(s.abs(nfd), 'nfd on disk\n');
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A, aTree: tree };
    reset(s);
    const seen: TickResult[] = [await snap.tick(cinp)];
    await s.write('src/a.txt', 'one\ncarry\nthree\n');
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_100);
      seen.push(await snap.tick(cinp));
    }
    for (const r of seen) {
      assert.equal(r.failed, false);
      for (const p of CARRIED) {
        assert.ok(r.carried.has(p), `${JSON.stringify(p)} is listed for not_converged`);
        assert.equal(r.dirty.has(p), false, `${JSON.stringify(p)} is never staged`);
        assert.equal(r.excluded.has(p), false, `${JSON.stringify(p)} is never a deletion candidate`);
      }
    }
    assert.equal(seen[1]?.dirty.get('src/a.txt')?.kind, 'modify', 'the tick still detects other changes');
    for (const p of CARRIED) {
      assert.ok(!s.fs.calls.includes(`lstat ${s.abs(p)}`) && !s.fs.calls.includes(`readFile ${s.abs(p)}`), `${JSON.stringify(p)} is never looked at`);
      assert.ok(!s.calls.some((c) => c.args.some((a) => a.includes(p)) || (c.opts.stdin?.toString('utf8') ?? '').includes(p)), `no git call names ${JSON.stringify(p)}`);
    }
    const m = await snap.materialize(cinp);
    for (const p of CARRIED) assert.deepEqual(m.sRawMap.get(p), A.get(p), `S_raw keeps A's entry for ${JSON.stringify(p)}`);
    assert.notEqual(blobOf(m.sRawMap, 'src/a.txt'), blobOf(A, 'src/a.txt'));
  });
});

test("a tracked path this OS cannot create (aux.c, trail., con/x.txt on Windows) is carried through, never staged as a removal", async () => {
  const NAMES = ['aux.c', 'trail.', 'con/x.txt'];
  await withSnap('snap-carry-win', async ({ s, inp }) => {
    const snap = makeSnap(s, { platform: 'win32' });
    // DiskEqDeps.isCarried: the static causes answer before the first tick (a restart's manyCandidates).
    for (const p of NAMES) assert.equal(snap.isCarried(p), true, `isCarried(${p}) before any tick`);
    const { tree, A } = await treeWith(s, NAMES, 'carry-win');
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A, aTree: tree };
    const seen: TickResult[] = [await snap.tick(cinp)];
    await s.write('src/b.txt', 'alpha\nwin\n');
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_100);
      seen.push(await snap.tick(cinp));
    }
    for (const r of seen) {
      for (const p of NAMES) {
        assert.ok(r.carried.has(p), `${p} is listed for not_converged`);
        assert.equal(r.dirty.has(p), false, `${p}: no removal is ever staged (03-data \u{a7}3.7)`);
        assert.equal(r.excluded.has(p), false, `${p}: never a deletion candidate`);
      }
    }
    assert.equal(seen[1]?.dirty.get('src/b.txt')?.kind, 'modify');
    const m = await snap.materialize(cinp);
    for (const p of NAMES) assert.deepEqual(m.sRawMap.get(p), A.get(p));
  });
  if (process.platform !== 'win32') {
    // Control: on this OS the same names are ordinary paths, so their absence is a real deletion.
    await withSnap('snap-carry-posix', async ({ s, inp }) => {
      const snap = makeSnap(s, { platform: process.platform });
      const { tree, A } = await treeWith(s, NAMES, 'carry-posix');
      await snap.reseed(tree);
      const cinp: TickInput = { ...inp, A, aTree: tree };
      await snap.tick(cinp);
      s.clock.advance(1_100);
      const r = await snap.tick(cinp);
      assert.equal(r.carried.size, 0);
      for (const p of NAMES) assert.equal(r.dirty.get(p)?.kind, 'remove', p);
    });
  }
});

test('two tracked paths that collide case-insensitively on a case-insensitive volume are both carried through, neither captured', async () => {
  await withSnap('snap-carry-case', async ({ s, inp }) => {
    // Git sets core.ignorecase=true when it clones onto a case-insensitive volume (Windows, macOS); set here for Linux.
    await s.f.repo.run(['config', 'core.ignorecase', 'true']);
    const snap = makeSnap(s);
    const CARRIED = ['README.md', 'readme.md', 'NOTES', 'notes/x.md']; // two files; a file where a directory must be
    const { tree, A } = await treeWith(s, ['readme.md', 'NOTES', 'notes/x.md'], 'carry-case');
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A, aTree: tree };
    const seen: TickResult[] = [await snap.tick(cinp)];
    await s.write('README.md', '# edited on the shared disk file\n');
    await s.write('big.txt', '0123456789\n'.repeat(101));
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_100);
      seen.push(await snap.tick(cinp));
    }
    for (const r of seen) {
      for (const p of CARRIED) {
        assert.ok(r.carried.has(p), `${p} is listed for not_converged`);
        assert.equal(r.dirty.has(p), false, `${p} is never captured`);
        assert.equal(r.excluded.has(p), false, `${p} is never a deletion candidate`);
      }
    }
    assert.equal(seen[1]?.dirty.get('big.txt')?.kind, 'modify', 'other paths are still detected');
    for (const p of CARRIED) assert.equal(snap.isCarried(p), true, `isCarried(${p}) after a tick`);
    const m = await snap.materialize(cinp);
    for (const p of CARRIED) assert.deepEqual(m.sRawMap.get(p), A.get(p));
  });
});

test("crashpoint('snapshot.index_written') fires after the private index update and before write-tree", async () => {
  await withSnap('snap-crash', async ({ s, snap, inp, privateIndex }) => {
    await snap.tick(inp);
    await snap.materialize(inp);
    const lastBefore = snap.last();
    await s.write('src/a.txt', 'one\ncrash\nthree\n');
    await s.write('fresh.txt', 'fresh\n');
    await fsp.rm(s.abs('src/d.txt'));
    await snap.tick(inp);
    s.clock.advance(1_100);
    const r = await snap.tick(inp);
    assert.equal(r.dirty.size, 3);
    const hits: string[] = [];
    setCrashHandler((name) => {
      hits.push(name);
      s.fs.calls.push(`crashpoint ${name}`);
      if (name === 'snapshot.index_written') throw new KilledAt(name);
    });
    reset(s);
    await assert.rejects(snap.materialize(inp), KilledAt);
    assert.deepEqual(hits, ['snapshot.index_written']);
    const order = s.fs.calls.filter((c) => c.startsWith('git ') || c.startsWith('crashpoint '));
    const at = order.indexOf('crashpoint snapshot.index_written');
    assert.ok(order.slice(0, at).includes('git add'), 'route (a) ran before the crashpoint');
    assert.ok(order.slice(0, at).includes('git update-index'), 'the cacheinfo / removal edits ran before it');
    assert.ok(!order.includes('git write-tree'), 'write-tree never ran');
    const idx = await s.repo.listIndex(privateIndex);
    assert.equal(idx.get('src/a.txt')?.oid, r.dirty.get('src/a.txt')?.id, 'the private index already holds the edit');
    assert.equal(idx.get('fresh.txt')?.oid, r.dirty.get('fresh.txt')?.id);
    assert.equal(idx.has('src/d.txt'), false);
    assert.equal(snap.last(), lastBefore, 'no S_raw was produced');
    setCrashHandler(null);
    const m = await snap.materialize(inp);
    assert.equal(blobOf(m.sRawMap, 'src/a.txt'), r.dirty.get('src/a.txt')?.id);
  });
});

test('reseed empties the stat cache so the next tick stage-reads every tracked path', async () => {
  await withSnap('snap-reseed', async ({ s, snap, inp, tree }) => {
    await snap.tick(inp);
    await s.write('src/a.txt', 'one\nkept dirty\nthree\n');
    await snap.tick(inp);
    assert.ok(s.statCache.size > 0);
    assert.ok((await fsp.readdir(s.stage.root, { recursive: true })).length > 0, 'a dirty copy is kept');
    reset(s);
    const unchanged = await snap.tick(inp);
    assert.deepEqual(reads(s), []);
    assert.ok(unchanged.dirty.has('src/a.txt'));
    await snap.reseed(tree);
    assert.equal(s.statCache.size, 0);
    assert.deepEqual(await fsp.readdir(s.stage.root), [], 'stage copies are deleted');
    assert.equal(snap.last(), null);
    reset(s);
    const r = await snap.tick(inp);
    assert.deepEqual(reads(s).sort(), Object.keys(FILES).map((p) => `readFile ${s.abs(p)}`).sort(), 'every tracked path is stage-read once');
    assert.deepEqual([...r.dirty.keys()], ['src/a.txt'], 'only the path that differs from the reseeded tree is dirty');
  });
});

test('a file in a directory the snapshot did not watch is found by the rescan backstop, within K loops', async () => {
  await withSnap('snap-rescan', async ({ s, snap, inp }) => {
    assert.ok(UNTRACKED_RESCAN_MS < 20 * 2_500, 'below K = 20 loops of 2.5 s, so INV-CONVERGE still sees the file');
    await snap.tick(inp);
    await fsp.mkdir(s.abs('later/deep'), { recursive: true });
    s.clock.advance(2_500);
    await snap.tick(inp); // the root changed: relisted; the new directories hold no file yet
    await s.write('later/deep/f.txt', 'late\n');
    s.clock.advance(2_500);
    let r = await snap.tick(inp);
    assert.equal(r.dirty.has('later/deep/f.txt'), false, 'no watched directory changed');
    s.clock.advance(UNTRACKED_RESCAN_MS);
    r = await snap.tick(inp);
    assert.equal(r.dirty.get('later/deep/f.txt')?.kind, 'new');
  });
});

test('markClean records a verified write so the next tick does not re-read the path', async () => {
  await withSnap('snap-markclean', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const bytes = Buffer.from('one\nwritten by apply\nthree\n');
    await s.write('src/a.txt', bytes);
    const id = await s.repo.hashBytes(bytes, true);
    const st = await s.fs.lstat(s.abs('src/a.txt'));
    assert.ok(st);
    snap.markClean('src/a.txt', st, id);
    assert.deepEqual(s.statCache.get('src/a.txt'), { stat: st, id, state: 'clean' });
    reset(s);
    const r = await snap.tick(inp);
    assert.deepEqual(reads(s), []);
    assert.equal(r.dirty.has('src/a.txt'), false);
  });
});

/** chmod +x of a tracked file, a new executable file, then chmod -x: the modes S_raw must record (P2-EXECBIT). */
async function execScenario({ s, snap, inp }: Snap, chmod: (p: string, exec: boolean) => Promise<void>): Promise<void> {
  await snap.tick(inp);
  const a = blobOf(s.A, 'src/a.txt');
  const script = '#!/bin/sh\necho hi\n';
  await s.write('run.sh', script);
  await chmod('run.sh', true);
  await chmod('src/a.txt', true);
  s.clock.advance(2_500);
  const r = await snap.tick(inp);
  assert.deepEqual(r.dirty.get('run.sh'), { kind: 'new', mode: '100755', id: await s.repo.hashBytes(Buffer.from(script), false) }, 'a new executable file stages as 100755');
  assert.deepEqual(r.dirty.get('src/a.txt'), { kind: 'modify', mode: '100755', id: a }, 'chmod +x alone makes the path dirty');
  assert.ok(r.changed.has('src/a.txt'));
  const m = await snap.materialize(inp);
  assert.deepEqual(m.sRawMap.get('src/a.txt'), { path: 'src/a.txt', mode: '100755', oid: a });
  assert.equal(m.sRawMap.get('run.sh')?.mode, '100755');
  const after = await snap.tick(inp);
  assert.equal(after.dirty.size, 0, 'materialized: the exec bit now matches S_raw');
  await chmod('src/a.txt', false);
  s.clock.advance(2_500);
  const r2 = await snap.tick(inp);
  assert.deepEqual(r2.dirty.get('src/a.txt'), { kind: 'modify', mode: '100644', id: a }, 'chmod -x is a change too');
  const m2 = await snap.materialize(inp);
  assert.deepEqual(m2.sRawMap.get('src/a.txt'), { path: 'src/a.txt', mode: '100644', oid: a });
}

test('on a core.fileMode=true file system a new executable file stages as 100755 and chmod +x of a tracked file is a change', {
  skip: process.platform === 'win32' ? 'POSIX legs only: Windows has no owner-exec bit and git clones it with core.fileMode=false' : false,
}, async () => {
  await withSnap('snap-exec', async (t) => {
    assert.equal(await t.s.f.repo.configGet('core.filemode'), 'true', 'git probed an exec-capable file system');
    await execScenario(t, (p, exec) => fsp.chmod(t.s.abs(p), exec ? 0o755 : 0o644));
  });
});

test('the exec bit comes from lstat only when core.fileMode is true and the platform is not Windows (emulated exec bits)', async () => {
  const exec = new Set<string>();
  await withSnap('snap-exec-sim', async (t) => {
    await t.s.f.repo.run(['config', 'core.filemode', 'true']);
    const snap = makeSnap(t.s, { fs: execBitsFs(exec), platform: 'linux' });
    await snap.reseed(t.tree);
    await execScenario({ ...t, snap }, async (p, on) => {
      if (on) exec.add(t.s.abs(p));
      else exec.delete(t.s.abs(p));
    });
  });
  // core.fileMode=false (the Windows clone default) or a win32 platform: lstat mode bits never decide the mode.
  for (const [label, filemode, platform] of [['cfg-false', 'false', 'linux'], ['win32', 'true', 'win32']] as const) {
    exec.clear();
    await withSnap(`snap-exec-off-${label}`, async ({ s, tree, inp }) => {
      await s.f.repo.run(['config', 'core.filemode', filemode]);
      const snap = makeSnap(s, { fs: execBitsFs(exec), platform });
      await snap.reseed(tree);
      await snap.tick(inp);
      await s.write('run.sh', 'x\n');
      exec.add(s.abs('run.sh'));
      exec.add(s.abs('src/a.txt'));
      s.clock.advance(2_500);
      const r = await snap.tick(inp);
      assert.equal(r.dirty.get('run.sh')?.mode, '100644', label);
      assert.equal(r.dirty.has('src/a.txt'), false, `${label}: a mode-bit-only change is invisible`);
    });
  }
});

test('a dirty new file deleted while the untracked listing is stale leaves the dirty set and is never materialized', async () => {
  // A file system that does not move directory timestamps (the ratified listing-gate cost): the src/ stat is frozen.
  const frozen = new Map<string, FsLstat | null>();
  const fs: Fs = {
    ...realFs,
    async lstat(p: string): Promise<FsLstat | null> {
      return frozen.has(p) ? (frozen.get(p) ?? null) : realFs.lstat(p);
    },
  };
  await withSnap('snap-new-gone', async ({ s, tree, inp }) => {
    const snap = makeSnap(s, { fs });
    await snap.reseed(tree);
    await snap.tick(inp);
    const dir = s.abs('src');
    await s.write('src/n.txt', 'new file\n');
    s.clock.advance(2_500);
    const r1 = await snap.tick(inp); // src/ changed: relisted
    assert.equal(r1.dirty.get('src/n.txt')?.kind, 'new');
    // Delete it and put the directory's mtime back, as the reviewer's probe did; the frozen stat makes the
    // directory look unchanged on every file system (sub-microsecond mtimes, macOS directory sizes).
    const atListing = await realFs.lstat(dir);
    assert.ok(atListing !== null);
    frozen.set(dir, atListing);
    await fsp.rm(s.abs('src/n.txt'));
    const t = Number(atListing.mtimeNs / 1_000n) / 1_000_000;
    await fsp.utimes(dir, t, t);
    s.clock.advance(2_500);
    reset(s);
    const r2 = await snap.tick(inp);
    assert.ok(!s.calls.some((c) => c.args[0] === 'ls-files'), 'the stale listing was reused (it still names src/n.txt)');
    assert.equal(r2.dirty.has('src/n.txt'), false, 'gone by lstat: the dirty new entry is dropped');
    assert.ok(r2.changed.has('src/n.txt'), 'leaving the dirty set is a change');
    const m = await snap.materialize(inp);
    assert.equal(m.sRawMap.has('src/n.txt'), false, 'a deleted new file is never materialized');
  });
});

test('every git call on the private index carries core.untrackedCache=false (R-38)', async () => {
  await withSnap('snap-untracked-cache', async ({ s, snap, inp, privateIndex, tree }) => {
    reset(s);
    await snap.reseed(tree);
    await snap.tick(inp);
    await s.write('src/a.txt', 'one\ncache\nthree\n');
    await s.write('fresh.txt', 'fresh\n');
    await fsp.rm(s.abs('src/d.txt'));
    await snap.tick(inp);
    s.clock.advance(1_100);
    await snap.tick(inp);
    await snap.materialize(inp);
    await snap.tick(inp);
    const onPrivate = s.calls.filter((c) => c.opts.indexFile === privateIndex);
    const subs = new Set(onPrivate.map((c) => c.args[0]));
    for (const sub of ['read-tree', 'ls-files', 'add', 'update-index', 'write-tree']) assert.ok(subs.has(sub), `${sub} ran on the private index`);
    for (const c of onPrivate) assert.equal(c.opts.config?.['core.untrackedCache'], 'false', `git ${c.args.join(' ')}`);
  });
});

test('a tracked dotgit alias (GIT~1/config, git~1/hooks/post-checkout) is carried on every platform: never looked at, read or named to git (P2-DOTGIT)', async () => {
  await withSnap('snap-dotgit', async ({ s, snap, inp }) => {
    const ALIASES = ['GIT~1/config', 'git~1/hooks/post-checkout'];
    // On Windows GIT~1 is the 8.3 name of .git itself: a look at GIT~1/config would read .git/config.
    const { tree, A } = await treeWith(s, ALIASES, 'dotgit');
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A, aTree: tree };
    reset(s);
    const seen: TickResult[] = [await snap.tick(cinp)];
    await s.write('src/a.txt', 'one\nalias\nthree\n');
    // New untracked files under a directory spelled like an 8.3 alias: git lists them, the snapshot never admits or
    // looks at them. No 8.3 name in this fixture reaches ~7, so GIT~7 is an ordinary directory on Windows too.
    const NEW = process.platform === 'win32' ? ['GIT~7/x'] : ['GIT~7/x', 'GIT~1/x'];
    for (const p of NEW) await s.write(p, 'new\n');
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_100);
      seen.push(await snap.tick(cinp));
    }
    for (const r of seen) {
      assert.equal(r.failed, false);
      for (const p of ALIASES) {
        assert.ok(r.carried.has(p), `${p} is listed for not_converged`);
        assert.equal(r.dirty.has(p), false, `${p} is never captured`);
        assert.equal(r.excluded.has(p), false, `${p} is never a deletion candidate`);
      }
    }
    assert.equal(seen[1]?.dirty.get('src/a.txt')?.kind, 'modify', 'other changes are still detected');
    for (const p of NEW) {
      assert.equal(seen[1]?.notAdmitted.get(p), 'portability', `a new ${p} is NOT_ADMITTED`);
      assert.equal(seen[1]?.dirty.has(p), false);
    }
    for (const p of ALIASES) assert.equal(snap.isCarried(p), true, `isCarried(${p}) for DiskEq`);
    assert.equal(snap.isCarried('src/a.txt'), false);
    assert.equal(s.statCache.get('GIT~1/config'), undefined, 'never recorded as clean');
    const m = await snap.materialize(cinp);
    for (const p of ALIASES) assert.deepEqual(m.sRawMap.get(p), A.get(p), `S_raw keeps A's entry for ${p}`);
    for (const p of NEW) assert.equal(m.sRawMap.has(p), false);
    const alias = /git~\d/i;
    const named = s.fs.calls.filter((c) => alias.test(c) || c.includes('.git/config') || c.includes(`.git${sep}config`));
    assert.deepEqual(named, [], 'no Fs call names an alias or .git/config');
    assert.ok(!s.calls.some((c) => c.args.some((a) => alias.test(a)) || alias.test(c.opts.stdin?.toString('utf8') ?? '')), 'no git argv or stdin names an alias');
  });
});

test('a tracked path longer than 200 UTF-16 code units is captured on Windows (D7 rule 3 binds new paths only)', async () => {
  const LONG = `${'a'.repeat(50)}/${'b'.repeat(50)}/${'c'.repeat(50)}/${'d'.repeat(53)}.txt`;
  assert.equal(LONG.length, 210);
  await withSnap('snap-long', async ({ s, inp, tree }) => {
    const snap = makeSnap(s, { platform: 'win32' });
    await snap.reseed(tree);
    const t0 = await snap.tick(inp);
    assert.equal(t0.carried.has(LONG), false, 'creatable: glossary \u{a7}18 forces core.longpaths=true');
    assert.equal(snap.isCarried(LONG), false);
    assert.equal(t0.dirty.size, 0);
    const bytes = Buffer.from('long\nedited\n');
    await s.write(LONG, bytes);
    s.clock.advance(2_500);
    const r = await snap.tick(inp);
    const id = await s.repo.hashBytes(bytes, false);
    assert.deepEqual(r.dirty.get(LONG), { kind: 'modify', mode: '100644', id }, 'the edit is captured');
    const m = await snap.materialize(inp);
    assert.equal(blobOf(m.sRawMap, LONG), id);
  }, { files: { ...FILES, [LONG]: Buffer.from('long\nfile\n') } });
});

test('an unreadable lstat between two absences ends the absence streak: the 1 s confirmation restarts', async () => {
  await withSnap('snap-delete-eacces', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const p = s.abs('src/d.txt');
    await fsp.rm(p);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending', 'first absence');
    s.clock.advance(500);
    s.fs.addRule({ op: 'lstat', pathIncludes: p, code: 'EACCES', times: 1 });
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'unreadable', 'the lstat failed: no absence was observed');
    assert.equal(s.statCache.get('src/d.txt')?.missingSinceMono, undefined, 'an observation that is not "absent" clears the pending deletion');
    s.clock.advance(600);
    r = await snap.tick(inp);
    assert.equal(r.dirty.has('src/d.txt'), false, 'absent, EACCES, absent 1.1 s after the first: never a removal');
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending');
    s.clock.advance(1_000);
    r = await snap.tick(inp);
    assert.deepEqual(r.dirty.get('src/d.txt'), { kind: 'remove', mode: '100644', id: null }, 'two consecutive absences 1 s apart');
  });
});

test('after a reseed a deletion first seen absent, then through an lstat error, is still staged: the next absence starts a fresh streak', async () => {
  await withSnap('snap-delete-reseed-eacces', async ({ s, snap, inp }) => {
    // No tick before the rm: after a start or reseed the stat cache is empty (it is never persisted), so the first
    // absence creates an entry with no stat that exists only to hold the streak.
    const p = s.abs('src/d.txt');
    await fsp.rm(p);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending', 'first absence');
    assert.equal(s.statCache.get('src/d.txt')?.stat, null, 'the streak holder has no stat');
    s.clock.advance(500);
    s.fs.addRule({ op: 'lstat', pathIncludes: p, code: 'EACCES', times: 1 });
    r = await snap.tick(inp);
    assert.equal(r.excluded.get('src/d.txt'), 'unreadable', 'the lstat failed: no absence was observed');
    assert.equal(s.statCache.get('src/d.txt'), undefined, 'the streak holder goes with its streak: nothing cached says "absent and clean"');
    s.clock.advance(600);
    r = await snap.tick(inp);
    assert.equal(r.dirty.has('src/d.txt'), false, 'absent, EACCES, absent 1.1 s after the first: never a removal');
    assert.equal(r.excluded.get('src/d.txt'), 'deletion_pending', 'the absence is a candidate again: a fresh streak starts');
    s.clock.advance(1_000);
    r = await snap.tick(inp);
    assert.deepEqual(r.dirty.get('src/d.txt'), { kind: 'remove', mode: '100644', id: null }, 'two consecutive absences 1 s apart');
    assert.deepEqual([...r.changed], ['src/d.txt']);
    const m = await snap.materialize(inp);
    assert.equal(m.sRawMap.has('src/d.txt'), false, 'the removal reaches S_raw');
  });
});

test('under an over-cap or unknown driver a deleted filtered tracked file is a filter_failure exclusion, never a removal', async () => {
  const check = async ({ s, snap, inp }: Snap, label: string): Promise<void> => {
    await snap.tick(inp);
    await fsp.rm(s.abs('more.sec'));
    const seen: TickResult[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await snap.tick(inp));
      s.clock.advance(1_100);
    }
    for (const r of seen) {
      assert.equal(r.dirty.has('more.sec'), false, `${label}: never staged as a removal`);
      assert.equal(r.excluded.get('more.sec'), 'filter_failure', `${label}: excluded before any removal logic`);
      assert.equal(r.publishBlocked, true, `${label}: nothing publishes`);
    }
    assert.equal(s.statCache.get('more.sec')?.missingSinceMono, undefined, `${label}: no deletion confirmation runs`);
    const m = await snap.materialize(inp);
    assert.deepEqual(m.sRawMap.get('more.sec'), s.A.get('more.sec'), `${label}: S_raw keeps A's entry`);
  };
  await withSnap('snap-overcap-rm', (t) => check(t, 'overCap'), { filter: true, drivers: ['secret'], files: SEC_FILES },
    { filters: { drivers: ['secret'], fingerprint: {}, overCap: 65 } });
  await withSnap('snap-unknown-rm', (t) => check(t, 'unknown driver'), { filter: true, drivers: ['secret'], files: SEC_FILES },
    { filters: { drivers: ['other'], fingerprint: {}, overCap: null } });
});

test('a same-spelling file to directory change (config -> config/app.json) is not a case collision under core.ignorecase', async () => {
  await withSnap('snap-file-dir', async ({ s, inp, tree }) => {
    await s.f.repo.run(['config', 'core.ignorecase', 'true']);
    const snap = makeSnap(s);
    await snap.reseed(tree);
    await snap.tick(inp);
    await fsp.rm(s.abs('config'));
    await s.write('config/app.json', '{"a": 1}\n');
    s.clock.advance(2_500);
    let r = await snap.tick(inp);
    assert.equal(r.excluded.get('config'), 'deletion_pending', 'a directory where the file was');
    assert.equal(r.dirty.get('config/app.json')?.kind, 'new');
    s.clock.advance(1_100);
    r = await snap.tick(inp);
    assert.equal(r.dirty.get('config')?.kind, 'remove');
    assert.equal(r.dirty.get('config/app.json')?.kind, 'new');
    await snap.materialize(inp);
    // Nothing published yet: A still holds the file `config`, the private index the directory `config/`.
    s.clock.advance(2_500);
    r = await snap.tick(inp);
    assert.equal(r.carried.size, 0, 'one spelling as a file in A and as a directory in S_raw is a change, not a collision');
    const m = await snap.materialize(inp);
    assert.equal(m.sRawMap.has('config'), false, 'S_raw keeps the removal');
    assert.ok(m.sRawMap.has('config/app.json'), 'S_raw keeps the new file');
    // A real collision is still one: a different spelling of the file as a directory.
    const collideA = await treeWith(s, ['Config/x.md'], 'file-dir-collide');
    const collide = await snap.tick({ ...inp, A: collideA.A, aTree: collideA.tree });
    assert.ok(collide.carried.has('Config/x.md') && collide.carried.has('config'), 'Config/ against the file config');
  }, { files: { ...FILES, config: Buffer.from('x = 1\n') } });
});

test("TickInput.aTree is required (ruling P2-ATREE): an input without A's tree oid does not compile and is refused at run time", async () => {
  await withSnap('snap-atree-required', async ({ snap, inp }) => {
    // Compile-time half (npm run typecheck): an omitted aTree is a type error.
    // @ts-expect-error P2-ATREE: TickInput.aTree is required
    const noTree: TickInput = { A: inp.A, epochBase: inp.epochBase, scope: inp.scope, skip: inp.skip };
    // Run-time half: a caller that gets past the types (a cast, plain JS) is refused before anything is read or
    // written, never served by a fallback that cannot name an A-only non-UTF-8 path (it would read as a deletion).
    await assert.rejects(snap.tick(noTree), /not an object id/, 'tick refuses an input without aTree');
    await assert.rejects(snap.materialize(noTree), /not an object id/, 'materialize refuses an input without aTree');
    assert.equal(snap.last(), null, 'nothing was materialized');
  });
});

/** The tree's entries whose path bytes are not UTF-8, as `<mode> <type> <oid> <hex path>` (raw, byte for byte), sorted. */
async function rawNonUtf8(s: SnapFixture, tree: Oid): Promise<string[]> {
  const out = (await s.repo.run(['ls-tree', '-r', '-z', '--full-tree', tree])).stdout;
  const lines: string[] = [];
  for (let pos = 0; pos < out.length;) {
    const end = out.indexOf(0, pos);
    const rec = out.subarray(pos, end < 0 ? out.length : end);
    pos = end < 0 ? out.length : end + 1;
    const tab = rec.indexOf(0x09);
    const path = rec.subarray(tab + 1);
    if (Buffer.from(path.toString('utf8'), 'utf8').equals(path)) continue;
    lines.push(`${rec.subarray(0, tab).toString('latin1')} ${path.toString('hex')}`);
  }
  return lines.sort();
}

test('a carried U+FFFD path converges to A in S_raw by its raw bytes: a teammate edit, removal and addition', async () => {
  const raw = (stem: string, byte: number): Buffer => Buffer.concat([Buffer.from(stem), Buffer.from([byte]), Buffer.from('.txt')]);
  const BAD = raw('bad', 0xff);
  const OLD = raw('old', 0xfe);
  const ADDED = raw('new', 0xfd);
  const KEYS = ['bad\u{fffd}.txt', 'old\u{fffd}.txt', 'new\u{fffd}.txt'];
  await withSnap('snap-fffd', async ({ s, snap, inp }) => {
    // The private index holds older raw entries; A (a teammate's commit) edited one, removed one and added one.
    const idx = await treeWith(s, [{ path: BAD, body: 'index side\n' }, { path: OLD, body: 'removed in A\n' }], 'fffd-idx');
    const a = await treeWith(s, [{ path: BAD, body: 'teammate edit\n' }, { path: ADDED, body: 'teammate add\n' }], 'fffd-a');
    await snap.reseed(idx.tree);
    const cinp: TickInput = { ...inp, A: a.A, aTree: a.tree };
    await s.write('src/a.txt', 'one\nfffd\nthree\n');
    const r = await snap.tick(cinp);
    for (const k of KEYS) assert.ok(r.carried.has(k), `${JSON.stringify(k)} is carried`);
    assert.equal(r.dirty.get('src/a.txt')?.kind, 'modify');
    const m: Materialized = await snap.materialize(cinp);
    assert.deepEqual(m.sRawMap.get('bad\u{fffd}.txt'), a.A.get('bad\u{fffd}.txt'), 'the edit converges');
    assert.equal(m.sRawMap.has('old\u{fffd}.txt'), false, 'the removal converges');
    assert.deepEqual(m.sRawMap.get('new\u{fffd}.txt'), a.A.get('new\u{fffd}.txt'), 'the A-only addition is in S_raw (never read as a deletion)');
    assert.deepEqual(m.sDiskMap.get('bad\u{fffd}.txt'), a.A.get('bad\u{fffd}.txt'), 'canon never touches a carried path');
    assert.notEqual(blobOf(m.sRawMap, 'src/a.txt'), blobOf(a.A, 'src/a.txt'));
    for (const k of KEYS) assert.deepEqual(m.sRawMap.get(k), a.A.get(k), `S_raw[${JSON.stringify(k)}] is A's`);
    assert.deepEqual(await rawNonUtf8(s, m.sRaw), await rawNonUtf8(s, a.tree), 'the raw entries of A, byte for byte (no literal U+FFFD path)');
    const again = await snap.materialize(cinp);
    assert.deepEqual(await rawNonUtf8(s, again.sRaw), await rawNonUtf8(s, a.tree), 'converged: nothing changes');
  });
});

/** Replaces the tracked directory `dir` with a symlink (a junction on Windows) to a directory outside the work tree holding `files`; the real directory is moved outside too. */
async function linkAway(s: SnapFixture, dir: string, files: Record<string, string>, label: string): Promise<string> {
  const root = join(s.f.paths.workTree, '..');
  const outside = join(root, `outside-${label}`);
  await fsp.mkdir(outside, { recursive: true });
  for (const [name, body] of Object.entries(files)) await fsp.writeFile(join(outside, name), body);
  await fsp.rename(s.abs(dir), join(root, `moved-${label}`));
  await fsp.symlink(outside, s.abs(dir), 'junction');
  for (const name of Object.keys(files)) {
    const t = (s.clock.wall - 1_000) / 1_000;
    await fsp.utimes(join(outside, name), t, t);
  }
  return outside;
}

test('final review FB-7: a tracked path beneath a symlink or junction is never read through it: an unreadable exclusion every tick, never dirty, never staged as a removal, and no outside byte is stored', async () => {
  await withSnap('snap-fb7-link', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const secret = 'OUTSIDE SECRET, not part of the repository\n';
    await linkAway(s, 'src', { 'a.txt': secret, 'b.txt': secret }, 'fb7');
    reset(s);
    for (let i = 0; i < 3; i++) {
      s.clock.advance(1_500);
      const t = await snap.tick(inp);
      for (const p of ['src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt']) {
        assert.equal(t.excluded.get(p), 'unreadable', `tick ${i}: ${p} is excluded`);
        assert.equal(t.dirty.has(p), false, `tick ${i}: ${p} is never dirty (no read, no removal)`);
      }
      assert.equal(t.excluded.get('README.md'), undefined, 'a path with real ancestors is untouched');
    }
    const m = await snap.materialize(inp);
    for (const p of ['src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt']) assert.deepEqual(m.sRawMap.get(p), s.A.get(p), `${p} keeps its A entry in S_raw`);
    const outsideBlob = await s.repo.hashBytes(Buffer.from(secret), false);
    assert.equal((await s.objects()).has(outsideBlob), false, 'no byte from outside the work tree was stored');
    assert.equal(s.fs.calls.some((c) => c.startsWith('readFile ') && c.includes(`${sep}src${sep}`) && !c.includes(s.stage.root)), false, 'no file beneath the link was read');
  });
});

test('final review minor (ledger Task 9:155): a dirty path whose stage copy is gone is excluded unreadable at that materialize and re-read by the next tick, so the following materialize captures it', async () => {
  await withSnap('snap-stage-gone', async ({ s, snap, inp }) => {
    await snap.tick(inp);
    const EDIT = 'one\nstage copy gone\nthree\n';
    await s.write('src/a.txt', EDIT);
    s.clock.advance(1_100);
    const t1 = await snap.tick(inp);
    assert.equal(t1.dirty.get('src/a.txt')?.kind, 'modify');
    await fsp.rm(s.stage.abs('src/a.txt'));   // an AV quarantine, a cleaned tmp/
    const m1 = await snap.materialize(inp);
    assert.equal(m1.excluded.get('src/a.txt'), 'unreadable');
    assert.deepEqual(m1.sRawMap.get('src/a.txt'), s.A.get('src/a.txt'), 'nothing captured without the copy');
    s.clock.advance(1_100);
    const t2 = await snap.tick(inp);
    assert.equal(t2.dirty.get('src/a.txt')?.kind, 'modify');
    assert.notEqual(await realFs.lstat(s.stage.abs('src/a.txt')), null, 'the next tick read p again: a new stage copy');
    const m2 = await snap.materialize(inp);
    assert.equal(m2.excluded.has('src/a.txt'), false);
    assert.equal(m2.sRawMap.get('src/a.txt')?.oid, await s.repo.hashBytes(Buffer.from(EDIT), false), 'the edit is captured');
  });
});

test('final review FB-6: on Windows a tree holding a root drive-prefix name (a:b.txt) is a typed IndexRefusedPathError for the private index: a reseed from it, and a materialize whose A holds it (the carried entry git would drop silently, so S_raw would diverge from A)', {
  skip: process.platform !== 'win32' ? 'git refuses a root drive-prefix name in an index only on Windows' : false,
}, async () => {
  await withSnap('snap-fb6-colon', async ({ s, snap, inp, tree }) => {
    // The tree a teammate's commit can hold: HEAD's root plus a:b.txt (mktree: no index can hold the name).
    const blob = await s.repo.hashBytes(Buffer.from('ab\n'), true);
    const root = (await s.repo.run(['ls-tree', '-z', tree])).stdout.toString('utf8').split('\0').filter((r) => r.length > 0).map((r) => {
      const [meta, name] = r.split('\t') as [string, string];
      const [mode, type, oid] = meta.split(' ') as [string, string, string];
      return { name, mode: mode as '100644' | '040000', type: type as 'blob' | 'tree', oid: parseOid(oid) };
    });
    const colonTree = await s.repo.mktree([...root, { name: 'a:b.txt', mode: '100644', type: 'blob', oid: blob }]);
    const colonA = await s.repo.readTreeMap(colonTree);
    assert.equal(colonA.get('a:b.txt')?.oid, blob);
    assert.equal(snap.isCarried('a:b.txt'), true, 'carried by its name (P2-DOTGIT: a ":" stream)');
    // A reseed from it: typed, naming the path (it was a bare GitCommandError, a respawn loop at join).
    await assert.rejects(snap.reseed(colonTree), (e: unknown) => e instanceof IndexRefusedPathError && e.paths.join() === 'a:b.txt');
    // The private index from the plain tree, A holding a:b.txt (as a lost-state rebuild from TIP can make it): the
    // carried path's forced entry is refused, never dropped silently.
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A: colonA, aTree: colonTree };
    await s.write('src/a.txt', 'one\nfb6\nthree\n');
    await snap.tick(cinp);
    s.clock.advance(1_100);
    await snap.tick(cinp);
    await assert.rejects(snap.materialize(cinp), (e: unknown) => e instanceof IndexRefusedPathError && e.paths.join() === 'a:b.txt');
  });
});

test('final review FB-6 (POSIX twin): where git indexes a root drive-prefix name (a:b.txt) a reseed from a tree holding it succeeds, and a materialize whose A holds it keeps the carried entry in S_raw (A\'s blob, never read from disk) next to the captured edit', {
  skip: process.platform === 'win32' ? 'git for Windows refuses a root drive-prefix name in an index (the Windows test above)' : false,
}, async () => {
  await withSnap('snap-fb6-colon-posix', async ({ s, snap, inp, tree }) => {
    const blob = await s.repo.hashBytes(Buffer.from('ab\n'), true);
    const root = (await s.repo.run(['ls-tree', '-z', tree])).stdout.toString('utf8').split('\0').filter((r) => r.length > 0).map((r) => {
      const [meta, name] = r.split('\t') as [string, string];
      const [mode, type, oid] = meta.split(' ') as [string, string, string];
      return { name, mode: mode as '100644' | '040000', type: type as 'blob' | 'tree', oid: parseOid(oid) };
    });
    const colonTree = await s.repo.mktree([...root, { name: 'a:b.txt', mode: '100644', type: 'blob', oid: blob }]);
    const colonA = await s.repo.readTreeMap(colonTree);
    assert.equal(snap.isCarried('a:b.txt'), true, 'carried by its name on every platform (P2-DOTGIT: a ":" stream)');
    await snap.reseed(colonTree);
    await snap.reseed(tree);
    const cinp: TickInput = { ...inp, A: colonA, aTree: colonTree };
    await s.write('src/a.txt', 'one\nfb6\nthree\n');
    await snap.tick(cinp);
    s.clock.advance(1_100);
    await snap.tick(cinp);
    const m = await snap.materialize(cinp);
    assert.equal(m.sRawMap.get('a:b.txt')?.oid, blob, 'the carried entry is A\'s');
    assert.equal(m.sRawMap.get('src/a.txt')?.oid, await s.repo.hashBytes(Buffer.from('one\nfb6\nthree\n'), false), 'the edit is captured');
  });
});
