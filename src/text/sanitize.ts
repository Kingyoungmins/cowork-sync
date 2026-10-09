// SEC-34 sanitize (first version, + channel viz, 12-visualizer section 9.3) and the viewer caps (12 section 3.11, R-V50).
// Imports nothing and uses no Node API: this file is part of the page's client program (R-V35). Non-ASCII characters are written as
// \u{...} escapes.

export type SanitizeChannel = 'claude' | 'deny' | 'terminal' | 'notification' | 'log' | 'viz';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LINE_BREAK = /\r\n|[\r\n\u{85}\u{2028}\u{2029}]/gu;
// C0/C1 controls except \n (every line break is \n by then), every format character (the bidi controls, zero-width characters,
// U+2060..U+2064, U+FEFF and the rest of Cf, such as the soft hyphen), every other default-ignorable code point (the Mn ones, such as
// U+034F, U+180B and the variation selectors, and the Lo Hangul fillers U+115F, U+1160, U+3164, U+FFA0: invisible or blank, so they
// could forge a name or hide a collision) and the tag block U+E0000..U+E007F. Follow-up FS; no emoji exception: the spec keeps no ZWJ.
const STRIPPED = /(?!\n)[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}]/gu;
const ESCAPE_INTRODUCER = /[\u{1B}\u{90}\u{98}\u{9B}\u{9D}\u{9E}\u{9F}]/u;
const COMMAND_TOKENS = /^(?:\s*\/\S*)+\s*/u;
// URLs: the schemes that need no '//', then any scheme with '//' (the whole scheme run is taken, so no '://' survives).
const BARE_SCHEMES = 'javascript|vbscript|data|blob|file|mailto';
const URL_BARE = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${BARE_SCHEMES}):\S*`, 'giu');
const URL_SCHEME = /(?<![A-Za-z0-9+.-])[A-Za-z0-9+.-]*:\/\/\S*/gu;
const DASH_RUN = /[-\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]{3,}/gu;
const LINK_REMOVED = '[link removed]';
const FULLWIDTH_LT = '\u{FF1C}';
const FULLWIDTH_GT = '\u{FF1E}';
const EM_DASH = '\u{2014}';

const ESC = 0x1b;
const BEL = 0x07;
const C1_ST = 0x9c;

/** Index after a CSI's parameter, intermediate and final bytes (an unfinished CSI ends at the first byte that is none of them). */
function skipCsi(s: string, j: number): number {
  while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
  while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
  if (j < s.length && s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e) j++;
  return j;
}

/** Index after an OSC, DCS, SOS, PM or APC string: through BEL or ST (ESC \ or U+009C); before any other ESC; else the end. */
function skipString(s: string, j: number): number {
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC) return s.charCodeAt(j + 1) === 0x5c ? j + 2 : j;
    j++;
  }
  return j;
}

/** Removes ANSI escape sequences whole: CSI (ESC [ and U+009B), OSC (OSC 8 and OSC 52 included), DCS, SOS, PM, APC, two-byte escapes. */
function stripEscapes(s: string): string {
  if (!ESCAPE_INTRODUCER.test(s)) return s;
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let next = -1;
    if (c === ESC) {
      const d = s.charCodeAt(i + 1);
      if (d === 0x5b) next = skipCsi(s, i + 2);                                                                  // ESC [
      else if (d === 0x5d || d === 0x50 || d === 0x58 || d === 0x5e || d === 0x5f) next = skipString(s, i + 2);   // ESC ] P X ^ _
      else {
        let j = i + 1;                                                                                           // ESC, intermediates, a final
        while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
        next = j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x7e ? j + 1 : i + 1;
      }
    } else if (c === 0x9b) next = skipCsi(s, i + 1);
    else if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) next = skipString(s, i + 1);
    if (next < 0) { i++; continue; }
    parts.push(s.slice(start, i));
    i = next;
    start = next;
  }
  parts.push(s.slice(start));
  return parts.join('');
}

/**
 * NFC; strip C0/C1 controls (keep \n only in 'claude'), ANSI CSI and OSC (incl. OSC 8 and OSC 52), bidi U+061C, U+202A..U+202E,
 * U+2066..U+2069, zero-width/format U+200B..U+200F, U+2060..U+2064, U+FEFF (every Cf character), tags U+E0000..U+E007F, lone surrogates;
 * '<' '>' -> U+FF1C U+FF1E; URLs -> '[link removed]'; leading '/' command tokens removed at the start of every line; in 'notification' and
 * 'viz' every line break (\n, \r, U+0085, U+2028, U+2029; CRLF is one) -> one space and every run of >= 3 dash-like characters -> U+2014.
 * In 'deny', 'terminal' and 'log' a line break is removed like any other control. Idempotent and total.
 */
export function sanitize(text: string, channel: SanitizeChannel): string {
  // Everything is removed before anything is recognised, so a removed character can neither shield nor build a command token, a URL or
  // a composition; after the line join, the steps only insert characters that no step acts on.
  let s = stripEscapes(text.replace(LONE_SURROGATE, ''));
  s = s.replace(LINE_BREAK, '\n').replace(STRIPPED, '').normalize('NFC');
  const sep = channel === 'claude' ? '\n' : channel === 'notification' || channel === 'viz' ? ' ' : '';
  s = s.split('\n').map((line) => line.replace(COMMAND_TOKENS, '')).join(sep);
  s = s.normalize('NFC');   // a join without a separator can put a combining mark after a base
  s = s.replace(/</g, FULLWIDTH_LT).replace(/>/g, FULLWIDTH_GT);
  s = s.replace(URL_BARE, LINK_REMOVED).replace(URL_SCHEME, LINK_REMOVED);
  if (channel === 'notification' || channel === 'viz') s = s.replace(DASH_RUN, EM_DASH);
  return s;
}

export type CapKind = 'name' | 'label' | 'path' | 'note' | 'branch' | 'room' | 'card' | 'tooltip' | 'plaque' | 'caption' | 'version';

/** User-perceived characters (graphemes) per kind (12 section 3.11; glossary section 19 and its viewer row). */
export const VIZ_CAPS: Readonly<Record<CapKind, number>> = Object.freeze({
  name: 20, label: 80, path: 80, note: 280, branch: 80, room: 40, card: 400, tooltip: 200, plaque: 16, caption: 120, version: 20,
});
export const NAME_RAW_MAX = 64;
/** R-V50: UTF-16 code units per kind: 4 x VIZ_CAPS, names NAME_RAW_MAX. */
export const VIZ_RAW_UNITS: Readonly<Record<CapKind, number>> = Object.freeze(
  Object.fromEntries((Object.keys(VIZ_CAPS) as CapKind[]).map((k) => [k, k === 'name' ? NAME_RAW_MAX : 4 * VIZ_CAPS[k]])) as Record<CapKind, number>,
);
export const MARKS_PER_GRAPHEME_MAX = 4;

const MIDDLE: ReadonlySet<CapKind> = new Set<CapKind>(['path', 'plaque', 'label']);
/** URL_BARE's schemes at the start of a string, where nothing shields them (its lookbehind sees no alphanumeric character). */
const BARE_SCHEME_START = new RegExp(String.raw`^(?:${BARE_SCHEMES}):`, 'iu');
const ELLIPSIS = '\u{2026}';
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const MARK = /\p{M}/u;

/** Drops combining marks beyond MARKS_PER_GRAPHEME_MAX in every grapheme; null when no grapheme had more. */
function trimMarksOnce(text: string): string | null {
  let changed = false;
  const parts: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    if (segment.length <= MARKS_PER_GRAPHEME_MAX) { parts.push(segment); continue; }
    let marks = 0;
    let kept = '';
    for (const cp of segment) {
      if (MARK.test(cp) && ++marks > MARKS_PER_GRAPHEME_MAX) { changed = true; continue; }
      kept += cp;
    }
    parts.push(kept);
  }
  return changed ? parts.join('') : null;
}

/** Until stable: dropping a mark (a virama, say) can split a grapheme in two, each of which is then checked again. */
function trimMarks(text: string): string {
  if (!MARK.test(text)) return text;
  let t = text;
  for (let next = trimMarksOnce(t); next !== null; next = trimMarksOnce(t)) t = next;
  return t;
}

/** How many whole graphemes, walking gs from index `from` by `step`, fit in maxG graphemes and maxU code units, and their units. */
function fit(gs: readonly string[], from: number, step: 1 | -1, maxG: number, maxU: number): { n: number; units: number } {
  let n = 0;
  let units = 0;
  for (let i = from; i >= 0 && i < gs.length && n < maxG; i += step) {
    const len = (gs[i] as string).length;
    if (units + len > maxU) break;
    units += len;
    n += 1;
  }
  return { n, units };
}

/**
 * R-V50: first cut to VIZ_RAW_UNITS[kind] code units at a grapheme boundary and drop combining marks beyond 4 per grapheme; then cap the
 * user-perceived characters (Intl.Segmenter graphemes): middle ellipsis for path, plaque and label, end ellipsis otherwise. Both budgets
 * hold for the result, the ellipsis included (it takes one grapheme and one code unit); a grapheme is never split. cap(sanitize(x, ch))
 * is sanitize-stable: a middle ellipsis never leaves a live bare-scheme URL after it.
 */
export function cap(text: string, kind: CapKind): string {
  const maxG = VIZ_CAPS[kind];
  const maxU = VIZ_RAW_UNITS[kind];
  const t = trimMarks(text);
  if (t.length <= maxG) return t;   // n code units are at most n graphemes, and maxG <= maxU
  const gs = Array.from(SEGMENTER.segment(t), (x) => x.segment);
  if (gs.length <= maxG && t.length <= maxU) return t;
  const contentG = maxG - 1;
  const contentU = maxU - 1;
  if (!MIDDLE.has(kind)) return gs.slice(0, fit(gs, 0, 1, contentG, contentU).n).join('') + ELLIPSIS;
  const front = fit(gs, 0, 1, Math.floor(contentG / 2), Math.floor(contentU / 2));
  const back = fit(gs, gs.length - 1, -1, contentG - front.n, contentU - front.units);
  // The tail follows the ellipsis, no longer the character before it: sanitize keeps "xfile:abc" (the x shields the scheme), but
  // "...file:abc" would be a live URL. Its leading graphemes are dropped while it starts with a bare scheme; a shorter tail keeps
  // both budgets, and re-sanitizing ("[link removed]") could not.
  let from = gs.length - back.n;
  while (from < gs.length && BARE_SCHEME_START.test(gs.slice(from).join(''))) from += 1;
  return gs.slice(0, front.n).join('') + ELLIPSIS + gs.slice(from).join('');
}
