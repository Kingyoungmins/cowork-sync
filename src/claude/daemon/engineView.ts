// src/claude/daemon/engineView.ts — everything Plan 5 reads from the engine, from memory only (no git process, no file
// read; CCI-12): the EngineView interface and its production binding engineView(e, core).
import { engineScope, flowAnchors, type EngineCore } from '../../engine/core.js';
import { portable, type PortRule } from '../../data/scope.js';
import type { Anchor } from '../../ports/clock.js';
import type { TreeMap } from '../../git/repo.js';
import type { NotSharedReason, ScopeClass } from '../../data/scope.js';
import type { DeferReason } from '../../holds/groups.js';
import type { FoldState } from '../../board/fold.js';
import type { PublishPause, StatusJson } from '../../engine/status.js';
import type { FreezeReason } from '../../engine/meta.js';
import type { HoldRegistry } from '../../holds/registry.js';
import type { OidOrAbsent } from '../../git/oid.js';
import { ABSENT } from '../../git/oid.js';
import type { FsLstat } from '../../ports/fs.js';
import type { PeerId } from '../../board/ids.js';
import type { OpDraft } from '../../board/ops.js';
import type { Engine } from '../../engine/loop.js';
import { LOOP_ACTIVE_MS } from '../../engine/loop.js';

export interface EngineView {
  peer(): PeerId; displayName(peer: PeerId): string;
  A(): TreeMap; tipHeight(): number; foldedHeight(): number; fold(): FoldState;
  scopeOf(path: string): { cls: ScopeClass; reason: NotSharedReason | null };                         // D5 scopeOfTracked; D6 admitNew for a new path
  portability(path: string): { ok: true } | { ok: false; reason: string; suggestion: string };       // D7 portable()
  modeOf(path: string): string | null; symlinksEnabled(): boolean;                                   // gate row 7
  pathState(path: string): Promise<'idle' | 'applying' | 'pending' | 'busy'>;                         // Writer.pathState (ENG-38)
  pendingReason(path: string): DeferReason | null;                                                    // meta.pending (R5-30)
  offline(): { offline: boolean; offlineForMs: number }; publishPause(): PublishPause | null; freezeReasons(): readonly FreezeReason[];
  heldRanges(path: string): ReadonlyArray<readonly [number, number]>;                                 // HLD-21 (A12-3), else Plan 3's Engine.heldRanges
  materializedOid(path: string): OidOrAbsent | null;                                                  // A12-2: the last materialized S_disk[p]
  openCsOf(seatId: string, agentId: string | null): string | null;                                    // A6-6 (Task 6; Task 12 uses it unchanged)
  csPaths(csId: string): readonly string[];                                                           // A6-6: that CsTableEntry's paths
  addOps(drafts: readonly OpDraft[]): void;                                                           // A12-2: the outbox binding SeatRegistry also uses
  untracked(): Promise<readonly string[]>;                                                            // A12-2: Plan 2's untracked listing; never on the gate path
  snapshotEntries(): ReadonlyMap<string, { oid: OidOrAbsent; stat: FsLstat | null }>;                 // A8-8: the newest completed snapshot's private-index entries
  registry(): HoldRegistry; lastStatus(): StatusJson | null; loopPeriodMs(): number;              // A5-8: lastStatus = Plan 2's Engine.lastStatusJson()
  ownAnchors(): { lastFetch: Anchor | null; lastPush: Anchor | null; suspendGapMs: number };          // PRO-37 (R5-06)
  checkpointCommands(): readonly string[];                                                            // TeamConfig.checks.checkpoint (R5-23)
  teamLanguage(): string | null;                                                                      // X-53 input: the team config's language; null when absent
  peerFoldedAgoMs(peer: PeerId): number | null;   // F05-11
  foldRecencyUncertain(): boolean;                // CCI-65
  /** A5-8 (F05-11), called by the engineView ticker and the seat.register step: stamps nowMono for every (peer, epoch)
   *  whose per-writer last_seq grew; peerFoldedAgoMs(peer) = now − the newest stamp of any epoch of that peer, null
   *  before one; foldRecencyUncertain() is true from attach until the first observation after the first completed
   *  iteration, and again from an observed publish_pause OFFLINE or AUTH until the first observation that follows the
   *  pause's clearing and a fetch that succeeded after the last observation that saw the pause (plan 1283-1287, 2759;
   *  CCI-65; F2 #51). */
  observe(nowMono: number): void;
}

/** D7 rows (03-data §3.7): the reason and suggested rename the gate shows with `PORTABILITY`. */
const PORT_RULE_TEXT: Readonly<Record<PortRule, { reason: string; suggestion: string }>> = Object.freeze({
  1: { reason: 'the path is not Unicode NFC', suggestion: 'rename the file with its name composed (NFC)' },
  2: { reason: 'the name is not valid on every OS the team uses', suggestion: 'rename the file to a name without < > : " | ? * or control characters, not a device name, with no trailing dot or space' },
  3: { reason: 'the whole path is longer than 200 characters', suggestion: 'move the file to a shorter path' },
  4: { reason: 'the name collides with another name on a case-insensitive volume', suggestion: 'rename the file so its name differs from every existing name beyond letter case' },
});

/** The production binding over an Engine and its core (memory only). */
export function engineView(e: Engine, core: EngineCore): EngineView {
  const scopeOf = engineScope(core);
  // A5-8: per (peer, epoch) stamps of the fold step 5 last_seq growth, and the recency state machine.
  const foldedAt = new Map<string, number>();            // key `<peer>/<epoch>` → nowMono of the newest observation that saw it grow
  let lastSeqs = new Map<string, number>();              // the last-seen per-writer last_seq, key `<peer>/<epoch>`
  let uncertain = true;                                  // from attach (the plan's line: use lastStatus() !== null as the completed-iteration marker)
  // An observed OFFLINE/AUTH publish pause re-arms the uncertainty (CCI-65, A5-8; F2 #51): pauseArmed holds it until
  // an observation after the pause cleared sees a fetch newer than pauseFetchMark, the fetcher's last success as of
  // the last observation that saw the pause (a fetch during the pause does not count).
  let pauseArmed = false;
  let pauseFetchMark: number | null = null;
  return {
    peer: () => e.peerId,
    displayName(peer) {
      const rec = this.fold().peers[peer];
      return rec?.display ?? peer;
    },
    A: () => core.view?.base !== undefined ? (flowAnchors(core).tip ?? new Map()) : new Map(),
    tipHeight: () => core.view?.fold?.height ?? 0,
    foldedHeight: () => core.view?.meta.fold_verified?.height ?? core.view?.fold?.height ?? 0,
    fold: () => {
      const f = core.view?.fold;
      if (f === null || f === undefined) throw new Error('engineView: no fold before the first state');
      return f;
    },
    scopeOf,
    portability(path) {
      const r = portable(path, new Set());
      if (r.ok) return r;
      const t = PORT_RULE_TEXT[r.rule];
      return { ok: false, reason: t.reason, suggestion: t.suggestion };
    },
    modeOf(path) {
      const entry = this.A().get(path);
      return entry?.mode ?? null;
    },
    symlinksEnabled: () => true,   // DECISION (engineView.ts): gate row 7 needs core.symlinks; no engine memory holds it and a configGet is a
                                   // git call (banned here), so Phase 2 answers true (gate row 7 never fires) — Phase 3 (claudeDaemon) must read
                                   // core.symlinks once at bind and pass it in; recorded as a decision point in the task report.
    pathState: (path) => core.writer.pathState(path),
    pendingReason: (path) => core.view?.meta.pending[path] ?? null,
    offline: () => core.fetcher.offline(),
    publishPause: () => e.lastStatusJson()?.publish_pause ?? null,
    freezeReasons: () => core.view?.meta.freeze_reasons ?? [],
    heldRanges: (path) => e.heldRanges(path),
    materializedOid(path) {
      const m = core.snapshot.last();
      const entry = m?.sDiskMap.get(path);
      return entry === undefined ? null : entry.oid;
    },
    openCsOf(seatId, agentId) {
      void agentId;   // A6-6 (Task 6): the seat CS; agentId refines nothing in Plan 3's table
      const hit = core.cs.table().cs.find((c) => c.seat === seatId && c.state === 'open');
      return hit?.cs_id ?? null;
    },
    csPaths(csId) {
      return core.cs.table().cs.find((c) => c.cs_id === csId)?.paths ?? [];
    },
    addOps: (drafts) => { for (const d of drafts) core.outbox.add(d); },
    async untracked() {
      // The one allowed listing command (W1): `ls-files -o --exclude-standard -z` on the private index, the same
      // command and config the snapshot's own rescan uses. Never on the gate path.
      const r = await core.repo.run(['ls-files', '-o', '--exclude-standard', '-z'], {});
      const out: string[] = [];
      for (const rec of r.stdout.toString('utf8').split('\0')) {
        if (rec.length === 0) continue;
        out.push(rec.endsWith('/') ? rec.slice(0, -1) : rec);
      }
      return out;
    },
    snapshotEntries: () => {
      const m = core.snapshot.last();
      if (m === null) return new Map();
      const out = new Map<string, { oid: OidOrAbsent; stat: FsLstat | null }>();
      for (const [p, entry] of m.sDiskMap) out.set(p, { oid: entry.oid, stat: core.statCache.get(p)?.stat ?? null });
      for (const [p, se] of core.statCache.entries()) if (!out.has(p)) out.set(p, { oid: ABSENT, stat: se.stat });
      return out;
    },
    registry: () => core.holds,
    lastStatus: () => e.lastStatusJson(),
    loopPeriodMs: () => e.lastStatusJson()?.loop_period_ms ?? LOOP_ACTIVE_MS,
    ownAnchors: () => {
      const lastOk = core.fetcher.lastSuccessMono();
      const clock = core.deps.ports.clock;
      const now = clock.monoMs();
      const lastFetch: Anchor | null = lastOk === null ? null : { mono: lastOk, wall: clock.wallMs() - (now - lastOk) };
      const lastPush: Anchor | null = core.lastPushMono === null ? null : { mono: core.lastPushMono, wall: clock.wallMs() - (now - core.lastPushMono) };
      return { lastFetch, lastPush, suspendGapMs: 0 };
    },
    checkpointCommands: () => core.config.checks.checkpoint,
    teamLanguage: () => null,   // DECISION: the team config's language is not a TeamConfig field in Plan 2/3's loader (config.ts has no
                                // `language`); Phase 3's lenient read owns it. null until then.
    peerFoldedAgoMs(peer) {
      let newest: number | null = null;
      for (const [key, at] of foldedAt) if (key.startsWith(`${peer}/`) && (newest === null || at > newest)) newest = at;
      if (newest === null) return null;
      return Math.max(0, core.deps.ports.clock.monoMs() - newest);
    },
    foldRecencyUncertain: () => uncertain,
    observe(nowMono) {
      const f = core.view?.fold ?? null;
      if (f !== null) {
        for (const [peer, rec] of Object.entries(f.peers)) {
          const key = `${peer}/${rec.epoch}`;
          const prev = lastSeqs.get(key);
          if (prev === undefined || rec.last_seq > prev) {
            lastSeqs.set(key, rec.last_seq);
            foldedAt.set(key, nowMono);
          }
        }
      }
      const pause = e.lastStatusJson()?.publish_pause ?? null;
      if (pause === 'OFFLINE' || pause === 'AUTH') {
        uncertain = true;
        pauseArmed = true;
        pauseFetchMark = core.fetcher.lastSuccessMono();
        return;
      }
      if (pauseArmed) {
        // Cleared: the first observation that follows the first post-pause fetch ends the re-armed uncertainty.
        const fetched = core.fetcher.lastSuccessMono();
        if (fetched !== null && (pauseFetchMark === null || fetched > pauseFetchMark)) {
          uncertain = false;
          pauseArmed = false;
        }
        return;
      }
      // Completed-iteration marker: lastStatus() !== null (the loop's first report).
      if (e.lastStatusJson() !== null) uncertain = false;
    },
  };
}
