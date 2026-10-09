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
  | { kind: 'apply'; peer: string; tip: string; written: readonly string[]; deferred: readonly string[] }
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
  | {
      kind: 'hold';
      peer: string;
      id: string;
      holdKind: 'PATCH' | 'PIN';
      guard: string;
      paths: readonly string[];
      residence: 'ON_DISK' | 'OFF_DISK';
    };

export interface Trace {
  emit(ev: TraceEvent): void;
}

export const noTrace: Trace = { emit: () => {} };
