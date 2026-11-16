// The XSS corpus of the browser smoke and fake StoreLike rooms that serve it on Plan 2-shaped data (Plan 8a Task 17; 12 §7
// T-VIZ-browser-smoke item (e), S20; Review Focus 1). XSS_CORPUS is the hostile text of 12 §7 T-VIZ-text (markup, script ends,
// javascript: and other URLs, ANSI, OSC 8 and OSC 52, bidi overrides, zero-width and tag characters, a 10 KB run, __proto__); every
// payload sets window.__pwned if it ever runs. test/fixtures/viz/xss-canaries.jsonl carries the same corpus through a demo log.
//
// xssStores(): one room whose label, branch, display names, desk paths, claim labels, notes and card labels carry the corpus. Its
// head scene (heights 0–5) holds four people, a pet, a publish of five hostile paths, a claim_take with hostile labels and an open
// request with a hostile note; after release(), the next poll tick delivers one timeline delta at height 6 — a note, an answer and a
// second request, each with hostile text — so the page plays it live: the bubbles (canvas) and the quoted frames of the log (DOM).
import { cardFor, type SceneRow } from '../../../src/viz/model/cards.js';
import type { SceneEvent } from '../../../src/viz/model/events.js';
import type { CardModel, PetInfo, RoomDelta, RoomSnapshotModel, StoreLike, TimelinePageModel } from '../../../src/viz/server/models.js';
import type { Overlay } from '../../../src/viz/source/roomSource.js';
import { ev } from '../../helpers/vizEvents.js';
import { layoutOf, PA, PB, PC, PD, peerInfo, reqOf, ROOM_ID, SA, sceneAfter, snapshotOf, SPEC, ulidOf } from '../../helpers/vizModels.js';

const ESC = String.fromCharCode(0x1b), BEL = String.fromCharCode(0x07);

/** The hostile corpus (12 §7 T-VIZ-text; the secret rows are 8b, R-V38). */
export const XSS_CORPUS: Readonly<Record<string, string>> = Object.freeze({
  img: '<img src=x onerror=window.__pwned=1>',
  script: '</script><script>window.__pwned=1</script>',
  svg: '"><svg onload=window.__pwned=1>',
  js: 'javascript:window.__pwned=1',
  ansi: `${ESC}[31mred${ESC}[0m`,
  osc8: `${ESC}]8;;https://evil.example/${BEL}click${ESC}]8;;${BEL}`,
  osc52: `${ESC}]52;c;cHduZWQ=${BEL}`,
  bidi: 'abc\u{202E}gnp.exe\u{2066}x\u{2069}',
  zeroWidth: 'zero\u{200B}width\u{200D}join\u{2060}',
  tags: 'tag\u{E0041}\u{E0042}\u{E007F}chars',
  url: 'see https://evil.example/x and data:text/html,hi',
  run: 'x'.repeat(10_000),
  proto: '__proto__',
});
const X = XSS_CORPUS;

/** The fake room's hostile fields (raw, as a board would hold them; the projection validates, sanitizes and caps them). */
export const XSS_ROOM = Object.freeze({
  label: X['img']!,                                       // ≤ 40 characters, like a demo room name
  branch: X['script']!,
  displays: Object.freeze([X['img']!, X['proto']!, `${X['ansi']!}${X['js']!}`, X['run']!]),   // PA, PB, PC, PD
  paths: Object.freeze([
    '__proto__/a.ts', 'constructor/prototype.ts', `docs/${X['svg']!}.md`, `src/${X['img']!}.ts`, `web/${X['script']!}.html`,
  ]),
  /** A claim label SEC-35 validLabel admits ([\p{L}\p{M}\p{N}_.:#<>,$@[\]()-]): markup and a scheme with no space or '='. */
  claimLabel: Object.freeze({ simple: '<script>javascript:window.__pwned', qualname: '<img>onerror:window.__pwned' }),
  /** The four notes: the head request's, then the delta's note, answer and second request. */
  notes: Object.freeze([
    `${X['img']!} ${X['url']!}`,
    `${X['script']!} ${X['bidi']!} ${X['zeroWidth']!}`,
    `${X['svg']!} ${X['ansi']!} ${X['osc8']!}`,
    `${X['js']!} ${X['tags']!} ${X['osc52']!} ${X['run']!}`,
  ]),
});

const C1 = ulidOf(1), R1 = reqOf(1), R2 = reqOf(2);
const FILE_DESKS = [1, 2, 3, 4, 5];

/** The head: people enter, a pet starts, PB publishes the five paths, the pet claims desk 1, PC asks it for the desk. */
function headEvents(): Array<{ e: SceneEvent; row: SceneRow }> {
  const [r1] = XSS_ROOM.notes;
  return [
    { e: ev('room_open', [0, 0, 0], {}), row: 'genesis' },
    { e: ev('person_enter', [1, 1, 0], { peer: PA }), row: 'join_new' },
    { e: ev('person_enter', [1, 2, 0], { peer: PB }), row: 'join_new' },
    { e: ev('person_enter', [1, 3, 0], { peer: PC }), row: 'join_new' },
    { e: ev('person_enter', [1, 4, 0], { peer: PD }), row: 'join_new' },
    { e: ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA }), row: 'seat_start' },
    {
      e: ev('publish', [3, 1001, 0], { actor: { peer: PB }, target: 1, others: FILE_DESKS.slice(1), paths: [...XSS_ROOM.paths], n: XSS_ROOM.paths.length, state: 'closed', checks: 'pass', origin: 'human' }),
      row: 'publish_cs',
    },
    {
      e: ev('claim_take', [4, 1, 0], { claimId: C1, seat: SA, desk: 1, order: 10, label: { ...XSS_ROOM.claimLabel }, granularity: 'symbol', lines: [10, 20], otherRules: false }),
      row: 'claim_new',
    },
    {
      e: ev('request_open', [5, 1, 0], { request: R1, from: { peer: PC }, holder: { seat: SA }, desk: 1, requestKind: 'handoff', estMinutes: 5, attempt: 1, note: r1! }),
      row: 'request',
    },
  ];
}

/** The live delta at height 6: PB's note on the request, the pet's answer, PD's second request. */
function deltaEvents(): Array<{ e: SceneEvent; row: SceneRow }> {
  const [, note, answer, r2] = XSS_ROOM.notes;
  return [
    { e: ev('note', [6, 1, 0], { actor: { peer: PB }, target: { request: R1 }, text: note! }), row: 'note' },
    { e: ev('answer', [6, 2, 0], { request: R1, holder: { seat: SA }, verb: 'later', by: 'human', note: answer! }), row: 'answer' },
    {
      e: ev('request_open', [6, 3, 0], { request: R2, from: { peer: PD }, holder: { seat: SA }, desk: 1, requestKind: 'go_first', estMinutes: 3, attempt: 1, note: r2! }),
      row: 'request',
    },
  ];
}

/** The cards of rows (cardFor), each request card also carrying the hostile claim label (a card label is served, never drawn). */
function cardsOf(rows: ReadonlyArray<{ e: SceneEvent; row: SceneRow }>): CardModel[] {
  const out: CardModel[] = [];
  for (const { e, row } of rows) {
    const card = cardFor(e, row);
    if (card === null) continue;
    out.push({ card: row === 'request' ? { ...card, label: XSS_ROOM.claimLabel.simple } : card, foldedAt: null });
  }
  return out;
}

/** A StoreLike over the hostile room: a fixed snapshot; tick() delivers the delta once, on the first tick after release(). */
class XssStore implements StoreLike {
  readonly ready: Promise<void> = Promise.resolve();
  private released = false;
  private sent = false;
  constructor(private readonly model: RoomSnapshotModel, private readonly delta: RoomDelta) {}
  release(): void {
    this.released = true;
  }
  snapshot(): RoomSnapshotModel {
    return this.model;
  }
  page(): Promise<TimelinePageModel | null> {
    return Promise.resolve(null);
  }
  earlier(): Promise<TimelinePageModel | null> {
    return Promise.resolve(null);
  }
  tick(): Promise<{ delta: RoomDelta | null; overlay: Overlay | null; change: 'state' | 'rebuilt' | null }> {
    if (!this.released || this.sent) return Promise.resolve({ delta: null, overlay: null, change: null });
    this.sent = true;
    return Promise.resolve({ delta: this.delta, overlay: null, change: null });
  }
}

/** One hostile room (deps.stores of startTestViewer, S20) and release(), which lets the next poll tick deliver its live delta. */
export function xssStores(): { stores: StoreLike[]; release(): void } {
  const layout = layoutOf(XSS_ROOM.paths, [PA, PB, PC, PD]);
  const head = headEvents();
  const scene = sceneAfter(head.map((x) => x.e), layout);
  const [da, db, dc, dd] = XSS_ROOM.displays;
  const pets = new Map<string, PetInfo>([[SA, { owner: PA, live: true, ssCode: null, variant: 0 }]]);
  const model = snapshotOf({
    spec: { ...SPEC, id: ROOM_ID, label: XSS_ROOM.label, branch: XSS_ROOM.branch },
    window: { h0: 0, h1: 5 }, layout, scene, pets, overlay: null,
    peers: new Map([[PA, peerInfo(da!)], [PB, peerInfo(db!)], [PC, peerInfo(dc!)], [PD, peerInfo(dd!)]]),
    cards: cardsOf(head), ticks: [{ h: 3, glyph: 'publish' }, { h: 5, glyph: 'request' }],
  });
  const delta = deltaEvents();
  const store = new XssStore(model, {
    roomId: ROOM_ID, kind: 'timeline', window: { h0: 0, h1: 6 }, events: delta.map((x) => x.e), cards: cardsOf(delta),
    ticks: [{ h: 6, glyph: 'request' }], layout: null, peers: new Map(), pets: new Map(), scene: null,
  });
  return { stores: [store], release: () => store.release() };
}
