// T-REG-20: the FoldMapper/1 golden (04-regions §3.4 step 6; REG-07, R1-036, R1-088; rulings R4-17, R4-21, PF-8). The test
// recomputes test/fixtures/regions/golden/foldmapper1.json with the real mapper and deep-equals it; the spec-given entries are
// asserted literally. Values the spec does not give were pinned at the first green run and reviewed by the controller;
// regeneration (COWORK_UPDATE_GOLDEN=foldmapper1 npx tsx --test test/unit/mapper.golden.test.ts) needs a reviewed diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineArray } from '../../src/regions/lines.js';
import { FOLD_MAPPER, hunks, mapRangesLines } from '../../src/regions/mapper.js';
import type { Hunk, MapResult, Ranges } from '../../src/regions/types.js';
import { RC_TOUCH_R2, fixture, s9Generator } from '../helpers/regionFixtures.js';

const GOLDEN = fileURLToPath(new URL('../fixtures/regions/golden/foldmapper1.json', import.meta.url));
const UPDATE = process.env['COWORK_UPDATE_GOLDEN'] === 'foldmapper1';

/** The named claim ranges of big_lf.py's hot zone (04 §3.6 VERIFIED rc_touch; test/helpers/regionFixtures.ts HOT_ZONE). */
const NAMED: Readonly<Record<'compute_total' | 'parse' | 'setter', Ranges>> = {
  compute_total: [[5331, 5339]],
  parse: [[5317, 5328]],
  setter: [[5310, 5314]],
};
const FWD = ['far_above', 'directly_above', 'directly_after', 'same_tail'] as const;
const S9_SEED = 's9-0';
const S9_STEPS = 50;

interface Pair { readonly name: string; readonly base: string; readonly post: string; readonly hunks: Hunk[]; readonly images: Record<string, MapResult> | null; }
interface Golden {
  readonly mapper: string;
  readonly note: string;
  readonly named: Readonly<Record<string, Ranges>>;
  readonly rc_touch: Pair[];
  readonly fwd: Pair[];
  readonly same_tail_variant: Pair;
  readonly s9: { readonly seed: string; readonly claim: Ranges; readonly steps: S9Step[] };
}
/** One S9 step: the hunks of that step's own change (previous step's peer, or step 0's holder, to this peer), the direct hunks from the
 *  anchor (step 0's holder) as a count and a sha256 of their JSON (7,740 hunks over the 50 steps in full), and the direct image of the claim. */
interface S9Step { readonly step: number; readonly hunks: Hunk[]; readonly direct: { readonly count: number; readonly sha256: string }; readonly image: MapResult; }

function pair(name: string, base: string, post: string): Pair {
  const a = lineArray(fixture(base));
  const b = lineArray(fixture(post));
  const images = base === 'big_lf.py'
    ? Object.fromEntries(Object.entries(NAMED).map(([k, r]) => [k, mapRangesLines(a, b, r, 'fold')]))
    : null;
  return { name, base, post, hunks: hunks(a, b), images };
}

function compute(): Golden {
  const steps: S9Step[] = [];
  let anchor: readonly Buffer[] | null = null;
  let previous: readonly Buffer[] = [];
  let claim: Ranges = [];
  for (const s of s9Generator(S9_SEED)) {
    if (s.step >= S9_STEPS) break;
    if (anchor === null) {
      anchor = lineArray(s.holder);
      previous = anchor;
      claim = s.oracle;
    }
    const peer = lineArray(s.peer);
    const direct = hunks(anchor, peer);
    steps.push({
      step: s.step,
      hunks: hunks(previous, peer),
      direct: { count: direct.length, sha256: createHash('sha256').update(JSON.stringify(direct)).digest('hex') },
      image: mapRangesLines(anchor, peer, claim, 'fold'),
    });
    previous = peer;
  }
  return {
    mapper: FOLD_MAPPER,
    note: 'T-REG-20 golden (04 section 3.4 step 6): FoldMapper/1 hunks and fold-mode images over the rc_touch R2 pairs, the four fwd variants, the same-tail git-vs-FoldMapper/1 variant and the first 50 steps of s9Generator(s9-0): per step the hunks of its own change, the count and sha256 of the direct hunks from step 0\'s holder, and the direct image of step 0\'s oracle (the claim). Images are given for the big_lf.py pairs only (the named ranges are big_lf.py rows). Regenerate only with COWORK_UPDATE_GOLDEN=foldmapper1 and a reviewed diff.',
    named: NAMED,
    rc_touch: RC_TOUCH_R2.map((r) => pair(r.name, r.base, r.post)),
    fwd: FWD.map((v) => pair(v, 'big_lf.py', `fwd/${v}.post.py`)),
    same_tail_variant: pair('git_vs_foldmapper', 'big_lf.py', 'same_tail/git_vs_foldmapper.post.py'),
    s9: { seed: S9_SEED, claim, steps },
  };
}

/** JSON with one hunk object and one [lo, hi] pair per line (LF, UTF-8 without BOM). */
function serialize(g: Golden): string {
  return `${JSON.stringify(g, null, 2)
    .replace(/\{\s+"aLo": (\d+),\s+"aHi": (\d+),\s+"bLo": (\d+),\s+"bHi": (\d+)\s+\}/g, '{ "aLo": $1, "aHi": $2, "bLo": $3, "bHi": $4 }')
    .replace(/\[\s+(\d+),\s+(\d+)\s+\]/g, '[$1, $2]')}\n`;
}

const h = (aLo: number, aHi: number, bLo: number, bHi: number): Hunk => ({ aLo, aHi, bLo, bHi });

test('FoldMapper/1 golden for rc_touch, fwd and S9', (t) => {
  const got = compute();
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, serialize(got));
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
  assert.deepEqual(got, golden, 'FoldMapper/1 output moved: a protocol change unless the reviewed regeneration says otherwise');

  // Spec-given entries, literally (04 §3.4 step 2 and 3; R4-21).
  const byName = (n: string): Pair => got.rc_touch.find((p) => p.name === n) as Pair;
  assert.deepEqual(byName('py_same_tail_def_after').hunks, [h(5342, 5341, 5342, 5350)]);
  assert.deepEqual(byName('py_append_after_last_line').hunks, [h(5340, 5339, 5340, 5340)]);
  assert.deepEqual(byName('py_append_after_last_line').images?.['compute_total'], [[5331, 5339]], 'a k == hi insertion is not in the image');
  // The same-tail git-vs-FoldMapper/1 divergence, as Task 2's fixture derives it by hand (git keeps the block after 5341).
  const derived = JSON.parse(fixture('same_tail/git_vs_foldmapper.json').toString('utf8')) as { foldMapper1: { hunks: Hunk[]; images: { compute_total: Ranges } } };
  assert.deepEqual(got.same_tail_variant.hunks, derived.foldMapper1.hunks);
  assert.deepEqual(got.same_tail_variant.images?.['compute_total'], derived.foldMapper1.images.compute_total);
  assert.deepEqual(got.same_tail_variant.hunks, [h(5320, 5320, 5320, 5320), h(5339, 5338, 5339, 5347)]);
  // The fwd variants: 22 rows inserted after rows 100, 5330, 5341 and 5341 (README "fwd").
  for (const p of got.fwd) assert.equal(p.hunks.length, 1, `${p.name}: one insertion hunk`);
  // T-REG-21 on these 50 steps: the direct image equals the generator's oracle.
  const oracles = [...(function* () {
    for (const s of s9Generator(S9_SEED)) {
      if (s.step >= S9_STEPS) return;
      yield s.oracle;
    }
  })()];
  for (const s of got.s9.steps) assert.deepEqual(s.image, oracles[s.step], `s9 step ${s.step}`);
  if (UPDATE) t.diagnostic(`regenerated ${GOLDEN} (COWORK_UPDATE_GOLDEN=foldmapper1): review its git diff`);
});
