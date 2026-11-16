// Plan 5 Task 3: the security log (BL2-19, OQ-25 (r3), R5-46, ENG-03, SEC-38 log rule, A3-7). HandshakeFailureRate: sec.handshake.test.ts
// (its flood window: the last cell here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Params } from '../../src/i18n/render.js';
import { realFs } from '../../src/ports/fs.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { recordingNotifier } from '../../src/ports/notifier.js';
import { FAIL_WINDOW_MS, HandshakeFailureRate, securityLog, securityLogAsLog, type SecParams, type SecurityLog } from '../../src/sec/securityLog.js';
import { VirtualClock } from '../sim/vclock.js';
import { makeTempRoot } from '../helpers/tmp.js';

function recordingLog(): Log & { lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> | undefined }> } {
  const lines: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> | undefined }> = [];
  return { lines, write: (level, code, params) => { lines.push({ level, code, params }); } };
}

async function linesOf(file: string, n: number): Promise<string[]> {
  // fileLog appends through its own queue; wait (bounded) until n lines have landed.
  for (let i = 0; i < 400; i++) {
    const text = await realFs.readFile(file).then((b) => b.toString('utf8'), () => '');
    const lines = text.split('\n').filter((l) => l !== '');
    if (lines.length >= n) return lines;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`fewer than ${n} lines in ${file}`);
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

test('security.jsonl carries codes only and mirrors to the daemon log', async (t) => {
  const tmp = await makeTempRoot('seclog');
  t.after(tmp.cleanup);
  const cowork = path.join(tmp.root, 'cowork');
  await realFs.mkdirp(path.join(cowork, 'log'));   // the daemon creates <cowork>/log at start (src/daemon/run.ts)
  const file = path.join(cowork, 'log', 'security.jsonl');
  const clock = new VirtualClock();
  const daemon = recordingLog();
  const sec: SecurityLog = securityLog(realFs, clock, cowork, daemon);

  sec.event('SEC_EVIDENCE_TAG_INVALID', { seat_key_prefix: 'ab12cd34' });
  const [line] = await linesOf(file, 1);
  const obj = JSON.parse(line as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(obj).sort(), ['code', 'level', 'params', 't']);
  assert.equal(obj['level'], 'security');
  assert.equal(obj['code'], 'SEC_EVIDENCE_TAG_INVALID');
  assert.deepEqual(obj['params'], { seat_key_prefix: 'ab12cd34' });
  assert.equal(obj['t'], clock.wallMs());
  assert.deepEqual(daemon.lines, [{ level: 'security', code: 'SEC_EVIDENCE_TAG_INVALID', params: { seat_key_prefix: 'ab12cd34' } }]);

  // A param value that is an object or an array (or anything but string, finite number, null) → TypeError, nothing written anywhere.
  for (const bad of [{ x: { y: 1 } }, { x: [1] }, { x: true }, { x: Number.NaN }, { x: undefined }] as unknown as SecParams[]) {
    assert.throws(() => sec.event('SEC_EVIDENCE_TAG_INVALID', bad), TypeError);
  }
  // A code that is not a registry-shaped code is refused the same way (codes only, never text).
  assert.throws(() => sec.event('handshake failed for C:\\Users\\me', {}), TypeError);
  assert.equal(daemon.lines.length, 1);

  // 50 concurrent events → 50 whole lines in call order (Plan 2 fileLog's queue).
  for (let i = 0; i < 50; i++) sec.event('SEC_IPC_HANDSHAKE_FAILED', { why: 'mac', n: i });
  const all = await linesOf(file, 51);
  assert.equal(all.length, 51);
  assert.deepEqual(all.slice(1).map((l) => (JSON.parse(l) as { params: { n: number } }).params.n), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(daemon.lines.length, 51);

  // A3-7: SecParams is a local copy of 8a's Params (structurally equal), and src/sec imports neither src/i18n nor src/claude — nor anything
  // else after it in the X-110 order (src/data, src/engine, …): an import is a node: built-in, src/ports or a sibling src/sec module.
  const same: Equal<SecParams, Params> = true;
  assert.equal(same, true);
  const allowed = (imp: string): boolean => imp.startsWith('node:') || /^\.\.\/ports\/[A-Za-z]+\.js$/.test(imp) || /^\.\/[A-Za-z]+\.js$/.test(imp);
  for (const bad of ['../i18n/claude.js', '../claude/wire/ndjson.js', '../data/pluginDataDir.js', '../engine/deps.js', 'fs']) assert.equal(allowed(bad), false, bad);
  const secDir = path.join(process.cwd(), 'src', 'sec');
  for (const name of readdirSync(secDir).filter((n) => n.endsWith('.ts'))) {
    const info = ts.preProcessFile(readFileSync(path.join(secDir, name), 'utf8'), true, true);
    for (const imp of info.importedFiles.map((f) => f.fileName)) {
      assert.ok(allowed(imp), `src/sec/${name} imports ${imp}`);
    }
  }
});

test('securityLogAsLog: the daemon\'s one SecurityLog as a Log — level security, checkLine, the daemon-log mirror, one Log per SecurityLog (X-34, R4-52; F2 #52)', async (t) => {
  const tmp = await makeTempRoot('seclog-aslog');
  t.after(tmp.cleanup);
  const cowork = path.join(tmp.root, 'cowork');
  await realFs.mkdirp(path.join(cowork, 'log'));
  const file = path.join(cowork, 'log', 'security.jsonl');
  const clock = new VirtualClock();
  const daemon = recordingLog();
  const sec = securityLog(realFs, clock, cowork, daemon);
  const log: Log = securityLogAsLog(sec);

  log.write('info', 'SEC_X_TEST', { a: 'b' });   // the caller's level is not kept: a security line is level 'security' (R4-52)
  // A boolean or an object param is not a security param: TypeError, nothing written anywhere.
  assert.throws(() => log.write('security', 'SEC_X_TEST', { b: true }), TypeError);
  assert.throws(() => log.write('security', 'SEC_X_TEST', { o: { x: 1 } } as unknown as Record<string, LogParam>), TypeError);
  await sec.flush();
  const lines = (await realFs.readFile(file)).toString('utf8').split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 1, lines.join('\n'));
  const obj = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual([obj['level'], obj['code'], obj['params']], ['security', 'SEC_X_TEST', { a: 'b' }]);
  assert.deepEqual(daemon.lines, [{ level: 'security', code: 'SEC_X_TEST', params: { a: 'b' } }]);

  // One Log per SecurityLog: the same SecurityLog gives the same Log object, another SecurityLog another one.
  assert.equal(securityLogAsLog(sec), log);
  assert.notEqual(securityLogAsLog(securityLog(realFs, clock, cowork, daemon)), log);
});

test('HandshakeFailureRate under a flood: count is the failures in the sliding 60 s window, the window drains, one NT_SECURITY (SEC-22; F2 t5-run r2)', () => {
  const clock = new VirtualClock();
  const notifier = recordingNotifier();
  const counts: number[] = [];
  const rate = new HandshakeFailureRate(clock, notifier, { event: (_code, params) => { counts.push(params['count'] as number); }, flush: async () => undefined });
  const step = 30;
  const n = 3 * FAIL_WINDOW_MS / step / 2;   // 3,000 failures over 90 s: the window fills, then slides
  for (let k = 0; k < n; k++) {
    if (k > 0) clock.advance(step);
    rate.fail('mac');
  }
  const full = FAIL_WINDOW_MS / step;
  assert.deepEqual(counts, Array.from({ length: n }, (_, k) => Math.min(k + 1, full)));
  clock.advance(FAIL_WINDOW_MS);
  rate.fail('mac');
  assert.equal(counts.at(-1), 1, 'every earlier failure has left the window');
  assert.equal(notifier.countOf('NT_SECURITY'), 1, 'one notification within 30 min');
});
