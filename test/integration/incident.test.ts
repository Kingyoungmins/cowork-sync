import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BATCH_READ_MAX_BYTES, BOARD_COMMIT_OBJECT_MAX_BYTES, BOARD_SUBJECT, boardTrailers, CODE_SUBJECT, liveCommitTrailers, type WriterId } from '../../src/board/boardCommit.js';
import { newEpoch, newPeerId } from '../../src/board/ids.js';
import { OPS_MAX_BYTES } from '../../src/board/ops.js';
import { ABSENT, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { GitCommandError, GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { formatMessage } from '../../src/git/trailers.js';
import { seededRandom } from '../../src/ports/random.js';
import type { MutantId } from '../../src/engine/deps.js';
import { fpOk, incidentCheck, liveBase, type IncidentVerdict, type IncidentWhy } from '../../src/engine/incident.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const NONE: ReadonlySet<MutantId> = new Set();
const M07: ReadonlySet<MutantId> = new Set(['M07']);

/** A GitRepo on the fixture clone whose runner records every argv. */
function recording(f: RepoFixture): { repo: GitRepo; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = {
    run(args, opts) {
      calls.push([...args]);
      return f.runner.run(args, opts);
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), calls };
}

interface Maker { f: RepoFixture; hr: Oid; hrTree: Oid; empty: Oid; boardTree: Oid; w(): WriterId; }
/** checkpoint/state.json: the one board entry a reader refuses to miss (final review FA-2, entry_missing). */
const CHECKPOINT_FILE = 'M 100644 inline checkpoint/state.json\n';
const CHECKPOINT_BYTES = Buffer.from('{}', 'utf8');
async function maker(label: string): Promise<Maker> {
  const f = await makeRepoFixture(label);
  const r = seededRandom(label);
  const peer = newPeerId(r);
  const epoch = newEpoch(r);
  let seq = 0;
  const hr = await f.repo.resolve('HEAD');
  assert.ok(hr !== null);
  const state = await f.repo.mktree([{ name: 'state.json', mode: '100644', type: 'blob', oid: await f.repo.hashBytes(CHECKPOINT_BYTES, true) }]);
  const boardTree = await f.repo.mktree([{ name: 'checkpoint', mode: '040000', type: 'tree', oid: state }]);
  return { f, hr, hrTree: (await f.repo.readCommit(hr)).tree, empty: await f.repo.emptyTree(), boardTree, w: () => ({ peer, epoch, seq: ++seq }) };
}
/** A live code commit (glossary §5 markers); `base` adds Cowork-Base (genesis, base move). Each gets a fresh writer seq, so oids differ. */
function live(m: Maker, parents: Oid[], base: Oid | null = null, subject = CODE_SUBJECT): Promise<Oid> {
  return m.f.repo.commitTree({ tree: m.hrTree, parents, subject, trailers: liveCommitTrailers(m.w(), ['human'], [], new Map(), base) });
}
/**
 * A board commit [prev, live] (or [L0]); unless given, the tree holds only checkpoint/state.json (readBoardCommit reads a
 * missing ops.jsonl or protocol.json as absent, but refuses a missing checkpoint: entry_missing).
 */
function board(m: Maker, parents: Oid[], opts: { subject?: string; tree?: Oid } = {}): Promise<Oid> {
  return m.f.repo.commitTree({ tree: opts.tree ?? m.boardTree, parents, subject: opts.subject ?? BOARD_SUBJECT, trailers: boardTrailers(m.w(), [], new Map()) });
}

/** Every scenario of the check over one honest chain L0/B0 … B4 and its corruptions. */
interface Scenarios { m: Maker; ok: Array<[Oid, Oid, OidOrAbsent]>; bad: Array<{ name: string; laB: Oid; laC: Oid; T: OidOrAbsent; want: IncidentVerdict }>; }
async function scenarios(label: string): Promise<Scenarios> {
  const m = await maker(label);
  const L0 = await live(m, [], m.hr);
  const B0 = await board(m, [L0]);
  const L1 = await live(m, [L0]);
  const B1 = await board(m, [B0, L1]);
  const L2 = await live(m, [L1]);
  const B2 = await board(m, [B1, L2]);
  const B3 = await board(m, [B2, L2]);                       // board-only: repeats the last parent
  const X = await commitFiles(m.f, { 'x.txt': 'branch\n' });
  const Lbm = await live(m, [L2, X], X);                      // base move
  const B4 = await board(m, [B3, Lbm]);
  const L5 = await live(m, [Lbm]);
  const B5 = await board(m, [B4, L5]);                       // after a base-move publish LA_C stays L2 (ENG-44): live_code(LA_B) != LA_C
  // Corruptions.
  const B1x = await board(m, [B0, L1]);                       // a rewrite of B1
  const Bm = await board(m, [B1x, B2]);                       // a rewrite keeping the old board chain as second parent
  const B5r = await board(m, [B2, L1]);                       // the live code rewound
  const Lroot = await live(m, [], m.hr);                      // an unrelated genesis-shaped root
  const B5u = await board(m, [B2, Lroot]);
  const L3 = await live(m, [L2]);
  const L4 = await live(m, [L3]);
  const Bplain = await board(m, [B2, L3], { subject: 'plain board' });
  const B3p = await board(m, [B2, X, L3]);
  const big = await m.f.repo.hashBytes(Buffer.alloc(OPS_MAX_BYTES + 1, 0x61), true);
  const bigTree = await m.f.repo.mktree([{ name: 'ops.jsonl', mode: '100644', type: 'blob', oid: big }]);
  const Bbig = await board(m, [B2, L3], { tree: bigTree });   // ops.jsonl over 64 KiB: BoardMalformedError
  const Bnext = await board(m, [Bbig, L3]);
  const Bj = await board(m, [B2, L4]);                        // the last parent jumps over L3
  const Bj2 = await board(m, [Bj, L4]);
  const Lu = await live(m, [L2], null, 'plain live');
  const Bu = await board(m, [B2, Lu]);
  const Lb = await live(m, [L2], m.hr);                       // an ordinary step with a Cowork-Base
  const Bb = await board(m, [B2, Lb]);
  const fail = (why: IncidentWhy, observedBoard: Oid | null, observedCode: Oid | null): IncidentVerdict => ({ ok: false, why, observedBoard, observedCode });
  return {
    m,
    ok: [[B0, L0, B4], [B2, L2, B4], [B2, L2, B3], [B4, Lbm, B4], [B0, L0, B0], [B4, L2, B5], [B4, L2, B4]],
    bad: [
      { name: 'board missing', laB: B2, laC: L2, T: ABSENT, want: fail('board_missing', null, null) },
      { name: 'board rewound', laB: B2, laC: L2, T: B1, want: fail('board_not_ff', B1, L1) },
      { name: 'board rewritten', laB: B1, laC: L1, T: B1x, want: fail('board_not_ff', B1x, L1) },
      { name: 'rewrite keeping the old chain as second parent', laB: B2, laC: L2, T: Bm, want: fail('board_not_ff', Bm, B2) },
      { name: 'live code rewound', laB: B2, laC: L2, T: B5r, want: fail('code_not_ff', B5r, L1) },
      { name: 'live code from an unrelated root', laB: B2, laC: L2, T: B5u, want: fail('code_not_ff', B5u, Lroot) },
      { name: 'board commit without markers', laB: B2, laC: L2, T: Bplain, want: fail('board_shape', Bplain, L3) },
      { name: 'board commit with three parents', laB: B2, laC: L2, T: B3p, want: fail('board_shape', B3p, L3) },
      { name: 'malformed board commit below the tip', laB: B2, laC: L2, T: Bnext, want: fail('board_shape', Bnext, L3) },
      { name: 'malformed board tip', laB: B2, laC: L2, T: Bbig, want: fail('board_shape', Bbig, null) },
      { name: 'board tip that is a tree', laB: B2, laC: L2, T: m.empty, want: fail('board_shape', m.empty, null) },
      { name: 'last parent jumps', laB: B2, laC: L2, T: Bj, want: fail('live_shape', Bj, L4) },
      { name: 'a jump below a board-only tip', laB: B2, laC: L2, T: Bj2, want: fail('live_shape', Bj2, L4) },
      { name: 'live commit without markers', laB: B2, laC: L2, T: Bu, want: fail('live_shape', Bu, Lu) },
      { name: 'ordinary step with a Cowork-Base', laB: B2, laC: L2, T: Bb, want: fail('live_shape', Bb, Lb) },
    ],
  };
}

test('fpOk: equal and fast-forward pass; a rewind, a rewrite keeping the old chain as second parent and an unrelated root fail', async () => {
  const f = await makeRepoFixture('incident-fpok');
  try {
    const { repo } = f;
    const A = await commitFiles(f, { 'a.txt': 'a\n' });
    const B = await commitFiles(f, { 'a.txt': 'b\n' }, A);
    const C = await commitFiles(f, { 'a.txt': 'c\n' }, B);
    const X = await commitFiles(f, { 'a.txt': 'x\n' }, A);
    const tree = (await repo.readCommit(C)).tree;
    const rewrite = await repo.commitTree({ tree, parents: [X, C], subject: 'rewrite', trailers: [] });
    const pull = await repo.commitTree({ tree, parents: [C, X], subject: 'merge keeping C first', trailers: [] });
    const R = await commitFiles(f, { 'r.txt': 'root\n' });
    const R2 = await commitFiles(f, { 'r.txt': 'root 2\n' }, R);
    assert.equal(await fpOk(repo, A, A), true);
    assert.equal(await fpOk(repo, A, C), true);
    assert.equal(await fpOk(repo, B, C), true);
    assert.equal(await fpOk(repo, C, pull), true, 'old as first parent of a merge is on the chain');
    assert.equal(await fpOk(repo, C, A), false, 'rewind');
    assert.equal(await fpOk(repo, B, X), false, 'sibling rewrite');
    assert.equal(await fpOk(repo, C, rewrite), false, 'old kept only as a second parent');
    assert.equal(await repo.isAncestor(C, rewrite), true, 'a bare ancestry test would have passed it (INV-FIRSTPARENT)');
    assert.equal(await fpOk(repo, C, R), false, 'unrelated root');
    assert.equal(await fpOk(repo, C, R2), false, 'unrelated chain');
    await assert.rejects(async () => fpOk(repo, '' as Oid, C));
  } finally {
    await f.cleanup();
  }
});

test('incidentCheck reports board_missing, board_not_ff, code_not_ff, board_shape and a last parent that jumps', async () => {
  const s = await scenarios('incident-check');
  try {
    const { repo } = s.m.f;
    for (const [laB, laC, T] of s.ok) assert.deepEqual(await incidentCheck(repo, laB, laC, T, NONE), { ok: true }, `${laB}..${T}`);
    for (const b of s.bad) assert.deepEqual(await incidentCheck(repo, b.laB, b.laC, b.T, NONE), b.want, b.name);
    // A missing local object is this clone's problem, not a teammate's malformed board: it throws, never a verdict.
    await assert.rejects(async () => incidentCheck(repo, s.ok[0]![0], s.ok[0]![1], parseOid('e'.repeat(40)), NONE), /missing/);
  } finally {
    await s.m.f.cleanup();
  }
});

test('a corrupted mirror changes no verdict; the mirror and displaced refs are never read', async () => {
  const s = await scenarios('incident-mirror');
  try {
    const { f } = s.m;
    const rec = recording(f);
    const all = [...s.ok.map(([laB, laC, T]) => ({ laB, laC, T })), ...s.bad];
    const verdicts = async (): Promise<IncidentVerdict[]> => {
      const out: IncidentVerdict[] = [];
      for (const c of all) out.push(await incidentCheck(rec.repo, c.laB, c.laC, c.T, NONE));
      return out;
    };
    const [laB, laC] = s.ok[1]!;
    await f.repo.run(['update-ref', 'refs/cowork-remote/main/code', laC]);
    await f.repo.run(['update-ref', 'refs/cowork-remote/main/displaced/0123456789ab', laB]);
    const honest = await verdicts();
    // Corrupt the fetched mirror and the displaced copy: point them at an unrelated root and a malformed board.
    const bad = s.bad.find((b) => b.name === 'live code from an unrelated root')!;
    await f.repo.run(['update-ref', 'refs/cowork-remote/main/code', bad.want.ok ? laC : bad.want.observedCode!]);
    await f.repo.run(['update-ref', 'refs/cowork-remote/main/displaced/0123456789ab', s.bad.find((b) => b.name === 'board commit without markers')!.T as Oid]);
    assert.deepEqual(await verdicts(), honest);
    // Delete them: identical verdicts again (01-engine test 19, check part).
    await f.repo.run(['update-ref', '-d', 'refs/cowork-remote/main/code']);
    await f.repo.run(['update-ref', '-d', 'refs/cowork-remote/main/displaced/0123456789ab']);
    assert.deepEqual(await verdicts(), honest);
    assert.deepEqual(honest.slice(s.ok.length), s.bad.map((b) => b.want));
    // incidentCheck takes oids only: no git call it makes names a ref (the mirror, displaced refs or any other).
    assert.ok(rec.calls.length > 0);
    for (const argv of rec.calls) assert.ok(!argv.some((a) => a.includes('refs/')), argv.join(' '));
  } finally {
    await s.m.f.cleanup();
  }
});

test('mutant M07 makes incidentCheck always ok', async () => {
  const s = await scenarios('incident-m07');
  try {
    const { repo } = s.m.f;
    for (const b of s.bad) {
      assert.equal((await incidentCheck(repo, b.laB, b.laC, b.T, NONE)).ok, false, b.name);
      assert.deepEqual(await incidentCheck(repo, b.laB, b.laC, b.T, M07), { ok: true }, b.name);
    }
    for (const [laB, laC, T] of s.ok) assert.deepEqual(await incidentCheck(repo, laB, laC, T, M07), { ok: true });
    // Only M07 switches the check off.
    const others: ReadonlySet<MutantId> = new Set(['M05', 'M06', 'M12', 'M17', 'M18', 'M20']);
    for (const b of s.bad) assert.deepEqual(await incidentCheck(repo, b.laB, b.laC, b.T, others), b.want, b.name);
  } finally {
    await s.m.f.cleanup();
  }
});

/** n live commits on `ref` in one fast-import: L0 with Cowork-Base: base, then ordinary children; returns them oldest first. */
async function importLive(m: Maker, ref: string, base: Oid, n: number): Promise<Oid[]> {
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  const data = (b: Buffer): void => { parts.push(Buffer.from(`data ${b.length}\n`, 'utf8'), b, Buffer.from('\n', 'utf8')); };
  for (let i = 0; i < n; i++) {
    text(`commit ${ref}\nmark :${i + 1}\nauthor Fixture <f@cowork.invalid> 1700000000 +0000\ncommitter Fixture <f@cowork.invalid> 1700000000 +0000\n`);
    data(formatMessage(CODE_SUBJECT, liveCommitTrailers(m.w(), ['human'], [], new Map(), i === 0 ? base : null)));
    if (i === 0) {
      text('deleteall\nM 100644 inline README.md\n');
      data(Buffer.from('# live\n', 'utf8'));
    } else {
      text(`from :${i}\n`);
    }
  }
  text('done\n');
  await m.f.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const list = await m.f.repo.run(['rev-list', '--first-parent', '--reverse', ref]);
  const oids = list.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  assert.equal(oids.length, n);
  return oids;
}

/**
 * A live commit whose message carries `Cowork-Base: <x>` in a body paragraph, not in its trailer paragraph: for
 * liveShape (and git's trailer rules) it carries no Cowork-Base, so it is an ordinary step; `--grep` still matches it.
 */
async function decoyLive(m: Maker, parent: Oid, x: Oid): Promise<Oid> {
  const text = formatMessage(CODE_SUBJECT, liveCommitTrailers(m.w(), ['human'], [], new Map(), null)).toString('utf8');
  const cut = text.indexOf('\n\n');
  const message = Buffer.from(`${text.slice(0, cut)}\n\nCowork-Base: ${x}\n${text.slice(cut)}`, 'utf8');
  const r = await m.f.repo.run(['commit-tree', m.hrTree, '-p', parent], { class: 'refupdate', identity: fixtureContext().identity, wallMsForDates: fixtureContext().wallMs(), stdin: message });
  return parseOid(r.stdout.toString('utf8'));
}

test('a Cowork-Base line outside the trailer paragraph is no base: the incident check passes the commit and liveBase skips it, in one git call', async () => {
  const m = await maker('incident-decoy');
  try {
    const X = await commitFiles(m.f, { 'x.txt': 'branch\n' });
    const L0 = await live(m, [], m.hr);
    const B0 = await board(m, [L0]);
    const decoy = await decoyLive(m, L0, X);
    const B1 = await board(m, [B0, decoy]);
    const L2 = await live(m, [decoy]);
    const B2 = await board(m, [B1, L2]);
    assert.match((await m.f.repo.run(['cat-file', 'commit', decoy])).stdout.toString('utf8'), new RegExp(`\n\nCowork-Base: ${X}\n\n`));
    assert.deepEqual((await m.f.repo.readCommit(decoy)).trailers.filter((t) => t.key === 'Cowork-Base'), [], 'not a trailer');
    assert.deepEqual(await incidentCheck(m.f.repo, B0, L0, B2, NONE), { ok: true }, 'an ordinary live step for the incident check');
    // The whole-chain walk (a repo with no earlier answer) skips the decoy, from above it and from the decoy itself.
    for (const L of [L2, decoy]) {
      const rec = recording(m.f);
      assert.deepEqual(await liveBase(rec.repo, L), { base: m.hr, introducedBy: L0 });
      assert.equal(rec.calls.length, 1, 'one git call per lookup');
    }
    // The incremental walk (the last answer was L0's) skips it too: decoy and L2 are the new commits.
    const inc = recording(m.f);
    assert.deepEqual(await liveBase(inc.repo, L0), { base: m.hr, introducedBy: L0 });
    assert.deepEqual(await liveBase(inc.repo, L2), { base: m.hr, introducedBy: L0 });
    assert.equal(inc.calls.length, 2, 'one git call per lookup');
    assert.ok(inc.calls[1]!.includes(`^${L0}`), 'the second lookup reads L0..L2 only');
    // A real base move above the decoy still wins.
    const Lbm = await live(m, [L2, X], X);
    assert.deepEqual(await liveBase(m.f.repo, await live(m, [Lbm])), { base: X, introducedBy: Lbm });
  } finally {
    await m.f.cleanup();
  }
});

/**
 * A board chain B0 … Bn over a live chain in one fast-import: B0 = [L0] (L0 genesis, Cowork-Base: hr), then
 * B_i = [B_{i-1}, L_i] with L_i an ordinary step, except every 7th board commit, which is board-only (repeats the
 * last parent). Board trees are empty. Returns, oldest first, every board commit and its live code commit.
 * `bodyBytes` > 0 puts a body paragraph of that many bytes between each board commit's subject and its trailers.
 */
async function importBoard(m: Maker, n: number, bodyBytes = 0): Promise<{ boards: Oid[]; lives: Oid[] }> {
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  const data = (b: Buffer): void => { parts.push(Buffer.from(`data ${b.length}\n`, 'utf8'), b, Buffer.from('\n', 'utf8')); };
  const who = 'author Fixture <f@cowork.invalid> 1700000000 +0000\ncommitter Fixture <f@cowork.invalid> 1700000000 +0000\n';
  let mark = 0;
  let liveMark = 0;
  let boardMark = 0;
  for (let i = 0; i <= n; i++) {
    if (i === 0 || i % 7 !== 0) {
      mark += 1;
      text(`commit refs/test/live\nmark :${mark}\n${who}`);
      data(formatMessage(CODE_SUBJECT, liveCommitTrailers(m.w(), ['human'], [], new Map(), i === 0 ? m.hr : null)));
      if (i === 0) {
        text('deleteall\nM 100644 inline README.md\n');
        data(Buffer.from('# live\n', 'utf8'));
      } else {
        text(`from :${liveMark}\n`);
      }
      liveMark = mark;
    }
    mark += 1;
    text(`commit refs/test/board\nmark :${mark}\n${who}`);
    const message = formatMessage(BOARD_SUBJECT, boardTrailers(m.w(), [], new Map()));
    if (bodyBytes === 0) {
      data(message);
    } else {
      const cut = message.indexOf('\n\n');
      data(Buffer.concat([message.subarray(0, cut), Buffer.from('\n\n', 'utf8'), Buffer.alloc(bodyBytes, 0x62), message.subarray(cut)]));
    }
    text(i === 0 ? `from :${liveMark}\ndeleteall\n` : `from :${boardMark}\nmerge :${liveMark}\n`);
    if (i === 0) {
      // B0 writes checkpoint/state.json; every later board commit carries it (fast-import starts from the parent's tree).
      text(CHECKPOINT_FILE);
      data(CHECKPOINT_BYTES);
    }
    boardMark = mark;
  }
  text('done\n');
  await m.f.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const list = await m.f.repo.run(['rev-list', '--first-parent', '--reverse', '--no-commit-header', '--format=%H %P', 'refs/test/board']);
  const boards: Oid[] = [];
  const lives: Oid[] = [];
  for (const line of list.stdout.toString('utf8').split('\n').filter((l) => l.length > 0)) {
    const [h, ...ps] = line.split(' ').filter((w) => w.length > 0);
    if (ps.length === 0) continue;                             // L0, B0's only parent, ends the first-parent chain
    boards.push(parseOid(h!));
    lives.push(parseOid(ps[ps.length - 1]!));
  }
  assert.equal(boards.length, n + 1);
  return { boards, lives };
}

test('the incident check of a 300-commit range takes as few git calls as a 30-commit range, and an unchanged range takes none', async () => {
  const m = await maker('incident-batch');
  try {
    const { boards, lives } = await importBoard(m, 300);
    const rec = recording(m.f);
    const calls = async (from: number, to: number): Promise<number> => {
      const before = rec.calls.length;
      assert.deepEqual(await incidentCheck(rec.repo, boards[from]!, lives[from]!, boards[to]!, NONE), { ok: true }, `B${from}..B${to}`);
      return rec.calls.length - before;
    };
    const long = await calls(0, 300);
    const short = await calls(270, 300);
    assert.equal(long, short, `B0..B300 took ${long} git calls, B270..B300 ${short}: the cost must not grow with the range`);
    assert.ok(long <= 10, `${long} git calls (the documented bound for a range of small commits is 10)`);
    // The same (LA_B, LA_C, T) again, as on an idle iteration: answered from the last verified range.
    const before = rec.calls.length;
    assert.deepEqual(await incidentCheck(rec.repo, boards[270]!, lives[270]!, boards[300]!, NONE), { ok: true });
    assert.equal(rec.calls.length, before, 'an unchanged range costs no git call');
    // A bad commit deep in a long range is still found: a jump of the last parent 60 board commits below the tip.
    const jumpLive = await live(m, [lives[99]!]);
    const jumpLive2 = await live(m, [jumpLive]);
    const jb1 = await board(m, [boards[99]!, jumpLive2]);
    let tip = jb1;
    for (let i = 0; i < 60; i++) tip = await board(m, [tip, jumpLive2]);
    assert.deepEqual(await incidentCheck(rec.repo, boards[0]!, lives[0]!, tip, NONE), { ok: false, why: 'live_shape', observedBoard: tip, observedCode: jumpLive2 });
  } finally {
    await m.f.cleanup();
  }
});

test('a range of large commits is read in several cat-file --batch calls, each of at most 32 MiB of objects', async (t) => {
  const m = await maker('incident-bigrange');
  try {
    // 40 board commits of ≈ 1,000,000 bytes each (under the 1 MiB commit cap): ≈ 40 MB in the range, more than one batch.
    const { boards, lives } = await importBoard(m, 40, 1_000_000);
    const sizesOut = await m.f.repo.run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { stdin: Buffer.from(`${[...boards, ...lives].join('\n')}\n`, 'utf8') });
    const size = new Map(sizesOut.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => {
      const [o, s] = l.split(' ');
      return [o!, Number(s)] as const;
    }));
    assert.ok(boards.slice(1).every((b) => size.get(b)! > 1_000_000 && size.get(b)! <= BOARD_COMMIT_OBJECT_MAX_BYTES), 'every board commit is large and within the commit cap');
    // The runner trace: the oids every `cat-file --batch` call read (its stdin), summed by object size.
    const reads: Oid[][] = [];
    const runner: GitRunner = {
      run(args, opts) {
        if (args[0] === 'cat-file' && args[1] === '--batch' && args.length === 2) {
          reads.push((opts.stdin ?? Buffer.alloc(0)).toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l)));
        }
        return m.f.runner.run(args, opts);
      },
    };
    const repo = new GitRepo(runner, m.f.paths, fixtureContext);
    assert.deepEqual(await incidentCheck(repo, boards[0]!, lives[0]!, boards[40]!, NONE), { ok: true });
    const perCall = reads.map((oids) => oids.reduce((n, o) => n + size.get(o)!, 0));
    t.diagnostic(`cat-file --batch calls: ${reads.length}; objects per call: ${reads.map((r) => r.length).join(', ')}; bytes per call: ${perCall.join(', ')}`);
    assert.ok(perCall.every((n) => n <= BATCH_READ_MAX_BYTES), `bytes per cat-file --batch call: ${perCall.join(', ')} (cap ${BATCH_READ_MAX_BYTES})`);
    const readBoards = new Set(reads.flat().filter((o) => boards.includes(o)));
    assert.equal(readBoards.size, 41, 'every board commit of B0..B40 was read');
    const bigCalls = reads.filter((oids) => oids.some((o) => size.get(o)! > 1_000_000));
    assert.ok(bigCalls.length >= 2, `the large range took ${bigCalls.length} cat-file --batch call(s)`);
    assert.equal(BATCH_READ_MAX_BYTES, 32 * 1024 * 1024);
  } finally {
    await m.f.cleanup();
  }
});

test('liveBase finds the genesis Cowork-Base on a 300-commit chain in one git call', async () => {
  const m = await maker('incident-livebase');
  try {
    const chain = await importLive(m, 'refs/test/live', m.hr, 300);
    const tip = chain[299]!;
    const rec = recording(m.f);
    assert.deepEqual(await liveBase(rec.repo, tip), { base: m.hr, introducedBy: chain[0] });
    assert.equal(rec.calls.length, 1, 'one git call, whatever the chain length');
    assert.equal(rec.calls[0]![0], 'rev-list');
    assert.deepEqual(await liveBase(rec.repo, chain[0]!), { base: m.hr, introducedBy: chain[0] });
    // The newest base move on the first-parent chain wins; what lies below it stays the genesis base.
    const X = await commitFiles(m.f, { 'x.txt': 'branch\n' });
    const Lbm = await live(m, [tip, X], X);
    const after = await live(m, [Lbm]);
    assert.deepEqual(await liveBase(m.f.repo, after), { base: X, introducedBy: Lbm });
    assert.deepEqual(await liveBase(m.f.repo, Lbm), { base: X, introducedBy: Lbm });
    assert.deepEqual(await liveBase(m.f.repo, chain[150]!), { base: m.hr, introducedBy: chain[0] });
    // A Cowork-Base reachable only through a second parent is not on the first-parent chain.
    const Y = await live(m, [], X);
    const merged = await m.f.repo.commitTree({ tree: m.hrTree, parents: [chain[150]!, Y], subject: CODE_SUBJECT, trailers: liveCommitTrailers(m.w(), ['human'], [], new Map(), null) });
    assert.deepEqual(await liveBase(m.f.repo, merged), { base: m.hr, introducedBy: chain[0] });
    // No Cowork-Base on the chain at all.
    const plain = await commitFiles(m.f, { 'p.txt': 'p\n' });
    await assert.rejects(async () => liveBase(m.f.repo, plain), /Cowork-Base/);
  } finally {
    await m.f.cleanup();
  }
});

/** A GitRepo whose runner records every argv with its stdout. */
function tracing(f: RepoFixture): { repo: GitRepo; calls: Array<{ argv: string[]; stdout: Buffer }> } {
  const calls: Array<{ argv: string[]; stdout: Buffer }> = [];
  const runner: GitRunner = {
    async run(args, opts) {
      const r = await f.runner.run(args, opts);
      calls.push({ argv: [...args], stdout: r.stdout });
      return r;
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), calls };
}

test('liveBase is incremental: after a first call on a 300-commit chain, a call on tip+1 examines one commit and returns the same base; a chain that does not continue the last tip is walked in full', async () => {
  const m = await maker('incident-livebase-inc');
  try {
    const chain = await importLive(m, 'refs/test/live', m.hr, 300);
    const tip = chain[299]!;
    const t = tracing(m.f);
    const genesis = { base: m.hr, introducedBy: chain[0] };
    /** One lookup: its answer, its git calls, and how many commits each call's output carried (NUL-led records). */
    const lookup = async (L: Oid): Promise<{ answer: unknown; calls: number; examined: number[]; argv: string[][] }> => {
      const from = t.calls.length;
      const answer = await liveBase(t.repo, L);
      const calls = t.calls.slice(from);
      return { answer, calls: calls.length, examined: calls.map((c) => c.stdout.toString('utf8').split('\0').length - 1), argv: calls.map((c) => c.argv) };
    };
    const first = await lookup(tip);
    assert.deepEqual({ answer: first.answer, calls: first.calls }, { answer: genesis, calls: 1 });
    // The same tip again (an iteration with an unchanged TIP): no git call.
    assert.deepEqual(await lookup(tip), { answer: genesis, calls: 0, examined: [], argv: [] });
    // tip + 1: one rev-list of tip..tip+1, one commit examined, the same base.
    const next = await live(m, [tip]);
    const step = await lookup(next);
    assert.deepEqual({ answer: step.answer, calls: step.calls, examined: step.examined }, { answer: genesis, calls: 1, examined: [1] });
    assert.ok(step.argv[0]!.includes(`^${tip}`), step.argv[0]!.join(' '));
    // A base move as the new commit: found by the same one-commit call; the next commit keeps it.
    const X = await commitFiles(m.f, { 'x.txt': 'branch\n' });
    const Lbm = await live(m, [next, X], X);
    const moved = await lookup(Lbm);
    assert.deepEqual({ answer: moved.answer, calls: moved.calls, examined: moved.examined }, { answer: { base: X, introducedBy: Lbm }, calls: 1, examined: [1] });
    const after = await live(m, [Lbm]);
    const kept = await lookup(after);
    assert.deepEqual({ answer: kept.answer, calls: kept.calls, examined: kept.examined }, { answer: { base: X, introducedBy: Lbm }, calls: 1, examined: [1] });
    // A chain that leaves the last tip's first-parent chain: K's first parent chain[150] is reachable from `after`, so a
    // rev-list K ^after stops after K alone; taking the last answer (X) would be wrong. The whole chain is walked.
    const K = await live(m, [chain[150]!]);
    const off = await lookup(K);
    assert.deepEqual({ answer: off.answer, calls: off.calls }, { answer: genesis, calls: 2 });
    // A rewind to an ancestor, and a chain through a second parent only: walked in full, right answers.
    assert.deepEqual((await lookup(chain[10]!)).answer, genesis);
    const Y = await live(m, [], X);
    const merged = await m.f.repo.commitTree({ tree: m.hrTree, parents: [Y, after], subject: CODE_SUBJECT, trailers: liveCommitTrailers(m.w(), ['human'], [], new Map(), null) });
    assert.deepEqual((await lookup(after)).answer, { base: X, introducedBy: Lbm });
    assert.deepEqual((await lookup(merged)).answer, { base: X, introducedBy: Y }, 'after is only a second parent: Y is the genesis of merged');
    // Every answer equals a fresh whole-chain walk's.
    for (const L of [tip, next, Lbm, after, K, chain[10]!, merged]) {
      assert.deepEqual(await liveBase(recording(m.f).repo, L), await liveBase(t.repo, L), L);
    }
  } finally {
    await m.f.cleanup();
  }
});

test('liveBase whose remembered tip was pruned walks the whole chain (rev-list ^tip exits 128), answers like a fresh repo, and the next tip+1 is incremental again', async () => {
  const m = await maker('incident-livebase-pruned');
  try {
    const chain = await importLive(m, 'refs/test/live', m.hr, 30);
    const tip = chain[29]!;
    const t = tracing(m.f);
    const genesis = { base: m.hr, introducedBy: chain[0] };
    const lookup = async (L: Oid): Promise<{ answer: unknown; calls: number; examined: number[]; argv: string[][] }> => {
      const from = t.calls.length;
      const answer = await liveBase(t.repo, L);
      const calls = t.calls.slice(from);
      return { answer, calls: calls.length, examined: calls.map((c) => c.stdout.toString('utf8').split('\0').length - 1), argv: calls.map((c) => c.argv) };
    };
    // D: a TIP that a rewrite later abandons; liveBase remembers it.
    const D = await live(m, [tip]);
    assert.deepEqual((await lookup(D)).answer, genesis);
    // D's object is pruned (its loose file removed, as `gc --prune=now` would after the reflog expired).
    const loose = join(m.f.paths.gitDir, 'objects', D.slice(0, 2), D.slice(2));
    assert.ok(existsSync(loose), `D is a loose object at ${loose}`);
    chmodSync(loose, 0o644);
    rmSync(loose);
    assert.equal(await m.f.repo.hasObject(D, 'commit'), false, 'D is gone');
    // E (the rewritten TIP): the incremental rev-list E ^D exits 128 (bad object D), so the whole chain is walked.
    const E = await live(m, [tip]);
    const rewritten = await lookup(E);
    assert.deepEqual({ answer: rewritten.answer, calls: rewritten.calls }, { answer: genesis, calls: 2 });
    assert.ok(rewritten.argv[0]!.includes(`^${D}`), `first the incremental call: ${rewritten.argv[0]!.join(' ')}`);
    assert.ok(rewritten.argv[1]!.includes('--grep=^Cowork-Base: ') && !rewritten.argv[1]!.some((a) => a.startsWith('^')), `then the whole-chain walk: ${rewritten.argv[1]!.join(' ')}`);
    assert.deepEqual(rewritten.answer, await liveBase(recording(m.f).repo, E), 'the same answer as a fresh repo');
    // The walk replaced the stale memo: E + 1 reads E..F only, one commit, in one call.
    const F = await live(m, [E]);
    const step = await lookup(F);
    assert.deepEqual({ answer: step.answer, calls: step.calls, examined: step.examined }, { answer: genesis, calls: 1, examined: [1] });
    assert.ok(step.argv[0]!.includes(`^${E}`), step.argv[0]!.join(' '));
    // A missing L is still an error, never an answer: the whole-chain walk of D exits 128 too.
    await assert.rejects(async () => liveBase(t.repo, D), (e: unknown) => e instanceof GitCommandError && e.code === 128);
    assert.deepEqual((await lookup(F)).calls, 0, 'the failed lookup left the memo at F');
  } finally {
    await m.f.cleanup();
  }
});
