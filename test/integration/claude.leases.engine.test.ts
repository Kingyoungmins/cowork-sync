// test/integration/claude.leases.engine.test.ts — Plan 5 Task 8 (06-claude test 17's integration leg, test 18; 06
// §3.7.1, CCI-20, CCI-21; O-LEASE): the lease table's defer rows on the real apply path over real git. A READ lease
// defers every incoming change to its path; released by the seat's next edit-class Post, the same apply merges the
// teammate's rows under the seat's own Write, and no lease lives longer than the READ hard cap (the released lease's
// own age, measured on the engine clock). An INFLIGHT lease that never sees its Post is expired by its backstop (the
// harness drives leases.expire() as the 1 s housekeeping does, the plan's "the seat's leases driven directly"), and the
// deferred change lands within 125,000 ms of the lease's acquisition (INV-CCI-LEASE's landing bound, plan l. 2967) —
// measured, never the sum of the test's own advances (F2 #22, rulings R-T8B-7, R-T8B-10: the lease table rides the
// fixture's peer clock through daemonRig({clock}) + lazyClaudePort).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { publishStep } from '../../src/engine/publish.js';
import { daemonRig, inflOf, lazyClaudePort, RIG_SEAT, type DaemonRig } from '../helpers/claudeRig.js';
import { makeEngines } from '../helpers/engineFixture.js';
import { seatHarness } from '../helpers/seatHarness.js';
import { remoteLiveFiles, withGuard } from '../helpers/loopHoldsFixture.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { buf, captureReady, prep } from '../helpers/publishHelpers.js';
import { C } from '../../src/claude/wire/constants.js';

const T10 = { timeout: 10 * 60_000 };
const F = 'src/f.ts';
const BASE = 'one\ntwo\nthree\nfour\nfive\n';
const B1 = 'one\ntwo\nthree-T3\nfour\nfive\n';
const B2 = 'one\ntwo\nthree-T3\nfour-T4\nfive\n';
const B3 = 'one\ntwo\nthree-T3\nfour-T4\nfive-T5\n';
const MERGED = `CLAUDE line\n${B3}`;
const B_LINE = 'one\ntwo\nthree-B\nfour\nfive\n';              // 06 test 19: B's change to line 3
const CLAUDE_STALE = `CLAUDE line\n${BASE}`;                    // the approved Write: the OLD pre-image, B's row missing

test('06 test 18: a READ lease defers a peer change; the edit Post releases it, the Write lands with all three teammate changes; no lease age exceeds 300,000', T10, async () => {
  const holder: { rig?: DaemonRig } = {};
  const fx = await makeEngines('p5-leases-test18', { n: 2, files: { [F]: buf(BASE), 'src/other.txt': buf('other\n') }, engineDeps: () => ({ claude: lazyClaudePort(() => holder.rig!.defer) }) });
  try {
    const rig = daemonRig({ clock: fx.peers[0]!.clock });   // the lease table on A's own clock
    holder.rig = rig;
    await fx.startAll();
    const pa = fx.peers[0]!;
    const pb = fx.peers[1]!;
    rig.leases.acquireRead(rig.seatId, F);
    // Three teammate changes at 0 / 5,000 / 10,000 (each a new board commit): none applies on A while the lease lives.
    await fx.pushTeamChange({ [F]: buf(B1) });
    fx.advance(10_000);
    const r0 = await applyStep(pa.core, await prep(pa, true));
    assert.ok(!r0.written.includes(F), JSON.stringify(r0));
    assert.equal(r0.deferred.get(F), 'read_lease', 'the READ lease defers the path');
    assert.equal(pa.core.view!.meta.pending[F], 'read_lease');
    await fx.pushTeamChange({ [F]: buf(B2) });
    fx.advance(5_000);
    assert.ok(!(await applyStep(pa.core, await prep(pa, true))).written.includes(F), 'the second change does not apply either');
    await fx.pushTeamChange({ [F]: buf(B3) });
    fx.advance(5_000);
    assert.ok(!(await applyStep(pa.core, await prep(pa, true))).written.includes(F), 'the third change does not apply');
    assert.equal((await readWork(pa, F))?.toString('utf8'), BASE, 'the local file is untouched while the lease lives');

    // At ~6 s after the last lease: the seat's Edit — its INFLIGHT PreToolUse, the test's Write (an edit away from
    // B's rows), then the edit-class Post releases the READ lease and the Post releases the INFLIGHT lease.
    rig.leases.acquireInflight(inflOf('tu-claude', F));
    await writeWork(pa, F, `CLAUDE line\n${BASE}`);   // the seat's own line before line 1 (away from B's rows: a clean merge)
    const released = rig.leases.releaseRead(rig.seatId, F, 'next_edit_post');
    assert.ok(released !== null, 'the edit Post released the READ lease');
    // No lease age exceeds 300,000 (plan l. 2999): the released lease's own age on the engine clock — it lived through
    // the three deferrals (≥ 20,000 ms) and never past the READ hard cap.
    const age = pa.clock.monoMs() - released.firstMono;
    assert.ok(age >= 20_000, `the READ lease lived through the three deferrals (${age} ms)`);
    assert.ok(age <= C.READ_LEASE_HARD_CAP_MS, `no lease age exceeds ${C.READ_LEASE_HARD_CAP_MS} (${age} ms)`);
    assert.ok(rig.leases.release('tu-claude', 'post') !== null, 'the Post released the INFLIGHT lease');
    fx.advance(10_000);
    const r1 = await applyStep(pa.core, await prep(pa, true));
    assert.ok(r1.written.includes(F), JSON.stringify(r1));
    assert.equal((await readWork(pa, F))?.toString('utf8'), MERGED, 'the apply merged the teammate rows under the seat\'s line');
    assert.deepEqual([...rig.leases.fencedPaths()], [], 'no lease lives any more');
    // A publishes its capture; B applies it: B's file holds Claude's line and all three of B's changes.
    fx.advance(20_000);
    await captureReady(pa, await prep(pa, true));
    fx.advance(30_000);
    const pub = await publishStep(pa.core, await prep(pa));
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    fx.advance(30_000);
    const rb = await applyStep(pb.core, await prep(pb, true));
    assert.ok(rb.written.includes(F), JSON.stringify(rb));
    assert.equal((await readWork(pb, F))?.toString('utf8'), MERGED);
  } finally {
    await fx.cleanup();
  }
});

test('the INFLIGHT backstop expires a lease with no Post; the deferred teammate change lands within 125,000 ms of the acquisition (06 test 17\'s leg, plan l. 2967)', T10, async () => {
  const holder: { rig?: DaemonRig } = {};
  const fx = await makeEngines('p5-leases-backstop', { n: 2, files: { [F]: buf(BASE) }, engineDeps: () => ({ claude: lazyClaudePort(() => holder.rig!.defer) }) });
  try {
    const rig = daemonRig({ clock: fx.peers[0]!.clock });   // the lease table on A's own clock
    holder.rig = rig;
    await fx.startAll();
    const pa = fx.peers[0]!;
    const t0 = pa.clock.monoMs();
    rig.leases.acquireInflight(inflOf('tu-abandoned', F));
    await fx.pushTeamChange({ [F]: buf(B1) });
    // 1 s steps: the housekeeping expiry (the daemon's 1 s ticker, driven directly) and one loop iteration of A.
    let landed: number | null = null;
    let expiredAt: number | null = null;
    let fencedSeen = false;
    for (let step = 0; step < 200 && landed === null; step++) {
      fx.advance(1_000);
      const ex = rig.leases.expire();
      if (ex.expired.length > 0) {
        assert.equal(expiredAt, null, 'the lease expires once');
        assert.equal(ex.expired.length, 1, JSON.stringify(ex));
        assert.equal(ex.expired[0]!.toolUseId, 'tu-abandoned');
        expiredAt = pa.clock.monoMs();
        const backstopAge = expiredAt - ex.expired[0]!.acquiredMono;
        assert.ok(backstopAge >= C.INFLIGHT_BACKSTOP_MS && backstopAge < C.INFLIGHT_BACKSTOP_MS + 2_000, `the backstop expired it at ${backstopAge} ms`);
        assert.deepEqual([...rig.leases.fencedPaths()], [], 'the fence went with the lease');
      }
      await pa.engine.iterate();
      if (expiredAt === null && pa.core.view!.meta.pending[F] === 'fence') fencedSeen = true;
      const text = (await readWork(pa, F))?.toString('utf8');
      if (text === B1) landed = pa.clock.monoMs();
      else assert.equal(text, BASE, `step ${step}: A does not write f while the lease lives`);
    }
    assert.ok(fencedSeen, 'while the lease lived the apply deferred f with reason fence');
    assert.ok(expiredAt !== null, 'the backstop expired the lease');
    assert.ok(landed !== null, 'the deferred change landed within 200 steps');
    assert.ok(landed >= expiredAt, 'it landed after the expiry');
    assert.ok(landed - t0 >= C.INFLIGHT_BACKSTOP_MS, `it cannot land before the backstop (${landed - t0} ms)`);
    assert.ok(landed - t0 <= 125_000, `landed ${landed - t0} ms after the acquisition (bound 125,000)`);
  } finally {
    await fx.cleanup();
  }
});

test('06 test 19: a 150 s permission prompt while a peer change applies — the expired lease taints the path; the teammate line stays in the live tip and a revert-detector PATCH exists (CCI-24, INV-CCI-EXPIRY-TAINT, R5-27)', T10, async () => {
  const h = await seatHarness({ peers: 2, files: { [F]: buf(BASE) } });
  try {
    await h.engines.startAll();
    const pa = h.engines.peers[0]!;
    const pb = h.engines.peers[1]!;
    const ctx = h.daemons[0]!.ctx;
    const S = RIG_SEAT;
    // One round: the harness clock +2,500 ms (the daemon's and both engines' clocks), the housekeeping expiry
    // driven directly (the 1 s ticker, as the plan's "the seat's leases driven directly"), then every engine's iterate.
    const rounds = async (n: number, each: () => void = () => undefined): Promise<void> => {
      for (let i = 0; i < n; i++) {
        await h.advance(2_500);
        each();
        for (const p of h.engines.peers) await p.engine.iterate();
      }
    };
    // B's teammate change to line 3 of f: B's own engine captures and publishes it (its own writes, its own clock).
    await writeWork(pb, F, B_LINE);
    for (let i = 0; i < 24 && !((await remoteLiveFiles(h.engines, pa)).get(F) ?? '').includes('three-B'); i++) await rounds(1, () => ctx.leases.expire());
    assert.ok(((await remoteLiveFiles(h.engines, pa)).get(F) ?? '').includes('three-B'), 'B published its change to line 3 of f');
    // The prompt: the full Read and the PreToolUse(Write) at 0; no hook activity during the 150 s prompt — the fence
    // holds the writer's apply until the 120 s backstop expires both leases.
    ctx.leases.acquireRead(S, F);
    ctx.leases.acquireInflight(inflOf('tu19', F));
    await rounds(44, () => ctx.leases.expire());   // 110 s: both leases still live
    assert.equal((await readWork(pa, F))?.toString('utf8'), BASE, 'the fence holds the writer\'s apply while the prompt runs');
    let applied = false;
    for (let i = 0; i < 12 && !applied; i++) {
      await rounds(1, () => ctx.leases.expire());
      applied = (await readWork(pa, F))?.toString('utf8') === B_LINE;
    }
    assert.ok(applied, 'after the 120 s backstop the expired fence lets the writer apply B\'s change');
    // The user approves at 150 s; the approved Write is the OLD pre-image (B's row missing) — the expired call wrote
    // f while the change was already applied. Task 12's post.edit replays: release(tu, 'post'), then the edit-Post.
    await writeWork(pa, F, CLAUDE_STALE);
    ctx.leases.release('tu19', 'post');
    ctx.windows.onEditPost(S, F, 'tu19');   // the expired call's own Post: the grace opens, the taint stays (R5-27)
    // The grace is open and the stale delta is fresh: the engine's port must answer UNOBSERVED — the taint wins over
    // the grace (R5-27, INV-CCI-EXPIRY-TAINT). 5d8e65d's production port answers observed here (its edit-Post grace
    // absorbs the stale delta: the RED, brief item I4-c) — the t8a wiring is what closes the gap.
    assert.equal(pa.core.deps.attribution.observedEdit(F), false, 'the expired call\'s taint keeps the stale delta unobserved inside the grace (the RED on 5d8e65d)');
    // The first post-Post detection ticks: the unobserved stale delta holds as a revert-detector PATCH.
    await h.advance(400);
    ctx.leases.expire();
    await pa.engine.iterate();
    await h.advance(400);
    await pa.engine.iterate();
    let recs: ReturnType<typeof withGuard> = [];
    for (let i = 0; i < 24 && recs.length === 0; i++) {
      await rounds(1, () => ctx.leases.expire());
      recs = withGuard(pa, 'revert').filter((r) => r.paths.includes(F));
    }
    assert.equal(recs.length, 1, `a non-terminal revert PATCH on f exists (${JSON.stringify(recs.map((r) => [r.id, r.state]))})`);
    let tip = '';
    for (let i = 0; i < 24 && !tip.includes('three-B'); i++) {
      await rounds(1, () => ctx.leases.expire());
      tip = (await remoteLiveFiles(h.engines, pa)).get(F) ?? '';
    }
    assert.ok(tip.includes('three-B'), `the teammate's line stays in the live tip ("${tip.slice(0, 60)}…")`);
  } finally {
    await h.cleanup();
  }
});
