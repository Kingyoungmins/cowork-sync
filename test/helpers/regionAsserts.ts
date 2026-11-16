// Region read and write assertions (Plan 4 Task 4; INV-REG-READ, T-REG-27 (f), REG-35, R1-040; assertNoWrites is Task 5's).
// readGuard wraps a GitRepo so that every git call the region module makes through it is checked against the read contract;
// looseObjectCount counts the loose objects of a git dir (the "no object written" check); assertNoWrites (R2-M07) checks that a
// region verdict call leaves the registry head, the outbox, the state ref and the object store unchanged.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineCore } from '../../src/engine/core.js';
import { isOid } from '../../src/git/oid.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRepo, RepoContext } from '../../src/git/repo.js';
import type { SnapshotStore } from '../../src/regions/snapshots.js';

/** A git call that breaks INV-REG-READ. */
export class ReadGuardError extends Error {
  constructor(args: readonly string[], why: string) {
    super(`INV-REG-READ: git ${args.slice(0, 4).join(' ')}: ${why}`);
    this.name = 'ReadGuardError';
  }
}

type Exec = (args: string[], opts?: Partial<GitCallOptions>) => Promise<unknown>;

/**
 * INV-REG-READ (T-REG-27 (f)): fails any cat-file whose argv or stdin names a registered DiskSnapshotId oid, and any grep that
 * names neither a tree oid nor --cached; allows cat-file --batch* (oids on stdin, checked against the store), ls-tree <tree> and
 * check-attr --stdin under attr.tree (the region module's own reads). A check-attr that would read the working tree's
 * .gitattributes (no attr.tree) fails too. Every git call of GitRepo (run and the typed reads) passes through its one private
 * exec, which the wrapper intercepts; the wrapped repo is otherwise the same object.
 */
export function readGuard(repo: GitRepo, snapshots: SnapshotStore): GitRepo {
  const check = (target: GitRepo, args: readonly string[], opts: Partial<GitCallOptions>): void => {
    const sub = args[0];
    if (sub === 'cat-file') {
      const named = args.find((a) => isOid(a) && snapshots.has(a));
      if (named !== undefined) throw new ReadGuardError(args, `names the DiskSnapshotId oid ${named}`);
      if (opts.stdin !== undefined) {
        for (const line of opts.stdin.toString('latin1').split('\n')) {
          const first = line.split(' ')[0] ?? '';
          if (isOid(first) && snapshots.has(first)) throw new ReadGuardError(args, `reads the DiskSnapshotId oid ${first} on stdin`);
        }
      }
    } else if (sub === 'grep') {
      const end = args.indexOf('--');
      const head = end < 0 ? args : args.slice(0, end);
      if (!head.includes('--cached') && !head.some((a) => isOid(a))) throw new ReadGuardError(args, 'a grep that names neither a tree oid nor --cached reads the working tree');
    } else if (sub === 'check-attr') {
      const ctx = (Reflect.get(target, 'ctx') as () => RepoContext).call(target);
      if (opts.attrTree === undefined && ctx.attrTree === null) throw new ReadGuardError(args, 'check-attr without attr.tree reads the working tree');
    }
  };
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop !== 'exec' || typeof value !== 'function') return value;
      const exec = value as Exec;
      return (args: string[], opts: Partial<GitCallOptions> = {}): Promise<unknown> => {
        check(target, args, opts);
        return exec.call(receiver, args, opts);
      };
    },
  });
}

/** The loose objects under <gitDir>/objects/<2 hex>/. */
export async function looseObjectCount(gitDir: string): Promise<number> {
  const objects = join(gitDir, 'objects');
  let n = 0;
  for (const dir of await readdir(objects)) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    n += (await readdir(join(objects, dir))).length;
  }
  return n;
}

/** What R2-M07 says a verdict call never changes: the registry head, the outbox, the state ref and the loose objects. */
async function writeMarks(core: EngineCore): Promise<{ registryHead: string | null; outbox: unknown; stateRef: string | null; looseObjects: number }> {
  return {
    registryHead: core.holds.head(),
    outbox: JSON.parse(JSON.stringify(core.outbox.toJson())) as unknown,   // a copy: toJson shares the entries' draft and op objects
    stateRef: await core.repo.resolve(core.refs.state),
    looseObjects: await looseObjectCount(core.deps.paths.gitDir),
  };
}

/**
 * R2-M07 ("verdict functions create nothing"): snapshots the registry head, Outbox.toJson(), the state ref and looseObjectCount, runs
 * fn (awaited) and asserts all four unchanged — an AssertionError naming what moved otherwise. Task 5 runs it over the stub steps;
 * Tasks 10, 12 and 15 reuse it on the real functions.
 */
export async function assertNoWrites(core: EngineCore, fn: () => Promise<unknown> | unknown): Promise<void> {
  const before = await writeMarks(core);
  await fn();
  const after = await writeMarks(core);
  assert.deepEqual(after, before, 'R2-M07: a region verdict call changed the registry head, the outbox, the state ref or the object store');
}
