// src/claude/text/claudeText.ts — the Plan 5-only text helpers that stay outside the registry (X-54): claudeTemplateOf, loaderLang, capLines,
// LOADER_TEXTS. Claude-facing text itself is rendered only by src/i18n/claude.ts's renderClaude (R5-11).
import type { ClaudeLang } from '../../i18n/claude.js';
import { CLAUDE_SEED_EN } from '../../i18n/claude/en/seed.js';
import { CLAUDE_SEED_KO } from '../../i18n/claude/ko/seed.js';

/** The 07 §3.16.4 rows Plan 5 seeds — G4_DOWN → G4, DAEMON_DOWN → G4, HOOK_LOAD_FAIL → T-HOOK_LOAD_FAIL, PAUSED_LINE → PAUSED,
 *  SINCE_POINTER → T-SINCE — and every other code to itself (rendered as its code line until Plan 6 adds the template; Plan 6's
 *  CODE_TEMPLATE_MAP then decides). */
const TEMPLATE_OF: Readonly<Record<string, string>> = Object.freeze({
  G4_DOWN: 'G4', DAEMON_DOWN: 'G4', HOOK_LOAD_FAIL: 'T-HOOK_LOAD_FAIL', PAUSED_LINE: 'PAUSED', SINCE_POINTER: 'T-SINCE',
});
export function claudeTemplateOf(code: string): string {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_OF, code) ? (TEMPLATE_OF[code] as string) : code;
}

/** X-53: the L_c of the dependency-free loader (and of core's loader-text paths, which run before any daemon answers), which cannot read team
 *  config (glossary §17 "user.json → OS locale → en"; A1-10): a non-null userLanguage decides alone ('ko' → 'ko', anything else → 'en'); only a
 *  null one falls to the OS locale (ko… → 'ko', else 'en') (06 §3.4.1). Daemon-rendered text uses src/i18n/locale.ts's claudeLang(lh). */
export function loaderLang(userLanguage: string | null, osLocale: string | null): ClaudeLang {
  if (userLanguage !== null) return userLanguage === 'ko' ? 'ko' : 'en';
  return osLocale !== null && /^ko(?:$|[-_.@])/i.test(osLocale) ? 'ko' : 'en';
}

const ELLIPSIS = '\u{2026}';

/** The first `max` UTF-16 units of a line, cut with an ellipsis and never between the halves of a surrogate pair. */
function cutInside(line: string, max: number): string {
  if (max <= 0) return '';
  if (line.length <= max) return line;
  let end = max - 1;
  const last = line.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return line.slice(0, end) + ELLIPSIS;
}

/** As many whole lines from the start as fit in max; when not even the first fits, the first cut inside. */
function headLines(lines: readonly string[], max: number): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const next = i === 0 ? (lines[0] as string) : `${out}\n${lines[i] as string}`;
    if (next.length > max) return i === 0 ? cutInside(lines[0] as string, max) : out;
    out = next;
  }
  return out;
}

/** Cuts at line boundaries to ≤ max chars (UTF-16 units), keeping the last line when keepTail (F04 recap); never cuts inside a line except the
 *  first. A tail that leaves no room for a head line is dropped like any other line. */
export function capLines(text: string, max: number, keepTail: boolean): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  if (keepTail && lines.length > 1) {
    const tail = lines[lines.length - 1] as string;
    const room = max - tail.length - 1;
    if (room >= 1) return `${headLines(lines.slice(0, -1), room)}\n${tail}`;
  }
  return headLines(lines, max);
}

const loaderText = (id: string): Readonly<Record<ClaudeLang, string>> =>
  Object.freeze({ en: (CLAUDE_SEED_EN[id] as { text: string }).text, ko: (CLAUDE_SEED_KO[id] as { text: string }).text });

/** The three loader texts (R5-40), from the registry's seed rows at module load: the glossary §11 G4 text verbatim (no cause slot), 07 PAUSED,
 *  and 07 T-HOOK_LOAD_FAIL with its literal {v} for the loader to fill; en and ko. Task 2's build generates the same strings into dist/hook.js
 *  (which imports only node:*) and pins its copy equal to these. */
export const LOADER_TEXTS: {
  readonly G4: Readonly<Record<ClaudeLang, string>>; readonly PAUSED: Readonly<Record<ClaudeLang, string>>; readonly HOOK_LOAD_FAIL: Readonly<Record<ClaudeLang, string>>;
} = Object.freeze({ G4: loaderText('G4'), PAUSED: loaderText('PAUSED'), HOOK_LOAD_FAIL: loaderText('T-HOOK_LOAD_FAIL') });
