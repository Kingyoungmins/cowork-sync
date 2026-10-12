// node --import tsx tools/viz/storyboard.ts [--check] (Plan 8a Task 18; 12 §3.9.3 "The bundled demo", VIZ-27, INV-VIZ-DET; R-V32):
// builds the Plan 2 storyboard as a real board — Plan 2's own board writer (tools/viz/boardWriter.ts) in a temp clone, three
// people `mina`, `theo` and `jun` (fictional display names) — exports it with tools/viz/export-demo.ts and the hand-written
// caption records of tools/viz/storyboard.captions.jsonl, and writes src/viz/demo/plan2.jsonl, the demo dist/viz.js embeds; with
// --check it compares the export with that file byte for byte and writes nothing (exit 1 when they differ). A dev tool, never
// shipped. Every fact of the story is one the Plan 2 fold applies (12 §3.9.3: the bundled demo grows with the plans).
//
// The story, one board commit per height (the caption heights of storyboard.captions.jsonl name these):
//    0  mina opens the room shop-app on main (caption 1)          1, 2  theo and jun enter (caption 2 at 1)
//    3  mina's change-set: src/cart.ts with paper planes to src/price.ts and test/cart.test.ts (caption 3)
//    4  theo's change-set at src/cart.ts: theo in the chair, mina on a visitor tile
//    6  jun's change-set of 300 files: not on the board, so the big table
//   11  mina frozen (EPOCH: a git command outside cowork-sync, caption 4)     16  mina thawed
//   12  jun slowed (HOST_THROTTLED)                                           20  jun's host-refused "!" (nonretryable)
//   24  theo rejoins with a new epoch (respawn)                               30  jun's last change-set
//   31–99  mina and theo keep publishing;  94  jun turns to the relaxed pose, 64 heights after his last publish (caption 5)
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventKind, OpDraft } from '../../src/board/ops.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { DEMO_CAPTION_CODES } from '../../src/viz/i18n/codes.js';
import { BUNDLED_DEMO_MAX_BYTES, DemoRoomSource, parseDemoLog, type DemoRoomHeader } from '../../src/viz/source/demo.js';
import { GitRoomSource } from '../../src/viz/source/git.js';
import { createVizGit } from '../../src/viz/source/vizGit.js';
import { makeRepoFixture } from '../../test/helpers/repoFixture.js';
import { vizRunner } from '../../test/helpers/vizSource.js';
import { BoardWriter, type ScriptCommit } from './boardWriter.js';
import { exportDemo, parseCaptionsFile } from './export-demo.js';
import { roomTimeline } from './golden.js';

/** The bundled demo and the caption records, repository-relative and '/'-separated. */
export const STORYBOARD_DEMO = posix.join('src', 'viz', 'demo', 'plan2.jsonl');
export const STORYBOARD_CAPTIONS = posix.join('tools', 'viz', 'storyboard.captions.jsonl');
/** The seed of the board's peer ids and epochs (BoardWriter), so the export is the same bytes on every run and OS. */
export const STORYBOARD_SEED = 'viz-storyboard-plan2';
export const STORYBOARD_ROOM: DemoRoomHeader = Object.freeze({ room: 'a', name: 'shop-app', branch: 'main' });

/** A step after genesis: a ScriptCommit (consecutive ones go to one commitMany) or a join. */
type Step = ScriptCommit | { join: string; o?: Parameters<BoardWriter['join']>[1] };

const ev = (kind: EventKind, reason: string): OpDraft => ({ type: 'event', cid: '', kind, refs: [], reason_code: reason });
const cs = (writer: string, ...paths: string[]): ScriptCommit => ({ writer, cs: [{ paths }] });
/** n generated asset files of one folder: a change-set of more than 256 paths has no Cowork-CS-Paths trailer (glossary §5). */
const many = (n: number, dir: string): string[] => Array.from({ length: n }, (_, i) => `${dir}/icon-${String(i).padStart(3, '0')}.svg`);

const CART = 'src/cart.ts', PRICE = 'src/price.ts', CHECKOUT = 'src/checkout.ts';
const CART_VIEW = 'src/ui/cart_view.tsx', BUTTON = 'src/ui/button.tsx';
const CART_TEST = 'test/cart.test.ts', PRICE_TEST = 'test/price.test.ts';
const README = 'README.md', PACKAGE = 'package.json', SETUP = 'docs/setup.md';
/** The last height of the story (100 heights, within 12 §3.9.3's 120). */
export const STORYBOARD_TIP = 99;

/** The script after genesis('mina'), heights 1 … STORYBOARD_TIP in order. */
export function storyboardSteps(): Step[] {
  const steps: Step[] = [
    { join: 'theo' },                                    // 1
    { join: 'jun' },                                     // 2
    cs('mina', CART, PRICE, CART_TEST),                  // 3: target src/cart.ts (first key), planes to two other desks
    cs('theo', CART),                                    // 4: two people at src/cart.ts
    cs('jun', README),                                   // 5: the root zone '·'
    { writer: 'jun', cs: [{ paths: many(300, 'assets/icons') }] },   // 6: the big table
    cs('theo', PRICE_TEST),                              // 7
    cs('mina', CART_VIEW),                               // 8
    cs('jun', PACKAGE),                                  // 9
    cs('theo', CHECKOUT),                                // 10
    { writer: 'mina', ops: [ev('freeze', 'EPOCH')] },    // 11: mina frozen
    { writer: 'jun', ops: [ev('health', 'HOST_THROTTLED')] },   // 12: jun slowed
    cs('theo', CART, CART_TEST),                         // 13
    cs('jun', README),                                   // 14
    cs('theo', BUTTON),                                  // 15
    { writer: 'mina', ops: [ev('unfreeze', 'EPOCH')] },  // 16: mina thawed
    cs('mina', CART_VIEW, BUTTON),                       // 17
    cs('jun', PACKAGE),                                  // 18
    cs('theo', PRICE),                                   // 19
    { writer: 'jun', ops: [ev('nonretryable', 'NONRETRYABLE')] },   // 20: the host refused jun's pushes: "!"
    cs('mina', CART_TEST),                               // 21
    cs('theo', CHECKOUT),                                // 22
    cs('jun', SETUP),                                    // 23
    { join: 'theo', o: { newEpoch: true } },             // 24: theo respawns
    cs('theo', CART),                                    // 25
    cs('mina', README),                                  // 26
    cs('jun', PACKAGE, README),                          // 27
    cs('theo', PRICE_TEST),                              // 28
    cs('mina', PRICE),                                   // 29
    cs('jun', PACKAGE),                                  // 30: jun's last change-set
  ];
  // 31 … 99: mina and theo take turns (jun writes nothing more and relaxes at 30 + 64 = 94); nobody else sits at package.json.
  const mina = [CART, PRICE, CART_VIEW, CART_TEST, README];
  const theo = [CHECKOUT, PRICE_TEST, BUTTON, CART];
  for (let h = 31, i = 0; h <= STORYBOARD_TIP; h++, i++) {
    steps.push(i % 2 === 0 ? cs('mina', mina[(i / 2) % mina.length]!) : cs('theo', theo[((i - 1) / 2) % theo.length]!));
  }
  return steps;
}

/**
 * The storyboard's demo log: the board written into a fresh temp clone (one commitMany per run of ScriptCommits, a join on its own),
 * exported with the captions file of `root`. The git source's timeline and the exported demo's must be byte-identical (12 §3.9.3),
 * and the log must fit the bundled cap; else it throws. The temp clone is removed.
 */
export async function storyboardDemo(root: string): Promise<Buffer> {
  const captions = parseCaptionsFile(readFileSync(join(root, ...STORYBOARD_CAPTIONS.split('/'))));
  if (!Array.isArray(captions)) throw new Error(`storyboard: ${STORYBOARD_CAPTIONS} line ${captions.line} is not a caption record`);
  const fx = await makeRepoFixture('viz-storyboard');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: STORYBOARD_ROOM.branch, seed: STORYBOARD_SEED });
    await w.genesis('mina');
    let batch: ScriptCommit[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length > 0) await w.commitMany(batch);
      batch = [];
    };
    for (const s of storyboardSteps()) {
      if ('join' in s) {
        await flush();
        await w.join(s.join, s.o);
      } else {
        batch.push(s);
      }
    }
    await flush();
    if (w.tip().height !== STORYBOARD_TIP) throw new Error(`storyboard: the board ends at height ${w.tip().height}, not ${STORYBOARD_TIP}`);
    const dataDir = join(fx.root, 'viz data');
    const runner = vizRunner(dataDir);
    const bytes = await exportDemo({ gitDir: fx.paths.gitDir, ref: w.ref, room: { ...STORYBOARD_ROOM }, captions }, { git: createVizGit({ runner, gitDir: fx.paths.gitDir, dataDir }) });
    if (bytes.length > BUNDLED_DEMO_MAX_BYTES) throw new Error(`storyboard: the demo is ${bytes.length} bytes, over the bundled ${BUNDLED_DEMO_MAX_BYTES}`);
    const log = parseDemoLog(bytes, new Set(DEMO_CAPTION_CODES));
    if ('line' in log) throw new Error(`storyboard: the exported demo refuses at line ${log.line}`);
    const demo = await roomTimeline(new DemoRoomSource(log.rooms[0]!, log.commits.get(STORYBOARD_ROOM.room)!));
    const spec = { id: 'r00000000', kind: 'git' as const, label: STORYBOARD_ROOM.name, branch: STORYBOARD_ROOM.branch, gitDir: fx.paths.gitDir, boardRef: w.ref, canonicalRoot: null };
    const git = await roomTimeline(new GitRoomSource(spec, createVizGit({ runner, gitDir: fx.paths.gitDir, dataDir }), { fs: realFs, clock: realClock }));
    if (git.text !== demo.text) throw new Error('storyboard: the git source\'s and the exported demo\'s timelines differ');
    return bytes;
  } finally {
    await fx.cleanup();
  }
}

export interface StoryboardIo { out(line: string): void; err(line: string): void; }

const USAGE = 'usage: node --import tsx tools/viz/storyboard.ts [--check]';

/**
 * argv [] writes `root`/src/viz/demo/plan2.jsonl (exactly the exported bytes) and exits 0; ['--check'] writes nothing and exits 0
 * when the file holds exactly those bytes, else 1 naming the file; anything else is a usage error (2). `demo` stands in for
 * storyboardDemo (tests).
 */
export async function runStoryboard(argv: readonly string[], o: { root: string; io: StoryboardIo; demo?: (root: string) => Promise<Buffer> }): Promise<number> {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length > 0 && !check) {
    o.io.err(USAGE);
    return 2;
  }
  const bytes = await (o.demo ?? storyboardDemo)(o.root);
  const file = join(o.root, ...STORYBOARD_DEMO.split('/'));
  if (check) {
    let old: Buffer | null = null;
    try {
      old = readFileSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (old !== null && old.equals(bytes)) {
      o.io.out(`storyboard: ${STORYBOARD_DEMO} matches (${bytes.length} bytes)`);
      return 0;
    }
    o.io.err(`storyboard: ${STORYBOARD_DEMO} ${old === null ? 'is missing' : 'differs from the storyboard'}; run \`node --import tsx tools/viz/storyboard.ts\` and review the diff`);
    return 1;
  }
  writeFileSync(file, bytes);
  o.io.out(`storyboard: wrote ${STORYBOARD_DEMO} (${bytes.length} bytes)`);
  return 0;
}

/** This module is the process entry (node --import tsx tools/viz/storyboard.ts), not an import. */
function isMain(url: string): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  const canon = (p: string): string => {
    let r = resolve(p);
    try {
      r = realpathSync.native(r);
    } catch {
      // not a file on disk: compare as given
    }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return canon(arg) === canon(fileURLToPath(url));
}

if (isMain(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  runStoryboard(process.argv.slice(2), { root, io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) } }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`storyboard: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
