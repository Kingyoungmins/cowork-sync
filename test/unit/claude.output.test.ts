// Plan 5 Task 4: output encoding per event (06 §3.4.5; R1-321, CCI-11, INV-CCI-NODECISION, M26, R5-44, glossary §11). Every cell of the 14 events ×
// decision × system, plus the G4 form; the M26 seam is a test-build mutant (A4-11, P5-EC-4: a source run is a test build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeOutput } from '../../src/claude/client/output.js';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import { HOOK_EVENTS, type CarrierDecision, type HookEvent, type ReplyFrame } from '../../src/claude/wire/frames.js';

const TEXT = 'T';
const DECISIONS: readonly CarrierDecision[] = ['deny', 'block', 'context', 'none'];
const reply = (decision: CarrierDecision, system: string | null): ReplyFrame => ({ t: 'reply', batch_id: 'b1', decision, text: TEXT, system, events: [], cursor: 0 });
const ctx = (event: HookEvent, system: string | null): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: TEXT }, ...(system === null ? {} : { systemMessage: system }) });
const block = (system: string | null): string => JSON.stringify({ decision: 'block', reason: TEXT, ...(system === null ? {} : { systemMessage: system }) });
const sysOnly = (system: string | null): string => (system === null ? '' : JSON.stringify({ systemMessage: system }));
const SILENT: ReadonlySet<HookEvent> = new Set(['SubagentStop', 'StopFailure', 'SessionEnd', 'PostToolBatch', 'PermissionDenied', 'Notification', 'UserPromptExpansion']);

/** The 06 §3.4.5 table, cell by cell. */
function expected(event: HookEvent, decision: CarrierDecision, system: string | null): { exit: 0 | 2; stdout: string; stderr: string } {
  const ok = (stdout: string): { exit: 0; stdout: string; stderr: string } => ({ exit: 0, stdout, stderr: '' });
  if (SILENT.has(event)) return ok('');
  switch (event) {
    case 'PreToolUse':
      if (decision === 'deny' || decision === 'block') return { exit: 2, stdout: '', stderr: TEXT };
      return ok(decision === 'context' ? ctx(event, system) : sysOnly(system));
    case 'PostToolUse':
      if (decision === 'block') return ok(block(system));
      return ok(decision === 'none' ? sysOnly(system) : ctx(event, system));
    case 'PostToolUseFailure':
      return ok(decision === 'none' ? '' : ctx(event, null));
    case 'Stop':
      return ok(decision === 'block' ? block(null) : '');
    default:   // SessionStart, SubagentStart, UserPromptSubmit: block and deny read as context, never decision:block
      return ok(decision === 'none' ? sysOnly(system) : ctx(event, system));
  }
}

/** Every stdout is empty or one JSON object whose only top-level keys are these; no output names a permission decision or a terminal sequence. */
function checkShape(cell: string, out: { stdout: string; stderr: string }): void {
  for (const s of [out.stdout, out.stderr]) {
    assert.ok(!s.includes('permissionDecision'), `${cell}: permissionDecision`);
    assert.ok(!s.includes('terminalSequence'), `${cell}: terminalSequence`);
  }
  if (out.stdout === '') return;
  const o = JSON.parse(out.stdout) as Record<string, unknown>;
  assert.ok(typeof o === 'object' && o !== null && !Array.isArray(o), cell);
  for (const k of Object.keys(o)) assert.ok(['hookSpecificOutput', 'decision', 'reason', 'systemMessage'].includes(k), `${cell}: top-level ${k}`);
}

function assertAllCells(): void {
  for (const event of HOOK_EVENTS) {
    for (const decision of DECISIONS) {
      for (const system of [null, 'S']) {
        const cell = `${event} ${decision} system=${String(system)}`;
        const out = encodeOutput(event, reply(decision, system));
        assert.deepEqual(out, expected(event, decision, system), cell);
        checkShape(cell, out);
      }
    }
    for (const lang of ['en', 'ko'] as const) {
      const out = encodeOutput(event, { g4: true, lang });
      assert.deepEqual(out, event === 'PreToolUse' ? { exit: 2, stdout: '', stderr: LOADER_TEXTS.G4[lang] } : { exit: 0, stdout: '', stderr: '' }, `${event} g4 ${lang}`);
      checkShape(`${event} g4 ${lang}`, out);
    }
  }
}

test('encodeOutput never emits permissionDecision for any event and outcome', () => {
  assert.equal(HOOK_EVENTS.length, 14);
  assertAllCells();
});

test('M26 is caught: under COWORK_TEST_MUTANT=M26 a G2 output carries a permission decision', () => {
  process.env['COWORK_TEST_MUTANT'] = 'M26';
  try {
    const out = encodeOutput('PreToolUse', reply('context', null));
    const o = JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> };
    assert.equal(o.hookSpecificOutput['permissionDecision'], 'allow');
    assert.throws(() => assertAllCells(), assert.AssertionError, 'the previous test\'s assertion fails for that cell');
  } finally {
    delete process.env['COWORK_TEST_MUTANT'];
  }
  assertAllCells();
});
