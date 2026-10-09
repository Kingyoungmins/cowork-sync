// The viewer log (12 §3.10.10; VIZ-38; R-V40) over a real temp directory: per-instance files and rotation, the 14-day cleanup,
// the 60 s security aggregation and the content allowlist.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realClock } from '../../../src/ports/clock.js';
import { realFs } from '../../../src/ports/fs.js';
import { VirtualClock } from '../../sim/vclock.js';
import { FaultFs } from '../../sim/faultfs.js';
import { makeTempRoot } from '../../helpers/tmp.js';
import { spyFs, type FsCall } from '../../helpers/vizFs.js';
import {
  cleanupVizLogs, LOG_FILES, LOG_KEEP_MS, LOG_ROTATE_BYTES, nullVizLog, openVizLog, SEC_WINDOW_MS, stackFrames,
} from '../../../src/viz/server/vizLog.js';

const roots: Array<() => Promise<void>> = [];
after(async () => { for (const c of roots) await c(); });

async function tempDir(label: string): Promise<string> {
  const t = await makeTempRoot(label);
  roots.push(t.cleanup);
  return join(t.root, 'log');
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

const A = 'AAAA1111';
const B = 'BBBB2222';
const name = (instance: string, n: number): string => `viz-${instance}-${n}.jsonl`;

test('T-VIZ-logs (unit): viz-<instance>-<n>.jsonl rotated at 10 MB, 5 files, by its owner only; two instances never rename each other\'s files; files older than 14 days are deleted at start; security codes aggregate to one line per 60 s; a non-code string parameter throws', async (t) => {
  assert.equal(LOG_ROTATE_BYTES, 10_000_000);
  assert.equal(LOG_FILES, 5);
  assert.equal(LOG_KEEP_MS, 14 * 24 * 3_600_000);
  assert.equal(SEC_WINDOW_MS, 60_000);

  await t.test('lines go to viz-<instance>-1.jsonl as {t, code, …}; the directory is created', async () => {
    const dir = await tempDir('vizlog-basic');
    const clock = new VirtualClock({ startMono: 1234 });
    const log = await openVizLog({ fs: realFs, clock, dir, instance: A });
    log.write('VIZ_EXIT_IDLE', { rooms: 2, ok: true, none: null, room: 'rABCDEFGH', err: 'ENOENT', reason: 'PAUSED' });
    await log.flush();
    assert.deepEqual(readdirSync(dir), [name(A, 1)]);
    assert.deepEqual(lines(join(dir, name(A, 1))), [
      { t: 1234, code: 'VIZ_EXIT_IDLE', rooms: 2, ok: true, none: null, room: 'rABCDEFGH', err: 'ENOENT', reason: 'PAUSED' },
    ]);
    assert.ok(readFileSync(join(dir, name(A, 1))).every((b) => b !== 13), 'LF only');
  });

  await t.test('rotation at 10 MB shifts -1..-4 up, drops -5, starts a new -1, and touches only its own instance', async () => {
    const dir = await tempDir('vizlog-rotate');
    mkdirSync(dir, { recursive: true });
    for (const inst of [A, B]) {
      for (let n = 2; n <= LOG_FILES; n++) writeFileSync(join(dir, name(inst, n)), `{"old":${n}}\n`);
    }
    writeFileSync(join(dir, name(B, 1)), '{"b":1}\n');
    // A's current file has exactly room for one line of 39 bytes ({"t":0,"code":"VIZ_EXIT_SIGNAL","n":1} and LF).
    const line = `${JSON.stringify({ t: 0, code: 'VIZ_EXIT_SIGNAL', n: 1 })}\n`;
    assert.equal(line.length, 39);
    writeFileSync(join(dir, name(A, 1)), Buffer.alloc(LOG_ROTATE_BYTES - line.length, 0x20));
    const calls: FsCall[] = [];
    const clock = new VirtualClock();
    const a = await openVizLog({ fs: spyFs(calls), clock, dir, instance: A });
    const b = await openVizLog({ fs: spyFs(calls), clock, dir, instance: B });
    a.write('VIZ_EXIT_SIGNAL', { n: 1 });
    await a.flush();
    assert.equal(readFileSync(join(dir, name(A, 1))).length, LOG_ROTATE_BYTES, 'a line that fits exactly does not rotate');
    assert.equal(calls.filter((c) => c.op === 'rename').length, 0);
    a.write('VIZ_EXIT_SIGNAL', { n: 2 });
    b.write('VIZ_EXIT_IDLE');
    await Promise.all([a.flush(), b.flush()]);
    assert.equal(readFileSync(join(dir, name(A, 2))).length, LOG_ROTATE_BYTES, 'the full file became -2');
    assert.deepEqual(lines(join(dir, name(A, 1))), [{ t: 0, code: 'VIZ_EXIT_SIGNAL', n: 2 }]);
    for (let n = 3; n <= LOG_FILES; n++) assert.deepEqual(lines(join(dir, name(A, n))), [{ old: n - 1 }], `-${n - 1} moved to -${n}`);
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(`viz-${A}-`)).length, LOG_FILES, 'at most 5 files per instance');
    // B untouched by A's rotation; B appended to its own -1.
    for (let n = 2; n <= LOG_FILES; n++) assert.deepEqual(lines(join(dir, name(B, n))), [{ old: n }]);
    assert.deepEqual(lines(join(dir, name(B, 1))), [{ b: 1 }, { t: 0, code: 'VIZ_EXIT_IDLE' }]);
    const moved = calls.filter((c) => c.op === 'rename' || c.op === 'unlink');
    assert.ok(moved.length >= LOG_FILES - 1, 'A rotated by rename');
    for (const c of moved) for (const p of c.paths) assert.ok(p.includes(`viz-${A}-`), `only A's files are renamed or deleted: ${p}`);
    // Every file access stays inside the log directory.
    for (const c of calls) for (const p of c.paths) assert.ok(p === dir || p.startsWith(dir), `inside the log dir: ${p}`);
  });

  await t.test('a held -1 skips the rotation: the line still goes to -1, no archive is touched, and the next line past the limit retries; a failed shift resumes where it stopped', async () => {
    const dir = await tempDir('vizlog-held');
    mkdirSync(dir, { recursive: true });
    for (let n = 2; n <= LOG_FILES; n++) writeFileSync(join(dir, name(A, n)), `{"old":${n}}\n`);
    const line = (n: number): string => `${JSON.stringify({ t: 0, code: 'VIZ_EXIT_SIGNAL', n })}\n`;
    writeFileSync(join(dir, name(A, 1)), Buffer.alloc(LOG_ROTATE_BYTES - line(1).length, 0x20));
    const fs = new FaultFs(realFs);
    // -1 is held by another process (a rename of it fails EPERM) for the first two rotation attempts.
    fs.addRule({ op: 'rename', pathIncludes: name(A, 1), code: 'EPERM', times: 2 });
    const log = await openVizLog({ fs, clock: new VirtualClock(), dir, instance: A });
    const archives = (): Array<Array<Record<string, unknown>>> => [2, 3, 4, 5].map((n) => lines(join(dir, name(A, n))));
    const before = archives();
    const ownFiles = (): string[] => readdirSync(dir).filter((f) => f.startsWith(`viz-${A}-`)).sort();
    log.write('VIZ_EXIT_SIGNAL', { n: 1 });
    await log.flush();
    assert.equal(readFileSync(join(dir, name(A, 1))).length, LOG_ROTATE_BYTES, 'the first line fits exactly');
    for (const n of [2, 3]) {
      log.write('VIZ_EXIT_SIGNAL', { n });
      await log.flush();
      assert.equal(fs.hits.get(`rename:EPERM:${name(A, 1)}`), n - 1, `rotation attempt ${n - 1} hit the held -1`);
      assert.deepEqual(lines(join(dir, name(A, 1))).map((l) => l.n), Array.from({ length: n }, (_, i) => i + 1), 'no line is dropped: it goes to -1');
      assert.deepEqual(archives(), before, 'no archive is renamed or deleted');
      assert.deepEqual(ownFiles(), [1, 2, 3, 4, 5].map((k) => name(A, k)));
    }
    // The hold ends: the next line past the limit completes the rotation.
    log.write('VIZ_EXIT_SIGNAL', { n: 4 });
    await log.flush();
    assert.deepEqual(lines(join(dir, name(A, 1))), [JSON.parse(line(4))]);
    assert.deepEqual(lines(join(dir, name(A, 2))).map((l) => l.n), [1, 2, 3], 'the held file became -2 whole');
    assert.deepEqual(archives().slice(1), before.slice(0, 3), '-2..-4 moved up one; only the old -5 is gone');
    assert.deepEqual(ownFiles(), [1, 2, 3, 4, 5].map((k) => name(A, k)));

    // A shift that fails half-way (another reader holds -3) deletes nothing more and resumes at the failed step on the next line.
    const big = Buffer.alloc(LOG_ROTATE_BYTES, 0x20);
    writeFileSync(join(dir, name(A, 1)), big);
    const b4 = archives();
    const log2 = await openVizLog({ fs, clock: new VirtualClock(), dir, instance: A });
    fs.addRule({ op: 'rename', pathIncludes: name(A, 3), code: 'EPERM', times: 1 });
    log2.write('VIZ_EXIT_SIGNAL', { n: 5 });
    await log2.flush();
    assert.deepEqual(lines(join(dir, name(A, 1))), [JSON.parse(line(5))], 'the line went to a new -1');
    assert.deepEqual(lines(join(dir, name(A, 5))), b4[2], 'the old -4 moved to -5 (the one archive a rotation drops is the old -5)');
    assert.equal(fs.hits.get(`rename:EPERM:${name(A, 3)}`), 1);
    log2.write('VIZ_EXIT_SIGNAL', { n: 6 });
    await log2.flush();
    assert.ok(readFileSync(join(dir, name(A, 2))).equals(big), 'the full -1 became -2');
    assert.deepEqual([lines(join(dir, name(A, 3))), lines(join(dir, name(A, 4))), lines(join(dir, name(A, 5)))], [b4[0], b4[1], b4[2]],
      'the shift resumed: -2..-4 each moved up one, nothing else lost');
    assert.deepEqual(lines(join(dir, name(A, 1))).map((l) => l.n), [5, 6]);
    assert.deepEqual(ownFiles(), [1, 2, 3, 4, 5].map((k) => name(A, k)), 'no staging file is left');
  });

  await t.test('R-V67: while a held archive blocks the shift (or a held -1 the rotation), -1 grows to at most 2 × 10 MB; later lines are dropped and counted, and the first line written once the rotation resumes is one VIZ_LOG_DROPPED{n} marker; never more than six files', async () => {
    const HOLD = 2 * LOG_ROTATE_BYTES;
    const dir = await tempDir('vizlog-bound');
    mkdirSync(dir, { recursive: true });
    for (let n = 2; n <= LOG_FILES; n++) writeFileSync(join(dir, name(A, n)), `{"old":${n}}\n`);
    const prefill = Buffer.alloc(LOG_ROTATE_BYTES, 0x20);
    writeFileSync(join(dir, name(A, 1)), prefill);   // exactly full: the first line stages it
    const fs = new FaultFs(realFs);
    // Another process holds -4 open: renaming it to -5 (and -3 onto it) fails EPERM, so the shift stops at its first step.
    const release = fs.holdLock(name(A, 4), 'share-read');
    const log = await openVizLog({ fs, clock: new VirtualClock(), dir, instance: A });
    const own = (): string[] => readdirSync(dir).filter((f) => f.startsWith(`viz-${A}-`)).sort();
    const size1 = (): number => statSync(join(dir, name(A, 1))).size;
    let most = 0;
    const settle = async (): Promise<void> => {
      await log.flush();
      most = Math.max(most, own().length);
    };
    log.write('VIZ_EXIT_SIGNAL', { n: 0 });
    await settle();
    assert.deepEqual(own(), [0, 1, 2, 3, 4, 5].map((k) => name(A, k)), 'the staged -1, a new -1 and the four archives');
    assert.deepEqual(lines(join(dir, name(A, 1))), [{ t: 0, code: 'VIZ_EXIT_SIGNAL', n: 0 }]);

    // Lines of ~96 KB: -1 takes those that fit within 2 × 10 MB, and the rest are dropped.
    const params = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, 123_456_789_012_345 + i]));
    const big = Buffer.byteLength(`${JSON.stringify({ t: 0, code: 'VIZ_EXIT_SIGNAL', ...params })}\n`);
    const fit = Math.floor((HOLD - size1()) / big);
    assert.ok(fit > 100 && big > 90_000);
    for (let i = 0; i < fit + 3; i++) log.write('VIZ_EXIT_SIGNAL', params);
    await settle();
    const held = size1();
    assert.ok(held <= HOLD && held > HOLD - big, `-1 holds at most 2 × 10 MB (${held})`);
    assert.equal(readFileSync(join(dir, name(A, 1)), 'utf8').split('\n').length - 1, 1 + fit, 'the lines that fit are in -1');
    log.write('VIZ_EXIT_SIGNAL', { n: 1 });   // a small line while still blocked is dropped too
    await settle();
    assert.equal(size1(), held, 'nothing more reaches -1 while the shift is blocked');
    assert.equal(own().length, 6);

    // The hold ends: the next line completes the pending shift, then rotates the full -1, and the new -1 starts with the marker.
    release();
    log.write('VIZ_EXIT_SIGNAL', { n: 2 });
    await settle();
    assert.deepEqual(lines(join(dir, name(A, 1))), [{ t: 0, code: 'VIZ_LOG_DROPPED', n: 4 }, { t: 0, code: 'VIZ_EXIT_SIGNAL', n: 2 }],
      'one marker with the count of dropped lines, then the line');
    assert.equal(statSync(join(dir, name(A, 2))).size, held, 'the held-back -1 became -2');
    assert.ok(readFileSync(join(dir, name(A, 3))).equals(prefill), 'the first staged -1 is -3');
    assert.deepEqual([lines(join(dir, name(A, 4))), lines(join(dir, name(A, 5)))], [[{ old: 2 }], [{ old: 3 }]], 'two rotations: the old -4 and -5 are gone');
    assert.deepEqual(own(), [1, 2, 3, 4, 5].map((k) => name(A, k)), 'no staging file is left');
    assert.ok(most <= 6, `never more than six files (${most})`);
    log.write('VIZ_EXIT_SIGNAL', { n: 3 });
    await settle();
    assert.deepEqual(lines(join(dir, name(A, 1))).map((l) => l.code), ['VIZ_LOG_DROPPED', 'VIZ_EXIT_SIGNAL', 'VIZ_EXIT_SIGNAL'], 'one marker only');

    // A held -1 (the rotation cannot even stage it) is bounded the same way.
    const dir2 = await tempDir('vizlog-bound-1');
    mkdirSync(dir2, { recursive: true });
    const nearly = Buffer.alloc(HOLD - 10, 0x20);
    writeFileSync(join(dir2, name(B, 1)), nearly);
    const fs2 = new FaultFs(realFs);
    const release1 = fs2.holdLock(name(B, 1), 'share-read');
    const log2 = await openVizLog({ fs: fs2, clock: new VirtualClock(), dir: dir2, instance: B });
    log2.write('VIZ_EXIT_SIGNAL', { n: 1 });
    log2.write('VIZ_EXIT_SIGNAL', { n: 2 });
    await log2.flush();
    assert.ok(readFileSync(join(dir2, name(B, 1))).equals(nearly), 'both lines dropped: -1 would pass 2 × 10 MB');
    release1();
    log2.write('VIZ_EXIT_SIGNAL', { n: 3 });
    await log2.flush();
    assert.deepEqual(lines(join(dir2, name(B, 1))), [{ t: 0, code: 'VIZ_LOG_DROPPED', n: 2 }, { t: 0, code: 'VIZ_EXIT_SIGNAL', n: 3 }]);
    assert.ok(readFileSync(join(dir2, name(B, 2))).equals(nearly));
    // The marker is the log's own line: a caller cannot write it (it is not a registry code).
    assert.throws(() => log2.write('VIZ_LOG_DROPPED', { n: 1 }), /not allowed/);
  });

  await t.test('cleanupVizLogs deletes viz-*.jsonl files whose mtime is older than 14 days, nothing else', async () => {
    const dir = await tempDir('vizlog-clean');
    mkdirSync(dir, { recursive: true });
    const day = 24 * 3_600_000;
    const files: Array<[string, number]> = [
      ['viz-OLDOLD11-1.jsonl', 14.5 * day], ['viz-OLDOLD11-2.jsonl', 30 * day], ['viz-NEWNEW22-1.jsonl', 13.5 * day],
      ['viz-CURRENT3-1.jsonl', 0], ['other.jsonl', 30 * day], ['viz-x.json', 30 * day], ['notes.txt', 30 * day],
    ];
    for (const [f, age] of files) {
      writeFileSync(join(dir, f), '{}\n');
      const when = (Date.now() - age) / 1000;
      utimesSync(join(dir, f), when, when);
    }
    const deleted = await cleanupVizLogs(realFs, realClock, dir);
    assert.equal(deleted, 2);
    assert.deepEqual(readdirSync(dir).sort(), ['notes.txt', 'other.jsonl', 'viz-CURRENT3-1.jsonl', 'viz-NEWNEW22-1.jsonl', 'viz-x.json']);
    assert.equal(await cleanupVizLogs(realFs, realClock, join(dir, 'absent')), 0, 'a missing directory deletes nothing');

    // An entry whose lstat fails (EACCES, EPERM: a file another process holds or locked down) is skipped; the others are cleaned.
    for (const f of ['viz-LOCKED11-1.jsonl', 'viz-OLDOLD33-1.jsonl']) {
      writeFileSync(join(dir, f), '{}\n');
      const when = (Date.now() - 30 * day) / 1000;
      utimesSync(join(dir, f), when, when);
    }
    const faulty = new FaultFs(realFs);
    faulty.addRule({ op: 'lstat', pathIncludes: 'viz-LOCKED11', code: 'EACCES', times: 1 });
    assert.equal(await cleanupVizLogs(faulty, realClock, dir), 1);
    assert.equal(faulty.hits.get('lstat:EACCES:viz-LOCKED11'), 1);
    assert.ok(existsSync(join(dir, 'viz-LOCKED11-1.jsonl')) && !existsSync(join(dir, 'viz-OLDOLD33-1.jsonl')));
  });

  await t.test('security codes: one line per code per 60 s window with its count, written when the window closes; SEC_VIZ_LAUNCH_REUSED at once; flush writes the open windows', async () => {
    const dir = await tempDir('vizlog-sec');
    const file = join(dir, name(A, 1));
    const clock = new VirtualClock();
    const log = await openVizLog({ fs: realFs, clock, dir, instance: A });
    // The window timers are observed, not run: each window arms one unref'd wake-up of SEC_WINDOW_MS; the injected Clock decides
    // whether the window is due when it wakes.
    const timers: Array<{ fn: () => void; ms: number | undefined; unref: boolean; cleared: boolean }> = [];
    const setT = mock.method(globalThis, 'setTimeout', ((fn: () => void, ms?: number) => {
      const rec = { fn, ms, unref: false, cleared: false };
      timers.push(rec);
      const handle = { unref: () => { rec.unref = true; return handle; }, ref: () => handle, rec };
      return handle;
    }) as unknown as typeof setTimeout);
    const clearT = mock.method(globalThis, 'clearTimeout', ((h: { rec?: { cleared: boolean } } | undefined) => {
      if (h?.rec !== undefined) h.rec.cleared = true;
    }) as unknown as typeof clearTimeout);
    const settle = async (want: number): Promise<Array<Record<string, unknown>>> => {
      for (let i = 0; i < 200; i++) {
        const got = existsSync(file) ? lines(file) : [];
        if (got.length >= want) return got;
        await new Promise((r) => setImmediate(r));
      }
      return existsSync(file) ? lines(file) : [];
    };
    try {
      for (let i = 0; i < 100; i++) log.security('SEC_VIZ_BAD_HOST');
      log.security('SEC_VIZ_METHOD');
      clock.advance(30_000);
      for (let i = 0; i < 10; i++) log.security('SEC_VIZ_BAD_HOST');
      log.security('SEC_VIZ_LAUNCH_REUSED');
      log.security('SEC_VIZ_LAUNCH_REUSED');
      // Inside the windows only SEC_VIZ_LAUNCH_REUSED is written (the viewer exits right after it).
      assert.deepEqual(await settle(2), [
        { t: 30_000, code: 'SEC_VIZ_LAUNCH_REUSED', count: 1 },
        { t: 30_000, code: 'SEC_VIZ_LAUNCH_REUSED', count: 1 },
      ]);
      assert.deepEqual(timers.map((x) => [x.ms, x.unref]), [[SEC_WINDOW_MS, true], [SEC_WINDOW_MS, true]], 'one timer per window');
      timers[1]?.fn();                            // the METHOD window's timer wakes early (30 s by the clock): not due, re-armed
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      assert.equal(lines(file).length, 2, 'a wake-up before 60 s of the clock writes nothing');
      assert.deepEqual(timers.slice(2).map((x) => [x.ms, x.unref]), [[30_000, true]], 're-armed for the remaining 30 s');
      clock.advance(30_000);
      log.security('SEC_VIZ_BAD_HOST');          // 60 s after the window opened: its line (110), and a new window
      log.security('SEC_VIZ_BAD_HOST');
      assert.ok(timers[0]?.cleared, 'the closed window\'s timer is cleared');
      timers[2]?.fn();                            // the METHOD window closes by its timer (due by the clock)
      timers[0]?.fn();                            // a stale timer writes nothing
      await log.flush();                          // the exit path: the open BAD_HOST window
      assert.ok(timers[3]?.cleared);
      assert.deepEqual(lines(file), [
        { t: 30_000, code: 'SEC_VIZ_LAUNCH_REUSED', count: 1 },
        { t: 30_000, code: 'SEC_VIZ_LAUNCH_REUSED', count: 1 },
        { t: 0, code: 'SEC_VIZ_BAD_HOST', count: 110 },
        { t: 0, code: 'SEC_VIZ_METHOD', count: 1 },
        { t: 60_000, code: 'SEC_VIZ_BAD_HOST', count: 2 },
      ]);
      await log.flush();
      assert.equal(lines(file).length, 5, 'a second flush writes nothing more');
    } finally {
      setT.mock.restore();
      clearT.mock.restore();
    }
  });

  await t.test('a non-code string parameter or code throws, without echoing it; nullVizLog checks the same', async () => {
    const dir = await tempDir('vizlog-allow');
    const log = await openVizLog({ fs: realFs, clock: new VirtualClock(), dir, instance: A });
    const secret = 'C:\\Users\\kim\\repo\\src\\a.ts';
    const bad: Array<() => void> = [];
    for (const l of [log, nullVizLog]) {
      bad.push(
        () => l.write('UI_VIZ_ROOM_DOWN', { path: secret }),
        () => l.write('UI_VIZ_ROOM_DOWN', { s: 'README' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { s: 'ui_viz_room_down' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { s: 'https://evil.test/x' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { s: 'rabcdefgh' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { s: 'ENOENT: no such file' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { n: Number.NaN }),
        () => l.write('UI_VIZ_ROOM_DOWN', { n: Number.POSITIVE_INFINITY }),
        () => l.write('UI_VIZ_ROOM_DOWN', { ['__proto__']: 1 }),
        () => l.write('UI_VIZ_ROOM_DOWN', { code: 'VIZ_EXIT_IDLE' }),
        () => l.write('UI_VIZ_ROOM_DOWN', { t: 1 }),
        () => l.write('UI_VIZ_ROOM_DOWN', { [secret]: 1 }),
        () => l.write('README'),
        () => l.write(secret),
        () => l.write('NOT_A_REGISTRY_CODE'),
        () => l.error(secret, new Error('x')),
        () => l.write('UI_VIZ_ROOM_DOWN', { o: ({} as unknown) as string }),
      );
    }
    for (const f of bad) {
      assert.throws(f, (e: unknown) => e instanceof Error && !e.message.includes('kim') && !e.message.includes('README') && !e.message.includes('evil'));
    }
    log.write('UI_VIZ_ROOM_DOWN', { room: 'rABCDEFGH', err: 'EPERM', reason: 'INCIDENT', code2: 'SEC_RECORD_INVALID', n: 0, b: false });
    nullVizLog.write('UI_VIZ_ROOM_DOWN', { room: 'rABCDEFGH' });
    nullVizLog.security('SEC_VIZ_LIMIT');
    nullVizLog.error('UI_INTERNAL_ERROR', new Error('x'));
    await nullVizLog.flush();
    await log.flush();
    const text = readFileSync(join(dir, name(A, 1)), 'utf8');
    assert.equal(lines(join(dir, name(A, 1))).length, 1, 'refused writes leave nothing');
    assert.ok(!text.includes('kim'));
  });

  await t.test('error() logs err.code and stack frames only (basenames), never err.message or the stack text; every line is sanitized', async () => {
    const dir = await tempDir('vizlog-error');
    const log = await openVizLog({ fs: realFs, clock: new VirtualClock(), dir, instance: A });
    const e = new Error('open C:\\Users\\kim\\secret.ts failed\n    at forged (C:\\Users\\kim\\forged.ts:9:9)') as Error & { code?: string };
    e.code = 'ENOENT';
    log.error('UI_INTERNAL_ERROR', e);
    const odd = new Error('y') as Error & { code?: string };
    odd.code = 'ERR_HTTP_REQUEST_TIMEOUT C:\\Users\\kim';
    log.error('UI_INTERNAL_ERROR', odd);
    log.error('UI_INTERNAL_ERROR', 'a thrown string C:\\Users\\kim');
    // A Node internal error keeps its code (ERR_*), like an errno.
    let internal: unknown = null;
    try {
      Buffer.alloc(-1);
    } catch (err) {
      internal = err;
    }
    log.error('UI_INTERNAL_ERROR', internal);
    await log.flush();
    const text = readFileSync(join(dir, name(A, 1)), 'utf8');
    for (const s of ['kim', 'secret', 'forged', 'Users', 'failed', 'thrown', '\\\\']) assert.ok(!text.includes(s), `no ${s}`);
    // sanitize(…, 'log') ran over the line: the frame name <anonymous> keeps only its fullwidth brackets.
    assert.ok(!/[<>]/.test(text));
    assert.ok(text.includes('\u{FF1C}anonymous\u{FF1E}'));
    const [first, second, third, fourth] = lines(join(dir, name(A, 1)));
    assert.equal((internal as { code?: unknown }).code, 'ERR_OUT_OF_RANGE');
    assert.equal(fourth?.err, 'ERR_OUT_OF_RANGE', 'a Node internal error is logged with its code');
    assert.equal(first?.code, 'UI_INTERNAL_ERROR');
    assert.equal(first?.err, 'ENOENT');
    const frames = first?.frames as Array<{ fn: string; line: number; col: number }>;
    assert.ok(Array.isArray(frames) && frames.length > 0);
    assert.ok(frames.some((f) => f.fn.includes('vizLog.test.ts')), 'the test file appears by basename');
    for (const f of frames) {
      assert.deepEqual(Object.keys(f).sort(), ['col', 'fn', 'line']);
      assert.ok(Number.isInteger(f.line) && Number.isInteger(f.col));
      assert.ok(!/[\\/:]/.test(f.fn), `basename only: ${f.fn}`);
    }
    assert.equal(second?.err, null, 'a code that is not errno-shaped is dropped');
    assert.deepEqual(third?.frames, [], 'a non-Error has no frames');
    assert.equal(third?.err, null);
  });

  await t.test('stackFrames: {fn, line, col} with the file reduced to its basename; a stack whose header is not the message has none', () => {
    const e = new Error('m');
    e.stack = 'Error: m\n    at Server.handle (C:\\Users\\kim\\plugin\\dist\\viz.js:10:5)\n    at /home/kim/p/src/viz/server/http.ts:7:3\n'
      + '    at async Promise.all (index 0)\n    at new Foo (file:///C:/Users/kim/x/a.ts:1:2)\n    at <anonymous> (node:internal/http/server:3:4)';
    assert.deepEqual(stackFrames(e), [
      { fn: 'Server.handle (viz.js)', line: 10, col: 5 },
      { fn: '(http.ts)', line: 7, col: 3 },
      { fn: 'new Foo (a.ts)', line: 1, col: 2 },
      { fn: '<anonymous> (server)', line: 3, col: 4 },
    ]);
    const forged = new Error('m');
    forged.stack = 'Error: other\n    at evil (C:\\Users\\kim\\evil.ts:1:1)';
    assert.deepEqual(stackFrames(forged), []);
    assert.deepEqual(stackFrames('string'), []);
    assert.deepEqual(stackFrames(null), []);
    const many = new Error('deep');
    many.stack = 'Error: deep' + '\n    at f (/a/b.ts:1:1)'.repeat(50);
    assert.equal(stackFrames(many).length, 20, 'at most 20 frames');
  });
});

