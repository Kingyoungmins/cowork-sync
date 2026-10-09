// A real clone on a file:// bare remote with a GitRepo bound to it (Plan 2 Task 2).
// Temp roots come from makeTempRoot (space and Hangul in the path); git is never mocked.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepo, type RepoContext, type RepoPaths } from '../../src/git/repo.js';
import type { GitRunner } from '../../src/git/runner.js';
import { createBareRemote, type BareRemote } from '../sim/remote.js';
import { clonePeer, seedRemote, type PeerClone } from '../sim/peers.js';
import { makeTempRoot, testRunner } from './tmp.js';

export interface RepoFixture {
  root: string;
  remote: BareRemote;
  peer: PeerClone;
  repo: GitRepo;
  paths: RepoPaths;
  runner: GitRunner;
  cleanup(): Promise<void>;
}

/** The commit identity and fixed virtual date every fixture GitRepo uses. */
export const FIXTURE_IDENTITY = { name: 'Fixture Peer', email: 'peer1@cowork.invalid' } as const;
export const FIXTURE_WALL_MS = 1_700_000_000_000;

export function fixtureContext(): RepoContext {
  return { attrTree: null, filterDrivers: [], identity: { ...FIXTURE_IDENTITY }, wallMs: () => FIXTURE_WALL_MS };
}

const DEFAULT_FILES: Record<string, Buffer> = {
  'README.md': Buffer.from('# fixture\n', 'utf8'),
  'src/a.txt': Buffer.from('one\ntwo\nthree\n', 'utf8'),
  'src/b.txt': Buffer.from('alpha\nbeta\n', 'utf8'),
};

export async function makeRepoFixture(
  label: string,
  opts: { files?: Record<string, Buffer>; autocrlf?: boolean; filter?: boolean } = {},
): Promise<RepoFixture> {
  const { root, cleanup } = await makeTempRoot(label);
  try {
    const runner = testRunner();
    const remote = await createBareRemote(root, runner);
    await seedRemote(remote, root, runner, opts.files ?? DEFAULT_FILES);
    const peer = await clonePeer(remote, root, { name: 'p1', autocrlf: opts.autocrlf ?? false, withFilter: opts.filter ?? false }, runner);
    const workTree = realpathSync.native(peer.dir);
    const paths: RepoPaths = { workTree, gitDir: join(workTree, '.git'), coworkDir: join(workTree, '.git', 'cowork') };
    const repo = new GitRepo(runner, paths, fixtureContext);
    return { root, remote, peer, repo, paths, runner, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
