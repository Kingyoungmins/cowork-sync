// src/claude/wire/schema.ts — SEC-22, R5-45: the IPC schema, keyed by (phase, direction, t). Before the handshake completes only
// hello{v,n1} / srv / cli are legal; after it only session frames, where `hello` is the MCP hello. An unknown t or any shape failure
// yields null and the caller closes the connection. A1-11: every built-in entry is a closed shape — an unknown key at any level fails,
// so a prompt, command_args, tool_response or transcript key can never ride a frame (09 test 8). Codes and typed params only (I18N-01).
import { C } from './constants.js';
import { MAX_DEPTH } from './ndjson.js';
import { ACTING_VERBS, READ_ONLY_GRANT_VERBS, type HandshakeFrame, type SessionClientFrame, type SessionServerFrame } from './frames.js';

export type Phase = 'handshake' | 'session';
type Dir = 'c2s' | 's2c';
type Check = (v: unknown) => boolean;

// ---- Combinators --------------------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};
const own = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A closed object: every required key present and valid, every optional key valid when present, no other key. */
function obj(required: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): Check {
  return (v) => {
    if (!isRecord(v)) return false;
    for (const k of Object.keys(v)) if (!own(required, k) && !own(optional, k)) return false;
    for (const [k, check] of Object.entries(required)) if (!own(v, k) || !check(v[k])) return false;
    for (const [k, check] of Object.entries(optional)) if (own(v, k) && !check(v[k])) return false;
    return true;
  };
}
const lit = (...values: readonly unknown[]): Check => (v) => values.includes(v);
const str: Check = (v) => typeof v === 'string';
const bool: Check = (v) => typeof v === 'boolean';
const int: Check = (v) => Number.isSafeInteger(v);
const nonNegInt: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const nonNegNum: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const re = (r: RegExp): Check => (v) => typeof v === 'string' && r.test(v);
const nullable = (c: Check): Check => (v) => v === null || c(v);
const arrOf = (c: Check, max = Infinity): Check => (v) => Array.isArray(v) && v.length <= max && v.every((x, i) => i in v && c(x));
const recordOf = (c: Check): Check => (v) => isRecord(v) && Object.values(v).every(c);
const and = (...cs: Check[]): Check => (v) => cs.every((c) => c(v));

/** Plan 2's depth bound, ndjson's MAX_DEPTH (a scalar is depth 0, a container 1 + its deepest member). */
function wireJsonAt(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return v.every((x, i) => i in v && wireJsonAt(x, depth + 1));
  return isRecord(v) && Object.values(v).every((x) => wireJsonAt(x, depth + 1));
}
const wireJson: Check = (v) => wireJsonAt(v, 1);
/** 8a's Params: a flat record of string, finite number or null. */
const params: Check = recordOf((x) => x === null || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)));

// ---- Field rules --------------------------------------------------------------------------------------------------------------------

const HEX64 = re(/^[0-9a-f]{64}$/);
/** Glossary §2: SHA-256 hex of the messaging socket name, else the claude pid. */
const SEAT_KEY = re(/^(?:[0-9a-f]{64}|[1-9][0-9]{0,9})$/);
const SEAT_ID = re(/^[0-9a-f]{32}$/);
const NONCE = re(/^cws-[0-9a-f]{16}$/);
const B64 = (bytes: number): Check => re(new RegExp(`^[A-Za-z0-9+/]{${4 * Math.floor(bytes / 3)}}${['', '[A-Za-z0-9+/]{2}==', '[A-Za-z0-9+/]{3}='][bytes % 3]}$`));
const NONCE_B64 = B64(C.HANDSHAKE_NONCE_BYTES);
const MAC_B64 = B64(32);
/** A non-empty string without NUL. */
const PATH_TEXT = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && !v.includes(String.fromCharCode(0));
/** 06 §3.4.3: repo-relative POSIX (no backslash, no leading '/'). */
const REPO_PATH = and(PATH_TEXT, (v) => !(v as string).includes('\\') && !(v as string).startsWith('/'));
const MODE = lit('tty', 'pipe', 'slash');
const EDIT_TOOL = lit('Edit', 'Write', 'MultiEdit', 'NotebookEdit');
const SHELL_TOOL = lit('Bash', 'PowerShell', 'Monitor');
const TOOL_NAME = lit('cowork_status', 'cowork_show', 'cowork_request', 'cowork_respond', 'cowork_note', 'cowork_release', 'cowork_checkpoint', 'cowork_resolve');
const HOOK_EVENT = lit('SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionDenied', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification');

/** REL-01 (11-testing.md): the plugin version is semver — exactly the grammar test/unit/version.test.ts pins for
 *  PLUGIN_VERSION, and every value it admits is one VersionPolicy's semverCompare parses (F2 #46, #101). */
const PLUGIN_SEMVER = re(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const HEADER = obj({
  seat_key: SEAT_KEY, claude_pid: nonNegInt, session_id: str, prompt_id: nullable(str), agent_id: nullable(str), agent_type: nullable(str),
  permission_mode: str, repo_root: str, plugin_version: PLUGIN_SEMVER, hook_proto: nonNegInt,
});
const EDIT_INPUT = obj({}, {
  old_string: str, new_string: str, replace_all: bool, content: str,
  edits: arrOf(obj({ old_string: str, new_string: str }, { replace_all: bool })),
  notebook: obj({}, { cell_id: str, new_source: str, cell_type: str, edit_mode: str }),
});
const READ_INFO = obj({ offset: nullable(nonNegInt), limit: nullable(nonNegInt), full: bool, enoent: bool, size: nullable(nonNegInt) });
/** 09 §2: exactly {seat_key, prompt_id, verb, args_sha256, mono_ns, used: false}; mono_ns a decimal string (C11, SE5-02). */
const EVIDENCE = obj({ seat_key: SEAT_KEY, prompt_id: str, verb: str, args_sha256: HEX64, mono_ns: re(/^(?:0|[1-9][0-9]*)$/), used: lit(false) });
const POLICY_HIT = obj({ setting: str, file: str, scope: lit('managed', 'user', 'project', 'local'), value: str });

/** 06 §3.4.3: one closed payload shape per event (PreToolUse: edit or shell; Agent|EnterWorktree never reach the daemon). */
const PAYLOADS: Readonly<Record<string, readonly Check[]>> = {
  SessionStart: [obj({ event: str, source: lit('startup', 'resume', 'clear', 'compact', 'fork'), transcript_path: nullable(str), messaging_present: bool,
    static_policy_hits: arrOf(POLICY_HIT) })],
  UserPromptSubmit: [obj({ event: str, nonces: arrOf(NONCE) })],
  UserPromptExpansion: [obj({ event: str, command_name: lit('cowork', 'cowork-sync:cowork'), verb: str, command_source: nullable(str), args_sha256: HEX64,
    nonces: arrOf(NONCE), evidence: nullable(EVIDENCE) })],
  PreToolUse: [
    obj({ event: str, gating: lit('edit'), tool_name: EDIT_TOOL, tool_use_id: str, path: REPO_PATH, tool_input: EDIT_INPUT }),
    obj({ event: str, gating: lit('shell'), tool_name: SHELL_TOOL, tool_use_id: str, command: str, run_in_background: bool }),
  ],
  PostToolUse: [obj({ event: str, tool_name: str, tool_use_id: str, path: nullable(REPO_PATH), read: nullable(READ_INFO), exit_status: nullable(int),
    command: nullable(str) })],
  PostToolUseFailure: [obj({ event: str, tool_name: str, tool_use_id: str, command: nullable(str) })],
  PermissionDenied: [obj({ event: str, tool_name: str, tool_use_id: str, command: nullable(str) })],
  PostToolBatch: [obj({ event: str, tool_use_ids: arrOf(str) })],
  Stop: [obj({ event: str, stop_hook_active: bool, background_tasks_running: nonNegInt, ids_in_last_message: nullable(arrOf(str)) })],
  SubagentStop: [obj({ event: str, stop_hook_active: bool, background_tasks_running: nonNegInt, ids_in_last_message: nullable(arrOf(str)) })],
  StopFailure: [obj({ event: str, reason: nullable(str) })],
  SessionEnd: [obj({ event: str, reason: nullable(str) })],
  SubagentStart: [obj({ event: str, agent_id: str, agent_type: nullable(str), cwd: str })],
  Notification: [obj({ event: str, type: lit('idle_prompt', 'permission_prompt') })],
};
const HOOK: Check = (v) => {
  if (!obj({ t: str, event: HOOK_EVENT, h: HEADER, payload: isRecord })(v)) return false;
  const f = v as { event: string; payload: Record<string, unknown> };
  return f.payload['event'] === f.event && (PAYLOADS[f.event] ?? []).some((c) => c(f.payload));
};

/** SEC-25 step 3: the CLI caller fields; verbOk narrows the verb per request kind. */
const callerFields = (verbOk: Check): Record<string, Check> => ({ mode: MODE, tty: bool, ancestry_has_claude: bool, verb: verbOk, args_sha256: HEX64 });
const LAST_CHECK = obj({ cs: str, edit_n: nonNegInt, kind: str, more: nonNegInt },
  { check: nonNegInt, path: str, line: nonNegInt, skip: str, last_code: str, last_params: params });
const FLOW_ENTRY = obj({ path: str, dir: lit('out', 'in'), stage: str, code: str, params });
const SINCE_MARKS = obj({ seen_h: nullable(nonNegInt), return_h: nullable(nonNegInt), run_h: nullable(nonNegInt) });

// ---- The registry -------------------------------------------------------------------------------------------------------------------

const registry = new Map<string, Check>();
const keyOf = (phase: Phase, dir: Dir, t: string): string => `${phase} ${dir} ${t}`;
/** A built-in kind: the closed shape plus t itself. */
function builtIn(phase: Phase, dir: Dir, t: string, required: Record<string, Check>, optional: Record<string, Check> = {}): void {
  registry.set(keyOf(phase, dir, t), obj({ t: lit(t), ...required }, optional));
}

// Handshake (09 §3.11): each nonce 16 random bytes, each proof an HMAC-SHA256, base64.
builtIn('handshake', 'c2s', 'hello', { v: lit(1), n1: NONCE_B64 });
builtIn('handshake', 'c2s', 'cli', { p: MAC_B64 });
builtIn('handshake', 's2c', 'srv', { n2: NONCE_B64, p: MAC_B64 });
// Session, client → daemon: the loader protocol, the MCP frames (glossary §13, 06 §3.4.3) and the rev 2.5 CLI requests (09 §3.11).
registry.set(keyOf('session', 'c2s', 'hook'), HOOK);
builtIn('session', 'c2s', 'printed', { batch_id: str });
builtIn('session', 'c2s', 'hello', { seat_id: SEAT_ID, seat_key: SEAT_KEY, claude_pid: nonNegInt, cc_version: nullable(str), plugin_version: PLUGIN_SEMVER,
  hook_proto: nonNegInt, messaging_present: bool });
builtIn('session', 'c2s', 'heartbeat', {});
builtIn('session', 'c2s', 'seat_end', {});
builtIn('session', 'c2s', 'ring_result', { nonce: NONCE, result: lit('sent', 'refused', 'error') });
builtIn('session', 'c2s', 'tool', { call_id: str, name: TOOL_NAME, args: wireJson });
builtIn('session', 'c2s', 'acting', { params: wireJson, ...callerFields(lit(...ACTING_VERBS)) });
builtIn('session', 'c2s', 'flow', { selector: (v) => obj({ all: lit(true), detail: lit('section', 'flow') })(v) || obj({ path: PATH_TEXT })(v) });
builtIn('session', 'c2s', 'wrap', {});
builtIn('session', 'c2s', 'since_query', {});
builtIn('session', 'c2s', 'since_ran', { to: nonNegInt, ...callerFields(lit(...READ_ONLY_GRANT_VERBS)) });
builtIn('session', 'c2s', 'slash_shown', { seat_key: SEAT_KEY, chars: nonNegInt });
// Session, daemon → client.
builtIn('session', 's2c', 'reply', { batch_id: str, decision: lit('deny', 'block', 'context', 'none'), text: str, system: nullable(str), events: arrOf(str),
  cursor: nonNegInt });
builtIn('session', 's2c', 'extend', { deadline_ms: (v) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= C.SUSPECT_DEADLINE_MAX_MS });
builtIn('session', 's2c', 'ring', { event_ids: arrOf(str), text: (v) => typeof v === 'string' && v.length <= C.CAPS.DOORBELL, nonce: NONCE });
builtIn('session', 's2c', 'tool_result', { call_id: str, text: str, structured: wireJson });
builtIn('session', 's2c', 'acting_result', { ok: bool, code: str, params }, { data: wireJson });
builtIn('session', 's2c', 'flow_result', { tip_height: nonNegInt, fetched_age_ms: nullable(nonNegNum), entries: arrOf(FLOW_ENTRY, C.FLOW_MAX_ENTRIES),
  omitted: nonNegInt, last_check: nullable(arrOf(LAST_CHECK)), last_withheld: bool });
builtIn('session', 's2c', 'wrap_result', { rows: wireJson, last_check: arrOf(LAST_CHECK) });
builtIn('session', 's2c', 'since_result', { marks: nullable(SINCE_MARKS), records: arrOf(obj({ id: str, paths: arrOf(str), state: str, offer: str })),
  labels: recordOf(str) });
builtIn('session', 's2c', 'refused', { code: str });

/** One decoded frame against the schema for (phase, direction, t); unknown t or a shape failure → null and the caller closes the connection. */
export function validateFrame(phase: Phase, dir: Dir, v: unknown): HandshakeFrame | SessionClientFrame | SessionServerFrame | null {
  if (!isRecord(v) || !own(v, 't') || typeof v['t'] !== 'string') return null;
  const check = registry.get(keyOf(phase, dir, v['t']));
  return check !== undefined && check(v) ? (v as unknown as HandshakeFrame | SessionClientFrame | SessionServerFrame) : null;
}

/** Plans 6/7 add session request kinds (09 §3.11 "others unchanged"); throws on a (dir, t) already registered in either phase. The check owns
 *  its shape (keep it closed, A1-11). */
export function registerFrameKind(dir: Dir, t: string, check: (v: unknown) => boolean): void {
  if (typeof t !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(t)) throw new Error(`registerFrameKind: ${String(t)} is not a frame kind name`);
  if (registry.has(keyOf('handshake', dir, t)) || registry.has(keyOf('session', dir, t))) {
    throw new Error(`registerFrameKind: ${dir} ${t} is already registered`);
  }
  registry.set(keyOf('session', dir, t), check);
}

/** A1-11: tests and Plans 6/7 read the registry. */
export function registeredKinds(): ReadonlyArray<{ phase: Phase; dir: Dir; t: string }> {
  return [...registry.keys()].map((k) => {
    const [phase, dir, t] = k.split(' ') as [Phase, Dir, string];
    return { phase, dir, t };
  });
}
