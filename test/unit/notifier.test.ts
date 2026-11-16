// Plan 5 Task 1: the Notifier seam (11 §3.2 Notifier row; R2-L1; A1-5; X-67).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as notifierModule from '../../src/ports/notifier.js';
import { logNotifier, recordingNotifier, type Notifier, type NtClass, type NtClassKey } from '../../src/ports/notifier.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

test('Notifier: recordingNotifier() records and counts per class; logNotifier writes one warn line per call', () => {
  const n = recordingNotifier();
  n.raise('NT_SECURITY', 'SEC_IPC_HANDSHAKE_FAILED', { count: 5 });
  n.raise('NT_SECURITY', 'SEC_REFUSE_IPC_SQUATTER', { kind: 'pipe' }, 'r1');
  n.raise('NT_NOHOOKS', 'NOHOOKS', { cause: 'policy' });
  assert.deepEqual(n.calls, [
    { cls: 'NT_SECURITY', code: 'SEC_IPC_HANDSHAKE_FAILED', params: { count: 5 }, key: null },
    { cls: 'NT_SECURITY', code: 'SEC_REFUSE_IPC_SQUATTER', params: { kind: 'pipe' }, key: 'r1' },
    { cls: 'NT_NOHOOKS', code: 'NOHOOKS', params: { cause: 'policy' }, key: null },
  ]);
  assert.equal(n.countOf('NT_SECURITY'), 2);
  assert.equal(n.countOf('NT_NOHOOKS'), 1);
  assert.equal(n.countOf('NT_PLUGIN_REMOVED'), 0);
  // Each factory call is its own recorder.
  assert.equal(recordingNotifier().calls.length, 0);

  const lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> | undefined }> = [];
  const log: Log = { write: (level, code, params) => { lines.push({ level, code, params }); } };
  logNotifier(log).raise('NT_SECURITY', 'SEC_IPC_HANDSHAKE_FAILED', { count: 5 });
  assert.deepEqual(lines, [{ level: 'warn', code: 'SEC_IPC_HANDSHAKE_FAILED', params: { count: 5, cls: 'NT_SECURITY' } }]);
  logNotifier(log).raise('NT_LIVE_MARKER_RESTORED', 'LIVE_MARKER_RESTORED', { repo: 'r' }, 'k');
  assert.equal(lines.length, 2);

  // Type level: Notifier has exactly the member raise (no notify); Plan 5's four classes; no RecordingNotifier class is exported.
  const members: Equal<keyof Notifier, 'raise'> = true;
  const classes: Equal<NtClass, 'NT_NOHOOKS' | 'NT_SECURITY' | 'NT_LIVE_MARKER_RESTORED' | 'NT_PLUGIN_REMOVED'> = true;
  const keys: Equal<NtClassKey, NtClass> = true;
  void [members, classes, keys];
  assert.deepEqual(Object.keys(notifierModule).sort(), ['logNotifier', 'recordingNotifier']);
  assert.ok(!('RecordingNotifier' in notifierModule));
});
