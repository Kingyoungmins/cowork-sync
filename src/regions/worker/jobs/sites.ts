// The 'sites' job: call, import and identifier sites with rows for the interface check (04 §3.10; REG-26, REG-27). It parses
// the blob in this worker's ParserHost (the same content-addressed key as the 'table' job, so a live tree is replaced only by a
// tree of the same bytes) and walks it with slices.ts' sitesOf. `names` empty: every call and import site; otherwise every
// import site plus the calls and identifier occurrences (comments and strings included, flagged) of those names. A Site's path
// is the DiskSnapshotId's path, '' for a stored oid (the main thread names the path it asked for). Bytes with no tree (a
// grammar this worker could not load, not UTF-8) throw: the caller sees 'crashed' and degrades to incomplete, never to "no
// sites" (P2).
import type { SiteSet } from '../../interface.js';
import type { RegionJob } from '../../pool.js';
import { isDisk, type BlobRef, type Language } from '../../types.js';
import type { JobCtx } from '../jobs.js';
import { sitesOf } from '../slices.js';

/** The 'table' job's parse key (content-addressed). */
function parseKey(lang: Language, ref: BlobRef): string {
  return isDisk(ref) ? `${lang}:disk:${ref.oid}:${ref.path}` : `${lang}:${ref}`;
}

export async function handle(job: Extract<RegionJob, { kind: 'sites' }>, ctx: JobCtx): Promise<SiteSet | 'deadline'> {
  const tree = ctx.parser.parse(job.lang, job.bytes, parseKey(job.lang, job.ref), ctx.deadline);
  if (tree === 'deadline') return 'deadline';
  if (tree === 'unavailable') throw new Error(`job sites: no ${job.lang} tree for this blob`);
  const sites = sitesOf(job.lang, tree.rootNode, isDisk(job.ref) ? job.ref.path : '', new Set(job.names), ctx.deadline);
  return sites === 'deadline' ? 'deadline' : { sites };
}
