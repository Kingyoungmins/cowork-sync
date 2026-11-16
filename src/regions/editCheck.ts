// The edit check types (04-regions §3.20; REG-36, INV-REG-EDITCHECK; glossary §27.1; R4-08, R4-41, R4-42) — Task 5
// creates it with the EditCheckReason and EditCheckEntry declarations (types only; src/holds/ports.ts imports them
// as types), Task 10 adds the rest. src/regions imports only ports, git, sec, data and its own (REG-02), so no
// runtime value lives here yet.
export type EditCheckReason =
  | 'new_error_node' | 'undecodable' | 'conflict_markers'       // check 1
  | 'incompatible_caller' | 'orphan_call'                      // check 2
  | 'unresolved_import' | 'removed_name_called'                // check 3
  | 'label_count' | 'shrink' | 'emptied' | 'deleted'           // check 4
  | 'no_snapshot' | 'merge_conflict' | 'no_merge';             // no check (F12)
/** `check` absent exactly for no_snapshot | merge_conflict | no_merge; `line` only for checks 1–3, a 1-based row of M' (F14); display data only (D1). */
export interface EditCheckEntry { readonly check?: 1 | 2 | 3 | 4; readonly path: string; readonly reason: EditCheckReason; readonly line?: number; }
