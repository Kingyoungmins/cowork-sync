// Trace port (11-testing §2): test builds record events, release binds noTrace.
// peer = peer_id; oids are hex strings; no durations and no wall times (SIM determinism, TST-03).
export type PushPurpose = 'publish' | 'board_only' | 'genesis' | 'probe' | 'displaced' | 'recover';
// disk_equal: ENG-36's applicable, non-deferred path with M_disk[p] == S_disk[p], whose A[p] := TIP[p] needs no write
export type ASetCause =
  | 'genesis'
  | 'join'
  | 'write_verified'
  | 'disk_equal'
  | 'push_confirmed'
  | 'unmanaged_follow'
  | 'restart_decision'
  | 'lost_state'
  | 'recover_reanchor';
export type TraceOutcome = 'ok' | 'landed' | 'lease_lost' | 'transient' | 'network' | 'nonretryable' | 'denied';

export type TraceEvent =
  | { kind: 'iteration'; peer: string; n: number; fetched: boolean; applied: boolean; pushes: number }
  | { kind: 'fetch'; peer: string; ok: boolean; board: string | null; code: string | null; branch: string | null }
  | { kind: 'state'; peer: string; prev: string | null; next: string; laC: string; laB: string; base: string }
  | {
      kind: 'merge';
      peer: string;
      use: 'apply' | 'publish';
      base: string;
      ours: string;
      theirs: string;
      aTree: string;
      laC: string;
      laB: string;
      tip: string;
      t: string;
      rc: number;
    }
  | { kind: 'A_set'; peer: string; path: string; blob: string | null; cause: ASetCause }
  | {
      kind: 'apply';
      peer: string;
      tip: string;
      written: readonly string[];
      deferred: readonly string[];
      // Plan 3 (INV-GROUP input, Task 6): every write group with its outcome and group-level closure reason (R3-31), every
      // not-applicable path, and M_disk; Plan 2's emit carries [], [] and null until Task 6 fills them.
      groups: ReadonlyArray<{ paths: readonly string[]; outcome: 'written' | 'deferred'; reason: string | null }>;
      notApplicable: ReadonlyArray<{ path: string; reason: string }>;
      mDisk: string | null;
    }
  | {
      kind: 'publish';
      peer: string;
      t: string;
      tip: string;
      aTree: string;
      pTree: string;
      outTree: string;
      c: string | null;
      bnew: string;
      conflicted: readonly string[];
      replaced: ReadonlyArray<{ path: string; blob: string | null }>;
    }
  | {
      kind: 'push';
      peer: string;
      purpose: PushPurpose;
      argv: readonly string[];
      bnew: string | null;
      outcome: TraceOutcome;
    }
  | { kind: 'incident'; peer: string; n: number; why: string; observedBoard: string | null }
  // Every registry creation and transition (Plan 3 Task 1): guard = the first guard or ''; residence null for a terminal record.
  | {
      kind: 'hold';
      peer: string;
      id: string;
      holdKind: 'PATCH' | 'PIN' | 'INCOMING';
      guard: string;
      guards: readonly string[];
      paths: readonly string[];
      residence: 'ON_DISK' | 'OFF_DISK' | null;
      state: string;
      rev: number;
      localOnly: boolean;
    }
  // Each S_pub computation, once per materialization (maskStep, Task 12; no re-MASK, R3-62); registry = the registry commit
  // maskEntries read (INV-MASK input, Task 14).
  | { kind: 'mask'; peer: string; sDisk: string; aTree: string; registry: string | null; partial: readonly string[]; withheld: readonly string[]; conflicted: readonly string[] }
  // publishStep after every composeP whose P tree is built, CAS re-merges and recompositions included, before ENG-41; a T0 trial
  // composition of a t0-held group emits none (R3-63) (Task 10; INV-MASK and O-ATOMIC-PUB input, Task 14). pairs = every
  // journaled ready pair at this composition (composed or not); groups[].ready = the engine's readiness.
  | {
      kind: 'compose';
      peer: string;
      tip: string;
      aTree: string;
      registry: string | null;
      pTree: string;
      pairs: ReadonlyArray<{ csId: string; R: string; A: string; order: number; paths: readonly string[] }>;
      groups: ReadonlyArray<{ key: string; csIds: readonly string[]; paths: readonly string[]; pins: readonly string[]; ready: boolean }>;
      withheldWhole: ReadonlyArray<{ key: string; paths: readonly string[] }>;
    }
  // Hold ops a pushed Bnew carries (Task 4).
  | { kind: 'mirror'; peer: string; bnew: string; holds: ReadonlyArray<{ id: string; rev: number; localOnly: boolean; held: number }> }
  // RESOLVED_DISCARD (Task 11; INV-NOLOSS).
  | { kind: 'discard'; peer: string; id: string; rev: number; held: ReadonlyArray<{ path: string; blob: string | null }> }
  // DAT-08 (Task 7).
  | { kind: 'repair'; peer: string; path: string; from: string; to: string }
  // DAT-11 (Task 6).
  | { kind: 'form_violation'; peer: string; path: string; commit: string }
  // HLD-67 (Task 10; O-EDITCHECK input for Plan 5). checks = the check numbers of the failed entries, always set by
  // Task 10's emit; optional so Plan 3's emit site and trace tests stay unchanged (R4-63; Plan 5 reads checks ?? []).
  | { kind: 'edit_check'; peer: string; cs: string; verdict: 'pass' | 'fail' | 'incomplete'; checks?: ReadonlyArray<1 | 2 | 3 | 4> }
  // HLD-30 entry / HLD-31 lift (Task 8).
  | { kind: 'mass'; peer: string; entered: boolean; paths: number }
  // Plan 5 variants (Plan 5 Task 1 declares all; each owning task emits its own; capture_late is Task 13's). X-115: one union, appended in place.
  | { kind: 'hook'; peer: string; seat: string | null; event: TraceHookEvent; promptId: string | null; toolUseId: string | null;
      outcome: 'g1' | 'g2' | 'g3' | 'g4' | 'block' | 'context' | 'none' | 'nonlive' | 'paused'; code: string | null }                 // Tasks 4, 5
  | { kind: 'lease'; peer: string; seat: string; lease: 'INFLIGHT' | 'READ' | 'TXN'; key: string; path: string | null;
      op: 'acquire' | 'renew' | 'release'; why: string | null }                                                                         // O-LEASE input (Task 8)
  | { kind: 'seat'; peer: string; seat: string; op: 'register' | 'alias' | 'wiring' | 'flag' | 'end'; sessionId: string | null;
      wiring: string | null; flags: readonly string[]; why: string | null }                                                             // O-SEAT input (Tasks 5, 9)
  | { kind: 'turn'; peer: string; seat: string; promptId: string | null; op: 'human' | 'wake' | 'doorbell' | 'stop'; nonce: string | null;
      humanPromptRefreshed: boolean; csReset: boolean; released: number }                                                              // O-TURN-ORIGIN input (Task 6)
  | { kind: 'ring'; peer: string; seat: string; nonce: string; result: 'sent' | 'refused' | 'error' | 'not_rung' }                      // Task 6
  | { kind: 'evidence'; peer: string; seat: string | null; verb: string; promptId: string | null;
      op: 'mint' | 'grant' | 'consume' | 'refuse' | 'expire'; why: string | null }                                                      // O-HUMANONLY input (Task 15)
  | { kind: 'acting'; peer: string; verb: string; accepted: boolean; route: 'tty' | 'evidence' | null }                                 // Task 15
  | { kind: 'deny_record'; peer: string; seat: string; id: string; phase: 'prerecord' | 'converted' | 'local_only' }                    // O-RECORD-FIRST input (Task 11)
  | { kind: 'edit_trigger'; peer: string; seat: string; cs: string; editN: number; candSeq: number | null;
      outcome: 'candidate' | 'shrink' | 'slow_read' | 'base_moved' | 'batch' | 'pinned' | 'shadow' | 'paused' }                          // O-EDITCHECK input (Task 13)
  | { kind: 'ipc'; peer: string; op: 'accept' | 'auth_ok' | 'auth_fail' | 'close'; bytesToUnauthenticated: number }                     // O-IPC input (Task 3)
  | { kind: 'carrier'; peer: string; seat: string; event: TraceHookEvent; chars: number; metered: number; codes: readonly string[]; eventIds: readonly string[] }   // Task 7
  // ---- Plan 4 (R4-63; Task 5 declares them once so the parallel tasks never edit this union) ----
  // Every GATE run (Task 12).
  | {
      kind: 'gate';
      peer: string;
      tip: string;
      csIds: readonly string[];
      blocked: ReadonlyArray<{ cs: string; claim: string; holder: string; path: string; reason: string }>;
      admitted: ReadonlyArray<{ cs: string; claim: string; path: string }>;
    }
  // Every claim op (Tasks 11, 14).
  | {
      kind: 'claim';
      peer: string;
      action: 'draft' | 'emit' | 'reanchor' | 'drift' | 'tombstone' | 'local_only' | 'precheck_drop' | 'precheck_block' | 'rejected' | 'discard';
      claim: string;
      cs: string;
      path: string;
      anchor: string | null;
      ranges: ReadonlyArray<readonly [number, number]>;
    }
  // A placement failure (Task 15).
  | { kind: 'placement'; peer: string; use: 'apply' | 'publish'; path: string; sub: 'a' | 'b' }
  // A breach hit (Task 15).
  | { kind: 'breach'; peer: string; claim: string; holder: string; commit: string; path: string; baseMove: boolean };

/** A1-5: the same 14-member string union as src/claude/wire/frames.ts's HookEvent (src/ports may not import src/claude); a type-level test pins
 *  the two unions equal. */
export type TraceHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'UserPromptExpansion' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'PostToolBatch' | 'PermissionDenied' | 'Stop' | 'StopFailure' | 'SubagentStart' | 'SubagentStop' | 'SessionEnd' | 'Notification';

export interface Trace {
  emit(ev: TraceEvent): void;
}

export const noTrace: Trace = { emit: () => {} };
