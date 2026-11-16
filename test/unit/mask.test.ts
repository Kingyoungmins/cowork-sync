import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScopeClass } from '../../src/data/scope.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import type { GitRepo, TreeEntry, TreeMap } from '../../src/git/repo.js';
import { assertP, maskEntries, maskReason, type MaskInputs } from '../../src/holds/mask.js';
import { RebaseCache } from '../../src/holds/rebase.js';
import type { Guard, HoldRecord, HoldState, Residence } from '../../src/holds/record.js';

const PEER = '0123456789abcdef0123456789abcdef';
const O = (c: string): Oid => parseOid(c.repeat(40));
const E = (path: string, c: string): TreeEntry => ({ path, mode: '100644', oid: O(c) });
const map = (...es: TreeEntry[]): TreeMap => new Map(es.map((e) => [e.path, e]));

let ids = 0;
function rec(o: {
  kind?: 'PATCH' | 'PIN' | 'INCOMING'; residence: Residence | null; state: HoldState; paths: string[]; guards?: string[]; local_only?: boolean;
}): HoldRecord {
  const paths = [...o.paths].sort();
  const side = Object.fromEntries(paths.map((p) => [p, ABSENT])) as Record<string, typeof ABSENT>;
  const guards: Guard[] = (o.guards ?? []).map((name) => ({ name, class: 'DECISION', owner: 'DAT' }));
  return {
    id: `01J9ZQ3V5W6X7Y8Z9A0B1C2D${String(ids++).padStart(2, '0')}`, rev: 1, owner: PEER,
    kind: o.kind ?? 'PATCH', residence: o.residence, state: o.state, offer: 'none', declines: 0, displaced_by: null,
    paths, blobs: { h0: { ...side }, h1: { ...side } }, guards, origin: 'human', cs_ids: [], peer_authors: [],
    local_only: o.local_only ?? false, age_anchor: { since_rev: 1, anchor_wall_ms: 0, mono_accum_ms: 0 }, proto: 1,
  };
}

function scopeOf(classes: Record<string, ScopeClass>): (p: string) => ScopeClass {
  return (p) => classes[p] ?? 'LIVE';
}

/** A GitRepo that refuses every use: steps 1–4 (and a whole-path step-5 path) run no git. */
const NO_GIT = new Proxy({}, { get: (_t, k) => { throw new Error(`no git expected (GitRepo.${String(k)})`); } }) as GitRepo;
const noCache = (): RebaseCache => new RebaseCache(NO_GIT, () => true);

test('MASK steps 1–4 apply in order and OFF_DISK records mask nothing', async () => {
  const records = [
    // step 1 beats every record step
    rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['q.json', 'gi', 'gen.js', 'pin2.txt'], guards: ['join'] }),
    // step 2: local_only (any guard) and a whole-path guard (with an argument), both before steps 3 and 4
    rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['secret.cfg', 'lo-pin.txt'], guards: ['secret-scan'], local_only: true }),
    rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['lo-pin.txt'], guards: ['join'] }),
    rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['gen2.js'], guards: ['generated?:exclude'] }),
    rec({ residence: 'ON_DISK', state: 'CONFLICTED', paths: ['eol.ini'], guards: ['eol-bom', 'conflict'] }),
    // step 3: an ON_DISK PIN with guards beats step 4
    rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['pin.txt'], guards: ['phantom'] }),
    rec({ residence: 'ON_DISK', state: 'CONFLICTED', paths: ['pin.txt', 'k4.txt'], guards: ['conflict'] }),
    // OFF_DISK records mask nothing (INV-HLD-OFFDISK): a K4 loser after the TIP write, a marker companion, a ring late write
    rec({ residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['off-k4.txt'], guards: ['conflict'] }),
    rec({ residence: 'OFF_DISK', state: 'PARKED', paths: ['companion.txt'], local_only: true }),
    rec({ residence: 'OFF_DISK', state: 'PARKED', paths: ['late.txt'] }),
    // ... except an OFF_DISK claim-breach path pin (step 4)
    rec({ residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['breach.txt'], guards: ['claim-breach'] }),
    // no guard: an ON_DISK PIN or ACTIVE PATCH with an empty guard set holds nothing; terminal records hold nothing
    rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['released-pin.txt'] }),
    rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['released-patch.txt'] }),
    rec({ residence: null, state: 'SUBSUMED', paths: ['done.txt'], guards: ['conflict'] }),
  ];
  const inp: MaskInputs = {
    A: map(), records, mergeable: () => true,
    scope: scopeOf({ 'q.json': 'QUARANTINED', gi: 'SAVE_ONLY', 'gen.js': 'UNMANAGED', 'nf.txt': 'NOT_ADMITTED', 'lo.txt': 'LOCAL_ONLY' }),
  };
  const want: Record<string, string | null> = {
    'q.json': 'path_class', gi: 'path_class', 'gen.js': 'path_class',
    'secret.cfg': 'local_only', 'lo-pin.txt': 'local_only', 'gen2.js': 'whole_path_guard', 'eol.ini': 'whole_path_guard',
    'pin2.txt': 'pin', 'pin.txt': 'pin', 'k4.txt': 'conflicted', 'breach.txt': 'conflicted',
    'off-k4.txt': null, 'companion.txt': null, 'late.txt': null, 'released-pin.txt': null, 'released-patch.txt': null, 'done.txt': null,
    // only QUARANTINED, SAVE_ONLY and UNMANAGED are step-1 classes
    'nf.txt': null, 'lo.txt': null, 'plain.txt': null,
  };
  for (const [p, r] of Object.entries(want)) assert.equal(maskReason(p, inp), r, p);

  // maskEntries: every masked path takes A's entry, every other path keeps X's.
  const all = Object.keys(want);
  const A = map(...all.map((p) => E(p, 'a')));
  const X = map(...all.map((p) => E(p, 'b')));
  const out = await maskEntries(NO_GIT, X, { ...inp, A }, noCache());
  assert.deepEqual([...out.entries.keys()].sort(), [...all].sort());
  for (const [p, r] of Object.entries(want)) {
    assert.equal(out.entries.get(p)!.oid, r === null ? O('b') : O('a'), p);
    assert.equal(out.withheld.has(p), r !== null, p);
  }
});

test('an ON_DISK ACTIVE PATCH with guards is a step-5 record; on a path that is not mergeable it is withheld whole without git', async () => {
  // Plan 3 (R3-18, R3-19): step 5 is the merge-file form (test/integration/mask.p3.test.ts); R-04's whole-path form survives only
  // for a binary or filtered path, which never reaches merge-file.
  const restart = rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt', 'src/b.txt'], guards: ['restart'] });
  const inp: MaskInputs = {
    A: map(E('src/a.txt', 'a'), E('src/b.txt', 'a'), E('src/c.txt', 'a')), scope: scopeOf({}), records: [restart], mergeable: () => false,
  };
  assert.equal(maskReason('src/a.txt', inp), 'patch');
  assert.equal(maskReason('src/c.txt', inp), null);
  const X = map(E('src/a.txt', 'b'), E('src/b.txt', 'c'), E('src/c.txt', 'd'), E('src/new.txt', 'e'));
  const out = await maskEntries(NO_GIT, X, inp, noCache());
  assert.deepEqual(out.entries, map(E('src/a.txt', 'a'), E('src/b.txt', 'a'), E('src/c.txt', 'd'), E('src/new.txt', 'e')));
  assert.deepEqual([...out.withheld].sort(), ['src/a.txt', 'src/b.txt']);
  assert.deepEqual([...out.partial], []);
  // A PIN or an OFF_DISK PATCH is never a step-5 record.
  const parked = { ...restart, residence: 'OFF_DISK' as const, state: 'PARKED' as const };
  assert.equal(maskReason('src/a.txt', { ...inp, records: [parked] }), null);
  // Inputs are not modified.
  assert.equal(X.get('src/a.txt')!.oid, O('b'));
});

test('a masked path that A lacks is absent from the result', async () => {
  const held = rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['new-held.txt', 'old-held.txt'], guards: ['join'] });
  const inp: MaskInputs = {
    A: map(E('old-held.txt', 'a'), E('vscode.json', 'a'), E('kept.txt', 'a'), E('gone.txt', 'a')),
    scope: scopeOf({ 'new-q.json': 'QUARANTINED', 'vscode.json': 'QUARANTINED' }),
    records: [held], mergeable: () => true,
  };
  // X: a held and a quarantined path A lacks (created locally), and a held and a quarantined path X lacks (deleted locally).
  const X = map(E('new-held.txt', 'b'), E('new-q.json', 'b'), E('kept.txt', 'b'), E('free.txt', 'b'));
  const out = (await maskEntries(NO_GIT, X, inp, noCache())).entries;
  assert.equal(out.has('new-held.txt'), false, 'a held creation is withheld');
  assert.equal(out.has('new-q.json'), false, 'a quarantined creation is withheld');
  // ... and a masked path X lacks takes A's entry: a held or quarantined deletion is withheld too.
  assert.deepEqual(out.get('old-held.txt'), E('old-held.txt', 'a'));
  assert.deepEqual(out.get('vscode.json'), E('vscode.json', 'a'));
  // Unmasked paths keep X, including X's deletion of gone.txt.
  assert.deepEqual(out.get('kept.txt'), E('kept.txt', 'b'));
  assert.deepEqual(out.get('free.txt'), E('free.txt', 'b'));
  assert.equal(out.has('gone.txt'), false);
  assert.deepEqual([...out.keys()].sort(), ['free.txt', 'kept.txt', 'old-held.txt', 'vscode.json']);
});

test('final review F5: an INCOMING record masks nothing, local_only included (R3-21 as amended by Task 6) — its path keeps X in S_pub and P', async () => {
  // An INCOMING record holds TIP's bytes and none of this disk's (ON_DISK by schema only): a secret-like name (U10) makes it local_only
  // for its mirror (a content-free stub), never a reason to withhold the human's own edit of a tracked LIVE file. Its guards are never
  // whole-path (05 §2) and it is never CONFLICTED, so it reaches no MASK step.
  const incoming = [
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/credentials.txt'], guards: ['lock'], local_only: true }),
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['.env.example', 'src/u.txt'], guards: ['eol-form'], local_only: true }),
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['appsettings.Development.json'], guards: ['collision'], local_only: true }),
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/plain.txt'], guards: ['lock'] }),
    // a local-only-conflict record waits for the local_only PATCH over its path: that PATCH masks it (step 2), the INCOMING one adds nothing
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/scanned.txt'], guards: ['local-only-conflict'], local_only: true }),
    rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/scanned.txt'], guards: ['secret-scan'], local_only: true }),
    // a quarantine-review record's path is masked by its class (step 1), not by the record
    rec({ kind: 'INCOMING', residence: 'ON_DISK', state: 'ACTIVE', paths: ['.claude/settings.json'], guards: ['quarantine-review'], local_only: true }),
  ];
  const want: Record<string, string | null> = {
    'src/credentials.txt': null, '.env.example': null, 'src/u.txt': null, 'appsettings.Development.json': null, 'src/plain.txt': null,
    'src/scanned.txt': 'local_only', '.claude/settings.json': 'path_class',
  };
  const all = Object.keys(want);
  const A = map(...all.map((p) => E(p, 'a')));
  const inp: MaskInputs = { A, records: incoming, mergeable: () => true, scope: scopeOf({ '.claude/settings.json': 'QUARANTINED' }) };
  for (const [p, r] of Object.entries(want)) assert.equal(maskReason(p, inp), r, p);
  // S_pub / MASK(R): the human's edits of the INCOMING-only paths stay; the two masked paths take A.
  const X = map(...all.map((p) => E(p, 'b')));
  const out = await maskEntries(NO_GIT, X, inp, noCache());
  for (const [p, r] of Object.entries(want)) assert.equal(out.entries.get(p)!.oid, r === null ? O('b') : O('a'), p);
  assert.deepEqual([...out.withheld].sort(), ['.claude/settings.json', 'src/scanned.txt']);
  // HLD-19 on P: a P carrying the human's edits of those paths is no p_local_only (or p_withheld) failure.
  const P = map(...all.map((p) => E(p, want[p] === null ? 'b' : 'a')));
  assert.deepEqual(await assertP(NO_GIT, P, inp), { ok: true });
  // ... while a P that carries the local_only PATCH's path still fails.
  assert.deepEqual(await assertP(NO_GIT, map(...all.map((p) => E(p, 'b'))), inp), { ok: false, clause: 'p_class', path: '.claude/settings.json' });
  assert.deepEqual(await assertP(NO_GIT, new Map([...P, ['src/scanned.txt', E('src/scanned.txt', 'b')]]), inp), { ok: false, clause: 'p_local_only', path: 'src/scanned.txt' });
});

test('R3-EF4-29 (HLD-05 fail closed, version skew): an ON_DISK record carrying a guard outside Table 3 is whole-path at step 2, never a step-5 record, so MASK reports no CONFLICTED id for it', async () => {
  // A newer daemon wrote 'future-guard' (HLD-05: this daemon never releases or transitions it). Step 5 could report the record in
  // `conflicted`, and Algorithm P would then commit a state patch the registry refuses for such a record (a thrown publishStep).
  const future = rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/a.txt'], guards: ['future-guard'] });
  const mixed = rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/b.txt'], guards: ['restart', 'future-guard'] });
  const pin = rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['src/c.txt'], guards: ['future-guard'] });
  const inp: MaskInputs = {
    A: map(E('src/a.txt', 'a'), E('src/b.txt', 'a'), E('src/c.txt', 'a'), E('src/d.txt', 'a')), scope: scopeOf({}), records: [future, mixed, pin], mergeable: () => true,
  };
  for (const p of ['src/a.txt', 'src/b.txt', 'src/c.txt']) assert.equal(maskReason(p, inp), 'whole_path_guard', p);
  assert.equal(maskReason('src/d.txt', inp), null);
  // No step 5 runs (no git): every path of these records takes A whole, and none is reported conflicted.
  const out = await maskEntries(NO_GIT, map(E('src/a.txt', 'b'), E('src/b.txt', 'b'), E('src/c.txt', 'b'), E('src/d.txt', 'b')), inp, noCache());
  assert.deepEqual(out.entries, map(E('src/a.txt', 'a'), E('src/b.txt', 'a'), E('src/c.txt', 'a'), E('src/d.txt', 'b')));
  assert.deepEqual([...out.withheld].sort(), ['src/a.txt', 'src/b.txt', 'src/c.txt']);
  assert.deepEqual([...out.partial], []);
  assert.deepEqual(out.conflicted, []);
  // OFF_DISK it still masks nothing (INV-HLD-OFFDISK), and a terminal one holds nothing.
  assert.equal(maskReason('src/a.txt', { ...inp, records: [{ ...future, residence: 'OFF_DISK', state: 'PARKED' }] }), null);
  assert.equal(maskReason('src/a.txt', { ...inp, records: [{ ...future, residence: null, state: 'GONE' }] }), null);
});
