// src/ports/notifier.ts — 11 §3.2 Notifier seam (OS notification, status write, trace event). X-67: the one Notifier interface of every plan,
// created by Plan 5 Task 1; Plan 6 appends its OsClass to NtClassKey (and deletes its NotifierPort), Plan 7 appends its classes to NtClass
// (24 in all) and its NotificationDispatcher extends Notifier. Production binds logNotifier until Plan 7's OS adapter (X5-31).
import type { Log } from './log.js';

/** Plan 5's four classes (X-67); Plan 7 appends in place. */
export type NtClass = 'NT_NOHOOKS' | 'NT_SECURITY' | 'NT_LIVE_MARKER_RESTORED' | 'NT_PLUGIN_REMOVED';
/** X-67: Plan 6 widens it to NtClass | OsClass in place. */
export type NtClassKey = NtClass;
/** A1-5: structurally 8a's Params (src/ports may not import src/i18n types). */
export type NotifyParams = Readonly<Record<string, string | number | null>>;

/** X-67: key — the per-subject rate key (e.g. NT_REQUEST_AGE's per-request rule); absent = the class's own rate. */
export interface Notifier { raise(cls: NtClassKey, code: string, params: NotifyParams, key?: string): void; }

/** A1-5: each call is one log.write('warn', code, { ...params, cls }) line. */
export function logNotifier(log: Log): Notifier {
  return { raise: (cls, code, params) => log.write('warn', code, { ...params, cls }) };
}

/** X-67: a factory (no class); A1-5: 11 §3.2 "recorder (counts per reason class)". */
export function recordingNotifier(): Notifier & {
  readonly calls: ReadonlyArray<{ cls: NtClassKey; code: string; params: NotifyParams; key: string | null }>; countOf(cls: NtClassKey): number;
} {
  const calls: Array<{ cls: NtClassKey; code: string; params: NotifyParams; key: string | null }> = [];
  return {
    calls,
    raise: (cls, code, params, key) => { calls.push({ cls, code, params, key: key ?? null }); },
    countOf: (cls) => calls.filter((c) => c.cls === cls).length,
  };
}
