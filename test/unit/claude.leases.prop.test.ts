// test/unit/claude.leases.prop.test.ts — O-LEASE (unit, TC-CCI-05): over 500 random sequences of the dropped-Post
// cases (second hook denies, manual No, deny rule, plan mode, Esc in a slow Write, StopFailure, PermissionDenied in
// auto mode, a parallel batch of two Edits on one file) driven with housekeeping ticks (a tick is 10–60 one-second
// expire() calls, so the backstops and caps fire inside a run): recomputed from the `lease` trace with the recorder's
// monoAt (every event stamped with the virtual clock), every acquire has its release with age at most its cap
// (INFLIGHT 120 s, TXN 120 s, READ 300 s) plus one tick, every READ lease is renewed at most 3 times, no INFLIGHT is
// released by another tool's PreToolUse (the table has no such operation; releases carry exactly the scripted whys or
// a backstop/cap), and the fence of a live lease stands while siblings come and go. Across the 500 runs the caps are
// actually reached (≥ 1 INFLIGHT backstop, TXN cap, READ backstop, READ lease renewed past 120 s, and a READ lease
// offered a fourth renewal that would have extended it — the renewal limit's own subject, made reachable by the
// `busy` command: the seat's hook activity every 10 s), so a broken cap or renewal limit cannot pass unseen (F2 #19). The 125 s landing clause is the integration leg
// (test/integration/claude.leases.engine.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { LeaseTable } from '../../src/claude/daemon/leases.js';
import { C } from '../../src/claude/wire/constants.js';
import { VirtualClock } from '../sim/vclock.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import type { DiskSnapshots } from '../../src/claude/daemon/hookRead.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';

const S = 's'.repeat(32);
const PATHS = ['src/a.ts', 'src/b.ts', 'docs/x.md'];
const IDS = ['tu1', 'tu2', 'tu3', 'tx1'];
const SESSIONS = ['s1', 's2'];
const AGENTS = ['a1', 'a2'];

type Cmd =
  | { c: 'inflight'; id: number; path: number }                       // a G2/G3 admission (PreToolUse) — acquires only
  | { c: 'txn'; id: number }                                          // a shell TXN opened
  | { c: 'read'; path: number }                                       // a full Read
  | { c: 'post'; id: number }                                         // the tool's own Post (or its failure / denial / batch)
  | { c: 'fail'; id: number }
  | { c: 'denied'; id: number }
  | { c: 'batch' }                                                    // a parallel batch of two Edits on one file
  | { c: 'ups' }                                                      // a new-turn UserPromptSubmit
  | { c: 'stop' }
  | { c: 'sessionEnd'; session: number }
  | { c: 'subStop'; agent: number }
  | { c: 'editPost'; path: number }                                   // the seat's edit-class Post on a path
  | { c: 'renew' }                                                    // hook activity renews the READ leases
  | { c: 'busy'; k: number }                                          // k × (10 s of ticks, then hook activity): a busy seat
  | { c: 'tick'; s: number };                                         // s × (advance 1 s, the housekeeping expire())

// tick and renew are weighted up so a run reaches the backstops and the renewal limit (a READ lease renewed 4 times
// needs a read and four tick→renew pairs before any release); size 'max' lets fast-check use the whole 1–40 range.
const cmdsArb: fc.Arbitrary<Cmd[]> = fc.array(
  fc.oneof(
    fc.record({ c: fc.constant('inflight' as const), id: fc.constantFrom(...IDS.map((_, i) => i)), path: fc.constantFrom(...PATHS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('txn' as const), id: fc.constantFrom(...IDS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('read' as const), path: fc.constantFrom(...PATHS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('post' as const), id: fc.constantFrom(...IDS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('fail' as const), id: fc.constantFrom(...IDS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('denied' as const), id: fc.constantFrom(...IDS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('batch' as const) }),
    fc.record({ c: fc.constant('ups' as const) }),
    fc.record({ c: fc.constant('stop' as const) }),
    fc.record({ c: fc.constant('sessionEnd' as const), session: fc.constantFrom(...SESSIONS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('subStop' as const), agent: fc.constantFrom(...AGENTS.map((_, i) => i)) }),
    fc.record({ c: fc.constant('editPost' as const), path: fc.constantFrom(...PATHS.map((_, i) => i)) }),
    { arbitrary: fc.record({ c: fc.constant('renew' as const) }), weight: 3 },
    { arbitrary: fc.record({ c: fc.constant('tick' as const), s: fc.integer({ min: 10, max: 60 }) }), weight: 3 },
    fc.record({ c: fc.constant('busy' as const), k: fc.integer({ min: 1, max: 6 }) }),
  ),
  { minLength: 1, maxLength: 40, size: 'max' },
);

type LeaseEv = Extract<TraceEvent, { kind: 'lease' }>;

/** Across all runs: how often each cap was actually reached (asserted after fc.assert). */
interface Reached { inflightBackstop: number; txnCap: number; readBackstop: number; readRenewedPast: number; readLimitOffered: number; }

/** One random sequence; O-LEASE violations are returned (empty = the property held). */
function run(cmds: Cmd[], reached: Reached): string[] {
  const v: string[] = [];
  const clock = new VirtualClock({ startMono: 0 });
  const rec = new TraceRecorder();
  const trace: Trace = { emit: (ev) => rec.emitAt(ev, clock.monoMs()) };   // every row stamped: monoAt is the event's instant
  const leases = new LeaseTable(clock, trace, {} as unknown as DiskSnapshots);
  const tick = (): void => {
    clock.advance(1_000);
    leases.expire();
  };
  let n = 0;
  const renewCalls: number[] = [];        // the instant of every renewReads call (the renewal-limit reachability check)
  const renew = (): void => {
    renewCalls.push(clock.monoMs());
    leases.renewReads(S);
  };
  const pendingInflight: string[] = [];   // the acquired INFLIGHT leases whose Post has not landed yet (the dropped-Post rig)
  const pendingTxn: string[] = [];
  const sessionId = (i: number): string => SESSIONS[i % SESSIONS.length]!;
  const agentId = (i: number): string => AGENTS[i % AGENTS.length]!;
  for (const cmd of cmds) {
    switch (cmd.c) {
      case 'inflight': {
        const id = `tu${n++}`;
        leases.acquireInflight({ toolUseId: id, seatId: S, agentId: null, sessionId: sessionId(n), path: PATHS[cmd.path]!, foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
        pendingInflight.push(id);
        break;
      }
      case 'txn': {
        const id = `tx${n++}`;
        leases.openTxn({ toolUseId: id, seatId: S, agentId: null, sessionId: sessionId(n), tool: 'Bash', foldHeight: 0, sOpen: {}, approximate: false, background: false, csId: null, view: null });
        pendingTxn.push(id);
        break;
      }
      case 'read':
        leases.acquireRead(S, PATHS[cmd.path]!);
        break;
      case 'post':
        leases.release(pendingInflight.pop() ?? 'gone', 'post');
        leases.release(pendingTxn.pop() ?? 'gone', 'post');
        break;
      case 'fail':
        leases.release(pendingInflight.pop() ?? 'gone', 'post_failure');
        leases.release(pendingTxn.pop() ?? 'gone', 'post_failure');
        break;
      case 'denied':
        leases.release(pendingInflight.pop() ?? 'gone', 'permission_denied');
        leases.release(pendingTxn.pop() ?? 'gone', 'permission_denied');
        break;
      case 'batch': {   // a parallel batch of two Edits on one file: one PostToolBatch event releases both ids
        const id1 = `b${n++}`;
        const id2 = `b${n++}`;
        leases.acquireInflight({ toolUseId: id1, seatId: S, agentId: null, sessionId: sessionId(n), path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
        leases.acquireInflight({ toolUseId: id2, seatId: S, agentId: null, sessionId: sessionId(n), path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
        leases.release(id1, 'batch');
        leases.release(id2, 'batch');
        break;
      }
      case 'ups':
        leases.releaseSeat(S, { }, 'new_turn');
        break;
      case 'stop':
        leases.releaseSeat(S, { }, 'stop');
        break;
      case 'sessionEnd':
        leases.releaseSeat(S, { sessionId: sessionId(cmd.session) }, 'session_end');
        break;
      case 'subStop':
        leases.releaseSeat(S, { agentId: agentId(cmd.agent) }, 'subagent_stop');
        break;
      case 'editPost':
        leases.releaseRead(S, PATHS[cmd.path]!, 'next_edit_post');
        break;
      case 'renew':
        renew();
        break;
      case 'busy':
        for (let r = 0; r < cmd.k; r++) {
          for (let k = 0; k < 10; k++) tick();
          renew();
        }
        break;
      case 'tick':
        for (let k = 0; k < cmd.s; k++) tick();
        break;
    }
  }
  // Teardown: 301 one-second ticks, so every lease still live reaches its own backstop or cap (READ's hard cap is 300 s
  // after its first acquisition); the checks then run on the trace, and the seat end must find nothing left.
  for (let i = 0; i < 301; i++) tick();

  const evs: Array<{ e: LeaseEv; mono: number | null }> = [];
  rec.events.forEach((e, i) => {
    if (e.kind === 'lease') evs.push({ e, mono: rec.monoAt(i) });
  });
  // Every acquire has its release (its first release after the acquire), with age at most its cap plus one housekeeping
  // tick of overshoot (a backstop fires at the first tick at/after its deadline). A row without its instant is a violation.
  const caps: Record<string, number> = { INFLIGHT: C.INFLIGHT_BACKSTOP_MS, TXN: C.TXN_CAP_MS, READ: C.READ_LEASE_HARD_CAP_MS };
  for (let i = 0; i < evs.length; i++) {
    const { e, mono } = evs[i]!;
    if (mono === null) {
      v.push(`${e.lease} ${e.key} ${e.op} has no monoAt`);
      continue;
    }
    if (e.op !== 'acquire') continue;
    const j = evs.findIndex((x, k) => k > i && x.e.lease === e.lease && x.e.key === e.key && x.e.op === 'release');
    if (j < 0) {
      v.push(`no release for ${e.lease} ${e.key}`);
      continue;
    }
    const rel = evs[j]!;
    const age = (rel.mono ?? Number.NaN) - mono;
    if (!(age <= caps[e.lease]! + 1_000)) v.push(`${e.lease} ${e.key} released at ${age} ms > cap ${caps[e.lease]} + tick`);
    if (e.lease === 'READ') {
      const renews = evs.slice(i + 1, j).filter((x) => x.e.lease === 'READ' && x.e.key === e.key && x.e.op === 'renew').length;
      if (renews > C.READ_LEASE_RENEWALS) v.push(`READ ${e.key} renewed ${renews} times > ${C.READ_LEASE_RENEWALS}`);
      // The limit was offered: after its third counted renewal (at t3, expiry min(first + 300 s, t3 + 120 s)) the seat's
      // hook activity came again while the lease lived and would have moved its expiry — only the limit refused it.
      const renewRows = evs.slice(i + 1, j).filter((x) => x.e.lease === 'READ' && x.e.key === e.key && x.e.op === 'renew');
      if (renewRows.length === C.READ_LEASE_RENEWALS) {
        const t3 = renewRows[renewRows.length - 1]!.mono ?? Number.NaN;
        const exp3 = Math.min(mono + C.READ_LEASE_HARD_CAP_MS, t3 + C.READ_LEASE_MS);
        const relMono = rel.mono ?? Number.NaN;
        if (renewCalls.some((t) => t > t3 && t < relMono && t < exp3 && Math.min(mono + C.READ_LEASE_HARD_CAP_MS, t + C.READ_LEASE_MS) > exp3)) reached.readLimitOffered += 1;
      }
      if (rel.e.why === 'backstop') reached.readBackstop += 1;
      if (age > C.READ_LEASE_MS) reached.readRenewedPast += 1;
    }
    if (e.lease === 'INFLIGHT' && rel.e.why === 'backstop') reached.inflightBackstop += 1;
    if (e.lease === 'TXN' && rel.e.why === 'cap') reached.txnCap += 1;
  }
  // No release carries a why outside the scripted set — in particular nothing releases a lease "because another
  // tool's PreToolUse ran" (that case exists nowhere in the table: a PreToolUse only acquires).
  const whys = new Set(['post', 'post_failure', 'permission_denied', 'batch', 'new_turn', 'stop', 'session_end', 'subagent_stop', 'next_edit_post', 'backstop', 'cap']);
  for (const { e } of evs) {
    if (e.op === 'release' && (e.why === null || !whys.has(e.why))) v.push(`release ${e.key} carries why ${String(e.why)}`);
  }
  const left = leases.releaseSeat(S, { }, 'seat_end');
  if (left.length !== 0) v.push(`the seat end still found ${left.length} live lease(s) after the backstop ticks`);
  return v;
}

test('O-LEASE (unit): over 500 random dropped-Post sequences every acquire has its release within its cap, READ renewals stay within 3, and no release is caused by another tool PreToolUse', async () => {
  const reached: Reached = { inflightBackstop: 0, txnCap: 0, readBackstop: 0, readRenewedPast: 0, readLimitOffered: 0 };
  await fc.assert(
    fc.property(cmdsArb, (cmds) => {
      assert.deepEqual(run(cmds, reached), []);
    }),
    { numRuns: 500 },
  );
  // The caps were reached, not only declared: a broken cap or renewal rule had something to break.
  assert.ok(reached.inflightBackstop >= 1, `an INFLIGHT backstop fired: ${JSON.stringify(reached)}`);
  assert.ok(reached.txnCap >= 1, `a TXN cap fired: ${JSON.stringify(reached)}`);
  assert.ok(reached.readBackstop >= 1, `a READ backstop fired: ${JSON.stringify(reached)}`);
  assert.ok(reached.readRenewedPast >= 1, `a renewed READ lease lived past 120 s: ${JSON.stringify(reached)}`);
  assert.ok(reached.readLimitOffered >= 1, `a READ lease was offered a fourth extending renewal: ${JSON.stringify(reached)}`);
});

test('the parallel-batch case keeps the fence of the surviving lease while its sibling releases', () => {
  const clock = new VirtualClock({ startMono: 0 });
  const trace = new TraceRecorder();
  const leases = new LeaseTable(clock, trace, {} as unknown as DiskSnapshots);
  leases.acquireInflight({ toolUseId: 'tu1', seatId: S, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
  leases.acquireInflight({ toolUseId: 'tu2', seatId: S, agentId: null, sessionId: 's1', path: 'src/a.ts', foldHeight: 0, pre: null, approximate: false, synthetic: false, preHeld: null, view: null, tentative: null });
  leases.release('tu1', 'post');
  assert.deepEqual([...leases.fencedPaths()], [['src/a.ts', 'fence']], 'tu2 keeps the fence over the same path');
  clock.advance(C.INFLIGHT_BACKSTOP_MS + 1);
  leases.expire();
  assert.deepEqual([...leases.fencedPaths()], [], 'the backstop closed the dropped Post lease');
  const evs = trace.events.filter((e): e is LeaseEv => e.kind === 'lease');
  assert.deepEqual(evs.filter((e) => e.op === 'release').map((e) => [e.key, e.why]), [['tu1', 'post'], ['tu2', 'backstop']]);
});
