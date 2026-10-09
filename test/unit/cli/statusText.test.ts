// cowork status (v0.1.0-preview): status.json parsing and the summary lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageText, parseStatusJson, statusStale, statusSummary, type StatusInput, type StatusView } from '../../../src/cli/statusText.js';

const NOW = 1_000_000;
function statusJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, state: 'ok', freeze_reasons: [], publish_pause: null, branch: 'main', peer_id: 'ab'.repeat(16), plugin_version: '0.1.0-preview',
    heartbeat_mono_ms: NOW - 1_000, loop_period_ms: 2_500, last_fetch_age_ms: 3_000, last_push_age_ms: null,
    pending: { cs_ready: 1, cs_open: 2, holds_active: 0, holds_local_only: 0, incoming: 3, not_converged: [] },
    claims_held: 0, requests_in: 0, requests_out: 0, adopt: { state: 'current', reasons: [] }, message_code: null, message_params: {},
    ...over,
  };
}
const view = (over: Record<string, unknown> = {}): StatusView => parseStatusJson(Buffer.from(JSON.stringify(statusJson(over))))!;
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  live: true, status: view(), nowMachineMono: NOW, peers: ['Ann (this clone)', 'Bob'], files: { status: '/r/.git/cowork/status.json', log: '/r/.git/cowork/log/daemon-0.jsonl' }, c: '/cowork', ...over,
});
const codes = (i: StatusInput): string[] => statusSummary(i).lines.map((l) => l.code);

test('parseStatusJson: the glossary §14 shape; anything else is null', () => {
  const v = view();
  assert.equal(v.state, 'ok');
  assert.deepEqual(v.pending, { cs_ready: 1, cs_open: 2, holds_active: 0, incoming: 3, not_converged: [] });
  for (const bad of ['', 'not json', '[]', JSON.stringify({ ...statusJson(), v: 2 }), JSON.stringify({ ...statusJson(), state: 3 }),
    JSON.stringify({ ...statusJson(), loop_period_ms: 0 }), JSON.stringify({ ...statusJson(), pending: null })]) {
    assert.equal(parseStatusJson(Buffer.from(bad)), null, bad);
  }
  assert.equal(parseStatusJson(Buffer.from([0xff, 0xfe])), null);
});

test('ageText: seconds, minutes, hours, days', () => {
  assert.equal(ageText(0), '0 s');
  assert.equal(ageText(119_999), '119 s');
  assert.equal(ageText(120_000), '2 min');
  assert.equal(ageText(7_200_000), '2 h');
  assert.equal(ageText(48 * 3_600_000), '2 d');
  assert.equal(ageText(-5), '0 s');
});

test('statusStale: older than 3 loop periods, or a heartbeat ahead of this boot', () => {
  assert.equal(statusStale(view(), NOW), false);
  assert.equal(statusStale(view({ heartbeat_mono_ms: NOW - 7_501 }), NOW), true);
  assert.equal(statusStale(view({ heartbeat_mono_ms: NOW + 2_501 }), NOW), true);
});

test('running in state ok is healthy; the rows show peers, ages, the waiting counts and the files', () => {
  const s = statusSummary(input());
  assert.equal(s.healthy, true);
  assert.deepEqual(s.lines.map((l) => l.code), [
    'UI_COWORK_STATUS_RUNNING', 'UI_COWORK_STATUS_PEERS', 'UI_COWORK_STATUS_PUSH', 'UI_COWORK_STATUS_FETCH', 'UI_COWORK_STATUS_PENDING', 'UI_COWORK_STATUS_FILES',
  ]);
  assert.deepEqual(s.lines[0]!.params, { branch: 'main', peer: 'abababab', state: 'ok' });
  assert.deepEqual(s.lines[2]!.params, { age: 'none since the daemon started' });
  assert.deepEqual(s.lines[3]!.params, { age: '4 s ago' }, 'the age at the heartbeat plus the heartbeat age');
  assert.deepEqual(s.lines[4]!.params, { ready: 1, open: 2, incoming: 3, holds: 0 });
});

test('degraded, frozen and paused show their rows and are not healthy; not_converged paths carry their causes', () => {
  const nc = view({
    state: 'degraded', freeze_reasons: ['HEAD_MOVED'], publish_pause: 'OFFLINE',
    pending: { cs_ready: 0, cs_open: 0, holds_active: 1, holds_local_only: 0, incoming: 0, not_converged: ['a.txt', 'b.txt'] },
    message_code: 'NOT_CONVERGED',
    message_params: { cause: 'not_applicable', guard: 'collision', paths: ['a.txt', 'b.txt'], causes: [{ cause: 'not_applicable', guard: 'collision' }, { cause: 'phantom' }] },
  });
  const s = statusSummary(input({ status: nc }));
  assert.equal(s.healthy, false);
  const row = (code: string) => s.lines.find((l) => l.code === code)?.params;
  assert.deepEqual(row('UI_COWORK_STATUS_FROZEN'), { reasons: 'HEAD_MOVED' });
  assert.deepEqual(row('UI_COWORK_STATUS_PAUSE'), { pause: 'OFFLINE' });
  assert.deepEqual(row('UI_COWORK_STATUS_NOT_CONVERGED'), { paths: 'a.txt (not_applicable: collision), b.txt (phantom)' });
  assert.equal(row('UI_COWORK_STATUS_MESSAGE'), undefined, 'NOT_CONVERGED is shown by its own row');

  const many = view({ pending: { cs_ready: 0, cs_open: 0, holds_active: 0, holds_local_only: 0, incoming: 0, not_converged: ['1', '2', '3', '4', '5', '6', '7'] } });
  assert.deepEqual(statusSummary(input({ status: many })).lines.find((l) => l.code === 'UI_COWORK_STATUS_NOT_CONVERGED')?.params,
    { paths: '1, 2, 3, 4, 5 and 2 more' });
  const msg = statusSummary(input({ status: view({ message_code: 'HOST_THROTTLED', message_params: { source: 'own' } }) }));
  assert.deepEqual(msg.lines.find((l) => l.code === 'UI_COWORK_STATUS_MESSAGE')?.params, { message: 'HOST_THROTTLED {"source":"own"}' });
});

test('headlines: stale, starting, down, never run, unreadable', () => {
  const stale = statusSummary(input({ status: view({ heartbeat_mono_ms: NOW - 60_000 }) }));
  assert.equal(stale.lines[0]!.code, 'UI_COWORK_STATUS_STALE');
  assert.deepEqual(stale.lines[0]!.params, { age: '60 s', state: 'ok' });
  assert.equal(stale.healthy, false);

  assert.deepEqual(codes(input({ status: null })), ['UI_COWORK_STATUS_STARTING', 'UI_COWORK_STATUS_FILES']);
  const down = statusSummary(input({ live: false, status: view({ state: 'down' }) }));
  assert.equal(down.lines[0]!.code, 'UI_COWORK_STATUS_DOWN');
  assert.deepEqual(down.lines[0]!.params, { branch: 'main', state: 'down', c: '/cowork' });
  assert.equal(down.healthy, false);
  assert.deepEqual(statusSummary(input({ live: false, status: null })), { lines: [{ code: 'UI_COWORK_STATUS_NEVER', params: { c: '/cowork' } }], healthy: false });
  assert.deepEqual(codes(input({ status: 'unreadable' })), ['UI_COWORK_STATUS_STARTING', 'UI_COWORK_STATUS_UNREADABLE', 'UI_COWORK_STATUS_FILES']);
  assert.deepEqual(codes(input({ live: false, status: 'unreadable' })), ['UI_COWORK_STATUS_DOWN', 'UI_COWORK_STATUS_UNREADABLE', 'UI_COWORK_STATUS_FILES']);
  assert.ok(!codes(input({ peers: null })).includes('UI_COWORK_STATUS_PEERS'), 'no peer row without the local board state');
});
