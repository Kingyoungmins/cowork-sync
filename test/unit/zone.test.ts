// F04-a Task A1: the area rule zone(p) (12 §2 / §3.5.3; 10-product §3.9a "area") in the one shared pure module
// src/data/zone.ts, moved verbatim from 8a's src/viz/model/layout.ts zoneOf, which re-exports it; and the R-V35 client
// program that layout.ts's import of it must stay inside (L-VIZ-IMPORT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { ROOT_ZONE as AREA_ROOT, zone } from '../../src/data/zone.js';
import { ROOT_ZONE, zoneOf } from '../../src/viz/model/layout.js';
import { lintVizClientClosure, lintVizSource } from '../../tools/lint/vizRules.js';
import { makeTempRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');

const E = '\u{2026}';           // '…': the viewer's overflow zone key, here only ever a real folder or file name
const MIDDLE_DOT = '\u{00B7}';  // '·', the root area
const HOUSE = '\u{2302}';       // '⌂', the big table's key
const pad = (n: number): string => String(n).padStart(2, '0');
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

/**
 * The 12 §2 area rule, written independently of the module under test: the first two segments of a path with three or
 * more segments, the first segment of a two-segment path, '·' for a root-level file.
 */
function areaRule(p: string): string {
  const i = p.indexOf('/');
  if (i < 0) return MIDDLE_DOT;
  const j = p.indexOf('/', i + 1);
  return j < 0 ? p.slice(0, i) : p.slice(0, j);
}

/** Every path the T-VIZ-layout tests (test/unit/viz/layout.test.ts) touch, with its area. */
const LAYOUT_FIXTURE: ReadonlyArray<readonly [string, string]> = [
  // zoneOf's own cases.
  ['src/engine/state.ts', 'src/engine'], ['src/engine/deep/er/x.ts', 'src/engine'], ['test/a.ts', 'test'], ['README.md', MIDDLE_DOT],
  [`${E}/x.ts`, E],
  // The builder, the R-V57 home delta and the frozen layout.
  ['src/a.ts', 'src'], ['src/b.ts', 'src'], ['lib/c.ts', 'lib'], ['new/x.ts', 'new'],
  // The 16th zone and the overflow folders.
  ...range(0, 17).map((i): [string, string] => [`d${pad(i)}/f.ts`, `d${pad(i)}`]),
  ['root.md', MIDDLE_DOT], ['over1/a/x.ts', 'over1/a'], ['over1/a/y.ts', 'over1/a'], ['over1/a/z.ts', 'over1/a'], ['over2/b.ts', 'over2'],
  ['d03/g.ts', 'd03'], ...range(0, 23).map((i): [string, string] => [`of${pad(i)}/q.ts`, `of${pad(i)}`]), ['of21/r.ts', 'of21'], ['of22/s.ts', 'of22'],
  // The 24th file of a zone and its shelf.
  ...range(0, 25).map((i): [string, string] => [`src/engine/f${pad(i)}.ts`, 'src/engine']), ['lib/a.ts', 'lib'],
  ['src/engine/sub/deeper.ts', 'src/engine'],
  // isDashed, the coordinates, officeTiles and the blocked tiles.
  ['a/1.ts', 'a'], ['a/2.ts', 'a'], ['b/3.ts', 'b'], ['c/4.ts', 'c'], ['d/5.ts', 'd'], ['d/6.ts', 'd'], ['e/7.ts', 'e'], ['e/8.ts', 'e'],
  ...range(0, 4).map((z): [string, string] => [`z${z}/a.ts`, `z${z}`]), ...range(0, 4).map((i): [string, string] => [`z4/f${i}.ts`, 'z4']),
  ['a/x.ts', 'a'], ['b/x.ts', 'b'], ['c/x.ts', 'c'], ['d/x.ts', 'd'], ...range(0, 7).map((i): [string, string] => [`a/f${i}.ts`, 'a']), ['c/y.ts', 'c'],
  // T-VIZ-text (layout): prototype names.
  ['__proto__/a.ts', '__proto__'], ['constructor/b.ts', 'constructor'], ['prototype/c.ts', 'prototype'], ['__proto__', MIDDLE_DOT],
  ['hasOwnProperty/toString/d.ts', 'hasOwnProperty/toString'], ['x/__proto__/e.ts', 'x/__proto__'],
  // T-VIZ-text (layout): real folders and files named with the reserved glyphs.
  [`${E}/a.ts`, E], [`${MIDDLE_DOT}/b.ts`, MIDDLE_DOT], ['top.md', MIDDLE_DOT], [HOUSE, MIDDLE_DOT], ['over/x.ts', 'over'], [`${E}/c.ts`, E],
  [`over2/${E}/y.ts`, `over2/${E}`], ...range(0, 21).map((i): [string, string] => [`${E}/f${pad(i)}.ts`, E]), [`${E}/g.ts`, E],
  [`${E}/late.ts`, E], [`${E}/late2.ts`, E], [`${E}/late3.ts`, E], [`test/${E}`, 'test'], [`src/x/${E}`, 'src/x'],
  ...range(0, 22).map((i): [string, string] => [`test/f${pad(i)}.ts`, 'test']), ['test/g.ts', 'test'], [`:${E}/x.ts`, `:${E}`], [`${E}/x.ts`, E],
  // applyLayoutDelta.
  ...range(0, 8).map((i): [string, string] => [`src/f${i}.ts`, 'src']), ...range(0, 20).map((i): [string, string] => [`src/g${i}.ts`, 'src']),
  ['lib/x.ts', 'lib'],
];

/** The path shapes of T-VIZ-layout's property tests (test/unit/viz/layout.prop.test.ts pathArb), rebuilt here. */
const GLYPHS = [E, MIDDLE_DOT, HOUSE];
const S1 = Array.from({ length: 20 }, (_, i) => `z${i}`).concat(['__proto__', 'constructor'], GLYPHS);
const pathArb: fc.Arbitrary<string> = fc.oneof(
  fc.nat(30).map((n) => `f${n}.ts`),
  fc.constantFrom(...GLYPHS),
  fc.tuple(fc.constantFrom(...S1, 'hot'), fc.constantFrom('', 'a/')).map(([s, a]) => `${s}/${a}${E}`),
  fc.tuple(fc.constantFrom(...S1), fc.nat(5)).map(([s, n]) => `${s}/f${n}.ts`),
  fc.tuple(fc.constantFrom(...S1), fc.constantFrom('a', 'b', '__proto__'), fc.nat(5)).map(([s, t, n]) => `${s}/${t}/f${n}.ts`),
  fc.tuple(fc.constantFrom(...S1), fc.nat(3)).map(([s, n]) => `${s}/a/b/f${n}.ts`),
  fc.nat(40).map((n) => `hot/f${n}.ts`),
);

test("zone equals 8a's zoneOf on every T-VIZ layout fixture path", () => {
  // layout.ts keeps zoneOf as a re-export of the one shared function, not a copy (12 §3.13 module table).
  assert.equal(zoneOf, zone);
  assert.equal(zone('README.md'), ROOT_ZONE, "a root-level file is the layout's root zone");
  // One '·': layout.ts's ROOT_ZONE is zone.ts's, imported, not a second definition (F04-a final review M1).
  assert.equal(ROOT_ZONE, AREA_ROOT);
  assert.equal(AREA_ROOT, MIDDLE_DOT);
  assert.doesNotMatch(read('src/viz/model/layout.ts'), /ROOT_ZONE\s*=/, 'layout.ts defines no ROOT_ZONE of its own');
  assert.ok(LAYOUT_FIXTURE.length > 200);
  for (const [p, area] of LAYOUT_FIXTURE) {
    assert.equal(zone(p), area, p);
    assert.equal(zoneOf(p), area, p);
    assert.equal(areaRule(p), area, `the fixture's own area of ${p}`);
  }
  fc.assert(fc.property(pathArb, (p) => zone(p) === zoneOf(p) && zone(p) === areaRule(p)), { numRuns: 2_000 });
  // The overflow zone '…' is the viewer layout's, never the area rule's (10 §3.9a): a path's area is its own segments.
  assert.equal(zone(`over${E}/a/b.ts`), `over${E}/a`);
  assert.equal(zone(''), MIDDLE_DOT);
});

async function put(root: string, rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, Buffer.from(text, 'utf8'));
}

test('L-VIZ-IMPORT accepts layout.ts importing src/data/zone.ts and still rejects a client import of src/engine', async () => {
  // The real repository: layout.ts takes zoneOf from src/data/zone.ts, and the client program's closure is clean.
  assert.match(read('src/viz/model/layout.ts'), /from '\.\.\/\.\.\/data\/zone\.js';/);
  assert.deepEqual(lintVizClientClosure(REPO), []);

  const { root, cleanup } = await makeTempRoot('f04a-zone-closure');
  try {
    // A client program whose page reaches layout.ts, which imports and re-exports zone from src/data/zone.ts.
    await put(root, 'src/viz/client/tsconfig.json', read('src/viz/client/tsconfig.json'));
    await put(root, 'src/viz/client/main.ts', `import { zoneOf } from '../model/layout.js';\nexport const z = zoneOf('a/b/c.ts');\n`);
    await put(root, 'src/viz/model/events.ts', 'export type DeskRef = number;\n');
    const layout = [
      `import type { DeskRef } from './events.js';`,
      `import { zone } from '../../data/zone.js';`,
      `export { zone as zoneOf } from '../../data/zone.js';`,
      `export const first: DeskRef = zone('a/b').length;`,
      '',
    ].join('\n');
    await put(root, 'src/viz/model/layout.ts', layout);
    await put(root, 'src/data/zone.ts', `export function zone(p: string): string {\n  return p;\n}\n`);
    assert.deepEqual(lintVizClientClosure(root), []);
    // The pure model layer's per-file rule takes src/data/zone.ts as no I/O module.
    assert.deepEqual(lintVizSource('src/viz/model/layout.ts', layout), []);

    // A client import of src/engine is still refused: from browser code (per file and in the closure)...
    const bad = `import type { Meta } from '../../engine/meta.js';\nexport const none: Meta | null = null;\n`;
    await put(root, 'src/viz/client/bad.ts', bad);
    const closure = lintVizClientClosure(root);
    assert.deepEqual(closure.map((f) => [f.rule, f.file, f.line]), [['L-VIZ-IMPORT', 'src/viz/client/bad.ts', 1]]);
    assert.match(closure[0]!.message, /^src\/engine\/meta\.ts is outside the client program \(R-V35\)/);
    const perFile = lintVizSource('src/viz/client/bad.ts', bad);
    assert.deepEqual(perFile.map((f) => [f.rule, f.line]), [['L-VIZ-IMPORT', 1]]);
    assert.match(perFile[0]!.message, /\(src\/engine\/meta\.ts\) is not importable from browser code/);

    // ...and from src/data/zone.ts itself, now a member of the client program.
    await put(root, 'src/viz/client/bad.ts', 'export const none = null;\n');
    await put(root, 'src/data/zone.ts', `import { META_V } from '../engine/meta.js';\nexport function zone(p: string): string {\n  return p + META_V;\n}\n`);
    const fromZone = lintVizClientClosure(root);
    assert.deepEqual(fromZone.map((f) => [f.rule, f.file, f.line]), [['L-VIZ-IMPORT', 'src/data/zone.ts', 1]]);
    assert.match(fromZone[0]!.message, /^src\/engine\/meta\.ts is outside the client program \(R-V35\)/);
  } finally {
    await cleanup();
  }
});
