// Plan 8a Task 15: the viewer opens no network connection (12 §3.10.1, §7 T-VIZ-no-network; VIZ-30, VIZ-07, INV-VIZ-LOOPBACK,
// INV-EGRESS; S5, S14, F7). (1) With every Node entry point to the network instrumented — socket connects, http(s) requests, DNS
// lookups and resolves (module functions, Resolver methods, their promise forms) and UDP binds and sends — a viewer run over a
// real clone (start, fold, serving the world, a page and a stream, polling) makes no connection and no name lookup (only Node's
// listen path looks up the literal 127.0.0.1, at most once) and holds exactly one listening socket, on 127.0.0.1; the calls the
// test's own HTTP client makes are told apart by a synchronous test/helpers/vizHttp.ts frame below the instrumentation, and a
// positive control (one name lookup injected on the viewer's side) shows the check sees the viewer's calls. (2) A promisor
// (partial) clone whose tip's live commit is missing: the viewer's git children never fetch it (it is still missing afterwards and the promisor remote's objects are untouched),
// while git without the viewer's protections would (the control at the end); the room shows UI_VIZ_NO_BOARD.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Oid } from '../../../src/git/oid.js';
import type { GitRunner } from '../../../src/git/runner.js';
import { machineMonoMs } from '../../../src/ports/clock.js';
import type { ViewerDeps } from '../../../src/viz/main.js';
import { vizGitRunner } from '../../../src/viz/source/vizGit.js';
import { VirtualClock } from '../../sim/vclock.js';
import { testRunner } from '../../helpers/tmp.js';
import { openStream } from '../../helpers/vizHttp.js';
import { hideObject, pubs, writeStatus } from '../../helpers/vizStore.js';
import { apiGet, gitRoomsFixture, startTestViewer, worldOf } from '../../helpers/vizViewer.js';

interface NetCall { what: string; arg: string; stack: string; }

/** The positive control's name: one lookup the test injects on the viewer's side (its git runner); recorded, never sent to a resolver. */
const CONTROL_NAME = 'positive-control.invalid';

/** Wraps every network entry point of Node; returns the calls seen and a restore(). */
function instrument(): { calls: NetCall[]; restore(): void } {
  const calls: NetCall[] = [];
  const mocks: Array<{ mock: { restore(): void } }> = [];
  const wrap = (obj: object, name: string, what: string): void => {
    const original = (obj as Record<string, unknown>)[name];
    if (typeof original !== 'function') return;
    mocks.push(mock.method(obj as Record<string, (...a: unknown[]) => unknown>, name, function netSpy(this: unknown, ...args: unknown[]): unknown {
      const a0 = args[0];
      const arg = typeof a0 === 'string' ? a0 : typeof a0 === 'object' && a0 !== null ? JSON.stringify(a0, (_k, v: unknown) => (typeof v === 'function' ? undefined : v)) ?? '' : String(a0);
      // The whole stack (the default limit of 10 frames cuts a client's connect off above its vizHttp.ts frame), without this wrapper.
      const holder: { stack?: string } = {};
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = Infinity;
      Error.captureStackTrace(holder, netSpy);
      Error.stackTraceLimit = limit;
      calls.push({ what, arg, stack: holder.stack ?? '' });
      if (arg === CONTROL_NAME) return undefined;
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    }));
  };
  wrap(net.Socket.prototype, 'connect', 'connect');
  for (const m of [http, https]) for (const n of ['request', 'get']) wrap(m, n, `${m === http ? 'http' : 'https'}.${n}`);
  const DNS_FNS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr',
    'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];
  for (const n of DNS_FNS) {
    wrap(dns, n, `dns.${n}`);
    wrap(dns.promises, n, `dns.promises.${n}`);
    wrap(dns.Resolver.prototype, n, `Resolver.${n}`);
    wrap(dns.promises.Resolver.prototype, n, `promises.Resolver.${n}`);
  }
  wrap(dgram.Socket.prototype, 'bind', 'dgram.bind');
  wrap(dgram.Socket.prototype, 'send', 'dgram.send');
  return { calls, restore: () => { for (const m of mocks) m.mock.restore(); } };
}

/**
 * The frames of a recorded call below the instrumentation: every frame after the first node:test mock frame (the wrapper and the
 * mock sit above it), without `at async` frames (V8's async stack traces tie a start path the test awaits to the test function).
 */
function callerFrames(stack: string): string[] {
  const frames = stack.split('\n').filter((l) => /^\s+at /.test(l));
  const mockAt = frames.findIndex((l) => l.includes('node:internal/test_runner/mock'));
  return frames.slice(mockAt + 1).filter((l) => !/^\s+at async /.test(l));
}
/** The test's own HTTP client: a synchronous frame of test/helpers/vizHttp.ts (its request and openStream), and nothing else. */
const CLIENT_FRAME = /[\\/]test[\\/]helpers[\\/]vizHttp\.ts:\d+:\d+\)?$/;
/** A call the test's own client made, not the viewer: the test file's own frames (the wrapper, the test function) never count. */
const byTest = (c: NetCall): boolean => callerFrames(c.stack).some((l) => CLIENT_FRAME.test(l));
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

/** Listening servers of this process (the viewer's, and nothing else of the test's). */
function listening(): net.AddressInfo[] {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.filter((h): h is net.Server => h instanceof net.Server && h.listening).map((s) => s.address() as net.AddressInfo);
}

/** A stack as the instrumentation records it: the given frames below the mock, each `at <fn> (<file>:1:1)`. */
const syntheticStack = (frames: readonly string[]): string =>
  ['Error', '    at Object.<anonymous> (C:\\r\\test\\integration\\viz\\noNetwork.test.ts:44:7)', '    at Object.apply (node:internal/test_runner/mock/mock:805:20)',
    ...frames.map((f) => `    at ${f}`)].join('\n');

test('T-VIZ-no-network (classifier): a call is the test client\'s only through a synchronous test/helpers/vizHttp.ts frame below the instrumentation; the wrapper, the mock and `at async` frames never count', () => {
  const call = (frames: readonly string[]): NetCall => ({ what: 'dns.lookup', arg: 'x', stack: syntheticStack(frames) });
  // The viewer's start path, awaited from the test function (V8's async frames name the test file).
  assert.equal(byTest(call(['startViewer (C:\\r\\src\\viz\\main.ts:1:1)', 'async startTestViewer (C:\\r\\test\\helpers\\vizViewer.ts:1:1)',
    'async TestContext.<anonymous> (C:\\r\\test\\integration\\viz\\noNetwork.test.ts:1:1)'])), false, 'the viewer\'s start path');
  // A poll tick (a timer callback): nothing of the test below the wrapper.
  assert.equal(byTest(call(['RoomStore.tick (file:///r/src/viz/server/store.ts:1:1)', 'listOnTimeout (node:internal/timers:1:1)'])), false, 'a poll tick');
  // Awaited from the test client only through an `at async` frame: still not the client's call.
  assert.equal(byTest(call(['startViewer (/r/src/viz/main.ts:1:1)', 'async request (/r/test/helpers/vizHttp.ts:1:1)'])), false, 'an async frame');
  // The test's client: http.request (itself instrumented) called synchronously from vizHttp.ts.
  assert.equal(byTest(call(['Socket.connect (node:net:1:1)', 'new ClientRequest (node:_http_client:1:1)', 'Object.apply (node:internal/test_runner/mock/mock:805:20)',
    'Object.<anonymous> (C:\\r\\test\\integration\\viz\\noNetwork.test.ts:44:7)', 'C:\\r\\test\\helpers\\vizHttp.ts:88:22', 'new Promise (<anonymous>)',
    'request (C:\\r\\test\\helpers\\vizHttp.ts:87:10)'])), true, 'the test client (win32 paths)');
  assert.equal(byTest(call(['Object.request (node:http:1:1)', 'openStream (file:///r/test/helpers/vizHttp.ts:113:22)'])), true, 'the test client (file URLs)');
});

test('T-VIZ-no-network: a viewer run makes 0 outbound connections and 0 name lookups and holds exactly one listening socket, on 127.0.0.1', { timeout: 120_000 }, async (t) => {
  const f = await gitRoomsFixture('viz-nonet', 1);
  try {
    const c = f.clones[0]!;
    await c.writer.commitMany(pubs(40));
    writeStatus(c.paths.gitDir, { heartbeat_mono_ms: machineMonoMs() });
    const before = listening().length;
    const net0 = instrument();
    let catFiles = 0;
    let injected = false;
    const gitRunner: NonNullable<ViewerDeps['gitRunner']> = (o): GitRunner => {
      const inner = vizGitRunner(o);
      return {
        run: async (a, opts) => {
          // The positive control: the first git call the viewer makes after its start (a store's init or a poll tick, in a turn of
          // its own) also looks up a name, as a viewer-side defect would; the check below must attribute it to the viewer.
          if (!injected && a[0] === 'cat-file') {
            injected = true;
            dns.lookup(CONTROL_NAME, () => undefined);
          }
          const r = await inner.run(a, opts);
          if (a[0] === 'cat-file') catFiles++;
          return r;
        },
      };
    };
    const clock = new VirtualClock();
    let v: Awaited<ReturnType<typeof startTestViewer>> | null = null;
    try {
      v = await startTestViewer({ repos: [c.dir] }, { clock, gitRunner });
      const s = await v.session();
      const st = await openStream(v.port, { 'x-cowork-session': s });
      const room = (await worldOf(v.port, s)).rooms[0]!;
      assert.ok(catFiles >= 2, 'the room folded');
      assert.equal((await apiGet(v.port, s, `/api/v1/rooms/${room.room_id}/timeline?from=0&to=20`)).status, 200);
      await c.writer.commitMany(pubs(3, 'live'));
      for (let i = 0; i < 4; i++) {
        clock.advance(25_000);
        await new Promise((r) => setTimeout(r, 2_700));
      }
      const servers = listening();
      assert.equal(servers.length - before, 1, 'one listening socket');
      assert.ok(servers.some((a) => a.address === '127.0.0.1' && a.port === v!.port && a.family === 'IPv4'), JSON.stringify(servers));
      st.close();
    } finally {
      await v?.stop('VIZ_EXIT_SIGNAL');
      net0.restore();
    }
    const viewer = net0.calls.filter((x) => !byTest(x));
    t.diagnostic(`${net0.calls.length} calls: ${net0.calls.length - viewer.length} by the test's client, ${viewer.length} by the viewer (${viewer.map((x) => `${x.what} ${x.arg}`).join(', ')})`);
    assert.deepEqual(viewer.filter((x) => x.what === 'connect' || x.what.startsWith('http')).map((x) => `${x.what} ${x.arg}`), [], '0 connections');
    const lookups = viewer.filter((x) => x.what.includes('lookup') || x.what.includes('resolve') || x.what.includes('reverse'));
    // The injected viewer-side lookup is the only name lookup: the check sees the viewer's calls (a classifier that files every call
    // under the test's client leaves this list empty and fails here).
    assert.deepEqual(lookups.filter((x) => !IP_LITERAL.test(x.arg)).map((x) => `${x.what} ${x.arg}`), [`dns.lookup ${CONTROL_NAME}`], '0 lookups of a name (besides the positive control)');
    assert.ok(lookups.filter((x) => x.arg === '127.0.0.1').length <= 1, 'at most Node\'s listen path');
    assert.deepEqual(lookups.filter((x) => x.arg !== '127.0.0.1' && x.arg !== CONTROL_NAME), [], 'no other lookup');
    assert.deepEqual(viewer.filter((x) => x.what.startsWith('dgram')), [], '0 datagrams');
    assert.ok(net0.calls.some(byTest), 'the instrumentation saw the test\'s own client');
    assert.ok(net0.calls.filter((x) => x.what === 'http.request').every(byTest), 'every HTTP request was the test\'s client');
  } finally {
    await f.cleanup();
  }
});

/** Every file under `dir` with its size and mtime (the promisor remote's object store: a fetch would add a pack or loose objects). */
function objectListing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const s = statSync(p, { bigint: true });
      out.push(`${relative(dir, p)} ${s.size} ${s.mtimeNs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test('T-VIZ-no-network: a promisor clone\'s missing live commit makes 0 connections from git children and the room shows UI_VIZ_NO_BOARD', { timeout: 120_000 }, async () => {
  const f = await gitRoomsFixture('viz-promisor', 1);
  try {
    const c = f.clones[0]!;
    const remote = f.fx.remote.dir;
    const run = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> => {
      const r = await testRunner().run(args, { class: 'local', cwd, extraEnv });
      return { code: r.code, out: r.stdout.toString('utf8').trim() };
    };
    // The board, loose objects; the remote holds it too (a promisor remote that has the object), and serves any object asked for.
    await c.writer.commitMany(pubs(4));
    await c.writer.commit({ writer: 'ann', cs: [{ paths: ['src/late.txt'] }] });
    const live = (await c.repo.readCommit(c.writer.tip().oid)).parents[1]! as Oid;
    assert.equal((await run(['push', '-q', f.fx.remote.url, `${c.writer.ref}:refs/heads/board-mirror`], c.dir)).code, 0);
    for (const [k, x] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) assert.equal((await run(['config', k!, x!], remote)).code, 0);
    // The clone becomes a partial clone of origin, then loses the live commit.
    for (const [k, x] of [['core.repositoryformatversion', '1'], ['extensions.partialClone', 'origin'], ['remote.origin.promisor', 'true']]) {
      assert.equal((await run(['config', k!, x!], c.dir)).code, 0);
    }
    hideObject(c.paths.gitDir, live);
    const absent = async (): Promise<boolean> => (await run(['cat-file', '-e', live], c.dir, { GIT_NO_LAZY_FETCH: '1' })).code !== 0;
    assert.ok(await absent(), 'the clone lacks the live commit');
    writeStatus(c.paths.gitDir, { heartbeat_mono_ms: machineMonoMs() });
    const objects = join(remote, 'objects');
    const remoteBefore = objectListing(objects);

    const clock = new VirtualClock();
    const v = await startTestViewer({ repos: [c.dir] }, { clock });
    try {
      const s = await v.session();
      const room = (await worldOf(v.port, s)).rooms[0]!;
      assert.deepEqual(room.badges, ['UI_VIZ_NO_BOARD']);
      assert.deepEqual(room.window, { h0: 0, h1: 0 }, 'nothing of the batch that names it is folded (R-V19): an empty room');
      for (let i = 0; i < 3; i++) {
        clock.advance(2_500);
        await new Promise((r) => setTimeout(r, 2_700));
      }
      assert.deepEqual((await worldOf(v.port, s)).rooms[0]!.badges, ['UI_VIZ_NO_BOARD'], 'retried, still missing');
    } finally {
      await v.stop('VIZ_EXIT_SIGNAL');
    }
    assert.ok(await absent(), 'no git child of the viewer fetched it');
    assert.deepEqual(objectListing(objects), remoteBefore, 'the promisor remote\'s objects were not accessed');
    // The control: git without the viewer's protections lazily fetches it from the promisor remote.
    assert.equal((await run(['cat-file', '-e', live], c.dir)).code, 0, 'the fixture really is a promisor clone that would fetch');
  } finally {
    await f.cleanup();
  }
});
