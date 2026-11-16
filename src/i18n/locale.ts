// src/i18n/locale.ts — glossary §17, X-53: the human language L_h and the Claude-facing language L_c. Created by Plan 5 Task 1 at Plan 7's
// signatures; Plan 7 Task 2 extends it in place (langOfLocale, …). The dependency-free loader's L_c (user.json → OS locale → en, no team
// config) is claudeText.ts's loaderLang.
import { LANGS, type Lang } from './render.js';
import type { ClaudeLang } from './claude.js';

const isLang = (v: string | null): v is Lang => v !== null && (LANGS as readonly string[]).includes(v);

/** One of the six languages for an OS locale (POSIX ko_KR.UTF-8 or BCP 47 ko-KR forms; zh-CN only for Simplified Chinese), else null. */
function osLang(locale: string): Lang | null {
  const tag = locale.split(/[.@]/)[0]!.replace(/_/g, '-').toLowerCase();
  const parts = tag.split('-');
  if (parts[0] === 'zh') return parts.includes('cn') || parts.includes('hans') ? 'zh-CN' : null;
  const primary = parts[0] as string;
  return (['en', 'ko', 'ja', 'fr', 'es'] as const).find((l) => l === primary) ?? null;
}

/** L_h: user.json → team config → OS locale → en; a user or team value outside the six languages counts as absent and is named in `invalid`
 *  (I18N-02). One declaration with Plan 7 (verify pass V-4): `invalid` lists the sources skipped, in order; `osLocale` is null when the OS
 *  gives none (the daemon and Plan 6 pass null). */
export function resolveHumanLang(i: { user: string | null; team: string | null; osLocale: string | null }): { lang: Lang; invalid: ReadonlyArray<'user' | 'team'> } {
  const invalid: Array<'user' | 'team'> = [];
  for (const source of ['user', 'team'] as const) {
    const v = i[source];
    if (isLang(v)) return { lang: v, invalid };
    if (v !== null) invalid.push(source);
  }
  return { lang: (i.osLocale === null ? null : osLang(i.osLocale)) ?? 'en', invalid };
}

/** L_c = L_h when 'en' or 'ko', else 'en' (glossary §17). The daemon renders Claude-facing text in claudeLang(resolveHumanLang({user, team, osLocale}).lang). */
export function claudeLang(lh: Lang): ClaudeLang {
  return lh === 'ko' ? 'ko' : 'en';
}
