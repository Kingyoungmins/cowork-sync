// Remote-content errors (Task 15 ruling: "typed at their source"): BoardMalformedError for a board commit readBoardCommit
// refuses and RemoteContentError for the live code/base chain and the fold's chain shape. Both classes live in
// src/board/boardCommit.ts (the fold throws one, and src/board imports nothing from src/engine) and are re-exported here
// with the one predicate start, restart and recover map: only these two are remote content, never a plain Error.
import { BoardMalformedError, RemoteContentError } from '../board/boardCommit.js';

export { BoardMalformedError, RemoteContentError };

/** Remote content (START_REMOTE{board_malformed}, a RECOVER refusal): exactly BoardMalformedError or RemoteContentError. */
export function isRemoteContentError(e: unknown): e is BoardMalformedError | RemoteContentError {
  return e instanceof BoardMalformedError || e instanceof RemoteContentError;
}
