// Speech bubbles (12 §3.8 "Bubbles"; VIZ-23): the text of a request, answer or note shown briefly above its actor. Duration
// clamp(1.5 s, 0.5 s + Σ 1/cps(char), 6 s) at reading speeds of 20 characters per second for Latin and other scripts, 12 for
// Hangul, 9 for Han and 4 for every character of a text that contains kana; in replay at k× divided by k, never below 1.0 s.
// At most 2 lines × 42 Latin or 16 full-width characters, then an ellipsis; at most one bubble per actor and three per room.
// A character is a grapheme (a combining sequence or an emoji ZWJ sequence is one). Pure and DOM-free (R-V33).

export const BUBBLE_MIN_MS = 1_500, BUBBLE_MAX_MS = 6_000, BUBBLE_BASE_MS = 500, BUBBLE_REPLAY_MIN_MS = 1_000;
export const BUBBLE_LINES = 2, BUBBLE_LINE_LATIN = 42, BUBBLE_LINE_WIDE = 16, BUBBLES_PER_ROOM = 3;

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const KANA = /[\u{3041}-\u{309F}\u{30A0}-\u{30FF}\u{31F0}-\u{31FF}\u{FF66}-\u{FF9F}\u{1B000}-\u{1B16F}]/u;
const HANGUL = /^\p{Script=Hangul}/u;
const HAN = /^\p{Script=Han}/u;
/** East Asian wide and full-width characters (by the grapheme's first code point): Hangul Jamo, CJK, kana, Hangul syllables,
 *  compatibility ideographs, full-width forms, and the wide emoji blocks. */
const WIDE = /^[\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{A960}-\u{A97F}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
const ELLIPSIS = '\u{2026}';
/** One line is 42 Latin units; a full-width character takes 42/16 of them, so 16 fill a line. */
const WIDE_UNITS = BUBBLE_LINE_LATIN / BUBBLE_LINE_WIDE;

const graphemes = (s: string): string[] => Array.from(SEGMENTER.segment(s), (g) => g.segment);
const widthOf = (g: string): number => (WIDE.test(g) ? WIDE_UNITS : 1);
const isSpace = (g: string): boolean => /^\s+$/u.test(g);
/** A replay speed that is not a positive number reads as 1×. */
const speedOf = (speed: number): number => (Number.isFinite(speed) && speed > 0 ? speed : 1);

/** clamp(1.5 s, 0.5 s + Σ 1/cps, 6 s) / speed, never below 1.0 s (ms). */
export function bubbleMs(text: string, speed: number): number {
  const gs = graphemes(text);
  let ms: number;
  if (KANA.test(text)) {
    ms = BUBBLE_BASE_MS + (gs.length * 1_000) / 4;
  } else {
    let latin = 0, hangul = 0, han = 0;
    for (const g of gs) {
      if (HANGUL.test(g)) hangul++;
      else if (HAN.test(g)) han++;
      else latin++;
    }
    ms = BUBBLE_BASE_MS + (latin * 1_000) / 20 + (hangul * 1_000) / 12 + (han * 1_000) / 9;
  }
  const clamped = Math.min(BUBBLE_MAX_MS, Math.max(BUBBLE_MIN_MS, ms));
  return Math.max(BUBBLE_REPLAY_MIN_MS, clamped / speedOf(speed));
}

/** The longest prefix of gs (from `from`) whose width is at most max: its end index and width. */
function fit(gs: readonly string[], from: number, max: number): { end: number; width: number } {
  let i = from, w = 0;
  while (i < gs.length && w + widthOf(gs[i]!) <= max) w += widthOf(gs[i++]!);
  return { end: i, width: w };
}
const trimStart = (gs: readonly string[], from: number): number => {
  let i = from;
  while (i < gs.length && isSpace(gs[i]!)) i++;
  return i;
};
const trimEnd = (gs: readonly string[], from: number, to: number): number => {
  let i = to;
  while (i > from && isSpace(gs[i - 1]!)) i--;
  return i;
};

/**
 * ≤ 2 lines × 42 Latin or 16 full-width characters. A line breaks at the last space that fits (or at the width when there is
 * none, as in CJK text); no line starts or ends with a space; a text longer than two lines ends its second line with '…'
 * (which takes one unit). A grapheme is never split. [] for a blank text.
 */
export function wrapBubble(text: string): string[] {
  const gs = graphemes(text);
  const lines: string[] = [];
  let at = trimStart(gs, 0);
  while (at < gs.length && lines.length < BUBBLE_LINES) {
    const { end } = fit(gs, at, BUBBLE_LINE_LATIN);
    if (end >= trimEnd(gs, at, gs.length)) {             // the rest fits on this line
      lines.push(gs.slice(at, trimEnd(gs, at, gs.length)).join(''));
      return lines;
    }
    if (lines.length === BUBBLE_LINES - 1) {             // the last line: cut to leave room for the ellipsis
      const { end: cut } = fit(gs, at, BUBBLE_LINE_LATIN - 1);
      lines.push(gs.slice(at, trimEnd(gs, at, cut)).join('') + ELLIPSIS);
      return lines;
    }
    let brk = end;
    if (!isSpace(gs[end]!)) {
      let sp = end - 1;
      while (sp > at && !isSpace(gs[sp]!)) sp--;
      if (sp > at) brk = sp;                             // the last space that fits; else a hard break at the width
    }
    lines.push(gs.slice(at, trimEnd(gs, at, brk)).join(''));
    at = trimStart(gs, brk);
  }
  return lines;
}

interface Bubble { actor: string; room: string; lines: string[]; shownMs: number; untilMs: number; seq: number }

/** At most one bubble per actor in a room (a newer one replaces it) and three per room (the fourth makes the oldest fade at once).
 *  Keyed by Maps: actor and room ids are served strings (VIZ-37). */
export class BubbleSet {
  private readonly rooms = new Map<string, Map<string, Bubble>>();
  private seq = 0;

  show(actor: string, room: string, text: string, nowMs: number, speed: number): void {
    this.prune(nowMs);
    let inRoom = this.rooms.get(room);
    if (inRoom === undefined) {
      inRoom = new Map();
      this.rooms.set(room, inRoom);
    }
    inRoom.delete(actor);
    while (inRoom.size >= BUBBLES_PER_ROOM) {
      let oldest: Bubble | null = null;
      for (const b of inRoom.values()) if (oldest === null || b.shownMs < oldest.shownMs || (b.shownMs === oldest.shownMs && b.seq < oldest.seq)) oldest = b;
      inRoom.delete(oldest!.actor);
    }
    inRoom.set(actor, { actor, room, lines: wrapBubble(text), shownMs: nowMs, untilMs: nowMs + bubbleMs(text, speed), seq: this.seq++ });
  }

  /** The bubbles still showing at nowMs (untilMs > nowMs), oldest first. */
  active(nowMs: number): Array<{ actor: string; lines: string[]; untilMs: number }> {
    this.prune(nowMs);
    const out: Bubble[] = [];
    for (const inRoom of this.rooms.values()) out.push(...inRoom.values());
    out.sort((a, b) => a.seq - b.seq);
    return out.map((b) => ({ actor: b.actor, lines: [...b.lines], untilMs: b.untilMs }));
  }

  private prune(nowMs: number): void {
    for (const [room, inRoom] of this.rooms) {
      for (const [actor, b] of inRoom) if (b.untilMs <= nowMs) inRoom.delete(actor);
      if (inRoom.size === 0) this.rooms.delete(room);
    }
  }
}
