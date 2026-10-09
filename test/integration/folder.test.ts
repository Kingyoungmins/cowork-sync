// Folder (Plan 2 Task 6): the incremental fold along a real board's first-parent chain — joiner start at the
// newest checkpoint (PRO-29, glossary §24 default 9), a persisted `from` that does not fit discarded (PRO-25),
// checkpoint verification with one refold from a checkpoint this Folder verified, else genesis (PRO-28,
// controller ruling P2-REFOLD), checkpoint_mismatch (ruling R-13) and its survival across a restart (ruling
// P2-FOLDPERSIST), and the proto flag (PRO-47). Real git on a file:// clone.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { buildBoardCommit, CODE_SUBJECT, liveCommitTrailers, type BoardDraft, type WriterId } from '../../src/board/boardCommit.js';
import { canonicalBytes, type Json } from '../../src/board/canonicalJson.js';
import {
  Folder,
  foldCommit,
  initialFoldState,
  parseFold,
  REPLAY_MAX,
  serializeFold,
  type FoldState,
  type FoldVerification,
  type OwnRejection,
} from '../../src/board/fold.js';
import { eventCid, parseOpLine, type Op } from '../../src/board/ops.js';
import { genesisProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { foldAll, generateBoard, genDraft, honestCheckpoints, importBoard, type GenBoard } from '../helpers/foldBoard.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const N = 600;
const LIVE = '1'.repeat(40) as Oid;
/** The record the wrong checkpoints of boards B and C carry and no honest fold produces. */
const FAKE_512 = 'ZZZZZZZZ';
const FAKE_256 = 'XXXXXXXX';

interface Shared {
  f: RepoFixture;
  gen: GenBoard;
  self: string;
  states: FoldState[];
  A: Oid[];   // honest board, by height
  B: Oid[];   // the same board with a wrong checkpoint at 512
  C: Oid[];   // the same board with self-consistent wrong checkpoints at 256 and 512 (512 = 256 folded forward)
}

let shared: Promise<Shared> | null = null;
let fixture: RepoFixture | null = null;

after(async () => {
  if (fixture !== null) await fixture.cleanup();
});

const same = (a: FoldState, b: FoldState): boolean => serializeFold(a).equals(serializeFold(b));

/** `s` with one freeze event under `cid` that no honest fold produces (a well-formed, wrong fold state). */
function withFakeEvent(s: FoldState, cid: string): FoldState {
  const wrong = structuredClone(s);
  wrong.events[cid] = { kind: 'freeze', refs: [], reason_code: 'FAKE_EVENT', op_id: `${'f'.repeat(32)}/${'f'.repeat(32)}/1`, height: s.height };
  wrong.record_count += 1;
  assert.ok(parseFold(canonicalBytes(wrong as unknown as Json)) !== null, 'the wrong checkpoint is a well-formed fold state');
  return wrong;
}

function setup(): Promise<Shared> {
  shared ??= (async () => {
    const f = await makeRepoFixture('folder');
    fixture = f;
    const gen = generateBoard('folder-integration', N);
    const self = gen.peers[2]!;
    const states = foldAll(gen, self, LIVE);
    const honest = honestCheckpoints(states);
    const A = (await importBoard(f.repo, 'refs/cowork-test/a', gen, honest)).oids;
    // B: the writer at 512 folded wrongly (one extra record).
    const wrong512 = serializeFold(withFakeEvent(states[512]!, FAKE_512));
    const B = (await importBoard(f.repo, 'refs/cowork-test/b', gen, new Map([...honest, [512, wrong512]]))).oids;
    assert.equal(B[511], A[511], 'the boards share every commit below 512');
    assert.notEqual(B[512], A[512]);
    // C: a wrong lineage — a wrong 256, and 512 folded from it, so 512 is consistent with 256 but not with genesis.
    let w = withFakeEvent(states[256]!, FAKE_256);
    const wrong256 = serializeFold(w);
    for (let h = 257; h <= 512; h++) w = foldCommit(w, genDraft(gen, gen.commits[h]!, LIVE), self).state;
    assert.ok(w.events[FAKE_256] !== undefined && !same(w, states[512]!), 'the wrong record survives to 512');
    const C = (await importBoard(f.repo, 'refs/cowork-test/c', gen, new Map([...honest, [256, wrong256], [512, serializeFold(w)]]))).oids;
    assert.equal(C[255], A[255]);
    assert.notEqual(C[256], A[256]);
    return { f, gen, self, states, A, B, C };
  })();
  return shared;
}

/** A GitRepo on the fixture that counts commit-object reads (`cat-file commit <oid>`, one per board commit read) and all git calls. */
function counting(f: RepoFixture): { repo: GitRepo; reads: () => number; calls: () => number } {
  let n = 0;
  let all = 0;
  const runner: GitRunner = {
    run(args, opts) {
      all++;
      if (args[0] === 'cat-file' && args[1] === 'commit') n++;
      return f.runner.run(args, opts);
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), reads: () => n, calls: () => all };
}

interface Reports { ownRejections: OwnRejection[]; landedOwnOpIds: string[]; throttle: number; }

/** What the pure fold reports for heights from..to (inclusive) of the honest fold, concatenated like FoldOutcome. */
function expectedReports(s: Shared, from: number, to: number): Reports {
  const ownRejections: OwnRejection[] = [];
  const landedOwnOpIds: string[] = [];
  let throttle = 0;
  for (let h = from; h <= to; h++) {
    const r = foldCommit(s.states[h - 1]!, genDraft(s.gen, s.gen.commits[h]!, LIVE), s.self);
    ownRejections.push(...r.ownRejections);
    landedOwnOpIds.push(...r.landedOwnOpIds);
    throttle += Object.values(s.states[h]!.events).filter((e) => e.height === h && e.kind === 'health' && e.reason_code === 'HOST_THROTTLED').length;
  }
  return { ownRejections, landedOwnOpIds, throttle };
}

/**
 * The honest state at `h` with this peer's last_seq far above every later own seq: folded on its own it rejects
 * this peer's later ops as 'generic' (different own reports) and differs at the next checkpoint (asserted by callers).
 */
function lastSeqCorruption(s: Shared, h: number): FoldState {
  const wrong = structuredClone(s.states[h]!);
  assert.ok(wrong.peers[s.self] !== undefined, `this peer joined before ${h}`);
  wrong.peers[s.self]!.last_seq = 10_000_000;
  return wrong;
}

/** record_count of a hand-edited state (02-protocol §2 "record": in Plan 2, events and ended seats). */
function recount(st: FoldState): number {
  return Object.keys(st.events).length + Object.values(st.seats).filter((x) => x.status === 'ended').length;
}

/**
 * A wrong state at `start` = h − 1 that commit h erases, for the first h in lo..hi where one exists: a seat or
 * event record set in advance to the value commit h gives it, so the own op that sets it folds as a no-op there
 * (a different own report) while the state at h, and so at every later height, is the honest one.
 */
function erasedCorruption(s: Shared, lo: number, hi: number): { start: number; state: FoldState } {
  for (let h = lo; h <= hi; h++) {
    const prev = s.states[h - 1]!;
    const next = s.states[h]!;
    const draft = genDraft(s.gen, s.gen.commits[h]!, LIVE);
    const honest = foldCommit(prev, draft, s.self);
    for (const field of ['seats', 'events'] as const) {
      const before = prev[field] as Record<string, unknown>;
      const now = next[field] as Record<string, unknown>;
      for (const k of Object.keys(now)) {
        if (Object.hasOwn(before, k) && isDeepStrictEqual(before[k], now[k])) continue;
        const wrong = structuredClone(prev);
        (wrong[field] as Record<string, unknown>)[k] = structuredClone(now[k]);
        wrong.record_count = recount(wrong);
        const r = foldCommit(wrong, draft, s.self);
        if (same(r.state, next) && !isDeepStrictEqual(r.landedOwnOpIds, honest.landedOwnOpIds)) {
          assert.ok(parseFold(serializeFold(wrong)) !== null, 'the wrong state is a well-formed fold state');
          return { start: h - 1, state: wrong };
        }
      }
    }
  }
  assert.fail(`the generated board has no erasable own op in heights ${lo}..${hi}`);
}

/** The pure fold from `start` (at height from − 1) over heights from..to, with no checkpoint check: its reports and states. */
function foldRange(s: Shared, start: FoldState, from: number, to: number): Reports & { at: (h: number) => FoldState } {
  const ownRejections: OwnRejection[] = [];
  const landedOwnOpIds: string[] = [];
  const states = new Map<number, FoldState>();
  let cur = start;
  for (let h = from; h <= to; h++) {
    const r = foldCommit(cur, genDraft(s.gen, s.gen.commits[h]!, LIVE), s.self);
    cur = r.state;
    states.set(h, cur);
    ownRejections.push(...r.ownRejections);
    landedOwnOpIds.push(...r.landedOwnOpIds);
  }
  return { ownRejections, landedOwnOpIds, throttle: 0, at: (h) => states.get(h)! };
}

test('a joiner starts at the newest checkpoint at or below the tip and reads at most 255 commits', async () => {
  const s = await setup();
  for (const H of [0, 255, 256, 300, 511, 599]) {
    const c = H - (H % 256);
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self);
    const out = await folder.foldTo(s.A[H]!, null, 'rs-1');
    assert.equal(out.board, s.A[H]);
    assert.ok(same(out.state, s.states[H]!), `tip ${H}: the joiner's state equals the fold from genesis`);
    assert.deepEqual(out.newCommits.map((x) => x.oid), s.A.slice(c + 1, H + 1), `tip ${H}: replays exactly the commits after checkpoint ${c}`);
    assert.ok(out.newCommits.length <= REPLAY_MAX);
    assert.equal(reads(), H - c + 1, `tip ${H}: reads the checkpoint commit and the ${H - c} replayed commits, nothing older`);
    assert.deepEqual(out.version, { proto: false, regionSpec: s.states[H]!.teamRegionSpec !== 'rs-1', checkpointMismatch: false });
    // P2-REFOLD: a trusted start (glossary §24 default 9) is not verified; B0 is, by folding it once from the empty state.
    assert.deepEqual(folder.verification(), { verified: c === 0 ? { board: s.A[0]!, height: 0 } : null, checkpointMismatch: false }, `tip ${H}`);
    if (H > c) {
      const exp = expectedReports(s, c + 1, H);
      assert.deepEqual(out.ownRejections, exp.ownRejections);
      assert.deepEqual(out.landedOwnOpIds, exp.landedOwnOpIds);
      assert.equal(out.throttleEventsFolded, exp.throttle);
    }
  }

  // Incremental from 300 to the tip: every commit after 300 once, and the checkpoint at 512 verifies.
  const { repo, reads, calls } = counting(s.f);
  const folder = new Folder(repo, s.self);
  const out = await folder.foldTo(s.A[N - 1]!, { board: s.A[300]!, state: s.states[300]! }, 'rs-1');
  assert.ok(same(out.state, s.states[N - 1]!));
  assert.equal(out.newCommits.length, N - 1 - 300);
  assert.equal(reads(), N - 1 - 300);
  assert.equal(out.version.checkpointMismatch, false);
  assert.deepEqual(folder.verification(), { verified: { board: s.A[512]!, height: 512 }, checkpointMismatch: false });
  const exp = expectedReports(s, 301, N - 1);
  assert.deepEqual(out.ownRejections, exp.ownRejections);
  assert.deepEqual(out.landedOwnOpIds, exp.landedOwnOpIds);
  assert.equal(out.throttleEventsFolded, exp.throttle);
  assert.ok(exp.landedOwnOpIds.length > 0 && exp.ownRejections.length > 0, 'the generated board exercises both reports');

  // Nothing new: no read, the same state, and no git call at all (this Folder knows the tip's height, so the
  // PRO-25 height check of `from` needs no count).
  const before = calls();
  const again = await folder.foldTo(s.A[N - 1]!, { board: s.A[N - 1]!, state: out.state }, 'rs-1');
  assert.equal(reads(), N - 1 - 300);
  assert.equal(calls(), before, 'nothing new: no git call');
  assert.deepEqual(again.newCommits, []);
  assert.ok(same(again.state, out.state));
  // A fresh Folder (no known height) counts the tip's chain once, and still reads no commit.
  const fresh = counting(s.f);
  const again2 = await new Folder(fresh.repo, s.self).foldTo(s.A[N - 1]!, { board: s.A[N - 1]!, state: out.state }, 'rs-1');
  assert.deepEqual(again2.newCommits, []);
  assert.ok(same(again2.state, out.state));
  assert.equal(fresh.reads(), 0);
  assert.equal(fresh.calls(), 1, 'one first-parent count of the tip');
});

test('a persisted from whose board is unknown, unrelated or off the tip\'s first-parent chain is discarded and the fold starts at the checkpoint', async () => {
  const s = await setup();
  const head = await s.f.repo.resolve('HEAD');
  assert.ok(head !== null);
  const TIP = 520;
  const cases: Array<[string, { board: Oid; state: FoldState }]> = [
    ['an unknown object', { board: '2'.repeat(40) as Oid, state: s.states[515]! }],
    ['a commit that shares no history with the board', { board: head, state: s.states[515]! }],
    ['a board commit off the tip\'s first-parent chain', { board: s.B[515]!, state: s.states[515]! }],
    ['a state whose height does not fit its board', { board: s.A[515]!, state: s.states[514]! }],
    ['the tip itself with a state of a lower height', { board: s.A[TIP]!, state: s.states[515]! }],
    ['the tip itself with a state of a higher height', { board: s.A[TIP]!, state: s.states[530]! }],
  ];
  for (const [what, from] of cases) {
    const { repo, reads } = counting(s.f);
    const out = await new Folder(repo, s.self).foldTo(s.A[TIP]!, from, 'rs-1');
    assert.ok(same(out.state, s.states[TIP]!), what);
    assert.deepEqual(out.newCommits.map((x) => x.oid), s.A.slice(513, TIP + 1), `${what}: PRO-25, the fold starts at checkpoint 512`);
    assert.equal(reads(), TIP - 512 + 1, what);
    assert.equal(out.version.checkpointMismatch, false, what);
  }
});

test('a corrupted incremental state is repaired by one refold; a wrong checkpoint that persists sets checkpointMismatch', async () => {
  const s = await setup();
  const TIP = 520;

  // A persisted incremental state at 300 whose last_seq for this peer is far above every later own seq: folded
  // on its own it rejects this peer's later ops as 'generic' (different own reports) and differs at 512.
  const corrupted = lastSeqCorruption(s, 300);
  const honest = expectedReports(s, 301, TIP);
  const alone = foldRange(s, corrupted, 301, TIP);
  assert.notDeepEqual(alone.ownRejections, honest.ownRejections, 'the corruption changes the own rejections');
  assert.notDeepEqual(alone.landedOwnOpIds, honest.landedOwnOpIds, 'and the own landings');
  assert.ok(!same(alone.at(512), s.states[512]!), 'and the state at checkpoint 512');

  const variants: Array<[string, FoldVerification | null, number]> = [
    // Nothing verified yet: the refold starts at genesis (P2-REFOLD) and reads heights 0..300 (301..512 are cached).
    ['a fresh Folder', null, 301],
    // A verified checkpoint restored after a restart (P2-FOLDPERSIST) is the refold base: checkpoint 256 and 257..300.
    ['a restored verified 256', { verified: { board: s.A[256]!, height: 256 }, checkpointMismatch: false }, 1 + 44],
    // A verified checkpoint on another chain is no refold base (C[256] is not on A's chain; folding from it would match nothing).
    ['a restored verified checkpoint off this chain', { verified: { board: s.C[256]!, height: 256 }, checkpointMismatch: false }, 301],
  ];
  for (const [what, restored, refoldReads] of variants) {
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self, restored);
    const out = await folder.foldTo(s.A[TIP]!, { board: s.A[300]!, state: corrupted }, 'rs-1');
    assert.ok(same(out.state, s.states[TIP]!), `${what}: the refold matched 512 and replaced the corrupted state`);
    assert.equal(out.version.checkpointMismatch, false, what);
    assert.equal(out.newCommits.length, TIP - 300, what);
    assert.equal(reads(), (TIP - 300) + refoldReads, `${what}: one refold`);
    assert.deepEqual(out.ownRejections, honest.ownRejections, `${what}: reports of the refolded range come from the refold`);
    assert.deepEqual(out.landedOwnOpIds, honest.landedOwnOpIds, what);
    assert.deepEqual(folder.verification(), { verified: { board: s.A[512]!, height: 512 }, checkpointMismatch: false }, what);
  }
  {
    // The same corrupted state on board B, whose checkpoint 512 is wrong: the refold from the verified 256 still
    // differs from 512 (the flag), and its state — this peer's fold from a verified base — replaces the corrupted one.
    const folder = new Folder(s.f.repo, s.self, { verified: { board: s.B[256]!, height: 256 }, checkpointMismatch: false });
    const out = await folder.foldTo(s.B[TIP]!, { board: s.B[300]!, state: corrupted }, 'rs-1');
    assert.equal(out.version.checkpointMismatch, true);
    assert.ok(same(out.state, s.states[TIP]!), 'the refolded state replaces the corrupted one even though 512 still differs');
    assert.deepEqual(out.ownRejections, honest.ownRejections);
    assert.deepEqual(out.landedOwnOpIds, honest.landedOwnOpIds);
    assert.deepEqual(folder.verification(), { verified: { board: s.B[256]!, height: 256 }, checkpointMismatch: true });
  }

  // A wrong checkpoint at 512 (board B): the refold from genesis differs from it too (R-13).
  const repo = s.f.repo;
  const folder = new Folder(repo, s.self);
  const mid = await folder.foldTo(s.B[300]!, null, 'rs-1');
  assert.ok(same(mid.state, s.states[300]!));
  assert.deepEqual(folder.verification(), { verified: null, checkpointMismatch: false }, 'the joiner\'s trusted checkpoint 256 is not verified');
  const bad = await folder.foldTo(s.B[TIP]!, { board: s.B[300]!, state: mid.state }, 'rs-1');
  assert.equal(bad.version.checkpointMismatch, true);
  assert.ok(same(bad.state, s.states[TIP]!), 'folding continues with this peer\'s own (refolded) state');
  assert.deepEqual(folder.verification(), { verified: { board: s.B[256]!, height: 256 }, checkpointMismatch: true }, 'the genesis refold byte-verified 0 and 256 on its way');
  // The flag stays while later calls fold new, non-checkpoint commits after 512…
  const more = await folder.foldTo(s.B[550]!, { board: s.B[TIP]!, state: bad.state }, 'rs-1');
  assert.equal(more.newCommits.length, 550 - TIP);
  assert.equal(more.version.checkpointMismatch, true, 'B[520] → B[550]');
  const most = await folder.foldTo(s.B[N - 1]!, { board: s.B[550]!, state: more.state }, 'rs-1');
  assert.equal(most.newCommits.length, N - 1 - 550);
  assert.equal(most.version.checkpointMismatch, true, 'B[550] → B[599]');
  assert.ok(same(most.state, s.states[N - 1]!));
  // …and on a call that folds nothing.
  const still = await folder.foldTo(s.B[N - 1]!, { board: s.B[N - 1]!, state: most.state }, 'rs-1');
  assert.equal(still.version.checkpointMismatch, true);

  // A restart (P2-FOLDPERSIST): the exported verdict restored into a new Folder keeps the pause while it folds
  // more non-checkpoint commits; without it the flag would read false after the restart.
  const exported = folder.verification();
  const restarted = new Folder(repo, s.self, exported);
  assert.deepEqual(restarted.verification(), exported);
  const after1 = await restarted.foldTo(s.B[N - 1]!, { board: s.B[550]!, state: more.state }, 'rs-1');
  assert.equal(after1.newCommits.length, N - 1 - 550);
  assert.equal(after1.version.checkpointMismatch, true, 'the restored flag survives non-checkpoint commits');
  const unrestored = await new Folder(repo, s.self).foldTo(s.B[N - 1]!, { board: s.B[550]!, state: more.state }, 'rs-1');
  assert.equal(unrestored.version.checkpointMismatch, false, 'contrast: a Folder without the restored verdict');
  // A later checkpoint that matches this peer's fold lifts it.
  const healed = await restarted.foldTo(s.A[N - 1]!, { board: s.A[500]!, state: s.states[500]! }, 'rs-1');
  assert.equal(healed.version.checkpointMismatch, false);
  assert.deepEqual(restarted.verification(), { verified: { board: s.A[512]!, height: 512 }, checkpointMismatch: false });
  // A restored verdict that is not well formed keeps only its flag.
  assert.deepEqual(
    new Folder(repo, s.self, { verified: { board: 'nope' as Oid, height: 7 }, checkpointMismatch: true }).verification(),
    { verified: null, checkpointMismatch: true },
  );
  assert.deepEqual(new Folder(repo, s.self, { verified: { board: s.A[300]!, height: 300 }, checkpointMismatch: false }).verification().verified, null, 'not a checkpoint height');

  // A joiner trusts the nearest checkpoint (glossary §24 default 9), the wrong one included, until PRO-28 detects it.
  const joiner = await new Folder(repo, s.self).foldTo(s.B[N - 1]!, null, 'rs-1');
  assert.ok(joiner.state.events[FAKE_512] !== undefined);
  assert.equal(joiner.version.checkpointMismatch, false);
});

test('a refold starts only from a checkpoint this Folder verified: self-consistent wrong checkpoints at 256 and 512 set checkpointMismatch and keep the honest state', async () => {
  const s = await setup();
  assert.equal(s.C[200], s.A[200]);
  const { repo, reads } = counting(s.f);
  const folder = new Folder(repo, s.self);
  const out = await folder.foldTo(s.C[N - 1]!, { board: s.C[200]!, state: s.states[200]! }, 'rs-1');
  // 256 differs → refold from genesis (nothing verified yet; B0 byte-matches on the way) → still differs → flag.
  // 512 differs → refold from B0, the newest verified checkpoint, never from the board's (wrong) 256 → flag stays.
  assert.equal(out.version.checkpointMismatch, true);
  assert.ok(same(out.state, s.states[N - 1]!), 'the state is the honest fold, not the wrong lineage');
  assert.equal(out.state.events[FAKE_256], undefined);
  assert.deepEqual(folder.verification(), { verified: { board: s.C[0]!, height: 0 }, checkpointMismatch: true }, 'only B0 byte-matched');
  assert.equal(reads(), (N - 1 - 200) + 201, 'the refold at 256 reads heights 0..200; the one at 512 reads nothing new');
  const exp = expectedReports(s, 201, N - 1);
  assert.deepEqual(out.ownRejections, exp.ownRejections);
  assert.deepEqual(out.landedOwnOpIds, exp.landedOwnOpIds);
});

test('a verified checkpoint at the checked height itself is no refold base: the refold starts at genesis and recomputes every own report of the call', async () => {
  const s = await setup();
  const TIP = 520;

  // (a) The only verified checkpoint is the checked one itself (A[512], restored): "refolding" from it would fold
  // nothing and keep the corrupted reports of 301..512. The refold starts at genesis instead.
  {
    const corrupted = lastSeqCorruption(s, 300);
    const honest = expectedReports(s, 301, TIP);
    const alone = foldRange(s, corrupted, 301, TIP);
    assert.ok(!same(alone.at(512), s.states[512]!), 'precondition: the corruption makes 512 differ');
    assert.notDeepEqual(alone.ownRejections, honest.ownRejections, 'precondition: and changes the own reports');
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self, { verified: { board: s.A[512]!, height: 512 }, checkpointMismatch: false });
    const out = await folder.foldTo(s.A[TIP]!, { board: s.A[300]!, state: corrupted }, 'rs-1');
    assert.deepEqual(out.ownRejections, honest.ownRejections, '(a) the reports of 301..512 come from the refold');
    assert.deepEqual(out.landedOwnOpIds, honest.landedOwnOpIds, '(a)');
    assert.ok(same(out.state, s.states[TIP]!), '(a)');
    assert.equal(out.version.checkpointMismatch, false, '(a)');
    assert.equal(reads(), (TIP - 300) + 301, '(a) the refold starts at genesis and reads heights 0..300');
    assert.deepEqual(folder.verification(), { verified: { board: s.A[512]!, height: 512 }, checkpointMismatch: false }, '(a)');
  }
});

test('a checkpoint verified above the height the call started from is no refold base: the refold starts at genesis and recomputes every own report of the call', async () => {
  const s = await setup();
  const TIP = 520;

  // (b) Board B (wrong 512), from a wrong state at `start` < 256 that commit start + 1 erases: 256 matches in this
  // call and becomes the verified checkpoint, 512 differs, and a refold from 256 would keep the wrong reports of
  // start + 1..256. A verified checkpoint above the call's start is no base: the refold starts at genesis.
  {
    const { start, state: wrong } = erasedCorruption(s, 201, 255);
    const honest = expectedReports(s, start + 1, TIP);
    const alone = foldRange(s, wrong, start + 1, TIP);
    assert.ok(same(alone.at(256), s.states[256]!), `precondition: the corruption at ${start} is gone by 256, so 256 matches`);
    assert.notDeepEqual(alone.landedOwnOpIds, honest.landedOwnOpIds, 'precondition: it changed an own report before 256');
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self);
    const out = await folder.foldTo(s.B[TIP]!, { board: s.B[start]!, state: wrong }, 'rs-1');
    assert.deepEqual(out.ownRejections, honest.ownRejections, `(b) start ${start}: the reports of ${start + 1}..256 come from the refold`);
    assert.deepEqual(out.landedOwnOpIds, honest.landedOwnOpIds, `(b) start ${start}`);
    assert.ok(same(out.state, s.states[TIP]!), '(b)');
    assert.equal(out.version.checkpointMismatch, true, '(b) 512 still differs (R-13)');
    assert.equal(reads(), (TIP - start) + (start + 1), `(b) the refold at 512 starts at genesis and reads heights 0..${start}`);
    assert.deepEqual(folder.verification(), { verified: { board: s.B[256]!, height: 256 }, checkpointMismatch: true }, '(b)');
  }
});

test('the verified refold base is the Folder\'s own copy: a caller that mutates the state a call ending at a matching checkpoint returned does not change a later refold', async () => {
  const s = await setup();

  // A call that ends at a matching checkpoint returns the state it verified (256, in the main loop).
  {
    const corrupted = lastSeqCorruption(s, 300);
    assert.ok(!same(foldRange(s, corrupted, 301, 512).at(512), s.states[512]!), 'precondition: the corruption makes 512 differ');
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self);
    const first = await folder.foldTo(s.A[256]!, { board: s.A[200]!, state: s.states[200]! }, 'rs-1');
    assert.deepEqual(folder.verification(), { verified: { board: s.A[256]!, height: 256 }, checkpointMismatch: false });
    first.state.peers[s.self]!.last_seq = 10_000_000;   // the caller edits the state it was handed
    assert.ok(!same(foldRange(s, lastSeqCorruption(s, 256), 257, 512).at(512), s.states[512]!), 'precondition: a refold from the edited 256 would differ at 512');
    const before = reads();
    const out = await folder.foldTo(s.A[520]!, { board: s.A[300]!, state: corrupted }, 'rs-1');
    assert.equal(out.version.checkpointMismatch, false, 'the refold from the verified 256 matched 512');
    assert.ok(same(out.state, s.states[520]!), 'the refold base is the state 256 verified, not the caller\'s edited object');
    const exp = expectedReports(s, 301, 520);
    assert.deepEqual(out.ownRejections, exp.ownRejections);
    assert.deepEqual(out.landedOwnOpIds, exp.landedOwnOpIds);
    assert.equal(reads() - before, 220 + 44, 'one refold from 256: heights 257..300 are the only new reads');
  }
});

test('the verified refold base is the Folder\'s own copy: a caller that mutates the B0 state a joiner at tip 0 returned does not change a later refold', async () => {
  const s = await setup();

  // A joiner at tip 0 returns the state of B0 it verified by folding it from the empty state.
  {
    const corrupted = lastSeqCorruption(s, 200);
    assert.ok(!same(foldRange(s, corrupted, 201, 256).at(256), s.states[256]!), 'precondition: the corruption makes 256 differ');
    const { repo, reads } = counting(s.f);
    const folder = new Folder(repo, s.self);
    const first = await folder.foldTo(s.A[0]!, null, 'rs-1');
    assert.deepEqual(folder.verification(), { verified: { board: s.A[0]!, height: 0 }, checkpointMismatch: false });
    const genesisPeer = s.gen.peers[0]!;
    first.state.peers[genesisPeer]!.status = 'left';   // the caller edits the state it was handed
    const edited = structuredClone(s.states[0]!);
    edited.peers[genesisPeer]!.status = 'left';
    assert.ok(!same(foldRange(s, edited, 1, 256).at(256), s.states[256]!), 'precondition: a refold from the edited B0 state would differ at 256');
    const before = reads();
    const out = await folder.foldTo(s.A[256]!, { board: s.A[200]!, state: corrupted }, 'rs-1');
    assert.equal(out.version.checkpointMismatch, false, 'the refold from the verified B0 matched 256');
    assert.ok(same(out.state, s.states[256]!), 'the refold base is the state B0 verified, not the caller\'s edited object');
    const exp = expectedReports(s, 201, 256);
    assert.deepEqual(out.ownRejections, exp.ownRejections);
    assert.deepEqual(out.landedOwnOpIds, exp.landedOwnOpIds);
    assert.equal(reads() - before, 56 + 200, 'one refold from B0: heights 1..200 are the only new reads');
  }
});

test('a protocol.json with proto 2 sets version.proto while folding continues', async () => {
  const s = await setup();
  const repo = s.f.repo;
  const peer = 'a1'.repeat(16);
  const epoch = 'b2'.repeat(16);
  const id = (seq: number): string => `${peer}/${epoch}/${seq}`;
  const op = (o: Record<string, Json>): Op => {
    const parsed = parseOpLine(JSON.stringify(o));
    assert.ok(parsed !== null);
    return parsed;
  };
  const join = op({
    id: id(1), type: 'join', display: 'Next', plugin_version: '9.0.0', plugin_sha: 'e'.repeat(64), proto: 2, regionSpec: 'rs-9',
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.50.0' }, coauthor_optin: false,
  });
  const caps = op({ id: id(2), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true });
  const event = op({ id: id(4), type: 'event', cid: eventCid(id(4), 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' });
  const seat = op({ id: id(5), type: 'seat_start', seat_id: 'c3'.repeat(16), permission_mode: 'default' });

  const head = await repo.resolve('HEAD');
  assert.ok(head !== null);
  const tree = (await repo.readCommit(head)).tree;

  for (const proto of [2, 1]) {
    const protocol: ProtocolJson = { ...genesisProtocol(12, 'rs-9'), proto };
    const w0: WriterId = { peer, epoch, seq: 3 };
    const L0 = await repo.commitTree({ tree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(w0, [], [], new Map(), head) });
    const d0: BoardDraft = { liveCode: L0, writer: w0, cs: [], protocol, opsLines: [join, caps].map((o) => JSON.stringify(o)), checkpoint: null, heldIds: [] };
    const s0 = foldCommit(initialFoldState(protocol), d0, peer);
    assert.equal(s0.protoMismatch, proto !== 1);
    const B0 = await buildBoardCommit(repo, { prevBoard: null, liveCode: L0, writer: w0, ops: [join, caps], cs: [], csPaths: new Map(), protocol, checkpoint: serializeFold(s0.state) });
    const B1 = await buildBoardCommit(repo, { prevBoard: B0, liveCode: L0, writer: { peer, epoch, seq: 6 }, ops: [event, seat], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });

    for (const from of [null, { board: B0, state: s0.state }]) {
      const out = await new Folder(repo, peer).foldTo(B1, from, 'rs-9');
      assert.deepEqual(out.version, { proto: proto !== 1, regionSpec: false, checkpointMismatch: false }, `proto ${proto}, from ${from === null ? 'null' : 'B0'}`);
      assert.equal(out.state.proto, proto);
      assert.equal(out.state.height, 1);
      assert.ok(out.state.events[eventCid(id(4), 'freeze')] !== undefined, 'ops still fold under the proto pause');
      assert.equal(out.state.seats[`${peer}/${epoch}/${'c3'.repeat(16)}`]?.status, 'live');
      assert.deepEqual(out.landedOwnOpIds, [id(4), id(5)]);
    }
  }
});
