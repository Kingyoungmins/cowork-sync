import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { HoldRegistry, RegistryCasLostError, type NewRecord, type RegistryDeps } from '../../src/holds/registry.js';
import { parseRecord, type HoldRecord } from '../../src/holds/record.js';
import { RELEASE_NAMESPACE, refNames } from '../../src/engine/refs.js';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import type { Log, LogLevel, LogParam } from '../../src/ports/log.js';
import { seededRandom } from '../../src/ports/random.js';
import type { Trace, TraceEvent } from '../../src/ports/trace.js';
import { validId } from '../../src/sec/validators.js';
import { makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { SIM_WALL_EPOCH_MS, VirtualClock } from '../sim/vclock.js';

const PEER = '0123456789abcdef0123456789abcdef';
const OP = `${PEER}/fedcba9876543210fedcba9876543210/9`;
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

interface Ctx {
  f: RepoFixture;
  ref: string;
  clock: VirtualClock;
  events: TraceEvent[];
  logs: Array<{ level: LogLevel; code: string; params: Readonly<Record<string, LogParam>> }>;
  deps(seed?: string): RegistryDeps;
  blob(text: string): Promise<Oid>;
}

function setup(f: RepoFixture): Ctx {
  const ref = refNames('main', RELEASE_NAMESPACE).holds;
  const clock = new VirtualClock();
  const events: TraceEvent[] = [];
  const logs: Ctx['logs'] = [];
  const trace: Trace = { emit: (ev) => events.push(ev) };
  const log: Log = { write: (level, code, params) => logs.push({ level, code, params: params ?? {} }) };
  return {
    f, ref, clock, events, logs,
    deps: (seed = 'registry') => ({ repo: f.repo, ref, random: seededRandom(seed), clock, peer: PEER, trace, log }),
    blob: (text) => f.repo.hashBytes(Buffer.from(text, 'utf8'), true),
  };
}

async function eolBom(c: Ctx, path = 'settings.ini', local = 'key=1\r\n'): Promise<NewRecord> {
  return {
    kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', paths: [path],
    blobs: { h0: { [path]: await c.blob('key=0\n') }, h1: { [path]: await c.blob(local) } },
    guard: 'eol-bom', origin: 'human', cs_ids: [], displaced_by: null, local_only: false,
  };
}

async function k4(c: Ctx, local: string, tip: string, base = 'line\n'): Promise<NewRecord> {
  return {
    kind: 'PATCH', residence: 'ON_DISK', state: 'CONFLICTED', paths: ['src/a.txt', 'src/gone.txt'],
    blobs: {
      s1: { 'src/a.txt': await c.blob(base), 'src/gone.txt': await c.blob('gone base\n') },
      s2: { 'src/a.txt': await c.blob(local), 'src/gone.txt': ABSENT },
      s3: { 'src/a.txt': await c.blob(tip), 'src/gone.txt': await c.blob('gone tip\n') },
    },
    guard: 'conflict', origin: 'human', cs_ids: [`${PEER}/human/3`], displaced_by: OP, local_only: false,
  };
}

/** One level of a tree: name → "<mode> <type> <oid>". */
async function ls(f: RepoFixture, tree: string): Promise<Map<string, string>> {
  const r = await f.repo.run(['ls-tree', '-z', tree]);
  const out = new Map<string, string>();
  for (const rec of r.stdout.toString('utf8').split(NUL)) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf(TAB);
    out.set(rec.slice(tab + 1), rec.slice(0, tab));
  }
  return out;
}

async function reflog(f: RepoFixture, ref: string): Promise<string[]> {
  const r = await f.repo.run(['reflog', 'show', '--format=%H %gs', ref]);
  return r.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
}

/** Every non-ABSENT oid of every blob map of the records. */
function referenced(records: readonly HoldRecord[]): string[] {
  const s = new Set<string>();
  for (const r of records) for (const m of Object.values(r.blobs)) for (const o of Object.values(m as Record<string, string>)) if (o !== ABSENT) s.add(o);
  return [...s].sort();
}

test('hold() writes one commit with records/<id>.json and blobs/<oid>, CAS with a reflog, and hits crashpoint registry.cas before and after the CAS', async () => {
  const f = await makeRepoFixture('registry-hold');
  const hits: string[] = [];
  let killAt = 0;
  setCrashHandler((name) => {
    hits.push(name);
    if (killAt === hits.length) throw new KilledAt(name);
  });
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    assert.deepEqual(reg.all(), [], 'an absent ref is an empty registry');
    assert.equal(await f.repo.readRef(c.ref), null);

    const n1 = await eolBom(c);
    const id1 = await reg.hold(n1);
    assert.ok(validId('ulid', id1), 'the id is a ULID');
    assert.deepEqual(hits, ['registry.cas', 'registry.cas'], 'one crashpoint before and one after the CAS');
    const c1 = (await f.repo.readRef(c.ref))!;
    const info1 = await f.repo.readCommit(c1);
    assert.deepEqual(info1.parents, [], 'the first registry commit has no parent');
    assert.equal(info1.subject, 'cowork-holds');
    assert.deepEqual([...(await ls(f, info1.tree)).entries()].map(([n, m]) => `${m.split(' ')[1]} ${n}`).sort(), ['tree blobs', 'tree records']);
    const recs = await ls(f, `${c1}:records`);
    assert.deepEqual([...recs.keys()], [`${id1}.json`]);
    const r1 = parseRecord(await f.repo.readBlob((await f.repo.resolve(`${c1}:records/${id1}.json`))!));
    assert.deepEqual(r1, {
      id: id1, rev: 1, owner: PEER, kind: 'PATCH', residence: 'ON_DISK', state: 'ACTIVE', offer: 'none', declines: 0, displaced_by: null,
      paths: ['settings.ini'], blobs: n1.blobs, guards: [{ name: 'eol-bom', class: 'PREDICATE', owner: 'DAT' }], origin: 'human',
      cs_ids: [], peer_authors: [], local_only: false, age_anchor: { since_rev: 1, anchor_wall_ms: c.clock.wallMs(), mono_accum_ms: 0 }, proto: 1,
    });
    assert.deepEqual(reg.get(id1), r1);
    const blobs1 = await ls(f, `${c1}:blobs`);
    assert.deepEqual([...blobs1.keys()].sort(), referenced([r1]));
    for (const [o, meta] of blobs1) assert.equal(meta, `100644 blob ${o}`, 'blobs/<oid> names the blob itself');
    assert.deepEqual(await reflog(f, c.ref), [`${c1} cowork-holds`], 'the CAS created a reflog');
    assert.deepEqual(c.events.at(-1), { kind: 'hold', peer: PEER, id: id1, holdKind: 'PATCH', guard: 'eol-bom', paths: ['settings.ini'], residence: 'ON_DISK' });

    // A second record: a stage record with an ABSENT side; the tree holds both records and the union of their blobs.
    const id2 = await reg.hold(await k4(c, 'local\n', 'tip\n'));
    const c2 = (await f.repo.readRef(c.ref))!;
    assert.deepEqual((await f.repo.readCommit(c2)).parents, [c1], 'each commit\'s first parent is the previous registry commit');
    assert.deepEqual([...(await ls(f, `${c2}:records`)).keys()].sort(), [`${id1}.json`, `${id2}.json`].sort());
    assert.deepEqual([...(await ls(f, `${c2}:blobs`)).keys()].sort(), referenced(reg.all()));
    assert.equal(referenced(reg.all()).length, 7, 'ABSENT has no blobs/ entry');
    assert.deepEqual(await reflog(f, c.ref), [`${c2} cowork-holds`, `${c1} cowork-holds`]);
    assert.equal(hits.length, 4);

    // Killed immediately before the CAS: the ref has not moved.
    killAt = hits.length + 1;
    await assert.rejects(reg.hold(await eolBom(c, 'b.ini')), KilledAt);
    assert.equal(await f.repo.readRef(c.ref), c2, 'a kill before the CAS leaves the ref');
    // Killed immediately after the CAS: the ref has moved and a re-attached registry sees the record.
    const n4 = await eolBom(c, 'c.ini');
    killAt = hits.length + 2;
    await assert.rejects(reg.hold(n4), KilledAt);
    const c3 = (await f.repo.readRef(c.ref))!;
    assert.notEqual(c3, c2, 'a kill after the CAS finds the ref moved');
    const again = new HoldRegistry(c.deps('fourth'));
    await again.load();
    assert.deepEqual(again.all().map((r) => r.paths[0]).sort(), ['c.ini', 'settings.ini', 'src/a.txt']);
    assert.equal(hits.filter((h) => h !== 'registry.cas').length, 0, 'no other crashpoint');
  } finally {
    setCrashHandler(null);
    await f.cleanup();
  }
});

test('hold() with the same kind, guard, paths and held side returns the existing id', async () => {
  const f = await makeRepoFixture('registry-dedupe');
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    const id = await reg.hold(await eolBom(c));
    const head = await f.repo.readRef(c.ref);
    assert.equal(await reg.hold(await eolBom(c)), id, 'same kind, guard, paths and h1');
    assert.equal(await f.repo.readRef(c.ref), head, 'a dedupe writes nothing');
    assert.equal(await reg.hold({ ...(await eolBom(c)), blobs: { h0: { 'settings.ini': await c.blob('other base\n') }, h1: { 'settings.ini': await c.blob('key=1\r\n') } } }), id, 'h0 is not part of the key');

    const others = [
      { ...(await eolBom(c, 'settings.ini', 'key=2\r\n')) },                                  // another h1
      { ...(await eolBom(c)), guard: 'restart' as const },                                    // another guard
      { ...(await eolBom(c)), kind: 'PIN' as const, guard: 'join' as const },                 // another kind
    ];
    const ids = new Set<string>([id]);
    for (const n of others) ids.add(await reg.hold(n));
    assert.equal(ids.size, 4, 'kind, guard and h1 are each part of the key');
    // Another path set (the same blob on another path).
    const two = await eolBom(c);
    two.paths = ['a.ini', 'settings.ini'];
    two.blobs = { h0: { 'a.ini': ABSENT, 'settings.ini': (two.blobs as { h0: Record<string, Oid> }).h0['settings.ini']! }, h1: { 'a.ini': ABSENT, 'settings.ini': (two.blobs as { h1: Record<string, Oid> }).h1['settings.ini']! } };
    assert.ok(!ids.has(await reg.hold(two)));

    // R-02: a stage record dedupes on s2 only; the newer call's s1/s3 replace the stored ones in a new rev.
    const k = await reg.hold(await k4(c, 'local\n', 'tip one\n'));
    const before = await f.repo.readRef(c.ref);
    assert.equal(await reg.hold(await k4(c, 'local\n', 'tip two\n', 'line two\n')), k);
    const updated = reg.get(k)!;
    assert.equal(updated.rev, 2);
    const stages = updated.blobs as { s1: Record<string, string>; s2: Record<string, string>; s3: Record<string, string> };
    assert.equal(stages.s1['src/a.txt'], await c.blob('line two\n'));
    assert.equal(stages.s3['src/a.txt'], await c.blob('tip two\n'));
    assert.equal(stages.s2['src/a.txt'], await c.blob('local\n'));
    const after = await f.repo.readRef(c.ref);
    assert.deepEqual((await f.repo.readCommit(after!)).parents, [before!], 'one commit for the stage update');
    assert.equal(await reg.hold(await k4(c, 'local\n', 'tip two\n', 'line two\n')), k);
    assert.equal(await f.repo.readRef(c.ref), after, 'identical stages: nothing written');
    // The dedupe holds after the record moved OFF_DISK (the apply wrote TIP), and a different s2 is a new record.
    await reg.transition(k, { residence: 'OFF_DISK' });
    assert.equal(await reg.hold(await k4(c, 'local\n', 'tip two\n', 'line two\n')), k);
    assert.notEqual(await reg.hold(await k4(c, 'local 2\n', 'tip two\n')), k);

    // A terminal record is never a dedupe target.
    await reg.transition(id, { residence: null, state: 'SUBSUMED' });
    const fresh = await reg.hold(await eolBom(c));
    assert.notEqual(fresh, id);
    assert.equal(reg.get(fresh)!.rev, 1);
  } finally {
    await f.cleanup();
  }
});

test('transition bumps rev and keeps the history on the chain', async () => {
  const f = await makeRepoFixture('registry-transition');
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    const k = await reg.hold(await k4(c, 'local\n', 'tip\n'));
    const e = await reg.hold(await eolBom(c));
    const c0 = (await f.repo.readRef(c.ref))!;
    assert.deepEqual(reg.maskingRecords().map((r) => r.id).sort(), [k, e].sort());

    // (i) the writer's ON_DISK → OFF_DISK move of a CONFLICTED record (R-02, R-03).
    c.clock.advance(4_000);
    const moved = await reg.transition(k, { residence: 'OFF_DISK' });
    assert.equal(moved.rev, 2);
    assert.equal(moved.residence, 'OFF_DISK');
    assert.equal(moved.state, 'CONFLICTED');
    assert.deepEqual(moved.age_anchor, { since_rev: 1, anchor_wall_ms: SIM_WALL_EPOCH_MS, mono_accum_ms: 4_000 }, 'the age anchor re-persists the accumulated Δmono');
    const c1 = (await f.repo.readRef(c.ref))!;
    assert.deepEqual((await f.repo.readCommit(c1)).parents, [c0]);
    // (ii) the eol-bom guard drops when a later snapshot passes canon.
    c.clock.advance(1_000);
    const dropped = await reg.transition(e, { guards: [] });
    assert.equal(dropped.rev, 2);
    assert.deepEqual(dropped.guards, []);
    assert.equal(dropped.age_anchor.mono_accum_ms, 5_000);
    const c2 = (await f.repo.readRef(c.ref))!;
    assert.deepEqual(reg.maskingRecords().map((r) => r.id), [k], 'an ON_DISK record without guards is not a masking record');
    assert.deepEqual(reg.nonTerminal().map((r) => r.id).sort(), [k, e].sort());

    // The history: every rev of k stays on the first-parent chain.
    const chain = await f.repo.firstParents(c2, null, 100);
    assert.equal(chain.length, 4, 'hold k, hold e, two transitions: one commit each');
    assert.deepEqual(chain.slice(0, 3), [c2, c1, c0]);
    const revs: number[] = [];
    for (const commit of chain) {
      const o = await f.repo.resolve(`${commit}:records/${k}.json`);
      if (o !== null) revs.push(parseRecord(await f.repo.readBlob(o)).rev);
    }
    assert.deepEqual(revs, [2, 2, 1, 1]);
    assert.equal(parseRecord(await f.repo.readBlob((await f.repo.resolve(`${c0}:records/${k}.json`))!)).residence, 'ON_DISK');

    // An invalid transition (OFF_DISK ACTIVE, Table 1) writes nothing and changes nothing.
    await assert.rejects(reg.transition(k, { state: 'ACTIVE' }), TypeError);
    // A blob that is not in the object store is refused before any commit.
    await assert.rejects(reg.transition(e, { blobs: { h0: { 'settings.ini': 'f'.repeat(40) as Oid }, h1: { 'settings.ini': 'e'.repeat(40) as Oid } } }));
    await assert.rejects(reg.transition('01J9ZQ3V5W6X7Y8Z9A0B1C2D3E', { guards: [] }), /unknown/);
    assert.equal(await f.repo.readRef(c.ref), c2);
    assert.equal(reg.get(k)!.rev, 2);
    // A terminal record does not transition again.
    await reg.transition(e, { residence: null, state: 'GONE' });
    await assert.rejects(reg.transition(e, { guards: [] }), /terminal/);
    assert.deepEqual(reg.nonTerminal().map((r) => r.id), [k]);
    assert.equal(reg.all().length, 2);
  } finally {
    await f.cleanup();
  }
});


test('load() re-attaches; a second writer throws RegistryCasLostError', async () => {
  const f = await makeRepoFixture('registry-cas');
  try {
    const c = setup(f);
    const one = new HoldRegistry(c.deps('one'));
    await assert.rejects(one.hold(await eolBom(c)), /load/, 'hold() before load() refuses');
    await one.load();
    const id = await one.hold(await eolBom(c));
    await one.transition(id, { guards: [] });

    const two = new HoldRegistry(c.deps('two'));
    await two.load();
    assert.deepEqual(two.all(), one.all(), 're-attached: the same records at the same revs');
    assert.deepEqual(two.get(id), one.get(id));

    const won = await two.hold(await k4(c, 'local\n', 'tip\n'));
    const head = await f.repo.readRef(c.ref);
    const logged = c.logs.length;
    await assert.rejects(one.hold(await eolBom(c, 'x.ini')), RegistryCasLostError);
    await assert.rejects(one.transition(id, { state: 'ACTIVE', guards: [{ name: 'restart', class: 'DECISION', owner: 'ENG' }] }), RegistryCasLostError);
    assert.equal(await f.repo.readRef(c.ref), head, 'the loser moves nothing');
    assert.equal(one.all().length, 1, 'the loser\'s memory is unchanged');
    assert.equal(one.get(id)!.rev, 2);
    const security = c.logs.slice(logged);
    assert.equal(security.length, 2);
    for (const l of security) {
      assert.equal(l.level, 'security');
      assert.match(l.code, /^[A-Z][A-Z0-9_]{2,47}$/);
      assert.equal(l.params['ref'], c.ref);
    }
    assert.ok(new RegistryCasLostError('x') instanceof Error);

    // Re-attaching picks up the other writer's records and the next write lands.
    await one.load();
    assert.deepEqual(one.get(won), two.get(won));
    await one.hold(await eolBom(c, 'y.ini'));
    assert.equal(one.all().length, 3);
  } finally {
    await f.cleanup();
  }
});

test('the registry stores validated copies and hands out frozen records: a caller mutating its objects later changes nothing', async () => {
  const f = await makeRepoFixture('registry-copies');
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    type H = { h0: Record<string, Oid>; h1: Record<string, Oid> };
    type S = { s1: Record<string, Oid>; s2: Record<string, Oid>; s3: Record<string, Oid> };
    const n1 = await eolBom(c);
    const h1Before = (n1.blobs as H).h1['settings.ini']!;
    const id1 = await reg.hold(n1);
    // The caller reuses its objects after hold(): every oid below is a real blob, so only the registry's own check can notice.
    (n1.blobs as H).h1['settings.ini'] = await c.blob('mutated by the caller\n');
    (n1.blobs as H).h0['settings.ini'] = await c.blob('mutated base\n');
    n1.cs_ids.push(`${PEER}/human/9`);
    n1.paths.push('other.ini');
    // ... and after transition(): the patch's blob maps are mutated too.
    const k = await reg.hold(await k4(c, 'local\n', 'tip\n'));
    const patch = { blobs: (await k4(c, 'local\n', 'tip 2\n', 'line 2\n')).blobs };
    const moved = await reg.transition(k, patch);
    (patch.blobs as S).s2['src/a.txt'] = await c.blob('mutated local\n');
    // The next write builds its tree from memory; a fresh load() must still re-attach (HLD-01) and see the stored state.
    await reg.hold(await eolBom(c, 'b.ini'));
    const fresh = new HoldRegistry(c.deps('fresh'));
    await fresh.load();
    assert.deepEqual(fresh.all(), reg.all());
    assert.equal((reg.get(id1)!.blobs as H).h1['settings.ini'], h1Before, 'the stored record keeps the bytes it was written with');
    assert.deepEqual(reg.get(id1)!.cs_ids, []);
    assert.deepEqual(reg.get(id1)!.paths, ['settings.ini']);
    assert.equal((reg.get(k)!.blobs as S).s2['src/a.txt'], await c.blob('local\n'));
    assert.deepEqual(moved, reg.get(k));

    // Every record handed out is deeply frozen: a caller cannot corrupt the registry through it.
    const r = reg.get(id1)!;
    const handed = [r, moved, reg.all()[0]!, reg.nonTerminal()[0]!, reg.maskingRecords()[0]!, fresh.get(id1)!];
    for (const x of handed) {
      for (const o of [x, x.blobs, ...Object.values(x.blobs), x.paths, x.guards, ...x.guards, x.cs_ids, x.peer_authors, x.age_anchor]) {
        assert.ok(Object.isFrozen(o), `${x.id}: ${JSON.stringify(o)} is frozen`);
      }
    }
    assert.throws(() => { (r.paths as string[]).push('x'); }, TypeError);
    assert.throws(() => { (r.blobs as H).h1['settings.ini'] = h1Before; }, TypeError);
    assert.throws(() => { r.rev = 99; }, TypeError);
    assert.equal(reg.get(id1)!.rev, 1);
  } finally {
    await f.cleanup();
  }
});

test('overlapping hold() and transition() calls are serialized: both land and no second writer is reported', async () => {
  const f = await makeRepoFixture('registry-serial');
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    const [na, nb, nk] = [await eolBom(c, 'a.ini'), await eolBom(c, 'b.ini'), await k4(c, 'local\n', 'tip\n')];
    const [a, b, k] = await Promise.all([reg.hold(na), reg.hold(nb), reg.hold(nk)]);
    assert.equal(new Set([a, b, k]).size, 3);
    assert.deepEqual(c.logs, [], 'no security event');
    const head1 = (await f.repo.readRef(c.ref))!;
    assert.equal((await f.repo.firstParents(head1, null, 100)).length, 3, 'one commit per hold on one chain');
    assert.deepEqual([...(await ls(f, `${head1}:records`)).keys()].sort(), [a, b, k].map((id) => `${id}.json`).sort());

    // A transition, a stage-updating hold (which transitions internally) and two identical holds, all overlapping.
    const nk2 = await k4(c, 'local\n', 'tip 2\n', 'line 2\n');
    const nc = await eolBom(c, 'c.ini');
    const [moved, again, c1, c2] = await Promise.all([reg.transition(a, { guards: [] }), reg.hold(nk2), reg.hold(nc), reg.hold(nc)]);
    assert.equal(moved.rev, 2);
    assert.equal(again, k, 'the stage record dedupes');
    assert.equal(reg.get(k)!.rev, 2, 'its stages were updated in a new rev');
    assert.equal(c1, c2, 'the second identical hold sees the first one and dedupes');
    assert.deepEqual(c.logs, []);
    const head2 = (await f.repo.readRef(c.ref))!;
    assert.equal((await f.repo.firstParents(head2, null, 100)).length, 6, 'transition, stage update and one new record');
    const back = new HoldRegistry(c.deps('back'));
    await back.load();
    assert.deepEqual(back.all(), reg.all());
    assert.equal(back.all().length, 4);
  } finally {
    await f.cleanup();
  }
});

test('every referenced blob survives git gc --prune=now', async () => {
  const f = await makeRepoFixture('registry-gc');
  try {
    const c = setup(f);
    const reg = new HoldRegistry(c.deps());
    await reg.load();
    // Every blob below is referenced by the registry and by nothing else.
    await reg.hold(await eolBom(c, 'only/e.ini', 'only eol local\r\n'));
    const k = await reg.hold(await k4(c, 'only local\n', 'only tip 1\n', 'only base 1\n'));
    const firstStages = referenced(reg.all());
    // The stage update replaces s1/s3: the older stage blobs stay reachable through the chain's history.
    await reg.hold(await k4(c, 'only local\n', 'only tip 2\n', 'only base 2\n'));
    await reg.transition(k, { residence: 'OFF_DISK' });
    const late = await c.blob('only late bytes\n');
    await reg.hold({
      kind: 'PATCH', residence: 'OFF_DISK', state: 'PARKED', paths: ['only/late.txt'],
      blobs: { h0: { 'only/late.txt': await c.blob('only late base\n') }, h1: { 'only/late.txt': late } },
      guard: null, origin: 'daemon', cs_ids: [], displaced_by: null, local_only: false,
    });
    const all = [...new Set([...firstStages, ...referenced(reg.all())])].sort();
    assert.ok(all.length >= 10);
    const stray = await c.blob('unreferenced stray\n');

    const gc = spawnSync('git', ['gc', '--prune=now', '--quiet'], { cwd: f.paths.workTree, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(gc.status, 0, gc.stderr);

    const check = await f.repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${[...all, stray].join('\n')}\n`, 'utf8') });
    const lines = check.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, all.length + 1);
    all.forEach((o, i) => assert.match(lines[i]!, new RegExp(`^${o} blob \\d+$`), `${o} survives gc`));
    assert.equal(lines[all.length], `${stray} missing`, 'the unreferenced control object was pruned');

    const back = new HoldRegistry(c.deps('reload'));
    await back.load();
    assert.deepEqual(back.all(), reg.all());
  } finally {
    await f.cleanup();
  }
});
