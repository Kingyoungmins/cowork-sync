// Plan 5 Task 1: frames and the phase-keyed IPC schema (R1-301…R1-305, R2-K5, R5-38, R5-45, R5-57, R5-58; 09 §3.11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredKinds, registerFrameKind, validateFrame } from '../../src/claude/wire/schema.js';
import { FrameTooLarge, LineReader, MAX_DEPTH } from '../../src/claude/wire/ndjson.js';

const HEX64 = 'a'.repeat(64);
const SEAT_ID = '0123456789abcdef0123456789abcdef';
const NONCE = 'cws-0123456789abcdef';
const B64_16 = Buffer.alloc(16, 7).toString('base64');   // 24 characters
const B64_32 = Buffer.alloc(32, 9).toString('base64');   // 44 characters
const NUL = String.fromCharCode(0);

const header = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  seat_key: HEX64, claude_pid: 4242, session_id: 's1', prompt_id: 'p1', agent_id: null, agent_type: null,
  permission_mode: 'default', repo_root: 'c:/Users/Me/repo', plugin_version: '0.6.0', hook_proto: 1, ...o,
});
const hook = (event: string, payload: Record<string, unknown>, h: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ t: 'hook', event, h: header(h), payload: { event, ...payload } });
const evidence = (o: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ seat_key: HEX64, prompt_id: 'p1', verb: 'save', args_sha256: HEX64, mono_ns: '123456789', used: false, ...o });
const caller = { mode: 'slash', tty: false, ancestry_has_claude: true, verb: 'done', args_sha256: HEX64 };

/** One valid frame per 06 §3.4.3 payload row. */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  SessionStart: hook('SessionStart', { source: 'compact', transcript_path: '/t/x.jsonl', messaging_present: true,
    static_policy_hits: [{ setting: 'disableAllHooks', file: '/etc/claude/managed-settings.json', scope: 'managed', value: 'true' }] }),
  UserPromptSubmit: hook('UserPromptSubmit', { nonces: [NONCE] }),
  UserPromptExpansion: hook('UserPromptExpansion', { command_name: 'cowork', verb: 'save', command_source: 'plugin', args_sha256: HEX64, nonces: [], evidence: evidence() }),
  'PreToolUse edit': hook('PreToolUse', { gating: 'edit', tool_name: 'MultiEdit', tool_use_id: 'tu1', path: 'src/a.ts',
    tool_input: { edits: [{ old_string: 'a', new_string: 'b', replace_all: true }], notebook: { cell_id: 'c1' } } }),
  'PreToolUse shell': hook('PreToolUse', { gating: 'shell', tool_name: 'Bash', tool_use_id: 'tu2', command: 'npm test', run_in_background: false }),
  'PostToolUse read': hook('PostToolUse', { tool_name: 'Read', tool_use_id: 'tu3', path: 'src/a.ts',
    read: { offset: 100, limit: 50, full: false, enoent: false, size: null }, exit_status: null, command: null }),
  'PostToolUse no read': hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu4', path: null, read: null, exit_status: 0, command: 'npm test' }),
  PostToolUseFailure: hook('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu5', command: 'npm test' }),
  PermissionDenied: hook('PermissionDenied', { tool_name: 'Edit', tool_use_id: 'tu6', command: null }),
  PostToolBatch: hook('PostToolBatch', { tool_use_ids: ['tu1', 'tu2'] }),
  Stop: hook('Stop', { stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: ['src/a.ts'] }),
  SubagentStop: hook('SubagentStop', { stop_hook_active: true, background_tasks_running: 2, ids_in_last_message: null }, { agent_id: 'ag1', agent_type: 'Explore' }),
  StopFailure: hook('StopFailure', { reason: null }),
  SessionEnd: hook('SessionEnd', { reason: 'clear' }),
  SubagentStart: hook('SubagentStart', { agent_id: 'ag1', agent_type: null, cwd: 'c:/Users/Me/repo' }),
  Notification: hook('Notification', { type: 'permission_prompt' }),
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const s2c = (v: unknown): unknown => validateFrame('session', 's2c', v);
const c2s = (v: unknown): unknown => validateFrame('session', 'c2s', v);

test('registeredKinds is the handshake set, the glossary §13 / 06 §3.4.3 session set and the rev 2.5 CLI requests', () => {
  const key = (k: { phase: string; dir: string; t: string }): string => `${k.phase} ${k.dir} ${k.t}`;
  const want = [
    ...['hello', 'cli'].map((t) => `handshake c2s ${t}`), 'handshake s2c srv',
    ...['hook', 'printed', 'hello', 'heartbeat', 'seat_end', 'ring_result', 'tool', 'acting', 'flow', 'wrap', 'since_query', 'since_ran', 'slash_shown'].map((t) => `session c2s ${t}`),
    ...['reply', 'extend', 'ring', 'tool_result', 'acting_result', 'flow_result', 'wrap_result', 'since_result', 'refused'].map((t) => `session s2c ${t}`),
  ];
  assert.deepEqual(registeredKinds().map(key).sort(), want.sort());
});

test('validateFrame closes on an unknown t, a schema failure, a session frame in the handshake phase and a 1,048,577-byte line', () => {
  assert.equal(c2s({ t: 'frobnicate' }), null);
  assert.equal(c2s(hook('Notification', { type: 'idle_prompt' }, { seat_key: 5 })), null);
  const valid = PAYLOADS['UserPromptSubmit']!;
  assert.notEqual(c2s(valid), null);
  assert.equal(validateFrame('handshake', 'c2s', valid), null);
  // The handshake hello is legal only before the handshake; the session hello is the MCP frame (R5-45).
  const hello = { t: 'hello', v: 1, n1: B64_16 };
  assert.equal(B64_16.length, 24);
  assert.deepEqual(validateFrame('handshake', 'c2s', hello), hello);
  assert.equal(c2s(hello), null);
  assert.notEqual(validateFrame('handshake', 's2c', { t: 'srv', n2: B64_16, p: B64_32 }), null);
  assert.notEqual(validateFrame('handshake', 'c2s', { t: 'cli', p: B64_32 }), null);
  assert.equal(validateFrame('handshake', 'c2s', { t: 'hello', v: 2, n1: B64_16 }), null);
  assert.equal(validateFrame('handshake', 'c2s', { t: 'hello', v: 1, n1: 'short' }), null);
  assert.equal(validateFrame('handshake', 'c2s', { t: 'cli', p: B64_32, extra: 1 }), null);
  assert.equal(validateFrame('handshake', 's2c', { t: 'cli', p: B64_32 }), null);
  for (const bad of [null, 1, 'x', [], [valid], { t: 1 }, Object.create({ t: 'heartbeat' })]) assert.equal(c2s(bad), null);
  // The 1 MiB frame cap (SEC-22).
  assert.throws(() => new LineReader().push(Buffer.alloc(1_048_577, 0x61)), FrameTooLarge);
  const lines = new LineReader().push(Buffer.concat([Buffer.alloc(1_048_576, 0x61), Buffer.from('\n')]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.length, 1_048_576);
});

test('every hook payload shape of 06 §3.4.3 validates, and nothing outside it', () => {
  for (const [name, f] of Object.entries(PAYLOADS)) assert.deepEqual(c2s(f), f, name);
  const withPayload = (name: string, add: Record<string, unknown>): unknown => {
    const f = clone(PAYLOADS[name]!);
    Object.assign(f['payload'] as object, add);
    return f;
  };
  assert.equal(c2s(withPayload('UserPromptSubmit', { prompt: 'x' })), null);
  assert.equal(c2s(withPayload('UserPromptExpansion', { command_args: 'save x' })), null);
  assert.equal(c2s(withPayload('PostToolUse no read', { tool_response: {} })), null);
  for (const [name, f] of Object.entries(PAYLOADS)) {
    assert.equal(c2s(withPayload(name, { transcript: 'x' })), null, `${name} payload`);
    assert.equal(c2s({ ...clone(f), transcript: 'x' }), null, `${name} frame`);
    const h = clone(f);
    (h['h'] as Record<string, unknown>)['transcript'] = 'x';
    assert.equal(c2s(h), null, `${name} header`);
  }
  // The payload event names the frame event; a PreToolUse payload is edit or shell (agent is decided locally).
  assert.equal(c2s({ ...clone(PAYLOADS['Stop']!), event: 'SubagentStop' }), null);
  assert.equal(c2s(withPayload('PreToolUse shell', { gating: 'agent' })), null);
  assert.equal(c2s(withPayload('PreToolUse edit', { tool_name: 'Bash' })), null);
  // seat_key: 64 lowercase hex or a pid.
  for (const k of [HEX64, '4242', '1', '1234567890']) assert.notEqual(c2s(hook('Notification', { type: 'idle_prompt' }, { seat_key: k })), null, k);
  for (const k of ['A'.repeat(64), 'a'.repeat(63), '0', '01', '12345678901', '', 'x']) assert.equal(c2s(hook('Notification', { type: 'idle_prompt' }, { seat_key: k })), null, k);
  // Paths are repo-relative POSIX.
  for (const p of ['src\\a.ts', '/src/a.ts', '', `a${NUL}b`]) {
    assert.equal(c2s(withPayload('PreToolUse edit', { path: p })), null, p);
    assert.equal(c2s(withPayload('PostToolUse read', { path: p })), null, p);
  }
  // Closed nested shapes: tool_input, edits[], notebook, read, static_policy_hits[].
  assert.equal(c2s(withPayload('PreToolUse edit', { tool_input: { file_path: '/x' } })), null);
  assert.equal(c2s(withPayload('PreToolUse edit', { tool_input: { edits: [{ old_string: 'a', new_string: 'b', x: 1 }] } })), null);
  assert.equal(c2s(withPayload('PreToolUse edit', { tool_input: { notebook: { source: 'x' } } })), null);
  assert.equal(c2s(withPayload('PostToolUse read', { read: { offset: 1, limit: 1, full: false, enoent: false, size: null, content: 'x' } })), null);
  assert.equal(c2s(withPayload('SessionStart', { static_policy_hits: [{ setting: 's', file: 'f', scope: 'team', value: 'v' }] })), null);
  assert.equal(c2s(withPayload('UserPromptSubmit', { nonces: ['cws-0123456789ABCDEF'] })), null);
  assert.equal(c2s(withPayload('Notification', { type: 'auth_success' })), null);
});

test('UserPromptExpansion carries args_sha256 and nonces[] for every verb; the evidence record has exactly the 09 §2 fields', () => {
  const flow = hook('UserPromptExpansion', { command_name: 'cowork', verb: 'status', command_source: 'plugin', args_sha256: HEX64, nonces: [], evidence: null });
  assert.deepEqual(c2s(flow), flow);
  for (const drop of ['args_sha256', 'nonces']) {
    const f = clone(flow);
    delete (f['payload'] as Record<string, unknown>)[drop];
    assert.equal(c2s(f), null, drop);
  }
  const withEvidence = (e: Record<string, unknown>): unknown => {
    const f = clone(PAYLOADS['UserPromptExpansion']!);
    (f['payload'] as Record<string, unknown>)['evidence'] = e;
    return f;
  };
  assert.notEqual(c2s(withEvidence(evidence())), null);
  assert.equal(c2s(withEvidence(evidence({ command_name: 'cowork' }))), null);
  for (const mono of ['12.5', '-1', '1e9', 'x', '', '01']) assert.equal(c2s(withEvidence(evidence({ mono_ns: mono }))), null, mono);
  assert.equal(c2s(withEvidence(evidence({ mono_ns: 123 }))), null);
  assert.equal(c2s(withEvidence(evidence({ used: true }))), null);
  assert.equal(c2s(withEvidence(evidence({ args_sha256: 'A'.repeat(64) }))), null);
  const other = clone(PAYLOADS['UserPromptExpansion']!);
  (other['payload'] as Record<string, unknown>)['command_name'] = 'other';
  assert.equal(c2s(other), null);
});

test('daemon → hook frames: extend ≤ 7,000, reply decisions closed', () => {
  assert.notEqual(s2c({ t: 'extend', deadline_ms: 7000 }), null);
  for (const d of [7001, 0, -1, 1.5, '7000']) assert.equal(s2c({ t: 'extend', deadline_ms: d }), null, String(d));
  const reply = (o: Record<string, unknown>): Record<string, unknown> => ({ t: 'reply', batch_id: 'b1', decision: 'none', text: '', system: null, events: [], cursor: 0, ...o });
  for (const d of ['deny', 'block', 'context', 'none']) assert.notEqual(s2c(reply({ decision: d })), null, d);
  assert.equal(s2c(reply({ decision: 'allow' })), null);
  assert.notEqual(s2c(reply({ system: 'mirror' })), null);
  assert.equal(s2c(reply({ events: [1] })), null);
  assert.notEqual(s2c(reply({ events: ['e1', 'e2'] })), null);
  assert.equal(s2c(reply({ permissionDecisionX: 1 })), null);
  assert.equal(c2s(reply({})), null, 'a reply is a server frame');
  assert.notEqual(c2s({ t: 'printed', batch_id: 'b1' }), null);
  assert.equal(c2s({ t: 'printed' }), null);
});

test('MCP frames: hello seat_id is 32 hex, ring nonce is cws- + 16 hex, ring text ≤ 1,500, ring_result values sent|refused|error', () => {
  const hello = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ t: 'hello', seat_id: SEAT_ID, seat_key: HEX64, claude_pid: 4242,
    cc_version: '2.1.270', plugin_version: '0.6.0', hook_proto: 1, messaging_present: true, ...o });
  assert.notEqual(c2s(hello()), null);
  assert.notEqual(c2s(hello({ cc_version: null })), null);
  assert.equal(c2s(hello({ seat_id: SEAT_ID.slice(1) })), null);
  assert.equal(c2s(hello({ seat_id: SEAT_ID.toUpperCase() })), null);
  assert.notEqual(c2s({ t: 'heartbeat' }), null);
  assert.notEqual(c2s({ t: 'seat_end' }), null);
  assert.equal(c2s({ t: 'heartbeat', n: 1 }), null);
  const ring = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ t: 'ring', event_ids: ['e1'], text: `doorbell ${NONCE}`, nonce: NONCE, ...o });
  assert.notEqual(s2c(ring()), null);
  assert.equal(s2c(ring({ nonce: 'cws-0123456789ABCDEF' })), null);
  assert.notEqual(s2c(ring({ text: 'x'.repeat(1_500) })), null);
  assert.equal(s2c(ring({ text: 'x'.repeat(1_501) })), null);
  assert.notEqual(s2c(ring({ text: '/cowork save x' })), null, 'the MCP server refuses to post it (06 §3.16.5), not the schema');
  for (const r of ['sent', 'refused', 'error']) assert.notEqual(c2s({ t: 'ring_result', nonce: NONCE, result: r }), null, r);
  for (const r of ['accepted', 'held', 'timeout']) assert.equal(c2s({ t: 'ring_result', nonce: NONCE, result: r }), null, r);
  assert.notEqual(c2s({ t: 'tool', call_id: 'c1', name: 'cowork_show', args: { id: ['a', 'b'] } }), null);
  assert.equal(c2s({ t: 'tool', call_id: 'c1', name: 'cowork_override', args: {} }), null);
  assert.notEqual(s2c({ t: 'tool_result', call_id: 'c1', text: 'ok', structured: { ok: true } }), null);
  assert.equal(s2c({ t: 'tool_result', call_id: 'c1', text: 'ok', structured: { ok: true }, isError: true }), null);
});

test('plugin_version is semver in the hook header and the MCP hello (REL-01; F2 #46, #101)', () => {
  const ss = (v: string): Record<string, unknown> => hook('SessionStart',
    { source: 'startup', transcript_path: null, messaging_present: true, static_policy_hits: [] }, { plugin_version: v });
  const hello = (v: string): Record<string, unknown> => ({ t: 'hello', seat_id: SEAT_ID, seat_key: HEX64, claude_pid: 4242,
    cc_version: '2.1.270', plugin_version: v, hook_proto: 1, messaging_present: true });
  for (const bad of ['1.2', '0.2.0+build.1', 'dev', '', 'v1.0.0']) {
    assert.equal(c2s(ss(bad)), null, `hook header ${JSON.stringify(bad)}`);
    assert.equal(c2s(hello(bad)), null, `hello ${JSON.stringify(bad)}`);
  }
  for (const good of ['0.6.0', '0.1.0-preview', '1.0.0-rc.1']) {
    assert.notEqual(c2s(ss(good)), null, `hook header ${good}`);
    assert.notEqual(c2s(hello(good)), null, `hello ${good}`);
  }
});

test('rev 2.5 CLI requests: flow selector, wrap, since_query, since_ran, slash_shown', () => {
  assert.notEqual(c2s({ t: 'flow', selector: { all: true, detail: 'flow' } }), null);
  assert.notEqual(c2s({ t: 'flow', selector: { all: true, detail: 'section' } }), null);
  assert.notEqual(c2s({ t: 'wrap' }), null);
  for (const [k, v] of Object.entries(caller)) {
    assert.equal(c2s({ t: 'flow', selector: { all: true, detail: 'flow' }, [k]: v }), null, `flow ${k}`);
    assert.equal(c2s({ t: 'wrap', [k]: v }), null, `wrap ${k}`);
  }
  assert.equal(c2s({ t: 'flow', selector: { all: true } }), null);
  assert.equal(c2s({ t: 'flow', selector: { all: true, detail: 'full' } }), null);
  assert.equal(c2s({ t: 'flow', selector: { all: false } }), null);
  assert.equal(c2s({ t: 'flow', selector: { all: false, detail: 'flow' } }), null);
  assert.notEqual(c2s({ t: 'flow', selector: { path: 'src/a.ts' } }), null);
  for (const p of ['', `a${NUL}b`]) assert.equal(c2s({ t: 'flow', selector: { path: p } }), null, JSON.stringify(p));
  assert.equal(c2s({ t: 'flow', selector: { path: 'a', all: true } }), null);
  assert.notEqual(c2s({ t: 'since_query' }), null);
  const ran = { t: 'since_ran', to: 12, ...caller, verb: 'since' };
  assert.notEqual(c2s(ran), null);
  for (const k of ['mode', 'tty', 'ancestry_has_claude', 'verb', 'args_sha256']) {
    const f: Record<string, unknown> = { ...ran };
    delete f[k];
    assert.equal(c2s(f), null, `since_ran without ${k}`);
  }
  for (const to of [-1, 1.5, '3']) assert.equal(c2s({ ...ran, to }), null, String(to));
  assert.notEqual(c2s({ ...ran, to: 0 }), null);
  assert.equal(c2s({ ...ran, verb: 'save' }), null, 'since_ran is the since grant only (X-02)');
  assert.notEqual(c2s({ t: 'slash_shown', seat_key: HEX64, chars: 1234 }), null);
  for (const chars of [-1, 1.5]) assert.equal(c2s({ t: 'slash_shown', seat_key: HEX64, chars }), null, String(chars));
  // flow_result: ≤ 2,000 entries (FEAT-F14-05), with the omitted count.
  const entry = { path: 'src/a.ts', dir: 'out', stage: 'O10', code: 'UI_FLOW_X', params: { n: 1, s: 'x', z: null } };
  const flowResult = (o: Record<string, unknown>): Record<string, unknown> =>
    ({ t: 'flow_result', tip_height: 7, fetched_age_ms: 1200, entries: [], omitted: 0, last_check: null, last_withheld: false, ...o });
  assert.notEqual(s2c(flowResult({ entries: Array.from({ length: 2_000 }, () => entry), omitted: 1000 })), null);
  assert.equal(s2c(flowResult({ entries: Array.from({ length: 2_001 }, () => entry) })), null);
  assert.notEqual(s2c(flowResult({ last_check: [{ cs: 'cs1', edit_n: 3, kind: 'fail', check: 2, path: 'src/a.ts', line: 9, more: 0, last_code: 'X_Y', last_params: { line: 9 } }] })), null);
  assert.equal(s2c(flowResult({ last_check: [{ cs: 'cs1', edit_n: 3, kind: 'fail', more: 0, text: 'x' }] })), null);
  // wrap_result: rows any WireJson, last_check always an array, no last_withheld.
  assert.notEqual(s2c({ t: 'wrap_result', rows: [{ a: [1, null] }, 'x'], last_check: [] }), null);
  assert.equal(s2c({ t: 'wrap_result', rows: [], last_check: [], last_withheld: false }), null);
  assert.equal(s2c({ t: 'wrap_result', rows: [], last_check: null }), null);
  // rows is bounded by ndjson's MAX_DEPTH (Plan 2's depth bound): MAX_DEPTH nested containers pass, one more fails.
  let deepRows: unknown = 0;
  for (let i = 0; i < MAX_DEPTH; i++) deepRows = [deepRows];
  assert.notEqual(s2c({ t: 'wrap_result', rows: deepRows, last_check: [] }), null);
  assert.equal(s2c({ t: 'wrap_result', rows: [deepRows], last_check: [] }), null);
  assert.notEqual(s2c({ t: 'since_result', marks: { seen_h: 1, return_h: null, run_h: null }, records: [{ id: 'h1', paths: ['a'], state: 'ON_DISK', offer: 'none' }], labels: { c1: 'foo()' } }), null);
  assert.notEqual(s2c({ t: 'since_result', marks: null, records: [], labels: {} }), null);
  assert.equal(s2c({ t: 'since_result', marks: { seen_h: -1, return_h: null, run_h: null }, records: [], labels: {} }), null);
  assert.notEqual(s2c({ t: 'refused', code: 'FLOW_PATH_INVALID' }), null);
  // acting: the CliCaller fields and an acting verb (R5-13).
  assert.notEqual(c2s({ t: 'acting', params: { id: 'h1', verb: '--publish' }, ...caller, verb: 'resolve' }), null);
  assert.equal(c2s({ t: 'acting', params: {}, ...caller, verb: 'override' }), null);
  assert.equal(c2s({ t: 'acting', params: {}, ...caller, mode: 'json' }), null);
  assert.notEqual(s2c({ t: 'acting_result', ok: true, code: 'X', params: {}, data: { preview: [1, 2], token: 't' } }), null);
  assert.notEqual(s2c({ t: 'acting_result', ok: false, code: 'SEC_REFUSE_NOT_HUMAN', params: { verb: 'save' } }), null);
  assert.equal(s2c({ t: 'acting_result', ok: false, code: 'X', params: { nested: { a: 1 } } }), null);
});

test('registerFrameKind adds a Plans 6/7 kind and refuses a duplicate', () => {
  registerFrameKind('c2s', 'canary_arm', (v) => typeof (v as { nonce?: unknown }).nonce === 'string');
  assert.deepEqual(validateFrame('session', 'c2s', { t: 'canary_arm', nonce: 'x' }), { t: 'canary_arm', nonce: 'x' });
  assert.equal(validateFrame('session', 'c2s', { t: 'canary_arm', nonce: 1 }), null);
  assert.equal(validateFrame('handshake', 'c2s', { t: 'canary_arm', nonce: 'x' }), null);
  assert.equal(validateFrame('session', 's2c', { t: 'canary_arm', nonce: 'x' }), null);
  assert.throws(() => registerFrameKind('c2s', 'hook', () => true));
  assert.throws(() => registerFrameKind('c2s', 'canary_arm', () => true));
  assert.throws(() => registerFrameKind('s2c', 'srv', () => true));
  assert.ok(registeredKinds().some((k) => k.phase === 'session' && k.dir === 'c2s' && k.t === 'canary_arm'));
});
