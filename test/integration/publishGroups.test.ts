// Algorithm P over publication groups (Plan 3 Task 10; 05-holds HLD-44, §3.6 Algorithm P, 05 I17 Plan 3 part, TC-HLD-08 at core level,
// O-ATOMIC-PUB; 01-engine §3.12, ENG-39, ENG-40; glossary §27.2; rulings R-18, R3-07, R3-63; X-03's `compose` event): the coalesced push,
// the governor's budget, whole group captures in every live commit, the step order and the `compose` trace event. Real clones; git
// is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import { applyStep } from '../../src/engine/apply.js';
import { tickInputOf, type IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { handOverThrottle, publishStep, type PublishReport } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { pinCs } from '../../src/holds/changesets.js';
import type { PublishGatePort, T0RegionsPort } from '../../src/holds/ports.js';
import { setBlob, type BlobMap } from '../../src/holds/record.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { gitCallsOf, readWork, writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { buf, editAndCapture, lines, prep, remoteLiveCode, treeOf, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { testRunner } from '../helpers/tmp.js';

const T10 = { timeout: 10 * 60_000 };
/**
 * R3-55's switch: the long multi-peer runs take their full length under `npm run test:sim` (TEST_SIM_FULL=1) and a shorter one under
 * `npm test`, whose files run in parallel on the PR legs (10 virtual minutes of four real peers outgrow the 10-minute file budget there).
 */
const FULL = process.env['TEST_SIM_FULL'] === '1';
const SA = 'a'.repeat(32);
const SB = 'b'.repeat(32);
const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const NOTES = '# Notes\n\nl1\nl2\nl3\nl4\nl5\nl6\n';

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

async function seatWrite(p: PeerFixture, seat: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  await prep(p);
}

async function capture(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[] }> {
  const it = await prep(p, true);
  return { it, captured: (await captureStep(p.core, it)).captured };
}

async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/** The first-parent live commits of the remote after `from`, oldest first, read in the bare remote. */
async function liveSince(fx: CoreFixture, from: Oid, to: Oid): Promise<Oid[]> {
  const r = await testRunner().run(['rev-list', '--first-parent', '--reverse', `${from}..${to}`], { class: 'local', cwd: fx.remote.dir });
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0) as Oid[];
}

/** path → content of a commit's tree, for the paths given, read in the bare remote. */
async function contentsAt(fx: CoreFixture, commit: Oid, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of paths) {
    const r = await testRunner().run(['show', `${commit}:${path}`], { class: 'local', cwd: fx.remote.dir });
    out.set(path, r.code === 0 ? r.stdout.toString('utf8') : '');
  }
  return out;
}

test('HLD-44: two independent ready groups publish in one push with one Cowork-CS trailer per CS, and a passing capture arriving before the window replaces the older one in that push', T10, async () => {
  const files = { 'README.md': buf('# HLD-44\n'), 'a.py': buf(py('a')), 'b.py': buf(py('b')) };
  await withCores('pg-hld44', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    await seatWrite(p, SA, { 'a.py': py('a', ' # first') });
    queueSignal(p.core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['a.py'] });
    await seatWrite(p, SB, { 'b.py': py('b', ' # B') });
    queueSignal(p.core, { kind: 'checkpoint', seat: SB, source: 'edit', candSeq: 1, paths: ['b.py'] });
    await capture(p);
    // A newer passing capture of A before the window: it replaces the older one in the same push.
    await seatWrite(p, SA, { 'a.py': py('a', ' # second') });
    queueSignal(p.core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 2, paths: ['a.py'] });
    await capture(p);
    const pushes = gitCallsOf(p).filter((c) => c.args[0] === 'push').length;
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.equal(gitCallsOf(p).filter((c) => c.args[0] === 'push').length, pushes + 1, 'one push');
    const C = await p.core.repo.readCommit(r.c!);
    assert.deepEqual(parseCsTrailers(C.trailers).cs.map((t) => t.csId).sort(), [`${SA}/1`, `${SB}/1`], 'one Cowork-CS per CS');
    const tree = await treeOf(p, r.c!);
    assert.equal((await p.core.repo.readBlob(tree.get('a.py')!.oid)).toString('utf8'), py('a', ' # second'), 'the newest passing capture');
    assert.equal((await p.core.repo.readBlob(tree.get('b.py')!.oid)).toString('utf8'), py('b', ' # B'));
  });
});

test('05 I17 Plan 3 part: four peers whose seats pass an edit check every 10–30 virtual seconds for 10 virtual minutes make at most 12 push attempts in every 60 s window and never publish a partial capture', T10, async () => {
  const files: Record<string, Buffer> = { 'README.md': buf('# I17\n') };
  for (let i = 0; i < 4; i++) for (const f of ['x', 'y']) files[`p${i}/${f}.py`] = buf(`${f} = 0\n`);
  await withCores('pg-i17', { n: 4, files }, async (fx) => {
    const seats = ['1', '2', '3', '4'].map((c) => c.repeat(32));
    const periods = [10, 20, 30, 20];   // virtual seconds between a peer's edits
    const candSeq = [0, 0, 0, 0];
    const perStep: number[] = [];
    const tip0 = await remoteLiveCode(fx, fx.peers[0]!);
    const allPushes = (): number => fx.peers.reduce((n, q) => n + gitCallsOf(q).filter((c) => c.args[0] === 'push').length, 0);
    const STEP = 10;
    for (let t = 0; t < (FULL ? 600 : 180); t += STEP) {
      const before = allPushes();
      for (const [i, p] of fx.peers.entries()) {
        const editing = t % periods[i]! === 0;
        // A peer with no edit due, nothing journaled and no op queued has nothing to publish this step (keeps the test short).
        if (!editing && p.core.cs.ready().length === 0 && p.core.outbox.size === 0) continue;
        if (editing) {
          const tag = `e${t}`;
          await writeWork(p, `p${i}/x.py`, `x = '${tag}'\n`);
          await writeWork(p, `p${i}/y.py`, `y = '${tag}'\n`);
          queueSignal(p.core, effect(seats[i]!, [`p${i}/x.py`, `p${i}/y.py`]));
          await prep(p);
          queueSignal(p.core, { kind: 'checkpoint', seat: seats[i]!, source: 'edit', candSeq: ++candSeq[i]!, paths: [`p${i}/x.py`, `p${i}/y.py`] });
        }
        const it = await prep(p, editing);
        if (editing) await captureStep(p.core, it);
        await publishStep(p.core, it);
      }
      perStep.push(allPushes() - before);
      fx.advance(STEP * 1_000);
    }
    // ≤ B = 12 attempts in every 60 s window (6 steps of 10 s).
    for (let k = 0; k + 6 <= perStep.length; k++) {
      const n = perStep.slice(k, k + 6).reduce((a, b) => a + b, 0);
      assert.ok(n <= 12, `${n} push attempts in the 60 s window from ${k * STEP} s`);
    }
    // No live commit carries half a capture: each peer's x.py and y.py always hold the same edit's tag.
    const commits = await liveSince(fx, tip0, await remoteLiveCode(fx, fx.peers[0]!));
    assert.ok(commits.length > 4, `the run published (${commits.length} live commits)`);
    for (const c of commits) {
      for (let i = 0; i < 4; i++) {
        const got = await contentsAt(fx, c, [`p${i}/x.py`, `p${i}/y.py`]);
        const tx = /'(e\d+)'|= 0/.exec(got.get(`p${i}/x.py`)!)?.[1] ?? 'base';
        const ty = /'(e\d+)'|= 0/.exec(got.get(`p${i}/y.py`)!)?.[1] ?? 'base';
        assert.equal(tx, ty, `${c}: peer ${i} published a partial capture (${tx} / ${ty})`);
      }
    }
  });
});

test('TC-HLD-08 at core level: every live commit of a 3-peer scripted run mixing seat and human CSs equals its parent plus whole group captures, never a strict subset of a group capture\'s hunks except exceptions (a)–(c)', T10, async () => {
  const files: Record<string, Buffer> = { 'README.md': buf('# TC-HLD-08\n') };
  for (let i = 0; i < 3; i++) for (const f of ['seat', 'human', 'shared']) files[`p${i}/${f}.py`] = buf(lines(10, (k) => `${f}_${k} = 0`));
  await withCores('pg-tchld08', { n: 3, files }, async (fx) => {
    const tip0 = await remoteLiveCode(fx, fx.peers[0]!);
    /** Every edit: its tag and the files it wrote (a group capture may hold several edits sharing shared.py). */
    const edits: Array<{ tag: string; peer: number; files: string[] }> = [];
    const text = new Map<string, string[]>();
    const set = async (p: PeerFixture, path: string, row: number, value: string): Promise<void> => {
      const rows = text.get(path) ?? (await readWork(p, path))!.toString('utf8').split('\n').slice(0, -1);
      rows[row] = value;
      text.set(path, rows);
      await writeWork(p, path, `${rows.join('\n')}\n`);
    };
    for (let round = 1; round <= (FULL ? 4 : 2); round++) {
      for (const [i, p] of fx.peers.entries()) {
        const seat = String(i + 1).repeat(32);
        const sTag = `S${round}p${i}`;
        const hTag = `H${round}p${i}`;
        // The seat edits seat.py and row 2 of shared.py; the human edits human.py and row 8 of shared.py: one group via shared.py.
        await set(p, `p${i}/seat.py`, 1, `seat = '${sTag}'`);
        await set(p, `p${i}/shared.py`, 1, `s = '${sTag}'`);
        queueSignal(p.core, effect(seat, [`p${i}/seat.py`, `p${i}/shared.py`]));
        await prep(p);
        edits.push({ tag: sTag, peer: i, files: [`p${i}/seat.py`, `p${i}/shared.py`] });
        if (round % 2 === 0) {
          await set(p, `p${i}/human.py`, 7, `h = '${hTag}'`);
          await set(p, `p${i}/shared.py`, 7, `hs = '${hTag}'`);
          await prep(p);
          edits.push({ tag: hTag, peer: i, files: [`p${i}/human.py`, `p${i}/shared.py`] });
        }
        queueSignal(p.core, { kind: 'stop', seat });
      }
      fx.advance(20_000);
      for (const p of fx.peers) {
        await captureStep(p.core, await prep(p, true));
        const r = await publish(fx, p);
        assert.ok(['landed', 'nothing', 'lease_lost'].includes(r.outcome), JSON.stringify(r));
      }
      for (const p of fx.peers) {
        const r = await publish(fx, p);   // a lost lease publishes in the next window
        assert.ok(['landed', 'nothing'].includes(r.outcome), JSON.stringify(r));
      }
    }
    const commits = await liveSince(fx, tip0, await remoteLiveCode(fx, fx.peers[0]!));
    assert.ok(commits.length >= (FULL ? 4 : 2));
    let parent = tip0;
    for (const c of commits) {
      const paths = edits.flatMap((e) => e.files);
      const now = await contentsAt(fx, c, [...new Set(paths)]);
      const was = await contentsAt(fx, parent, [...new Set(paths)]);
      // Every edit whose tag this commit introduces is whole in it: all its files carry the tag.
      for (const e of edits) {
        const introduced = e.files.some((f) => now.get(f)!.includes(`'${e.tag}'`) && !was.get(f)!.includes(`'${e.tag}'`));
        if (!introduced) continue;
        for (const f of e.files) assert.ok(now.get(f)!.includes(`'${e.tag}'`), `${c}: ${e.tag} without ${f} (a strict subset of a group capture)`);
      }
      parent = c;
    }
  });
});

// assertP (an ESM import of publish.ts) cannot be observed from a test without a seam; its place before OUT is covered by
// publish.mask.test.ts ("an assertP failure drops the code part and keeps board-only ops": no live commit, no OUT pushed).
test('Algorithm P order: groups() then the gate over the ready groups, composeP, the dependency PIN, and (recomposed) groups(), the gate, composeP, the compose event, OUT and T0; the gate gets the rebased R, never S_disk', T10, async () => {
  const order: string[] = [];
  const gateR: Array<{ paths: string[]; csIds: string[]; R: Map<string, Oid> }> = [];
  const gate: PublishGatePort = {
    gate: async (_repo, _tip, _A, R, paths, csIds) => {
      order.push('gate');
      gateR.push({ paths: [...paths], csIds: [...csIds], R: new Map([...R].map(([k, e]) => [k, e.oid])) });
      return { block: null };
    },
    claimStillBlocks: async () => true,
  };
  const t0: T0RegionsPort = { check: async () => { order.push('t0'); return { pass: true }; } };
  const files = { 'README.md': buf('# order\n'), 'settings.ini': buf('[core]\nk = 1\n'), 'worker.py': buf(py('worker')), 'notes.md': buf(NOTES) };
  await withCores('pg-order', { n: 1, files, ports: { gate, t0Regions: t0 } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    // G2: seat A appends at the end of notes.md and stops: captured; its next CS edits row l3 (S_disk differs from R); the
    // teammate's heading change applies cleanly and HLD-41 rebases the pair.
    await seatWrite(p, SA, { 'notes.md': `${NOTES}appended\n` });
    queueSignal(core, { kind: 'stop', seat: SA });
    await capture(p);
    const notes = { pair: core.view!.ready.find((x) => x.csId === `${SA}/1`)! };
    // A different size: two writeWork calls at the same virtual instant differ by 1 µs of mtime, which Windows' utimes
    // rounding often collapses, so a same-size rewrite could look unchanged to the stat cache.
    await seatWrite(p, SA, { 'notes.md': `${NOTES.replace('l3', 'L3 seat')}appended\n` });
    await fx.pushTeamChange({ 'notes.md': buf(NOTES.replace('# Notes', '# Team notes')) });
    fx.advance(10_000);
    assert.deepEqual((await applyStep(core, await prep(p))).written, ['notes.md']);
    const rebased = core.view!.ready.find((x) => x.csId === notes.pair.csId)!;
    const rebasedR = (await core.repo.readTreeMap(rebased.R)).get('notes.md')!.oid;
    assert.notEqual(rebasedR, (await core.repo.readTreeMap(notes.pair.R)).get('notes.md')!.oid, 'the pair was rebased');
    // G1: settings.ini under an eol-bom record and worker.py.
    const g1 = await editAndCapture(fx, p, { 'settings.ini': '[core]\nk = 2\n', 'worker.py': py('worker', ' # k') });
    await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['settings.ini'], guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'settings.ini': g1.it.A.get('settings.ini')!.oid }, h1: { 'settings.ini': g1.it.mat!.sDiskMap.get('settings.ini')!.oid } },
    });
    // Spies on groups() (outside composeP, which reads it itself), composeP (with the groups it composed over) and hold() (the
    // dependency PIN); compose and merge come from the trace.
    const cs = core.cs;
    let inComposeP = false;
    const groups = cs.groups.bind(cs);
    cs.groups = (pins) => {
      if (!inComposeP) order.push('groups');
      return groups(pins);
    };
    const composed: Array<Array<{ csIds: string[]; pins: number; ready: boolean }>> = [];
    const composeP = cs.composeP.bind(cs);
    cs.composeP = async (...a: Parameters<typeof composeP>) => {
      order.push('composeP');
      inComposeP = true;
      try {
        const c = await composeP(...a);
        composed.push(c.groups.map((g) => ({ csIds: [...g.csIds], pins: g.pins.length, ready: g.ready })));
        return c;
      } finally {
        inComposeP = false;
      }
    };
    const hold = core.holds.hold.bind(core.holds);
    core.holds.hold = async (n) => {
      if (n.guard?.startsWith('dependency:') === true) order.push('dependency');
      return hold(n);
    };
    const trace = core.deps.trace;
    const emit = trace.emit.bind(trace);
    trace.emit = (e: TraceEvent): void => {
      if (e.kind === 'compose' || e.kind === 'merge') order.push(e.kind);
      emit(e);
    };
    try {
      fx.advance(6_000);
      const it = await prep(p);
      const S = (await core.snapshot.materialize(tickInputOf(core, it))).sDiskMap;
      order.length = 0;   // publishStep's own calls only (prep's governor predicate reads groups() too)
      const r = await publishStep(core, it);
      assert.equal(r.outcome, 'landed', JSON.stringify(r));
      assert.equal(r.dependencyPins.length, 1);
      // The first two groups() are publishStep's predicates before the window (the throttle hand-over's pendingCheap and
      // composeDue: a ready group exists); then each round of Algorithm P reads groups() before its gate.
      assert.deepEqual(order, ['groups', 'groups', 'groups', 'gate', 'gate', 'composeP', 'dependency', 'groups', 'gate', 'composeP', 'compose', 'merge', 't0'],
        'groups() and the gate over every ready group, composeP, the dependency PIN, then (recomposed) groups(), the gate over the ready group left, composeP, the compose event, OUT (merge), T0');
      // Round 1 gated and composed both ready groups; round 2 read G1 held by the dependency PIN (not ready) and gated only G2.
      const g1Ids = [g1.pair.csId];
      const g2Ids = [`${SA}/1`, `${SA}/2`];   // A's second CS (open, editing notes.md) shares the group; A/1's passing capture keeps it ready (U11)
      assert.deepEqual(gateR.map((g) => g.csIds).sort(), [g1Ids, g2Ids, g2Ids].sort());
      assert.deepEqual(gateR.slice(0, 2).map((g) => g.csIds).sort(), [g1Ids, g2Ids].sort(), 'round 1: the gate saw both ready groups');
      assert.deepEqual(gateR[2]!.csIds, g2Ids, 'round 2: only the group left ready');
      const byKey = (gs: Array<{ csIds: string[]; pins: number; ready: boolean }>, ids: string[]): unknown => gs.find((g) => g.csIds.join() === ids.join());
      assert.equal(composed.length, 2);
      assert.deepEqual([byKey(composed[0]!, g1Ids), byKey(composed[0]!, g2Ids)], [{ csIds: g1Ids, pins: 0, ready: true }, { csIds: g2Ids, pins: 0, ready: true }]);
      assert.deepEqual([byKey(composed[1]!, g1Ids), byKey(composed[1]!, g2Ids)], [{ csIds: g1Ids, pins: 1, ready: false }, { csIds: g2Ids, pins: 0, ready: true }]);
      // The gate saw the rebased R of notes.md, never S_disk.
      const seen = gateR.find((g) => g.paths.includes('notes.md'))!;
      assert.equal(seen.R.get('notes.md'), rebasedR);
      assert.notEqual(seen.R.get('notes.md'), S.get('notes.md')?.oid, 'never S_disk');
    } finally {
      Reflect.deleteProperty(cs, 'groups');
      Reflect.deleteProperty(cs, 'composeP');
      core.holds.hold = hold;
      trace.emit = emit;
    }
  });
});

test('publishStep emits one compose trace event per built P tree, CAS re-merges and K7/drop/dependency recompositions included, naming the pairs, groups and withheldWhole that composeP used', T10, async () => {
  const files = { 'README.md': buf('# compose\n'), 'settings.ini': buf('[core]\nk = 1\n'), 'worker.py': buf(py('worker')), 'x.py': buf(py('x')), 'y.py': buf(py('y')) };
  await withCores('pg-compose', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const g1 = await editAndCapture(fx, p, { 'settings.ini': '[core]\nk = 2\n', 'worker.py': py('worker', ' # k') });
    const eol = await core.holds.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: ['settings.ini'], guard: 'eol-bom', origin: 'daemon', cs_ids: [], displaced_by: null,
      blobs: { h0: { 'settings.ini': g1.it.A.get('settings.ini')!.oid }, h1: { 'settings.ini': g1.it.mat!.sDiskMap.get('settings.ini')!.oid } },
    });
    fx.advance(1_000);
    const g2 = await editAndCapture(fx, p, { 'x.py': py('x', ' # x') });
    const mark = fx.trace.events.length;
    // Window 1: the dependency PIN, the recomposition (one event), and a push that loses its lease.
    let raced = false;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        await fx.pushTeamChange({ 'y.py': buf(py('y', ' # team')) });
      }
      return inner(args, opts);
    });
    let r1: PublishReport;
    try {
      r1 = await publish(fx, p);
    } finally {
      restore();
    }
    assert.equal(r1.outcome, 'lease_lost', JSON.stringify(r1));
    const r2 = await publish(fx, p);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    const events = fx.trace.since(mark).filter((e) => e.peer === core.peerId);
    const composes = events.filter((e): e is Extract<TraceEvent, { kind: 'compose' }> => e.kind === 'compose');
    const publishes = events.filter((e): e is Extract<TraceEvent, { kind: 'publish' }> => e.kind === 'publish');
    assert.equal(composes.length, 2, 'two compose events before the landed push');
    assert.equal(publishes.length, 2);
    const pin = r1.dependencyPins[0]!;
    assert.ok(pin !== undefined);
    for (const [k, e] of composes.entries()) {
      const pub = publishes[k]!;
      assert.equal(e.pTree, pub.pTree, 'pTree is the tree of the composed P');
      assert.equal(e.aTree, pub.aTree);
      assert.equal(e.tip, pub.tip);
      assert.ok(events.indexOf(e) < events.indexOf(pub), 'before ENG-41 and the push');
      assert.equal(e.registry !== null && e.registry.length === 40, true, 'the registry head');
      assert.deepEqual(e.pairs.map((x) => x.csId).sort(), [g1.pair.csId, g2.pair.csId].sort(), 'every journaled ready pair');
      const p1 = e.pairs.find((x) => x.csId === g1.pair.csId)!;
      assert.deepEqual([p1.R, p1.A, p1.order, p1.paths], [g1.pair.R, g1.pair.A, g1.pair.order, g1.pair.paths]);
      const held = e.groups.find((g) => g.csIds.includes(g1.pair.csId))!;
      assert.deepEqual([held.pins, held.ready], [[pin], false]);
      const free = e.groups.find((g) => g.csIds.includes(g2.pair.csId))!;
      assert.deepEqual([free.pins, free.ready], [[], true]);
      assert.deepEqual(e.withheldWhole, [{ key: held.key, paths: ['settings.ini'] }]);
    }
    assert.equal(composes[0]!.registry, composes[1]!.registry, 'no registry commit between the two windows');
    assert.notEqual(composes[0]!.tip, composes[1]!.tip, 'the CAS re-merge on the new tip');
    void eol;
    // A window that composes nothing emits none.
    const before = fx.trace.ofKind('compose').length;
    const r3 = await publish(fx, p);
    assert.notEqual(r3.c !== null, true);
    assert.equal(fx.trace.ofKind('compose').length, before, 'no compose event when nothing is composed');
  });
});

test('the throttle event\'s otherPending counts only ready, unheld groups', T10, async () => {
  const files = { 'README.md': buf('# throttle\n'), 'a.py': buf(py('a')), 'b.py': buf(py('b')), 'f.py': buf(py('f')), 'j.py': buf(py('j')) };
  await withCores('pg-throttle', { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    const seen: boolean[] = [];
    const onSignal = core.governor.onSignal.bind(core.governor);
    core.governor.onSignal = (s, fromPush, otherPending) => {
      seen.push(otherPending);
      return onSignal(s, fromPush, otherPending);
    };
    const signalNow = async (): Promise<boolean> => {
      const it = await prep(p);
      seen.length = 0;
      handOverThrottle(core, { ...it.fetched!, deferred: false, httpThrottle: 'http_429' }, it.pushStates);
      assert.equal(seen.length, 1);
      return seen[0]!;
    };
    // One group held by a join PIN.
    const j = await editAndCapture(fx, p, { 'j.py': py('j', ' # local') });
    const h1: BlobMap = {};
    setBlob(h1, 'j.py', j.it.mat!.sDiskMap.get('j.py')!.oid);
    await core.holds.hold(pinCs('join', [j.pair.csId], ['j.py'], j.it.A, h1, 'human', 'none'));
    // One not-ready open group: A open and uncovered, B closed, sharing f.py.
    await seatWrite(p, SA, { 'f.py': py('f', ' # A') });
    await seatWrite(p, SB, { 'f.py': py('f', ' # A and B'), 'b.py': py('b', ' # B') });
    queueSignal(core, { kind: 'stop', seat: SB });
    await capture(p);
    assert.equal(await signalNow(), false, 'no other pending code');
    // One ready, unheld group.
    await editAndCapture(fx, p, { 'a.py': py('a', ' # ready') });
    assert.equal(await signalNow(), true);
  });
});

test('under openGate no record with a claim guard is created in a 3-peer human run', T10, async () => {
  const files: Record<string, Buffer> = { 'README.md': buf('# open gate\n'), 'shared.py': buf(py('shared')) };
  for (let i = 0; i < 3; i++) files[`p${i}.py`] = buf(py(`p${i}`));
  await withCores('pg-opengate', { n: 3, files }, async (fx) => {
    const tip0 = await remoteLiveCode(fx, fx.peers[0]!);
    for (let round = 0; round < 3; round++) {
      for (const [i, p] of fx.peers.entries()) {
        await writeWork(p, `p${i}.py`, py(`p${i}`, ` # round ${round}`));
        await prep(p);
      }
      fx.advance(20_000);
      for (const p of fx.peers) {
        await captureStep(p.core, await prep(p, true));
        await publish(fx, p);
      }
      for (const p of fx.peers) {
        fx.advance(10_000);
        await applyStep(p.core, await prep(p));
        await publish(fx, p);
      }
    }
    for (const p of fx.peers) {
      assert.equal(p.core.holds.all().some((r) => r.guards.some((g) => g.name.startsWith('claim'))), false, `${p.name}: no claim record`);
    }
    assert.ok((await liveSince(fx, tip0, await remoteLiveCode(fx, fx.peers[0]!))).length >= 3, 'the run published');
  });
});

