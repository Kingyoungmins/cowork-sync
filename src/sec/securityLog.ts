// src/sec/securityLog.ts — ENG-03, SEC-38 (log rule), R5-46, X-34: the daemon's one security log, and SEC-22's handshake failure rate.
// <coworkDir>/log/security.jsonl holds codes and typed params only, each line mirrored to the daemon log at level 'security'. The lines go
// through Plan 2's fileLog (its queue keeps call order and whole lines); <coworkDir>/log exists because the daemon creates it at start.
// src/sec comes before src/claude and src/i18n in the import order: SecParams and the three rate numbers are local copies (A3-7, X5-45).
import { join } from 'node:path';
import type { Clock } from '../ports/clock.js';
import type { Fs } from '../ports/fs.js';
import { fileLog, type FileLog, type Log } from '../ports/log.js';
import type { Notifier } from '../ports/notifier.js';

/** A3-7: a local structural copy of 8a's Params (src/sec does not import src/i18n); X5-45 pins it. */
export type SecParams = Readonly<Record<string, string | number | null>>;
export interface SecurityLog { event(code: string, params: SecParams): void;
  /** Additive: flush() resolves once every security.jsonl line written so far has landed (security.jsonl's queue only; the
   *  daemon-log mirror is the caller's own file log, which it flushes as well — run.ts's flushLogs awaits both on every exit). */
  flush(): Promise<void>;
}

/** 09 §3.19 SEC_IPC_HANDSHAKE_FAILED: ≥ 5 failures … (= C.HANDSHAKE_FAIL_NOTIFY_AT) */
export const FAIL_NOTIFY_AT = 5;
/** … within 60 s (Δmono) … (= C.HANDSHAKE_FAIL_WINDOW_MS) */
export const FAIL_WINDOW_MS = 60_000;
/** … raise at most one OS notification per 30 min (glossary §20; = C.SECURITY_NOTIFY_SPACING_MS). */
export const NOTIFY_SPACING_MS = 1_800_000;

/** Registry code names (Plan 2's REASON_CODE_RE shape): a security line never carries text. */
const CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

function checkLine(code: string, params: SecParams): void {
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new TypeError('securityLog: the code is not a registry code');
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new TypeError('securityLog: params must be a flat record');
  for (const v of Object.values(params) as unknown[]) {
    const ok = v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new TypeError('securityLog: a param value is not a string, a finite number or null');
  }
}

/**
 * <coworkDir>/log/security.jsonl ({t, level: 'security', code, params} per line, codes and typed params only), each line mirrored to
 * daemonLog.write('security', code, params). A code that is not registry-shaped or a param value other than a string, a finite number or
 * null throws TypeError and nothing is written. X-34: the one security Log per daemon (run.ts builds it once; Plan 7 wraps it).
 */
export function securityLog(fs: Fs, clock: Clock, coworkDir: string, daemonLog: Log): SecurityLog {
  const file: FileLog = fileLog(fs, clock, join(coworkDir, 'log', 'security.jsonl'));
  return {
    event(code: string, params: SecParams): void {
      checkLine(code, params);
      const copy: Record<string, string | number | null> = { ...params };
      file.write('security', code, copy);
      daemonLog.write('security', code, copy);
    },
    flush: () => file.flush(),   // security.jsonl's queue only: the caller awaits the daemon log's flush as well
  };
}

/** One Log per SecurityLog (securityLogAsLog's memo), so the Log a module receives is identifiably the daemon's. */
const asLogs = new WeakMap<SecurityLog, Log>();

/**
 * X-34 / R4-52 / R5-46: the daemon's one SecurityLog as a Log, for a module that takes a security Log (Plan 4's
 * RegionDeps.securityLog) — no second writer of security.jsonl. write(level, code, params) is event(code, params): the line
 * is written at level 'security' whatever level the caller names, and checkLine's TypeError propagates (SEC-38: a security
 * line never carries text; nothing is written). The same SecurityLog always gives the same Log object.
 */
export function securityLogAsLog(s: SecurityLog): Log {
  let l = asLogs.get(s);
  if (l === undefined) {
    // LogParam admits booleans, SecParams does not: checkLine refuses one at run time (TypeError, nothing written).
    l = { write: (_level, code, params) => s.event(code, (params ?? {}) as SecParams) };
    asLogs.set(s, l);
  }
  return l;
}

/** SEC-22: every failed handshake is a security event SEC_IPC_HANDSHAKE_FAILED {why, count}; ≥ 5 failures within 60 s (Δmono) raise
 *  NT_SECURITY, at most once per 30 min (Δmono). count = the failures in the current 60 s window, this one included. */
export class HandshakeFailureRate {
  private readonly clock: Clock;
  private readonly notifier: Notifier;
  private readonly security: SecurityLog;
  /** The failures' mono times, oldest first; the live window is recent[head..]. A head index (compacted once it passes half the
   *  array) replaces Array.shift, so a flood of failed handshakes costs O(1) amortized per failure, not O(window) (F2 t5-run r2). */
  private recent: number[] = [];
  private head = 0;
  private lastNotified: number | null = null;

  constructor(clock: Clock, notifier: Notifier, security: SecurityLog) {
    this.clock = clock;
    this.notifier = notifier;
    this.security = security;
  }

  fail(why: string): void {
    const now = this.clock.monoMs();
    this.recent.push(now);
    while (this.head < this.recent.length && now - (this.recent[this.head] as number) >= FAIL_WINDOW_MS) this.head++;
    if (this.head >= 64 && this.head * 2 >= this.recent.length) {
      this.recent = this.recent.slice(this.head);
      this.head = 0;
    }
    const count = this.recent.length - this.head;
    this.security.event('SEC_IPC_HANDSHAKE_FAILED', { why, count });
    if (count >= FAIL_NOTIFY_AT && (this.lastNotified === null || now - this.lastNotified >= NOTIFY_SPACING_MS)) {
      this.lastNotified = now;
      this.notifier.raise('NT_SECURITY', 'SEC_IPC_HANDSHAKE_FAILED', { count });
    }
  }
}
