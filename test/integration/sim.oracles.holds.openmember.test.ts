// EF4 mask-compose-p (11-testing §3.4 INV-MASK, O-ATOMIC-PUB; 05-holds HLD-36, HLD-38, HLD-39 rev 2.4; rulings R3-53, R3-63, R3-69,
// R3-EF4-12): a compose event's ready group may hold an OPEN member that has a cs_id but no journaled pair — the `recovered` CS a restart
// creates when the CS cache is missing or stale (HLD-36: "every unpublished local delta not in a ready pair"), or a seat CS after its first
// effect. HLD-39 (rev 2.4): a member's file effect after the passing capture does not withdraw it, and the engine's readyOf (Task 12a,
// ratified) keeps such a group ready; its pairs' R carries none of the open member's bytes. So the oracle's composability treats such a
// member like the open human CS (which has no cs_id yet): it does not keep the group from composing. A member the journaled CS table
// shows CLOSED without a pair still does (HLD-34 "a closed CS always has a ready pair", HLD-52: never its older pairs alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeta } from '../../src/engine/meta.js';
import { parseCsTable, serializeCsTable, type CsTable } from '../../src/holds/changesets.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { SIM_TIMEOUT, okOrFail, scriptRun, type Step } from '../helpers/holdsScript.js';
import { fresh, untilPlanting } from '../helpers/holdsOracleScript.js';
import { readBlob, treeEntries } from '../sim/holdsView.js';
import { emitAs, forkTrace, oracleMask, peerIdOf, plantBlob, plantTree } from '../sim/oraclesHolds.js';

type ComposeEvent = Extract<TraceEvent, { kind: 'compose' }>;

test('INV-MASK compose-P: a ready group with an open member that has a cs_id but no pair composes its pairs (the restart\'s recovered CS; R3-EF4-12, R3-63 read with HLD-39 rev 2.4); a member the journaled CS table shows closed without a pair still keeps the group from composing', { timeout: SIM_TIMEOUT }, async () => {
  const run = untilPlanting();
  let checked = false;
  const steps: Step[] = [
    { rounds: 1 },
    { kind: 'edit_band', peer: 1, params: { path: 'shared.txt', insert: true, row: 14, n: 1, text: 'p1-line' } },
    { rounds: 12 },
    {
      probe: 'plants', run: async (ctx) => {
        assert.equal(await fresh(oracleMask, ctx), null, 'a fresh oracleMask passes on the run as it is');
        run.plant();
        const id1 = peerIdOf(ctx, 1);
        const dir = ctx.peers[1]!.dir;
        // p1's composition of its ready human CS (its R carries p1-line on shared.txt, A does not).
        const ce = ctx.trace.ofKind('compose').filter((e) => e.peer === id1 && e.pairs.length > 0 && e.groups.some((g) => g.ready)).pop() as ComposeEvent | undefined;
        assert.ok(ce !== undefined, 'p1 composed a ready group with a pair');
        const g = ce.groups.find((x) => x.ready && x.csIds.some((id) => ce.pairs.some((p) => p.csId === id)))!;
        const st = ctx.trace.ofKind('state').filter((e) => e.peer === id1).pop()!;
        const files = await treeEntries(ctx.git, dir, st.next);
        const n = (parseMeta(await readBlob(ctx.git, dir, files.get('meta')!.oid)) as { cs_human_next: number }).cs_human_next;
        const tableEntry = files.get('journal/keep/cs/table.json');
        const base: CsTable = tableEntry === undefined ? { v: 1, next_order: 1, seats: {}, cs: [], orders: {}, passing: {} } : parseCsTable(await readBlob(ctx.git, dir, tableEntry.oid));
        // The open member: a human-class id at meta.cs_human_next, the id a restart's restore gives the recovered CS (R3-69).
        const extra = `${id1}/human/${n}`;
        assert.ok(!base.cs.some((e) => e.cs_id === extra) && !ce.pairs.some((p) => p.csId === extra), `${extra} is in no journaled table and has no pair`);
        const entry = (state: 'open' | 'closed'): CsTable['cs'][number] => ({
          cs_id: extra, kind: 'recovered', seat: null, agent: null, origin: 'human', paths: ['notes.txt'], state, cap_seq: state === 'closed' ? 1 : 0,
          publishes: 0, checks: 'skipped', covered: false,
        });
        /** A forked trace ending with (an optional state event naming a planted table and) ce with `extra` in g's csIds. */
        const plant = async (table: CsTable | null): Promise<{ mask: string | null }> => {
          const f = forkTrace(ctx);
          if (table !== null) {
            const blob = await plantBlob(ctx, 1, serializeCsTable(table));
            emitAs(f, 1, { ...st, prev: st.next, next: await plantTree(ctx, 1, st.next, { 'journal/keep/cs/table.json': blob }) });
          }
          emitAs(f, 1, { ...ce, groups: ce.groups.map((x) => (x.key === g.key ? { ...x, csIds: [...x.csIds, extra].sort() } : x)) });
          return { mask: await fresh(oracleMask, f) };
        };
        // (a) the recovered CS before any table lists it (the state before the compose journaled the table without it)
        const a = await plant(null);
        assert.equal(a.mask, null, `(a) an open recovered member with no pair does not make P keep A: ${a.mask}`);
        // (b) the journaled table lists it open
        const b = await plant({ ...base, cs: [...base.cs, entry('open')] });
        assert.equal(b.mask, null, `(b) a member the journaled table shows open: ${b.mask}`);
        // (c) the journaled table lists it closed and it has no pair: the group is not composable, P must keep A (refused as before)
        const c = await plant({ ...base, cs: [...base.cs, entry('closed')] });
        assert.ok(c.mask !== null && c.mask.includes('INV-MASK (compose-P) p1 shared.txt'), `(c) a closed member without a pair keeps the group from composing: ${c.mask}`);
        checked = true;
      },
    },
  ];
  okOrFail((await scriptRun('holds-plant-openmember', () => steps, { oracles: run.oracles })).r);
  assert.ok(checked);
});
