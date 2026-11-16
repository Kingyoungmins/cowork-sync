// The stream hub (12-visualizer §3.10.5 "Stream ids and resume"; VIZ-34, VIZ-42): one per-process sequence of ids from 1 shared by
// every room and kind, a resume ring of the last 4,096 events or 10 min (Δmono), whichever is less, and at most SSE_BUFFER_MAX (1 MiB)
// of messages (R-V72), SSE messages of at most 64 KiB, comment lines and bye. The hub writes framed text to sinks; http.ts adapts a
// response to an SseSink and closes a stream whose backlog stays above SSE_BUFFER_MAX across two deferred checks (R-V65, cappedSink).
// A resume never replays more than SSE_BUFFER_MAX (R-V65): the ring holds no more, so a resume whose later events add up to more is
// older than the ring and gets one reset. The presented Last-Event-ID is only validated, never echoed or logged.
import type { Clock } from '../../ports/clock.js';
import type { CardVM, EventVM, Pos, StreamPayload, Tick } from './viewModel.js';

export interface SseSink { write(chunk: string): boolean; end(): void; onClose(cb: () => void): void; }

export const SSE_MAX_BYTES = 65_536, RING_EVENTS = 4_096, RING_MS = 600_000, COMMENT_MS = 15_000;
/** R-V65 (amends the stream backpressure ruling; spec-edit list 12 §3.10.5): a stream whose backlog — the bytes its reader has not
 *  taken, measured in a deferred check after Node had a chance to flush — is above 1 MiB at two consecutive checks is closed and
 *  counted SEC_VIZ_LIMIT once (the page reconnects); a resume never replays more than 1 MiB. */
export const SSE_BUFFER_MAX = 1_048_576;
/** R-V72 (spec-edit list 12 §3.10): besides its count and age limits, the resume ring keeps at most SSE_BUFFER_MAX bytes of framed
 *  messages, the most a resume may replay (R-V65), so a resume whose later events add up to more is older than the ring: one reset. */
export const RING_MAX_BYTES = SSE_BUFFER_MAX;
export const LAST_EVENT_ID_RE: RegExp = /^(0|[1-9][0-9]{0,15})$/;

const JSON_UNSAFE = /[<>&\u{2028}\u{2029}]/gu;

/** JSON with <, >, &, U+2028, U+2029 as \u escapes (12 §3.10.4); the one serializer of every served body and stream message.
 *  http.ts re-exports it. */
export function escapeJson(v: unknown): string {
  return (JSON.stringify(v) ?? 'null').replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** `id: <n>\nevent: <type>\ndata: <escapeJson(p)>\n\n` (JSON carries no raw line break, so data is one line). */
export function frameSse(id: number, p: StreamPayload): string {
  return `id: ${id}\nevent: ${p.type}\ndata: ${escapeJson(p)}\n\n`;
}

const COMMENT = ': \n\n';

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The serialized size of one array element. escapeJson works per character, so a payload's serialized length is that of its empty
 *  form plus, per array, every element's own length and the commas between them. */
function size(x: unknown): number {
  return bytes(escapeJson(x));
}

/** Bytes an element of `len` adds to a JSON array that already holds `count` elements. */
function added(len: number, count: number): number {
  return len + (count > 0 ? 1 : 0);
}

function comparePos(a: Pos, b: Pos): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

type Timeline = Extract<StreamPayload, { type: 'timeline' }>;
type Snapshot = Extract<StreamPayload, { type: 'room_snapshot' }>;

/** An event with its cards: an event and its card never travel apart. A card whose event is not in the payload joins the group of the
 *  last event at or before it (or the first group). */
interface Group { event: EventVM | null; eventLen: number; cards: CardVM[]; cardLens: number[]; height: number; }

function groupsOf(p: Timeline): Group[] {
  const groups: Group[] = p.events.map((e) => ({ event: e, eventLen: size(e), cards: [], cardLens: [], height: e.at[0] }));
  const byPos = new Map<string, Group>();
  for (const g of groups) if (g.event !== null) byPos.set(g.event.at.join('.'), g);
  for (const c of p.cards) {
    let g = byPos.get(c.at.join('.'))
      ?? groups.filter((x) => x.event !== null && comparePos(x.event.at, c.at) <= 0).at(-1) ?? groups[0];
    if (g === undefined) {
      g = { event: null, eventLen: 0, cards: [], cardLens: [], height: c.at[0] };
      groups.push(g);
    }
    g.cards.push(c);
    g.cardLens.push(size(c));
  }
  return groups;
}

interface Part { events: EventVM[]; cards: CardVM[]; ticks: Tick[]; first: boolean; size: number; }

/** A timeline payload over 64 KiB as parts that each fit, or null. Greedy, whole groups in order; characters and pets ride in the
 *  first part; a tick joins the part that takes the first event at or above its height, the rest join the last part. An earlier
 *  part's h1 is the height of its last event; one without events (characters and pets alone, or ticks alone) keeps the h1 before it,
 *  the first part's being just below the payload's first event; the last part keeps the payload's h1. So h1 never decreases. */
function splitTimeline(p: Timeline, firstId: number): StreamPayload[] | null {
  const groups = groupsOf(p);
  const tickLens = p.ticks.map(size);
  const extras = p.characters.length > 0 || p.pets.length > 0;
  const parts: Part[] = [];
  let nextTick = 0;
  const open = (): Part => {
    const first = parts.length === 0;
    const empty: Timeline = { ...p, events: [], cards: [], ticks: [], characters: first ? p.characters : [], pets: first ? p.pets : [] };
    return { events: [], cards: [], ticks: [], first, size: bytes(frameSse(firstId + parts.length, empty)) };
  };
  /** A part worth sending on its own. */
  const carries = (part: Part): boolean => part.events.length + part.cards.length + part.ticks.length > 0 || (part.first && extras);
  /** The size of `part` with `g` and the ticks up to its height added, and the index after those ticks. */
  const probe = (part: Part, g: Group): { size: number; tickEnd: number } => {
    let s = part.size;
    if (g.event !== null) s += added(g.eventLen, part.events.length);
    g.cardLens.forEach((l, i) => { s += added(l, part.cards.length + i); });
    let t = nextTick;
    for (; t < p.ticks.length && (p.ticks[t] as Tick).h <= g.height; t++) s += added(tickLens[t] as number, part.ticks.length + t - nextTick);
    return { size: s, tickEnd: t };
  };
  let cur = open();
  if (cur.size > SSE_MAX_BYTES) return null;
  for (const g of groups) {
    let fit = probe(cur, g);
    if (fit.size > SSE_MAX_BYTES) {
      if (!carries(cur)) return null;
      parts.push(cur);
      cur = open();
      fit = probe(cur, g);
      if (fit.size > SSE_MAX_BYTES) return null;
    }
    if (g.event !== null) cur.events.push(g.event);
    cur.cards.push(...g.cards);
    cur.ticks.push(...p.ticks.slice(nextTick, fit.tickEnd));
    nextTick = fit.tickEnd;
    cur.size = fit.size;
  }
  while (nextTick < p.ticks.length) {
    const s = cur.size + added(tickLens[nextTick] as number, cur.ticks.length);
    if (s <= SSE_MAX_BYTES) {
      cur.ticks.push(p.ticks[nextTick] as Tick);
      cur.size = s;
      nextTick++;
    } else {
      if (!carries(cur)) return null;
      parts.push(cur);
      cur = open();
    }
  }
  parts.push(cur);
  const firstHeight = p.events[0]?.at[0];
  let h1 = firstHeight === undefined ? p.h1 : Math.min(p.h1, Math.max(0, firstHeight - 1));
  return parts.map((part, i): Timeline => {
    h1 = i === parts.length - 1 ? p.h1 : Math.min(p.h1, Math.max(h1, part.events.at(-1)?.at[0] ?? h1));
    return {
      type: 'timeline', room_id: p.room_id, h1,
      events: part.events, cards: part.cards, ticks: part.ticks,
      characters: part.first ? p.characters : [], pets: part.first ? p.pets : [],
    };
  });
}

/** A snapshot over 64 KiB as messages that each fit (8a final review B1), or null when the scene alone — with its characters and
 *  pets, without cards and ticks — does not fit. The snapshot keeps the longest suffix of its cards (the newest) that fits without
 *  ticks, then the longest prefix of its ticks that still fits; the ticks left over follow, in order, as tick-only timeline parts
 *  with the snapshot's h1 (no events, cards, characters or pets), which the page appends like any timeline's ticks. */
function fitSnapshot(p: Snapshot, id: number): StreamPayload[] | null {
  let total = bytes(frameSse(id, { ...p, cards: [], ticks: [] }));
  if (total > SSE_MAX_BYTES) return null;
  let keep = 0;
  for (let i = p.cards.length - 1; i >= 0; i--) {
    const next = total + added(size(p.cards[i]), keep);
    if (next > SSE_MAX_BYTES) break;
    total = next;
    keep++;
  }
  let fit = 0;
  for (; fit < p.ticks.length; fit++) {
    const next = total + added(size(p.ticks[fit]), fit);
    if (next > SSE_MAX_BYTES) break;
    total = next;
  }
  const snapshot: Snapshot = { ...p, cards: p.cards.slice(p.cards.length - keep), ticks: p.ticks.slice(0, fit) };
  if (fit === p.ticks.length) return [snapshot];
  const rest: Timeline = { type: 'timeline', room_id: p.room_id, h1: p.window.h1, events: [], cards: [], ticks: p.ticks.slice(fit), characters: [], pets: [] };
  const parts = splitTimeline(rest, id + 1);
  return parts === null ? null : [snapshot, ...parts];
}

interface Entry { id: number; mono: number; frame: string; bytes: number; }

export class StreamHub {
  private last = 0;
  /** Consecutive ids, oldest first. */
  private readonly ring: Entry[] = [];
  /** The UTF-8 bytes of the ring's frames. */
  private ringBytes = 0;
  private readonly sinks = new Set<SseSink>();
  private byeFrame: string | null = null;
  /** The id of the last reset emitted into the ring (lastReset). */
  private resetId = 0;

  constructor(private readonly clock: Clock) {}

  /** Assigns the next id(s); a timeline payload over 64 KiB is split between events (never inside one), each part its own id; a
   *  snapshot over 64 KiB keeps as many of its newest cards as fit, then as many of its ticks as still fit, and the ticks left over
   *  follow as tick-only timeline parts with its h1 (fitSnapshot); a layout delta over 64 KiB, or a snapshot whose scene alone (no
   *  cards, no ticks) is over 64 KiB, is replaced by one reset; a single event whose framed message with its card exceeds 64 KiB
   *  (unreachable under R-V50's budgets; pinned by a test) is replaced by one reset — the whole payload, so a page never holds half of
   *  it. */
  publish(p: StreamPayload): void {
    const id = this.last + 1;
    const whole = frameSse(id, p);
    if (bytes(whole) <= SSE_MAX_BYTES) {
      this.emit(whole, p.type === 'reset');
      return;
    }
    const parts = p.type === 'timeline' ? splitTimeline(p, id) : p.type === 'room_snapshot' ? fitSnapshot(p, id) : null;
    const frames = parts?.map((q, i) => frameSse(id + i, q));
    if (frames === undefined || frames.some((f) => bytes(f) > SSE_MAX_BYTES)) this.emit(frameSse(id, { type: 'reset' }), true);
    else for (const f of frames) this.emit(f);
  }

  /** The id of the last reset this hub emitted into its ring (0 before any): published, or standing in for an oversize payload. A
   *  world whose cursor is below it would make the reloading page replay that reset and reload again (8a final review: the api's
   *  world cache is stale then). The reset attach() writes for an uncovered resume is not one: it never enters the ring. */
  lastReset(): number {
    return this.resetId;
  }

  /** A resume from `cursor` would replay rather than reset: a whole number ≤ seq at or above the oldest ring id − 1 (resumePoint's
   *  test). A world whose cursor the ring no longer covers is stale (8a final review). */
  covers(cursor: number): boolean {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.last) return false;
    this.trim();
    const oldest = this.ring[0]?.id ?? this.last + 1;
    return cursor >= oldest - 1;
  }

  /** Valid, ≤ seq and covered by the ring (or no event yet) → replay every later event of every kind, then live; else one reset
   *  (carrying the current sequence; not an event of the ring), then live. The ring holds at most SSE_BUFFER_MAX bytes (R-V72), so a
   *  replay never passes it: a resume whose later events add up to more is older than the ring, and the page reloads /api/v1/world
   *  instead of taking a replay the stream cap would cut (R-V65). Never echoed or logged. */
  attach(out: SseSink, lastEventId: string | undefined): void {
    if (this.byeFrame !== null) {
      out.write(this.byeFrame);
      out.end();
      return;
    }
    const from = this.resumePoint(lastEventId);
    if (from === null) out.write(frameSse(this.last, { type: 'reset' }));
    else for (const e of this.ring) if (e.id > from) out.write(e.frame);
    this.sinks.add(out);
    out.onClose(() => this.sinks.delete(out));
  }

  /** ': \n\n' to every sink (the 15 s timer). */
  comment(): void {
    for (const s of this.sinks) s.write(COMMENT);
  }

  /** bye to every sink, then end; a stream attached later gets bye at once. */
  close(): void {
    if (this.byeFrame !== null) return;
    const bye = frameSse(this.last + 1, { type: 'bye' });
    this.emit(bye);
    this.byeFrame = bye;
    const sinks = [...this.sinks];
    this.sinks.clear();
    for (const s of sinks) s.end();
  }

  seq(): number {
    return this.last;
  }

  /** Open streams (the idle exit). */
  open(): number {
    return this.sinks.size;
  }

  private resumePoint(lastEventId: string | undefined): number | null {
    if (lastEventId === undefined || !LAST_EVENT_ID_RE.test(lastEventId)) return null;
    const n = Number(lastEventId);
    return this.covers(n) ? n : null;
  }

  /** Records a frame framed with the next id and writes it to every sink; `reset`: the frame is a reset (lastReset). */
  private emit(frame: string, reset = false): void {
    const id = ++this.last;
    if (reset) this.resetId = id;
    const entry: Entry = { id, mono: this.clock.monoMs(), frame, bytes: bytes(frame) };
    this.ring.push(entry);
    this.ringBytes += entry.bytes;
    this.trim();
    for (const s of this.sinks) s.write(frame);
  }

  /** Drops the oldest entries past 4,096 events, older than 10 min (Δmono) or past RING_MAX_BYTES (1 MiB) of frames. */
  private trim(): void {
    const now = this.clock.monoMs();
    let drop = 0;
    let dropped = 0;
    const over = (): boolean => {
      const e = this.ring[drop] as Entry;
      return this.ring.length - drop > RING_EVENTS || now - e.mono > RING_MS || this.ringBytes - dropped > RING_MAX_BYTES;
    };
    while (drop < this.ring.length && over()) dropped += (this.ring[drop++] as Entry).bytes;
    if (drop > 0) {
      this.ring.splice(0, drop);
      this.ringBytes -= dropped;
    }
  }
}
