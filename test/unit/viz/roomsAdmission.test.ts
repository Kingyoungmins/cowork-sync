// Plan 8a final review, fix Group D (§3 cli-host #1, downgraded to Minor; §4a "sequential admission"): discoverRooms admits the
// --repo arguments through a bounded pool of ADMIT_POOL = 8 (the ready window — 5 s, 15 s on Windows — holds every admission's
// for-each-ref), keeps the results by argument index, runs git once per clone (two spellings whose <path>/.git has one realpath are
// deduplicated before any git runs, the first spelling kept) and refuses RF_VIZ_REPO_NOT_LIVE on any failure, a thrown one included.
// Fakes only (Fs, VizGit, RootProbe; POSIX paths on every host): the real-git cases stay in test/integration/viz/rooms.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import type { RootProbe } from '../../../src/data/canonRoot.js';
import type { Fs, FsLstat } from '../../../src/ports/fs.js';
import type { BoundedReader } from '../../../src/viz/source/boundedRead.js';
import { ADMIT_POOL, discoverRooms, roomId, type DiscoverDeps, type Discovery } from '../../../src/viz/source/rooms.js';
import type { VizGit } from '../../../src/viz/source/vizGit.js';

const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const OID = 'b'.repeat(40);
const DIR: FsLstat = { size: 0, mtimeMs: 0, mtimeNs: 0n, isFile: false, isDirectory: true, isSymbolicLink: false, mode: 0o40755, dev: 1n, ino: 1n } as unknown as FsLstat;

interface World {
  /** A spelling of a clone → its canonical root (the main worktree's realpath). */
  canon: Map<string, string>;
  /** A gitdir's remoteRefs, after `delayMs(gitDir)`; throwing when `fails` names it. */
  delayMs?: (gitDir: string) => number;
  fails?: ReadonlySet<string>;
  /** A spelling whose realpath(<path>/.git) throws. */
  realpathFails?: ReadonlySet<string>;
}

/** The fakes and what they saw: every gitdir remoteRefs ran for, and the most remoteRefs calls in flight at once. */
function fakes(w: World): { deps: DiscoverDeps; seen: string[]; maxInFlight(): number } {
  const seen: string[] = [];
  let inFlight = 0;
  let max = 0;
  const no = (): never => { throw new Error('unexpected call'); };
  const canonOf = (p: string): string => {
    const c = w.canon.get(p.replace(/\/+$/, ''));
    if (c === undefined) throw new Error(`no such path ${p}`);
    return c;
  };
  const fs = {
    lstat: async (p: string) => (w.canon.has(posix.dirname(p)) && posix.basename(p) === '.git' ? DIR : null),
    realpath: async (p: string) => {
      const repo = posix.dirname(p);
      if (w.realpathFails?.has(repo) === true) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return posix.join(canonOf(repo), '.git');
    },
  } as unknown as Fs;
  const reader: BoundedReader = { read: no };
  const git = (gitDir: string): VizGit => ({
    gitDir,
    remoteRefs: async () => {
      seen.push(gitDir);
      inFlight += 1;
      max = Math.max(max, inFlight);
      try {
        await new Promise((r) => setTimeout(r, w.delayMs?.(gitDir) ?? 5));
        if (w.fails?.has(gitDir) === true) throw new Error('git for-each-ref failed with exit code 128');
        return [{ ref: 'refs/cowork-remote/main/board', oid: OID as never }];
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as VizGit);
  const probe: RootProbe = {
    exists: (p) => w.canon.has(p.replace(/\/+$/, '')) || [...w.canon.values()].includes(p),
    realpathNative: (p) => canonOf(p),
    readText: () => null,
    isDir: () => true,
  };
  return { deps: { fs, reader, git, salt: SALT, platform: 'linux', probe }, seen, maxInFlight: () => max };
}

function rooms(d: Discovery): Extract<Discovery, { rooms: unknown }> {
  assert.ok('rooms' in d, `refused: ${JSON.stringify(d)}`);
  return d;
}

/** n clones /w/c00 … each its own canonical root. */
const clones = (n: number): Map<string, string> => new Map(Array.from({ length: n }, (_, i) => {
  const p = `/w/c${String(i).padStart(2, '0')}`;
  return [p, p];
}));

test('discoverRooms admits through a bounded pool of 8: 20 clones run at most 8 for-each-refs at once (more than one), each clone once', async () => {
  assert.equal(ADMIT_POOL, 8);
  const canon = clones(20);
  const f = fakes({ canon, delayMs: () => 30 });
  const d = rooms(await discoverRooms([...canon.keys()], f.deps));
  assert.equal(d.rooms.length, 20);
  assert.equal(f.maxInFlight(), ADMIT_POOL, 'eight admissions at once, never more');
  assert.deepEqual([...f.seen].sort(), [...canon.keys()].map((p) => `${p}/.git`), 'one for-each-ref per clone');
  // Fewer clones than the pool: all at once.
  const three = fakes({ canon: clones(3), delayMs: () => 30 });
  rooms(await discoverRooms([...clones(3).keys()], three.deps));
  assert.equal(three.maxInFlight(), 3);
});

test('discoverRooms keeps the results by argument index: admissions that finish in any order give the sequential answer (sorted by label and canonical root)', async () => {
  const canon = clones(12);
  const repos = [...canon.keys()].reverse();
  // The first arguments answer last.
  const slowFirst = fakes({ canon, delayMs: (g) => 5 + 4 * Number(/c(\d+)/.exec(g)![1]) });
  const fastFirst = fakes({ canon, delayMs: (g) => 50 - 4 * Number(/c(\d+)/.exec(g)![1]) });
  const a = rooms(await discoverRooms(repos, slowFirst.deps));
  const b = rooms(await discoverRooms(repos, fastFirst.deps));
  assert.deepEqual(a, b);
  assert.deepEqual(a.rooms.map((r) => r.label), [...canon.keys()].map((p) => posix.basename(p)));
  assert.deepEqual(a.rooms.map((r) => r.id), [...canon.keys()].map((p) => roomId(SALT, p)));
  assert.equal(a.more, 0);
});

test('two spellings of one clone (one realpath of <path>/.git) run git once: the first spelling is admitted, the rest are dropped before any git runs', async () => {
  const canon = new Map([['/w/shop', '/w/shop'], ['/alias/shop', '/w/shop'], ['/w/other', '/w/other'], ['/w/./shop', '/w/shop']]);
  const f = fakes({ canon });
  const d = rooms(await discoverRooms(['/alias/shop', '/w/other', '/w/shop', '/w/shop/', '/w/./shop'], f.deps));
  assert.deepEqual(f.seen, ['/w/shop/.git', '/w/other/.git'], 'one for-each-ref per gitdir, in argument order');
  assert.deepEqual(d.rooms.map((r) => [r.label, r.gitDir, r.canonicalRoot]), [['other', '/w/other/.git', '/w/other'], ['shop', '/w/shop/.git', '/w/shop']]);
  assert.equal(d.more, 0);
});

test('any admission failure refuses RF_VIZ_REPO_NOT_LIVE, also one that throws (a git error, an unreadable .git), and no later admission starts after it', async () => {
  const canon = clones(20);
  const repos = [...canon.keys()];
  // A git failure in the first admission: the refusal, never the exception; the pool stops taking new arguments.
  const thrown = fakes({ canon, fails: new Set(['/w/c00/.git']), delayMs: (g) => (g === '/w/c00/.git' ? 1 : 40) });
  assert.deepEqual(await discoverRooms(repos, thrown.deps), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
  assert.equal(thrown.seen.length, ADMIT_POOL, `the eight started at once, and none after the failure: ${JSON.stringify(thrown.seen)}`);
  // The last argument failing still refuses (nothing is dropped).
  const last = fakes({ canon, fails: new Set(['/w/c19/.git']) });
  assert.deepEqual(await discoverRooms(repos, last.deps), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
  // realpath(<path>/.git) throwing: refused before any git runs.
  const unreadable = fakes({ canon, realpathFails: new Set(['/w/c07']) });
  assert.deepEqual(await discoverRooms(repos, unreadable.deps), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
  assert.deepEqual(unreadable.seen, []);
  // A path with no .git directory: refused, and no git runs either.
  const missing = fakes({ canon });
  assert.deepEqual(await discoverRooms([...repos, '/w/none'], missing.deps), { refuse: 'RF_VIZ_REPO_NOT_LIVE' });
  assert.deepEqual(missing.seen, []);
  // No argument: no rooms.
  assert.deepEqual(await discoverRooms([], fakes({ canon }).deps), { refuse: 'RF_VIZ_NO_ROOMS' });
});
