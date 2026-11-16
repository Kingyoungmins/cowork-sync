// The harness's quiescence rule (ruling R-32 as amended for Task 19 fix round 2; 02-protocol §3.11): T* is the remote
// board tip once every peer has run K iterations since it OBSERVED that tip — fetched it successfully after the forced
// heal at the end of the op budget — not merely K rounds since the tip last changed. A peer still in network backoff
// after the heal has observed nothing, so it is not yet quiescent (seed faults-187). Engines that register no trace name
// (stubs that never emit a `fetch` event) keep the tip-unchanged count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitClass } from '../../src/git/flags.js';
import type { EngineFactory, QuiescenceOptions, SimContext, SimResult } from '../sim/harness.js';
import { runSim } from '../sim/harness.js';
import { SIM_WALL_EPOCH_MS } from '../sim/vclock.js';
import { removeKeptRoot } from '../helpers/tmp.js';

const BOARD_REF = 'refs/cowork/main/board';
const Q: QuiescenceOptions = { loopMs: 1_000, k: 2, extraLoops: 3, maxRounds: 30 };

async function remoteGit(ctx: SimContext, cls: GitClass, args: string[]): Promise<string> {
  const r = await ctx.git.run(args, {
    class: cls, cwd: ctx.remote.dir,
    identity: { name: 'stub', email: 'stub@cowork.invalid' }, wallMsForDates: SIM_WALL_EPOCH_MS,
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString('utf8')}`);
  return r.stdout.toString('utf8').trim();
}

/** A new board commit on the remote (the stub's "publish"): its parent is the current board, else main. */
async function moveBoard(ctx: SimContext, label: string): Promise<string> {
  const refs = await ctx.remote.refs();
  const parent = refs[BOARD_REF] ?? refs['refs/heads/main'];
  assert.ok(parent !== undefined, 'the remote has a main branch');
  const commit = await remoteGit(ctx, 'refupdate', ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', label]);
  await remoteGit(ctx, 'refupdate', ['update-ref', BOARD_REF, commit]);
  return commit;
}

/**
 * Stub engines. During the op budget the first step creates the board. In the quiescence and extra rounds a tracked peer
 * (one that registers its peer id in ctx.trace.names, as realEngine does) emits a successful `fetch` event of the
 * current board each step, except `backoff` peers, which stay silent for their first `backoff` quiescence steps (the
 * network backoff after the heal) and then fetch and publish once (a board move, counted as a push attempt).
 */
function stubs(o: { backoff: ReadonlyMap<string, number>; untracked?: ReadonlySet<string> }): { factory: EngineFactory } {
  const factory: EngineFactory = (_ctx, peer) => {
    const id = `id-${peer.name}`;
    const tracked = o.untracked?.has(peer.name) !== true;
    let qSteps = 0;
    let pushes = 0;
    let published = false;
    return {
      peer,
      pushAttempts: () => pushes,
      async step(ctx: SimContext): Promise<void> {
        if (tracked) ctx.trace.names.set(id, peer.name);
        if (ctx.phase === 'ops') {
          if ((await ctx.remote.refs())[BOARD_REF] === undefined) await moveBoard(ctx, 'board 0');
          return;
        }
        qSteps++;
        if (!tracked) return;
        if (qSteps <= (o.backoff.get(peer.name) ?? 0)) return;   // still in network backoff: no fetch
        const board = (await ctx.remote.refs())[BOARD_REF] ?? null;
        ctx.trace.emit({ kind: 'fetch', peer: id, ok: true, board, code: null, branch: null });
        if (o.backoff.has(peer.name) && !published) {
          published = true;
          pushes++;
          await moveBoard(ctx, `publish ${peer.name}`);
        }
      },
    };
  };
  return { factory };
}

async function dropKept(r: SimResult): Promise<void> {
  if (r.artifactsDir !== undefined) await removeKeptRoot(r.artifactsDir);
}

test('R-32 as amended: T* waits until every peer fetched it after the forced heal; a peer in network backoff is not quiescent, and its publish after the backoff restarts the count', async () => {
  const BACKOFF = 4;
  const { factory } = stubs({ backoff: new Map([['p1', BACKOFF]]) });
  const r = await runSim({ seed: 'quiescence-observed', peers: 2, ops: 2 }, factory, [], { quiescence: Q });
  try {
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    const q = r.quiescence ?? assert.fail('the run had a quiescence phase');
    assert.equal(q.reached, true);
    const board = r.remoteRefs[BOARD_REF];
    assert.match(board ?? '', /^[0-9a-f]{40,64}$/);
    assert.equal(q.tStar, board, 'T* is the board after p1\'s publish, not the board p1 had not fetched yet');
    // Rounds 1–4: p1 in backoff (p0 alone observed board 0). Round 5: p1 fetches board 0 and publishes board 1, so the
    // count restarts. Round 6: both fetch board 1 (count 0); rounds 7 and 8: counts 1 and 2 = K.
    assert.equal(q.rounds, BACKOFF + 1 + 1 + Q.k, 'K is counted from the round in which the last peer observed the tip');
    assert.equal(q.pushAttemptsInExtra, 0, 'no push in the extra rounds');
    assert.equal(q.boardChangedInExtra, false, 'the tip stays T* in the extra rounds');
    const rounds = r.opLog.filter((e) => e.kind === 'round');
    assert.equal(rounds.length, q.rounds + Q.extraLoops);
  } finally {
    await dropKept(r);
  }
});

test('a peer whose engine registers no trace name (a stub that emits no fetch event) counts K from the tip\'s last change; tracked peers still need their own observation', async () => {
  // p0 is tracked and fetches every round; p1 is untracked and silent: K rounds after the last change suffice for p1.
  const { factory } = stubs({ backoff: new Map(), untracked: new Set(['p1']) });
  const r = await runSim({ seed: 'quiescence-untracked', peers: 2, ops: 2 }, factory, [], { quiescence: Q });
  try {
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    const q = r.quiescence ?? assert.fail('the run had a quiescence phase');
    assert.equal(q.reached, true);
    assert.equal(q.tStar, r.remoteRefs[BOARD_REF]);
    assert.equal(q.rounds, Q.k + 1, 'p0 observes the tip in round 1 (count 0) and reaches K in round K + 1');
  } finally {
    await dropKept(r);
  }
  // No peer tracked: exactly the tip-unchanged rule (K rounds).
  const none = stubs({ backoff: new Map(), untracked: new Set(['p0', 'p1']) });
  const r2 = await runSim({ seed: 'quiescence-untracked', peers: 2, ops: 2 }, none.factory, [], { quiescence: Q });
  try {
    assert.equal(r2.ok, true, JSON.stringify(r2.failure));
    assert.equal(r2.quiescence?.reached, true);
    assert.equal(r2.quiescence?.rounds, Q.k);
  } finally {
    await dropKept(r2);
  }
});

test('QUIESCENCE\'s failure text states the per-peer rule: a tip that stayed put while a peer never observed it names that peer (never "the board tip kept changing")', async () => {
  // p1 stays in network backoff past maxRounds: the tip never moves, yet no T* can be declared.
  const { factory } = stubs({ backoff: new Map([['p1', Q.maxRounds + 1]]) });
  const r = await runSim({ seed: 'quiescence-never-observed', peers: 2, ops: 2 }, factory, [], { quiescence: Q });
  try {
    assert.equal(r.ok, false);
    assert.equal(r.failure?.oracle, 'QUIESCENCE');
    const msg = r.failure?.message ?? '';
    assert.doesNotMatch(msg, /kept changing/, msg);
    assert.match(msg, new RegExp(`no quiescence within ${Q.maxRounds} rounds`), msg);
    assert.match(msg, new RegExp(`K = ${Q.k} rounds after it observed the board tip`), msg);
    assert.match(msg, /p1 \(never observed it\)/, msg);
    assert.doesNotMatch(msg, /p0 \(/, `p0 reached K and is not listed: ${msg}`);
    assert.match(msg, /last changed in round 0/, msg);
  } finally {
    await dropKept(r);
  }
});

test('QUIESCENCE\'s failure text for a board that keeps moving names the round of its last change and every peer short of K', async () => {
  // Both peers untracked (the tip-unchanged rule), and the board moves every quiescence round.
  const factory: EngineFactory = (_ctx, peer) => ({
    peer,
    async step(ctx: SimContext): Promise<void> {
      if (ctx.phase === 'ops' && (await ctx.remote.refs())[BOARD_REF] !== undefined) return;
      if (peer.name === 'p0') await moveBoard(ctx, `move ${ctx.phase}`);
    },
  });
  const r = await runSim({ seed: 'quiescence-moving', peers: 2, ops: 2 }, factory, [], { quiescence: Q });
  try {
    assert.equal(r.failure?.oracle, 'QUIESCENCE');
    const msg = r.failure?.message ?? '';
    assert.match(msg, new RegExp(`last changed in round ${Q.maxRounds}\\b`), msg);
    assert.match(msg, /p0 \(0 of 2 rounds since the tip last changed\)/, msg);
    assert.match(msg, /p1 \(0 of 2 rounds since the tip last changed\)/, msg);
  } finally {
    await dropKept(r);
  }
});

test('EF2 D2: SimOptions.beforeQuiescenceRound runs once at the start of every quiescence round — after that round\'s op-log row, before any engine steps in it — never in an op step or an extra round, and the op-log rows it adds stay where it put them', async () => {
  const { factory } = stubs({ backoff: new Map() });
  const seq: string[] = [];
  const counting: EngineFactory = (ctx, peer) => {
    const e = factory(ctx, peer);
    return {
      peer: e.peer,
      pushAttempts: e.pushAttempts!,
      async step(c: SimContext): Promise<void> {
        seq.push(`${c.phase}:${peer.name}`);
        await e.step(c);
      },
    };
  };
  const r = await runSim({ seed: 'quiescence-hook', peers: 2, ops: 2 }, counting, [], {
    quiescence: Q,
    beforeQuiescenceRound: async (ctx, step) => {
      const last = ctx.opLog[ctx.opLog.length - 1];
      assert.equal(last?.kind, 'round', 'the round row comes first');
      assert.equal(last?.step, step, 'with this round\'s step');
      seq.push(`hook:${ctx.phase}`);
      ctx.opLog.push({ step, peer: '*', kind: 'resume', detail: 'hook' });
    },
  });
  try {
    assert.equal(r.ok, true, JSON.stringify(r.failure));
    const q = r.quiescence ?? assert.fail('the run had a quiescence phase');
    assert.equal(q.reached, true);
    assert.equal(seq.filter((x) => x.startsWith('hook:')).length, q.rounds, 'one call per quiescence round');
    assert.ok(seq.every((x) => x !== 'hook:extra' && x !== 'hook:ops'), 'never in an extra round or an op step');
    const firstQ = seq.indexOf('hook:quiescence');
    assert.ok(seq.slice(0, firstQ).every((x) => x.startsWith('ops:')), 'the op steps come before the first call');
    const quiescent = seq.slice(firstQ, seq.indexOf('extra:p0'));
    assert.deepEqual(quiescent, Array.from({ length: q.rounds }, () => ['hook:quiescence', 'quiescence:p0', 'quiescence:p1']).flat(), 'each round: the hook, then every engine');
    const rows = r.opLog.filter((e) => e.kind === 'round' || e.kind === 'resume');
    rows.forEach((e, i) => {
      if (e.kind === 'resume') assert.ok(rows[i - 1]?.kind === 'round' && rows[i - 1]!.step === e.step && rows[i - 1]!.detail.startsWith('quiescence'), `a hook row follows its quiescence round row: ${JSON.stringify(e)}`);
    });
  } finally {
    await dropKept(r);
  }
});

test('EF2 r1 F4: a string SimOptions.beforeQuiescenceRound returns fails the run at that quiescence round (oracle BEFORE_QUIESCENCE_ROUND, that round\'s step) before any engine steps in it; QuiescenceInfo.resumes counts the `resume` rows the hook added', async () => {
  const { factory } = stubs({ backoff: new Map() });
  const seq: string[] = [];
  const counting: EngineFactory = (ctx, peer) => {
    const e = factory(ctx, peer);
    return {
      peer: e.peer,
      pushAttempts: e.pushAttempts!,
      async step(c: SimContext): Promise<void> {
        seq.push(`${c.phase}:${peer.name}`);
        await e.step(c);
      },
    };
  };
  let calls = 0;
  const r = await runSim({ seed: 'quiescence-hook-fails', peers: 2, ops: 2 }, counting, [], {
    quiescence: Q,
    beforeQuiescenceRound: async (ctx, step) => {
      calls++;
      if (calls === 1) {
        ctx.opLog.push({ step, peer: 'p1', kind: 'resume', detail: 'quiescence hook' });
        return null;
      }
      return `the hook refuses round ${step}`;
    },
  });
  try {
    assert.equal(r.ok, false, 'the run fails');
    const rounds = r.opLog.filter((e) => e.kind === 'round');
    assert.deepEqual(r.failure, { oracle: 'BEFORE_QUIESCENCE_ROUND', message: `the hook refuses round ${rounds[1]!.step}`, step: rounds[1]!.step });
    assert.deepEqual(seq.filter((x) => x.startsWith('quiescence:')), ['quiescence:p0', 'quiescence:p1'], 'no engine steps in the failing round');
    assert.equal(r.quiescence?.resumes, 1, 'the one resume row the hook added');
  } finally {
    await dropKept(r);
  }
});
