// src/claude/wire/pluginData.ts — R5-12; X-52: CLAUDE_PLUGIN_DATA/user.json read leniently into the one daemon-side type UserPrefs (Plan 6's
// PrefsPort.user() returns it; Plan 7's strict schema type stays UserJson, loaded by its loadUserJson(fs, dataDir)). The directory functions
// live in src/data/pluginDataDir.ts (X-61). Pure: the caller reads the file through its own port and passes the text (null when missing).
import { LANGS, type Lang } from '../../i18n/render.js';

/** A1-10, X-52: the glossary §17 / §29.5 keys and envPassthrough (the passthrough argument of buildDaemonEnv for spawnDaemon, Task 4). */
export interface UserPrefs {
  language: string | null; wakeTurnEdits: 'allow' | 'deny'; wakeEnabled: boolean; wakeMaxPerSeatPerHour: number; notificationsOs: boolean;
  sinceRecap: boolean; sinceClaudePointer: boolean; envPassthrough: readonly string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Rec, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `a.b` in nested form ({"a": {"b": v}}) or dotted form ({"a.b": v}); the nested form decides when it is present. */
function key(o: Rec, dotted: string): unknown {
  const [head, ...rest] = dotted.split('.');
  let v: unknown = o;
  for (const k of [head as string, ...rest]) v = isRec(v) ? own(v, k) : undefined;
  return v !== undefined ? v : own(o, dotted);
}
const pick = <T>(v: unknown, ok: (x: unknown) => x is T, dflt: T): T => (ok(v) ? v : dflt);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';

/** Lenient: a missing file, bad JSON or a mistyped key → the default (null, 'allow', true, 4, true, true, true, []). A1-10: each key in nested
 *  ({"wake": {"turnEdits": "deny"}}) or dotted ({"wake.turnEdits": "deny"}) form, nested winning. A language outside 8a's six Lang values
 *  reads as null (I18N-02); env.passthrough keeps only valid variable names. */
export function readUserJson(text: string | null): UserPrefs {
  let o: Rec = {};
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text.replace(/^\u{FEFF}/u, ''));
      if (isRec(parsed)) o = parsed;
    } catch {
      // bad JSON: every key its default
    }
  }
  const language = key(o, 'language');
  const passthrough = key(o, 'env.passthrough');
  return Object.freeze({
    language: typeof language === 'string' && (LANGS as readonly string[]).includes(language) ? (language as Lang) : null,
    wakeTurnEdits: pick(key(o, 'wake.turnEdits'), (x): x is 'allow' | 'deny' => x === 'allow' || x === 'deny', 'allow'),
    wakeEnabled: pick(key(o, 'wake.enabled'), isBool, true),
    wakeMaxPerSeatPerHour: pick(key(o, 'wake.maxPerSeatPerHour'), (x): x is number => Number.isSafeInteger(x) && (x as number) >= 0, 4),
    notificationsOs: pick(key(o, 'notifications.os'), isBool, true),
    sinceRecap: pick(key(o, 'since.recap'), isBool, true),
    sinceClaudePointer: pick(key(o, 'since.claudePointer'), isBool, true),
    envPassthrough: Object.freeze(Array.isArray(passthrough) ? passthrough.filter((x): x is string => typeof x === 'string' && ENV_NAME.test(x)) : []),
  });
}
