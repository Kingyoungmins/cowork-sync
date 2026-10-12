// The GC observer T-VIZ-perf starts the real viewer with (Plan 8a final review B2; test/fixtures/viz/gcObserver.mjs and
// test/helpers/vizMemory.ts), checked on plain node children so `npm test` covers what only the slow suite uses: with --expose-gc
// and an IPC channel it answers 'gc' with process.memoryUsage() after two plain major GCs (the garbage the child dropped is gone from
// its heap) and after a memory-reducing one (the heap committed for it is given back, Node 24); without --expose-gc it stays silent;
// it never keeps a child alive; and the OS view of a child's memory reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { GC_OBSERVER_FLAGS, memoryAfterGc, osMemoryOf } from '../../helpers/vizMemory.js';

const MB = 1024 * 1024;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

/** A node child running `script` with `flags`, an IPC channel (its only stdio) and no shell; ended through its handle by the caller. */
function child(flags: readonly string[], script: string): ChildProcess {
  return spawn(process.execPath, [...flags, '-e', script], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
/** The child's 'close' (its exit, with its channel closed); 'timeout' after `ms`. */
const closeOf = (c: ChildProcess, ms: number): Promise<number | null | 'timeout'> => new Promise((resolve) => {
  if (c.exitCode !== null && !c.connected) return resolve(c.exitCode);
  const timer = setTimeout(() => resolve('timeout'), ms);
  c.once('close', (code) => { clearTimeout(timer); resolve(code); });
});
/** Ends a child that still runs through its handle (never by a pid) and waits for its close (at most 10 s), then one loop turn for
 *  its process handle's own close. */
const end = async (c: ChildProcess): Promise<void> => {
  if (c.exitCode === null && c.signalCode === null) {
    const closed = closeOf(c, 10_000);
    c.kill();
    await closed;
  } else if (c.connected) {
    c.disconnect();
  }
  await new Promise((r) => setTimeout(r, 50));
};
/** Resolves once the child sent 'ready' over its channel. */
const ready = (c: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  c.on('message', (m) => { if (m === 'ready') resolve(); });
  c.once('exit', () => reject(new Error('the child exited first')));
});

test('the GC observer answers \'gc\' with the child\'s memory after two forced major GCs (the 100+ MB of objects it dropped are gone from its heap) and after a memory-reducing major GC (the heap pages they took are given back too)', { timeout: 60_000 }, async (t) => {
  // The child holds ~2 million small objects, drops them, then idles: only a full GC frees them before V8's own timing would, and
  // a plain one keeps the heap V8 committed for them; the memory-reducing one releases it.
  const c = child(GC_OBSERVER_FLAGS, 'let a = []; for (let i = 0; i < 2e6; i++) a.push({ i, s: "x" + i }); globalThis.keep = a; a = null; globalThis.keep = null; process.send("ready"); setInterval(() => {}, 1000);');
  try {
    await ready(c);
    const { major, reduced } = await memoryAfterGc(c);
    for (const m of [major, reduced]) {
      for (const k of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'] as const) assert.ok(Number.isSafeInteger(m[k]) && m[k] >= 0, `${k}: ${m[k]}`);
      assert.ok(m.rss > 0 && m.heapUsed > 0);
      assert.ok(m.heapUsed < 32 * MB, `the dropped objects were collected: heapUsed ${(m.heapUsed / MB).toFixed(1)} MB`);
    }
    const mb = (x: number): string => `${(x / MB).toFixed(1)} MB`;
    t.diagnostic(`after two plain major GCs: heapTotal ${mb(major.heapTotal)}, RSS ${mb(major.rss)}; after the memory-reducing one: heapTotal ${mb(reduced.heapTotal)}, RSS ${mb(reduced.rss)}`);
    assert.ok(reduced.heapTotal <= major.heapTotal, 'the memory-reducing GC never grows the heap');
    // The memory-reducing flavor of gc() (`flavor: 'last-resort'`) is V8's; measured on Node 24, the version viz-slow runs
    // T-VIZ-perf with (an older V8 may read it as a plain major GC).
    if (NODE_MAJOR >= 24) {
      assert.ok(reduced.heapTotal < 32 * MB, `the memory-reducing GC gives the committed heap back: heapTotal ${mb(reduced.heapTotal)} (after the plain ones ${mb(major.heapTotal)})`);
    }
    // Asked again: the same answer shape (the observer stays installed).
    const again = await memoryAfterGc(c);
    assert.ok(again.major.heapUsed < 32 * MB && again.reduced.heapUsed < 32 * MB);
    if (NODE_MAJOR >= 24) assert.ok(again.reduced.heapTotal < 32 * MB);
    if (process.platform === 'win32' || process.platform === 'linux') {
      const os = osMemoryOf(c.pid!);
      assert.ok(os.rss > 0);
      const names = Object.keys(os.fields);
      if (process.platform === 'win32') assert.deepEqual(names, ['WorkingSet64', 'PrivateMemorySize64', 'PeakWorkingSet64']);
      else assert.ok(['VmRSS', 'VmHWM', 'RssAnon', 'RssFile'].every((k) => names.includes(k)), names.join(' '));
    }
  } finally {
    await end(c);
  }
});

test('the GC observer is inert without --expose-gc, and never keeps a child alive', { timeout: 60_000 }, async () => {
  // Without --expose-gc: no answer (memoryAfterGc times out), and the child carries on.
  const silent = child(GC_OBSERVER_FLAGS.filter((f) => f !== '--expose-gc'), 'process.send("ready"); setInterval(() => {}, 1000);');
  try {
    await ready(silent);
    await assert.rejects(memoryAfterGc(silent, 2_000), /no answer from the GC observer/);
    assert.equal(silent.exitCode, null);
  } finally {
    await end(silent);
  }
  // With the observer and an open IPC channel, a child whose own work is done exits by itself (the viewer's exits are unchanged).
  const done = child(GC_OBSERVER_FLAGS, 'console.log("done");');
  try {
    assert.equal(await closeOf(done, 20_000), 0, 'the child ended on its own');
  } finally {
    await end(done);
  }
});
