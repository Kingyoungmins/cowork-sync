import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_ORDER, TICK_ORDER, registerStep, runStep, registerTicker, runTicker, type StepId, type TickerId } from '../../src/claude/daemon/pipeline.js';
import type { DaemonCtx, HookRequest, ReplyDraft, HookStep } from '../../src/claude/daemon/ctx.js';
import type { HookEvent, HookFrame } from '../../src/claude/wire/frames.js';
import { HOOK_EVENTS } from '../../src/claude/wire/frames.js';

function fakeCtx(): DaemonCtx {
  return {} as unknown as DaemonCtx;
}
function fakeReq(event: HookEvent): HookRequest {
  const frame: HookFrame = { t: 'hook', event, h: { seat_key: 'k', claude_pid: 1, session_id: 's', prompt_id: null, agent_id: null, agent_type: null, permission_mode: 'default', repo_root: '.', plugin_version: '0.6.0', hook_proto: 3 }, payload: {} as never };
  return { frame, seat: {} as never, startedMono: 0, extend: () => false, turn: null, trigger: null };
}
function emptyDraft(): ReplyDraft {
  return { carrier: 'none', items: [], deny: null, block: null, done: false };
}

test('STEP_ORDER is the fixed 14-row table of 06 §3.4.2/§3.7/§3.8.4/§3.12/§3.14/§3.15', () => {
  // The keys are exactly the 14 events. The table's row order (the contract) puts PermissionDenied before
  // PostToolBatch; glossary §13's row order (A1-7, HOOK_EVENTS) differs only in that pair, so compare as sets too.
  assert.deepEqual(Object.keys(STEP_ORDER).sort(), [...HOOK_EVENTS].sort());
  assert.deepEqual(Object.keys(STEP_ORDER), [
    'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionDenied', 'PostToolBatch', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification',
  ]);
  assert.deepEqual(STEP_ORDER.SessionStart, ['seat.register', 'version.check', 'health.observe', 'signal.emit', 'carrier.context', 'transition.deliver', 'event.deliver']);
  assert.deepEqual(STEP_ORDER.UserPromptSubmit, ['seat.register', 'turn.prompt', 'lease.release', 'signal.emit', 'activity.mark', 'carrier.context', 'recap.system', 'transition.deliver', 'event.deliver']);
  assert.deepEqual(STEP_ORDER.UserPromptExpansion, ['seat.register', 'turn.expansion', 'evidence.expansion', 'activity.mark']);
  assert.deepEqual(STEP_ORDER.PreToolUse, ['seat.register', 'version.check', 'health.observe', 'gate.edit', 'gate.shell', 'transition.deliver', 'event.deliver']);
  assert.deepEqual(STEP_ORDER.PostToolUse, ['seat.register', 'health.observe', 'post.edit', 'post.read', 'txn.close', 'lease.release', 'checkpoint.trigger', 'signal.emit', 'journal.attribution', 'carrier.context', 'transition.deliver', 'event.deliver']);
  // A13-9: checkpoint.trigger ships with Task 5's table even though Task 13 registers the step.
  assert.deepEqual(STEP_ORDER.PostToolUseFailure, ['seat.register', 'health.observe', 'txn.close', 'lease.release', 'checkpoint.trigger', 'signal.emit', 'event.deliver']);
  // A PermissionDenied close is never a checkpoint.
  assert.deepEqual(STEP_ORDER.PermissionDenied, ['seat.register', 'health.observe', 'txn.close', 'lease.release', 'signal.emit', 'event.deliver']);
  assert.deepEqual(STEP_ORDER.PostToolBatch, ['seat.register', 'lease.release']);
  assert.deepEqual(STEP_ORDER.Stop, ['seat.register', 'stop.decide', 'signal.emit', 'lease.release', 'turn.stop', 'event.deliver']);
  assert.deepEqual(STEP_ORDER.StopFailure, STEP_ORDER.Stop);
  assert.deepEqual(STEP_ORDER.SubagentStart, ['seat.register', 'signal.emit', 'carrier.context']);
  assert.deepEqual(STEP_ORDER.SubagentStop, ['seat.register', 'lease.release', 'signal.emit']);
  assert.deepEqual(STEP_ORDER.SessionEnd, ['seat.register', 'lease.release', 'signal.emit']);
  assert.deepEqual(STEP_ORDER.Notification, ['seat.register', 'health.observe']);
});

test('TICK_ORDER is the A5-7 order (+ meter, F2 #7)', () => {
  // The meter's 1 s window roll runs before `ring`, so the ring ticker sees a PULL_MODE flag cleared in the same run.
  assert.deepEqual(TICK_ORDER, ['seats', 'turns', 'idle', 'meter', 'ring', 'leases', 'health', 'liveness', 'engineView']);
});

test('registerStep/registerTicker throw on a duplicate', () => {
  const step: HookStep = async () => undefined;
  registerStep('seat.register', step);
  assert.throws(() => registerStep('seat.register', step), /already registered/);
  const ticker = () => undefined;
  registerTicker('seats', ticker);
  assert.throws(() => registerTicker('seats', ticker), /already registered/);
});

test('an unregistered step or ticker is a no-op', async () => {
  const d = emptyDraft();
  await runStep('stop.decide', fakeReq('Stop'), d, fakeCtx());
  assert.deepEqual(d, emptyDraft());
  await runTicker('ring', fakeCtx());
});

test('runStep keeps the first deny: a later deny never replaces an earlier one', async () => {
  const early: ReplyDraft['deny'] = { code: 'TEST_EARLY', params: {}, form: 'T1' };
  const late: ReplyDraft['deny'] = { code: 'TEST_LATE', params: {}, form: 'T1' };
  const r = fakeReq('PreToolUse');
  const ctx = fakeCtx();
  const setEarly: HookStep = async (_r, d) => { d.deny = early; };
  const tryLate: HookStep = async (_r, d) => { d.deny = late; };
  const d1 = emptyDraft();
  await runStep('gate.edit', r, d1, ctx);
  await runStep('gate.edit', r, d1, ctx);   // unregistered → no-op
  registerStep('gate.edit', setEarly);
  await runStep('gate.edit', r, d1, ctx);
  assert.equal(d1.deny, early);
  registerStep('gate.shell', tryLate);
  await runStep('gate.shell', r, d1, ctx);
  assert.equal(d1.deny, early, 'the later step still ran, but the first deny is kept');
  const d2 = emptyDraft();
  await runStep('gate.shell', r, d2, ctx);
  assert.equal(d2.deny, late, 'with no earlier deny the step\'s own deny stays');
});
