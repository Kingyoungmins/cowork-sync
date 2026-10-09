// N peers with Engines on real clones of one file:// bare remote (Plan 2 Task 17): the core fixture's clones, virtual
// clocks, one VirtualScheduler, a FaultFs per peer and one TraceRecorder, each peer driven by an Engine instead of a bare
// EngineCore. Every peer holds its own daemon.lock (DaemonLock, as `daemon.js run` does: restart() and every ENG-53
// own-leftover deletion run only while it is held) and logs into a LogRecorder. startAll() is a real genesis on peer 0
// and real joins on the others; rounds() advances every clock and iterates every engine in name order. Git is never
// mocked.
import assert from 'node:assert/strict';
import type { MutantId } from '../../src/engine/deps.js';
import { DaemonLock, Engine } from '../../src/engine/loop.js';
import type { StartOptions } from '../../src/engine/start.js';
import type { Oid } from '../../src/git/oid.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { makeCores, readWork, type CoreFixture, type CoreOptions, type PeerFixture } from './coreFixture.js';
import { LogRecorder } from './publishHelpers.js';
import { gitIn } from './startFixture.js';

export interface EngineFixture extends Omit<CoreFixture, 'peers'> {
  peers: Array<PeerFixture & { engine: Engine }>;
  startAll(opts?: StartOptions): Promise<void>;          // peer 0 genesis, the others join
  rounds(n: number, loopMs?: number): Promise<void>;    // advance every clock loopMs (default 2,500), iterate every engine in name order
}

const locksOf = new WeakMap<PeerFixture, DaemonLock>();

/** Fixture extension: the daemon.lock this peer holds (a test may release it to run a `daemon.js` verb on the clone). */
export function lockOf(p: PeerFixture): DaemonLock {
  const l = locksOf.get(p);
  assert.ok(l !== undefined, `${p.name}: no daemon.lock`);
  return l;
}

/** Fixture extension: each peer's LogRecorder (the deps.log its Engine writes to). */
export function logOf(p: PeerFixture): LogRecorder {
  const l = p.deps.log;
  assert.ok(l instanceof LogRecorder, `${p.name}: no LogRecorder`);
  return l;
}

/** url: the URL each peer's EngineDeps names instead of the bare remote's file:// URL (a test makes git reach the remote through it). */
export async function makeEngines(label: string, opts: { n: number; files?: Record<string, Buffer>; autocrlf?: readonly boolean[]; seed?: string; mutants?: ReadonlySet<MutantId>; url?: (p: PeerFixture) => string } & Pick<CoreOptions, 'platform'>): Promise<EngineFixture> {
  const fx = await makeCores(label, opts);
  const locks: DaemonLock[] = [];
  try {
    const peers: Array<PeerFixture & { engine: Engine }> = [];
    for (const p of fx.peers) {
      p.deps.log = new LogRecorder();
      if (opts.url !== undefined) p.deps.url = opts.url(p);
      const lock = await DaemonLock.acquire(p.deps.ports.fs, p.deps.paths.coworkDir, { pluginVersion: PLUGIN_VERSION, instance: `fixture-${p.name}` });
      assert.ok(lock instanceof DaemonLock, `${p.name}: daemon.lock is held`);
      locks.push(lock);
      locksOf.set(p, lock);
      const engine = await Engine.create(p.deps);
      p.core = engine.core;
      peers.push(Object.assign(p, { engine }));
    }
    const ef: EngineFixture = {
      ...fx,
      peers,
      async startAll(o?: StartOptions): Promise<void> {
        for (const [i, p] of peers.entries()) {
          const r = await p.engine.start(o ?? { publishLocal: null });
          assert.ok(r.ok, `${p.name}: start refused ${JSON.stringify(r)}`);
          assert.equal(r.mode, i === 0 ? 'genesis' : 'join', `${p.name}: start mode`);
        }
      },
      async rounds(n: number, loopMs = 2_500): Promise<void> {
        for (let i = 0; i < n; i++) {
          fx.advance(loopMs);
          for (const p of peers) await p.engine.iterate();
        }
      },
      async cleanup(): Promise<void> {
        for (const l of locks) await l.release().catch(() => undefined);
        await fx.cleanup();
      },
    };
    return ef;
  } catch (e) {
    for (const l of locks) await l.release().catch(() => undefined);
    await fx.cleanup();
    throw e;
  }
}

/** Fixture extension: counts the calls of one instance method (the original still runs); restore() puts it back. */
export function countCalls<T extends object>(o: T, method: keyof T & string): { readonly n: number; restore(): void } {
  const orig = o[method] as unknown as (...a: unknown[]) => unknown;
  const own = Object.prototype.hasOwnProperty.call(o, method);
  const box = { n: 0 };
  Reflect.set(o, method, function (this: unknown, ...a: unknown[]): unknown {
    box.n += 1;
    return orig.apply(o, a);
  });
  return {
    get n(): number {
      return box.n;
    },
    restore: () => {
      if (own) Reflect.set(o, method, orig);
      else Reflect.deleteProperty(o, method);
    },
  };
}

/** The remote board tip (undefined before genesis). */
export async function remoteBoardTip(fx: EngineFixture): Promise<string | undefined> {
  return (await fx.remote.refs())[fx.peers[0]!.core.refs.remoteBoard];
}

/**
 * Ruling R-32 in miniature: rounds until the remote board tip stayed unchanged for `k` rounds (the count restarts at every
 * change; at most maxRounds); returns T* and the rounds run since the last change. Fails "no quiescence" otherwise.
 */
export async function quiesce(fx: EngineFixture, o: { k?: number; maxRounds?: number; loopMs?: number } = {}): Promise<{ tStar: string; rounds: number; lastChangeRound: number }> {
  const k = o.k ?? 20;
  const max = o.maxRounds ?? 200;
  let tip = await remoteBoardTip(fx);
  let since = 0;
  let last = 0;
  for (let r = 1; r <= max; r++) {
    await fx.rounds(1, o.loopMs);
    const now = await remoteBoardTip(fx);
    if (now !== tip) {
      tip = now;
      since = 0;
      last = r;
    } else if (++since >= k) {
      assert.ok(tip !== undefined, 'no board on the remote');
      return { tStar: tip, rounds: r, lastChangeRound: last };
    }
  }
  assert.fail(`no quiescence within ${max} rounds`);
}

/** A working file's text in its stored (LF) form: CRLF read back as LF (the seeds and edits are LF-stored text). */
export async function storedText(p: PeerFixture, path: string): Promise<string | null> {
  const b = await readWork(p, path);
  return b === null ? null : b.toString('utf8').replace(/\r\n/g, '\n');
}

/**
 * INV-CONVERGE at T* (R-32): every peer has LA_B == T*, A == tree(live_code(T*)), nothing pending or not converged, and
 * every path of tree(live_code(T*)) on disk in its stored form: the blob git stores for the working file under that
 * clone's own settings (`hash-object --path`: core.autocrlf and the attributes) is the tree's blob, byte for byte — the
 * disk is never compared after the test stripped its CRs (a CRLF file on an autocrlf=false peer fails).
 */
export async function assertConverged(fx: EngineFixture, tStar: string): Promise<Map<string, string>> {
  const p0 = fx.peers[0]!;
  const board = await p0.core.repo.readCommit(tStar as Oid);
  const live = board.parents[board.parents.length - 1]!;
  const liveTree = (await p0.core.repo.readCommit(live)).tree;
  const files = new Map<string, string>();
  const blobs = new Map<string, string>();
  for (const [path, e] of await p0.core.repo.readTreeMap(liveTree)) {
    files.set(path, (await p0.core.repo.readBlob(e.oid)).toString('utf8'));
    blobs.set(path, e.oid);
  }
  for (const p of fx.peers) {
    const view = p.core.view!;
    assert.equal(view.laB, tStar, `${p.name}: LA_B == T*`);
    assert.equal(view.base, liveTree, `${p.name}: A == tree(live_code(T*))`);
    assert.deepEqual(view.meta.pending, {}, `${p.name}: nothing pending`);
    const ins = await p.engine.inspect();
    assert.deepEqual(ins.notConverged, [], `${p.name}: not_converged`);
    for (const [path, oid] of blobs) {
      assert.ok((await readWork(p, path)) !== null, `${p.name}: ${path} on disk`);
      assert.equal(await gitIn(p, ['hash-object', `--path=${path}`, '--', path]), oid, `${p.name}: ${path} in its stored form`);
    }
  }
  return files;
}

/** makeEngines with cleanup and the scheduler hook always reset. */
export async function withEngines<T>(label: string, opts: Parameters<typeof makeEngines>[1], fn: (fx: EngineFixture) => Promise<T>): Promise<T> {
  const fx = await makeEngines(label, opts);
  try {
    return await fn(fx);
  } finally {
    fx.scheduler.onYield = null;
    await fx.cleanup();
  }
}
