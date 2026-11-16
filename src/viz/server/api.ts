// The routes' data contract (12 §3.10.5; WorldApi of models.ts; R-V15, R-V22, R-V29, R-V49): the world snapshot recomputed at
// most once per 2.5 s (Δmono) whatever the number of tabs and only after every store is ready, timeline pages with their layout
// deltas announced on the stream before the page returns, the en strings of the page subset, and the poll sink that projects
// what the poll loop reports onto the stream. Every served value comes from project.ts. A handle collision (R-V22) makes
// earlier served handles stale: the value is re-projected with the extended handles, the cached world is dropped and one reset
// tells every page to reload the world.
import { LANGS, type CatalogEntry } from '../../i18n/render.js';
import type { Clock } from '../../ports/clock.js';
import { EN_VIZ } from '../i18n/en.js';
import { PAGE_CODES } from '../i18n/codes.js';
import type { PeerRef } from '../model/events.js';
import type { DemoCaption, Overlay } from '../source/roomSource.js';
import type { PollSink, RoomDelta, RoomSnapshotModel, StoreLike, WorldApi } from './models.js';
import {
  projectCharacters, projectDelta, projectOverlay, projectPage, projectRoomHeader, projectWorld, tagCollisions, type HandleTable,
} from './project.js';
import type { StreamHub } from './stream.js';
import type { CatalogEntryVM, Strings, TimelinePage, World } from './viewModel.js';
import { nullVizLog, type VizLog } from './vizLog.js';

/** The world is recomputed at most once per this many ms of Δmono (12 §3.10.5; the poll period). */
const WORLD_MS = 2_500;

/** What pollSinkFor needs of an api createWorldApi made (module-private: the WorldApi interface stays the routes' contract). */
interface ApiState {
  readonly stores: readonly StoreLike[];
  readonly handles: HandleTable;
  readonly hub: StreamHub;
  readonly clock: Clock;
  readonly demo: boolean;
  /** The stores whose ready resolved (the sink is synchronous and asks only those for a snapshot). */
  readonly ready: Set<StoreLike>;
  /** Each store's room id, learnt from its first snapshot (a store's RoomSpec never changes). */
  readonly ids: Map<StoreLike, string>;
  /** The last world: pending (at null) or computed at Δmono `at` with stream cursor `cursor`. */
  cache: { at: number | null; cursor: number | null; world: Promise<World> } | null;
  /** Per room, the peers whose name tags showed their handle when last served (a change re-sends those characters, R-V52). */
  readonly collide: Map<string, ReadonlySet<PeerRef>>;
}
const STATE = new WeakMap<WorldApi, ApiState>();

function internals(api: WorldApi): ApiState {
  const st = STATE.get(api);
  if (st === undefined) throw new TypeError('pollSinkFor: the api was not made by createWorldApi');
  return st;
}

function storeOf(st: ApiState, roomId: string): StoreLike | null {
  for (const s of st.stores) {
    let id = st.ids.get(s);
    if (id === undefined && st.ready.has(s)) {
      id = s.snapshot().spec.id;
      st.ids.set(s, id);
    }
    if (id === roomId) return s;
  }
  return null;
}

/** A reset after a handle collision or a rebuilt room: every page reloads the world, which must not be the cached one. */
function resetAll(st: ApiState): void {
  st.cache = null;
  st.hub.publish({ type: 'reset' });
}

/** R-V15: { lang: 'en', templates } of PAGE_CODES (the reason codes' templates included, R-V43), the same for each of the six codes. */
function pageStrings(): Strings {
  const templates: Record<string, CatalogEntryVM> = {};
  for (const code of [...PAGE_CODES].sort()) {
    const e: CatalogEntry | undefined = EN_VIZ[code];
    if (e !== undefined) templates[code] = structuredClone(e) as CatalogEntryVM;
  }
  return { lang: 'en', templates };
}

export function createWorldApi(o: { stores: readonly StoreLike[]; handles: HandleTable; hub: StreamHub; clock: Clock; demo: boolean;
                                    captions: readonly DemoCaption[] }): WorldApi {
  const st: ApiState = {
    stores: o.stores, handles: o.handles, hub: o.hub, clock: o.clock, demo: o.demo, ready: new Set(), ids: new Map(), cache: null, collide: new Map(),
  };
  for (const s of o.stores) void s.ready.then(() => { st.ready.add(s); }, () => {});
  const strings = pageStrings();
  const allReady = (): Promise<void> => Promise.all(o.stores.map((s) => s.ready)).then(() => undefined);

  const compute = async (entry: { at: number | null; cursor: number | null }): Promise<World> => {
    await allReady();
    const models: RoomSnapshotModel[] = o.stores.map((s) => s.snapshot());
    o.stores.forEach((s, i) => st.ids.set(s, models[i]!.spec.id));
    entry.at = o.clock.monoMs();
    for (;;) {
      // The cursor is the sequence number of the last stream event this world includes; read with the snapshots, and again after a reset
      // this projection publishes, so the page never replays that reset.
      const world = projectWorld(models, o.hub.seq(), o.demo, o.captions, o.clock.monoMs(), o.handles);
      if (!o.handles.takeCollision()) {
        for (const m of models) st.collide.set(m.spec.id, tagCollisions(m.peers, m.looks));
        entry.cursor = world.cursor;
        return world;
      }
      o.hub.publish({ type: 'reset' });
    }
  };

  /** A computed world goes stale before WORLD_MS when the hub has since emitted a reset after its cursor (an oversize payload's, a
   *  collision's: the reloading page would replay it and reload again) or its ring no longer covers the cursor (the page's resume
   *  would get a reset) — 8a final review, the reset/world-cache loop (spec-edit 12 §3.10.5). */
  const fresh = (cursor: number): boolean => cursor >= o.hub.lastReset() && o.hub.covers(cursor);

  const api: WorldApi = {
    world(): Promise<World> {
      const c = st.cache;
      if (c !== null && (c.at === null || c.cursor === null || (o.clock.monoMs() - c.at < WORLD_MS && fresh(c.cursor)))) return c.world;
      const pending = { at: null as number | null, cursor: null as number | null };
      const entry = Object.assign(pending, { world: compute(pending) });
      st.cache = entry;
      entry.world.catch(() => { if (st.cache === entry) st.cache = null; });
      return entry.world;
    },

    async page(roomId: string, from: number, to: number): Promise<TimelinePage | null> {
      await allReady();
      const store = storeOf(st, roomId);
      if (store === null) return null;
      const m = await store.page(from, to);
      if (m === null) return null;
      let p = projectPage(m, o.clock.monoMs(), o.handles);
      if (o.handles.takeCollision()) {
        resetAll(st);
        p = projectPage(m, o.clock.monoMs(), o.handles);
      }
      // R-V49: the appended desks go to every open stream before the requesting tab gets its page (which carries the same delta).
      if (p.layout !== null) o.hub.publish({ type: 'layout', room_id: p.room_id, layout: p.layout });
      return p;
    },

    strings(lang: string): Strings | null {
      return (LANGS as readonly string[]).includes(lang) ? strings : null;
    },
  };
  STATE.set(api, st);
  return api;
}

/** Projects and publishes what the poll loop reports: a layout message before its timeline or snapshot; characters re-projected over the
 *  whole room (name tags, ph) with every peer whose tag collision changed; a handle collision → one reset instead of stale handles.
 *  A failing projection or publish is logged here (UI_INTERNAL_ERROR; the poll loop has no log) and rethrown, so the loop ends that
 *  tick with a reset (Task 8 fix round 1; `log` is an additive parameter — the viewer passes its own log). */
export function pollSinkFor(api: WorldApi, hub: StreamHub, handles: HandleTable, clock: Clock, log: VizLog = nullVizLog): PollSink {
  const st = internals(api);

  /** fn, with a failure logged and rethrown (a line the log refuses is dropped: logging never hides the failure). */
  const logged = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): void => {
    try {
      fn(...args);
    } catch (e) {
      try {
        log.error('UI_INTERNAL_ERROR', e);
      } catch {
        // the log refused the line
      }
      throw e;
    }
  };

  /** The delta's characters over the whole room (the store's state after the tick that made the delta). */
  const withRoom = (d: RoomDelta, payloads: ReturnType<typeof projectDelta>): ReturnType<typeof projectDelta> => {
    const store = storeOf(st, d.roomId);
    if (store === null) return payloads;
    const m = store.snapshot();
    const collide = tagCollisions(m.peers, m.looks);
    const prev = st.collide.get(d.roomId);
    st.collide.set(d.roomId, collide);
    const only = new Set<PeerRef>(d.peers.keys());
    if (prev !== undefined) {
      for (const p of collide) if (!prev.has(p)) only.add(p);
      for (const p of prev) if (!collide.has(p)) only.add(p);
    }
    const characters = projectCharacters({ peers: m.peers, looks: m.looks, scene: m.scene, at: m.scene.at }, only, handles);
    return payloads.map((p) => (p.type === 'timeline' || p.type === 'room_snapshot' ? { ...p, characters } : p));
  };

  const publishAll = (payloads: ReturnType<typeof projectDelta>): void => {
    if (handles.takeCollision()) {
      resetAll(st);
      return;
    }
    for (const p of payloads) hub.publish(p);
  };

  return {
    delta: logged((d: RoomDelta): void => {
      publishAll(withRoom(d, projectDelta(d, clock.monoMs(), handles)));
    }),
    overlay: logged((roomId: string, ov: Overlay): void => {
      if (st.demo) return;
      const overlay = projectOverlay(ov, handles);
      if (overlay !== null) publishAll([{ type: 'overlay', room_id: roomId, overlay }]);
    }),
    roomChanged: logged((roomId: string): void => {
      const store = storeOf(st, roomId);
      if (store === null) return;
      const r = projectRoomHeader(store.snapshot());
      publishAll([{ type: 'room', room_id: r.room_id, change: 'state', label: r.label, branch: r.branch, gone: r.gone, badges: r.badges, unknown: r.unknown }]);
    }),
    reset: logged((): void => {
      resetAll(st);
    }),
  };
}
