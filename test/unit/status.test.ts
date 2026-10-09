// status.json (glossary §14; 01-engine §3.16, test 5; ENG-56, ENG-57; rulings R-16, R-35): the precedence table over
// every combination of freeze reasons and publish pauses, the exact glossary field set, and the writer's EPERM retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FreezeReason } from '../../src/engine/meta.js';
import { blockedPublishReason, computeStatus, StatusWriter, type NotConvergedWhy, type StatusInputs, type StatusJson } from '../../src/engine/status.js';
import { realFs } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';
import { VirtualClock } from '../sim/vclock.js';

const REASONS: readonly FreezeReason[] = ['EPOCH', 'MASS', 'PAUSED', 'INCIDENT', 'CONFIG', 'NOHOOKS'];

/** Glossary §14, in its order. */
const TOP_KEYS = [
  'v', 'state', 'freeze_reasons', 'publish_pause', 'branch', 'peer_id', 'plugin_version', 'heartbeat_mono_ms', 'loop_period_ms',
  'last_fetch_age_ms', 'last_push_age_ms', 'pending', 'claims_held', 'requests_in', 'requests_out', 'adopt', 'message_code', 'message_params',
];
const PENDING_KEYS = ['cs_ready', 'cs_open', 'holds_active', 'holds_local_only', 'incoming', 'not_converged'];

function base(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    refused: null, down: null, freeze: [], offline: null, nonretryable: null, version: null,
    notConverged: [], pendingOlderThan60s: false, throttle: null, branchRewritten: null, lastEvent: null,
    counts: { csReady: 1, csOpen: 2, holdsActive: 3, holdsLocalOnly: 4, incoming: 5 },
    branch: 'main', peerId: 'a'.repeat(32), pluginVersion: '0.0.0',
    heartbeatMs: 1234.5, loopPeriodMs: 2_500, lastFetchAgeMs: 10, lastPushAgeMs: null,
    ...over,
  };
}

function subsets<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => (m & (1 << i)) !== 0));
  return out;
}

function checkShape(s: StatusJson): void {
  assert.deepEqual(Object.keys(s), TOP_KEYS, 'exactly the glossary §14 fields, in order');
  assert.deepEqual(Object.keys(s.pending), PENDING_KEYS);
  assert.deepEqual(Object.keys(s.adopt), ['state', 'reasons']);
  assert.equal(s.v, 1);
}

test('status precedence over every combination of freeze reasons and pauses, with exactly the glossary §14 fields', () => {
  const offlines: Array<StatusInputs['offline']> = [null, { label: 'OFFLINE', explanation: 'network', offlineForS: 42 }, { label: 'AUTH', explanation: 'auth', offlineForS: 7 }];
  const versions: Array<StatusInputs['version']> = [null, { form: 'proto', cause: null }, { form: 'regionSpec', cause: null }, { form: 'regionSpec', cause: 'checkpoint_mismatch' }];
  const throttle: StatusInputs['throttle'] = { source: 'own', untilMin: 12, budget: 6, fallbackLeftS: 700, signal: 'http_429' };
  // 01-engine §2's params: INCIDENT{n, old and observed oids, displaced ref or kept_local}; NOT_CONVERGED{paths, cause per
  // path}; DEFERRED{reason, paths}.
  const incident = { n: 3, why: 'board_missing', old_board: 'b'.repeat(40), old_code: 'c'.repeat(40), new_board: null, new_code: null, displaced: 'kept_local' };
  const causes: StatusInputs['notConvergedCauses'] = new Map<string, NotConvergedWhy>([['a.txt', { cause: 'blocked_publish', reason: 'OFFLINE' }], ['b.txt', { cause: 'not_applicable', guard: 'collision' }]]);
  const deferred: StatusInputs['deferred'] = { reason: 'locked', paths: ['d.txt'] };
  let combos = 0;
  for (const freeze of subsets(REASONS)) {
    for (const offline of offlines) {
      for (const nonretryable of [null, { holdId: '01J0000000000000000000000A' }]) {
        for (const version of versions) {
          for (const notConverged of [[], ['b.txt', 'a.txt', 'b.txt']]) {
            for (const pendingOlderThan60s of [false, true]) {
              for (const refused of [null, { code: 'START_PREVIEW', params: { n_in: 1 } }]) {
                for (const withThrottle of [false, true]) {
                  combos++;
                  const s = computeStatus(base({
                    freeze, offline, nonretryable, version, notConverged, pendingOlderThan60s, refused, throttle: withThrottle ? throttle : null,
                    incident: freeze.includes('INCIDENT') ? incident : null, notConvergedCauses: causes, deferred: pendingOlderThan60s ? deferred : null,
                  }));
                  checkShape(s);
                  const nonPaused = freeze.filter((r) => r !== 'PAUSED');
                  const want =
                    refused !== null ? 'refused'
                    : freeze.includes('INCIDENT') ? 'incident'
                    : nonPaused.length > 0 ? 'frozen'
                    : freeze.length > 0 ? 'paused'
                    : offline !== null ? 'offline'
                    : nonretryable !== null || version !== null || notConverged.length > 0 || pendingOlderThan60s ? 'degraded'
                    : 'ok';
                  const ctx = JSON.stringify({ freeze, offline, nonretryable, version, notConverged, pendingOlderThan60s, refused, withThrottle });
                  assert.equal(s.state, want, ctx);
                  assert.deepEqual(s.freeze_reasons, freeze, ctx);
                  const pause = offline !== null ? offline.label : nonretryable !== null ? 'NONRETRYABLE' : version !== null ? 'VERSION' : null;
                  assert.equal(s.publish_pause, pause, ctx);
                  assert.deepEqual(s.pending.not_converged, notConverged.length === 0 ? [] : ['a.txt', 'b.txt'], ctx);
                  // HOST_THROTTLED only in ok (it never changes the state, R-16).
                  assert.equal(s.message_code === 'HOST_THROTTLED', want === 'ok' && withThrottle, ctx);
                  if (want === 'refused') assert.deepEqual([s.message_code, s.message_params], ['START_PREVIEW', { n_in: 1 }], ctx);
                  if (want === 'incident') assert.deepEqual([s.message_code, s.message_params], ['INCIDENT', incident], ctx);
                  if (want === 'frozen') assert.deepEqual([s.message_code, s.message_params], ['FROZEN', { reasons: freeze }], ctx);
                  if (want === 'paused') assert.deepEqual([s.message_code, s.message_params], ['PAUSED', {}], ctx);
                  if (want === 'offline') {
                    assert.equal(s.message_code, 'OFFLINE', ctx);
                    assert.deepEqual(s.message_params, { label: offline!.label, explanation: offline!.explanation, offline_for_s: offline!.offlineForS }, ctx);
                  }
                  if (want === 'degraded') {
                    const code = nonretryable !== null ? 'NONRETRYABLE' : version !== null ? 'VERSION_PAUSED' : notConverged.length > 0 ? 'NOT_CONVERGED' : 'DEFERRED';
                    assert.equal(s.message_code, code, ctx);
                    if (code === 'NOT_CONVERGED') {
                      assert.deepEqual(s.message_params, {
                        cause: 'blocked_publish', reason: 'OFFLINE', paths: ['a.txt', 'b.txt'],
                        causes: [{ cause: 'blocked_publish', reason: 'OFFLINE' }, { cause: 'not_applicable', guard: 'collision' }],
                      }, ctx);
                    }
                    if (code === 'DEFERRED') assert.deepEqual(s.message_params, { reason: 'locked', paths: ['d.txt'] }, ctx);
                  }
                  if (want === 'ok' && !withThrottle) assert.equal(s.message_code, null, ctx);
                }
              }
            }
          }
        }
      }
    }
  }
  assert.equal(combos, 64 * 3 * 2 * 4 * 2 * 2 * 2 * 2);

  // HOST_THROTTLED in ok carries {source, until_min, budget, fallback_left_s, signal} (R-16); a null source renders 'own'.
  const t = computeStatus(base({ throttle }));
  assert.equal(t.state, 'ok');
  assert.deepEqual([t.message_code, t.message_params], ['HOST_THROTTLED', { source: 'own', until_min: 12, budget: 6, fallback_left_s: 700, signal: 'http_429' }]);
  // BRANCH_REWRITTEN is shown in ok and wins over the throttle and the last event.
  const b = computeStatus(base({ throttle, branchRewritten: { hb: 'h'.repeat(40), hr: '' }, lastEvent: { code: 'UNFROZEN', params: {} } }));
  assert.deepEqual([b.state, b.message_code, b.message_params], ['ok', 'BRANCH_REWRITTEN', { hb: 'h'.repeat(40), hr: '' }]);
  // ... and not in another state.
  assert.equal(computeStatus(base({ branchRewritten: { hb: 'x', hr: 'y' }, notConverged: ['a'] })).message_code, 'NOT_CONVERGED');
  // In ok without either, the last engine event.
  assert.deepEqual(computeStatus(base({ lastEvent: { code: 'INDEX_LOCK_WAIT', params: { age: 31 } } })).message_params, { age: 31 });
  // A VERSION pause names its form and cause; NONRETRYABLE names its PIN.
  assert.deepEqual(computeStatus(base({ version: { form: 'regionSpec', cause: 'checkpoint_mismatch' } })).message_params, { form: 'regionSpec', cause: 'checkpoint_mismatch' });
  assert.deepEqual(computeStatus(base({ nonretryable: { holdId: 'X' } })).message_params, { hold_id: 'X' });
  // The unresolved push intent (Task 14 carry): degraded with NOT_CONVERGED{cause: push_unresolved}, also with no path.
  const pu = computeStatus(base({ notConvergedCause: 'push_unresolved' }));
  assert.deepEqual([pu.state, pu.message_code, pu.message_params], ['degraded', 'NOT_CONVERGED', { cause: 'push_unresolved', paths: [], causes: [] }]);
  // An INV-MASK violation (ENG-28) names its path with cause publish_assert and check INV-MASK (01-engine §3.5 step 4); a
  // path without a known cause is not_applicable with no guard.
  const mask = computeStatus(base({ notConverged: ['m.txt', 'z.txt'], notConvergedCauses: new Map([['m.txt', { cause: 'publish_assert', check: 'INV-MASK' }]]) }));
  assert.deepEqual([mask.state, mask.message_code, mask.message_params], ['degraded', 'NOT_CONVERGED', {
    cause: 'publish_assert', check: 'INV-MASK', paths: ['m.txt', 'z.txt'], causes: [{ cause: 'publish_assert', check: 'INV-MASK' }, { cause: 'not_applicable' }],
  }]);
  // Without the inputs that carry them, INCIDENT and DEFERRED have empty params (never another code's params).
  assert.deepEqual(computeStatus(base({ freeze: ['INCIDENT'], lastEvent: { code: 'INDEX_LOCK_WAIT', params: { age: 31 } } })).message_params, {});
  assert.deepEqual(computeStatus(base({ pendingOlderThan60s: true })).message_params, {});

  // down only from `down`, over everything; IDLE_NO_SESSION or no code (a plain drain).
  const idle = computeStatus(base({ down: { code: 'IDLE_NO_SESSION' }, freeze: ['INCIDENT'], refused: { code: 'X_Y', params: {} } }));
  assert.deepEqual([idle.state, idle.message_code, idle.message_params], ['down', 'IDLE_NO_SESSION', {}]);
  checkShape(idle);
  const plain = computeStatus(base({ down: { code: null } }));
  assert.deepEqual([plain.state, plain.message_code], ['down', null]);

  // The passthrough fields.
  assert.deepEqual(
    [t.branch, t.peer_id, t.plugin_version, t.heartbeat_mono_ms, t.loop_period_ms, t.last_fetch_age_ms, t.last_push_age_ms],
    ['main', 'a'.repeat(32), '0.0.0', 1234.5, 2_500, 10, null],
  );
  assert.deepEqual(t.pending, { cs_ready: 1, cs_open: 2, holds_active: 3, holds_local_only: 4, incoming: 5, not_converged: [] });
  assert.deepEqual([t.claims_held, t.requests_in, t.requests_out, t.adopt], [0, 0, 0, { state: 'current', reasons: [] }]);
});

test('NOT_CONVERGED params carry the per-cause qualifiers of 01-engine §2: not_applicable its guard, blocked_publish its pause, FREEZE reason or holding guard, publish_assert its check', () => {
  const nc = (why: ReadonlyArray<[string, NotConvergedWhy]>, explicit: StatusInputs['notConvergedCause'] = null): StatusJson['message_params'] => {
    const s = computeStatus(base({ notConverged: why.map(([p]) => p), notConvergedCauses: new Map(why), notConvergedCause: explicit }));
    assert.deepEqual([s.state, s.message_code], ['degraded', 'NOT_CONVERGED']);
    return s.message_params;
  };
  // The headline (the first path's cause, as EV.NOT_CONVERGED's {NCCAUSE} reads it) carries its qualifier under the name
  // 01-engine §2 gives it, between `cause` and `paths`; each path's entry in `causes` carries its own.
  const na = nc([['x.txt', { cause: 'not_applicable', guard: 'quarantine-review' }], ['y.txt', { cause: 'phantom' }]]);
  assert.deepEqual(na, { cause: 'not_applicable', guard: 'quarantine-review', paths: ['x.txt', 'y.txt'], causes: [{ cause: 'not_applicable', guard: 'quarantine-review' }, { cause: 'phantom' }] });
  assert.deepEqual(Object.keys(na), ['cause', 'guard', 'paths', 'causes']);
  assert.deepEqual(nc([['a', { cause: 'blocked_publish', reason: 'EPOCH' }]]), { cause: 'blocked_publish', reason: 'EPOCH', paths: ['a'], causes: [{ cause: 'blocked_publish', reason: 'EPOCH' }] });
  assert.deepEqual(nc([['a', { cause: 'blocked_publish', guard: 'join' }]]), { cause: 'blocked_publish', guard: 'join', paths: ['a'], causes: [{ cause: 'blocked_publish', guard: 'join' }] });
  assert.deepEqual(nc([['a', { cause: 'publish_assert', check: 'i' }]]), { cause: 'publish_assert', check: 'i', paths: ['a'], causes: [{ cause: 'publish_assert', check: 'i' }] });
  assert.deepEqual(nc([['a', { cause: 'deferred', reason: 'locked' }]]), { cause: 'deferred', reason: 'locked', paths: ['a'], causes: [{ cause: 'deferred', reason: 'locked' }] });
  assert.deepEqual(nc([['a', { cause: 'round_trip' }]]), { cause: 'round_trip', paths: ['a'], causes: [{ cause: 'round_trip' }] });
  // The paths are sorted and their causes follow them.
  assert.deepEqual(nc([['b', { cause: 'phantom' }], ['a', { cause: 'not_applicable', guard: 'unmaterializable' }]]),
    { cause: 'not_applicable', guard: 'unmaterializable', paths: ['a', 'b'], causes: [{ cause: 'not_applicable', guard: 'unmaterializable' }, { cause: 'phantom' }] });
  // An explicit headline (push_unresolved, fetch_owed) has no qualifier; the paths keep theirs.
  assert.deepEqual(nc([['a', { cause: 'fetch_owed' }], ['b', { cause: 'blocked_publish', reason: 'OFFLINE' }]], 'fetch_owed'),
    { cause: 'fetch_owed', paths: ['a', 'b'], causes: [{ cause: 'fetch_owed' }, { cause: 'blocked_publish', reason: 'OFFLINE' }] });

  // blocked_publish's reason follows the status precedence: INCIDENT, another FREEZE reason, PAUSED, then the publish
  // pause shown (OFFLINE/AUTH > NONRETRYABLE > VERSION); null when nothing blocks.
  assert.equal(blockedPublishReason(['EPOCH', 'INCIDENT'], 'OFFLINE'), 'INCIDENT');
  assert.equal(blockedPublishReason(['PAUSED', 'EPOCH'], 'OFFLINE'), 'EPOCH');
  assert.equal(blockedPublishReason(['PAUSED'], 'NONRETRYABLE'), 'PAUSED');
  assert.equal(blockedPublishReason([], 'AUTH'), 'AUTH');
  assert.equal(blockedPublishReason([], 'VERSION'), 'VERSION');
  assert.equal(blockedPublishReason([], null), null);
});

test('StatusWriter retries EPERM 3 × 50 ms, then skips the write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cowork-status-'));
  try {
    const file = join(dir, 'status.json');
    const fs = new FaultFs(realFs);
    const clock = new VirtualClock({ startMono: 1_000 });
    const w = new StatusWriter(fs, file, dir, clock);
    const s1 = computeStatus(base());
    assert.equal(await w.write(s1), true);
    const first = await readFile(file);
    assert.deepEqual(JSON.parse(first.toString('utf8')), s1);
    assert.equal(first.at(-1), 0x0a, 'LF-terminated');
    assert.ok(!first.includes(0x0d), 'no CR');

    // A reader holding the file without share-delete: the rename fails EPERM three times, the fourth attempt lands.
    const renames = (): number => fs.calls.filter((c) => c.startsWith('rename ')).length;
    let before = renames();
    fs.addRule({ op: 'rename', pathIncludes: 'status.json', code: 'EPERM', times: 3 });
    const t0 = clock.monoMs();
    const s2 = computeStatus(base({ freeze: ['EPOCH'] }));
    assert.equal(await w.write(s2), true);
    assert.equal(renames() - before, 4);
    assert.equal(clock.monoMs() - t0, 150, 'three 50 ms waits');
    assert.equal(JSON.parse((await readFile(file)).toString('utf8')).state, 'frozen');

    // Still held after the third retry: this write is skipped (false), the previous status stays, no temp file is left.
    before = renames();
    fs.addRule({ op: 'rename', pathIncludes: 'status.json', code: 'EPERM', times: 4 });
    const t1 = clock.monoMs();
    assert.equal(await w.write(computeStatus(base({ freeze: ['INCIDENT'] }))), false);
    assert.equal(renames() - before, 4, 'one attempt and three retries');
    assert.equal(clock.monoMs() - t1, 150);
    assert.equal(JSON.parse((await readFile(file)).toString('utf8')).state, 'frozen');
    assert.deepEqual((await readdir(dir)).sort(), ['status.json']);

    // EACCES and EBUSY (a Windows holder) are retried the same way, 3 × 50 ms on the Clock port; another error propagates.
    fs.addRule({ op: 'rename', pathIncludes: 'status.json', code: 'EACCES', times: 1 });
    assert.equal(await w.write(s1), true);
    before = renames();
    fs.addRule({ op: 'rename', pathIncludes: 'status.json', code: 'EBUSY', times: 3 });
    const t2 = clock.monoMs();
    assert.equal(await w.write(s1), true, 'EBUSY three times: the fourth attempt lands');
    assert.equal(renames() - before, 4);
    assert.equal(clock.monoMs() - t2, 150);
    fs.addRule({ op: 'writeFile', pathIncludes: 'status.json', code: 'ENOSPC', times: 1 });
    await assert.rejects(w.write(s1), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    assert.deepEqual((await readdir(dir)).sort(), ['status.json'], 'a failed write leaves no temp file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
