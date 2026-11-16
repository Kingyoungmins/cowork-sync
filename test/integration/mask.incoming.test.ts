// Final review F5 (Plan 3; 05-holds §3.4 item 2 step 2, HLD-19's P clause, HLD-42; ruling R3-21 as amended by Task 6: "INCOMING records
// never make a path LOCAL_ONLY"): an INCOMING record holds TIP's bytes and none of this disk's, so it masks nothing — also when the
// registry flags it local_only because its tracked LIVE path has a secret-like name (U10, `*credentials*`). A teammate's change to that
// file waits under a lock for 60 s and becomes an INCOMING `lock` record; the human's own edit of the same file (another line) and of a
// second file in the same change-set publish in one commit, as they do for a name that is not secret-like, and no dependency PIN is
// made. Real git on file:// clones; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CoreFixture, PeerFixture } from '../helpers/coreFixture.js';
import { writeWork, workPath } from '../helpers/coreFixture.js';
import { incomingRecords, loop } from '../helpers/incomingFixture.js';
import { T9, t9 } from '../helpers/maskFixture.js';
import { blobText, buf, captureReady, prep, remoteLiveCode, treeOf, withCores } from '../helpers/publishHelpers.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const OTHER = 'src/other.txt';

/** Loops every 10 s until the closure's INCOMING record exists (at most 70 s); the record id. */
async function untilRecord(fx: CoreFixture, p: PeerFixture): Promise<string> {
  for (let t = 0; t <= 70_000; t += 10_000) {
    await loop(p, { mirror: true });
    const rs = incomingRecords(p);
    if (rs.length > 0) return rs[0]!.id;
    fx.advance(10_000);
  }
  throw new Error('no INCOMING record within 70 s');
}

async function scenario(name: string, path: string, secretLike: boolean): Promise<void> {
  const files = { 'README.md': buf('# mask incoming\n'), [path]: buf(T9), [OTHER]: buf('o1\no2\no3\n') };
  await withCores(name, { n: 1, files }, async (fx) => {
    const p = fx.peers[0]!;
    // The warm-up loop: the stat cache knows the file clean, so the writer (W4) meets the holder.
    await loop(p);
    fx.advance(10_000);
    p.fs.holdLock(workPath(p, path), 'share-read');
    await fx.pushTeamChange({ [path]: buf(t9([2, 'a team line'])) });
    fx.advance(10_000);
    const id = await untilRecord(fx, p);
    const rec = p.core.holds.get(id)!;
    assert.deepEqual([rec.kind, rec.residence, rec.state, rec.paths, rec.guards.map((g) => g.name)], ['INCOMING', 'ON_DISK', 'ACTIVE', [path], ['lock']]);
    assert.equal(rec.local_only, secretLike, `precondition: the INCOMING record is local_only exactly for the secret-like name (${path})`);
    // The human edits another line of the same file and a second file: one human change-set.
    await writeWork(p, path, t9([8, 'a human line']));
    await writeWork(p, OTHER, 'o1\no2 human\no3\n');
    await prep(p);
    fx.advance(20_000);
    const pair = await captureReady(p, await prep(p, true));
    assert.deepEqual([...pair.paths].sort(), [OTHER, path].sort());
    fx.advance(6_000);
    const { pub } = await loop(p, { publish: true });
    assert.ok(pub !== null);
    assert.deepEqual(pub.dependencyPins, [], 'no dependency PIN: the INCOMING record withholds no path of the group (HLD-42)');
    assert.deepEqual(p.core.holds.nonTerminal().filter((r) => r.kind === 'PIN').map((r) => r.guards.map((g) => g.name)), [], 'no PIN record');
    assert.equal(pub.outcome, 'landed', JSON.stringify(pub));
    const live = await treeOf(p, await remoteLiveCode(fx, p));
    assert.equal(await blobText(p, live, path), t9([2, 'a team line'], [8, 'a human line']), 'the human line published with the team line');
    assert.equal(await blobText(p, live, OTHER), 'o1\no2 human\no3\n', 'and the rest of the change-set in the same commit');
  });
}

test('final review F5: a secret-like tracked file under an INCOMING lock record (local_only by its name) still publishes the human\'s own edit with its change-set — no step-2 withholding, no dependency PIN', T10, async () => {
  await scenario('f5-incoming-secretlike', 'src/credentials.txt', true);
});

test('final review F5 control: the same scenario on a name that is not secret-like (the INCOMING record is not local_only) publishes the same way', T10, async () => {
  await scenario('f5-incoming-plain', 'src/plain.txt', false);
});
