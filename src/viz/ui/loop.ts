// The render-loop scheduler (12 §3.7 "Rendering"; VIZ-22): requestAnimationFrame drives it, capped at 12 fps; it draws only
// when some sprite's frame index changed (frameKey), so an idle room draws at most 2 frames per second, and it stops asking for
// frames when nothing animates; wake() restarts it. Pure and DOM-free (R-V33): the page passes requestAnimationFrame.

export interface LoopIo { raf(cb: (t: number) => void): number; cancel(id: number): void; }
export const FPS_CAP = 12;
const MIN_GAP_MS = 1_000 / FPS_CAP;

/**
 * frameKey(t) changes exactly when a sprite's frame index changes; draw only then (or once after wake()) and ≤ 12 fps; stop when
 * idle(t) (paused, reduced motion, nothing on screen, or a constant key with nothing animating) once the latest frame is drawn.
 */
export function createLoop(io: LoopIo, frameKey: (t: number) => string, idle: (t: number) => boolean, draw: (t: number) => void): { wake(): void; stop(): void; draws(): number } {
  let pending: number | null = null;     // the one requested frame: every request goes through request(), so one chain at most
  let halted = false;                    // stop() was called (perhaps from inside a frame) since the last wake()
  let lastKey: string | null = null;
  let lastDraw = Number.NEGATIVE_INFINITY;
  let dirty = false;
  let count = 0;

  const request = (): void => {
    if (pending === null) pending = io.raf(frame);
  };
  const frame = (t: number): void => {
    pending = null;
    const key = frameKey(t);
    let owed = dirty || key !== lastKey;
    if (owed && t - lastDraw >= MIN_GAP_MS) {
      dirty = false;                     // before draw(): a wake() from inside draw asks for one more frame
      draw(t);
      count++;
      lastDraw = t;
      lastKey = key;
      owed = false;
    }
    // A frame still owed (held back by the cap) is drawn before the loop may stop. idle() runs before the request, which then
    // adds nothing when a wake() inside frameKey, draw or idle already asked for the next frame; a stop() inside them holds.
    const more = owed || !idle(t);
    if (more && !halted) request();
  };

  return {
    wake(): void {
      halted = false;
      dirty = true;
      request();
    },
    stop(): void {
      halted = true;
      if (pending !== null) io.cancel(pending);
      pending = null;
    },
    draws: (): number => count,
  };
}
