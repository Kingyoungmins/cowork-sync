// test/unit/holds.signals.expect.test.ts — CsSignal.expect rides the closing/green/tool signals without changing
// Plan 3's behaviour before Task 13 (X5-08 declaration half, R5-20, R5-02; 06 test 29's expect half). A real
// EngineCore over a clone: queueSignal accepts an expect-bearing signal exactly as its bare kind, the CS table is
// untouched, and writeCsCache writes no expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CsSignal, CaptureExpect } from '../../src/holds/signals.js';
import type { Oid } from '../../src/git/oid.js';
import { queueSignal, readCsCache, writeCsCache } from '../../src/engine/csStep.js';
import { buf, lines, prep, withCores } from '../helpers/publishHelpers.js';
import { writeWork } from '../helpers/coreFixture.js';
import { testRunner } from '../helpers/tmp.js';

const T10 = { timeout: 10 * 60_000 };
const A = 'a'.repeat(32);
const FILES = { 'README.md': buf('# expect fixture\n'), 'a.py': buf(lines(12, (i) => `a_${i} = ${i}`)) };
const oidOf = (s: string): Oid => s as Oid;
const expect: CaptureExpect = { 'a.py': oidOf('a'.repeat(40)) };

// Type-level (X5-08): expect is optional on exactly these kinds.
type ExpectKind = Extract<CsSignal, { expect?: CaptureExpect }>['kind'];
const EXPECT_KINDS = ['checkpoint', 'stop', 'stop_failure', 'session_end', 'seat_end', 'subagent_stop'] as const;
const listed: readonly ExpectKind[] = EXPECT_KINDS;   // every listed kind really carries optional expect
type Missing = Exclude<ExpectKind, (typeof EXPECT_KINDS)[number]>;
const exhaustive: [Missing] extends [never] ? true : never = true;
void listed;
void exhaustive;

test('CsSignal.expect is accepted by Plan 3 and changes nothing before Task 13 (X5-08, R5-02, R5-20)', T10, async () => {
  await withCores('sig-expect', { n: 1, files: FILES }, async (fx) => {
    const p = fx.peers[0]!;
    const core = p.core;
    await writeWork(p, 'a.py', lines(12, (i) => `a_${i} # seat`));     // a seat write the effect claims
    const effect = { kind: 'effect' as const, seat: A, agent: null, toolUseId: 'tu1', paths: ['a.py'], turnOrigin: 'prompt' as const };
    queueSignal(core, effect);
    await prep(p);                                     // the effect opens the seat CS
    assert.equal(core.cs.table().cs.find((e) => e.seat === A)?.state, 'open');
    const r0 = queueSignal(core, { kind: 'stop', seat: A });           // a boundary: true, and it closes the CS
    const r1 = queueSignal(core, { kind: 'stop', seat: A, expect });   // the same kind with expect
    assert.equal(r1, r0);                                              // the same boolean as without expect
    assert.equal(typeof queueSignal(core, { kind: 'checkpoint', seat: A, source: 'green', candSeq: 5, paths: ['a.py'], expect }), 'boolean');
    await prep(p, true);                               // the closing iteration settles: the seat CS is closed
    assert.equal(core.cs.table().cs.find((e) => e.seat === A)?.state, 'closed');
    const closed = JSON.stringify(core.cs.table().cs);
    assert.ok(!closed.includes('"expect"'), 'the CS table carries no expect');
    await writeWork(p, 'a.py', lines(12, (i) => `a_${i} # more`));      // a fresh CS for the cache half
    queueSignal(core, effect);
    await prep(p);
    await writeCsCache(core);
    const cache = await readCsCache(core);
    assert.ok(cache !== null);
    assert.ok(!JSON.stringify(cache).includes('"expect"'), 'writeCsCache writes no expect');
    void testRunner;
  });
});
