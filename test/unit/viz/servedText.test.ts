// Plan 8a Task 9: untrusted text on the server (12 §3.10.7, §3.11 caps, §3.6 name tags; VIZ-18, VIZ-36; R-V27, R-V50, R-V52,
// S7, S8): every served string passes its validator, sanitize(…, 'viz') and its cap; name tags keep the whole handle; and
// every plain string field of the served schemas is listed in SERVED_STRING_FIELDS, whose check the projection applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIZ_CAPS, VIZ_RAW_UNITS, type CapKind } from '../../../src/text/sanitize.js';
import type { PeerRef } from '../../../src/viz/model/events.js';
import type { Layout } from '../../../src/viz/model/layout.js';
import { lookOf, lookTable } from '../../../src/viz/model/looks.js';
import type { PeerInfo, StoreLike } from '../../../src/viz/server/models.js';
import {
  createHandleTable, nameTag, projectCard, projectEvent, projectLayout, projectOverlay, projectRoom, projectScene, projectWorld, SERVED_STRING_FIELDS,
  tagCollisions, vizText, type VizTextKind,
} from '../../../src/viz/server/project.js';
import { createWorldApi, pollSinkFor } from '../../../src/viz/server/api.js';
import { StreamHub } from '../../../src/viz/server/stream.js';
import type { EventVM, StreamPayload } from '../../../src/viz/server/viewModel.js';
import { ROOTS, stringFields, viewModelSchemas } from '../../helpers/vizSchema.js';
import { ev } from '../../helpers/vizEvents.js';
import { VirtualClock } from '../../sim/vclock.js';
import {
  cardOf, FakeStore, layoutOf, OVERLAY, PA, PB, peerInfo, peerOf, ROOM_ID, SA, SB, sceneAfter, snapshotOf, SPEC, ulidOf, reqOf,
} from '../../helpers/vizModels.js';

const ESC = String.fromCharCode(0x1b), BEL = String.fromCharCode(0x07);
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s: string): number => [...SEGMENTER.segment(s)].length;

/** The hostile corpus of 12 §7 T-VIZ-text (the secret rows are 8b, R-V38). */
const CORPUS: readonly string[] = [
  '<img src=x onerror=alert(1)>',
  '</script><script>alert(1)</script>',
  'javascript:alert(1)',
  `${ESC}[31mred${ESC}[0m text`,
  `${ESC}]8;;http${':'}//evil.test${BEL}click${ESC}]8;;${BEL}`,
  `${ESC}]52;c;ZXZpbA==${BEL}copied`,
  'abc\u{202E}gnp.exe\u{2066}x\u{2069}',
  'zero\u{200B}width\u{200D}join\u{2060}\u{FEFF}',
  'tag\u{E0041}\u{E0042}\u{E007F}chars',
  `see http${':'}//evil.test/x and data:text/html,hi`,
  'x'.repeat(10_000),
  'a/'.repeat(5_000) + 'b',
];

/** The cap kind behind each served text kind. */
const CAP_OF: Readonly<Record<VizTextKind, CapKind>> = {
  name: 'name', label: 'label', path: 'path', plaque: 'plaque', branch: 'branch', room: 'room', caption: 'caption', version: 'version',
  sign: 'path', note: 'note', card: 'card', tooltip: 'tooltip',
};

function assertClean(s: string, kind: VizTextKind, what: string): void {
  assert.doesNotMatch(s, /[<>]/, `${what}: no < or >`);
  assert.doesNotMatch(s, /[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/u, `${what}: no control, format or tag character`);
  assert.doesNotMatch(s, /\p{Default_Ignorable_Code_Point}/u, `${what}: no default-ignorable (invisible) character`);
  assert.doesNotMatch(s, /:\/\/|(?<![A-Za-z0-9])(javascript|vbscript|data|blob|file|mailto):/iu, `${what}: no URL`);
  const k = CAP_OF[kind];
  assert.ok(graphemes(s) <= VIZ_CAPS[k], `${what}: ≤ ${VIZ_CAPS[k]} graphemes (${graphemes(s)})`);
  assert.ok(s.length <= VIZ_RAW_UNITS[k], `${what}: ≤ ${VIZ_RAW_UNITS[k]} code units`);
}

test("T-VIZ-text (served): every served string passes its validator, sanitize(…, 'viz') and its cap", () => {
  const kinds: VizTextKind[] = ['name', 'label', 'path', 'plaque', 'branch', 'room', 'caption', 'version', 'sign', 'note', 'card', 'tooltip'];
  for (const kind of kinds) for (const [i, raw] of CORPUS.entries()) assertClean(vizText(kind, raw), kind, `${kind} #${i}`);

  // Labels: SEC-35 validLabel, else '?'.
  assert.equal(vizText('label', 'Outer.Inner.m'), 'Outer.Inner.m');
  assert.equal(vizText('label', '(int,string)'), '(int,string)');
  assert.equal(vizText('label', 'two words'), '?', 'whitespace');
  assert.equal(vizText('label', 'a/b'), '?', 'a slash');
  assert.equal(vizText('label', 'x'.repeat(201)), '?', '201 characters');
  assert.equal(graphemes(vizText('label', 'x'.repeat(200))), 80, '200 characters pass and are capped to 80');
  assert.equal(vizText('label', 'Vec<T>'), 'Vec\u{FF1C}T\u{FF1E}');
  // Paths: validPathSyntax, else '?'.
  assert.equal(vizText('path', 'src/a.ts'), 'src/a.ts');
  for (const bad of ['/abs/x', 'C:/x', 'a\\b', 'a//b', '../x', 'a:b', '']) assert.equal(vizText('path', bad), '?', JSON.stringify(bad));
  assert.equal(vizText('path', '__proto__/a.ts'), '__proto__/a.ts', 'admitted by validPathSyntax and served as text only');
  const long = `src/${'d'.repeat(200)}/file.ts`;
  const served = vizText('path', long);
  assert.equal(graphemes(served), 80);
  assert.ok(served.startsWith('src/') && served.endsWith('file.ts') && served.includes('\u{2026}'), 'middle ellipsis');

  // Through the projection: a room whose names, labels, paths, plaques, zone signs, branch, room label, version and captions carry the corpus.
  const h = createHandleTable();
  const hostile = CORPUS[0]!;
  const paths = ['<img src=x onerror=alert(1)>/a.ts', `z/${'q'.repeat(40)}/${'p'.repeat(60)}.ts`, 'javascript:alert(1)/x.ts'];
  const layout = layoutOf(paths.filter((p) => !p.includes(':')), [PA, PB]);
  const scene = sceneAfter([
    ev('person_enter', [1, 1, 0], { peer: PA }),
    ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA }),
    ev('claim_take', [3, 1, 0], { claimId: ulidOf(1), seat: SA, desk: 1, order: 1, label: { simple: hostile, qualname: 'Mod.Vec<T>' }, granularity: 'symbol', lines: [1, 2], otherRules: false }),
    ev('request_open', [4, 1, 0], { request: reqOf(1), from: { peer: PA }, holder: { seat: SA }, desk: 1, requestKind: 'handoff', estMinutes: null, attempt: 1, note: CORPUS[3]! }),
    ev('note', [5, 1, 0], { actor: { peer: PA }, target: null, text: CORPUS[10]! }),
  ], layout);
  const peers = new Map<PeerRef, PeerInfo>([[PA, peerInfo(hostile, 'active', CORPUS[4]!)], [PB, peerInfo('B'.repeat(60), 'active', CORPUS[10]!)]]);
  const m = snapshotOf({
    spec: { ...SPEC, label: CORPUS[1]!, branch: CORPUS[9]! }, layout, scene, peers, pets: new Map(),
    cards: [{ card: cardOf([5, 1, 0], { group: 'conversation', code: 'UI_VIZ_CARD_NOTE', paths, label: CORPUS[2]!, text: CORPUS[6]!, n: 3 }), foldedAt: null }],
  });
  const w = projectWorld([m], 0, true, [{ room: ROOM_ID, height: 2, code: null, text: CORPUS[5]! }, { room: ROOM_ID, height: 3, code: null, text: CORPUS[10]! }], 0, h);
  const room = w.rooms[0]!;
  assertClean(room.label, 'room', 'room label');
  assertClean(room.branch, 'branch', 'branch');
  for (const c of room.characters) {
    assertClean(c.name, 'name', 'name');
    assertClean(c.version, 'version', 'version');
  }
  for (const d of room.layout.desks) {
    if (d.plaque !== null) assertClean(d.plaque, 'plaque', 'plaque');
    if (d.path !== null) assertClean(d.path, 'path', 'path');
  }
  assert.ok(room.layout.desks.some((d) => d.plaque !== null && d.plaque.includes('\u{2026}') && graphemes(d.plaque) === 16), 'a long basename gets a middle ellipsis at 16');
  for (const z of room.layout.zones) assertClean(z.sign, 'sign', 'zone sign');
  for (const c of w.captions) if (c.text !== null) assertClean(c.text, 'caption', 'caption');
  for (const c of room.cards) {
    for (const p of c.paths) assertClean(p, 'path', 'card path');
    if (c.label !== null) assertClean(c.label, 'label', 'card label');
    if (c.text !== null) assertClean(c.text, 'note', 'card text');
  }
  for (const [, c] of room.scene.claims) if (c.label !== null) { assertClean(c.label.simple, 'label', 'claim label'); assertClean(c.label.qualname, 'label', 'qualname'); }
  for (const e of room.scene.beat) if (e.kind === 'note') assertClean(e.text, 'note', 'note');
  const json = JSON.stringify(w);
  assert.doesNotMatch(json, /[<>]/);
  assert.ok(!json.includes(ESC));
});

// sanitize (src/text/sanitize.ts) drops every \p{Default_Ignorable_Code_Point}, so served text carries none (follow-up FS). Name tags also
// compare names without these code points (tagCollisions), which stays correct on its own.
test("T-VIZ-text (served, default-ignorable): served text carries no invisible default-ignorable mark", () => {
  const rows = ['Ann\u{034F}', 'A\u{FE0F}nn', 'Ann\u{180B}', 'Ann\u{E0100}', '\u{3164}Ann', 'Ann\u{115F}', 'Ann\u{17B4}', 'Ann\u{FFA0}'];
  for (const raw of rows) {
    assertClean(vizText('name', raw), 'name', `name ${JSON.stringify(raw)}`);
    assertClean(nameTag(raw, '9c8d7e', false), 'name', `tag ${JSON.stringify(raw)}`);
  }
});

test('T-VIZ-looks (tags): validName else peer-<handle>; equal tags or equal looks in a room show the display and the whole handle; a colliding tag never loses its handle', () => {
  const tag = (peers: ReadonlyMap<PeerRef, { display: string | null }>, h = createHandleTable()): Map<PeerRef, string> => {
    const looks = lookTable(peers.keys());
    const collide = tagCollisions(peers, looks);
    return new Map([...peers].map(([p, { display }]) => [p, nameTag(display, h.peer(p), collide.has(p))]));
  };
  const X = peerOf('3f2a1b'), Y = peerOf('9c8d7e');
  // Distinct looks for X and Y (the look test below covers equal looks).
  assert.notDeepEqual(lookOf(X), lookOf(Y));

  // validName else peer-<handle>.
  assert.equal(nameTag('Ann', '3f2a1b', false), 'Ann');
  assert.equal(nameTag('<b>Ann</b>', '3f2a1b', false), 'peer-3f2a1b');
  assert.equal(nameTag(null, '3f2a1b', false), 'peer-3f2a1b');
  assert.equal(nameTag('x'.repeat(65), '3f2a1b', false), 'peer-3f2a1b', 'over 64 raw characters');
  assert.equal(graphemes(nameTag('Abcdefghijklmnopqrstuvwxyz', '3f2a1b', false)), 20);

  // Two peers with the same 20-character name.
  const twenty = 'Abcdefghijklmnopqrst';
  let t = tag(new Map([[X, { display: twenty }], [Y, { display: twenty }]]));
  assert.ok(t.get(X)!.endsWith(' \u{B7} 3f2a1b') && t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), [...t.values()].join(' | '));
  assert.notEqual(t.get(X), t.get(Y));
  assert.ok(graphemes(t.get(X)!) <= 20);
  // Two 25-character names equal in their first 20.
  t = tag(new Map([[X, { display: `${twenty}uvwxy` }], [Y, { display: `${twenty}zzzzz` }]]));
  assert.ok(t.get(X)!.endsWith(' \u{B7} 3f2a1b') && t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), [...t.values()].join(' | '));
  // A display forging a handle suffix next to the real Ann: it shows its own handle; the real Ann stays Ann.
  t = tag(new Map([[X, { display: 'Ann' }], [Y, { display: 'Ann . 3f2a1b' }]]));
  assert.equal(t.get(X), 'Ann');
  assert.ok(t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), t.get(Y));
  assert.notEqual(t.get(Y), 'Ann . 3f2a1b');
  for (const forged of ['Ann 3f2a1b', 'Ann-3F2A1B', 'Ann - 3f2a1b9']) assert.ok(tagCollisions(new Map([[Y, { display: forged }]]), lookTable([Y])).has(Y), forged);
  // Default-ignorable code points (Mn or Lo, so validName admits them and sanitize keeps them) never hide a collision. The Mn marks
  // (U+034F, U+FE0F, U+E0100, U+180B, U+17B4) draw as nothing; the four Lo Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) draw as a
  // blank space (fix round 2), so a leading or trailing filler is a blank around 'Ann'. A name that looks like the real Ann's collides
  // with it, a forged handle suffix followed by a mark or a filler still counts as a lookalike, and a mark cannot keep a precomposed and
  // a decomposed letter apart.
  for (const twin of ['Ann\u{034F}', 'A\u{FE0F}nn', 'Ann\u{E0100}', 'Ann\u{180B}', '\u{3164}Ann', 'Ann\u{115F}', 'Ann\u{17B4}', 'Ann\u{FFA0}']) {
    t = tag(new Map([[X, { display: 'Ann' }], [Y, { display: twin }]]));
    assert.equal(t.get(X), 'Ann \u{B7} 3f2a1b', JSON.stringify(twin));
    assert.ok(t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), `${JSON.stringify(twin)}: ${t.get(Y)}`);
  }
  t = tag(new Map([[X, { display: '\u{C1}nn' }], [Y, { display: 'A\u{034F}\u{301}nn' }]]));
  assert.ok(t.get(X)!.endsWith(' \u{B7} 3f2a1b') && t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), [...t.values()].join(' | '));
  for (const mark of ['\u{034F}', '\u{FE0F}', '\u{180B}', '\u{E0100}', '\u{3164}', '\u{115F}']) {
    for (const forged of [`Ann - 3f2a1b${mark}`, `Ann - 3f2a${mark}1b`, `Ann .${mark} 3f2a1b`]) {
      t = tag(new Map([[X, { display: 'Ann' }], [Y, { display: forged }]]));
      assert.equal(t.get(X), 'Ann', JSON.stringify(forged));
      assert.ok(t.get(Y)!.endsWith(' \u{B7} 9c8d7e'), `${JSON.stringify(forged)}: ${t.get(Y)}`);
      assert.ok(tagCollisions(new Map([[Y, { display: forged }]]), lookTable([Y])).has(Y), `alone: ${JSON.stringify(forged)}`);
    }
  }
  // A Hangul filler used to draw as a blank space, so 'Ann<filler>3f2a1b' read as 'Ann 3f2a1b'. sanitize now drops it before the tag
  // is formed (follow-up FS), so the tag shows 'Ann3f2a1b' (no separator, no filler) and 'Ann<filler>Bo' shows 'AnnBo': neither draws
  // like the name or the handle suffix it imitated, and the real Ann is not made to collide.
  for (const filler of ['\u{3164}', '\u{FFA0}', '\u{115F}', '\u{1160}']) {
    t = tag(new Map([[X, { display: 'Ann' }], [Y, { display: `Ann${filler}3f2a1b` }]]));
    assert.equal(t.get(X), 'Ann', JSON.stringify(filler));
    assert.equal(t.get(Y), 'Ann3f2a1b', JSON.stringify(filler));
    t = tag(new Map([[X, { display: 'Ann Bo' }], [Y, { display: `Ann${filler}Bo` }]]));
    assert.equal(t.get(X), 'Ann Bo', JSON.stringify(filler));
    assert.equal(t.get(Y), 'AnnBo', JSON.stringify(filler));
  }
  // Neither comparison form makes a lone name collide with itself, with or without a filler.
  for (const alone of ['Ann', 'Ann Bo', 'Ann\u{3164}Bo', 'Ann - 3f2a']) assert.equal(tagCollisions(new Map([[X, { display: alone }]]), lookTable([X])).size, 0, JSON.stringify(alone));
  // A display of nothing visible is no name: peer-<handle>, like a whitespace-only one.
  for (const blank of ['\u{3164}', '\u{034F}', '\u{3164}\u{3164}\u{3164}', ' \u{115F} \u{1160} ', '\u{FFA0}']) {
    assert.equal(nameTag(blank, '9c8d7e', false), 'peer-9c8d7e', JSON.stringify(blank));
    assert.equal(nameTag(blank, '9c8d7e', true), 'peer-9c8d7e', JSON.stringify(blank));
  }
  // NFKC and case: ANN and Ann collide; so do a full-width and an ASCII name.
  t = tag(new Map([[X, { display: 'ANN' }], [Y, { display: 'Ann' }]]));
  assert.equal(t.get(X), 'ANN \u{B7} 3f2a1b');
  assert.equal(t.get(Y), 'Ann \u{B7} 9c8d7e');
  assert.equal(tagCollisions(new Map([[X, { display: '\u{FF21}nn' }], [Y, { display: 'ann' }]]), lookTable([X, Y])).size, 2);
  // Equal looks: two peers with the same look and different names both show their handle.
  const seen = new Map<string, PeerRef>();
  let twins: [PeerRef, PeerRef] | null = null;
  for (let i = 0; twins === null && i < 4096; i++) {
    const p = peerOf(i.toString(16).padStart(6, '0'));
    const k = JSON.stringify(lookOf(p));
    const q = seen.get(k);
    if (q !== undefined) twins = [q, p];
    else seen.set(k, p);
  }
  assert.ok(twins !== null);
  const [T1, T2] = twins;
  assert.deepEqual([...tagCollisions(new Map([[T1, { display: 'Mina' }], [T2, { display: 'Theo' }]]), lookTable([T1, T2]))].sort(), [T1, T2].sort());
  // A colliding tag never loses its handle, however long the handle (R-V22 extensions up to 32).
  for (const handle of ['3f2a1b', '3f2a1b9c', '3f2a1b9c8d7e6f50', '3f2a1b9c8d7e6f503f2a1b9c8d7e6f50']) {
    const s = nameTag('Abcdefghijklmnopqrstuvwxyz', handle, true);
    assert.ok(s.endsWith(` \u{B7} ${handle}`), s);
    assert.equal(graphemes(s), Math.max(20, 3 + handle.length));
  }
  // In a projected room: the two characters with equal names show their handles.
  const h = createHandleTable();
  const room = projectRoom(snapshotOf({ peers: new Map([[PA, peerInfo('Ann')], [PB, peerInfo('ann')]]), pets: new Map() }), 0, h);
  const names = room.characters.map((c) => c.name);
  assert.ok(names.includes(`Ann \u{B7} ${h.peer(PA)}`) && names.includes(`ann \u{B7} ${h.peer(PB)}`), names.join(' | '));
});

/** Each SERVED_STRING_FIELDS entry: the value served for a raw model value at that field, and the raw value itself. */
type Probe = (raw: string) => Promise<{ served: unknown; raw: string }>;

function hubRecorder(): { hub: StreamHub; payloads: StreamPayload[] } {
  const hub = new StreamHub(new VirtualClock());
  const payloads: StreamPayload[] = [];
  const pub = hub.publish.bind(hub);
  hub.publish = (p: StreamPayload): void => { payloads.push(p); pub(p); };
  return { hub, payloads };
}

const PROBES: ReadonlyMap<string, Probe> = (() => {
  const h = createHandleTable();
  const eventField = (kind: string, field: string, build: (raw: string) => Parameters<typeof projectEvent>[0]): Probe => async (raw) => {
    const vm = projectEvent(build(raw), h) as unknown as Record<string, unknown>;
    let v: unknown = vm;
    for (const f of field.split('.')) v = (v as Record<string, unknown>)[f];
    void kind;
    return { served: v, raw };
  };
  const box = (o: Partial<Record<'holdKind' | 'residence' | 'state' | 'offer', string>>) => ev('box', [3, 1, 0], {
    holdId: ulidOf(9), owner: { peer: PA }, holdKind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', desk: 1, localOnly: false, terminal: false, ...o,
  });
  const claim = (label: { simple: string; qualname: string }) => ev('claim_take', [3, 1, 0], {
    claimId: ulidOf(3), seat: SA, desk: 1, order: 1, label, granularity: 'symbol', lines: null, otherRules: false,
  });
  const sceneWith = (patch: (s: ReturnType<typeof sceneAfter>) => void) => {
    const s = sceneAfter([ev('person_enter', [1, 1, 0], { peer: PA }), ev('pet_spawn', [2, 1001, 0], { seat: SA, owner: PA })], layoutOf());
    patch(s);
    return projectScene(s, h);
  };
  const deskLayout = (path: string): Layout => ({
    version: 1, zones: [{ index: 0, key: 'z', cells: [0] }],
    desks: [layoutOf().desks[0]!, { ordinal: 1, key: path, kind: 'file', zone: 0, cell: 0, slot: 0, path, lockbox: false, first: 1 }], homeOrder: [], deskOf: new Map(),
  });
  const roomPayload = async (spec: Partial<typeof SPEC>): Promise<Extract<StreamPayload, { type: 'room' }>> => {
    const { hub, payloads } = hubRecorder();
    const clock = new VirtualClock();
    const store: StoreLike = new FakeStore(snapshotOf({ spec: { ...SPEC, ...spec } }));
    const handles = createHandleTable();
    const api = createWorldApi({ stores: [store], handles, hub, clock, demo: false, captions: [] });
    await api.world();
    pollSinkFor(api, hub, handles, clock).roomChanged(ROOM_ID);
    return payloads.find((p): p is Extract<StreamPayload, { type: 'room' }> => p.type === 'room')!;
  };
  return new Map<string, Probe>([
    ['CaptionVM.text', async (raw) => ({ served: projectWorld([snapshotOf()], 0, true, [{ room: ROOM_ID, height: 1, code: null, text: raw }], 0, h).captions[0]!.text, raw })],
    ['CardVM.label', async (raw) => ({ served: projectCard({ card: cardOf([1, 1, 0], { label: raw }), foldedAt: null }, 0, h).label, raw })],
    ['CardVM.paths', async (raw) => ({ served: projectCard({ card: cardOf([1, 1, 0], { paths: [raw] }), foldedAt: null }, 0, h).paths[0], raw })],
    ['CardVM.text', async (raw) => ({ served: projectCard({ card: cardOf([1, 1, 0], { text: raw }), foldedAt: null }, 0, h).text, raw })],
    ['CharacterVM.name', async (raw) => ({ served: projectRoom(snapshotOf({ peers: new Map([[PA, peerInfo(raw)]]), pets: new Map() }), 0, h).characters.find((c) => c.handle === h.peer(PA))!.name, raw })],
    ['CharacterVM.version', async (raw) => ({ served: projectRoom(snapshotOf({ peers: new Map([[PA, peerInfo('Ann', 'active', raw)]]), pets: new Map() }), 0, h).characters.find((c) => c.handle === h.peer(PA))!.version, raw })],
    ['EventVM.eventKind', eventField('conflict', 'eventKind', (raw) => ev('conflict', [3, 1, 0], { conflict: 'generic', source: 'event', on: { peer: PA }, desk: null, holdId: null, cid: null, eventKind: raw, line: null }))],
    ['EventVM.holdKind', eventField('box', 'holdKind', (raw) => box({ holdKind: raw }))],
    ['EventVM.residence', eventField('box', 'residence', (raw) => box({ residence: raw }))],
    ['EventVM.state', eventField('box', 'state', (raw) => box({ state: raw }))],
    ['EventVM.offer', eventField('box', 'offer', (raw) => box({ offer: raw }))],
    ['EventVM.label.simple', eventField('claim_take', 'label.simple', (raw) => claim({ simple: raw, qualname: 'Q' }))],
    ['EventVM.label.qualname', eventField('claim_take', 'label.qualname', (raw) => claim({ simple: 'S', qualname: raw }))],
    ['EventVM.note', eventField('request_open', 'note', (raw) => ev('request_open', [3, 1, 0], { request: reqOf(1), from: { peer: PA }, holder: { seat: SA }, desk: 1, requestKind: 'go_first', estMinutes: 3, attempt: 2, note: raw }))],
    ['EventVM.paths', eventField('publish', 'paths.0', (raw) => ev('publish', [3, 1001, 0], { actor: { peer: PA }, target: 1, others: [], paths: [raw], n: 1, state: 'closed', checks: 'pass', origin: 'human' }))],
    ['EventVM.text', eventField('note', 'text', (raw) => ev('note', [3, 1, 0], { actor: { peer: PA }, target: null, text: raw }))],
    ['LayoutVM.desks.path', async (raw) => ({ served: projectLayout(deskLayout(raw), h).desks[1]!.path, raw })],
    ['LayoutVM.desks.plaque', async (raw) => ({ served: projectLayout(deskLayout(`d/${raw}`), h).desks[1]!.plaque, raw: raw.slice(raw.lastIndexOf('/') + 1) })],
    ['LayoutVM.zones.sign', async (raw) => ({ served: projectLayout({ ...layoutOf(), zones: [{ index: 0, key: raw, cells: [0] }] }, h).zones[0]!.sign, raw })],
    ['OverlayVM.state', async (raw) => ({ served: projectOverlay({ ...OVERLAY, state: raw }, h)!.state, raw })],
    ['RoomVM.branch', async (raw) => ({ served: projectRoom(snapshotOf({ spec: { ...SPEC, branch: raw } }), 0, h).branch, raw })],
    ['RoomVM.label', async (raw) => ({ served: projectRoom(snapshotOf({ spec: { ...SPEC, label: raw } }), 0, h).label, raw })],
    ['SceneVM.boxes.holdKind', async (raw) => ({ served: sceneWith((s) => s.boxes.set(ulidOf(5), { owner: { peer: PA }, desk: 1, holdKind: raw, residence: 'ON_DISK', state: 'ACTIVE', localOnly: false })).boxes[0]![1].holdKind, raw })],
    ['SceneVM.boxes.residence', async (raw) => ({ served: sceneWith((s) => s.boxes.set(ulidOf(5), { owner: { peer: PA }, desk: 1, holdKind: 'PIN', residence: raw, state: 'ACTIVE', localOnly: false })).boxes[0]![1].residence, raw })],
    ['SceneVM.boxes.state', async (raw) => ({ served: sceneWith((s) => s.boxes.set(ulidOf(5), { owner: { peer: PA }, desk: 1, holdKind: 'PIN', residence: 'OFF_DISK', state: raw, localOnly: false })).boxes[0]![1].state, raw })],
    ['SceneVM.claims.label.simple', async (raw) => ({ served: sceneWith((s) => s.claims.set(ulidOf(6), claimState({ simple: raw, qualname: 'Q' }))).claims[0]![1].label!.simple, raw })],
    ['SceneVM.claims.label.qualname', async (raw) => ({ served: sceneWith((s) => s.claims.set(ulidOf(6), claimState({ simple: 'S', qualname: raw }))).claims[0]![1].label!.qualname, raw })],
    ['SceneVM.requests.status', async (raw) => ({ served: sceneWith((s) => s.requests.set(reqOf(2), { from: { peer: PA }, holder: { seat: SA }, desk: 1, status: raw })).requests[0]![1].status, raw })],
    ['StreamPayload.branch', async (raw) => ({ served: (await roomPayload({ branch: raw })).branch, raw })],
    ['StreamPayload.label', async (raw) => ({ served: (await roomPayload({ label: raw })).label, raw })],
  ]);
})();

function claimState(label: { simple: string; qualname: string }) {
  return { seat: SB, desk: 1, order: 1, label, granularity: 'symbol' as const, lines: null, stale: false, reservedFor: null, grantee: null, otherRules: false, at: { height: 3, sub: 1, k: 0 } };
}

/** Raw samples per check: hostile text for the text kinds; an in-set and an unknown value for the enum-like fields. */
const TEXT_SAMPLES: readonly string[] = ['<img src=x onerror=alert(1)>/a.ts', 'Mod.Vec<T>', `${'Abcdefghij'.repeat(3)}`, `src/${'d'.repeat(120)}/x.ts`, CORPUS[6]!];
const IN_SET: Readonly<Record<string, string>> = {
  'EventVM.eventKind': 'breach', 'EventVM.holdKind': 'INCOMING', 'EventVM.residence': 'OFF_DISK', 'EventVM.state': 'PARKED', 'EventVM.offer': 'offered',
  'OverlayVM.state': 'degraded', 'SceneVM.boxes.holdKind': 'PATCH', 'SceneVM.boxes.residence': 'ON_DISK', 'SceneVM.boxes.state': 'CONFLICTED',
  'SceneVM.requests.status': 'awaiting_human',
};

test('T-VIZ-text: every string field of the generated schemas is a named alias, a literal union or a SERVED_STRING_FIELDS entry, and the projection applies that entry\'s check', async () => {
  const schemas = viewModelSchemas();
  const fields = new Set(ROOTS.flatMap((r) => stringFields(schemas[r])));
  assert.deepEqual([...fields].sort(), [...SERVED_STRING_FIELDS.keys()].sort(), 'the plain string fields are exactly the table');
  assert.deepEqual([...PROBES.keys()].sort(), [...SERVED_STRING_FIELDS.keys()].sort(), 'one probe per entry');
  for (const [field, check] of SERVED_STRING_FIELDS) {
    const probe = PROBES.get(field)!;
    if (check === 'enum') {
      const known = IN_SET[field]!;
      assert.equal((await probe(known)).served, known, `${field}: an in-set value is served unchanged`);
      for (const unknown of ['NOT_IN_ANY_SET', 'UI_VIZ_LINK_REUSED', '__proto__', '<b>']) {
        const { served } = await probe(unknown);
        assert.ok(served === '?' || served === null, `${field}: ${unknown} → ${String(served)}`);
      }
    } else {
      for (const sample of TEXT_SAMPLES) {
        const { served, raw } = await probe(sample);
        assert.equal(served, field === 'CharacterVM.name' ? nameTag(raw, createHandleTable().peer(PA), false) : vizText(check, raw), `${field} (${check}): ${sample.slice(0, 30)}`);
      }
    }
  }
  // An id field fed a raw seat key, an oid or a path fails its alias pattern; Session and Strings have no plain string field.
  assert.deepEqual(stringFields(schemas.Session), []);
  assert.deepEqual(stringFields(schemas.Strings), []);
  void ({} as EventVM);
  void PB;
});
