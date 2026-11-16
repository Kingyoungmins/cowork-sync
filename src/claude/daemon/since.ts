// src/claude/daemon/since.ts — the F04 catch-up (06 §3.12.2 F04 paragraph, FEAT-F04-01…18, glossary §29.7, 10 §3.9a,
// §3.12, R5-52). Phase 1: the shapes; Task 16 implements.
import type { Lang } from '../../i18n/render.js';
import type { UserPrefs } from '../wire/pluginData.js';
import type { SinceMarks } from '../wire/frames.js';
import type { SessionClientFrame, SinceResultFrame } from '../wire/frames.js';
import type { CarrierItem } from './carriers.js';
import type { Seat } from './seats.js';
import type { DaemonCtx } from './ctx.js';
import type { MyRecord, SinceStep, SinceReport, SinceAcc } from '../../since/report.js';
import type { sinceInit, sincePush, sinceFinish } from '../../since/report.js';

export type ActivityKind = 'ups' | 'expansion' | 'human_cs';

export class HumanActivity {
  /** Phase 3a-1: constructible (Task 16 owns the bodies); the composition passes a pre-attach stand-in (decision 7-8). */
  constructor(_ctx: DaemonCtx, _engine: { markSince(m: SinceMarks): void; foldedHeight(): number }, _prefs: () => UserPrefs) { void _ctx; void _engine; void _prefs; }
  onActivity(_kind: ActivityKind, _seatId: string | null, _o: { sinceExpansion: boolean }): void { throw new Error('Plan 5 Task 16'); }
  takeRecap(_seat: Seat, _lang: { human: Lang; claude: import('./claudeDaemon.js').ClaudeLang }): { system: string | null; pointer: CarrierItem | null } | null {
    throw new Error('Plan 5 Task 16');
  }
  marks(): SinceMarks { throw new Error('Plan 5 Task 16'); }
  /** FEAT-F04-18: applied only from a tty-mode CLI or with awaitGrant true; one-way (no reply frame, R5-58). */
  sinceRan(_f: Extract<SessionClientFrame, { t: 'since_ran' }>): Promise<void> { throw new Error('Plan 5 Task 16'); }
}

/** One running accumulator fed by every folded commit since seen_h (Engine.onFoldStep); canonical-JSON equal to the
 *  batch report. A16-2: it runs only on F04-a's src/since/report.ts — Plan 5 writes no stand-in report. */
export class RecapAccumulator {
  constructor(_core: { sinceInit: typeof sinceInit; sincePush: typeof sincePush; sinceFinish: typeof sinceFinish }, _records: () => MyRecord[]) {
    throw new Error('Plan 5 Task 16');
  }
  push(_s: SinceStep): void { throw new Error('Plan 5 Task 16'); }
  restartAt(_h: number): void { throw new Error('Plan 5 Task 16'); }
  snapshot(_capFrom: number): SinceReport { throw new Error('Plan 5 Task 16'); }
}

/** since_query: meta.since (heights only), this peer's hold-record metadata, labels only from the verified-label cache. */
export function handleSinceQuery(_ctx: DaemonCtx): SinceResultFrame {
  throw new Error('Plan 5 Task 16');
}

export type { SinceAcc };
