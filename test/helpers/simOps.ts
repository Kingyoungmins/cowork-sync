// Scripted SIM runs for the Plan 2 oracle and crash tests (Task 19): a script is a list of steps — an engine step of
// one peer, a wait (every peer clock moves), a row edit or file write on one peer's disk (the human's editor: test
// code, node:fs, mtime on the peer's virtual wall clock), a server-side board rewind, a human-typed recover — played by
// an OpGenerator, so the harness logs each one, runs the afterEveryOp oracles after it and keeps its determinism.
//
// The human-typed recover is the engine adapter's hook (RecoverableSimEngine.recover, test/sim/engineAdapter.ts): the
// Engine's own public verb, under its own daemon.lock, in its own queue, exactly what `daemon.js` does with an in-daemon
// recover request. A KilledAt inside the recover ends the call like any other crash (the adapter restarts the engine at
// the peer's next step). Nothing here patches a prototype.
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RecoverResult } from '../../src/engine/recover.js';
import { isRecoverable } from '../sim/engineAdapter.js';
import { healRemote, partitionRemote, type OpGenerator, type Oracle, type SimContext, type SimOp, type SimResult } from '../sim/harness.js';
import { currentRemoteDir } from '../sim/oracles.js';
import { removeKeptRoot } from './tmp.js';
import type { PeerClone } from '../sim/peers.js';

export type ScriptStep =
  | { iterate: number }
  | { wait: number }
  | { op: (ctx: SimContext) => SimOp }
  | { gen: OpGenerator; count?: number };

/** Plays `script` one step per harness step; an exhausted script (or a generator returning null) is an engine step of a random peer. */
export function scripted(script: readonly ScriptStep[]): OpGenerator {
  const flat: Array<Exclude<ScriptStep, { gen: OpGenerator; count?: number }> | { gen: OpGenerator }> = [];
  for (const s of script) {
    if ('gen' in s) for (let k = 0; k < (s.count ?? 1); k++) flat.push({ gen: s.gen });
    else flat.push(s);
  }
  return {
    next(ctx: SimContext, step: number): SimOp | null {
      const s = flat[step];
      if (s === undefined) return null;
      if ('iterate' in s) return iterateOp(ctx, s.iterate);
      if ('wait' in s) return { peer: '*', kind: 'wait', run: async (c) => { for (const k of c.clocks.values()) k.advance(s.wait); return `ms=${s.wait}`; } };
      if ('op' in s) return s.op(ctx);
      return s.gen.next(ctx, step);
    },
  };
}

function iterateOp(ctx: SimContext, i: number): SimOp {
  const peer = peerAt(ctx, i);
  return { peer: peer.name, kind: 'iterate', run: async (c) => { await engineAt(c, i).step(c); return 'step'; } };
}

/** `n` rounds: every peer clock moves `ms`, then every engine steps once in peer order. */
export function rounds(n: number, peers: number, ms = 2_500): ScriptStep[] {
  const out: ScriptStep[] = [];
  for (let r = 0; r < n; r++) {
    out.push({ wait: ms });
    for (let i = 0; i < peers; i++) out.push({ iterate: i });
  }
  return out;
}

export function peerAt(ctx: SimContext, i: number): PeerClone {
  const p = ctx.peers[i];
  if (p === undefined) throw new Error(`simOps: no peer ${i}`);
  return p;
}

function engineAt(ctx: SimContext, i: number) {
  const e = ctx.engines[i];
  if (e === undefined) throw new Error(`simOps: no engine ${i}`);
  return e;
}

const absPath = (p: PeerClone, path: string): string => join(p.dir, ...path.split('/'));

async function stamp(ctx: SimContext, p: PeerClone, abs: string, aheadMs = 0): Promise<void> {
  const c = ctx.clocks.get(p.name);
  if (c === undefined) throw new Error(`simOps: no clock for ${p.name}`);
  const t = (c.wallMs() + aheadMs) / 1_000;
  await utimes(abs, t, t);
}

/** Writes a new file (rows joined by the peer's checkout ending) on peer i; its directory gets the same mtime. */
export function writeFileStep(i: number, path: string, rows: readonly string[]): ScriptStep {
  return {
    op: (ctx) => {
      const p = peerAt(ctx, i);
      return {
        peer: p.name, kind: 'write_file',
        run: async (c) => {
          const eol = p.opts.autocrlf ? '\r\n' : '\n';
          const abs = absPath(p, path);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, Buffer.from(rows.map((r) => `${r}${eol}`).join(''), 'utf8'));
          await stamp(c, p, abs);
          await stamp(c, p, dirname(abs));
          return path;
        },
      };
    },
  };
}

/** Replaces row `row` of `path` on peer i, keeping the file's endings (CRLF when most rows end in CRLF). */
export function editRowStep(i: number, path: string, row: number, text: string): ScriptStep {
  return {
    op: (ctx) => {
      const p = peerAt(ctx, i);
      return {
        peer: p.name, kind: 'edit_row',
        run: async (c) => {
          const abs = absPath(p, path);
          const s = (await readFile(abs)).toString('utf8');
          const crlf = s.split('\r\n').length - 1;
          const eol = crlf > s.split('\n').length - 1 - crlf ? '\r\n' : '\n';
          const rows = s.split(/\r?\n/);
          const final = rows[rows.length - 1] === '';
          if (final) rows.pop();
          if (row < 0 || row >= rows.length) throw new Error(`simOps: ${p.name}:${path} has no row ${row}`);
          rows[row] = text;
          await writeFile(abs, Buffer.from(`${rows.join(eol)}${final ? eol : ''}`, 'utf8'));
          await stamp(c, p, abs);
          return `${path} row=${row}`;
        },
      };
    },
  };
}

/** Removes `path` on peer i (its directory's mtime on the peer clock). */
export function deleteFileStep(i: number, path: string): ScriptStep {
  return {
    op: (ctx) => {
      const p = peerAt(ctx, i);
      return {
        peer: p.name, kind: 'delete_file',
        run: async (c) => {
          const abs = absPath(p, path);
          await rm(abs, { force: true });
          await stamp(c, p, dirname(abs));
          return path;
        },
      };
    },
  };
}

/** Rewrites `path` on peer i with its own bytes and an mtime `aheadMs` in the peer's future: the quiet period excludes it (and the apply defers it) once. */
export function touchFutureStep(i: number, path: string, aheadMs: number): ScriptStep {
  return {
    op: (ctx) => {
      const p = peerAt(ctx, i);
      return {
        peer: p.name, kind: 'touch_future',
        run: async (c) => {
          const abs = absPath(p, path);
          await writeFile(abs, await readFile(abs));
          await stamp(c, p, abs, aheadMs);
          return `${path} ahead_ms=${aheadMs}`;
        },
      };
    },
  };
}

/**
 * F-BR-3's rewind fault, server-side: `update-ref <board> <board>~n <board>` in the bare remote (an ancestor on the
 * first-parent chain; the mirror is left as it is, as a host-side rewrite would). The post-receive log never sees it.
 */
export function rewindBoardStep(n: number, boardRef = 'refs/cowork/main/board'): ScriptStep {
  return {
    op: () => ({
      peer: '*', kind: 'rewind_board',
      run: async (c) => {
        const dir = await currentRemoteDir(c);
        const git = async (args: string[]): Promise<string> => {
          const r = await c.git.run(args, { class: 'local', cwd: dir });
          if (r.code !== 0) throw new Error(`git ${args.join(' ')} in the remote failed (${r.code}): ${r.stderr.toString('utf8')}`);
          return r.stdout.toString('utf8').trim();
        };
        const cur = await git(['rev-parse', '--verify', `${boardRef}^{commit}`]);
        const to = await git(['rev-parse', '--verify', `${cur}~${n}^{commit}`]);
        await git(['update-ref', boardRef, to, cur]);
        return `${boardRef} ${cur} -> ${to}`;
      },
    }),
  };
}

/** F-NET-5: the bare remote renamed away (fetches and pushes fail fast) until healStep. */
export function partitionStep(): ScriptStep {
  return { op: () => ({ peer: '*', kind: 'partition', run: async (c) => ((await partitionRemote(c)) ? 'remote renamed' : 'already partitioned') }) };
}

export function healStep(): ScriptStep {
  return { op: () => ({ peer: '*', kind: 'heal', run: async (c) => ((await healRemote(c)) ? 'remote restored' : 'not partitioned') }) };
}

// ---- the human-typed recover ----------------------------------------------------------------------------------------

function describe(r: RecoverResult): string {
  if (!r.ok) return `refused ${r.code}`;
  return `${r.done ? 'done' : 'preview'} ${r.preview.mode}`;
}

/**
 * `/cowork recover` then `--confirm=<id>` on peer i, through the engine adapter's own hook (RecoverableSimEngine.recover:
 * the Engine's public verb; a dead engine boots first). The detail lists each result (`preview restore done restore`,
 * `refused <code>`); an engine without the hook fails the run.
 */
export function recoverStep(i: number): ScriptStep {
  return {
    op: (ctx) => {
      const p = peerAt(ctx, i);
      return {
        peer: p.name, kind: 'recover',
        run: async (c) => {
          const engine = engineAt(c, i);
          if (!isRecoverable(engine)) throw new Error(`simOps: ${p.name}'s engine has no recover hook (RecoverableSimEngine)`);
          const out = await engine.recover(c);
          return out.length === 0 ? 'no recover ran (the engine died or was refused at boot)' : out.map(describe).join(' ');
        },
      };
    },
  };
}

// ---- observing oracles ----------------------------------------------------------------------------------------------

export interface Fired { step: number; phase: 'afterEveryOp' | 'atQuiescence'; message: string; }

/**
 * Wraps oracles so a run never stops on them: each one's first failure is recorded in `fired` (by oracle name) and
 * the run goes on, so a test can see every oracle a mutant trips, not only the first.
 */
export function observing(oracles: readonly Oracle[]): { oracles: Oracle[]; fired: Map<string, Fired> } {
  const fired = new Map<string, Fired>();
  const stepOf = (ctx: SimContext): number => ctx.opLog[ctx.opLog.length - 1]?.step ?? -1;
  const wrapped = oracles.map((o): Oracle => {
    const w: Oracle = { name: `observe:${o.name}` };
    const after = o.afterEveryOp;
    const atQ = o.atQuiescence;
    if (after !== undefined) {
      w.afterEveryOp = async (ctx) => {
        const m = await after.call(o, ctx);
        if (m !== null && !fired.has(o.name)) fired.set(o.name, { step: stepOf(ctx), phase: 'afterEveryOp', message: m });
        return null;
      };
    }
    if (atQ !== undefined) {
      w.atQuiescence = async (ctx) => {
        const m = await atQ.call(o, ctx);
        if (m !== null && !fired.has(o.name)) fired.set(o.name, { step: stepOf(ctx), phase: 'atQuiescence', message: m });
        return null;
      };
    }
    return w;
  });
  return { oracles: wrapped, fired };
}

/**
 * A failed run keeps its temp root (<makeTempRoot base>/<spaced dir>/artifacts): removeKeptRoot deletes that base only
 * when it is a marked makeTempRoot base in the system temp directory; any other path is left alone.
 */
export async function dropArtifacts(r: SimResult): Promise<void> {
  if (r.artifactsDir === undefined) return;
  await removeKeptRoot(r.artifactsDir);
}
