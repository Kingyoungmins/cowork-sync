import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realFs } from '../../src/ports/fs.js';
import { machineMonoMs, type Clock } from '../../src/ports/clock.js';
import { noTrace, type TraceEvent } from '../../src/ports/trace.js';
import { nullLog, fileLog } from '../../src/ports/log.js';
import { alwaysLeased, LEASE_STOP_SYNC_MS, LEASE_EXIT_MS } from '../../src/ports/lease.js';
import { FaultFs } from '../sim/faultfs.js';

let base = '';
let dir = '';

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-ports2-'));
  dir = path.join(base, '공 백 dir');
  await fsp.mkdir(dir);
});

after(async () => {
  await fsp.rm(base, { recursive: true, force: true, maxRetries: 3 });
});

test('machineMonoMs is non-decreasing and within 5 ms of process.hrtime.bigint()', () => {
  let prev = machineMonoMs();
  for (let i = 0; i < 1000; i++) {
    const now = machineMonoMs();
    assert.ok(now >= prev);
    prev = now;
  }
  const ref = Number(process.hrtime.bigint()) / 1e6;
  assert.ok(Math.abs(machineMonoMs() - ref) < 5);
});

test('noTrace and nullLog accept everything and write nothing', async () => {
  const ev: TraceEvent = { kind: 'iteration', peer: 'p', n: 1, fetched: false, applied: false, pushes: 0 };
  assert.equal(noTrace.emit(ev), undefined);
  assert.equal(nullLog.write('info', 'SOME_CODE', { a: 1, b: 'x', c: true, d: null }), undefined);
  assert.equal(nullLog.write('security', 'OTHER'), undefined);
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('fileLog appends one JSON line per write, in call order, never interleaved under 50 concurrent writes', async () => {
  const file = path.join(dir, 'log', 'daemon-0.jsonl');
  await realFs.mkdirp(path.dirname(file));
  const ffs = new FaultFs(realFs);
  let wall = 1000;
  const clock: Clock = { monoMs: () => 0, wallMs: () => wall++, sleep: async () => {} };
  const log = fileLog(ffs, clock, file);
  log.write('info', 'FIRST');
  for (let i = 0; i < 50; i++) log.write(i % 2 === 0 ? 'warn' : 'error', 'CODE_X', { i, s: 'a'.repeat(20000), ok: i % 3 === 0, nil: null });
  log.write('security', 'LAST', { path: '공 백/f.txt' });
  // writes are queued: wait until the 52 lines landed
  for (let i = 0; i < 400; i++) {
    const t = await realFs.stat(file).catch(() => null);
    if (t !== null && (await realFs.readFile(file)).toString('utf8').split('\n').length === 53) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const text = (await realFs.readFile(file)).toString('utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, 52);
  const rows = lines.map((l) => JSON.parse(l) as { t: number; level: string; code: string; params?: Record<string, unknown> });
  assert.equal(rows[0]?.code, 'FIRST');
  assert.equal(rows[0]?.level, 'info');
  assert.equal(rows[0]?.t, 1000);
  for (let i = 0; i < 50; i++) {
    const r = rows[i + 1];
    assert.equal(r?.code, 'CODE_X');
    assert.equal(r?.level, i % 2 === 0 ? 'warn' : 'error');
    assert.equal(r?.params?.['i'], i);
    assert.equal(r?.params?.['nil'], null);
  }
  assert.equal(rows[51]?.code, 'LAST');
  assert.equal(rows[51]?.params?.['path'], '공 백/f.txt');
  // one appendFile per write, never two in flight at once
  assert.equal(ffs.calls.filter((c) => c.startsWith('appendFile ')).length, 52);
});

test('alwaysLeased.idleMs() is 0; LEASE_STOP_SYNC_MS is 120,000 and LEASE_EXIT_MS 600,000', () => {
  assert.equal(alwaysLeased.idleMs(), 0);
  assert.equal(LEASE_STOP_SYNC_MS, 120_000);
  assert.equal(LEASE_EXIT_MS, 600_000);
});
