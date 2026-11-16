// Plan 5 Task 1: every Plan 5 TraceEvent variant, declared in one place (A1-5, X-115); no duration and no wall time (TST-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceEvent, TraceHookEvent } from '../../src/ports/trace.js';
import type { HookEvent } from '../../src/claude/wire/frames.js';
import { HOOK_EVENTS } from '../../src/claude/wire/frames.js';
import { TraceRecorder } from '../sim/traceRecorder.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

test('TraceEvent declares every Plan 5 variant with no duration and no wall time', () => {
  const events: TraceEvent[] = [
    { kind: 'hook', peer: 'p1', seat: 's1', event: 'PreToolUse', promptId: 'pr1', toolUseId: 'tu1', outcome: 'g1', code: 'HELDREG' },
    { kind: 'lease', peer: 'p1', seat: 's1', lease: 'INFLIGHT', key: 'tu1', path: 'src/a.ts', op: 'acquire', why: null },
    { kind: 'seat', peer: 'p1', seat: 's1', op: 'register', sessionId: 'sess', wiring: 'FULL', flags: ['PULL_MODE'], why: null },
    { kind: 'turn', peer: 'p1', seat: 's1', promptId: 'pr2', op: 'wake', nonce: 'cws-0123456789abcdef', humanPromptRefreshed: false, csReset: false, released: 0 },
    { kind: 'ring', peer: 'p1', seat: 's1', nonce: 'cws-0123456789abcdef', result: 'not_rung' },
    { kind: 'evidence', peer: 'p1', seat: null, verb: 'save', promptId: 'pr3', op: 'mint', why: null },
    { kind: 'acting', peer: 'p1', verb: 'done', accepted: true, route: 'evidence' },
    { kind: 'deny_record', peer: 'p1', seat: 's1', id: 'h1', phase: 'prerecord' },
    { kind: 'edit_trigger', peer: 'p1', seat: 's1', cs: 'cs1', editN: 3, candSeq: null, outcome: 'shrink' },
    { kind: 'ipc', peer: 'p1', op: 'auth_fail', bytesToUnauthenticated: 0 },
    { kind: 'carrier', peer: 'p1', seat: 's1', event: 'PostToolUse', chars: 120, metered: 120, codes: ['ATTRIBUTION'], eventIds: ['e1'] },
  ];
  const rec = new TraceRecorder();
  for (const e of events) rec.emit(e);
  const kinds = ['hook', 'lease', 'seat', 'turn', 'ring', 'evidence', 'acting', 'deny_record', 'edit_trigger', 'ipc', 'carrier'] as const;
  for (const k of kinds) {
    const got = rec.ofKind(k);
    assert.equal(got.length, 1, k);
    assert.deepEqual(got[0], events.find((e) => e.kind === k), k);
  }
  for (const e of events) {
    for (const key of Object.keys(e)) assert.doesNotMatch(key, /ms$|Ms$|wall|duration|time/i, `${e.kind}.${key}`);
  }
  // A1-5: the trace port's own copy of the 14 hook events equals HookEvent.
  const same: Equal<TraceHookEvent, HookEvent> = true;
  const toHook = (e: TraceHookEvent): HookEvent => e;
  const toTrace = (e: HookEvent): TraceHookEvent => e;
  void same;
  for (const e of HOOK_EVENTS) assert.equal(toHook(toTrace(e)), e);
});
