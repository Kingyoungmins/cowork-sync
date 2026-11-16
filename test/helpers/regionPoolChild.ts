// A child process of test/integration/regionDeps.test.ts (Plan 4 Task 5; R4-78, B3-05, X-34): it binds the PRODUCTION region pool
// (productionRegionDeps over a real build in <outdir>: two worker_threads on <outdir>/worker.js) and returns from its top level
// without process.exit. Live worker threads keep a Node process alive, so the parent's "the child exited on its own within the
// timeout" is the check that no thread remains (an in-process test cannot see another module's Worker objects).
//   pool <outdir>                 productionRegionDeps, every grammar 'ok', then close()
//   daemon <outdir> <c1> <c2>     runDaemon in-process over that pool: a run stopped right after its start (the stop handler is
//                                 what SIGINT calls), a start refused after the pool was built (c2's HEAD is detached), and two
//                                 refusals before it (daemon.lock held by a planted second daemon; a missing repo)
// One JSON line per case on stdout; any failure sets a non-zero exit code. Test code only: git is never mocked.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDaemon, type DaemonArgs, type DaemonIo, type DaemonRegionDeps } from '../../src/daemon/run.js';
import type { RegionDeps } from '../../src/engine/deps.js';
import { DaemonLock } from '../../src/engine/loop.js';
import { productionRegionDeps } from '../../src/engine/regionDeps.js';
import { realClock } from '../../src/ports/clock.js';
import { realFs } from '../../src/ports/fs.js';
import { PLUGIN_VERSION } from '../../src/version.js';

const [mode, outdir, c1, c2] = process.argv.slice(2);

/** One region binding over the build in `outdir`, counting its calls and the pool's close() calls. */
interface Counted { factory: DaemonRegionDeps; calls(): number; closes(): number; linesAtClose(): readonly string[] | null; }
function counted(dist: string, lines: readonly string[], onSecurityLog?: (log: RegionDeps['securityLog']) => void): Counted {
  let calls = 0;
  let closes = 0;
  let atClose: string[] | null = null;
  return {
    factory: async (o) => {
      calls += 1;
      onSecurityLog?.(o.securityLog);
      const d = await productionRegionDeps({ ...o, distDir: dist });
      const close = d.workers.close.bind(d.workers);
      return {
        ...d,
        workers: {
          run: d.workers.run.bind(d.workers),
          availability: d.workers.availability.bind(d.workers),
          close: async () => {
            closes += 1;
            atClose = [...lines];
            await close();
          },
        },
      };
    },
    calls: () => calls,
    closes: () => closes,
    linesAtClose: () => atClose,
  };
}

function args(repo: string): DaemonArgs {
  return { cmd: 'run', repo, branch: 'main', publish: null, name: 'Tester', remote: null, confirm: null, id: null, verb: null, dataDir: null, pluginRoot: null, spawned: false };
}

/** The daemon's environment: this process's, without proxies and ssh overrides (as daemon.cli.test.ts builds it). */
function daemonEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|git_ssh_command|git_ssh|git_ssh_variant)$/i.test(k)) delete env[k];
  return env;
}

/** A DaemonIo recording every line; `stopOnStart` calls the registered stop handler (SIGINT's) once the start line is printed. */
function io(lines: string[], stopOnStart: boolean): DaemonIo {
  let stop: (() => void) | null = null;
  return {
    out: (l) => {
      lines.push(l);
      if (stopOnStart && l.startsWith('started ')) stop?.();
    },
    err: (l) => lines.push(l),
    onStop: (cb) => {
      stop = cb;
    },
  };
}

async function poolCase(dist: string): Promise<void> {
  const securityLog = { write: (): void => undefined };
  const d = await productionRegionDeps({ fs: realFs, clock: realClock, distDir: dist, securityLog });
  const av = [...d.workers.availability().values()];
  await d.workers.close();
  process.stdout.write(`pool ${av.length === 5 && av.every((v) => v === 'ok') ? 'ok' : `not-ok ${av.join(',')}`} closed\n`);
}

async function daemonCases(dist: string, run1: string, refused: string): Promise<void> {
  // 1. A run stopped right after its start: the drain prints 'stopped' before the pool closes, exactly once.
  {
    const lines: string[] = [];
    let wrote = false;
    const c = counted(dist, lines, (log) => {
      if (!wrote) log.write('security', 'TEST_SECURITY_LINE', { n: 1 });
      wrote = true;
    });
    const code = await runDaemon(args(run1), daemonEnv(), io(lines, true), { regionDeps: c.factory });
    const security = (await readFile(join(realpathSync.native(run1), '.git', 'cowork', 'log', 'security.jsonl'), 'utf8').catch(() => ''))
      .split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { code: string }).code);
    const atClose = c.linesAtClose();
    process.stdout.write(`${JSON.stringify({ case: 'run', code, calls: c.calls(), closes: c.closes(), stoppedBeforeClose: atClose?.includes('stopped') ?? false, security, lines })}\n`);
  }
  // 2. A start refused after the pool was built (Engine.start: a detached HEAD): the pool closes exactly once.
  {
    const lines: string[] = [];
    const c = counted(dist, lines);
    const code = await runDaemon(args(refused), daemonEnv(), io(lines, false), { regionDeps: c.factory });
    process.stdout.write(`${JSON.stringify({ case: 'refused_after', code, calls: c.calls(), closes: c.closes(), lines })}\n`);
  }
  // 3. daemon.lock held by a planted second daemon: the refusal comes before the pool, so no thread is ever spawned.
  {
    const lines: string[] = [];
    const c = counted(dist, lines);
    const planted = await DaemonLock.acquire(realFs, join(realpathSync.native(run1), '.git', 'cowork'), { pluginVersion: PLUGIN_VERSION, instance: 'planted-second-daemon' });
    if (!(planted instanceof DaemonLock)) throw new Error('the planted daemon.lock could not be taken');
    try {
      const code = await runDaemon(args(run1), daemonEnv(), io(lines, false), { regionDeps: c.factory });
      process.stdout.write(`${JSON.stringify({ case: 'lock_held', code, calls: c.calls(), closes: c.closes(), lines })}\n`);
    } finally {
      await planted.release();
    }
  }
  // 4. A missing repository (START_REPO_SHAPE): refused before the pool too.
  {
    const lines: string[] = [];
    const c = counted(dist, lines);
    const code = await runDaemon(args(join(run1, 'no-such-repo')), daemonEnv(), io(lines, false), { regionDeps: c.factory });
    process.stdout.write(`${JSON.stringify({ case: 'no_repo', code, calls: c.calls(), closes: c.closes(), lines })}\n`);
  }
}

try {
  if (mode === 'pool' && outdir !== undefined) await poolCase(outdir);
  else if (mode === 'daemon' && outdir !== undefined && c1 !== undefined && c2 !== undefined) await daemonCases(outdir, c1, c2);
  else throw new Error(`usage: regionPoolChild.ts pool <outdir> | daemon <outdir> <clone1> <clone2> (got ${process.argv.slice(2).join(' ')})`);
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exitCode = 1;
}
