// EF4 mask-compose-p (11-testing §3.4 INV-MASK; 05-holds HLD-36, HLD-39 rev 2.4; R3-63, R3-69, R3-EF4-12): a peer killed after a state
// commit and before its iteration wrote the CS cache restarts with a stale or missing cache, so its unpublished deltas outside the ready
// pairs form one `recovered` CS (an open human-class CS with a cs_id and no pair). Sharing a path with an older ready pair, it joins that
// pair's publication group; the engine keeps the group ready (HLD-39 rev 2.4) and publishes the pair's capture alone (none of the
// recovered CS's bytes). The fixed-seed runs stop at the failing composition of a65e3c5's measurement.
//   sample-faults-0 (30): p1 killed at publish.out_built (step 23), restarted at 25, composes {human/1, human/2} at step 29 (op-log entry 36).
//   sample-faults-0 (40) — the re-pinned meas-holds-24 cell (F2 controller ruling C-17, 2026-11-11): the holds-profile premise seeds no
//     longer build the shape (the re-pin search ran meas-holds-24 and meas-holds-0..-7 at 60 ops each on the fixed engine: nine runs,
//     every one premise-free), while the faults-profile seed sample-faults-0 deterministically builds it twice-reproduced at step 29 —
//     p1's pending human/1 pair and the restart's recovered human/2 compose into one ready group; the 40-op window also covers the
//     group's publication aftermath. The holds-profile premise coverage rests on sim.oracles.holds.openmember (the plant).
// EF4 r2 I2-6 (r2 rereview O minor 3): each run also asserts its premise — a compose event, before the stop op, whose ready group carries
// a pair and a pair-less own human-class csId (the recovered CS) — so a reshaped seed (a generator or engine change) cannot pass without
// building that composition; the plant test sim.oracles.holds.openmember stays the robust coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileRun } from '../../tools/sim/profileRun.js';
import type { Profile } from '../../tools/sim/seedProtocol.js';
import { removeKeptRoot } from '../helpers/tmp.js';
import { runSim, type Oracle } from '../sim/harness.js';

/** HLD-33: `<peer>/human/<n>` — a human-class cs_id (the human CS's or a restart's recovered CS's) of the compose event's own peer. */
const HUMAN_CLASS = /^([0-9a-f]{32})\/human\/[1-9][0-9]*$/;

/**
 * A recording oracle (never fails): the first compose event whose ready group carries both a csId among the event's pairs and an own
 * human-class csId with no pair (an open member — the recovered CS), as `op <n>: <peer> group <key> pairless [...] paired [...]`.
 */
function recoveredCompose(): { oracle: Oracle; seen: () => string | null } {
  let seen: string | null = null;
  let scanned = 0;
  const oracle: Oracle = {
    name: 'PREMISE_RECOVERED_COMPOSE',
    afterEveryOp(ctx) {
      const events = ctx.trace.events;
      for (; scanned < events.length && seen === null; scanned++) {
        const ev = events[scanned]!;
        if (ev.kind !== 'compose') continue;
        const paired = new Set(ev.pairs.map((x) => x.csId));
        for (const g of ev.groups) {
          if (!g.ready || !g.csIds.some((id) => paired.has(id))) continue;
          const pairless = g.csIds.filter((id) => !paired.has(id) && HUMAN_CLASS.exec(id)?.[1] === ev.peer);
          if (pairless.length === 0) continue;
          seen = `op-log entry ${ctx.opLog.length}: ${ev.peer} group ${g.key} pairless ${JSON.stringify(pairless)} paired ${JSON.stringify(g.csIds.filter((id) => paired.has(id)))}`;
          break;
        }
      }
      return Promise.resolve(null);
    },
  };
  return { oracle, seen: () => seen };
}

async function firstOps(seed: string, profile: Profile, steps: number, ops: number): Promise<string> {
  const run = profileRun(seed, profile, { steps });
  // The generator keeps its full plan; the run stops after `ops` with no quiescence phase, so INV-CONVERGE (T* only) is left out.
  const oracles = run.oracles.filter((o) => o.name !== 'INV-CONVERGE');
  // F2 #151 #17: the cell exists for INV-MASK, so INV-MASK must be among the run's oracles and must have judged the premise's
  // operation (its afterEveryOp reads every trace event up to the op-log length it is called at, the compose event included).
  assert.ok(oracles.some((o) => o.name === 'INV-MASK'), `${seed}: the ${profile} profile's oracles include INV-MASK`);
  const maskAt: number[] = [];
  const judged = oracles.map((o): Oracle => {
    const after = o.afterEveryOp;
    if (o.name !== 'INV-MASK' || after === undefined) return o;
    return { ...o, afterEveryOp: (ctx) => { maskAt.push(ctx.opLog.length); return after.call(o, ctx); } };
  });
  const premise = recoveredCompose();
  const r = await runSim({ ...run.tuple, ops }, run.factory, [...judged, premise.oracle], { ...run.options, quiescence: undefined });
  if (r.artifactsDir !== undefined) await removeKeptRoot(r.artifactsDir);
  assert.equal(r.ok, true, JSON.stringify(r.failure));
  const seen = premise.seen();
  assert.ok(seen !== null, `premise: ${seed}'s first ${ops} ops compose a ready group holding a pair-less recovered CS next to a pair`);
  const at = Number(/^op-log entry (\d+):/.exec(seen)?.[1] ?? NaN);
  const last = maskAt.length === 0 ? -1 : Math.max(...maskAt);
  assert.ok(Number.isInteger(at) && last >= at, `INV-MASK judged the premise's op-log entry ${at} (its last afterEveryOp saw ${last} entries)`);
  return seen;
}

test('INV-MASK (compose-P) accepts the restart\'s open recovered CS in a ready group: sample-faults-0 runs its first 30 ops with every per-op exit oracle passing', { timeout: 20 * 60_000 }, async (t) => {
  t.diagnostic(`premise: ${await firstOps('sample-faults-0', 'faults', 40, 30)}`);
});

test('INV-MASK (compose-P) accepts the restart\'s open recovered CS in a ready group: sample-faults-0 (the re-pinned meas-holds-24) runs its first 40 ops with every per-op exit oracle passing', { timeout: 20 * 60_000 }, async (t) => {
  t.diagnostic(`premise: ${await firstOps('sample-faults-0', 'faults', 40, 40)}`);
});
