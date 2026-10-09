// Plan 8a Task 13: the render-loop scheduler (12 §3.7 "Rendering"; VIZ-22): requestAnimationFrame-driven, at most 12 fps,
// a draw only when some sprite's frame index changes (at most 2 draws/s for an idle room), stopping when nothing animates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, FPS_CAP, type LoopIo } from '../../../src/viz/ui/loop.js';

/** A fake requestAnimationFrame at `hz` that holds every requested callback, as a browser does (a single slot would hide a
 *  second chain of frames): tick() advances one frame time and fires each callback requested before it and not cancelled; one
 *  requested during the tick waits for the next tick. pending() is the number of callbacks waiting. */
function fakeRaf(hz: number): LoopIo & { pending(): number; tick(): void; now(): number; requests: number } {
  let t = 0;
  let next = 1;
  const cbs = new Map<number, (t: number) => void>();
  const io = {
    requests: 0,
    raf(f: (t: number) => void): number {
      io.requests++;
      const id = next++;
      cbs.set(id, f);
      return id;
    },
    cancel(id: number): void {
      cbs.delete(id);
    },
    pending: (): number => cbs.size,
    tick(): void {
      t += 1_000 / hz;
      for (const id of [...cbs.keys()]) {
        const f = cbs.get(id);
        if (f === undefined) continue;                   // cancelled by an earlier callback of this tick
        cbs.delete(id);
        f(t);
      }
    },
    now: (): number => t,
  };
  return io;
}

/** The largest number of draws inside any half-open window of 1,000 ms (less a rounding epsilon of the fake clock's sums). */
function maxPerSecond(times: readonly number[]): number {
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! < times[i]! + 1_000 - 1e-6; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

test('T-VIZ-anim: with a fake rAF the loop draws at most 12 frames per second, at most 2 per second for an idle room, and stops when nothing animates; wake() restarts it', () => {
  assert.equal(FPS_CAP, 12);

  // A walk animates every 100 ms frame and a sparkle at 100 ms: frame keys change faster than 12 fps at 60 and 144 Hz.
  for (const hz of [60, 144, 30]) {
    const io = fakeRaf(hz);
    const drawn: number[] = [];
    const loop = createLoop(io, (t) => String(Math.floor(t / 50)), () => false, (t) => drawn.push(t));
    loop.wake();
    for (let i = 0; i < hz * 5; i++) io.tick();
    assert.ok(maxPerSecond(drawn) <= 12, `${hz} Hz: ${maxPerSecond(drawn)} draws in one second`);
    for (let i = 1; i < drawn.length; i++) assert.ok(drawn[i]! - drawn[i - 1]! >= 1_000 / 12 - 1e-6, `${hz} Hz: a gap of ${drawn[i]! - drawn[i - 1]!} ms`);
    assert.ok(drawn.length >= (hz >= 60 ? 5 * 10 : 5 * 9), `${hz} Hz: ${drawn.length} draws in 5 s`);
    assert.equal(loop.draws(), drawn.length);
    // Draws only when the frame key changed.
    const keys = drawn.map((t) => Math.floor(t / 50));
    assert.equal(new Set(keys).size, keys.length);
  }

  // An idle room: everyone bobs with a phase of 0 or 600 ms, 2 frames × 600 ms: the key changes every 600 ms → ≤ 2 draws/s.
  {
    const io = fakeRaf(60);
    const drawn: number[] = [];
    const phases = [0, 600, 0, 600, 600];
    const key = (t: number): string => phases.map((p) => Math.floor((t + p) / 600) % 2).join('');
    const loop = createLoop(io, key, () => false, (t) => drawn.push(t));
    loop.wake();
    for (let i = 0; i < 60 * 10; i++) io.tick();
    assert.ok(maxPerSecond(drawn) <= 2, `idle: ${maxPerSecond(drawn)} draws in one second`);
    assert.ok(drawn.length >= 16 && drawn.length <= 18, `idle: ${drawn.length} draws in 10 s`);
  }

  // Nothing animates (paused, reduced motion, nobody on screen): the loop draws the current frame once, then stops asking for
  // frames; wake() restarts it and draws once even with an unchanged key (the scene behind the key changed).
  {
    const io = fakeRaf(60);
    let idle = false;
    const drawn: number[] = [];
    const loop = createLoop(io, () => 'k', () => idle, (t) => drawn.push(t));
    assert.equal(io.pending(), 0, 'a new loop waits for wake()');
    loop.wake();
    loop.wake();                                         // a second wake while running asks for no second frame
    assert.equal(io.requests, 1);
    io.tick();
    assert.equal(drawn.length, 1);
    for (let i = 0; i < 30; i++) io.tick();
    assert.equal(drawn.length, 1, 'a constant key draws nothing more');
    idle = true;
    io.tick();
    assert.equal(io.pending(), 0, 'stopped: no frame requested');
    const requests = io.requests;
    for (let i = 0; i < 30; i++) io.tick();
    assert.equal(io.requests, requests);
    assert.equal(drawn.length, 1);
    idle = false;
    loop.wake();
    assert.equal(io.pending(), 1);
    io.tick();
    assert.equal(drawn.length, 2, 'wake() draws once');
    // stop() cancels the pending frame; nothing is drawn until the next wake().
    loop.stop();
    assert.equal(io.pending(), 0);
    for (let i = 0; i < 10; i++) io.tick();
    assert.equal(drawn.length, 2);
    loop.wake();
    io.tick();
    assert.equal(drawn.length, 3);
    assert.equal(loop.draws(), 3);
  }

  // Idle with a changed frame: the last frame is drawn before the loop stops, so the screen never shows a stale frame.
  {
    const io = fakeRaf(60);
    const drawn: string[] = [];
    let key = 'a';
    const loop = createLoop(io, () => key, () => key === 'b', () => drawn.push(key));
    loop.wake();
    io.tick();
    for (let i = 0; i < 10; i++) io.tick();
    key = 'b';
    io.tick();
    io.tick();
    assert.deepEqual(drawn, ['a', 'b']);
    assert.equal(io.pending(), 0);
  }

  // A wake() from inside draw, frameKey or idle (the page wakes the loop when a beat or a walk ends) starts no second chain of
  // frames: exactly one frame is pending after every tick, frameKey runs once per tick, and the woken frame is still drawn
  // (≤ 12 fps). stop() then leaves nothing pending, and nothing more is drawn or keyed until the next wake().
  for (const where of ['draw', 'key', 'idle'] as const) {
    const io = fakeRaf(60);
    let keys = 0;
    const drawn: number[] = [];
    const loop = createLoop(
      io,
      () => {
        keys++;
        if (where === 'key') loop.wake();
        return 'k';
      },
      () => {
        if (where === 'idle') loop.wake();
        return where === 'idle';                         // idle, but the wake() inside idle keeps the loop running
      },
      (t) => {
        drawn.push(t);
        if (where === 'draw') loop.wake();
      },
    );
    loop.wake();
    for (let i = 0; i < 60 * 5; i++) {
      io.tick();
      assert.equal(io.pending(), 1, `${where}: ${io.pending()} frames pending after tick ${i + 1}`);
    }
    assert.equal(keys, 60 * 5, `${where}: one frame per tick, so ${keys} frameKey calls`);
    assert.ok(maxPerSecond(drawn) <= 12, `${where}: ${maxPerSecond(drawn)} draws in one second`);
    assert.ok(drawn.length >= 5 * 10, `${where}: the woken frames are drawn (${drawn.length} draws in 5 s)`);
    loop.stop();
    assert.equal(io.pending(), 0, `${where}: stop() leaves no frame pending`);
    const [k, d] = [keys, drawn.length];
    for (let i = 0; i < 60; i++) io.tick();
    assert.deepEqual([keys, drawn.length], [k, d], `${where}: nothing runs after stop()`);
  }

  // stop() from inside a frame (draw, frameKey or idle) also stops: the end of that frame requests nothing, and only the next
  // wake() restarts the loop.
  for (const where of ['draw', 'key', 'idle'] as const) {
    const io = fakeRaf(60);
    let stopNow = false;
    let stopped = false;
    let keys = 0;
    const drawn: number[] = [];
    const maybeStop = (w: typeof where): void => {
      if (stopNow && where === w) {
        loop.stop();
        stopped = true;
      }
    };
    const loop = createLoop(io, (t) => (keys++, maybeStop('key'), String(Math.floor(t / 100))), () => (maybeStop('idle'), false), (t) => (drawn.push(t), maybeStop('draw')));
    loop.wake();
    for (let i = 0; i < 30; i++) io.tick();
    stopNow = true;
    for (let i = 0; i < 12 && !stopped; i++) io.tick();      // a draw comes at least every 100 ms (the key changes)
    assert.equal(stopped, true, `${where}: stop() was called inside a frame`);
    assert.equal(io.pending(), 0, `${where}: stop() inside a frame leaves no frame pending`);
    const [k, d] = [keys, drawn.length];
    for (let i = 0; i < 60; i++) io.tick();
    assert.deepEqual([keys, drawn.length], [k, d], `${where}: nothing runs after stop() inside a frame`);
    stopNow = false;
    loop.wake();
    io.tick();
    assert.equal(io.pending(), 1, `${where}: wake() restarts the loop`);
    assert.equal(drawn.length, d + 1);
  }
});
