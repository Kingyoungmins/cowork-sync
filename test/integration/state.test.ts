import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import { serializeFold, type FoldState } from '../../src/board/fold.js';
import { enc } from '../../src/git/enc.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import type { MktreeEntry, TreeEntry } from '../../src/git/repo.js';
import type { Trailer } from '../../src/git/trailers.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { readyKey, type ReadyPair } from '../../src/holds/changesets.js';
import { MetaTooNewError, serializeMeta, type Meta } from '../../src/engine/meta.js';
import { RELEASE_NAMESPACE, refNames, type RefNames } from '../../src/engine/refs.js';
import { LostStateError, StateCasLostError, StateStore, type Intent, type JournalTree, type StateView } from '../../src/engine/state.js';
import { foldAll, generateBoard } from '../helpers/foldBoard.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const PEER = '0123456789abcdef0123456789abcdef';
const EPOCH = 'fedcba9876543210fedcba9876543210';
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

interface Rec extends Trace { events: TraceEvent[]; }
function recorder(): Rec {
  const events: TraceEvent[] = [];
  return { events, emit: (ev) => events.push(ev) };
}

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

interface Ctx {
  f: RepoFixture;
  refs: RefNames;
  trace: Rec;
  store: StateStore;
  laC: Oid;
  laB: Oid;
  meta: Meta;
  tree(files: Record<string, string>): Promise<Oid>;
}

let scratchN = 0;
async function setup(f: RepoFixture, branch: string): Promise<Ctx> {
  const refs = refNames(branch, RELEASE_NAMESPACE);
  const trace = recorder();
  const store = new StateStore({ repo: f.repo, refs, trace, peer: () => PEER });
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const tree = async (files: Record<string, string>): Promise<Oid> => {
    const m = new Map<string, TreeEntry>();
    for (const [p, c] of Object.entries(files)) m.set(p, { path: p, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(c, 'utf8'), true) });
    return f.repo.writeTreeMap(m, join(dir, `test-${scratchN++}.index`));
  };
  const laC = (await f.repo.resolve('HEAD'))!;
  // LA_B: a distinct commit (a duplicate parent would be dropped by commit-tree), reachable only from the state.
  const laB = await f.repo.commitTree({ tree: await tree({ [`board-${branch}.txt`]: `board of ${branch}\n` }), parents: [], subject: 'board', trailers: [] });
  assert.notEqual(laB, laC);
  return { f, refs, trace, store, laC, laB, meta: sampleMeta(branch, laC), tree };
}

async function lsTree(f: RepoFixture, o: string): Promise<Array<{ mode: string; type: string; oid: string; name: string }>> {
  const r = await f.repo.run(['ls-tree', '-z', o]);
  return r.stdout.toString('utf8').split(NUL).filter((s) => s.length > 0).map((rec) => {
    const tab = rec.indexOf(TAB);
    const [mode, type, oid] = rec.slice(0, tab).split(' ') as [string, string, string];
    return { mode, type, oid, name: rec.slice(tab + 1) };
  });
}

const shape = (entries: Array<{ type: string; name: string }>): string[] => entries.map((e) => `${e.type} ${e.name}`).sort();

async function at(f: RepoFixture, commit: Oid, path: string): Promise<Oid | null> {
  return f.repo.resolve(`${commit}:${path}`);
}

async function reflog(f: RepoFixture, ref: string): Promise<string[]> {
  const r = await f.repo.run(['reflog', 'show', '--format=%H %gs', ref]);
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
}

function pairOf(csId: string, R: Oid, A: Oid, paths: string[]): ReadyPair {
  const n = Number(csId.split('/')[2]);
  return { csId, R, A, paths: [...paths].sort(), order: n };
}

async function deleteLoose(f: RepoFixture, o: Oid): Promise<void> {
  const p = join(f.paths.gitDir, 'objects', o.slice(0, 2), o.slice(2));
  await stat(p); // the object is loose (written by this test, never packed)
  await rm(p, { force: true });
  assert.equal(await f.repo.hasObject(o, 'blob') || await f.repo.hasObject(o, 'tree') || await f.repo.hasObject(o, 'commit'), false);
}

/** The rejection of `p` (null when it resolves), so a test can check the error's own fields. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

const swap = (list: MktreeEntry[], name: string, e: MktreeEntry | null): MktreeEntry[] =>
  [...list.filter((x) => x.name !== name), ...(e === null ? [] : [e])];

interface PlantEdit {
  root?: (r: MktreeEntry[]) => Promise<MktreeEntry[]>;
  journal?: (j: MktreeEntry[]) => Promise<MktreeEntry[]>;
  parents?: Oid[];
  subject?: string;
  trailers?: Trailer[];
}

interface Planter {
  /** Plants a state commit rebuilt from `from`'s tree (the journal edited by `journal`, then the root by `root`), moves the state ref to it and returns it. */
  plant(edit: PlantEdit): Promise<Oid>;
  blob(s: string | Buffer): Promise<Oid>;
}

function planter(c: Ctx, from: StateView): Planter {
  const f = c.f;
  const entries = async (o: string): Promise<MktreeEntry[]> =>
    (await lsTree(f, o)).map((e) => ({ name: e.name, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: parseOid(e.oid) }));
  const blob = async (s: string | Buffer): Promise<Oid> => f.repo.hashBytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s, true);
  const plant = async (edit: PlantEdit): Promise<Oid> => {
    let journal = await entries(`${from.commit}:journal`);
    if (edit.journal) journal = await edit.journal(journal);
    let root = swap(await entries(`${from.commit}^{tree}`), 'journal', { name: 'journal', mode: '040000', type: 'tree', oid: await f.repo.mktree(journal) });
    if (edit.root) root = await edit.root(root);
    const commit = await f.repo.commitTree({
      tree: await f.repo.mktree(root), parents: edit.parents ?? [from.laC, from.laB], subject: edit.subject ?? 'cowork-state', trailers: edit.trailers ?? [],
    });
    const prev = await f.repo.readRef(c.refs.state);
    assert.ok(await f.repo.casRef(c.refs.state, commit, prev, 'test plant'));
    return commit;
  };
  return { plant, blob };
}

test('the state commit has parents [LA_C, LA_B] and a tree of exactly base, snap, meta, journal/{intent.json, t/, ready/<k>/{R,A}, keep/}', async () => {
  const f = await makeRepoFixture('state-shape');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const snap = await c.tree({ 'README.md': '# fixture\n', 'src/a.txt': 'one\nTWO\nthree\n' });
    const csId = `${PEER}/human/1`;
    const R = await c.tree({ 'src/a.txt': 'one\nTWO\nthree\n' });
    const A = await c.tree({ 'src/a.txt': 'one\ntwo\nthree\n' });
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap, meta: c.meta, ready: [pairOf(csId, R, A, ['src/a.txt'])] });

    const info = await f.repo.readCommit(v0.commit);
    assert.deepEqual(info.parents, [c.laC, c.laB]);
    assert.equal(info.subject, 'cowork-state');
    assert.deepEqual(info.trailers, []);
    assert.equal(await f.repo.readRef(c.refs.state), v0.commit);
    assert.equal(c.refs.state, 'refs/cowork-local/main/state');

    const root = await lsTree(f, info.tree);
    assert.deepEqual(shape(root), ['blob meta', 'tree base', 'tree journal', 'tree snap']);
    assert.equal(root.find((e) => e.name === 'base')!.oid, base);
    assert.equal(root.find((e) => e.name === 'snap')!.oid, snap);
    assert.equal(root.find((e) => e.name === 'meta')!.mode, '100644');
    assert.ok((await f.repo.readBlob(parseOid(root.find((e) => e.name === 'meta')!.oid))).equals(serializeMeta(c.meta)));

    const journal = await lsTree(f, `${v0.commit}:journal`);
    assert.deepEqual(shape(journal), ['blob intent.json', 'tree keep', 'tree ready', 'tree t']);
    assert.equal((await f.repo.readBlob(parseOid(journal.find((e) => e.name === 'intent.json')!.oid))).toString('utf8'), '{"kind":"none"}');
    assert.deepEqual(await lsTree(f, `${v0.commit}:journal/t`), []);
    assert.deepEqual(await lsTree(f, `${v0.commit}:journal/keep`), []);
    const k = readyKey(csId);
    assert.deepEqual(shape(await lsTree(f, `${v0.commit}:journal/ready`)), [`tree ${k}`]);
    assert.deepEqual(shape(await lsTree(f, `${v0.commit}:journal/ready/${k}`)), ['tree A', 'tree R']);
    assert.equal(await at(f, v0.commit, `journal/ready/${k}/R`), R);
    assert.equal(await at(f, v0.commit, `journal/ready/${k}/A`), A);

    // A transition with t/ and keep/ entries keeps the same layout.
    const M = await c.tree({ 'src/a.txt': 'merged\n' });
    const kept = await c.tree({ 'x.txt': 'kept\n' });
    const v1 = await c.store.commit(v0, { t: new Map<JournalTree, Oid>([['M', M]]), keep: new Map([['pre_freeze', kept]]) });
    assert.deepEqual((await f.repo.readCommit(v1.commit)).parents, [c.laC, c.laB]);
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}^{tree}`)), ['blob meta', 'tree base', 'tree journal', 'tree snap']);
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}:journal`)), ['blob intent.json', 'tree keep', 'tree ready', 'tree t']);
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}:journal/t`)), ['tree M']);
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}:journal/keep`)), ['tree pre_freeze']);
    assert.equal(await at(f, v1.commit, 'journal/t/M'), M);
    assert.equal(await at(f, v1.commit, 'journal/keep/pre_freeze'), kept);

    // LA_C == LA_B would lose a parent (commit-tree drops a duplicate) and read back as a lost state: refused.
    await assert.rejects(c.store.commit(v1, { laB: c.laC }), TypeError);
    assert.equal(await f.repo.readRef(c.refs.state), v1.commit);

    // One 'state' trace event per transition, after the CAS.
    assert.deepEqual(c.trace.events, [
      { kind: 'state', peer: PEER, prev: null, next: v0.commit, laC: c.laC, laB: c.laB, base },
      { kind: 'state', peer: PEER, prev: v0.commit, next: v1.commit, laC: c.laC, laB: c.laB, base },
    ]);
  } finally {
    await f.cleanup();
  }
});

test('every intent kind round-trips and every referenced tree is a subtree of the state commit', async () => {
  const f = await makeRepoFixture('state-intents');
  try {
    const c = await setup(f, 'feature/x');
    const base = await c.tree({ 'src/a.txt': 'A\n' });
    const snap = await c.tree({ 'src/a.txt': 'S\n' });
    const R = await c.tree({ 'src/a.txt': 'R\n' });
    const A = await c.tree({ 'src/a.txt': 'A\n', 'src/b.txt': 'b\n' });
    const ready = [pairOf(`${PEER}/human/3`, R, A, ['src/a.txt', 'src/b.txt'])];
    let prev = await c.store.create({ laC: c.laC, laB: c.laB, base, snap, meta: c.meta, ready });
    const blob = await f.repo.hashBytes(Buffer.from('target\n', 'utf8'), true);
    const M = await c.tree({ 'src/a.txt': 'M\n' });
    const S = await c.tree({ 'src/a.txt': 'S2\n' });
    const TIP = await c.tree({ 'src/a.txt': 'TIP\n' });
    const P = await c.tree({ 'src/a.txt': 'P\n' });
    const kept = await c.tree({ 'k.txt': 'k\n' });
    const intents: Array<{ intent: Intent; t: Map<JournalTree, Oid> }> = [
      { intent: { kind: 'none' }, t: new Map() },
      {
        intent: {
          kind: 'apply', tip: c.laC, board: c.laB, groups: [
            { n: 0, entries: [{ path: 'src/a.txt', kind: 'modify', slot: 0 }, { path: '\u{D55C}/\u{AE00}.txt', kind: 'create', slot: 1 }] },
            { n: 1, entries: [{ path: 'old.txt', kind: 'delete', slot: 2 }] },
          ],
        },
        t: new Map<JournalTree, Oid>([['M', M], ['S', S], ['TIP', TIP]]),
      },
      {
        intent: { kind: 'local', origin: 'restart', entries: [{ path: 'src/a.txt', expected: ABSENT, target: blob, slot: 0 }, { path: 'src/b.txt', expected: blob, target: 'DELETE', slot: 1 }] },
        t: new Map(),
      },
      {
        intent: { kind: 'push', bnew: c.laB, c: c.laC, lease_board: c.laB, lease_code: ABSENT, cs_ids: [`${PEER}/human/3`], writer_seq: 9, op_ids: [`${PEER}/${EPOCH}/8`] },
        t: new Map<JournalTree, Oid>([['P', P]]),
      },
      { intent: { kind: 'push', bnew: c.laB, c: null, lease_board: ABSENT, lease_code: ABSENT, cs_ids: [], writer_seq: 1, op_ids: [] }, t: new Map<JournalTree, Oid>([['P', P]]) },
      { intent: { kind: 'none' }, t: new Map() },
    ];
    const keep = new Map([['pre_freeze', kept]]);
    for (const { intent, t } of intents) {
      const v = await c.store.commit(prev, { intent, t, keep });
      const r = await c.store.read();
      assert.ok(r !== null);
      assert.deepEqual(r, v, `read() returns the view commit() returned (${intent.kind})`);
      assert.deepEqual(r.intent, intent);
      assert.deepEqual(r.t, t);
      assert.ok((await f.repo.readBlob((await at(f, v.commit, 'journal/intent.json'))!)).equals(canonicalBytes(intent as unknown as Json)));
      // Every tree the view names is that subtree of the state commit (INV-ENG-REACH's precondition).
      for (const [name, o] of r.t) assert.equal(await at(f, v.commit, `journal/t/${name}`), o, `t/${name}`);
      assert.deepEqual(shape(await lsTree(f, `${v.commit}:journal/t`)), [...t.keys()].map((n) => `tree ${n}`).sort());
      for (const p of r.ready) {
        assert.equal(await at(f, v.commit, `journal/ready/${readyKey(p.csId)}/R`), p.R);
        assert.equal(await at(f, v.commit, `journal/ready/${readyKey(p.csId)}/A`), p.A);
      }
      for (const [name, o] of r.keep) assert.equal(await at(f, v.commit, `journal/keep/${name}`), o);
      assert.equal(await at(f, v.commit, 'base'), r.base);
      assert.equal(await at(f, v.commit, 'snap'), r.snap);
      assert.deepEqual(r.ready, ready);
      assert.deepEqual(r.keep, keep);
      prev = v;
    }

    // An intent the schema refuses throws before any write; the ref stays.
    const before = await f.repo.readRef(c.refs.state);
    const bad: unknown[] = [
      { kind: 'adopt' },
      { kind: 'apply', tip: 'x', board: c.laB, groups: [] },
      { kind: 'apply', tip: c.laC, board: c.laB, groups: [{ n: 0, entries: [{ path: '../x', kind: 'modify', slot: 0 }] }] },
      { kind: 'local', origin: 'restart', entries: [{ path: 'a', expected: ABSENT, target: 'REMOVE', slot: 0 }] },
      { kind: 'push', bnew: c.laB, c: null, lease_board: ABSENT, lease_code: ABSENT, cs_ids: ['nope'], writer_seq: 1, op_ids: [] },
      { kind: 'none', extra: 1 },
    ];
    for (const intent of bad) {
      await assert.rejects(c.store.commit(prev, { intent: intent as Intent }), TypeError, JSON.stringify(intent));
    }
    await assert.rejects(c.store.commit(prev, { t: new Map([['X' as JournalTree, P]]) }), TypeError);
    await assert.rejects(c.store.commit(prev, { keep: new Map([['a/b', kept]]) }), TypeError);
    await assert.rejects(c.store.commit(prev, { ready: [{ ...ready[0]!, order: 4 }] }), TypeError);
    await assert.rejects(c.store.commit(prev, { ready: [ready[0]!, ready[0]!] }), TypeError);
    assert.equal(await f.repo.readRef(c.refs.state), before);
  } finally {
    await f.cleanup();
  }
});

test('after git gc --prune=now every object named by the state commit still exists', async () => {
  const f = await makeRepoFixture('state-reach');
  try {
    const c = await setup(f, 'main');
    // Every object below is referenced by the state commit and by nothing else.
    const base = await c.tree({ 'only/base.txt': 'base only\n' });
    const snap = await c.tree({ 'only/snap.txt': 'snap only\n' });
    const R = await c.tree({ 'only/r.txt': 'R only\n' });
    const A = await c.tree({ 'only/r.txt': 'A only\n' });
    const t = new Map<JournalTree, Oid>([
      ['M', await c.tree({ 'm.txt': 'M only\n' })], ['S', await c.tree({ 's.txt': 'S only\n' })],
      ['TIP', await c.tree({ 'tip.txt': 'TIP only\n' })], ['P', await c.tree({ 'p.txt': 'P only\n' })],
    ]);
    const keep = new Map([['pre_freeze', await c.tree({ 'keep.txt': 'kept only\n' })]]);
    const gen = generateBoard('state-reach', 30);
    const fold = foldAll(gen, gen.peers[0]!, c.laC).at(-1)!;
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap, meta: c.meta, ready: [pairOf(`${PEER}/human/1`, R, A, ['only/r.txt'])] });
    const v1 = await c.store.commit(v0, {
      intent: { kind: 'apply', tip: c.laC, board: c.laB, groups: [{ n: 0, entries: [{ path: 'only/r.txt', kind: 'modify', slot: 0 }] }] },
      t, keep, fold, meta: { ...c.meta, fold_board: c.laB },
    });
    // Negative control: an object nothing references must be gone after the gc, or the test proves nothing.
    const stray = await f.repo.hashBytes(Buffer.from('unreferenced stray\n', 'utf8'), true);

    // Every object the state commit names, down to the blobs of every tree.
    const named = new Map<string, string>([[v1.commit, 'commit'], [c.laC, 'commit'], [c.laB, 'commit']]);
    const walk = async (o: string): Promise<void> => {
      const r = await f.repo.run(['ls-tree', '-r', '-t', '-z', o]);
      for (const rec of r.stdout.toString('utf8').split(NUL)) {
        if (rec.length === 0) continue;
        const [, type, oid] = rec.slice(0, rec.indexOf(TAB)).split(' ') as [string, string, string];
        named.set(oid, type);
      }
    };
    named.set((await f.repo.resolve(`${v1.commit}^{tree}`))!, 'tree');
    await walk(`${v1.commit}^{tree}`);
    await walk(`${c.laB}^{tree}`);
    for (const o of [base, snap, R, A, ...t.values(), ...keep.values()]) assert.equal(named.get(o), 'tree', `named ${o}`);
    assert.equal(named.get((await at(f, v1.commit, 'journal/keep/fold/state.json'))!), 'blob');
    assert.ok(named.size > 25);

    // The destructive gc runs through the test runner with a hermetic environment: no global or system git config
    // (GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM name empty files, GIT_CONFIG_NOSYSTEM=1), so a developer's gc or prune
    // settings cannot change what survives. GitRepo.run throws on a non-zero exit.
    const systemConfig = join(f.root, 'empty system gitconfig');
    await writeFile(systemConfig, '');
    await hermeticRepo(f, [], { GIT_CONFIG_SYSTEM: systemConfig }).repo.run(['gc', '--prune=now', '--quiet']);

    const check = await f.repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${[...named.keys(), stray].join('\n')}\n`, 'utf8') });
    const lines = check.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, named.size + 1);
    [...named.entries()].forEach(([o, type], i) => assert.match(lines[i]!, new RegExp(`^${o} ${type} \\d+$`), `${type} ${o} survives gc`));
    assert.equal(lines[named.size], `${stray} missing`, 'the unreferenced control object was pruned');

    const r = await c.store.read();
    assert.deepEqual(r, v1);
    assert.deepEqual(r!.fold, fold);
  } finally {
    await f.cleanup();
  }
});

test('a second writer\'s CAS throws StateCasLostError and leaves the ref unchanged', async () => {
  const f = await makeRepoFixture('state-cas');
  try {
    const c = await setup(f, 'main');
    const other = new StateStore({ repo: f.repo, refs: c.refs, trace: c.trace, peer: () => PEER });
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta });
    const seen = await other.read();
    assert.deepEqual(seen, v0);
    // The second writer transitions first.
    const won = await other.commit(seen!, { meta: { ...c.meta, seq_next: 2 } });
    const events = c.trace.events.length;
    const lost = await rejection(c.store.commit(v0, { meta: { ...c.meta, seq_next: 3 } }));
    assert.ok(lost instanceof StateCasLostError, String(lost));
    assert.equal(lost.name, 'StateCasLostError');
    assert.ok(lost.message.includes(c.refs.state) && lost.message.includes(v0.commit), lost.message);
    assert.equal(await f.repo.readRef(c.refs.state), won.commit, 'the ref is unchanged by the loser');
    assert.equal((await reflog(f, c.refs.state)).length, 2, 'the loser adds no reflog entry');
    assert.equal(c.trace.events.length, events, 'a lost CAS emits no state event');
    assert.deepEqual(await c.store.read(), won);
    // A create over an existing state is a second writer too: the same error, and nothing recorded.
    const lostCreate = await rejection(c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta }));
    assert.ok(lostCreate instanceof StateCasLostError, String(lostCreate));
    assert.equal(lostCreate.name, 'StateCasLostError');
    assert.ok(lostCreate.message.includes(c.refs.state), lostCreate.message);
    assert.equal(await f.repo.readRef(c.refs.state), won.commit);
    assert.equal((await reflog(f, c.refs.state)).length, 2, 'the losing create adds no reflog entry');
    assert.equal(c.trace.events.length, events, 'the losing create emits no state event');
  } finally {
    await f.cleanup();
  }
});

test('each transition adds one reflog entry to the state ref', async () => {
  const f = await makeRepoFixture('state-reflog');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const views: StateView[] = [await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta })];
    assert.deepEqual(await reflog(f, c.refs.state), [`${views[0]!.commit} cowork-state`]);
    for (let i = 2; i <= 4; i++) {
      const snap = await c.tree({ 'src/a.txt': `v${i}\n` });
      views.push(await c.store.commit(views.at(-1)!, { snap, meta: { ...c.meta, seq_next: i } }));
      await c.store.read(); // a read adds nothing
      assert.equal((await reflog(f, c.refs.state)).length, i);
    }
    assert.deepEqual(await reflog(f, c.refs.state), views.map((v) => `${v.commit} cowork-state`).reverse());
    assert.equal(new Set(views.map((v) => v.commit)).size, 4);
  } finally {
    await f.cleanup();
  }
});

test('a missing ref reads null; a missing named object throws LostStateError', async () => {
  const f = await makeRepoFixture('state-lost');
  try {
    const victims = ['meta', 'base', 'snap', 'ready R', 'ready A', 't/M', 'keep', 'fold', 'LA_C', 'LA_B', 'commit'] as const;
    for (const victim of victims) {
      // One state per victim (its own branch, its own objects), so a deletion breaks only that state. Every object
      // here is written by this test and referenced by nothing else (HEAD and its tree are the clone's, packed).
      const c = await setup(f, `lost-${victim.replace(/[^a-z]/gi, '')}`);
      assert.equal(await c.store.read(), null, 'no ref reads null');
      const laC = await f.repo.commitTree({ tree: await c.tree({ [`code-${victim}.txt`]: `LA_C ${victim}\n` }), parents: [], subject: 'code', trailers: [] });
      const base = await c.tree({ [`base-${victim}.txt`]: `base ${victim}\n` });
      const snap = await c.tree({ [`snap-${victim}.txt`]: `${victim}\n` });
      const R = await c.tree({ [`r-${victim}.txt`]: `R ${victim}\n` });
      const A = await c.tree({ [`r-${victim}.txt`]: `A ${victim}\n` });
      const M = await c.tree({ [`m-${victim}.txt`]: `M ${victim}\n` });
      const kept = await c.tree({ [`k-${victim}.txt`]: `K ${victim}\n` });
      const gen = generateBoard(`state-lost-${victim}`, 8);
      const fold = foldAll(gen, gen.peers[0]!, c.laC).at(-1)!;
      const v0 = await c.store.create({ laC, laB: c.laB, base, snap, meta: c.meta, ready: [pairOf(`${PEER}/human/1`, R, A, [`r-${victim}.txt`])], fold });
      const v1 = await c.store.commit(v0, { t: new Map<JournalTree, Oid>([['M', M]]), keep: new Map([['pre_freeze', kept]]) });
      assert.deepEqual(await c.store.read(), v1);
      const target: Record<typeof victim, Oid> = {
        meta: (await at(f, v1.commit, 'meta'))!, base, snap, 'ready R': R, 'ready A': A, 't/M': M, keep: kept,
        fold: (await at(f, v1.commit, 'journal/keep/fold/state.json'))!, LA_C: laC, LA_B: c.laB, commit: v1.commit,
      };
      await deleteLoose(f, target[victim]);
      const e = await rejection(c.store.read());
      assert.ok(e instanceof LostStateError && !(e instanceof MetaTooNewError), `missing ${victim}: ${String(e)}`);
      assert.equal(e.name, 'LostStateError');
      assert.equal(e.stateOid, v1.commit, `missing ${victim}: stateOid is the commit the ref names`);
      assert.ok(e.cause !== undefined, `missing ${victim}: the cause is kept`);
      assert.equal(await f.repo.readRef(c.refs.state), v1.commit, 'a read writes nothing');
    }
  } finally {
    await f.cleanup();
  }
});

test('a malformed state reads as LostStateError and a newer meta as MetaTooNewError', async () => {
  const f = await makeRepoFixture('state-malformed');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const R = await c.tree({ 'r.txt': 'R\n' });
    const gen = generateBoard('state-malformed', 8);
    const fold = foldAll(gen, gen.peers[0]!, c.laC).at(-1)!;
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta, ready: [pairOf(`${PEER}/human/2`, R, R, ['r.txt'])], fold });
    const { plant, blob } = planter(c, v0);
    // Control: plant() with no edit rebuilds v0's tree byte for byte and reads back as a valid state, so each row
    // below is refused for its own edit and not for something plant() itself gets wrong.
    const same = await plant({});
    assert.equal((await f.repo.readCommit(same)).tree, (await f.repo.readCommit(v0.commit)).tree);
    assert.deepEqual(await c.store.read(), { ...v0, commit: same });

    const metaJson = JSON.parse(serializeMeta(c.meta).toString('utf8')) as Record<string, Json>;
    const meta2 = async (): Promise<MktreeEntry> => ({ name: 'meta', mode: '100644', type: 'blob', oid: await blob(canonicalBytes({ ...metaJson, v: 2 })) });
    const extra = async (): Promise<MktreeEntry> => ({ name: 'extra', mode: '100644', type: 'blob', oid: await blob('x') });
    // A third distinct commit (commit-tree drops a duplicate parent).
    const third = await f.repo.commitTree({ tree: await c.tree({ 'third.txt': 'third\n' }), parents: [], subject: 'third', trailers: [] });
    const newer = async (r: MktreeEntry[]): Promise<MktreeEntry[]> => swap(r, 'meta', await meta2());
    const cases: Array<[string, PlantEdit, typeof LostStateError | typeof MetaTooNewError]> = [
      ['non-canonical meta', { root: async (r) => swap(r, 'meta', { name: 'meta', mode: '100644', type: 'blob', oid: await blob(JSON.stringify(metaJson, null, 1)) }) }, LostStateError],
      ['no meta', { root: async (r) => swap(r, 'meta', null) }, LostStateError],
      ['three parents', { parents: [c.laC, c.laB, third] }, LostStateError],
      ['another subject', { subject: 'cowork-state-2' }, LostStateError],
      ['a trailer', { trailers: [{ key: 'Cowork-State', value: '2' }] }, LostStateError],
      // LIF-37 (ruling P2-METAFIRST): a newer meta is refused before the subject, parent and layout checks, whatever
      // else a newer plugin changed, so the state of a newer plugin is never read as lost and rebuilt over.
      ['meta v 2', { root: newer }, MetaTooNewError],
      ['meta v 2 with an extra root entry', { root: async (r) => [...(await newer(r)), await extra()] }, MetaTooNewError],
      ['pretty-printed meta v 2 with an extra root entry', {
        root: async (r) => [...swap(r, 'meta', { name: 'meta', mode: '100644', type: 'blob', oid: await blob(JSON.stringify({ ...metaJson, v: 2 }, null, 2)) }), await extra()],
      }, MetaTooNewError],
      ['meta v 2 without a journal', { root: async (r) => swap(await newer(r), 'journal', null) }, MetaTooNewError],
      ['meta v 2 with one parent', { root: newer, parents: [c.laC] }, MetaTooNewError],
      ['meta v 2 with three parents', { root: newer, parents: [c.laC, c.laB, third] }, MetaTooNewError],
      ['meta v 2 under another subject', { root: newer, subject: 'cowork-state-2' }, MetaTooNewError],
      ['meta v 2 with a trailer', { root: newer, trailers: [{ key: 'Cowork-State', value: '2' }] }, MetaTooNewError],
      ['an extra root entry', { root: async (r) => [...r, await extra()] }, LostStateError],
      ['no snap', { root: async (r) => swap(r, 'snap', null) }, LostStateError],
      ['meta as a tree', { root: async (r) => swap(r, 'meta', { name: 'meta', mode: '040000', type: 'tree', oid: R }) }, LostStateError],
      ['garbage intent.json', { journal: async (j) => swap(j, 'intent.json', { name: 'intent.json', mode: '100644', type: 'blob', oid: await blob('{"kind":"later"}') }) }, LostStateError],
      ['a t/ entry outside M, S, TIP, P', { journal: async (j) => swap(j, 't', { name: 't', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'Q', mode: '040000', type: 'tree', oid: R }]) }) }, LostStateError],
      ['a ready key that is not readyKey of a cs id', {
        journal: async (j) => swap(j, 'ready', { name: 'ready', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'bm90LWEtY3M', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'A', mode: '040000', type: 'tree', oid: R }, { name: 'R', mode: '040000', type: 'tree', oid: R }]) }]) }),
      }, LostStateError],
      ['a ready pair without A', {
        journal: async (j) => swap(j, 'ready', { name: 'ready', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: readyKey(`${PEER}/human/2`), mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'R', mode: '040000', type: 'tree', oid: R }]) }]) }),
      }, LostStateError],
      ['an unparsable fold state', {
        journal: async (j) => swap(j, 'keep', { name: 'keep', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'fold', mode: '040000', type: 'tree', oid: await f.repo.mktree([{ name: 'state.json', mode: '100644', type: 'blob', oid: await blob('{}') }]) }]) }),
      }, LostStateError],
      ['one parent', { parents: [c.laC] }, LostStateError],
    ];
    // Every row runs; the rows that read wrongly are listed together.
    const wrong: string[] = [];
    for (const [what, edit, err] of cases) {
      const planted = await plant(edit);
      const e = await rejection(c.store.read());
      const ok = err === MetaTooNewError
        ? e instanceof MetaTooNewError
        : e instanceof LostStateError && !(e instanceof MetaTooNewError) && e.stateOid === planted;
      if (!ok) wrong.push(`${what}: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : String(e)}`);
      assert.equal(await f.repo.readRef(c.refs.state), planted, `${what}: a read writes nothing`);
    }
    assert.deepEqual(wrong, []);
  } finally {
    await f.cleanup();
  }
});

test('rebuild replaces an unusable state ref by one CAS from LostStateError.stateOid', async () => {
  const f = await makeRepoFixture('state-rebuild');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta });
    const { plant, blob } = planter(c, v0);
    // An existing but unusable state: its meta blob replaced by garbage.
    const corrupt = await plant({ root: async (r) => swap(r, 'meta', { name: 'meta', mode: '100644', type: 'blob', oid: await blob('not json\n') }) });
    const lost = await rejection(c.store.read());
    assert.ok(lost instanceof LostStateError, String(lost));
    assert.equal(lost.stateOid, corrupt, 'stateOid is the value of the state ref');
    assert.equal(await f.repo.readRef(c.refs.state), corrupt);

    const snap = await c.tree({ 'src/a.txt': 'rebuilt\n' });
    const R = await c.tree({ 'src/a.txt': 'R\n' });
    const A = await c.tree({ 'src/a.txt': 'A\n' });
    const gen = generateBoard('state-rebuild', 8);
    const fold = foldAll(gen, gen.peers[0]!, c.laC).at(-1)!;
    const init = { laC: c.laC, laB: c.laB, base, snap, meta: { ...c.meta, seq_next: 7 }, ready: [pairOf(`${PEER}/human/4`, R, A, ['src/a.txt'])], fold };

    // create() cannot replace an existing ref, and a rebuild from any oid but the ref's value is a second writer:
    // the ref, its reflog and the trace stay as they were.
    const reflogBefore = await reflog(f, c.refs.state);
    const events = c.trace.events.length;
    await assert.rejects(c.store.create(init), StateCasLostError);
    await assert.rejects(c.store.rebuild(v0.commit, init), StateCasLostError);
    await assert.rejects(c.store.rebuild(c.laC, init), StateCasLostError);
    assert.equal(await f.repo.readRef(c.refs.state), corrupt);
    assert.deepEqual(await reflog(f, c.refs.state), reflogBefore);
    assert.equal(c.trace.events.length, events);

    // The rebuild: one CAS from the unusable commit to a fresh state (no intent, empty t/ and keep/).
    const rebuilt = await c.store.rebuild(lost.stateOid!, init);
    assert.equal(await f.repo.readRef(c.refs.state), rebuilt.commit);
    assert.deepEqual(await c.store.read(), rebuilt);
    assert.deepEqual((await f.repo.readCommit(rebuilt.commit)).parents, [c.laC, c.laB]);
    assert.deepEqual(rebuilt.intent, { kind: 'none' });
    assert.deepEqual(rebuilt.t, new Map());
    assert.deepEqual(rebuilt.keep, new Map());
    assert.deepEqual(rebuilt.meta, init.meta);
    assert.deepEqual(rebuilt.fold, fold);
    assert.deepEqual(rebuilt.ready, init.ready);
    assert.equal(rebuilt.snap, snap);
    assert.deepEqual(await reflog(f, c.refs.state), [`${rebuilt.commit} cowork-state`, ...reflogBefore]);
    assert.deepEqual(c.trace.events.slice(events), [{ kind: 'state', peer: PEER, prev: corrupt, next: rebuilt.commit, laC: c.laC, laB: c.laB, base }]);

    // The ref has moved on: rebuilding from the old unusable oid now loses the CAS.
    await assert.rejects(c.store.rebuild(corrupt, init), StateCasLostError);
    assert.equal(await f.repo.readRef(c.refs.state), rebuilt.commit);
  } finally {
    await f.cleanup();
  }
});

test('a state ref whose value git cannot read is a LostStateError with stateOid null', async () => {
  const f = await makeRepoFixture('state-unreadable-ref');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta });
    assert.deepEqual(await c.store.read(), v0);
    // A corrupt packed-refs makes every ref lookup fail (for-each-ref exits 128): the ref value itself is unreadable.
    await appendFile(join(f.paths.gitDir, 'packed-refs'), 'garbage line\n');
    const e = await rejection(c.store.read());
    assert.ok(e instanceof LostStateError, String(e));
    assert.equal(e.stateOid, null);
    assert.ok(e.cause !== undefined, 'the cause is kept');
  } finally {
    await f.cleanup();
  }
});

test('readyKey is base64url without padding', () => {
  const ref = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Lengths 40, 41, 42 (mod 3 = 1, 2, 0) cover both padding cases; a seat CS id (Plan 3 form) too.
  const ids = [`${PEER}/human/1`, `${PEER}/human/12`, `${PEER}/human/123`, `${'f'.repeat(32)}/7`];
  for (const id of ids) {
    const k = readyKey(id);
    assert.equal(k, ref(id));
    assert.match(k, /^[A-Za-z0-9_-]+$/);
    assert.ok(!k.includes('='));
    assert.equal(Buffer.from(k, 'base64url').toString('utf8'), id);
  }
  assert.equal(readyKey(`${PEER}/human/1`), 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYvaHVtYW4vMQ');
  for (const bad of ['', 'x', `${PEER}/human/0`, `${PEER}/robot/1`]) assert.throws(() => readyKey(bad), TypeError, bad);
});

test('the fold state survives in journal/keep/fold/state.json with meta.fold_board', async () => {
  const f = await makeRepoFixture('state-fold');
  try {
    const c = await setup(f, 'main');
    const base = (await f.repo.resolve('HEAD^{tree}'))!;
    const gen = generateBoard('state-fold', 40);
    const states: FoldState[] = foldAll(gen, gen.peers[0]!, c.laC);
    const fold = states.at(-1)!;
    assert.ok(Object.keys(fold.peers).length > 0, 'a non-trivial fold state');
    const v0 = await c.store.create({ laC: c.laC, laB: c.laB, base, snap: base, meta: c.meta });
    assert.equal(v0.fold, null);
    assert.deepEqual(shape(await lsTree(f, `${v0.commit}:journal/keep`)), []);

    const kept = await c.tree({ 'k.txt': 'k\n' });
    const meta1: Meta = { ...c.meta, fold_board: c.laB, fold_verified: { board: c.laB, height: 0 }, checkpoint_mismatch: true };
    const v1 = await c.store.commit(v0, { fold, meta: meta1, keep: new Map([['pre_freeze', kept]]) });
    const foldBlob = (await at(f, v1.commit, 'journal/keep/fold/state.json'))!;
    assert.ok((await f.repo.readBlob(foldBlob)).equals(serializeFold(fold)));
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}:journal/keep`)), ['tree fold', 'tree pre_freeze']);
    assert.deepEqual(shape(await lsTree(f, `${v1.commit}:journal/keep/fold`)), ['blob state.json']);

    const r1 = (await c.store.read())!;
    assert.deepEqual(r1.fold, fold);
    assert.equal(r1.meta.fold_board, c.laB);
    assert.deepEqual(r1.meta.fold_verified, { board: c.laB, height: 0 });
    assert.equal(r1.meta.checkpoint_mismatch, true);
    assert.deepEqual(r1.keep, new Map([['pre_freeze', kept]]), 'keep/fold is the fold state, not a kept tree');

    // A transition that does not name the fold keeps it byte for byte; a new fold replaces it.
    const v2 = await c.store.commit(r1, { meta: { ...meta1, seq_next: 5 }, keep: new Map() });
    assert.equal(await at(f, v2.commit, 'journal/keep/fold/state.json'), foldBlob);
    assert.deepEqual((await c.store.read())!.fold, fold);
    const older = states.at(-2)!;
    const v3 = await c.store.commit(v2, { fold: older, meta: { ...meta1, fold_board: c.laC } });
    assert.ok((await f.repo.readBlob((await at(f, v3.commit, 'journal/keep/fold/state.json'))!)).equals(serializeFold(older)));
    const r3 = (await c.store.read())!;
    assert.deepEqual(r3.fold, older);
    assert.equal(r3.meta.fold_board, c.laC);
    // 'fold' is not a keep name a caller can use.
    await assert.rejects(c.store.commit(r3, { keep: new Map([['fold', kept]]) }), TypeError);
  } finally {
    await f.cleanup();
  }
});
