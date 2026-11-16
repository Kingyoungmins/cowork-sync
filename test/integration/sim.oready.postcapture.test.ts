// EF4 o-ready-rebase-hld41, ruling R3-EF4-1 (11-testing §3.4 O-READY; glossary §3 ready pair; 05-holds HLD-35, HLD-39, HLD-41): a ready pair whose
// path got a member file effect after its capture (S_disk[p] != R[p] before the apply) is rebased by the plain merge-file at the
// apply, R[p] := merge-file(A_new, A_cap, R), not to the apply's M_disk[p] (which also carries the later, uncaptured bytes).
// meas-holds-83: p1 edits shared.txt row 14 before it joins (the join captures human/1 with it), edits row 16 at op 7, and its first
// iteration at op 29 applies p2's row-25 change: R must carry rows 14 + 25, the disk rows 14 + 16 + 25.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileRun } from '../../tools/sim/profileRun.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { runSim } from '../sim/harness.js';

test('O-READY (rebase) judges a ready pair with a post-capture effect on the written path by the plain HLD-41 rebase, not by M_disk: meas-holds-83 runs its first 30 ops (p1\'s first apply at op 29) with every per-op exit oracle passing', { timeout: 20 * 60_000 }, async () => {
  const run = profileRun('meas-holds-83', 'holds', { steps: 60 });
  // The generator keeps its 60-step plan; the run stops after op 30 with no quiescence phase, so INV-CONVERGE (T* only) is left out.
  const oracles = run.oracles.filter((o) => o.name !== 'INV-CONVERGE');
  const r = await runSim({ ...run.tuple, ops: 30 }, run.factory, oracles, { ...run.options, quiescence: undefined });
  if (r.artifactsDir !== undefined) await removeKeptRoot(r.artifactsDir);
  assert.equal(r.ok, true, JSON.stringify(r.failure));
});
