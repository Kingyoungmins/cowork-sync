// MASK in merge-file form (Plan 3 Task 2; glossary §3 MASK; 05-holds §3.4 item 2, HLD-13, HLD-15; 03-data DAT-20, DAT-23,
// DAT-35; rulings R3-18, R3-19, R3-21, R3-50 mutants M19, M25, M28), on a real clone. Notation: test/helpers/maskFixture.ts
// (T9, T9{2:two}, T9+{4:x1,x2}, T9-{3}, B0…B3). r is an ON_DISK ACTIVE `revert` PATCH unless stated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AttrCache } from '../../src/data/attrs.js';
import { DEFAULT_TEAM_CONFIG } from '../../src/data/config.js';
import { scopeOfTracked, type ScopeClass, type ScopeInputs } from '../../src/data/scope.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { buildGitInvocation, MERGE_FLAGS } from '../../src/git/flags.js';
import { ABSENT, parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo, type TreeEntry, type TreeMap } from '../../src/git/repo.js';
import { maskEntries, maskReason, type MaskInputs, type MaskResult } from '../../src/holds/mask.js';
import { HoldOperatorError, RebaseCache } from '../../src/holds/rebase.js';
import type { HoldRecord } from '../../src/holds/record.js';
import { HoldRegistry } from '../../src/holds/registry.js';
import { nullLog } from '../../src/ports/log.js';
import { realFs } from '../../src/ports/fs.js';
import { seededRandom } from '../../src/ports/random.js';
import {
  binary, inputs, looseObjects, mergeCalls, P, pair, PEER, record, T9, t9, tmap, ulidOf, withMaskRepo, type MaskCtx,
} from '../helpers/maskFixture.js';
import { mergeLabels, mergeSides } from '../helpers/mergeFileArgs.js';
import { fixtureContext } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

/** R3-55: every test of this file carries the 10-minute node:test timeout. */
const T10 = { timeout: 10 * 60_000 };

const O =(c: string): Oid => parseOid(c.repeat(40));
const E = (path: string, c: string): TreeEntry => ({ path, mode: '100644', oid: O(c) });
const map = (...es: TreeEntry[]): TreeMap => new Map(es.map((e) => [e.path, e]));

/** A HoldRegistry on the clone (the scope is LIVE everywhere, A as given). */
async function registryOf(c: MaskCtx, A: () => TreeMap): Promise<HoldRegistry> {
  const reg = new HoldRegistry({
    repo: c.repo, ref: refNames('main', RELEASE_NAMESPACE).holds, random: seededRandom('mask-p3'), clock: new VirtualClock(), peer: PEER,
    trace: { emit: () => {} }, log: nullLog, scopeOf: () => () => 'LIVE', A, rebase: new RebaseCache(c.repo, () => true),
  });
  await reg.load();
  return reg;
}

test('steps 1–4 keep Plan 2\'s order and results through the async maskEntries', T10, async () => {
  await withMaskRepo('mask-steps14', async (c) => {
    const at = (paths: string[]): { h0: Record<string, typeof ABSENT>; h1: Record<string, typeof ABSENT> } => ({
      h0: Object.fromEntries(paths.map((p) => [p, ABSENT])), h1: Object.fromEntries(paths.map((p) => [p, ABSENT])),
    });
    const rec = (o: { kind?: 'PATCH' | 'PIN'; residence: 'ON_DISK' | 'OFF_DISK' | null; state: HoldRecord['state']; paths: string[]; guards?: string[]; local_only?: boolean }): HoldRecord =>
      record(at(o.paths), { kind: o.kind, residence: o.residence, state: o.state, paths: o.paths, guards: o.guards ?? [], local_only: o.local_only });
    const records = [
      rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['q.json', 'gi', 'gen.js', 'pin2.txt'], guards: ['join'] }),
      rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['secret.cfg', 'lo-pin.txt'], guards: ['secret-scan'], local_only: true }),
      rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['lo-pin.txt'], guards: ['join'] }),
      rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['gen2.js'], guards: ['generated?:exclude'] }),
      rec({ residence: 'ON_DISK', state: 'CONFLICTED', paths: ['eol.ini'], guards: ['eol-bom', 'conflict'] }),
      rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['pin.txt'], guards: ['phantom'] }),
      rec({ residence: 'ON_DISK', state: 'CONFLICTED', paths: ['pin.txt', 'k4.txt'], guards: ['conflict'] }),
      rec({ residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['off-k4.txt'], guards: ['conflict'] }),
      rec({ residence: 'OFF_DISK', state: 'PARKED', paths: ['companion.txt'], local_only: true }),
      rec({ residence: 'OFF_DISK', state: 'PARKED', paths: ['late.txt'] }),
      rec({ residence: 'OFF_DISK', state: 'CONFLICTED', paths: ['breach.txt'], guards: ['claim-breach'] }),
      rec({ kind: 'PIN', residence: 'ON_DISK', state: 'ACTIVE', paths: ['released-pin.txt'] }),
      rec({ residence: 'ON_DISK', state: 'ACTIVE', paths: ['released-patch.txt'] }),
      rec({ residence: null, state: 'SUBSUMED', paths: ['done.txt'], guards: ['conflict'] }),
    ];
    const want: Record<string, string | null> = {
      'q.json': 'path_class', gi: 'path_class', 'gen.js': 'path_class',
      'secret.cfg': 'local_only', 'lo-pin.txt': 'local_only', 'gen2.js': 'whole_path_guard', 'eol.ini': 'whole_path_guard',
      'pin2.txt': 'pin', 'pin.txt': 'pin', 'k4.txt': 'conflicted', 'breach.txt': 'conflicted',
      'off-k4.txt': null, 'companion.txt': null, 'late.txt': null, 'released-pin.txt': null, 'released-patch.txt': null, 'done.txt': null,
      'nf.txt': null, 'lo.txt': null, 'plain.txt': null,
    };
    const all = Object.keys(want);
    const A = map(...all.map((p) => E(p, 'a')));
    const X = map(...all.map((p) => E(p, 'b')));
    const inp: MaskInputs = inputs(A, records, { scope: { 'q.json': 'QUARANTINED', gi: 'SAVE_ONLY', 'gen.js': 'UNMANAGED', 'nf.txt': 'NOT_ADMITTED', 'lo.txt': 'LOCAL_ONLY' } });
    for (const [p, r] of Object.entries(want)) assert.equal(maskReason(p, inp), r, p);
    const n0 = c.calls.length;
    const out = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, () => true));
    assert.equal(c.calls.length, n0, 'steps 1–4 run no git');
    assert.deepEqual([...out.entries.keys()].sort(), [...all].sort());
    for (const [p, r] of Object.entries(want)) {
      assert.equal(out.entries.get(p)!.oid, r === null ? O('b') : O('a'), p);
      assert.equal(out.withheld.has(p), r !== null, `${p} listed in withheld iff masked`);
    }
    assert.deepEqual([...out.partial], []);
    assert.deepEqual(out.conflicted, []);
  });
});

test('step 5 removes only the held change: an edit two lines away publishes', T10, async () => {
  await withMaskRepo('mask-step5', async (c) => {
    const a = await c.blob(T9);
    const r = record(pair(a, await c.blob(t9([2, 'two']))));
    const other = await c.blob('other\n');
    const A = tmap({ [P]: a, 'src/other.txt': other });
    const X = tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])), 'src/other.txt': other });
    const from = c.calls.length;
    const out = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    const during = c.calls.slice(from);   // maskEntries' own calls only (the test's c.blob() is route (c) too)
    assert.equal(await c.text(out.entries.get(P)?.oid), t9([6, 'six']));
    assert.equal(out.entries.get(P)!.oid, await c.blob(t9([6, 'six'])));
    const routeC = during.filter((x) => x.args[0] === 'hash-object' && x.args.includes('-w') && x.args.includes('--stdin') && x.args.includes('--no-filters')
      && !x.args.some((a) => a.startsWith('--path')));
    assert.ok(routeC.some((x) => x.opts.stdin !== undefined && Buffer.from(x.opts.stdin).equals(Buffer.from(t9([6, 'six']), 'utf8'))),
      'the step-5 output is written by route (c) during maskEntries');
    assert.deepEqual([...out.partial], [P]);
    assert.deepEqual([...out.withheld], []);
    assert.deepEqual(out.conflicted, []);
    assert.equal(out.entries.get('src/other.txt')!.oid, other);
  });
});

test('step 5 runs every guarded ON_DISK ACTIVE PATCH on p in ULID order from x = X[p]', T10, async () => {
  await withMaskRepo('mask-chain', async (c) => {
    const a = await c.blob(T9);
    const r1 = record(pair(a, await c.blob(t9([2, 'two']))), { id: ulidOf(1) });
    const r2 = record(pair(a, await c.blob(t9([8, 'eight']))), { id: ulidOf(2) });
    const A = tmap({ [P]: a });
    const x0 = await c.blob(t9([2, 'two'], [5, 'five'], [8, 'eight']));
    const cache = new RebaseCache(c.repo, () => true);
    // REBASE of both records first (cached by (id, rev, A[p])), so the calls below are step 5's own.
    await cache.rebase(r1, A);
    await cache.rebase(r2, A);
    const before = c.calls.length;
    const out = await maskEntries(c.repo, tmap({ [P]: x0 }), inputs(A, [r2, r1]), cache);
    assert.equal(await c.text(out.entries.get(P)?.oid), t9([5, 'five']));
    const merges = mergeCalls(c.calls.slice(before));
    assert.equal(merges.length, 2);
    const h1r1 = await c.blob(t9([2, 'two']));
    const h1r2 = await c.blob(t9([8, 'eight']));
    assert.deepEqual(mergeSides(merges[0]!.args), [x0, h1r1, a], 'r1 (the smaller ULID) first: mf(X[p], H1\'[p], H0\'[p])');
    const mid = await c.blob(t9([5, 'five'], [8, 'eight']));
    assert.deepEqual(mergeSides(merges[1]!.args), [mid, h1r2, a], 'the second takes the first output as <current>');
  });
});

test('a step-5 conflict withholds the whole path and reports the record', T10, async () => {
  await withMaskRepo('mask-conflict', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const reg = await registryOf(c, () => A);
    const id = await reg.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], blobs: pair(a, await c.blob(t9([2, 'two']))), guard: 'revert',
      origin: 'human', cs_ids: [], displaced_by: null,
    });
    const head = reg.head();
    const refsBefore = await c.repo.listRefs('refs/');
    const out = await maskEntries(c.repo, tmap({ [P]: await c.blob(t9([2, 'two'], [3, 'three'])) }), inputs(A, reg.maskingRecords()), new RebaseCache(c.repo, () => true));
    assert.equal(out.entries.get(P)!.oid, a, 'the path takes A[p]');
    assert.deepEqual([...out.withheld], [P]);
    assert.deepEqual([...out.partial], []);
    assert.deepEqual(out.conflicted, [id]);
    assert.equal(reg.head(), head, 'maskEntries writes no registry state');
    assert.deepEqual(await c.repo.listRefs('refs/'), refsBefore);
    assert.equal(reg.get(id)!.state, 'ACTIVE', 'the caller transitions the record, not MASK');
  });
});

test('step 5 uses REBASE: mutant M19 reverts a teammate\'s identical change', T10, async () => {
  await withMaskRepo('mask-m19', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const A = tmap({ [P]: await c.blob(t9([2, 'two'])) });
    const X = tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) });
    const good = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    assert.equal(await c.text(good.entries.get(P)?.oid), t9([2, 'two'], [6, 'six']));
    const m19 = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true), { m19: true });
    assert.equal(await c.text(m19.entries.get(P)?.oid), t9([6, 'six']));
    assert.notEqual((await c.text(m19.entries.get(P)?.oid)).split('\n')[1], (await c.text(A.get(P)!.oid)).split('\n')[1], 'M19 differs from A on line 2');
  });
});

test('step 5 is a reverse merge: mutant M28 corrupts a file after a team insertion', T10, async () => {
  await withMaskRepo('mask-m28', async (c) => {
    const r = record(pair(await c.blob(T9), await c.blob(t9([2, 'two']))));
    const aText = `n1\nn2\nn3\n${T9}`;
    const A = tmap({ [P]: await c.blob(aText) });
    const xRows = aText.split('\n');
    xRows[4] = 'two';   // row 5 (`2`) → `two`
    const X = tmap({ [P]: await c.blob(xRows.join('\n')) });
    const good = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    assert.equal(good.entries.get(P)!.oid, A.get(P)!.oid, 'exactly A');
    const m28 = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true), { m28: true });
    const bad = await c.text(m28.entries.get(P)?.oid);
    assert.notEqual(bad, aText);
    assert.ok(bad.split('\n').includes('two'), 'the held line stays in');
  });
});

test('step 1 resets quarantined paths: mutant M25 does not', T10, async () => {
  await withMaskRepo('mask-m25', async (c) => {
    const ci = '.github/workflows/ci.yml';
    const A = tmap({ [ci]: await c.blob('on: push\n') });
    const X = tmap({ [ci]: await c.blob('on: [push, pull_request]\n') });
    const inp = inputs(A, [], { scope: { [ci]: 'QUARANTINED' } });
    const out = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, () => true));
    assert.equal(out.entries.get(ci)!.oid, A.get(ci)!.oid);
    assert.ok(out.withheld.has(ci));
    const m25 = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, () => true), { m25: true });
    assert.equal(m25.entries.get(ci)!.oid, X.get(ci)!.oid);
  });
});

const CLASS_FILES: Record<string, Buffer> = {
  '.gitattributes': Buffer.from('vendor/lib.bin cowork-sync=off\nsecret.cfg filter=crypt\n', 'utf8'),
  '.github/workflows/ci.yml': Buffer.from('on: push\n', 'utf8'),
  '.gitignore': Buffer.from('node_modules/\n', 'utf8'),
  'vendor/lib.bin': Buffer.from('lib v1\n', 'utf8'),
  '.env.local': Buffer.from('KEY=1\n', 'utf8'),
  'secret.cfg': Buffer.from('password = one\n', 'utf8'),
  'src/t9.txt': Buffer.from(T9, 'utf8'),
};

/** D5 over the clone's HEAD attributes (Plan 2's scopeOfTracked), with `localOnly` as row 9's record paths. */
async function d5(c: MaskCtx, A: TreeMap, localOnly: ReadonlySet<string>): Promise<(p: string) => ScopeClass> {
  const head = (await c.repo.resolve('HEAD'))!;
  const attrs = await new AttrCache(c.repo, realFs).snapshot(head, A.keys());
  const si: ScopeInputs = { attrs, config: DEFAULT_TEAM_CONFIG, mergeDrivers: new Set(), localOnlyPaths: localOnly, hooksPathDir: null };
  return (p) => scopeOfTracked(p, A.get(p)?.mode ?? '100644', 0, si).cls;
}

test('path classes are not records', T10, async () => {
  await withMaskRepo('mask-classes', async (c) => {
    const head = (await c.repo.resolve('HEAD'))!;
    const A = await c.repo.readTreeMap((await c.repo.readCommit(head)).tree);
    const env = '.env.local';
    const scope = await d5(c, A, new Set([env]));
    assert.equal(scope('.github/workflows/ci.yml'), 'QUARANTINED');
    assert.equal(scope('.gitignore'), 'SAVE_ONLY');
    assert.equal(scope('vendor/lib.bin'), 'UNMANAGED');
    assert.equal(scope(env), 'LOCAL_ONLY', 'row 9');
    const X = new Map(A);
    for (const p of ['.github/workflows/ci.yml', '.gitignore', 'vendor/lib.bin', env]) {
      X.set(p, { path: p, mode: '100644', oid: await c.blob(`${p} changed locally\n`) });
    }
    const lo = record(pair(A.get(env)!.oid, X.get(env)!.oid, env), { paths: [env], guards: ['secret-scan'], local_only: true });
    const reg = await registryOf(c, () => A);
    const refs0 = await c.repo.listRefs('refs/');
    const from = c.calls.length;
    const classes = ['.github/workflows/ci.yml', '.gitignore', 'vendor/lib.bin'];
    // The three path classes need no record: step 1 resets them with an empty record list. LOCAL_ONLY (row 9) is its record's
    // class: without the record MASK leaves the path alone, with it step 2 resets it.
    const bare = await maskEntries(c.repo, X, { A, scope, records: [], mergeable: () => true }, new RebaseCache(c.repo, () => true));
    for (const p of classes) {
      assert.equal(bare.entries.get(p)!.oid, A.get(p)!.oid, `${p} without a record`);
      assert.ok(bare.withheld.has(p), p);
      assert.equal(maskReason(p, { A, scope, records: [], mergeable: () => true }), 'path_class', p);
    }
    assert.equal(bare.entries.get(env)!.oid, X.get(env)!.oid, 'LOCAL_ONLY is masked by its record, not by its class');
    const out = await maskEntries(c.repo, X, { A, scope, records: [lo], mergeable: () => true }, new RebaseCache(c.repo, () => true));
    for (const p of [...classes, env]) {
      assert.equal(out.entries.get(p)!.oid, A.get(p)!.oid, p);
      assert.ok(out.withheld.has(p), p);
    }
    assert.equal(maskReason(env, { A, scope, records: [lo], mergeable: () => true }), 'local_only');
    // No registry record created: no ref moved, no registry-writing git command ran, and the registry re-read from its ref is empty.
    assert.deepEqual(await c.repo.listRefs('refs/'), refs0, 'no ref moved');
    assert.deepEqual(c.calls.slice(from).map((k) => k.args[0]).filter((a) => ['update-ref', 'commit-tree', 'mktree', 'update-index'].includes(a!)), []);
    await reg.load();
    assert.equal(reg.head(), null, 'no registry commit');
    assert.equal(reg.all().length, 0, 'no registry record');
  }, { files: CLASS_FILES });
});

test('OFF_DISK records and INCOMING records mask nothing; an OFF_DISK claim-breach pins its path', T10, async () => {
  await withMaskRepo('mask-offdisk', async (c) => {
    const a = await c.blob(T9);
    const held = await c.blob(t9([2, 'two']));
    const A = tmap({ [P]: a });
    const X = tmap({ [P]: await c.blob(t9([2, 'two'], [6, 'six'])) });
    const cases: Array<[string, HoldRecord, boolean]> = [
      ['an OFF_DISK PARKED revert PATCH', record(pair(a, held), { residence: 'OFF_DISK', state: 'PARKED' }), false],
      ['an OFF_DISK CONFLICTED K4 record', record({ s1: { [P]: a }, s2: { [P]: held }, s3: { [P]: a } }, { residence: 'OFF_DISK', state: 'CONFLICTED', guards: ['conflict'] }), false],
      ['an INCOMING lock record', record(pair(a, held), { kind: 'INCOMING', guards: ['lock'] }), false],
      ['an OFF_DISK claim-breach record', record(pair(a, held), { residence: 'OFF_DISK', state: 'CONFLICTED', guards: ['claim-breach'] }), true],
    ];
    for (const [what, r, masks] of cases) {
      const out = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
      assert.equal(out.entries.get(P)!.oid, masks ? a : X.get(P)!.oid, what);
      assert.equal(out.withheld.has(P), masks, what);
      assert.deepEqual(out.conflicted, [], what);
    }
  });
});

test('an ON_DISK local_only record withholds its whole path; an OFF_DISK one masks nothing', T10, async () => {
  await withMaskRepo('mask-localonly', async (c) => {
    const env = '.env';
    const a = await c.blob('KEY=1\nOTHER=2\n');
    const d = await c.blob('KEY=1\nOTHER=3\n');
    const A = tmap({ [env]: a });
    const X = tmap({ [env]: d });
    const onDisk = record(pair(a, d, env), { paths: [env], guards: ['revert'], local_only: true });
    const out = await maskEntries(c.repo, X, inputs(A, [onDisk]), new RebaseCache(c.repo, () => true));
    assert.equal(out.entries.get(env)!.oid, a);
    assert.ok(out.withheld.has(env));
    assert.equal(maskReason(env, inputs(A, [onDisk])), 'local_only');
    const companion = record(pair(a, d, env), { paths: [env], residence: 'OFF_DISK', state: 'PARKED', guards: [], local_only: true });
    const take = record(pair(ABSENT, d, env), { paths: [env], residence: 'OFF_DISK', state: 'PARKED', guards: [] });
    for (const r of [companion, take]) {
      const o = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
      assert.equal(o.entries.get(env)!.oid, d);
      assert.equal(o.withheld.has(env), false);
    }
  });
});

test('binary and filtered PATCH paths are withheld whole and never merged', T10, async () => {
  await withMaskRepo('mask-binary', async (c) => {
    const png = 'img/logo.png';
    const cfg = 'secret.cfg';
    const head = (await c.repo.resolve('HEAD'))!;
    const attrs = await new AttrCache(c.repo, realFs).snapshot(head, [png, cfg]);
    assert.equal(attrs.get(cfg).filter, 'crypt', 'filter=crypt at EPOCH_BASE');
    // The engine's mergeable(p): text and unfiltered at EPOCH_BASE (core.ts's pathIsText && !pathIsFiltered).
    const mergeable = (p: string): boolean => {
      const at = attrs.get(p);
      return at.filter === null && !at.binary && at.text !== 'unset' && at.merge !== 'binary';
    };
    const [b0, b1, b2] = [await c.blob(binary(0)), await c.blob(binary(1)), await c.blob(binary(2))];
    const [s0, s1, s2] = [await c.blob('password = one\n'), await c.blob('password = two\n'), await c.blob('password = one\nuser = me\n')];
    const A = tmap({ [png]: b0, [cfg]: s0 });
    const X = tmap({ [png]: b2, [cfg]: s2 });
    const rp = record(pair(b0, b1, png), { paths: [png] });
    const rc = record(pair(s0, s1, cfg), { paths: [cfg] });
    const inp = { ...inputs(A, [rp, rc]), mergeable };
    const before = c.calls.length;
    const out = await maskEntries(c.repo, X, inp, new RebaseCache(c.repo, mergeable));
    for (const p of [png, cfg]) {
      assert.equal(out.entries.get(p)!.oid, A.get(p)!.oid, p);
      assert.ok(out.withheld.has(p), p);
      assert.equal(maskReason(p, inp), 'patch', p);
    }
    assert.deepEqual(out.conflicted, []);
    const named = new Set<string>([b0, b1, b2, s0, s1, s2]);
    assert.ok(!mergeCalls(c.calls.slice(before)).some((m) => m.args.some((x) => named.has(x))), 'no merge-file names their oids');
  }, { files: CLASS_FILES });
});

test('an ABSENT side in step 5 follows the whole-path rule', T10, async () => {
  await withMaskRepo('mask-absent', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const del = record(pair(a, ABSENT));
    const before = c.calls.length;
    // A held deletion with X lacking p: the deletion is withheld.
    const gone = await maskEntries(c.repo, tmap({}), inputs(A, [del]), new RebaseCache(c.repo, () => true));
    assert.equal(gone.entries.get(P)?.oid, a);
    assert.deepEqual(gone.conflicted, []);
    // A held deletion with new bytes at p: a conflict.
    const fresh = await maskEntries(c.repo, tmap({ [P]: await c.blob(t9([6, 'six'])) }), inputs(A, [del]), new RebaseCache(c.repo, () => true));
    assert.equal(fresh.entries.get(P)?.oid, a);
    assert.ok(fresh.withheld.has(P));
    assert.deepEqual(fresh.conflicted, [del.id]);
    // A held creation (h0 ABSENT) with X[p] = h1 and A lacking p: p is absent.
    const n = await c.blob('created here\n');
    const create = record(pair(ABSENT, n));
    const made = await maskEntries(c.repo, tmap({ [P]: n }), inputs(tmap({}), [create]), new RebaseCache(c.repo, () => true));
    assert.equal(made.entries.has(P), false);
    assert.deepEqual(made.conflicted, []);
    assert.equal(mergeCalls(c.calls.slice(before)).length, 0, 'no merge-file runs with an ABSENT side');
  });
});

/** merge-file's conflict counts (exit 0…127): the okCodes of a test-side re-run. */
const MERGE_OK = Array.from({ length: 128 }, (_, i) => i);

test('maskEntries writes no registry state and only route-(c) step-5 outputs', T10, async () => {
  await withMaskRepo('mask-objects', async (c) => {
    // CRLF rows on a core.autocrlf=true clone: a filtered route (hash-object --path, git add) would store these bytes with LF
    // endings, so the checks below tell route (c) from it.
    assert.equal(await c.repo.configGet('core.autocrlf'), 'true', 'a core.autocrlf=true clone');
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
    const a = await c.blob(crlf(T9));
    const A = tmap({ [P]: a });
    const reg = await registryOf(c, () => A);
    await reg.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], blobs: pair(a, await c.blob(crlf(t9([2, 'two'])))), guard: 'revert',
      origin: 'human', cs_ids: [], displaced_by: null,
    });
    await reg.hold({
      kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [P], blobs: pair(a, await c.blob(crlf(t9([8, 'eight'])))), guard: 'revert',
      origin: 'human', cs_ids: [], displaced_by: null,
    });
    const head = reg.head();
    const xs = [
      t9([2, 'two'], [5, 'five'], [8, 'eight']), t9([2, 'two'], [3, 'three']), t9([5, 'FIVE']), T9, t9([2, 'two'], [8, 'eight']),
    ].map(crlf);
    let total = 0;
    for (const x of xs) {
      const X = tmap({ [P]: await c.blob(x) });
      const before = looseObjects(c.f);
      const callsBefore = c.calls.length;
      await maskEntries(c.repo, X, inputs(A, reg.maskingRecords()), new RebaseCache(c.repo, () => true));
      const during = c.calls.slice(callsBefore);
      assert.equal(reg.head(), head, 'the registry head never moves');
      // Every object MASK writes is route (c): hash-object -w --stdin --no-filters, never --path (no filter, no working file).
      for (const h of during.filter((k) => k.args[0] === 'hash-object')) {
        assert.ok(h.args.includes('--stdin') && h.args.includes('--no-filters') && !h.args.some((v) => v.startsWith('--path')), h.args.join(' '));
      }
      assert.ok(!during.some((k) => ['update-ref', 'commit-tree', 'mktree', 'update-index'].includes(k.args[0]!)), 'no registry write');
      // Each created object is the stdout of one of the call's own merge-file runs, as merge-file printed it (re-run test-side and
      // hashed without filters), CRLF rows kept: the bytes a filtered route would store differ (another oid).
      const outputs = new Set<string>();
      for (const m of during.filter((k) => k.args[0] === 'merge-file')) {
        // Ruling G1-FILEFORM: the executed call ran over scratch files the runner removed after it. Recreate the three side
        // files from the stored blobs the argv names (the same bytes git merged, by the oid labels), so the replay re-runs
        // the same file-form merge deterministically.
        const dir = dirname(m.args.at(-1)!);
        await realFs.rmrf(dir).catch(() => {});
        await realFs.mkdirp(dir, 0o700);
        for (const [k, o] of mergeSides(m.args).entries()) {
          await realFs.writeFileExclusive(join(dir, `${k}.${o}`), await c.repo.readBlob(o as Oid));
        }
        const r = await c.repo.run(m.args, { okCodes: MERGE_OK });
        if (r.code === 0) outputs.add(await c.repo.hashBytes(r.stdout, false));
      }
      const created = [...looseObjects(c.f)].filter((o) => !before.has(o));
      for (const o of created) {
        assert.equal((await c.repo.run(['cat-file', '-t', o])).stdout.toString('utf8').trim(), 'blob', o);
        assert.ok(outputs.has(o), `${o} is a merge-file output of the call, hashed by route (c)`);
        const bytes = await c.repo.readBlob(o as Oid);
        assert.ok(bytes.includes('\r\n'), `${o} keeps its CRLF rows`);
        const filtered = (await c.repo.run(['hash-object', '--stdin', `--path=${P}`], { stdin: bytes })).stdout.toString('utf8').trim();
        assert.notEqual(filtered, o, 'a filtered route would have stored other bytes');
      }
      total += created.length;
    }
    assert.ok(total >= 2, `the cases write step-5 outputs (${total})`);
  }, { autocrlf: true });
});

test('every MASK merge is merge-file -p --object-id with an explicit A-based base', T10, async () => {
  await withMaskRepo('mask-argv', async (c) => {
    const a = await c.blob(T9);
    const A = tmap({ [P]: a });
    const r1 = record(pair(a, await c.blob(t9([2, 'two']))), { id: ulidOf(1) });
    const r2 = record(pair(a, await c.blob(t9([8, 'eight']))), { id: ulidOf(2) });
    const cache = new RebaseCache(c.repo, () => true);
    await cache.rebase(r1, A);
    await cache.rebase(r2, A);
    const before = c.calls.length;
    for (const x of [t9([2, 'two'], [5, 'five'], [8, 'eight']), t9([2, 'two'], [3, 'three']), t9([6, 'six'])]) {
      await maskEntries(c.repo, tmap({ [P]: await c.blob(x) }), inputs(A, [r1, r2]), cache);
    }
    const merges = mergeCalls(c.calls.slice(before));
    assert.ok(merges.length >= 3);
    const base = { hooksPath: process.platform === 'win32' ? 'C:\\hooks' : '/hooks', platform: process.platform, daemonEnv: {}, testBuild: true };
    for (const m of merges) {
      // Ruling G1-FILEFORM: the executed form is merge-file -p over the three objects' stored bytes, each labelled with its oid.
      assert.deepEqual(m.args.slice(0, 2), ['merge-file', '-p']);
      assert.equal(m.args.length, 11, '-p, three -L labels and three side files, nothing else');
      const sides = mergeSides(m.args);
      assert.deepEqual(mergeLabels(m.args), sides, 'each side labelled with its oid (the labels of the --object-id form)');
      assert.equal(sides[2], a, 'the explicit base of the reverse merge: H0\'[p] = A[p]');
      for (const bad of ['--ours', '--union', '--theirs']) assert.ok(!m.args.includes(bad), bad);
      assert.ok(!m.args.some((x) => x.startsWith('-X')));
      const argv = buildGitInvocation(m.args, m.opts, base).argv;
      const at = argv.indexOf(MERGE_FLAGS[0]!);
      assert.ok(argv.join('\u0000').includes(MERGE_FLAGS.join('\u0000')), 'the MERGE_FLAGS -c pairs');
      assert.ok(at >= 0);
    }
  });
});

test('MASK\'s base is A[p], never tree(LA_C)[p]', T10, async () => {
  await withMaskRepo('mask-base', async (c) => {
    const a = await c.blob(T9);
    const r = record(pair(a, await c.blob(t9([2, 'two']))));
    const A = tmap({ [P]: a });
    const laC = tmap({ [P]: await c.blob(t9([3, 'three'])) });   // TIP's version, not yet applied
    const X = tmap({ [P]: await c.blob(t9([2, 'two'])) });
    const out = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    assert.equal(out.entries.get(P)!.oid, a, 'T9');
    assert.deepEqual(out.conflicted, []);
    // A test-local MASK fed tree(LA_C): it reports r conflicted and outputs a team version this peer never applied.
    const wrong: MaskResult = await maskEntries(c.repo, X, inputs(laC, [r]), new RebaseCache(c.repo, () => true));
    assert.deepEqual(wrong.conflicted, [r.id]);
    assert.equal(await c.text(wrong.entries.get(P)?.oid), t9([3, 'three']));
  });
});

test('maskReason stays synchronous and names the first step', T10, async () => {
  await withMaskRepo('mask-reason', async (c) => {
    const a = await c.blob(T9);
    const h = await c.blob(t9([2, 'two']));
    const r = (paths: string[], o: Parameters<typeof record>[1] = {}): HoldRecord => record({ h0: Object.fromEntries(paths.map((p) => [p, a])), h1: Object.fromEntries(paths.map((p) => [p, h])) }, { paths, ...o });
    const records = [
      r(['lo.txt'], { local_only: true, guards: ['secret-scan'] }),
      r(['eol.txt'], { guards: ['eol-bom'] }),
      r(['pin.txt'], { kind: 'PIN', guards: ['join'] }),
      r(['k4.txt'], { state: 'CONFLICTED', guards: ['conflict'] }),
      r(['p5.txt', 'img.png']),
    ];
    const inp = inputs(tmap({}), records, { scope: { 'q.json': 'QUARANTINED' }, mergeable: (p) => p !== 'img.png' });
    const res = maskReason('p5.txt', inp);
    assert.equal(typeof res, 'string', 'not a Promise');
    const want: Record<string, string | null> = {
      'q.json': 'path_class', 'lo.txt': 'local_only', 'eol.txt': 'whole_path_guard', 'pin.txt': 'pin', 'k4.txt': 'conflicted',
      'p5.txt': 'patch', 'img.png': 'patch', 'free.txt': null,
    };
    for (const [p, w] of Object.entries(want)) assert.equal(maskReason(p, inp), w, p);
  });
});

test('a merge-file error in step 5 throws HoldOperatorError', T10, async () => {
  await withMaskRepo('mask-operator-error', async (c) => {
    const a = await c.blob(T9);
    const h1 = await c.blob(t9([2, 'only in this test: corrupt me']));
    const x = await c.blob(t9([2, 'only in this test: corrupt me'], [6, 'six']));
    const r = record(pair(a, h1));
    const A = tmap({ [P]: a });
    const dir = join(c.f.paths.gitDir, 'objects', h1.slice(0, 2));
    assert.ok(readdirSync(dir).includes(h1.slice(2)), 'the object is loose');
    const file = join(dir, h1.slice(2));
    // The plant: h1's loose object is corrupted at the moment step 5's own reverse merge mf(X[p], H1'[p], H0'[p]) reads its sides —
    // after the binary sniff and REBASE have read every side. Ruling G1-FILEFORM: merge-file runs over scratch copies of the sides,
    // which runMergeFile reads with one cat-file --batch of the unique sides in order (x, h1, a), so that read is where git fails on the
    // corrupt object (a real git process, never a mocked exit code), and the merge is an error (rc -1), never a conflict.
    const merges: Array<{ args: string[]; code: number }> = [];
    const sideRead = `${x}\n${h1}\n${a}\n`;
    let planted = 0;
    const plantedRepo = new GitRepo({
      run: async (args, opts) => {
        if (args[0] === 'cat-file' && args[1] === '--batch' && args.length === 2 && opts.stdin?.toString('utf8') === sideRead) {
          planted++;
          chmodSync(file, 0o644);
          writeFileSync(file, Buffer.from('this is not a zlib stream', 'utf8'));
        }
        const res = await c.f.runner.run(args, opts);
        if (args[0] === 'merge-file') merges.push({ args: [...args], code: res.code });
        return res;
      },
    }, c.f.paths, fixtureContext);
    let escaped: Map<string, TreeEntry> | null = null;
    const err = await maskEntries(plantedRepo, tmap({ [P]: x }), inputs(A, [r]), new RebaseCache(plantedRepo, () => true))
      .then((m) => {
        escaped = m.entries;
        return null;
      }, (e: unknown) => e);
    assert.ok(err instanceof HoldOperatorError, `got ${String(err)}`);
    assert.equal(err.op, 'mask');
    assert.equal(err.path, P);
    assert.equal(err.holdId, r.id);
    assert.match(err.message, /merge-file ended abnormally, its stderr names an error, or its exit is not a conflict count/, 'the error of step 5\'s merge-file call, not a read before it');
    assert.equal(planted, 1, 'the failing read is step 5\'s reverse merge reading its sides');
    assert.ok(merges.every((m) => mergeSides(m.args).join(' ') !== `${x} ${h1} ${a}`), 'no merge-file ran over the unreadable side');
    assert.equal(escaped, null, 'no entry map escapes');
  });
});

test('step 5 keeps X\'s mode when its output equals A\'s bytes', T10, async () => {
  await withMaskRepo('mask-mode', async (c) => {
    const a = await c.blob(T9);
    const r = record(pair(a, await c.blob(t9([2, 'two']))));
    const A = tmap({ [P]: a });   // mode 100644
    // X: the held change and a mode change (chmod +x); the mode change is not held, so it stays in MASK's output.
    const X: TreeMap = new Map([[P, { path: P, mode: '100755', oid: await c.blob(t9([2, 'two'])) }]]);
    const out = await maskEntries(c.repo, X, inputs(A, [r]), new RebaseCache(c.repo, () => true));
    assert.deepEqual(out.entries.get(P), { path: P, mode: '100755', oid: a });
    assert.deepEqual([...out.partial], [P]);
  });
});

