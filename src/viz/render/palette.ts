// The scene palette (12 §3.6, VIZ-19): the seven body hues, their highlight and outline tones, the bounded L* adjustment that
// keeps every hue legible on the floor, the accessory tone pairs, the fixed and environment tones, the icon tones, and the
// colour science under them (sRGB <-> CIELAB with the D65 white, CIEDE2000, Machado et al. 2009). Pure: part of the page's
// client program (R-V35), so no Node API; PALETTE is computed once at module load, identically on the server and the page.
// Rulings: R-V62 (outline = mix(b, #000, 0.35) — a 0.62 outline sits at the dark floor's lightness), R-V63 (the colour-vision
// test compares against the spec's own unadjusted hues; that test lives in test/unit/viz/palette.test.ts).
import type { IconName } from './sprites.js';
export type Rgb = readonly [number, number, number];
export interface Lab { L: number; a: number; b: number; }

function hex(s: string): Rgb {
  return Object.freeze([parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)] as const);
}
const BLACK: Rgb = hex('#000000');
const WHITE: Rgb = hex('#FFFFFF');

/** 12 §3.6: the Okabe-Ito set without black, vermillion replaced by the apricot of the mockups (VD-2). Index = look hue. */
export const BODY_HUES: readonly Rgb[] = Object.freeze(['#D97757', '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#CC79A7'].map(hex));
/** The UI_VIZ_ANON_NAME_* suffixes, in hue order. */
export const HUE_NAMES: readonly string[] = Object.freeze(['APRICOT', 'AMBER', 'SKY', 'GREEN', 'LEMON', 'BLUE', 'PINK']);
/** The UI_VIZ_ACC_* suffixes, in look-accessory order (sprites.ts AccessoryName in the same order). */
export const ACCESSORY_NAMES: readonly string[] = Object.freeze(['BEANIE', 'HEADPHONES', 'SUNGLASSES', 'SCARF', 'SPROUT', 'CAP', 'BOW', 'GLASSES']);
export const FIXED: Readonly<{ cheek: Rgb; eyeWhite: Rgb; pupil: Rgb; lens: Rgb }> = Object.freeze({
  cheek: hex('#F2B49A'), eyeWhite: hex('#FFFFFF'), pupil: hex('#1A1A1A'), lens: hex('#59C3FF'),
});
export const ENV: Readonly<{ floorA: Rgb; floorB: Rgb; wall: Rgb; deskA: Rgb; deskB: Rgb; monitor: Rgb; screenIdle: Rgb; screenPublished: Rgb; accent: Rgb }> =
  Object.freeze({
    floorA: hex('#3A3346'), floorB: hex('#342E40'), wall: hex('#22222C'), deskA: hex('#6B4A2E'), deskB: hex('#8A6440'),
    monitor: hex('#2B2B38'), screenIdle: hex('#59C3FF'), screenPublished: hex('#7FE0A0'), accent: hex('#D97757'),
  });

const pair = (a: string, b: string): readonly [Rgb, Rgb] => Object.freeze([hex(a), hex(b)] as const);
/**
 * Main and alternate (a, A) tone pairs, in ACCESSORY_NAMES order; the main tone of a pair is its `a`. The beanie, headphones,
 * sunglasses and scarf mains are option A's (12 §3.6); every other value is chosen here. Each alternate's main tone clears
 * ΔE 15 against every body hue (the build test proves it), so the fallback never melts either.
 */
export const ACCESSORY_PAIRS: ReadonlyArray<{ main: readonly [Rgb, Rgb]; alt: readonly [Rgb, Rgb] }> = Object.freeze([
  { main: pair('#3E7CB1', '#2A5578'), alt: pair('#6A3FA0', '#4B2C6B') },   // beanie: blue knit; alt plum
  { main: pair('#E4E4E4', '#333344'), alt: pair('#5B3A8E', '#D9D9D9') },   // headphones: light cups, dark band; alt violet cups
  { main: pair('#222222', '#222222'), alt: pair('#F4F1E8', '#F4F1E8') },   // sunglasses: dark frames (lens l fixed); alt cream frames
  { main: pair('#C8463D', '#8E2E28'), alt: pair('#1F4F4F', '#143838') },   // scarf: red; alt deep teal
  { main: pair('#7BC043', '#3E7A2A'), alt: pair('#F7F3EA', '#3E7A2A') },   // sprout: leaf and stem; alt white blossom
  { main: pair('#2F5D8A', '#F4F1E8'), alt: pair('#D9D9D9', '#2D2D2D') },   // cap: navy with a cream button; alt light grey
  { main: pair('#E8485F', '#9E2A44'), alt: pair('#F7F3EA', '#9E2A44') },   // bow: red with a deep-red knot; alt white
  { main: pair('#3A2C24', '#3A2C24'), alt: pair('#F4F1E8', '#F4F1E8') },   // glasses: brown frames (the map draws A only); alt cream
].map((p) => Object.freeze(p)));

/**
 * The (a, A) tones of every 8×8 icon (sprites.ts ICONS; keys o, w, l are the fixed pupil, eye-white and lens tones). Icons
 * sit on the dark floor, so their tones are light or saturated; the host-refused "!" (12 §3.4) uses ORANGE_BANG instead of
 * the conflict red.
 */
const T = {
  red: '#E04A3F', deepRed: '#9E2A2A', orange: '#F08A24', green: '#5CC86A', gold: '#F2C14E', darkGold: '#B8862E', yellow: '#F0E442',
  ice: '#BDEBFF', grey: '#9AA0AE', darkGrey: '#5A5F6E', light: '#D9D9D9', wood: '#A0703A', card: '#C89858', tape: '#E8D8A8',
  purple: '#8E6BD8', badgeBlue: '#3E7CB1', pink: '#F06EA9', cyan: '#59C3FF', white: '#FFFFFF', skin: '#F2B49A', sage: '#8FB08A',
  apricot: '#D97757',
} as const;
export const ICON_TONES: Readonly<Record<IconName, readonly [Rgb, Rgb]>> = Object.freeze({
  queued: pair(T.gold, T.wood), asked: pair(T.white, T.white), awaiting_human: pair(T.skin, T.skin), undeliverable: pair(T.grey, T.red),
  accepted: pair(T.skin, T.green), declined: pair(T.red, T.red), later: pair(T.white, T.grey), daemon: pair(T.grey, T.grey),
  wake: pair(T.red, T.red), flag: pair(T.green, T.wood), tick: pair(T.green, T.green), star: pair(T.gold, T.gold),
  snowflake: pair(T.ice, T.ice), door: pair(T.wood, T.gold), speech: pair(T.white, T.white), bang: pair(T.red, T.deepRed),
  snail: pair(T.orange, T.sage), ice: pair(T.ice, T.ice), paused: pair(T.white, T.darkGrey), zzz: pair(T.white, T.white),
  parcel: pair(T.card, T.tape), cart: pair(T.grey, T.darkGrey), lockbox: pair(T.grey, T.gold), bin: pair(T.grey, T.grey),
  lock: pair(T.gold, T.grey), keyboard: pair(T.light, T.darkGrey), clipboard: pair(T.wood, T.white), bolt: pair(T.yellow, T.gold),
  version: pair(T.white, T.badgeBlue), rules: pair(T.white, T.purple), credit: pair(T.gold, T.darkGold), health: pair(T.gold, T.gold),
  plane: pair(T.white, T.grey), sparkle: pair(T.white, T.gold), confetti: pair(T.pink, T.cyan), stamp: pair(T.red, T.red),
  sign: pair(T.wood, T.white), cabinet: pair(T.grey, T.grey), more: pair(T.white, T.darkGrey), caught_up: pair(T.green, T.green),
  you: pair(T.apricot, T.white), think: pair(T.white, T.white),
});
/** The tones of the host-refused "!" (person_bang, 12 §3.4: a one-beat orange exclaim). */
export const ORANGE_BANG: readonly [Rgb, Rgb] = pair(T.orange, T.orange);

/** Per channel, rounded: round(a + (b − a)·t). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

// sRGB (IEC 61966-2-1) <-> CIE XYZ (D65) <-> CIELAB; the matrices and the white point are the sRGB primaries' (Lindbloom).
const M = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]] as const;
const MI = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]] as const;
const WHITE_XYZ = [0.95047, 1.0, 1.08883] as const;
const EPS = 216 / 24389, KAPPA = 24389 / 27;

function linear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Linear light → an sRGB byte: clipped to [0, 1], gamma-encoded, rounded. */
function encode(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
type M3 = readonly (readonly [number, number, number])[];
function apply(m: M3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]![0] * v[0] + m[0]![1] * v[1] + m[0]![2] * v[2],
    m[1]![0] * v[0] + m[1]![1] * v[1] + m[1]![2] * v[2],
    m[2]![0] * v[0] + m[2]![1] * v[1] + m[2]![2] * v[2],
  ];
}
const f = (t: number): number => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const finv = (t: number): number => { const t3 = t * t * t; return t3 > EPS ? t3 : (116 * t - 16) / KAPPA; };

export function srgbToLab(c: Rgb): Lab {
  const [x, y, z] = apply(M, [linear(c[0]), linear(c[1]), linear(c[2])]);
  const fx = f(x / WHITE_XYZ[0]), fy = f(y / WHITE_XYZ[1]), fz = f(z / WHITE_XYZ[2]);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** Out-of-gamut values are clipped per channel. */
export function labToSrgb(l: Lab): Rgb {
  const fy = (l.L + 16) / 116, fx = fy + l.a / 500, fz = fy - l.b / 200;
  const [r, g, b] = apply(MI, [finv(fx) * WHITE_XYZ[0], finv(fy) * WHITE_XYZ[1], finv(fz) * WHITE_XYZ[2]]);
  return [encode(r), encode(g), encode(b)];
}

const RAD = Math.PI / 180;
const hueAngle = (b: number, a: number): number => {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / RAD;
  return h < 0 ? h + 360 : h;
};

/** CIEDE2000 (Sharma, Wu and Dalal 2005, with their hue-mean and ΔH conventions), kL = kC = kH = 1. Symmetric. */
export function deltaE2000(x: Lab, y: Lab): number {
  const C1 = Math.hypot(x.a, x.b), C2 = Math.hypot(y.a, y.b), Cb = (C1 + C2) / 2;
  const Cb7 = Math.pow(Cb, 7);
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + Math.pow(25, 7))));
  const a1 = (1 + G) * x.a, a2 = (1 + G) * y.a;
  const c1 = Math.hypot(a1, x.b), c2 = Math.hypot(a2, y.b);
  const h1 = hueAngle(x.b, a1), h2 = hueAngle(y.b, a2);
  const dL = y.L - x.L, dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * RAD);
  const Lb = (x.L + y.L) / 2, cb = (c1 + c2) / 2;
  let hb = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hb = (h1 + h2) / 2;
    else hb = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const T2 = 1 - 0.17 * Math.cos((hb - 30) * RAD) + 0.24 * Math.cos(2 * hb * RAD) + 0.32 * Math.cos((3 * hb + 6) * RAD) - 0.2 * Math.cos((4 * hb - 63) * RAD);
  const dTheta = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2));
  const cb7 = Math.pow(cb, 7);
  const Rc = 2 * Math.sqrt(cb7 / (cb7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lb - 50, 2)) / Math.sqrt(20 + Math.pow(Lb - 50, 2));
  const Sc = 1 + 0.045 * cb, Sh = 1 + 0.015 * cb * T2;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear RGB. */
const CVD: Readonly<Record<'protan' | 'deutan' | 'tritan', M3>> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export function simulateCvd(c: Rgb, kind: 'protan' | 'deutan' | 'tritan'): Rgb {
  const [r, g, b] = apply(CVD[kind], [linear(c[0]), linear(c[1]), linear(c[2])]);
  return [encode(r), encode(g), encode(b)];
}

export interface CharacterColours { body: Rgb; highlight: Rgb; outline: Rgb; accessory: readonly [Rgb, Rgb]; }
export interface Palette { bodies: Rgb[]; characters: CharacterColours[][]; }   // characters[hue][accessory]

const HIGHLIGHT_T = 0.35, OUTLINE_T = 0.35;   // highlight = mix(b, #FFF, 0.35); outline = mix(b, #000, 0.35) (R-V62)
const OUTLINE_MIN_DE = 20, EYE_MIN_DE = 15, CHEEK_MIN_DE = 10, ACCESSORY_MIN_DE = 15;
const L_MIN = 55, L_MAX = 80;                 // the band of the option-A pastels

function scores(b: Rgb, floors: readonly Rgb[]): { outline: boolean; eye: boolean; cheek: boolean } {
  const lb = srgbToLab(b);
  const lo = srgbToLab(mix(b, BLACK, OUTLINE_T));
  return {
    outline: floors.every((fl) => deltaE2000(lo, srgbToLab(fl)) >= OUTLINE_MIN_DE),
    eye: deltaE2000(srgbToLab(FIXED.eyeWhite), lb) >= EYE_MIN_DE,
    cheek: deltaE2000(srgbToLab(FIXED.cheek), lb) >= CHEEK_MIN_DE,
  };
}

/**
 * 12 §3.6's adjustment of one body hue: unchanged when the outline clears ΔE 20 against every floor tone, the eye white
 * ΔE 15 and the cheek ΔE 10 against the body; otherwise L* moves in steps of 1 from the hue's own L* — lighter when the
 * outline test fails, else darker — with a* and b* (hue angle and chroma) kept, and the first value within L* 55–80 that
 * passes all three (tested on the rounded sRGB result) wins. Throws when none does: the palette build fails.
 */
export function adjustBody(b: Rgb, floors: readonly Rgb[] = [ENV.floorA, ENV.floorB]): Rgb {
  const s0 = scores(b, floors);
  if (s0.outline && s0.eye && s0.cheek) return b;
  const lab = srgbToLab(b);
  const dir = s0.outline ? -1 : 1;
  for (let step = 1; ; step++) {
    const L = lab.L + dir * step;
    if (dir > 0 ? L > L_MAX : L < L_MIN) break;
    if (L < L_MIN || L > L_MAX) continue;
    const c = labToSrgb({ L, a: lab.a, b: lab.b });
    const s = scores(c, floors);
    if (s.outline && s.eye && s.cheek) return c;
  }
  throw new RangeError(`palette: no L* in ${L_MIN}-${L_MAX} makes rgb(${b.join(', ')}) pass the scene-contrast tests`);
}

/**
 * The §3.6 L* adjustment of every body hue, then per (hue, accessory) the main pair when its main tone has ΔE ≥ 15
 * against the body, else the alternate pair (throws when the alternate does not qualify either). Deterministic.
 */
export function buildPalette(): Palette {
  const bodies = BODY_HUES.map((b) => adjustBody(b));
  const characters = bodies.map((body) => {
    const lb = srgbToLab(body);
    const highlight = mix(body, WHITE, HIGHLIGHT_T);
    const outline = mix(body, BLACK, OUTLINE_T);
    return ACCESSORY_PAIRS.map((p, j) => {
      let accessory = p.main;
      if (deltaE2000(srgbToLab(p.main[0]), lb) < ACCESSORY_MIN_DE) {
        if (deltaE2000(srgbToLab(p.alt[0]), lb) < ACCESSORY_MIN_DE) {
          throw new RangeError(`palette: neither tone pair of ${ACCESSORY_NAMES[j]} clears ΔE ${ACCESSORY_MIN_DE} against rgb(${body.join(', ')})`);
        }
        accessory = p.alt;
      }
      return { body, highlight, outline, accessory };
    });
  });
  return { bodies, characters };
}

function freezePalette(p: Palette): Palette {
  for (const row of p.characters) {
    for (const c of row) Object.freeze(c);
    Object.freeze(row);
  }
  Object.freeze(p.characters);
  Object.freeze(p.bodies);
  return Object.freeze(p);
}
export const PALETTE: Palette = freezePalette(buildPalette());
