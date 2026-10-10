// Room-store fixtures (Plan 8a Task 8; 12 §3.3.3, §3.9, §3.10.5): a RoomSource spy that counts folds (frames yielded, one
// foldCommit each) and records every startAt/frames call with the `self` it folds with; a VizGit whose runner records every
// git child and the most in flight at once; a git room (GitRoomSource + RoomStore) over a fixture clone and a VirtualClock;
// status.json and peer-file writers; a reference fold of the same chain by a fresh source; R-V28's tick glyphs; a deep scan
// for canary values; and a hidden loose object (a partial clone).
import { existsSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRunner, GitResult } from '../../src/git/runner.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import { realFs } from '../../src/ports/fs.js';
import type { Clock } from '../../src/ports/clock.js';
import type { Card } from '../../src/viz/model/cards.js';
import type { Position, SceneEvent } from '../../src/viz/model/events.js';
import { ZERO_PEER, type Frame } from '../../src/viz/model/frame.js';
import type { Layout } from '../../src/viz/model/layout.js';
import { reduceScene, type Scene, type TimelineView } from '../../src/viz/model/scene.js';
import { TimelineBuilder, type Carry, type Timeline } from '../../src/viz/model/timeline.js';
import type { Tick } from '../../src/viz/server/models.js';
import { RoomStore, type StoreDeps } from '../../src/viz/server/store.js';
import { nullVizLog } from '../../src/viz/server/vizLog.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { realBoundedReader } from '../../src/viz/source/boundedRead.js';
import { GitRoomSource } from '../../src/viz/source/git.js';
import type { RoomSource, RoomSpec } from '../../src/viz/source/roomSource.js';
import { createVizGit, type VizGit } from '../../src/viz/source/vizGit.js';
import type { ScriptCommit } from '../../tools/viz/boardWriter.js';
import type { RepoFixture } from './repoFixture.js';
import { collect, sourceOf, vizRunner, type VizCall } from './vizSource.js';
import { statusBytes } from './vizStatus.js';

/**
 * The viewer version every test store runs as (a status.json plugin_version other than this is version skew): the build's own
 * PLUGIN_VERSION, as test/helpers/vizViewer.ts gives the in-process viewer and dist/viz.js has, so writeStatus's default status.json
 * is skew-free for both (it was the literal '0.0.0', which only matched while PLUGIN_VERSION was 0.0.0).
 */
export const VIEWER_VERSION: string = PLUGIN_VERSION;
const END = Number.MAX_SAFE_INTEGER;
/** The last position of height h (12 §3.3.5: every event of h). */
export const end = (h: number): Position => ({ height: h, sub: END, k: END });

/** What a spied source saw: startAt heights, frames calls (from, to, the start state's height, self) and the folds yielded. */
export interface SourceSpy {
  startAt: number[];
  frames: Array<{ from: number; to: number; start: number; self: string }>;
  folds: number;
  changed: number;
  advance: number;
  tip: number;
}

/** `inner` behind a recorder; every frame yielded counts one fold. */
export function spySource(inner: RoomSource): { source: RoomSource; spy: SourceSpy } {
  const spy: SourceSpy = { startAt: [], frames: [], folds: 0, changed: 0, advance: 0, tip: 0 };
  const source: RoomSource = {
    kind: inner.kind,
    tip: () => { spy.tip++; return inner.tip(); },
    changed: () => { spy.changed++; return inner.changed(); },
    advance: (last) => { spy.advance++; return inner.advance(last); },
    startAt: (h) => { spy.startAt.push(h); return inner.startAt(h); },
    async *frames(start, from, to, self) {
      spy.frames.push({ from, to, start: start.height, self });
      for await (const f of inner.frames(start, from, to, self)) {
        spy.folds++;
        yield f;
      }
    },
  };
  return { source, spy };
}

/** A VizGit whose runner records every git child (argv and stdin) and the most children in flight at once. */
export interface CountingGit { git: VizGit; calls: VizCall[]; inFlight: number; maxInFlight: number; reset(): void; }
export function countingVizGit(runner: GitRunner, gitDir: string, dataDir: string): CountingGit {
  const c: CountingGit = {
    git: null as unknown as VizGit, calls: [], inFlight: 0, maxInFlight: 0,
    reset(): void { c.calls.length = 0; c.maxInFlight = c.inFlight; },
  };
  const spy: GitRunner = {
    async run(args: string[], opts: GitCallOptions): Promise<GitResult> {
      c.calls.push({ args: [...args], stdin: opts.stdin?.toString('utf8') ?? '' });
      c.inFlight++;
      c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
      try {
        return await runner.run(args, opts);
      } finally {
        c.inFlight--;
      }
    },
  };
  c.git = createVizGit({ runner: spy, gitDir, dataDir });
  return c;
}

/** The store's deps over a clock: real Fs and bounded reads, the null log, machineMonoMs = the clock's monoMs unless given. */
export function storeDeps(clock: Clock, over: Partial<StoreDeps> = {}): StoreDeps {
  return { clock, fs: realFs, reader: realBoundedReader, log: nullVizLog, viewerVersion: VIEWER_VERSION, machineMonoMs: () => clock.monoMs(), ...over };
}

/** A room id (^r[0-9A-HJKMNP-TV-Z]{8}$) for test room n (decimal digits are Crockford digits). */
export const roomIdOf = (n: number): string => `r${String(n).padStart(8, '0')}`;

/** n board commits by ann and bob in turn (both must have joined), each with two change-sets on <dir>/f<i mod 20>.txt and
 *  <dir>/g<i mod 7>.txt: two publish cards and two publish ticks per height. */
export function pubs(n: number, dir = 'src'): ScriptCommit[] {
  return Array.from({ length: n }, (_, i): ScriptCommit => ({
    writer: i % 2 === 0 ? 'ann' : 'bob',
    cs: [{ paths: [`${dir}/f${i % 20}.txt`] }, { paths: [`${dir}/g${i % 7}.txt`] }],
  }));
}

export interface GitRoom { store: RoomStore; spy: SourceSpy; git: CountingGit; spec: RoomSpec; }
/** A RoomStore over a GitRoomSource of the fixture's clone and board ref, every git child counted, every fold spied. */
export function gitRoom(fx: RepoFixture, ref: string, o: { clock: Clock; n?: number; deps?: Partial<StoreDeps>; runner?: GitRunner }): GitRoom {
  const dataDir = join(fx.root, 'viz data');
  const runner = o.runner ?? vizRunner(dataDir, o.clock);
  const git = countingVizGit(runner, fx.paths.gitDir, dataDir);
  const spec: RoomSpec = { id: roomIdOf(o.n ?? 0), kind: 'git', label: 'shop-app', branch: 'main', gitDir: fx.paths.gitDir, boardRef: ref, canonicalRoot: null };
  const { source, spy } = spySource(new GitRoomSource(spec, git.git, { fs: realFs, clock: o.clock }));
  return { store: new RoomStore(spec, source, storeDeps(o.clock, o.deps)), spy, git, spec };
}

let stamp = 1_700_000_000;
/** <gitdir>/cowork/status.json: a Plan 2 status.json with `over` merged, its mtime moved forward on every write (coarse clocks);
 *  its plugin_version is VIEWER_VERSION unless `over` names one (a skew test passes its own). */
export function writeStatus(gitDir: string, over: Record<string, unknown> = {}): void {
  const dir = join(gitDir, 'cowork');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'status.json');
  writeFileSync(p, statusBytes({ plugin_version: VIEWER_VERSION, ...over }));
  stamp += 10;
  utimesSync(p, stamp, stamp);
}
export function removeStatus(gitDir: string): void {
  rmSync(join(gitDir, 'cowork', 'status.json'), { force: true });
}
/** <gitdir>/cowork/peer with a peer id and a newline; null removes it. */
export function writePeerFile(gitDir: string, peer: string | null): void {
  const dir = join(gitDir, 'cowork');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'peer');
  if (peer === null) rmSync(p, { force: true });
  else writeFileSync(p, `${peer}\n`);
}

/** A board reference: the chain of `ref` folded by a fresh source from the window start h0 on `layout`, one builder. */
export interface Reference { timeline: Timeline; frames: Frame[]; carry: Carry; unknown: number; tip: number; }
export async function reference(fx: RepoFixture, ref: string, h0: number, layout?: Layout, upTo?: number): Promise<Reference> {
  const { src } = sourceOf(fx, ref);
  const tip = (await src.tip())!;
  const start = await src.startAt(h0);
  const frames = await collect(src.frames(start, h0 === 0 ? 0 : h0 + 1, upTo ?? tip.height, ZERO_PEER));
  const b = TimelineBuilder.open(h0, start, layout);
  let unknown = 0;
  for (const f of frames) unknown += b.push(f).unknown;
  return { timeline: b.timeline(), frames, carry: b.carry(), unknown, tip: tip.height };
}

/** R-V28's tick glyphs, one per event of those kinds. */
export function ticksOf(events: readonly SceneEvent[]): Tick[] {
  const out: Tick[] = [];
  for (const e of events) {
    const glyph: Tick['glyph'] | null =
      e.kind === 'publish' ? 'publish' : e.kind === 'conflict' ? 'conflict' : e.kind === 'request_open' ? 'request' : e.kind === 'save' ? 'save'
        : e.kind === 'person_enter' || e.kind === 'person_respawn' || e.kind === 'person_exit' ? 'door' : e.kind === 'person_freeze' ? 'freeze' : null;
    if (glyph !== null) out.push({ h: e.height, glyph });
  }
  return out;
}

/** The scene at the end of height h of a timeline view (the reducer's own seek), and a scene without its position, for comparing
 *  a served page scene (whose `at` is the last event of h, or (h, 0, 0)) with it. */
export const sceneAtEnd = (t: TimelineView, h: number): Scene => reduceScene(t, end(h));
export const unplaced = (s: Scene): Omit<Scene, 'at'> & { at: null } => ({ ...s, at: null });

/** Events and cards of heights [from, to]. */
export const eventsIn = (events: readonly SceneEvent[], from: number, to: number): SceneEvent[] => events.filter((e) => e.height >= from && e.height <= to);
export const cardsIn = (cards: readonly Card[], from: number, to: number): Card[] => cards.filter((c) => c.at.height >= from && c.at.height <= to);

/** Every place in v (Map keys and values, Set members, array items, object fields) whose string contains, or whose number equals,
 *  one of the canaries; the paths found. */
export function deepFind(v: unknown, strings: readonly string[], numbers: readonly number[], path = '$', seen = new Set<unknown>()): string[] {
  if (typeof v === 'string') return strings.some((s) => v.includes(s)) ? [path] : [];
  if (typeof v === 'number') return numbers.includes(v) ? [path] : [];
  if (v === null || typeof v !== 'object' || seen.has(v)) return [];
  seen.add(v);
  const out: string[] = [];
  if (v instanceof Map) {
    for (const [k, x] of v) out.push(...deepFind(k, strings, numbers, `${path}<key>`, seen), ...deepFind(x, strings, numbers, `${path}[${String(k)}]`, seen));
  } else if (v instanceof Set) {
    for (const x of v) out.push(...deepFind(x, strings, numbers, `${path}<member>`, seen));
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => out.push(...deepFind(x, strings, numbers, `${path}[${i}]`, seen)));
  } else {
    for (const [k, x] of Object.entries(v)) out.push(...deepFind(k, strings, numbers, `${path}.<key>`, seen), ...deepFind(x, strings, numbers, `${path}.${k}`, seen));
  }
  return out;
}

/** Moves the loose object `oid` of the clone aside (a partial clone that lacks it); the returned function puts it back. */
export function hideObject(gitDir: string, oid: string): () => void {
  const p = join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  if (!existsSync(p)) throw new Error(`hideObject: ${oid} is not a loose object`);
  renameSync(p, `${p}.hidden`);
  return () => renameSync(`${p}.hidden`, p);
}
