// The state ref (01-engine §3.2; ENG-03, ENG-04, ENG-07; INV-ENG-REACH, INV-ENG-STATE; rulings R-14, R-15).
//
// refs/cowork-local/<enc(b)>/state points to a commit `cowork-state` with parents [LA_C, LA_B] and the tree
//
//   base       tree   A (per-path base; stored form)
//   snap       tree   S_disk at the last transition
//   meta       blob   meta.json (src/engine/meta.ts)
//   journal    tree
//     intent.json      blob   the journaled intent (canonical JSON)
//     t/<M|S|TIP|P>    tree   trees an intent references
//     ready/<k>/{R,A}  tree   ready pairs, k = readyKey(cs_id)
//     keep/<name>      tree   trees kept reachable; keep/fold/state.json = the fold state (PRO-25, R-14)
//
// so every object the state names is reachable for `git gc --prune=now`. Metadata trees are built with mktree
// from existing objects, one call per directory level (R-15); the ref changes only by one CAS update-ref
// --create-reflog per transition, and a lost CAS is a second writer (StateCasLostError: the caller logs a
// security event and exits). read() looks for a meta blob from a newer plugin first, which is a MetaTooNewError
// whatever else that state holds (LIF-37, ruling P2-METAFIRST); it then checks the commit, the layout and every
// named object, and anything missing or unparsable is a LostStateError carrying the unusable commit (ENG-54), which
// rebuild() replaces by one CAS from that commit (ruling P2-REBUILD).
import { STATE_SUBJECT } from '../board/boardCommit.js';
import { canonicalBytes, type Json } from '../board/canonicalJson.js';
import { parseFold, serializeFold, type FoldState } from '../board/fold.js';
import type { PeerId } from '../board/ids.js';
import { ABSENT, isOid, parseOid, type Oid, type OidOrAbsent } from '../git/oid.js';
import { GitCommandError, type GitRepo, type MktreeEntry } from '../git/repo.js';
import { readyKey, type ReadyPair } from '../holds/changesets.js';
import type { Trace } from '../ports/trace.js';
import { validId, validPathSyntax } from '../sec/validators.js';
import { MetaTooNewError, parseMeta, serializeMeta, type Meta } from './meta.js';
import type { RefNames } from './refs.js';

export type ApplyIntentEntry = { path: string; kind: 'create' | 'modify' | 'delete'; slot: number };
export type Intent =
  | { kind: 'none' }
  | { kind: 'apply'; tip: Oid; board: Oid; groups: Array<{ n: number; entries: ApplyIntentEntry[] }> }            // journal t/M, t/S, t/TIP
  | { kind: 'local'; origin: string; entries: Array<{ path: string; expected: OidOrAbsent; target: Oid | 'DELETE'; slot: number }> }
  | { kind: 'push'; bnew: Oid; c: Oid | null; lease_board: OidOrAbsent; lease_code: OidOrAbsent; cs_ids: string[]; writer_seq: number; op_ids: string[] };   // journal t/P
export type JournalTree = 'M' | 'S' | 'TIP' | 'P';
export interface StateView {
  commit: Oid; laC: Oid; laB: Oid;
  base: Oid; snap: Oid;                         // A and S_disk at the last transition (trees)
  meta: Meta; intent: Intent;
  t: ReadonlyMap<JournalTree, Oid>;
  ready: readonly ReadyPair[];                  // journal/ready/<readyKey>/{R,A}
  keep: ReadonlyMap<string, Oid>;               // journal/keep/<name>; keep/fold/state.json = the fold state
  fold: FoldState | null;
}
export interface Transition {
  laC?: Oid; laB?: Oid; base?: Oid; snap?: Oid; meta?: Meta; intent?: Intent;
  t?: ReadonlyMap<JournalTree, Oid>;            // replaces t/ (an empty map clears it)
  ready?: readonly ReadyPair[]; keep?: ReadonlyMap<string, Oid>; fold?: FoldState;
}

/** A second writer moved the state ref: log 'security', exit (ENG-03). */
export class StateCasLostError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'StateCasLostError';
  }
}

/** The state ref names a missing or unparsable object, or its value cannot be read (ENG-54: lost-state rebuild). */
export class LostStateError extends Error {
  /** The unusable commit the state ref names, which StateStore.rebuild replaces by CAS (ruling P2-REBUILD); null when the ref value itself could not be read. */
  readonly stateOid: Oid | null;
  constructor(stateOid: Oid | null, message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LostStateError';
    this.stateOid = stateOid;
  }
}

const NUL = String.fromCharCode(0);
const TREE_MODE = '040000';
const BLOB_MODE = '100644';
const JOURNAL_TREES: ReadonlySet<string> = new Set(Object.keys({ M: 1, S: 1, TIP: 1, P: 1 } satisfies Record<JournalTree, 1>));
const FOLD_NAME = 'fold';
const FOLD_FILE = 'state.json';
/** A keep/ name: one plain path component; 'fold' is the fold state's own entry. */
const KEEP_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const HUMAN_CS = /^[0-9a-f]{32}\/human\/([1-9][0-9]*)$/;

type Obj = Record<string, unknown>;

/** A layout or schema deviation found while reading (becomes LostStateError) or writing (a TypeError). */
class StateFormatError extends TypeError {
  constructor(what: string) {
    super(`state: ${what}`);
    this.name = 'StateFormatError';
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function keys(v: unknown, want: readonly string[], what: string): Obj {
  if (!isObj(v)) throw new StateFormatError(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const w = [...want].sort();
  if (have.length !== w.length || have.some((k, i) => k !== w[i])) throw new StateFormatError(`${what} has keys [${have.join(', ')}]`);
  return v;
}

function check(ok: boolean, what: string): asserts ok {
  if (!ok) throw new StateFormatError(what);
}

const int = (v: unknown, min: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const oidOrAbsent = (v: unknown): boolean => v === ABSENT || isOid(v);
const array = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new StateFormatError(`${what} is not an array`);
  return v;
};

/** The Intent schema of 01-engine §3.2 (Plan 2 kinds; the adopt intent is Plan 7). */
function checkIntent(v: unknown): Intent {
  const kind = isObj(v) ? v['kind'] : undefined;
  switch (kind) {
    case 'none':
      keys(v, ['kind'], 'intent');
      break;
    case 'apply': {
      const o = keys(v, ['kind', 'tip', 'board', 'groups'], 'apply intent');
      check(isOid(o['tip']) && isOid(o['board']), 'apply intent tip/board must be object ids');
      for (const g of array(o['groups'], 'apply intent groups')) {
        const go = keys(g, ['n', 'entries'], 'apply group');
        check(int(go['n'], 0), 'apply group n must be a safe integer >= 0');
        for (const e of array(go['entries'], 'apply group entries')) {
          const eo = keys(e, ['path', 'kind', 'slot'], 'apply entry');
          check(typeof eo['path'] === 'string' && validPathSyntax(eo['path']), 'apply entry path is not a valid path');
          check(eo['kind'] === 'create' || eo['kind'] === 'modify' || eo['kind'] === 'delete', 'apply entry kind');
          check(int(eo['slot'], 0), 'apply entry slot must be a safe integer >= 0');
        }
      }
      break;
    }
    case 'local': {
      const o = keys(v, ['kind', 'origin', 'entries'], 'local intent');
      check(typeof o['origin'] === 'string' && o['origin'].length > 0, 'local intent origin must be a non-empty string');
      for (const e of array(o['entries'], 'local intent entries')) {
        const eo = keys(e, ['path', 'expected', 'target', 'slot'], 'local entry');
        check(typeof eo['path'] === 'string' && validPathSyntax(eo['path']), 'local entry path is not a valid path');
        check(oidOrAbsent(eo['expected']), 'local entry expected must be an object id or ABSENT');
        check(eo['target'] === 'DELETE' || isOid(eo['target']), 'local entry target must be an object id or DELETE');
        check(int(eo['slot'], 0), 'local entry slot must be a safe integer >= 0');
      }
      break;
    }
    case 'push': {
      const o = keys(v, ['kind', 'bnew', 'c', 'lease_board', 'lease_code', 'cs_ids', 'writer_seq', 'op_ids'], 'push intent');
      check(isOid(o['bnew']) && (o['c'] === null || isOid(o['c'])), 'push intent bnew/c must be object ids');
      check(oidOrAbsent(o['lease_board']) && oidOrAbsent(o['lease_code']), 'push intent leases must be object ids or ABSENT');
      check(array(o['cs_ids'], 'push intent cs_ids').every((x) => typeof x === 'string' && validId('cs', x)), 'push intent cs_ids must be change-set ids');
      check(int(o['writer_seq'], 1), 'push intent writer_seq must be a safe integer >= 1');
      check(array(o['op_ids'], 'push intent op_ids').every((x) => typeof x === 'string' && validId('op', x)), 'push intent op_ids must be op ids');
      break;
    }
    default:
      throw new StateFormatError(`unknown intent kind ${JSON.stringify(kind)}`);
  }
  return v as unknown as Intent;
}

/** intent.json: canonical JSON of a valid Intent; anything else (non-canonical bytes included) throws. */
function parseIntent(buf: Buffer): Intent {
  let v: unknown;
  try {
    v = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new StateFormatError('intent.json is not JSON');
  }
  const intent = checkIntent(v);
  check(canonicalBytes(v as Json).equals(buf), 'intent.json is not canonical JSON');
  return intent;
}

function serializeIntent(i: Intent): Buffer {
  const buf = canonicalBytes(i as unknown as Json);
  parseIntent(buf);
  return buf;
}

/** n of `<peer>/human/<n>`: the ready pair's capture order (R-01); Plan 2 journals human CSs only. */
function humanOrder(csId: string): number | null {
  const m = HUMAN_CS.exec(csId);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** The cs_id a journal/ready key names: readyKey's inverse, only for the key readyKey itself writes. */
function csIdOfKey(k: string): string {
  check(/^[A-Za-z0-9_-]+$/.test(k), `ready key ${JSON.stringify(k)} is not base64url`);
  const csId = Buffer.from(k, 'base64url').toString('utf8');
  check(validId('cs', csId) && readyKey(csId) === k, `ready key ${JSON.stringify(k)} does not name a change-set id`);
  return csId;
}

interface TreeRec { mode: string; type: string; oid: Oid; }

/** One level of a tree (`ls-tree -z`, no recursion: base and snap are whole code trees). */
async function lsTree(repo: GitRepo, tree: Oid): Promise<Map<string, TreeRec>> {
  const r = await repo.run(['ls-tree', '-z', parseOid(tree)]);
  const out = new Map<string, TreeRec>();
  for (const rec of r.stdout.toString('utf8').split(NUL)) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf('\t');
    const meta = rec.slice(0, tab).split(' ');
    check(tab > 0 && meta.length === 3, `ls-tree record ${JSON.stringify(rec.slice(0, 120))}`);
    out.set(rec.slice(tab + 1), { mode: meta[0]!, type: meta[1]!, oid: parseOid(meta[2]!) });
  }
  return out;
}

function isTree(e: TreeRec): boolean {
  return e.type === 'tree' && e.mode === TREE_MODE;
}

function isBlob(e: TreeRec): boolean {
  return e.type === 'blob' && e.mode === BLOB_MODE;
}

/** Exactly these entry names, each of the given type. */
function exact<K extends string>(entries: Map<string, TreeRec>, want: Record<K, 'tree' | 'blob'>, what: string): Record<K, TreeRec> {
  const names = Object.keys(want) as K[];
  check(entries.size === names.length && names.every((n) => entries.has(n)), `${what} has entries [${[...entries.keys()].join(', ')}]`);
  const out = {} as Record<K, TreeRec>;
  for (const n of names) {
    const e = entries.get(n)!;
    check(want[n] === 'tree' ? isTree(e) : isBlob(e), `${what}/${n} is not a ${want[n]}`);
    out[n] = e;
  }
  return out;
}

/** One `cat-file --batch-check`: every object exists and has its type. */
async function checkObjects(repo: GitRepo, items: ReadonlyArray<readonly [Oid, 'commit' | 'tree' | 'blob']>): Promise<void> {
  if (items.length === 0) return;
  const r = await repo.run(['cat-file', '--batch-check'], { stdin: Buffer.from(`${items.map(([o]) => o).join('\n')}\n`, 'utf8') });
  const lines = r.stdout.toString('utf8').split('\n');
  items.forEach(([o, type], i) => {
    const parts = (lines[i] ?? '').split(' ');
    check(parts.length === 3 && parts[0] === o && parts[1] === type, `${type} ${o} is missing`);
  });
}

const tree = (name: string, oid: Oid): MktreeEntry => ({ name, mode: TREE_MODE, type: 'tree', oid });
const blob = (name: string, oid: Oid): MktreeEntry => ({ name, mode: BLOB_MODE, type: 'blob', oid });

interface Resolved {
  laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta; intent: Intent;
  t: ReadonlyMap<JournalTree, Oid>; ready: readonly ReadyPair[]; keep: ReadonlyMap<string, Oid>; fold: FoldState | null;
}

/** create's and rebuild's init (the contract's literal type). */
type StateInit = { laC: Oid; laB: Oid; base: Oid; snap: Oid; meta: Meta; ready?: readonly ReadyPair[]; fold?: FoldState };

/** A fresh state: no intent, empty t/ and keep/. */
function initial(init: StateInit): Resolved {
  return {
    laC: init.laC, laB: init.laB, base: init.base, snap: init.snap, meta: init.meta, intent: { kind: 'none' },
    t: new Map(), ready: init.ready ?? [], keep: new Map(), fold: init.fold ?? null,
  };
}

export class StateStore {
  private readonly d: { repo: GitRepo; refs: RefNames; trace: Trace; peer: () => PeerId };

  constructor(d: { repo: GitRepo; refs: RefNames; trace: Trace; peer: () => PeerId }) {
    this.d = d;
  }

  /**
   * null = no ref; MetaTooNewError when the state's meta blob comes from a newer plugin (checked first, LIF-37);
   * LostStateError when the state names a missing or unparsable object (stateOid = the ref's value) or when git
   * cannot read the ref value itself (stateOid = null).
   */
  async read(): Promise<StateView | null> {
    let commit: Oid | null;
    try {
      commit = await this.d.repo.readRef(this.d.refs.state);
    } catch (e) {
      // A ref lookup git refuses (a corrupt packed-refs, exit 128); a spawn failure (rc -1) says nothing about the state.
      if (e instanceof GitCommandError && e.code >= 0) {
        throw new LostStateError(null, `${this.d.refs.state}: the ref value cannot be read: ${e.message}`, { cause: e });
      }
      throw e;
    }
    if (commit === null) return null;
    try {
      return await this.load(commit);
    } catch (e) {
      if (e instanceof MetaTooNewError) throw e;
      // git could not be started at all (rc -1): not evidence about the state.
      if (e instanceof GitCommandError && e.code < 0) throw e;
      throw new LostStateError(commit, `${this.d.refs.state} at ${commit}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  create(init: StateInit): Promise<StateView> {
    return this.write(null, initial(init));
  }

  /** ENG-54 lost-state rebuild over an existing but unusable state ref: one CAS from `unusable` (LostStateError.stateOid) to the new commit (ruling P2-REBUILD); never used for a MetaTooNewError state. */
  rebuild(unusable: Oid, init: StateInit): Promise<StateView> {
    return this.write(parseOid(unusable), initial(init));
  }

  /** Commit [laC, laB], tree {base, snap, meta, journal/{intent.json, t/, ready/<k>/{R,A}, keep/}} built bottom-up with one mktree per directory level
   *  (journal/ready/<k>, journal/ready, journal/t, journal/keep/fold, journal/keep, journal, root; existing trees and blobs referenced by oid; never
   *  read-tree --prefix; R-15), subject 'cowork-state', one CAS update-ref --create-reflog; trace 'state'. */
  commit(prev: StateView, t: Transition): Promise<StateView> {
    return this.write(prev.commit, {
      laC: t.laC ?? prev.laC, laB: t.laB ?? prev.laB, base: t.base ?? prev.base, snap: t.snap ?? prev.snap,
      meta: t.meta ?? prev.meta, intent: t.intent ?? prev.intent, t: t.t ?? prev.t, ready: t.ready ?? prev.ready,
      keep: t.keep ?? prev.keep, fold: t.fold ?? prev.fold,
    });
  }

  private async load(commit: Oid): Promise<StateView> {
    const repo = this.d.repo;
    const info = await repo.readCommit(commit);
    // Meta first (LIF-37, ruling P2-METAFIRST): the root listing is searched leniently for a `meta` blob, and a meta_v
    // newer than this plugin's refuses the branch (MetaTooNewError) before the subject, parent and layout checks, so a
    // newer plugin's state is never read as lost and rebuilt over (01-engine §3.16: write nothing to that state ref).
    // A missing or non-blob meta, or an unparsable one, is a lost state.
    const rootEntries = await lsTree(repo, info.tree);
    const metaEntry = rootEntries.get('meta');
    check(metaEntry !== undefined && isBlob(metaEntry), 'the state tree has no meta blob');
    const meta = parseMeta(await repo.readBlob(metaEntry.oid));
    check(info.subject === STATE_SUBJECT && info.trailers.length === 0, 'the state commit is not a cowork-state commit');
    check(info.parents.length === 2, `the state commit has ${info.parents.length} parents`);
    const [laC, laB] = info.parents as [Oid, Oid];
    const root = exact(rootEntries, { base: 'tree', snap: 'tree', meta: 'blob', journal: 'tree' }, 'state tree');
    const journal = exact(await lsTree(repo, root.journal.oid), { 'intent.json': 'blob', t: 'tree', ready: 'tree', keep: 'tree' }, 'journal');
    const intent = parseIntent(await repo.readBlob(journal['intent.json'].oid));

    const t = new Map<JournalTree, Oid>();
    for (const [name, e] of await lsTree(repo, journal.t.oid)) {
      check(JOURNAL_TREES.has(name) && isTree(e), `journal/t/${name} is not one of the trees M, S, TIP, P`);
      t.set(name as JournalTree, e.oid);
    }

    const ready: ReadyPair[] = [];
    for (const [k, e] of await lsTree(repo, journal.ready.oid)) {
      check(isTree(e), `journal/ready/${k} is not a tree`);
      const csId = csIdOfKey(k);
      const order = humanOrder(csId);
      check(order !== null, `journal/ready/${k} is not a human change-set`);
      const pair = exact(await lsTree(repo, e.oid), { R: 'tree', A: 'tree' }, `journal/ready/${k}`);
      ready.push({ csId, R: pair.R.oid, A: pair.A.oid, paths: await this.pairPaths(pair.R.oid, pair.A.oid), order: order! });
    }

    const keep = new Map<string, Oid>();
    let fold: FoldState | null = null;
    for (const [name, e] of await lsTree(repo, journal.keep.oid)) {
      check(isTree(e), `journal/keep/${name} is not a tree`);
      if (name === FOLD_NAME) {
        const f = exact(await lsTree(repo, e.oid), { [FOLD_FILE]: 'blob' } as Record<typeof FOLD_FILE, 'blob'>, 'journal/keep/fold');
        fold = parseFold(await repo.readBlob(f[FOLD_FILE].oid));
        check(fold !== null, 'journal/keep/fold/state.json is not a fold state');
      } else {
        check(KEEP_NAME.test(name), `journal/keep/${name} is not a keep name`);
        keep.set(name, e.oid);
      }
    }

    // Every named object the reads above did not open from the object store: the parents, base, snap, the
    // t/ and keep/ trees, and R and A (whose listings may come from GitRepo's tree cache).
    await checkObjects(repo, [
      [laC, 'commit'], [laB, 'commit'], [root.base.oid, 'tree'], [root.snap.oid, 'tree'],
      ...[...t.values()].map((o) => [o, 'tree'] as const), ...[...keep.values()].map((o) => [o, 'tree'] as const),
      ...ready.flatMap((p) => [[p.R, 'tree'] as const, [p.A, 'tree'] as const]),
    ]);

    return { commit, laC, laB, base: root.base.oid, snap: root.snap.oid, meta, intent, t, ready: sortReady(ready), keep, fold };
  }

  /** The union of R's and A's paths: the CS paths as the journal records them (R-01). */
  private async pairPaths(R: Oid, A: Oid): Promise<string[]> {
    const r = await this.d.repo.readTreeMap(R);
    const a = await this.d.repo.readTreeMap(A);
    return [...new Set([...r.keys(), ...a.keys()])].sort();
  }

  private async write(prevCommit: Oid | null, s: Resolved): Promise<StateView> {
    const repo = this.d.repo;
    // Validate everything before the first object is written.
    for (const o of [s.laC, s.laB, s.base, s.snap]) parseOid(o);
    // commit-tree drops a duplicate parent, and a one-parent state commit reads as lost.
    check(s.laC !== s.laB, 'LA_C and LA_B are the same commit');
    const metaBuf = serializeMeta(s.meta);
    const intentBuf = serializeIntent(s.intent);
    for (const [name, o] of s.t) {
      check(JOURNAL_TREES.has(name), `journal/t/${String(name)} is not one of the trees M, S, TIP, P`);
      parseOid(o);
    }
    for (const [name, o] of s.keep) {
      check(KEEP_NAME.test(name) && name !== FOLD_NAME, `${JSON.stringify(name)} is not a keep name`);
      parseOid(o);
    }
    const seenKeys = new Set<string>();
    for (const p of s.ready) {
      const order = humanOrder(p.csId);
      check(order !== null, `ready pair ${JSON.stringify(p.csId)} is not a human change-set`);
      check(p.order === order, `ready pair ${p.csId} has order ${p.order}, its cs_id says ${String(order)}`);
      const k = readyKey(p.csId);
      check(!seenKeys.has(k), `ready pair ${p.csId} is listed twice`);
      seenKeys.add(k);
      parseOid(p.R);
      parseOid(p.A);
    }
    let foldBuf: Buffer | null = null;
    if (s.fold !== null) {
      foldBuf = serializeFold(s.fold);
      check(parseFold(foldBuf) !== null, 'the fold state does not serialize to a readable fold state');
    }

    const ready: ReadyPair[] = [];
    const readyEntries: MktreeEntry[] = [];
    for (const p of s.ready) {
      ready.push({ csId: p.csId, R: p.R, A: p.A, paths: await this.pairPaths(p.R, p.A), order: p.order });
      readyEntries.push(tree(readyKey(p.csId), await repo.mktree([tree('R', p.R), tree('A', p.A)])));
    }
    const readyTree = await repo.mktree(readyEntries);
    const tTree = await repo.mktree([...s.t].map(([name, o]) => tree(name, o)));
    const keepEntries = [...s.keep].map(([name, o]) => tree(name, o));
    if (foldBuf !== null) {
      keepEntries.push(tree(FOLD_NAME, await repo.mktree([blob(FOLD_FILE, await repo.hashBytes(foldBuf, true))])));
    }
    const keepTree = await repo.mktree(keepEntries);
    const journal = await repo.mktree([
      blob('intent.json', await repo.hashBytes(intentBuf, true)), tree('t', tTree), tree('ready', readyTree), tree('keep', keepTree),
    ]);
    const root = await repo.mktree([tree('base', s.base), tree('snap', s.snap), blob('meta', await repo.hashBytes(metaBuf, true)), tree('journal', journal)]);
    const commit = await repo.commitTree({ tree: root, parents: [s.laC, s.laB], subject: STATE_SUBJECT, trailers: [] });

    if (!(await repo.casRef(this.d.refs.state, commit, prevCommit, STATE_SUBJECT))) {
      throw new StateCasLostError(`${this.d.refs.state} is no longer at ${prevCommit ?? '(absent)'}: a second writer`);
    }
    this.d.trace.emit({ kind: 'state', peer: this.d.peer(), prev: prevCommit, next: commit, laC: s.laC, laB: s.laB, base: s.base });
    return {
      commit, laC: s.laC, laB: s.laB, base: s.base, snap: s.snap, meta: s.meta, intent: s.intent,
      t: new Map(s.t), ready: sortReady(ready), keep: new Map(s.keep), fold: s.fold,
    };
  }
}

/** Capture order (newest last), the order "newest capture wins" reads them in. */
function sortReady(pairs: ReadyPair[]): ReadyPair[] {
  return pairs.sort((a, b) => a.order - b.order || (a.csId < b.csId ? -1 : a.csId > b.csId ? 1 : 0));
}
