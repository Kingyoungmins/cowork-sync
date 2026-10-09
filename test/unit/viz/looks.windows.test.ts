// Plan 8a Task 6: looks across windows (12 §3.6, §7 T-VIZ-looks; VIZ-18, F18): a timeline's look table is a function of the
// peer ids alone, so windows with different h0, a "load earlier" and a display rename never recolour anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialFoldState } from '../../../src/board/fold.js';
import { lookOf, type LookTable } from '../../../src/viz/model/looks.js';
import { buildTimeline, prependTimeline } from '../../../src/viz/model/timeline.js';
import { FIXTURE_PROTOCOL, fixtureFrames, peerOf, type FixtureFrame } from '../../helpers/vizRows.js';

/** Two one-character aliases whose peer ids share a look (no collision probing, 12 §3.6). */
function lookTwins(): [string, string] {
  const seen = new Map<string, string>();
  for (let c = 0x30; c < 0x7b; c++) {
    const a = String.fromCharCode(c);
    const l = JSON.stringify(lookOf(peerOf(a)));
    const twin = seen.get(l);
    if (twin !== undefined && twin !== 'A' && a !== 'A') return [twin, a];
    seen.set(l, a);
  }
  throw new Error('no look collision among the aliases');
}
/** Pairs of peers of a look table that share a look: the projection gives both their handles (12 §3.6 name tags). */
function sameLook(t: LookTable): string[] {
  const peers = [...t.keys()].sort();
  const out: string[] = [];
  for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
    if (JSON.stringify(t.get(peers[i]!)) === JSON.stringify(t.get(peers[j]!))) out.push(`${peers[i]} ${peers[j]}`);
  }
  return out;
}

test('T-VIZ-looks: the same peer gets the same look in two windows with different h0, before and after load earlier, and after a display rename; equal tags or looks show handles in both windows', () => {
  const [x, y] = lookTwins();
  // A, the twins x and y (both named "Sam"), then 600 heights in which x renames itself to "Sasha".
  const specs: FixtureFrame[] = [
    { writer: 'A', ops: [{ type: 'join', display: 'Ann' }, { type: 'caps' }] },
    { writer: x, ops: [{ type: 'join', display: 'Sam' }] }, { writer: y, ops: [{ type: 'join', display: 'Sam' }] },
    { writer: 'A', cs: [{ human: 'A', n: 1, files: ['src/a.ts'] }] },
  ];
  for (let h = 4; h <= 600; h++) {
    const w = [x, y, 'A'][h % 3]!;
    specs.push(h === 400 ? { writer: x, ops: [{ type: 'join', display: 'Sasha' }] } : { writer: w });
  }
  const frames = fixtureFrames({ row: 'looks', plan: 2, about: '', frames: specs });
  assert.equal(frames[600]!.after.peers[peerOf(x)]!.display, 'Sasha');
  const start = initialFoldState(FIXTURE_PROTOCOL);
  const whole = buildTimeline({ h0: 0, start, frames });                                         // h0 = 0
  const late = buildTimeline({ h0: 512, start: frames[512]!.after, frames: frames.slice(513) });  // h0 = 512, after the rename
  const early = buildTimeline({ h0: 0, start, frames: frames.slice(0, 300) });                    // before the rename
  const earlier = prependTimeline(late, { h0: 256, start: frames[256]!.after, frames: frames.slice(257, 513) });
  const peers = ['A', x, y].map(peerOf);
  for (const t of [whole, late, early, earlier]) {
    assert.deepEqual(new Set(t.looks.keys()), new Set(peers));
    for (const p of peers) assert.deepEqual(t.looks.get(p), lookOf(p));
    // The twins share a look in every window, so every window gives both their handles; no window finds another pair.
    assert.deepEqual(sameLook(t.looks), [[peerOf(x), peerOf(y)].sort().join(' ')]);
  }
  // Load earlier keeps every look and every home spot.
  assert.deepEqual([...earlier.looks], [...late.looks]);
  assert.deepEqual(earlier.layout.homeOrder, late.layout.homeOrder);
  // The display names (equal "Sam" before the rename) never enter a look; both windows see the same names the projection compares.
  assert.equal(frames[299]!.after.peers[peerOf(x)]!.display, frames[299]!.after.peers[peerOf(y)]!.display);
});
