// The page's catalogs (12 §3.10.5 "/api/v1/strings", §3.11; VIZ-39; R-V15; 10-product §3.2 step 1): a /api/v1/strings answer is
// filed under the language it names — in 8a the server answers { lang: 'en', templates } for each of the six — never under the
// language the page asked for, so renderWith falls back from the viewer's language to en and picks en's plural forms ("1 file",
// never "1 files" under ko's single plural category). Each language is asked for once. The strings route needs a session, so the
// page also carries the en templates of the four states a tab reaches without one (the link reused, expired or missing, and the
// viewer stopped); every other text waits for the served catalog. Pure and DOM-free (R-V33).
import { LANGS, renderWith, type Catalog, type Lang, type Params } from '../../i18n/render.js';
import { REASON_CODES } from '../i18n/codes.js';

/**
 * The en templates of the page states before a session (ui/conn.ts's terminal states: stopped, link_reused, link_expired,
 * need_link), equal to src/viz/i18n/en.ts EN_VIZ's entries (tested; the page cannot import en.ts, which is outside the client
 * program, R-V35).
 */
export const BOOT_EN: Catalog = Object.freeze({
  UI_VIZ_STOPPED: Object.freeze({ text: 'The viewer stopped. Run /cowork view to open it again.' }),
  UI_VIZ_LINK_EXPIRED: Object.freeze({ text: 'This link has expired. Run /cowork view again.' }),
  UI_VIZ_LINK_REUSED: Object.freeze({
    text: 'This link was opened twice, so the viewer stopped. If you did not open it twice, another program or user on this PC may have '
      + 'opened it. Run /cowork view again.',
  }),
  UI_VIZ_NEED_LINK: Object.freeze({ text: 'Open the viewer with the link that /cowork view gives you.' }),
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class PageCatalogs {
  private readonly served: Partial<Record<Lang, Catalog>> = {};
  private readonly answered = new Set<Lang>();        // the languages the page asked for and got an answer to (each once)
  private merged: Partial<Record<Lang, Catalog>> = { en: BOOT_EN };

  /** The page asked for l and got a catalog: it is not asked for again. */
  asked(l: Lang): boolean {
    return this.answered.has(l);
  }

  /** A /api/v1/strings answer to a request for `asked`: filed under the language it names (one of the six), never under `asked`;
   *  false (and nothing filed) when it is not { lang, templates } with templates an object. */
  accept(asked: Lang, json: unknown): boolean {
    if (!isObject(json) || !isObject(json['templates'])) return false;
    const named = LANGS.find((l) => l === json['lang']);
    if (named === undefined) return false;
    this.served[named] = json['templates'] as Catalog;
    this.answered.add(asked);
    this.answered.add(named);
    this.merged = { ...this.served, en: { ...BOOT_EN, ...this.served.en } };
    return true;
  }

  /** A served catalog renders lang: lang's own, or en's (render's fallback). */
  has(lang: Lang): boolean {
    return this.served[lang] !== undefined || this.served.en !== undefined;
  }

  /** The page can render code in lang now: a served catalog, or one of the bundled sessionless states. */
  can(code: string, lang: Lang): boolean {
    return this.has(lang) || Object.hasOwn(BOOT_EN, code);
  }

  /** render (channel viz) over the served catalogs, the bundled states under them (VIZ-39). */
  render(code: string, params: Params, lang: Lang): string {
    return renderWith(this.merged, REASON_CODES, code, params, 'viz', lang);
  }
}
