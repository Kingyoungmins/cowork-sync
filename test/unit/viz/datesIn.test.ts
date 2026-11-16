// T-VIZ-clock's date heuristic (test/helpers/vizViewer.ts datesIn; 12-visualizer §3.3.5 "Seed", T-VIZ-clock; F1 audit fix #10). The
// served timeline pages carry about 2,381 fixed event seeds (uint32 hashes of fixed fixtures); a seed whose value read as Unix seconds
// falls within ± 2 days of the test run's wall clock used to read as a leaked date, so apiE2E failed in repeating date windows (PC 2,
// 2026-10-21: seed 1792629121 = 2026-10-22T00:32Z; PC 1, 2026-10-12 to 10-19: seed 1792244106 = 2026-10-17T13:35Z, page from=257).
// An event `seed` value that fits uint32 is a hash, never a clock: it is not flagged. The same number anywhere else still is, and so
// is a millisecond wall clock (13 digits, never a uint32) even under the `seed` key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesIn } from '../../helpers/vizViewer.js';

const SEED_PC2 = 1_792_629_121;   // 2026-10-22T00:32:01Z read as Unix seconds
const SEED_PC1 = 1_792_244_106;   // 2026-10-17T13:35:06Z read as Unix seconds
const HOUR_MS = 3_600_000;

/** A timeline page body as GET /api/v1/rooms/<id>/timeline serves it (the EventVM shape of 12 §3.10.6: at, seed, kind, …). */
const page = (seed: number): string => JSON.stringify({ from: 257, events: [{ at: [403, 1001, 0], seed, kind: 'pet_spawn', seat: 'a1b2c3', owner: 'e5a40f' }] });

test('T-VIZ-clock fixture: an event seed inside the ± 2 day window of the wall clock is not a date; the same number outside a seed field, or a wall clock in ms under the seed key, still is', () => {
  // The two seeds the hosts flagged, each with the run's wall clock 3 h after the instant the number names.
  assert.deepEqual(datesIn(page(SEED_PC2), SEED_PC2 * 1_000 + 3 * HOUR_MS), [], 'PC 2\'s flagged seed');
  assert.deepEqual(datesIn(page(SEED_PC1), SEED_PC1 * 1_000 - 3 * HOUR_MS), [], 'PC 1\'s flagged seed');
  // A stream message's escaped form (a JSON body inside a JSON string, as a log line can carry it).
  assert.deepEqual(datesIn(JSON.stringify({ line: page(SEED_PC2) }), SEED_PC2 * 1_000), [], 'the escaped "seed" key');
  // The same number in any other field reads as Unix seconds of the run: a leak.
  const at = SEED_PC2 * 1_000 + HOUR_MS;
  assert.deepEqual(datesIn(JSON.stringify({ at: [403, 1001, 0], seen_s: SEED_PC2 }), at), [String(SEED_PC2)], 'seconds outside a seed field');
  assert.deepEqual(datesIn(`room since ${SEED_PC2}`, at), [String(SEED_PC2)], 'seconds in plain text');
  // Under the seed key, a value that is not a uint32 is no seed (the wall clock in ms has 13 digits).
  assert.deepEqual(datesIn(JSON.stringify({ seed: at }), at), [String(at)], 'a millisecond wall clock in a seed field');
  // A seed outside the window, and the textual date forms, unchanged.
  assert.deepEqual(datesIn(page(1_000_000_001), at), []);
  assert.deepEqual(datesIn(JSON.stringify({ seed: 7, when: '2026-10-22T00:32:01Z' }), at), ['2026-10-22T00:32', '00:32']);
});
