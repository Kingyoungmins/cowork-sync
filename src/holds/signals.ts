// The change-set boundary signals (06-claude §3.12.1; HLD-34, HLD-36; glossary §25 F2; ruling R3-05). Plan 3 builds the
// change-set table that consumes them and tests it with scripted signals; Plan 5 feeds the same shape from hooks.
// X5-08 (R5-20, R5-02): the capture-at-trigger kinds carry `expect`, the content identity of the CS's paths computed
// within Plan 5's 150 ms bound (Task 6); Plan 3 accepts it and changes nothing before Task 13 (identity checks land
// there). `effect` and `prompt` never carry it (no capture is triggered by them).
import type { OidOrAbsent } from '../git/oid.js';

/** A seat's activity as the seat's hooks report it (glossary §3; 06-claude §3.11.2a): the HLD-36 recovered-CS close input. */
export type SeatActivity = 'IDLE' | 'ENDED' | 'MID_TURN' | 'AWAITING_PERMISSION';

/** X5-08: the optional capture identity, `Record<path, OidOrAbsent>` over the signal's CS paths (R5-20). */
export type CaptureExpect = Readonly<Record<string, OidOrAbsent>>;

export type CsSignal =
  | { kind: 'effect'; seat: string; agent: string | null; toolUseId: string; paths: readonly string[]; turnOrigin: 'prompt' | 'wake' }   // an attributed file effect (CCI-27); never split below one tool_use
  | { kind: 'prompt'; seat: string; humanOrigin: boolean; nonce: boolean }                                    // a nonce prompt is never a boundary and promotes nothing
  | { kind: 'stop' | 'stop_failure' | 'session_end' | 'seat_end'; seat: string; expect?: CaptureExpect }
  | { kind: 'subagent_stop'; seat: string; agent: string; expect?: CaptureExpect }
  | { kind: 'checkpoint'; seat: string; source: 'edit' | 'green' | 'tool'; candSeq: number; paths: readonly string[]; expect?: CaptureExpect }
  | { kind: 'checks_run'; seat: string; ok: boolean }                                                         // a completed checks.checkpoint-matching call (HLD-37 `checks`; R3-43; a 05/06 gap: Plan 5 feeds it)
  | { kind: 'idle_10min'; seat: string; activity: SeatActivity; txnOpen: boolean }                             // the HLD-34 fallback close input
  | { kind: 'activity'; seat: string; activity: SeatActivity };                                               // the HLD-36 recovered-CS close input
