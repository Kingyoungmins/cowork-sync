// What an engine is built from (01-engine §3.5): the ports, the trace and log, the lease, attribution, the
// repository and branch identity, and the test-build switches (rulings R-11, R-25, R-29, R-35).
import { createHash } from 'node:crypto';
import type { RepoPaths } from '../git/repo.js';
import type { Ports } from '../ports/index.js';
import type { LeasePort } from '../ports/lease.js';
import type { Log } from '../ports/log.js';
import type { Trace } from '../ports/trace.js';
import type { RefNamespace } from './refs.js';

export type MutantId = 'M05' | 'M06' | 'M07' | 'M12' | 'M17' | 'M18' | 'M20';   // ruling R-29; one site each

/**
 * Whether a removal or a large shrink of a path is attributed to an actor (glossary §20, ENG-25, HLD-32).
 * Plan 5 binds hook windows for seat deltas; until then a human edit is never attributed by a hook.
 */
export interface AttributionPort { removalAttributed(path: string): boolean; shrinkAttributed(path: string): boolean; }

/**
 * Ruling R-25: a human shrink publishes once two detection ticks ≥ 1 s apart (Δmono) saw the same shrunken
 * stat, so shrinks count as attributed; deletions keep the 1 s two-read rule, so removals do not.
 */
export const humanOnlyAttribution: AttributionPort = Object.freeze({
  removalAttributed: (_path: string): boolean => false,
  shrinkAttributed: (_path: string): boolean => true,
});

/** sha256, lowercase hex, over the parts sorted by UTF-16 code units and joined by '\n'; a part holding '\n' throws. */
export function regionSpecId(parts: readonly string[]): string {
  for (const p of parts) {
    if (typeof p !== 'string' || p.includes('\n')) throw new TypeError(`regionSpecId: invalid part ${JSON.stringify(p)}`);
  }
  return createHash('sha256').update(Buffer.from([...parts].sort().join('\n'), 'utf8')).digest('hex');
}

/** The regionSpec of a Plan 2 build (PRO-47, PRO-48): no grammars yet (Plan 4). */
export const PLAN2_REGION_SPEC: string = regionSpecId(['FoldMapper/1', 'extent-convention/1', 'label-convention/1']);

export interface EngineDeps {
  ports: Ports;                    // git = createGitRunner with hooksPath <coworkDir>/empty-hooks, DAEMON_ENV, sshCommand, testBuild
  trace: Trace; log: Log; lease: LeasePort; attribution: AttributionPort;
  heartbeatMs: () => number;       // R-35
  paths: RepoPaths;
  branch: string; namespace: RefNamespace;
  url: string;                     // pinned URL, never a remote name
  display: string;                 // validName-checked
  pluginVersion: string; pluginSha: string; regionSpec: string;
  platform: NodeJS.Platform;
  testBuild: boolean; testMutants: ReadonlySet<MutantId>;
}
