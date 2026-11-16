// The 'table' job: a RegionTable or NO_TABLE for one blob (04 §3.3; REG-05, REG-06; R1-081, R4-14). Class 6 is the block table
// of the raw 0x0A split (no parse); class 4 parses in this worker's ParserHost — incrementally from prevRef's live tree when
// that tree is still live (≤ BUDGETS.liveTreesPerWorker per worker), which gives the same tree as a cold parse — and builds
// the symbol table. A parse key names the language and the blobRef, so it is content-addressed; the bytes of the live trees
// are kept here per ParserHost (pruned to that host's live keys) to build the incremental edit (lineTable.inputEdit).
import type { RegionJob } from '../../pool.js';
import { isDisk, type BlobRef, type Language, type TableOrNone } from '../../types.js';
import type { JobCtx } from '../jobs.js';
import { lineArray } from '../../lines.js';
import { inputEdit } from '../lineTable.js';
import { blockTable, buildTable } from '../tables.js';

/** The parse key of a blob in a language: content-addressed (an oid, or a DiskSnapshotId's path and oid). */
function parseKey(lang: Language, ref: BlobRef): string {
  return isDisk(ref) ? `${lang}:disk:${ref.oid}:${ref.path}` : `${lang}:${ref}`;
}

/** Per ParserHost: the bytes of its recently parsed keys (content-addressed), pruned to that host's live keys. One map per host,
 *  so several hosts in one realm (inline workers of several SIM peers) keep their own incremental-parse state. */
const recentByHost = new WeakMap<JobCtx['parser'], Map<string, Buffer>>();

export async function handle(job: Extract<RegionJob, { kind: 'table' }>, ctx: JobCtx): Promise<TableOrNone | 'deadline'> {
  if (job.cls === 6) return blockTable(job.bytes, job.regionSpec);
  if (job.lang === null) throw new Error('job table: a class-4 table needs a language');
  let recent = recentByHost.get(ctx.parser);
  if (recent === undefined) {
    recent = new Map();
    recentByHost.set(ctx.parser, recent);
  }
  const key = parseKey(job.lang, job.ref);
  let old: { key: string; edit: unknown } | undefined;
  if (job.prevRef !== null) {
    const prevKey = parseKey(job.lang, job.prevRef);
    const prevBytes = recent.get(prevKey);
    if (prevKey !== key && prevBytes !== undefined && ctx.parser.liveKeys().includes(prevKey)) old = { key: prevKey, edit: inputEdit(prevBytes, job.bytes) };
  }
  const tree = ctx.parser.parse(job.lang, job.bytes, key, ctx.deadline, old);
  if (tree === 'deadline') return 'deadline';
  // This worker's grammar did not load (or the bytes are not UTF-8): no table here; the caller degrades like a budget overrun (P2).
  if (tree === 'unavailable') return { kind: 'NO_TABLE', reason: 'budget', lineCount: lineArray(job.bytes).length };
  recent.set(key, job.bytes);
  const live = new Set(ctx.parser.liveKeys());
  for (const k of recent.keys()) if (!live.has(k)) recent.delete(k);
  return buildTable(job.lang, tree, job.bytes, job.regionSpec, ctx.deadline);
}
