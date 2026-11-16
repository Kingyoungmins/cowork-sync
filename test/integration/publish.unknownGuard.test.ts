// Ruling R3-EF4-29 (delta review I3; 05-holds HLD-05 fail closed, version skew): an ACTIVE ON_DISK PATCH carrying a guard outside
// Table 3 (written by a newer daemon) is whole-path in MASK (step 2), never a step-5 record. Before the ruling it masked at step 5;
// when its reverse merge conflicted with an adjacent human edit, maskEntries reported it in `conflicted` and Algorithm P committed
// {state: CONFLICTED} for it — which the registry refuses for such a record (TypeError, HLD-05), so publishStep threw every window
// (a daemon crash loop). Started from the delta probe zz_inv_unknownguard_step5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishStep } from '../../src/engine/publish.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { readWork, writeWork } from '../helpers/coreFixture.js';
import { blob, P, pair, plantRecord, prepIt, withPeers } from '../helpers/holdOpsFixture.js';
import { t9 } from '../helpers/maskFixture.js';
import { editAndCapture } from '../helpers/publishHelpers.js';

const T10 = { timeout: 10 * 60_000 };
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FZZ';

test('R3-EF4-29: an unknown-guard ACTIVE PATCH whose path the human edits next to its held row withholds the path whole; publishStep never throws and the record is never transitioned (HLD-05)', T10, async () => {
  await withPeers('x3-unknown-step5', {}, async (fx) => {
    const p = fx.peers[0]!;
    await writeWork(p, P, t9([5, 'five held']));
    const it0 = await prepIt(p, { holdPaths: [P] });
    const a = it0.A.get(P)!.oid;
    const planted: HoldRecord = {
      id: ID, rev: 1, owner: p.core.peerId, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0,
      displaced_by: null, paths: [P], blobs: pair(a, await blob(p, t9([5, 'five held']))),
      guards: [{ name: 'future-guard', class: 'DECISION', owner: 'HLD' }], origin: 'human',
      cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
    };
    await plantRecord(p, planted);
    // The human edits the adjacent row; captured as a ready pair. Step 5's reverse merge of r would conflict with it.
    await editAndCapture(fx, p, { [P]: t9([5, 'five held'], [6, 'six local']) });
    fx.advance(3_000);
    const it = await prepIt(p, { forceFetch: true });
    let err: unknown = null;
    try {
      await publishStep(p.core, it);
    } catch (e) {
      err = e;
    }
    assert.equal(err, null, `publishStep threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    // The record is untouched (HLD-05: no state, residence, guards or offer change) and still holds its path.
    const r = p.core.holds.get(ID)!;
    assert.deepEqual([r.rev, r.state, r.residence, r.guards.map((g) => g.name)], [1, 'ACTIVE', 'ON_DISK', ['future-guard']]);
    // The path is withheld whole: the live code still has A[p] there (neither the held row nor the adjacent human row left).
    const after = await prepIt(p, { forceFetch: true });
    assert.equal(after.tipMap.get(P)?.oid, a, 'TIP[p] is still A[p]: the path was withheld whole');
    assert.deepEqual(await readWork(p, P), Buffer.from(t9([5, 'five held'], [6, 'six local']), 'utf8'), 'the disk is untouched');
    // A second window does not throw either.
    fx.advance(10_000);
    await publishStep(p.core, await prepIt(p, { forceFetch: true }));
  });
});
