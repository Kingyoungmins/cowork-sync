// Zoom and following (12 §3.5.3 "Scrolling, not automatic coarse zoom", §3.7 "Rendering"; VIZ-16): the integer zoom Z is set
// only when the page opens, on a window resize or on a user zoom — never because the office grew; the coarse view is a user
// toggle only; the office panel follows a new event only when the user has not scrolled for 30 s. Pure and DOM-free (R-V33).

export const ZOOM_MIN = 2, ZOOM_MAX = 8, FOLLOW_AFTER_MS = 30_000;

/** max(2, ⌊panelW / worldW⌋); 2 for a panel or world that is not a positive number. */
export function autoZoom(panelW: number, worldW: number): number {
  if (!(Number.isFinite(panelW) && Number.isFinite(worldW) && panelW > 0 && worldW > 0)) return ZOOM_MIN;
  return Math.max(ZOOM_MIN, Math.floor(panelW / worldW));
}

/** A manual zoom: the nearest integer within 2–8 (2 for NaN). */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return Number.isNaN(z) ? ZOOM_MIN : z > 0 ? ZOOM_MAX : ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));
}

/** The map uses max(1, Z − 1). */
export function mapZoom(z: number): number {
  return Math.max(1, z - 1);
}

/** The office panel's zoom and view: Z changes on open, resize and user zoom only; growth changes neither Z nor the view. */
export class ZoomState {
  private zoom = ZOOM_MIN;
  private coarseView = false;
  constructor(private readonly worldW: number) {}
  get z(): number { return this.zoom; }
  get coarse(): boolean { return this.coarseView; }
  open(panelW: number): void { this.zoom = autoZoom(panelW, this.worldW); }
  resize(panelW: number): void { this.zoom = autoZoom(panelW, this.worldW); }
  /** + or − steps from the current zoom, within 2–8. The auto-fit Z of a wide panel can sit above 8: there + changes nothing (it never
   *  shrinks the office) and − steps to at most 8 (clampZoom of min(z − 1, 8)). */
  userZoom(delta: number): void {
    if (delta > 0 && this.zoom >= ZOOM_MAX) return;
    this.zoom = clampZoom(this.zoom + delta);
  }
  /** The office grew (it grows downward only; its width, and so Z, never changes): nothing changes. */
  officeGrew(): void { /* VIZ-16: the panel scrolls instead */ }
  toggleCoarse(): void { this.coarseView = !this.coarseView; }
}

/** Follow (scroll to a new event's desk) only when the user has not scrolled for 30 s. */
export class FollowRule {
  private last: number | null = null;
  scrolled(nowMono: number): void { this.last = nowMono; }
  follow(nowMono: number): boolean { return this.last === null || nowMono - this.last >= FOLLOW_AFTER_MS; }
}
