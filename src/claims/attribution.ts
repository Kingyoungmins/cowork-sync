// Hunk attribution port (REG-19; R4-05) — Task 5 declares the port type only; Task 12 adds csAttribution.
import type { PeerId } from '../board/ids.js';
import type { Hunk } from '../regions/types.js';
import type { SeatKey } from './types.js';

/** Seats of the change-set authors behind one hunk of one path (REG-19's S(h)). */
export interface HunkAttributionPort { seatsOf(csIds: readonly string[], path: string, hunk: Hunk, self: PeerId): readonly SeatKey[]; }
