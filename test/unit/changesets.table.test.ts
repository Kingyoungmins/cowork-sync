// The change-set table (Plan 3 Task 9): seat CSs from scripted signals, the human CS, attribution, the close rules and
// queueSignal's out-of-cycle iterations (05-holds HLD-33…HLD-36; 06-claude §3.12.1; 01-engine ENG-13 (b)/(c); 05 U9;
// rulings R3-05, R3-06). A ChangeSets on a VirtualClock; seat ids are 32 lowercase hex; the signals are scripted (R3-05).
// The captures that give human-class CSs their <peer_id>/human/<n> use a real clone (git is never mocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineCore } from '../../src/engine/core.js';
import { queueSignal } from '../../src/engine/csStep.js';
import type { TreeEntry } from '../../src/git/repo.js';
import { ChangeSets, HUMAN_CS_QUIET_MS, type CsTable, type CsTableEntry } from '../../src/holds/changesets.js';
import { HoldRegistry } from '../../src/holds/registry.js';
import type { CsSignal, SeatActivity } from '../../src/holds/signals.js';
import { validId } from '../../src/sec/validators.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const T10 = { timeout: 10 * 60_000 };
const PEER = '0123456789abcdef0123456789abcdef';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

let tool = 0;
function effect(seat: string, paths: readonly string[], o: { agent?: string | null; turnOrigin?: 'prompt' | 'wake' } = {}): CsSignal {
  return { kind: 'effect', seat, agent: o.agent ?? null, toolUseId: `toolu_${++tool}`, paths, turnOrigin: o.turnOrigin ?? 'prompt' };
}

function entry(t: CsTable, csId: string): CsTableEntry {
  const e = t.cs.find((x) => x.cs_id === csId);
  assert.ok(e !== undefined, `the table has ${csId}: ${JSON.stringify(t.cs.map((x) => x.cs_id))}`);
  return e;
}

function openIds(cs: ChangeSets): string[] {
  return cs.table().cs.filter((e) => e.state === 'open').map((e) => e.cs_id).sort();
}

interface Repo { f: RepoFixture; scratch: string; tm(files: Record<string, string>): Promise<Map<string, TreeEntry>>; }

async function repo(label: string): Promise<Repo> {
  const f = await makeRepoFixture(label);
  const dir = join(f.paths.coworkDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const tm = async (files: Record<string, string>): Promise<Map<string, TreeEntry>> => {
    const m = new Map<string, TreeEntry>();
    for (const [p, t] of Object.entries(files)) m.set(p, { path: p, mode: '100644', oid: await f.repo.hashBytes(Buffer.from(t, 'utf8'), true) });
    return m;
  };
  return { f, scratch: join(dir, 'cs.index'), tm };
}

test('seat cs_ids are <seat_id>/<turn-seq> counted from 1 per seat, including a subagent CS opening after the parent\'s stop; human cs_ids are <peer_id>/human/<n>', T10, async () => {
  const clock = new VirtualClock();
  const cs = new ChangeSets(PEER, clock);
  cs.signal(effect(A, ['a1.py']));
  assert.deepEqual(openIds(cs), [`${A}/1`]);
  cs.signal({ kind: 'stop', seat: A });
  cs.signal(effect(A, ['a2.py']));
  assert.deepEqual(openIds(cs), [`${A}/2`]);
  cs.signal(effect(A, ['a3.py'], { agent: 'x' }));
  assert.deepEqual(openIds(cs), [`${A}/2`], 'a call with an agent while A/2 is open joins A/2');
  assert.deepEqual(entry(cs.table(), `${A}/2`).paths, ['a2.py', 'a3.py']);
  cs.signal({ kind: 'stop', seat: A });
  cs.signal(effect(A, ['a4.py'], { agent: 'x' }));
  assert.deepEqual(openIds(cs), [`${A}/3`], 'after the parent\'s stop the agent\'s call opens its own CS, the next turn-seq');
  cs.signal(effect(B, ['b1.py']));
  assert.deepEqual(openIds(cs), [`${A}/3`, `${B}/1`], 'turn-seq counts per seat');
  const t = cs.table();
  assert.deepEqual(t.seats, { [A]: { turn_seq: 3 }, [B]: { turn_seq: 1 } });
  for (const e of t.cs) assert.ok(validId('cs', e.cs_id), e.cs_id);

  // Human-class CSs get <peer_id>/human/<n> at their first capture, n from the per-peer counter.
  const r = await repo('cs-table-ids');
  try {
    const h = new ChangeSets(PEER, clock);
    h.restore([], 4, null);
    const disk = await r.tm({ 'h1.txt': 'one\n', 'h2.txt': 'two\n' });
    h.observe(['h1.txt']);
    clock.advance(HUMAN_CS_QUIET_MS);
    const c1 = await h.capture(r.f.repo, disk, new Map(), r.scratch, new Set(), []);
    assert.ok(c1 !== null && c1.pair !== null);
    assert.equal(c1.pair.csId, `${PEER}/human/4`);
    assert.equal(c1.nextN, 5);
    h.observe(['h2.txt']);
    clock.advance(HUMAN_CS_QUIET_MS);
    const c2 = await h.capture(r.f.repo, disk, new Map(), r.scratch, new Set(), []);
    assert.ok(c2 !== null && c2.pair !== null);
    assert.equal(c2.pair.csId, `${PEER}/human/5`);
    assert.ok(validId('cs', c1.pair.csId) && validId('cs', c2.pair.csId));
  } finally {
    await r.f.cleanup();
  }
});

test('agent, session and prompt ids are CS-table attributes, never part of the cs_id', T10, () => {
  const cs = new ChangeSets(PEER, new VirtualClock());
  cs.signal(effect(A, ['a1.py']));
  cs.signal({ kind: 'stop', seat: A });
  cs.signal(effect(A, ['a2.py']));
  cs.signal({ kind: 'stop', seat: A });
  cs.signal(effect(A, ['a3.py'], { agent: 'x' }));
  const t = cs.table();
  const e = entry(t, `${A}/3`);
  assert.equal(e.agent, 'x');
  assert.equal(e.seat, A);
  assert.equal(e.kind, 'seat');
  assert.equal(entry(t, `${A}/1`).agent, null);
  for (const x of t.cs) assert.match(x.cs_id, /^[0-9a-f]{32}\/[1-9][0-9]*$/, 'the agent never enters the cs_id');
});

test('a seat CS opens at its first file effect, never at a prompt; it closes at stop, stop_failure, session_end and seat_end; idle_10min closes it only when the activity is IDLE or ENDED and no TXN is open', T10, () => {
  const fresh = new ChangeSets(PEER, new VirtualClock());
  fresh.signal({ kind: 'prompt', seat: A, humanOrigin: true, nonce: false });
  assert.deepEqual(fresh.table().cs, [], 'a prompt opens no CS');
  assert.deepEqual(fresh.counts(), { open: 0, ready: 0 });

  const idle = (activity: SeatActivity, txnOpen: boolean): CsSignal => ({ kind: 'idle_10min', seat: A, activity, txnOpen });
  const rows: Array<[string, CsSignal, boolean]> = [
    ['stop', { kind: 'stop', seat: A }, true],
    ['stop_failure', { kind: 'stop_failure', seat: A }, true],
    ['session_end', { kind: 'session_end', seat: A }, true],
    ['seat_end', { kind: 'seat_end', seat: A }, true],
    ['idle_10min{IDLE}', idle('IDLE', false), true],
    ['idle_10min{ENDED}', idle('ENDED', false), true],
    ['idle_10min{MID_TURN}', idle('MID_TURN', false), false],
    ['idle_10min{AWAITING_PERMISSION}', idle('AWAITING_PERMISSION', false), false],
    ['idle_10min{IDLE, txnOpen: true}', idle('IDLE', true), false],
    ['idle_10min{ENDED, txnOpen: true}', idle('ENDED', true), false],
    ['prompt', { kind: 'prompt', seat: A, humanOrigin: true, nonce: false }, false],
    ['activity', { kind: 'activity', seat: A, activity: 'IDLE' }, false],
    ['checks_run', { kind: 'checks_run', seat: A, ok: true }, false],
    ['another seat\'s stop', { kind: 'stop', seat: B }, false],
  ];
  for (const [name, s, closes] of rows) {
    const cs = new ChangeSets(PEER, new VirtualClock());
    cs.signal(effect(A, ['x.py']));
    assert.equal(cs.closeDue(), false, `${name}: an open seat CS is not due`);
    cs.signal(s);
    const e = entry(cs.table(), `${A}/1`);
    assert.equal(e.state, closes ? 'closed' : 'open', `${name}: closed? ${String(closes)}`);
    assert.equal(cs.closeDue(), closes, `${name}: a close is a capture trigger (HLD-40)`);
  }
});

test('calls with an agent join the parent\'s open CS; after the parent\'s stop they form their own CS that closes only at that agent\'s subagent_stop or seat_end', T10, () => {
  const cs = new ChangeSets(PEER, new VirtualClock());
  cs.signal(effect(A, ['p.py']));
  cs.signal(effect(A, ['q.py'], { agent: 'x' }));
  assert.deepEqual(openIds(cs), [`${A}/1`]);
  assert.deepEqual(entry(cs.table(), `${A}/1`).paths, ['p.py', 'q.py']);
  cs.signal({ kind: 'stop', seat: A });
  assert.equal(entry(cs.table(), `${A}/1`).state, 'closed');
  cs.signal(effect(A, ['r.py'], { agent: 'x' }));
  assert.deepEqual(openIds(cs), [`${A}/2`]);
  assert.equal(entry(cs.table(), `${A}/2`).agent, 'x');
  for (const s of [
    { kind: 'stop', seat: A }, { kind: 'stop_failure', seat: A }, { kind: 'session_end', seat: A },
    { kind: 'idle_10min', seat: A, activity: 'IDLE', txnOpen: false }, { kind: 'subagent_stop', seat: A, agent: 'y' },
    { kind: 'subagent_stop', seat: B, agent: 'x' },
  ] as CsSignal[]) {
    cs.signal(s);
    assert.equal(entry(cs.table(), `${A}/2`).state, 'open', `${s.kind}: the agent's own CS stays open`);
  }
  cs.signal(effect(A, ['r2.py'], { agent: 'x' }));
  assert.deepEqual(entry(cs.table(), `${A}/2`).paths, ['r.py', 'r2.py'], 'the agent\'s later calls extend its own CS');
  cs.signal({ kind: 'subagent_stop', seat: A, agent: 'x' });
  assert.equal(entry(cs.table(), `${A}/2`).state, 'closed', 'that agent\'s subagent_stop closes it');
  cs.signal(effect(A, ['s.py'], { agent: 'z' }));
  assert.deepEqual(openIds(cs), [`${A}/3`]);
  cs.signal({ kind: 'seat_end', seat: A });
  assert.equal(entry(cs.table(), `${A}/3`).state, 'closed', 'seat_end closes it');
});

test('all paths of one effect signal enter the same CS (never split below one tool_use)', T10, () => {
  const cs = new ChangeSets(PEER, new VirtualClock());
  cs.signal(effect(A, ['a.py', 'b.py']));
  cs.signal({ kind: 'stop', seat: A });
  // One tool_use naming a path of the closed A/1 and new paths: every path enters the one new CS.
  cs.signal(effect(A, ['b.py', 'c.py', 'd/e.py']));
  const t = cs.table();
  assert.deepEqual(entry(t, `${A}/1`).paths, ['a.py', 'b.py']);
  assert.deepEqual(entry(t, `${A}/2`).paths, ['b.py', 'c.py', 'd/e.py']);
  assert.equal(t.cs.length, 2);
});

test('05 U9: a nonce prompt mid-turn leaves the open CS, its cs_id and its origin unchanged and fires no offer event; at an idle seat the next effect with turnOrigin wake opens a new CS with origin wake; a prompt without a nonce changes no CS', T10, () => {
  const offers: unknown[] = [];
  const proto = HoldRegistry.prototype as unknown as { offerEvent: (...args: unknown[]) => unknown };
  const orig = proto.offerEvent;
  proto.offerEvent = function spy(...args: unknown[]): unknown {
    offers.push(args);
    return orig.apply(this, args);
  };
  try {
    const cs = new ChangeSets(PEER, new VirtualClock());
    cs.signal(effect(A, ['a.py'], { turnOrigin: 'prompt' }));
    const before = cs.table();
    cs.signal({ kind: 'prompt', seat: A, humanOrigin: false, nonce: true });
    assert.deepEqual(cs.table(), before, 'the doorbell mid-turn changes nothing');
    cs.signal(effect(A, ['b.py'], { turnOrigin: 'wake' }));
    const mid = entry(cs.table(), `${A}/1`);
    assert.equal(mid.state, 'open');
    assert.equal(mid.origin, 'prompt', 'the turn keeps its origin');
    assert.deepEqual(openIds(cs), [`${A}/1`]);
    cs.signal({ kind: 'stop', seat: A });
    cs.signal({ kind: 'prompt', seat: A, humanOrigin: false, nonce: true });
    assert.deepEqual(openIds(cs), [], 'a doorbell at an idle seat opens nothing: the CS opens lazily');
    cs.signal(effect(A, ['c.py'], { turnOrigin: 'wake' }));
    assert.equal(entry(cs.table(), `${A}/2`).origin, 'wake');
    const t = cs.table();
    cs.signal({ kind: 'prompt', seat: A, humanOrigin: true, nonce: false });
    assert.deepEqual(cs.table(), t, 'a prompt without a nonce changes no CS');
    assert.deepEqual(offers, [], 'no offer event (R3-06)');
  } finally {
    proto.offerEvent = orig;
  }
});

test('unattributed deltas form the human CS, which closes 20 s Δmono after its last change or at done(); paths an effect claimed since the previous observe stay with the seat CS', T10, async () => {
  const r = await repo('cs-table-human');
  try {
    const clock = new VirtualClock();
    const cs = new ChangeSets(PEER, clock);
    cs.restore([], 1, null);
    const disk = await r.tm({ 's.py': 'seat\n', 'h.py': 'human\n', 'g.py': 'later\n' });
    cs.signal(effect(A, ['s.py']));
    cs.observe(['s.py', 'h.py']);
    assert.deepEqual(cs.counts(), { open: 2, ready: 0 }, 'the seat CS and the human CS');
    clock.advance(HUMAN_CS_QUIET_MS - 1);
    assert.equal(cs.closeDue(), false);
    cs.observe(['h.py']);
    clock.advance(HUMAN_CS_QUIET_MS - 1);
    assert.equal(cs.closeDue(), false, 'a change restarts the 20 s');
    clock.advance(1);
    assert.equal(cs.closeDue(), true, '20 s Δmono after its last change');
    const cap = await cs.capture(r.f.repo, disk, new Map(), r.scratch, new Set(), []);
    assert.ok(cap !== null);
    const human = cap.pairs.find((p) => p.csId.startsWith(`${PEER}/human/`));
    assert.ok(human !== undefined);
    assert.deepEqual(human.paths, ['h.py'], 's.py was claimed by the effect: it stays with the seat CS');
    assert.equal(entry(cs.table(), `${A}/1`).state, 'open');
    assert.deepEqual(entry(cs.table(), `${A}/1`).paths, ['s.py']);

    // The claim lasts for one observe: a later unclaimed change of s.py is unattributed.
    cs.observe(['g.py']);
    cs.observe(['s.py']);
    cs.done();
    assert.equal(cs.closeDue(), true, 'done() closes it at once');
    const cap2 = await cs.capture(r.f.repo, disk, new Map(), r.scratch, new Set(), []);
    assert.ok(cap2 !== null);
    const human2 = cap2.pairs.find((p) => p.csId === `${PEER}/human/2`);
    assert.ok(human2 !== undefined);
    assert.deepEqual(human2.paths, ['g.py', 's.py']);
  } finally {
    await r.f.cleanup();
  }
});

test('a checkpoint{source: edit} names only seat CSs: the human CS and a recovered CS never get a pending candidate', T10, async () => {
  const clock = new VirtualClock();
  const cs = new ChangeSets(PEER, clock);
  cs.restore([], 1, null);
  cs.observe(['h.py']);
  cs.signal({ kind: 'checkpoint', seat: A, source: 'edit', candSeq: 1, paths: ['h.py'] });
  assert.deepEqual(cs.pendingCandidates(), [], 'no seat CS is open: the human CS gets nothing');
  assert.equal(cs.closeDue(), false, 'an edit checkpoint is no close');
  cs.signal(effect(A, ['s.py']));
  cs.signal({ kind: 'checkpoint', seat: A, source: 'edit', candSeq: 2, paths: ['s.py'] });
  assert.deepEqual(cs.pendingCandidates(), [{ csId: `${A}/1`, candSeq: 2, paths: ['s.py'] }]);
  assert.equal(cs.closeDue(), false, 'a pending candidate is not a closing capture (Task 10 settles it)');

  // A recovered CS (the journaled table survived, the cache did not) gets no candidate either.
  const rec = new ChangeSets(PEER, clock);
  const journaled: CsTable = { v: 1, next_order: 1, seats: {}, cs: [], orders: {}, passing: {} };
  rec.restore([], 1, journaled, null);
  rec.observe(['r.py']);
  rec.signal({ kind: 'checkpoint', seat: B, source: 'edit', candSeq: 1, paths: ['r.py'] });
  assert.deepEqual(rec.pendingCandidates(), []);
  assert.deepEqual(rec.counts(), { open: 1, ready: 0 }, 'the recovered CS holds r.py');
});

test('queueSignal asks for an out-of-cycle iteration exactly for stop, stop_failure, subagent_stop, session_end, seat_end, checkpoint (green, tool, edit) and an idle_10min that closes; never for effect, prompt, activity, checks_run or an idle_10min that keeps the CS open', T10, () => {
  const fresh = (): EngineCore => {
    const cs = new ChangeSets(PEER, new VirtualClock());
    cs.signal(effect(A, ['x.py']));
    return { cs } as unknown as EngineCore;
  };
  const rows: Array<[CsSignal, boolean]> = [
    [{ kind: 'stop', seat: A }, true],
    [{ kind: 'stop_failure', seat: A }, true],
    [{ kind: 'subagent_stop', seat: A, agent: 'x' }, true],
    [{ kind: 'session_end', seat: A }, true],
    [{ kind: 'seat_end', seat: A }, true],
    [{ kind: 'checkpoint', seat: A, source: 'green', candSeq: 1, paths: ['x.py'] }, true],
    [{ kind: 'checkpoint', seat: A, source: 'tool', candSeq: 1, paths: ['x.py'] }, true],
    [{ kind: 'checkpoint', seat: A, source: 'edit', candSeq: 1, paths: ['x.py'] }, true],
    [{ kind: 'idle_10min', seat: A, activity: 'IDLE', txnOpen: false }, true],
    [{ kind: 'idle_10min', seat: A, activity: 'ENDED', txnOpen: false }, true],
    [effect(A, ['y.py']), false],
    [{ kind: 'prompt', seat: A, humanOrigin: true, nonce: false }, false],
    [{ kind: 'prompt', seat: A, humanOrigin: false, nonce: true }, false],
    [{ kind: 'activity', seat: A, activity: 'MID_TURN' }, false],
    [{ kind: 'checks_run', seat: A, ok: true }, false],
    [{ kind: 'idle_10min', seat: A, activity: 'MID_TURN', txnOpen: false }, false],
    [{ kind: 'idle_10min', seat: A, activity: 'AWAITING_PERMISSION', txnOpen: false }, false],
    [{ kind: 'idle_10min', seat: A, activity: 'IDLE', txnOpen: true }, false],
    [{ kind: 'idle_10min', seat: B, activity: 'IDLE', txnOpen: false }, false],
  ];
  for (const [s, asks] of rows) assert.equal(queueSignal(fresh(), s), asks, JSON.stringify(s));
  // The signal reaches the CS table.
  const core = fresh();
  queueSignal(core, { kind: 'stop', seat: A });
  assert.equal(entry(core.cs.table(), `${A}/1`).state, 'closed');
});
