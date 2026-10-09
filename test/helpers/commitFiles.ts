// Test helper: a parentless commit holding exactly the given files (stands in for EPOCH_BASE).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Oid } from '../../src/git/oid.js';
import type { FileMode } from '../../src/git/repo.js';
import type { RepoFixture } from './repoFixture.js';

let counter = 0;

export async function commitFiles(f: RepoFixture, files: Record<string, string | Buffer>, parent: Oid | null = null): Promise<Oid> {
  await mkdir(join(f.paths.coworkDir, 'tmp'), { recursive: true });
  const scratch = join(f.paths.coworkDir, 'tmp', `commitfiles-${process.pid}-${counter++}.idx`);
  const entries = new Map<string, { path: string; mode: FileMode; oid: Oid }>();
  for (const [path, bytes] of Object.entries(files)) {
    const oid = await f.repo.hashBytes(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes, true);
    entries.set(path, { path, mode: '100644', oid });
  }
  const tree = await f.repo.writeTreeMap(entries, scratch);
  return f.repo.commitTree({ tree, parents: parent === null ? [] : [parent], subject: 'epoch base', trailers: [] });
}
