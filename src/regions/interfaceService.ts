// The interface check, main-thread side (04-regions §3.10; §3.20 "Caller search without a stored merged tree"; REG-26, REG-27,
// REG-31, REG-35; rulings R4-44, R4-50, R4-72). It classifies the CS's units (base versus ours, net), searches the callers of
// every breaking change on `out`, checks the callees of the calls the CS wrote and the import names, and reports the symbol
// delta and the referenced names (05 §8 Q2 default, HLD-48/49). Parsing, call-site walks and mappings run as RegionWorkers jobs
// ('table', 'sites', 'map'); the caller grep is `git grep` through GitRepo.run on out's stored tree, and the paths an overlay
// replaces are searched in memory by the same byte-wise whole-word predicate (wholeWordRows), so the union equals a grep of
// out without writing it (REG-02, REG-35). Every verdict degrades by P2: a deadline, a missing object, NO_TABLE{budget} or a
// crashed job makes the result incomplete, never a pass (REG-27, REG-31). No web-tree-sitter import here (L-REGION-DEPS).
//
// "Written by this CS" (R1-142): the CS's rows of ours[p] (csRows, from hunks(base, ours)) are mapped into out[p] with
// FoldMapper/1 in local mode; a caller whose row lies in that image is the CS's own and is no entry. A WHOLE_FILE image (the
// mapping's D > 5,000 or local cap — and, read the same way, a CS whose own change of p exceeds D_CAP, so its rows have no
// row-level image) counts no row of out[p] as written by the CS: every definite caller there is checked, and the CS's new calls
// on p are all of out[p]'s call sites (P2: more entries, never fewer); the result stays complete.
import { posix } from 'node:path';
import { GitCommandError } from '../git/repo.js';
import type { GitResult } from '../git/runner.js';
import type { Deadline } from './budgets.js';
import {
  CALLER_STOPLIST, MAX_HITS_PER_NAME, arityCompatible, classifyUnit, jsonKeyPaths, sameUnitShape,
  type Breaking, type BreakingKind, type Finding, type InterfaceResult, type Site,
} from './interface.js';
import { decodeStrict } from './lines.js';
import { languageOf } from './runtime.js';
import type { RegionService } from './service.js';
import { blobOid, labelKey, type BlobRef, type FileMode, type Label, type Language, type Oid, type Range, type Ranges, type RegionTable, type SigSlice, type TableOrNone, type TreeView, type Unit } from './types.js';

export interface InterfaceInput {
  readonly base: TreeView; readonly ours: TreeView; readonly out: TreeView;
  readonly csPaths: readonly string[];               // the CS's (or the group's) LIVE paths
  readonly csRows: ReadonlyMap<string, Ranges>;      // rows of ours the CS wrote (from hunks(base, ours)): "a definite call not written by this CS"
  readonly epochBase: Oid;
}

// ---- The split caller search (04 §3.20; R4-44, R2-E12) -------------------------------------------------------------------------

const isWordByte = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;

/**
 * The byte-wise git grep -w -F predicate (word constituents [A-Za-z0-9_], every other byte a boundary, as under LC_ALL=C), 1-based
 * rows; part (ii) of the split caller search. Like git, a row matches when any occurrence of the name's bytes has a non-word byte
 * (or the row's edge) on both sides. The name is searched for with Buffer#indexOf (its UTF-8 bytes); no text is encoded into a
 * buffer of its own and nothing is written.
 */
export function wholeWordRows(lines: readonly Buffer[], name: string): number[] {
  const out: number[] = [];
  if (name === '') return out;
  const n = Buffer.byteLength(name, 'utf8');
  lines.forEach((row, i) => {
    const end = row.length > 0 && row[row.length - 1] === 0x0a ? row.length - 1 : row.length;   // git's line excludes its LF
    for (let at = row.indexOf(name, 0, 'utf8'); at >= 0 && at + n <= end; at = row.indexOf(name, at + 1, 'utf8')) {
      const before = at === 0 ? -1 : (row[at - 1] as number);
      const after = at + n >= end ? -1 : (row[at + n] as number);
      if ((before < 0 || !isWordByte(before)) && (after < 0 || !isWordByte(after))) {
        out.push(i + 1);
        return;
      }
    }
  });
  return out;
}

/** Real timers only poll the Clock-port deadline (they never decide expiry), so a virtual clock stays deterministic. */
const ABORT_POLL_MS = 10;

/** An AbortSignal that fires once `d` has expired (checked every ABORT_POLL_MS); stop() ends the polling. */
function abortWhenExpired(d: Deadline): { readonly signal: AbortSignal; stop(): void } {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const poll = (): void => {
    if (stopped) return;
    if (d.expired()) {
      ac.abort();
      return;
    }
    timer = setTimeout(poll, Math.max(1, Math.min(ABORT_POLL_MS, d.remainingMs())));
    timer.unref();
  };
  poll();
  return {
    signal: ac.signal,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Windows' CreateProcess command line holds 32,767 UTF-16 units including its terminating NUL. A grep's own arguments (each
 * counted as Windows quotes it, worst case) stay within ARGV_BUDGET; RUNNER_RESERVE is left for the program path and the runner's
 * forced prefix (--no-replace-objects, --git-dir=<abs>, about 20 -c pairs with the hooks path and attr.tree: 1–2 K in practice).
 * More paths → more greps.
 */
const WINDOWS_CMDLINE_MAX = 32_767;
const RUNNER_RESERVE = 8_192;
const ARGV_BUDGET = WINDOWS_CMDLINE_MAX - 1 - RUNNER_RESERVE;

/** An argument's length on a Windows command line plus its separator, worst case: one with a space, a tab or a quote is quoted
 *  and every quote and backslash in it may be escaped. */
const argCost = (a: string): number => (a.length > 0 && !/[ \t"]/u.test(a) ? a.length : 2 * a.length + 2) + 1;

/**
 * The pathspecs of the caller greps, split so each grep's arguments (`head` included) cost at most ARGV_BUDGET: every searched
 * path as `:(literal)p`, and `:(exclude,literal)p` in the same grep when the overlay replaces or deletes p (pathspecs are exact,
 * so an exclude of a path a grep does not include changes nothing, and each exclude rides with its include). null when one path
 * alone does not fit: it cannot be searched, so the search is incomplete (P2).
 */
function pathspecChunks(paths: readonly string[], overlay: ReadonlyMap<string, unknown>, head: readonly string[]): string[][] | null {
  const fixed = head.reduce((n, a) => n + argCost(a), 0);
  const out: string[][] = [];
  let includes: string[] = [];
  let excludes: string[] = [];
  let len = fixed;
  for (const p of paths) {
    const inc = `:(literal)${p}`;
    const exc = overlay.has(p) ? `:(exclude,literal)${p}` : null;
    const cost = argCost(inc) + (exc === null ? 0 : argCost(exc));
    if (fixed + cost > ARGV_BUDGET) return null;
    if (includes.length > 0 && len + cost > ARGV_BUDGET) {
      out.push([...includes, ...excludes]);
      includes = [];
      excludes = [];
      len = fixed;
    }
    includes.push(inc);
    if (exc !== null) excludes.push(exc);
    len += cost;
  }
  if (includes.length > 0) out.push([...includes, ...excludes]);
  return out;
}

/** `git grep -z -n` records on a tree: `<tree>:<path>\0<line>\0<text>\n`; a `Binary file … matches` line has no row and is skipped. */
function parseGrep(stdout: Buffer, tree: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const prefix = `${tree}:`;
  let i = 0;
  while (i < stdout.length) {
    const nextLine = (from: number): number => {
      const nl = stdout.indexOf(0x0a, from);
      return nl < 0 ? stdout.length : nl + 1;
    };
    if (stdout.toString('latin1', i, i + prefix.length) !== prefix) {
      i = nextLine(i);
      continue;
    }
    const pathEnd = stdout.indexOf(0, i + prefix.length);
    const lineEnd = pathEnd < 0 ? -1 : stdout.indexOf(0, pathEnd + 1);
    if (pathEnd < 0 || lineEnd < 0) break;
    const line = Number(stdout.toString('latin1', pathEnd + 1, lineEnd));
    if (Number.isSafeInteger(line) && line > 0) out.push({ path: stdout.toString('utf8', i + prefix.length, pathEnd), line });
    i = nextLine(lineEnd + 1);
  }
  return out;
}

/**
 * The raw union of part (i) (git grep on out.tree with :(literal) paths and one :(exclude,literal) per searched overlay path, split
 * into several greps when the pathspecs would not fit on a Windows command line) and part (ii) (wholeWordRows over each overlay
 * path's line array), before the definition/comment/string filter, so the R2-E12 property compares hit sets exactly; a deadline,
 * an aborted grep or a failed git call (a spawn failure, rc 128) → 'incomplete'. `paths` are the paths to search (out's paths with
 * a symbol table); the grep runs with `-c attr.tree=<epochBase>`, okCodes [0, 1] and literal pathspec magic (never GIT_LITERAL_PATHSPECS
 * and never RunOpts.config: core.quotepath=off is one of the runner's forced pairs, R4-44); its abort fires when `deadline` expires.
 * Sorted by (path, line), each once.
 */
export async function callerHits(s: RegionService, out: TreeView, name: string, paths: readonly string[], epochBase: Oid, deadline: Deadline): Promise<ReadonlyArray<{ path: string; line: number }> | 'incomplete'> {
  if (deadline.expired()) return 'incomplete';
  const found = new Map<string, Set<number>>();
  const add = (path: string, line: number): void => {
    let rows = found.get(path);
    if (rows === undefined) {
      rows = new Set();
      found.set(path, rows);
    }
    rows.add(line);
  };
  if (out.tree !== null && paths.length > 0) {
    const head = ['grep', '-z', '-n', '-w', '-F', '-e', name, out.tree, '--'];
    const chunks = pathspecChunks([...paths].sort(byCodeUnit), out.overlay, head);
    if (chunks === null) return 'incomplete';
    for (const chunk of chunks) {
      if (deadline.expired()) return 'incomplete';
      const watch = abortWhenExpired(deadline);
      let r: GitResult;
      try {
        r = await s.deps.repo.run([...head, ...chunk], { attrTree: epochBase, okCodes: [0, 1], abort: watch.signal });
      } catch (e) {
        // an aborted grep exits with whatever status the kill left (rc not in okCodes); any other git failure (a spawn failure,
        // rc 128 on a missing object) cannot vouch for the hits either: incomplete, never an exception or a pass (P2)
        if (watch.signal.aborted || e instanceof GitCommandError) return 'incomplete';
        throw e;
      } finally {
        watch.stop();
      }
      if (r.aborted || watch.signal.aborted) return 'incomplete';
      for (const h of parseGrep(r.stdout, out.tree)) add(h.path, h.line);
    }
  }
  const wanted = new Set(paths);
  for (const [path, ref] of [...out.overlay].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    if (ref === 'ABSENT' || !wanted.has(path)) continue;
    if (deadline.expired()) return 'incomplete';
    const lines = await s.lines(ref, path);
    if (lines === 'MISSING') return 'incomplete';
    for (const row of wholeWordRows(lines, name)) add(path, row);
  }
  return [...found.keys()].sort(byCodeUnit).flatMap((path) => [...(found.get(path) as Set<number>)].sort((a, b) => a - b).map((line) => ({ path, line })));
}

// ---- The check ----------------------------------------------------------------------------------------------------------------------

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Thrown inside the check when it must stop; interfaceCheck turns it into incomplete. */
class Incomplete extends Error {
  constructor(readonly budget: 'grep' | 'caller') {
    super(`interface check incomplete (${budget})`);
  }
}

type Entry = { readonly blob: BlobRef; readonly mode: FileMode } | 'ABSENT';
type Side = 'base' | 'ours' | 'out';
type Image = Ranges | 'WHOLE_FILE';
type NoteKind = InterfaceResult['notes'][number]['kind'];

const symbolTable = (t: TableOrNone | null): RegionTable | null => (t !== null && !('kind' in t) && t.grammar !== null ? t : null);
const inRanges = (rs: Ranges, row: number): boolean => rs.some(([lo, hi]) => lo <= row && row <= hi);
const sameEntry = (a: Entry, b: Entry): boolean => (a === 'ABSENT' || b === 'ABSENT' ? a === b : blobOid(a.blob) === blobOid(b.blob) && a.mode === b.mode);
/** The units classification compares: labelled symbol units, class residues left out (they share their class's label). */
const comparable = (t: RegionTable | null): Unit[] => (t === null ? [] : t.units.filter((x) => x.granularity === 'symbol' && !x.residue && x.label.qualname !== ''));
const sliceText = (s: SigSlice | null): string => JSON.stringify(s);
/** Identifier-like tokens of a decoded row (the names a 'sites' job is asked for). */
const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const UPPER = /^[A-Z][A-Z0-9_]*$/u;

/** A Python method called on an instance (self., obj.) is passed its first parameter; a staticmethod is not. */
function bound(s: SigSlice): SigSlice {
  if (s.lang !== 'python' || s.unit !== 'function' || s.decorators.includes('staticmethod')) return s;
  const first = s.params[0];
  return first !== undefined && (first.kind === 'pos' || first.kind === 'posonly') ? { ...s, params: s.params.slice(1) } : s;
}

/** A breaking change with what the caller search needs to find its new definition. */
interface Change {
  readonly b: Breaking;
  readonly lang: Language;
  readonly baseUnit: Unit;
  /** The ours units that carry the new definition (empty for a removal). */
  readonly next: readonly Unit[];
}

class Check {
  readonly breaking: Breaking[] = [];
  readonly changes: Change[] = [];
  readonly incompatibleCallers = new Map<string, Finding>();
  readonly orphanCalls = new Map<string, Finding>();
  readonly unresolvedImports = new Map<string, Finding>();
  readonly notes = new Map<string, InterfaceResult['notes'][number]>();
  readonly added: Label[] = [];
  readonly signatureChanged: Label[] = [];
  readonly identifiers = new Set<string>();
  readonly imports = new Set<string>();
  incompleteBudget: 'grep' | 'caller' | null = null;
  /** CS paths whose ours differs from base, in path order. */
  readonly changed: string[] = [];
  private grepDeadline: Deadline | null = null;
  private readonly tables = new Map<string, Promise<TableOrNone | null>>();
  private readonly siteCache = new Map<string, Promise<readonly Site[]>>();
  private readonly images = new Map<string, Promise<Image>>();
  private grammarPathList: Promise<string[]> | null = null;

  constructor(readonly s: RegionService, readonly inp: InterfaceInput, readonly deadline: Deadline) {}

  view(side: Side): TreeView {
    return side === 'base' ? this.inp.base : side === 'ours' ? this.inp.ours : this.inp.out;
  }

  /** Which deadline stopped the check: the caller's wins; the caller search's own 4× stop otherwise. */
  which(): 'grep' | 'caller' {
    if (this.deadline.expired()) return 'caller';
    return this.grepDeadline !== null && this.grepDeadline.expired() ? 'grep' : 'caller';
  }

  /** The deadline that applies now: the caller's, or within the caller search the earlier of it and the search's own. */
  current(): Deadline {
    const g = this.grepDeadline;
    if (g === null) return this.deadline;
    const d = this.deadline;
    return Object.freeze({
      kind: g.kind,
      budgetMs: Math.min(d.budgetMs, g.budgetMs),
      expired: (): boolean => d.expired() || g.expired(),
      remainingMs: (): number => Math.min(d.remainingMs(), g.remainingMs()),
    });
  }

  check(): void {
    if (this.current().expired()) throw new Incomplete(this.which());
  }

  async entry(side: Side, path: string): Promise<Entry> {
    return this.view(side).entry(path);
  }

  /** The table of a side's path (null when absent); NO_TABLE{budget} (an overrun, a crash, a missing object) stops the check. */
  table(side: Side, path: string): Promise<TableOrNone | null> {
    const key = `${side}\u{0}${path}`;
    let t = this.tables.get(key);
    if (t === undefined) {
      t = (async () => {
        this.check();
        const e = await this.entry(side, path);
        if (e === 'ABSENT') return null;
        const r = await this.s.table(e.blob, path, { epochBase: this.inp.epochBase, mode: e.mode });
        if ('kind' in r && r.reason === 'budget') throw new Incomplete('caller');
        return r;
      })();
      this.tables.set(key, t);
    }
    return t;
  }

  async lines(side: Side, path: string): Promise<readonly Buffer[]> {
    const e = await this.entry(side, path);
    if (e === 'ABSENT') return [];
    const l = await this.s.lines(e.blob, path);
    if (l === 'MISSING') throw new Incomplete('caller');
    return l;
  }

  /** The 'sites' job on a side's path (names empty: every call and import), each site carrying that path. */
  sites(side: Side, path: string, lang: Language, names: readonly string[]): Promise<readonly Site[]> {
    const key = `${side}\u{0}${path}\u{0}${names.join('\u{0}')}`;
    let p = this.siteCache.get(key);
    if (p === undefined) {
      p = (async () => {
        this.check();
        const e = await this.entry(side, path);
        if (e === 'ABSENT') return [];
        const bytes = await this.s.bytes(e.blob, path);
        if (bytes === 'MISSING') throw new Incomplete('caller');
        const r = await this.s.deps.workers.run({ kind: 'sites', lang, ref: e.blob, bytes, names }, 'fg', this.current());
        if (r.kind === 'deadline') throw new Incomplete(this.which());
        if (r.kind !== 'ok') throw new Incomplete('caller');
        return r.value.sites.map((x) => ({ ...x, path }));
      })();
      this.siteCache.set(key, p);
    }
    return p;
  }

  note(path: string, line: number | null, kind: NoteKind): void {
    this.notes.set(`${path}\u{0}${line ?? 0}\u{0}${kind}`, { path, line, kind });
  }

  finding(into: Map<string, Finding>, f: Finding): void {
    into.set(`${f.path}\u{0}${String(f.line).padStart(10, '0')}\u{0}${f.name}`, f);
  }

  // ---- 1. classification (REG-26) ----------------------------------------------------------------------------------------------

  async classify(): Promise<void> {
    for (const p of [...new Set(this.inp.csPaths)].sort(byCodeUnit)) {
      this.check();
      const b = await this.entry('base', p);
      const o = await this.entry('ours', p);
      if (sameEntry(b, o)) continue;
      this.changed.push(p);
      if (p.endsWith('.json')) {
        await this.jsonNotes(p, b, o);
        continue;
      }
      if (languageOf(p) === null) continue;
      const tb = await this.table('base', p);
      const to = await this.table('ours', p);
      const sb = symbolTable(tb);
      const so = symbolTable(to);
      // an existing side without a symbol table (conflict markers, not decodable, no grammar) cannot be compared
      if ((tb !== null && sb === null) || (to !== null && so === null) || (sb === null && so === null)) continue;
      await this.classifyPath(p, (sb ?? so) as RegionTable, sb, so);
    }
  }

  private async jsonNotes(p: string, b: Entry, o: Entry): Promise<void> {
    if (b === 'ABSENT' || o === 'ABSENT') return;
    const before = await this.s.bytes(b.blob, p);
    const after = await this.s.bytes(o.blob, p);
    if (before === 'MISSING' || after === 'MISSING') throw new Incomplete('caller');
    const kb = jsonKeyPaths(before);
    const ko = jsonKeyPaths(after);
    if (kb === null || ko === null) return;
    const now = new Set(ko);
    if (kb.some((k) => !now.has(k))) this.note(p, null, 'json_key');   // a key path removed or renamed: a note in v1, never a Breaking
  }

  private async classifyPath(p: string, any: RegionTable, sb: RegionTable | null, so: RegionTable | null): Promise<void> {
    const lang = any.grammar as Language;
    const baseUnits = comparable(sb);
    const oursUnits = comparable(so);
    const group = (us: readonly Unit[]): Map<string, Unit[]> => {
      const m = new Map<string, Unit[]>();
      for (const x of us) {
        const k = labelKey(x.label);
        const list = m.get(k);
        if (list === undefined) m.set(k, [x]);
        else list.push(x);
      }
      return m;
    };
    const bm = group(baseUnits);
    const om = group(oursUnits);
    const paired = new Set<Unit>();
    const removed: Unit[] = [];
    for (const x of baseUnits) {
      const k = labelKey(x.label);
      const i = (bm.get(k) as Unit[]).indexOf(x);
      const partner = om.get(k)?.[i];
      if (partner === undefined) {
        removed.push(x);
        continue;
      }
      paired.add(partner);
      const v = classifyUnit(x, partner);
      if (sliceText(x.sigSlice) !== sliceText(partner.sigSlice)) this.signatureChanged.push(partner.label);
      if (v.cls === 'breaking') this.addBreaking(p, lang, x, v.breaking as BreakingKind, [partner]);
      else if (v.cls === 'note') await this.unitNote(p, x, partner);
    }
    for (const x of removed) {
      const others = this.successors(x, oursUnits);
      if (others.length === 0) {
        this.addBreaking(p, lang, x, 'removed', []);
        continue;
      }
      const verdicts = others.map((o) => classifyUnit(x, o));
      if (verdicts.some((v) => v.cls !== 'breaking')) continue;
      this.addBreaking(p, lang, x, verdicts[0]?.breaking ?? 'removed', others);
    }
    for (const x of oursUnits) if (!paired.has(x)) this.added.push(x.label);
  }

  /**
   * What a unit with no same-label partner became: the C# overloads of its (type, simple) pair, else a unit of the same qualname
   * (a platform branch, a setter beside its getter) — in both cases only a unit of the same shape (sameUnitShape: the same kind, or
   * two JS/TS callables). A name that survives only as another kind of unit (a function now a value or a class, a C# method now a
   * property) has no successor, so it is 'removed' (04 §3.10; P2).
   */
  private successors(x: Unit, ours: readonly Unit[]): Unit[] {
    const s = x.sigSlice;
    if (s !== null && s.lang === 'c_sharp' && (x.kind === 'method' || x.kind === 'ctor' || x.kind === 'operator' || x.kind === 'indexer')) {
      return ours.filter((o) => o.sigSlice !== null && o.sigSlice.lang === 'c_sharp' && o.sigSlice.overloadKey === s.overloadKey && sameUnitShape(x, o));
    }
    return ours.filter((o) => o.label.qualname === x.label.qualname && sameUnitShape(x, o));
  }

  private addBreaking(path: string, lang: Language, baseUnit: Unit, kind: BreakingKind, next: readonly Unit[]): void {
    const b: Breaking = { path, label: baseUnit.label, name: baseUnit.label.simple, kind, removal: kind === 'removed' };
    this.breaking.push(b);
    this.changes.push({ b, lang, baseUnit, next: kind === 'removed' ? [] : next });
  }

  private async unitNote(p: string, base: Unit, ours: Unit): Promise<void> {
    const bs = base.sigSlice;
    const os = ours.sigSlice;
    const decorator = bs !== null && os !== null && bs.lang === 'python' && os.lang === 'python' && bs.unit === 'function' && os.unit === 'function'
      && JSON.stringify(bs.decorators) !== JSON.stringify(os.decorators);
    const out = symbolTable(await this.table('out', p));
    const key = labelKey(ours.label);
    const hit = out?.units.find((x) => !x.residue && labelKey(x.label) === key);
    this.note(p, hit?.ranges[0]?.[0] ?? null, decorator ? 'decorator' : 'default_value');
  }

  // ---- 2. what the CS wrote in out ----------------------------------------------------------------------------------------------

  /** The image in out[p] of the rows the CS wrote in ours[p]; WHOLE_FILE when no row-level image exists (see the header). */
  image(p: string): Promise<Image> {
    let img = this.images.get(p);
    if (img === undefined) {
      img = (async (): Promise<Image> => {
        const rows = this.inp.csRows.get(p) ?? [];
        const o = await this.entry('ours', p);
        const x = await this.entry('out', p);
        if (rows.length === 0 || o === 'ABSENT' || x === 'ABSENT') return [];
        const oursLines = await this.lines('ours', p);
        const own = await this.map(await this.lines('base', p), oursLines, [[1, 1]]);
        if (own === 'WHOLE_FILE') return 'WHOLE_FILE';
        if (blobOid(o.blob) === blobOid(x.blob)) return rows;
        const m = await this.map(oursLines, await this.lines('out', p), rows);
        return m === 'TOMBSTONE' ? [] : m;
      })();
      this.images.set(p, img);
    }
    return img;
  }

  /** FoldMapper/1 in local mode as a worker job (its own 200 ms cap): an expired or crashed job is WHOLE_FILE (P2). */
  private async map(from: readonly Buffer[], to: readonly Buffer[], ranges: Ranges): Promise<Ranges | 'TOMBSTONE' | 'WHOLE_FILE'> {
    this.check();
    const r = await this.s.deps.workers.run({ kind: 'map', from, to, ranges, mode: 'local' }, 'fg', this.s.deps.budgets.deadline('map'));
    return r.kind === 'ok' ? r.value : 'WHOLE_FILE';
  }

  // ---- 3. referenced names (05 §8 Q2 default; R4-50) ----------------------------------------------------------------------------

  async referenced(): Promise<void> {
    for (const p of this.changed) {
      const rows = this.inp.csRows.get(p) ?? [];
      if (rows.length === 0) continue;
      const t = symbolTable(await this.table('ours', p));
      if (t === null) continue;
      const lines = await this.lines('ours', p);
      const tokens = new Set<string>();
      for (const [lo, hi] of rows) {
        for (let r = lo; r <= hi && r <= lines.length; r++) {
          for (const m of (decodeStrict(lines[r - 1] as Buffer) ?? '').matchAll(TOKEN)) tokens.add(m[0]);
        }
      }
      if (tokens.size === 0) continue;
      for (const x of await this.sites('ours', p, t.grammar as Language, [...tokens].sort(byCodeUnit))) {
        if (!inRanges(rows, x.line) || x.inComment || x.inString) continue;
        if (x.kind === 'identifier') this.identifiers.add(x.name);
        else if (x.kind === 'import' && x.name !== '*') this.imports.add(x.name);
      }
    }
  }

  // ---- module resolution (04 §3.10 "Import names") ---------------------------------------------------------------------------

  private async exists(path: string): Promise<boolean> {
    return path !== '' && !path.startsWith('../') && (await this.entry('out', path)) !== 'ABSENT';
  }

  /** Python: a dotted module (relative to the importer's package with leading dots) → `a/b.py`, then `a/b/__init__.py`; null when not a file of out. */
  async resolvePython(module: string, importer: string): Promise<string | null> {
    const dots = /^\.*/u.exec(module)?.[0].length ?? 0;
    const rest = module.slice(dots).replace(/\./gu, '/');
    let base: string;
    if (dots > 0) {
      let dir = posix.dirname(importer);
      for (let i = 1; i < dots; i++) {
        if (dir === '.' || dir === '') return null;
        dir = posix.dirname(dir);
      }
      const pkg = dir === '.' ? '' : dir;
      if (rest === '') return (await this.exists(posix.join(pkg, '__init__.py'))) ? posix.join(pkg, '__init__.py') : null;
      base = pkg === '' ? rest : `${pkg}/${rest}`;
    } else {
      base = rest;
    }
    for (const c of [`${base}.py`, `${base}/__init__.py`]) if (await this.exists(c)) return c;
    return null;
  }

  /** JS/TS: a relative specifier → the exact file when it names one, then `.ts .tsx .js .jsx .mjs .cjs`, then `/index.*`; bare specifiers are not local. */
  async resolveJs(spec: string, importer: string): Promise<string | null> {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
    const base = posix.normalize(posix.join(posix.dirname(importer), spec));
    if (base.startsWith('../') || base === '..') return null;
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
    const candidates = [...(exts.some((e) => base.endsWith(e)) ? [base] : []), ...exts.map((e) => `${base}${e}`), ...exts.map((e) => `${base}/index${e}`)];
    for (const c of candidates) if (await this.exists(c)) return c;
    return null;
  }

  /** Whether `name` is defined at module level of out[module] (an unparseable module cannot refute an import: true). */
  async defines(module: string, name: string, lang: 'python' | 'js'): Promise<boolean> {
    const t = symbolTable(await this.table('out', module));
    if (t === null) return true;
    const symbolRows = t.units.filter((x) => x.granularity === 'symbol' && x.leaf).flatMap((x) => x.ranges);
    const sites = await this.sites('out', module, t.grammar as Language, [name]);
    const moduleLevel = sites.some((x) => x.kind === 'identifier' && x.name === name && !x.inComment && !x.inString && !inRanges(symbolRows, x.line));
    if (lang === 'python') {
      if (t.units.some((x) => x.parentUnitId === null && x.label.simple === name && x.label.qualname !== '')) return true;
      if (sites.some((x) => x.kind === 'import' && (x.name === name || x.name === '*'))) return true;
      if (moduleLevel) return true;
      // `from pkg import sub` names a submodule file
      if (posix.basename(module) === '__init__.py') {
        const dir = posix.dirname(module) === '.' ? '' : `${posix.dirname(module)}/`;
        return (await this.exists(`${dir}${name}.py`)) || (await this.exists(`${dir}${name}/__init__.py`));
      }
      return false;
    }
    if (t.units.some((x) => x.sigSlice !== null && 'exported' in x.sigSlice && x.sigSlice.exported && x.sigSlice.exportName === name)) return true;
    if (sites.some((x) => x.kind === 'import' && x.receiver === 'type' && (x.name === name || x.name === '*'))) return true;
    return moduleLevel;
  }

  // ---- 4. callees of the CS's new calls (orphanCalls) and its import names ------------------------------------------------------

  /** The out signatures a definite call in out[p] resolves to, by 04 §3.10's definite rules; null when it resolves to none. */
  private async callee(p: string, t: RegionTable, sites: readonly Site[], c: Site): Promise<{ lang: Language; sigs: SigSlice[] } | null> {
    const lang = t.grammar as Language;
    const slices = (us: readonly Unit[], self: boolean): SigSlice[] => us.flatMap((x) => (x.sigSlice === null ? [] : [self ? bound(x.sigSlice) : x.sigSlice]));
    const topLevel = (table: RegionTable, name: string): Unit[] => table.units.filter((x) => !x.residue && x.parentUnitId === null && x.label.simple === name && x.label.type === '' && x.label.qualname !== '');
    if (lang === 'c_sharp') {
      let type: string | null = null;
      if (c.receiver === 'bare' || c.receiver === 'self') type = innermostType(t, c.line);
      else if (c.receiver === 'type') type = t.units.find((x) => !x.residue && x.kind === 'type' && x.label.simple === c.module)?.label.qualname ?? null;
      if (type === null) return null;
      const us = t.units.filter((x) => !x.residue && x.label.type === type && x.label.simple === c.name);
      return us.length === 0 ? null : { lang, sigs: slices(us, false) };
    }
    const fam: 'python' | 'js' = lang === 'python' ? 'python' : 'js';
    const resolve = (m: string): Promise<string | null> => (fam === 'python' ? this.resolvePython(m, p) : this.resolveJs(m, p));
    if (c.receiver === 'self') {
      const cls = innermostType(t, c.line);
      if (cls === null) return null;
      const us = t.units.filter((x) => !x.residue && x.label.type === cls && x.label.simple === c.name);
      return us.length === 0 ? null : { lang, sigs: slices(us, fam === 'python') };
    }
    let module: string | null = null;
    if (c.receiver === 'bare') {
      const local = topLevel(t, c.name);
      if (local.length > 0) return { lang, sigs: slices(local, false) };
      const imp = sites.find((x) => x.kind === 'import' && x.receiver !== 'type' && x.name === c.name && x.module !== null);
      if (imp === undefined || imp.module === null) return null;
      module = await resolve(imp.module);
    } else if (c.receiver === 'module' && c.module !== null) {
      module = await resolve(c.module);
    }
    if (module === null) return null;
    const mt = symbolTable(await this.table('out', module));
    if (mt === null) return null;
    const us = fam === 'js'
      ? mt.units.filter((x) => !x.residue && x.sigSlice !== null && 'exported' in x.sigSlice && x.sigSlice.exported && x.sigSlice.exportName === c.name)
      : topLevel(mt, c.name);
    return us.length === 0 ? null : { lang, sigs: slices(us, false) };
  }

  async callees(): Promise<void> {
    for (const p of this.changed) {
      const t = symbolTable(await this.table('out', p));
      if (t === null) continue;
      const img = await this.image(p);
      if (img !== 'WHOLE_FILE' && img.length === 0) continue;
      const sites = await this.sites('out', p, t.grammar as Language, []);
      for (const c of sites) {
        if (c.kind !== 'call' || c.args === null || (img !== 'WHOLE_FILE' && !inRanges(img, c.line))) continue;
        this.check();
        const def = await this.callee(p, t, sites, c);
        if (def === null) continue;
        const v = arityCompatible(def.lang, def.sigs, c.args);
        if (v === 'note') this.note(p, c.line, 'splat');
        else if (!v) this.finding(this.orphanCalls, { path: p, line: c.line, name: c.name, removal: false });
      }
    }
  }

  /** The names this CS removed from a module (the 'removed' breaking changes of top-level units of that path). */
  private removedFrom(module: string): Set<string> {
    return new Set(this.changes.filter((x) => x.b.removal && x.b.path === module && x.b.label.type === '').map((x) => x.b.name));
  }

  /** A local import of a name the resolved module of out does not define → unresolvedImports (removal when this CS removed it). */
  private async checkImport(p: string, x: Site, fam: 'python' | 'js'): Promise<void> {
    if (x.kind !== 'import' || x.module === null || x.name === '*') return;
    if (fam === 'python' && x.receiver === 'module') return;   // `import m` names a module, not a name in it
    if (fam === 'js' && x.name === 'default') return;          // 04 §3.10 checks JS/TS *named* imports only
    const module = fam === 'python' ? await this.resolvePython(x.module, p) : await this.resolveJs(x.module, p);
    if (module === null || (await this.defines(module, x.name, fam))) return;
    this.finding(this.unresolvedImports, { path: p, line: x.line, name: x.name, removal: this.removedFrom(module).has(x.name) });
  }

  async importNames(): Promise<void> {
    for (const p of this.changed) {
      const t = symbolTable(await this.table('out', p));
      if (t === null || t.grammar === 'c_sharp') continue;   // C# using/namespace resolution is deferred (glossary §22)
      const fam = t.grammar === 'python' ? 'python' : 'js';
      for (const x of await this.sites('out', p, t.grammar as Language, [])) {
        this.check();
        await this.checkImport(p, x, fam);
      }
    }
  }

  // ---- 5. callers of the breaking changes (incompatibleCallers) -----------------------------------------------------------------

  /** out's paths with a grammar (a symbol table is only possible there): the stored tree's and the overlay's present paths. */
  private grammarPaths(): Promise<string[]> {
    this.grammarPathList ??= (async () => {
      const out = this.inp.out;
      const paths = new Set<string>();
      if (out.tree !== null) for (const p of (await this.s.deps.repo.readTreeMap(out.tree)).keys()) if (languageOf(p) !== null) paths.add(p);
      for (const [p, ref] of out.overlay) {
        if (ref === 'ABSENT') paths.delete(p);
        else if (languageOf(p) !== null) paths.add(p);
      }
      return [...paths].sort(byCodeUnit);
    })();
    return this.grammarPathList;
  }

  /** The out units that define a breaking change's name now (its own rows are not callers). */
  private async definitions(ch: Change): Promise<Unit[]> {
    if (ch.b.removal) return [];
    const t = symbolTable(await this.table('out', ch.b.path));
    if (t === null) return [];
    const keys = new Set(ch.next.map((x) => labelKey(x.label)));
    const s = ch.baseUnit.sigSlice;
    return t.units.filter((x) => !x.residue && (keys.has(labelKey(x.label))
      || (s !== null && s.lang === 'c_sharp' && x.sigSlice !== null && x.sigSlice.lang === 'c_sharp' && x.sigSlice.overloadKey === s.overloadKey && x.label.simple === ch.b.name)));
  }

  /** Whether call c in out[h] is a definite call of ch's unit (04 §3.10 "definite"); possible calls are the caller's note. */
  private async definite(ch: Change, h: string, t: RegionTable, sites: readonly Site[], c: Site): Promise<boolean> {
    const label = ch.b.label;
    const d = ch.b.path;
    if (ch.lang === 'c_sharp') {
      if (c.receiver === 'bare' || c.receiver === 'self') return innermostType(t, c.line) === (label.type === '' ? label.qualname : label.type);
      const typeName = (label.kind === 'ctor' || label.type === '' ? label.qualname : label.type).split('.').pop();
      return c.receiver === 'type' && c.module === typeName;
    }
    const fam: 'python' | 'js' = ch.lang === 'python' ? 'python' : 'js';
    const resolve = (m: string): Promise<string | null> => (fam === 'python' ? this.resolvePython(m, h) : this.resolveJs(m, h));
    if (label.type !== '') return c.receiver === 'self' && h === d && innermostType(t, c.line) === label.type;
    if (c.receiver === 'bare') {
      if (h === d) return true;
      for (const imp of sites) {
        if (imp.kind !== 'import' || imp.receiver === 'type' || imp.name !== c.name || imp.module === null) continue;
        if ((await resolve(imp.module)) === d) return true;
      }
      return false;
    }
    return c.receiver === 'module' && c.module !== null && (await resolve(c.module)) === d;
  }

  async callers(): Promise<void> {
    const names = [...new Set(this.changes.map((x) => x.b.name))].sort(byCodeUnit);
    for (const name of names) {
      const changes = this.changes.filter((x) => x.b.name === name);
      if (CALLER_STOPLIST.has(name)) {
        for (const p of new Set(changes.map((x) => x.b.path))) this.note(p, null, 'stoplist');
        continue;
      }
      // R4-72: the caller search (the grep, the in-memory part and the hit filtering) also stops at its own 4× budget
      this.grepDeadline ??= this.s.deps.budgets.deadline('caller_grep', 4);
      this.check();
      const raw = await callerHits(this.s, this.inp.out, name, await this.grammarPaths(), this.inp.epochBase, this.current());
      if (raw === 'incomplete') throw new Incomplete(this.which());
      const own = new Map<string, Range[]>();
      for (const ch of changes) {
        for (const x of await this.definitions(ch)) own.set(ch.b.path, [...(own.get(ch.b.path) ?? []), ...x.ranges]);
      }
      const hits = raw.filter((h) => !inRanges(own.get(h.path) ?? [], h.line));
      if (hits.length > MAX_HITS_PER_NAME) {
        for (const p of new Set(changes.map((x) => x.b.path))) this.note(p, null, 'too_many_hits');
        continue;
      }
      for (const h of [...new Set(hits.map((x) => x.path))]) await this.callersIn(h, name, hits.filter((x) => x.path === h).map((x) => x.line), changes);
    }
  }

  private async callersIn(h: string, name: string, rows: readonly number[], changes: readonly Change[]): Promise<void> {
    this.check();
    const t = symbolTable(await this.table('out', h));
    if (t === null) return;   // no symbol table: its hits cannot be calls the check can classify
    const fam: 'python' | 'js' | 'c_sharp' = t.grammar === 'python' ? 'python' : t.grammar === 'c_sharp' ? 'c_sharp' : 'js';
    const sites = await this.sites('out', h, t.grammar as Language, [name]);
    const written = this.inp.csPaths.includes(h) ? await this.image(h) : [];
    for (const row of rows) {
      for (const c of sites.filter((x) => x.line === row && x.name === name)) {
        this.check();
        if (c.kind === 'import') {
          if (fam !== 'c_sharp' && changes.some((ch) => ch.b.removal)) await this.checkImport(h, c, fam);
          continue;
        }
        if (c.kind === 'identifier') {
          if (c.inString && UPPER.test(name)) this.note(h, row, 'possible');   // UPPER_CASE names keep their string hits (getattr(cfg, "NAME"))
          continue;
        }
        if (c.args === null || c.inComment || c.inString) continue;
        let definite: Change | null = null;
        for (const ch of changes) {
          if (await this.definite(ch, h, t, sites, c)) {
            definite = ch;
            break;
          }
        }
        if (definite === null) {
          // an attribute call on an unknown receiver (a C# `x.Name(…)` whose x is not the defining type is one too)
          if (c.receiver === 'other' || (fam === 'c_sharp' && c.receiver === 'type')) this.note(h, row, 'possible');
          continue;
        }
        if (written !== 'WHOLE_FILE' && inRanges(written, row)) continue;   // a call this CS wrote is its own (R1-142)
        if (definite.b.removal) {
          this.finding(this.incompatibleCallers, { path: h, line: row, name, removal: true });
          continue;
        }
        const defs = await this.definitions(definite);
        const method = definite.lang === 'python' && definite.b.label.type !== '';   // called through self., so its first parameter is bound
        const sigs = (defs.length > 0 ? defs : definite.next).flatMap((x) => (x.sigSlice === null ? [] : [method ? bound(x.sigSlice) : x.sigSlice]));
        const v = arityCompatible(definite.lang, sigs, c.args);
        if (v === 'note') this.note(h, row, 'splat');
        else if (!v) this.finding(this.incompatibleCallers, { path: h, line: row, name, removal: false });
      }
    }
  }

  result(): InterfaceResult {
    const sorted = <T>(m: Map<string, T>): T[] => [...m.keys()].sort(byCodeUnit).map((k) => m.get(k) as T);
    return {
      breaking: this.breaking,
      incompatibleCallers: sorted(this.incompatibleCallers),
      orphanCalls: sorted(this.orphanCalls),
      unresolvedImports: sorted(this.unresolvedImports),
      notes: [...this.notes.values()].sort((a, b) => byCodeUnit(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || byCodeUnit(a.kind, b.kind)),
      incomplete: this.incompleteBudget !== null,
      incompleteBudget: this.incompleteBudget,
      symbolDelta: { added: this.added, signatureChanged: this.signatureChanged },
      referencedNames: { identifiers: [...this.identifiers].sort(byCodeUnit), imports: [...this.imports].sort(byCodeUnit) },
    };
  }
}

/** The qualname of the innermost class or type whose extent holds the row (null at module level). */
function innermostType(t: RegionTable, row: number): string | null {
  let best: Unit | null = null;
  for (const x of t.units) {
    if (x.residue || x.leaf || !inRanges(x.ranges, row)) continue;
    if (best === null || x.label.qualname.length > best.label.qualname.length) best = x;
  }
  return best === null || best.label.qualname === '' ? null : best.label.qualname;
}

/**
 * Callers: git -c attr.tree=<EPOCH_BASE> grep -z -n -w -F -e <name> on out's stored tree with :(literal) paths and one
 * :(exclude,literal) per searched overlay path (split over several greps on a long path list), plus the same whole-word
 * fixed-string predicate over the overlay's in-memory line arrays (the union equals a grep of out); callees of the CS's new calls;
 * import names; a deadline or a failed git call (GitCommandError) → incomplete.
 * The caller search (part (i), part (ii) and the hit filtering) runs under the earlier of `deadline` and one
 * s.deps.budgets.deadline('caller_grep', 4) created when the search starts (R4-72); incompleteBudget names the one that expired.
 * Writes nothing (REG-02, REG-35); raises no code (REGION_BUDGET is the T0 binding's).
 */
export async function interfaceCheck(s: RegionService, inp: InterfaceInput, deadline: Deadline): Promise<InterfaceResult> {
  const c = new Check(s, inp, deadline);
  try {
    c.check();
    await c.classify();
    await c.referenced();
    await c.callees();
    await c.importNames();
    await c.callers();
  } catch (e) {
    if (e instanceof Incomplete) c.incompleteBudget = e.budget;
    else if (e instanceof GitCommandError) c.incompleteBudget = 'caller';   // a failed git read (ls-tree of a missing tree, a spawn failure): incomplete, never an exception (P2)
    else throw e;
  }
  return c.result();
}
