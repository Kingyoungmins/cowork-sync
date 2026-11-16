// ObservedWrites after the park family and --discard (Plan 3 final review F1; 05-holds HLD-26, HLD-27, HLD-28, INV-HLD-NOREVERT;
// rulings R3-36, R3-60). A PARK or an ON_DISK --discard records its write in ObservedWrites and then sets the private-index entry to the
// same blob (parkWritten), so that write never shows up as a materialized delta and nothing would ever consume the entry. A lingering
// entry made a later stale save that writes the same older team version count as observed: the revert detector missed the removal of a
// teammate's later line and made no `revert` record (the stale-editor-buffer case HLD-27/28 exist for). parkWritten now forgets the
// entry once the private index holds the write. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { revertStep } from '../../src/engine/detect.js';
import { park } from '../../src/engine/holdOps.js';
import { resolve } from '../../src/engine/resolve.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { buf, prep, withCores } from '../helpers/publishHelpers.js';
import { HUMAN } from '../helpers/resolveFixture.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const F = 'f.py';
const text = (rows: readonly string[]): string => rows.map((r) => `${r}\n`).join('');
const BASE = Array.from({ length: 40 }, (_, i) => `row_${i + 1} = ${i + 1}`);
const withAt = (rows: readonly string[], i: number, line: string): string[] => [...rows.slice(0, i), line, ...rows.slice(i)];
const A1 = withAt(BASE, 10, 'TEAM = 1');      // the teammate's first change
const A2 = withAt(A1, 31, 'TEAM2 = 2');       // the teammate's second change

for (const verb of ['park', 'discard'] as const) {
  test(`after ${verb === 'park' ? 'a PARK' : 'an ON_DISK --discard'} of a revert PATCH wrote the team version, a later stale save of that same version over a teammate's newer line is a revert (no lingering observed entry; final review F1)`, T10, async () => {
    await withCores(`f1-linger-${verb}`, { n: 1, files: { 'README.md': buf('# f1\n'), [F]: buf(text(BASE)) } }, async (fx) => {
      const p = fx.peers[0]!;
      await fx.pushTeamChange({ [F]: buf(text(A1)) });
      fx.advance(10_000);
      assert.ok((await applyStep(p.core, await prep(p))).ran, 'A1 applied');
      assert.deepEqual(await revertStep(p.core, await prep(p, true)), []);

      // A stale save removes TEAM: one revert PATCH.
      await writeWork(p, F, text(BASE));
      await prep(p);
      fx.advance(1_500);
      const ids = await revertStep(p.core, await prep(p, true));
      assert.equal(ids.length, 1, 'the TEAM removal is a revert record');
      const id = ids[0]!;

      // The human parks (or discards) it: the daemon writes A1 back.
      if (verb === 'park') {
        const out = await park(p.core, await prep(p, true), id, { humanEvidence: true, displacedBy: null, refreshMustBeDurable: false });
        assert.equal(out.kind, 'PARKED', JSON.stringify(out));
      } else {
        const res = await resolve(p.core, await prep(p, true), id, 'discard', HUMAN);
        assert.deepEqual(res, { kind: 'done', code: 'RESOLVED_DISCARD', id, created: null });
      }
      assert.equal((await readWork(p, F))?.toString('utf8'), text(A1), 'the operator wrote the team version A1');
      // A few ordinary iterations: the operator's write is never a materialized delta (its private-index entry is set).
      for (let i = 0; i < 3; i++) {
        fx.advance(2_000);
        assert.deepEqual(await revertStep(p.core, await prep(p, true)), []);
      }

      // The teammate adds TEAM2; the apply writes A2.
      await fx.pushTeamChange({ [F]: buf(text(A2)) });
      fx.advance(10_000);
      assert.ok((await applyStep(p.core, await prep(p))).ran, 'A2 applied');
      assert.equal((await readWork(p, F))?.toString('utf8'), text(A2));
      assert.deepEqual(await revertStep(p.core, await prep(p, true)), []);

      // A stale editor buffer writes A1 again: TEAM2 is removed, an unobserved delta (HLD-26) and a revert (HLD-27/28).
      await writeWork(p, F, text(A1));
      await prep(p);
      fx.advance(1_500);
      const later = await revertStep(p.core, await prep(p, true));
      assert.equal(later.length, 1, `the TEAM2 removal is a revert record: ${JSON.stringify(later)}`);
      const r = p.core.holds.get(later[0]!)!;
      assert.ok(r.guards.some((g) => g.name === 'revert') && r.paths.includes(F), JSON.stringify(r));
    });
  });
}
