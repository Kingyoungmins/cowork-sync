// Final review FA-3 (and the board minor "fold and refold hold every commit of the plan in memory at once"): the board
// size caps are per commit, so a small push of a hostile board range (delta compression packs a 1 MB subject or a
// 4.9 MB carried checkpoint into a few bytes per commit) used to exhaust every peer's memory: the incident check kept
// every parsed commit of LA_B..T (subject and trailers included), and the fold read checkpoint/state.json for every
// commit and returned every BoardCommitData of the range. What a range read keeps must not grow with the commits'
// bodies. The repositories are built with one git fast-import each (the many-parent commits with hash-object
// --literally, as a hostile pusher would write them); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { BOARD_SUBJECT, boardShapeOk, checkBoardCommits, liveShape, readBoardCommit, readCommitsChecked } from '../../src/board/boardCommit.js';
import { Folder, foldCommit, initialFoldState, serializeFold } from '../../src/board/fold.js';
import { genesisProtocol, serializeProtocol, type ProtocolJson } from '../../src/board/protocol.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const MiB = 1_048_576;
const SELF = '5e1f'.repeat(8);
const TRAILERS = '\n\nskip-checks: true\nCowork-Proto: 1\n';
const DATE = '1700000000 +0000';

/**
 * Live heap and Buffer memory after two full collections. The event loop runs first: the stdout Buffer of a git call
 * that has just ended stays referenced by its child process's stream state until the loop has turned (transient, at
 * most one 32 MiB batch read), and only what a read keeps afterwards is retained.
 */
async function retained(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  gc();
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/** A GitRepo on the fixture whose runner sums the stdout bytes of every git call. */
function counting(f: RepoFixture): { repo: GitRepo; stdoutBytes: () => number } {
  let bytes = 0;
  const runner: GitRunner = {
    async run(args, opts) {
      const r = await f.runner.run(args, opts);
      bytes += r.stdout.length;
      return r;
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), stdoutBytes: () => bytes };
}

/**
 * A GitRepo on the fixture whose runner samples the live heap and Buffer memory (after two full collections) before
 * every git call: the most a read holds while it runs, not only what it keeps afterwards. The stdout of the call that
 * has just ended may still be counted (one batch read at most).
 */
function sampling(f: RepoFixture): { repo: GitRepo; peak: () => number } {
  let peak = 0;
  const runner: GitRunner = {
    async run(args, opts) {
      gc();
      gc();
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.arrayBuffers);
      return f.runner.run(args, opts);
    },
  };
  return { repo: new GitRepo(runner, f.paths, fixtureContext), peak: () => peak };
}

interface BoardSpec {
  n: number;
  /** The message subject of board commit i (1..n); B0's is the plain board subject. */
  subject?: (i: number) => string;
  /** Trailer lines (each ending in LF) appended to board commit i's trailer block. */
  trailers?: (i: number) => string;
  /** Replaces checkpoint/state.json on board commit i (later commits carry it). */
  checkpointAt?: (i: number) => Buffer | null;
  /** Replaces protocol.json on board commit i. */
  protocolAt?: (i: number) => Buffer | null;
}

/**
 * L0 on refs/m/live and B0 + n board commits on refs/m/board ([prev, L0], board-only), in one fast-import. B0 carries
 * the honest height-0 checkpoint of its own fold (writer none, no ops), so a Folder starts from it verified. Returns the
 * board oids by height.
 */
async function importBoard(f: RepoFixture, protocol: ProtocolJson, spec: BoardSpec): Promise<Oid[]> {
  const parts: Buffer[] = [];
  const text = (s: string): void => { parts.push(Buffer.from(s, 'utf8')); };
  const data = (b: Buffer): void => { parts.push(Buffer.from(`data ${b.length}\n`, 'utf8'), b, Buffer.from('\n', 'utf8')); };
  const who = `author F <f@cowork.invalid> ${DATE}\ncommitter F <f@cowork.invalid> ${DATE}\n`;
  text(`commit refs/m/live\nmark :1\n${who}`);
  data(Buffer.from(`[skip ci] ***NO_CI*** cowork live${TRAILERS}`, 'utf8'));
  text('M 100644 inline README.md\n');
  data(Buffer.from('# x\n', 'utf8'));
  const s0 = foldCommit(initialFoldState(protocol), { liveCode: '1'.repeat(40) as Oid, writer: null, cs: [], protocol, opsLines: [], checkpoint: null, heldIds: [] }, SELF).state;
  text(`commit refs/m/board\nmark :2\n${who}`);
  data(Buffer.from(`${BOARD_SUBJECT}${TRAILERS}`, 'utf8'));
  text('from :1\ndeleteall\nM 100644 inline protocol.json\n');
  data(serializeProtocol(protocol));
  text('M 100644 inline ops.jsonl\n');
  data(Buffer.alloc(0));
  text('M 100644 inline checkpoint/state.json\n');
  data(serializeFold(s0));
  for (let i = 1; i <= spec.n; i++) {
    text(`commit refs/m/board\nmark :${i + 2}\n${who}`);
    data(Buffer.from(`${spec.subject?.(i) ?? `${BOARD_SUBJECT} ${i}`}${TRAILERS}${spec.trailers?.(i) ?? ''}`, 'utf8'));
    text(`from :${i + 1}\nmerge :1\n`);
    const ck = spec.checkpointAt?.(i) ?? null;
    if (ck !== null) {
      text('M 100644 inline checkpoint/state.json\n');
      data(ck);
    }
    const proto = spec.protocolAt?.(i) ?? null;
    if (proto !== null) {
      text('M 100644 inline protocol.json\n');
      data(proto);
    }
  }
  text('done\n');
  await f.repo.run(['fast-import', '--quiet', '--done'], { stdin: Buffer.concat(parts) });
  const list = await f.repo.run(['rev-list', '--first-parent', '--reverse', 'refs/m/board']);
  const oids = list.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).map((l) => parseOid(l));
  assert.equal(oids.length, spec.n + 2, 'L0, B0 and the n board commits');
  return oids.slice(1);
}

test('the incident check\'s range readers keep a compact record per commit: 64 board commits with 1 MB subjects add no subject-sized memory', async (t) => {
  const f = await makeRepoFixture('board-mem-subjects');
  try {
    const N = 64;
    const big = 'x'.repeat(1_000_000);
    const boards = await importBoard(f, genesisProtocol(12, 'rs'), { n: N, subject: (i) => `${BOARD_SUBJECT} ${i} ${big}` });
    const range = boards.slice(1);
    const sizes = await f.repo.blobSizes(range);
    assert.ok(sizes.every((s) => s > 1_000_000), 'every commit object is over 1 MB (and under the 1 MiB commit cap)');

    const before = await retained();
    const checked = await checkBoardCommits(f.repo, range);
    const read = await readCommitsChecked(f.repo, range);
    const grew = (await retained()) - before;
    t.diagnostic(`retained ${(grew / MiB).toFixed(1)} MiB`);
    // The verdicts are unchanged: every commit is a board-shaped, board-only step on the previous one.
    checked.forEach((c, i) => {
      assert.equal(c.refused, null, `commit ${i + 1}`);
      assert.ok(boardShapeOk(c.commit!, boards[i]!), `commit ${i + 1} is board-shaped on its predecessor`);
      assert.deepEqual(read[i]?.commit?.parents, c.commit!.parents);
    });
    assert.ok(grew < 16 * MiB, `the two range reads keep ${(grew / MiB).toFixed(1)} MiB for ${N} commits of 1 MB (bounded: under 16 MiB)`);
  } finally {
    await f.cleanup();
  }
});

test('Folder.foldTo neither reads nor keeps a carried 4.9 MB checkpoint at heights that are no checkpoint height, and returns light records', async (t) => {
  const f = await makeRepoFixture('board-mem-checkpoint');
  try {
    const N = 24;
    const huge = Buffer.alloc(4_900_000, 0x61);   // one blob, carried by every commit from height 1 on
    const boards = await importBoard(f, genesisProtocol(12, 'rs'), { n: N, checkpointAt: (i) => (i === 1 ? huge : null) });
    const { repo, stdoutBytes } = counting(f);
    const before = await retained();
    const out = await new Folder(repo, SELF).foldTo(boards[N]!, null, 'rs');
    const grew = (await retained()) - before;
    t.diagnostic(`retained ${(grew / MiB).toFixed(1)} MiB`);
    assert.equal(out.state.height, N);
    assert.ok(grew < 16 * MiB, `the fold keeps ${(grew / MiB).toFixed(1)} MiB after ${N} commits carrying a 4.9 MB checkpoint (bounded: under 16 MiB)`);
    assert.ok(stdoutBytes() < huge.length, `git printed ${stdoutBytes()} bytes: the carried checkpoint was read`);
    assert.deepEqual(out.newCommits.map((c) => c.oid), boards.slice(1));
    assert.deepEqual(Object.keys(out.newCommits[0]!).sort(), ['firstParent', 'liveCode', 'oid'], 'a light record: no bodies');
    assert.deepEqual(out.newCommits[N - 1]!.protocol, genesisProtocol(12, 'rs'), 'the newest record carries the tip\'s protocol.json');
  } finally {
    await f.cleanup();
  }
});

test('Folder.foldTo keeps no per-commit protocol.json: 24 board commits with distinct 2 MB protocol.json blobs add no protocol-sized memory', async (t) => {
  const f = await makeRepoFixture('board-mem-protocol');
  try {
    const N = 24;
    const protocolOf = (i: number): Buffer => serializeProtocol(genesisProtocol(12, `rs-${i}-${'r'.repeat(2_000_000)}`));
    const boards = await importBoard(f, genesisProtocol(12, 'rs'), { n: N, protocolAt: (i) => protocolOf(i) });
    const before = await retained();
    const out = await new Folder(f.repo, SELF).foldTo(boards[N]!, null, 'rs');
    const grew = (await retained()) - before;
    t.diagnostic(`retained ${(grew / MiB).toFixed(1)} MiB`);
    assert.equal(out.state.height, N);
    assert.ok(grew < 16 * MiB, `the fold keeps ${(grew / MiB).toFixed(1)} MiB after ${N} distinct 2 MB protocol.json blobs (bounded: under 16 MiB)`);
    assert.equal(out.newCommits.length, N);
    assert.ok(out.newCommits.slice(0, -1).every((c) => c.protocol === undefined), 'only the newest record carries protocol.json');
    assert.equal(out.newCommits[N - 1]!.protocol?.regionSpec.length, `rs-${N}-`.length + 2_000_000);
  } finally {
    await f.cleanup();
  }
});

// FA-3, the parents of a commit: git (and fsck --strict, receive.fsckObjects; probed on git 2.55) accepts a commit
// whose consecutive `parent` lines repeat one existing commit thousands of times, so a 1 MiB commit can carry about
// 21,000 parents and identical lines pack into a few bytes. A shape record must not keep them all: every shape
// verdict reads only the count (0, 1, 2 or more), the first two and the last parent.
test('the incident check\'s range readers keep at most three parents per commit: 48 fsck-valid commits with 20,000 parent lines each add no parent-sized memory', async (t) => {
  const f = await makeRepoFixture('board-mem-parents');
  try {
    const N = 48;
    const PARENTS = 20_000;
    const [B0] = await importBoard(f, genesisProtocol(12, 'rs'), { n: 0 });
    const L0 = (await f.repo.run(['rev-parse', 'refs/m/live'])).stdout.toString('utf8').trim() as Oid;
    const tree = (await f.repo.run(['rev-parse', `${B0!}^{tree}`])).stdout.toString('utf8').trim();
    const who = `author F <f@cowork.invalid> ${DATE}\ncommitter F <f@cowork.invalid> ${DATE}\n`;
    const parentLines = `parent ${L0}\n`.repeat(PARENTS);
    const range: Oid[] = [];
    for (let i = 1; i <= N; i++) {
      const text = `tree ${tree}\n${parentLines}${who}\n${BOARD_SUBJECT} ${i}${TRAILERS}`;
      const r = await f.repo.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { stdin: Buffer.from(text, 'utf8') });
      range.push(parseOid(r.stdout.toString('utf8').trim()));
    }
    const gitView = (await f.repo.run(['rev-list', '--parents', '-n', '1', range[0]!])).stdout.toString('utf8').trim().split(' ');
    assert.equal(gitView.length, 1 + PARENTS, 'git reads every parent line');
    const sizes = await f.repo.blobSizes(range);
    assert.ok(sizes.every((s) => s > 900_000 && s <= 1_048_576), 'every commit object is about 1 MB (under the 1 MiB commit cap)');

    const before = await retained();
    const checked = await checkBoardCommits(f.repo, range);
    const read = await readCommitsChecked(f.repo, range);
    const grew = (await retained()) - before;
    t.diagnostic(`retained ${(grew / MiB).toFixed(1)} MiB`);
    checked.forEach((c, i) => {
      assert.equal(c.refused, null, `commit ${i + 1}: readBoardCommit's checks refuse nothing`);
      const p = c.commit!.parents;
      assert.ok(p.length > 2, `commit ${i + 1}: still more than two parents`);
      assert.equal(p[0], L0);
      assert.equal(p[p.length - 1], L0, 'the last parent (the live code commit the incident check reads) is kept');
      assert.equal(boardShapeOk(c.commit!, L0), false, 'not board-shaped: more than two parents');
      assert.equal(liveShape(read[i]!.commit!, L0), null, 'not a live step either');
    });
    assert.ok(grew < 16 * MiB, `the two range reads keep ${(grew / MiB).toFixed(1)} MiB for ${N} commits of ${PARENTS} parents (bounded: under 16 MiB)`);
  } finally {
    await f.cleanup();
  }
});

// FA-3, the fold's read cache: what a cached commit costs must count everything it keeps. A board commit may carry
// about 10,000 distinct Cowork-CS trailers in its 1 MiB message (the board shape checks only the markers and the
// parents), and every one is a CsTrailer of the commit's BoardCommitData; a cache charging a kilobyte per commit kept
// every such commit of a range (and, through the trailer values, its whole message), so the peak grew with the range.
test('Folder.foldTo\'s peak memory does not grow with the range: 48 board commits with 10,000 distinct Cowork-CS trailers each', async (t) => {
  const f = await makeRepoFixture('board-mem-cs');
  try {
    const N = 48;
    const CS = 10_000;
    const hex = (i: number, k: number): string => `${i.toString(16).padStart(8, '0')}${k.toString(16).padStart(8, '0')}`.repeat(2);
    const csLines = (i: number): string => Array.from({ length: CS }, (_, k) => `Cowork-CS: ${hex(i, k)}/1 state=closed seq=1 origin=prompt checks=pass paths=1\n`).join('');
    const boards = await importBoard(f, genesisProtocol(12, 'rs'), { n: N, trailers: csLines });
    const sizes = await f.repo.blobSizes(boards.slice(1));
    assert.ok(sizes.every((s) => s > 800_000 && s <= 1_048_576), 'every commit object is about 1 MB (under the 1 MiB commit cap)');
    assert.equal((await readBoardCommit(f.repo, boards[1]!)).cs.length, CS, 'every Cowork-CS trailer parses');

    const { repo, peak } = sampling(f);
    const before = await retained();
    const out = await new Folder(repo, SELF).foldTo(boards[N]!, null, 'rs');
    const held = peak() - before;
    t.diagnostic(`peak ${(held / MiB).toFixed(1)} MiB above the start`);
    assert.equal(out.state.height, N);
    // The bound: the 16 MiB read cache plus 8 reads ahead of ~3 MB each while parsed (measured 34 MiB; 129 MiB before).
    assert.ok(held < 64 * MiB, `the fold held ${(held / MiB).toFixed(1)} MiB at its peak over ${N} commits of ${CS} change-set trailers (bounded: under 64 MiB)`);
  } finally {
    await f.cleanup();
  }
});
