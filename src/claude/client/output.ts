// src/claude/client/output.ts — 06 §3.4.5 output encoding per event (CCI-11, INV-CCI-NODECISION, R1-321, R5-44; glossary §11). A reply or the G4
// form becomes the hook's exit code, stdout and stderr: exit 2 with a UTF-8 stderr reason only for a PreToolUse deny (G1) or G4; additionalContext,
// decision:block (PostToolUse K2 and Stop only) and systemMessage as the table allows; no output ever carries a permission decision (no source token
// here names it: L-PERMISSION) or a terminal sequence (R5-44). Strings carry no trailing newline. The M26 site (A4-11, P5-EC-4): in a test build
// only, COWORK_TEST_MUTANT=M26 gives a G2 PreToolUse output a permission-decision "allow" key composed at run time.
import { LOADER_TEXTS } from '../text/claudeText.js';
import type { ClaudeLang } from '../../i18n/claude.js';
import type { ClientMutantId, HookEvent, ReplyFrame } from '../wire/frames.js';

declare const __COWORK_TEST_BUILD__: boolean | undefined;
// P5-EC-4's guard, written at the seam: esbuild 0.24.2 folds `typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__` to false under
// --release and drops the branch only where the expression itself stands (a module-level const of a module with imports stays a var, its seam kept).

export interface HookOutput { exit: 0 | 2; stdout: string; stderr: string }

const SILENT: ReadonlySet<HookEvent> = new Set(['SubagentStop', 'StopFailure', 'SessionEnd', 'PostToolBatch', 'PermissionDenied', 'Notification', 'UserPromptExpansion']);
const NOTHING: HookOutput = Object.freeze({ exit: 0, stdout: '', stderr: '' });

const ok = (o: Record<string, unknown> | null): HookOutput => (o === null || Object.keys(o).length === 0 ? NOTHING : { exit: 0, stdout: JSON.stringify(o), stderr: '' });
const withSystem = (o: Record<string, unknown>, system: string | null): Record<string, unknown> => (system === null ? o : { ...o, systemMessage: system });
const context = (event: HookEvent, text: string): Record<string, unknown> => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** Per-event encoding (the 06 §3.4.5 table; readings pinned by test/unit/claude.output.test.ts): PreToolUse deny (and block) → exit 2 + stderr;
 *  context → additionalContext (+ systemMessage); none → empty or {"systemMessage"}. PostToolUse block → {"decision":"block","reason"} (K2), deny and
 *  context → additionalContext, each + systemMessage. PostToolUseFailure → additionalContext only, never a systemMessage. SessionStart,
 *  SubagentStart, UserPromptSubmit → additionalContext (+ systemMessage) for context, block and deny alike, never decision:block. Stop → block only,
 *  no systemMessage. SubagentStop, StopFailure, SessionEnd, PostToolBatch, PermissionDenied, Notification, UserPromptExpansion → nothing. G4 → exit 2
 *  with the loader's G4 text for PreToolUse, nothing for every other event. */
export function encodeOutput(event: HookEvent, r: ReplyFrame | { g4: true; lang: ClaudeLang }): HookOutput {
  if ('g4' in r) return event === 'PreToolUse' ? { exit: 2, stdout: '', stderr: LOADER_TEXTS.G4[r.lang] } : NOTHING;
  if (SILENT.has(event)) return NOTHING;
  const { decision, text, system } = r;
  switch (event) {
    case 'PreToolUse': {
      if (decision === 'deny' || decision === 'block') return { exit: 2, stdout: '', stderr: text };
      if (decision === 'none') return ok(withSystem({}, system));
      const out = context(event, text);
      if ((typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__) && process.env['COWORK_TEST_MUTANT'] === ('M26' satisfies ClientMutantId)) {
        (out['hookSpecificOutput'] as Record<string, unknown>)[['permission', 'Decision'].join('')] = 'allow';
      }
      return ok(withSystem(out, system));
    }
    case 'PostToolUse':
      if (decision === 'block') return ok(withSystem({ decision: 'block', reason: text }, system));
      return ok(withSystem(decision === 'none' ? {} : context(event, text), system));
    case 'PostToolUseFailure':
      return ok(decision === 'none' ? null : context(event, text));
    case 'Stop':
      return ok(decision === 'block' ? { decision: 'block', reason: text } : null);
    default:   // SessionStart, SubagentStart, UserPromptSubmit
      return ok(withSystem(decision === 'none' ? {} : context(event, text), system));
  }
}
