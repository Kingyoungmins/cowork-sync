// held/<hold_id>/<stage>/<repo path> on the board (Plan 3 Task 3; A7, HLD-04, PRO-02, PRO-06, PRO-27 writer side):
// buildHeldTree's nested mktree trees, BoardBuild.held puts/replaces/removes with every other subtree carried by oid,
// readHeld/readHeldAll, the exact board tree shape and the 5,000,000-byte board tree cap over every tree object under
// held/. Real git on a file:// clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BOARD_SUBJECT,
  BOARD_TREE_MAX_BYTES,
  BoardMalformedError,
  boardTrailers,
  buildBoardCommit,
  buildHeldTree,
  checkBoardCommits,
  CODE_SUBJECT,
  FACTS_CACHE_MAX,
  HELD_LISTING_MAX_BYTES,
  liveCommitTrailers,
  maxDistinctTrees,
  readBoardCommit,
  readHeld,
  readHeldAll,
  rememberFacts,
  subtreeNames,
  type BoardBuild,
  type HeldBlob,
  type WriterId,
} from '../../src/board/boardCommit.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { BoardCapError, type Op } from '../../src/board/ops.js';
import { genesisProtocol, serializeProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { GitCommandError, GitRepo, type MktreeEntry } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { seededRandom } from '../../src/ports/random.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const A = '01J9ZQ3C5X000000000000000A';
const B = '01J9ZQ3C5X000000000000000B';
const C = '01J9ZQ3C5X000000000000000C';
const D = '01J9ZQ3C5X000000000000000D';
const E = '01J9ZQ3C5X000000000000000E';
const RS = 'rs-test';
const CHECKPOINT = Buffer.from('{"v":1}', 'utf8');

interface Board { f: RepoFixture; repo: GitRepo; peer: string; epoch: string; L0: Oid; B0: Oid; seq: number; blob(text: string): Promise<Oid>; }

/** A clone with a genesis L0/B0 (join only) and a blob helper. */
async function setup(label: string): Promise<Board> {
  const f = await makeRepoFixture(label);
  const r = seededRandom(label);
  const peer = newPeerId(r);
  const epoch = newEpoch(r);
  const repo = f.repo;
  const hr = await repo.resolve('HEAD');
  assert.ok(hr !== null);
  const w: WriterId = { peer, epoch, seq: 2 };
  const L0 = await repo.commitTree({ tree: (await repo.readCommit(hr)).tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(w, [], [], new Map(), hr) });
  const join: Op = {
    id: `${peer}/${epoch}/1`, type: 'join', display: 'Ada', plugin_version: '0.3.0', plugin_sha: '0'.repeat(64), proto: 1, regionSpec: RS,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  };
  const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer: w, ops: [join], cs: [], csPaths: new Map(), protocol: genesisProtocol(12, RS), checkpoint: CHECKPOINT });
  return { f, repo, peer, epoch, L0, B0, seq: 2, blob: (text) => repo.hashBytes(Buffer.from(text, 'utf8'), true) };
}

/** The next board build on `prev` (no ops). */
function next(b: Board, prev: Oid, held?: BoardBuild['held']): BoardBuild {
  b.seq += 1;
  const build: BoardBuild = { prevBoard: prev, liveCode: b.L0, writer: { peer: b.peer, epoch: b.epoch, seq: b.seq }, ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null };
  return held === undefined ? build : { ...build, held };
}

interface LsEntry { mode: string; type: string; oid: string; path: string; }
async function lsTree(repo: GitRepo, treeish: string, flags: string[] = []): Promise<LsEntry[]> {
  const out = (await repo.run(['ls-tree', '-z', ...flags, treeish])).stdout.toString('utf8');
  return out.split('\0').filter((x) => x.length > 0).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode = '', type = '', oid = ''] = rec.slice(0, tab).split(' ');
    return { mode, type, oid, path: rec.slice(tab + 1) };
  });
}

/** A GitRepo on the fixture that records every git argv. */
function spying(f: RepoFixture): { repo: GitRepo; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = { run(args, opts) { calls.push([...args]); return f.runner.run(args, opts); } };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), calls };
}

test('buildHeldTree builds held/<id>/<stage>/<repo path> as nested mktree trees', T10, async () => {
  const b = await setup('held-tree');
  try {
    const [o1, o2, o3] = [await b.blob('one\n'), await b.blob('two\n'), await b.blob('three\n')];
    const blobs: HeldBlob[] = [{ stage: 'h0', path: 'src/deep/a.ts', oid: o1 }, { stage: 'h1', path: 'src/deep/a.ts', oid: o2 }, { stage: 'h1', path: 'README.md', oid: o3 }];
    const tree = await buildHeldTree(b.repo, blobs);
    const leaves = await lsTree(b.repo, tree, ['-r']);
    assert.deepEqual(leaves.map((e) => [e.path, e.oid, e.type]), [
      ['h0/src/deep/a.ts', o1, 'blob'],
      ['h1/README.md', o3, 'blob'],
      ['h1/src/deep/a.ts', o2, 'blob'],
    ]);
    // Nested trees (mktree names carry no '/'): h0, h0/src, h0/src/deep, h1, h1/src, h1/src/deep.
    const trees = (await lsTree(b.repo, tree, ['-r', '-t'])).filter((e) => e.type === 'tree').map((e) => e.path);
    assert.deepEqual(trees, ['h0', 'h0/src', 'h0/src/deep', 'h1', 'h1/src', 'h1/src/deep']);
    // The input order does not matter.
    assert.equal(await buildHeldTree(b.repo, [...blobs].reverse()), tree);
    // Refusals: an empty list (R3-56), a stage outside h0/h1/s1/s2/s3, an invalid path, an oid that is no oid, a repeated
    // (stage, path), a path that is both a file and a directory.
    await assert.rejects(buildHeldTree(b.repo, []), TypeError);
    await assert.rejects(buildHeldTree(b.repo, [{ stage: 'h2' as HeldBlob['stage'], path: 'a.txt', oid: o1 }]), TypeError);
    await assert.rejects(buildHeldTree(b.repo, [{ stage: 'h1', path: 'docs/12:30-notes.md', oid: o1 }]), TypeError);
    await assert.rejects(buildHeldTree(b.repo, [{ stage: 'h1', path: 'a.txt', oid: 'nope' as Oid }]), TypeError);
    await assert.rejects(buildHeldTree(b.repo, [{ stage: 'h1', path: 'a.txt', oid: o1 }, { stage: 'h1', path: 'a.txt', oid: o2 }]), TypeError);
    await assert.rejects(buildHeldTree(b.repo, [{ stage: 'h1', path: 'a', oid: o1 }, { stage: 'h1', path: 'a/b.txt', oid: o2 }]), TypeError);
    // Every stage is accepted.
    const all = await buildHeldTree(b.repo, (['h0', 'h1', 's1', 's2', 's3'] as const).map((stage) => ({ stage, path: 'x.txt', oid: o1 })));
    assert.deepEqual((await lsTree(b.repo, all)).map((e) => e.path), ['h0', 'h1', 's1', 's2', 's3']);

    // One `git mktree --batch` process writes every directory, and the trees are the ones a per-directory mktree builds —
    // git's entry order included (a directory name sorts as if it ended in '/': a-b, a.b/, a.txt, a/, a0), non-ASCII names too.
    const tricky: HeldBlob[] = [
      { stage: 'h1', path: 'a/x.txt', oid: o1 }, { stage: 'h1', path: 'a.b/y.txt', oid: o2 }, { stage: 'h1', path: 'a.txt', oid: o3 },
      { stage: 'h1', path: 'a-b', oid: o1 }, { stage: 'h1', path: 'a0', oid: o2 }, { stage: 'h0', path: `d\u{e9}j\u{e0}/\u{d55c}.md`, oid: o3 },
      { stage: 's2', path: 'deep/er/still/deeper/z.ts', oid: o1 },
    ];
    const spy = spying(b.f);
    const batched = await buildHeldTree(spy.repo, tricky);
    assert.deepEqual(spy.calls.map((a) => a.filter((x) => x === 'mktree' || x === '--batch')), [['mktree', '--batch']], `one mktree --batch: ${JSON.stringify(spy.calls)}`);
    assert.equal(batched, await referenceHeldTree(b.repo, tricky), 'the per-directory mktree tree');
    assert.equal(await buildHeldTree(spy.repo, blobs), tree);
  } finally {
    await b.f.cleanup();
  }
});

/** The held/<id>/ tree as Plan 2's GitRepo.mktree builds it, one process per directory (the test's reference). */
async function referenceHeldTree(repo: GitRepo, blobs: readonly HeldBlob[]): Promise<Oid> {
  interface Dir { files: Map<string, Oid>; dirs: Map<string, Dir>; }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const x of blobs) {
    const parts = [x.stage, ...x.path.split('/')];
    const leaf = parts.pop()!;
    let d = root;
    for (const p of parts) {
      if (!d.dirs.has(p)) d.dirs.set(p, { files: new Map(), dirs: new Map() });
      d = d.dirs.get(p)!;
    }
    d.files.set(leaf, x.oid);
  }
  const write = async (d: Dir): Promise<Oid> => {
    const entries: MktreeEntry[] = [...d.files].map(([name, oid]) => ({ name, mode: '100644', type: 'blob', oid }));
    for (const [name, sub] of d.dirs) entries.push({ name, mode: '040000', type: 'tree', oid: await write(sub) });
    return repo.mktree(entries);
  };
  return write(root);
}

test('buildBoardCommit puts, replaces and removes held/<id>/ and carries the rest by oid', T10, async () => {
  const b = await setup('held-build');
  try {
    const [x, y, z] = [await b.blob('x\n'), await b.blob('y\n'), await b.blob('z\n')];
    const spy = spying(b.f);
    const B1 = await buildBoardCommit(spy.repo, next(b, b.B0, {
      put: new Map([[A, [{ stage: 'h1', path: 'a.txt', oid: x }]], [B, [{ stage: 'h0', path: 'b/b.txt', oid: x }, { stage: 'h1', path: 'b/b.txt', oid: y }]]]),
      remove: new Set(),
    }));
    assert.deepEqual((await readBoardCommit(b.repo, B1)).heldIds, [A, B]);
    // Every held/ directory of the build (both subtrees and held/ itself) comes from one `mktree --batch`; the only other
    // mktree is the board tree's.
    const mktrees = spy.calls.filter((a) => a.includes('mktree'));
    assert.equal(mktrees.length, 2, JSON.stringify(mktrees));
    assert.equal(mktrees.filter((a) => a.includes('--batch')).length, 1);
    const held1 = new Map((await lsTree(b.repo, `${B1}:held`)).map((e) => [e.path, e.oid]));

    const B2 = await buildBoardCommit(b.repo, next(b, B1, {
      put: new Map([[B, [{ stage: 'h1', path: 'b.txt', oid: z }]], [C, [{ stage: 'h1', path: 'docs/c.md', oid: x }]]]),
      remove: new Set([A]),
    }));
    const r2 = await readBoardCommit(b.repo, B2);
    assert.deepEqual(r2.heldIds, [B, C]);
    const held2 = new Map((await lsTree(b.repo, `${B2}:held`)).map((e) => [e.path, e.oid]));
    assert.deepEqual([...held2.keys()], [B, C], 'no held/A');
    assert.notEqual(held2.get(B), held1.get(B), 'held/B is the new tree');
    assert.equal(held2.get(B), await buildHeldTree(b.repo, [{ stage: 'h1', path: 'b.txt', oid: z }]));
    assert.equal(held2.get(C), await buildHeldTree(b.repo, [{ stage: 'h1', path: 'docs/c.md', oid: x }]));

    // The next build without `held` carries held/B and held/C with identical tree oids (and the same held/ tree).
    const B3 = await buildBoardCommit(b.repo, next(b, B2));
    assert.deepEqual((await readBoardCommit(b.repo, B3)).heldIds, [B, C]);
    assert.deepEqual(new Map((await lsTree(b.repo, `${B3}:held`)).map((e) => [e.path, e.oid])), held2);
    assert.equal((await lsTree(b.repo, B3)).find((e) => e.path === 'held')?.oid, (await lsTree(b.repo, B2)).find((e) => e.path === 'held')?.oid);
    // An empty `held` edit carries too; removing an id that is not there changes nothing.
    const B4 = await buildBoardCommit(b.repo, next(b, B3, { put: new Map(), remove: new Set([A]) }));
    assert.deepEqual(new Map((await lsTree(b.repo, `${B4}:held`)).map((e) => [e.path, e.oid])), held2);
    // Removing every subtree drops held/ itself.
    const B5 = await buildBoardCommit(b.repo, next(b, B4, { put: new Map(), remove: new Set([B, C]) }));
    assert.deepEqual((await readBoardCommit(b.repo, B5)).heldIds, []);
    assert.deepEqual((await lsTree(b.repo, B5)).map((e) => e.path), ['checkpoint', 'ops.jsonl', 'protocol.json']);

    // Refusals: an id that is no ULID, an id both put and removed, an empty put list.
    await assert.rejects(buildBoardCommit(b.repo, next(b, B3, { put: new Map([['nope', [{ stage: 'h1', path: 'a.txt', oid: x }]]]), remove: new Set() })), TypeError);
    await assert.rejects(buildBoardCommit(b.repo, next(b, B3, { put: new Map(), remove: new Set(['../x']) })), TypeError);
    await assert.rejects(buildBoardCommit(b.repo, next(b, B3, { put: new Map([[B, [{ stage: 'h1', path: 'a.txt', oid: x }]]]), remove: new Set([B]) })), Error);
    await assert.rejects(buildBoardCommit(b.repo, next(b, B3, { put: new Map([[A, []]]), remove: new Set() })), TypeError);
  } finally {
    await b.f.cleanup();
  }
});

test('readHeld and readHeldAll read back what buildHeldTree wrote', T10, async () => {
  const b = await setup('held-read');
  try {
    const [x, y, z] = [await b.blob('x\n'), await b.blob('y\n'), await b.blob('z\n')];
    const cBlobs: HeldBlob[] = [{ stage: 'h1', path: 'src/z.ts', oid: z }, { stage: 'h0', path: 'src/z.ts', oid: x }, { stage: 'h1', path: 'README.md', oid: y }];
    const bBlobs: HeldBlob[] = [{ stage: 's2', path: 'b.txt', oid: y }];
    const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[C, cBlobs], [B, bBlobs]]), remove: new Set() }));
    const order = (xs: HeldBlob[]): HeldBlob[] => [...xs].sort((p, q) => (p.stage === q.stage ? (p.path < q.path ? -1 : 1) : p.stage < q.stage ? -1 : 1));
    assert.deepEqual(await readHeld(b.repo, B1, C), [
      { stage: 'h0', path: 'src/z.ts', oid: x },
      { stage: 'h1', path: 'README.md', oid: y },
      { stage: 'h1', path: 'src/z.ts', oid: z },
    ], 'stage/path order');
    assert.deepEqual(await readHeld(b.repo, B1, B), bBlobs);
    assert.equal(await readHeld(b.repo, B1, A), null, 'an id without a subtree');
    assert.equal(await readHeld(b.repo, b.B0, A), null, 'a board without held/');
    assert.deepEqual(await readHeldAll(b.repo, b.B0), new Map());

    // readHeldAll: every id's entries listed from the held/ walk's tree bodies (final review F13 round 2): no `ls-tree` at all,
    // one `rev-list` of the distinct tree objects and cat-file batches (a fresh GitRepo: nothing cached), whatever held/ holds.
    const spy = spying(b.f);
    const all = await readHeldAll(spy.repo, B1);
    assert.deepEqual([...all.keys()].sort(), [B, C]);
    assert.deepEqual(all.get(C), order(cBlobs));
    assert.deepEqual(all.get(B), bBlobs);
    assert.deepEqual(spy.calls.filter((a) => a.includes('ls-tree')), [], `no ls-tree call: ${JSON.stringify(spy.calls)}`);
    assert.equal(spy.calls.filter((a) => a.includes('rev-list')).length, 1, 'one traversal of held/');
    assert.ok(spy.calls.every((a) => a.includes('cat-file') || a.includes('rev-list')), 'the only other calls are cat-file batches');
    assert.ok(spy.calls.length <= 4, `${spy.calls.length} git calls`);

    // A held/ entry that is not <ulid>/<stage>/<valid path> is not read (a teammate's malformed subtree): a name that is no
    // ULID, and a ULID whose only entry has a stage outside h0/h1/s1/s2/s3.
    const q = await b.repo.mktree([{ name: 'q.txt', mode: '100644', type: 'blob', oid: x }]);
    const stage = (name: string): Promise<Oid> => b.repo.mktree([{ name, mode: '040000', type: 'tree', oid: q }]);
    const prevHeld = (await lsTree(b.repo, `${B1}:held`)).map((e): MktreeEntry => ({ name: e.path, mode: '040000', type: 'tree', oid: e.oid as Oid }));
    // Entries that are not regular-file blobs are malformed too: an executable, a symlink and a gitlink beside a regular file
    // (D keeps only the regular file), and a subtree with nothing else (E reads as absent).
    const odd = (entries: MktreeEntry[]): Promise<Oid> => b.repo.mktree(entries).then((h1) => b.repo.mktree([{ name: 'h1', mode: '040000', type: 'tree', oid: h1 }]));
    const dTree = await odd([
      { name: 'ok.txt', mode: '100644', type: 'blob', oid: x },
      { name: 'run.sh', mode: '100755', type: 'blob', oid: y },
      { name: 'link', mode: '120000', type: 'blob', oid: z },
      { name: 'sub', mode: '160000', type: 'commit', oid: b.L0 },
    ]);
    const eTree = await odd([{ name: 'run.sh', mode: '100755', type: 'blob', oid: y }, { name: 'link', mode: '120000', type: 'blob', oid: z }]);
    const heldTree = await b.repo.mktree([
      ...prevHeld,
      { name: 'not-a-ulid', mode: '040000', type: 'tree', oid: await stage('h1') },
      { name: A, mode: '040000', type: 'tree', oid: await stage('h9') },
      { name: D, mode: '040000', type: 'tree', oid: dTree },
      { name: E, mode: '040000', type: 'tree', oid: eTree },
    ]);
    const top = (await lsTree(b.repo, B1)).filter((e) => e.path !== 'held').map((e): MktreeEntry => ({ name: e.path, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid as Oid }));
    const tree = await b.repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: heldTree }]);
    const oddBoard = await b.repo.commitTree({ tree, parents: [B1, b.L0], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: b.peer, epoch: b.epoch, seq: 99 }, [], new Map()) });
    const oddAll = await readHeldAll(b.repo, oddBoard);
    assert.deepEqual([...oddAll.keys()].sort(), [B, C, D], 'the malformed subtrees are skipped');
    assert.deepEqual(oddAll.get(C), order(cBlobs));
    assert.deepEqual(oddAll.get(D), [{ stage: 'h1', path: 'ok.txt', oid: x }], 'only the 100644 blob of D');
    assert.equal(await readHeld(b.repo, oddBoard, A), null, 'no well-formed entry');
    assert.deepEqual(await readHeld(b.repo, oddBoard, C), order(cBlobs));
    assert.deepEqual(await readHeld(b.repo, oddBoard, D), [{ stage: 'h1', path: 'ok.txt', oid: x }], 'no executable, symlink or gitlink');
    assert.equal(await readHeld(b.repo, oddBoard, E), null, 'an executable and a symlink only: absent');
  } finally {
    await b.f.cleanup();
  }
});

test('a board tree holds exactly ops.jsonl, protocol.json, checkpoint/state.json and held/', T10, async () => {
  const b = await setup('held-shape');
  try {
    const x = await b.blob('x\n');
    const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path: 'src/a.ts', oid: x }]], [B, [{ stage: 'h0', path: 'b.txt', oid: x }]]]), remove: new Set() }));
    const B2 = await buildBoardCommit(b.repo, { ...next(b, B1, { put: new Map([[C, [{ stage: 's3', path: 'deep/er/c.txt', oid: x }]]]), remove: new Set([A]) }), checkpoint: CHECKPOINT });
    for (const board of [B1, B2]) {
      assert.deepEqual((await lsTree(b.repo, board)).map((e) => e.path), ['checkpoint', 'held', 'ops.jsonl', 'protocol.json']);
      const leaves = (await lsTree(b.repo, board, ['-r'])).map((e) => e.path);
      for (const p of leaves) {
        assert.ok(['ops.jsonl', 'protocol.json', 'checkpoint/state.json'].includes(p) || /^held\/[0-9A-HJKMNP-TV-Z]{26}\/(h0|h1|s1|s2|s3)\//.test(p), `no path outside held/: ${p}`);
      }
    }
    assert.deepEqual((await lsTree(b.repo, B2, ['-r'])).map((e) => e.path).filter((p) => p.startsWith('held/')), [`held/${B}/h0/b.txt`, `held/${C}/s3/deep/er/c.txt`]);
  } finally {
    await b.f.cleanup();
  }
});

/** n h1 paths of 193 bytes (the last one `lastExtra` longer): one wide h1 tree object, so the held/ tree object stays tiny. */
function wide(oid: Oid, n: number, tag: string, lastExtra = 0): HeldBlob[] {
  return Array.from({ length: n }, (_, i) => ({
    stage: 'h1' as const, path: `${tag}-${String(i).padStart(6, '0')}-${'n'.repeat(i === n - 1 ? 180 + lastExtra : 180)}.txt`, oid,
  }));
}

/** `cat-file --batch-check` sizes of `names` (an oid or `<rev>:<path>`); a missing name counts 0. */
async function sizesOf(repo: GitRepo, names: readonly string[]): Promise<number[]> {
  const out = (await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${names.join('\n')}\n`, 'utf8') })).stdout.toString('utf8');
  return out.split('\n').filter((l) => l.length > 0).map((l) => (l.endsWith(' missing') ? 0 : Number(l.split(' ')[2])));
}

/**
 * 02-protocol §3.1 measured test-side from git objects (independent of the writer's arithmetic): ops.jsonl + protocol.json +
 * checkpoint/state.json + every tree object under held/, held/ itself included, each counted at every path it appears under.
 */
async function boardTotal(repo: GitRepo, board: Oid): Promise<number> {
  const sum = (xs: readonly number[]): number => xs.reduce((a, n) => a + n, 0);
  const files = sum(await sizesOf(repo, [`${board}:ops.jsonl`, `${board}:protocol.json`, `${board}:checkpoint/state.json`]));
  const held = (await lsTree(repo, board)).find((e) => e.path === 'held');
  if (held === undefined) return files;
  // git's own listing of the tree objects under held/ (`-r -d`: trees only, so a 20,000-entry held/ lists a handful of lines).
  const trees = (await lsTree(repo, held.oid, ['-r', '-d'])).map((e) => e.oid);
  return files + sum(await sizesOf(repo, [held.oid, ...trees]));
}

/** A hand-built board commit on `prev` whose held/ is exactly `subtrees` (a writer that ignored the cap). */
async function handBoard(b: Board, prev: Oid, subtrees: ReadonlyMap<string, readonly HeldBlob[]>): Promise<Oid> {
  const entries: MktreeEntry[] = [];
  for (const [id, blobs] of subtrees) entries.push({ name: id, mode: '040000', type: 'tree', oid: await buildHeldTree(b.repo, blobs) });
  const held = await b.repo.mktree(entries);
  const top = (await lsTree(b.repo, prev)).filter((e) => e.path !== 'held').map((e): MktreeEntry => ({ name: e.path, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid as Oid }));
  const tree = await b.repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  b.seq += 1;
  return b.repo.commitTree({ tree, parents: [prev, b.L0], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: b.peer, epoch: b.epoch, seq: b.seq }, [], new Map()) });
}

/** The cap refusal, before commit-tree; the error names the tree cap that tripped (EF5 minors: BoardCapError.cap). */
async function refused(b: Board, build: BoardBuild, what: string): Promise<void> {
  const spy = spying(b.f);
  await assert.rejects(buildBoardCommit(spy.repo, build), (e: unknown) => e instanceof BoardCapError && /5000000/.test(e.message) && e.cap === BOARD_TREE_MAX_BYTES, what);
  assert.ok(!spy.calls.some((a) => a.includes('commit-tree')), `${what}: refused before commit-tree`);
}

/**
 * The cap-sized boards: B1 carries held/A (12,000 wide h1 entries, ~2.65 MB of tree objects); atCap adds held/B sized so
 * the §3.1 sum is exactly 5,000,000 bytes. A tree object is `<mode> <name>NUL<20-byte id>` per entry, so a 193-byte name
 * is a 221-byte h1 entry; the counts come from that arithmetic, and boardTotal checks the result on git's objects. atCap is
 * built only when asked (null otherwise).
 */
async function capBoards(b: Board, withAtCap: boolean): Promise<{ x: Oid; B1: Oid; atCap: Oid | null; nB: number; extra: number }> {
  const x = await b.blob('x\n');
  const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, wide(x, 12_000, 'a')]]), remove: new Set() }));
  const entry = 6 + 1 + 193 + 1 + 20;
  const subtree = (n: number, lastExtra: number): number => n * entry + lastExtra + (5 + 1 + 2 + 1 + 20);   // h1 tree + the <id> tree
  const files = serializeProtocol(genesisProtocol(12, RS)).length + CHECKPOINT.length;   // an empty ops.jsonl
  const base = files + 2 * (5 + 1 + 26 + 1 + 20) + subtree(12_000, 0);                  // held/ with two entries, plus A
  const nB = Math.floor((BOARD_TREE_MAX_BYTES - base - subtree(0, 0)) / entry);
  const extra = BOARD_TREE_MAX_BYTES - base - subtree(nB, 0);
  assert.ok(extra >= 0 && extra < entry, `${nB} entries leave ${extra} bytes for the last name`);
  if (!withAtCap) return { x, B1, atCap: null, nB, extra };
  const atCap = await buildBoardCommit(b.repo, next(b, B1, { put: new Map([[B, wide(x, nB, 'b', extra)]]), remove: new Set() }));
  assert.equal(await boardTotal(b.repo, atCap), BOARD_TREE_MAX_BYTES, 'git agrees: exactly the cap');
  return { x, B1, atCap, nB, extra };
}

test('the writer refuses held/ subtrees that push the board tree over 5,000,000 bytes', T10, async () => {
  const b = await setup('held-cap');
  try {
    const { x, B1, atCap, nB, extra } = await capBoards(b, true);
    assert.ok(atCap !== null);
    assert.ok((await boardTotal(b.repo, B1)) > 2_000_000, 'one wide subtree fits; held/ alone is far below the cap');
    assert.deepEqual((await readBoardCommit(b.repo, atCap)).heldIds, [A, B], 'a board tree of exactly 5,000,000 bytes builds');
    // One byte more is refused before commit-tree.
    await refused(b, next(b, B1, { put: new Map([[B, wide(x, nB, 'b', extra + 1)]]), remove: new Set() }), 'one byte over');

    // The reader refuses a held/ §3.1 sum over the cap (final review F13) but not a files+held total over it while held/ alone
    // is within the cap: a hand-built board whose total is one byte over (the files take the difference, so held/ stays below
    // the cap) still reads, as capViolation's separate files/held checks have always allowed.
    const byHand = await handBoard(b, B1, new Map([[A, wide(x, 12_000, 'a')], [B, wide(x, nB, 'b', extra + 1)]]));
    assert.equal(await boardTotal(b.repo, byHand), BOARD_TREE_MAX_BYTES + 1);
    assert.deepEqual((await readBoardCommit(b.repo, byHand)).heldIds, [A, B]);
  } finally {
    await b.f.cleanup();
  }
});

test('R3-74: on an over-cap board only builds that grow the held/ part past the cap are refused', T10, async () => {
  const b = await setup('held-cap-over');
  try {
    const { x, B1, nB, extra } = await capBoards(b, false);
    // An over-cap board left by a writer that ignored the rule: A, B one byte over the cap, and a small C.
    const byHand = await handBoard(b, B1, new Map([[A, wide(x, 12_000, 'a')], [B, wide(x, nB, 'b', extra + 1)], [C, wide(x, 10, 'c')]]));
    const over = await boardTotal(b.repo, byHand);
    assert.ok(over > BOARD_TREE_MAX_BYTES + 2_000, `the board is ${over} bytes`);

    // A carry-only build lands (nothing to remove, no op): the total is unchanged.
    const carry = await buildBoardCommit(b.repo, next(b, byHand));
    assert.equal(await boardTotal(b.repo, carry), over);
    // An ending-op build lands (a hold op ending a record, its subtree kept): ops.jsonl grows, held/ does not.
    const n = next(b, carry);
    const ending: Op = {
      id: `${b.peer}/${b.epoch}/${n.writer.seq - 1}`, type: 'hold', hold_id: C, rev: 2, prev_rev: 1, kind: 'PATCH', residence: null, state: 'RESOLVED_DISCARD',
      offer: 'none', guards: [{ name: 'revert', class: 'DECISION', owner: 'HLD' }], paths: ['c.txt'], origin: 'human', cs_ids: [], peer_authors: [], local_only: false,
    };
    const ended = await buildBoardCommit(b.repo, { ...n, ops: [ending] });
    assert.ok((await boardTotal(b.repo, ended)) > over, 'the sum grew by the op line, not by held/');
    // A checkpoint build lands (a larger checkpoint/state.json, held/ carried).
    const ck = await buildBoardCommit(b.repo, { ...next(b, ended), checkpoint: Buffer.from(`{"v":1,"pad":"${'p'.repeat(2_000)}"}`, 'utf8') });
    assert.ok((await boardTotal(b.repo, ck)) > over);
    // A removal build lands and reduces the total, still over the cap.
    const removed = await buildBoardCommit(b.repo, next(b, ck, { put: new Map(), remove: new Set([C]) }));
    const afterRemoval = await boardTotal(b.repo, removed);
    assert.ok(afterRemoval < (await boardTotal(b.repo, ck)) && afterRemoval > BOARD_TREE_MAX_BYTES, `${afterRemoval} bytes after the removal`);
    assert.deepEqual((await readBoardCommit(b.repo, removed)).heldIds, [A, B]);

    // Any put while the board stays over the cap is refused with the cap error: a new subtree, and a replacement that shrinks
    // held/<B> but leaves the board over the cap.
    await refused(b, next(b, removed, { put: new Map([[D, [{ stage: 'h1', path: 'd.txt', oid: x }]]]), remove: new Set() }), 'a new subtree');
    await refused(b, next(b, byHand, { put: new Map([[B, wide(x, nB - 1, 'b')]]), remove: new Set() }), 'a shrinking replacement still over');
    // A put that leaves the board within the cap lands (it does not grow the sum past it).
    const relieved = await buildBoardCommit(b.repo, next(b, removed, { put: new Map([[D, [{ stage: 'h1', path: 'd.txt', oid: x }]]]), remove: new Set([B]) }));
    assert.ok((await boardTotal(b.repo, relieved)) < BOARD_TREE_MAX_BYTES);
    assert.deepEqual((await readBoardCommit(b.repo, relieved)).heldIds, [A, D]);
  } finally {
    await b.f.cleanup();
  }
});

test('the writer cap lists no held blob: a carry-only or removal build measures nothing, a put build lists trees only', T10, async () => {
  const b = await setup('held-cap-calls');
  try {
    const x = await b.blob('x\n');
    const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path: 'src/a.ts', oid: x }]], [B, [{ stage: 'h0', path: 'b.txt', oid: x }]]]), remove: new Set() }));
    // Final review F13 r2 (E-1): the measurement is the held/ walk — one `rev-list --objects --filter=blob:none` (distinct tree
    // objects only, never a blob) — and no recursive `ls-tree` at all.
    const recursive = (calls: string[][]): string[][] => calls.filter((a) => (a.includes('ls-tree') && a.includes('-r')) || a.includes('rev-list'));
    for (const [what, build] of [['carry-only', next(b, B1)], ['removal', next(b, B1, { put: new Map(), remove: new Set([A]) })]] as const) {
      const spy = spying(b.f);
      await buildBoardCommit(spy.repo, build);
      assert.deepEqual(recursive(spy.calls), [], `${what}: no recursive listing`);
    }
    const spy = spying(b.f);
    const B2 = await buildBoardCommit(spy.repo, next(b, B1, { put: new Map([[C, [{ stage: 'h1', path: 'deep/c.txt', oid: x }]]]), remove: new Set() }));
    const lists = recursive(spy.calls);
    assert.equal(lists.length, 1, JSON.stringify(spy.calls));
    assert.ok(lists[0]!.includes('rev-list') && lists[0]!.includes('--filter=blob:none'), `trees only: ${JSON.stringify(lists[0])}`);
    assert.deepEqual((await readBoardCommit(b.repo, B2)).heldIds, [A, B, C]);
  } finally {
    await b.f.cleanup();
  }
});

test("the writer cap's measurement failures are typed build failures (GitCommandError)", T10, async () => {
  const b = await setup('held-cap-missing');
  try {
    const x = await b.blob('x\n');
    const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path: 'a.txt', oid: x }]]]), remove: new Set() }));
    // A runner that answers the batch-check following the trees-only listing (the held/ walk's rev-list) with `<name> missing`
    // for every name, as a repository that lost a held/ tree object would.
    let listed = false;
    const calls: string[][] = [];
    const runner: GitRunner = {
      async run(args, opts) {
        calls.push([...args]);
        const r = await b.f.runner.run(args, opts);
        if (args.includes('rev-list') && args.includes('--filter=blob:none')) listed = true;
        else if (listed && args.includes('cat-file') && args.includes('--batch-check')) {
          listed = false;
          const names = (opts.stdin as Buffer).toString('utf8').split('\n').filter((l) => l.length > 0);
          return { ...r, stdout: Buffer.from(names.map((n) => `${n} missing\n`).join(''), 'utf8') };
        }
        return r;
      },
    };
    const repo = new GitRepo(runner, b.f.paths, fixtureContext);
    await assert.rejects(buildBoardCommit(repo, next(b, B1, { put: new Map([[B, [{ stage: 'h1', path: 'b.txt', oid: x }]]]), remove: new Set() })), GitCommandError);
    assert.ok(calls.some((a) => a.includes('rev-list') && a.includes('--filter=blob:none')), 'the measurement ran');
    assert.ok(!calls.some((a) => a.includes('commit-tree')), 'refused before commit-tree');
  } finally {
    await b.f.cleanup();
  }
});

// ---- final review F13: held/ is a §3.1 tree bomb (every tree object under held/, counted at every path) --------------------

/**
 * A hostile board commit on `prev` whose held/ is a deduplicated tree bomb: N1 ULID subtrees all pointing at one h0 tree T1,
 * T1's single dir at a wide tree T2 of N2 dirs all pointing at T3, and T3 of N3 blobs. The root held/ tree object stays tiny
 * (N1 short ULID names), so the Plan 2 reader that measured only held/'s own object accepted it, but the §3.1 sum (every tree
 * object under held/, counted once per path it appears under) is N1·(T1 + T2 + N2·T3) — unbounded. An ls-tree -r over it
 * expands to N1·N2·N3 entries.
 */
async function bombBoard(b: Board, prev: Oid, n1: number, n2: number, n3: number): Promise<Oid> {
  const x = await b.blob('x\n');
  const t3 = await b.repo.mktree(Array.from({ length: n3 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
  const t2 = await b.repo.mktree(Array.from({ length: n2 }, (_, i) => ({ name: `d${String(i).padStart(5, '0')}`, mode: '040000', type: 'tree', oid: t3 } as MktreeEntry)));
  const t1 = await b.repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t2 }]);
  const ulid = (i: number): string => `01J9ZQ3C5X${String(i).padStart(16, '0')}`;
  const held = await b.repo.mktree(Array.from({ length: n1 }, (_, i) => ({ name: ulid(i), mode: '040000', type: 'tree', oid: t1 } as MktreeEntry)));
  const top = (await lsTree(b.repo, prev)).filter((e) => e.path !== 'held').map((e): MktreeEntry => ({ name: e.path, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid as Oid }));
  const tree = await b.repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  b.seq += 1;
  return b.repo.commitTree({ tree, parents: [prev, b.L0], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: b.peer, epoch: b.epoch, seq: b.seq }, [], new Map()) });
}

/**
 * Writes a tree object verbatim with `hash-object -t tree --literally` so its entries keep the exact mode bytes given (mktree
 * canonicalizes `040000` to `40000`): used to plant a non-canonical zero-padded directory mode git still parses as a tree.
 * Entries are sorted in git's order (all here are trees, so plain name-byte order).
 */
async function rawTree(repo: GitRepo, entries: ReadonlyArray<{ mode: string; name: string; oid: Oid }>): Promise<Oid> {
  const sorted = [...entries].sort((a, c) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(c.name, 'utf8')));
  const body = Buffer.concat(sorted.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.oid, 'hex')]));
  const r = await repo.run(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], { stdin: body });
  return r.stdout.toString('utf8').trim() as Oid;
}

/** A board on `prev` whose held/ root carries each ULID→subtree edge with the non-canonical `040000` mode (git parses octal). */
async function octalBombBoard(b: Board, prev: Oid, n1: number, n2: number, n3: number): Promise<Oid> {
  const x = await b.blob('x\n');
  const t3 = await b.repo.mktree(Array.from({ length: n3 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
  const t2 = await b.repo.mktree(Array.from({ length: n2 }, (_, i) => ({ name: `d${String(i).padStart(5, '0')}`, mode: '040000', type: 'tree', oid: t3 } as MktreeEntry)));
  const t1 = await b.repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t2 }]);
  const ulid = (i: number): string => `01J9ZQ3C5X${String(i).padStart(16, '0')}`;
  const held = await rawTree(b.repo, Array.from({ length: n1 }, (_, i) => ({ mode: '040000', name: ulid(i), oid: t1 })));
  const top = (await lsTree(b.repo, prev)).filter((e) => e.path !== 'held').map((e): MktreeEntry => ({ name: e.path, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid as Oid }));
  const tree = await b.repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  b.seq += 1;
  return b.repo.commitTree({ tree, parents: [prev, b.L0], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: b.peer, epoch: b.epoch, seq: b.seq }, [], new Map()) });
}

test('F13: a deduplicated held/ tree bomb is refused board_too_large on the read side, and held/ is never expanded unbounded', T10, async () => {
  const b = await setup('held-bomb');
  try {
    // N1=50 ULIDs → ~9 KB of tree objects but 50·100·100 = 500,000 held entries under an unbounded ls-tree -r (the probe's shape).
    const bomb = await bombBoard(b, b.B0, 50, 100, 100);
    // The root held/ tree object alone is far under the cap (50 short ULID entries), so the Plan 2 root-only check accepted it.
    const heldOid = (await lsTree(b.repo, bomb)).find((e) => e.path === 'held')!.oid;
    const heldSize = (await sizesOf(b.repo, [heldOid]))[0]!;
    assert.ok(heldSize < BOARD_TREE_MAX_BYTES, `the root held/ object is ${heldSize} bytes, under the cap`);
    // The §3.1 sum over every tree object under held/ (counted at every path) is over the cap, while the root object is tiny and
    // an ls-tree -r would expand to 50·100·100 = 500,000 entries.
    assert.ok((await boardTotal(b.repo, bomb)) > BOARD_TREE_MAX_BYTES, 'the §3.1 sum is over the cap');

    // readBoardCommit refuses it as board_too_large (the fold then never folds the commit).
    await assert.rejects(readBoardCommit(b.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readBoardCommit refuses the bomb');
    // The incident check's reader refuses it too (one mapping: the fold refuses exactly what readBoardCommit cannot read).
    const [checked] = await checkBoardCommits(b.repo, [bomb]);
    assert.equal(checked!.refused, 'board_too_large', 'checkBoardCommits refuses the bomb');

    // No reader ever ran a recursive listing of held/ (an unbounded ls-tree -r would have), and none returned 500,000 entries.
    const spy = spying(b.f);
    await assert.rejects(readHeldAll(spy.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readHeldAll refuses the bomb');
    assert.ok(!spy.calls.some((a) => a.includes('ls-tree') && a.includes('-r') && !a.includes('-d')), `no unbounded ls-tree -r: ${JSON.stringify(spy.calls.filter((a) => a.includes('ls-tree')))}`);
  } finally {
    await b.f.cleanup();
  }
});

test('F13: a tree bomb using zero-padded (040000) subtree modes is still refused — the walk parses modes as octal, like git', T10, async () => {
  const b = await setup('held-bomb-octal');
  try {
    // The held/ root's ULID edges carry the non-canonical `040000` mode. A reader that matched only the literal '40000' string
    // would skip every edge, measure just the tiny root and accept, while git's `ls-tree -r` (octal) still expands the bomb.
    const bomb = await octalBombBoard(b, b.B0, 50, 100, 100);
    assert.ok((await boardTotal(b.repo, bomb)) > BOARD_TREE_MAX_BYTES, 'git (octal) sees the §3.1 sum over the cap');
    const heldOid = (await lsTree(b.repo, bomb)).find((e) => e.path === 'held')!.oid;
    assert.ok((await sizesOf(b.repo, [heldOid]))[0]! < BOARD_TREE_MAX_BYTES, 'the root held/ object is tiny');
    await assert.rejects(readBoardCommit(b.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readBoardCommit refuses the octal bomb');
    const [checked] = await checkBoardCommits(b.repo, [bomb]);
    assert.equal(checked!.refused, 'board_too_large', 'checkBoardCommits refuses the octal bomb');
    await assert.rejects(readHeldAll(b.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readHeldAll refuses the octal bomb');
  } finally {
    await b.f.cleanup();
  }
});

/** A board on `prev` whose held/ root carries each ULID→subtree edge with the raw directory mode `mode` (any octal string git parses as a tree). */
async function modeBombBoard(b: Board, prev: Oid, mode: string, n1: number, n2: number, n3: number): Promise<Oid> {
  const x = await b.blob('x\n');
  const t3 = await b.repo.mktree(Array.from({ length: n3 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
  const t2 = await b.repo.mktree(Array.from({ length: n2 }, (_, i) => ({ name: `d${String(i).padStart(5, '0')}`, mode: '040000', type: 'tree', oid: t3 } as MktreeEntry)));
  const t1 = await b.repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t2 }]);
  const ulid = (i: number): string => `01J9ZQ3C5X${String(i).padStart(16, '0')}`;
  const held = await rawTree(b.repo, Array.from({ length: n1 }, (_, i) => ({ mode, name: ulid(i), oid: t1 })));
  return boardWithHeld(b, prev, held);
}

/** A hand-built board commit on `prev` whose held/ tree is `held` (the previous board's other entries carried by oid). */
async function boardWithHeld(b: Board, prev: Oid, held: Oid): Promise<Oid> {
  const top = (await lsTree(b.repo, prev)).filter((e) => e.path !== 'held').map((e): MktreeEntry => ({ name: e.path, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid as Oid }));
  const tree = await b.repo.mktree([...top, { name: 'held', mode: '040000', type: 'tree', oid: held }]);
  b.seq += 1;
  return b.repo.commitTree({ tree, parents: [prev, b.L0], subject: BOARD_SUBJECT, trailers: boardTrailers({ peer: b.peer, epoch: b.epoch, seq: b.seq }, [], new Map()) });
}

test('E-1: a directory mode of more than 17 octal digits (git keeps its low 32 bits: a tree) cannot hide a tree bomb from the §3.1 walk', T10, async () => {
  const b = await setup('held-bomb-overflow');
  try {
    // 8^25 + 0o40000: git's unsigned-int mode parse wraps to 0o40000 and descends the entry (and fetch.fsckObjects admits it:
    // the mode is not zero-padded); a parse of the whole string as one JS number loses the low bits and reads no subtree.
    const OVERFLOW = '10000000000000000000040000';
    const bomb = await modeBombBoard(b, b.B0, OVERFLOW, 50, 100, 100);
    assert.ok((await boardTotal(b.repo, bomb)) > BOARD_TREE_MAX_BYTES, 'git (wrapping the mode) sees the §3.1 sum over the cap');
    const heldOid = (await lsTree(b.repo, bomb)).find((e) => e.path === 'held')!.oid as Oid;
    const rootBody = (await b.repo.run(['cat-file', 'tree', heldOid])).stdout;
    assert.equal(subtreeNames(rootBody, heldOid.length / 2).length, 50, 'every overflowing edge names a subtree, as git reads it');
    await assert.rejects(readBoardCommit(b.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readBoardCommit refuses the overflow-mode bomb');
    const [checked] = await checkBoardCommits(b.repo, [bomb]);
    assert.equal(checked!.refused, 'board_too_large', 'checkBoardCommits refuses the overflow-mode bomb');
    await assert.rejects(readHeldAll(b.repo, bomb), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'readHeldAll refuses the overflow-mode bomb');
  } finally {
    await b.f.cleanup();
  }
});

test('F13: an honest at-cap board still reads back; a plain wide held/ over the cap is refused on read, and the §3.1 walk is cached per held oid', T10, async () => {
  const b = await setup('held-bomb-honest');
  try {
    const { x, atCap } = await capBoards(b, true);
    assert.ok(atCap !== null);
    // The honest at-cap board (exactly 5,000,000 bytes) still reads: no honest writer is refused on the read side.
    assert.deepEqual((await readBoardCommit(b.repo, atCap)).heldIds, [A, B], 'the at-cap board reads');
    assert.deepEqual([...(await readHeldAll(b.repo, atCap)).keys()].sort(), [A, B], 'readHeldAll reads the at-cap board');
    const [ok] = await checkBoardCommits(b.repo, [atCap]);
    assert.equal(ok!.refused, null, 'checkBoardCommits accepts the at-cap board');

    // A plain (non-deduplicated) wide held/ whose tree objects alone sum over the cap — the simplest hostile case — is refused.
    const wideOver = await handBoard(b, atCap, new Map([[A, wide(x, 12_000, 'a')], [B, wide(x, 12_000, 'b')], [C, wide(x, 12_000, 'c')]]));
    const held = (await lsTree(b.repo, wideOver)).find((e) => e.path === 'held')!.oid;
    const heldSum = ([held, ...(await lsTree(b.repo, held, ['-r', '-d'])).map((e) => e.oid)]);
    assert.ok((await sizesOf(b.repo, heldSum)).reduce((s, n) => s + n, 0) > BOARD_TREE_MAX_BYTES, 'held/ tree objects alone sum over the cap');
    await assert.rejects(readBoardCommit(b.repo, wideOver), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large', 'a wide over-cap held/ is refused');

    // The §3.1 verdict is cached by held tree oid (so the fold's per-commit read of a carried held/ walks it once): a second
    // read of the same board issues strictly fewer git calls than the first (the walk is not repeated).
    const spy = spying(b.f);
    const before = spy.calls.length;
    await readBoardCommit(spy.repo, atCap);
    const firstRead = spy.calls.length - before;
    await readBoardCommit(spy.repo, atCap);
    const secondRead = spy.calls.length - before - firstRead;
    assert.ok(secondRead < firstRead, `the cached second read is cheaper (${secondRead} < ${firstRead} git calls)`);
  } finally {
    await b.f.cleanup();
  }
});

// ---- final review F13 round 2 (E-1, E-2, E-3): every held/ reader walks held/ in a few git calls, bounded by the deepest and
// longest legal held path and by the listing it would return; no `ls-tree -r` of held/ anywhere ------------------------------

/** A GitRepo on the fixture that records every git argv with its stdin. */
function spyingIo(f: RepoFixture): { repo: GitRepo; calls: Array<{ args: string[]; stdin: string }> } {
  const calls: Array<{ args: string[]; stdin: string }> = [];
  const runner: GitRunner = { run(args, opts) { calls.push({ args: [...args], stdin: opts.stdin?.toString('utf8') ?? '' }); return f.runner.run(args, opts); } };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), calls };
}

/**
 * A chain of `depth` single-entry trees (each `40000 <name>` over the one below) on top of `bottom`, written by one
 * `git mktree --batch` (the oids are computed here from git's tree format, so each record can name the one before it).
 */
async function chain(repo: GitRepo, bottom: Oid, depth: number, name: string): Promise<Oid> {
  const hash = bottom.length === 64 ? 'sha256' : 'sha1';
  const specs: string[] = [];
  let child = bottom;
  for (let i = 0; i < depth; i++) {
    specs.push(`040000 tree ${child}\t${name}\n`);
    const body = Buffer.concat([Buffer.from(`40000 ${name}\0`, 'utf8'), Buffer.from(child, 'hex')]);
    child = createHash(hash).update(`tree ${body.length}\0`).update(body).digest('hex') as Oid;
  }
  const printed = (await repo.run(['mktree', '--batch'], { stdin: Buffer.from(specs.join('\n'), 'utf8') })).stdout.toString('utf8').trim().split('\n');
  assert.equal(printed[printed.length - 1], child, 'mktree --batch wrote the planned chain');
  return child;
}

const isTooLarge = (e: unknown): boolean => e instanceof BoardMalformedError && e.reason === 'board_too_large';

test('E-1: a held/ tree path longer than any valid held path (held/<ulid>/<stage>/ and 4,096 bytes) is refused board_too_large, never listed; one at the legal maximum reads', T10, async () => {
  const b = await setup('held-longpath');
  try {
    const x = await b.blob('x\n');
    // The e2e probe's long-path shape, smaller: two 4,000-byte directory names under h0 over 1,500 blobs. Its tree objects are
    // ~60 KB (far under the cap), but every line of an `ls-tree -r` would carry an 8 KB path (the probe's 100 levels: 400 KB).
    let t = await b.repo.mktree(Array.from({ length: 1_500 }, (_, i) => ({ name: `f${String(i).padStart(5, '0')}`, mode: '100644', type: 'blob', oid: x } as MktreeEntry)));
    for (let d = 0; d < 2; d++) t = await b.repo.mktree([{ name: String(d).repeat(4_000), mode: '040000', type: 'tree', oid: t }]);
    const h0 = await b.repo.mktree([{ name: 'h0', mode: '040000', type: 'tree', oid: t }]);
    const board = await boardWithHeld(b, b.B0, await b.repo.mktree([{ name: A, mode: '040000', type: 'tree', oid: h0 }]));
    assert.ok((await boardTotal(b.repo, board)) < 100_000, 'the §3.1 sum is far under the cap');
    await assert.rejects(readBoardCommit(b.repo, board), isTooLarge, 'readBoardCommit refuses the long tree path');
    const [checked] = await checkBoardCommits(b.repo, [board]);
    assert.equal(checked!.refused, 'board_too_large', 'checkBoardCommits refuses it');
    const spy = spyingIo(b.f);
    await assert.rejects(readHeldAll(spy.repo, board), isTooLarge, 'readHeldAll refuses it');
    await assert.rejects(readHeld(spy.repo, board, A), isTooLarge, 'readHeld refuses it');
    assert.deepEqual(spy.calls.filter((c) => c.args.includes('ls-tree') && c.args.includes('-r')), [], 'no recursive listing of held/');

    // The longest valid held path (a 4,096-byte repo path) is written by an honest writer and reads back.
    const longest = `${'p'.repeat(2_047)}/${'q'.repeat(2_048)}`;
    assert.equal(Buffer.byteLength(longest), 4_096);
    const honest = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path: longest, oid: x }]]]), remove: new Set() }));
    assert.deepEqual((await readBoardCommit(b.repo, honest)).heldIds, [A]);
    assert.deepEqual(await readHeld(b.repo, honest, A), [{ stage: 'h1', path: longest, oid: x }]);
  } finally {
    await b.f.cleanup();
  }
});

test('E-1: a held/ whose listing (the bytes of every held/ entry path) is over 32 MiB is refused on read, and the writer never grows one past it', T10, async () => {
  const b = await setup('held-listing');
  try {
    const x = await b.blob('x\n');
    // 16 directories of 250-byte names (a 4,015-byte prefix: valid held paths) over n blobs: ~34 bytes of tree object per blob,
    // but each listed path is 4,057 bytes (`held/<id>/h1/`, the prefix, `/f00001`), so 8,400 paths list ~34 MB.
    const dir = Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(250)).join('/');
    const blobs = (n: number): HeldBlob[] => Array.from({ length: n }, (_, i) => ({ stage: 'h1' as const, path: `${dir}/f${String(i).padStart(5, '0')}`, oid: x }));
    const rowBytes = Buffer.byteLength(`held/${A}/h1/${blobs(1)[0]!.path}`);
    assert.equal(rowBytes, 4_057);
    assert.ok(8_000 * rowBytes < 33_554_432 && 8_400 * rowBytes > 33_554_432);
    // Under the bound: the writer builds it and every reader reads it.
    const under = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, blobs(8_000)]]), remove: new Set() }));
    assert.ok((await boardTotal(b.repo, under)) < 400_000, 'its §3.1 sum is far under the cap');
    assert.equal((await readHeld(b.repo, under, A))!.length, 8_000);
    // Over it: the writer refuses the put before commit-tree (BoardCapError, so the publish withholds it as a tree-cap episode) …
    const spy = spying(b.f);
    await assert.rejects(buildBoardCommit(spy.repo, next(b, b.B0, { put: new Map([[A, blobs(8_400)]]), remove: new Set() })), (e: unknown) => e instanceof BoardCapError && /33554432/.test(e.message) && e.cap === HELD_LISTING_MAX_BYTES, 'the writer refuses a put that grows the listing past 32 MiB (the error names the listing cap)');
    assert.ok(!spy.calls.some((a) => a.includes('commit-tree')), 'refused before commit-tree');
    // … and a hand-built board carrying it is refused by every reader.
    const over = await handBoard(b, b.B0, new Map([[A, blobs(8_400)]]));
    assert.ok((await boardTotal(b.repo, over)) < 400_000, 'its §3.1 sum is far under the cap');
    await assert.rejects(readBoardCommit(b.repo, over), isTooLarge, 'readBoardCommit refuses a listing over 32 MiB');
    const [checked] = await checkBoardCommits(b.repo, [over]);
    assert.equal(checked!.refused, 'board_too_large');
    await assert.rejects(readHeldAll(b.repo, over), isTooLarge);
  } finally {
    await b.f.cleanup();
  }
});

test('E-2: the held/ walk costs a few git calls whatever the depth of held/ (an honest 300-component path)', T10, async () => {
  const b = await setup('held-deep-cost');
  try {
    const x = await b.blob('x\n');
    const path = `${'d/'.repeat(299)}f.txt`;
    const board = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path, oid: x }]]]), remove: new Set() }));
    const spy = spying(b.f);
    assert.deepEqual((await readBoardCommit(spy.repo, board)).heldIds, [A]);
    // readBoardCommit's own four calls, plus the walk's: a constant, never one or two per tree level (302 levels here).
    assert.ok(spy.calls.length <= 8, `readBoardCommit of a fresh deep held/ costs ${spy.calls.length} git calls`);
    const before = spy.calls.length;
    assert.deepEqual(await readHeld(spy.repo, board, A), [{ stage: 'h1', path, oid: x }]);
    assert.ok(spy.calls.length - before <= 4, `readHeld after it costs ${spy.calls.length - before} git calls`);
  } finally {
    await b.f.cleanup();
  }
});

test('E-2: the deepest legal held path (2,048 components) reads back; a held/ one tree level deeper is refused board_too_large, and so is one past git\'s own depth limit', T10, async () => {
  const b = await setup('held-deep-limit');
  try {
    const x = await b.blob('x\n');
    // 2,048 one-byte components: 4,095 bytes, a valid path whose deepest directory is held/ + 2,049 tree levels (id, stage,
    // 2,047 directories), one more than git's default core.maxTreeDepth (2,048) lets an `ls-tree -r` of the board descend.
    const deepest = Array.from({ length: 2_048 }, () => 'a').join('/');
    const honest = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, [{ stage: 'h1', path: deepest, oid: x }]]]), remove: new Set() }));
    const spy = spying(b.f);
    assert.deepEqual((await readBoardCommit(spy.repo, honest)).heldIds, [A]);
    assert.ok(spy.calls.length <= 8, `${spy.calls.length} git calls`);
    assert.deepEqual(await readHeldAll(spy.repo, honest), new Map([[A, [{ stage: 'h1', path: deepest, oid: x }]]]));

    // One tree level deeper than any valid path (2,048 directories under the stage tree, the last holding the blob): refused,
    // though git's traversal still reaches it; and one far past git's own depth limit (2,101 directories). `chain` builds the
    // stage tree itself (its top) and `dirs` single-entry `a` trees under it, ending at `leaf`; the honest board above is the
    // same shape with 2,047 (its stage tree is `chain(leaf, 2_047)`).
    const leaf = await b.repo.mktree([{ name: 'a', mode: '100644', type: 'blob', oid: x }]);
    assert.equal((await lsTree(b.repo, `${honest}:held/${A}`))[0]!.oid, await chain(b.repo, leaf, 2_047, 'a'), 'the honest stage tree is the 2,047 chain');
    const below = async (dirs: number): Promise<Oid> => {
      const id = await b.repo.mktree([{ name: 'h1', mode: '040000', type: 'tree', oid: await chain(b.repo, leaf, dirs, 'a') }]);
      return boardWithHeld(b, b.B0, await b.repo.mktree([{ name: A, mode: '040000', type: 'tree', oid: id }]));
    };
    for (const [dirs, what] of [[2_048, 'one level past the deepest valid path'], [2_101, "past git's own depth limit"]] as const) {
      const board = await below(dirs);
      await assert.rejects(readBoardCommit(b.repo, board), isTooLarge, `readBoardCommit: ${what}`);
      const [checked] = await checkBoardCommits(b.repo, [board]);
      assert.equal(checked!.refused, 'board_too_large', `checkBoardCommits: ${what}`);
      await assert.rejects(readHeldAll(b.repo, board), isTooLarge, `readHeldAll: ${what}`);
    }
  } finally {
    await b.f.cleanup();
  }
});

test('integration I-2 (r2 rereview E): the writer\'s listing counts a non-tree entry at the held/ root it carries, as the readers do — an honest put on a board whose held/ root holds a long-named blob is refused before commit-tree when readers would refuse the result', T10, async () => {
  const b = await setup('held-root-blob');
  try {
    const x = await b.blob('x\n');
    // An accepted previous board whose held/ root carries a blob with a 1,000,000-byte name (a forger's; readers list it as
    // `held/<name>`, 1,000,005 bytes).
    const name = 'z'.repeat(1_000_000);
    const prev = await boardWithHeld(b, b.B0, await rawTree(b.repo, [{ mode: '100644', name, oid: x }]));
    await readBoardCommit(b.repo, prev);
    // An honest put of 8,050 paths of 4,057 listed bytes (32,658,850): under the cap alone, over it with the carried blob.
    const dir = Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(250)).join('/');
    const blobs: HeldBlob[] = Array.from({ length: 8_050 }, (_, i) => ({ stage: 'h1' as const, path: `${dir}/f${String(i).padStart(5, '0')}`, oid: x }));
    assert.ok(8_050 * 4_057 <= 33_554_432 && 8_050 * 4_057 + 5 + 1_000_000 > 33_554_432);
    const spy = spying(b.f);
    await assert.rejects(buildBoardCommit(spy.repo, next(b, prev, { put: new Map([[A, blobs]]), remove: new Set() })),
      (e: unknown) => e instanceof BoardCapError && /33554432/.test(e.message) && e.cap === HELD_LISTING_MAX_BYTES, 'the writer counts the carried root blob');
    assert.ok(!spy.calls.some((a) => a.includes('commit-tree')), 'refused before commit-tree');
    // The same put on a held/ root without the blob still builds and reads back (the root entry is what tips it over).
    const ok = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, blobs]]), remove: new Set() }));
    assert.equal((await readHeld(b.repo, ok, A))!.length, 8_050);
  } finally {
    await b.f.cleanup();
  }
});

test('integration I-2 (r2 rereview E): the facts cache is at least 2 × the distinct trees a legal held/ can have, and evicts least recently used, so one board\'s trees survive the next walk', T10, () => {
  assert.ok(FACTS_CACHE_MAX >= 2 * maxDistinctTrees(20, BOARD_TREE_MAX_BYTES), `${FACTS_CACHE_MAX} >= 2 × ${maxDistinctTrees(20, BOARD_TREE_MAX_BYTES)}`);
  // Boards of at most 3 distinct trees in a cache of 6: each walk touches every tree it lists and adds the ones it computed.
  const cache = new Map<string, number>();
  const walk = (listed: readonly string[]): void => rememberFacts(cache, listed, listed.filter((o) => !cache.has(o)).map((o) => [o, 1] as const), 6);
  walk(['t1', 't2', 't3']);
  walk(['t1', 't2', 't4']);
  walk(['t2', 't4', 't5']);
  walk(['t5', 't6', 't7']);
  for (const o of ['t2', 't4', 't5']) assert.ok(cache.has(o), `${o}: the previous board's trees survive the next walk`);
  assert.ok(cache.size <= 6);
  walk(['t8', 't9', 't10']);
  for (const o of ['t5', 't6', 't7']) assert.ok(cache.has(o), `${o}: still after a walk of all-new trees`);
  assert.ok(!cache.has('t1') && !cache.has('t3'), 'the least recently used went first');
});

test('E-3: the walk caches what it learns per tree object, so a changed held/ reads only its new trees; an honest fresh read costs at most 7 git calls', T10, async () => {
  const b = await setup('held-spine');
  try {
    const x = await b.blob('x\n');
    const many = (tag: string): HeldBlob[] => Array.from({ length: 40 }, (_, i) => ({ stage: 'h1' as const, path: `src/${tag}/m${i % 5}/f${i}.ts`, oid: x }));
    const B1 = await buildBoardCommit(b.repo, next(b, b.B0, { put: new Map([[A, many('a')], [B, many('b')]]), remove: new Set() }));
    const B2 = await buildBoardCommit(b.repo, next(b, B1, { put: new Map([[C, [{ stage: 'h0', path: 'x/c.txt', oid: x }]]]), remove: new Set() }));
    const spy = spyingIo(b.f);
    await readBoardCommit(spy.repo, B1);
    assert.ok(spy.calls.length <= 7, `an honest readBoardCommit with a fresh held/ costs ${spy.calls.length} git calls`);
    spy.calls.length = 0;
    await readBoardCommit(spy.repo, B2);
    // held/A and held/B are carried by oid into B2: none of their tree objects is read again (checked or fetched); only the
    // new held/ root and held/C's trees are.
    const carried = new Set<string>();
    for (const id of [A, B]) {
      const sub = (await lsTree(b.repo, `${B2}:held`)).find((e) => e.path === id)!.oid;
      carried.add(sub);
      for (const e of await lsTree(b.repo, sub, ['-r', '-d'])) carried.add(e.oid);
    }
    const reread = spy.calls.filter((c) => c.args[0] === 'cat-file').flatMap((c) => c.stdin.split('\n')).filter((l) => carried.has(l));
    assert.deepEqual(reread, [], 'no carried tree object is read again');
    assert.ok(spy.calls.length <= 7, `${spy.calls.length} git calls`);
  } finally {
    await b.f.cleanup();
  }
});
