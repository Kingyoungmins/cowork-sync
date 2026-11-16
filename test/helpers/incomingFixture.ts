// Shared helpers of the receive-side tests (Plan 3 Task 6; 05-holds HLD-32, HLD-53…HLD-55; 03-data DAT-11, DAT-29, DAT-33): the
// test loop (prepareIteration → applyStep → incomingStep → raiseHoldCodes → mirrorSync/publishStep, as Task 12's recordStep will
// compose it; Engine.iterate is Plan 2 Tasks 17–20, not on this base, R3-72), the IncomingInputs built from an ApplyReport and the
// iteration (the transient map from the tick's exclusions, privateBlob read from the private index), and small record queries.
// Git is never mocked.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { captureDue, raiseHoldCodes, tickInputOf, type IterationCtx } from '../../src/engine/core.js';
import { mirrorSync, publishStep, type PublishReport } from '../../src/engine/publish.js';
import { transientOf } from '../../src/engine/holdSteps.js';
import { sameTreeEntry } from '../../src/engine/treeDiff.js';
import { ABSENT, type OidOrAbsent } from '../../src/git/oid.js';
import { incomingCsOf, incomingStep, type HoldCodeRaise, type IncomingInputs } from '../../src/holds/incoming.js';
import { guardName, type HoldRecord } from '../../src/holds/record.js';
import type { PeerFixture } from './coreFixture.js';
import { prep } from './publishHelpers.js';

/**
 * HLD-32's publish-side exclusions of a tick as IncomingInputs.transient: since Plan 3 Task 12a the one definition is holdSteps.ts's
 * (recordStep builds IncomingInputs with it); re-exported for these tests.
 */
export { transientOf };

/** The blob the peer's private index holds for p (ls-files -s on <coworkDir>/<e>.index, as Snapshotter.lsIndex reads it), else ABSENT. */
export async function privateBlobs(p: PeerFixture): Promise<(path: string) => OidOrAbsent> {
  const index = join(p.deps.paths.coworkDir, `${p.core.refs.e}.index`);
  const r = await p.core.repo.run(['ls-files', '-s', '-z'], { indexFile: index, config: { 'core.untrackedCache': 'false', 'core.protectNTFS': 'false' } });
  const m = new Map<string, OidOrAbsent>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, oid, stage] = rec.slice(0, tab).split(' ');
    if (stage === '0' && oid !== undefined) m.set(rec.slice(tab + 1), oid as OidOrAbsent);
  }
  return (path) => m.get(path) ?? ABSENT;
}

/**
 * IncomingInputs of one loop: everything from the ApplyReport and the iteration (A after the apply, TIP, the tick's exclusions).
 * The private index is read only when the tick has a transient exclusion (incomingStep reads privateBlob for a transient PIN's h1
 * alone), so an idle loop spends no git process on it.
 */
export async function inputsOf(p: PeerFixture, it: IterationCtx, apply: ApplyReport): Promise<IncomingInputs> {
  const transient = transientOf(it.tick?.excluded ?? new Map());
  return {
    A: it.A, tipMap: it.tipMap, differs: (path) => !sameTreeEntry(it.A.get(path), it.tipMap.get(path)),
    closures: apply.closures, notApplicable: apply.notApplicable, rules: apply.notApplicableRules,
    csOf: incomingCsOf(apply.incoming),
    transient,
    privateBlob: transient.size > 0 ? await privateBlobs(p) : () => ABSENT,
  };
}

export interface Loop { it: IterationCtx; apply: ApplyReport; created: string[]; released: string[]; codes: HoldCodeRaise[]; pub: PublishReport | null; }

/**
 * One test-loop iteration: prepareIteration ('auto' materialize, a fresh fetch) → (`capture`: the HLD-40 capture when due, as
 * mirrorFixture's loopOnce composes it) → applyStep → incomingStep → raiseHoldCodes, then publishStep (`publish`), or mirrorSync only
 * (`mirror`: drafts the hold ops a publish would carry), or neither.
 */
export async function loop(p: PeerFixture, o: { publish?: boolean; mirror?: boolean; capture?: boolean } = {}): Promise<Loop> {
  const it = await prep(p, 'auto');
  const core = p.core;
  if (o.capture === true && captureDue(core)) {
    if (it.mat === null) it.mat = await core.snapshot.materialize(tickInputOf(core, it));
    const c = await core.cs.capture(core.repo, it.mat.sDiskMap, it.A, core.scratch('r'));
    if (c !== null) await core.commit({ ready: core.cs.ready(), meta: { ...core.view!.meta, cs_human_next: c.nextN } });
  }
  const apply = await applyStep(p.core, it);
  const r = await incomingStep(p.core.holds, p.core.transient, await inputsOf(p, it, apply));
  raiseHoldCodes(p.core, r.codes);
  let pub: PublishReport | null = null;
  if (o.publish === true) pub = await publishStep(p.core, it);
  else if (o.mirror === true) await mirrorSync(p.core, it);
  return { it, apply, ...r, pub };
}

/** Non-terminal INCOMING records of the peer, in ULID order. */
export function incomingRecords(p: PeerFixture): HoldRecord[] {
  return p.core.holds.nonTerminal().filter((r) => r.kind === 'INCOMING');
}

/** Every record (any state) carrying `guard` (by name, an argument ignored). */
export function withGuard(p: PeerFixture, guard: string): HoldRecord[] {
  return p.core.holds.all().filter((r) => r.guards.some((g) => guardName(g) === guard));
}

/** The one record carrying `guard`; fails otherwise. */
export function onlyWithGuard(p: PeerFixture, guard: string): HoldRecord {
  const rs = withGuard(p, guard);
  assert.equal(rs.length, 1, `exactly one ${guard} record: ${JSON.stringify(rs.map((r) => [r.id, r.paths, r.state]))}`);
  return rs[0]!;
}

/** The registry head (null = none). */
export function registryHead(p: PeerFixture): string | null {
  return p.core.holds.head();
}
