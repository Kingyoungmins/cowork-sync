// Final review round 2, D-1 (05-holds HLD-07, HLD-02, HLD-14, MASK step 5, INV-HLD-NOREVERT; ruling R3-14): an ON_DISK revert PATCH r1
// keeps its ORIGINAL pair (h0 = the A it was made at, h1 = the human's bytes) while an apply moves A under it, so its current H1' (REBASE
// at the new A) is no longer its stored h1. A later stale save that also drops the teammate's newer line is a different change — its
// H1 equals r1's stored h1 but not r1's H1' — so HLD-07 must not attach it to r1 with an empty patch: the newer line's removal must stay
// held and never reach the remote. The loop alone (no resolve, no stop) through Engine.iterate on real clones of one file:// remote;
// the synthetic teammate (fx.pushTeamChange) writes the teammate lines; git is never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork, type PeerFixture } from '../helpers/coreFixture.js';
import { withEngines } from '../helpers/engineFixture.js';
import { untilNoOpenCs } from '../helpers/escalationFixture.js';
import { fpy, humanRemovesTeamLine, remoteLiveFiles, roundsUntil, T10, teammateLine, withGuard } from '../helpers/loopHoldsFixture.js';
import { buf } from '../helpers/publishHelpers.js';

const N = 30;
const FILES: Record<string, Buffer> = { 'README.md': buf('# moved base\n'), 'f.py': buf(fpy(N)) };
const TEAM1 = 'TEAM = 1';
const TEAM2 = 'TEAM2 = 2';

/** The text of one side of r's f.py pair ('' for ABSENT). */
async function side(p: PeerFixture, r: HoldRecord, s: 'h0' | 'h1'): Promise<string> {
  const b = r.blobs as { h0: Record<string, string>; h1: Record<string, string> };
  const o = b[s]['f.py'];
  return o === undefined || o === ABSENT ? '' : (await p.core.repo.readBlob(o as Oid)).toString('utf8');
}

test('final review D-1: a stale save that also drops a teammate line applied under an ON_DISK revert PATCH is held — HLD-07 compares with the record\'s current H1\', not its stored h1, so the newer line never leaves the remote', T10, async () => {
  await withEngines('d1-moved-base', { n: 1, files: FILES }, async (fx) => {
    await fx.startAll();
    await fx.rounds(2);
    const p = fx.peers[0]!;
    // TEAM1 applied; the human drops it: r1 = revert PATCH, h0 = A (with TEAM1), h1 = fpy(N).
    await teammateLine(fx, p, N, 10, TEAM1);
    const r1 = await humanRemovesTeamLine(fx, p, N);
    await untilNoOpenCs(fx, p);
    // The teammate adds TEAM2; the apply merges it into the disk and moves A under r1.
    await fx.pushTeamChange({ 'f.py': buf(fpy(N, { after: { 10: TEAM1, 20: TEAM2 } })) });
    await roundsUntil(fx, async () => (await readWork(p, 'f.py'))?.toString('utf8').includes(TEAM2) === true, 'TEAM2 applied');
    await untilNoOpenCs(fx, p);
    const before = p.core.holds.get(r1.id)!;
    assert.deepEqual([before.state, before.residence], ['ACTIVE', 'ON_DISK'], 'precondition: r1 is still held on disk');
    assert.equal((await side(p, before, 'h0')).includes(TEAM2), false, 'precondition: r1 keeps its original pair (HLD-02, HLD-14): its h0 has no TEAM2');
    assert.equal(await side(p, before, 'h1'), fpy(N), 'precondition: r1\'s stored h1 is fpy(N)');
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), fpy(N, { after: { 20: TEAM2 } }), 'precondition: the disk has TEAM2 and still lacks TEAM1');

    // A stale save drops TEAM2 as well: the disk is fpy(N) again, byte-equal to r1's stored h1.
    await writeWork(p, 'f.py', fpy(N));
    fx.advance(1_000);
    await fx.rounds(20);

    const live = (await remoteLiveFiles(fx, p)).get('f.py');
    assert.ok(live !== undefined, 'f.py is on the remote');
    assert.deepEqual([live.includes(TEAM1), live.includes(TEAM2)], [true, true], 'the remote keeps both teammate lines (INV-HLD-NOREVERT)');
    const holding: HoldRecord[] = [];
    for (const r of withGuard(p, 'revert')) if ((await side(p, r, 'h0')).includes(TEAM2) && !(await side(p, r, 'h1')).includes(TEAM2)) holding.push(r);
    assert.equal(holding.length, 1, `one non-terminal revert record holds TEAM2's removal: ${JSON.stringify(withGuard(p, 'revert').map((r) => [r.id, r.rev, r.state, r.residence]))}`);
    assert.notEqual(holding[0]!.id, r1.id, 'the removal of TEAM2 is a new change (a new id), not an empty attach to r1');
    assert.equal(p.core.holds.get(r1.id)!.state === 'ACTIVE' || p.core.holds.get(r1.id)!.state === 'CONFLICTED', true, 'r1 stays non-terminal');
    assert.equal((await readWork(p, 'f.py'))?.toString('utf8'), fpy(N), 'the disk keeps the human\'s bytes');

    assert.equal(p.core.maskInvalid, false, 'S_pub is valid with both records on f.py (INV-MASK, HLD-19): code is not blocked');

    // No churn: the per-loop detection attaches to the records it made (no new id, no new rev).
    const revs = withGuard(p, 'revert').map((r) => [r.id, r.rev] as const);
    await fx.rounds(4);
    assert.deepEqual(withGuard(p, 'revert').map((r) => [r.id, r.rev] as const), revs, 'the revert records are stable over later loops');

    // Liveness (R3-37): an untainted human edit of the same file still publishes through both records, without either removal.
    await writeWork(p, 'f.py', fpy(N, { replace: { 25: 'row_25 = 2525' } }));
    await roundsUntil(fx, async () => (await remoteLiveFiles(fx, p)).get('f.py')?.includes('row_25 = 2525') === true, 'the row-25 edit published', 24);
    const live2 = (await remoteLiveFiles(fx, p)).get('f.py')!;
    assert.deepEqual([live2.includes(TEAM1), live2.includes(TEAM2)], [true, true], 'still both teammate lines on the remote');
    assert.equal(p.core.maskInvalid, false);
  });
});
