// Engine.flowInputs() and Engine.hasShadow(path) (Plan 3 Task 18; rev 2.5, F14; X-11; 10-product §3.5.1, UX-33, UX-34, FEAT-F14-04,
// -05, -13): F14's engine-side inputs, computed from the last iteration's in-memory state — no git process and no Fs call during the
// query — with every fact the query needs kept where the engine already has it (the apply's trailer read, the snapshot tick, the state
// commits, the daemon start). Two Engines on real clones of one file:// remote (makeEngines); git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimes, writeFile } from 'node:fs/promises';
import { parseWriter } from '../../src/board/boardCommit.js';
import { governorRank } from '../../src/board/fold.js';
import { foldPatch } from '../../src/engine/core.js';
import { buildFlowInputs, hasShadow, type EngineFlowInputs } from '../../src/engine/flowInputs.js';
import { heldPins, pinCs, shadowRecord } from '../../src/holds/changesets.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { gitCallsOf, readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { restartEngine, T10 } from '../helpers/loopHoldsFixture.js';
import { buf, failedResult, wrapGit } from '../helpers/publishHelpers.js';

const FIELDS: ReadonlyArray<keyof EngineFlowInputs> = [
  'nowMono', 'loopPeriodMs', 'tipHeight', 'fetchedAgeMs', 'frozen', 'paused', 'B',
  'dirtyPaths', 'incomingPaths', 'pushIntentPaths', 'exclusions', 'deferred', 'notApplicable',
  'pendingFirstSeenMono', 'lastApplyMono', 'quietLeftMs', 'cs', 'groups', 'heldPins', 'holds',
  // Task 18 additions (contract addition 1, additive): O6's governor wait, the A ≠ TIP paths no apply has read a commit for yet, and
  // (fix round 1, O2's input) the scope class and not-shared reason of every path the other fields name.
  'wait', 'incomingUnread', 'scopes',
];

const TEAM_A = 'one\ntwo team\nthree\nfour\nfive\nsix\nseven\neight\n';
const P2_A = 'one\ntwo team\nthree\nfour\nfive p2\nsix\nseven\neight\n';
const TEAM_A2 = 'one\ntwo team\nthree\nfour\nfive p2\nsix\nseven\neight team\n';
const TEAM_B2 = 'alpha\nbeta\ngamma team\n';

/** The spawn spy (every git call of the peer's runner) and the Fs spy (every FaultFs call), as counts. */
function spies(p: PeerFixture): { git: number; fs: number } {
  return { git: gitCallsOf(p).length, fs: p.fs.calls.length };
}

/** A working file written with its mtime at the peer's virtual wall clock now: the next tick sees it inside the 300 ms quiet period. */
async function writeQuiet(p: PeerFixture, path: string, text: string): Promise<void> {
  await writeFile(workPath(p, path), text, 'utf8');
  const t = p.clock.wallMs() / 1_000;
  await utimes(workPath(p, path), t, t);
}

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

/** `n` loop periods on peer p alone (every clock advances; the other peer has nothing to do in these tests). */
async function step(fx: EngineFixture, p: EngineFixture['peers'][number], n = 1, ms = 2_500): Promise<void> {
  for (let i = 0; i < n; i++) {
    fx.advance(ms);
    await p.engine.iterate();
  }
}

/**
 * Loop periods on peer p alone until `cond` holds (at most `max` steps of `ms`). A step stays below 3 × the active loop period, so the
 * loop never reads it as a suspend (Global Constraints, step 0a).
 */
async function stepUntil(fx: EngineFixture, p: EngineFixture['peers'][number], cond: () => boolean | Promise<boolean>, what: string, max = 16, ms = 2_500): Promise<void> {
  for (let i = 0; i < max && !(await cond()); i++) await step(fx, p, 1, ms);
  assert.ok(await cond(), `${what} within ${max} loop periods`);
}

/** A push that lands on the server while the client sees no report, with first-parent walks that fail until `walks.fail` is cleared. */
function ambiguousLandingPush(fx: EngineFixture, p: PeerFixture): { walks: { fail: boolean }; restore: () => void } {
  const walks = { fail: false };
  let pushes = 0;
  const restore = wrapGit(p, async (args, opts, inner) => {
    if (args[0] === 'push' && pushes === 0) {
      pushes += 1;
      const real = await inner(args, opts);
      await fx.pushTeamChange({ 'team.txt': buf('t\n') });
      walks.fail = true;
      return { ...failedResult(128), durationMs: real.durationMs };
    }
    if (walks.fail && args[0] === 'rev-list' && args.includes('--max-count=10000') && args.some((a) => a.startsWith('^'))) return failedResult(128);
    return inner(args, opts);
  });
  return { walks, restore };
}

test('flowInputs is computed from memory: the spawn spy and the Fs spy record nothing during the call, and every EngineFlowInputs field is present', T10, async () => {
  await withEngines('fi-memory', { n: 2 }, async (fx) => {
    const p = fx.peers[0]!;
    // Before any start: no state yet (core.view null), the registry loaded (createEngineCore loads it): a complete, empty answer from
    // memory, nothing thrown — the governor's wait not known yet (ms null, never Infinity).
    assert.equal(p.core.view, null, 'no state before the start');
    const before0 = spies(p);
    const fi0 = p.engine.flowInputs();
    assert.equal(p.engine.hasShadow('src/a.txt'), false);
    assert.deepEqual(spies(p), before0, 'memory only before the start too');
    assert.deepEqual(Object.keys(fi0).sort(), [...FIELDS].sort());
    assert.deepEqual(
      [fi0.tipHeight, fi0.fetchedAgeMs, fi0.frozen, fi0.paused, fi0.wait, fi0.pendingFirstSeenMono, fi0.lastApplyMono, fi0.quietLeftMs],
      [null, null, false, false, { ms: null, term: 'window' }, null, null, null],
    );
    for (const k of ['dirtyPaths', 'incomingPaths', 'incomingUnread', 'pushIntentPaths', 'exclusions', 'deferred', 'notApplicable', 'cs', 'groups', 'heldPins', 'holds', 'scopes'] as const) {
      assert.deepEqual(fi0[k], [], `${k} is empty before the start`);
    }
    assert.equal(JSON.stringify(fi0.wait), '{"ms":null,"term":"window"}', 'the IPC form says "not known" explicitly');
    await fx.startAll();
    await step(fx, p, 2);
    await writeWork(p, 'src/b.txt', 'alpha\nbeta local\ngamma\n');
    await step(fx, p);
    const before = spies(p);
    const fi = p.engine.flowInputs();
    const viaCore = buildFlowInputs(p.core);
    const shadowed = p.engine.hasShadow('src/b.txt') || hasShadow(p.core, 'src/a.txt');
    assert.deepEqual(spies(p), before, 'no git process and no Fs call during flowInputs() and hasShadow()');
    assert.ok(!(fi instanceof Promise), 'a synchronous read');
    assert.equal(shadowed, false);
    assert.deepEqual(Object.keys(fi).sort(), [...FIELDS].sort(), 'every EngineFlowInputs field, nothing else');
    for (const k of FIELDS) assert.notEqual(fi[k], undefined, `${k} is present`);
    assert.deepEqual(viaCore, fi, 'Engine.flowInputs() is buildFlowInputs(core)');
    assert.equal(fi.nowMono, p.clock.monoMs());
    assert.deepEqual(fi.dirtyPaths.map((d) => d.path), ['src/b.txt']);
    assert.deepEqual(fi.scopes, [{ path: 'src/b.txt', cls: 'LIVE', reason: null }], 'the one path named, shared live');
    assert.equal(fi.quietLeftMs, 20_000, 'the human CS opened at this iteration');
    assert.deepEqual(fi.incomingPaths, []);
    assert.deepEqual(fi.incomingUnread, []);
    // The spies do record: one iteration spawns git and calls the Fs.
    await step(fx, p);
    const after = spies(p);
    assert.ok(after.git > before.git && after.fs > before.fs, 'the spies count an iteration');
  });
});

test('dirtyPaths lists only paths seen by the last snapshot, and pushIntentPaths carries a kept push intent\'s paths with its since-instant', T10, async () => {
  await withEngines('fi-dirty', { n: 2 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p, 2);
    await writeWork(p, 'src/a.txt', 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\n');
    fx.advance(2_500);
    await p.engine.iterate();
    const t1 = p.clock.monoMs();
    assert.deepEqual(p.engine.flowInputs().dirtyPaths, [{ path: 'src/a.txt', firstSeenMono: t1 }]);
    // An edit after the last snapshot is not listed until a tick reads it.
    await writeWork(p, 'src/b.txt', 'alpha\nbeta 2\ngamma\n');
    assert.deepEqual(p.engine.flowInputs().dirtyPaths, [{ path: 'src/a.txt', firstSeenMono: t1 }], 'an edit newer than the last snapshot');
    fx.advance(2_500);
    await p.engine.iterate();
    const t2 = p.clock.monoMs();
    assert.deepEqual(p.engine.flowInputs().dirtyPaths, [{ path: 'src/a.txt', firstSeenMono: t1 }, { path: 'src/b.txt', firstSeenMono: t2 }], 'first seen, kept across ticks');
    assert.deepEqual(p.engine.flowInputs().pushIntentPaths, []);

    // The human CS closes; its publish lands on the server but the report is lost and the first-parent walk fails: the intent is kept.
    fx.advance(21_000);
    const { walks, restore } = ambiguousLandingPush(fx, p);
    try {
      const tBefore = p.clock.monoMs();
      await p.engine.iterate();
      const tAfter = p.clock.monoMs();
      const intent = p.core.view!.intent;
      assert.equal(intent.kind, 'push', 'the ambiguous intent is kept');
      let fi = p.engine.flowInputs();
      assert.deepEqual(fi.pushIntentPaths.map((x) => x.path), ['src/a.txt', 'src/b.txt']);
      const since = fi.pushIntentPaths[0]!.sinceMono;
      assert.ok(since >= tBefore && since <= tAfter, 'since the intent was journaled');
      assert.ok(fi.pushIntentPaths.every((x) => x.sinceMono === since));
      fx.advance(2_500);
      await p.engine.iterate();
      assert.equal(p.core.view!.intent.kind, 'push', 'still kept');
      fi = p.engine.flowInputs();
      assert.deepEqual(fi.pushIntentPaths.map((x) => [x.path, x.sinceMono]), [['src/a.txt', since], ['src/b.txt', since]], 'the since-instant is kept');
      walks.fail = false;
      for (let i = 0; i < 20 && p.core.view!.intent.kind === 'push'; i++) await step(fx, p);
      assert.equal(p.core.view!.intent.kind, 'none', 'the intent resolved');
    } finally {
      restore();
    }
    await step(fx, p, 2);
    const fi = p.engine.flowInputs();
    assert.deepEqual(fi.pushIntentPaths, []);
    assert.deepEqual(fi.dirtyPaths, [], 'published: the disk equals A again');
    const own = (x: EngineFlowInputs): string[] => [...x.incomingPaths.map((e) => e.path), ...x.incomingUnread].filter((q) => q.startsWith('src/'));
    assert.deepEqual(own(fi), [], 'an own published change is no incoming change (the kept intent resolved as landed)');

    // A direct landing: right after the iteration whose publish landed, the TIP map in memory is the one fetched before the push while
    // A already holds the published entries — the flow still lists no incoming change for them.
    await writeWork(p, 'src/a.txt', 'one\nTWO\nthree\nFOUR\nfive\nsix\nseven\neight\n');
    await step(fx, p);
    p.engine.done();   // /cowork done: the human CS closes at the next iteration
    let landed = false;
    for (let i = 0; i < 16 && !landed; i++) {
      fx.advance(2_500);
      landed = (await p.engine.iterate()).landed;
    }
    assert.ok(landed, 'the edit published');
    assert.deepEqual(own(p.engine.flowInputs()), [], 'not listed as incoming right after its own landing');
  });
});

test('incomingPaths carries, for each A ≠ TIP path, the writer and the Cowork-Writer display name of the newest LA_C..TIP commit changing it, kept from the last apply; no commit is read at query time', T10, async () => {
  await withEngines('fi-incoming', { n: 2 }, async (fx) => {
    await fx.startAll();
    const [p1, p2] = [fx.peers[0]!, fx.peers[1]!];
    await fx.rounds(2);   // p1's stat cache knows src/a.txt clean: the writer meets the lock holder
    const release = p1.fs.holdLock(workPath(p1, 'src/a.txt'), 'share-none');
    try {
      // An older change by the synthetic teammate, then p2's newer change of the same path: the newest commit's writer is p2.
      await fx.pushTeamChange({ 'src/a.txt': buf(TEAM_A) });
      await stepUntil(fx, p2, async () => (await readWork(p2, 'src/a.txt'))?.toString('utf8') === TEAM_A, 'p2 applied the teammate change');
      await writeWork(p2, 'src/a.txt', P2_A);
      await step(fx, p2);
      p2.engine.done();   // /cowork done: p2's human CS closes at its next iteration
      let landed = false;
      for (let i = 0; i < 16 && !landed; i++) {
        fx.advance(2_500);
        landed = (await p2.engine.iterate()).landed;
      }
      assert.ok(landed, 'p2 published its change');
      await stepUntil(fx, p1, () => p1.engine.flowInputs().incomingPaths.some((x) => x.writer === p2.core.peerId), 'p1\'s apply read p2\'s commit');
      assert.ok(Object.hasOwn(p1.core.view!.meta.pending, 'src/a.txt'), 'deferred by the lock: A ≠ TIP');
      const before = spies(p1);
      const fi = p1.engine.flowInputs();
      assert.deepEqual(spies(p1), before, 'no commit is read at query time');
      assert.deepEqual(fi.incomingPaths, [{ path: 'src/a.txt', writer: p2.core.peerId, name: p2.deps.display }]);
      assert.deepEqual(fi.incomingUnread, []);
      assert.equal(fi.lastApplyMono, p1.core.lastApplyMono, 'the last apply\'s instant (the 10 s coalescing input)');
      assert.ok(fi.lastApplyMono !== null && fi.lastApplyMono <= fi.nowMono);

      const firstDeferral = fi.deferred.find((d) => d.path === 'src/a.txt');
      assert.ok(firstDeferral !== undefined && firstDeferral.reason === 'locked', 'the lock deferral');

      // A newer teammate change fetched right after an apply waits for the next one (10 s coalescing): until an apply reads its commit,
      // its paths are listed as unread — src/a.txt too, whose kept writer (p2) described the TIP blob that apply read, not this one —
      // never under a writer kept for an older change.
      await stepUntil(fx, p1, () => p1.core.lastApplyMono === p1.clock.monoMs(), 'an apply at this iteration');
      await fx.pushTeamChange({ 'src/a.txt': buf(TEAM_A2), 'src/b.txt': buf(TEAM_B2) });
      await step(fx, p1);
      const coalesced = p1.engine.flowInputs();
      assert.ok(p1.clock.monoMs() - p1.core.lastApplyMono! < 10_000, 'the apply is coalesced');
      assert.deepEqual(coalesced.incomingUnread, ['src/a.txt', 'src/b.txt'], 'fetched, not read by any apply yet');
      assert.deepEqual(coalesced.incomingPaths, [], 'no writer kept for an older change of src/a.txt stands in');

      // The next apply reads the commit: one teammate CS over both paths, so the lock holds back src/b.txt too — a new closure
      // {src/a.txt, src/b.txt}, whose HLD-54 clock (TransientClocks) starts at this apply: the deferral anchor of both paths, although
      // src/a.txt has been in meta.pending since its first deferral.
      await stepUntil(fx, p1, () => p1.core.lastApplyMono === p1.clock.monoMs(), 'the next apply');
      const tClosure = p1.clock.monoMs();
      const reread = p1.engine.flowInputs();
      assert.deepEqual(reread.incomingUnread, []);
      assert.deepEqual(reread.incomingPaths.map((x) => x.path), ['src/a.txt', 'src/b.txt']);
      assert.ok(reread.incomingPaths.every((x) => x.writer !== p2.core.peerId && x.writer === reread.incomingPaths[0]!.writer), 'the teammate\'s commit, one writer');
      assert.deepEqual(reread.deferred.map((d) => [d.path, d.firstSeenMono]), [['src/a.txt', tClosure], ['src/b.txt', tClosure]], 'the HLD-54 anchor of the new closure');
      assert.ok(firstDeferral.firstSeenMono < tClosure);
      assert.equal(reread.pendingFirstSeenMono, tClosure);
    } finally {
      release();
    }
    await stepUntil(fx, p1, async () => (await readWork(p1, 'src/a.txt'))?.toString('utf8') === TEAM_A2, 'applied after the lock went', 16, 7_500);
    const fi = p1.engine.flowInputs();
    assert.deepEqual([fi.incomingPaths, fi.incomingUnread, fi.deferred], [[], [], []]);
  });
});

test('incomingPaths keeps a not-applicable path\'s writer and name after a later apply of an unrelated teammate commit, whose trailer read starts above the path\'s commit (audit #25)', T10, async () => {
  await withEngines('fi-keepwriter', { n: 1 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    // A teammate commit adds .gitattributes — quarantined for review (glossary §16): not applicable, pending 'quarantine', stage I2 —
    // beside a LIVE path that applies.
    const first = await fx.pushTeamChange({ 'src/x.txt': buf('x team\n'), '.gitattributes': buf('print(1)\n') });
    await stepUntil(fx, p, () => p.core.view!.meta.pending['.gitattributes'] === 'quarantine', 'the attribute file waits for a decision');
    // The writer as the commit names it, read with git here (the query never reads a commit). The synthetic teammate never joined, so
    // the fold names no display name for it and {name} is its peer id (10-product §3.5.1).
    const trailer = (await p.core.repo.readCommit(first.live)).trailers.filter((t) => t.key === 'Cowork-Writer');
    assert.equal(trailer.length, 1);
    const writer = parseWriter(trailer[0]!.value)!.peer;
    assert.equal(p.core.displayName(writer), null);
    const kept = { path: '.gitattributes', writer, name: writer };
    let fi = p.engine.flowInputs();
    assert.deepEqual(fi.notApplicable, [{ path: '.gitattributes', reason: 'quarantine' }]);
    assert.deepEqual([fi.incomingPaths, fi.incomingUnread], [[kept], []], 'the apply that read the commit names its writer');

    // An unrelated teammate commit, applied: LA_C moves to the new TIP, and that apply's trailer read is (LA_C, TIP] — incomingBase
    // leaves a not-applicable row out of its walk — so it never reaches the attribute file's commit. The writer stays known.
    const laC0 = p.core.view!.laC;
    await fx.pushTeamChange({ 'other.txt': buf('unrelated\n') });
    await stepUntil(fx, p, async () => (await readWork(p, 'other.txt'))?.toString('utf8') === 'unrelated\n', 'the unrelated commit applied');
    assert.notEqual(p.core.view!.laC, laC0, 'the apply moved LA_C');
    assert.equal(p.core.view!.meta.pending['.gitattributes'], 'quarantine', 'still waiting for a decision');
    const before = spies(p);
    fi = p.engine.flowInputs();
    assert.deepEqual(spies(p), before, 'no commit is read at query time');
    assert.deepEqual(fi.incomingPaths, [kept], 'the writer and name of the earlier read, not moved to incomingUnread');
    assert.deepEqual(fi.incomingUnread, []);
  });
});

test('exclusions, deferred and notApplicable carry a 60 s lock deferral, an unmaterializable path and a quiet-period exclusion with first-seen Δmono; setAtStart and openAtStart are true only for anchors and CSs that existed when this daemon started', T10, async () => {
  await withEngines('fi-anchors', { n: 2, platform: 'win32' }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p);   // the stat cache knows src/a.txt clean: the writer meets the lock holder
    const release = p.fs.holdLock(workPath(p, 'src/a.txt'), 'share-none');
    try {
      // One teammate commit: src/a.txt (deferred by the lock) and con.py (not creatable on Windows: not applicable at once).
      await fx.pushTeamChange({ 'src/a.txt': buf(TEAM_A), 'con.py': buf('print(1)\n') });
      let tDefer = -1;
      await stepUntil(fx, p, () => {
        const on = Object.hasOwn(p.core.view!.meta.pending, 'src/a.txt');
        if (on && tDefer < 0) tDefer = p.clock.monoMs();
        return on;
      }, 'the lock deferral');
      assert.equal(p.core.view!.meta.pending['con.py'], 'unmaterializable');
      // 60 s in 8 steps of 7.5 s (3 x the active loop period: no suspend, the rule is Δmono > 3 x period): the closure's INCOMING record
      // exists (HLD-54 creates it once the closure's clock reaches 60 s).
      await step(fx, p, 8, 7_500);
      assert.ok(p.core.holds.nonTerminal().some((r) => r.kind === 'INCOMING' && r.paths.includes('src/a.txt') && r.guards.some((g) => g.name === 'lock')));
      let fi = p.engine.flowInputs();
      assert.deepEqual(fi.deferred, [{ path: 'src/a.txt', reason: 'locked', firstSeenMono: tDefer, setAtStart: false }]);
      assert.ok(fi.nowMono - fi.deferred[0]!.firstSeenMono >= 60_000, 'a 60 s deferral');
      assert.deepEqual(fi.notApplicable, [{ path: 'con.py', reason: 'unmaterializable' }]);
      assert.equal(fi.pendingFirstSeenMono, tDefer);

      // A save inside the 300 ms quiet period: excluded at this tick, first seen now.
      await writeQuiet(p, 'src/b.txt', 'alpha\nbeta quiet\ngamma\n');
      await p.engine.iterate();
      const tq = p.clock.monoMs();
      fi = p.engine.flowInputs();
      assert.deepEqual(fi.exclusions, [{ path: 'src/b.txt', reason: 'quiet', firstSeenMono: tq, setAtStart: false }]);
      fx.advance(1_000);
      await p.engine.iterate();
      assert.deepEqual(p.engine.flowInputs().exclusions, [], 'read once quiet');

      // An open seat CS and a quiet save at the restart; the lock and the not-applicable path stay.
      const SEAT = 'c'.repeat(32);
      await fx.signal(0, effect(SEAT, ['seat1.txt']));
      const seatCs = `${SEAT}/1`;
      assert.ok(p.core.cs.table().cs.some((e) => e.cs_id === seatCs && e.state === 'open'));
      fi = p.engine.flowInputs();
      assert.equal(fi.cs.find((e) => e.cs_id === seatCs)?.openAtStart, false, 'opened after this daemon started');
      await writeQuiet(p, 'README.md', '# quiet at the restart\n');
      await restartEngine(p);
      const tStart = p.clock.monoMs();
      fi = p.engine.flowInputs();
      // Its reason is the state's (the restarted snapshot cannot read the locked file either); the path stayed pending, so its anchor is the start's.
      const why = p.core.view!.meta.pending['src/a.txt'];
      assert.ok(why !== undefined && why !== 'unmaterializable' && why !== 'collision' && why !== 'quarantine', `still deferred: ${String(why)}`);
      assert.deepEqual(fi.deferred, [{ path: 'src/a.txt', reason: why, firstSeenMono: tStart, setAtStart: true }], 'the deferral existed at this start: its anchor restarted there');
      assert.deepEqual(fi.notApplicable, [{ path: 'con.py', reason: 'unmaterializable' }]);
      const row = fi.cs.find((e) => e.cs_id === seatCs);
      assert.ok(row !== undefined && row.state === 'open' && row.openAtStart, 'the seat CS restored from the cache was open at this start');
      const quietAtStart = fi.exclusions.find((e) => e.path === 'README.md');
      assert.deepEqual(quietAtStart, { path: 'README.md', reason: 'quiet', firstSeenMono: tStart, setAtStart: true }, 'first seen by a tick of the start');
      assert.ok(fi.exclusions.every((e) => e.setAtStart), 'every exclusion seen now was seen by the start');

      // Anchors and CSs that come after the start.
      const SEAT2 = 'd'.repeat(32);
      await fx.signal(0, effect(SEAT2, ['seat2.txt']));
      fx.advance(1_000);
      await writeQuiet(p, 'src/new.txt', 'new\n');
      await p.engine.iterate();
      const tNew = p.clock.monoMs();
      fi = p.engine.flowInputs();
      assert.equal(fi.cs.find((e) => e.cs_id === `${SEAT2}/1`)?.openAtStart, false, 'a CS opened after the start');
      assert.equal(fi.cs.find((e) => e.cs_id === seatCs)?.openAtStart, true);
      assert.deepEqual(fi.exclusions.find((e) => e.path === 'src/new.txt'), { path: 'src/new.txt', reason: 'quiet', firstSeenMono: tNew, setAtStart: false });
      assert.equal(fi.exclusions.find((e) => e.path === 'README.md'), undefined, 'README.md was read once quiet');
      assert.deepEqual(fi.deferred, [{ path: 'src/a.txt', reason: p.core.view!.meta.pending['src/a.txt'], firstSeenMono: tStart, setAtStart: true }]);
    } finally {
      release();
    }
    await stepUntil(fx, p, async () => (await readWork(p, 'src/a.txt'))?.toString('utf8') === TEAM_A, 'applied after the lock went', 16, 7_500);
    const fi = p.engine.flowInputs();
    assert.deepEqual(fi.deferred, []);
    assert.deepEqual(fi.notApplicable, [{ path: 'con.py', reason: 'unmaterializable' }], 'a not-applicable path waits for a decision');
  });
});

test('cs, groups, heldPins and holds equal the CS table, groups(heldPins) and the registry\'s non-terminal records, INCOMING ones included', T10, async () => {
  await withEngines('fi-tables', { n: 2 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p, 2);
    // An INCOMING record (a teammate's change deferred by a lock for 60 s) and a held PIN (a local edit unreadable for 60 s).
    const releaseA = p.fs.holdLock(workPath(p, 'src/a.txt'), 'share-none');
    await writeWork(p, 'src/b.txt', 'alpha\nbeta local\ngamma\n');
    const releaseB = p.fs.holdLock(workPath(p, 'src/b.txt'), 'share-none');
    try {
      await fx.pushTeamChange({ 'src/a.txt': buf(TEAM_A) });
      const kinds = (): string[] => p.core.holds.nonTerminal().map((r) => `${r.kind}:${r.guards.map((g) => g.name).join(',')}`).sort();
      await stepUntil(fx, p, () => kinds().includes('INCOMING:lock') && kinds().includes('PIN:unreadable'), 'the INCOMING record and the unreadable PIN', 16, 7_000);
      // An open seat CS and an open human CS.
      await fx.signal(0, effect('c'.repeat(32), ['seat.txt']));
      await writeWork(p, 'README.md', '# human\n');
      fx.advance(2_500);
      await p.engine.iterate();
      const fi = p.engine.flowInputs();
      const core = p.core;
      assert.deepEqual(fi.cs, core.cs.table().cs.map((e) => ({ ...e, openAtStart: false })), 'the CS table\'s rows (none was open at this start)');
      assert.ok(fi.cs.some((e) => e.kind === 'seat' && e.state === 'open'));
      const pins = heldPins(core.holds);
      assert.deepEqual(fi.heldPins, pins);
      assert.deepEqual(fi.heldPins.map((x) => x.guards), [['unreadable']]);
      assert.deepEqual(fi.groups, core.cs.groups(pins), 'groups(heldPins)');
      assert.ok(fi.groups.some((g) => g.paths.includes('README.md')), 'the open human CS\'s group');
      assert.deepEqual(fi.holds, core.holds.nonTerminal().map((r) => ({
        id: r.id, kind: r.kind, residence: r.residence, state: r.state, guards: r.guards.map((g) => g.name), paths: [...r.paths],
        cs_ids: [...r.cs_ids], local_only: r.local_only, ageMs: core.holds.ageMs(r),
      })));
      assert.deepEqual(fi.holds.map((h) => h.kind).sort(), ['INCOMING', 'PIN'], 'INCOMING records included');
      assert.ok(fi.holds.every((h) => h.ageMs >= 0));
      // PC-2 Task 18 review (Minor, a): the unreadable PIN shares no path with a CS, so the groups above do not show that the pins reach
      // groups(). A held PIN on a path of the open human CS joins that CS's publication group, which lists its id and is not ready.
      const A = await core.repo.readTreeMap(core.view!.base);
      const h1 = await core.repo.hashBytes(buf('pinned\n'), true);
      const pinId = await core.holds.hold(pinCs('claim:abcdefghij234567', [], ['README.md'], A, { 'README.md': h1 }, 'e'.repeat(32), 'pending_leftover'));
      const withPin = p.engine.flowInputs();
      const group = withPin.groups.find((g) => g.paths.includes('README.md'));
      assert.ok(group !== undefined && group.pins.includes(pinId) && !group.ready, `the human CS's group lists the PIN: ${JSON.stringify(withPin.groups)}`);
      assert.deepEqual(withPin.groups, core.cs.groups(heldPins(core.holds)));
    } finally {
      releaseA();
      releaseB();
    }
  });
});

test('hasShadow(path) is true only for a member path of an open seat CS that a non-terminal SHADOW record names in its cs_ids', T10, async () => {
  await withEngines('fi-shadow', { n: 2 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p, 2);
    const S1 = 'c'.repeat(32);
    const S2 = 'd'.repeat(32);
    await fx.signal(0, effect(S1, ['src/a.txt', 'src/b.txt']));
    await fx.signal(0, effect(S2, ['README.md']));
    const cs1 = `${S1}/1`;
    const cs2 = `${S2}/1`;
    assert.deepEqual(p.core.cs.table().cs.filter((e) => e.state === 'open').map((e) => e.cs_id).sort(), [cs1, cs2]);
    assert.equal(p.engine.hasShadow('src/a.txt'), false, 'no SHADOW yet');
    const A = await p.core.repo.readTreeMap(p.core.view!.base);
    const h1 = await p.core.repo.hashBytes(buf('denied\n'), true);
    // A PIN naming cs2 is no SHADOW (not an OFF_DISK claim PATCH).
    await p.core.holds.hold(pinCs('claim:abcdefghij234567', [cs2], ['README.md'], A, { 'README.md': h1 }, S2, 'pending_leftover'));
    const shadow = await p.core.holds.hold({ ...shadowRecord('claim:abcdefghij234567', 'src/a.txt', A.get('src/a.txt')!.oid, h1, S1), cs_ids: [cs1] });
    // Plan 7 asks per path: the registry is read (and sorted) once per registry state, not once per call.
    const reg = p.core.holds;
    const nonTerminal = reg.nonTerminal.bind(reg);
    let reads = 0;
    reg.nonTerminal = (): ReturnType<typeof nonTerminal> => {
      reads += 1;
      return nonTerminal();
    };
    try {
      for (let i = 0; i < 1_000; i++) assert.equal(p.engine.hasShadow(i % 2 === 0 ? 'src/a.txt' : 'README.md'), i % 2 === 0);
      assert.ok(reads <= 1, `1,000 calls read the registry ${reads} times`);
    } finally {
      reg.nonTerminal = nonTerminal;
    }
    const before = spies(p);
    assert.equal(p.engine.hasShadow('src/a.txt'), true);
    assert.equal(p.engine.hasShadow('src/b.txt'), true, 'every member path of the named CS');
    assert.equal(p.engine.hasShadow('README.md'), false, 'a seat CS no SHADOW names');
    assert.equal(p.engine.hasShadow('src/other.txt'), false, 'no member path');
    assert.deepEqual(spies(p), before, 'memory only');
    // A terminal SHADOW names nothing.
    await p.core.holds.transition(shadow, { state: 'GONE' });
    assert.equal(p.engine.hasShadow('src/a.txt'), false, 'the SHADOW ended');
    await p.core.holds.hold({ ...shadowRecord('claim:abcdefghij234567', 'src/b.txt', A.get('src/b.txt')!.oid, h1, S1), cs_ids: [cs1] });
    assert.equal(p.engine.hasShadow('src/a.txt'), true, 'a new SHADOW names the CS again');
    // The CS closes at its seat's stop: no longer an open seat CS.
    await fx.signal(0, { kind: 'stop', seat: S1 });
    assert.equal(p.core.cs.table().cs.find((e) => e.cs_id === cs1)?.state ?? 'closed', 'closed');
    assert.equal(p.engine.hasShadow('src/a.txt'), false, 'the named CS is closed');
    assert.equal(p.engine.hasShadow('src/b.txt'), false);
  });
});

test('frozen, paused, B, tipHeight, fetchedAgeMs, loopPeriodMs and nowMono follow the engine: a FREEZE reason, a publish pause and a throttle fallback each show', T10, async () => {
  await withEngines('fi-scalars', { n: 2 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p, 3);
    const height = (): number => (foldPatch(p.core)?.fold ?? p.core.view!.fold)!.height;
    let fi = p.engine.flowInputs();
    assert.equal(fi.nowMono, p.clock.monoMs());
    assert.equal(fi.tipHeight, height());
    assert.equal(fi.fetchedAgeMs, 0, 'the iteration fetched at this instant');
    assert.deepEqual([fi.frozen, fi.paused, fi.B], [false, false, 12]);
    const fold = foldPatch(p.core)?.fold ?? p.core.view!.fold!;
    assert.deepEqual(fi.wait, p.core.governor.waitDetail(governorRank(fold, p.core.peerId)), 'the governor\'s wait at this peer\'s rank');
    fx.advance(1_000);
    fi = p.engine.flowInputs();
    assert.equal(fi.fetchedAgeMs, 1_000);
    assert.equal(fi.nowMono, p.clock.monoMs());

    // The loop period of the last iteration: idle, then active with an edit pending.
    let rep = await p.engine.iterate();
    assert.equal(p.engine.flowInputs().loopPeriodMs, rep.active ? 2_500 : 10_000);
    assert.equal(rep.active, false, 'nothing pending: idle');
    await writeWork(p, 'src/b.txt', 'alpha\nbeta 9\ngamma\n');
    fx.advance(2_500);
    rep = await p.engine.iterate();
    assert.equal(rep.active, true);
    assert.equal(p.engine.flowInputs().loopPeriodMs, 2_500);

    // tipHeight follows a teammate's landing.
    const h0 = p.engine.flowInputs().tipHeight!;
    await fx.pushTeamChange({ 'team.txt': buf('t\n') });
    await step(fx, p);
    assert.equal(p.engine.flowInputs().tipHeight, h0 + 1);

    // A FREEZE reason.
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: ['PAUSED'] } });
    fi = p.engine.flowInputs();
    assert.deepEqual([fi.frozen, fi.paused], [true, false]);
    await p.core.commit({ meta: { ...p.core.view!.meta, freeze_reasons: [] } });
    assert.equal(p.engine.flowInputs().frozen, false);

    // A publish pause: OFFLINE after 30 s without an answer of the remote.
    let cut = true;
    const restore = wrapGit(p, async (args, opts, inner) => (cut && opts.class === 'network' ? failedResult(128, "fatal: unable to access 'remote': Could not resolve host\n") : inner(args, opts)));
    try {
      await step(fx, p, 1, 31_000);   // 31 s without an answer of the remote
      fi = p.engine.flowInputs();
      assert.deepEqual([fi.frozen, fi.paused], [false, true], 'OFFLINE is a publish pause, no FREEZE');
      assert.ok(fi.fetchedAgeMs !== null && fi.fetchedAgeMs >= 30_000);
      cut = false;
      for (let i = 0; i < 6 && p.engine.flowInputs().paused; i++) await step(fx, p, 1, 31_000);   // past any network backoff
      assert.equal(p.engine.flowInputs().paused, false, 'online again');
    } finally {
      cut = false;
      restore();
    }

    // A throttle fallback: B_eff 6.
    p.core.governor.onSignal('http_429', true, false);
    fi = p.engine.flowInputs();
    assert.equal(fi.B, 6);
    assert.equal(fi.paused, false, 'a fallback is no publish pause');

    // O6's estimate through the flow: B_eff (6) teammate landings revealed by one fetch hold the sliding team guard for 60 s; once the
    // window and the own spacing are over (at this peer's rank) the guard alone remains: team_guard, 60 s minus the time since.
    // First the edit of src/b.txt is published (nothing of this peer's own lands meanwhile).
    const settled = (): boolean => p.core.cs.counts().open === 0 && p.core.cs.counts().ready === 0 && p.core.view!.intent.kind === 'none'
      && p.core.outbox.size === 0;
    await stepUntil(fx, p, settled, 'nothing left to publish');
    await step(fx, p);   // an own landing of the last iteration is folded at the next fetch
    const hBefore = p.engine.flowInputs().tipHeight!;
    for (let i = 0; i < 6; i++) await fx.pushTeamChange({ [`team${i}.txt`]: buf(`${i}\n`) });
    fx.advance(2_500);
    const rep6 = await p.engine.iterate();
    assert.equal(p.engine.flowInputs().tipHeight, hBefore + 6, `the six landings were folded (${JSON.stringify({ landed: rep6.landed, attempts: rep6.pushAttempts, outbox: p.core.outbox.size })})`);
    const eff = p.core.governor.effective();
    const rank = governorRank(foldPatch(p.core)?.fold ?? p.core.view!.fold!, p.core.peerId);
    const past = Math.max(eff.G_ms + (rank - 1) * eff.S_ms, eff.Gbase_ms) + 1_000;
    assert.ok(past < 60_000, `the window opens before the guard ends: ${JSON.stringify({ eff, rank })}`);
    fx.advance(past);
    fi = p.engine.flowInputs();
    assert.deepEqual(fi.wait, { ms: 60_000 - past, term: 'team_guard' }, 'the team guard, through flowInputs');
  });
});

/** The core fixture's three files plus a .gitattributes that turns gen/** off (cowork-sync=off: UNMANAGED, D5 row 4). */
const GEN_FILES: Record<string, Buffer> = {
  'README.md': buf('# core fixture\n'),
  'src/a.txt': buf('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'),
  'src/b.txt': buf('alpha\nbeta\ngamma\n'),
  '.gitattributes': buf('gen/** cowork-sync=off\n'),
};

test('in is the apply trigger\'s A ≠ TIP set without UNMANAGED paths — a PHANTOM PIN\'s path and an UNMANAGED path are left out, a triggered path is listed — and scopes carries the scope class and not-shared reason of every path the inputs name (O2)', T10, async () => {
  await withEngines('fi-trigger', { n: 2, files: GEN_FILES }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p);
    // An apply at this iteration, then a teammate commit fetched while the next apply is coalesced (10 s): A ≠ TIP on its three paths.
    await fx.pushTeamChange({ 'README.md': buf('# one\n') });
    await stepUntil(fx, p, async () => (await readWork(p, 'README.md'))?.toString('utf8') === '# one\n', 'the first change applied');
    assert.equal(p.core.lastApplyMono, p.clock.monoMs(), 'applied at this iteration');
    await fx.pushTeamChange({ 'README.md': buf('# two\n'), 'src/a.txt': buf(TEAM_A), 'gen/out.txt': buf('generated\n') });
    // Local work: a LIVE edit, an edit of a quarantined tracked file (.gitattributes, glossary §16) and a new temp file (not admitted).
    await writeWork(p, 'src/b.txt', 'alpha\nbeta local\ngamma\n');
    await writeWork(p, '.gitattributes', 'gen/** cowork-sync=off\n# local\n');
    await writeWork(p, 'notes.swp', 'swap\n');
    await step(fx, p);
    assert.ok(p.clock.monoMs() - p.core.lastApplyMono! < 10_000, 'the apply is coalesced');
    const trees = p.core.revertTreesNow()!;
    const differs = (q: string): boolean => trees.A.get(q)?.oid !== trees.TIP.get(q)?.oid;
    assert.ok(['README.md', 'src/a.txt', 'gen/out.txt'].every(differs), 'A ≠ TIP on the three paths');
    const inOf = (x: EngineFlowInputs): string[] => [...x.incomingPaths.map((e) => e.path), ...x.incomingUnread].sort();
    let fi = p.engine.flowInputs();
    assert.deepEqual(inOf(fi), ['README.md', 'src/a.txt'], 'gen/out.txt is UNMANAGED (cowork-sync=off): never written, no in entry');

    // scopes (O2's input): every path the inputs name, with its class and its not-shared reason, sorted by path.
    const scopeOf = (q: string): unknown => fi.scopes.find((s) => s.path === q);
    assert.deepEqual(fi.dirtyPaths.map((d) => d.path), ['.gitattributes', 'notes.swp', 'src/b.txt'], 'the out domain lists dirty non-LIVE paths');
    assert.deepEqual(scopeOf('src/b.txt'), { path: 'src/b.txt', cls: 'LIVE', reason: null });
    assert.deepEqual(scopeOf('.gitattributes'), { path: '.gitattributes', cls: 'QUARANTINED', reason: 'quarantine' });
    assert.deepEqual(scopeOf('notes.swp'), { path: 'notes.swp', cls: 'NOT_ADMITTED', reason: 'temp' });
    assert.deepEqual(scopeOf('README.md'), { path: 'README.md', cls: 'LIVE', reason: null });
    assert.equal(scopeOf('gen/out.txt'), undefined, 'a path no field names is not listed');
    const listed = fi.scopes.map((s) => s.path);
    assert.deepEqual(listed, [...listed].sort(), 'sorted by path');

    // A PHANTOM PIN (ENG-34: written once, never verified) takes src/a.txt out of the apply trigger: no in entry while it holds.
    await p.core.holds.hold({
      kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt'],
      blobs: { h0: { 'src/a.txt': trees.A.get('src/a.txt')!.oid }, h1: { 'src/a.txt': trees.TIP.get('src/a.txt')!.oid } },
      guard: 'phantom', origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false,
    });
    const before = spies(p);
    fi = p.engine.flowInputs();
    assert.deepEqual(spies(p), before, 'memory only');
    assert.ok(differs('src/a.txt'), 'A ≠ TIP still');
    assert.deepEqual(inOf(fi), ['README.md'], 'the PHANTOM path is out of the apply trigger');
    assert.deepEqual(fi.holds.map((h) => [h.kind, h.paths]), [['PIN', ['src/a.txt']]]);
  });
});

test('exclusions keep a materialization\'s own exclusion with its first-seen Δmono and tick across loops while the path stays excluded, and drop it once a materialization reads the path', T10, async () => {
  await withEngines('fi-matex', { n: 2 }, async (fx) => {
    await fx.startAll();
    const p = fx.peers[0]!;
    await step(fx, p);
    // Route (a)'s add cannot index src/b.txt (rc 1, the path stuck): every materialization excludes it 'unreadable'; the tick, which
    // hashes without writing, never does.
    let stuck = true;
    let adds = 0;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (stuck && args[0] === 'add' && args.includes('--pathspec-from-file=-')) {
        adds += 1;
        return failedResult(1);
      }
      return inner(args, opts);
    });
    try {
      await writeWork(p, 'src/b.txt', 'alpha\nbeta stuck\ngamma\n');
      await step(fx, p);
      p.engine.done();   // /cowork done: the human CS closes, its capture materializes
      const find = (): EngineFlowInputs['exclusions'][number] | undefined => p.engine.flowInputs().exclusions.find((e) => e.path === 'src/b.txt');
      let first: EngineFlowInputs['exclusions'][number] | undefined;
      await stepUntil(fx, p, () => (first = find()) !== undefined, 'a materialization excluded src/b.txt');
      assert.equal(first!.reason, 'unreadable');
      assert.equal(first!.firstSeenMono, p.clock.monoMs(), 'first seen at this materialization');
      const addsAtFirst = adds;
      await step(fx, p);
      assert.equal(adds, addsAtFirst, 'a tick, no materialization');
      assert.deepEqual(find(), first, 'kept while the path is dirty and no materialization has read it');
      // An incoming change: its admitted apply materializes again ('auto'), which excludes src/b.txt again — the same exclusion.
      await fx.pushTeamChange({ 'README.md': buf('# team\n') });
      await stepUntil(fx, p, async () => (await readWork(p, 'README.md'))?.toString('utf8') === '# team\n', 'the teammate change applied');
      assert.ok(adds > addsAtFirst, 'materialized again');
      assert.deepEqual(find(), first, 'the first sighting and tick kept across the materialization');
    } finally {
      stuck = false;
      restore();
    }
    // The next materialization (another incoming change's apply) reads src/b.txt: the exclusion ends.
    await fx.pushTeamChange({ 'README.md': buf('# team 2\n') });
    await stepUntil(fx, p, () => !p.engine.flowInputs().exclusions.some((e) => e.path === 'src/b.txt'), 'read once the add works', 16, 7_500);
  });
});
