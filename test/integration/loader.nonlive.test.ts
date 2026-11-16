// Plan 5 Task 4: the non-live fast path (R1-207, INV-CCI-NONLIVE, CCI-07; 06 test 3 unit, TC-CCI-12 unit). A repo without a live marker and a fakeDaemon
// listening on the endpoint that repo would have: no hook connects, prints or spawns. The ≤ 80 ms p95 gate is Task 17's windows-latest leg.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonRoot, findRepo } from '../../src/data/canonRoot.js';
import { realRootProbe } from '../../src/ports/fs.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, copyDist, EVENTS, GATING_TOOLS, hookJson, loaderRepo, pooled, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

let repo: LoaderRepo;
let daemon: FakeDaemon;
let dist = '';
/** A copy of the built plugin root whose core.js only records that it ran (one line per call in `coreRan`): the loader must never import it here. */
let sentinelDist = '';
let coreRan = '';
before(async () => {
  repo = await loaderRepo({ label: 'loader-nonlive' });
  daemon = await fakeDaemon(repo.endpoint as string, repo.key as Buffer);
  dist = buildDist(join(repo.base, 'build'));
  sentinelDist = copyDist(dist, join(repo.base, 'sentinel'));
  coreRan = join(repo.base, 'core-ran.txt');
  writeFileSync(join(sentinelDist, 'core.js'), [
    "import { appendFileSync } from 'node:fs';",
    `export async function main(event) { appendFileSync(${JSON.stringify(coreRan)}, event + '\\n'); return { exit: 0, evidenceDelivered: false }; }`,
    '',
  ].join('\n'));
});
after(async () => {
  await daemon?.close();
  await repo?.cleanup();
});

/** Every file under dir with its bytes (forward-slash relative paths). */
function snapshot(dir: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) for (const [k, v] of snapshot(p, `${prefix}${name}/`)) out.set(k, v);
    else out.set(`${prefix}${name}`, readFileSync(p).toString('base64'));
  }
  return out;
}

test('non-live: zero IPC connections and zero output bytes over ≥ 200 invocations of every event', { timeout: 600_000 }, async () => {
  const cowork = join(repo.gitdir, 'cowork');
  const before = snapshot(cowork);
  assert.ok(!existsSync(join(cowork, 'live')), 'no live marker');
  assert.ok(!existsSync(join(cowork, 'status.json')), 'no status.json: none is needed');
  const runs: Array<{ event: string; json: Record<string, unknown> }> = [];
  for (let i = 0; i < 15; i++) {
    for (const event of EVENTS) {
      if (event === 'PreToolUse') runs.push({ event, json: preToolJson(GATING_TOOLS[i % GATING_TOOLS.length]!, repo.dir) });
      else if (event === 'UserPromptExpansion') runs.push({ event, json: hookJson(event, repo.dir, { prompt: '/cowork save "x"', command_args: 'save "x"' }) });
      else runs.push({ event, json: hookJson(event, repo.dir) });
    }
  }
  assert.ok(runs.length >= 200);
  assert.deepEqual(new Set(runs.filter((r) => r.event === 'PreToolUse').map((r) => (r.json['tool_name'] as string))), new Set(GATING_TOOLS));
  const results = await pooled(runs, 4, (r) => runLoader(r.event, r.json, { dist, cwd: repo.dir, env: repo.env }));
  results.forEach((res, i) => {
    const what = `${i} ${runs[i]!.event} ${String(runs[i]!.json['tool_name'] ?? '')}`;
    assert.equal(res.exit, 0, `${what}: ${res.stderr}`);
    assert.equal(res.stdout, '', what);
    assert.equal(res.stderr, '', what);
  });
  assert.equal(daemon.connections(), 0, 'zero IPC connections');
  const afterSnap = snapshot(cowork);
  const changed = [...new Set([...before.keys(), ...afterSnap.keys()])].filter((k) => before.get(k) !== afterSnap.get(k)).sort();
  assert.deepEqual(changed, ['tmp/evidence.jsonl'], '<gitdir>/cowork/ changes only by the appended evidence lines');
  const lines = readFileSync(join(cowork, 'tmp', 'evidence.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 15, 'one line per acting-verb expansion');
  assert.ok(!existsSync(join(cowork, 'status.json')), 'still no status.json');

  // Core never runs for a non-live repo (so nothing reads status.json or spawns): every event and every PreToolUse tool once more with a core.js
  // that records each call — no record. The positive control: the same dist in a live repo runs that core once.
  const probes: Array<{ event: string; json: Record<string, unknown> }> = [
    ...EVENTS.filter((e) => e !== 'PreToolUse').map((event) => ({ event, json: event === 'UserPromptExpansion' ? hookJson(event, repo.dir, { prompt: '/cowork save "x"', command_args: 'save "x"' }) : hookJson(event, repo.dir) })),
    ...GATING_TOOLS.map((tool) => ({ event: 'PreToolUse', json: preToolJson(tool, repo.dir) })),
  ];
  const sentinel = await pooled(probes, 4, (r) => runLoader(r.event, r.json, { dist: sentinelDist, cwd: repo.dir, env: repo.env }));
  sentinel.forEach((res, i) => assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', ''], `${probes[i]!.event} ${String(probes[i]!.json['tool_name'] ?? '')}`));
  assert.ok(!existsSync(coreRan), `core.js ran for a non-live repo: ${existsSync(coreRan) ? readFileSync(coreRan, 'utf8') : ''}`);
  repo.setLive(true);
  try {
    const control = await runLoader('UserPromptSubmit', hookJson('UserPromptSubmit', repo.dir), { dist: sentinelDist, cwd: repo.dir, env: repo.env });
    assert.equal(control.exit, 0, control.stderr);
    assert.equal(existsSync(coreRan) ? readFileSync(coreRan, 'utf8') : '', 'UserPromptSubmit\n', 'the positive control: a live repo runs the recording core once');
  } finally {
    repo.setLive(false);
    rmSync(coreRan, { force: true });
  }
});

test('non-live: an edit under a dangling or looping link exits 0 with no output, in a non-live repo and in a directory without its own .git (P5-T4-1)', async () => {
  // Junctions on win32 (no privilege needed), symlinks elsewhere (the type argument is ignored there). A dangling link: its target removed; a loop: two
  // links naming each other.
  const plain = join(repo.base, 'plain');
  const links = (dir: string): { dangling: string; loop: string; cleanup: () => void } => {
    const gone = join(dir, 'gone-target');
    mkdirSync(gone, { recursive: true });
    const dangling = join(dir, 'dangling-link');
    symlinkSync(gone, dangling, 'junction');
    rmSync(gone, { recursive: true });
    const a = join(dir, 'loop-a');
    const b = join(dir, 'loop-b');
    symlinkSync(b, a, 'junction');
    symlinkSync(a, b, 'junction');
    return { dangling, loop: a, cleanup: () => { for (const l of [dangling, a, b]) rmSync(l, { force: true }); } };
  };
  mkdirSync(plain, { recursive: true });
  const inRepo = links(repo.dir);
  const inPlain = links(plain);
  // This PC's %TEMP% lies under a non-live repository (C:\Users\<u>\AppData\Local\.git), so `plain`'s walk may reach an ancestor .git; either way it
  // is not live. Recorded in the messages below.
  const ancestor = findRepo(canonRoot(plain, realRootProbe, process.platform), realRootProbe, process.platform);
  const where = `plain's walk: ${ancestor === null ? 'no .git up to the root' : `${ancestor.kind} ${ancestor.root} (not live)`}`;
  try {
    const runs: Array<{ dir: string; tool: string; file: string }> = [];
    for (const [dir, l] of [[repo.dir, inRepo], [plain, inPlain]] as const) {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        for (const file of [l.dangling, join(l.dangling, 'sub', 'x.ts'), l.loop, join(l.loop, 'x.ts')]) runs.push({ dir, tool, file });
      }
    }
    const results = await pooled(runs, 4, (r) => runLoader('PreToolUse', preToolJson(r.tool, r.dir, { filePath: r.file }), { dist, cwd: r.dir, env: repo.env }));
    results.forEach((res, i) => {
      const r = runs[i]!;
      assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', ''], `${r.tool} ${r.file} (${where})`);
    });
    assert.equal(daemon.connections(), 0, 'zero IPC connections');
  } finally {
    inRepo.cleanup();
    inPlain.cleanup();
  }
});
