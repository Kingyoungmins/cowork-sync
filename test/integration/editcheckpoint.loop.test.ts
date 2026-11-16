// Edit checkpoints through the loop (Plan 3 Task 12a; 01-engine ENG-13, tests 53–56; 05-holds HLD-40, HLD-67; CS-09; rulings R3-05,
// R3-23, R3-41; contract additions 5 and 8): Engine.signal queues a scripted change-set signal and runs the ENG-13 out-of-cycle
// iteration (after the hook-named paths' 300 ms quiet period), whose candidate the scripted EditCheckPort settles; a scripted
// T0RegionsPort fails a merged tree holding the BROKEN marker. makeEngines({n: 2, ports}) on real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCsCache } from '../../src/engine/csStep.js';
import { enc } from '../../src/git/enc.js';
import type { Oid } from '../../src/git/oid.js';
import type { GitRepo } from '../../src/git/repo.js';
import type { EditCheckPort, EditCheckVerdict, T0RegionsPort, T0Verdict } from '../../src/holds/ports.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { readWork, workPath, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { LOOP_ACTIVE_MS } from '../../src/engine/loop.js';
import { logOf, remoteBoardTip, withEngines, type EngineFixture } from '../helpers/engineFixture.js';
import { liveOf } from '../helpers/incidentFixture.js';
import { fpy, remoteLiveFiles, roundsUntil, T10, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const S = 'a'.repeat(32);
const BROKEN = 'BROKEN';
const g = (tag: string): string => fpy(12, { replace: { 4: `g_4 = ${tag}` } }).replace(/row_/g, 'g_');
const FILES: Record<string, Buffer> = {
  'README.md': buf('# edit checkpoints\n'),
  'g.py': buf(g('0')),
  'other.txt': buf('other 1\nother 2\nother 3\n'),
  's.txt': buf('s1\n'),
};

/** The text of `path` in tree `t` (null when absent). */
async function textIn(repo: GitRepo, t: Oid, path: string): Promise<string | null> {
  const e = (await repo.readTreeMap(t)).get(path);
  return e === undefined ? null : (await repo.readBlob(e.oid)).toString('utf8');
}

/** An EditCheckPort that fails a candidate whose R holds the BROKEN marker in any CS path, and counts its calls. */
function markerEditCheck(): { port: EditCheckPort; calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    port: {
      async check(repo, _a, r, _tip, csPaths): Promise<EditCheckVerdict> {
        calls.n += 1;
        for (const p of csPaths) if ((await textIn(repo, r, p))?.includes(BROKEN) === true) return { verdict: 'fail', failed: [4], entries: [{ check: 4, path: p, reason: 'label_count' }] };
        return { verdict: 'pass' };
      },
    },
  };
}

/** A T0RegionsPort failing a merged OUT whose CS path holds the BROKEN marker (item 1, as Plan 4's regionTripwire would). */
const markerT0: T0RegionsPort = {
  async check(repo, _tip, out, paths): Promise<T0Verdict> {
    for (const p of paths) if ((await textIn(repo, out, p))?.includes(BROKEN) === true) return { pass: false, paths: [p], item: 1 };
    return { pass: true };
  },
};

type EnginePeer = EngineFixture['peers'][number];
let tool = 0;
const effect = (paths: readonly string[], seat = S): CsSignal => ({ kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' });
let cand = 0;
const editCheckpoint = (paths: readonly string[], seat = S): CsSignal => ({ kind: 'checkpoint', seat, source: 'edit', candSeq: ++cand, paths });

/** A seat's Edit of g.py: written, its effect and its edit checkpoint announced through Engine.signal (the out-of-cycle iteration runs). */
async function seatEdit(fx: EngineFixture, text: string): Promise<void> {
  await writeWork(fx.peers[0]!, 'g.py', text);
  await fx.signal(0, effect(['g.py']));
  await fx.signal(0, editCheckpoint(['g.py']));
}

async function started(fx: EngineFixture): Promise<EnginePeer> {
  await fx.startAll();
  await fx.rounds(2);
  return fx.peers[0]!;
}

const iterations = (fx: EngineFixture, p: PeerFixture, from: number): number => fx.trace.events.slice(from).filter((e) => e.kind === 'iteration' && e.peer === p.core.peerId).length;

/** Every live commit's g.py text on the remote chain since `from` (first-parent, oldest first). */
async function liveHistory(fx: EngineFixture, p: PeerFixture, from: Oid): Promise<string[]> {
  const tip = await liveOf(p, (await remoteBoardTip(fx)) as Oid);
  const r = await p.core.repo.run(['rev-list', '--first-parent', '--reverse', `${from}..${tip}`]);
  const out: string[] = [];
  for (const c of r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0)) out.push((await textIn(p.core.repo, (await p.core.repo.readCommit(c as Oid)).tree, 'g.py')) ?? '');
  return out;
}

/**
 * Instruments p.engine's iterateNow (every iteration, the loop's and the out-of-cycle ones): each start's mono and wall time on p's
 * clock and the most iterations that ever ran at once. restore() removes the instrumentation.
 */
function instrumentIterations(p: EnginePeer): { monoStarts: number[]; wallStarts: number[]; maxInFlight: () => number; restore: () => void } {
  let inFlight = 0;
  let max = 0;
  const monoStarts: number[] = [];
  const wallStarts: number[] = [];
  const run = (Reflect.get(p.engine, 'iterateNow') as (...a: unknown[]) => Promise<unknown>).bind(p.engine);
  Reflect.set(p.engine, 'iterateNow', async (...a: unknown[]): Promise<unknown> => {
    monoStarts.push(p.clock.monoMs());
    wallStarts.push(p.clock.wallMs());
    max = Math.max(max, ++inFlight);
    try {
      return await run(...a);
    } finally {
      inFlight -= 1;
    }
  });
  return { monoStarts, wallStarts, maxInFlight: () => max, restore: () => void Reflect.deleteProperty(p.engine, 'iterateNow') };
}

async function remoteLive(fx: EngineFixture, p: PeerFixture): Promise<Oid> {
  await p.core.fetcher.fetch(true);
  return liveOf(p, (await remoteBoardTip(fx)) as Oid);
}

test('01 #53: a passing edit checkpoint starts one out-of-cycle iteration whose candidate is journaled in one state update and published in the next governor window before the turn ends; a second passing edit replaces it and only its content publishes', T10, async () => {
  const ec = markerEditCheck();
  await withEngines('ecl-53', { n: 2, files: FILES, ports: { editCheck: ec.port, t0Regions: markerT0 } }, async (fx) => {
    const p = await started(fx);
    const tip0 = await remoteLive(fx, p);
    await writeWork(p, 'g.py', g('one'));
    await fx.signal(0, effect(['g.py']));
    fx.advance(6_000);   // the governor window is open for the iteration after the out-of-cycle one
    const from = fx.trace.events.length;
    const before = p.core.view!.commit;
    await fx.signal(0, editCheckpoint(['g.py']));
    assert.equal(iterations(fx, p, from), 1, 'one out-of-cycle iteration');
    assert.equal(ec.calls.n, 1, 'its candidate checked once');
    // Fix round 1 (minor): journaled in exactly one state update — checked right at the out-of-cycle iteration, before any publish round.
    const updates = fx.trace.events.slice(from).filter((e) => e.kind === 'state' && e.peer === p.core.peerId);
    assert.equal(updates.length, 1, 'one state update');
    assert.deepEqual(updates.map((e) => (e.kind === 'state' ? [e.prev, e.next] : null)), [[before, p.core.view!.commit]], 'that update is the current state commit');
    assert.equal(p.core.view!.ready.length, 1, 'it journals the candidate as the CS\'s ready pair');
    assert.equal(await textIn(p.core.repo, p.core.view!.ready[0]!.R, 'g.py'), g('one'));
    assert.equal(p.core.cs.table().cs.find((e) => e.seat === S)?.state, 'open', 'the turn has not ended');
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('one'), 'published in the next window, before the turn ends', 4);
    // Two passing edits before the next window: the second's candidate replaces the first's ready pair, only its content publishes.
    const tip1 = await remoteLive(fx, p);
    assert.notEqual(tip1, tip0);
    await seatEdit(fx, g('two'));
    await seatEdit(fx, g('three'));
    assert.equal(p.core.view!.ready.length, 1, 'one ready pair: the newest passing capture');
    assert.equal(await textIn(p.core.repo, p.core.view!.ready[0]!.R, 'g.py'), g('three'));
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('three'), 'the second content published', 6);
    assert.deepEqual(await liveHistory(fx, p, tip1), [g('three')], 'the replaced content never reached the live chain');
    assert.equal(p.core.cs.table().cs.find((e) => e.seat === S)?.state, 'open', 'still before the turn ends');
  });
});

test('01 #54: a failing edit leaves no ready pair, record, event or message (rev 2.5: only the memory-only last_check changes, D1); an earlier passing capture still publishes; the next passing edit publishes; a turn that ends while still failing gets the ordinary close and a K7 PIN when T0 fails', T10, async () => {
  const ec = markerEditCheck();
  await withEngines('ecl-54', { n: 2, files: FILES, ports: { editCheck: ec.port, t0Regions: markerT0 } }, async (fx) => {
    const p = await started(fx);
    // A passing edit, captured (the window is closed: a fresh own landing is not needed; the round after publishes it).
    await seatEdit(fx, g('good'));
    assert.equal(p.core.view!.ready.length, 1);
    const csId = p.core.view!.ready[0]!.csId;
    // A failing edit: nothing changes but the memory-only last_check.
    const state = p.core.view!.commit;
    const registry = p.core.holds.head();
    const outbox = JSON.stringify(p.core.outbox.toJson());
    const holdCode = p.core.holdCode;
    const logged = logOf(p).lines.length;
    await seatEdit(fx, g(`${BROKEN} half`));
    assert.equal(p.core.view!.commit, state, 'no state update');
    assert.equal(p.core.holds.head(), registry, 'no record');
    assert.equal(JSON.stringify(p.core.outbox.toJson()), outbox, 'no event');
    assert.equal(p.core.holdCode, holdCode, 'no message');
    assert.equal(logOf(p).lines.length, logged, 'no log line');
    assert.equal(p.core.cs.lastCheck.get(csId)?.kind, 'fail', 'last_check (memory only)');
    // The earlier passing capture still publishes.
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('good'), 'the earlier passing capture published', 6);
    // The next passing edit publishes.
    await seatEdit(fx, g('fixed'));
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('fixed'), 'the next passing edit published', 6);
    // The turn ends while still failing: the ordinary close captures, T0 fails on the merged OUT, a K7 PIN holds the group.
    const tip = await remoteLive(fx, p);
    await seatEdit(fx, g(`${BROKEN} at the end`));
    await fx.signal(0, { kind: 'stop', seat: S });
    await roundsUntil(fx, () => withGuard(p, 't0').length === 1, 'the K7 PIN', 6);
    const pin = withGuard(p, 't0')[0]!;
    assert.deepEqual([pin.kind, pin.paths], ['PIN', ['g.py']]);
    await fx.rounds(3);
    assert.equal(await remoteLive(fx, p), tip, 'nothing of the failing turn end published');
  });
});

test('01 #55: the out-of-cycle iteration starts no earlier than 300 ms after the hook-named path\'s mtime and captures the edited bytes; with a concurrent appender no capture holds a half-written file; ten edits within 1 s coalesce into one iteration per loop slot with at most one in flight', T10, async () => {
  const ec = markerEditCheck();
  await withEngines('ecl-55', { n: 2, files: FILES, ports: { editCheck: ec.port, t0Regions: markerT0 } }, async (fx) => {
    const p = await started(fx);
    // A fresh write: its mtime is this PC's wall clock now.
    const abs = workPath(p, 'g.py');
    await writeFile(abs, g('fresh'));
    await utimes(abs, p.clock.wallMs() / 1_000, p.clock.wallMs() / 1_000);
    const mtime = (await stat(abs)).mtimeMs;   // as the file system stored it
    await fx.signal(0, effect(['g.py']));
    // Fix round 1: the iteration's start is read at iterateNow itself (an out-of-cycle iteration of steps 0–4 may make no git fetch of
    // its own: the 2.5 s fetch spacing defers it, and it no longer publishes).
    const first = instrumentIterations(p);
    try {
      await fx.signal(0, editCheckpoint(['g.py']));
    } finally {
      first.restore();
    }
    assert.equal(first.wallStarts.length, 1, 'one out-of-cycle iteration');
    assert.ok(first.wallStarts[0]! >= mtime + 300, `the iteration started ${first.wallStarts[0]! - mtime} ms after the mtime`);
    assert.equal(await textIn(p.core.repo, p.core.view!.ready[0]!.R, 'g.py'), g('fresh'), 'the capture holds the edited bytes');
    // A concurrent in-place appender: every read of g.py during the iteration sees the file grow, so the staged read is unstable and
    // no candidate is captured from a half-written file; once the writer is done the next checkpoint captures the whole file.
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('fresh'), 'the fresh capture published', 6);
    const tipA = await remoteLive(fx, p);
    const whole = `${g('appended')}tail 1\ntail 2\n`;
    await writeWork(p, 'g.py', g('appended'));
    let appends = 0;
    p.fs.interpose('readFile', abs, async () => {
      appends += 1;
      await appendFile(abs, appends === 1 ? 'tail 1\n' : appends === 2 ? 'tail 2\n' : '');
    }, 2);
    await fx.signal(0, effect(['g.py']));
    await fx.signal(0, editCheckpoint(['g.py']));
    assert.equal(appends, 2, 'the writer appended during the iteration\'s reads');
    const Rs = async (): Promise<Array<string | null>> => Promise.all(p.core.view!.ready.map((r) => textIn(p.core.repo, r.R, 'g.py')));
    for (const t of await Rs()) assert.ok(t === whole, `no half-written capture: ${JSON.stringify(t)}`);
    assert.equal(await readFile(abs).then((b) => b.toString('utf8')), whole);
    // The writer is done: the hook reports its effect and the next edit checkpoint.
    await fx.signal(0, effect(['g.py']));
    await fx.signal(0, editCheckpoint(['g.py']));
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === whole, 'the whole file captured and published once the writer is done', 6);
    for (const t of await liveHistory(fx, p, tipA)) assert.equal(t, whole, 'no half-written file on the live chain');
    // Ten edits within 1 s: their signals coalesce into one out-of-cycle iteration per loop slot, at most one in flight.
    // Instrumented: every iteration's start on this peer's clock and how many run at once.
    const ins = instrumentIterations(p);
    const burst: Array<Promise<void>> = [];
    let settled: Array<PromiseSettledResult<void>>;
    try {
      for (let i = 0; i < 10; i++) {
        await writeWork(p, 'g.py', g(`burst ${i}`));
        burst.push(fx.signal(0, effect(['g.py'])).then(() => fx.signal(0, editCheckpoint(['g.py']))));
        fx.advance(100);
      }
      settled = await Promise.allSettled(burst);
    } finally {
      ins.restore();
    }
    // At most one in flight, checked first: the instrumentation counts overlapping iterateNow runs directly, and two overlapping iterations
    // also break each other (their scratch indexes), which must not hide the count (fix round 1: a planted mutant running the waiting
    // out-of-cycle iteration outside the Engine's queue fails here).
    assert.equal(ins.maxInFlight(), 1, 'never two iterations at once');
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
    const starts = ins.monoStarts;
    // Fix round 1 (minor): a bound that a non-coalescing engine fails. The ten checkpoints are all issued inside the first loop slot
    // (≤ 1 s of virtual time), so they make at most: the first slot's iteration, one iteration waiting at that slot's end that every
    // checkpoint asking meanwhile joins, and one more for a checkpoint whose quiet check finished after that one had started (observed:
    // [0, 2500, 5000] on every run). One iteration per checkpoint (10), or two per slot, fails here or in the spacing check below.
    assert.ok(starts.length >= 1 && starts.length <= 3, `the ten checkpoints coalesced into ${starts.length} out-of-cycle iteration(s): ${JSON.stringify(starts)}`);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= LOOP_ACTIVE_MS, `one per loop slot: ${JSON.stringify(starts)}`);
    const captured = p.core.view!.ready.find((r) => r.paths.includes('g.py'));
    const last = captured !== undefined ? await textIn(p.core.repo, captured.R, 'g.py') : (await remoteLiveFiles(fx, p)).get('g.py');
    assert.equal(last, g('burst 9'), 'the last edit is captured');
  });
});

test('01 #56 Plan 3 part: a failing candidate leaves the state ref unchanged and its blobs referenced only by the private index', T10, async () => {
  const ec = markerEditCheck();
  await withEngines('ecl-56', { n: 2, files: FILES, ports: { editCheck: ec.port, t0Regions: markerT0 } }, async (fx) => {
    const p = await started(fx);
    const state = p.core.view!.commit;
    const text = g(`${BROKEN} candidate`);
    await seatEdit(fx, text);
    assert.equal(ec.calls.n, 1);
    assert.equal(p.core.view!.commit, state, 'the state ref is unchanged');
    const blob = await p.core.repo.hashBytes(buf(text), false);
    const r = await testRunner().run(['rev-list', '--objects', '--all'], { class: 'local', cwd: p.deps.paths.workTree });
    assert.equal(r.stdout.toString('utf8').includes(blob), false, 'no ref reaches the candidate\'s blob');
    const idx = await p.core.repo.listIndex(join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`));
    assert.equal(idx.get('g.py')?.oid, blob, 'the private index references it (the materialization took it in)');
  });
});

test('Engine.signal of a stop starts one out-of-cycle iteration of steps 0–4 whose capture comes from a fresh snapshot', T10, async () => {
  await withEngines('ecl-stop', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await writeWork(p, 'g.py', g('before'));
    await fx.signal(0, effect(['g.py']));
    await writeWork(p, 'g.py', g('at stop'));   // written after the effect, before the stop: only a fresh snapshot sees it
    // Fix round 1 (finding 2): work a full iteration would do in steps 5–6 — a teammate change to apply, and the governor window open,
    // so the stop's own capture would publish in the same iteration. Steps 0–4 (01-engine §3.5 (b), ENG-13) do neither.
    await fx.pushTeamChange({ 'other.txt': buf('other 1\nother 2 team\nother 3\n') });
    fx.advance(6_000);
    const from = fx.trace.events.length;
    const pushes = p.core.pushAttempts;
    await fx.signal(0, { kind: 'stop', seat: S });
    const events = fx.trace.events.slice(from).filter((e) => e.peer === p.core.peerId);
    assert.equal(iterations(fx, p, from), 1, 'one out-of-cycle iteration');
    assert.equal(events.filter((e) => e.kind === 'mask').length, 1, 'it materialized (step 4)');
    assert.deepEqual(events.filter((e) => e.kind === 'apply' || e.kind === 'publish').map((e) => e.kind), [], 'no apply (step 5) and no publish (step 6)');
    assert.equal(p.core.pushAttempts, pushes, 'no push attempt across the signal');
    assert.equal((await readWork(p, 'other.txt'))?.toString('utf8'), 'other 1\nother 2\nother 3\n', 'the teammate change is not applied yet');
    const pair = p.core.view!.ready.find((r) => r.csId.startsWith(S)) ?? null;
    assert.ok(pair !== null, 'the stop\'s ready pair is journaled');
    assert.equal(await textIn(p.core.repo, pair.R, 'g.py'), g('at stop'), 'the capture comes from the fresh snapshot');
    // The next ordinary iteration applies and publishes.
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('g.py') === g('at stop') && (await readWork(p, 'other.txt'))?.toString('utf8') === 'other 1\nother 2 team\nother 3\n', 'applied and published by the loop', 6);
  });
});

test('Engine.signal resolves only after the out-of-cycle iteration it asked for has started and the cache is written', T10, async () => {
  await withEngines('ecl-resolve', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    await writeWork(p, 'g.py', g('cache'));
    await fx.signal(0, effect(['g.py']));
    const from = fx.trace.events.length;
    await p.engine.signal({ kind: 'stop', seat: S });
    // With no further step: the cache names the current state commit and the iteration's event is recorded.
    const doc = JSON.parse((await readFile(join(p.deps.paths.coworkDir, 'cs', `${enc(p.deps.branch)}.json`))).toString('utf8')) as { state: string };
    assert.equal(doc.state, p.core.view!.commit, 'cs/<enc(b)>.json names the current state commit');
    assert.ok((await readCsCache(p.core)) !== null);
    assert.equal(iterations(fx, p, from), 1, 'that iteration\'s iteration event');
  });
});

test('a stranded restore blocks every capture: a due close and a passing edit checkpoint journal no ready pair until the restore completes', T10, async () => {
  await withEngines('ecl-stranded', { n: 2, files: FILES }, async (fx) => {
    const p = await started(fx);
    // s.txt: the apply's P2 link fails, the rollback's relink of its .old too, and every sweep after it — for as long as the test keeps
    // the fault on (fix round 1, finding 3: the restore stays stranded until the test lets it complete, so the checks below always run).
    let stranding = true;
    p.fs.interpose('link', workPath(p, 's.txt'), async (path) => {
      if (stranding) throw Object.assign(new Error(`EPERM: operation not permitted, link '${path}'`), { code: 'EPERM', errno: -4048, syscall: 'link', path });
    }, 1_000_000);
    await fx.pushTeamChange({ 's.txt': buf('s2\n') });
    await roundsUntil(fx, () => p.core.writer.strandedPaths().length > 0, 'a stranded restore', 8);
    // A human close due and a passing edit checkpoint while it is stranded.
    await writeWork(p, 'other.txt', 'other 1 human\nother 2\nother 3\n');
    await writeWork(p, 'g.py', g('seat'));
    await fx.signal(0, effect(['g.py']));
    const state = p.core.view!.commit;
    const from = fx.trace.events.length;
    fx.advance(21_000);
    await fx.signal(0, editCheckpoint(['g.py']));
    assert.ok(p.core.writer.strandedPaths().length > 0, 'still stranded after the out-of-cycle iteration');
    for (let i = 0; i < 2; i++) {
      fx.advance(500);
      await p.engine.iterate();
      assert.ok(p.core.writer.strandedPaths().length > 0, `still stranded after iteration ${i + 1}`);
    }
    assert.ok(p.core.cs.pendingCandidates().length > 0, 'the passing edit checkpoint is still pending');
    assert.equal(fx.trace.events.slice(from).filter((e) => e.kind === 'mask' && e.peer === p.core.peerId).length, 0, 'no materialization for the checkpoint or the due close while stranded');
    assert.equal(fx.trace.events.slice(from).filter((e) => e.kind === 'edit_check' && e.peer === p.core.peerId).length, 0, 'no candidate settled');
    assert.deepEqual(p.core.view!.ready, [], 'no ready pair journaled');
    assert.equal(p.core.view!.commit, state, 'the state commit is unchanged');
    // The restore completes (the fault is off); the next iteration captures.
    stranding = false;
    await roundsUntil(fx, () => p.core.writer.strandedPaths().length === 0, 'the stranded restore completed', 10);
    await roundsUntil(fx, () => p.core.view!.ready.length > 0 || p.core.cs.table().cs.some((e) => e.publishes > 0), 'a capture after the restore', 10);
  });
});
