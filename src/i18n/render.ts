// render(code, params, channel, lang): the 10-product section 3.2 pipeline, first version (12-visualizer section 3.11; R-V15, R-V43,
// R-V53, R-V54). The one renderer: the CLI, dist/viz.js and the page (renderWith over fetched catalogs) all use it.
// Imports only src/text/sanitize.ts and uses no Node API: this file is part of the page's client program (R-V35).
import { cap, sanitize, type CapKind, type SanitizeChannel } from '../text/sanitize.js';

export type Lang = 'en' | 'ko' | 'zh-CN' | 'ja' | 'fr' | 'es';
export const LANGS: readonly Lang[] = Object.freeze(['en', 'ko', 'zh-CN', 'ja', 'fr', 'es'] as const);
export type RenderChannel = 'terminal' | 'slash' | 'systemMessage' | 'notification' | 'json' | 'log' | 'viz';
export type ParamType = 'name' | 'path' | 'label' | 'id' | 'n' | 'dur' | 'cmd' | 'reason' | 'note' | 'code' | 'text' | 'url';
export interface CatalogEntry {
  text: string;
  params?: Readonly<Record<string, ParamType>>;
  plural?: string;
  forms?: Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>;
}
export type Catalog = Readonly<Record<string, CatalogEntry>>;
export type Params = Readonly<Record<string, string | number | null>>;

/** Rendered graphemes per channel (glossary section 19 human-facing row; viz: 12 section 3.11 card text); null = no cap. */
export const CHANNEL_CAPS: Readonly<Record<RenderChannel, number | null>> = Object.freeze({
  terminal: null, slash: 4_000, systemMessage: 1_050, notification: 120, json: null, log: null, viz: 400,
});

const SANITIZE_CHANNEL: Readonly<Record<RenderChannel, SanitizeChannel>> = {
  terminal: 'terminal', slash: 'terminal', systemMessage: 'terminal', notification: 'notification', json: 'terminal', log: 'log', viz: 'viz',
};
const TEXT_CAP: Readonly<Record<'name' | 'path' | 'label' | 'id' | 'note' | 'text', CapKind>> = {
  name: 'name', path: 'path', label: 'label', id: 'label', note: 'note', text: 'card',
};
const PARAM_TYPES: ReadonlySet<string> = new Set<ParamType>(['name', 'path', 'label', 'id', 'n', 'dur', 'cmd', 'reason', 'note', 'code', 'text', 'url']);
const CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
/** URL_RE's expression (src/viz/cli/view.ts): the only URL a {url} parameter may carry, and only on the terminal channel. */
const LAUNCH_URL_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#k=[0-9a-f]{64}$/;
const NOT_A_REASON = ['UI_', 'RF_', 'SEC_', 'VIZ_', 'PH_', 'SS_', 'START_'];
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const LINK_REMOVED = '[link removed]';
const UNKNOWN = '?';
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

// The registry: per language, code -> entry (Maps, so no code reaches an object prototype).
const registry = new Map<Lang, Map<string, CatalogEntry>>();
const reasonRegistry = new Set<string>();

const own = (o: object, key: string): unknown => (Object.prototype.hasOwnProperty.call(o, key) ? (o as Record<string, unknown>)[key] : undefined);

function validEntry(e: unknown): e is CatalogEntry {
  if (typeof e !== 'object' || e === null || typeof (e as { text?: unknown }).text !== 'string') return false;
  const entry = e as CatalogEntry;
  if (entry.params !== undefined && (typeof entry.params !== 'object' || entry.params === null
    || !Object.values(entry.params).every((t) => typeof t === 'string' && PARAM_TYPES.has(t)))) return false;
  if (entry.plural !== undefined && typeof entry.plural !== 'string') return false;
  if (entry.forms !== undefined && (typeof entry.forms !== 'object' || entry.forms === null
    || !Object.values(entry.forms).every((f) => typeof f === 'string'))) return false;
  return true;
}

/** A structural key: two entries are identical when their keys are equal. */
function entryKey(e: CatalogEntry): string {
  const sortedPairs = (o: object | undefined): Array<[string, unknown]> | null =>
    o === undefined ? null : Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([e.text, sortedPairs(e.params), e.plural ?? null, sortedPairs(e.forms)]);
}

function copyEntry(e: CatalogEntry): CatalogEntry {
  const c: { -readonly [K in keyof CatalogEntry]: CatalogEntry[K] } = { text: e.text };
  if (e.params !== undefined) c.params = Object.freeze({ ...e.params });
  if (e.plural !== undefined) c.plural = e.plural;
  if (e.forms !== undefined) c.forms = Object.freeze({ ...e.forms });
  return Object.freeze(c);
}

/**
 * Merged per language; registering a code again with an identical entry is a no-op, with a different entry throws (cli.js registers
 * EN_VIZ_CLI, viz.js EN_VIZ, which contains the same CLI entries). A malformed code or entry throws; a throw registers nothing.
 */
export function registerCatalog(lang: Lang, entries: Catalog): void {
  if (!LANGS.includes(lang)) throw new Error(`registerCatalog: unknown language ${String(lang)}`);
  const current = registry.get(lang) ?? new Map<string, CatalogEntry>();
  const add = new Map<string, CatalogEntry>();
  for (const code of Object.keys(entries)) {
    const e: unknown = own(entries, code);
    if (!CODE_RE.test(code) || !validEntry(e)) throw new Error(`registerCatalog: ${lang} ${code} is not a code with a catalog entry`);
    const prev = current.get(code) ?? add.get(code);
    if (prev !== undefined && entryKey(prev) !== entryKey(e)) throw new Error(`registerCatalog: ${lang} ${code} is already registered with another entry`);
    if (prev === undefined) add.set(code, copyEntry(e));
  }
  for (const [code, e] of add) current.set(code, e);
  registry.set(lang, current);
}

/** The codes a `reason` parameter may nest (R-V43); throws on a code prefixed UI_, RF_, SEC_, VIZ_, PH_, SS_ or START_. All or nothing. */
export function registerReasonCodes(codes: Iterable<string>): void {
  const list = [...codes];
  for (const code of list) {
    if (typeof code !== 'string' || !CODE_RE.test(code) || NOT_A_REASON.some((p) => code.startsWith(p))) {
      throw new Error(`registerReasonCodes: ${String(code)} cannot be a reason code`);
    }
  }
  for (const code of list) reasonRegistry.add(code);
}

/** A catalog hit and the language of the catalog it came from (the requested one, or en after a fall-back): its plural rules. */
interface Found { e: CatalogEntry; lang: Lang; }
type Lookup = (lang: Lang, code: string) => Found | null;

interface Ctx { look: Lookup; reasons: ReadonlySet<string>; channel: RenderChannel; lang: Lang; }

const numberFormats = new Map<Lang, Intl.NumberFormat>();
const pluralRules = new Map<Lang, Intl.PluralRules>();
function numberFormat(lang: Lang): Intl.NumberFormat {
  let f = numberFormats.get(lang);
  if (f === undefined) { f = new Intl.NumberFormat(lang); numberFormats.set(lang, f); }
  return f;
}
function plurals(lang: Lang): Intl.PluralRules {
  let p = pluralRules.get(lang);
  if (p === undefined) { p = new Intl.PluralRules(lang); pluralRules.set(lang, p); }
  return p;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Step 3's template: the entry's form for the plural category of its plural parameter, else its text. The category comes from the
 * plural rules of the language the entry came from, so an en template a language falls back to keeps en's forms ("1 file", never
 * "1 files" under ko's single "other" category); n itself is still formatted for the requested language.
 */
function templateOf(found: Found, params: Params): string {
  const { e } = found;
  if (e.plural === undefined || e.forms === undefined) return e.text;
  const v = own(params, e.plural);
  if (!isNumber(v)) return e.text;
  const form = own(e.forms, plurals(found.lang).select(v)) ?? own(e.forms, 'other');
  return typeof form === 'string' ? form : e.text;
}

/** dur, in milliseconds: UI_DUR_S under 60 s, UI_DUR_MIN under 60 min, else UI_DUR_H, each rounded. */
function duration(ctx: Ctx, ms: number): string {
  const s = Math.round(ms / 1_000);
  const m = Math.round(ms / 60_000);
  const [code, n] = s < 60 ? ['UI_DUR_S', s] : m < 60 ? ['UI_DUR_MIN', m] : ['UI_DUR_H', Math.round(ms / 3_600_000)];
  const found = ctx.look(ctx.lang, code);
  return found === null ? UNKNOWN : fill(ctx, found, { n }, 1);
}

/** Step 2 for one placeholder. Depth > 0 means inside a nested reason (or unit): no further nesting. */
function value(ctx: Ctx, e: CatalogEntry, params: Params, name: string, depth: number): string {
  const type = e.params === undefined ? undefined : own(e.params, name);
  const v = own(params, name);
  switch (type) {
    case 'n':
      return isNumber(v) ? numberFormat(ctx.lang).format(v) : UNKNOWN;
    case 'dur':
      return isNumber(v) && v >= 0 ? duration(ctx, v) : UNKNOWN;
    case 'reason': {
      if (depth > 0 || typeof v !== 'string' || !ctx.reasons.has(v)) return UNKNOWN;
      const nested = ctx.look(ctx.lang, v);   // its own language: a reason that fell back to en takes en's plural rules
      return nested === null ? UNKNOWN : fill(ctx, nested, params, depth + 1);
    }
    case 'url':
      return ctx.channel === 'terminal' && typeof v === 'string' && LAUNCH_URL_RE.test(v) ? v : LINK_REMOVED;
    case 'cmd':
      // Copied from the caller's fixed command table, never from board data; a command starts with '/', so it is not sanitized.
      return typeof v === 'string' ? v.replace(CONTROL_OR_FORMAT, '') : UNKNOWN;
    case 'code':
      return typeof v === 'string' && CODE_RE.test(v) ? v : UNKNOWN;
    case 'name': case 'path': case 'label': case 'id': case 'note': case 'text':
      if (typeof v !== 'string' && !isNumber(v)) return UNKNOWN;
      return cap(sanitize(String(v), SANITIZE_CHANNEL[ctx.channel]), TEXT_CAP[type]);
    default:
      return UNKNOWN;   // a placeholder the entry does not declare
  }
}

function fill(ctx: Ctx, found: Found, params: Params, depth: number): string {
  return templateOf(found, params).replace(PLACEHOLDER, (_m, name: string) => value(ctx, found.e, params, name, depth));
}

/** Step 1's miss: the UI_INTERNAL_ERROR text, which never names the refused code (a teammate's text is never a code). */
function internalError(ctx: Ctx): string {
  const found = ctx.look(ctx.lang, 'UI_INTERNAL_ERROR');
  return found === null ? UNKNOWN : fill(ctx, found, {}, 1);
}

const graphemeCount = (s: string): number => {
  let n = 0;
  for (const _ of SEGMENTER.segment(s)) n += 1;
  return n;
};

function run(look: Lookup, reasons: ReadonlySet<string>, code: string, params: Params, channel: RenderChannel, lang: Lang): string {
  const ctx: Ctx = { look, reasons, channel, lang };
  const found = look(lang, code);
  const out = found === null ? internalError(ctx) : fill(ctx, found, params, 0);
  // Step 4. R-V53: the viz channel end-ellipsizes to its cap (and the card text's code-unit budget) instead of UI_TEXT_TOO_LONG,
  // which is not a viewer code (VIZ-39).
  if (channel === 'viz') return cap(out, 'card');
  const max = CHANNEL_CAPS[channel];
  if (max === null || graphemeCount(out) <= max) return out;
  const tooLong = look(lang, 'UI_TEXT_TOO_LONG');
  return tooLong === null ? internalError(ctx) : fill(ctx, tooLong, { code }, 1);
}

function registeredLookup(lang: Lang, code: string): Found | null {
  if (!CODE_RE.test(code)) return null;
  const e = registry.get(lang)?.get(code);
  if (e !== undefined) return { e, lang };
  const en = registry.get('en')?.get(code);
  return en === undefined ? null : { e: en, lang: 'en' };
}

/**
 * Step 1 catalog[lang][code] ?? catalog.en[code] (a miss -> UI_INTERNAL_ERROR text); step 2 each placeholder sanitized for the channel's
 * sanitize channel and capped by its type; n -> Intl.NumberFormat(lang); dur (ms) -> UI_DUR_S | UI_DUR_MIN | UI_DUR_H with
 * Intl.PluralRules(lang); reason -> nested render (depth <= 1) only when the value is a registered reason code, else '?'; url -> kept only on
 * the terminal channel and only in the launch-URL shape, else '[link removed]'; cmd copied from the fixed command table; step 3 plural form;
 * step 4 over the channel cap -> UI_TEXT_TOO_LONG, except the viz channel, which end-ellipsizes to 400 graphemes (R-V53).
 */
export function render(code: string, params: Params, channel: RenderChannel, lang: Lang): string {
  return run(registeredLookup, reasonRegistry, code, params, channel, lang);
}

/** The page's form: the same pipeline over catalogs fetched from /api/v1/strings and the reason set the client bundles (REASON_CODES). */
export function renderWith(
  catalogs: Partial<Record<Lang, Catalog>>, reasons: ReadonlySet<string>, code: string, params: Params, channel: RenderChannel, lang: Lang,
): string {
  const entryIn = (l: Lang, c: string): Found | null => {
    const cat = own(catalogs, l);
    const e = typeof cat === 'object' && cat !== null ? own(cat, c) : undefined;
    return validEntry(e) ? { e, lang: l } : null;   // a fetched catalog is data: a malformed entry is a miss
  };
  const look: Lookup = (l, c) => (CODE_RE.test(c) ? entryIn(l, c) ?? entryIn('en', c) : null);
  return run(look, reasons, code, params, channel, lang);
}
