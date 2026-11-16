// Plan 8a Task 19: the eight follow codes and the follow-end announcement (12 §3.8.1 "Wording", §3.11; FEAT-F32-09, -11;
// T-VIZ-follow-i18n, a CI lint). Each has a template
// in every registered catalog (8a: en, R-V15) with the parameters 12 §3.8.1 names, renders within the viz caps at worst-case
// parameters, and uses the "follow along" sense: no template matches the surveillance denylist of 12 §7 (8b adds the ko, ja, zh-CN,
// fr and es lists with their catalogs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_CAPS, LANGS, renderWith, type Catalog, type CatalogEntry, type Lang, type ParamType } from '../../../src/i18n/render.js';
import { VIZ_RAW_UNITS } from '../../../src/text/sanitize.js';
import { PAGE_CODES, REASON_CODES, VIZ_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';

/** The eight codes of the Task 19 brief's table and UI_VIZ_FOLLOW_ENDED (FEAT-F32-11, the follow end offered to the announcer; the fix
 *  round's §3.11 row), their group in codes.ts and their parameters with types (12 §3.8.1). */
const FOLLOW_CODES: ReadonlyArray<{ code: string; group: 'scene' | 'control'; params: Readonly<Record<string, ParamType>> }> = [
  { code: 'UI_VIZ_CTRL_FOLLOW', group: 'control', params: {} },
  { code: 'UI_VIZ_FOLLOWING', group: 'scene', params: { name: 'name' } },
  { code: 'UI_VIZ_NOW_ASKS', group: 'scene', params: { target: 'name', id: 'id' } },
  { code: 'UI_VIZ_NOW_ASKED_BY', group: 'scene', params: { target: 'name', id: 'id' } },
  // {height}: plain digits like every '#<height>' of the page, so an 'id' (final review §4a, Group B), not an 'n'
  { code: 'UI_VIZ_NOW_LAST_SHARED', group: 'scene', params: { path: 'path', height: 'id' } },
  { code: 'UI_VIZ_NOW_LAST_SHARED_TABLE', group: 'scene', params: { height: 'id' } },
  { code: 'UI_VIZ_NOW_NOTHING', group: 'scene', params: {} },
  { code: 'UI_VIZ_NOW_NOT_HERE', group: 'scene', params: { name: 'name' } },
  { code: 'UI_VIZ_FOLLOW_ENDED', group: 'scene', params: { name: 'name' } },
];

/** The registered catalogs: 8a has en only (R-V15); 8b adds the other five here and their denylists below. */
const CATALOGS: Partial<Record<Lang, Catalog>> = { en: EN_VIZ };
/** 12 §7 T-VIZ-follow-i18n's denylists, per catalog language (8a: en). */
const DENYLIST: Partial<Record<Lang, RegExp>> = { en: /monitor|track|surveil|spy|supervis|watch/i };

const SEG = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s: string): number => [...SEG.segment(s)].length;
const templatesOf = (e: CatalogEntry): string[] => [e.text, ...Object.values(e.forms ?? {}).filter((x): x is string => typeof x === 'string')];
const placeholdersOf = (s: string): string[] => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] as string);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

test('T-VIZ-follow-i18n: the eight follow codes and the follow-end code', () => {
  assert.equal(FOLLOW_CODES.length, 9);
  assert.deepEqual(Object.keys(CATALOGS), ['en'], '8a registers en only (R-V15)');
  for (const lang of Object.keys(CATALOGS) as Lang[]) assert.ok(DENYLIST[lang] !== undefined, `a denylist for ${lang}`);
  // Worst-case parameters: names at the raw name cap of wide graphemes, paths and ids far beyond theirs, the largest height.
  const worst = (filler: string): Readonly<Record<ParamType, string | number>> => ({
    name: filler.repeat(200), path: filler.repeat(2_000), label: filler.repeat(2_000), id: filler.repeat(2_000), note: filler.repeat(2_000),
    text: filler.repeat(2_000), code: 'C'.repeat(48), n: Number.MAX_SAFE_INTEGER, dur: 1e15, reason: 'EPOCH', url: '', cmd: '',
  });
  for (const { code, group, params } of FOLLOW_CODES) {
    // In the §3.11 table's group (T-VIZ-i18n compares codes.ts with the spec table) and in the page subset /api/v1/strings serves.
    assert.ok(VIZ_CODES[group].includes(code), `${code} in the ${group} group`);
    assert.ok(PAGE_CODES.has(code), `${code} is served to the page`);
    for (const [lang, cat] of Object.entries(CATALOGS) as Array<[Lang, Catalog]>) {
      const e = cat[code];
      assert.ok(e !== undefined, `${lang}: a template for ${code}`);
      // Equal placeholder sets: every template of the entry names exactly the code's parameters, each declared with its type.
      for (const t of templatesOf(e)) {
        assert.deepEqual(sorted(placeholdersOf(t)), sorted(Object.keys(params)), `${lang} ${code}: {${placeholdersOf(t).join('}, {')}}`);
        assert.doesNotMatch(t, DENYLIST[lang]!, `${lang} ${code}: "${t}" uses a surveillance word`);
      }
      assert.deepEqual(e.params ?? {}, params, `${lang} ${code}: declared parameters`);
      // Within the viz caps: the rendered text at worst-case parameters, in every language the page may ask for (en falls back).
      for (const filler of ['W', '\u{1F1F0}\u{1F1F7}', '\u{AC00}']) {
        const p = Object.fromEntries(Object.entries(params).map(([k, type]) => [k, worst(filler)[type]]));
        for (const asked of LANGS) {
          const out = renderWith(CATALOGS, REASON_CODES, code, p, 'viz', asked);
          assert.ok(out.length > 0 && graphemes(out) <= (CHANNEL_CAPS.viz as number), `${code} (${asked}): ${graphemes(out)} graphemes`);
          assert.ok(out.length <= VIZ_RAW_UNITS.card, `${code} (${asked}): ${out.length} code units`);
          assert.doesNotMatch(out, /\{[a-z_]+\}/, `${code} (${asked}): every placeholder filled`);
        }
      }
    }
  }
  // The denylist bites (a negative control), and the wording is the "follow along" sense of 12 §3.8.1.
  for (const w of ['Monitor Ann', 'tracking', 'Surveillance', 'spy on', 'Supervise', 'Watch Ann']) assert.match(w, DENYLIST.en!);
  assert.equal(EN_VIZ['UI_VIZ_CTRL_FOLLOW']!.text, 'Follow');
  assert.equal(EN_VIZ['UI_VIZ_FOLLOWING']!.text, 'Following {name}');
  assert.equal(EN_VIZ['UI_VIZ_FOLLOW_ENDED']!.text, 'Stopped following {name}');
});
