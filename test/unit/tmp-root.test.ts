// A failed SIM run keeps its temp root (runSim); the tests and tools that drop it afterwards delete only a directory the
// harness created: a makeTempRoot base (its marker file present) under the system temp directory, never a path outside
// it (Task 19 fix round 1, finding 3; fix round 2 moved Plan 1's SIM tests and tools/sim/smoke.ts to removeKeptRoot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SimResult } from '../sim/harness.js';
import { dropArtifacts } from '../helpers/simOps.js';
import { makeTempRoot, removeKeptRoot } from '../helpers/tmp.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** A result whose kept artifacts directory is `<base>/<sub>/artifacts` (runSim's layout). */
function failed(base: string): { r: SimResult; artifacts: string } {
  const artifacts = join(base, 'sub dir', 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'op-log.jsonl'), '');
  return { r: { ok: false, opLog: [], remoteRefs: {}, artifactsDir: artifacts }, artifacts };
}

test('dropArtifacts deletes a kept makeTempRoot base; a planted path outside the temp root, or one in it that makeTempRoot did not create, survives', async () => {
  // A path outside the system temp directory (in this checkout), even holding a copy of the marker file.
  const outside = mkdtempSync(join(REPO, '.planted-outside-'));
  // A cowork-named directory in the temp directory that makeTempRoot did not create (no marker).
  const unmarked = mkdtempSync(join(realpathSync.native(tmpdir()), 'cowork-sim-planted-'));
  try {
    writeFileSync(join(outside, '.cowork-temp-root'), 'cowork temp root\n');
    const a = failed(outside);
    await dropArtifacts(a.r);
    assert.ok(existsSync(a.artifacts), 'the planted path outside the temp root survives');
    const b = failed(unmarked);
    await dropArtifacts(b.r);
    assert.ok(existsSync(b.artifacts), 'an unmarked directory in the temp root survives');
    assert.equal(await removeKeptRoot(b.artifacts), false);
    assert.equal(await removeKeptRoot(tmpdir()), false, 'never the temp directory itself');
    assert.equal(await removeKeptRoot(join(tmpdir(), 'cowork-no-such-dir', 'x', 'artifacts')), false, 'a missing path removes nothing');

    // A real kept root goes (dropArtifacts), and so does one named by any path inside it (removeKeptRoot).
    const kept = await makeTempRoot('sim');
    const c = failed(join(kept.root, '..'));
    await dropArtifacts(c.r);
    assert.equal(existsSync(join(kept.root, '..')), false, 'the kept makeTempRoot base is gone');
    const again = await makeTempRoot('sim');
    mkdirSync(join(again.root, 'artifacts'), { recursive: true });
    assert.equal(await removeKeptRoot(join(again.root, 'artifacts')), true);
    assert.equal(existsSync(join(again.root, '..')), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(unmarked, { recursive: true, force: true });
  }
});

/** The .ts files under `dir`, recursively (node_modules and dot-directories skipped). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** The code lines of a source file: full-line `//` comments and block-comment lines dropped. */
function codeLines(text: string): Array<{ n: number; line: string }> {
  return text.split('\n').map((line, i) => ({ n: i + 1, line })).filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line));
}

test('every SIM test and tool drops a kept root only through removeKeptRoot: no code in test/ or tools/ deletes the grandparent of a kept artifacts directory (nested dirname calls)', () => {
  // Task 19 fix round 2, item 3: Plan 1's sim.harness, sim.naive, sim.oracles and sim.smoke.cli tests and tools/sim/smoke.ts.
  const nested = /dirname\(\s*dirname\(/;
  const hits: string[] = [];
  for (const file of [...tsFiles(join(REPO, 'test')), ...tsFiles(join(REPO, 'tools'))]) {
    for (const { n, line } of codeLines(readFileSync(file, 'utf8'))) if (nested.test(line)) hits.push(`${relative(REPO, file).split(sep).join('/')}:${n}: ${line.trim()}`);
  }
  assert.deepEqual(hits, [], 'a kept root is removed with removeKeptRoot(<any path inside it>), never by deleting a derived parent');
  for (const f of ['sim.harness', 'sim.naive', 'sim.oracles', 'sim.smoke.cli']) {
    const text = readFileSync(join(REPO, 'test', 'integration', `${f}.test.ts`), 'utf8');
    assert.ok(codeLines(text).some(({ line }) => /\bremoveKeptRoot\(/.test(line)), `${f}.test.ts drops its kept roots through removeKeptRoot`);
  }
  const smoke = readFileSync(join(REPO, 'tools', 'sim', 'smoke.ts'), 'utf8');
  assert.equal(nested.test(smoke), false, 'tools/sim/smoke.ts does not tell its reader to delete the grandparent of the artifacts directory');
});
