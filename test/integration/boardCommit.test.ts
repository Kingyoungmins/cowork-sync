import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  BOARD_COMMIT_OBJECT_MAX_BYTES,
  BOARD_ROOT_TREE_MAX_BYTES,
  BOARD_SUBJECT,
  BOARD_TREE_MAX_BYTES,
  BoardMalformedError,
  boardShapeOk,
  boardTrailers,
  buildBoardCommit,
  checkBoardCommits,
  CODE_SUBJECT,
  decodeCsPaths,
  encodeCsPaths,
  formatWriter,
  liveCommitTrailers,
  liveShape,
  parseCsTrailers,
  parseWriter,
  readBoardCommit,
  readCommitsChecked,
  STATE_SUBJECT,
  type BoardBuild,
  type BoardCommitData,
  type CsTrailer,
  type WriterId,
} from '../../src/board/boardCommit.js';
import { canonicalBytes, canonicalJson, type Json } from '../../src/board/canonicalJson.js';
import { H, newEpoch, newPeerId } from '../../src/board/ids.js';
import { BoardCapError, OPS_MAX_BYTES, parseOpLine, serializeOps, type Op } from '../../src/board/ops.js';
import { genesisProtocol, serializeProtocol } from '../../src/board/protocol.js';
import type { Oid } from '../../src/git/oid.js';
import { GitRepo, type MktreeEntry } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { formatMessage, SKIP_SUBJECT_PREFIX, type Trailer } from '../../src/git/trailers.js';
import { seededRandom } from '../../src/ports/random.js';
import { FIXTURE_WALL_MS, fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const DISPLAY = 'Ada Lovelace';
const RS = 'rs-test';
const SEAT = '00112233445566778899aabbccddeeff';
const HOLD_ID = '01J9ZQ3C5X0000000000000000';

interface Board { f: RepoFixture; repo: GitRepo; peer: string; epoch: string; hr: Oid; hrTree: Oid }

/** A clone whose GitRepo commits as `<display> <peer_id@cowork.invalid>` (glossary §5, SEC-03). */
async function setup(label: string): Promise<Board> {
  const f = await makeRepoFixture(label);
  const r = seededRandom(label);
  const peer = newPeerId(r);
  const epoch = newEpoch(r);
  const repo = new GitRepo(f.runner, f.paths, () => ({ ...fixtureContext(), identity: { name: DISPLAY, email: `${peer}@cowork.invalid` } }));
  const hr = await repo.resolve('HEAD');
  assert.ok(hr !== null);
  return { f, repo, peer, epoch, hr, hrTree: (await repo.readCommit(hr)).tree };
}

const opId = (b: Board, seq: number): string => `${b.peer}/${b.epoch}/${seq}`;
const writerAt = (b: Board, seq: number): WriterId => ({ peer: b.peer, epoch: b.epoch, seq });
const T = (key: string, value: string): Trailer => ({ key, value });
const HEAD3 = (w: string): Trailer[] => [T('skip-checks', 'true'), T('Cowork-Proto', '1'), T('Cowork-Writer', w)];

function joinOp(b: Board, seq: number): Op {
  return {
    id: opId(b, seq), type: 'join', display: DISPLAY, plugin_version: '0.0.0', plugin_sha: '0'.repeat(64), proto: 1, regionSpec: RS,
    config_fingerprint: { filters: {}, autocrlf: '', eol_attrs: '', git: '2.47.1' }, coauthor_optin: false,
  };
}
function capsOp(b: Board, seq: number): Op {
  return { id: opId(b, seq), type: 'caps', custom_refs: true, lease: true, delete: true, push_options: false, two_parent_ok: true };
}
function eventOp(b: Board, seq: number): Op {
  return { id: opId(b, seq), type: 'event', cid: H(opId(b, seq), 'freeze'), kind: 'freeze', refs: [], reason_code: 'EPOCH_CHANGED' };
}

/** L0 and B0 of a genesis (01-engine §3.14): L0 = tree(Hr) with Cowork-Base: Hr, B0 = [L0] with join and caps. */
async function genesis(b: Board): Promise<{ L0: Oid; B0: Oid; ops: Op[]; checkpoint: Buffer; w: WriterId; build: BoardBuild }> {
  const w = writerAt(b, 3);
  const L0 = await b.repo.commitTree({ tree: b.hrTree, parents: [], subject: CODE_SUBJECT, trailers: liveCommitTrailers(w, [], [], new Map(), b.hr) });
  const checkpoint = canonicalBytes({ v: 1, height: 0 });
  const ops = [joinOp(b, 1), capsOp(b, 2)];
  const build: BoardBuild = { prevBoard: null, liveCode: L0, writer: w, ops, cs: [], csPaths: new Map(), protocol: genesisProtocol(12, RS), checkpoint };
  return { L0, B0: await buildBoardCommit(b.repo, build), ops, checkpoint, w, build };
}

interface TopEntry { mode: string; type: string; oid: Oid }
/** The top-level entries of a tree (or a commit's tree), by name. */
async function topLevel(repo: GitRepo, treeish: Oid): Promise<Map<string, TopEntry>> {
  const out = new Map<string, TopEntry>();
  for (const rec of (await repo.run(['ls-tree', '-z', treeish])).stdout.toString('utf8').split('\0')) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    out.set(rec.slice(tab + 1), { mode: mode!, type: type!, oid: oid as Oid });
  }
  return out;
}
const asMktree = (top: Map<string, TopEntry>): MktreeEntry[] =>
  [...top].map(([name, e]) => ({ name, mode: e.mode as MktreeEntry['mode'], type: e.type as MktreeEntry['type'], oid: e.oid }));

/** A live code commit holding one file, on top of `parents`. */
async function codeCommit(b: Board, parents: Oid[], content: string, trailers: Trailer[], subject = CODE_SUBJECT): Promise<Oid> {
  const blob = await b.repo.hashBytes(Buffer.from(content, 'utf8'), true);
  const tree = await b.repo.mktree([{ name: 'f.txt', mode: '100644', type: 'blob', oid: blob }]);
  return b.repo.commitTree({ tree, parents, subject, trailers });
}

test('B0 has the single parent [L0], the PRO-01 subject and trailers, and a tree of exactly ops.jsonl, protocol.json, checkpoint/state.json', async () => {
  const b = await setup('board-b0');
  try {
    const { L0, B0, ops, checkpoint, w, build } = await genesis(b);
    const info = await b.repo.readCommit(B0);
    assert.deepEqual(info.parents, [L0]);
    assert.equal(info.subject, BOARD_SUBJECT);
    assert.ok(BOARD_SUBJECT.startsWith(SKIP_SUBJECT_PREFIX) && CODE_SUBJECT.startsWith(SKIP_SUBJECT_PREFIX));
    assert.equal(STATE_SUBJECT, 'cowork-state');
    assert.deepEqual(info.trailers, HEAD3(`${b.peer}/${b.epoch}/3`));

    // Exactly three leaves; checkpoint/ is a tree holding state.json.
    const top = await topLevel(b.repo, info.tree);
    assert.deepEqual([...top.keys()], ['checkpoint', 'ops.jsonl', 'protocol.json']);
    assert.equal(top.get('checkpoint')?.type, 'tree');
    const leaves = await b.repo.readTreeMap(info.tree);
    assert.deepEqual([...leaves.keys()].sort(), ['checkpoint/state.json', 'ops.jsonl', 'protocol.json']);
    // ops.jsonl = the starter's join followed by its caps (PRO-07); protocol.json and the height-0 checkpoint.
    const opsBytes = await b.repo.readBlob(leaves.get('ops.jsonl')!.oid);
    assert.deepEqual(opsBytes, serializeOps(ops));
    assert.equal(opsBytes.toString('utf8'), `${canonicalJson(ops[0] as unknown as Json)}\n${canonicalJson(ops[1] as unknown as Json)}\n`);
    assert.deepEqual(await b.repo.readBlob(leaves.get('protocol.json')!.oid), serializeProtocol(genesisProtocol(12, RS)));
    assert.deepEqual(await b.repo.readBlob(leaves.get('checkpoint/state.json')!.oid), checkpoint);

    // readBoardCommit reads it back.
    const data = await readBoardCommit(b.repo, B0);
    assert.deepEqual(data, {
      oid: B0, parents: [L0], firstParent: null, liveCode: L0, writer: w, cs: [], protocol: genesisProtocol(12, RS),
      opsLines: ops.map((o) => canonicalJson(o as unknown as Json)), checkpoint, heldIds: [],
    });
    assert.deepEqual(data.opsLines.map((l) => parseOpLine(l)), ops);

    // B0 needs protocol.json and the height-0 checkpoint; its ops are the writer's own, below the writer seq.
    await assert.rejects(buildBoardCommit(b.repo, { ...build, protocol: null }), /protocol/);
    await assert.rejects(buildBoardCommit(b.repo, { ...build, checkpoint: null }), /checkpoint/);
    await assert.rejects(buildBoardCommit(b.repo, { ...build, writer: writerAt(b, 2) }), /writer/);
    await assert.rejects(buildBoardCommit(b.repo, { ...build, writer: { ...w, epoch: b.peer } }), /writer/);
  } finally {
    await b.f.cleanup();
  }
});

test('a later board commit has parents [prev, live], carries protocol.json and held/ by oid and replaces ops.jsonl', async () => {
  const b = await setup('board-later');
  try {
    const { L0, B0, checkpoint } = await genesis(b);
    const b0Top = await topLevel(b.repo, B0);
    // A board commit that mirrors one hold (Plan 3 writes held/; built by hand here) and carries a stray entry.
    const s2 = await b.repo.hashBytes(Buffer.from('displaced bytes\n'), true);
    let sub = await b.repo.mktree([{ name: 'a.txt', mode: '100644', type: 'blob', oid: s2 }]);
    for (const name of ['src', 's2', HOLD_ID]) sub = await b.repo.mktree([{ name, mode: '040000', type: 'tree', oid: sub }]);
    const held = sub;
    const stray = await b.repo.hashBytes(Buffer.from('stray\n'), true);
    const bhTree = await b.repo.mktree([
      ...asMktree(b0Top),
      { name: 'held', mode: '040000', type: 'tree', oid: held },
      { name: 'stray.txt', mode: '100644', type: 'blob', oid: stray },
    ]);
    const Bh = await b.repo.commitTree({ tree: bhTree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: boardTrailers(writerAt(b, 4), [], new Map()) });

    // One publish intent (writer 6): a code commit L1 and its board commit with one op (seq 5).
    const w6 = writerAt(b, 6);
    const L1 = await codeCommit(b, [L0], 'one\n', liveCommitTrailers(w6, ['human'], [], new Map(), null));
    const ev = eventOp(b, 5);
    const B2 = await buildBoardCommit(b.repo, { prevBoard: Bh, liveCode: L1, writer: w6, ops: [ev], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
    assert.deepEqual((await b.repo.readCommit(B2)).parents, [Bh, L1]);
    const b2Top = await topLevel(b.repo, B2);
    assert.deepEqual([...b2Top.keys()], ['checkpoint', 'held', 'ops.jsonl', 'protocol.json'], 'exactly the PRO-02 entries; the stray one is not carried');
    assert.equal(b2Top.get('protocol.json')?.oid, b0Top.get('protocol.json')?.oid, 'protocol.json carried as the same blob');
    assert.equal(b2Top.get('held')?.oid, held, 'held/ carried by oid');
    assert.equal(b2Top.get('checkpoint')?.oid, b0Top.get('checkpoint')?.oid, 'checkpoint carried when none is given');
    assert.notEqual(b2Top.get('ops.jsonl')?.oid, b0Top.get('ops.jsonl')?.oid);
    assert.deepEqual(await b.repo.readBlob(b2Top.get('ops.jsonl')!.oid), serializeOps([ev]), 'ops.jsonl replaced, not appended');
    const d2 = await readBoardCommit(b.repo, B2);
    assert.equal(d2.firstParent, Bh);
    assert.equal(d2.liveCode, L1);
    assert.deepEqual(d2.heldIds, [HOLD_ID]);
    assert.deepEqual(d2.opsLines, [canonicalJson(ev as unknown as Json)]);
    assert.deepEqual(d2.protocol, genesisProtocol(12, RS));
    assert.deepEqual(d2.checkpoint, checkpoint);
    assert.deepEqual(d2.writer, w6);

    // A board-only publish repeats the last parent; a new checkpoint replaces checkpoint/state.json; no ops → empty ops.jsonl.
    const ck = canonicalBytes({ v: 1, height: 256 });
    const B3 = await buildBoardCommit(b.repo, { prevBoard: B2, liveCode: L1, writer: writerAt(b, 7), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: ck });
    assert.deepEqual((await b.repo.readCommit(B3)).parents, [B2, L1]);
    const b3Top = await topLevel(b.repo, B3);
    assert.deepEqual([...b3Top.keys()], ['checkpoint', 'held', 'ops.jsonl', 'protocol.json']);
    assert.equal(b3Top.get('protocol.json')?.oid, b0Top.get('protocol.json')?.oid);
    assert.equal(b3Top.get('held')?.oid, held);
    const d3 = await readBoardCommit(b.repo, B3);
    assert.deepEqual(d3.checkpoint, ck);
    assert.deepEqual(d3.opsLines, []);
    assert.equal((await b.repo.readBlob(b3Top.get('ops.jsonl')!.oid)).length, 0);

    // protocol.json is written only at genesis; a previous board without protocol.json cannot be carried.
    const later: BoardBuild = { prevBoard: B2, liveCode: L1, writer: writerAt(b, 8), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null };
    await assert.rejects(buildBoardCommit(b.repo, { ...later, protocol: genesisProtocol(12, RS) }), /protocol/);
    const noProto = new Map(b0Top);
    noProto.delete('protocol.json');
    const Bbad = await b.repo.commitTree({ tree: await b.repo.mktree(asMktree(noProto)), parents: [B0, L0], subject: BOARD_SUBJECT, trailers: boardTrailers(writerAt(b, 4), [], new Map()) });
    await assert.rejects(buildBoardCommit(b.repo, { ...later, prevBoard: Bbad }), /protocol/);
  } finally {
    await b.f.cleanup();
  }
});

test('live commit trailers: skip-checks, Cowork-Proto, the Cowork-Writer shared with its board commit, Cowork-Seat: human, Cowork-CS, Cowork-CS-Paths only up to 256 paths, Cowork-Base on L0', async () => {
  const b = await setup('board-trailers');
  try {
    const { L0, B0 } = await genesis(b);
    // L0: the live markers, the writer of the genesis intent and Cowork-Base: Hr; no seat.
    const l0 = await b.repo.readCommit(L0);
    assert.equal(l0.subject, CODE_SUBJECT);
    assert.deepEqual(l0.parents, []);
    assert.deepEqual(l0.tree, b.hrTree);
    assert.deepEqual(l0.trailers, [...HEAD3(`${b.peer}/${b.epoch}/3`), T('Cowork-Base', b.hr)]);
    const writerOf = (ts: Trailer[]): string | undefined => ts.find((t) => t.key === 'Cowork-Writer')?.value;
    assert.equal(writerOf((await b.repo.readCommit(B0)).trailers), writerOf(l0.trailers), 'L0 and B0 share the genesis writer');

    const w = writerAt(b, 9);
    const csA: CsTrailer = { csId: `${b.peer}/human/1`, state: 'closed', seq: 1, origin: 'human', checks: 'skipped', paths: 2 };
    const big = Array.from({ length: 257 }, (_, i) => `gen/f${String(i).padStart(3, '0')}.txt`);
    const csB: CsTrailer = { csId: `${b.peer}/human/2`, state: 'closed', seq: 2, origin: 'human', checks: 'skipped', paths: 257 };
    const at256 = big.slice(0, 256);
    const csC: CsTrailer = { csId: `${SEAT}/4`, state: 'checkpoint', seq: 3, origin: 'prompt', checks: 'pass', paths: 256 };
    const csPaths = new Map<string, readonly string[]>([[csA.csId, ['src/b.txt', 'src/a.txt']], [csB.csId, big], [csC.csId, at256]]);
    const cs = [csA, csB, csC];
    const trailers = liveCommitTrailers(w, ['human', SEAT, 'human'], cs, csPaths, null);
    const csLines = [
      T('Cowork-CS', `${csA.csId} state=closed seq=1 origin=human checks=skipped paths=2`),
      T('Cowork-CS', `${csB.csId} state=closed seq=2 origin=human checks=skipped paths=257`),
      T('Cowork-CS', `${csC.csId} state=checkpoint seq=3 origin=prompt checks=pass paths=256`),
      T('Cowork-CS-Paths', `${csA.csId} ${encodeCsPaths(['src/a.txt', 'src/b.txt'])}`),
      T('Cowork-CS-Paths', `${csC.csId} ${encodeCsPaths(at256)}`),
    ];
    assert.deepEqual(trailers, [...HEAD3(`${b.peer}/${b.epoch}/9`), T('Cowork-Seat', SEAT), T('Cowork-Seat', 'human'), ...csLines]);
    assert.deepEqual(boardTrailers(w, cs, csPaths), [...HEAD3(`${b.peer}/${b.epoch}/9`), ...csLines]);

    // Through git: the code commit and the board commit of one intent share Cowork-Writer; only the code commit has seats.
    const L1 = await codeCommit(b, [L0], 'one\n', trailers);
    const B1 = await buildBoardCommit(b.repo, { prevBoard: B0, liveCode: L1, writer: w, ops: [], cs, csPaths, protocol: null, checkpoint: null });
    const l1 = await b.repo.readCommit(L1);
    const b1 = await b.repo.readCommit(B1);
    assert.deepEqual(l1.trailers, trailers);
    assert.deepEqual(b1.trailers, boardTrailers(w, cs, csPaths));
    assert.equal(writerOf(l1.trailers), writerOf(b1.trailers));
    assert.ok(!b1.trailers.some((t) => t.key === 'Cowork-Seat' || t.key === 'Cowork-Base'));
    assert.ok(!l1.trailers.some((t) => t.key === 'Cowork-Base'), 'only genesis and base-move commits carry Cowork-Base');
    const parsed = parseCsTrailers(l1.trailers);
    assert.deepEqual(parsed.cs, cs);
    assert.deepEqual([...parsed.paths], [[csA.csId, ['src/a.txt', 'src/b.txt']], [csC.csId, at256]]);
    assert.deepEqual((await readBoardCommit(b.repo, B1)).cs, cs);
    for (const t of csLines.filter((x) => x.key === 'Cowork-CS-Paths')) assert.match(t.value, /^\S+ [A-Za-z0-9_-]+$/);

    // Cowork-CS-Paths: base64url(zlib(NUL-joined sorted paths)), order-independent, decoded only when well formed.
    assert.equal(encodeCsPaths(['src/b.txt', 'src/a.txt']), encodeCsPaths(['src/a.txt', 'src/b.txt']));
    assert.deepEqual(decodeCsPaths(encodeCsPaths(['한글/파일.md', 'a b.txt'])), ['a b.txt', '한글/파일.md']);
    assert.throws(() => encodeCsPaths(big), RangeError);
    const enc = (s: string): string => deflateSync(Buffer.from(s, 'utf8')).toString('base64url');
    assert.deepEqual(decodeCsPaths(enc('a.txt\0b.txt')), ['a.txt', 'b.txt']);
    for (const bad of ['', '!!', 'abc=', Buffer.from('not zlib').toString('base64url'), enc('a.txt\0../b'), enc('a.txt\0\0b.txt'), enc(big.join('\0'))]) {
      assert.equal(decodeCsPaths(bad), null, bad.slice(0, 20));
    }
    // A malformed Cowork-CS is skipped; a Cowork-CS-Paths without its CS or with another count is dropped.
    const loose = parseCsTrailers([
      T('Cowork-CS', `${csA.csId} seq=1 state=closed origin=human checks=skipped paths=2`),
      T('Cowork-CS', `${csA.csId} state=open seq=1 origin=human checks=skipped paths=2`),
      T('Cowork-CS', `${csA.csId} state=closed seq=01 origin=human checks=skipped paths=2`),
      T('Cowork-CS', `bad-id state=closed seq=1 origin=human checks=skipped paths=2`),
      T('Cowork-CS', `${csC.csId} state=checkpoint seq=3 origin=prompt checks=pass paths=3`),
      T('Cowork-CS-Paths', `${csC.csId} ${encodeCsPaths(['a.txt', 'b.txt'])}`),
      T('Cowork-CS-Paths', `${csA.csId} ${encodeCsPaths(['a.txt', 'b.txt'])}`),
    ]);
    assert.deepEqual(loose.cs, [{ ...csC, paths: 3 }]);
    assert.equal(loose.paths.size, 0);

    // The writer side refuses what receivers would misread.
    assert.throws(() => liveCommitTrailers(w, ['Human'], [], new Map(), null));
    assert.throws(() => liveCommitTrailers(w, [], [{ ...csA, paths: 3 }], csPaths, null), /paths/);
    assert.throws(() => liveCommitTrailers(w, [], [csA], new Map(), null), /Cowork-CS-Paths/);
    assert.throws(() => liveCommitTrailers(w, [], [{ ...csA, csId: 'bad' }], new Map([['bad', ['a.txt', 'b.txt']]]), null));
    assert.throws(() => liveCommitTrailers(w, [], [csA, csA], csPaths, null));
    assert.throws(() => liveCommitTrailers({ ...w, seq: 0 }, [], [], new Map(), null));
  } finally {
    await b.f.cleanup();
  }
});

test('author and committer are <display> <peer_id@cowork.invalid> at +0000 and the commits are unsigned', async () => {
  const b = await setup('board-ident');
  try {
    // A user config that must neither leak into nor sign a cowork commit.
    await b.repo.run(['config', 'user.name', 'Leaky User']);
    await b.repo.run(['config', 'user.email', 'leak@example.com']);
    await b.repo.run(['config', 'commit.gpgSign', 'true']);
    await b.repo.run(['config', 'gpg.program', join(b.f.root, 'no-such-gpg')]);
    const { L0, B0 } = await genesis(b);
    const secs = FIXTURE_WALL_MS / 1000;
    for (const oid of [L0, B0]) {
      const raw = (await b.repo.run(['cat-file', 'commit', oid])).stdout.toString('utf8');
      const header = (raw.split('\n\n')[0] ?? '').split('\n');
      assert.ok(header.includes(`author ${DISPLAY} <${b.peer}@cowork.invalid> ${secs} +0000`), header.join('\n'));
      assert.ok(header.includes(`committer ${DISPLAY} <${b.peer}@cowork.invalid> ${secs} +0000`), header.join('\n'));
      assert.ok(!header.some((l) => l.startsWith('gpgsig')), 'never signed');
      assert.ok(!raw.includes('leak@example.com') && !raw.includes('Leaky User'));
    }
  } finally {
    await b.f.cleanup();
  }
});

test("a user's i18n.commitEncoding and i18n.logOutputEncoding never reach board and live commits", async () => {
  const b = await setup('board-encoding');
  try {
    // A Hangul display name: the author line is where a re-encoding would show.
    const DISPLAY_KO = '\u{d64d}\u{ae38}\u{b3d9}';
    const repo = new GitRepo(b.f.runner, b.f.paths, () => ({ ...fixtureContext(), identity: { name: DISPLAY_KO, email: `${b.peer}@cowork.invalid` } }));
    const hb: Board = { ...b, repo };
    // The user's config asks git to label commit messages EUC-KR.
    await repo.run(['config', 'i18n.commitEncoding', 'EUC-KR']);
    const { L0, B0, w } = await genesis(hb);
    const expected: Array<[Oid, Buffer]> = [
      [L0, formatMessage(CODE_SUBJECT, liveCommitTrailers(w, [], [], new Map(), b.hr))],
      [B0, formatMessage(BOARD_SUBJECT, boardTrailers(w, [], new Map()))],
    ];
    for (const [oid, message] of expected) {
      const raw = (await repo.run(['cat-file', 'commit', oid])).stdout;
      const split = raw.indexOf('\n\n');
      const header = raw.subarray(0, split).toString('utf8').split('\n');
      assert.ok(!header.some((l) => l.startsWith('encoding ')), `no encoding header:\n${header.join('\n')}`);
      assert.ok(header.some((l) => l.startsWith(`author ${DISPLAY_KO} <${b.peer}@cowork.invalid> `)));
      assert.deepEqual(raw.subarray(split + 2), message, 'the message reads back byte-identical');
    }
    assert.deepEqual((await readBoardCommit(repo, B0)).writer, w);

    // The user's config asks git to print log output EUC-KR: what cowork reads through log stays UTF-8.
    await repo.run(['config', '--unset', 'i18n.commitEncoding']);
    await repo.run(['config', 'i18n.logOutputEncoding', 'EUC-KR']);
    const printed = (await repo.run(['log', '-1', '--format=%an%n%B', B0])).stdout;
    assert.deepEqual(printed, Buffer.concat([Buffer.from(`${DISPLAY_KO}\n`, 'utf8'), expected[1]![1], Buffer.from('\n')]));
  } finally {
    await b.f.cleanup();
  }
});

test('readBoardCommit reports writer null for a missing or malformed Cowork-Writer', async () => {
  const b = await setup('board-writer');
  try {
    const { L0, B0, ops } = await genesis(b);
    const tree = (await b.repo.readCommit(B0)).tree;
    const commitWith = (trailers: Trailer[]): Promise<Oid> => b.repo.commitTree({ tree, parents: [L0], subject: BOARD_SUBJECT, trailers });
    const base = [T('skip-checks', 'true'), T('Cowork-Proto', '1')];
    const good = `${b.peer}/${b.epoch}/3`;
    const cases: Array<[string, Trailer[]]> = [
      ['no trailers', []],
      ['no Cowork-Writer', base],
      ['garbage', [...base, T('Cowork-Writer', 'garbage')]],
      ['two segments', [...base, T('Cowork-Writer', `${b.peer}/${b.epoch}`)]],
      ['seq 0', [...base, T('Cowork-Writer', `${b.peer}/${b.epoch}/0`)]],
      ['seq 03', [...base, T('Cowork-Writer', `${b.peer}/${b.epoch}/03`)]],
      ['seq beyond MAX_SAFE_INTEGER', [...base, T('Cowork-Writer', `${b.peer}/${b.epoch}/9007199254740993`)]],
      ['upper-case peer', [...base, T('Cowork-Writer', `${b.peer.toUpperCase()}/${b.epoch}/3`)]],
      ['trailing space', [...base, T('Cowork-Writer', `${good} `)]],
      ['two writers', [...base, T('Cowork-Writer', good), T('Cowork-Writer', `${b.peer}/${b.epoch}/4`)]],
    ];
    for (const [what, trailers] of cases) {
      const data = await readBoardCommit(b.repo, await commitWith(trailers));
      assert.equal(data.writer, null, what);
      // The rest of the commit still reads: the fold turns its ops into no-ops (02-protocol §3.3 step 1).
      assert.equal(data.opsLines.length, ops.length, what);
      assert.equal(data.protocol.proto, 1, what);
    }
    assert.deepEqual((await readBoardCommit(b.repo, await commitWith([...base, T('Cowork-Writer', good)]))).writer, writerAt(b, 3));

    // formatWriter/parseWriter share the op id grammar.
    assert.equal(formatWriter(writerAt(b, 12)), `${b.peer}/${b.epoch}/12`);
    assert.deepEqual(parseWriter(formatWriter(writerAt(b, 12))), writerAt(b, 12));
    assert.equal(parseWriter(`${b.peer}/${b.epoch}/0`), null);
    assert.throws(() => formatWriter(writerAt(b, 0)));
  } finally {
    await b.f.cleanup();
  }
});

/** A board commit on [B0, L0] whose tree is B0's with the named top-level entries replaced (null: removed). */
async function boardWith(b: Board, B0: Oid, L0: Oid, replace: Record<string, MktreeEntry | null>): Promise<Oid> {
  const entries = asMktree(await topLevel(b.repo, B0)).filter((e) => !(e.name in replace));
  for (const e of Object.values(replace)) if (e !== null) entries.push(e);
  const tree = await b.repo.mktree(entries);
  return b.repo.commitTree({ tree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: boardTrailers(writerAt(b, 4), [], new Map()) });
}
async function blobEntry(b: Board, name: string, bytes: Buffer): Promise<MktreeEntry> {
  return { name, mode: '100644', type: 'blob', oid: await b.repo.hashBytes(bytes, true) };
}

/** What protocol.json reads as when it is absent (readProtocol(null)). */
const PROTOCOL_ABSENT = { proto: 0, regionSpec: '', budget: 6, G_s: 10, S_s: 3 };

// Final review FA-1: a teammate (or a foreign tool) can push a board commit whose header git and fsck accept but
// that a reader keeping the LAST tree line, every `parent` line or only lower-case hex misreads: every peer then
// crashes (OidError, a phantom parent's `bad object`), raises a false incident, or folds a tree git does not
// associate with the commit. The readers must see exactly git's tree and parents (repo.test.ts pins readCommit).
test('readBoardCommit, readCommitsChecked and checkBoardCommits read a board commit header as git does', async () => {
  const b = await setup('board-header-parity');
  try {
    const { L0, B0 } = await genesis(b);
    const honest = await boardWith(b, B0, L0, {});
    const raw = (await b.repo.run(['cat-file', 'commit', honest])).stdout.toString('utf8');
    const split = raw.indexOf('\n\n');
    const head = raw.slice(0, split).split('\n');
    const message = raw.slice(split + 2);
    assert.deepEqual(head.slice(0, 3).map((l) => l.split(' ')[0]), ['tree', 'parent', 'parent']);
    const [treeLine, , , ...ident] = head;
    const tree = treeLine!.slice(5) as Oid;
    const missing = '0123456789abcdef'.repeat(4).slice(0, tree.length);
    const up = (o: string): string => o.toUpperCase();
    const variants: Array<[string, string]> = [
      ['upper-case hex', [`tree ${up(tree)}`, `parent ${up(B0)}`, `parent ${up(L0)}`, ...ident].join('\n')],
      ['a parent after the committer line naming an existing commit', [treeLine!, `parent ${B0}`, `parent ${L0}`, ...ident, `parent ${b.hr}`].join('\n')],
      ['a parent after the committer line naming a missing object', [treeLine!, `parent ${B0}`, `parent ${L0}`, ...ident, `parent ${missing}`].join('\n')],
      ['a tree after the committer line naming a missing object', [treeLine!, `parent ${B0}`, `parent ${L0}`, ...ident, `tree ${missing}`].join('\n')],
      ['a tree after the committer line naming an older board tree', [treeLine!, `parent ${B0}`, `parent ${L0}`, ...ident, `tree ${await b.repo.emptyTree()}`].join('\n')],
    ];
    const want = await readBoardCommit(b.repo, honest);
    for (const [what, header] of variants) {
      const c = (await b.repo.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { stdin: Buffer.from(`${header}\n\n${message}`, 'utf8') })).stdout.toString('utf8').trim() as Oid;
      const gitView = (await b.repo.run(['log', '-1', '--format=%T %P', c])).stdout.toString('utf8').trim();
      assert.equal(gitView, `${tree} ${B0} ${L0}`, `${what}: git reads the first tree and the two parents`);
      assert.deepEqual(await readBoardCommit(b.repo, c), { ...want, oid: c }, `${what}: readBoardCommit`);
      const [checked] = await checkBoardCommits(b.repo, [c]);
      assert.equal(checked?.refused, null, `${what}: checkBoardCommits refuses nothing`);
      assert.deepEqual(checked?.commit?.parents, [B0, L0], what);
      assert.equal(checked?.commit?.tree, tree, what);
      assert.ok(boardShapeOk(checked!.commit!, B0), `${what}: a board-only publish on B0`);
      const [read] = await readCommitsChecked(b.repo, [c]);
      assert.deepEqual([read?.commit?.tree, read?.commit?.parents], [tree, [B0, L0]], `${what}: readCommitsChecked`);
    }
  } finally {
    await b.f.cleanup();
  }
});

interface Traced {
  calls: Array<{ args: string[]; stdin: string }>;
  /** readBoardCommit through the spy runner; the error is returned instead of thrown; calls holds only its calls. */
  read: (commit: Oid) => Promise<unknown>;
  /** A cat-file call that reads an object's content (not --batch-check in any format, -t or -s) and names oid or `name`. */
  readsContentOf: (oid: Oid, name: string) => boolean;
}
/** The runner trace: every git call readBoardCommit makes, with its stdin. */
function traced(b: Board): Traced {
  const calls: Traced['calls'] = [];
  const spy: GitRunner = {
    run(args, opts) {
      calls.push({ args: [...args], stdin: opts.stdin?.toString('latin1') ?? '' });
      return b.f.runner.run(args, opts);
    },
  };
  const repo = new GitRepo(spy, b.f.paths, fixtureContext);
  return {
    calls,
    read: async (commit) => {
      calls.length = 0;
      try {
        return await readBoardCommit(repo, commit);
      } catch (e) {
        return e;
      }
    },
    readsContentOf: (oid, name) => calls.some((c) =>
      c.args[0] === 'cat-file' && !c.args.some((a) => a.startsWith('--batch-check') || a === '-t' || a === '-s')
      && [oid, name].some((x) => c.args.some((a) => a.includes(x)) || c.stdin.includes(x))),
  };
}
const sizeOf = async (b: Board, o: Oid): Promise<number> => Number((await b.repo.run(['cat-file', '-s', o])).stdout.toString('utf8').trim());
/** readBoardCommit's first call: the type and size of the unpeeled oid, before anything is read. */
const TYPE_PROBE = ['cat-file', '--batch-check=%(objecttype) %(objectsize)'];

test('readBoardCommit returns the first 1,000 lines of an ops.jsonl of at most 64 KiB as stored; a line that is not UTF-8 reads as an empty line', async () => {
  const b = await setup('board-opslines');
  try {
    const { L0, B0 } = await genesis(b);
    const withEntries = (replace: Record<string, MktreeEntry | null>): Promise<Oid> => boardWith(b, B0, L0, replace);
    const linesOfBytes = async (bytes: Buffer): Promise<string[]> => (await readBoardCommit(b.repo, await withEntries({ 'ops.jsonl': await blobEntry(b, 'ops.jsonl', bytes) }))).opsLines;
    const linesOf = (text: string): Promise<string[]> => linesOfBytes(Buffer.from(text, 'utf8'));

    // 1,005 lines: the first 1,000.
    const many = Array.from({ length: 1_005 }, (_, i) => `L${i}`);
    assert.deepEqual(await linesOf(`${many.join('\n')}\n`), many.slice(0, 1_000));
    // A file of exactly 65,536 bytes is read in full, its unterminated last line included (one byte more is a
    // malformed board commit: see the oversize test below).
    const row = (i: number): string => `${String(i).padStart(4, '0')}${'a'.repeat(95)}`;
    const rows = Array.from({ length: 655 }, (_, i) => row(i));
    const atCap = `${rows.join('\n')}\n${'z'.repeat(36)}`;
    assert.equal(Buffer.byteLength(atCap), 65_536);
    assert.deepEqual(await linesOf(atCap), [...rows, 'z'.repeat(36)]);
    // As stored: a blank line and a CR stay; only the final LF ends the file.
    assert.deepEqual(await linesOf('a\r\n\nb\n'), ['a\r', '', 'b']);
    assert.deepEqual(await linesOf(''), []);

    // Decoding is strict UTF-8 per line (PRO-03). A note op with an invalid byte inside its text would parse
    // after a lossy decode (as U+FFFD); it reads as an empty line instead, a no-op that keeps its position.
    const ops = [eventOp(b, 5), eventOp(b, 6)].map((o) => canonicalJson(o as unknown as Json));
    const noteWith = (bad: number[]): Buffer => Buffer.concat([
      Buffer.from(`{"id":"${opId(b, 7)}","target":null,"text":"x`, 'utf8'), Buffer.from(bad), Buffer.from('","type":"note"}', 'utf8'),
    ]);
    const lossy = noteWith([0xff]).toString('utf8');
    assert.notEqual(parseOpLine(lossy), null, 'the lossy decoding would be a valid op');
    for (const bad of [[0xff], [0xc3], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      const file = Buffer.concat([Buffer.from(`${ops[0]}\n`), noteWith(bad), Buffer.from(`\n${ops[1]}\n`)]);
      const lines = await linesOfBytes(file);
      assert.deepEqual(lines, [ops[0], '', ops[1]], `bytes ${bad.map((x) => x.toString(16)).join(' ')}`);
      assert.deepEqual(lines.map((l) => parseOpLine(l) === null), [false, true, false]);
    }
    // An unterminated last line is decoded the same way; valid multi-byte UTF-8 is kept as is.
    assert.deepEqual(await linesOfBytes(Buffer.concat([Buffer.from(`${ops[0]}\n`), noteWith([0xff])])), [ops[0], '']);
    const hangul = `{"id":"${opId(b, 7)}","target":null,"text":"\u{d55c}\u{ae00}","type":"note"}`;
    assert.deepEqual(await linesOf(`${hangul}\n`), [hangul]);
    // A BOM is kept as stored (never stripped by the decoder), so a BOM-prefixed line stays malformed.
    const bomLines = await linesOfBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${ops[0]}\n`)]));
    assert.deepEqual(bomLines, [`\u{feff}${ops[0]}`]);
    assert.equal(parseOpLine(bomLines[0]!), null);

    // Missing or mistyped entries other than the checkpoint: no ops, protocol read as missing (proto 0), no held ids.
    const empty = await b.repo.mktree([{ name: 'x', mode: '100644', type: 'blob', oid: await b.repo.hashBytes(Buffer.alloc(0), true) }]);
    const xBlob = await b.repo.hashBytes(Buffer.from('x'), true);
    const odd = await readBoardCommit(b.repo, await withEntries({
      'ops.jsonl': { name: 'ops.jsonl', mode: '040000', type: 'tree', oid: empty },
      'protocol.json': null,
      held: { name: 'held', mode: '100644', type: 'blob', oid: xBlob },
    }));
    assert.deepEqual(odd.opsLines, []);
    assert.deepEqual(odd.protocol, { proto: 0, regionSpec: '', budget: 6, G_s: 10, S_s: 3 });
    assert.deepEqual(odd.checkpoint, (await readBoardCommit(b.repo, B0)).checkpoint, 'the checkpoint B0 carries');
    assert.deepEqual(odd.heldIds, []);
    // A missing or mistyped checkpoint/state.json (final review FA-2): every honest board commit carries one (PRO-02; B0
    // writes it, later commits carry it), and a publish on such a board could not carry it, so it is a malformed board
    // commit for every reader (entry_missing → the incident check's board_shape), never an absent entry.
    const stateOnly = await b.repo.mktree([{ name: 'other.json', mode: '100644', type: 'blob', oid: xBlob }]);
    const stateTree = await b.repo.mktree([{ name: 'state.json', mode: '040000', type: 'tree', oid: empty }]);
    for (const [what, ck] of [
      ['no checkpoint/', null],
      ['checkpoint is a blob', { name: 'checkpoint', mode: '100644', type: 'blob', oid: xBlob }],
      ['checkpoint/ without state.json', { name: 'checkpoint', mode: '040000', type: 'tree', oid: stateOnly }],
      ['checkpoint/state.json is a tree', { name: 'checkpoint', mode: '040000', type: 'tree', oid: stateTree }],
    ] as Array<[string, MktreeEntry | null]>) {
      await assert.rejects(readBoardCommit(b.repo, await withEntries({ checkpoint: ck })), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'entry_missing', what);
    }
    // A commit that is not a commit, or has no parent, is not a board commit.
    await assert.rejects(readBoardCommit(b.repo, empty), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'not_commit');
    const orphan = await b.repo.commitTree({ tree: empty, parents: [], subject: BOARD_SUBJECT, trailers: [] });
    await assert.rejects(readBoardCommit(b.repo, orphan), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'no_parent' && /parent/.test(e.message));
  } finally {
    await b.f.cleanup();
  }
});

test('readBoardCommit treats an oversized ops.jsonl, checkpoint or board tree as a malformed board commit without reading it', async () => {
  const b = await setup('board-oversize');
  try {
    const { L0, B0 } = await genesis(b);
    assert.equal(BOARD_TREE_MAX_BYTES, 5_000_000);
    const { calls, read, readsContentOf } = traced(b);
    const malformed = (r: unknown, reason: string): boolean => r instanceof BoardMalformedError && r.reason === reason;

    // ops.jsonl: 64 KiB is read (and the trace sees the read); 64 KiB + 1 and 65 KiB + 1 are malformed and never read.
    const opsOf = (n: number): Buffer => Buffer.from(`${'x'.repeat(n - 1)}\n`, 'utf8');
    const okOps = await blobEntry(b, 'ops.jsonl', opsOf(OPS_MAX_BYTES));
    const ok = await read(await boardWith(b, B0, L0, { 'ops.jsonl': okOps }));
    assert.ok(!(ok instanceof Error), String(ok));
    assert.ok(readsContentOf(okOps.oid, ':ops.jsonl'), 'the trace sees a content read');
    for (const size of [OPS_MAX_BYTES + 1, 65 * 1_024 + 1, 3 * 1_024 * 1_024]) {
      const big = await blobEntry(b, 'ops.jsonl', opsOf(size));
      const r = await read(await boardWith(b, B0, L0, { 'ops.jsonl': big }));
      assert.ok(malformed(r, 'ops_too_large'), `${size}: ${String(r)}`);
      assert.ok(!readsContentOf(big.oid, ':ops.jsonl'), `${size}: the blob was read`);
      assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [TYPE_PROBE, ['cat-file', 'commit'], ['cat-file', '--batch-check']], `${size}: sizes first, nothing read`);
    }

    // checkpoint/state.json, protocol.json and ops.jsonl together are at most 5 MB (02-protocol §3.1 board tree size).
    const b0 = await readBoardCommit(b.repo, B0);
    const opsSize = (await b.repo.readBlob((await b.repo.readTreeMap((await b.repo.readCommit(B0)).tree)).get('ops.jsonl')!.oid)).length;
    const protoSize = serializeProtocol(b0.protocol).length;
    const checkpointEntry = async (bytes: Buffer): Promise<{ entry: MktreeEntry; blob: Oid }> => {
      const blob = await b.repo.hashBytes(bytes, true);
      const tree = await b.repo.mktree([{ name: 'state.json', mode: '100644', type: 'blob', oid: blob }]);
      return { entry: { name: 'checkpoint', mode: '040000', type: 'tree', oid: tree }, blob };
    };
    const fits = await checkpointEntry(Buffer.alloc(BOARD_TREE_MAX_BYTES - opsSize - protoSize, 0x20));
    const fitsData = await read(await boardWith(b, B0, L0, { checkpoint: fits.entry }));
    assert.ok(!(fitsData instanceof Error), String(fitsData));
    assert.equal((fitsData as { checkpoint: Buffer }).checkpoint.length, BOARD_TREE_MAX_BYTES - opsSize - protoSize);
    for (const size of [BOARD_TREE_MAX_BYTES - opsSize - protoSize + 1, BOARD_TREE_MAX_BYTES + 1]) {
      const over = await checkpointEntry(Buffer.alloc(size, 0x20));
      const r = await read(await boardWith(b, B0, L0, { checkpoint: over.entry }));
      assert.ok(malformed(r, 'board_too_large'), `checkpoint ${size}: ${String(r)}`);
      assert.ok(!readsContentOf(over.blob, ':checkpoint/state.json'), `checkpoint ${size}: the blob was read`);
    }
    const bigProto = await blobEntry(b, 'protocol.json', Buffer.alloc(BOARD_TREE_MAX_BYTES + 1, 0x20));
    const rp = await read(await boardWith(b, B0, L0, { 'protocol.json': bigProto }));
    assert.ok(malformed(rp, 'board_too_large'), String(rp));
    assert.ok(!readsContentOf(bigProto.oid, ':protocol.json'));

    // A held/ tree object over 5 MB is malformed too (an honest board's held/ lists at most 5,000 ids).
    const sub = await b.repo.mktree([{ name: 'a.txt', mode: '100644', type: 'blob', oid: await b.repo.hashBytes(Buffer.from('x'), true) }]);
    const heldNames = Array.from({ length: 22_100 }, (_, i) => `${String(i).padStart(6, '0')}${'h'.repeat(194)}`);
    const held = await b.repo.mktree(heldNames.map((name) => ({ name, mode: '040000', type: 'tree', oid: sub })));
    const heldSize = (await b.repo.blobSizes([held]))[0]!;
    assert.ok(heldSize > BOARD_TREE_MAX_BYTES, String(heldSize));
    const rh = await read(await boardWith(b, B0, L0, { held: { name: 'held', mode: '040000', type: 'tree', oid: held } }));
    assert.ok(malformed(rh, 'board_too_large'), String(rh));
    assert.ok(!readsContentOf(held, ':held'));
  } finally {
    await b.f.cleanup();
  }
});

test('readBoardCommit reads a gitlink at ops.jsonl, protocol.json, checkpoint/state.json or held as an absent entry, never an error', async () => {
  const b = await setup('board-gitlink');
  try {
    const { L0, B0 } = await genesis(b);
    const full = await readBoardCommit(b.repo, B0);
    // A gitlink whose commit this clone does not have (git 2.46+ prints `<oid> submodule` for it, a 2-part record
    // like `missing`) and one whose commit exists (`<oid> commit <size>`: present, but not a blob or a tree).
    const absentCommit = '1'.repeat(L0.length) as Oid;
    for (const [what, target] of [['a missing commit', absentCommit], ['an existing commit', L0]] as const) {
      const link = (name: string): MktreeEntry => ({ name, mode: '160000', type: 'commit', oid: target });
      const linkedState = await b.repo.mktree([link('state.json')]);
      const linkedCheckpoint: MktreeEntry = { name: 'checkpoint', mode: '040000', type: 'tree', oid: linkedState };
      const cases: Array<[string, Record<string, MktreeEntry | null>, Partial<BoardCommitData>]> = [
        ['ops.jsonl', { 'ops.jsonl': link('ops.jsonl') }, { opsLines: [] }],
        ['protocol.json', { 'protocol.json': link('protocol.json') }, { protocol: PROTOCOL_ABSENT }],
        ['held', { held: link('held') }, { heldIds: [] }],
        [
          'all three of them',
          { 'ops.jsonl': link('ops.jsonl'), 'protocol.json': link('protocol.json'), held: link('held') },
          { opsLines: [], protocol: PROTOCOL_ABSENT, heldIds: [] },
        ],
      ];
      for (const [name, replace, absent] of cases) {
        const oid = await boardWith(b, B0, L0, replace);
        let data: BoardCommitData;
        try {
          data = await readBoardCommit(b.repo, oid);
        } catch (e) {
          assert.fail(`a gitlink to ${what} at ${name} threw: ${String(e)}`);
        }
        assert.deepEqual(data, { ...full, oid, parents: [B0, L0], firstParent: B0, liveCode: L0, writer: writerAt(b, 4), ...absent }, `a gitlink to ${what} at ${name}`);
      }
      // A gitlink at checkpoint or checkpoint/state.json leaves no checkpoint/state.json blob: the board commit is
      // malformed (final review FA-2, entry_missing), a typed refusal and never an error of another kind.
      for (const [name, replace] of [
        ['checkpoint', { checkpoint: link('checkpoint') }],
        ['checkpoint/state.json', { checkpoint: linkedCheckpoint }],
        ['all four', { 'ops.jsonl': link('ops.jsonl'), 'protocol.json': link('protocol.json'), checkpoint: linkedCheckpoint, held: link('held') }],
      ] as Array<[string, Record<string, MktreeEntry | null>]>) {
        await assert.rejects(readBoardCommit(b.repo, await boardWith(b, B0, L0, replace)),
          (e: unknown) => e instanceof BoardMalformedError && e.reason === 'entry_missing', `a gitlink to ${what} at ${name}`);
      }
    }
  } finally {
    await b.f.cleanup();
  }
});

test('readBoardCommit refuses a board commit object over BOARD_COMMIT_OBJECT_MAX_BYTES after a size check, without reading it', async () => {
  const b = await setup('board-commitcap');
  try {
    const { L0, B0 } = await genesis(b);
    assert.equal(BOARD_COMMIT_OBJECT_MAX_BYTES, 1_048_576);
    const { calls, read } = traced(b);
    const tree = (await b.repo.readCommit(B0)).tree;
    const head = boardTrailers(writerAt(b, 4), [], new Map());
    // A board commit padded by one long trailer value (no LF): its object size grows byte for byte with the pad.
    const padded = (pad: number): Promise<Oid> =>
      b.repo.commitTree({ tree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: [...head, T('Cowork-Pad', 'p'.repeat(pad))] });
    const probe = await sizeOf(b, await padded(1));
    const atCap = await padded(1 + BOARD_COMMIT_OBJECT_MAX_BYTES - probe);
    assert.equal(await sizeOf(b, atCap), BOARD_COMMIT_OBJECT_MAX_BYTES);
    const ok = await read(atCap);
    assert.ok(!(ok instanceof Error), String(ok));
    assert.deepEqual((ok as BoardCommitData).writer, writerAt(b, 4));
    assert.ok(calls.some((c) => c.args[0] === 'cat-file' && c.args[1] === 'commit'), 'the trace sees the commit read');

    // A message of exactly 1 MiB + 1 bytes.
    const messageBase = formatMessage(BOARD_SUBJECT, [...head, T('Cowork-Pad', '')]).length;
    const mib1 = 1_048_576 + 1 - messageBase;
    assert.equal(formatMessage(BOARD_SUBJECT, [...head, T('Cowork-Pad', 'p'.repeat(mib1))]).length, 1_048_577);
    // One byte over the cap, that message, and 3 MiB: malformed, after one size check and nothing else.
    for (const commit of [await padded(2 + BOARD_COMMIT_OBJECT_MAX_BYTES - probe), await padded(mib1), await padded(3 * 1_048_576)]) {
      const size = await sizeOf(b, commit);
      assert.ok(size > BOARD_COMMIT_OBJECT_MAX_BYTES, String(size));
      const r = await read(commit);
      assert.ok(r instanceof BoardMalformedError && r.reason === 'commit_too_large', `${size}: ${String(r)}`);
      assert.deepEqual(calls.map((c) => c.args), [TYPE_PROBE], `${size}: the commit object is never read`);
      assert.equal(calls[0]!.stdin, `${commit}\n`, `${size}: the probe names the unpeeled oid`);
    }
  } finally {
    await b.f.cleanup();
  }
});

test('readBoardCommit refuses an oid naming a tag, a tree or a blob as not_commit after one type-and-size check of the unpeeled oid, never peeling a tag past the size cap', async () => {
  const b = await setup('board-notcommit');
  try {
    const { L0, B0 } = await genesis(b);
    const { calls, read } = traced(b);
    const notCommit = (r: unknown): boolean => r instanceof BoardMalformedError && r.reason === 'not_commit';
    /** Exactly one call, the type probe of the unpeeled oid: no `cat-file commit`, nothing read. */
    const probedOnly = (oid: Oid, what: string): void => {
      assert.deepEqual(calls.map((c) => c.args), [TYPE_PROBE], `${what}: one type-and-size check`);
      assert.equal(calls[0]!.stdin, `${oid}\n`, `${what}: the probe names the unpeeled oid`);
      assert.ok(!calls.some((c) => c.args[0] === 'cat-file' && c.args[1] === 'commit'), `${what}: no cat-file commit`);
    };
    /** An annotated tag object, as a hostile pusher could point a board ref at. */
    const tagOf = async (target: Oid, type: 'commit' | 'tag', name: string): Promise<Oid> => {
      const body = `object ${target}\ntype ${type}\ntag ${name}\ntagger ${DISPLAY} <${b.peer}@cowork.invalid> 0 +0000\n\nboard\n`;
      return (await b.repo.run(['mktag'], { stdin: Buffer.from(body, 'utf8') })).stdout.toString('utf8').trim() as Oid;
    };

    // (a) A small tag wrapping a 3 MiB board commit. `cat-file commit <tag>` peels it and reads the whole commit;
    // a size check of the tag object itself (the old `cat-file -s`) sees only the small tag.
    const tree = (await b.repo.readCommit(B0)).tree;
    const head = boardTrailers(writerAt(b, 4), [], new Map());
    const huge = await b.repo.commitTree({ tree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: [...head, T('Cowork-Pad', 'p'.repeat(3 * 1_048_576))] });
    assert.ok((await sizeOf(b, huge)) > BOARD_COMMIT_OBJECT_MAX_BYTES);
    const bigTag = await tagOf(huge, 'commit', 'big');
    assert.ok((await sizeOf(b, bigTag)) < 1_024, 'the tag object itself is small');
    assert.ok((await b.repo.run(['cat-file', 'commit', bigTag])).stdout.length > BOARD_COMMIT_OBJECT_MAX_BYTES, 'cat-file commit peels a tag');
    const ra = await read(bigTag);
    assert.ok(notCommit(ra), `a tag of an over-cap commit: ${String(ra)}`);
    probedOnly(bigTag, 'a tag of an over-cap commit');
    // (c) The over-cap commit itself is still commit_too_large, after the same single probe.
    const rh = await read(huge);
    assert.ok(rh instanceof BoardMalformedError && rh.reason === 'commit_too_large', `the over-cap commit: ${String(rh)}`);
    probedOnly(huge, 'the over-cap commit');

    // (b) A tag wrapping an ordinary board commit is refused too: a board ref names a commit, never a tag.
    const b0 = await read(B0);
    assert.ok(!(b0 instanceof Error), `B0 itself reads: ${String(b0)}`);
    const smallTag = await tagOf(B0, 'commit', 'b0');
    const rb = await read(smallTag);
    assert.ok(notCommit(rb), `a tag of B0: ${String(rb)}`);
    probedOnly(smallTag, 'a tag of B0');
    const tagOfTag = await tagOf(smallTag, 'tag', 'b0-again');
    const rt = await read(tagOfTag);
    assert.ok(notCommit(rt), `a tag of a tag: ${String(rt)}`);
    probedOnly(tagOfTag, 'a tag of a tag');

    // A tree or a blob is not a commit either, whatever its size: the type is checked before the size.
    const smallBlob = await b.repo.hashBytes(Buffer.from('x'), true);
    const bigBlob = await b.repo.hashBytes(Buffer.alloc(BOARD_COMMIT_OBJECT_MAX_BYTES + 1, 0x20), true);
    for (const [what, oid] of [['a tree', tree], ['a blob', smallBlob], ['an over-cap blob', bigBlob]] as const) {
      const r = await read(oid);
      assert.ok(notCommit(r), `${what}: ${String(r)}`);
      probedOnly(oid, what);
    }

    // A missing oid is not board content: an Error, never BoardMalformedError (callers would blame the board).
    const missing = '1'.repeat(L0.length) as Oid;
    const rm = await read(missing);
    assert.ok(rm instanceof Error && !(rm instanceof BoardMalformedError) && /missing/.test(rm.message), `a missing oid: ${String(rm)}`);
    probedOnly(missing, 'a missing oid');
  } finally {
    await b.f.cleanup();
  }
});

test('buildBoardCommit refuses with BoardCapError a board commit readBoardCommit would refuse: the 5 MB board tree, an over-cap held/ and the commit object cap', async () => {
  const b = await setup('board-buildcap');
  try {
    const { L0, B0, build } = await genesis(b);
    const capError = (e: unknown): boolean => e instanceof BoardCapError;
    const protoBytes = serializeProtocol(genesisProtocol(12, RS)).length;

    // B0: a checkpoint that makes the three files exactly 5 MB builds and reads back; one byte more is refused.
    const fit0 = BOARD_TREE_MAX_BYTES - serializeOps(build.ops).length - protoBytes;
    const B0fit = await buildBoardCommit(b.repo, { ...build, checkpoint: Buffer.alloc(fit0, 0x20) });
    assert.equal((await readBoardCommit(b.repo, B0fit)).checkpoint?.length, fit0);
    await assert.rejects(buildBoardCommit(b.repo, { ...build, checkpoint: Buffer.alloc(fit0 + 1, 0x20) }), capError);

    // A later commit: a new checkpoint counts with the new ops.jsonl and the carried protocol.json.
    const later: BoardBuild = { prevBoard: B0, liveCode: L0, writer: writerAt(b, 8), ops: [eventOp(b, 5)], cs: [], csPaths: new Map(), protocol: null, checkpoint: null };
    const fit = BOARD_TREE_MAX_BYTES - serializeOps([eventOp(b, 5)]).length - protoBytes;
    const Bfit = await buildBoardCommit(b.repo, { ...later, checkpoint: Buffer.alloc(fit, 0x20) });
    assert.equal((await readBoardCommit(b.repo, Bfit)).checkpoint?.length, fit);
    await assert.rejects(buildBoardCommit(b.repo, { ...later, checkpoint: Buffer.alloc(fit + 1, 0x20) }), capError);
    // A carried checkpoint counts too: on top of Bfit, an ops.jsonl of the same length fits, a longer one does not.
    assert.equal(serializeOps([eventOp(b, 7)]).length, serializeOps([eventOp(b, 5)]).length);
    const Bcarry = await buildBoardCommit(b.repo, { ...later, prevBoard: Bfit, ops: [eventOp(b, 7)] });
    assert.equal((await readBoardCommit(b.repo, Bcarry)).checkpoint?.length, fit);
    await assert.rejects(buildBoardCommit(b.repo, { ...later, prevBoard: Bfit, ops: [eventOp(b, 5), eventOp(b, 7)] }), capError);

    // held/: a previous board whose held/ tree object is over the cap reads as malformed, and nothing is built on it.
    const sub = await b.repo.mktree([{ name: 'a.txt', mode: '100644', type: 'blob', oid: await b.repo.hashBytes(Buffer.from('x'), true) }]);
    const heldNames = Array.from({ length: 22_100 }, (_, i) => `${String(i).padStart(6, '0')}${'h'.repeat(194)}`);
    const held = await b.repo.mktree(heldNames.map((name) => ({ name, mode: '040000', type: 'tree', oid: sub })));
    const Bheld = await boardWith(b, B0, L0, { held: { name: 'held', mode: '040000', type: 'tree', oid: held } });
    await assert.rejects(readBoardCommit(b.repo, Bheld), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'board_too_large');
    await assert.rejects(buildBoardCommit(b.repo, { ...later, prevBoard: Bheld }), capError);

    // The commit object: Cowork-CS-Paths lists of incompressible 4,000-byte paths. One change-set's list (about
    // 0.7 MB of trailer) builds and reads back; two put the board commit object over 1 MiB and are refused.
    const hexPath = (seed: string): string => {
      let s = '';
      let h = seed;
      while (s.length < 4_000) {
        h = createHash('sha256').update(h).digest('hex');
        s += h;
      }
      return s.slice(0, 4_000);
    };
    const csOf = (n: number): [CsTrailer, string[]] => [
      { csId: `${b.peer}/human/${n}`, state: 'closed', seq: n, origin: 'human', checks: 'skipped', paths: 256 },
      Array.from({ length: 256 }, (_, i) => hexPath(`${n}/${i}`)),
    ];
    const withCs = (list: Array<[CsTrailer, string[]]>): BoardBuild => ({ ...later, cs: list.map(([c]) => c), csPaths: new Map(list.map(([c, p]) => [c.csId, p])) });
    const one = withCs([csOf(1)]);
    const Bone = await buildBoardCommit(b.repo, one);
    const oneSize = await sizeOf(b, Bone);
    assert.ok(oneSize > 600_000 && oneSize <= BOARD_COMMIT_OBJECT_MAX_BYTES, String(oneSize));
    assert.deepEqual((await readBoardCommit(b.repo, Bone)).cs, one.cs);
    const two = withCs([csOf(1), csOf(2)]);
    await assert.rejects(buildBoardCommit(b.repo, two), capError);
    // The same commit made by hand is one readBoardCommit refuses.
    const byHand = await b.repo.commitTree({ tree: (await b.repo.readCommit(Bone)).tree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: boardTrailers(two.writer, two.cs, two.csPaths) });
    assert.ok((await sizeOf(b, byHand)) > BOARD_COMMIT_OBJECT_MAX_BYTES);
    await assert.rejects(readBoardCommit(b.repo, byHand), (e: unknown) => e instanceof BoardMalformedError && e.reason === 'commit_too_large');
  } finally {
    await b.f.cleanup();
  }
});

// Final review FA-2: readers used to read a board tree without checkpoint/state.json as "no checkpoint", so the incident
// check and the fold accepted it, and the next publish's buildBoardCommit threw a plain Error (no checkpoint to carry):
// every peer with local work crashed in a respawn loop with no INCIDENT. Every reader now refuses it (entry_missing →
// board_shape), and the builder's "nothing to carry" refusals are typed (publish's build_failed), never a plain Error.
test('a board tree without checkpoint/state.json is malformed (entry_missing) for checkBoardCommits and readBoardCommit, and buildBoardCommit refuses a previous board it cannot carry from with BoardMalformedError', async () => {
  const b = await setup('board-nocheckpoint');
  try {
    const { L0, B0 } = await genesis(b);
    const entryMissing = (e: unknown): boolean => e instanceof BoardMalformedError && e.reason === 'entry_missing';
    const honest = await boardWith(b, B0, L0, {});
    const noCheckpoint = await boardWith(b, B0, L0, { checkpoint: null });
    const noProtocol = await boardWith(b, B0, L0, { 'protocol.json': null });
    assert.deepEqual((await checkBoardCommits(b.repo, [honest, noCheckpoint, noProtocol, B0])).map((c) => c.refused), [null, 'entry_missing', null, null]);
    await assert.rejects(readBoardCommit(b.repo, noCheckpoint), entryMissing);
    // A missing protocol.json still reads as proto 0 (the VERSION pause; a spec gap left to Plan 7), but nothing can
    // carry it either: the builder refuses both with a typed error.
    assert.equal((await readBoardCommit(b.repo, noProtocol)).protocol.proto, 0);
    const later: BoardBuild = { prevBoard: honest, liveCode: L0, writer: writerAt(b, 8), ops: [eventOp(b, 5)], cs: [], csPaths: new Map(), protocol: null, checkpoint: null };
    assert.equal((await readBoardCommit(b.repo, await buildBoardCommit(b.repo, later))).checkpoint?.length, (await readBoardCommit(b.repo, B0)).checkpoint?.length, 'control: an honest previous board carries');
    await assert.rejects(buildBoardCommit(b.repo, { ...later, prevBoard: noCheckpoint }), entryMissing);
    await assert.rejects(buildBoardCommit(b.repo, { ...later, prevBoard: noProtocol }), entryMissing);
  } finally {
    await b.f.cleanup();
  }
});

// Final review minor (board): the root tree object of a board commit was never size-checked, so a root tree with a
// million stray entries passed every cap and topEntries listed all of it into memory on every publish. An honest root
// holds at most four entries (PRO-02): ops.jsonl, protocol.json, checkpoint/ and held/.
test('a board root tree object over BOARD_ROOT_TREE_MAX_BYTES is malformed for every reader, after one size check and without being listed', async () => {
  const b = await setup('board-roottree');
  try {
    const { L0, B0 } = await genesis(b);
    assert.equal(BOARD_ROOT_TREE_MAX_BYTES, 4_096);
    const { calls, read } = traced(b);
    const blob = await b.repo.hashBytes(Buffer.from('stray\n'), true);
    const b0Entries = asMktree(await topLevel(b.repo, B0));
    const rootWith = async (fillers: MktreeEntry[]): Promise<{ commit: Oid; size: number }> => {
      const tree = await b.repo.mktree([...b0Entries, ...fillers]);
      const commit = await b.repo.commitTree({ tree, parents: [B0, L0], subject: BOARD_SUBJECT, trailers: boardTrailers(writerAt(b, 4), [], new Map()) });
      return { commit, size: await sizeOf(b, tree) };
    };
    const filler = (name: string): MktreeEntry => ({ name, mode: '100644', type: 'blob', oid: blob });
    // Stray entries of 100-byte names, then one whose name length makes the tree object exactly the cap.
    const strays = Array.from({ length: 20 }, (_, i) => filler(`s${String(i).padStart(99, '0')}`));
    const base = await rootWith(strays);
    const perEntry = (await rootWith([...strays, filler('t')])).size - base.size - 1;   // `100644 ` + name + NUL + hash, minus the 1-byte name
    const atCap = await rootWith([...strays, filler('t'.repeat(BOARD_ROOT_TREE_MAX_BYTES - base.size - perEntry))]);
    assert.equal(atCap.size, BOARD_ROOT_TREE_MAX_BYTES);
    const ok = await read(atCap.commit);
    assert.ok(!(ok instanceof Error), String(ok));
    assert.deepEqual((await checkBoardCommits(b.repo, [atCap.commit]))[0]?.refused, null);
    const over = await rootWith([...strays, filler('t'.repeat(BOARD_ROOT_TREE_MAX_BYTES - base.size - perEntry + 1))]);
    assert.equal(over.size, BOARD_ROOT_TREE_MAX_BYTES + 1);
    for (const commit of [over.commit, (await rootWith(Array.from({ length: 3_000 }, (_, i) => filler(`m${i}`)))).commit]) {
      const r = await read(commit);
      assert.ok(r instanceof BoardMalformedError && r.reason === 'board_too_large', String(r));
      assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [TYPE_PROBE, ['cat-file', 'commit'], ['cat-file', '--batch-check']], 'sizes first, nothing listed or read');
      assert.deepEqual((await checkBoardCommits(b.repo, [commit]))[0]?.refused, 'board_too_large');
    }
  } finally {
    await b.f.cleanup();
  }
});

test('boardShapeOk and liveShape accept the three live shapes and reject a last parent that jumps to a non-descendant', async () => {
  const b = await setup('board-shapes');
  try {
    const { L0, B0 } = await genesis(b);
    const info = (o: Oid) => b.repo.readCommit(o);
    const live = (seq: number, base: Oid | null): Trailer[] => liveCommitTrailers(writerAt(b, seq), ['human'], [], new Map(), base);
    // Genesis: L0 (no parents, Cowork-Base: Hr), B0 = [L0].
    assert.equal(liveShape(await info(L0), null), 'genesis');
    assert.equal(boardShapeOk(await info(B0), null), true);
    // Ordinary: L1 = [L0], B1 = [B0, L1].
    const L1 = await codeCommit(b, [L0], 'one\n', live(5, null));
    const B1 = await buildBoardCommit(b.repo, { prevBoard: B0, liveCode: L1, writer: writerAt(b, 5), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
    assert.equal(liveShape(await info(L1), L0), 'ordinary');
    assert.equal(boardShapeOk(await info(B1), B0), true);
    // Base move: Lm = [L1, X] with Cowork-Base: X (X a branch commit).
    const X = await b.repo.commitTree({ tree: b.hrTree, parents: [b.hr], subject: 'a branch commit', trailers: [] });
    const Lm = await codeCommit(b, [L1, X], 'moved\n', live(6, X));
    const B2 = await buildBoardCommit(b.repo, { prevBoard: B1, liveCode: Lm, writer: writerAt(b, 6), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
    assert.equal(liveShape(await info(Lm), L1), 'base_move');
    assert.equal(boardShapeOk(await info(B2), B1), true);

    // A board commit whose last parent jumps to a commit that does not descend from live_code(B2) = Lm:
    // the board commit itself has the board shape, the code step from Lm to it has no live shape.
    const R = await codeCommit(b, [], 'unrelated root\n', [T('skip-checks', 'true'), T('Cowork-Proto', '1'), T('Cowork-Base', b.hr)]);
    const Ljump = await codeCommit(b, [R], 'jump\n', live(7, null));
    const B3 = await buildBoardCommit(b.repo, { prevBoard: B2, liveCode: Ljump, writer: writerAt(b, 7), ops: [], cs: [], csPaths: new Map(), protocol: null, checkpoint: null });
    assert.equal(boardShapeOk(await info(B3), B2), true);
    assert.equal(liveShape(await info(Ljump), Lm), null, 'a jump to a non-descendant is not a live shape');
    // Skipping over a live commit is not a live step either (one code commit per board commit).
    const L2 = await codeCommit(b, [Lm], 'two\n', live(8, null));
    const L3 = await codeCommit(b, [L2], 'three\n', live(9, null));
    assert.equal(liveShape(await info(L3), Lm), null);
    assert.equal(liveShape(await info(L3), L2), 'ordinary');

    // Live shapes that are wrong.
    assert.equal(liveShape(await info(L0), L0), null, 'genesis only without an expected predecessor');
    assert.equal(liveShape(await info(L1), null), null, 'an ordinary commit is not a genesis');
    assert.equal(liveShape(await info(L1), L1), null);
    const noBase = await codeCommit(b, [], 'no base\n', live(10, null));
    assert.equal(liveShape(await info(noBase), null), null, 'genesis needs Cowork-Base');
    const badBase = await codeCommit(b, [], 'bad base\n', [...HEAD3(opId(b, 11)), T('Cowork-Base', 'not-an-oid')]);
    assert.equal(liveShape(await info(badBase), null), null);
    const ordinaryWithBase = await codeCommit(b, [L1], 'stray base\n', live(12, X));
    assert.equal(liveShape(await info(ordinaryWithBase), L1), null, 'an ordinary commit carries no Cowork-Base');
    const moveWrongBase = await codeCommit(b, [L1, X], 'wrong base\n', live(13, b.hr));
    assert.equal(liveShape(await info(moveWrongBase), L1), null, 'Cowork-Base must name the second parent');
    const moveNoBase = await codeCommit(b, [L1, X], 'move no base\n', live(14, null));
    assert.equal(liveShape(await info(moveNoBase), L1), null);
    const plainSubject = await codeCommit(b, [L1], 'plain\n', live(15, null), 'a user commit');
    assert.equal(liveShape(await info(plainSubject), L1), null, 'live commits carry the skip subject');
    const noMarkers = await codeCommit(b, [L1], 'no markers\n', [T('Cowork-Writer', opId(b, 16))]);
    assert.equal(liveShape(await info(noMarkers), L1), null, 'live commits carry skip-checks and Cowork-Proto');

    // Board shapes that are wrong.
    assert.equal(boardShapeOk(await info(B1), null), false, 'only B0 has a single parent');
    assert.equal(boardShapeOk(await info(B0), B0), false);
    assert.equal(boardShapeOk(await info(B2), B0), false, 'the first parent must be the expected previous board commit');
    const tree = (await info(B1)).tree;
    const three = await b.repo.commitTree({ tree, parents: [B1, L1, X], subject: BOARD_SUBJECT, trailers: boardTrailers(writerAt(b, 17), [], new Map()) });
    assert.equal(boardShapeOk(await info(three), B1), false);
    const userSubject = await b.repo.commitTree({ tree, parents: [B1, L1], subject: 'merge board', trailers: boardTrailers(writerAt(b, 18), [], new Map()) });
    assert.equal(boardShapeOk(await info(userSubject), B1), false);
    const bare = await b.repo.commitTree({ tree, parents: [B1, L1], subject: BOARD_SUBJECT, trailers: [] });
    assert.equal(boardShapeOk(await info(bare), B1), false);
    // A missing or malformed Cowork-Writer or another proto value is the fold's business, not a shape violation.
    const oddWriter = await b.repo.commitTree({ tree, parents: [B1, L1], subject: BOARD_SUBJECT, trailers: [T('skip-checks', 'true'), T('Cowork-Proto', '2')] });
    assert.equal(boardShapeOk(await info(oddWriter), B1), true);
  } finally {
    await b.f.cleanup();
  }
});
