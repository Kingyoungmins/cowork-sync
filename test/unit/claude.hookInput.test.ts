// Plan 5 Task 1: the host's hook JSON → the frame payload (R1-301, R1-304, F05-01, C11, C16; 06 §3.4.3; 09 §2, §3.13; SEC-25, SEC-26).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import {
  buildPayload, COWORK_ID_RE, evidenceFor, evidenceTag, HookInputError, HOST_FIELDS, idsInText, NONCE_RE, nonces, normArgs, parseHookInput, seatKeyOf,
  type HookInput,
} from '../../src/claude/wire/hookInput.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { validateFrame } from '../../src/claude/wire/schema.js';
import type { HookEvent } from '../../src/claude/wire/frames.js';

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'hooks');
const CANARY = 'COWORK_CANARY_P5';
const ROOT = '/home/me/repo';
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const K1 = sha256hex('\\\\.\\pipe\\LOCAL\\cc-msg-k1');
const extra = (target: string | null = null): Parameters<typeof buildPayload>[2] =>
  ({ messaging_present: true, static_policy_hits: [], evidence: null, target });
const base = { session_id: 's1', transcript_path: '/t/s1.jsonl', cwd: ROOT, permission_mode: 'default', prompt_id: 'p1' };
const input = (event: HookEvent, o: Record<string, unknown>): HookInput => parseHookInput(event, { ...base, hook_event_name: event, ...o });
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

function fixtures(): Array<{ name: string; json: Record<string, unknown> }> {
  return readdirSync(FIXTURES).filter((n) => n.endsWith('.json')).sort()
    .map((n) => ({ name: n, json: JSON.parse(readFileSync(join(FIXTURES, n), 'utf8')) as Record<string, unknown> }));
}

/** The canary in every free-text host field and in an unlisted field at every level a fixture has. */
function plant(json: Record<string, unknown>): Record<string, unknown> {
  const j = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  j['prompt'] = `please ${CANARY} cws-0123456789abcdef`;
  if (j['hook_event_name'] === 'UserPromptExpansion') {
    j['prompt'] = `/cowork save ${CANARY}`;
    j['command_args'] = `save ${CANARY} "${CANARY} two"`;
  } else {
    j['command_args'] = CANARY;
  }
  const resp = typeof j['tool_response'] === 'object' && j['tool_response'] !== null ? j['tool_response'] as Record<string, unknown> : {};
  resp['stdout'] = CANARY;
  resp['content'] = CANARY;
  resp['x_unlisted'] = CANARY;
  if (typeof resp['file'] === 'object' && resp['file'] !== null) (resp['file'] as Record<string, unknown>)['content'] = CANARY;
  j['tool_response'] = resp;
  if (typeof j['tool_input'] === 'object' && j['tool_input'] !== null) (j['tool_input'] as Record<string, unknown>)['description'] = CANARY;
  j['last_assistant_message'] = `done ${CANARY} src/a.ts`;
  j['message'] = CANARY;
  j['error'] = CANARY;
  j['x_unlisted'] = { nested: CANARY };
  return j;
}

test('buildPayload never carries prompt text, command_args, tool_response content or transcript content; UserPromptSubmit carries only nonces[]', () => {
  const seen = new Set<string>();
  for (const { name, json } of fixtures()) {
    const event = json['hook_event_name'] as HookEvent;
    seen.add(event);
    const planted = plant(json);
    const i = parseHookInput(event, planted);
    const ti = (planted['tool_input'] ?? {}) as Record<string, unknown>;
    const target = typeof ti['file_path'] === 'string' ? ti['file_path'] : typeof ti['notebook_path'] === 'string' ? ti['notebook_path'] : null;
    const payload = buildPayload(i, { root: ROOT }, extra(target as string | null));
    assert.equal(payload.event, event, name);
    assert.equal(count(JSON.stringify(payload), CANARY), 0, name);
    // The payload is a frame the schema admits (buildPayload and the closed schema agree).
    const h = { seat_key: K1, claude_pid: 4242, session_id: i.session_id, prompt_id: i.prompt_id, agent_id: i.agent_id, agent_type: i.agent_type,
      permission_mode: i.permission_mode, repo_root: ROOT, plugin_version: '0.6.0', hook_proto: 1 };
    assert.notEqual(validateFrame('session', 'c2s', { t: 'hook', event, h, payload }), null, name);
  }
  assert.equal(seen.size, 14, 'one fixture per hook event');
  const ups = buildPayload(input('UserPromptSubmit', { prompt: `please ${CANARY} cws-0123456789abcdef` }), { root: ROOT }, extra());
  assert.deepEqual(ups, { event: 'UserPromptSubmit', nonces: ['cws-0123456789abcdef'] });
  const start = buildPayload(input('SessionStart', { source: 'resume', transcript_path: '/t/x.jsonl' }), { root: ROOT },
    { messaging_present: false, static_policy_hits: [{ setting: 'disableAllHooks', file: '/etc/m.json', scope: 'managed', value: 'true' }], evidence: null, target: null });
  assert.deepEqual(start, { event: 'SessionStart', source: 'resume', transcript_path: '/t/x.jsonl', messaging_present: false,
    static_policy_hits: [{ setting: 'disableAllHooks', file: '/etc/m.json', scope: 'managed', value: 'true' }] });
  const upe = buildPayload(input('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'cowork-sync:cowork', command_args: 'status --flow',
    command_source: 'plugin', prompt: '/cowork status --flow cws-fedcba9876543210' }), { root: ROOT }, extra());
  assert.deepEqual(upe, { event: 'UserPromptExpansion', command_name: 'cowork-sync:cowork', verb: 'status', command_source: 'plugin',
    args_sha256: sha256hex('"--flow"'), nonces: ['cws-fedcba9876543210'], evidence: null });
});

test('parseHookInput gives a typed view and throws HookInputError on a malformed shape', () => {
  const i = input('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu1', tool_input: { file_path: '/x' }, agent_id: 'ag', agent_type: 'Explore' });
  assert.equal(i.event, 'PreToolUse');
  assert.equal(i.session_id, 's1');
  assert.equal(i.prompt_id, 'p1');
  assert.equal(i.transcript_path, '/t/s1.jsonl');
  assert.equal(i.cwd, ROOT);
  assert.equal(i.permission_mode, 'default');
  assert.equal(i.agent_id, 'ag');
  assert.equal(i.agent_type, 'Explore');
  assert.equal(i.tool_name, 'Edit');
  assert.equal(i.tool_use_id, 'tu1');
  assert.deepEqual(i.tool_input, { file_path: '/x' });
  assert.equal(i.tool_response, null);
  assert.equal(i.fields['hook_event_name'], 'PreToolUse');
  const bare = parseHookInput('SessionEnd', { session_id: 's', cwd: '/r' });
  assert.deepEqual([bare.prompt_id, bare.transcript_path, bare.agent_id, bare.tool_name, bare.permission_mode], [null, null, null, null, '']);
  for (const bad of [null, 1, 'x', [], { cwd: '/r' }, { session_id: 's' }, { session_id: 1, cwd: '/r' }, { session_id: 's', cwd: '/r', prompt_id: 5 },
    { session_id: 's', cwd: '/r', hook_event_name: 'Stop' }, { session_id: 's', cwd: '/r', tool_name: ['Edit'] }, { session_id: 's', cwd: '/r', permission_mode: 1 }]) {
    assert.throws(() => parseHookInput('SessionEnd', bad), HookInputError, JSON.stringify(bad));
  }
  // A payload the frame cannot carry is a malformed input too (the loader's step 2 maps it to an internal failure).
  assert.throws(() => buildPayload(input('Notification', { notification_type: 'auth_success' }), { root: ROOT }, extra()), HookInputError);
  assert.throws(() => buildPayload(input('SessionStart', { source: 'reboot' }), { root: ROOT }, extra()), HookInputError);
  assert.throws(() => buildPayload(input('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu', tool_input: {} }), { root: ROOT }, extra()), HookInputError);
  assert.throws(() => buildPayload(input('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu', tool_input: { file_path: '/elsewhere/a.ts' } }), { root: ROOT },
    extra('/elsewhere/a.ts')), HookInputError);
  assert.throws(() => buildPayload(input('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu', tool_input: { old_string: 5 } }), { root: ROOT },
    extra(`${ROOT}/a.ts`)), HookInputError);
  assert.throws(() => buildPayload(input('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu', tool_input: {} }), { root: ROOT }, extra()), HookInputError);
});

test('nonces dedupes in order and matches only cws- plus 16 lowercase hex', () => {
  assert.deepEqual(nonces('x cws-0123456789abcdef y cws-0123456789abcdef cws-fedcba9876543210 cws-0123456789ABCDEF'),
    ['cws-0123456789abcdef', 'cws-fedcba9876543210']);
  assert.deepEqual(nonces('nothing here'), []);
  assert.equal(NONCE_RE.source, 'cws-[0-9a-f]{16}');
  assert.ok(NONCE_RE.global);
  // The exported global regex keeps no state between calls.
  assert.deepEqual(nonces('cws-0123456789abcdef'), ['cws-0123456789abcdef']);
  assert.deepEqual(nonces('cws-0123456789abcdef'), ['cws-0123456789abcdef']);
});

test('normArgs normalizes the shell words of command_args and of argv to one form', () => {
  assert.deepEqual(normArgs('save   "x"  '), { verb: 'save', argsNorm: '"x"', argsSha256: sha256hex('"x"') });
  assert.deepEqual(normArgs('  status   --flow '), { verb: 'status', argsNorm: '"--flow"', argsSha256: sha256hex('"--flow"') });
  assert.deepEqual(normArgs('done'), { verb: 'done', argsNorm: '', argsSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.equal(normArgs('resolve\t01ARZ3NDEKTSV4RRFFQ69G5FAV\n--publish').argsNorm, '"01ARZ3NDEKTSV4RRFFQ69G5FAV" "--publish"');
  const quoted = normArgs('save   "fix  the bug"   --sign ');
  const argv = normArgs(['save', 'fix  the bug', '--sign']);
  assert.equal(quoted.argsNorm, '"fix the bug" "--sign"');
  assert.deepEqual(argv, quoted);
  assert.deepEqual(normArgs("save 'a b'"), normArgs(['save', 'a b']));
  assert.deepEqual(normArgs('save a\\ b "c\\"d" \'e\'"f"'), normArgs(['save', 'a b', 'c"d', 'ef']));
  assert.deepEqual(normArgs(''), { verb: '', argsNorm: '', argsSha256: sha256hex('') });
  assert.deepEqual(normArgs([]), normArgs(''));
  // For any argument list, the text produced by POSIX-quoting each word gives the list's own normal form.
  const posixQuote = (w: string): string => `'${w.split("'").join("'\\''")}'`;
  const word = fc.oneof(fc.string(), fc.fullUnicodeString({ maxLength: 8 }), fc.constantFrom('', ' ', '\t', '\n', "'", '"', '\\', 'a  b', '$HOME', '#x'));
  fc.assert(fc.property(fc.array(word, { minLength: 1, maxLength: 6 }), (words) => {
    assert.deepEqual(normArgs(words.map(posixQuote).join(' ')), normArgs(words));
  }), { numRuns: 300 });
});

test('evidenceFor mints only for a slash_command cowork expansion of an acting verb without a nonce', () => {
  const exp = (o: Record<string, unknown> = {}): HookInput => input('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'cowork',
    command_args: 'save "x"', prompt: '/cowork save "x"', prompt_id: 'p1', command_source: 'plugin', ...o });
  const r = evidenceFor(exp(), K1, 123456789n);
  assert.deepEqual(r, { seat_key: K1, prompt_id: 'p1', verb: 'save', args_sha256: sha256hex('"x"'), mono_ns: '123456789', used: false });
  assert.notEqual(evidenceFor(exp({ command_name: 'cowork-sync:cowork' }), K1, 1n), null);
  assert.equal(evidenceFor(exp({ command_name: 'other' }), K1, 1n), null);
  assert.equal(evidenceFor(exp({ expansion_type: 'prompt' }), K1, 1n), null);
  assert.equal(evidenceFor(exp({ command_args: 'status --flow', prompt: '/cowork status --flow' }), K1, 1n), null);
  assert.equal(evidenceFor(exp({ command_args: 'since', prompt: '/cowork since' }), K1, 1n), null, 'a read-only verb mints no evidence');
  assert.equal(evidenceFor(exp({ prompt: '/cowork save "x" cws-0123456789abcdef' }), K1, 1n), null);
  assert.equal(evidenceFor(exp({ prompt_id: null }), K1, 1n), null);
  assert.equal(evidenceFor(input('UserPromptSubmit', { prompt: '/cowork save "x"' }), K1, 1n), null);
  for (const verb of ['start', 'stop', 'pause', 'resume', 'done', 'resolve', 'review', 'revert', 'release', 'recover', 'uninstall']) {
    assert.equal(evidenceFor(exp({ command_args: verb, prompt: `/cowork ${verb}` }), K1, 1n)?.verb, verb, verb);
  }
  const key = Buffer.alloc(32, 1);
  const rec = r!;
  assert.equal(evidenceTag(key, rec), createHmac('sha256', key).update('evidence' + canonicalJsonLine({ ...rec })).digest('hex'));
  assert.match(evidenceTag(key, rec), /^[0-9a-f]{64}$/);
  assert.notEqual(evidenceTag(Buffer.alloc(32, 2), rec), evidenceTag(key, rec));
});

test('ReadInfo: full, ranged, truncated and ENOENT reads', () => {
  const read = (ti: Record<string, unknown>, tr: Record<string, unknown> | null = null, tool = 'Read'): unknown =>
    (buildPayload(input('PostToolUse', { tool_name: tool, tool_use_id: 'tu', tool_input: ti, tool_response: tr }), { root: ROOT }, extra(`${ROOT}/src/a.ts`)) as { read: unknown }).read;
  assert.deepEqual(read({ file_path: `${ROOT}/src/a.ts`, offset: 100, limit: 50 }), { offset: 100, limit: 50, full: false, enoent: false, size: null });
  assert.deepEqual(read({ file_path: `${ROOT}/src/a.ts` }), { offset: null, limit: null, full: true, enoent: false, size: null });
  assert.deepEqual(read({ file_path: `${ROOT}/src/a.ts` }, { truncated: true }), { offset: null, limit: null, full: false, enoent: false, size: null });
  assert.deepEqual(read({ file_path: `${ROOT}/src/a.ts` }, { enoent: true }), { offset: null, limit: null, full: true, enoent: true, size: null });
  assert.deepEqual(read({ file_path: `${ROOT}/src/a.ts` }, { file: { numLines: 1234 } }), { offset: null, limit: null, full: true, enoent: false, size: 1234 });
  assert.equal(read({ file_path: `${ROOT}/src/a.ts` }, null, 'Edit'), null);
});

test('PostToolUse exit_status, Stop and Notification fields come through HOST_FIELDS', () => {
  assert.deepEqual(HOST_FIELDS, { exitStatus: ['exit_code', 'exitCode'], backgroundTasks: 'background_tasks_running', lastMessage: 'last_assistant_message',
    notificationType: 'notification_type', readTruncated: 'truncated', readEnoent: 'enoent', readSize: 'file.numLines' });
  const post = (tool: string, ti: Record<string, unknown>, tr: Record<string, unknown> | null): Record<string, unknown> =>
    buildPayload(input('PostToolUse', { tool_name: tool, tool_use_id: 'tu', tool_input: ti, tool_response: tr }), { root: ROOT }, extra()) as unknown as Record<string, unknown>;
  assert.equal(post('Bash', { command: 'npm test' }, { exit_code: 0 })['exit_status'], 0);
  assert.equal(post('Bash', { command: 'npm test' }, { exitCode: 3 })['exit_status'], 3);
  assert.equal(post('Bash', { command: 'npm test' }, { stdout: 'x' })['exit_status'], null);
  assert.equal(post('Bash', { command: 'npm test' }, null)['command'], 'npm test');
  assert.equal(post('PowerShell', { command: 'Get-Item x' }, null)['command'], 'Get-Item x');
  assert.equal(post('Edit', { file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' }, null)['command'], null);
  const stop = (o: Record<string, unknown>): Record<string, unknown> => buildPayload(input('Stop', o), { root: ROOT }, extra()) as unknown as Record<string, unknown>;
  const s = stop({ stop_hook_active: true, last_assistant_message: `done (see 01ARZ3NDEKTSV4RRFFQ69G5FAV and src/a.ts) ${CANARY}`, background_tasks_running: 2 });
  assert.deepEqual(s, { event: 'Stop', stop_hook_active: true, background_tasks_running: 2, ids_in_last_message: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'src/a.ts'] });
  assert.deepEqual(stop({}), { event: 'Stop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: null });
  const sub = buildPayload(input('SubagentStop', { agent_id: 'ag', stop_hook_active: false, last_assistant_message: 'no ids' }), { root: ROOT }, extra());
  assert.deepEqual(sub, { event: 'SubagentStop', stop_hook_active: false, background_tasks_running: 0, ids_in_last_message: [] });
  assert.deepEqual(buildPayload(input('Notification', { notification_type: 'permission_prompt', message: 'x' }), { root: ROOT }, extra()),
    { event: 'Notification', type: 'permission_prompt' });
  assert.deepEqual(buildPayload(input('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }), { root: ROOT }, extra()),
    { event: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore', cwd: ROOT });
  assert.deepEqual(buildPayload(input('SessionEnd', { reason: 'logout' }), { root: ROOT }, extra()), { event: 'SessionEnd', reason: 'logout' });
  assert.deepEqual(buildPayload(input('StopFailure', {}), { root: ROOT }, extra()), { event: 'StopFailure', reason: null });
  assert.deepEqual(buildPayload(input('PostToolBatch', { tool_use_ids: ['a', 'b'] }), { root: ROOT }, extra()), { event: 'PostToolBatch', tool_use_ids: ['a', 'b'] });
  assert.deepEqual(buildPayload(input('PermissionDenied', { tool_name: 'Bash', tool_use_id: 'tu', tool_input: { command: 'rm x' } }), { root: ROOT }, extra()),
    { event: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'tu', command: 'rm x' });
  // idsInText: cowork ids and path-like tokens only, deduplicated in order.
  assert.deepEqual(idsInText('held R1a2b3c4d and C0123456789abcdef, cs 5ea70000000000000000000000000001/12; see (src/b.ts) "a.md". done.'),
    ['R1a2b3c4d', 'C0123456789abcdef', '5ea70000000000000000000000000001/12', 'src/b.ts', 'a.md']);
  assert.ok(COWORK_ID_RE.global);
  assert.deepEqual(idsInText(`${'x/'.repeat(101)} ok/1`), ['ok/1'], 'a token over 200 units is not an id');
});

test('edit-class paths are repo-relative POSIX NFC in the target\'s on-disk spelling', () => {
  const nfd = 'c:/Users/Me/repo/src/A\u{301}.ts';
  const pre = (target: string, root: string, ti: Record<string, unknown> = { file_path: target }): Record<string, unknown> =>
    buildPayload(input('PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu', tool_input: ti }), { root }, extra(target)) as unknown as Record<string, unknown>;
  const post = (target: string | null, root: string): unknown =>
    (buildPayload(input('PostToolUse', { tool_name: 'Write', tool_use_id: 'tu', tool_input: { file_path: target, content: 'x' } }), { root }, extra(target)) as { path: unknown }).path;
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  if (folds) {
    // The DAT-34 case rule of this platform (buildPayload reads process.platform): the root's spelling differs, the remainder keeps the target's.
    assert.equal(pre(nfd, 'c:/users/me/repo')['path'], 'src/\u{C1}.ts');
    assert.equal(post(nfd, 'C:/USERS/ME/REPO'), 'src/\u{C1}.ts');
  } else {
    assert.equal(post(nfd, 'c:/users/me/repo'), null);
  }
  assert.equal(pre(nfd, 'c:/Users/Me/repo')['path'], 'src/\u{C1}.ts');
  assert.equal(post('/home/me/other/a.ts', ROOT), null);
  assert.equal(post('/home/me/repo2/a.ts', ROOT), null, 'a sibling with the root as a string prefix is outside');
  assert.equal(post(ROOT, ROOT), null, 'the root itself is not a path');
  assert.equal(post(null, ROOT), null);
  assert.equal(post(`${ROOT}/x/y.ts`, `${ROOT}/`), 'x/y.ts', 'a trailing separator on the root');
  // Edit fields are copied; every other tool_input key is dropped.
  const all = pre(`${ROOT}/nb/x.ipynb`, ROOT, {
    notebook_path: `${ROOT}/nb/x.ipynb`, file_path: 'ignored', old_string: 'a', new_string: 'b', replace_all: true, content: 'c',
    edits: [{ old_string: 'd', new_string: 'e', replace_all: false, extra: 1 }], cell_id: 'c1', new_source: 'print(1)', cell_type: 'code', edit_mode: 'replace',
    description: 'dropped', timeout: 5,
  });
  assert.deepEqual(all['tool_input'], { old_string: 'a', new_string: 'b', replace_all: true, content: 'c',
    edits: [{ old_string: 'd', new_string: 'e', replace_all: false }], notebook: { cell_id: 'c1', new_source: 'print(1)', cell_type: 'code', edit_mode: 'replace' } });
  assert.deepEqual(pre(`${ROOT}/a.ts`, ROOT)['tool_input'], {});
  assert.deepEqual(pre(`${ROOT}/a.ts`, ROOT), { event: 'PreToolUse', gating: 'edit', tool_name: 'Edit', tool_use_id: 'tu', path: 'a.ts', tool_input: {} });
  const shell = buildPayload(input('PreToolUse', { tool_name: 'Monitor', tool_use_id: 'tu', tool_input: { command: 'tail -f log', run_in_background: true } }), { root: ROOT }, extra());
  assert.deepEqual(shell, { event: 'PreToolUse', gating: 'shell', tool_name: 'Monitor', tool_use_id: 'tu', command: 'tail -f log', run_in_background: true });
});

test('seatKeyOf hashes the socket name, never the token', () => {
  const socket = '\\\\.\\pipe\\claude-x';
  assert.equal(seatKeyOf({ CLAUDE_CODE_MESSAGING_SOCKET: socket }, 4242), sha256hex(socket));
  assert.equal(seatKeyOf({ CLAUDE_CODE_MESSAGING_SOCKET: '' }, 4242), '4242');
  assert.equal(seatKeyOf({}, 4242), '4242');
  const read: string[] = [];
  const env = new Proxy({ CLAUDE_CODE_MESSAGING_SOCKET: socket, OTHER: 'x' } as Record<string, string | undefined>, {
    get(t, k) { read.push(String(k)); return t[k as string]; },
    has(t, k) { read.push(`has:${String(k)}`); return k in t; },
    ownKeys(t) { read.push('ownKeys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { read.push(`desc:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  assert.equal(seatKeyOf(env, 1), sha256hex(socket));
  assert.deepEqual(read, ['CLAUDE_CODE_MESSAGING_SOCKET']);
});
