// The demo source against files and boards (Plan 8a Task 7; 12 §3.9.3, VIZ-06, VIZ-27; rulings R-V19, R-V30; F8): readDemoFile
// through realBoundedReader on a temp root with a space and Hangul; a demo run that spawns no git and reads no file; and the
// property export-demo relies on (Task 16) — a DemoLog built from a board's batched reads folds to the git source's timeline
// byte for byte, a shape-null live read and a malformed board commit included (only the unknown counts differ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { join } from 'node:path';
import { isBoardReadFailure, readBoardCommits, type BoardRead, type BoardReadFailure } from '../../../src/board/batchRead.js';
import { formatWriter, liveShape, type CsTrailer } from '../../../src/board/boardCommit.js';
import type { Oid } from '../../../src/git/oid.js';
import { realClock } from '../../../src/ports/clock.js';
import { realFs } from '../../../src/ports/fs.js';
import { ZERO_PEER, type Frame } from '../../../src/viz/model/frame.js';
import { serializeTimeline, TimelineBuilder } from '../../../src/viz/model/timeline.js';
import { realBoundedReader, type BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { DEMO_MAX_BYTES, DemoRoomSource, parseDemoLog, readDemoFile, serializeDemoLog, type DemoCommit, type DemoLog } from '../../../src/viz/source/demo.js';
import { GitRoomSource } from '../../../src/viz/source/git.js';
import type { RoomSource } from '../../../src/viz/source/roomSource.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { chain, many, SEAT } from '../../helpers/vizBatchRead.js';
import { CAPTION_CODES, demoBuffer, headerLine, storyLines } from '../../helpers/vizDemo.js';
import { spyNodeFs, type FsCall } from '../../helpers/vizFs.js';
import { spiedVizGit, vizRunner } from '../../helpers/vizSource.js';
import { within } from '../../helpers/vizStatus.js';

const POSIX = process.platform !== 'win32';

test('T-VIZ-demo-format: readDemoFile refuses a FIFO, a directory, a symlink and a 4 MiB + 1 byte file', async (t) => {
  const { root, cleanup } = await makeTempRoot('viz-demo-file');
  try {
    const good = demoBuffer([headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }]), ...storyLines('a')]);
    const file = join(root, 'demo log.jsonl');
    writeFileSync(file, good);
    const read = await readDemoFile(file, realBoundedReader);
    assert.ok(Buffer.isBuffer(read) && read.equals(good));
    assert.ok('rooms' in parseDemoLog(read as Buffer, CAPTION_CODES));
    // Exactly 4 MiB is read; one byte more is refused at the file level.
    const exact = join(root, 'exact.jsonl');
    writeFileSync(exact, Buffer.alloc(DEMO_MAX_BYTES, 0x20));
    const e = await readDemoFile(exact, realBoundedReader);
    assert.ok(Buffer.isBuffer(e) && e.length === DEMO_MAX_BYTES);
    const big = join(root, 'big.jsonl');
    writeFileSync(big, Buffer.alloc(DEMO_MAX_BYTES + 1, 0x20));
    assert.deepEqual(await readDemoFile(big, realBoundedReader), { line: 0 }, '4 MiB + 1 byte');
    const dir = join(root, 'a dir.jsonl');
    mkdirSync(dir);
    assert.deepEqual(await readDemoFile(dir, realBoundedReader), { line: 0 }, 'a directory');
    assert.deepEqual(await readDemoFile(join(root, 'absent.jsonl'), realBoundedReader), { line: 0 }, 'absent');
    const link = join(root, 'link.jsonl');
    try {
      symlinkSync(file, link);
      assert.deepEqual(await readDemoFile(link, realBoundedReader), { line: 0 }, 'a symlink to a valid demo');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      t.diagnostic('symlink leg skipped: this account cannot create symlinks');
    }
    // A reader that fails (EACCES) refuses too.
    const failing: BoundedReader = { read: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    assert.deepEqual(await readDemoFile(file, failing), { line: 0 });
    if (!POSIX) {
      t.diagnostic('FIFO leg skipped on win32 (POSIX only)');
      return;
    }
    const fifo = join(root, 'fifo.jsonl');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.deepEqual(await within(5_000, readDemoFile(fifo, realBoundedReader), 'FIFO demo'), { line: 0 }, 'a FIFO, without blocking');
  } finally {
    await cleanup();
  }
});

test('a demo source spawns no git process and reads no file', async () => {
  const buf = demoBuffer([headerLine([{ room: 'a', name: 'shop-app', branch: 'main' }, { room: 'b', name: 'two', branch: 'main' }]), ...storyLines('a'), ...storyLines('b')]);
  const fsCalls: FsCall[] = [];
  const spawns: string[] = [];
  const reads: string[] = [];
  const reader: BoundedReader = { read: async (p) => { reads.push(p); return null; } };
  const mocks = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map((name) =>
    mock.method(childProcess, name, (...args: unknown[]) => {
      spawns.push(`${name} ${String(args[0])}`);
      throw new Error(`${name} called by a demo source`);
    }));
  syncBuiltinESMExports();
  const restoreFs = spyNodeFs(fsCalls);
  try {
    const log = parseDemoLog(buf, CAPTION_CODES);
    assert.ok('rooms' in log);
    for (const room of log.rooms) {
      const src: RoomSource = new DemoRoomSource(room, log.commits.get(room.room)!);
      assert.equal(src.kind, 'demo');
      const tip = (await src.tip())!;
      assert.equal(await src.changed(), false);
      assert.deepEqual(await src.advance(tip), { kind: 'none' });
      const frames: Frame[] = [];
      for await (const f of src.frames(await src.startAt(0), 0, tip.height, ZERO_PEER)) frames.push(f);
      assert.equal(frames.length, tip.height + 1);
      assert.deepEqual(await src.startAt(tip.height), frames[frames.length - 1]!.after);
    }
    serializeDemoLog(log);
  } finally {
    restoreFs();
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(spawns, [], 'no child process');
  assert.deepEqual(fsCalls, [], 'no file access');
  assert.deepEqual(reads, [], 'no bounded read');
});

/** The Cowork-CS value of a trailer (the Plan 2 form parseCsTrailers reads). */
const csValue = (c: CsTrailer): string => `${c.csId} state=${c.state} seq=${c.seq} origin=${c.origin} checks=${c.checks} paths=${c.paths}`;

/**
 * What export-demo writes (Task 16; 12 §3.9.3, R-V19): one commit record per batched read, `code` from the named live commit's
 * trailers (an unchanged board-only commit names the previous one), a shape-null live read as code {changed: false, seats: [],
 * base: null}, a malformed board commit as writer null, ops [], cs [], csPaths {}, held [] with that code.
 */
function exportDemo(reads: ReadonlyArray<BoardRead | BoardReadFailure>): DemoLog {
  const commits: DemoCommit[] = [];
  let prevLive: Oid | null = null;
  let carried = { seats: [] as string[], base: null as string | null };
  const unchanged = { changed: false, seats: [] as string[], base: null as string | null };
  for (const r of reads) {
    const at = { room: 'a', height: r.height, line: r.height + 2, live: null, claims: null };
    if (isBoardReadFailure(r)) {
      assert.notEqual(r.malformed, 'missing');
      commits.push({ ...at, writer: null, protocol: null, code: unchanged, cs: [], csPaths: new Map(), ops: [], held: [] });
      continue;
    }
    let code: DemoCommit['code'];
    const changed = r.height > 0 && r.liveCode !== prevLive;
    if (r.live === 'same' || r.live === null) {
      code = { changed: false, ...carried };
    } else if ('malformed' in r.live) {
      code = unchanged;
      carried = { seats: [], base: null };
    } else {
      const shape = r.height === 0 ? liveShape(r.live.info, null) : changed ? liveShape(r.live.info, prevLive) : null;
      carried = { seats: [...r.live.seats], base: r.live.base };
      code = changed && shape === null ? unchanged : { changed, ...carried };
    }
    prevLive = r.liveCode;
    commits.push({
      ...at, writer: r.writer === null ? null : formatWriter(r.writer), protocol: r.height === 0 ? r.protocol : null, code,
      cs: r.cs.map(csValue), csPaths: new Map([...r.csPaths].map(([k, v]) => [k, [...v]])), ops: [...r.opsLines], held: [...r.heldIds],
    });
  }
  return { rooms: [{ room: 'a', name: 'shop-app', branch: 'main' }], commits: new Map([['a', commits]]), captions: [] };
}

/** The serialized timeline of a source's whole board from height 0, and the unknown count of every frame. */
async function timelineOf(src: RoomSource): Promise<{ text: string; unknown: number; frames: Frame[] }> {
  const tip = (await src.tip())!;
  const start = await src.startAt(0);
  const b = TimelineBuilder.open(0, start);
  let unknown = 0;
  const frames: Frame[] = [];
  for await (const f of src.frames(start, 0, tip.height, ZERO_PEER)) {
    frames.push(f);
    unknown += b.push(f).unknown;
  }
  return { text: serializeTimeline(b.timeline()), unknown, frames };
}

test('a DemoLog built from a board\'s reads folds to the git source\'s timeline byte for byte', async () => {
  const fx = await makeRepoFixture('viz-demo-export');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'viz-demo-export' });
    await w.genesis('ann');
    await w.join('bob');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/cart.ts', 'src/price.ts'] }] });
    await w.commit({ writer: 'bob', cs: [{ paths: ['src/cart.ts'] }, { paths: ['test/cart.test.ts'] }] });
    await w.malformed('live_not_commit');
    await w.commit({ writer: 'ann', cs: [{ paths: ['docs/a.md'] }] });
    await w.commit({ writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] });
    await w.commit({ writer: 'ann', cs: [{ seat: SEAT, paths: ['src/cart.ts'] }] });
    await w.malformed('live_three_parents');
    await w.malformed('board_ops_too_large');
    await w.commit({ writer: 'bob', ops: [{ type: 'event', cid: '', kind: 'freeze', refs: [], reason_code: 'EPOCH' }] });
    await w.commit({ writer: 'bob', code: 'base_move' });
    await w.commit({ writer: 'bob', cs: [{ paths: many(300, 'big') }] });
    await w.commit({ writer: 'bob', rawOps: ['{"truncated":'] });
    await w.commit({ writer: null, rawOps: ['{}'] });
    await w.join('ann', { newEpoch: true });
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/price.ts'] }] });

    // The board's reads, from height 0, call after call (R-V69), prevLive carried as the last draft's liveCode.
    const oids = await chain(fx.repo, w.tip().oid);
    const items = oids.map((oid, height) => ({ oid, height }));
    const reads: Array<BoardRead | BoardReadFailure> = [];
    let prevLive: Oid | null = null;
    while (reads.length < items.length) {
      const { reads: got, next } = await readBoardCommits(fx.repo, items.slice(reads.length), { withLive: true, prevLive });
      assert.ok(next > 0);
      for (const r of got) {
        reads.push(r);
        if (!isBoardReadFailure(r)) prevLive = r.liveCode;
      }
    }
    // The log goes through a file's bytes, as export-demo writes it.
    const bytes = serializeDemoLog(exportDemo(reads));
    const log = parseDemoLog(bytes, CAPTION_CODES);
    assert.ok('rooms' in log, JSON.stringify(log));
    const demo = await timelineOf(new DemoRoomSource(log.rooms[0]!, log.commits.get('a')!));

    const dataDir = join(fx.root, 'viz data');
    const sg = spiedVizGit(vizRunner(dataDir), fx.paths.gitDir, dataDir);
    const git = await timelineOf(new GitRoomSource({ id: 'r00000000', kind: 'git', label: 'shop-app', branch: 'main', gitDir: fx.paths.gitDir, boardRef: w.ref, canonicalRoot: null }, sg.git, { fs: realFs, clock: realClock }));

    assert.equal(demo.text, git.text, 'byte-identical timelines');
    const malformed = git.frames.filter((f) => f.malformed).length;
    const shapeNull = git.frames.filter((f) => f.height > 0 && f.code.changed && f.code.shape === null).length;
    assert.equal(malformed, 1, 'one malformed board commit');
    assert.ok(shapeNull >= 2, `shape-null live reads: ${shapeNull}`);
    assert.equal(git.unknown - demo.unknown, malformed + shapeNull, 'only the unknown counts differ, by exactly those frames');
  } finally {
    await fx.cleanup();
  }
});
