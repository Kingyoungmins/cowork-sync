// Plants for the INV-NOLOSS and held-secret oracle tests (Plan 3 Task 15; TC-TST-02 form): a scratch copy of the bare remote whose board
// tip is rewritten (held/<id>/ removed, the live code commit's tree changed), a view of a running SimContext over that copy and over an
// edited trace, and a per-instance inspect() wrapper. Plants never touch the run's own remote: an oracle judges the view.
import { cp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refNames, RELEASE_NAMESPACE } from '../../src/engine/refs.js';
import type { Engine, EngineInspection } from '../../src/engine/loop.js';
import type { GitRunner } from '../../src/git/runner.js';
import { isTerminal, type HoldRecord } from '../../src/holds/record.js';
import type { TraceEvent } from '../../src/ports/trace.js';
import { realEngineOf } from '../sim/engineAdapter.js';
import { advanceClocks, type Oracle, type SimContext } from '../sim/harness.js';
import { readRegistry } from '../sim/holdsView.js';
import { findMarkers, type MarkerModel } from '../sim/markers.js';
import { locateMarker, type NolossFound } from '../sim/oracleNoloss.js';
import { currentRemoteDir } from '../sim/oracles.js';
import { alone, has, holdsOf, until, type Step } from './holdsScript.js';
import { testRunner } from './tmp.js';

export const REFS = refNames('main', RELEASE_NAMESPACE);

let plantGit: GitRunner | null = null;
const runner = (): GitRunner => (plantGit ??= testRunner());

/**
 * A git call in `dir` (stdout trimmed); a non-zero exit throws. An index operation runs with core.protectNTFS/protectHFS off: a plant
 * rewrites trees that may hold a name Windows cannot check out (the team writer's np/team-1/con.py), which no work tree ever sees.
 */
export async function g(dir: string, args: string[], o: { stdin?: Buffer; indexFile?: string } = {}): Promise<string> {
  const r = await runner().run(args, {
    class: o.indexFile === undefined ? 'local' : 'refupdate', cwd: dir, identity: { name: 'plant', email: 'plant@cowork.invalid' }, wallMsForDates: 1_700_000_000_000,
    ...(o.stdin === undefined ? {} : { stdin: o.stdin }),
    ...(o.indexFile === undefined ? {} : { indexFile: o.indexFile, config: { 'core.protectNTFS': 'false', 'core.protectHFS': 'false' } }),
  });
  if (r.code !== 0) throw new Error(`plant: git ${args.join(' ')} in ${dir} failed (${r.code}): ${r.stderr.toString('utf8').trim()}`);
  return r.stdout.toString('utf8').trim();
}

let n = 0;
/** A copy of the bare remote under the run root (its own path; the run's remote is untouched). */
export async function scratchRemote(ctx: SimContext, tag: string): Promise<string> {
  const to = join(ctx.root, `scratch-${tag}-${++n}.git`);
  await cp(await currentRemoteDir(ctx), to, { recursive: true });
  return to;
}

export async function dropScratch(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** `commit` re-made with `tree` and `parents` (same message), its oid. */
async function remake(dir: string, commit: string, tree: string, parents: readonly string[]): Promise<string> {
  const msg = await g(dir, ['log', '-1', '--format=%B', commit]);
  return g(dir, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p])], { stdin: Buffer.from(`${msg}\n`, 'utf8') });
}

async function parentsOf(dir: string, commit: string): Promise<string[]> {
  return (await g(dir, ['rev-list', '--no-walk', '--parents', '-n', '1', commit])).split(' ').slice(1);
}

/** The board tip of the scratch remote without held/<id>/ for each id (a board commit with the same parents and message). */
export async function boardWithoutHeld(dir: string, ids: readonly string[]): Promise<string> {
  const tip = await g(dir, ['rev-parse', `${REFS.remoteBoard}^{commit}`]);
  const top = (await g(dir, ['ls-tree', `${tip}^{tree}`])).split('\n').filter((l) => l.length > 0);
  const out: string[] = [];
  for (const line of top) {
    const name = line.slice(line.indexOf('\t') + 1);
    if (name !== 'held') {
      out.push(line);
      continue;
    }
    const heldOid = line.split(' ')[2]!.split('\t')[0]!;
    const kept = (await g(dir, ['ls-tree', heldOid])).split('\n').filter((l) => l.length > 0 && !ids.includes(l.slice(l.indexOf('\t') + 1)));
    if (kept.length > 0) out.push(`040000 tree ${await g(dir, ['mktree'], { stdin: Buffer.from(`${kept.join('\n')}\n`, 'utf8') })}\theld`);
  }
  const tree = await g(dir, ['mktree'], { stdin: Buffer.from(`${out.join('\n')}\n`, 'utf8') });
  const board = await remake(dir, tip, tree, await parentsOf(dir, tip));
  await g(dir, ['update-ref', REFS.remoteBoard, board, tip]);
  return board;
}

/**
 * The board tip of the scratch remote re-made over a live code commit whose tree has `edit` applied (path → new bytes, null = removed):
 * a new live commit with the old one's parents and message (a pushed-tree plant), the board commit with it as last parent, both refs moved.
 */
export async function liveRewritten(dir: string, edit: (path: string, bytes: Buffer) => Buffer | null | undefined): Promise<{ board: string; live: string }> {
  const tip = await g(dir, ['rev-parse', `${REFS.remoteBoard}^{commit}`]);
  const bp = await parentsOf(dir, tip);
  const oldLive = bp[bp.length - 1]!;
  const index = join(dir, `plant-${++n}.index`);
  await g(dir, ['read-tree', `${oldLive}^{tree}`], { indexFile: index });
  const files = (await g(dir, ['ls-tree', '-r', '-z', `${oldLive}^{tree}`])).split('\0').filter((x) => x.length > 0);
  for (const rec of files) {
    const tab = rec.indexOf('\t');
    const [mode = '', , oid = ''] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (mode !== '100644' && mode !== '100755') continue;
    const bytes = (await runner().run(['cat-file', 'blob', oid], { class: 'local', cwd: dir })).stdout;
    const next = edit(path, bytes);
    if (next === undefined) continue;
    // --index-info works in a bare repository (mode 0 and the null oid remove the entry).
    const entry = next === null ? `0 ${'0'.repeat(oid.length)}` : `${mode} ${await g(dir, ['hash-object', '-w', '--stdin', '--no-filters'], { stdin: next })}`;
    const line = `${entry}\t${path}\n`;
    await g(dir, ['update-index', '--index-info'], { indexFile: index, stdin: Buffer.from(line, 'utf8') });
  }
  const tree = await g(dir, ['write-tree'], { indexFile: index });
  await rm(index, { force: true });
  const live = await remake(dir, oldLive, tree, await parentsOf(dir, oldLive));
  const board = await remake(dir, tip, await g(dir, ['rev-parse', `${tip}^{tree}`]), [...bp.slice(0, -1), live]);
  await g(dir, ['update-ref', REFS.remoteBoard, board, tip]);
  await g(dir, ['update-ref', REFS.remoteCode, live]);
  return { board, live };
}

/** Bytes without the rows that contain `needle` (latin1 rows; endings kept). */
export function withoutRow(bytes: Buffer, needle: string): Buffer {
  const s = bytes.toString('latin1');
  return Buffer.from(s.split(/(?<=\n)/).filter((row) => !row.includes(needle)).join(''), 'latin1');
}

/** A trace with the same names and monoAt table as the run's, over `events` (same length, events edited in place). */
export function traceView(ctx: SimContext, events: readonly TraceEvent[]): SimContext['trace'] {
  return {
    events, names: ctx.trace.names,
    monoAt: (i: number) => ctx.trace.monoAt(i),
    since: (i: number) => events.slice(i),
    ofKind: (k: TraceEvent['kind']) => events.filter((e) => e.kind === k),
    emit: () => { throw new Error('traceView: read-only'); },
    emitAt: () => { throw new Error('traceView: read-only'); },
  } as unknown as SimContext['trace'];
}

/** The run's context seen over another remote directory and/or another trace. */
export function viewOf(ctx: SimContext, o: { remoteDir?: string; trace?: SimContext['trace'] }): SimContext {
  return { ...ctx, remote: o.remoteDir === undefined ? ctx.remote : { ...ctx.remote, dir: o.remoteDir }, trace: o.trace ?? ctx.trace };
}

/** One afterEveryOp of `oracle` over `view` (a fresh oracle per plant: its first check looks at every obligation). */
export async function judge(oracle: Oracle, view: SimContext): Promise<string | null> {
  return (await oracle.afterEveryOp?.call(oracle, view)) ?? null;
}

// ---- the D-26 scenario (05 I11 shape), shared by sim.noloss and sim.heldsecret ----------------------------------------------------

const nonTerminalOf = async (ctx: SimContext, i: number): Promise<HoldRecord[]> => (await holdsOf(ctx, i)).filter((r) => !isTerminal(r));
const holdsBlob = async (ctx: SimContext, i: number, side: Record<string, string> | undefined, m: string): Promise<boolean> => {
  for (const oid of Object.values(side ?? {})) {
    if (oid === 'ABSENT') continue;
    const r = await runner().run(['cat-file', 'blob', oid], { class: 'local', cwd: ctx.peers[i]!.dir });
    if (r.code === 0 && findMarkers(r.stdout).includes(m)) return true;
  }
  return false;
};

/**
 * p0 loses a same-row race on notes.txt row 4 (a K4 record, OFF_DISK after the TIP write), edits row 4 again (overlapping), restores the K4
 * record (`cowork:` markers on p0's disk, guard `markers`), types a half-done resolution with a fresh marker (noted), and after age_24h S6's
 * markers park moves it into a companion; then the companion is restored (rows and marker back). Facts: restored, k4Marker, fresh,
 * companion {id, parent, h1}, restoreCompanion, back; locations at the companion probe: companion (the fresh marker), parent (p0's K4
 * marker), and after the restore: back.
 */
export function d26Steps(markers: MarkerModel, facts: Map<string, unknown>, at: Map<string, NolossFound | null>): Step[] {
  const loc = (ctx: SimContext, m: string): Promise<NolossFound | null> => locateMarker(ctx, RELEASE_NAMESPACE, m, markers.live().get(m) ?? { peer: 'p0', path: 'notes.txt' }, {});
  return [
    { rounds: 1 },
    { kind: 'edit_same_line', peer: 1, params: { other: 0, row: 4 } },
    { probe: 'k4 marker', run: async (ctx) => {
      const e = [...ctx.opLog].reverse().find((x) => x.kind === 'edit_same_line')!;
      const ms = findMarkers(Buffer.from(e.detail, 'latin1'));
      facts.set('k4Marker', ms[ms.length - 1]);   // the op's last marker is p0's (peers=p1,p0)
    } },
    ...alone(1, 14),
    until(0, 'k4', async (ctx) => (await nonTerminalOf(ctx, 0)).some((r) => has(r, 'conflict')), 30),
    { rounds: 6 },
    { kind: 'edit_own', peer: 0, params: { path: 'notes.txt', row: 4, text: 'note row 4 p0 again' } },
    { kind: 'resolve', peer: 0, params: { verb: 'restore' } },
    {
      probe: 'restored', run: async (ctx) => {
        const disk = (await readFile(join(ctx.peers[0]!.dir, 'notes.txt'))).toString('latin1');
        const recs = await nonTerminalOf(ctx, 0);
        facts.set('restored', { markersOnDisk: /^<<<<<<< cowork:/m.test(disk), guards: recs.map((r) => [r.id, r.guards.map((x) => x.name), r.residence, r.state]) });
      },
    },
    {
      probe: 'half-done', run: async (ctx) => {
        // The human keeps the conflict rows and types a fresh line under the first one (a half-done resolution).
        const p = join(ctx.peers[0]!.dir, 'notes.txt');
        const text = (await readFile(p)).toString('latin1');
        const m = markers.mint('p0');
        const at0 = text.indexOf('\n', text.search(/^<<<<<<< cowork:/m)) + 1;
        await writeFile(p, Buffer.from(`${text.slice(0, at0)}half done ${m}\n${text.slice(at0)}`, 'latin1'));
        const t = ctx.clocks.get('p0')!.wallMs() / 1_000;
        await utimes(p, t, t);
        markers.noteEdit('p0', 'notes.txt', [m], [], true, () => false);
        facts.set('fresh', m);
        return m;
      },
    },
    ...alone(0, 4),
    { kind: 'age_24h', peer: 0 },
    until(0, 'companion wait', async (ctx) => {
      const reg = await readRegistry(runner(), ctx.peers[0]!.dir, 'main');
      return Object.keys(reg.local?.companions ?? {}).some((id) => !isTerminal(reg.records.get(id)!));
    }, 30),
    {
      probe: 'companion', run: async (ctx) => {
        const fresh = facts.get('fresh') as string;
        at.set('companion', await loc(ctx, fresh));
        at.set('parent', await loc(ctx, facts.get('k4Marker') as string));
        const reg = await readRegistry(runner(), ctx.peers[0]!.dir, 'main');
        const cid = Object.keys(reg.local?.companions ?? {}).find((id) => !isTerminal(reg.records.get(id)!))!;
        facts.set('companion', { id: cid, parent: reg.local!.companions[cid], h1: await holdsBlob(ctx, 0, (reg.records.get(cid)!.blobs as { h1?: Record<string, string> }).h1, fresh) });
      },
    },
    ...alone(0, 2),   // the park's write settles (an engine-written mtime is read only once its stat held 300 ms)
    {
      probe: 'restore-companion', run: async (ctx) => {
        const comp = facts.get('companion') as { id: string };
        const e = realEngineOf(ctx.engines[0]!) as Engine;
        let res = await e.resolve(comp.id, 'restore', { humanEvidence: true, actor: 'human' });
        // HOLD_DISK_CHANGED's next command is "repeat the command" (a path its detection tick did not read yet).
        for (let k = 0; k < 3 && res.kind === 'refused' && res.code === 'HOLD_DISK_CHANGED'; k++) {
          advanceClocks(ctx, 2_500);
          res = await e.resolve(comp.id, 'restore', { humanEvidence: true, actor: 'human' });
        }
        facts.set('restoreCompanion', res);
        return JSON.stringify(res);
      },
    },
    ...alone(0, 2),
    {
      probe: 'back', run: async (ctx) => {
        const fresh = facts.get('fresh') as string;
        const disk = await readFile(join(ctx.peers[0]!.dir, 'notes.txt'));
        facts.set('back', { marker: findMarkers(disk).includes(fresh), rows: /^<<<<<<< cowork:/m.test(disk.toString('latin1')) });
        at.set('back', await loc(ctx, fresh));
      },
    },
  ];
}

/** Runs `fn` while peer i's Engine.inspect() answers through `wrap` (an instance wrapper; restored after). */
export async function withInspect<T>(ctx: SimContext, i: number, wrap: (ins: EngineInspection) => EngineInspection, fn: () => Promise<T>): Promise<T> {
  const e = realEngineOf(ctx.engines[i]!) as Engine;
  const orig = e.inspect;
  e.inspect = async function (this: Engine) { return wrap(await orig.call(this)); };
  try {
    return await fn();
  } finally {
    e.inspect = orig;
  }
}
