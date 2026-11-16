// ParserHost.dispose (Plan 4 Task 1; REG-31, R4-14, TST-03): a host frees its Parsers, compiled Queries and live Trees
// explicitly. Every host in a realm shares one web-tree-sitter wasm heap, and web-tree-sitter's FinalizationRegistry runs
// only on JS garbage collection, not on wasm heap pressure, so SIM (inlineWorkers per peer, many seeds in one process)
// would otherwise grow the heap until Emscripten aborts. inlineWorkers.close() and runWorkerLoop's exit path call it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Query, Tree } from 'web-tree-sitter';
import { realClock } from '../../src/ports/clock.js';
import { BUDGETS } from '../../src/regions/budgets.js';
import type { RegionJob } from '../../src/regions/pool.js';
import { LANGUAGES } from '../../src/regions/runtime.js';
import type { Language } from '../../src/regions/types.js';
import { inlineWorkers } from '../../src/regions/worker/inline.js';
import { runWorkerLoop } from '../../src/regions/worker/main.js';
import { initParser } from '../../src/regions/worker/parser.js';
import type { FromWorker, WorkerPortLike } from '../../src/regions/worker/protocol.js';
import { testRegionRuntime, testWorkerInit } from '../helpers/regionRuntime.js';

const HUNKS: RegionJob = { kind: 'hunks', from: [], to: [] };
const MAP: RegionJob = { kind: 'map', from: [], to: [], ranges: [[1, 1]], mode: 'local' };
const ALL_UNAVAILABLE = Object.fromEntries(LANGUAGES.map((l) => [l, 'unavailable']));
const SNIPPET: Readonly<Record<Language, string>> = {
  python: 'def f(x):\n    return x\n',
  javascript: 'function f(x) { return x; }\n',
  typescript: 'function f(x: number): number { return x; }\n',
  tsx: 'const A = () => <div />;\n',
  c_sharp: 'class A { int F(int x) { return x; } }\n',
};

interface Deleted { readonly trees: object[]; readonly parsers: object[]; readonly queries: object[]; }
interface Deletable { delete(): void; }

/** Records every .delete() of a web-tree-sitter Tree, Parser or Query while body runs; the prototypes are restored afterwards. */
async function spyDeletes<T>(body: (deleted: Deleted) => Promise<T>): Promise<T> {
  const deleted: Deleted = { trees: [], parsers: [], queries: [] };
  const restore: Array<() => void> = [];
  const spy = (proto: Deletable, into: object[]): void => {
    const original = proto.delete;
    proto.delete = function (this: Deletable): void {
      into.push(this);
      original.call(this);
    };
    restore.push(() => {
      proto.delete = original;
    });
  };
  spy(Tree.prototype, deleted.trees);
  spy(Parser.prototype, deleted.parsers);
  spy(Query.prototype, deleted.queries);
  try {
    return await body(deleted);
  } finally {
    for (const r of restore) r();
  }
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const until = realClock.monoMs() + ms;
  while (!cond()) {
    if (realClock.monoMs() > until) assert.fail(`timed out waiting for ${what}`);
    await realClock.sleep(5);
  }
}

/** Asserts that `objects` holds `n` distinct objects (each deleted exactly once). */
function distinct(objects: readonly object[], n: number, what: string): void {
  assert.equal(objects.length, n, `${what}: ${objects.length} deletes`);
  assert.equal(new Set(objects).size, n, `${what}: each deleted once`);
}

test('ParserHost.dispose deletes its Parsers, Queries and live Trees, once', async () => {
  const host = await initParser(testWorkerInit(await testRegionRuntime()));
  const ready = LANGUAGES.filter((l) => host.availability().get(l) === 'ok').length;
  assert.equal(ready, LANGUAGES.length);
  await spyDeletes(async (deleted) => {
    const trees: Tree[] = [];
    const keys = Array.from({ length: BUDGETS.liveTreesPerWorker + 1 }, (_, i) => `k${i}`);
    for (const [i, key] of keys.entries()) {
      const lang = LANGUAGES[i % LANGUAGES.length] as Language;
      const tree = host.parse(lang, Buffer.from(SNIPPET[lang], 'utf8'), key, null);
      assert.ok(typeof tree === 'object', `${key} (${lang}) parses`);
      trees.push(tree);
    }
    assert.deepEqual(deleted.trees, [trees[0]], 'the LRU already freed the oldest tree');
    assert.deepEqual(host.liveKeys(), keys.slice(1));

    host.dispose();
    distinct(deleted.trees, trees.length, 'trees');
    assert.deepEqual(new Set(deleted.trees), new Set(trees), 'every live tree is deleted, and the evicted one not again');
    distinct(deleted.parsers, ready, 'parsers');
    distinct(deleted.queries, ready, 'queries');
    assert.deepEqual(host.liveKeys(), []);
    assert.equal(host.parse('python', Buffer.from('x = 1\n', 'utf8'), 'after', null), 'unavailable', 'a disposed host parses nothing');
    assert.deepEqual(Object.fromEntries(host.availability()), ALL_UNAVAILABLE);

    host.dispose();
    assert.deepEqual([deleted.trees.length, deleted.parsers.length, deleted.queries.length], [trees.length, ready, ready], 'a second dispose deletes nothing');
  });
});

test('inlineWorkers.close() disposes its parser host', async () => {
  const trees: Tree[] = [];
  const pool = await inlineWorkers(await testRegionRuntime(), {
    handlers: {
      hunks: async (_job, ctx) => {
        const tree = ctx.parser.parse('python', Buffer.from(SNIPPET.python, 'utf8'), 'inline', null);
        if (typeof tree === 'object') trees.push(tree);
        return [];
      },
    },
  });
  assert.deepEqual(await pool.run(HUNKS, 'fg', null), { kind: 'ok', value: [] });
  assert.equal(trees.length, 1);
  await spyDeletes(async (deleted) => {
    await pool.close();
    assert.deepEqual(deleted.trees, trees, 'the live tree is deleted');
    distinct(deleted.parsers, LANGUAGES.length, 'parsers');
    distinct(deleted.queries, LANGUAGES.length, 'queries');
    await pool.close();
    assert.deepEqual([deleted.trees.length, deleted.parsers.length, deleted.queries.length], [1, LANGUAGES.length, LANGUAGES.length], 'a second close deletes nothing');
  });
});

test('runWorkerLoop disposes its parser host when the loop stops after a throw', async () => {
  const posted: FromWorker[] = [];
  let deliver: (m: unknown) => void = () => undefined;
  const port: WorkerPortLike = {
    on: (_ev, cb) => {
      deliver = cb;
    },
    postMessage: (m) => {
      posted.push(m);
    },
  };
  const trees: Tree[] = [];
  const loop = runWorkerLoop(port, testWorkerInit(await testRegionRuntime()), {
    hunks: async (_job, ctx) => {
      const tree = ctx.parser.parse('python', Buffer.from(SNIPPET.python, 'utf8'), 'loop', null);
      if (typeof tree === 'object') trees.push(tree);
      return [];
    },
    map: async () => {
      throw new Error('test handler');
    },
  });
  await waitFor(() => posted.length > 0, 30_000, 'the ready message');
  assert.equal(posted[0]?.type, 'ready');
  deliver({ type: 'job', id: 1, job: HUNKS, remainingMs: null });
  await waitFor(() => posted.length > 1, 30_000, 'the hunks result');
  assert.deepEqual(posted[1], { type: 'result', id: 1, result: { kind: 'ok', value: [] } });
  assert.equal(trees.length, 1);
  await spyDeletes(async (deleted) => {
    deliver({ type: 'job', id: 2, job: MAP, remainingMs: null });
    await loop;
    assert.deepEqual(posted[2], { type: 'result', id: 2, result: { kind: 'crashed' } });
    assert.deepEqual(deleted.trees, trees, 'the live tree is deleted before the loop resolves');
    distinct(deleted.parsers, LANGUAGES.length, 'parsers');
    distinct(deleted.queries, LANGUAGES.length, 'queries');
  });
});
