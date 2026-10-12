// The area rule zone(p) (12-visualizer §2 / §3.5.3; 10-product §3.9a "area", §3.20.2; rev 2.5 F04-a, merge round 2): the one
// shared pure module that cli.js (`since`, `wrap`), the daemon and the viewer use. Moved verbatim from 8a's
// src/viz/model/layout.ts zoneOf, which re-exports it. A leaf: it imports nothing, so it stays inside the viewer's R-V35 client
// program (CLIENT_PROGRAM_FILES in tools/lint/vizRules.ts) and satisfies L-PURE. The viewer layout's overflow zone '…' is
// the layout's own and is not applied here.

/** The area of a root-level file: the one definition of '·' (src/viz/model/layout.ts imports and re-exports it as its root zone). */
export const ROOT_ZONE = '\u{00B7}';

/** s1/s2 for a path of three or more segments, s1 for two, '·' for a root-level file. */
export function zone(p: string): string {
  const parts = p.split('/');
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0]!;
  return ROOT_ZONE;
}
