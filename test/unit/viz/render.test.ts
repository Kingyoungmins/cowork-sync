import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_CAPS, LANGS, registerCatalog, registerReasonCodes, render, renderWith,
  type Catalog, type CatalogEntry, type Params, type RenderChannel,
} from '../../../src/i18n/render.js';
import { VIZ_RAW_UNITS } from '../../../src/text/sanitize.js';
import { EN_VIZ_CLI } from '../../../src/viz/cli/strings.js';
import { PAGE_CODES, REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';

const ELL = '\u{2026}';
const SEG = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s: string): string[] => Array.from(SEG.segment(s), (x) => x.segment);
const HEX64 = '0123456789abcdef'.repeat(4);
const LAUNCH = `${'http'}://127.0.0.1:43123/#k=${HEX64}`;
const has = (c: Catalog, code: string): boolean => Object.prototype.hasOwnProperty.call(c, code);
const entry = (code: string): CatalogEntry => {
  assert.ok(has(EN_VIZ, code), code);
  return EN_VIZ[code] as CatalogEntry;
};

// Test-only codes (ZT_*: no registry prefix) and the generic UI_TEXT_TOO_LONG, which is not a viewer code (VIZ-39).
const TEST_EN: Catalog = {
  ZT_HELLO: { text: 'hello {name}', params: { name: 'name' } },
  ZT_TYPES: {
    text: 'N={name}|P={path}|L={label}|I={id}|O={note}|X={text}|C={code}',
    params: { name: 'name', path: 'path', label: 'label', id: 'id', note: 'note', text: 'text', code: 'code' },
  },
  ZT_COUNT: { text: '{n} files', params: { n: 'n' }, plural: 'n', forms: { one: '{n} file', other: '{n} files' } },
  ZT_DUR: { text: 'for {d}', params: { d: 'dur' } },
  ZT_REASON: { text: 'because {reason}', params: { reason: 'reason' } },
  ZT_NESTER: { text: 'nested {reason}', params: { reason: 'reason' } },
  ZT_UNDECLARED: { text: 'a {mystery} b' },
  ZT_CMD: { text: 'run: {cmd}', params: { cmd: 'cmd' } },
  ZT_SHORT_OVER: { text: `${'x'.repeat(115)} {name}`, params: { name: 'name' } },
  ZT_HUGE: { text: 'y'.repeat(4_001) },
  ZT_WIDE: { text: '{a} {b} {c} {d} {e} {f}', params: { a: 'path', b: 'path', c: 'path', d: 'path', e: 'path', f: 'path' } },
  UI_TEXT_TOO_LONG: { text: 'text too long [{code}]', params: { code: 'code' } },
};

// What dist/viz.js does at start (R-V43, R-V54), plus the test catalog. The registry is module-global and has no reset, so these
// module-level registrations are the one shared baseline, and every test that registers anything more does so under codes no other
// test reads (ZQ_OK, ZT_NEW1, ZT_PER_LANG): the tests pass in any order (checked with --test-randomize).
registerCatalog('en', EN_VIZ);
registerReasonCodes(REASON_CODES);
registerCatalog('en', TEST_EN);
registerCatalog('ko', { ZT_HELLO: { text: '\u{C548}\u{B155} {name}', params: { name: 'name' } } });
registerCatalog('fr', {
  ZT_COUNT_FR: { text: '{n} fichiers', params: { n: 'n' }, plural: 'n', forms: { one: '{n} fichier', other: '{n} fichiers' } },
  ZT_DUR_FR: { text: 'pendant {d}', params: { d: 'dur' } },
});
registerReasonCodes(['ZT_NESTER']);

// The /api/v1/strings answer as the page receives it (R-V15): the page subset, through JSON.
const FETCHED = (JSON.parse(JSON.stringify({ lang: 'en', templates: Object.fromEntries([...PAGE_CODES].map((c) => [c, entry(c)])) })) as { templates: Catalog }).templates;

test('render looks up the language, falls back to en, sanitizes and caps every placeholder by its type, formats n and dur, nests reason once and refuses an over-cap result with UI_TEXT_TOO_LONG outside the viz channel', () => {
  assert.deepEqual([...LANGS], ['en', 'ko', 'zh-CN', 'ja', 'fr', 'es']);
  assert.deepEqual({ ...CHANNEL_CAPS }, { terminal: null, slash: 4000, systemMessage: 1050, notification: 120, json: null, log: null, viz: 400 });
  // step 1: the language, else en
  assert.equal(render('ZT_HELLO', { name: 'Ann' }, 'terminal', 'ko'), '\u{C548}\u{B155} Ann');
  for (const lang of LANGS.filter((l) => l !== 'ko')) assert.equal(render('ZT_HELLO', { name: 'Ann' }, 'terminal', lang), 'hello Ann', lang);
  // step 2: each placeholder sanitized for the channel's sanitize channel and capped by its type
  assert.equal(render('ZT_HELLO', { name: '<b>Ann</b>\u{202E}\nx' }, 'viz', 'en'), 'hello \u{FF1C}b\u{FF1E}Ann\u{FF1C}/b\u{FF1E} x');
  assert.equal(render('ZT_HELLO', { name: '<b>Ann</b>\u{202E}\nx' }, 'terminal', 'en'), 'hello \u{FF1C}b\u{FF1E}Ann\u{FF1C}/b\u{FF1E}x');
  assert.equal(render('ZT_HELLO', { name: 'see https://evil.example' }, 'slash', 'en'), 'hello see [link removed]');
  assert.equal(render('ZT_HELLO', { name: 'A'.repeat(30) }, 'viz', 'en'), `hello ${'A'.repeat(19)}${ELL}`);
  assert.equal(render('ZT_HELLO', { name: 7 }, 'viz', 'en'), 'hello 7');
  assert.equal(render('ZT_HELLO', {}, 'viz', 'en'), 'hello ?');
  assert.equal(render('ZT_HELLO', { name: null }, 'viz', 'en'), 'hello ?');
  const path = `src/${'d'.repeat(100)}/file.ts`;
  const typed = render('ZT_TYPES', {
    name: 'Ann', path, label: 'L'.repeat(90), id: 'R7K2M9QP', note: 'n'.repeat(300), text: 't'.repeat(500), code: 'NONRETRYABLE',
  }, 'terminal', 'en').split('|');
  assert.deepEqual(typed, [
    'N=Ann',
    `P=${path.slice(0, 39)}${ELL}${path.slice(-40)}`,
    `L=${'L'.repeat(39)}${ELL}${'L'.repeat(40)}`,
    'I=R7K2M9QP',
    `O=${'n'.repeat(279)}${ELL}`,
    `X=${'t'.repeat(399)}${ELL}`,
    'C=NONRETRYABLE',
  ]);
  assert.equal(render('ZT_TYPES', { code: 'not a code' }, 'terminal', 'en').split('|')[6], 'C=?');
  // every text type is sanitized for its channel's sanitize channel: markup, a URL, a bidi override and a leading command token on
  // every line; viz turns the line break into a space and the dash run into an em dash, terminal (and slash, json, log) drop the break
  const hostile = '/cowork save <x>\u{202E} https://e.example a---b\n/cowork stop c';
  const flat = 'save \u{FF1C}x\u{FF1E} [link removed] a\u{2014}b stop c';
  const joined = 'save \u{FF1C}x\u{FF1E} [link removed] a---bstop c';
  const hostileParams: Params = { name: 'Ann', path: hostile, label: hostile, id: hostile, note: hostile, text: hostile, code: 'EPOCH' };
  for (const [ch, want] of [['viz', flat], ['terminal', joined], ['slash', joined], ['json', joined], ['log', joined]] as const) {
    const fields = render('ZT_TYPES', hostileParams, ch, 'en').split('|');
    assert.deepEqual(fields, ['N=Ann', `P=${want}`, `L=${want}`, `I=${want}`, `O=${want}`, `X=${want}`, 'C=EPOCH'], ch);
    for (const f of fields) {
      assert.ok(!f.includes('\u{202E}') && !f.includes('/cowork') && !/[<>]/u.test(f) && !f.includes('://'), `${ch}: ${f}`);
    }
  }
  assert.equal(render('ZT_UNDECLARED', { mystery: 'x' }, 'terminal', 'en'), 'a ? b');
  assert.equal(render('ZT_CMD', { cmd: '/cowork doctor' }, 'terminal', 'en'), 'run: /cowork doctor');
  assert.equal(render('ZT_CMD', { cmd: '/cowork doctor\u001b[2J\n' }, 'terminal', 'en'), 'run: /cowork doctor[2J');
  // n through Intl.NumberFormat(lang); step 3: the plural form through Intl.PluralRules(lang)
  assert.equal(render('ZT_COUNT', { n: 1 }, 'terminal', 'en'), '1 file');
  assert.equal(render('ZT_COUNT', { n: 0 }, 'terminal', 'en'), '0 files');
  assert.equal(render('ZT_COUNT', { n: 1_234_567 }, 'terminal', 'en'), '1,234,567 files');
  assert.equal(render('ZT_COUNT', { n: 1_234_567 }, 'terminal', 'fr'), `${new Intl.NumberFormat('fr').format(1_234_567)} files`);
  assert.equal(render('ZT_COUNT', { n: '7' }, 'terminal', 'en'), '? files');
  assert.equal(render('ZT_COUNT', { n: Number.NaN }, 'terminal', 'en'), '? files');
  // dur (milliseconds) through UI_DUR_S | UI_DUR_MIN | UI_DUR_H and their plural forms
  const durs: ReadonlyArray<readonly [number, string]> = [
    [1_000, '1 second'], [45_000, '45 seconds'], [59_600, '1 minute'], [90_000, '2 minutes'], [3_599_000, '1 hour'], [7_200_000, '2 hours'],
  ];
  for (const [ms, want] of durs) assert.equal(render('ZT_DUR', { d: ms }, 'terminal', 'en'), `for ${want}`, String(ms));
  assert.equal(render('ZT_DUR', { d: -1 }, 'terminal', 'en'), 'for ?');
  assert.equal(render('ZT_DUR', { d: 'soon' }, 'terminal', 'en'), 'for ?');
  // step 3 for a template that fell back to en: the en plural rules (ko, ja and zh-CN have only "other"; fr counts 0 as "one"),
  // while n keeps the requested language's number format; a template the language has: that language's rules
  for (const lang of LANGS) {
    assert.equal(render('ZT_COUNT', { n: 1 }, 'terminal', lang), '1 file', lang);
    assert.equal(render('ZT_COUNT', { n: 0 }, 'terminal', lang), '0 files', lang);
    assert.equal(render('ZT_DUR', { d: 1_000 }, 'terminal', lang), 'for 1 second', lang);
    assert.equal(render('ZT_DUR', { d: 0 }, 'terminal', lang), 'for 0 seconds', lang);
    assert.equal(renderWith({ en: FETCHED }, REASON_CODES, 'UI_DUR_MIN', { n: 1 }, 'terminal', lang), '1 minute', lang);
  }
  assert.equal(render('ZT_COUNT_FR', { n: 0 }, 'terminal', 'fr'), '0 fichier');
  assert.equal(render('ZT_COUNT_FR', { n: 2 }, 'terminal', 'fr'), '2 fichiers');
  assert.equal(render('ZT_DUR_FR', { d: 0 }, 'terminal', 'fr'), 'pendant 0 seconds', 'the nested UI_DUR_S fell back to en');
  // reason: nested once (depth <= 1)
  assert.equal(render('ZT_REASON', { reason: 'EPOCH' }, 'viz', 'en'), `because ${entry('EPOCH').text}`);
  assert.equal(render('ZT_REASON', { reason: 'ZT_NESTER' }, 'viz', 'en'), 'because nested ?');
  // step 4: over the channel cap -> UI_TEXT_TOO_LONG outside viz; no cap -> unchanged
  assert.equal(render('ZT_SHORT_OVER', { name: 'Al' }, 'notification', 'en'), `${'x'.repeat(115)} Al`);
  assert.equal(render('ZT_SHORT_OVER', { name: 'Alexandra' }, 'notification', 'en'), 'text too long [ZT_SHORT_OVER]');
  for (const ch of ['slash', 'systemMessage', 'notification'] as const) assert.equal(render('ZT_HUGE', {}, ch, 'en'), 'text too long [ZT_HUGE]', ch);
  for (const ch of ['terminal', 'json', 'log'] as const) assert.equal(render('ZT_HUGE', {}, ch, 'en'), 'y'.repeat(4_001), ch);
});

test('T-VIZ-i18n: in the viz channel an over-cap result is end-ellipsized to 400 graphemes and UI_TEXT_TOO_LONG never appears', () => {
  const huge = render('ZT_HUGE', {}, 'viz', 'en');
  assert.equal(huge, `${'y'.repeat(399)}${ELL}`);
  const p = `src/${'\u{1F600}'.repeat(100)}`;
  const wide = render('ZT_WIDE', { a: p, b: p, c: p, d: p, e: p, f: p }, 'viz', 'en');
  const g = graphemes(wide);
  assert.equal(g.length, 400);
  assert.equal(g[399], ELL);
  assert.ok(wide.length <= VIZ_RAW_UNITS.card);
  for (const s of [huge, wide]) {
    assert.ok(!s.includes('too long'));
    assert.ok(!s.includes('UI_TEXT_TOO_LONG'));
  }
  assert.equal(render('ZT_HELLO', { name: 'Ann' }, 'viz', 'en'), 'hello Ann');
});

test('render nests a reason parameter only when it is a registered reason code', () => {
  assert.equal(render('PH_FROZEN', { reason: 'EPOCH' }, 'viz', 'en'), `paused (${entry('EPOCH').text})`);
  for (const r of REASON_CODES) assert.equal(render('PH_FROZEN', { reason: r }, 'viz', 'en'), `paused (${entry(r).text})`, r);
  for (const forged of ['UI_VIZ_LINK_REUSED', 'RF_VIZ_START_FAILED', 'SEC_VIZ_BAD_HOST', 'PH_OK', 'ZZZ_CODE', 'epoch', 'EPOCH ', '']) {
    const out = render('PH_FROZEN', { reason: forged }, 'viz', 'en');
    assert.equal(out, 'paused (?)', forged);
    if (has(EN_VIZ, forged)) assert.ok(!out.includes(entry(forged).text));
  }
  assert.equal(render('PH_FROZEN', { reason: 7 }, 'viz', 'en'), 'paused (?)');
  assert.equal(render('PH_FROZEN', {}, 'viz', 'en'), 'paused (?)');
  for (const bad of ['UI_A1', 'RF_A1', 'SEC_A1', 'VIZ_A1', 'PH_A1', 'SS_A1', 'START_A1', 'lower', 'AB']) {
    assert.throws(() => registerReasonCodes([bad]), /registerReasonCodes/, bad);
  }
  // all or nothing: a refused set registers none of its codes
  registerCatalog('en', { ZQ_OK: { text: 'zq' } });
  assert.throws(() => registerReasonCodes(['ZQ_OK', 'PH_BAD']), /registerReasonCodes/);
  assert.equal(render('PH_FROZEN', { reason: 'ZQ_OK' }, 'viz', 'en'), 'paused (?)');
  registerReasonCodes(['ZQ_OK']);
  assert.equal(render('PH_FROZEN', { reason: 'ZQ_OK' }, 'viz', 'en'), 'paused (zq)');
  // renderWith takes its reason set as an argument
  assert.equal(renderWith({ en: FETCHED }, new Set<string>(), 'PH_FROZEN', { reason: 'EPOCH' }, 'viz', 'en'), 'paused (?)');
  assert.equal(renderWith({ en: FETCHED }, REASON_CODES, 'PH_FROZEN', { reason: 'EPOCH' }, 'viz', 'en'), `paused (${entry('EPOCH').text})`);
});

test('a url parameter survives only on the terminal channel and only in the launch-URL shape', () => {
  assert.ok(render('UI_VIZ_URL', { url: LAUNCH }, 'terminal', 'en').includes(LAUNCH));
  for (const ch of ['viz', 'slash', 'json', 'systemMessage', 'notification', 'log'] as RenderChannel[]) {
    const out = render('UI_VIZ_URL', { url: LAUNCH }, ch, 'en');
    assert.ok(out.includes('[link removed]'), ch);
    assert.ok(!out.includes(HEX64) && !out.includes('127.0.0.1'), ch);
  }
  const bad = [
    `${'file'}:///etc/passwd`,
    `${'http'}://evil.example:43123/#k=${HEX64}`,
    `${'http'}://127.0.0.1:43123/#k=${HEX64.slice(1)}`,
    `${'http'}://127.0.0.1:43123/#k=${HEX64}a`,
    `${'http'}://127.0.0.1:43123/#k=${HEX64.toUpperCase()}`,
    `${'http'}://127.0.0.1:0/#k=${HEX64}`,
    `${'http'}://127.0.0.1:123456/#k=${HEX64}`,
    `${'https'}://127.0.0.1:43123/#k=${HEX64}`,
    `${'http'}://127.0.0.1:43123/x#k=${HEX64}`,
    `${LAUNCH}\n`, ` ${LAUNCH}`, `${LAUNCH}&x=1`,
  ];
  for (const u of bad) {
    const out = render('UI_VIZ_URL', { url: u }, 'terminal', 'en');
    assert.ok(out.includes('[link removed]'), u);
    assert.ok(!out.includes(HEX64.slice(1, 60)) && !out.includes('passwd') && !out.includes('evil'), u);
  }
  assert.ok(render('UI_VIZ_URL', {}, 'terminal', 'en').includes('[link removed]'));
  for (const [code, e] of Object.entries(EN_VIZ)) {
    assert.equal(Object.values(e.params ?? {}).includes('url'), code === 'UI_VIZ_URL', code);
  }
});

test('registerCatalog: an identical entry again is a no-op, a different one throws; EN_VIZ contains every EN_VIZ_CLI entry unchanged', () => {
  const cliCodes = [
    'UI_VIZ_OPENED', 'UI_VIZ_URL', 'UI_VIZ_OPEN_FAILED', 'UI_VIZ_TERMINAL_ONLY', 'RF_VIZ_START_FAILED', 'RF_VIZ_BIND_FAILED', 'RF_VIZ_NO_ROOMS',
    'RF_VIZ_REPO_NOT_LIVE', 'RF_VIZ_DEMO_INVALID', 'RF_UNKNOWN_FLAG', 'START_TOOL_VERSION', 'UI_INTERNAL_ERROR',
  ];
  assert.deepEqual(Object.keys(EN_VIZ_CLI).sort(), [...cliCodes].sort());
  for (const code of cliCodes) assert.equal(EN_VIZ[code], EN_VIZ_CLI[code], code);
  // cli.js registers EN_VIZ_CLI and viz.js EN_VIZ: in either order, again, or as a structural copy, a no-op
  registerCatalog('en', EN_VIZ_CLI);
  registerCatalog('en', EN_VIZ);
  registerCatalog('en', JSON.parse(JSON.stringify(EN_VIZ)) as Catalog);
  const opened = render('UI_VIZ_OPENED', {}, 'terminal', 'en');
  assert.equal(opened, entry('UI_VIZ_OPENED').text);
  const dur = entry('UI_DUR_S');
  const url = entry('UI_VIZ_URL');
  const changed: Catalog[] = [
    { UI_VIZ_OPENED: { text: `${entry('UI_VIZ_OPENED').text} ` } },
    { UI_VIZ_URL: { ...url, params: { url: 'text' } } },
    { UI_DUR_S: { ...dur, forms: { one: '{n} sec', other: '{n} seconds' } } },
    { UI_DUR_S: { text: dur.text, params: dur.params } },
  ];
  for (const c of changed) assert.throws(() => registerCatalog('en', c), /registerCatalog/, JSON.stringify(c));
  assert.equal(render('UI_VIZ_OPENED', {}, 'terminal', 'en'), opened);
  // all or nothing
  assert.throws(() => registerCatalog('en', { ZT_NEW1: { text: 'new' }, UI_VIZ_OPENED: { text: 'different' } }), /registerCatalog/);
  assert.equal(render('ZT_NEW1', {}, 'terminal', 'en'), render('UI_INTERNAL_ERROR', {}, 'terminal', 'en'));
  // malformed codes and entries are refused
  for (const bad of [{ lower_case: { text: 'x' } }, { AB: { text: 'x' } }, { ZT_BAD: { text: 7 } }, { ZT_BAD2: null }]) {
    assert.throws(() => registerCatalog('en', bad as unknown as Catalog), /registerCatalog/);
  }
  // catalogs are per language (under this test's own code: the module-level ZT_HELLO stays en-only outside ko for the other tests)
  registerCatalog('en', { ZT_PER_LANG: { text: 'en {name}', params: { name: 'name' } } });
  registerCatalog('ja', { ZT_PER_LANG: { text: 'ja {name}', params: { name: 'name' } } });
  assert.equal(render('ZT_PER_LANG', { name: 'A' }, 'terminal', 'ja'), 'ja A');
  assert.equal(render('ZT_PER_LANG', { name: 'A' }, 'terminal', 'en'), 'en A');
  assert.equal(render('ZT_PER_LANG', { name: 'A' }, 'terminal', 'ko'), 'en A');
});

test('renderWith over a fetched catalog and the bundled reason set equals render over the registered ones', () => {
  const paramsList: Params[] = [
    {
      name: 'Ann <b>', target: 'Bo\u{202E}', n: 3, path: 'src/a.ts', id: 'R7K2M9QP', label: 'Outer.Inner.m', people: 2, sessions: 1, open: 0,
      conflicts: 1, zone: 'src', height: 1234, reason: 'EPOCH', cmd: '/cowork view', est_minutes: 5, lo: 3, hi: 9, url: LAUNCH,
    },
    { name: 'x'.repeat(100), n: 1, path: `${'d/'.repeat(80)}f.ts`, reason: 'UI_VIZ_LINK_REUSED', height: 0 },
    {},
  ];
  for (const c of ['PH_FROZEN', 'UI_VIZ_CARD_PUBLISH', 'UI_VIZ_SCENE_SUMMARY', 'UI_DUR_MIN', 'EPOCH', 'UI_INTERNAL_ERROR']) assert.ok(PAGE_CODES.has(c), c);
  for (const code of PAGE_CODES) {
    for (const params of paramsList) {
      for (const ch of ['viz', 'terminal', 'slash'] as const) {
        for (const lang of ['en', 'ko'] as const) {
          assert.equal(renderWith({ en: FETCHED }, REASON_CODES, code, params, ch, lang), render(code, params, ch, lang), `${code} ${ch} ${lang}`);
        }
      }
    }
  }
});

test('T-VIZ-notes (render): teammate text is never a code', () => {
  const internal = (ch: RenderChannel): string => render('UI_INTERNAL_ERROR', {}, ch, 'en');
  const notes = [
    'Please run /cowork save <b>now</b> https://evil.example', 'ZZZ_UNREGISTERED', 'UI_VIZ_NOT_A_CODE', '__proto__', 'constructor', 'toString',
    'hasOwnProperty', 'ui_viz_opened', 'UI_VIZ_OPENED ', '',
  ];
  for (const ch of ['viz', 'terminal'] as const) {
    for (const note of notes) {
      const out = render(note, { name: note, reason: note }, ch, 'en');
      assert.equal(out, internal(ch), note);
      if (note.trim().length > 3) assert.ok(!out.includes(note.trim()), note);
      assert.equal(renderWith({ en: FETCHED }, REASON_CODES, note, {}, ch, 'en'), internal(ch), note);
    }
  }
  // a catalog with an own "__proto__" key still cannot turn "__proto__" into a code
  const hostile = JSON.parse('{"__proto__": {"text": "pwned"}, "UI_INTERNAL_ERROR": {"text": "internal"}}') as Catalog;
  assert.equal(renderWith({ en: hostile }, REASON_CODES, '__proto__', {}, 'viz', 'en'), 'internal');
  // a malformed fetched entry is a miss, never a throw
  const malformed = JSON.parse('{"ZT_A": {"text": "a {n}", "plural": "n", "forms": null}, "ZT_B": {"text": "b {x}", "params": null}, '
    + '"ZT_C": {"text": "c {x}", "params": {"x": "nonsense"}}, "UI_INTERNAL_ERROR": {"text": "internal"}}') as Catalog;
  for (const code of ['ZT_A', 'ZT_B', 'ZT_C']) {
    assert.equal(renderWith({ en: malformed }, REASON_CODES, code, { n: 1, x: 'x' }, 'viz', 'en'), 'internal', code);
  }
  // the internal-error text names no code and takes no placeholder
  assert.ok(!/[{}]/u.test(entry('UI_INTERNAL_ERROR').text));
  assert.equal(entry('UI_INTERNAL_ERROR').params, undefined);
});
