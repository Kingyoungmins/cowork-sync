// src/claude/wire/hookInput.ts — 06 §3.4.1 steps 2–4, §3.4.3; 09 §2, §3.13 step 1; SEC-25, SEC-26 (CCI-09).
// The host's hook JSON as a typed view, and the frame payload built from it. The payload carries only the fields 06 §3.4.3 lists: never
// prompt text, command_args, tool_response content or transcript content (UserPromptSubmit sends only its wake nonces; a
// UserPromptExpansion sends its arguments only as args_sha256). Pure: no file, clock or random read (the loader passes mono_ns in).
import { createHash, createHmac } from 'node:crypto';
import { sameRoot } from '../../data/canonRoot.js';
import { ACTING_VERBS, type EditInput, type EvidenceRecord, type GatingClass, type HookEvent, type HookPayload, type PolicyHit, type ReadInfo,
  type WireJson } from './frames.js';
import { canonicalJsonLine } from './ndjson.js';

export class HookInputError extends Error {}

export interface HookInput {
  event: HookEvent; session_id: string; prompt_id: string | null; transcript_path: string | null; cwd: string; permission_mode: string;
  agent_id: string | null; agent_type: string | null; tool_name: string | null; tool_use_id: string | null; tool_input: WireJson | null;
  tool_response: WireJson | null; fields: Readonly<Record<string, unknown>>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Rec, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const fail = (what: string): never => { throw new HookInputError(`hook input: ${what}`); };
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** An optional string field: absent or null → null; anything else but a string throws. */
function optStr(o: Rec, k: string): string | null {
  const v = own(o, k);
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : fail(`${k} is not a string`);
}

/** Typed view of the host's hook JSON; throws HookInputError on a malformed shape (loader step 2 → internal failure). */
export function parseHookInput(event: HookEvent, json: unknown): HookInput {
  if (!isRec(json)) return fail('not an object');
  const named = own(json, 'hook_event_name');
  if (named !== undefined && named !== event) fail('hook_event_name differs from the event');
  const session = own(json, 'session_id');
  const cwd = own(json, 'cwd');
  if (typeof session !== 'string') fail('session_id');
  if (typeof cwd !== 'string') fail('cwd');
  const mode = own(json, 'permission_mode');
  if (mode !== undefined && typeof mode !== 'string') fail('permission_mode');
  const toolInput = own(json, 'tool_input');
  const toolResponse = own(json, 'tool_response');
  return {
    event, session_id: session as string, prompt_id: optStr(json, 'prompt_id'), transcript_path: optStr(json, 'transcript_path'), cwd: cwd as string,
    permission_mode: (mode as string | undefined) ?? '', agent_id: optStr(json, 'agent_id'), agent_type: optStr(json, 'agent_type'),
    tool_name: optStr(json, 'tool_name'), tool_use_id: optStr(json, 'tool_use_id'),
    tool_input: toolInput === undefined ? null : (toolInput as WireJson), tool_response: toolResponse === undefined ? null : (toolResponse as WireJson),
    fields: Object.freeze({ ...json }),
  };
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Monitor']);
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'EnterWorktree']);

/** 06 §2 "gating event": PreToolUse of an edit-class tool, of Bash|PowerShell|Monitor, or of Agent|EnterWorktree; every other event is non-gating. */
export function gatingClass(event: HookEvent, toolName: string | null): GatingClass {
  if (event !== 'PreToolUse' || toolName === null) return null;
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (SHELL_TOOLS.has(toolName)) return 'shell';
  return AGENT_TOOLS.has(toolName) ? 'agent' : null;
}

/** Glossary §25 F2: the wake nonce. Global: use it with matchAll (which copies it), never with a stateful test(). */
export const NONCE_RE: RegExp = /cws-[0-9a-f]{16}/g;

/** Every cws- token, deduplicated, in order. */
export function nonces(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(NONCE_RE), (m) => m[0]))];
}

const BLANK = /[ \t\n]/;
/** The words of a command line as a POSIX shell splits it: blanks separate; '…' is literal; "…" keeps backslash escapes of $ ` " \ and
 *  newline only; an unquoted backslash escapes the next character (backslash-newline joins lines); an unquoted # at a word start begins a
 *  comment. Nothing is expanded (no variables, globs or operators). An unterminated quote runs to the end. */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  const end = (): void => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (BLANK.test(c)) { end(); continue; }
    if (c === '#' && !inWord) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < s.length) {
        i++;
        if (s[i] === '\n') continue;   // line continuation
        cur += s[i];
      } else {
        cur += c;
      }
      inWord = true;
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      cur += close < 0 ? s.slice(i + 1) : s.slice(i + 1, close);
      i = close < 0 ? s.length : close;
      inWord = true;
      continue;
    }
    if (c === '"') {
      inWord = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1] as string)) {
          i++;
          if (s[i] !== '\n') cur += s[i];
        } else {
          cur += s[i];
        }
      }
      continue;
    }
    cur += c;
    inWord = true;
  }
  end();
  return words;
}

/** SEC-25 as ruled by X-60 (the one implementation for loader, core and CLI; SE5-15 closed): the words are the shell words of the input — a
 *  string (the loader's command_args) is split with POSIX quoting as the `!` line's shell splits it; an array (the CLI's argv after the verb's
 *  own process start) is taken as those words; verb = the first word; args_norm = every further word with its whitespace runs collapsed to one
 *  space, each JSON-quoted (JSON.stringify), joined by one space ('' when there is none); args_sha256 = hex SHA-256(args_norm). */
export function normArgs(input: string | readonly string[]): { verb: string; argsNorm: string; argsSha256: string } {
  const words = typeof input === 'string' ? shellWords(input) : [...input];
  const argsNorm = words.slice(1).map((w) => JSON.stringify(w.replace(/\s+/g, ' '))).join(' ');
  return { verb: words[0] ?? '', argsNorm, argsSha256: sha256hex(argsNorm) };
}

/** A1-8: the host hook-input field names Plan 5 reads that 06 §3.4.3 does not spell, in one table so the SPIKE-0/R5-50 host checks (Task 12)
 *  correct a name in one place: exitStatus, readTruncated, readEnoent and readSize are (dotted) paths inside tool_response; backgroundTasks,
 *  lastMessage and notificationType are top-level. */
export const HOST_FIELDS: {
  readonly exitStatus: readonly string[]; readonly backgroundTasks: string; readonly lastMessage: string; readonly notificationType: string;
  readonly readTruncated: string; readonly readEnoent: string; readonly readSize: string;
} = Object.freeze({
  exitStatus: Object.freeze(['exit_code', 'exitCode']), backgroundTasks: 'background_tasks_running', lastMessage: 'last_assistant_message',
  notificationType: 'notification_type', readTruncated: 'truncated', readEnoent: 'enoent', readSize: 'file.numLines',
});

/** A1-8: hold ULIDs, request display ids, claim ids, cs ids. */
export const COWORK_ID_RE: RegExp = /\b(?:[0-9A-HJKMNP-TV-Z]{26}|R[0-9a-z]{8}|C[0-9a-z]{16}|[0-9a-f]{32}\/[1-9][0-9]{0,9})\b/g;

/** A1-8: every COWORK_ID_RE match plus every token (split on whitespace and ` ' " ( ) [ ] , ;, trailing . and : trimmed) that contains '/' or
 *  '.', has ≤ 200 UTF-16 units and no control character (the not-shared item ids of Stop (a) are paths); deduplicated in text order. */
export function idsInText(text: string): string[] {
  const out = new Set<string>();
  for (const token of text.split(/[\s`'"()[\],;]+/u)) {
    for (const m of token.matchAll(COWORK_ID_RE)) out.add(m[0]);
    const t = token.replace(/[.:]+$/, '');
    if (t !== '' && t.length <= 200 && (t.includes('/') || t.includes('.')) && !/\p{Cc}/u.test(t)) out.add(t);
  }
  return [...out];
}

/** A1-8: lowercase hex SHA-256 of CLAUDE_CODE_MESSAGING_SOCKET when set and non-empty, else String(ppid) (glossary §2; the loader carries a copy,
 *  Task 4 parity test). Reads exactly that one variable: never the token's. */
export function seatKeyOf(env: Readonly<Record<string, string | undefined>>, ppid: number): string {
  const socket = env['CLAUDE_CODE_MESSAGING_SOCKET'];
  return typeof socket === 'string' && socket !== '' ? sha256hex(socket) : String(ppid);
}

const COMMAND_NAMES: ReadonlySet<string> = new Set(['cowork', 'cowork-sync:cowork']);
const ACTING: ReadonlySet<string> = new Set(ACTING_VERBS);

/** A1-8: non-null exactly for a UserPromptExpansion with expansion_type slash_command, command_name ∈ {cowork, cowork-sync:cowork}, verb ∈
 *  ACTING_VERBS and no cws- nonce in its prompt (09 §2, §3.13 steps 1–2; R5-38). */
export function evidenceFor(i: HookInput, seatKey: string, monoNs: bigint): EvidenceRecord | null {
  if (i.event !== 'UserPromptExpansion' || i.prompt_id === null) return null;
  if (i.fields['expansion_type'] !== 'slash_command' || !COMMAND_NAMES.has(i.fields['command_name'] as string)) return null;
  const prompt = i.fields['prompt'];
  if (typeof prompt === 'string' && nonces(prompt).length > 0) return null;
  const args = i.fields['command_args'];
  const { verb, argsSha256 } = normArgs(typeof args === 'string' ? args : '');
  if (!ACTING.has(verb)) return null;
  return { seat_key: seatKey, prompt_id: i.prompt_id, verb, args_sha256: argsSha256, mono_ns: monoNs.toString(), used: false };
}

/** A1-8: hex HMAC-SHA256(key, "evidence" ‖ canonicalJsonLine(r)) (09 §3.13 step 1). */
export function evidenceTag(key: Buffer, r: EvidenceRecord): string {
  return createHmac('sha256', key).update('evidence' + canonicalJsonLine({ ...r })).digest('hex');
}

// ---- buildPayload -------------------------------------------------------------------------------------------------------------------

/** target relative to root: the root's components compared by sameRoot's case rule (this process's platform), the rest kept in the target's
 *  spelling, '/' separators, NFC; null when outside the root (or the root itself). */
function repoRelative(target: string | null, root: string): string | null {
  if (target === null) return null;
  const t = target.normalize('NFC').split('/');
  const r = root.normalize('NFC').split('/');
  while (r.length > 1 && r[r.length - 1] === '') r.pop();
  if (t.length <= r.length) return null;
  for (let k = 0; k < r.length; k++) if (!sameRoot(t[k] as string, r[k] as string, process.platform)) return null;
  const rest = t.slice(r.length);
  return rest.some((c) => c === '' || c === '.' || c === '..') ? null : rest.join('/');
}

/** A dotted path inside a record ('file.numLines'). */
function at(o: unknown, dotted: string): unknown {
  let v = o;
  for (const k of dotted.split('.')) v = isRec(v) ? own(v, k) : undefined;
  return v;
}
const nonNegInt = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
const required = (v: string | null, what: string): string => (v === null ? fail(`${what} missing`) : v);

function editInput(ti: Rec): EditInput {
  const out: { -readonly [K in keyof EditInput]: EditInput[K] } = {};
  const s = (k: 'old_string' | 'new_string' | 'content'): void => {
    const v = own(ti, k);
    if (v !== undefined) out[k] = typeof v === 'string' ? v : fail(`tool_input.${k}`);
  };
  s('old_string');
  s('new_string');
  s('content');
  const ra = own(ti, 'replace_all');
  if (ra !== undefined) out.replace_all = typeof ra === 'boolean' ? ra : fail('tool_input.replace_all');
  const edits = own(ti, 'edits');
  if (edits !== undefined) {
    if (!Array.isArray(edits)) fail('tool_input.edits');
    out.edits = (edits as unknown[]).map((e) => {
      if (!isRec(e) || typeof own(e, 'old_string') !== 'string' || typeof own(e, 'new_string') !== 'string') return fail('tool_input.edits[]');
      const ra2 = own(e, 'replace_all');
      if (ra2 !== undefined && typeof ra2 !== 'boolean') fail('tool_input.edits[].replace_all');
      return { old_string: e['old_string'] as string, new_string: e['new_string'] as string, ...(ra2 === undefined ? {} : { replace_all: ra2 as boolean }) };
    });
  }
  const nb: { cell_id?: string; new_source?: string; cell_type?: string; edit_mode?: string } = {};
  for (const k of ['cell_id', 'new_source', 'cell_type', 'edit_mode'] as const) {
    const v = own(ti, k);
    if (v !== undefined) nb[k] = typeof v === 'string' ? v : fail(`tool_input.${k}`);
  }
  if (Object.keys(nb).length > 0) out.notebook = nb;
  return out;
}

const shellCommand = (i: HookInput): string | null => {
  if (i.tool_name !== 'Bash' && i.tool_name !== 'PowerShell') return null;
  const c = isRec(i.tool_input) ? own(i.tool_input, 'command') : undefined;
  return typeof c === 'string' ? c : null;
};

function readInfo(i: HookInput): ReadInfo | null {
  if (i.tool_name !== 'Read') return null;
  const ti = isRec(i.tool_input) ? i.tool_input : {};
  const offset = nonNegInt(own(ti, 'offset'));
  const limit = nonNegInt(own(ti, 'limit'));
  const truncated = at(i.tool_response, HOST_FIELDS.readTruncated) === true;
  return { offset, limit, full: offset === null && limit === null && !truncated, enoent: at(i.tool_response, HOST_FIELDS.readEnoent) === true,
    size: nonNegInt(at(i.tool_response, HOST_FIELDS.readSize)) };
}

function exitStatus(i: HookInput): number | null {
  for (const name of HOST_FIELDS.exitStatus) {
    const v = at(i.tool_response, name);
    if (Number.isSafeInteger(v)) return v as number;
  }
  return null;
}

const SOURCES: ReadonlySet<string> = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);

/** 06 §3.4.3: the frame payload; never copies prompt text, command_args, tool_response content or transcript content beyond the listed fields;
 *  path repo-relative POSIX NFC. A1-8: extra.target = the canonical absolute target path of an edit-class or Read call (core computes it with
 *  canonRoot + realRootProbe); path = target relative to repo.root (prefix compared by sameRoot's case rule, remainder kept in the target's
 *  on-disk spelling, '/' separators, NFC), null when outside the root; ids_in_last_message carries only idsInText tokens, never the message
 *  (CCI-09). A shape the payload cannot carry throws HookInputError. */
export function buildPayload(
  i: HookInput, repo: { root: string },
  extra: { messaging_present: boolean; static_policy_hits: PolicyHit[]; evidence: EvidenceRecord | null; target: string | null },
): HookPayload {
  const f = i.fields;
  switch (i.event) {
    case 'SessionStart': {
      const source = f['source'];
      if (typeof source !== 'string' || !SOURCES.has(source)) return fail('SessionStart source');
      return { event: 'SessionStart', source: source as 'startup', transcript_path: i.transcript_path, messaging_present: extra.messaging_present,
        static_policy_hits: extra.static_policy_hits };
    }
    case 'UserPromptSubmit':
      return { event: 'UserPromptSubmit', nonces: typeof f['prompt'] === 'string' ? nonces(f['prompt']) : [] };
    case 'UserPromptExpansion': {
      const name = f['command_name'];
      if (name !== 'cowork' && name !== 'cowork-sync:cowork') return fail('command_name');
      const args = f['command_args'];
      const { verb, argsSha256 } = normArgs(typeof args === 'string' ? args : '');
      const source = f['command_source'];
      return { event: 'UserPromptExpansion', command_name: name, verb, command_source: typeof source === 'string' ? source : null,
        args_sha256: argsSha256, nonces: typeof f['prompt'] === 'string' ? nonces(f['prompt']) : [], evidence: extra.evidence };
    }
    case 'PreToolUse': {
      const gating = gatingClass('PreToolUse', i.tool_name);
      const id = required(i.tool_use_id, 'tool_use_id');
      if (!isRec(i.tool_input)) return fail('tool_input');
      if (gating === 'edit') {
        const path = repoRelative(extra.target, repo.root);
        if (path === null) return fail('edit target outside the repo');
        return { event: 'PreToolUse', gating: 'edit', tool_name: i.tool_name as 'Edit', tool_use_id: id, path, tool_input: editInput(i.tool_input) };
      }
      if (gating === 'shell') {
        const command = own(i.tool_input, 'command');
        if (typeof command !== 'string') return fail('tool_input.command');
        return { event: 'PreToolUse', gating: 'shell', tool_name: i.tool_name as 'Bash', tool_use_id: id, command,
          run_in_background: own(i.tool_input, 'run_in_background') === true };
      }
      return fail('no payload for this PreToolUse');   // Agent|EnterWorktree are decided locally
    }
    case 'PostToolUse':
      return { event: 'PostToolUse', tool_name: required(i.tool_name, 'tool_name'), tool_use_id: required(i.tool_use_id, 'tool_use_id'),
        path: repoRelative(extra.target, repo.root), read: readInfo(i), exit_status: exitStatus(i), command: shellCommand(i) };
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return { event: i.event, tool_name: required(i.tool_name, 'tool_name'), tool_use_id: required(i.tool_use_id, 'tool_use_id'), command: shellCommand(i) };
    case 'PostToolBatch': {
      const ids = f['tool_use_ids'];
      if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) return fail('tool_use_ids');
      return { event: 'PostToolBatch', tool_use_ids: ids === undefined ? [] : [...(ids as string[])] };
    }
    case 'Stop':
    case 'SubagentStop': {
      const last = f[HOST_FIELDS.lastMessage];
      return { event: i.event, stop_hook_active: f['stop_hook_active'] === true, background_tasks_running: nonNegInt(f[HOST_FIELDS.backgroundTasks]) ?? 0,
        ids_in_last_message: typeof last === 'string' ? idsInText(last) : null };
    }
    case 'StopFailure':
    case 'SessionEnd':
      return { event: i.event, reason: typeof f['reason'] === 'string' ? f['reason'] : null };
    case 'SubagentStart':
      return { event: 'SubagentStart', agent_id: required(i.agent_id, 'agent_id'), agent_type: i.agent_type, cwd: i.cwd };
    case 'Notification': {
      const type = f[HOST_FIELDS.notificationType];
      if (type !== 'idle_prompt' && type !== 'permission_prompt') return fail('notification_type');
      return { event: 'Notification', type };
    }
    default:
      return fail('unknown event');
  }
}
