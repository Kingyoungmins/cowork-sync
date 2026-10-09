// Plan 8a Task 15: the viewer's lifetime (12 §3.2 item 5, §3.10.2; VIZ-03; INV-CLOCK; S13). Over a VirtualClock: the launch
// token's TTL, the idle exit and the 24 h lifetime are own staleness (max(Δwall, Δmono): a suspend gap counts), only an
// authenticated request or an open stream keeps the viewer alive, the 30 s check of dist/viz.js ends it when the file changed or
// went, and SIGTERM sends bye and ends it. Each exit is logged with its code. The viewer's checks are woken by unref'd timers on
// the injected clock (clockTimer.ts), so a test advances the virtual clock and then gives the wake-up a moment of real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { GitResult, GitRunner } from '../../../src/git/runner.js';
import { IDLE_MS, LIFETIME_MS, PLUGIN_CHECK_MS, type ViewerDeps, type VizExit } from '../../../src/viz/main.js';
import { vizGitRunner } from '../../../src/viz/source/vizGit.js';
import { LAUNCH_TTL_MS } from '../../../src/viz/server/tokens.js';
import { VirtualClock } from '../../sim/vclock.js';
import { openStream, request } from '../../helpers/vizHttp.js';
import { gitRoomsFixture, logLines, startTestViewer, type TestViewer } from '../../helpers/vizViewer.js';

/** The exit reason when the viewer has exited within `ms` of real time, else null. */
async function exitWithin(v: TestViewer, ms: number): Promise<VizExit | null> {
  // The wait is cancelled once the race is decided, so no timer outlives a test.
  const timer = new AbortController();
  try {
    return await Promise.race([v.exited, delay(ms, null, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

/** Not exited after the viewer's checks had a chance to run (their wake-ups come at least once a second). */
async function stillRunning(v: TestViewer, what: string): Promise<void> {
  assert.equal(await exitWithin(v, 1_500), null, what);
}

/** Exits with `reason` (and logs it) once the virtual clock has passed the limit. */
async function exitsWith(v: TestViewer, reason: VizExit): Promise<void> {
  assert.equal(await exitWithin(v, 10_000), reason);
  assert.ok(logLines(v.dataDir).some((l) => (JSON.parse(l) as { code: string }).code === reason), `${reason} is logged`);
}

type Sig = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

/** A demo viewer on `clock`; `signals.cb` receives the viewer's signal callback. */
function viewer(clock: VirtualClock, signals: { cb?: (sig: Sig) => void } = {}): Promise<TestViewer> {
  return startTestViewer({ demo: true }, { clock, signals: (cb) => { signals.cb = cb; } });
}

test('T-VIZ-lifetime (fake Clock): unredeemed 120 s → VIZ_EXIT_LAUNCH_UNUSED; a suspend gap counts toward the TTL, the idle exit and the lifetime; 10 min without a stream or request → VIZ_EXIT_IDLE; an open stream keeps it alive; 24 h → VIZ_EXIT_LIFETIME; dist/viz.js rewritten or removed → VIZ_EXIT_PLUGIN_REMOVED within 30 s; SIGTERM → bye and VIZ_EXIT_SIGNAL', { timeout: 120_000 }, async () => {
  // Unredeemed: 120 s of Δmono, then the exit.
  {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    clock.advance(LAUNCH_TTL_MS - 1_000);
    await stillRunning(v, 'within the TTL');
    clock.advance(1_001);
    await exitsWith(v, 'VIZ_EXIT_LAUNCH_UNUSED');
  }
  // A suspend gap (Δwall without Δmono) counts toward the TTL: one second after waking.
  {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    clock.suspend(LAUNCH_TTL_MS + 1_000);
    clock.advance(1_000);
    await exitsWith(v, 'VIZ_EXIT_LAUNCH_UNUSED');
  }
  // Redeemed, no stream: 10 min after the last authenticated request.
  {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    const s = await v.session();
    clock.advance(IDLE_MS - 60_000);
    assert.equal((await request(v.port, { path: '/api/v1/world', headers: { 'x-cowork-session': s } })).status, 200);
    clock.advance(IDLE_MS - 1_000);
    await stillRunning(v, 'an authenticated request restarts the idle time');
    clock.advance(2_000);
    await exitsWith(v, 'VIZ_EXIT_IDLE');
  }
  // A suspend gap counts toward the idle exit.
  {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    await v.session();
    clock.suspend(IDLE_MS + 1_000);
    clock.advance(1_000);
    await exitsWith(v, 'VIZ_EXIT_IDLE');
  }
  // An open stream keeps the viewer alive; 10 min after it closes, the idle exit.
  {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    const st = await openStream(v.port, { 'x-cowork-session': await v.session() });
    assert.equal(st.status, 200);
    clock.advance(3 * IDLE_MS);
    await stillRunning(v, 'an open stream');
    st.close();
    await st.ended;
    await delay(200);
    clock.advance(IDLE_MS - 1_000);
    await stillRunning(v, 'the idle time counts from the stream\'s close');
    clock.advance(2_000);
    await exitsWith(v, 'VIZ_EXIT_IDLE');
  }
  // 24 h, even with a stream open; and a suspend gap counts toward it.
  for (const suspend of [false, true]) {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    const st = await openStream(v.port, { 'x-cowork-session': await v.session() });
    if (suspend) {
      clock.suspend(LIFETIME_MS);
      clock.advance(1_000);
    } else {
      clock.advance(LIFETIME_MS - 1_000);
      await stillRunning(v, 'within 24 h');
      clock.advance(2_000);
    }
    await exitsWith(v, 'VIZ_EXIT_LIFETIME');
    await st.waitFor((m) => m.event === 'bye');
  }
  // dist/viz.js rewritten, or removed: the next 30 s check ends the viewer.
  for (const change of ['rewrite', 'remove'] as const) {
    const clock = new VirtualClock();
    const v = await viewer(clock);
    await v.session();
    clock.advance(PLUGIN_CHECK_MS);
    await stillRunning(v, 'an unchanged viz.js');
    if (change === 'rewrite') writeFileSync(v.selfPath, '// an updated plugin\n');
    else unlinkSync(v.selfPath);
    clock.advance(PLUGIN_CHECK_MS);
    await exitsWith(v, 'VIZ_EXIT_PLUGIN_REMOVED');
  }
  // SIGTERM: bye on every stream, then the exit.
  {
    const clock = new VirtualClock();
    const signals: { cb?: (sig: Sig) => void } = {};
    const v = await viewer(clock, signals);
    const st = await openStream(v.port, { 'x-cowork-session': await v.session() });
    assert.equal(typeof signals.cb, 'function', 'the viewer registered for signals');
    signals.cb!('SIGTERM');
    await st.waitFor((m) => m.event === 'bye');
    await st.ended;
    await exitsWith(v, 'VIZ_EXIT_SIGNAL');
    // Every socket is closed: a new request is refused at the TCP level.
    await assert.rejects(request(v.port, { path: '/' }));
  }
});

test('a stopping viewer (SIGTERM) aborts its running git children, and a git call after the stop starts nothing (ledger carry: the serve entry kills its git children)', { timeout: 60_000 }, async () => {
  const f = await gitRoomsFixture('viz-abort', 1);
  try {
    const calls: Array<{ args: string[]; signal: AbortSignal | undefined }> = [];
    let hung: Promise<GitResult> | null = null;
    const gitRunner: NonNullable<ViewerDeps['gitRunner']> = (o): GitRunner => {
      const inner = vizGitRunner(o);
      return {
        run: (args, opts) => {
          calls.push({ args: [...args], signal: opts.abort });
          // The first --batch-check hangs as a stuck git child would, until the call's abort signal fires.
          if (args[1] === '--batch-check' && hung === null) {
            hung = new Promise<GitResult>((resolve) => {
              const done = (): void => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: true, durationMs: 0 });
              if (opts.abort?.aborted === true) done();
              else opts.abort?.addEventListener('abort', done, { once: true });
            });
            return hung;
          }
          return inner.run(args, opts);
        },
      };
    };
    const signals: { cb?: (sig: Sig) => void } = {};
    const v = await startTestViewer({ repos: [f.clones[0]!.dir] }, { gitRunner, signals: (cb) => { signals.cb = cb; } });
    for (let i = 0; i < 100 && hung === null; i++) await delay(50);
    assert.ok(hung !== null, 'a git child is running (the first window\'s read)');
    assert.ok(calls.every((c) => c.signal !== undefined && !c.signal.aborted), 'every git call carries the viewer\'s abort signal');
    signals.cb!('SIGTERM');
    assert.equal(await exitWithin(v, 10_000), 'VIZ_EXIT_SIGNAL', 'the exit does not wait for the stuck child');
    assert.equal((await hung!).aborted, true, 'the running child was aborted');
    assert.ok(calls.every((c) => c.signal!.aborted), 'and every later call starts nothing (P2-ABORT)');
  } finally {
    await f.cleanup();
  }
});

test('T-VIZ-lifetime: unauthenticated probes never keep the viewer alive', { timeout: 120_000 }, async () => {
  const clock = new VirtualClock();
  const v = await viewer(clock);
  await v.session();
  // A 401 probe every 60 s for 15 min: the viewer exits at 10 min all the same.
  let exitedAt: number | null = null;
  for (let minute = 1; minute <= 15; minute++) {
    clock.advance(60_000);
    const probe = await request(v.port, { path: '/api/v1/world' }).catch(() => null);
    if (probe !== null) assert.equal(probe.status, 401, `minute ${minute}`);
    const r = await exitWithin(v, minute <= 10 ? 1_200 : 10_000);
    if (r !== null) {
      assert.equal(r, 'VIZ_EXIT_IDLE');
      exitedAt = minute;
      break;
    }
  }
  assert.equal(exitedAt, 11, 'the first check after 10 min of virtual time without an authenticated request');
});
