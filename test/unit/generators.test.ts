// The Plan 2 op generator (Task 18; 11-testing §3.3 run step 1, §3.5 F-ED-2/6/8/9, F-NET-2/5/10; ruling R-31): draws
// only from ctx.random, resolves every parameter in next(), and the seed files of the `edits` and `faults` profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitRunner } from '../../src/git/runner.js';
import { seededRandom, type Random } from '../../src/ports/random.js';
import type { PushPurpose, TraceEvent, TraceOutcome } from '../../src/ports/trace.js';
import { retryTransientHolder, type SimContext } from '../sim/harness.js';
import type { PeerClone } from '../sim/peers.js';
import type { BareRemote, RejectKind } from '../sim/remote.js';
import { TraceRecorder } from '../sim/traceRecorder.js';
import { VirtualClock } from '../sim/vclock.js';
import { VirtualScheduler } from '../sim/vscheduler.js';
import { editGenerator, PROFILES, seedFilesPlan2, UNICODE_FILE, type EditKind, type FaultKind, type GeneratorProfile } from '../sim/generators.js';

const EDIT_KINDS: readonly EditKind[] = ['new_file', 'edit_own', 'edit_band', 'edit_same_line', 'append_md', 'eol_rewrite', 'delete_own', 'temp_file', 'secret_name'];
const FAULT_KINDS: readonly FaultKind[] = ['partition', 'heal', 'reject_transient', 'race_push'];

/** A Random that counts the bytes drawn from it. */
function counting(inner: Random): Random & { drawn: number } {
  const r = {
    drawn: 0,
    bytes(n: number): Uint8Array {
      r.drawn += n;
      return inner.bytes(n);
    },
  };
  return r;
}

/** A SimContext without git or disk: next() needs only the peers, their clocks and ctx.random. */
function fakeCtx(seed: string, peers = 3): SimContext & { random: Random & { drawn: number } } {
  const names = Array.from({ length: peers }, (_, i) => `p${i}`);
  const clonesOf = names.map((name, i): PeerClone => ({
    name, dir: `/nowhere/${name}`, filterCountFile: '', canary: '', opts: { name, autocrlf: i % 2 === 1, withFilter: false },
  }));
  const clocks = new Map(names.map((n) => [n, new VirtualClock()] as const));
  return {
    root: '/nowhere', remote: {} as BareRemote, peers: clonesOf, git: {} as GitRunner, random: counting(seededRandom(seed)),
    clocks, scheduler: new VirtualScheduler(new VirtualClock(), seededRandom(`${seed}/scheduler`)), opLog: [],
    seed, engines: [], trace: new TraceRecorder(), phase: 'ops', quiescence: null,
  };
}

/** `n` draws: each op as "<peer> <kind>", an engine step as "engine". Real time and Math.random throw meanwhile. */
function draws(profile: GeneratorProfile, ctx: SimContext, n: number): string[] {
  const gen = editGenerator(profile);
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => assert.fail('Math.random called by the generator');
  Date.now = () => assert.fail('Date.now called by the generator');
  try {
    const out: string[] = [];
    for (let step = 0; step < n; step++) {
      for (const c of ctx.clocks.values()) c.advance(1_000);
      const op = gen.next(ctx, step);
      out.push(op === null ? 'engine' : `${op.peer} ${op.kind}`);
    }
    return out;
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
}

test('editGenerator draws every EditKind of profile edits and every FaultKind of profile faults within 300 draws, using only ctx.random', () => {
  const edits = fakeCtx('gen-edits');
  const e = draws(PROFILES.edits, edits, 300);
  const eKinds = new Set(e.map((d) => d.split(' ')[1]).filter((k) => k !== undefined));
  for (const k of EDIT_KINDS) assert.ok(eKinds.has(k), `edits: ${k} drawn`);
  for (const k of FAULT_KINDS) assert.ok(!eKinds.has(k), `edits: no fault ${k}`);
  assert.ok(e.includes('engine'), 'edits: engine steps are drawn too');
  assert.ok(edits.random.drawn > 0, 'the draws came from ctx.random');

  const faults = fakeCtx('gen-faults');
  const f = draws(PROFILES.faults, faults, 300);
  const fKinds = new Set(f.map((d) => d.split(' ')[1]).filter((k) => k !== undefined));
  for (const k of FAULT_KINDS) assert.ok(fKinds.has(k), `faults: ${k} drawn`);
  for (const k of EDIT_KINDS) assert.ok(fKinds.has(k), `faults: ${k} drawn`);

  // Only ctx.random: the same seed gives the same draws, another seed other draws, and ctx.random is the only source
  // (a ctx whose random replays the same bytes replays the same draws, whatever else differs).
  assert.deepEqual(draws(PROFILES.edits, fakeCtx('gen-edits'), 300), e);
  assert.deepEqual(draws(PROFILES.faults, fakeCtx('gen-faults'), 300), f);
  assert.notDeepEqual(draws(PROFILES.edits, fakeCtx('gen-edits-other'), 300), e);
  const other = fakeCtx('another-seed-entirely');
  other.random = counting(seededRandom('gen-edits'));
  assert.deepEqual(draws(PROFILES.edits, other, 300), e);
});

test('with one peer race_push is never drawn; heal only follows a partition', () => {
  const solo = fakeCtx('gen-solo', 1);
  const g1 = editGenerator(PROFILES.faults);
  let partitioned = false;
  for (let step = 0; step < 300; step++) {
    const kind = g1.next(solo, step)?.kind;
    assert.notEqual(kind, 'race_push');
    if (kind === 'heal') assert.ok(partitioned, `heal at ${step} without a partition`);
    if (kind === 'partition') {
      assert.ok(!partitioned, `partition at ${step} while partitioned`);
      partitioned = true;
    } else if (kind === 'heal') {
      partitioned = false;
    }
  }
});

test('editGenerator refuses non-integer or negative weights', () => {
  assert.throws(() => editGenerator({ name: 'edits', engineWeight: 1.5, weights: {} }), RangeError);
  assert.throws(() => editGenerator({ name: 'edits', engineWeight: 1, weights: { new_file: -1 } }), RangeError);
});

/** A fake remote that records rejectNext calls (the control file is never written: nothing is ever pending). */
function recordingRemote(dir = '/nowhere/remote.git'): BareRemote & { calls: Array<{ n: number; kind: RejectKind; ref: string | undefined }> } {
  const calls: Array<{ n: number; kind: RejectKind; ref: string | undefined }> = [];
  return {
    dir, url: 'file:///nowhere/remote.git', calls,
    async rejectNext(n, kind, ref) { calls.push({ n, kind, ref }); },
    async clearRejects() {}, async readRemoteLog() { return []; }, async readRefTxLog() { return []; }, async refs() { return {}; },
  };
}

test('reject_transient draws both host texts ([remote rejected] (failed) and commit_refs), 1–2 rejections on a board ref', async () => {
  const ctx = fakeCtx('gen-reject');
  const remote = recordingRemote();
  ctx.remote = remote;
  const gen = editGenerator({ name: 'faults', engineWeight: 0, weights: { reject_transient: 1 } });
  for (let step = 0; step < 40; step++) assert.match(await gen.next(ctx, step)!.run(ctx), /^n=[12] kind=(transient-failed|commit_refs) ref=\/board$/);
  assert.deepEqual([...new Set(remote.calls.map((c) => c.kind))].sort(), ['commit_refs', 'transient-failed']);
  assert.deepEqual([...new Set(remote.calls.map((c) => c.n))].sort(), [1, 2]);
  assert.ok(remote.calls.every((c) => c.ref === '/board'));
});

test('reject_transient keeps every publish\'s transient streak at 2 or less (R-31 "1–2": never NONRETRYABLE by accident)', async () => {
  const push = (peer: string, outcome: TraceOutcome, purpose: PushPurpose = 'publish'): TraceEvent => ({ kind: 'push', peer, purpose, argv: [], bnew: null, outcome });
  const run = async (events: TraceEvent[], draws = 20): Promise<{ details: string[]; calls: number[] }> => {
    const ctx = fakeCtx('gen-streak');
    const remote = recordingRemote();
    ctx.remote = remote;
    for (const e of events) ctx.trace.emit(e);
    const gen = editGenerator({ name: 'faults', engineWeight: 0, weights: { reject_transient: 1 } });
    const details: string[] = [];
    for (let step = 0; step < draws; step++) details.push(await gen.next(ctx, step)!.run(ctx));
    return { details, calls: remote.calls.map((c) => c.n) };
  };
  // Two transient rejections in a row on one peer: no more until a landing or a lease loss ends the streak.
  const full = await run([push('a', 'transient'), push('a', 'network'), push('a', 'denied'), push('a', 'transient')]);
  assert.deepEqual(full.calls, []);
  assert.ok(full.details.every((d) => d === 'skipped streak=2'), full.details[0]);
  // One (b's; a's ended with its lease loss): at most one more.
  const one = await run([push('a', 'landed'), push('b', 'transient'), push('a', 'transient'), push('a', 'lease_lost'), push('b', 'network')]);
  assert.deepEqual([...new Set(one.calls)], [1], JSON.stringify(one.details));
  // Ended by a landing (or a lease loss), and genesis/probe pushes are no publish streak: 1–2 again.
  const reset = await run([push('a', 'transient'), push('a', 'transient', 'board_only'), push('a', 'landed', 'board_only'), push('b', 'lease_lost', 'genesis'), push('b', 'transient', 'probe')]);
  assert.deepEqual([...new Set(reset.calls)].sort(), [1, 2]);
});

test('reject_transient arms nothing while earlier rejections are still pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-gen-pending-'));
  try {
    const ctx = fakeCtx('gen-pending');
    ctx.root = root;
    const remote = recordingRemote();
    ctx.remote = remote;
    await writeFile(join(root, 'remote-control.json'), JSON.stringify({ count: 1, kind: 'transient-failed', refSubstring: '/board' }));
    const gen = editGenerator({ name: 'faults', engineWeight: 0, weights: { reject_transient: 1 } });
    assert.equal(await gen.next(ctx, 0)!.run(ctx), 'skipped pending=1');
    assert.deepEqual(remote.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('partition logs the outage it plans (planned_ms) and every heal the outage it really had (for_ms)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cowork-gen-partition-'));
  try {
    const dir = join(root, 'remote.git');
    await mkdir(dir);
    const ctx = fakeCtx('gen-partition');
    ctx.remote = recordingRemote(dir);
    const advance = (ms: number): void => { for (const c of ctx.clocks.values()) c.advance(ms); };
    const part = editGenerator({ name: 'faults', engineWeight: 0, weights: { partition: 1 } });
    const heal = editGenerator({ name: 'faults', engineWeight: 0, weights: { heal: 1 } });
    // A heal drawn before the planned end: the outage was shorter, and its for_ms says so.
    const p1 = part.next(ctx, 0)!;
    const planned1 = Number(/^remote renamed planned_ms=(\d+)$/.exec(await p1.run(ctx))![1]);
    assert.ok(planned1 >= 30_000 && planned1 <= 600_000, String(planned1));
    assert.ok(!existsSync(dir), 'the remote is renamed away');
    advance(12_345);
    assert.equal(await heal.next(ctx, 1)!.run(ctx), `remote restored for_ms=12345 planned_ms=${planned1}`);
    assert.ok(existsSync(dir), 'the remote is back');
    // No heal drawn: the generator heals at its first step past the planned end, and for_ms is the real outage.
    const p2 = part.next(ctx, 2)!;
    const planned2 = Number(/^remote renamed planned_ms=(\d+)$/.exec(await p2.run(ctx))![1]);
    advance(planned2 + 1_500);
    const h2 = part.next(ctx, 3)!;
    assert.equal(h2.kind, 'heal');
    assert.equal(await h2.run(ctx), `remote restored for_ms=${planned2 + 1_500} planned_ms=${planned2}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retryTransientHolder retries EBUSY/EPERM/EACCES (a Windows holder), rethrows anything else at once, and gives up after its attempts', async () => {
  const failing = (codes: string[]): { fn: () => Promise<string>; calls: () => number } => {
    let k = 0;
    return {
      fn: async () => {
        const code = codes[k++];
        if (code === undefined) return 'done';
        throw Object.assign(new Error(code), { code });
      },
      calls: () => k,
    };
  };
  const a = failing(['EBUSY', 'EPERM', 'EACCES']);
  assert.equal(await retryTransientHolder(a.fn, { attempts: 5, delayMs: 1 }), 'done');
  assert.equal(a.calls(), 4);
  const b = failing(['ENOENT']);
  await assert.rejects(retryTransientHolder(b.fn, { attempts: 5, delayMs: 1 }), /ENOENT/);
  assert.equal(b.calls(), 1);
  const c = failing(Array(10).fill('EBUSY'));
  await assert.rejects(retryTransientHolder(c.fn, { attempts: 3, delayMs: 1 }), /EBUSY/);
  assert.equal(c.calls(), 3);
});

test('seedFilesPlan2: shared.txt has 60 numbered LF rows in 6 bands of 10, crlf.txt is CRLF, big.py BOM+CRLF, plus notes.md, README.md, notes.txt and a non-ASCII, space-containing path', () => {
  const files = seedFilesPlan2(seededRandom('seed-files'));
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'big.py', 'crlf.txt', UNICODE_FILE, 'notes.md', 'notes.txt', 'shared.txt'].sort());
  assert.equal(UNICODE_FILE, 'docs/caf\u{e9} \u{d55c}\u{ae00} notes.txt');
  assert.ok(/[^\x00-\x7f]/.test(UNICODE_FILE) && UNICODE_FILE.includes(' '), 'non-ASCII and a space');
  assert.ok(!files[UNICODE_FILE]!.includes(0x0d), `${UNICODE_FILE} is LF`);
  const shared = files['shared.txt']!.toString('utf8');
  assert.ok(!shared.includes('\r'), 'shared.txt is LF');
  const rows = shared.split('\n');
  assert.equal(rows.pop(), '', 'a final newline');
  assert.equal(rows.length, 60);
  assert.equal(new Set(rows).size, 60, 'every row is distinct (numbered)');
  const crlf = files['crlf.txt']!;
  assert.ok(crlf.includes('\r\n') && !/(^|[^\r])\n/.test(crlf.toString('latin1')), 'crlf.txt has only CRLF endings');
  const big = files['big.py']!;
  assert.deepEqual([...big.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'big.py starts with a BOM');
  assert.ok(!/(^|[^\r])\n/.test(big.toString('latin1')), 'big.py has only CRLF endings');
  for (const name of ['notes.md', 'README.md', 'notes.txt']) assert.ok(!files[name]!.includes(0x0d), `${name} is LF`);
  assert.ok(files['notes.txt']!.toString('utf8').split('\n').length >= 9, 'notes.txt has the same-line rows');
  // Deterministic for one Random, different for another (big.py is generated).
  assert.deepEqual(seedFilesPlan2(seededRandom('seed-files')), files);
  assert.notDeepEqual(seedFilesPlan2(seededRandom('seed-files-2'))['big.py'], big);
});
