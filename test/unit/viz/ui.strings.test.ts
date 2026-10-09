// Plan 8a Task 14 (fix round 1): the page's catalogs (12 §3.10.5, §3.11; VIZ-39; R-V15, 10-product §3.2). A /api/v1/strings answer
// is filed under the language it names, never under the language the page asked for: in 8a the server answers en for each of the
// six, and renderWith picks the plural form by the language whose catalog holds the entry, so a ko, ja, zh-CN or fr page renders
// en's "1 file" (never "1 files"). Each language is asked for once. Before a session there is no catalog (the strings route needs
// a session), so the page bundles the en templates of the four states a tab can reach without one — equal to EN_VIZ's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, renderWith, type Catalog } from '../../../src/i18n/render.js';
import { PAGE_CODES, REASON_CODES } from '../../../src/viz/i18n/codes.js';
import { EN_VIZ } from '../../../src/viz/i18n/en.js';
import { BOOT_EN, PageCatalogs } from '../../../src/viz/ui/strings.js';

/** The page subset the server serves (api.ts pageStrings), as JSON. */
const SERVED: Catalog = JSON.parse(JSON.stringify(Object.fromEntries([...PAGE_CODES].sort().flatMap((c) => (EN_VIZ[c] === undefined ? [] : [[c, EN_VIZ[c]]])))));
const ONE = { name: 'Ann', n: 1 };

test('the page files a served catalog under the language it names: an en catalog served for a ko request renders "1 file" on a ko, ja, zh-CN or fr page', () => {
  // The defect the page had: the en templates filed under the asked language pick ko's single plural category (a probe of renderWith).
  assert.equal(renderWith({ ko: SERVED }, REASON_CODES, 'UI_VIZ_CARD_PUBLISH', ONE, 'viz', 'ko'), 'Ann shared 1 files');
  for (const asked of ['ko', 'ja', 'zh-CN', 'fr'] as const) {
    const c = new PageCatalogs();
    assert.equal(c.asked(asked), false);
    assert.equal(c.accept(asked, { lang: 'en', templates: SERVED }), true, asked);
    assert.equal(c.asked(asked), true, `${asked} is fetched once`);
    assert.equal(c.asked('es'), false);
    assert.equal(c.has(asked), true, `${asked} renders through en`);
    assert.equal(c.render('UI_VIZ_CARD_PUBLISH', ONE, asked), 'Ann shared 1 file', asked);
    assert.equal(c.render('UI_VIZ_CARD_PUBLISH', { name: 'Ann', n: 2 }, asked), 'Ann shared 2 files', asked);
  }
  // A served catalog of another language (8b) is filed under that language.
  const ko: Catalog = { UI_VIZ_CTRL_LIVE: { text: 'LIVE-KO' } };
  const c = new PageCatalogs();
  assert.equal(c.accept('ko', { lang: 'ko', templates: ko }), true);
  assert.equal(c.render('UI_VIZ_CTRL_LIVE', {}, 'ko'), 'LIVE-KO');
  assert.equal(c.has('en'), false, 'no en catalog arrived');
  // Malformed answers are refused and file nothing.
  for (const bad of [null, [], 'en', { lang: 'de', templates: SERVED }, { lang: 'en' }, { lang: 'en', templates: [] }, { lang: 'en', templates: 'x' }]) {
    const d = new PageCatalogs();
    assert.equal(d.accept('ko', bad), false, JSON.stringify(bad));
    assert.equal(d.has('ko'), false);
    assert.equal(d.has('en'), false);
    assert.equal(d.asked('ko'), false, 'a refused answer is asked for again later');
  }
});

test('before a session the page renders its four sessionless states from the bundled en table, equal to EN_VIZ\'s', () => {
  const STATES = ['UI_VIZ_LINK_EXPIRED', 'UI_VIZ_LINK_REUSED', 'UI_VIZ_NEED_LINK', 'UI_VIZ_STOPPED'];
  assert.deepEqual(Object.keys(BOOT_EN).sort(), STATES);
  for (const code of STATES) assert.deepEqual(BOOT_EN[code], EN_VIZ[code], code);
  const c = new PageCatalogs();
  for (const lang of LANGS) {
    for (const code of STATES) {
      assert.equal(c.can(code, lang), true, `${code} before a session`);
      assert.equal(c.render(code, {}, lang), renderWith({ en: EN_VIZ }, REASON_CODES, code, {}, 'viz', 'en'), `${code} in ${lang}`);
    }
    assert.equal(c.can('UI_VIZ_RECONNECTING', lang), false, 'every other code waits for the served catalog');
    assert.equal(c.has(lang), false, 'the bundled table is not a served catalog');
  }
  // A served catalog wins over the bundled table.
  const served: Catalog = { ...SERVED, UI_VIZ_STOPPED: { text: 'served stop' } };
  assert.equal(c.accept('en', { lang: 'en', templates: served }), true);
  assert.equal(c.render('UI_VIZ_STOPPED', {}, 'en'), 'served stop');
  assert.equal(c.can('UI_VIZ_RECONNECTING', 'en'), true);
});
