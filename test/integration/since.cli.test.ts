// The terminal `since` verb (F04-a Task A3; 10-product §3.9a, §7 T-F04-anchors and T-F04-readonly, `tty` rows; FEAT-F04-01,
// -02, -08, -17): runSince over a real clone holding the SB-F04 board (test/helpers/sbF04.ts) and this peer's `peer` file.
// The anchor rows without `last-run` (Plan 5), the read-only rows in `tty` mode (refs, registry and worktree mtimes
// unchanged across 3 runs; an argv spy on the CLI's own git runner: local calls only, every object it names is one of the
// board commit's own objects), the anchor search that does not depend on the walk's fold window (controller ruling A3),
// and dist/cli.js dispatching `since`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enc } from '../../src/git/enc.js';
import { createGitRunner, type GitRunner, type GitRunnerDeps } from '../../src/git/runner.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { EN_SINCE_CLI, runSince } from '../../src/since/cli.js';
import { walkSince } from '../../src/since/walk.js';
import type { CliEnv } from '../../src/viz/cli/view.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { SAVE_C, SB_SEED, sbF04, sbF04ARejoins, sbF04Peers, sbPeerIds, sbWrite, type SbAction } from '../helpers/sbF04.js';
import { makeTempRoot } from '../helpers/tmp.js';

const PEERS = sbF04Peers();
const A = PEERS.a.peer;
const C8 = SAVE_C.slice(0, 8);

/** One git call of the CLI's runner: argv, its class, stdin and stdout. */
interface Call { args: string[]; cls: string; stdin: string; stdout: Buffer; code: number; }

/** Runs after each recorded call of the CLI's runner, before the CLI sees its result (a test's way to change the repository between two calls). */
type AfterCall = (c: Call) => Promise<void>;

/** The CLI's git runner (built by runSince from its own deps), wrapped so that every call is recorded. */
function spying(calls: Call[], after?: AfterCall): { gitRunner: (d: GitRunnerDeps) => GitRunner } {
  return {
    gitRunner: (d: GitRunnerDeps): GitRunner => {
      const real = createGitRunner(d);
      return {
        async run(args, opts) {
          const r = await real.run(args, opts);
          const call = { args: [...args], cls: opts.class, stdin: opts.stdin?.toString('utf8') ?? '', stdout: r.stdout, code: r.code };
          calls.push(call);
          if (after !== undefined) await after(call);
          return r;
        },
      };
    },
  };
}

interface Run { code: number; outs: string[]; errs: string[]; calls: Call[]; }

/** A CliEnv over the real Fs and clock whose out/err record; a TTY unless said otherwise. */
function cliEnv(cwd: string, outs: string[], errs: string[], o: { isTTY?: boolean; env?: Record<string, string | undefined> } = {}): CliEnv {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'CLAUDECODE') env[k] = v;
  const unused = (): never => { throw new Error('since starts no viewer'); };
  return {
    pluginRoot: cwd, cwd, env: o.env ?? env, platform: process.platform, isTTY: o.isTTY ?? true, home: cwd, locale: 'en-US',
    execPath: process.execPath, uid: null,
    out: (s: string) => { outs.push(s); },
    err: (s: string) => { errs.push(s); },
    fs: realFs, clock: realClock,
    ownerProbe: { posix: unused, euid: unused, windows: unused },
    spawnViewer: unused, openUrl: unused,
  };
}

async function since(cwd: string, argv: string[], o: { isTTY?: boolean; env?: Record<string, string | undefined>; after?: AfterCall } = {}): Promise<Run> {
  const outs: string[] = [];
  const errs: string[] = [];
  const calls: Call[] = [];
  const code = await runSince(argv, cliEnv(cwd, outs, errs, o), spying(calls, o.after));
  return { code, outs, errs, calls };
}

/** The clone's `<gitDir>/cowork/peer` file (glossary §6), as the daemon writes it. */
function writePeer(fx: RepoFixture, peer: string): void {
  mkdirSync(fx.paths.coworkDir, { recursive: true });
  writeFileSync(join(fx.paths.coworkDir, 'peer'), `${peer}\n`);
}

/** UI_SINCE_HEAD in en: the heights as typed, the count of heights with en's digit grouping and plural. */
const head = (from: number, anchor: string, to: number): string =>
  `Since #${from} (${anchor}) to #${to}: ${new Intl.NumberFormat('en').format(to - from)} board height${to - from === 1 ? '' : 's'}.`;
/** A's peer id on a board that only B and A write (BoardWriter draws peer ids in first-use order). */
const A_OF_BA = sbPeerIds(SB_SEED, ['b', 'a']).get('a')!.peer;
const ANCHOR_REFUSAL = 'cowork-sync: that --since value names no point to start from (use #<height> below the board tip, or save: and 7 to 64 hex digits of a save) [RF_SINCE_ANCHOR]\nnext: /cowork since';
const AMBIGUOUS = 'cowork-sync: that save: prefix matches more than one save [AMBIGUOUS_ID]\nnext: (none: give more hex digits of the save after save:)';
const UNKNOWN_FLAG = 'cowork-sync: unknown flag; since takes only --since=<anchor>, where <anchor> is #<height> or save:<hex> [RF_UNKNOWN_FLAG]\nnext: /cowork since';
/** RF_SINCE_NOT_LIVE (registered by the F04-a Task A3 fix r1 ruling): no main worktree, a detached HEAD, a branch without a
 *  board, a missing or invalid peer file, and the default anchor of a peer that never joined the board. */
const NOT_LIVE = 'cowork-sync: this PC has not joined a cowork-sync board here; run since in the main worktree of a repository where cowork-sync '
  + 'runs, on its branch [RF_SINCE_NOT_LIVE]\nnext: /cowork start';

/** SB-F04 from #10 (T-F04-golden's range) as the terminal prints it: sections in §3.9a order, empty ones left out. */
const GOLDEN_FROM_10 = [
  head(10, 'the height you gave', 30),
  'Saves:',
  `  C saved ${C8}`,
  'Team:',
  '  B: 1 change-set',
  '    src/engine (1)',
  'Events:',
  '  #25 B rejoined (new session)',
  '  #30 C paused sharing',
];

/** SB-F04 written on `main` and a variant with a second save at 22 whose commit shares C's first seven hex digits. */
const SAVE_22 = 'c0ffee01' + 'e'.repeat(32);
function twoSaves(): SbAction[] {
  const actions = sbF04({});
  actions[22] = { kind: 'commit', c: { writer: 'b', ops: [{ type: 'save', save_commit: SAVE_22, saved_live: 'a'.repeat(40), chain_base: 'b'.repeat(40), released_claim_ids: [] }] } };
  return actions;
}

test('T-F04-anchors (F04-a rows): #17, save:<c8>, save:deadbee and #999999, --since=away, and the default anchor on a clone with no meta.since (A joined at 4)', async () => {
  const fx = await makeRepoFixture('since-cli-anchors');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    writePeer(fx, A);
    const cwd = fx.paths.workTree;

    const dflt = await since(cwd, []);
    assert.deepEqual([dflt.code, dflt.errs, dflt.outs[0]], [0, [], head(4, 'when this PC joined', 30)]);
    const h17 = await since(cwd, ['--since=#17']);
    assert.deepEqual([h17.code, h17.errs, h17.outs[0]], [0, [], head(17, 'the height you gave', 30)]);
    for (const v of [C8, SAVE_C.slice(0, 7), SAVE_C, C8.toUpperCase()]) {
      const s = await since(cwd, [`--since=save:${v}`]);
      assert.deepEqual([s.code, s.errs, s.outs[0]], [0, [], head(20, `save ${C8}`, 30)], v);
    }
    // #0 is below the tip; #29 is the last height below it.
    assert.equal((await since(cwd, ['--since=#0'])).outs[0], head(0, 'the height you gave', 30));
    assert.equal((await since(cwd, ['--since=#29'])).outs[0], head(29, 'the height you gave', 30));

    // Refused (FEAT-F04-02, -17): an unknown save, a height not below the tip, away, and last-run before Plan 5's marks.
    for (const v of ['save:deadbee', '#999999', '#30', 'away', 'last-run', '', '#017', 'save:c0ffe']) {
      const r = await since(cwd, [`--since=${v}`]);
      assert.deepEqual([r.code, r.outs, r.errs], [1, [], [ANCHOR_REFUSAL]], v);
    }

    // Two saves whose commits share the prefix c0ffee0: ambiguous; one more digit picks each.
    await sbWrite(fx, SB_SEED, twoSaves(), 'two');
    await fx.repo.run(['symbolic-ref', 'HEAD', 'refs/heads/two']);
    const amb = await since(cwd, ['--since=save:c0ffee0']);
    assert.deepEqual([amb.code, amb.outs, amb.errs], [1, [], [AMBIGUOUS]]);
    assert.equal((await since(cwd, ['--since=save:c0ffee01'])).outs[0], head(22, 'save c0ffee01', 30));
    assert.equal((await since(cwd, ['--since=save:c0ffee00'])).outs[0], head(20, `save ${C8}`, 30));
  } finally {
    await fx.cleanup();
  }
});

test('T-F04-anchors: save:<prefix> resolves a save below this peer\'s newest join, and a prefix matching saves on both sides of that join is AMBIGUOUS_ID; the default anchor is the newest join (final review I1, M6)', async () => {
  const fx = await makeRepoFixture('since-cli-save-join');
  try {
    // A rejoins in a new epoch at 25, above C's save at 20.
    await sbWrite(fx, SB_SEED, sbF04ARejoins(), 'main');
    writePeer(fx, A);
    const cwd = fx.paths.workTree;
    // The default anchor is A's newest join (25), not its first one (4).
    const dflt = await since(cwd, []);
    assert.deepEqual([dflt.code, dflt.errs, dflt.outs[0]], [0, [], head(25, 'when this PC joined', 30)]);
    // The report from #19 lists C's save at 20 ...
    const h19 = await since(cwd, ['--since=#19']);
    assert.deepEqual([h19.code, h19.outs.slice(0, 3)], [0, [head(19, 'the height you gave', 30), 'Saves:', `  C saved ${C8}`]]);
    // ... and the same save is an anchor (10-product §3.9a: no join bound on save:).
    for (const v of [C8, SAVE_C.slice(0, 7), SAVE_C, C8.toUpperCase()]) {
      const s = await since(cwd, [`--since=save:${v}`]);
      assert.deepEqual([s.code, s.errs, s.outs[0]], [0, [], head(20, `save ${C8}`, 30)], v);
    }

    // B saves c0ffee01… at 27, above A's join: c0ffee0 matches one save on each side of it.
    await sbWrite(fx, SB_SEED, sbF04ARejoins({ save27: true }), 'two');
    await fx.repo.run(['symbolic-ref', 'HEAD', 'refs/heads/two']);
    const amb = await since(cwd, ['--since=save:c0ffee0']);
    assert.deepEqual([amb.code, amb.outs, amb.errs], [1, [], [AMBIGUOUS]]);
    assert.equal((await since(cwd, ['--since=save:c0ffee01'])).outs[0], head(27, 'save c0ffee01', 30));
    assert.equal((await since(cwd, ['--since=save:c0ffee00'])).outs[0], head(20, `save ${C8}`, 30));
    assert.equal((await since(cwd, [])).outs[0], head(25, 'when this PC joined', 30));
    // An unknown save is still refused after the whole chain is searched.
    const none = await since(cwd, ['--since=save:deadbee']);
    assert.deepEqual([none.code, none.outs, none.errs], [1, [], [ANCHOR_REFUSAL]]);
    // A malformed save: value is refused on the tip-only path, like an unreachable #<n>: no whole-chain search (FF re-review).
    const kinds = (r: Run): string[] => r.calls.map((c) => c.args.slice(0, 2).join(' '));
    const tipOnly = await since(cwd, ['--since=#999999']);
    for (const v of ['save:c0ffe', 'save:zzzzzzz', 'save:']) {
      const m = await since(cwd, [`--since=${v}`]);
      assert.deepEqual([m.code, m.outs, m.errs], [1, [], [ANCHOR_REFUSAL]], v);
      assert.deepEqual(kinds(m), kinds(tipOnly), `${v}: only the tip-only reads`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('the anchor search and the walk read one board chain: a board ref rewritten between the two reads changes nothing (final review M3)', async () => {
  const fx = await makeRepoFixture('since-cli-one-chain');
  try {
    const w = await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    writePeer(fx, A);
    const ref = `refs/cowork-remote/${enc('main')}/board`;
    const chain = (await fx.repo.run(['rev-list', '--first-parent', w.tip().oid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    const at22 = chain[30 - 22]!;
    for (const argv of [[], ['--since=#17'], [`--since=save:${C8}`]]) {
      await fx.repo.run(['update-ref', ref, w.tip().oid]);
      const plain = await since(fx.paths.workTree, argv);
      assert.equal(plain.code, 0, plain.errs.join('\n'));
      // An incident rewrite fetched right after the anchor search read the ref: the ref now names the old chain's height 22.
      let moved = false;
      const raced = await since(fx.paths.workTree, argv, {
        after: async (c) => {
          if (moved || c.args[0] !== 'for-each-ref') return;
          moved = true;
          await fx.repo.run(['update-ref', ref, at22]);
        },
      });
      assert.ok(moved, argv.join(' '));
      assert.deepEqual([raced.code, raced.errs, raced.outs], [0, [], plain.outs], argv.join(' '));
      assert.equal(raced.calls.filter((c) => c.args[0] === 'for-each-ref').length, 1, `${argv.join(' ')}: one read of the board ref`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('since reads the peer file bounded: a regular file of at most 4 KiB, else RF_SINCE_NOT_LIVE (an oversized file, a directory named peer) (final review M10)', async () => {
  const fx = await makeRepoFixture('since-cli-peer-bounded');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    const cwd = fx.paths.workTree;
    const peer = join(fx.paths.coworkDir, 'peer');
    mkdirSync(fx.paths.coworkDir, { recursive: true });
    // Exactly 4,096 bytes (the id, then blanks) is read.
    writeFileSync(peer, `${A}\n`.padEnd(4_096, ' '));
    assert.equal(lstatSync(peer).size, 4_096);
    const full = await since(cwd, []);
    assert.deepEqual([full.code, full.errs, full.outs[0]], [0, [], head(4, 'when this PC joined', 30)]);
    // One byte more is not read at all (an unbounded read would trim it to the same valid id).
    writeFileSync(peer, `${A}\n`.padEnd(4_097, ' '));
    const big = await since(cwd, []);
    assert.deepEqual([big.code, big.outs, big.errs], [1, [], [NOT_LIVE]]);
    // A directory named peer.
    rmSync(peer);
    mkdirSync(peer);
    const dir = await since(cwd, []);
    assert.deepEqual([dir.code, dir.outs, dir.errs], [1, [], [NOT_LIVE]]);
  } finally {
    await fx.cleanup();
  }
});

test('since --since=#10 prints SB-F04 golden report in English, in the order of 10-product §3.9a; a range with nothing in it prints UI_SINCE_NOTHING', async () => {
  const fx = await makeRepoFixture('since-cli-golden');
  try {
    await sbWrite(fx, SB_SEED, sbF04({ aCsAt8: true }), 'main');
    writePeer(fx, A);
    const r = await since(fx.paths.workTree, ['--since=#10']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.errs, []);
    // A's own change-set on loop.ts at 8 makes B's group a touch, printed first (section 2).
    assert.deepEqual(r.outs, [GOLDEN_FROM_10[0], 'For you:', '  B changed src/engine/loop.ts in 1 change-set', ...GOLDEN_FROM_10.slice(1)]);
    // (29, 30] holds only C's freeze; (30, 30] is empty: from the tip of the default anchor on a peer that just joined.
    const last = await since(fx.paths.workTree, ['--since=#29']);
    assert.deepEqual(last.outs, [head(29, 'the height you gave', 30), 'Events:', '  #30 C paused sharing']);
    // A run from a subfolder finds the same clone.
    const sub = await since(join(fx.paths.workTree, 'src'), ['--since=#29']);
    assert.deepEqual(sub.outs, last.outs);
  } finally {
    await fx.cleanup();
  }
  const fy = await makeRepoFixture('since-cli-nothing');
  try {
    // A joins at the tip: the default range (1, 1] is empty.
    await sbWrite(fy, SB_SEED, [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'a' }], 'main');
    writePeer(fy, A_OF_BA);
    const r = await since(fy.paths.workTree, []);
    assert.deepEqual([r.code, r.errs, r.outs], [0, [], [head(1, 'when this PC joined', 1), 'Nothing new in this range: no saves, change-sets or events.']]);
  } finally {
    await fy.cleanup();
  }
});

test('the default anchor comes from a search of its own (controller ruling A3): a join older than the walk window still resolves, and a capped range prints UI_SINCE_OLDER', { timeout: 600_000 }, async () => {
  const fx = await makeRepoFixture('since-cli-oldjoin');
  try {
    const tip = 6_400;
    const actions: SbAction[] = [{ kind: 'genesis', writer: 'b' }, { kind: 'join', name: 'a' }];
    while (actions.length <= tip) actions.push({ kind: 'commit', c: { writer: 'b' } });
    await sbWrite(fx, SB_SEED, actions, 'main');
    const you = A_OF_BA;
    writePeer(fx, you);
    // The walk of (1, 6400] folds (6400 − 5,000 − 1,024 − 256, 6400]: it never sees A's join at 1.
    const walked = await walkSince(fx.repo, 'main', { from: 1, to: tip, you, mine: [] });
    assert.equal(walked.joinHeight, null);
    const r = await since(fx.paths.workTree, []);
    assert.equal(r.code, 0, r.errs.join('\n'));
    assert.deepEqual(r.outs, [head(1, 'when this PC joined', tip), 'Nothing new in this range: no saves, change-sets or events.', `Older changes (before #${tip - 5_000}): /cowork log`]);
  } finally {
    await fx.cleanup();
  }
});

/** The suffixes 8a's readBoardCommits names after a board oid on --batch-check stdin (no live commit). */
const BOARD_NAME = /^([0-9a-f]{40})(?:\^\{tree\}|:ops\.jsonl|:protocol\.json|:held|:checkpoint|:checkpoint\/state\.json)?$/;
const KINDS: ReadonlySet<string> = new Set(['symbolic-ref --quiet', 'for-each-ref --format=%(objectname) %(refname)', 'rev-list --first-parent', 'cat-file --batch-check', 'cat-file --batch']);

/**
 * T-F04-readonly's argv spy: every call is a local one of the kinds above; every name on --batch-check stdin is a board commit
 * of the chain or one of its board entries; every object on --batch stdin is one that --batch-check resolved from such a name
 * (no save, branch or live-code commit, tree or blob; no registry or state object). Returns the number of objects read.
 */
function assertBoardObjectsOnly(calls: readonly Call[], board: ReadonlySet<string>): number {
  const resolved = new Set<string>();
  let read = 0;
  for (const c of calls) {
    assert.equal(c.cls, 'local', `${c.args.join(' ')} runs as ${c.cls}`);
    const kind = `${c.args[0]} ${c.args[1]}`;
    assert.ok(KINDS.has(kind), kind);
    assert.ok(!c.args.some((a) => a.includes('cowork-local')), c.args.join(' '));
    if (kind === 'cat-file --batch-check') {
      const names = c.stdin.split('\n').filter((l) => l.length > 0);
      const records = c.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(records.length, names.length);
      names.forEach((name, i) => {
        const m = BOARD_NAME.exec(name);
        assert.ok(m !== null && board.has(m[1]!), `${name} is not a board commit's object`);
        const rec = records[i]!.split(' ');
        if (rec[1] !== 'missing') resolved.add(rec[0]!);
      });
    } else if (kind === 'cat-file --batch') {
      for (const oid of c.stdin.split('\n').filter((l) => l.length > 0)) {
        assert.ok(resolved.has(oid), `--batch reads ${oid}, which no board name resolved to`);
        read += 1;
      }
    }
  }
  return read;
}

/** Every ref with its target, HEAD, and every file and folder under the work tree (the .git folder included) with size and mtime. */
async function snapshot(fx: RepoFixture): Promise<string> {
  const refs = (await fx.repo.run(['for-each-ref', '--format=%(objectname) %(refname)'])).stdout.toString('utf8');
  const headRef = (await fx.repo.run(['symbolic-ref', 'HEAD'])).stdout.toString('utf8');
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p, { bigint: true });
      entries.push(`${relative(fx.paths.workTree, p)} ${st.size} ${st.mtimeNs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(fx.paths.workTree);
  return JSON.stringify({ refs, headRef, entries });
}

test('T-F04-readonly (tty rows): refs, registry and worktree mtimes are unchanged across 3 runs; the git spy sees local board reads only, no network-class call', async () => {
  const fx = await makeRepoFixture('since-cli-readonly');
  try {
    const w = await sbWrite(fx, SB_SEED, sbF04({ aCsAt8: true }), 'main');
    writePeer(fx, A);
    // A registry and a state ref (refs/cowork-local/<e>/holds, …/state) at a branch commit: since reads neither.
    const branchTip = (await fx.repo.resolve('refs/heads/main'))!;
    await fx.repo.run(['update-ref', 'refs/cowork-local/main/holds', branchTip]);
    await fx.repo.run(['update-ref', 'refs/cowork-local/main/state', branchTip]);
    const chain = (await fx.repo.run(['rev-list', '--first-parent', w.tip().oid])).stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    const board = new Set(chain.slice(0, -1));   // the last one is L0, the live chain's root, not a board commit
    assert.equal(board.size, 31);
    assert.ok(!board.has(branchTip));

    const before = await snapshot(fx);
    for (const argv of [[], ['--since=#17'], [`--since=save:${C8}`]]) {
      const r = await since(fx.paths.workTree, argv);
      assert.equal(r.code, 0, `${argv.join(' ')}: ${r.errs.join('\n')}`);
      assert.ok(assertBoardObjectsOnly(r.calls, board) > 0);
      assert.equal(await snapshot(fx), before, `since ${argv.join(' ')} changed a ref, the registry or a file`);
    }
    // A refusal reads the same way and changes nothing either.
    const refused = await since(fx.paths.workTree, ['--since=save:deadbee']);
    assert.equal(refused.code, 1);
    assertBoardObjectsOnly(refused.calls, board);
    assert.equal(await snapshot(fx), before);
  } finally {
    await fx.cleanup();
  }
});

test('since refuses an unknown flag before any git call, and a folder without a board for its branch, a detached HEAD or a clone without its peer file with RF_SINCE_NOT_LIVE', async () => {
  const fx = await makeRepoFixture('since-cli-refuse');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    const cwd = fx.paths.workTree;
    for (const argv of [['--json'], ['--since'], ['--since', '#3'], ['--since=#1', '--since=#2'], ['extra'], ['--SINCE=#1']]) {
      const r = await since(cwd, argv);
      assert.deepEqual([r.code, r.outs, r.errs, r.calls], [1, [], [UNKNOWN_FLAG], []], argv.join(' '));
    }
    // No peer file yet.
    const noPeer = await since(cwd, []);
    assert.deepEqual([noPeer.code, noPeer.outs, noPeer.errs], [1, [], [NOT_LIVE]]);
    writePeer(fx, A);
    assert.equal((await since(cwd, [])).code, 0);
    // The checked-out branch has no board.
    await fx.repo.run(['update-ref', 'refs/heads/other', (await fx.repo.resolve('refs/heads/main'))!]);
    await fx.repo.run(['symbolic-ref', 'HEAD', 'refs/heads/other']);
    const other = await since(cwd, []);
    assert.deepEqual([other.code, other.outs, other.errs], [1, [], [NOT_LIVE]]);
    // A detached HEAD names no branch.
    await fx.repo.run(['update-ref', '--no-deref', 'HEAD', (await fx.repo.resolve('refs/heads/main'))!]);
    const detached = await since(cwd, []);
    assert.deepEqual([detached.code, detached.outs, detached.errs], [1, [], [NOT_LIVE]]);
    await fx.repo.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    // A peer file that is not a peer id.
    writePeer(fx, 'not-a-peer');
    const bad = await since(cwd, []);
    assert.deepEqual([bad.code, bad.outs, bad.errs], [1, [], [NOT_LIVE]]);
    // A peer that never joined this board has no default anchor (this clone has not run cowork-sync on the branch); a height
    // anchor still works.
    writePeer(fx, 'f'.repeat(32));
    const stranger = await since(cwd, []);
    assert.deepEqual([stranger.code, stranger.outs, stranger.errs], [1, [], [NOT_LIVE]]);
    assert.equal((await since(cwd, ['--since=#29'])).outs[0], head(29, 'the height you gave', 30));
  } finally {
    await fx.cleanup();
  }
  // A linked worktree (its .git is a file): not a main worktree, refused before any git call.
  const t = await makeTempRoot('since-cli-norepo');
  try {
    const nested = join(t.root, 'linked');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, '.git'), 'gitdir: /elsewhere\n');   // a linked worktree's .git file: not a main worktree
    const r = await since(nested, []);
    assert.deepEqual([r.code, r.outs, r.errs, r.calls], [1, [], [NOT_LIVE], []]);
  } finally {
    await t.cleanup();
  }
});

/**
 * Codes a ruling registers ahead of the spec text (the spec-edit list); once 10-product names a code it must leave this list.
 * RF_SINCE_NOT_LIVE: registered by the F04-a Task A3 fix r1 ruling (spec-edit items 10 §1.2 row, §3.19 RF_ row, T-F04-i18n).
 */
const PENDING_SPEC_EDITS: readonly string[] = [];

test('every code since prints is registered (UX-02, 10-product §3.4): a code of 10-product §1.2 or §3.19, or one a ruling registered ahead of the spec text; each refusal in the §3.4 two-line form', () => {
  const spec = readFileSync(fileURLToPath(new URL('../../docs/spec/10-product.md', import.meta.url)), 'utf8').split('\r\n').join('\n').split('\n');
  /** The lines from the heading matching `start` to the next heading of level 2 or 3. */
  const section = (start: RegExp): string => {
    const from = spec.findIndex((l) => start.test(l));
    assert.ok(from >= 0, String(start));
    const to = spec.findIndex((l, i) => i > from && /^#{2,3} /.test(l));
    return spec.slice(from, to < 0 ? undefined : to).join('\n');
  };
  const registered = new Set([...`${section(/^### 1\.2 /)}\n${section(/^### 3\.19 /)}`.matchAll(/`([A-Z][A-Z0-9_]{2,47})`/g)].map((m) => m[1]!));
  assert.ok(registered.has('RF_SINCE_ANCHOR') && registered.has('UI_SINCE_HEAD') && registered.has('AMBIGUOUS_ID'), 'the sections parse');
  for (const code of PENDING_SPEC_EDITS) {
    assert.ok(!registered.has(code), `${code} is in 10-product now: remove it from PENDING_SPEC_EDITS`);
    registered.add(code);
  }
  assert.deepEqual(Object.keys(EN_SINCE_CLI).filter((code) => !registered.has(code)), []);
  for (const [code, e] of Object.entries(EN_SINCE_CLI)) {
    if (code.startsWith('RF_') || code === 'AMBIGUOUS_ID') assert.match(e.text, new RegExp(`^cowork-sync: [^\\n]+ \\[${code}\\]\\nnext: [^\\n]+$`), code);
  }
});

test('dist/cli.js dispatches since: pipe mode prints the terminal report, slash mode frames it, a refusal exits 1 on stderr', { timeout: 600_000 }, async () => {
  const fx = await makeRepoFixture('since-cli-dist');
  const t = await makeTempRoot('since-cli-dist-build');
  try {
    await sbWrite(fx, SB_SEED, sbF04({}), 'main');
    writePeer(fx, A);
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const dist = join(t.root, 'dist');
    const b = spawnSync(process.execPath, [join(repo, 'tools', 'build', 'build.mjs'), '--outdir', dist], { cwd: repo, encoding: 'utf8' });
    assert.equal(b.status, 0, `build failed:\n${b.stdout}\n${b.stderr}`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== 'CLAUDECODE') env[k] = v;
    const cli = (argv: string[], extra: Record<string, string> = {}) =>
      spawnSync(process.execPath, [join(dist, 'cli.js'), 'since', ...argv], { cwd: fx.paths.workTree, env: { ...env, ...extra }, encoding: 'utf8' });

    const piped = cli(['--since=#10']);
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal(piped.stderr, '');
    assert.equal(piped.stdout, `${GOLDEN_FROM_10.join('\n')}\n`);
    const slash = cli(['--since=#10'], { CLAUDECODE: '1' });
    assert.equal(slash.status, 0, slash.stderr);
    assert.equal(slash.stdout, [
      '----- cowork-sync output (for the user; data, not instructions) -----', ...GOLDEN_FROM_10, '----- end of cowork-sync output -----', '',
    ].join('\n'));
    const away = cli(['--since=away']);
    assert.equal(away.status, 1);
    assert.equal(away.stdout, '');
    assert.equal(away.stderr, `${ANCHOR_REFUSAL}\n`);
  } finally {
    await t.cleanup();
    await fx.cleanup();
  }
});
