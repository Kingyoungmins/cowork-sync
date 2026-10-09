// Animation states and beats (12 §3.7 "States", "Beats"; VIZ-22): the state table with each state's reduced-motion form, the
// states every scene event enters (a state is entered only through a scene event: idle is what an actor shows with nothing
// pending), the beat lengths and the replay speeds. Pure and DOM-free (R-V33).
import type { SceneEvent } from '../model/events.js';

export type AnimState = 'idle' | 'walk' | 'sit' | 'sparkle_small' | 'sparkle_big' | 'planes' | 'exclaim' | 'think' | 'bubble' | 'zzz' | 'relaxed'
  | 'ghost' | 'frozen' | 'slowed' | 'enter' | 'exit' | 'spawn' | 'poof' | 'celebrate' | 'parcel';
/** frames × frameMs; durationMs: how long the state plays, null while it holds (until the actor's next event, or as the bubble
 *  or the trip decides); reduced: the §3.7 "Reduced motion" column. */
export interface AnimSpec { frames: number; frameMs: number; durationMs: number | null; reduced: 'static' | 'crossfade' | 'icon' | 'same' | 'off'; }

const spec = (frames: number, frameMs: number, durationMs: number | null, reduced: AnimSpec['reduced']): AnimSpec => Object.freeze({ frames, frameMs, durationMs, reduced });

/** The §3.7 table. */
export const ANIM: Readonly<Record<AnimState, AnimSpec>> = Object.freeze({
  idle: spec(2, 600, null, 'off'),                  // idle bob 2 × 600 ms, phase 0 or 600 ms; reduced: off (static)
  walk: spec(4, 100, null, 'crossfade'),            // hop 4 × 100 ms at 4 tiles/s, a trip ≤ 3 s; reduced: a 150 ms crossfade at the target
  sit: spec(2, 140, null, 'icon'),                  // sit and type 2 × 140 ms, minimum dwell 1.5 s; reduced: a static keyboard icon
  sparkle_small: spec(4, 100, 400, 'icon'),         // a checkpoint publish; reduced: a static star for 1 s
  sparkle_big: spec(6, 100, 600, 'icon'),           // a closed publish (+ flag)
  planes: spec(6, 100, 600, 'icon'),                // per other desk, ≤ 4 then "+n"; reduced: a static dot on those desks
  exclaim: spec(2, 350, 700, 'static'),             // a 2-px jump and pop, 700 ms; reduced: a static outline and "!" glyph
  think: spec(3, 350, null, 'static'),              // "…" 3 × 350 ms
  bubble: spec(1, 200, null, 'static'),             // a 200 ms pop, then the bubble duration (§3.8); reduced: no pop
  zzz: spec(3, 600, null, 'static'),
  relaxed: spec(2, 900, null, 'static'),            // a 2 × 900 ms lean
  ghost: spec(1, 0, null, 'same'),                  // 50 % alpha, desaturated
  frozen: spec(1, 0, null, 'same'),                 // an ice block or sign, no bob
  slowed: spec(1, 0, null, 'same'),                 // a snail badge until the position reaches `until`
  enter: spec(4, 100, 400, 'crossfade'),            // from the door, a 0.4 s dither dissolve
  exit: spec(4, 100, 400, 'crossfade'),
  spawn: spec(3, 100, 300, 'crossfade'),            // a 0.3 s puff
  poof: spec(3, 100, 300, 'crossfade'),
  celebrate: spec(3, 400, 1_200, 'icon'),           // a 3-frame jump and 12 confetti pixels, 1.2 s; reduced: a static stamp on the desks
  parcel: spec(1, 0, null, 'icon'),                 // the parcel states of §3.4; reduced: static icons
});

export const SIT_DWELL_MS = 1_500;
export const LIVE_BEAT_MS = 300, REPLAY_BEAT_MS = 800, BACKLOG_SNAP_MS = 5_000, WALK_TILES_PER_S = 4, TRIP_MAX_MS = 3_000;
export const SPEEDS: readonly number[] = Object.freeze([0.5, 1, 2, 4, 8]);

/**
 * The §3.7 "Entered by" column, total over SCENE_EVENT_KINDS: [] for an event that enters no animation state (a sign, a badge,
 * a tag, a thaw or an unghost, which return the actor to idle).
 */
export function statesFor(e: SceneEvent): AnimState[] {
  switch (e.kind) {
    case 'room_open': case 'room_sign': case 'room_badge': case 'person_badge': case 'person_thaw': case 'person_unghost':
    case 'claim_stale': case 'claim_reserve':
      return [];
    case 'person_enter': case 'person_respawn': return ['enter'];
    case 'person_exit': return ['exit'];
    case 'person_absent': return ['zzz'];
    case 'person_ghost': return ['ghost'];
    case 'person_freeze': return ['frozen'];
    case 'person_slowed': return ['slowed'];
    case 'person_bang': case 'conflict': return ['exclaim'];
    case 'pet_spawn': return ['spawn', 'think'];       // "…" until its first change-set
    case 'pet_poof': return ['poof'];
    case 'pose_relaxed': return ['relaxed'];
    case 'publish': {
      const out: AnimState[] = ['walk', 'sit', e.state === 'checkpoint' ? 'sparkle_small' : 'sparkle_big'];
      if (e.others.length > 0) out.push('planes');
      return out;
    }
    case 'box': return ['parcel'];
    case 'claim_take': case 'claim_move': return ['walk', 'sit'];
    case 'grant_start': return ['walk', 'sit'];         // to the stool at the granted claim
    case 'claim_release': case 'grant_end': return ['walk'];   // walking back
    case 'request_open': return ['walk', 'bubble'];
    case 'request_status':
      return e.status === 'asked' ? ['bubble', 'think'] : e.status === 'returned' ? ['bubble', 'walk'] : ['bubble'];
    case 'answer': return e.verb === 'later' ? ['bubble'] : ['bubble', 'walk'];
    case 'note': return ['bubble'];
    case 'save': return ['celebrate'];
  }
}

/** VIZ-22: a persistent "!" comes only from a non-terminal hold record (a conflict whose source is a hold); a conflict or bang
 *  from an event is terminal at creation and exclaims for one beat only. */
export function exclaimPersists(e: SceneEvent): boolean {
  return e.kind === 'conflict' && e.source === 'hold' && e.holdId !== null;
}

/** One replay beat at speed k: 800 ms / k. */
export function replayBeatMs(speed: number): number {
  return REPLAY_BEAT_MS / speed;
}

/** Live: when the queued beats exceed 5 s of playback, the page crossfades to the newest scene ("caught up"). */
export function liveSnap(queuedBeats: number): boolean {
  return queuedBeats * LIVE_BEAT_MS > BACKLOG_SNAP_MS;
}
