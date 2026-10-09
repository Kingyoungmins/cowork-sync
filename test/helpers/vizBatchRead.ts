// Shared fixtures of the batched-reader tests (Plan 8a Task 2; test/integration/viz/batchRead*.test.ts). Objects are
// written byte for byte with git's own plumbing (`hash-object -w`, `mktree`, `hash-object -t tree --literally`), the
// corrupt loose objects with node:zlib, never through src/; every git call of the reader under test goes through a
// runner spy.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  isBoardReadFailure, readBoardCommits, readLiveCommits, type BatchGit, type BoardRead, type BoardReadFailure, type LiveRead, type LiveReadFailure,
} from '../../src/board/batchRead.js';
import { readBoardCommit, type BoardCommitData } from '../../src/board/boardCommit.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import { parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import { BoardWriter } from '../../tools/viz/boardWriter.js';
import { fixtureContext, type RepoFixture } from './repoFixture.js';

/** One git call the spy saw: argv, stdin, stdout and the exit code (a failed call is recorded too). */
export interface Call { args: string[]; stdin: string; stdout: Buffer; code: number; }

/** A GitRepo over the fixture's runner that records every git call (argv, stdin, stdout and exit code). */
export function spyRepo(fx: RepoFixture): { repo: GitRepo; calls: Call[] } {
  const calls: Call[] = [];
  const runner: GitRunner = {
    async run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      const r = await fx.runner.run(args, opts);
      calls.push({ args: [...args], stdin: opts.stdin?.toString('utf8') ?? '', stdout: r.stdout, code: r.code });
      return r;
    },
  };
  return { repo: new GitRepo(runner, fx.paths, fixtureContext), calls };
}

/** hash-object -w of raw bytes as `type` (git checks a commit or tag the way it checks any object it writes). */
export async function hashRaw(fx: RepoFixture, type: 'blob' | 'commit' | 'tag', bytes: Buffer): Promise<Oid> {
  return parseOid((await fx.repo.run(['hash-object', '-t', type, '-w', '--stdin'], { stdin: bytes })).stdout.toString('utf8'));
}

/** git mktree of [mode, name, oid] entries (sorted and checked by git). */
export async function mktree(fx: RepoFixture, entries: ReadonlyArray<[string, string, Oid]>): Promise<Oid> {
  const kind = (mode: string): string => (mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob');
  const text = entries.map(([mode, name, oid]) => `${mode} ${kind(mode)} ${oid}\t${name}`).join('\n');
  return parseOid((await fx.repo.run(['mktree'], { stdin: Buffer.from(`${text}\n`, 'utf8') })).stdout.toString('utf8'));
}

/**
 * The checkpoint/ tree a hand-built board tree carries (Plan 2 final review FA-2: a board commit without a
 * checkpoint/state.json blob is malformed, `entry_missing`): one small state.json, read only at heights divisible by 256.
 */
export async function checkpointTree(fx: RepoFixture): Promise<Oid> {
  return mktree(fx, [['100644', 'state.json', await hashRaw(fx, 'blob', Buffer.from('{}\n', 'utf8'))]]);
}

/** A tree record: raw bytes, or [mode, name, oid hex] written as `<mode> <name>\0<hash>`. */
export type TreeRecord = Buffer | readonly [mode: string, name: string, oid: string];

/** A tree object written byte for byte (`hash-object -t tree --literally`): the records in the given order, nothing checked. */
export async function rawTree(fx: RepoFixture, records: readonly TreeRecord[]): Promise<Oid> {
  const bytes = Buffer.concat(records.map((r) => (Buffer.isBuffer(r) ? r : Buffer.concat([Buffer.from(`${r[0]} ${r[1]}\0`, 'utf8'), Buffer.from(r[2], 'hex')]))));
  return parseOid((await fx.repo.run(['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], { stdin: bytes })).stdout.toString('utf8'));
}

export const IDENT = 'Fixture <fixture@cowork.invalid> 1700000000 +0000';

/** The bytes of a commit object: tree, parent lines, author and committer, then the message. */
export function commitBytes(tree: Oid, parents: readonly string[], message: string): Buffer {
  return Buffer.from(`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${IDENT}\ncommitter ${IDENT}\n\n${message}`, 'utf8');
}

/** Objects that were never written: a partial clone's missing objects. */
export const NOT_STORED = 'ab'.repeat(20) as Oid;
export const NOT_STORED_2 = 'cd'.repeat(20) as Oid;

/** One round that must hold every item (small boards). */
export async function readOnce(git: BatchGit, items: ReadonlyArray<{ oid: Oid; height: number }>, opts: { withLive?: boolean; prevLive?: Oid | null } = {}): Promise<Array<BoardRead | BoardReadFailure>> {
  const { reads, next } = await readBoardCommits(git, items, opts);
  assert.equal(next, items.length, 'the whole batch fits one --batch');
  return reads;
}

/** The BoardCommitData fields of a batched read (what readBoardCommit returns). */
export function boardData(r: BoardRead): BoardCommitData {
  return { oid: r.oid, parents: r.parents, firstParent: r.firstParent, liveCode: r.liveCode, writer: r.writer, cs: r.cs, protocol: r.protocol, opsLines: r.opsLines, checkpoint: r.checkpoint, heldIds: r.heldIds };
}

/** A seat id for scripted boards. */
export const SEAT = '5ea75ea75ea75ea75ea75ea75ea75ea7';

/** n file paths under dir. */
export const many = (n: number, dir: string): string[] => Array.from({ length: n }, (_, i) => `${dir}/f${String(i).padStart(3, '0')}.txt`);

/** The board commits of the chain to tip, oldest first, genesis B0 at index 0 (rev-list --first-parent, the empty root dropped). */
export async function chain(repo: GitRepo, tip: Oid): Promise<Oid[]> {
  const r = await repo.run(['rev-list', '--first-parent', '--reverse', tip]);
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0).slice(1).map((l) => parseOid(l));
}

/**
 * R-V69's near-cap board: after genesis, eight board commits of ~1 MB each (message), each with its own ~4.9 MB
 * protocol.json and its own ~1 MB live commit: ~6.9 MB of `cat-file --batch` output per item (4 fit 32 MiB, 5 do not),
 * ~55 MB in all, every cap respected; compressible, so cheap to store. items are at heights 1–8, lives[i] is items[i]'s.
 */
export async function nearCapBoard(fx: RepoFixture, seed: string): Promise<{ b0: Oid; tree0: Oid; items: Array<{ oid: Oid; height: number }>; lives: Oid[] }> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  const b0 = await w.genesis('ann');
  const b0Info = await fx.repo.readCommit(b0);
  const ops = await hashRaw(fx, 'blob', Buffer.alloc(0));
  const ck = await checkpointTree(fx);
  const items: Array<{ oid: Oid; height: number }> = [];
  const lives: Oid[] = [];
  let prev = b0;
  let prevLive = b0Info.parents[0]!;
  for (let h = 1; h <= 8; h++) {
    const protocol = await hashRaw(fx, 'blob', Buffer.from(`{"proto":1}${' '.repeat(4_900_000 + h)}\n`, 'utf8'));
    const tree = await mktree(fx, [['040000', 'checkpoint', ck], ['100644', 'ops.jsonl', ops], ['100644', 'protocol.json', protocol]]);
    const liveH = await hashRaw(fx, 'commit', commitBytes(b0Info.tree, [prevLive], `live ${h}\n\n${'l'.repeat(1_000_000)}\n`));
    const boardH = await hashRaw(fx, 'commit', commitBytes(tree, [prev, liveH], `board ${h}\n\n${'b'.repeat(1_000_000)}\n`));
    items.push({ oid: boardH, height: h });
    lives.push(liveH);
    prev = boardH;
    prevLive = liveH;
  }
  return { b0, tree0: b0Info.tree, items, lives };
}

/** One call of a batched reader in a read-everything loop: the `next` it returned and the git calls it made. */
export interface Step { next: number; git: Call[]; }

/**
 * Every item, call after call from `next` (R-V69), the caller's prevLive carried across calls as Tasks 7/8 carry it;
 * `steps` records each call (its git calls when the spy's call list is given).
 */
export async function readAllBoard(git: BatchGit, items: ReadonlyArray<{ oid: Oid; height: number }>, withLive = false, spy: readonly Call[] = []): Promise<{ out: Array<BoardRead | BoardReadFailure>; steps: Step[] }> {
  const out: Array<BoardRead | BoardReadFailure> = [];
  const steps: Step[] = [];
  let prevLive: Oid | null = null;
  while (out.length < items.length) {
    const from = spy.length;
    const { reads, next } = await readBoardCommits(git, items.slice(out.length), { withLive, prevLive });
    steps.push({ next, git: spy.slice(from) });
    assert.ok(next > 0, 'every call reads at least one item');
    assert.equal(reads.length, next);
    out.push(...reads);
    const last = reads[reads.length - 1]!;
    prevLive = isBoardReadFailure(last) ? null : last.liveCode;
  }
  return { out, steps };
}

/** readLiveCommits over every oid, call after call from `next` (R-V69); `steps` as in readAllBoard. */
export async function readAllLive(git: BatchGit, oids: readonly Oid[], spy: readonly Call[] = []): Promise<{ out: Array<LiveRead | LiveReadFailure>; steps: Step[] }> {
  const out: Array<LiveRead | LiveReadFailure> = [];
  const steps: Step[] = [];
  while (out.length < oids.length) {
    const from = spy.length;
    const { reads, next } = await readLiveCommits(git, oids.slice(out.length));
    steps.push({ next, git: spy.slice(from) });
    assert.ok(next > 0, 'every call reads at least one oid');
    assert.equal(reads.length, next);
    out.push(...reads);
  }
  return { out, steps };
}

/** The bytes of `cat-file --batch` output a call keeps: its --batch calls that git completed (exit 0). */
export function keptBatchBytes(calls: readonly Call[]): number {
  return calls.filter((c) => c.args[1] === '--batch' && c.code === 0).reduce((n, c) => n + c.stdout.length, 0);
}

/** A small board: genesis, then two writer commits `before` and `after`, with their live commits. */
export async function smallBoard(fx: RepoFixture, seed: string): Promise<{ b0: Oid; before: Oid; after: Oid; tree: Oid; live: Oid; afterLive: Oid }> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  const b0 = await w.genesis('ann');
  const before = await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
  const after = await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });
  const info = await fx.repo.readCommit(before);
  return { b0, before, after, tree: info.tree, live: info.parents[1]!, afterLive: (await fx.repo.readCommit(after)).parents[1]! };
}

/** The outcome of each item: its BoardReadFailure reason, or 'ok'. */
export const reasonsOf = (out: ReadonlyArray<BoardRead | BoardReadFailure>): string[] => out.map((r) => (isBoardReadFailure(r) ? r.malformed : 'ok'));
/** Each git call as `<cat-file mode> <exit code>`. */
export const seenOf = (calls: readonly Call[]): string[] => calls.map((c) => `${c.args[1]} ${c.code}`);

/** Every item that read equals readBoardCommit (checkpoint aside: these heights are not multiples of 256). */
export async function equalsEngine(fx: RepoFixture, out: ReadonlyArray<BoardRead | BoardReadFailure>): Promise<void> {
  for (const r of out) {
    if (isBoardReadFailure(r)) continue;
    assert.deepEqual({ ...boardData(r), checkpoint: null }, { ...(await readBoardCommit(fx.repo, r.oid)), checkpoint: null }, `height ${r.height}`);
  }
}

/** The live commit an item read itself (not 'same', not a failure). */
export function ownLive(r: BoardRead | BoardReadFailure | undefined): Oid {
  assert.ok(r !== undefined && !isBoardReadFailure(r), JSON.stringify(r));
  const l = r.live;
  assert.ok(l !== null && l !== 'same' && !('malformed' in l), `height ${r.height}: ${JSON.stringify(l)}`);
  return l.oid;
}

/** A loose object whose header inflates but whose zlib checksum is wrong: --batch-check sizes it, --batch dies (128). */
export function plantCorrupt(fx: RepoFixture, oid: Oid, type: 'blob' | 'commit', body: Buffer): void {
  const z = Buffer.from(deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body])));
  for (const at of [z.length - 1, z.length - 2]) z.writeUInt8(z.readUInt8(at) ^ 0xff, at);   // the Adler-32 trailer
  const dir = join(fx.paths.gitDir, 'objects', oid.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, oid.slice(2)), z);
}
