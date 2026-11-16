// Plan 8a Task 18 step A: the bundled Plan 2 storyboard demo (12 §3.9.3 "The bundled demo", VIZ-27, INV-VIZ-DET; R-V32). The
// bundled demo src/viz/demo/plan2.jsonl is the export of a real board that tools/viz/storyboard.ts writes with Plan 2's own board
// writer (BoardWriter, a temp clone) and exports with tools/viz/export-demo.ts and the hand-written caption records of
// tools/viz/storyboard.captions.jsonl. These tests read the file as dist/viz.js embeds it: its shape and caps, every Plan 2 fact the
// storyboard must show (asserted on the timeline the viewer folds from it, and on the scenes that timeline reduces to), and that the
// tool regenerates it byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_CAPTION_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { actorKey, SUB_DERIVED, type ActorRef, type SceneEventKind } from '../../../src/viz/model/events.js';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { BIG_TABLE, ROOT_ZONE } from '../../../src/viz/model/layout.js';
import { reduceScene, type Scene } from '../../../src/viz/model/scene.js';
import { TimelineBuilder, type Timeline } from '../../../src/viz/model/timeline.js';
import { BUNDLED_DEMO_MAX_BYTES, DEMO_FORMAT, DemoRoomSource, parseDemoLog, type DemoLog } from '../../../src/viz/source/demo.js';
import { runStoryboard } from '../../../tools/viz/storyboard.js';
import type { EventOf } from '../../helpers/vizEvents.js';
import { viewerTemp } from '../../helpers/vizViewer.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BUNDLED = join(REPO, 'src', 'viz', 'demo', 'plan2.jsonl');
const STORYBOARD_TOOL = join(REPO, 'tools', 'viz', 'storyboard.ts');
/** The tool's own limit inside the 120 s test (Plan 8a final review, fix Group D; ledger L152). */
const STORYBOARD_TIMEOUT_MS = 110_000;
/** The caption codes the viewer accepts in a demo (src/viz/main.ts): the defined ones. */
const DEFINED_CAPTIONS: ReadonlySet<string> = new Set(DEMO_CAPTION_CODES.filter((c) => EN_VIZ[c] !== undefined));

function bundledLog(): DemoLog {
  const log = parseDemoLog(readFileSync(BUNDLED), DEFINED_CAPTIONS);
  if ('line' in log) assert.fail(`the bundled demo refuses at line ${log.line}`);
  return log;
}

/** The room's whole timeline from height 0, as the viewer folds the demo (DemoRoomSource frames through the timeline builder), and
 *  the frames' `unknown` count (ops and trailers the fold does not draw). */
async function timelineOf(log: DemoLog): Promise<{ t: Timeline; unknown: number }> {
  const src = new DemoRoomSource(log.rooms[0]!, log.commits.get(log.rooms[0]!.room)!);
  const tip = await src.tip();
  assert.ok(tip !== null);
  const start = await src.startAt(0);
  const b = TimelineBuilder.open(0, start);
  let unknown = 0;
  for await (const f of src.frames(start, 0, tip.height, ZERO_PEER)) unknown += b.push(f).unknown;
  return { t: b.timeline(), unknown };
}

/** The scene after every event of height h. */
const sceneAt = (t: Timeline, h: number): Scene => reduceScene(t, { height: h, sub: SUB_DERIVED, k: Number.MAX_SAFE_INTEGER });
const of = <K extends SceneEventKind>(t: Timeline, kind: K): Array<EventOf<K>> => t.events.filter((e): e is EventOf<K> => e.kind === kind);
const peerOf = (a: ActorRef): string | null => ('peer' in a ? a.peer : null);

test('the bundled demo is cowork-viz-demo/1, ≤ 64 KiB, LF without BOM or CR, one room shop-app on main, ≤ 120 heights and 3–5 caption codes defined in en', () => {
  const bytes = readFileSync(BUNDLED);
  assert.ok(bytes.length <= BUNDLED_DEMO_MAX_BYTES, `${bytes.length} bytes`);
  assert.equal(BUNDLED_DEMO_MAX_BYTES, 64 * 1024);
  assert.ok(!bytes.includes(0x0d), 'no CR');
  assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'no BOM');
  assert.equal(bytes[bytes.length - 1], 0x0a, 'the last line ends with LF');
  assert.equal((JSON.parse(bytes.toString('utf8').split('\n')[0]!) as { format: string }).format, DEMO_FORMAT);
  const log = bundledLog();
  assert.deepEqual(log.rooms, [{ room: 'a', name: 'shop-app', branch: 'main' }]);
  const commits = log.commits.get('a')!;
  assert.deepEqual([...log.commits.keys()], ['a']);
  assert.ok(commits.length >= 1 && commits.length <= 120, `${commits.length} heights`);
  assert.ok(log.captions.length >= 3 && log.captions.length <= 5, `${log.captions.length} captions`);
  const codes = log.captions.map((c) => c.code);
  for (const c of log.captions) {
    assert.equal(c.text, null, 'a bundled caption is a catalog code, never text');
    assert.ok(c.code !== null && DEMO_CAPTION_CODES.includes(c.code) && EN_VIZ[c.code] !== undefined, `${c.code} is defined in en`);
    assert.equal(c.room, 'a');
  }
  assert.equal(new Set(codes).size, codes.length, 'each caption code once');
  const heights = log.captions.map((c) => c.height);
  assert.deepEqual(heights, [...heights].sort((a, b) => a - b), 'captions in height order');
});

test('the storyboard shows every Plan 2 fact 12 §3.9.3 lists', async () => {
  const { t, unknown } = await timelineOf(bundledLog());
  const layout = t.layout;

  // The room opens at height 0.
  assert.deepEqual(of(t, 'room_open').map((e) => e.height), [0]);

  // Three people enter one after another (three heights, three peers).
  const enters = of(t, 'person_enter');
  assert.equal(enters.length, 3, JSON.stringify(enters));
  assert.equal(new Set(enters.map((e) => e.peer)).size, 3);
  assert.ok(enters[0]!.height < enters[1]!.height && enters[1]!.height < enters[2]!.height, enters.map((e) => e.height).join(','));
  const people = new Set(enters.map((e) => e.peer));

  // Human change-sets reach at least six file desks in at least three zones: one under src, test and the root zone '·'.
  const publishes = of(t, 'publish');
  const human = publishes.filter((e) => e.origin === 'human' && peerOf(e.actor) !== null);
  const fileDesks = new Set(human.flatMap((e) => [e.target, ...e.others]).filter((d) => layout.desks[d]?.kind === 'file'));
  assert.ok(fileDesks.size >= 6, `${fileDesks.size} file desks`);
  const zoneKeys = new Set([...fileDesks].map((d) => layout.zones.find((z) => z.index === layout.desks[d]!.zone)!.key));
  assert.ok(zoneKeys.size >= 3, [...zoneKeys].join(', '));
  assert.ok([...zoneKeys].some((k) => k === 'src' || k.startsWith('src/')), `a src zone: ${[...zoneKeys].join(', ')}`);
  assert.ok(zoneKeys.has('test') && zoneKeys.has(ROOT_ZONE), [...zoneKeys].join(', '));

  // Two people at one desk: a chair and a visitor, both people.
  const heights = [...new Set(t.events.map((e) => e.height))];
  const shared = heights.find((h) => [...sceneAt(t, h).desks.values()].some((d) => d.chair !== null && 'peer' in d.chair && d.visitors.some((v) => 'peer' in v)));
  assert.ok(shared !== undefined, 'some scene has a person in a chair and another on a visitor tile of the same desk');

  // One change-set with paper planes to two other desks.
  assert.ok(human.some((e) => e.target !== BIG_TABLE && e.others.length === 2), 'a publish with two paper planes');

  // One change-set of more than 256 paths at the big table (its paths are not on the board).
  assert.ok(publishes.some((e) => e.target === BIG_TABLE && e.paths.length === 0 && e.n > 256 && e.others.length === 0), 'the big table');

  // One person frozen (EPOCH) and thawed.
  const freeze = of(t, 'person_freeze').find((e) => e.reasonCode === 'EPOCH');
  assert.ok(freeze !== undefined, 'a freeze with reason EPOCH');
  assert.equal(sceneAt(t, freeze.height).characters.get(freeze.peer)?.frozen, 'EPOCH');
  const thaw = of(t, 'person_thaw').find((e) => e.peer === freeze.peer && e.height > freeze.height);
  assert.ok(thaw !== undefined, 'the frozen person thaws');
  assert.equal(sceneAt(t, thaw.height).characters.get(freeze.peer)?.frozen, null);

  // One slowed (HOST_THROTTLED) and later the host-refused "!".
  const slowed = of(t, 'person_slowed');
  assert.ok(slowed.length >= 1, 'a person is slowed');
  const bang = of(t, 'person_bang').find((b) => b.bang === 'host' && slowed.some((s) => s.peer === b.peer && s.height < b.height));
  assert.ok(bang !== undefined, 'the slowed person later shows person_bang{host}');
  assert.ok(sceneAt(t, bang.height).characters.get(bang.peer)!.slowedUntil! > bang.height, 'still slowed when the "!" shows');

  // One respawn with a new epoch.
  const respawn = of(t, 'person_respawn');
  assert.equal(respawn.length, 1, JSON.stringify(respawn));
  assert.ok(people.has(respawn[0]!.peer));

  // A person who stops publishing turns to the relaxed pose 64 heights after their last publish.
  const relaxed = of(t, 'pose_relaxed').filter((e) => 'peer' in e.actor);
  const last = (peer: string): number => Math.max(...human.filter((e) => peerOf(e.actor) === peer).map((e) => e.height));
  const r = relaxed.find((e) => last(peerOf(e.actor)!) + 64 === e.height);
  assert.ok(r !== undefined, `a pose_relaxed 64 heights after a person's last publish: ${JSON.stringify(relaxed.map((e) => [e.height, actorKey(e.actor)]))}`);
  assert.equal(sceneAt(t, r.height).characters.get(peerOf(r.actor)!)?.pose, 'relaxed');
  assert.ok(respawn[0]!.peer !== peerOf(r.actor) || respawn[0]!.height < last(peerOf(r.actor)!), 'the relaxing person does not respawn after their last publish');

  // Only facts the Plan 2 fold applies, all drawn: no unknown op or trailer, no pet, ghost or exit.
  assert.equal(unknown, 0);
  assert.deepEqual([of(t, 'pet_spawn').length, of(t, 'person_ghost').length, of(t, 'person_exit').length], [0, 0, 0]);
});

test('regenerating the storyboard reproduces src/viz/demo/plan2.jsonl byte for byte', { timeout: 120_000 }, async () => {
  // The tool itself, as a developer runs it: --check exits 0 and writes nothing. It is given 110 s of the test's 120 s (≈ 24 s
  // measured), so a hung tool fails here, named, instead of holding the file until the runner's own limit; a run the timeout ended
  // (spawnSync's ETIMEDOUT error and SIGTERM) or a signal fails before its exit code is read.
  const before = readFileSync(BUNDLED);
  const r = spawnSync(process.execPath, ['--import', 'tsx', STORYBOARD_TOOL, '--check'], { cwd: REPO, encoding: 'utf8', timeout: STORYBOARD_TIMEOUT_MS });
  assert.equal(r.error, undefined, `the tool ran to its end within ${STORYBOARD_TIMEOUT_MS} ms: ${String(r.error)}`);
  assert.equal(r.signal, null, `no signal ended the tool: ${String(r.signal)}`);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^storyboard: src\/viz\/demo\/plan2\.jsonl matches \([0-9]+ bytes\)\n$/);
  assert.ok(readFileSync(BUNDLED).equals(before), '--check wrote nothing');

  // The check and write paths, over a copy of the repository files the tool reads and writes (the export stands in for a build).
  const root = join(viewerTemp('storyboard'), 'repo');
  mkdirSync(join(root, 'src', 'viz', 'demo'), { recursive: true });
  mkdirSync(join(root, 'tools', 'viz'), { recursive: true });
  copyFileSync(join(REPO, 'tools', 'viz', 'storyboard.captions.jsonl'), join(root, 'tools', 'viz', 'storyboard.captions.jsonl'));
  const file = join(root, 'src', 'viz', 'demo', 'plan2.jsonl');
  const lines: string[] = [];
  const io = { out: (l: string) => { lines.push(`out ${l}`); }, err: (l: string) => { lines.push(`err ${l}`); } };
  const demo = async (): Promise<Buffer> => before;
  assert.equal(await runStoryboard(['--check'], { root, io, demo }), 1, 'a missing file differs');
  writeFileSync(file, Buffer.concat([before, Buffer.from('\n')]));
  assert.equal(await runStoryboard(['--check'], { root, io, demo }), 1, 'one extra byte differs');
  writeFileSync(file, before.toString('utf8').replace(/\n/g, '\r\n'));
  assert.equal(await runStoryboard(['--check'], { root, io, demo }), 1, 'CRLF differs');
  assert.equal(await runStoryboard([], { root, io, demo }), 0);
  assert.ok(readFileSync(file).equals(before), 'the write is the exported bytes exactly');
  assert.equal(await runStoryboard(['--check'], { root, io, demo }), 0);
  assert.equal(await runStoryboard(['--bogus'], { root, io, demo }), 2);
  assert.deepEqual(lines.filter((l) => l.startsWith('err')).length, 4, lines.join('\n'));
});
