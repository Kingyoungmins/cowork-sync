// 01-engine test 1 / TC-ENG-08, Review Focus 2: 200 applies of one-line teammate changes to the 1.3 MB BOM+CRLF file on
// a core.autocrlf=true peer. The blob is stored as given (BOM + CRLF, i/crlf), so a comparison that hashed the working
// file with --path would see every write as a mismatch; DISK_EQ's index-context comparison must see none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStep } from '../../src/engine/apply.js';
import { prepareIteration } from '../../src/engine/core.js';
import { seededRandom } from '../../src/ports/random.js';
import { makeCores, readWork } from '../helpers/coreFixture.js';
import { generateBigBomCrlf } from '../sim/fixtures/bigBomCrlf.js';

const ROUNDS = 200;

/** The fixture with row `row` (0-based, after the BOM) replaced by a comment naming the round; CRLF kept. */
function edited(base: Buffer, row: number, round: number): Buffer {
  const text = base.subarray(3).toString('utf8');
  const rows = text.split('\r\n');
  rows[row] = `# teammate change ${round}`;
  return Buffer.concat([base.subarray(0, 3), Buffer.from(rows.join('\r\n'), 'utf8')]);
}

// Its own timeout (tools/test/run-tests.mjs sets 10 min per test on Node 24+, and 60 min per file before 24): ~8 min in a full
// parallel CI run, 15 min on a loaded machine, and past 30 min on a developer machine shared with several other full test runs.
test('200 one-line teammate changes to the 1.3 MB BOM+CRLF fixture on an autocrlf=true peer give 0 mismatch deferrals and 0 phantoms', { timeout: 60 * 60_000 }, async () => {
  const big = generateBigBomCrlf(26_436, seededRandom('t13-bomcrlf'));
  assert.ok(big.length > 1_200_000, 'about 1.3 MB');
  const fx = await makeCores('apply-bomcrlf', { n: 1, autocrlf: [true], files: { 'big.py': big, 'README.md': Buffer.from('# big\n', 'utf8') } });
  try {
    await fx.bootstrap();
    const p = fx.peers[0]!;
    assert.deepEqual(await readWork(p, 'big.py'), big, 'checked out BOM+CRLF, byte-identical');
    let current = big;
    let mismatches = 0;
    let otherDeferrals = 0;
    let written = 0;
    for (let round = 1; round <= ROUNDS; round++) {
      current = edited(current, 10 + ((round * 131) % 26_000), round);
      await fx.pushTeamChange({ 'big.py': current });
      fx.advance(10_000);
      const prep = await prepareIteration(p.core, round, { materialize: 'auto', forceFetch: true });
      assert.ok(prep.ok, `round ${round}: prepareIteration ${JSON.stringify(prep)}`);
      const r = await applyStep(p.core, prep.it);
      assert.equal(r.ran, true, `round ${round}: ${r.skipped ?? ''}`);
      for (const reason of r.deferred.values()) {
        if (reason === 'mismatch') mismatches++;
        else otherDeferrals++;
      }
      if (r.written.includes('big.py')) written++;
    }
    const phantoms = p.core.holds.all().filter((h) => h.guards.some((g) => g.name === 'phantom'));
    assert.equal(mismatches, 0, '0 mismatch deferrals');
    assert.equal(phantoms.length, 0, '0 phantoms');
    assert.equal(otherDeferrals, 0);
    assert.equal(written, ROUNDS, 'every change was written');
    assert.deepEqual(await readWork(p, 'big.py'), current, 'the disk holds the last TIP bytes');
  } finally {
    await fx.cleanup();
  }
});
