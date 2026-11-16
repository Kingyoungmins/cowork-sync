// The partial-type grep (Plan 4 Task 6; 04 §3.12, §6 row "Partial-type grep fails/times out", §8 Q8; REG-17, R2-H01,
// R4-44, R4-45, glossary §26.1 W6; T-REG-10 git-grep part). Real git on a file:// fixture clone: a private index built by
// read-tree of a commit, a spy GitRunner under the GitRepo that records every call, and the runner's own argv builder
// (buildGitInvocation) applied test-side to the recorded call to see the forced -c list.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttrSnapshot } from '../../src/data/attrs.js';
import { buildGitInvocation, type GitBase, type GitCallOptions } from '../../src/git/flags.js';
import { parseOid } from '../../src/git/oid.js';
import { GitRepo } from '../../src/git/repo.js';
import type { GitResult, GitRunner } from '../../src/git/runner.js';
import type { Clock } from '../../src/ports/clock.js';
import { BUDGETS, clockBudgets, testBudgetInjector, type BudgetInjector } from '../../src/regions/budgets.js';
import { TableCache } from '../../src/regions/cache.js';
import { groupNameHit } from '../../src/regions/groupName.js';
import { lineArray, rangesIntersect } from '../../src/regions/lines.js';
import { hunks } from '../../src/regions/mapper.js';
import { declaresPartial, partialTypeFiles } from '../../src/regions/partial.js';
import type { RegionWorkers } from '../../src/regions/pool.js';
import { RegionService } from '../../src/regions/service.js';
import { SnapshotStore } from '../../src/regions/snapshots.js';
import type { Unit } from '../../src/regions/types.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { looseObjectCount, readGuard } from '../helpers/regionAsserts.js';
import { fixture } from '../helpers/regionFixtures.js';
import { testTable } from '../helpers/regionRuntime.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';
import { VirtualClock } from '../sim/vclock.js';

const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const HANGUL_CS = '\u{D55C}\u{AE00}.cs';
/** R4-44, R4-45: the spec's pattern with its trailing \b spelled ([^[:alnum:]_]|$). */
const SVC_PATTERN = 'partial[[:space:]]+(class|struct|record|interface)[[:space:]]+Svc([^[:alnum:]_]|$)';

const PART2 = u8('namespace N\n{\n    public partial record Svc\n    {\n        public string Name() => "svc";\n    }\n}\n');
const OTHER = u8('namespace N\n{\n    public partial class Svc2\n    {\n    }\n\n    public partial class SvcExtra\n    {\n    }\n}\n');
const FILES: Record<string, Buffer> = {
  'Svc.cs': fixture('csharp/Svc.cs'),               // `public partial class Svc` at the end of its row
  'Svc.Part2.cs': PART2,                            // `partial record Svc` at the end of its row
  'Other.cs': OTHER,                                // `partial class Svc2`, `partial class SvcExtra`: no match
  'a[b] c.cs': u8('namespace N\n{\n    partial class Svc{ }\n}\n'),
  [HANGUL_CS]: u8('namespace N\n{\n    public partial  struct Svc<T>\n    {\n    }\n\n    public partial class \u{D55C}\u{AE00}\n    {\n    }\n}\n'),
};

interface Call { readonly args: readonly string[]; readonly opts: GitCallOptions; result?: GitResult; }

let f: RepoFixture;
let privateIndex: string;
let hooksPath: string;
let gitEnv: Record<string, string>;

before(async () => {
  f = await makeRepoFixture('partial-grep');
  // a private HOME and global config (as test/helpers/hermetic.ts): the developer's git config never reaches the grep
  const home = join(f.root, 'hermetic home');
  mkdirSync(join(home, 'xdg config', 'git'), { recursive: true });
  writeFileSync(join(home, 'gitconfig'), '');
  gitEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'xdg config'), GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  hooksPath = join(f.root, 'no hooks');
  const commit = await commitFiles(f, FILES);
  privateIndex = join(f.paths.coworkDir, 'private.index');
  await f.repo.run(['read-tree', commit], { class: 'refupdate', indexFile: privateIndex });
});

after(async () => {
  await f.cleanup();
});

/** A GitRepo over the fixture clone whose runner records every call (and its result) before git runs; `hold` replaces git for a call. */
function spyRepo(calls: Call[], hold?: (args: readonly string[], opts: GitCallOptions) => Promise<GitResult> | null): GitRepo {
  const runner: GitRunner = {
    run: async (args, opts) => {
      const call: Call = { args: [...args], opts };
      calls.push(call);
      const held = hold?.(args, opts) ?? null;
      call.result = await (held ?? f.runner.run(args, { ...opts, extraEnv: { ...(opts.extraEnv ?? {}), ...gitEnv } }));
      return call.result;
    },
  };
  return new GitRepo(runner, f.paths, fixtureContext);
}

const noWorkers: RegionWorkers = {
  run: () => Promise.reject(new Error('the partial grep runs no worker job')),
  availability: () => new Map(),
  close: async () => undefined,
};

/** The default clock never moves (its sleeps wait for an advance no test makes): as under SIM, no budget expires unless injected,
 *  so a slow git spawn on a loaded machine cannot turn these greps into timeouts. */
function serviceOf(repo: GitRepo, o: { clock?: Clock; inject?: BudgetInjector; index?: string } = {}): RegionService {
  const clock = o.clock ?? gatedClock().clock;
  return new RegionService({
    repo, workers: noWorkers, budgets: clockBudgets(clock, o.inject), cache: new TableCache(), snapshots: new SnapshotStore(), regionSpec: 'a'.repeat(64),
    log: { write: (_l, code) => { throw new Error(`unexpected log line ${code}`); } }, clock,
    attrs: (): Promise<AttrSnapshot> => Promise.reject(new Error('no attributes are read')),
    privateIndex: o.index ?? privateIndex,
    onBudget: (path, b) => { throw new Error(`unexpected REGION_BUDGET ${path} ${b}`); },
  });
}

test("partialTypeFiles greps the private index with the spec's pattern", async () => {
  const calls: Call[] = [];
  const s = serviceOf(spyRepo(calls));
  assert.deepEqual(await partialTypeFiles(s, 'Svc'), { simpleName: 'Svc', files: ['Svc.Part2.cs', 'Svc.cs', 'a[b] c.cs', HANGUL_CS], failed: false });
  assert.equal(calls.length, 1);
  const [call] = calls as [Call];
  // the pattern rides behind -e: git 2.55 refuses an option after the first non-option argument ("--cached must come before");
  // --text: every match is a `path NUL line NUL text LF` record, never a NUL-free "Binary file … matches" line (fix r1)
  assert.deepEqual(call.args, ['grep', '-z', '-n', '--text', '--no-color', '-E', '-e', SVC_PATTERN, '--cached']);
  assert.equal(call.opts.indexFile, privateIndex);
  assert.equal(call.opts.config, undefined, 'no RunOpts.config (core.quotepath is a forced key, R4-44)');
  assert.ok(call.opts.abort instanceof AbortSignal, 'the grep carries GitCallOptions.abort');
  const inv = buildGitInvocation([...call.args], call.opts, { hooksPath, platform: process.platform, daemonEnv: {}, testBuild: true } satisfies GitBase);
  const quotepath = inv.argv.flatMap((a, i) => (a === 'core.quotepath=off' && inv.argv[i - 1] === '-c' ? [i] : []));
  assert.equal(quotepath.length, 1, "exactly one -c core.quotepath=off: the runner's forced pair");
  assert.equal(inv.argv.filter((a) => a.toLowerCase().startsWith('core.quotepath')).length, 1);
  assert.equal(inv.env.GIT_INDEX_FILE, privateIndex);

  // no match is exit 1: an answer, not a failure
  assert.deepEqual(await partialTypeFiles(s, 'Nope'), { simpleName: 'Nope', files: [], failed: false });
  assert.equal(calls.at(-1)?.result?.code, 1);
  // a name that is not a C# identifier never reaches the argv: the grep is a failure (P2: the whole-file fallback)
  const before = calls.length;
  for (const bad of ['Svc<T>', '-e', 'a b', '1Svc', '', 'S.c', '@class']) {
    assert.deepEqual(await partialTypeFiles(s, bad), { simpleName: bad, files: [], failed: true }, JSON.stringify(bad));
  }
  assert.equal(calls.length, before, 'no git call for a refused name');
  // Task 4's table spells a verbatim identifier with its '@' (`partial class @class` → simple '@class'): the grep refuses it,
  // so the failure fallback's one sensor is declaresPartial's literal match, which must keep catching it (no identifier check there)
  assert.equal(declaresPartial(u8('    public partial class @class\n'), '@class'), true);
  // a non-ASCII identifier is greppable (its UTF-8 bytes match literally under LC_ALL=C)
  assert.deepEqual(await partialTypeFiles(s, '\u{D55C}\u{AE00}'), { simpleName: '\u{D55C}\u{AE00}', files: [HANGUL_CS], failed: false });
  // under LC_ALL=C no non-ASCII byte is [[:alnum:]], so a name followed by a non-ASCII letter still matches: more files, never fewer
  assert.deepEqual(await partialTypeFiles(s, '\u{D55C}'), { simpleName: '\u{D55C}', files: [HANGUL_CS], failed: false });
  assert.equal(declaresPartial(FILES[HANGUL_CS] as Buffer, '\u{D55C}'), true, 'declaresPartial agrees with the grep');
});

test("a user's color.ui=always / color.grep=always never reaches the -z records: the grep runs --no-color", async () => {
  // Without --no-color, ESC sequences wrap the path and line-number fields and every partial grep fails (failed:true, the
  // whole-file fallback for every C# partial type); before fix r1's grammar check they leaked as garbage paths (re-review r1).
  const global = gitEnv.GIT_CONFIG_GLOBAL as string;
  writeFileSync(global, '[color]\n\tui = always\n\tgrep = always\n');
  try {
    const calls: Call[] = [];
    assert.deepEqual(await partialTypeFiles(serviceOf(spyRepo(calls)), 'Svc'), { simpleName: 'Svc', files: ['Svc.Part2.cs', 'Svc.cs', 'a[b] c.cs', HANGUL_CS], failed: false });
    assert.ok(calls.at(-1)?.args.includes('--no-color'));
  } finally {
    writeFileSync(global, '');
  }
});

test('the -z records are parsed NUL-first: a newline in a path, a -diff file and a binary blob come back verbatim', async () => {
  // A teammate's commit can carry any of these into the private index: the engine reads trees there with core.protectNTFS=false
  // (src/engine/snapshot.ts INDEX_ONLY_CONFIG), so even git for Windows keeps `Svc\nNew.cs`. The tree is built with mktree and read
  // with the same config (PF-10: update-index drops such names; read-tree without it exits 128 "invalid path").
  const svc = u8('namespace N\n{\n    public partial class Svc\n    {\n    }\n}\n');
  const nul = Buffer.from([0x00]);
  const entries: ReadonlyArray<readonly [string, Buffer]> = [
    // without --text git reports a -diff file (a class-4 text file with a table: WinForms' partial Form1.Designer.cs) and a binary blob
    // as a NUL-free "Binary file … matches" line, which an LF-first parse dropped and a NUL-first parse would glue onto the next path
    ['.gitattributes', u8('*.Designer.cs -diff\n')],
    // a binary blob whose matching row holds NULs, one of them followed by digits and a NUL: the row's text ends at its LF, not at a NUL
    ['Bin.cs', Buffer.concat([u8('x'), nul, u8('y\npartial class Svc '), nul, u8(' 12'), nul, u8(' tail\n')])],
    ['Form1.Designer.cs', u8('namespace N\n{\n    partial class Svc\n    {\n    }\n}\n')],
    ['Plain.cs', u8('class Plain { }\n')],
    ['Svc\nNew.cs', svc],
    ['Svc.cs', svc],
  ];
  const tree = await f.repo.mktree(await Promise.all(entries.map(async ([name, bytes]) => ({ name, mode: '100644' as const, type: 'blob' as const, oid: await f.repo.hashBytes(bytes, true) }))));
  const index = join(f.paths.coworkDir, 'newline.index');
  await f.repo.run(['read-tree', tree], { class: 'refupdate', indexFile: index, config: { 'core.protectNTFS': 'false' } });
  const calls: Call[] = [];
  const s = serviceOf(spyRepo(calls), { index });
  assert.deepEqual(await partialTypeFiles(s, 'Svc'), { simpleName: 'Svc', files: ['Bin.cs', 'Form1.Designer.cs', 'Svc\nNew.cs', 'Svc.cs'], failed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.result?.stderr.length, 0, 'a clean grep: nothing on stderr');

  // output outside the record grammar (a NUL-free line, a record without its LF, a line number that is not digits) is a failure, never a partial list
  const malformed = [
    Buffer.concat([u8('Svc.cs'), nul, u8('3'), nul, u8('    public partial class Svc\nBinary file Bin.cs matches\n')]),
    Buffer.concat([u8('Svc.cs'), nul, u8('3'), nul, u8('    public partial class Svc')]),
    Buffer.concat([u8('Svc.cs'), nul, u8('x'), nul, u8('    public partial class Svc\n')]),
    Buffer.concat([nul, u8('3'), nul, u8('    public partial class Svc\n')]),
  ];
  for (const stdout of malformed) {
    const canned = (): Promise<GitResult> => Promise.resolve({ code: 0, stdout, stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: false, durationMs: 0 });
    assert.deepEqual(await partialTypeFiles(serviceOf(spyRepo([], canned), { index }), 'Svc'), { simpleName: 'Svc', files: [], failed: true }, JSON.stringify(stdout.toString('latin1')));
  }
});

/** The leaf unit of a C# table with this qualname and disc. */
function unit(units: readonly Unit[], qualname: string, disc: string): Unit {
  const u = units.find((x) => x.leaf && x.label.qualname === qualname && x.label.disc === disc);
  assert.ok(u !== undefined, `${qualname}#${disc}`);
  return u;
}

test("an index entry naming a missing object makes the grep fail, never 'no conflict'", async () => {
  const ghostIndex = join(f.paths.coworkDir, 'ghost.index');
  copyFileSync(privateIndex, ghostIndex);
  const missing = parseOid('deadbeef'.repeat(5));
  assert.equal(await f.repo.hasObject(missing, 'blob'), false);
  await f.repo.run(['update-index', '--add', '--cacheinfo', `100644,${missing},Ghost.cs`], { class: 'refupdate', indexFile: ghostIndex });
  const calls: Call[] = [];
  const info = await partialTypeFiles(serviceOf(spyRepo(calls), { index: ghostIndex }), 'Svc');
  assert.deepEqual(info, { simpleName: 'Svc', files: [], failed: true });
  assert.equal(calls.length, 1);
  // git reports the unreadable blob on stderr (measured on 2.55: exit 0 while other files match, 1 when none do)
  assert.ok((calls[0]?.result?.stderr.length ?? 0) > 0, 'git wrote the missing object to stderr');

  // the 04 §3.12 fallback: every hunk of a file whose post bytes declare a partial part of the type touches a claim on it
  const claimed = [unit((await testTable('Svc.cs', FILES['Svc.cs'] as Buffer)).units, 'N.Svc.Calc', '(int)')];
  const addMethod = (bytes: Buffer, method: string): Buffer => {
    const s = bytes.toString('utf8');
    const at = s.lastIndexOf('    }\n}\n');
    return u8(`${s.slice(0, at)}\n        public void ${method}()\n        {\n        }\n${s.slice(at)}`);
  };
  for (const [path, base, method, expect] of [['Svc.Part2.cs', PART2, 'Name2', true], ['Other.cs', OTHER, 'Helper', false]] as const) {
    const post = addMethod(base, method);
    const hs = hunks(lineArray(base), lineArray(post));
    const postTable = await testTable(path, post);
    const added = postTable.units.filter((u) => u.leaf && hs.some((h) => h.bLo <= h.bHi && rangesIntersect(u.ranges, [[h.bLo, h.bHi]])));
    assert.ok(added.some((u) => u.label.simple === method), `${path}: ${method} is added`);
    assert.equal(groupNameHit('c_sharp', added, claimed, info, { path, fileDeclaresPartial: declaresPartial(post, 'Svc') }), expect, path);
  }
});

/** A virtual clock whose sleeps wait until the test advances it past their end (VirtualClock.sleep would advance it itself). */
function gatedClock(): { clock: Clock; sleeps: number[]; advance(ms: number): void } {
  const virtual = new VirtualClock();
  const waiting: Array<{ until: number; release(): void }> = [];
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      monoMs: () => virtual.monoMs(),
      wallMs: () => virtual.wallMs(),
      sleep: (ms: number) => new Promise<void>((release) => {
        sleeps.push(ms);
        waiting.push({ until: virtual.monoMs() + Math.max(0, ms), release });
      }),
    },
    advance(ms: number): void {
      virtual.advance(ms);
      for (const w of waiting.splice(0)) {
        if (w.until <= virtual.monoMs()) w.release();
        else waiting.push(w);
      }
    },
  };
}

/** Lets every pending promise callback and I/O callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('a grep past its 100 ms budget is a failure', async () => {
  const injected: Call[] = [];
  const inject = testBudgetInjector();
  inject.expire('partial_grep', 1);
  assert.deepEqual(await partialTypeFiles(serviceOf(spyRepo(injected), { inject }), 'Svc'), { simpleName: 'Svc', files: [], failed: true });
  assert.equal(injected.length, 0, 'an expired deadline runs no git');

  // the runner withholds the grep's result until its AbortSignal fires; the deadline fires the signal through the Clock port
  const gate = gatedClock();
  const calls: Call[] = [];
  const withheld = (_args: readonly string[], opts: GitCallOptions): Promise<GitResult> => new Promise((resolve) => {
    opts.abort?.addEventListener('abort', () => resolve({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), killedByWatchdog: false, aborted: true, durationMs: 0 }), { once: true });
  });
  let done = false;
  const pending = partialTypeFiles(serviceOf(spyRepo(calls, withheld), { clock: gate.clock }), 'Svc').finally(() => {
    done = true;
  });
  await settle();
  assert.equal(calls.length, 1);
  const signal = calls[0]?.opts.abort;
  assert.ok(signal instanceof AbortSignal, 'the call passes GitCallOptions.abort');
  assert.deepEqual(gate.sleeps, [BUDGETS.partialGrepMs], 'the deadline waits on the Clock port');
  gate.advance(BUDGETS.partialGrepMs - 1);
  await settle();
  assert.equal(done, false, 'pending at +99 ms');
  assert.equal(signal.aborted, false);
  gate.advance(1);
  await settle();
  assert.equal(signal.aborted, true, 'the signal fires at +100 ms');
  assert.deepEqual(await pending, { simpleName: 'Svc', files: [], failed: true }, "the runner's aborted result is a failure (its exit code 1 is no 'no match')");
});

const refsOf = async (): Promise<string> => (await f.repo.run(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.toString('utf8');

test('the partial grep reads only the index and writes nothing', async () => {
  const calls: Call[] = [];
  const snapshots = new SnapshotStore();
  const s = serviceOf(readGuard(spyRepo(calls), snapshots));
  for (const name of ['Svc', 'Nope', 'Svc2']) {
    const index = readFileSync(privateIndex);
    const refs = await refsOf();
    const objects = await looseObjectCount(f.paths.gitDir);
    const r = await partialTypeFiles(s, name);
    assert.equal(r.failed, false, name);
    assert.ok(calls.at(-1)?.args.includes('--cached'), 'the argv carries --cached');
    assert.ok(readFileSync(privateIndex).equals(index), `${name}: the private index is unchanged`);
    assert.equal(await refsOf(), refs, `${name}: no ref changed`);
    assert.equal(await looseObjectCount(f.paths.gitDir), objects, `${name}: no object was written`);
  }
  assert.deepEqual(calls.map((c) => c.args[0]), ['grep', 'grep', 'grep']);
  // Svc2 has its own partial declaration in Other.cs
  assert.deepEqual((await partialTypeFiles(s, 'Svc2')).files, ['Other.cs']);
});
