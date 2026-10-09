// Plan 8a Task 12: the scene palette of 12 §3.6 (VIZ-19) — body hues, the bounded L* adjustment, the colour-vision
// distinctness check, the accessory pairs and the colour science under them (CIEDE2000, Machado et al. 2009).
// Rulings: R-V62 (outline = mix(b, #000, 0.35); PINK becomes #CF7CAA), R-V63 (the colour-vision baseline is the spec's
// own unadjusted seven hues with APRICOT, not the unmodified Okabe-Ito set).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCESSORY_NAMES, ACCESSORY_PAIRS, BODY_HUES, ENV, FIXED, HUE_NAMES, PALETTE, adjustBody, buildPalette, deltaE2000, labToSrgb, mix,
  simulateCvd, srgbToLab, type Rgb,
} from '../../../src/viz/render/palette.js';

const hex = (s: string): Rgb => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const dE = (x: Rgb, y: Rgb): number => deltaE2000(srgbToLab(x), srgbToLab(y));
const chroma = (c: Rgb): number => { const l = srgbToLab(c); return Math.hypot(l.a, l.b); };
const hueDeg = (c: Rgb): number => { const l = srgbToLab(c); const h = (Math.atan2(l.b, l.a) * 180) / Math.PI; return h < 0 ? h + 360 : h; };

test('palette constants: the seven body hues, names, fixed tones, environment tones and the option-A accessory mains are 12 \u{a7}3.6 verbatim', () => {
  assert.deepEqual(BODY_HUES, ['#D97757', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#CC79A7'].map(hex));
  assert.deepEqual(HUE_NAMES, ['APRICOT', 'AMBER', 'SKY', 'GREEN', 'LEMON', 'BLUE', 'PINK']);
  assert.deepEqual(ACCESSORY_NAMES, ['BEANIE', 'HEADPHONES', 'SUNGLASSES', 'SCARF', 'SPROUT', 'CAP', 'BOW', 'GLASSES']);
  assert.deepEqual(FIXED, { cheek: hex('#F2B49A'), eyeWhite: hex('#FFFFFF'), pupil: hex('#1A1A1A'), lens: hex('#59C3FF') });
  assert.deepEqual(ENV, {
    floorA: hex('#3A3346'), floorB: hex('#342E40'), wall: hex('#22222C'), deskA: hex('#6B4A2E'), deskB: hex('#8A6440'),
    monitor: hex('#2B2B38'), screenIdle: hex('#59C3FF'), screenPublished: hex('#7FE0A0'), accent: hex('#D97757'),
  });
  assert.equal(ACCESSORY_PAIRS.length, ACCESSORY_NAMES.length);
  assert.deepEqual(ACCESSORY_PAIRS.slice(0, 4).map((p) => p.main), [
    [hex('#3E7CB1'), hex('#2A5578')], [hex('#E4E4E4'), hex('#333344')], [hex('#222222'), hex('#222222')], [hex('#C8463D'), hex('#8E2E28')],
  ]);
});

test('mix is per channel and rounded; sRGB \u{2194} CIELAB (D65) maps white to L* 100, black to 0 and round-trips every body hue', () => {
  assert.deepEqual(mix(BLACK, WHITE, 0.5), [128, 128, 128]);                       // 127.5 rounds up
  assert.deepEqual(mix(hex('#D97757'), BLACK, 0.35), [141, 77, 57]);
  assert.deepEqual(mix(hex('#D97757'), WHITE, 0.35), [230, 167, 146]);
  const w = srgbToLab(WHITE);
  assert.ok(Math.abs(w.L - 100) < 1e-4 && Math.abs(w.a) < 1e-3 && Math.abs(w.b) < 1e-3, JSON.stringify(w));
  const k = srgbToLab(BLACK);
  assert.ok(Math.abs(k.L) < 1e-9 && Math.abs(k.a) < 1e-9 && Math.abs(k.b) < 1e-9, JSON.stringify(k));
  for (const c of [...BODY_HUES, FIXED.cheek, ENV.floorA, ENV.floorB, hex('#123456'), hex('#FEDCBA')]) assert.deepEqual(labToSrgb(srgbToLab(c)), c);
  assert.deepEqual(labToSrgb({ L: 120, a: 0, b: 0 }), WHITE);                           // out of gamut clamps
  assert.deepEqual(labToSrgb({ L: -5, a: 0, b: 0 }), BLACK);
});

/** Sharma, Wu and Dalal 2005, Table 1: the 34 CIEDE2000 test pairs (L1, a1, b1, L2, a2, b2, ΔE00). */
const SHARMA: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425], [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615], [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1], [50, -1.1848, -84.8006, 50, 0, -82.7485, 1], [50, -0.9009, -85.5211, 50, 0, -82.7485, 1],
  [50, 0, 0, 50, -1, 2, 2.3669], [50, -1, 2, 50, 0, 0, 2.3669], [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792], [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195], [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195], [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045], [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461], [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492], [50, 2.5, 0, 61, -5, 29, 22.8977], [50, 2.5, 0, 56, -27, -3, 31.903], [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1], [50, 2.5, 0, 50, 3.2972, 0, 1], [50, 2.5, 0, 50, 1.8634, 0.5757, 1], [50, 2.5, 0, 50, 3.2592, 0.335, 1],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644], [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731], [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373], [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441], [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377], [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

test('CIEDE2000 matches the Sharma et al. 2005 test vectors', () => {
  assert.equal(SHARMA.length, 34);
  SHARMA.forEach(([L1, a1, b1, L2, a2, b2, want], i) => {
    const x = { L: L1, a: a1, b: b1 }, y = { L: L2, a: a2, b: b2 };
    for (const got of [deltaE2000(x, y), deltaE2000(y, x)]) {
      assert.ok(Math.abs(got - want) <= 5e-5, `pair ${i + 1}: ${got} vs ${want}`);   // the table rounds to 4 decimals
    }
  });
  assert.equal(deltaE2000({ L: 50, a: 10, b: -10 }, { L: 50, a: 10, b: -10 }), 0);
});

test('T-VIZ-palette: for every hue, outline vs both floor tones \u{394}E \u{2265} 20, eye white vs body \u{2265} 15, cheek vs body \u{2265} 10, after the bounded L* adjustment within 55\u{2013}80', () => {
  assert.equal(PALETTE.bodies.length, 7);
  assert.equal(PALETTE.characters.length, 7);
  for (let i = 0; i < 7; i++) {
    const body = PALETTE.bodies[i]!;
    assert.equal(PALETTE.characters[i]!.length, 8);
    for (const c of PALETTE.characters[i]!) {
      assert.deepEqual(c.body, body);
      assert.deepEqual(c.highlight, mix(body, WHITE, 0.35));
      assert.deepEqual(c.outline, mix(body, BLACK, 0.35));                            // R-V62
    }
    const outline = mix(body, BLACK, 0.35);
    assert.ok(dE(outline, ENV.floorA) >= 20 && dE(outline, ENV.floorB) >= 20, `${HUE_NAMES[i]} outline vs floor`);
    assert.ok(dE(FIXED.eyeWhite, body) >= 15, `${HUE_NAMES[i]} eye white`);
    assert.ok(dE(FIXED.cheek, body) >= 10, `${HUE_NAMES[i]} cheek`);
  }
  // Every hue but PINK passes unadjusted; PINK's outline fails (\u{394}E < 20), so it moves one step lighter, hue angle and chroma kept.
  assert.deepEqual(PALETTE.bodies.slice(0, 6), BODY_HUES.slice(0, 6));
  const pink = BODY_HUES[6]!;
  assert.ok(Math.min(dE(mix(pink, BLACK, 0.35), ENV.floorA), dE(mix(pink, BLACK, 0.35), ENV.floorB)) < 20);
  assert.deepEqual(PALETTE.bodies[6], hex('#CF7CAA'));                                 // R-V62
  const L0 = srgbToLab(pink).L, L1 = srgbToLab(PALETTE.bodies[6]!).L;
  assert.ok(L1 >= 55 && L1 <= 80, `adjusted L* ${L1}`);
  assert.ok(Math.abs(L1 - (L0 + 1)) < 0.5, `one step of 1 from L* ${L0}: ${L1}`);
  assert.ok(Math.abs(chroma(PALETTE.bodies[6]!) - chroma(pink)) < 1, 'chroma kept');
  assert.ok(Math.abs(hueDeg(PALETTE.bodies[6]!) - hueDeg(pink)) < 1, 'hue angle kept');
});

test('adjustBody keeps a passing hue, steps L* by 1 from the hue\u{2019}s own L* (lighter for the outline test) and throws when no L* in 55\u{2013}80 passes', () => {
  for (let i = 0; i < 6; i++) assert.deepEqual(adjustBody(BODY_HUES[i]!), BODY_HUES[i]);
  assert.deepEqual(adjustBody(BODY_HUES[6]!), hex('#CF7CAA'));
  // A grey whose outline fails moves lighter until it passes (first passing step, not the best one).
  const grey = adjustBody([128, 128, 128]);
  assert.ok(srgbToLab(grey).L > srgbToLab([128, 128, 128]).L);
  // Floor tones placed at every candidate outline make every L* in the band fail: the build fails.
  const floors: Rgb[] = [];
  for (let L = 50; L <= 85; L += 2) {
    const l = srgbToLab(BODY_HUES[0]!);
    floors.push(mix(labToSrgb({ L, a: l.a, b: l.b }), BLACK, 0.35));
  }
  assert.throws(() => adjustBody(BODY_HUES[0]!, floors), (e: unknown) => e instanceof RangeError && /no L\* in 55-80/.test(e.message));
});

test('adjustBody steps darker when the outline passes but the eye white or the cheek test fails, a* and b* kept, the first passing L* in 55\u{2013}80', () => {
  // Floor tones far from every candidate outline (pure white): the outline test always passes, so only eye white or cheek fails.
  const floors: Rgb[] = [WHITE];
  const passes = (c: Rgb): boolean => dE(FIXED.eyeWhite, c) >= 15 && dE(FIXED.cheek, c) >= 10;
  for (const [what, body] of [['cheek', FIXED.cheek], ['eye white', hex('#F0F0F4')]] as const) {
    assert.ok(!passes(body), `${what}: the start tone fails`);
    const got = adjustBody(body, floors);
    const l0 = srgbToLab(body), l1 = srgbToLab(got);
    assert.ok(l1.L < l0.L, `${what}: darker (${l0.L} -> ${l1.L})`);
    assert.ok(l1.L >= 55 && l1.L <= 80, `${what}: within the band (${l1.L})`);
    assert.ok(passes(got), `${what}: the result passes`);
    assert.ok(Math.abs(l1.a - l0.a) < 1.5 && Math.abs(l1.b - l0.b) < 1.5, `${what}: a* and b* kept`);
    // The first passing value: the candidate one step before it (when inside the band) fails.
    const k = Math.round(l0.L - l1.L);
    const before = l0.L - (k - 1);
    if (k > 1 && before <= 80) assert.ok(!passes(labToSrgb({ L: before, a: l0.a, b: l0.b })), `${what}: not the first passing step`);
  }
  // With the scene's own floor tones the same bodies go darker too (their dark outlines clear the floor by far).
  assert.ok(srgbToLab(adjustBody(FIXED.cheek)).L < srgbToLab(FIXED.cheek).L);
});

/** Machado, Oliveira and Fernandes 2009, severity 1.0 (linear RGB). */
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
} as const;
const encode = (v: number): number => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

test('simulateCvd applies the Machado et al. 2009 severity-1.0 matrices in linear RGB, clipped and re-encoded', () => {
  for (const kind of ['protan', 'deutan', 'tritan'] as const) {
    const m = MACHADO[kind];
    for (let j = 0; j < 3; j++) {
      const primary: Rgb = [j === 0 ? 255 : 0, j === 1 ? 255 : 0, j === 2 ? 255 : 0];
      assert.deepEqual(simulateCvd(primary, kind), [encode(m[0][j]), encode(m[1][j]), encode(m[2][j])], `${kind} primary ${j}`);
    }
    assert.deepEqual(simulateCvd(BLACK, kind), BLACK);
    assert.deepEqual(simulateCvd(WHITE, kind), WHITE);
  }
});

function minPairwise(cs: readonly Rgb[]): number {
  let m = Infinity;
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) m = Math.min(m, dE(cs[i]!, cs[j]!));
  return m;
}

test('T-VIZ-palette: the minimum pairwise \u{394}E of the seven (adjusted) bodies under normal vision and simulated protanopia, deuteranopia and tritanopia is \u{2265} 0.9 \u{d7} the same minimum for the spec\u{2019}s own unadjusted seven hues (R-V63)', () => {
  for (const view of ['normal', 'protan', 'deutan', 'tritan'] as const) {
    const seen = (cs: readonly Rgb[]): Rgb[] => (view === 'normal' ? [...cs] : cs.map((c) => simulateCvd(c, view)));
    const adjusted = minPairwise(seen(PALETTE.bodies));
    const reference = minPairwise(seen(BODY_HUES));
    assert.ok(reference > 5, `${view}: reference minimum ${reference}`);
    assert.ok(adjusted >= 0.9 * reference, `${view}: ${adjusted} < 0.9 \u{d7} ${reference}`);
  }
});

test('every (accessory, hue) uses the main pair when its main tone has \u{394}E \u{2265} 15 against the body, else the alternate pair, which passes', () => {
  let alternates = 0;
  for (let i = 0; i < 7; i++) {
    const body = PALETTE.bodies[i]!;
    for (let j = 0; j < 8; j++) {
      const { main, alt } = ACCESSORY_PAIRS[j]!;
      const chosen = PALETTE.characters[i]![j]!.accessory;
      if (dE(main[0], body) >= 15) assert.deepEqual(chosen, main, `${HUE_NAMES[i]} ${ACCESSORY_NAMES[j]}`);
      else {
        alternates++;
        assert.deepEqual(chosen, alt, `${HUE_NAMES[i]} ${ACCESSORY_NAMES[j]}`);
        assert.ok(dE(alt[0], body) >= 15, `${HUE_NAMES[i]} ${ACCESSORY_NAMES[j]} alternate`);
      }
    }
  }
  // The alternate pairs qualify for every hue, not just the ones that need them.
  for (const { alt } of ACCESSORY_PAIRS) for (const body of PALETTE.bodies) assert.ok(dE(alt[0], body) >= 15);
  // Option A's beanie melts into BLUE and its scarf into APRICOT (measured \u{394}E 4.8 and 13.8): those two take the alternate.
  assert.deepEqual(PALETTE.characters[5]![0]!.accessory, ACCESSORY_PAIRS[0]!.alt);
  assert.deepEqual(PALETTE.characters[0]![3]!.accessory, ACCESSORY_PAIRS[3]!.alt);
  assert.ok(alternates >= 2);
});

test('buildPalette is deterministic and PALETTE is its result', () => {
  assert.deepEqual(buildPalette(), PALETTE);
  assert.deepEqual(buildPalette(), buildPalette());
});
