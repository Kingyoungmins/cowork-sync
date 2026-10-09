// The exit verdict of sim-exit.yml (Task 19; roadmap row 2's acceptance artifact): tools/sim/exit-verdict.ts reads the
// run-seeds reports of one OS's shards and passes only when the seeds reported are exactly the expected ones — each
// `${prefix}${profile}-${i}` for i in [from, from + N) once, of that profile, every one passed — with no lost seed, no
// problem and every report complete. The count alone never passes it. Run as a script, the way the workflow runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedLine, SeedsReport } from '../../tools/sim/seedProtocol.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const VERDICT = fileURLToPath(new URL('../../tools/sim/exit-verdict.ts', import.meta.url));

function verdict(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', VERDICT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const line = (seed: string, ok = true, profile: SeedLine['profile'] = 'edits'): SeedLine => (ok
  ? { seed, profile, ok, ms: 1 }
  : { seed, profile, ok, oracle: 'INV-CONVERGE', step: 9, message: 'p1: planted', ms: 1 });

function report(results: SeedLine[], extra: Partial<SeedsReport> = {}): SeedsReport {
  return {
    runs: [{ profile: 'edits', seeds: results.map((r) => r.seed) }], peers: 3, steps: 40, mutants: [], shards: [results.map((r) => r.seed)],
    results, failures: results.filter((r) => !r.ok).length, lost: [], problems: [], complete: true, ...extra,
  };
}

const seeds = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => `edits-${from + i}`);

test('the exit verdict passes exactly the expected seed set, all passed, and names every missing, unexpected, duplicated, failed, lost or wrong-profile seed, problem and incomplete report', () => {
  const root = mkdtempSync(join(tmpdir(), 'cowork-exit-verdict-'));
  let n = 0;
  const dirWith = (...reports: SeedsReport[]): string => {
    const d = join(root, `case-${n++}`);
    mkdirSync(d);
    reports.forEach((r, i) => writeFileSync(join(d, `sim-exit-ubuntu-latest-${i}.json`), JSON.stringify(r)));
    return d;
  };
  const args = (d: string): string[] => ['--reports', d, '--profile', 'edits', '--from', '0', '--seeds', '6', '--label', 'ubuntu-latest'];
  try {
    const good = verdict(args(dirWith(report(seeds(0, 3).map((s) => line(s))), report(seeds(3, 3).map((s) => line(s))))));
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, /^ubuntu-latest: 6 of 6 edits seeds passed; failures 0, missing 0, unexpected 0, duplicated 0, wrong profile 0, lost 0, problems 0, incomplete reports 0$/m);

    // The right count with the wrong identity: edits-5 is missing, edits-9 is not one of the expected seeds.
    const identity = verdict(args(dirWith(report([...seeds(0, 5), 'edits-9'].map((s) => line(s))))));
    assert.equal(identity.code, 1, identity.out);
    assert.match(identity.out, /^MISSING edits-5$/m);
    assert.match(identity.out, /^UNEXPECTED edits-9$/m);
    assert.match(identity.out, /: 5 of 6 edits seeds passed; failures 0, missing 1, unexpected 1,/);

    const dup = verdict(args(dirWith(report(seeds(0, 6).map((s) => line(s))), report([line('edits-2')]))));
    assert.equal(dup.code, 1, dup.out);
    assert.match(dup.out, /^DUPLICATED edits-2 \(2 results\)$/m);

    const failed = verdict(args(dirWith(report(seeds(0, 6).map((s) => line(s, s !== 'edits-3'))))));
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /^FAIL edits-3 INV-CONVERGE at step 9: p1: planted$/m);
    assert.match(failed.out, /: 5 of 6 edits seeds passed; failures 1,/);

    const profile = verdict(args(dirWith(report(seeds(0, 6).map((s) => line(s, true, s === 'edits-1' ? 'faults' : 'edits'))))));
    assert.equal(profile.code, 1, profile.out);
    assert.match(profile.out, /^WRONG PROFILE edits-1 \(faults\)$/m);

    const broken = verdict(args(dirWith(report(seeds(0, 6).map((s) => line(s)), {
      lost: [{ seed: 'edits-6', profile: 'edits', reason: 'running at the deadline', rerun: 'npm run sim:seeds -- --seed edits-6' }],
      problems: ['shard 1 ended with exit 70'], complete: false,
    }))));
    assert.equal(broken.code, 1, broken.out);
    assert.match(broken.out, /^LOST edits-6 \(running at the deadline\)$/m);
    assert.match(broken.out, /^PROBLEM sim-exit-ubuntu-latest-0\.json: shard 1 ended with exit 70$/m);
    assert.match(broken.out, /^INCOMPLETE sim-exit-ubuntu-latest-0\.json$/m);

    const none = verdict(args(dirWith()));
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /: 0 of 6 edits seeds passed; failures 0, missing 6,/);

    // Usage and unreadable input: exit 2.
    assert.equal(verdict(['--profile', 'edits']).code, 2);
    assert.equal(verdict(['--reports', join(root, 'no-such-dir'), '--profile', 'edits', '--from', '0', '--seeds', '6']).code, 2);
    assert.equal(verdict([...args(dirWith()), '--bogus']).code, 2);
    const junk = join(root, 'junk');
    mkdirSync(junk);
    writeFileSync(join(junk, 'a.json'), '{ not json');
    assert.equal(verdict(args(junk)).code, 2);
    writeFileSync(join(junk, 'a.json'), JSON.stringify({ results: [{ seed: 'edits-0' }] }));
    assert.equal(verdict(args(junk)).code, 2, 'a report that is not a run-seeds report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
