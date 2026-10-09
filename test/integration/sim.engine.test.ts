// The real engine inside the SIM harness (Plan 2 Task 18; 11-testing §3.3 setup, run steps 1–5 and host emulation,
// §3.5; TST-02, TST-03, TC-TST-01; rulings R-31, R-32, R-SIM-02). Real git against a file:// bare remote; git is never
// mocked. A failed run keeps its temp root and artifacts (okOrFail names them); every assertion runs before anything is
// removed. The long crash-rate run is behind COWORK_SIM_LONG=1 (sim-long.yml), to keep this per-push file in budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KilledAt, setCrashHandler } from '../../src/ports/crashpoint.js';
import { seededRandom } from '../../src/ports/random.js';
import { testRunner } from '../helpers/tmp.js';
import { realEngine } from '../sim/engineAdapter.js';
import { editGenerator, PROFILES, seedFilesPlan2, type GeneratorProfile } from '../sim/generators.js';
import { DEFAULT_QUIESCENCE, runSim, type EngineFactory, type OpGenerator, type Oracle, type SimContext, type SimResult } from '../sim/harness.js';
import { naiveEngine } from '../sim/naiveEngine.js';
import { oracleFF, oracleOID } from '../sim/oracles.js';
import { only, scripted, startAll } from '../sim/scripted.js';

const BOARD = 'refs/cowork/main/board';
/** The quiescence of R-32 with a shorter extra phase, for the tests that are not the R-31 run itself. */
const SHORT_Q = { ...DEFAULT_QUIESCENCE, extraLoops: 2 };

const seedFiles = (seed: string): Record<string, Buffer> => seedFilesPlan2(seededRandom(`${seed}/files`));

/** A failed run keeps its temp root: the message names its artifacts (op-log, trace, remote logs, remote bundle). */
function okOrFail(r: SimResult): void {
  assert.ok(r.ok, `run failed: ${JSON.stringify(r.failure)}; artifacts kept in ${String(r.artifactsDir)}; op-log tail ${JSON.stringify(r.opLog.slice(-8))}`);
}

/** Captures the run's SimContext and computes `at(ctx)` at the end, while the temp root still exists. */
function capture<T>(at: (ctx: SimContext) => Promise<T>): Oracle & { ctx: SimContext | null; value: T | null } {
  const o: Oracle & { ctx: SimContext | null; value: T | null } = {
    name: 'CAPTURE', ctx: null, value: null,
    async atQuiescence(ctx) {
      o.ctx = ctx;
      o.value = await at(ctx);
      return null;
    },
  };
  return o;
}

/** R-32's LA_B == T* for every engine (atQuiescence). */
const laBIsTStar: Oracle = {
  name: 'LA_B',
  async atQuiescence(ctx) {
    const q = ctx.quiescence;
    if (q === null || !q.reached || q.tStar === null) return `no T* (${JSON.stringify(q)})`;
    for (const e of ctx.engines) {
      const ins = await e.inspect!();
      if (ins.laB !== q.tStar) return `${e.peer.name}: LA_B ${ins.laB} != T* ${q.tStar}`;
    }
    return null;
  },
};

/** The op-log entries of one kind: [peer, the detail without its dt= prefix]. */
function ops(r: SimResult, kind: string): Array<{ step: number; peer: string; detail: string }> {
  return r.opLog.filter((e) => e.kind === kind).map((e) => ({ step: e.step, peer: e.peer, detail: e.detail.replace(/^dt=\d+ /, '') }));
}

const peerDir = (ctx: SimContext, name: string): string => ctx.peers.find((p) => p.name === name)!.dir;
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Replaces every run-specific path (remote URL, remote dir, temp root; both slash forms, as raw text and as JSON string content). */
function masker(ctx: SimContext): (text: string) => string {
  const slash = (p: string): string => p.split('\\').join('/');
  const esc = (p: string): string => JSON.stringify(p).slice(1, -1);
  const masks: Array<[string, string]> = [];
  for (const [s, mask] of [[ctx.remote.url, '<remote>'], [ctx.remote.dir, '<remote>'], [slash(ctx.remote.dir), '<remote>'], [ctx.root, '<root>'], [slash(ctx.root), '<root>']] as const) {
    masks.push([esc(s), mask], [s, mask]);
  }
  return (text) => masks.reduce((t, [s, mask]) => t.split(s).join(mask), text);
}

/** `git cat-file --batch` output: each object's content, in input order (a missing object throws). */
function batchObjects(out: Buffer): Buffer[] {
  const objs: Buffer[] = [];
  let at = 0;
  while (at < out.length) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString('utf8');
    const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(header);
    if (m === null) throw new Error(`cat-file --batch: ${header}`);
    const size = Number(m[1]);
    objs.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return objs;
}

/** A tree object's entries: "<mode> <name> <oid hex>" (SHA-1 object names). */
function treeEntries(tree: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let at = 0;
  while (at < tree.length) {
    const sp = tree.indexOf(0x20, at);
    const nul = tree.indexOf(0x00, sp);
    out.push({ mode: tree.subarray(at, sp).toString('utf8'), name: tree.subarray(sp + 1, nul).toString('utf8'), oid: tree.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return out;
}

/**
 * Ruling R-SIM-02: every state commit (the 'state' events' prev/next, local to their peer, never pushed) named by its
 * normalised content: the commit object with its tree line replaced by the state tree's entries, the `meta` entry by
 * the sha256 of meta.json with the remote URL and the temp-root paths masked (meta.pinned.url is the file:// URL), every
 * other entry (base, snap, journal) by its oid. One `cat-file --batch` per peer.
 */
async function stateContents(ctx: SimContext, mask: (text: string) => string): Promise<Map<string, string>> {
  const byPeer = new Map<string, Set<string>>();
  for (const e of ctx.trace.ofKind('state')) {
    const name = ctx.trace.names.get(e.peer);
    assert.ok(name !== undefined, `state event of an unnamed peer ${e.peer}`);
    if (!byPeer.has(name)) byPeer.set(name, new Set());
    for (const oid of [e.prev, e.next]) if (oid !== null) byPeer.get(name)!.add(oid);
  }
  const out = new Map<string, string>();
  const git = testRunner();
  for (const [name, set] of byPeer) {
    const oids = [...set];
    const input = Buffer.from(oids.flatMap((o) => [o, `${o}^{tree}`, `${o}:meta`]).join('\n') + '\n', 'utf8');
    const r = await git.run(['cat-file', '--batch'], { class: 'local', cwd: peerDir(ctx, name), stdin: input });
    assert.equal(r.code, 0, r.stderr.toString('utf8'));
    const objs = batchObjects(r.stdout);
    assert.equal(objs.length, 3 * oids.length);
    oids.forEach((oid, i) => {
      const meta = sha256(mask(objs[3 * i + 2]!.toString('utf8')));
      const entries = treeEntries(objs[3 * i + 1]!).map((e) => `${e.mode} ${e.name} ${e.name === 'meta' ? `masked:${meta}` : e.oid}`);
      const text = objs[3 * i]!.toString('utf8').replace(/^tree [0-9a-f]+\n/, `tree {${entries.join('; ')}}\n`);
      out.set(oid, `state:${sha256(text)}`);
    });
  }
  return out;
}

/** The run's trace events as text, every run-specific path masked and every state commit named by its content (R-SIM-02). */
async function normalisedTrace(ctx: SimContext): Promise<string> {
  const mask = masker(ctx);
  const states = await stateContents(ctx, mask);
  const named = (oid: string | null): string | null => (oid === null ? null : states.get(oid)!);
  const events = ctx.trace.events.map((e) => (e.kind === 'state' ? { ...e, prev: named(e.prev), next: named(e.next) } : e));
  return mask(JSON.stringify(events));
}

/** No engine: the generator's file operations only. */
const idle: EngineFactory = (_ctx, peer) => ({ peer, async step() {} });

test('Plan 1 harness, oracle and NaiveEngine tests pass unchanged without the fourth argument', async () => {
  const t = { seed: 'plan1-compat', peers: 3, ops: 6 };
  const oracles = (): Oracle[] => [oracleFF('refs/cowork/'), oracleOID(['refs/cowork/probe-'])];
  const seen: SimContext[] = [];
  const probe: Oracle = { name: 'probe', async afterEveryOp(ctx) { seen.push(ctx); return null; } };
  // The 3-argument path and a 4-argument call with an empty options object.
  const plain = await runSim(t, naiveEngine(), [...oracles(), probe]);
  const empty = await runSim(t, naiveEngine(), oracles(), {});
  okOrFail(plain);
  okOrFail(empty);
  // Without the 4th argument (or with no option set) the run is the Plan 1 run: same draws, same op-log, same oids.
  assert.deepEqual(empty.opLog, plain.opLog);
  assert.deepEqual(empty.remoteRefs, plain.remoteRefs);
  assert.equal(plain.quiescence, undefined);
  assert.deepEqual(plain.opLog.map((e) => e.kind).filter((k) => k !== 'commit' && k !== 'push'), Array(6).fill('step'));
  const ctx = seen[0]!;
  assert.equal(seen.length, 6);
  assert.deepEqual([ctx.phase, ctx.quiescence, ctx.seed], ['ops', null, 'plan1-compat']);
  assert.deepEqual(ctx.engines.map((e) => e.peer.name), ['p0', 'p1', 'p2']);
  assert.deepEqual(ctx.trace.events, [], 'the NaiveEngine emits no trace');
});

test('the same edits seed twice in different temp roots gives identical op-logs, identical trace events and identical remote ref oids', async () => {
  const run = async (): Promise<{ r: SimResult; ctx: SimContext; trace: string }> => {
    const cap = capture(normalisedTrace);
    const r = await runSim({ seed: 'tc-tst-01', peers: 3, ops: 24 }, realEngine(), [cap], {
      generator: editGenerator(PROFILES.edits), quiescence: SHORT_Q, seedFiles: seedFiles('tc-tst-01'),
    });
    okOrFail(r);
    return { r, ctx: cap.ctx!, trace: cap.value! };
  };
  const a = await run();
  const b = await run();
  assert.notEqual(a.ctx.root, b.ctx.root, 'two temp roots');
  assert.deepEqual(b.r.opLog, a.r.opLog);
  assert.deepEqual(b.r.remoteRefs, a.r.remoteRefs);
  assert.equal(b.trace, a.trace);
  // Not vacuous: edits were made, published and pushed with their argv (normalised, never dropped), and state commits
  // were compared by content (their oids differ between the roots: meta.pinned.url).
  const pushes = a.ctx.trace.ofKind('push').filter((e) => e.outcome === 'landed');
  assert.ok(pushes.some((e) => e.purpose === 'publish'), 'a publish landed');
  assert.ok(pushes.every((e) => e.argv.includes(a.ctx.remote.url)), 'push argv carries the remote URL');
  assert.ok(ops(a.r, 'new_file').length + ops(a.r, 'edit_band').length > 0);
  const stateA = a.ctx.trace.ofKind('state')[0]!.next;
  const stateB = b.ctx.trace.ofKind('state')[0]!.next;
  assert.notEqual(stateA, stateB, 'state oids differ between the temp roots');
  assert.match(a.trace, /"next":"state:[0-9a-f]{64}"/);
  assert.equal(a.r.quiescence?.reached, true);
});

test('a 3-peer edits run of 40 steps reaches quiescence and every engine shows LA_B == T*', async () => {
  const r = await runSim({ seed: 'r31-edits', peers: 3, ops: 40 }, realEngine(), [oracleFF('refs/cowork/'), oracleOID(['refs/cowork/probe-']), laBIsTStar], {
    generator: editGenerator(PROFILES.edits), quiescence: DEFAULT_QUIESCENCE, seedFiles: seedFiles('r31-edits'),
  });
  okOrFail(r);
  const q = r.quiescence!;
  assert.equal(q.reached, true);
  assert.equal(q.tStar, r.remoteRefs[BOARD]);
  assert.equal(q.pushAttemptsInExtra, 0, 'zero pushes in the 40 extra loops');
  assert.equal(q.boardChangedInExtra, false);
  assert.ok(q.rounds >= DEFAULT_QUIESCENCE.k && q.rounds <= DEFAULT_QUIESCENCE.maxRounds);
  assert.equal(r.opLog.filter((e) => e.kind === 'round').length, q.rounds + DEFAULT_QUIESCENCE.extraLoops);
  const starts = ops(r, 'start');
  assert.deepEqual(starts.map((s) => s.peer).sort(), ['p0', 'p1', 'p2'], 'every peer started once');
  assert.deepEqual(starts.filter((s) => s.detail.startsWith('genesis ')).length, 1, 'one genesis, the others join');
});

type Ending = 'crlf' | 'lf';
/** The dominant line ending (CRLF when more rows end in CRLF than in a bare LF). */
function dominant(b: Buffer): Ending {
  const s = b.toString('latin1');
  const crlf = s.split('\r\n').length - 1;
  const lf = s.split('\n').length - 1 - crlf;
  return crlf > lf ? 'crlf' : 'lf';
}

test('written files get the peer\'s virtual wall clock as mtime, and files on autocrlf=true peers keep CRLF endings', async () => {
  const WRITES = ['new_file', 'edit_own', 'edit_band', 'edit_same_line', 'append_md', 'temp_file', 'secret_name'];
  let checked = 0;
  const check: Oracle = {
    name: 'WRITTEN',
    async afterEveryOp(ctx) {
      const e = ctx.opLog[ctx.opLog.length - 1]!;
      if (!WRITES.includes(e.kind)) return null;
      const [, path = '', ...rest] = e.detail.split(' ');
      const peers = rest.find((x) => x.startsWith('peers='))?.slice('peers='.length).split(',') ?? [e.peer];
      for (const name of peers) {
        const peer = ctx.peers.find((p) => p.name === name)!;
        const abs = join(peer.dir, ...path.split('/'));
        const wall = ctx.clocks.get(name)!.wallMs();
        const mtime = (await stat(abs)).mtimeMs;
        if (Math.abs(mtime - wall) >= 1) return `${e.kind} ${name}:${path}: mtime ${mtime} != wall ${wall}`;
        const text = (await readFile(abs)).toString('latin1');
        const bareLf = /(^|[^\r])\n/.test(text);
        const crlf = text.includes('\r\n');
        if (peer.opts.autocrlf && bareLf) return `${e.kind} ${name}:${path}: a bare LF on an autocrlf=true peer`;
        if (!peer.opts.autocrlf && path !== 'crlf.txt' && crlf) return `${e.kind} ${name}:${path}: CRLF on an autocrlf=false peer`;
        checked++;
      }
      return null;
    },
  };
  const profile: GeneratorProfile = { name: 'edits', engineWeight: 0, weights: Object.fromEntries(Object.entries(PROFILES.edits.weights).filter(([k]) => k !== 'eol_rewrite')) };
  const r = await runSim({ seed: 'gen-mtime-eol', peers: 2, ops: 60 }, idle, [check], { generator: editGenerator(profile), seedFiles: seedFiles('gen-mtime-eol') });
  okOrFail(r);
  assert.ok(checked >= 40, `${checked} written files checked`);
  for (const k of WRITES) assert.ok(r.opLog.some((e) => e.kind === k), `${k} ran`);

  // eol_rewrite is the one exception: it writes the file in the other ending (canon must map it back, R-07). The last
  // ending seen per (peer, path): the seed form (crlf.txt and big.py are CRLF-stored, so CRLF on every checkout) or the
  // checkout's ending, then what new_file and each eol_rewrite left on disk.
  const endings = new Map<string, Ending>();
  let flips = 0;
  const flipped: Oracle = {
    name: 'FLIPPED',
    async afterEveryOp(ctx) {
      const e = ctx.opLog[ctx.opLog.length - 1]!;
      if (e.kind !== 'new_file' && e.kind !== 'eol_rewrite') return null;
      const peer = ctx.peers.find((p) => p.name === e.peer)!;
      const path = e.kind === 'new_file' ? e.detail.split(' ')[1]! : /^dt=\d+ (.+) row=\d+ eol=(?:crlf|lf)$/.exec(e.detail)![1]!;
      const key = `${peer.name}:${path}`;
      const now = dominant(await readFile(join(peer.dir, ...path.split('/'))));
      const before = endings.get(key) ?? (path === 'crlf.txt' || path === 'big.py' || peer.opts.autocrlf ? 'crlf' : 'lf');
      endings.set(key, now);
      if (e.kind === 'new_file') return null;
      if (now === before) return `${key}: still ${now} after eol_rewrite`;
      flips++;
      return null;
    },
  };
  const r2 = await runSim({ seed: 'gen-eol-flip', peers: 2, ops: 30 }, idle, [flipped], { generator: only('new_file', 'eol_rewrite'), seedFiles: seedFiles('gen-eol-flip') });
  okOrFail(r2);
  assert.ok(flips >= 3, `${flips} flips checked`);
  assert.ok([...endings.keys()].some((k) => /[^\x00-\x7f]/.test(k)), 'the non-ASCII seed path was rewritten');
});

test('edit_band touches only rows 3–7 of the peer\'s band', async () => {
  const last = new Map<string, string[]>();
  const rowsOf = async (dir: string): Promise<string[]> => (await readFile(join(dir, 'shared.txt'))).toString('utf8').split(/\r?\n/);
  const bands: Oracle = {
    name: 'BAND',
    async afterEveryOp(ctx) {
      const e = ctx.opLog[ctx.opLog.length - 1]!;
      for (const [i, p] of ctx.peers.entries()) {
        const now = await rowsOf(p.dir);
        const before = last.get(p.name);
        last.set(p.name, now);
        if (before === undefined || e.kind !== 'edit_band' || e.peer !== p.name) continue;
        if (now.length !== before.length) return `${p.name}: shared.txt has ${now.length} rows, was ${before.length}`;
        const changed = now.flatMap((row, g) => (row !== before[g] ? [g] : []));
        if (changed.length !== 1) return `${p.name}: edit_band changed rows ${changed.join(',')}`;
        const g = changed[0]!;
        if (Math.floor(g / 10) !== i || g % 10 < 3 || g % 10 > 7) return `${p.name}: edit_band changed row ${g}, outside rows 3–7 of band ${i}`;
      }
      return null;
    },
  };
  const noConflicts: Oracle = {
    name: 'NO-K4',
    async atQuiescence(ctx) {
      for (const e of ctx.engines) {
        const holds = (await e.inspect!()).holds;
        if (holds.length > 0) return `${e.peer.name}: ${holds.length} hold record(s): ${holds.map((h) => h.guards.map(String).join('+')).join(', ')}`;
      }
      return null;
    },
  };
  const profile: GeneratorProfile = { name: 'edits', engineWeight: 1, weights: { edit_band: 1 } };
  const r = await runSim({ seed: 'gen-bands', peers: 3, ops: 24 }, realEngine(), [bands, noConflicts, laBIsTStar], {
    generator: editGenerator(profile), quiescence: SHORT_Q, seedFiles: seedFiles('gen-bands'),
  });
  okOrFail(r);
  const edits = ops(r, 'edit_band');
  assert.ok(new Set(edits.map((e) => e.peer)).size === 3 && edits.length >= 6, `${edits.length} band edits`);
});

/** An atQuiescence check that throws on a failure (the temp root still exists while it runs; a throw keeps it). */
function atEnd(fn: (ctx: SimContext) => Promise<void>): Oracle {
  return { name: 'AT-END', async atQuiescence(ctx) { await fn(ctx); return null; } };
}

const rowOf = async (ctx: SimContext, name: string, path: string, row: number): Promise<string | undefined> =>
  (await readFile(join(peerDir(ctx, name), ...path.split('/')))).toString('utf8').split(/\r?\n/)[row];

test('edit_same_line on two peers before either publishes yields exactly one K4 record, on the later publisher', async () => {
  let checked = false;
  const end = atEnd(async (ctx) => {
    const e = ctx.opLog.find((x) => x.kind === 'edit_same_line')!;
    const [, path, row, who] = e.detail.split(' ');
    const editors = who!.slice('peers='.length).split(',');
    const r = Number(row!.slice('row='.length));
    assert.equal(editors.length, 2);
    assert.equal(path, 'notes.txt');
    // The first of the two editors whose publish landed is the earlier publisher; the record is on the other one.
    const nameOf = (id: string): string => ctx.trace.names.get(id) ?? id;
    const first = ctx.trace.ofKind('push').find((x) => x.purpose === 'publish' && x.outcome === 'landed' && editors.includes(nameOf(x.peer)));
    assert.ok(first !== undefined, 'an editor published');
    const later = editors.find((n) => n !== nameOf(first.peer))!;
    const all = [];
    for (const eng of ctx.engines) for (const h of (await eng.inspect!()).holds) all.push({ peer: eng.peer.name, h });
    assert.equal(all.length, 1, `exactly one record: ${JSON.stringify(all)}`);
    const rec = all[0]!;
    assert.equal(rec.peer, later, 'the record is on the later publisher');
    assert.deepEqual([rec.h.kind, rec.h.state, rec.h.paths], ['PATCH', 'CONFLICTED', ['notes.txt']]);
    assert.ok(JSON.stringify(rec.h.guards).includes('conflict'), JSON.stringify(rec.h.guards));
    // The earlier publisher's row is TIP's row, on every peer's disk.
    const winner = await rowOf(ctx, nameOf(first.peer), 'notes.txt', r);
    assert.ok(winner !== undefined && winner.includes(nameOf(first.peer)), `row ${r}: ${String(winner)}`);
    for (const p of ctx.peers) assert.equal(await rowOf(ctx, p.name, 'notes.txt', r), winner, `${p.name}: TIP's row`);
    checked = true;
  });
  const r = await runSim({ seed: 'gen-same-line', peers: 3, ops: 4 }, realEngine(), [laBIsTStar, end], {
    generator: scripted([...startAll(3), { gen: only('edit_same_line') }]), quiescence: SHORT_Q, seedFiles: seedFiles('gen-same-line'),
  });
  okOrFail(r);
  assert.ok(checked);
});

/** Per peer at the end of a run: SimEngine.pushAttempts(), the running engine's own count, and the traced attempts. */
interface PushCount { peer: string; total: number; current: number; traced: number; killedInClassify: number; }

/**
 * The KilledAt run, shared by the restart test and the pushAttempts test: two peers start and the joiner's board-only
 * first publish lands and is seen (so the last change is a code change: a board-only last change leaves LA_B behind T*,
 * ENG-36); a peer creates a file, and the publish carrying it is killed at publish.sent (after the push, inside its
 * classification). The seed's first kill keeps its daemon.lock (a stale lock for the restart to take over) and drops
 * its queued log tail.
 */
let killedRun: Promise<{ r: SimResult; pushes: PushCount[] }> | null = null;
function runKilled(): Promise<{ r: SimResult; pushes: PushCount[] }> {
  killedRun ??= (async () => {
    /** The crash handler kills the first publish.sent after the script armed it, once. */
    let armed = false;
    let killed: string | null = null;
    const arm: OpGenerator = { next: () => ({ peer: '*', kind: 'arm_kill', run: async () => { armed = true; return 'publish.sent'; } }) };
    const end = atEnd(async (ctx) => {
      const kill = ctx.opLog.find((e) => e.kind === 'killed')!;
      const [point, instance, lock, log] = kill.detail.split(' ');
      assert.equal(point, 'publish.sent');
      assert.equal(kill.peer, ctx.opLog.find((e) => e.kind === 'new_file')!.peer, 'the killed publish carried the new file');
      assert.equal(instance, `sim-${kill.peer}-1`);
      assert.equal(lock, 'lock=kept', 'the killed daemon left its daemon.lock behind');
      assert.match(log!, /^log=dropped:[1-9]\d*$/, 'the killed daemon lost a queued log tail');
      const next = ctx.opLog.find((e) => e.step > kill.step && e.peer === kill.peer && e.kind === 'iterate')!;
      const restart = ctx.opLog.find((e) => e.step > kill.step && e.kind === 'start')!;
      assert.deepEqual([restart.peer, restart.detail, restart.step], [kill.peer, `restart sim-${kill.peer}-2`, next.step], 'the next step of that peer restarts it, as a new daemon');
      // From disk: the same peer id across the restart, the stale daemon.lock taken over, the new file published once.
      assert.equal([...ctx.trace.names.values()].filter((n) => n === kill.peer).length, 1, 'one peer id across the restart');
      const held = JSON.parse(await readFile(join(peerDir(ctx, kill.peer), '.git', 'cowork', 'daemon.lock'), 'utf8')) as { instance: string };
      assert.equal(held.instance, `sim-${kill.peer}-2`, 'daemon.lock taken over by the restarted daemon');
      const file = ctx.opLog.find((e) => e.kind === 'new_file')!.detail.split(' ')[1]!;
      for (const p of ctx.peers) assert.ok(existsSync(join(p.dir, ...file.split('/'))), `${p.name}: ${file} converged`);
      // Exactly one commit on the first-parent chain of the remote's live code (live_code(TIP) = the board tip's
      // second parent) adds the file: a restart that published it twice would add a second introduction.
      const git = testRunner();
      const live = await git.run(['rev-parse', '--verify', `${BOARD}^2`], { class: 'local', cwd: ctx.remote.dir });
      assert.equal(live.code, 0, live.stderr.toString('utf8'));
      const log2 = await git.run(['log', '--first-parent', '--diff-filter=A', '--format=%H', live.stdout.toString('utf8').trim(), '--', file], { class: 'local', cwd: ctx.remote.dir });
      assert.equal(log2.code, 0, log2.stderr.toString('utf8'));
      const introduced = log2.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
      assert.equal(introduced.length, 1, `one live commit introduced ${file}: ${introduced.join(', ')}`);
    });
    const counts = capture(async (ctx): Promise<PushCount[]> => {
      const out: PushCount[] = [];
      for (const e of ctx.engines) {
        const ids = [...ctx.trace.names].filter(([, n]) => n === e.peer.name).map(([id]) => id);
        out.push({
          peer: e.peer.name, total: e.pushAttempts!(), current: (await e.inspect!()).pushAttempts,
          traced: ctx.trace.ofKind('push').filter((p) => ids.includes(p.peer) && p.outcome !== 'denied').length,
          killedInClassify: ctx.opLog.filter((k) => k.kind === 'killed' && k.peer === e.peer.name && k.detail.startsWith('publish.sent ')).length,
        });
      }
      return out;
    });
    setCrashHandler((name) => {
      if (armed && name === 'publish.sent') {
        armed = false;
        killed = name;
        throw new KilledAt(name);
      }
    });
    let r: SimResult;
    try {
      r = await runSim({ seed: 'sim-killed-1', peers: 2, ops: 40 }, realEngine(), [laBIsTStar, end, counts], {
        generator: scripted([
          ...startAll(2), { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },
          { gen: only('new_file') }, { iterate: 0 }, { iterate: 1 }, { wait: 25_000 }, { gen: arm },
          ...Array.from({ length: 28 }, (_, k) => ({ iterate: k % 2 })),
        ]),
        quiescence: SHORT_Q, seedFiles: seedFiles('sim-killed-1'),
      });
    } finally {
      setCrashHandler(null);
    }
    okOrFail(r);
    assert.equal(killed, 'publish.sent');
    return { r, pushes: counts.value! };
  })();
  return killedRun;
}

test('a KilledAt at a crashpoint ends the step and the next step restarts the engine from disk', async () => {
  const { r } = await runKilled();
  assert.equal(ops(r, 'killed').length, 1);
  assert.equal(ops(r, 'start').filter((s) => s.detail.startsWith('restart ')).length, 1);
});

test('SimEngine.pushAttempts() counts every push attempt of the peer, across a restart', async () => {
  const { r, pushes } = await runKilled();
  const killedPeer = ops(r, 'killed')[0]!.peer;
  for (const p of pushes) {
    // governedPush counts an attempt before it pushes; one killed inside its classification is never traced.
    assert.equal(p.total, p.traced + p.killedInClassify, `${p.peer}: ${JSON.stringify(p)}`);
    assert.ok(p.total > 0, `${p.peer} pushed`);
    if (p.peer === killedPeer) {
      assert.equal(p.killedInClassify, 1);
      assert.ok(p.total > p.current, `${p.peer}: the attempts of the killed engine still count (${JSON.stringify(p)})`);
    } else {
      assert.equal(p.total, p.current, `${p.peer}: one engine, its own count`);
    }
  }
});

test('race_push interleaves two engines at publish.beforePush and records a lease_lost push outcome', async () => {
  let checked = false;
  const end = atEnd(async (ctx) => {
    const race = ctx.opLog.find((e) => e.kind === 'race_push')!;
    assert.match(race.detail, /^dt=\d+ p[01]@gate p[01]@gate$/, 'both engines reached publish.beforePush');
    const publishes = ctx.trace.ofKind('push').filter((e) => e.purpose === 'publish');
    assert.deepEqual(publishes.slice(0, 2).map((e) => e.outcome), ['landed', 'lease_lost'], 'the first released lands, the other loses its lease');
    // Both new files converged after the loser re-merged in a later window.
    for (const f of ctx.opLog.filter((e) => e.kind === 'new_file')) {
      const path = f.detail.split(' ')[1]!;
      for (const p of ctx.peers) assert.ok(existsSync(join(p.dir, ...path.split('/'))), `${p.name}: ${path}`);
    }
    checked = true;
  });
  // Both peers see the joiner's board-only publish and then wait out their governor windows, so both have a ready
  // change-set and an open window in the race step.
  const r = await runSim({ seed: 'sim-race', peers: 2, ops: 10 }, realEngine(), [laBIsTStar, end], {
    generator: scripted([
      ...startAll(2),
      { gen: only('new_file') }, { gen: only('new_file') },
      { iterate: 0 }, { iterate: 1 }, { iterate: 0 }, { iterate: 1 }, { wait: 25_000 },
      { gen: only('race_push') },
    ]),
    quiescence: SHORT_Q, seedFiles: seedFiles('sim-race'),
  });
  okOrFail(r);
  assert.ok(checked);
});

test('partition renames the bare remote and heal restores it', async () => {
  const git = testRunner();
  const seen: string[] = [];
  /** The virtual mono after each partition and heal entry. */
  const monoAt = new Map<number, number>();
  const probe: Oracle = {
    name: 'PARTITION',
    async afterEveryOp(ctx) {
      if (ctx.phase !== 'ops') return null;
      const e = ctx.opLog.filter((x) => x.kind !== 'start')[ctx.opLog.filter((x) => x.kind !== 'start').length - 1]!;
      if (e.kind !== 'partition' && e.kind !== 'heal' && e.kind !== 'iterate') return null;
      if (e.kind !== 'iterate') monoAt.set(e.step, ctx.clocks.get('p0')!.monoMs());
      const ls = await git.run(['ls-remote', ctx.remote.url], { class: 'network', cwd: ctx.root });
      const up = (await lstat(ctx.remote.dir).catch(() => null)) !== null;
      seen.push(`${e.kind}:${up ? 'up' : 'down'}:${ls.code === 0 ? 'ok' : 'fail'}`);
      return null;
    },
  };
  let checked = false;
  const end = atEnd(async (ctx) => {
    assert.ok(ctx.trace.ofKind('fetch').some((e) => !e.ok), 'an engine fetch failed during the partition');
    assert.ok(existsSync(ctx.remote.dir), 'the remote is back');
    checked = true;
  });
  // The joiner's board-only first publish (its join op) lands, and is seen, before the partition: a board-only change
  // that is the last one leaves the other peer's LA_B behind T* (LA_B moves only at an apply, ENG-36).
  const r = await runSim({ seed: 'sim-partition', peers: 2, ops: 12 }, realEngine(), [probe, laBIsTStar, end], {
    generator: scripted([
      ...startAll(2), { wait: 10_000 }, { iterate: 1 }, { iterate: 0 },
      { gen: only('partition') }, { gen: only('new_file') }, { iterate: 0 }, { iterate: 1 },
      { gen: only('heal') }, { iterate: 0 },
      // The run ends partitioned: the harness heals before quiescence.
      { gen: only('partition') },
    ]),
    quiescence: SHORT_Q, seedFiles: seedFiles('sim-partition'),
  });
  okOrFail(r);
  assert.deepEqual(seen, [
    'iterate:up:ok', 'iterate:up:ok', 'iterate:up:ok', 'iterate:up:ok',
    'partition:down:fail', 'iterate:down:fail', 'iterate:down:fail', 'heal:up:ok', 'iterate:up:ok', 'partition:down:fail',
  ]);
  // The op-log states every outage as it really was: planned_ms when drawn, for_ms (the virtual time it lasted) at its
  // heal — a heal drawn early and the harness's own heal at the end of the op budget cut it short.
  const [p1, p2] = ops(r, 'partition');
  const [h1, forced] = ops(r, 'heal');
  const planned = (d: string): number => Number(/^remote renamed planned_ms=(\d+)$/.exec(d)![1]);
  assert.deepEqual([p1!.step, h1!.step, p2!.step, forced!.step], [5, 9, 11, 12]);
  assert.equal(h1!.detail, `remote restored for_ms=${monoAt.get(9)! - monoAt.get(5)!} planned_ms=${planned(p1!.detail)}`);
  assert.ok(monoAt.get(9)! - monoAt.get(5)! < planned(p1!.detail), 'healed early');
  // The second partition began in the last step, and the harness heals before quiescence without time passing.
  assert.equal(forced!.peer, '*');
  assert.equal(forced!.detail, `forced for_ms=0 planned_ms=${planned(p2!.detail)}`, 'the harness healed the remote before quiescence');
  assert.equal(r.quiescence?.reached, true);
  assert.ok(checked);
});

test('SimOptions.crash arms a KilledAt at a random peer\'s next crashpoint; the run restarts it and converges', { skip: process.env['COWORK_SIM_LONG'] === '1' ? false : 'long run: set COWORK_SIM_LONG=1 (sim-long.yml runs it)' }, async () => {
  const r = await runSim({ seed: 'sim-crash-rate', peers: 3, ops: 40 }, realEngine(), [laBIsTStar], {
    generator: editGenerator(PROFILES.edits), quiescence: SHORT_Q, seedFiles: seedFiles('sim-crash-rate'), crash: { rate: 0.5 },
  });
  okOrFail(r);
  const kills = r.opLog.filter((e) => e.kind === 'killed');
  assert.ok(kills.length >= 1, 'at least one crash fired');
  let restarted = 0;
  for (const k of kills) {
    // A real restart: the peer's next start is a new daemon (another lock instance) from disk; once the peer had
    // started (its state exists), startDispatch dispatches RESTART (Table 3.3-A). A kill inside a peer's first start
    // may come before its state exists: then the next start is what the disk says (genesis or join again).
    const at = r.opLog.indexOf(k);
    const [point, instance] = k.detail.split(' ');
    const after = r.opLog.slice(at + 1).find((e) => e.peer === k.peer && e.kind === 'start');
    assert.ok(after !== undefined, `${k.peer} started again after ${String(point)}`);
    const [mode, next] = after.detail.split(' ');
    assert.notEqual(next, instance, `${k.peer}: a new engine instance after ${String(point)}`);
    if (r.opLog.slice(0, at).some((e) => e.peer === k.peer && e.kind === 'start')) {
      assert.equal(mode, 'restart', `${k.peer}: startDispatch dispatched RESTART after ${String(point)}`);
      restarted++;
    }
  }
  assert.ok(restarted >= 1, 'a running engine was killed and restarted');
  assert.ok(r.opLog.every((e) => e.kind !== 'killed' || r.opLog.indexOf(e) < r.opLog.findIndex((x) => x.kind === 'round')), 'no kill in a quiescence or extra round');
  assert.equal(r.quiescence?.reached, true);
});
