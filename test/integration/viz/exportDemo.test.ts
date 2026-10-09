// Plan 8a Task 16: tools/viz/export-demo.ts (12 §3.9.3 "Producing a demo log", §1.5 item 8; VIZ-27, INV-VIZ-DET; R-V19, R-V69;
// the owner's choice of 2026-10-08 for `live`). Boards are written by tools/viz/boardWriter.ts on a real clone (temp roots with a
// space and Hangul); the exporter reads them through VizGit only; each exported log is folded by the demo source and compared with
// the git source's timeline of the same board, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoardCommit, formatWriter, parseCsTrailers, BOARD_SUBJECT } from '../../../src/board/boardCommit.js';
import { genesisProtocol } from '../../../src/board/protocol.js';
import type { Oid } from '../../../src/git/oid.js';
import type { GitRunner } from '../../../src/git/runner.js';
import { realClock } from '../../../src/ports/clock.js';
import { realFs } from '../../../src/ports/fs.js';
import { DemoRoomSource, parseDemoLog, type DemoCommit, type DemoLog } from '../../../src/viz/source/demo.js';
import { BoardObjectMissingError, GitRoomSource } from '../../../src/viz/source/git.js';
import { VizGitRefused, type VizGit } from '../../../src/viz/source/vizGit.js';
import { vizGitArgvOk } from '../../../src/viz/source/vizGitArgv.js';
import { DEMO_CAPTION_CODES } from '../../../src/viz/i18n/codes.js';
import { BoardWriter, type ScriptCommit } from '../../../tools/viz/boardWriter.js';
import { createExportGit, exportDemo, exportDemoCli, exportGitArgvOk } from '../../../tools/viz/export-demo.js';
import { roomTimeline } from '../../../tools/viz/golden.js';
import { makeRepoFixture, type RepoFixture } from '../../helpers/repoFixture.js';
import { commitBytes, hashRaw, many, mktree, NOT_STORED, SEAT } from '../../helpers/vizBatchRead.js';
import { kinds, specOf, spiedVizGit, vizRunner, type SpiedVizGit } from '../../helpers/vizSource.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const EXPORT_TOOL = join(REPO, 'tools', 'viz', 'export-demo.ts');
const CAPTIONS: ReadonlySet<string> = new Set(DEMO_CAPTION_CODES);
const ROOM = { room: 'a', name: 'shop-app', branch: 'main' };
const UNCHANGED = { changed: false, seats: [], base: null };

/** The exporter's git: VizGit over the absolute git, with a data directory outside the clone, every argv recorded. */
function vizOf(fx: RepoFixture): SpiedVizGit {
  const dataDir = join(fx.root, 'viz data');
  return spiedVizGit(vizRunner(dataDir), fx.paths.gitDir, dataDir);
}

/** The export CLI's git (createExportGit) over a runner that records every argv that reaches git. */
function spiedExportGit(fx: RepoFixture): { git: VizGit; calls: string[][] } {
  const dataDir = join(fx.root, 'viz data');
  const runner = vizRunner(dataDir);
  const calls: string[][] = [];
  const spy: GitRunner = {
    run(args, opts) {
      calls.push([...args]);
      return runner.run(args, opts);
    },
  };
  return { git: createExportGit({ runner: spy, gitDir: fx.paths.gitDir, dataDir }), calls };
}

function parsed(bytes: Buffer): DemoLog {
  const log = parseDemoLog(bytes, CAPTIONS);
  assert.ok('rooms' in log, `the exported log parses (refused at line ${JSON.stringify(log)})`);
  return log;
}

const recordsOf = (log: DemoLog): DemoCommit[] => log.commits.get('a')!;
const lfOnly = (b: Buffer): boolean => !b.includes(0x0d) && !(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) && b[b.length - 1] === 0x0a;

/** The git source's and the exported demo's timelines of the board at `ref` (12 §3.3.5 serialization), and the demo bytes. */
async function bothTimelines(fx: RepoFixture, ref: string, bytes: Buffer): Promise<{ git: Awaited<ReturnType<typeof roomTimeline>>; demo: Awaited<ReturnType<typeof roomTimeline>> }> {
  const log = parsed(bytes);
  const demo = await roomTimeline(new DemoRoomSource(log.rooms[0]!, recordsOf(log)));
  const git = await roomTimeline(new GitRoomSource(specOf(fx.paths.gitDir, ref), vizOf(fx).git, { fs: realFs, clock: realClock }));
  return { git, demo };
}

/** The CLI as a process (as a developer runs it). */
function runCli(args: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', EXPORT_TOOL, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The CLI in-process, its stdout and stderr lines. */
async function cli(args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await exportDemoCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test('export-demo writes one commit record per board commit from height 0 with held, code, cs and csPaths, and captions only from --captions', async () => {
  const fx = await makeRepoFixture('viz-export-records');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'viz-export-records' });
    await w.genesis('ann');                                                                                         // 0
    await w.join('bob');                                                                                             // 1
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/price.ts', 'src/cart.ts'] }, { paths: many(300, 'gen'), checks: 'pass' }] });   // 2
    await w.commit({ writer: 'bob', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] });     // 3
    await w.commit({ writer: 'bob', cs: [{ seat: SEAT, paths: ['test/cart.test.ts'] }] });                          // 4
    await w.commit({ writer: 'bob', code: 'base_move' });                                                            // 5
    await w.commit({ writer: 'ann' });                                                                               // 6
    // 7: a board commit with two held/<hold_id>/ entries (hand-built: Plan 2's writer has no holds), naming height 6's live commit.
    const top = await fx.repo.readCommit(w.tip().oid);
    const blob = await hashRaw(fx, 'blob', Buffer.from('hold\n', 'utf8'));
    const hold = await mktree(fx, [['100644', 'record.json', blob]]);
    const held = await mktree(fx, [['040000', '01J0000000000000000000HOLD', hold], ['040000', '01J0000000000000000001HOLD', hold]]);
    const entries = (await fx.repo.run(['ls-tree', top.tree])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0)
      .map((l): [string, string, Oid] => { const [meta, name] = l.split('\t') as [string, string]; const [mode, , oid] = meta.split(' ') as [string, string, Oid]; return [mode, name, oid]; });
    const tree = await mktree(fx, [...entries, ['040000', 'held', held]]);
    const b7 = await hashRaw(fx, 'commit', commitBytes(tree, [w.tip().oid, top.parents[1]!], `${BOARD_SUBJECT}\n`));
    await fx.repo.run(['update-ref', w.ref, b7]);

    const outDir = join(fx.root, 'out dir');
    mkdirSync(outDir);
    const plain = join(outDir, 'demo.jsonl');
    const r = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--out', plain]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, ['export-demo: wrote 8 commit records and 0 captions']);
    const bytes = readFileSync(plain);
    assert.ok(lfOnly(bytes), 'LF, no BOM, no CR');
    const log = parsed(bytes);
    assert.deepEqual(log.rooms, [{ room: 'a', name: 'p1', branch: 'main' }], 'room a, the clone folder, the branch the ref encodes');
    assert.deepEqual(log.captions, [], 'no caption without --captions');
    const recs = recordsOf(log);
    assert.deepEqual(recs.map((c) => c.height), [0, 1, 2, 3, 4, 5, 6, 7], 'one record per board commit from height 0');

    // Every record against Plan 2's own per-oid reader and the commit's trailers.
    const oids = (await fx.repo.run(['rev-list', '--first-parent', '--reverse', b7])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0).slice(1) as Oid[];
    for (const [h, oid] of oids.entries()) {
      const d = await readBoardCommit(fx.repo, oid);
      const info = await fx.repo.readCommit(oid);
      const c = recs[h]!;
      assert.equal(c.writer, d.writer === null ? null : formatWriter(d.writer), `writer ${h}`);
      assert.deepEqual(c.ops, d.opsLines, `ops ${h}`);
      assert.deepEqual(c.held, d.heldIds, `held ${h}`);
      assert.deepEqual(parseCsTrailers(c.cs.map((value) => ({ key: 'Cowork-CS', value }))).cs, d.cs, `cs ${h}`);
      assert.deepEqual([...c.csPaths], [...parseCsTrailers(info.trailers).paths], `csPaths ${h}`);
      assert.deepEqual(c.protocol, h === 0 ? genesisProtocol(12, 'rs-1') : null, `protocol ${h}`);
      assert.equal(c.live, c.code.changed ? info.parents[info.parents.length - 1] : null, `live ${h}`);
    }
    assert.deepEqual(recs[7]!.held, ['01J0000000000000000000HOLD', '01J0000000000000000001HOLD']);
    assert.equal(recs[2]!.cs.length, 2);
    assert.deepEqual([...recs[2]!.csPaths.values()], [['src/cart.ts', 'src/price.ts']], 'the 300-path change-set has no list (big table)');
    // code: the named live commit's Cowork-Seat and Cowork-Base; a board-only commit carries the previous ones.
    const l0 = await fx.repo.readCommit((await fx.repo.readCommit(oids[0]!)).parents[0]!);
    const base0 = l0.trailers.find((t) => t.key === 'Cowork-Base')!.value;
    const x = (await fx.repo.readCommit((await fx.repo.readCommit(oids[5]!)).parents[1]!)).parents[1]!;
    assert.deepEqual(recs.map((c) => c.code), [
      { changed: false, seats: [], base: base0 }, { changed: false, seats: [], base: base0 }, { changed: true, seats: ['human'], base: null },
      { changed: false, seats: ['human'], base: null }, { changed: true, seats: [SEAT], base: null }, { changed: true, seats: ['human'], base: x },
      { changed: false, seats: ['human'], base: x }, { changed: false, seats: ['human'], base: x },
    ]);

    // Captions come only from --captions, in file order, and change no commit record.
    const capFile = join(outDir, 'captions.jsonl');
    const capLines = ['{"t":"caption","room":"a","height":2,"code":"UI_VIZ_DEMO_CAPTION_3"}', '{"t":"caption","room":"a","height":7,"text":"Two people, two PCs."}'];
    writeFileSync(capFile, capLines.map((l) => `${l}\n`).join(''));
    const withCaps = join(outDir, 'captioned.jsonl');
    const r2 = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--captions', capFile, '--out', withCaps]);
    assert.equal(r2.code, 0, r2.err.join('\n'));
    const capBytes = readFileSync(withCaps);
    assert.ok(lfOnly(capBytes));
    assert.deepEqual(parsed(capBytes).captions, [{ room: 'a', height: 2, code: 'UI_VIZ_DEMO_CAPTION_3', text: null }, { room: 'a', height: 7, code: null, text: 'Two people, two PCs.' }]);
    assert.equal(capBytes.toString('utf8').split('\n').filter((l) => !l.includes('"t":"caption"')).join('\n'), bytes.toString('utf8'), 'the same records');
    // A captions file written by hand on Windows (CRLF line ends, a UTF-8 BOM, or both; 12 §3.9.3 "written by hand") is read
    // like the LF file: the written log is byte for byte the LF one (LF, no BOM).
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const [what, file] of [
      ['CRLF', Buffer.from(capLines.map((l) => `${l}\r\n`).join(''), 'utf8')],
      ['a BOM', Buffer.concat([bom, Buffer.from(capLines.map((l) => `${l}\n`).join(''), 'utf8')])],
      ['a BOM and CRLF', Buffer.concat([bom, Buffer.from(capLines.map((l) => `${l}\r\n`).join(''), 'utf8')])],
      ['CRLF, no final line end', Buffer.from(capLines.join('\r\n'), 'utf8')],
    ] as const) {
      writeFileSync(capFile, file);
      const windows = join(outDir, 'windows.jsonl');
      const rw = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--captions', capFile, '--out', windows]);
      assert.deepEqual([rw.code, rw.err], [0, []], `${what}: accepted`);
      assert.ok(readFileSync(windows).equals(capBytes), `${what}: the same LF log as the LF captions file`);
    }
    // Only one BOM at offset 0 is skipped: a BOM opening line 2 refuses line 2; bytes that are not UTF-8 refuse their own line.
    for (const [file, msg] of [
      [Buffer.concat([Buffer.from(`${capLines[0]!}\r\n`, 'utf8'), bom, Buffer.from(`${capLines[1]!}\r\n`, 'utf8')]), 'export-demo: --captions line 2 is not a caption record'],
      [Buffer.concat([bom, bom, Buffer.from(`${capLines[0]!}\n`, 'utf8')]), 'export-demo: --captions line 1 is not a caption record'],
      [Buffer.concat([Buffer.from(`${capLines[0]!}\r\n`, 'utf8'), Buffer.from([0x7b, 0xff, 0x7d, 0x0d, 0x0a])]), 'export-demo: --captions line 2 is not UTF-8'],
    ] as const) {
      writeFileSync(capFile, file);
      const refused = join(outDir, 'refused.jsonl');
      const rr = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--captions', capFile, '--out', refused]);
      assert.deepEqual([rr.code, rr.err], [1, [msg]]);
      assert.equal(existsSync(refused), false, `${msg}: no file`);
    }
    // A caption the board cannot hold (beyond the tip, or a code the catalog lacks) refuses the run: exit 1, no file.
    for (const bad of ['{"t":"caption","room":"a","height":8,"code":"UI_VIZ_DEMO_CAPTION_1"}', '{"t":"caption","room":"a","height":1,"code":"UI_VIZ_DEMO_CAPTION_99"}',
      '{"t":"caption","room":"a","height":1,"code":"UI_VIZ_DEMO_CAPTION_1","text":"both"}', '{"t":"caption","room":"b","height":1,"text":"x"}']) {
      writeFileSync(capFile, `${bad}\n`);
      const refused = join(outDir, 'refused.jsonl');
      const r3 = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--captions', capFile, '--out', refused]);
      assert.equal(r3.code, 1, bad);
      assert.match(r3.err.join('\n'), /caption/, bad);
      assert.equal(existsSync(refused), false, `${bad}: no file`);
    }

    // The exported log folds to the board's own timeline.
    const t = await bothTimelines(fx, w.ref, bytes);
    assert.equal(t.demo.text, t.git.text, 'byte-identical timelines');
  } finally {
    await fx.cleanup();
  }
});

/** genesis, a join and a publish; then R-V19's live and board fixtures between ordinary commits; heights 0–8. */
async function malformedBoard(fx: RepoFixture, seed: string): Promise<BoardWriter> {
  const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed });
  await w.genesis('ann');                                                // 0
  await w.join('bob');                                                    // 1
  await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.ts'] }] });      // 2
  await w.malformed('live_not_commit');                                   // 3: names a tag
  await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.ts'] }] });      // 4: continues the live chain from 2, not from the tag
  await w.malformed('live_three_parents');                                // 5
  await w.malformed('board_ops_too_large');                               // 6: a malformed board commit
  await w.commit({ writer: 'bob' });                                      // 7: board-only after the no-op draft
  await w.commit({ writer: 'bob', cs: [{ paths: ['src/a.ts'] }] });      // 8
  return w;
}

test('export-demo encodes unreadable live commits and malformed board commits so the demo folds to the same timeline', async () => {
  const fx = await makeRepoFixture('viz-export-malformed');
  try {
    const w = await malformedBoard(fx, 'viz-export-malformed');
    const bytes = await exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: ROOM, captions: [] }, { git: vizOf(fx).git });
    const recs = recordsOf(parsed(bytes));
    assert.equal(recs.length, 9);
    // R-V19 (F8): a not_commit live, the live commit after it (no live step from the tag) and a three-parent live commit.
    for (const h of [3, 4, 5]) {
      assert.deepEqual(recs[h]!.code, UNCHANGED, `code ${h}`);
      assert.equal(recs[h]!.live, null, `no live ${h}`);
      assert.notEqual(recs[h]!.writer, null, `the board commit itself reads: writer ${h}`);
    }
    // The malformed board commit: writer null, ops [], cs [], csPaths {}, held [] with that code.
    const m = recs[6]!;
    assert.deepEqual([m.writer, m.ops, m.cs, [...m.csPaths], m.held, m.code, m.live, m.protocol], [null, [], [], [], [], UNCHANGED, null, null]);
    assert.ok(bytes.toString('utf8').split('\n')[7]!.endsWith('"code":{"changed":false,"seats":[],"base":null},"cs":[],"csPaths":{},"ops":[],"held":[]}'));
    assert.deepEqual(recs[8]!.code, { changed: true, seats: ['human'], base: null });

    const t = await bothTimelines(fx, w.ref, bytes);
    assert.equal(t.demo.text, t.git.text, 'byte-identical timelines');
    assert.equal(t.git.malformed, 1, 'one malformed board commit');
    assert.equal(t.git.shapeNull, 3, 'three changed frames without a live step');
    assert.equal(t.git.unknown - t.demo.unknown, t.git.malformed + t.git.shapeNull, 'only the unknown counts differ, by exactly those frames');

    // A missing object (a partial clone): a board commit naming a live commit the store lacks, under an ordinary one.
    const tip = await fx.repo.readCommit(w.tip().oid);
    const bad = await hashRaw(fx, 'commit', commitBytes(tip.tree, [w.tip().oid, NOT_STORED], `${BOARD_SUBJECT}\n`));
    const good = await hashRaw(fx, 'commit', commitBytes(tip.tree, [bad, tip.parents[1]!], `${BOARD_SUBJECT}\n`));
    await fx.repo.run(['update-ref', w.ref, good]);
    await assert.rejects(exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: ROOM, captions: [] }, { git: vizOf(fx).git }),
      (e: unknown) => e instanceof BoardObjectMissingError && e.height === 9);
    const out = join(fx.root, 'missing.jsonl');
    const r = runCli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--out', out]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /^export-demo: a board or live object of height 9 is missing$/m);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(out), false, 'no file is written');
  } finally {
    await fx.cleanup();
  }
});

test('--oplog only prints each op-log entry beside the heights of its peer\'s board commits and never adds a record', async () => {
  const fx = await makeRepoFixture('viz-export-oplog');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'viz-export-oplog' });
    await w.genesis('ann');                                                  // 0
    await w.join('bob');                                                      // 1
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.ts'] }] });        // 2
    await w.commit({ writer: 'bob', cs: [{ paths: ['src/b.ts'] }] });        // 3
    await w.commit({ writer: null, rawOps: ['{}'] });                         // 4: no writer
    await w.join('cat', { display: 'Peer p2' });                              // 5: the SIM adapter's display form
    await w.commit({ writer: 'ann' });                                        // 6
    const dir = join(fx.root, 'oplog dir');
    mkdirSync(dir);
    const opLog = join(dir, 'op-log.jsonl');
    const esc = String.fromCharCode(0x1b);
    const entries = [
      { step: 0, peer: 'Ann', kind: 'step', detail: 'dt=1' },
      { step: 0, peer: 'Ann', kind: 'edit', detail: 'src/a.ts' },
      { step: 1, peer: 'Bob', kind: 'step', detail: 'dt=3' },
      { step: 2, peer: 'p2', kind: 'step', detail: `${esc}[31mred${esc}[0m` },
      { step: 3, peer: 'zed', kind: 'step', detail: 'dt=2' },
    ];
    writeFileSync(opLog, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const without = join(dir, 'plain.jsonl');
    const withLog = join(dir, 'listed.jsonl');
    const a = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--out', without]);
    const b = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--oplog', opLog, '--out', withLog]);
    assert.equal(a.code, 0, a.err.join('\n'));
    assert.equal(b.code, 0, b.err.join('\n'));
    assert.ok(readFileSync(withLog).equals(readFileSync(without)), 'the op-log adds no record and changes no byte');
    assert.deepEqual(a.out, ['export-demo: wrote 7 commit records and 0 captions']);
    assert.deepEqual(b.out, [
      '0 Ann step dt=1  heights 0,2,6',
      '0 Ann edit src/a.ts  heights 0,2,6',
      '1 Bob step dt=3  heights 1,3',
      '2 p2 step red  heights 5',
      '3 zed step dt=2  heights -',
      'export-demo: wrote 7 commit records and 0 captions',
    ]);
    // The same op-log saved with a UTF-8 BOM and CRLF line ends lists the same lines.
    const windowsLog = join(dir, 'op-log-windows.jsonl');
    writeFileSync(windowsLog, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(entries.map((e) => `${JSON.stringify(e)}\r\n`).join(''), 'utf8')]));
    const bw = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--oplog', windowsLog, '--out', join(dir, 'listed-windows.jsonl')]);
    assert.deepEqual([bw.code, bw.out], [0, b.out], bw.err.join('\n'));
    assert.ok(readFileSync(join(dir, 'listed-windows.jsonl')).equals(readFileSync(without)));
    // An op-log line that is not an entry refuses the run before anything is read or written.
    writeFileSync(opLog, '{"step":0,"peer":"Ann","kind":"step"}\n');
    const bad = join(dir, 'bad.jsonl');
    const c = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--oplog', opLog, '--out', bad]);
    assert.deepEqual([c.code, c.err], [1, ['export-demo: --oplog line 1 is not an op-log entry']]);
    assert.equal(existsSync(bad), false);
  } finally {
    await fx.cleanup();
  }
});

test('export-demo reads the board only through VizGit', async () => {
  const fx = await makeRepoFixture('viz-export-vizgit');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'viz-export-vizgit' });
    await w.genesis('ann');
    await w.join('bob');
    // 1,300 heights: two read rounds of ≤ 1,280 board commits (one fast-import writes them).
    const filler: ScriptCommit[] = Array.from({ length: 1_298 }, (_, i) => (i % 97 === 0 ? { writer: i % 2 === 0 ? 'ann' : 'bob', cs: [{ paths: [`src/f${i}.ts`] }] } : { writer: i % 2 === 0 ? 'ann' : 'bob' }));
    await w.commitMany(filler);
    assert.equal(w.tip().height, 1_299);
    const sg = vizOf(fx);
    const bytes = await exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: ROOM, captions: [] }, { git: sg.git });
    assert.equal(recordsOf(parsed(bytes)).length, 1_300);
    for (const c of sg.calls) assert.ok(vizGitArgvOk(c.args), `allowlisted: ${JSON.stringify(c.args)}`);
    assert.deepEqual(kinds(sg.calls), ['rev-parse --verify', 'rev-list --first-parent', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch', 'cat-file --batch-check', 'cat-file --batch']);
    assert.deepEqual(sg.calls.map((c) => c.args.slice(2)), [
      ['-q', w.ref], ['--count', w.tip().oid], ['--skip=0', '--max-count=1300', w.tip().oid], [], [], [], [],
    ]);
    // A ref outside the allowlist is refused before anything is spawned; the CLI takes board refs only.
    const sg2 = vizOf(fx);
    await assert.rejects(exportDemo({ gitDir: fx.paths.gitDir, ref: 'refs/heads/main', room: ROOM, captions: [] }, { git: sg2.git }), VizGitRefused);
    assert.deepEqual(sg2.calls, []);
    const r = await cli(['--git-dir', fx.paths.gitDir, '--ref', 'refs/heads/main', '--out', join(fx.root, 'x.jsonl')]);
    assert.equal(r.code, 2);
    assert.match(r.err.join('\n'), /--ref must be a board ref refs\/cowork-remote\/<enc\(branch\)>\/board or refs\/cowork-ci\/<run_id>\/<enc\(branch\)>\/board/);
  } finally {
    await fx.cleanup();
  }
});

test('export-demo reads a refs/cowork-ci/<run_id>/<enc(branch)>/board ref (12 §3.9.3) through an export-only extra namespace and refuses every other ref (exit 2)', async () => {
  const fx = await makeRepoFixture('viz-export-ci');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'viz-export-ci' });
    await w.genesis('ann');                                               // 0
    await w.join('bob');                                                   // 1
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.ts'] }] });     // 2
    await w.commit({ writer: 'bob', code: 'base_move' });                 // 3
    // The same chain under the test namespace (glossary §4: refs/cowork-ci/<run_id>/ in place of refs/cowork/; src/engine/refs.ts
    // names a CI run's board refs/cowork-ci/<run_id>/<enc(ci/<run_id>/<b>)>/board).
    const ciMain = 'refs/cowork-ci/run_42-a/main/board';
    const ciReal = 'refs/cowork-ci/run_42-a/ci%2Frun_42-a%2Fmain/board';
    for (const ref of [ciMain, ciReal]) await fx.repo.run(['update-ref', ref, w.tip().oid]);
    const dir = join(fx.root, 'ci out');
    mkdirSync(dir);
    const remote = await cli(['--git-dir', fx.paths.gitDir, '--ref', w.ref, '--out', join(dir, 'remote.jsonl')]);
    const ci = await cli(['--git-dir', fx.paths.gitDir, '--ref', ciMain, '--out', join(dir, 'ci.jsonl')]);
    assert.deepEqual([remote.code, remote.err], [0, []]);
    assert.deepEqual([ci.code, ci.err], [0, []], 'a cowork-ci board ref is accepted');
    const remoteBytes = readFileSync(join(dir, 'remote.jsonl'));
    assert.ok(readFileSync(join(dir, 'ci.jsonl')).equals(remoteBytes), 'the same chain and branch: the same bytes');
    const real = await cli(['--git-dir', fx.paths.gitDir, '--ref', ciReal, '--out', join(dir, 'real.jsonl')]);
    assert.deepEqual([real.code, real.err], [0, []]);
    const realLog = parsed(readFileSync(join(dir, 'real.jsonl')));
    assert.deepEqual(realLog.rooms, [{ room: 'a', name: 'p1', branch: 'ci/run_42-a/main' }], 'the branch the CI ref encodes');
    assert.deepEqual(recordsOf(realLog), recordsOf(parsed(remoteBytes)), 'the same records');
    // Every other ref shape is still a usage error before anything is read or written: exit 2, no file.
    for (const ref of ['refs/cowork/main/board', 'refs/heads/main', 'refs/cowork-remote/main/code', 'refs/cowork-ci/run_42-a/board', 'refs/cowork-ci/run_42-a/main/code',
      'refs/cowork-ci/run_42-a/main/board/x', 'refs/cowork-ci/run_42-a/x/main/board', 'refs/cowork-ci/run 42/main/board', `refs/cowork-ci/${'r'.repeat(41)}/main/board`,
      'refs/cowork-ci/run.42/main/board', 'refs/cowork-ci/run_42-a/m%zz/board', 'refs/cowork-ci//main/board']) {
      const out = join(dir, 'refused.jsonl');
      const r = await cli(['--git-dir', fx.paths.gitDir, '--ref', ref, '--out', out]);
      assert.equal(r.code, 2, ref);
      assert.match(r.err.join('\n'), /--ref must be a board ref refs\/cowork-remote\/<enc\(branch\)>\/board or refs\/cowork-ci\/<run_id>\/<enc\(branch\)>\/board/, ref);
      assert.equal(existsSync(out), false, `${ref}: no file`);
    }

    // In-process: the export git (the CLI's) reads the CI ref with exactly one call outside the viewer allowlist, the CI rev-parse;
    // every later call is the viewer's own. The viewer's VizGit still refuses that ref before spawning anything (allowlist unchanged).
    assert.equal(vizGitArgvOk(['rev-parse', '--verify', '-q', ciMain]), false, 'the viewer allowlist does not take a cowork-ci ref');
    const eg = spiedExportGit(fx);
    const viaCi = await exportDemo({ gitDir: fx.paths.gitDir, ref: ciMain, room: ROOM, captions: [] }, { git: eg.git });
    assert.ok(viaCi.equals(await exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: ROOM, captions: [] }, { git: vizOf(fx).git })), 'the same log as the cowork-remote ref');
    assert.deepEqual(eg.calls.map((a) => `${a[0]} ${a[1]}`), ['rev-parse --verify', 'rev-list --first-parent', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch']);
    assert.deepEqual(eg.calls.filter((a) => !vizGitArgvOk(a)), [['rev-parse', '--verify', '-q', ciMain]], 'one export-only call: the CI rev-parse');
    const sv = vizOf(fx);
    await assert.rejects(exportDemo({ gitDir: fx.paths.gitDir, ref: ciMain, room: ROOM, captions: [] }, { git: sv.git }), VizGitRefused);
    assert.deepEqual(sv.calls, [], 'the viewer VizGit spawns nothing for a cowork-ci ref');
    // The export git refuses every other ref the viewer refuses, before spawning; an unknown CI board ref reads as no ref.
    const eg2 = spiedExportGit(fx);
    for (const ref of ['refs/heads/main', 'refs/cowork/main/board', 'refs/cowork-ci/run_42-a/main/code', 'refs/cowork-ci/run_42-a/board']) {
      await assert.rejects(eg2.git.revParse(ref), VizGitRefused, ref);
    }
    assert.deepEqual(eg2.calls, []);
    assert.equal(await eg2.git.revParse('refs/cowork-ci/run_42-a/nope/board'), null);
    await assert.rejects(exportDemo({ gitDir: fx.paths.gitDir, ref: 'refs/cowork-ci/run_42-a/nope/board', room: ROOM, captions: [] }, { git: eg2.git }), /does not resolve/);
    // Only that one rev-parse form joins the viewer allowlist.
    for (const args of [['rev-parse', ciMain], ['rev-parse', '--verify', ciMain], ['rev-parse', '--verify', '-q', ciMain, '--'], ['rev-parse', '--verify', '-q', 'refs/cowork/main/board'],
      ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/cowork-ci/'], ['rev-list', '--first-parent', '--count', ciMain], ['update-ref', ciMain, w.tip().oid]]) {
      assert.equal(exportGitArgvOk(args), false, JSON.stringify(args));
    }
    assert.equal(exportGitArgvOk(['rev-parse', '--verify', '-q', ciReal]), true);
  } finally {
    await fx.cleanup();
  }
});

test('export-demo writes live on every changed record and the git-source and demo timelines stay byte-identical', async () => {
  const fx = await makeRepoFixture('viz-export-live');
  try {
    const w = await malformedBoard(fx, 'viz-export-live');
    await w.commit({ writer: 'ann', code: 'base_move' });                                      // 9
    await w.commit({ writer: 'ann', ops: [{ type: 'seat_start', seat_id: SEAT, permission_mode: 'default' }] });   // 10
    await w.commit({ writer: 'ann', cs: [{ seat: SEAT, paths: ['src/c.ts'] }] });              // 11
    await w.commit({ writer: 'bob' });                                                          // 12
    const bytes = await exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: ROOM, captions: [] }, { git: vizOf(fx).git });
    const recs = recordsOf(parsed(bytes));
    const oids = (await fx.repo.run(['rev-list', '--first-parent', '--reverse', w.tip().oid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0).slice(1) as Oid[];
    const changed: number[] = [];
    for (const [h, oid] of oids.entries()) {
      const parents = (await fx.repo.readCommit(oid)).parents;
      if (recs[h]!.code.changed) {
        changed.push(h);
        assert.equal(recs[h]!.live, parents[parents.length - 1], `live ${h}: the named live commit`);
      } else {
        assert.equal(recs[h]!.live, null, `no live on an unchanged record ${h}`);
      }
    }
    assert.deepEqual(changed, [2, 8, 9, 11], 'every live step, and only those');
    const lines = bytes.toString('utf8').split('\n');
    assert.deepEqual(changed.map((h) => lines[h + 1]!.includes(`,"live":"${recs[h]!.live!}"`) && lines[h + 1]!.endsWith('}')), [true, true, true, true]);
    const t = await bothTimelines(fx, w.ref, bytes);
    assert.equal(t.demo.text, t.git.text, 'byte-identical timelines');
  } finally {
    await fx.cleanup();
  }
});
