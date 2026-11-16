// src/claude/wire/frames.ts — 06 §3.4.3, glossary §13 (as superseded by §25 F1/F5), 09 §3.11 incl. the rev 2.5 CLI requests; R5-38, R5-45.
// Pure declarations: the hook ↔ daemon, MCP ↔ daemon, CLI ↔ daemon and handshake frames, the hook registrations and the verb lists.
// The client tier imports this module, so it reaches no engine-side type (L-HOOK-THIN): WireJson, CliMode, StatusHeartbeat,
// ClientMutantId and SinceMarks are wire-local structural copies pinned by type-level tests (X5-45).
import type { Params } from '../../i18n/render.js';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'UserPromptExpansion' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'PostToolBatch' | 'PermissionDenied' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'SessionEnd' | 'Notification';
export type EditTool = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';
export type ShellTool = 'Bash' | 'PowerShell' | 'Monitor';
export type GatingClass = 'edit' | 'shell' | 'agent' | null;   // 06 §2 "gating event"; agent = Agent|EnterWorktree (decided locally)

/** A1-1: the wire tier's JSON type, used wherever a wire or client-tier type carries arbitrary JSON (tool.args, acting.params, tool_result.structured,
 *  wrap_result.rows, HookInput.tool_input/tool_response, McpToolSchema.inputSchema, worktreeDenied's toolInput); Plan 2's Json lives in
 *  src/board/canonicalJson.ts, which the client tier must not reach (L-HOOK-THIN); a type-level test pins WireJson and Json mutually assignable
 *  (X5-45). Daemon-tier types keep Plan 2's Json. */
export type WireJson = null | boolean | number | string | WireJson[] | { [k: string]: WireJson };
/** A1-2: CliCaller.mode; Plan 8a declares OutputMode in src/viz/cli/view.ts, outside the wire tier's import set; a type-level test pins CliMode
 *  and OutputMode mutually assignable. */
export type CliMode = 'tty' | 'pipe' | 'slash';

/** A1-7: the 14 events of glossary §13 in its row order. */
export const HOOK_EVENTS: readonly HookEvent[] = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop',
  'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PermissionDenied', 'Notification',
] as const);

/** A1-7: glossary §13 as superseded by §25 F5 — the UserPromptExpansion matcher covers every verb; SessionEnd times out at 2 s, every other
 *  row at 10 s (Task 2's hooks/hooks.json test and L-HOOKS-JSON consume it). */
export const HOOK_REGISTRATIONS: ReadonlyArray<{ event: HookEvent; matcher: string | null; timeout: 10 | 2 }> = Object.freeze(([
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact|fork', timeout: 10 },
  { event: 'UserPromptSubmit', matcher: null, timeout: 10 },
  { event: 'UserPromptExpansion', matcher: 'cowork|cowork-sync:cowork', timeout: 10 },
  { event: 'PreToolUse', matcher: '^(Edit|Write|MultiEdit|NotebookEdit)$', timeout: 10 },
  { event: 'PreToolUse', matcher: '^(Bash|PowerShell|Monitor)$', timeout: 10 },
  { event: 'PreToolUse', matcher: '^(Agent|EnterWorktree)$', timeout: 10 },
  { event: 'PostToolUse', matcher: '.*', timeout: 10 },
  { event: 'PostToolUseFailure', matcher: '.*', timeout: 10 },
  { event: 'PostToolBatch', matcher: null, timeout: 10 },
  { event: 'Stop', matcher: null, timeout: 10 },
  { event: 'StopFailure', matcher: null, timeout: 10 },
  { event: 'SubagentStart', matcher: null, timeout: 10 },
  { event: 'SubagentStop', matcher: null, timeout: 10 },
  { event: 'SessionEnd', matcher: null, timeout: 2 },
  { event: 'PermissionDenied', matcher: '.*', timeout: 10 },
  { event: 'Notification', matcher: 'idle_prompt|permission_prompt', timeout: 10 },
] as const).map((r) => Object.freeze(r)));

/** CCI-52: this build's hook protocol (A1-7: the first); a daemon serves its current and previous (HOOK_PROTO − 1) value. */
export const HOOK_PROTO = 1 as const;

export interface HookHeader {
  seat_key: string; claude_pid: number; session_id: string; prompt_id: string | null; agent_id: string | null; agent_type: string | null;
  permission_mode: string; repo_root: string; plugin_version: string; hook_proto: number;
}
/** Daemon memory only (CCI-09). */
export interface EditInput {
  old_string?: string; new_string?: string; replace_all?: boolean; content?: string;
  edits?: ReadonlyArray<{ old_string: string; new_string: string; replace_all?: boolean }>;
  notebook?: { cell_id?: string; new_source?: string; cell_type?: string; edit_mode?: string };
}
/** F05 prerequisite; offset base per R5-50 (raw until the host check is recorded). */
export interface ReadInfo { offset: number | null; limit: number | null; full: boolean; enoent: boolean; size: number | null; }
/** 09 §2 (SE5-02). */
export interface EvidenceRecord { seat_key: string; prompt_id: string; verb: string; args_sha256: string; mono_ns: string; used: boolean; }
/** SEC-28/29: name and file; value = the JSON scalar or 'set'. */
export interface PolicyHit { setting: string; file: string; scope: 'managed' | 'user' | 'project' | 'local'; value: string; }

export type HookPayload =
  | { event: 'SessionStart'; source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'; transcript_path: string | null; messaging_present: boolean; static_policy_hits: PolicyHit[] }
  | { event: 'UserPromptSubmit'; nonces: string[] }                                                               // no other prompt text (CCI-54)
  | { event: 'UserPromptExpansion'; command_name: 'cowork' | 'cowork-sync:cowork'; verb: string; command_source: string | null;
      args_sha256: string; nonces: string[]; evidence: EvidenceRecord | null }                                    // R5-38 (args_sha256 and nonces: SE5-02)
  | { event: 'PreToolUse'; gating: 'edit'; tool_name: EditTool; tool_use_id: string; path: string; tool_input: EditInput }   // path repo-relative POSIX NFC
  | { event: 'PreToolUse'; gating: 'shell'; tool_name: ShellTool; tool_use_id: string; command: string; run_in_background: boolean }
  | { event: 'PostToolUse'; tool_name: string; tool_use_id: string; path: string | null; read: ReadInfo | null; exit_status: number | null; command: string | null }   // command: Bash|PowerShell only, for R5-23
  | { event: 'PostToolUseFailure' | 'PermissionDenied'; tool_name: string; tool_use_id: string; command: string | null }
  | { event: 'PostToolBatch'; tool_use_ids: string[] }
  | { event: 'Stop' | 'SubagentStop'; stop_hook_active: boolean; background_tasks_running: number; ids_in_last_message: string[] | null }   // null: host gave no last message (§8 Q7)
  | { event: 'StopFailure' | 'SessionEnd'; reason: string | null }
  | { event: 'SubagentStart'; agent_id: string; agent_type: string | null; cwd: string }
  | { event: 'Notification'; type: 'idle_prompt' | 'permission_prompt' };
export interface HookFrame { t: 'hook'; event: HookEvent; h: HookHeader; payload: HookPayload; }
export type CarrierDecision = 'deny' | 'block' | 'context' | 'none';
export interface ReplyFrame { t: 'reply'; batch_id: string; decision: CarrierDecision; text: string; system: string | null; events: string[]; cursor: number; }
/** SUSPECT only, ≤ 7,000, at most once per request (CCI-17). */
export interface ExtendFrame { t: 'extend'; deadline_ms: number; }
export interface PrintedFrame { t: 'printed'; batch_id: string; }
export interface McpHelloFrame {
  t: 'hello'; seat_id: string; seat_key: string; claude_pid: number; cc_version: string | null; plugin_version: string; hook_proto: number; messaging_present: boolean;
}
/** Glossary §15. */
export type ToolName = 'cowork_status' | 'cowork_show' | 'cowork_request' | 'cowork_respond' | 'cowork_note' | 'cowork_release' | 'cowork_checkpoint' | 'cowork_resolve';
/** Glossary §15 (rev 2.5: revert). */
export type ActingVerb = 'start' | 'stop' | 'pause' | 'resume' | 'save' | 'done' | 'resolve' | 'review' | 'revert' | 'release' | 'recover' | 'uninstall';
export const ACTING_VERBS: readonly ActingVerb[] = Object.freeze([
  'start', 'stop', 'pause', 'resume', 'save', 'done', 'resolve', 'review', 'revert', 'release', 'recover', 'uninstall',
] as const);
/** X-02: the grant survives only for FEAT-F04-18's since_ran (R5-14 as ruled by X-01). */
export const READ_ONLY_GRANT_VERBS = Object.freeze(['since'] as const);
/** SEC-25 step 3, 10 §2. */
export interface CliCaller { mode: CliMode; tty: boolean; ancestry_has_claude: boolean; verb: string; args_sha256: string; }
/** 09 §3.11; R5-57: detail 'section' = plain status's section 6 (its reply carries last_check: null), 'flow' = status --flow (its reply always
 *  carries last_check, X-01). The schema checks the path is a non-empty string without NUL; the daemon applies validPathSyntax and refuses
 *  FLOW_PATH_INVALID (R5-60). */
export type FlowSelector = { all: true; detail: 'section' | 'flow' } | { path: string };
/** 10 §3.5.1 --json shape; produced by FlowPort (Plan 7). */
export interface FlowEntryWire { path: string; dir: 'out' | 'in'; stage: string; code: string; params: Params; }
export interface LastCheckWire {
  cs: string; edit_n: number; kind: string; check?: number; path?: string; line?: number; skip?: string; more: number; last_code?: string; last_params?: Params;
}
/** X-01: last_check is an array (one slot per open seat CS that has one; possibly empty) for {all: true, detail: 'flow'} whoever asked, and null
 *  for detail 'section' and for a {path} selector; last_withheld = the reply holds an O10 entry and last_check is null (the CLI then prints
 *  UI_FLOW_LAST_WITHHELD once, Plan 7). */
export interface FlowResultFrame {
  t: 'flow_result'; tip_height: number; fetched_age_ms: number | null; entries: FlowEntryWire[]; omitted: number; last_check: LastCheckWire[] | null; last_withheld: boolean;
}
/** X-01: every wrap reply carries last_check (never null, never withheld), so the frame has no last_withheld field. */
export interface WrapResultFrame { t: 'wrap_result'; rows: WireJson; last_check: LastCheckWire[]; }
/** 01 §3.2 meta.since (R5-52). The wire copy: F04-a declares the engine's SinceMarks beside Meta (X5-03); Task 16 pins the two mutually
 *  assignable (X5-45). */
export interface SinceMarks { seen_h: number | null; return_h: number | null; run_h: number | null; }
/** A4-14: what core reads from status.json (06 §3.4.2 step 1), a wire-local shape so the client tier never imports Plan 2's StatusJson
 *  (L-HOOK-THIN); StatusJson is pinned assignable to it (X5-45). */
export interface StatusHeartbeat { heartbeat_mono_ms: number; loop_period_ms: number; state: string; }
/** A4-14, R5-64: the mutants whose switch lives in a client-tier process (loader, core, MCP server); a subset of MutantId pinned by a type-level
 *  test (X5-45; Task 1B). */
export type ClientMutantId = 'M08' | 'M26' | 'M27' | 'M45';
export interface SinceResultFrame {
  t: 'since_result'; marks: SinceMarks | null; records: Array<{ id: string; paths: string[]; state: string; offer: string }>; labels: Record<string, string>;
}
export type SessionClientFrame =
  | HookFrame | PrintedFrame | McpHelloFrame | { t: 'heartbeat' } | { t: 'seat_end' }
  | { t: 'ring_result'; nonce: string; result: 'sent' | 'refused' | 'error' }
  | { t: 'tool'; call_id: string; name: ToolName; args: WireJson }
  | ({ t: 'acting'; params: WireJson } & CliCaller)                               // R5-13
  | { t: 'flow'; selector: FlowSelector } | { t: 'wrap' }                         // X-01: no tty/ancestry fields — the daemon does not test who asked (09 §3.11)
  | { t: 'since_query' } | ({ t: 'since_ran'; to: number } & CliCaller)         // since_ran keeps the route-(a) fields and args_sha256 for the 'since' grant (X-02)
  | { t: 'slash_shown'; seat_key: string; chars: number };                       // R5-58: one-way, like since_ran (no reply frame); chars a non-negative integer
export type SessionServerFrame =
  | ReplyFrame | ExtendFrame
  | { t: 'ring'; event_ids: string[]; text: string; nonce: string }               // ≤ 1,500, never starts with '/'
  | { t: 'tool_result'; call_id: string; text: string; structured: WireJson }    // never isError (CCI-48)
  | { t: 'acting_result'; ok: boolean; code: string; params: Params; data?: WireJson }   // X-58: data carries Plan 7's previews, phases and single-use tokens
  | FlowResultFrame | WrapResultFrame | SinceResultFrame | { t: 'refused'; code: string };
/** SEC-22 (base64 fields). */
export type HandshakeFrame = { t: 'hello'; v: 1; n1: string } | { t: 'srv'; n2: string; p: string } | { t: 'cli'; p: string };
