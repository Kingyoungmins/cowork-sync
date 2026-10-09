// The git room source, polling (Plan 8a Task 7; 12 §3.3.1, §3.9.2; VIZ-07, VIZ-15; ruling R-V31; Review Focus 4): the stat
// pairs of the board ref's storage and the 60 s safety net (VirtualClock), the tip pinned across a ref moved mid-tick, and
// the fast-forward check — real boards in clones on file:// remotes, every git call through a runner spy. Kept apart from
// gitSource.test.ts so each file stays within the 60 s integration budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitVersion } from '../../../src/git/version.js';
import { realFs } from '../../../src/ports/fs.js';
import { ZERO_PEER } from '../../../src/viz/model/frame.js';
import { GitRoomSource, REVPARSE_SAFETY_MS } from '../../../src/viz/source/git.js';
import type { TipInfo } from '../../../src/viz/source/roomSource.js';
import { BoardWriter } from '../../../tools/viz/boardWriter.js';
import { VirtualClock } from '../../sim/vclock.js';
import { makeRepoFixture } from '../../helpers/repoFixture.js';
import { makeTempRoot, testRunner } from '../../helpers/tmp.js';
import { collect, kinds, script, sourceOf, specOf, spiedVizGit, vizRunner } from '../../helpers/vizSource.js';

test('changed(): no git process while the stat pairs are unchanged; a loose-ref update, git pack-refs --all and (where git supports it) a reftable repository each change a pair; 60 s without change → true once', async (t) => {
  const fx = await makeRepoFixture('viz-gitsrc-changed');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-changed' });
    await w.genesis('ann');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    const clock = new VirtualClock();
    const { src, sg } = sourceOf(fx, w.ref, clock);
    const loose = join(fx.paths.gitDir, 'refs', 'cowork-remote', 'main', 'board');
    utimesSync(loose, 1_600_000_000, 1_600_000_000);   // a coarse clock cannot hide the next update
    let last = (await src.tip())!;
    assert.equal(last.height, 1);
    const pairs = await src.statPairs();
    assert.equal(pairs.length, 2, 'loose ref and packed-refs (no reftable/)');
    assert.ok(pairs[0] !== null, 'the loose board ref');

    const quiet = async (label: string): Promise<void> => {
      const n = sg.calls.length;
      for (let i = 0; i < 5; i++) {
        clock.advance(2_500);
        assert.equal(await src.changed(), false, `${label}: tick ${i}`);
      }
      assert.equal(sg.calls.length, n, `${label}: no git process`);
    };
    await quiet('idle');

    // A loose-ref update (this PC's daemon fetched): the loose file's pair changes.
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });
    const n0 = sg.calls.length;
    assert.equal(await src.changed(), true, 'a loose-ref update');
    assert.equal(sg.calls.length, n0, 'changed() itself runs no git');
    const a1 = await src.advance(last);
    assert.deepEqual(a1, { kind: 'ff', to: { height: 2, key: w.tip().oid } });
    last = a1.kind === 'ff' ? a1.to : last;
    await quiet('after the update');

    // git pack-refs --all moves the ref into packed-refs: both pairs change, the tip does not.
    const pack = await testRunner().run(['pack-refs', '--all'], { class: 'local', cwd: fx.paths.workTree });
    assert.equal(pack.code, 0, pack.stderr.toString('utf8'));
    assert.equal(await src.changed(), true, 'pack-refs --all');
    assert.deepEqual(await src.advance(last), { kind: 'none' });
    const packed = await src.statPairs();
    assert.equal(packed[0], null, 'the loose file is gone');
    assert.ok(packed[1] !== null, 'packed-refs exists');
    await quiet('after pack-refs');

    // 60 s without a change: true once (the safety net), then quiet again; the rev-parse that follows resets it.
    clock.advance(REVPARSE_SAFETY_MS - 5 * 2_500 - 1);
    assert.equal(await src.changed(), false, '1 ms before 60 s');
    clock.advance(1);
    assert.equal(await src.changed(), true, '60 s without a rev-parse');
    assert.equal(await src.changed(), false, 'true once');
    assert.deepEqual(await src.advance(last), { kind: 'none' });
    clock.advance(REVPARSE_SAFETY_MS - 1);
    assert.equal(await src.changed(), false);
    clock.advance(1);
    assert.equal(await src.changed(), true);

    // A reftable repository: reftable/tables.list is the third pair.
    const v = parseGitVersion((await testRunner().run(['version'], { class: 'local', cwd: fx.root })).stdout.toString('utf8'));
    if (v.major < 2 || (v.major === 2 && v.minor < 45)) {
      t.diagnostic(`reftable leg skipped: git ${v.major}.${v.minor} has no --ref-format=reftable (2.45+)`);
      return;
    }
    const { root, cleanup } = await makeTempRoot('viz-gitsrc-reftable');
    try {
      const dir = join(root, 'rt');
      const must = async (args: string[], opts: { stdin?: Buffer } = {}): Promise<string> => {
        const r = await testRunner().run(args, { class: 'local', cwd: args[0] === 'init' ? root : dir, identity: { name: 'F', email: 'f@cowork.invalid' }, wallMsForDates: 1_700_000_000_000, ...opts });
        assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
        return r.stdout.toString('utf8').trim();
      };
      await must(['init', '-q', '--ref-format=reftable', dir]);
      const tree = await must(['hash-object', '-w', '-t', 'tree', '--stdin'], { stdin: Buffer.alloc(0) });
      const c1 = await must(['commit-tree', tree], { stdin: Buffer.from('one\n') });
      const c2 = await must(['commit-tree', tree, '-p', c1], { stdin: Buffer.from('two\n') });
      await must(['update-ref', 'refs/cowork-remote/main/board', c1]);
      const gitDir = join(dir, '.git');
      const dataDir = join(root, 'viz data');
      const rs = spiedVizGit(vizRunner(dataDir), gitDir, dataDir);
      const rclock = new VirtualClock();
      const rsrc = new GitRoomSource(specOf(gitDir, 'refs/cowork-remote/main/board'), rs.git, { fs: realFs, clock: rclock });
      utimesSync(join(gitDir, 'reftable', 'tables.list'), 1_600_000_000, 1_600_000_000);
      await rsrc.tip();
      const rp = await rsrc.statPairs();
      assert.equal(rp.length, 3, 'loose ref, packed-refs and reftable/tables.list');
      assert.ok(rp[2] !== null);
      rclock.advance(2_500);
      assert.equal(await rsrc.changed(), false);
      await must(['update-ref', 'refs/cowork-remote/main/board', c2]);
      assert.equal(await rsrc.changed(), true, 'a reftable update');
    } finally {
      await cleanup();
    }
  } finally {
    await fx.cleanup();
  }
});

test('changed(): a tip() or advance() that fails at or after its rev-parse leaves changed() true next tick (no 60 s wait); the retry that succeeds quiets it', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-retry');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-retry' });
    await w.genesis('ann');
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    const loose = join(fx.paths.gitDir, 'refs', 'cowork-remote', 'main', 'board');
    utimesSync(loose, 1_600_000_000, 1_600_000_000);   // a coarse clock cannot hide the next update
    const clock = new VirtualClock();
    const { src, sg } = sourceOf(fx, w.ref, clock);
    /** The next git call whose argv starts with `sub` throws once (a transient error, a watchdog kill); every other call runs. */
    const failOnce = (sub: string): void => {
      sg.before = async (args) => {
        if (args[0] !== sub) return;
        sg.before = null;
        throw new Error(`injected ${sub} failure`);
      };
    };
    const tick = async (): Promise<boolean> => {
      clock.advance(2_500);
      return src.changed();
    };

    // tip(): its rev-list --count fails after the rev-parse ran → the next tick reports a change, the retry pins.
    failOnce('rev-list');
    await assert.rejects(src.tip(), /injected rev-list failure/);
    assert.equal(await tick(), true, 'tip() failed after its rev-parse: changed() is true next tick');
    let last = (await src.tip())!;
    assert.deepEqual(last, { height: 1, key: w.tip().oid });
    assert.equal(await tick(), false, 'the retry succeeded: quiet');

    // advance(): the ref moved; the ff page (rev-list) fails after the rev-parse → still a change next tick, every tick until a retry succeeds.
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/b.txt'] }] });
    assert.equal(await tick(), true, 'a loose-ref update');
    failOnce('rev-list');
    await assert.rejects(src.advance(last), /injected rev-list failure/);
    for (let i = 0; i < 3; i++) assert.equal(await tick(), true, `advance() failed after its rev-parse: tick ${i} still reports the change`);
    const a = await src.advance(last);
    assert.deepEqual(a, { kind: 'ff', to: { height: 2, key: w.tip().oid } });
    last = a.kind === 'ff' ? a.to : last;
    assert.equal(await tick(), false, 'the retry succeeded: quiet');

    // advance(): the rev-parse itself fails → a change next tick.
    utimesSync(loose, 1_600_000_100, 1_600_000_100);
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/c.txt'] }] });
    assert.equal(await tick(), true);
    failOnce('rev-parse');
    await assert.rejects(src.advance(last), /injected rev-parse failure/);
    assert.equal(await tick(), true, 'the rev-parse failed: changed() is true next tick');
    const b = await src.advance(last);
    assert.deepEqual(b, { kind: 'ff', to: { height: 3, key: w.tip().oid } });
    assert.equal(await tick(), false);
    assert.equal(sg.before, null, 'every injected failure fired');
  } finally {
    await fx.cleanup();
  }
});

test('tip pinning: a ref moved between tip() and frames() changes nothing that tick', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-pin');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-pin' });
    await w.genesis('ann');
    await w.join('bob');
    for (let i = 0; i < 4; i++) await w.commit({ writer: i % 2 === 0 ? 'ann' : 'bob', cs: [{ paths: [`src/f${i}.txt`] }] });
    const pinned = w.tip();
    const { src, sg } = sourceOf(fx, w.ref);
    const tip = (await src.tip())!;
    assert.deepEqual(tip, { height: pinned.height, key: pinned.oid });

    // The daemon fetches while this tick reads: the ref moves inside the first git call after tip().
    let moved = false;
    sg.before = async () => {
      if (moved) return;
      moved = true;
      await w.commit({ writer: 'bob', cs: [{ paths: ['src/late.txt'] }] });
    };
    const from = sg.calls.length;
    const start = await src.startAt(0);
    const frames = await collect(src.frames(start, 0, tip.height, ZERO_PEER));
    assert.ok(moved, 'the ref moved during the tick');
    assert.notEqual(w.tip().oid, pinned.oid);
    assert.deepEqual(frames.map((f) => f.height), Array.from({ length: pinned.height + 1 }, (_, i) => i));
    assert.equal(frames[frames.length - 1]!.oid, pinned.oid, 'the tick reads the pinned tip, not the moved ref');
    const tickCalls = sg.calls.slice(from);
    assert.ok(!tickCalls.some((c) => c.args[0] === 'rev-parse'), 'no re-resolve inside the tick');
    for (const c of tickCalls.filter((x) => x.args[0] === 'rev-list')) assert.equal(c.args[c.args.length - 1], pinned.oid, 'the chain listed is the pinned one');
    assert.ok(!tickCalls.some((c) => c.stdin.includes(w.tip().oid)), 'the moved tip is never read this tick');
    // The next tick sees it.
    sg.before = null;
    assert.deepEqual(await src.advance(tip), { kind: 'ff', to: { height: pinned.height + 1, key: w.tip().oid } });
  } finally {
    await fx.cleanup();
  }
});

test('advance: ff with one rev-list; a rewrite and a > 1,280 catch-up told apart with rev-list --count and one --skip read; a deleted ref → gone', async () => {
  const fx = await makeRepoFixture('viz-gitsrc-advance');
  try {
    const w = await BoardWriter.create({ runner: fx.runner, paths: fx.paths, branch: 'main', seed: 'gitsrc-advance' });
    await w.genesis('ann');
    await w.join('bob');
    const { src, sg } = sourceOf(fx, w.ref);
    let last: TipInfo = (await src.tip())!;
    const step = async (want: string, expectCalls: string[]): Promise<TipInfo> => {
      const n = sg.calls.length;
      const a = await src.advance(last);
      assert.equal(a.kind, want, JSON.stringify(a));
      assert.deepEqual(kinds(sg.calls.slice(n)), expectCalls, `${want}: git calls`);
      if (a.kind === 'ff' || a.kind === 'rewrite') {
        assert.deepEqual(a.to, { height: w.tip().height, key: w.tip().oid });
        return a.to;
      }
      return last;
    };

    // ff: rev-parse and one rev-list of the new tip's newest 1,281 commits.
    await w.commit({ writer: 'ann', cs: [{ paths: ['src/a.txt'] }] });
    await w.commit({ writer: 'bob', cs: [{ paths: ['src/b.txt'] }] });
    const n0 = sg.calls.length;
    last = await step('ff', ['rev-parse --verify', 'rev-list --first-parent']);
    assert.deepEqual(sg.calls[n0 + 1]!.args, ['rev-list', '--first-parent', '--skip=0', '--max-count=1281', w.tip().oid]);
    assert.equal(last.height, 3);
    // The tick's frames use that listing: no second rev-list.
    const s = await src.startAt(0);
    const n1 = sg.calls.length;
    await collect(src.frames(s, 0, 3, ZERO_PEER));
    assert.ok(!sg.calls.slice(n1).some((c) => c.args[0] === 'rev-list'), 'frames reuse the ff page');
    // Nothing new: rev-parse only.
    last = await step('none', ['rev-parse --verify']);

    // A catch-up beyond 1,280 (a laptop waking up): the page misses the last folded commit; --count and one --skip read find it.
    await w.commitMany(script(1_290));
    const h1 = last.height;
    const n2 = sg.calls.length;
    last = await step('ff', ['rev-parse --verify', 'rev-list --first-parent', 'rev-list --first-parent', 'rev-list --first-parent']);
    assert.deepEqual(sg.calls[n2 + 2]!.args, ['rev-list', '--first-parent', '--count', w.tip().oid]);
    assert.deepEqual(sg.calls[n2 + 3]!.args, ['rev-list', '--first-parent', `--skip=${w.tip().height - h1}`, '--max-count=1', w.tip().oid]);
    assert.equal(last.height, h1 + 1_290);

    // A rewrite below the last folded height, then more than 1,280 commits on the new chain: the --skip read tells it apart.
    const old = last;
    await w.rewrite(old.height - 5);
    await w.commitMany(script(1_290));
    const n3 = sg.calls.length;
    last = await step('rewrite', ['rev-parse --verify', 'rev-list --first-parent', 'rev-list --first-parent', 'rev-list --first-parent']);
    assert.deepEqual(sg.calls[n3 + 3]!.args, ['rev-list', '--first-parent', `--skip=${w.tip().height - old.height}`, '--max-count=1', w.tip().oid]);
    // A rewrite to a shorter chain: the page holds the whole chain, no --count needed.
    const n4 = sg.calls.length;
    await w.rewrite(10);
    last = await step('rewrite', ['rev-parse --verify', 'rev-list --first-parent']);
    assert.equal(sg.calls.length, n4 + 2);
    assert.equal(last.height, 10);
    // The pinned rewrite tip folds from scratch.
    const frames = await collect(src.frames(await src.startAt(0), 0, 10, ZERO_PEER));
    assert.equal(frames[10]!.oid, w.tip().oid);

    // The ref deleted: gone.
    const del = await testRunner().run(['update-ref', '-d', w.ref], { class: 'local', cwd: fx.paths.workTree });
    assert.equal(del.code, 0);
    assert.deepEqual(await src.advance(last), { kind: 'gone' });
    assert.equal(await src.tip(), null);
  } finally {
    await fx.cleanup();
  }
});
