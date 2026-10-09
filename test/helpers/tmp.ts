// Test-only helpers: temp roots whose path contains a space and non-ASCII
// characters (Review Focus 1), and a git runner bound for tests.
import { mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { realClock, type Clock } from '../../src/ports/clock.js';
import { buildDaemonEnv } from '../../src/git/env.js';
import { createGitRunner, type GitRunner } from '../../src/git/runner.js';

const SPACED_SEGMENT = '공 백 dir';
/** makeTempRoot's marker in its base directory: removeKeptRoot deletes nothing without it. */
const ROOT_MARKER = '.cowork-temp-root';
const BASE_PREFIX = 'cowork-';

export async function makeTempRoot(label: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const safe = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  // realpath (native) expands Windows 8.3 short names and macOS /var -> /private/var,
  // so paths we compare against git output are the canonical spelling.
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), `${BASE_PREFIX}${safe}-`)));
  await writeFile(join(base, ROOT_MARKER), 'cowork temp root\n');
  const root = join(base, SPACED_SEGMENT);
  await mkdir(root, { recursive: true });
  return {
    root,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

/**
 * Deletes the kept makeTempRoot base that holds `inside` (a failed SIM run's artifacts directory, say) and returns true —
 * only when that base is a direct child of the system temp directory (real paths), is named `cowork-…` and holds
 * makeTempRoot's marker file. Anything else (a path outside the temp directory, the temp directory itself, a directory
 * makeTempRoot did not create, a missing path) is left alone and false is returned.
 */
export async function removeKeptRoot(inside: string): Promise<boolean> {
  let real: string;
  let tmp: string;
  try {
    real = await realpath(inside);
    tmp = await realpath(tmpdir());
  } catch {
    return false;
  }
  const rel = relative(tmp, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  const name = rel.split(sep)[0] as string;
  if (!name.startsWith(BASE_PREFIX) || name === '.' || name === '..') return false;
  const base = join(tmp, name);
  const marker = await lstat(join(base, ROOT_MARKER)).catch(() => null);
  if (marker === null || !marker.isFile()) return false;
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return true;
}

let emptyHooks: string | undefined;

function emptyHooksDir(): string {
  if (emptyHooks === undefined) {
    emptyHooks = join(realpathSync.native(tmpdir()), 'cowork-test-empty-hooks');
    mkdirSync(emptyHooks, { recursive: true });
  }
  return emptyHooks;
}

export function testRunner(clock?: Clock): GitRunner {
  return createGitRunner({
    clock: clock ?? realClock,
    hooksPath: emptyHooksDir(),
    daemonEnv: buildDaemonEnv(process.env as Record<string, string | undefined>, []),
    testBuild: true,
  });
}
