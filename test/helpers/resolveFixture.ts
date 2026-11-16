// Shared helpers of the Plan 3 Task 11 resolve tests (05-holds Table 4, HLD-57…HLD-59, HLD-64): the human's options, board windows
// until every hold op landed, the close-capture-publish-R1 sequence a released record goes through, and record snapshots for the
// "nothing changed" assertions. Git is never mocked.
import assert from 'node:assert/strict';
import { joinDraft } from '../../src/engine/core.js';
import { evaluateRecords } from '../../src/engine/holdOps.js';
import type { ResolveOptions } from '../../src/engine/resolve.js';
import type { PublishReport } from '../../src/engine/publish.js';
import type { HoldRecord } from '../../src/holds/record.js';
import type { CoreFixture, PeerFixture } from './coreFixture.js';
import { prepIt } from './holdOpsFixture.js';
import { win } from './mirrorFixture.js';
import { captureReady, prep } from './publishHelpers.js';

/** A human-typed verb (SEC-25 evidence). */
export const HUMAN: ResolveOptions = { humanEvidence: true, actor: 'human' };

/** Hold drafts (pending or allocated) of the peer's outbox. */
export const holdDrafts = (p: PeerFixture): number => p.core.outbox.drafts().filter((d) => d.type === 'hold').length;

/**
 * A bootstrapped peer other than the first has no `join` op on the board (the test bootstrap writes peer 0's only), so the fold
 * ignores its ops: this lands its join op (Plan 2's joinDraft) first.
 */
export async function joinOnBoard(fx: CoreFixture, p: PeerFixture, max = 8): Promise<void> {
  p.core.outbox.add(await joinDraft(p.core));
  for (let i = 0; i < max; i++) {
    await win(fx, p);
    if (p.core.outbox.size === 0) return;
  }
  assert.equal(p.core.outbox.size, 0, `${p.name}: its join op landed`);
}

/** Governed windows until the outbox holds no hold op (each landed); at most `max`. */
export async function landHoldOps(fx: CoreFixture, p: PeerFixture, max = 8): Promise<void> {
  for (let i = 0; i < max; i++) {
    await win(fx, p);
    if (holdDrafts(p) === 0) return;
  }
  assert.equal(holdDrafts(p), 0, 'every hold op landed');
}

/**
 * The open human CS closes (a tick, then 21 s quiet), its pair is captured, windows run until a code publish lands (`max`), then one
 * materializing iteration and R1 (evaluateRecords over the paths A changed). Returns the landing report.
 */
export async function captureAndLand(fx: CoreFixture, p: PeerFixture, max = 8): Promise<PublishReport> {
  // Two ticks 2.5 s apart first: a > 50 % shrink is seen only at its second stable snapshot (the shrink guard).
  await prep(p);
  fx.advance(2_500);
  await prep(p);
  fx.advance(21_000);
  await captureReady(p, await prep(p, true));
  let landed: PublishReport | null = null;
  for (let i = 0; i < max && landed === null; i++) {
    const { r } = await win(fx, p);
    if (r.outcome === 'landed' && r.c !== null) landed = r;
  }
  assert.ok(landed !== null, 'a code publish landed');
  const it = await prepIt(p, { materialize: true });
  await evaluateRecords(p.core, it, new Set(it.A.keys()), []);
  return landed;
}

/** A record as stored now (undefined when absent). */
export const recordOf = (p: PeerFixture, id: string): HoldRecord | undefined => p.core.holds.get(id);
