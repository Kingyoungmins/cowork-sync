// The T0 slot of Algorithm P (Plan 3 Task 10; 05-holds HLD-50, HLD-52, HLD-67's open-CS exception, §8 Q15, U11, TC-HLD-11 (d);
// 01-engine ENG-39, ENG-40; rulings R3-04, R3-63; rev 2.5: X-06, X-07, D1): scripted T0RegionsPorts and a seat AttributionPort whose
// shrinkAttributed answers false. A closing capture failing T0 becomes one K7 PIN `t0`; an open CS's edit-checkpoint capture is dropped
// instead (last_check{kind: 'stale'}); an incomplete verdict holds the group back for the window; the t0 PREDICATE is evaluated on a
// trial OUT each window. Real clones; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsTrailers } from '../../src/board/boardCommit.js';
import type { IterationCtx } from '../../src/engine/core.js';
import { captureStep, queueSignal } from '../../src/engine/csStep.js';
import { humanOnlyAttribution, type AttributionPort } from '../../src/engine/deps.js';
import { publishStep, type PublishReport } from '../../src/engine/publish.js';
import type { Oid } from '../../src/git/oid.js';
import type { EditCheckPort, EditCheckVerdict, T0RegionsPort, T0Verdict } from '../../src/holds/ports.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import type { CsSignal } from '../../src/holds/signals.js';
import { writeWork, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { blobText, buf, editAndCapture, lines, LogRecorder, prep, remoteLiveCode, stateA, treeOf, withCores, wrapGit } from '../helpers/publishHelpers.js';
import { join } from 'node:path';

const T10 = { timeout: 10 * 60_000 };
const SA = 'a'.repeat(32);
const SB = 'b'.repeat(32);
const A1 = `${SA}/1`;
const BIG = lines(40, (i) => `row ${i} of a file large enough to shrink`);
const SHRUNK = lines(14, (i) => `row ${i} of a file large enough to shrink`);   // 35 % of BIG: a 65 % cut
const py = (name: string, tag = ''): string => lines(12, (i) => `${name}_${i} = ${i}${i === 4 ? tag : ''}`);
const FILES: Record<string, Buffer> = {
  'README.md': buf('# t0 fixture\n'),
  'big.txt': buf(BIG), 'big2.txt': buf(BIG), 'a.py': buf(py('a')), 'b.py': buf(py('b')), 'x.py': buf(py('x')), 'y.py': buf(py('y')),
};

/** A seat's shrink is not attributed (no hook window says so before Plan 5): HLD-50 item 3 applies to it. */
const SEAT_ATTRIBUTION: AttributionPort = { ...humanOnlyAttribution, shrinkAttributed: () => false };

let tool = 0;
function effect(seat: string, paths: readonly string[]): CsSignal {
  return { kind: 'effect', seat, agent: null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: 'prompt' };
}

/**
 * A seat writes `files` in one effect; two detection ticks ≥ 1 s apart (a > 50 % shrink is read from its second stable tick, R-25),
 * each observing the paths as the seat's (the hook's attribution is per tick in Plan 5; here the effect is repeated).
 */
async function seatWrite(fx: CoreFixture, p: PeerFixture, seat: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) await writeWork(p, path, text);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  await prep(p);
  fx.advance(1_500);
  queueSignal(p.core, effect(seat, Object.keys(files)));
  await prep(p);
}

async function capture(p: PeerFixture): Promise<{ it: IterationCtx; captured: string[]; verdicts: string[] }> {
  const it = await prep(p, true);
  const r = await captureStep(p.core, it);
  return { it, captured: r.captured, verdicts: r.candidates.map((c) => `${c.csId}:${c.verdict}`) };
}

async function publish(fx: CoreFixture, p: PeerFixture): Promise<PublishReport> {
  fx.advance(6_000);
  return publishStep(p.core, await prep(p));
}

/**
 * A T0RegionsPort answering queued verdicts, else `decide(paths)`, else pass, and recording every call's OUT and paths (a T0 trial's
 * calls included).
 */
function regions(decide: (paths: readonly string[]) => T0Verdict | undefined = () => undefined): { port: T0RegionsPort; calls: Array<{ out: Oid; paths: string[] }>; queue: T0Verdict[] } {
  const calls: Array<{ out: Oid; paths: string[] }> = [];
  const queue: T0Verdict[] = [];
  return {
    calls, queue,
    port: {
      check: async (_r, _tip, out, paths) => {
        calls.push({ out, paths: [...paths] });
        return queue.shift() ?? decide(paths) ?? { pass: true };
      },
    },
  };
}

/** An EditCheckPort that passes everything (the edit check is not what these tests exercise). */
const PASS: EditCheckPort = { check: async (): Promise<EditCheckVerdict> => ({ verdict: 'pass' }) };

const t0Pins = (p: PeerFixture): HoldRecord[] => p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN' && r.guards.some((g) => g.name === 't0'));

async function changedIn(p: PeerFixture, c: Oid): Promise<string[]> {
  const C = await p.core.repo.readCommit(c);
  return (await p.core.repo.run(['diff-tree', '--no-commit-id', '--name-only', '-r', C.parents[0]!, c])).stdout.toString('utf8').trim().split('\n').filter((l) => l.length > 0).sort();
}

test('a closing seat CS whose OUT shrinks p by 60 % without attribution becomes one K7 PIN guard t0 over its group\'s LIVE paths, while another ready group publishes in the same push', T10, async () => {
  await withCores('t0-k7', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    p.deps.attribution = SEAT_ATTRIBUTION;
    await seatWrite(fx, p, SA, { 'big.txt': SHRUNK, 'a.py': py('a', ' # A') });
    await seatWrite(fx, p, SB, { 'x.py': py('x', ' # B') });
    queueSignal(p.core, { kind: 'stop', seat: SA });
    queueSignal(p.core, { kind: 'stop', seat: SB });
    assert.equal((await capture(p)).captured.length, 2);
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    const pins = t0Pins(p);
    assert.equal(pins.length, 1);
    assert.deepEqual(r.k7, [pins[0]!.id]);
    assert.deepEqual(pins[0]!.paths, ['a.py', 'big.txt'], 'the group\'s LIVE paths');
    assert.deepEqual(pins[0]!.cs_ids, [A1]);
    assert.deepEqual(pins[0]!.guards.map((g) => g.name), ['t0']);
    assert.deepEqual(await changedIn(p, r.c!), ['x.py'], 'the other group publishes; composition restarted without the failing one');
    assert.ok(p.core.view!.ready.some((x) => x.csId === A1), 'the held group keeps its pair');
  });
});

test('the same failure on an open CS\'s edit-checkpoint capture drops the capture with no PIN and no message and recomposes without it', T10, async () => {
  await withCores('t0-drop', { n: 1, files: FILES, ports: { editCheck: PASS } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    p.deps.attribution = SEAT_ATTRIBUTION;
    const log = new LogRecorder();
    p.deps.log = log;
    await seatWrite(fx, p, SA, { 'big.txt': SHRUNK });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['big.txt'] });
    assert.deepEqual((await capture(p)).verdicts, [`${A1}:pass`]);
    assert.deepEqual(core.cs.lastCheck.pass(A1), { ready: 1, shared: null });
    const head = core.holds.head();
    const tip = await remoteLiveCode(fx, p);
    const r = await publish(fx, p);
    assert.deepEqual(r.dropped, [A1]);
    assert.deepEqual(r.k7, []);
    assert.equal(r.c, null);
    assert.equal(t0Pins(p).length, 0, 'no PIN');
    assert.equal(core.holds.head(), head, 'no record');
    assert.deepEqual(core.view!.ready, [], 'the capture left the journal');
    assert.equal(await remoteLiveCode(fx, p), tip);
    assert.deepEqual(log.lines, [], 'no message');
    // rev 2.5 (X-06, X-07, D1): last_check{kind: 'stale'} from T0's item-3 finding; last_pass.ready cleared; nothing else written.
    assert.deepEqual(core.cs.lastCheck.get(A1), { edit_n: 1, kind: 'stale', check: 4, path: 'big.txt', more: 0 });
    assert.deepEqual(core.cs.lastCheck.pass(A1), { ready: null, shared: null });
  });
});

test('rev 2.5: a T0RegionsPort item 1 or 2 failure on an open CS\'s capture records stale from its first finding, and a fail form without findings records stale with no check, path or line', T10, async () => {
  const t0 = regions();
  await withCores('t0-stale-findings', { n: 1, files: FILES, ports: { editCheck: PASS, t0Regions: t0.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(fx, p, SA, { 'a.py': py('a', ' # one') });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['a.py'] });
    await capture(p);
    t0.queue.push({ pass: false, paths: ['a.py'], item: 2, findings: [{ check: 2, path: 'a.py', line: 9, reason: 'incompatible_caller' }] });
    assert.deepEqual((await publish(fx, p)).dropped, [A1]);
    assert.deepEqual(core.cs.lastCheck.get(A1), { edit_n: 1, kind: 'stale', check: 2, path: 'a.py', line: 9, more: 0 });
    await seatWrite(fx, p, SA, { 'a.py': py('a', ' # two') });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 2, paths: ['a.py'] });
    await capture(p);
    t0.queue.push({ pass: false, paths: ['a.py'], item: 1 });
    assert.deepEqual((await publish(fx, p)).dropped, [A1]);
    assert.deepEqual(core.cs.lastCheck.get(A1), { edit_n: 2, kind: 'stale', more: 0 });
  });
});

test('05 U11 last clause: the same shrink at the CS\'s stop makes the K7 PIN', T10, async () => {
  await withCores('t0-u11', { n: 1, files: FILES, ports: { editCheck: PASS } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    p.deps.attribution = SEAT_ATTRIBUTION;
    await seatWrite(fx, p, SA, { 'big.txt': SHRUNK });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['big.txt'] });
    await capture(p);
    assert.deepEqual((await publish(fx, p)).dropped, [A1], 'mid-turn: dropped');
    queueSignal(core, { kind: 'stop', seat: SA });
    assert.deepEqual((await capture(p)).captured, [A1]);
    const r = await publish(fx, p);
    assert.deepEqual(r.dropped, []);
    assert.equal(r.k7.length, 1, 'at the stop: K7');
    assert.deepEqual(t0Pins(p).map((x) => x.id), r.k7);
  });
});

test('a T0RegionsPort item 1 or 2 failure is K7 like item 3, and an incomplete verdict publishes nothing of that group, creates no record and re-runs in the next window', T10, async () => {
  // a.py's group always fails item 1 (its t0 trial too); x.py's group is incomplete once, then passes.
  let xCalls = 0;
  const t0 = regions((paths) => {
    if (paths.includes('a.py')) return { pass: false, paths: ['a.py'], item: 1 };
    if (paths.includes('x.py')) return xCalls++ === 0 ? { incomplete: true } : undefined;
    return undefined;
  });
  await withCores('t0-items', { n: 1, files: FILES, ports: { t0Regions: t0.port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await seatWrite(fx, p, SA, { 'a.py': py('a', ' # A') });
    queueSignal(core, { kind: 'stop', seat: SA });
    await capture(p);
    const r1 = await publish(fx, p);
    assert.equal(r1.k7.length, 1, 'item 1 is K7');
    assert.deepEqual(t0Pins(p)[0]!.paths, ['a.py']);
    // An incomplete verdict: nothing of the group, no record, and T0 runs again next window.
    await seatWrite(fx, p, SB, { 'x.py': py('x', ' # B') });
    queueSignal(core, { kind: 'stop', seat: SB });
    await capture(p);
    const records = core.holds.all().length;
    const tip = await remoteLiveCode(fx, p);
    const r2 = await publish(fx, p);
    assert.equal(xCalls, 1, 'the incomplete verdict');
    assert.equal(r2.c, null, 'nothing of the group publishes');
    assert.deepEqual([r2.k7, r2.dropped], [[], []]);
    assert.equal(core.holds.all().length, records, 'no record');
    assert.equal(await remoteLiveCode(fx, p), tip);
    const r3 = await publish(fx, p);
    assert.equal(xCalls, 2, 'T0 re-ran in the next window');
    assert.equal(r3.outcome, 'landed', `T0 re-ran and passed: ${JSON.stringify(r3)}`);
    assert.deepEqual(await changedIn(p, r3.c!), ['x.py']);
  });
});

test('the t0 guard releases when T0 passes on a fresh OUT, and the group publishes in that window in one commit', T10, async () => {
  await withCores('t0-release', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    p.deps.attribution = SEAT_ATTRIBUTION;
    await seatWrite(fx, p, SA, { 'big.txt': SHRUNK, 'a.py': py('a', ' # with the cut') });
    queueSignal(core, { kind: 'stop', seat: SA });
    await capture(p);
    const r1 = await publish(fx, p);
    const pinId = r1.k7[0]!;
    assert.ok(pinId !== undefined);
    // While T0 still fails, each window's trial composition emits no compose event and the PIN stays.
    const composeBefore = fx.trace.ofKind('compose').length;
    const r2 = await publish(fx, p);
    assert.equal(r2.c, null, 'no code (the PIN op may leave board-only)');
    assert.equal(fx.trace.ofKind('compose').length, composeBefore, 'a T0 trial composition emits no compose event');
    assert.deepEqual(core.holds.get(pinId)!.guards.map((g) => g.name), ['t0']);
    // The shrink becomes attributed (a hook window says so): T0 passes on the fresh OUT, the release is a registry commit, and the
    // recomposition emits the one compose event that precedes Bnew.
    p.deps.attribution = humanOnlyAttribution;
    const head = core.holds.head();
    const mark = fx.trace.events.length;
    const r3 = await publish(fx, p);
    assert.equal(r3.outcome, 'landed', JSON.stringify(r3));
    assert.notEqual(core.holds.head(), head, 'the release is a registry commit');
    assert.deepEqual(core.holds.get(pinId)!.guards, []);
    const events = fx.trace.since(mark);
    const composes = events.filter((e) => e.kind === 'compose');
    assert.equal(composes.length, 1);
    const g = (composes[0] as Extract<typeof composes[number], { kind: 'compose' }>).groups.find((x) => x.csIds.includes(A1))!;
    assert.deepEqual([g.ready, g.pins], [true, []], 'no t0 PIN in the groups of the event that precedes Bnew');
    assert.ok(events.findIndex((e) => e.kind === 'compose') < events.findIndex((e) => e.kind === 'publish'));
    assert.deepEqual(await changedIn(p, r3.c!), ['a.py', 'big.txt'], 'one commit');
  });
});

test('after a CAS loss the next attempt recomputes groups, the gate and T0 from scratch: the T0RegionsPort sees the new OUT', T10, async () => {
  const t0 = regions();
  await withCores('t0-cas', { n: 1, files: FILES, ports: { t0Regions: t0.port } }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'a.py': py('a', ' # mine') });
    let raced = false;
    const restore = wrapGit(p, async (args, opts, inner) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        await fx.pushTeamChange({ 'y.py': buf(py('y', ' # team')) });
      }
      return inner(args, opts);
    });
    try {
      const r1 = await publish(fx, p);
      assert.equal(r1.outcome, 'lease_lost', JSON.stringify(r1));
    } finally {
      restore();
    }
    const r2 = await publish(fx, p);
    assert.equal(r2.outcome, 'landed', JSON.stringify(r2));
    assert.equal(t0.calls.length, 2);
    assert.notEqual(t0.calls[1]!.out, t0.calls[0]!.out, 'T0 saw the OUT merged on the new tip');
    const out2 = await p.core.repo.readTreeMap(t0.calls[1]!.out);
    assert.equal(await blobText(p, out2, 'y.py'), py('y', ' # team'));
  });
});

test('A_cap ≠ A at composition throws ReadyBaseMismatchError and publishes nothing', T10, async () => {
  await withCores('t0-acap', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await editAndCapture(fx, p, { 'x.py': py('x', ' # mine') });
    const moved = await p.core.repo.hashBytes(buf(py('x', ' # moved under the pair')), true);
    assert.notEqual(moved, (await stateA(p)).get('x.py')?.oid);
    const base = await p.core.repo.editTree(p.core.view!.base, [{ path: 'x.py', mode: '100644', oid: moved }], join(p.deps.paths.coworkDir, 'tmp', 'acap.index'));
    await p.core.commit({ base });
    const tip = await remoteLiveCode(fx, p);
    const r = await publish(fx, p);
    assert.deepEqual([r.outcome, r.why, r.assert], ['aborted', 'ready_base_mismatch', { check: 'a_cap', path: 'x.py' }]);
    assert.equal(await remoteLiveCode(fx, p), tip, 'nothing published');
  });
});

test('TC-HLD-11 (d): a turn ending with the last edit still failing and T0 failing makes a K7 PIN, while the last passing capture, already published, stays published', T10, async () => {
  const checks: EditCheckVerdict[] = [];
  const port: EditCheckPort = { check: async () => checks.shift() ?? { verdict: 'pass' } };
  await withCores('t0-tc11d', { n: 1, files: FILES, ports: { editCheck: port } }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    p.deps.attribution = SEAT_ATTRIBUTION;
    await seatWrite(fx, p, SA, { 'a.py': py('a', ' # first half') });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 1, paths: ['a.py'] });
    await capture(p);
    const pub = await publish(fx, p);
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const published = pub.c!;
    // The last edit cuts big2.txt and its check fails; the turn ends: the closing capture fails T0 (an unattributed cut): K7.
    await seatWrite(fx, p, SA, { 'big2.txt': SHRUNK });
    queueSignal(core, { kind: 'checkpoint', seat: SA, source: 'edit', candSeq: 2, paths: ['big2.txt'] });
    checks.push({ verdict: 'fail', failed: [4] });
    await capture(p);
    queueSignal(core, { kind: 'stop', seat: SA });
    await capture(p);
    const r = await publish(fx, p);
    assert.equal(r.k7.length, 1, JSON.stringify(r));
    const pin = core.holds.get(r.k7[0]!)!;
    assert.ok(pin.paths.includes('big2.txt'));
    assert.equal(pin.guards.map((g) => guardName(g))[0], 't0');
    // The earlier passing capture stays published.
    const head = await remoteLiveCode(fx, p);
    const tree = await treeOf(p, head as Oid);
    assert.equal(await blobText(p, tree, 'a.py'), py('a', ' # first half'));
    assert.equal(await blobText(p, tree, 'big2.txt'), BIG);
    assert.deepEqual(parseCsTrailers((await core.repo.readCommit(published)).trailers).cs.map((t) => [t.csId, t.state, t.seq]), [[A1, 'checkpoint', 1]]);
  });
});

test('a human CS shrinking a file by 60 % publishes after two stable snapshots (attributed by R-25)', T10, async () => {
  await withCores('t0-human', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, 'big.txt', SHRUNK);
    await prep(p);
    fx.advance(1_500);
    await prep(p);
    fx.advance(20_000);
    const { captured } = await capture(p);
    assert.equal(captured.length, 1);
    const r = await publish(fx, p);
    assert.equal(r.outcome, 'landed', JSON.stringify(r));
    assert.deepEqual(r.k7, []);
    const tree = await treeOf(p, r.c!);
    assert.equal(await blobText(p, tree, 'big.txt'), SHRUNK);
  });
});
