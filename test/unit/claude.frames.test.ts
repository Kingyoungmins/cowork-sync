// Plan 5 Task 1: the local terms of 06 §2, glossary §13's registrations, the deferred list, and the wire tier's structural copies (X5-45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTING_VERBS, HOOK_EVENTS, HOOK_PROTO, HOOK_REGISTRATIONS, READ_ONLY_GRANT_VERBS,
  type ActingVerb, type CarrierDecision, type CliMode, type HookEvent, type StatusHeartbeat, type ToolName, type WireJson,
} from '../../src/claude/wire/frames.js';
import { gatingClass } from '../../src/claude/wire/hookInput.js';
import type { Json } from '../../src/board/canonicalJson.js';
import type { OutputMode } from '../../src/viz/cli/view.js';
import type { StatusJson } from '../../src/engine/status.js';
import type { Params } from '../../src/i18n/render.js';
import type { NotifyParams } from '../../src/ports/notifier.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Glossary §13's table, in row order (a row naming several events lists them in its own order). */
function glossaryHookRows(): Array<{ events: string[]; matcher: string }> {
  const text = readFileSync(join(ROOT, 'docs', 'spec', '00-glossary.md'), 'utf8');
  const s13 = text.slice(text.indexOf('## 13. Hooks'), text.indexOf('**Loader protocol:**'));
  const rows: Array<{ events: string[]; matcher: string }> = [];
  for (const line of s13.split('\n')) {
    const m = /^\| ([A-Z][A-Za-z, ]+) \| (.+) \|$/.exec(line);
    if (m === null || m[1] === 'Event') continue;
    rows.push({ events: m[1]!.split(', '), matcher: m[2]! });
  }
  return rows;
}

test('the local terms of 06 §2: edit-class tools, gating events and the 14 hook events', () => {
  const fromGlossary = glossaryHookRows().flatMap((r) => r.events);
  assert.equal(fromGlossary.length, 14);
  assert.deepEqual(HOOK_EVENTS, fromGlossary);
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(gatingClass('PreToolUse', t), 'edit', t);
  for (const t of ['Bash', 'PowerShell', 'Monitor']) assert.equal(gatingClass('PreToolUse', t), 'shell', t);
  for (const t of ['Agent', 'EnterWorktree']) assert.equal(gatingClass('PreToolUse', t), 'agent', t);
  assert.equal(gatingClass('PreToolUse', 'Read'), null);
  assert.equal(gatingClass('PreToolUse', null), null);
  for (const e of HOOK_EVENTS.filter((x) => x !== 'PreToolUse')) {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor', 'Agent', 'EnterWorktree', 'Read', null]) {
      assert.equal(gatingClass(e, t), null, `${e} ${String(t)}`);
    }
  }
});

test('HOOK_REGISTRATIONS is glossary §13 with the §25 F5 all-verb UserPromptExpansion matcher', () => {
  const NONE = null;
  assert.deepEqual(HOOK_REGISTRATIONS, [
    { event: 'SessionStart', matcher: 'startup|resume|clear|compact|fork', timeout: 10 },
    { event: 'UserPromptSubmit', matcher: NONE, timeout: 10 },
    { event: 'UserPromptExpansion', matcher: 'cowork|cowork-sync:cowork', timeout: 10 },
    { event: 'PreToolUse', matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$', timeout: 10 },
    { event: 'PreToolUse', matcher: '^(Bash|PowerShell|Monitor)$', timeout: 10 },
    { event: 'PreToolUse', matcher: '^(Agent|EnterWorktree)$', timeout: 10 },
    { event: 'PostToolUse', matcher: '.*', timeout: 10 },
    { event: 'PostToolUseFailure', matcher: '.*', timeout: 10 },
    { event: 'PostToolBatch', matcher: NONE, timeout: 10 },
    { event: 'Stop', matcher: NONE, timeout: 10 },
    { event: 'StopFailure', matcher: NONE, timeout: 10 },
    { event: 'SubagentStart', matcher: NONE, timeout: 10 },
    { event: 'SubagentStop', matcher: NONE, timeout: 10 },
    { event: 'SessionEnd', matcher: NONE, timeout: 2 },
    { event: 'PermissionDenied', matcher: '.*', timeout: 10 },
    { event: 'Notification', matcher: 'idle_prompt|permission_prompt', timeout: 10 },
  ]);
  // The UserPromptExpansion matcher has no pause|resume restriction (§25 F5 supersedes §13's "(pause/resume only)").
  const upe = HOOK_REGISTRATIONS.find((r) => r.event === 'UserPromptExpansion');
  assert.ok(upe !== undefined && !/pause|resume/.test(upe.matcher ?? ''));
  // Every glossary §13 matcher is the registered one (the UserPromptExpansion row minus its superseded note).
  for (const row of glossaryHookRows()) {
    const matchers = row.matcher === '—' ? [null] : row.matcher.replace(/ \(.*\)$/, '').replace(/`/g, '').split('; ');
    for (const e of row.events) {
      assert.deepEqual(HOOK_REGISTRATIONS.filter((r) => r.event === e).map((r) => r.matcher), matchers, e);
    }
  }
  assert.equal(HOOK_PROTO, 1);
});

test('nothing of the deferred list exists', () => {
  // Type level: each line below must fail to compile (npm run typecheck).
  // @ts-expect-error override is a v2 verb
  const v1: ActingVerb = 'override';
  // @ts-expect-error adopt is a v2 verb
  const v2: ActingVerb = 'adopt';
  // @ts-expect-error end is a v2 verb
  const v3: ActingVerb = 'end';
  // @ts-expect-error gc is a v2 verb
  const v4: ActingVerb = 'gc';
  // @ts-expect-error eol is a v2 verb
  const v5: ActingVerb = 'eol';
  // @ts-expect-error protocol is a v2 verb
  const v6: ActingVerb = 'protocol';
  // @ts-expect-error blame is a v2 verb
  const v7: ActingVerb = 'blame';
  // @ts-expect-error where is a v2 verb
  const v8: ActingVerb = 'where';
  // @ts-expect-error holds is a v2 verb
  const v9: ActingVerb = 'holds';
  // @ts-expect-error undo is removed (revert)
  const v10: ActingVerb = 'undo';
  // @ts-expect-error never allow
  const d1: CarrierDecision = 'allow';
  // @ts-expect-error never ask
  const d2: CarrierDecision = 'ask';
  // @ts-expect-error never defer
  const d3: CarrierDecision = 'defer';
  const eight: Equal<ToolName, 'cowork_status' | 'cowork_show' | 'cowork_request' | 'cowork_respond' | 'cowork_note' | 'cowork_release'
    | 'cowork_checkpoint' | 'cowork_resolve'> = true;
  void [v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, d1, d2, d3, eight];

  assert.deepEqual(ACTING_VERBS, ['start', 'stop', 'pause', 'resume', 'save', 'done', 'resolve', 'review', 'revert', 'release', 'recover', 'uninstall']);
  assert.deepEqual(READ_ONLY_GRANT_VERBS, ['since']);
  assert.ok(Object.isFrozen(ACTING_VERBS) && Object.isFrozen(READ_ONLY_GRANT_VERBS) && Object.isFrozen(HOOK_EVENTS) && Object.isFrozen(HOOK_REGISTRATIONS));
  const source = readFileSync(join(ROOT, 'src', 'claude', 'wire', 'frames.ts'), 'utf8');
  assert.ok(!source.includes('permission' + 'Decision'));
});

test('WireJson and CliMode are structurally Plan 2\'s Json and 8a\'s OutputMode; the client tier\'s wire copies match their engine-side shapes', () => {
  // Mutual assignability, both ways (A1-1, A1-2, X5-45); checked by npm run typecheck.
  const toJson = (w: WireJson): Json => w;
  const toWire = (j: Json): WireJson => j;
  const toOutputMode = (m: CliMode): OutputMode => m;
  const toCliMode = (m: OutputMode): CliMode => m;
  const sameMode: Equal<CliMode, OutputMode> = true;
  // A4-14: Plan 2's StatusJson is assignable to the wire heartbeat shape (Task 1B re-runs this against Plan 3's StatusJson).
  const heartbeat = (s: StatusJson): StatusHeartbeat => s;
  // A1-5: NotifyParams is structurally 8a's Params.
  const toParams = (p: NotifyParams): Params => p;
  const toNotify = (p: Params): NotifyParams => p;
  const hookEvent: (e: HookEvent) => string = (e) => e;
  void [sameMode, hookEvent];
  const sample: WireJson = { a: [1, 'x', null, true, { b: [] }] };
  assert.deepEqual(toWire(toJson(sample)), sample);
  assert.equal(toCliMode(toOutputMode('slash')), 'slash');
  assert.deepEqual(toNotify(toParams({ n: 1, s: 'x', z: null })), { n: 1, s: 'x', z: null });
  assert.equal(typeof heartbeat, 'function');
});
