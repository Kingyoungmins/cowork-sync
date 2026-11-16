// test/helpers/liveRepo.ts — Plan 5 Task 5 (A5-9, plan 2322-2323): setupLiveRepo(peerRoot, o?) → LiveRepo.
// Creates <dataDir> (default <peerRoot>-data), createIpcKey unless withKey === false, and writes
// <gitdir>/cowork/live holding the main-worktree root in canonical form plus '\n' (R5-17, R5-18 test
// side). peerRoot must already be a git work tree (the fixtures' or a loaderRepo's dir). The return is
// the plan's LiveRepo with the key and endpoint added (additive: the harness binds ClaudeDaemonDeps with
// them; readIpcKey would recover the key, endpointOf would recompute the endpoint).
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonRoot, endpointRoot, type LiveRepo } from '../../src/data/canonRoot.js';
import { realFs, realRootProbe } from '../../src/ports/fs.js';
import { realRandom } from '../../src/ports/random.js';
import { createIpcKey, type KeyDeps } from '../../src/sec/ipcKey.js';
import { realWinAcl } from '../../src/sec/winAcl.js';
import { endpointOf } from './loaderRun.js';

export const PLATFORM = process.platform;

export async function setupLiveRepo(peerRoot: string, o?: { dataDir?: string; withKey?: boolean; live?: boolean }):
Promise<LiveRepo & { key: Buffer | null; endpoint: string | null }> {
  if (!existsSync(join(peerRoot, '.git'))) {
    throw new TypeError(`setupLiveRepo: ${peerRoot} is not a git work tree`);
  }
  const root = canonRoot(realpathSync.native(peerRoot), realRootProbe, PLATFORM);
  const gitdir = join(realpathSync.native(peerRoot), '.git');
  const coworkDir = join(gitdir, 'cowork');
  mkdirSync(coworkDir, { recursive: true });
  const dataDir = o?.dataDir ?? `${peerRoot}-data`;
  const keyDeps: KeyDeps = { fs: realFs, random: realRandom, platform: PLATFORM, uid: process.getuid?.() ?? null, acl: realWinAcl };
  let key: Buffer | null = null;
  if (o?.withKey !== false) key = await createIpcKey(dataDir, keyDeps);
  else mkdirSync(dataDir, { recursive: true });
  if (o?.live !== false) writeFileSync(join(coworkDir, 'live'), `${root}\n`);
  const eroot = endpointRoot(gitdir, realRootProbe, PLATFORM);
  return {
    root, gitdir, coworkDir, dataDir, endpointRoot: eroot,
    key, endpoint: key === null ? null : await endpointOf(key, gitdir),
  };
}
