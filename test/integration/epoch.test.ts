// The minimal epoch guard (ruling R-09; 01-engine §3.5 step 0c, ENG-16, ENG-17, test 25 subset; ruling R-27's board
// freeze/unfreeze events). Real git: the human's own git commands run in the clone; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBoardCommit } from '../../src/board/boardCommit.js';
import { epochVerdict, observeEpoch, OPERATION_MARKERS } from '../../src/engine/epoch.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Oid } from '../../src/git/oid.js';
import { GitCommandError } from '../../src/git/repo.js';
import { writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { countCalls, remoteBoardTip, storedText, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { liveOf } from '../helpers/incidentFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { gitIn } from '../helpers/startFixture.js';

async function statusOf(p: PeerFixture): Promise<StatusJson> {
  return JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'status.json'))).toString('utf8')) as StatusJson;
}

/** The event kinds this peer's ops carry on the remote board chain from `from` (exclusive) to the tip. */
async function ownEventKinds(fx: EngineFixture, p: PeerFixture, from: Oid): Promise<string[]> {
  await p.core.fetcher.fetch(true);
  const repo = p.core.repo;
  const out: string[] = [];
  for (const b of (await repo.firstParents((await remoteBoardTip(fx)) as Oid, from, 1_000)).reverse()) {
    for (const line of (await readBoardCommit(repo, b)).opsLines) {
      const op = JSON.parse(line) as { id: string; type: string; kind?: string };
      if (op.type === 'event' && op.id.startsWith(`${p.core.peerId}/`)) out.push(op.kind!);
    }
  }
  return out;
}

test('git checkout -b other, reset --hard with a modified file, git stash and a MERGE_HEAD marker each freeze EPOCH within one iteration with no apply and no code publish, and post a board-only freeze event; returning to E1 unfreezes', async () => {
  await withEngines('epoch-freeze', { n: 2 }, async (fx) => {
    await fx.startAll();
    await fx.rounds(3);
    const p = fx.peers[1]!;
    const head = await gitIn(p, ['rev-parse', 'HEAD']);
    assert.equal(epochVerdict(await observeEpoch(p.core.repo, p.deps.ports.fs), p.core.view!.meta.expected_epoch), 'E1');
    assert.deepEqual(OPERATION_MARKERS, ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer']);

    const step = async (): Promise<ReturnType<typeof p.engine.iterate> extends Promise<infer R> ? R : never> => {
      fx.advance(2_500);
      return p.engine.iterate();
    };

    const scenario = async (name: string, enter: () => Promise<void>, leave: () => Promise<void>): Promise<void> => {
      // A local edit observed (its change-set due during the freeze) and a teammate's change waiting to be applied.
      await writeWork(p, `local-${name}.txt`, `${name}\n`);
      await step();
      const team = await fx.pushTeamChange({ [`team-${name}.txt`]: buf(`${name}\n`) });
      fx.advance(21_000);
      const T0 = team.board;
      const liveBefore = team.live;
      const before = { base: p.core.view!.base, laC: p.core.view!.laC, ready: p.core.cs.ready().length };
      const mark = fx.trace.events.length;
      await enter();
      // LIF-10 / glossary §8 under FREEZE(EPOCH): fetch and fold (and the board-only freeze event) only — no detection
      // tick, no change-set observation, no ring sweep (a work-tree write), no materialization.
      const spies = [countCalls(p.core.writer, 'sweepRing'), countCalls(p.core.snapshot, 'tick'), countCalls(p.core.cs, 'observe'), countCalls(p.core.snapshot, 'materialize')];

      // Within one iteration: FREEZE(EPOCH), no apply, no capture.
      const r = await p.engine.iterate();
      assert.equal(r.frozen, true, `${name}: frozen`);
      assert.deepEqual(p.core.view!.meta.freeze_reasons, ['EPOCH'], name);
      assert.equal(r.applied, false, `${name}: no apply`);
      assert.deepEqual([p.core.view!.base, p.core.view!.laC], [before.base, before.laC], `${name}: A and LA_C unchanged`);
      assert.equal(p.core.cs.ready().length, before.ready, `${name}: no capture while frozen`);
      let s = await statusOf(p);
      assert.deepEqual([s.state, s.message_code, s.message_params], ['frozen', 'FROZEN', { reasons: ['EPOCH'] }], name);

      // Still frozen: the freeze event leaves board-only in a governed window; no code is published.
      for (let i = 0; i < 4; i++) await step();
      assert.deepEqual(p.core.view!.meta.freeze_reasons, ['EPOCH'], name);
      for (const x of spies) x.restore();
      assert.deepEqual(spies.map((x) => x.n), [0, 0, 0, 0], `${name}: sweepRing, tick, observe, materialize while frozen`);
      const pushes = fx.trace.since(mark).filter((e) => e.kind === 'push' && e.peer === p.core.peerId);
      assert.ok(pushes.length > 0 && pushes.every((e) => e.kind === 'push' && e.purpose === 'board_only'), `${name}: only board-only pushes ${JSON.stringify(pushes)}`);
      const T1 = (await remoteBoardTip(fx)) as Oid;
      assert.equal(await liveOf(p, T1), liveBefore, `${name}: no code publish`);
      assert.deepEqual(await ownEventKinds(fx, p, T0), ['freeze'], `${name}: one board-only freeze event`);
      assert.equal(await storedText(p, `team-${name}.txt`), null, `${name}: the team change waits`);

      // Back to E1: unfrozen within one iteration; the apply, the capture and the publish follow.
      await leave();
      await step();
      assert.deepEqual(p.core.view!.meta.freeze_reasons, [], `${name}: unfrozen`);
      // 01-engine §2: UNFROZEN{reasons} names the reasons lifted.
      s = await statusOf(p);
      assert.deepEqual([s.message_code, s.message_params], ['UNFROZEN', { reasons: ['EPOCH'] }], `${name}: ${JSON.stringify(s)}`);
      for (let i = 0; i < 10; i++) await step();
      assert.equal(await storedText(p, `team-${name}.txt`), `${name}\n`, `${name}: applied after the freeze`);
      await p.core.fetcher.fetch(true);
      const files = await p.core.repo.readTreeMap((await p.core.repo.readCommit(await liveOf(p, (await remoteBoardTip(fx)) as Oid))).tree);
      assert.ok(files.has(`local-${name}.txt`), `${name}: the local edit published after the freeze`);
      assert.deepEqual(await ownEventKinds(fx, p, T0), ['freeze', 'unfreeze'], `${name}: the unfreeze event`);
      s = await statusOf(p);
      assert.equal(s.state, 'ok', `${name}: ${JSON.stringify(s)}`);
    };

    await scenario('reset', async () => {
      await writeWork(p, 'README.md', 'a modified file the reset throws away\n');
      const x = await gitIn(p, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'elsewhere']);
      await gitIn(p, ['reset', '-q', '--hard', x]);
      const o = await observeEpoch(p.core.repo, p.deps.ports.fs);
      assert.equal(o.head, x);
      assert.equal(epochVerdict(o, p.core.view!.meta.expected_epoch), 'FREEZE');
    }, async () => {
      await gitIn(p, ['reset', '-q', '--hard', head]);
    });

    await scenario('checkout', async () => {
      await gitIn(p, ['checkout', '-q', '-b', 'other']);
      assert.equal((await observeEpoch(p.core.repo, p.deps.ports.fs)).symref, 'refs/heads/other');
    }, async () => {
      await gitIn(p, ['checkout', '-q', 'main']);
    });

    await scenario('stash', async () => {
      await writeWork(p, 'README.md', 'stashed work\n');
      await gitIn(p, ['stash', 'push', '-q']);
      assert.notEqual((await observeEpoch(p.core.repo, p.deps.ports.fs)).stash, null);
    }, async () => {
      await gitIn(p, ['stash', 'pop', '-q']);
    });

    const mergeHead = join(p.deps.paths.gitDir, 'MERGE_HEAD');
    await scenario('merge', async () => {
      await writeFile(mergeHead, `${head}\n`);
      assert.deepEqual((await observeEpoch(p.core.repo, p.deps.ports.fs)).markers, ['MERGE_HEAD']);
    }, async () => {
      await rm(mergeHead);
    });

    // The stash's work came back and was published as the human's own change.
    assert.equal(await storedText(p, 'README.md'), 'stashed work\n');
  });
});

test('a symbolic-ref that fails (rc 128) is an error of the observation, never read as a detached HEAD', async () => {
  await withEngines('epoch-symref-fail', { n: 1 }, async (fx) => {
    const p = fx.peers[0]!;
    const headFile = join(p.deps.paths.gitDir, 'HEAD');
    const head = await readFile(headFile);
    // A HEAD git cannot read: symbolic-ref exits 128.
    await writeFile(headFile, 'ref: refs/heads/../broken\n');
    try {
      const sym = await p.core.repo.run(['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1, 128] });
      assert.equal(sym.code, 128, 'the precondition: symbolic-ref fails');
      await assert.rejects(observeEpoch(p.core.repo, p.deps.ports.fs), (e: unknown) => e instanceof GitCommandError && e.argv.includes('symbolic-ref') && e.code === 128);
    } finally {
      await writeFile(headFile, head);
    }
    // A detached HEAD (rc 1) still reads as symref null.
    await gitIn(p, ['checkout', '-q', '--detach']);
    assert.equal((await observeEpoch(p.core.repo, p.deps.ports.fs)).symref, null);
  });
});
