// src/i18n/claude.ts — CCI-45, glossary §19, R5-11, X-54: the one Claude template registry of every plan (row modules src/i18n/claude/{en,ko}/*.ts).
// Created by Plan 5 Task 1 with its seed rows; Plan 6 Task 3 extends it in place (renderClaudeChecked, TEMPLATE_IDS, templateCap, claudeCatalog,
// CODE_TEMPLATE_MAP and the full 07 catalogs; no move, no deletion); Plan 7 uses renderClaude. renderClaude and registerClaudeCatalog are
// exported by this module only. Claude-facing text ships in en and ko only (glossary §17 L_c, §19, §22). A leaf every tier may import:
// it imports only 8a's sanitize/cap and render types and the seed row modules.
import { cap, sanitize, type CapKind } from '../text/sanitize.js';
import type { CatalogEntry, Params, ParamType } from './render.js';
import { CLAUDE_SEED_EN } from './claude/en/seed.js';
import { CLAUDE_SEED_KO } from './claude/ko/seed.js';

export type ClaudeLang = 'en' | 'ko';

// P5-EC-4: the test-build flag (the build defines it; a source run under tsx is a test build); --release folds it to false and drops the seam.
declare const __COWORK_TEST_BUILD__: boolean | undefined;
const TEST_BUILD = typeof __COWORK_TEST_BUILD__ === 'undefined' || __COWORK_TEST_BUILD__;

const LANGS: readonly ClaudeLang[] = ['en', 'ko'];
/** A template id: a 07 row id (G4, PAUSED, T-SINCE.touch, T1R.esc, EV.FROZEN, …) or a message code; no blank, no braces. */
const TEMPLATE_ID = /^[A-Z][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*$/;
const PARAM_TYPES: ReadonlySet<string> = new Set<ParamType>(['name', 'path', 'label', 'id', 'n', 'dur', 'cmd', 'reason', 'note', 'code', 'text', 'url']);
/** A1-13: the ParamTypes that are capped, each by the 8a CapKind of the same name. */
const CAPPED: ReadonlySet<string> = new Set<CapKind>(['name', 'path', 'label', 'note']);
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const NBSP = '\u{A0}';
/** Every whitespace character (ECMAScript \s: the line breaks, U+0020, the other Zs spaces, U+FEFF). */
const WHITESPACE = /\s/gu;

const registry = new Map<ClaudeLang, Map<string, CatalogEntry>>(LANGS.map((l) => [l, new Map<string, CatalogEntry>()]));

const own = (o: object, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);

function validEntry(e: unknown): e is CatalogEntry {
  if (typeof e !== 'object' || e === null || typeof (e as { text?: unknown }).text !== 'string') return false;
  const x = e as CatalogEntry;
  if (x.params !== undefined && (typeof x.params !== 'object' || x.params === null
    || !Object.values(x.params).every((t) => typeof t === 'string' && PARAM_TYPES.has(t)))) return false;
  if (x.plural !== undefined && typeof x.plural !== 'string') return false;
  if (x.forms !== undefined && (typeof x.forms !== 'object' || x.forms === null || !Object.values(x.forms).every((f) => typeof f === 'string'))) return false;
  return true;
}

/** A structural key: two entries are identical when their keys are equal (8a's registerCatalog rule). */
function entryKey(e: CatalogEntry): string {
  const sorted = (o: object | undefined): Array<[string, unknown]> | null =>
    o === undefined ? null : Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([e.text, sorted(e.params), e.plural ?? null, sorted(e.forms)]);
}

function copyEntry(e: CatalogEntry): CatalogEntry {
  const c: { -readonly [K in keyof CatalogEntry]: CatalogEntry[K] } = { text: e.text };
  if (e.params !== undefined) c.params = Object.freeze({ ...e.params });
  if (e.plural !== undefined) c.plural = e.plural;
  if (e.forms !== undefined) c.forms = Object.freeze({ ...e.forms });
  return Object.freeze(c);
}

/** Merged per language: an identical re-registration is a no-op, a different entry for a registered id throws; a malformed id or entry throws;
 *  a throw registers nothing of the call (8a's registerCatalog rule, R5-11). */
export function registerClaudeCatalog(lang: ClaudeLang, entries: Readonly<Record<string, CatalogEntry>>): void {
  const current = registry.get(lang);
  if (current === undefined) throw new Error(`registerClaudeCatalog: ${String(lang)} is not a Claude-facing language`);
  const add = new Map<string, CatalogEntry>();
  for (const id of Object.keys(entries)) {
    const e = own(entries, id);
    if (!TEMPLATE_ID.test(id) || !validEntry(e)) throw new Error(`registerClaudeCatalog: ${lang} ${id} is not a template id with a catalog entry`);
    const prev = current.get(id) ?? add.get(id);
    if (prev !== undefined && entryKey(prev) !== entryKey(e)) throw new Error(`registerClaudeCatalog: ${lang} ${id} is already registered with another entry`);
    if (prev === undefined) add.set(id, copyEntry(e));
  }
  for (const [id, e] of add) current.set(id, e);
}

registerClaudeCatalog('en', CLAUDE_SEED_EN);
registerClaudeCatalog('ko', CLAUDE_SEED_KO);

/** Plan 5 Task 2 (ruling P5-EB-6, X-54): a frozen copy of one language's merged registry, which tools/build/claudeCatalog.ts serializes into
 *  dist/i18n/claude.<lang>.json. Read-only: registering stays registerClaudeCatalog's. */
export function claudeCatalogRows(lang: ClaudeLang): Readonly<Record<string, CatalogEntry>> {
  const current = registry.get(lang);
  if (current === undefined) throw new Error(`claudeCatalogRows: ${String(lang)} is not a Claude-facing language`);
  return Object.freeze(Object.fromEntries(current));
}

/** A1-13: a number → String(n) (no grouping); a string → sanitize(value, channel), then cap(value, kind) for ParamType name/path/label/note;
 *  null → empty; a missing param → empty (renderClaude throws first for a registered template in a test build). */
function substitute(v: unknown, type: string | undefined, channel: 'claude' | 'deny'): string {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return '';
  const s = sanitize(v, channel);
  return type !== undefined && CAPPED.has(type) ? cap(s, type as CapKind) : s;
}

/** Template text from the catalogs (lang, else en); params sanitized (8a sanitize, 'deny' for G1/K2 reasons, 'claude' elsewhere) and capped
 *  by type; a template id with no catalog entry renders the code line `[cowork-sync] <ID> k=v …` (each param in UTF-16 key order, its value
 *  substituted as above with every whitespace character — a line break the 'claude' channel keeps included — replaced by U+00A0, so the line
 *  stays one parseable line and a teammate-supplied value can never start a forged `[cowork-sync]` line). Verify pass V-5: an unregistered id never
 *  throws. A1-13 (P5-EC-5): a registered template whose placeholder has no param throws TypeError in a test build and renders it empty otherwise. */
export function renderClaude(templateId: string, params: Params, lang: ClaudeLang, channel: 'claude' | 'deny' = 'claude'): string {
  const e = registry.get(lang)?.get(templateId) ?? registry.get('en')?.get(templateId);
  if (e === undefined) {
    const keys = Object.keys(params).sort();
    return `[cowork-sync] ${templateId}` + keys.map((k) => ` ${k}=${substitute(own(params, k), undefined, channel).replace(WHITESPACE, NBSP)}`).join('');
  }
  return e.text.replace(PLACEHOLDER, (_m, name: string) => {
    if (TEST_BUILD && !Object.prototype.hasOwnProperty.call(params, name)) throw new TypeError(`renderClaude: ${templateId} has no param ${name}`);
    return substitute(own(params, name), e.params === undefined ? undefined : own(e.params, name) as string | undefined, channel);
  });
}
