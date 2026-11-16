// Plan 5 Task 4: fail closed (CCI-06, INV-CCI-FAILCLOSED, M08; 06 test 2, TC-CCI-19, R1-201, R1-202, R1-210, glossary §25 F6). The bundled loader of a
// test-form build runs against a live, unpaused repo (fresh status.json, a key, and a fakeDaemon answering {decision: 'none'} where a run gets that
// far): five faults — (a) core.js a syntax error, (b) main throws, (c) main rejects, (d) main throws from a timer, (e) the real core with malformed
// stdin — over the 14 events and the 9 PreToolUse tools, in en and ko (user.json, read before stdin, A4-13).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOADER_TEXTS } from '../../src/claude/text/claudeText.js';
import { PLUGIN_VERSION } from '../../src/version.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, copyDist, EVENTS, GATING_TOOLS, hookJson, loaderRepo, pooled, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

const FAULTS = {
  a: 'export const main = (;\n',
  b: "export function main() { throw new Error('x'); }\n",
  c: "export function main() { return Promise.reject(new Error('x')); }\n",
  d: "export async function main() { setTimeout(() => { throw new Error('x'); }, 0); await new Promise((r) => setTimeout(r, 50)); return { exit: 0, evidenceDelivered: false }; }\n",
  e: null,
} as const;
type Fault = keyof typeof FAULTS;

let repo: LoaderRepo;
let daemon: FakeDaemon;
const dists = new Map<Fault, string>();

before(async () => {
  repo = await loaderRepo({ label: 'loader-faults', live: true });
  daemon = await fakeDaemon(repo.endpoint as string, repo.key as Buffer);
  const dist = buildDist(join(repo.base, 'build'));
  for (const [f, core] of Object.entries(FAULTS) as Array<[Fault, string | null]>) {
    const d = copyDist(dist, join(repo.base, `fault-${f}`));
    if (core !== null) writeFileSync(join(d, 'core.js'), core);
    dists.set(f, d);
  }
});
after(async () => {
  await daemon?.close();
  await repo?.cleanup();
});

/** Every cell: [event, PreToolUse tool or null, hook input]. */
function cells(): Array<{ event: string; tool: string | null; json: Record<string, unknown> }> {
  const out: Array<{ event: string; tool: string | null; json: Record<string, unknown> }> = [];
  for (const event of EVENTS) {
    if (event === 'PreToolUse') for (const tool of GATING_TOOLS) out.push({ event, tool, json: preToolJson(tool, repo.dir) });
    else out.push({ event, tool: null, json: hookJson(event, repo.dir) });
  }
  return out;
}

const expectedStderr = (f: Fault, lang: 'en' | 'ko'): string =>
  (f === 'a' ? LOADER_TEXTS.HOOK_LOAD_FAIL[lang].replace('{v}', PLUGIN_VERSION) : LOADER_TEXTS.G4[lang]);

test('loader.faults: core.js syntax error, injected throw, rejected promise and malformed stdin → exit 2 with the load or G4 text for each gating matcher, exit 0 and no bytes for every other event; never exit 1', { timeout: 600_000 }, async () => {
  const all = cells();
  assert.equal(all.length, 13 + 9);
  for (const lang of ['en', 'ko'] as const) {
    repo.setLanguage(lang);
    for (const f of Object.keys(FAULTS) as Fault[]) {
      const results = await pooled(all, 4, (c) => runLoader(c.event, c.json, {
        dist: dists.get(f) as string, cwd: repo.dir, env: repo.env, ...(f === 'e' ? { stdin: '{"a":' } : {}),
      }));
      results.forEach((r, i) => {
        const c = all[i]!;
        const cell = `${lang} fault ${f} ${c.event}${c.tool === null ? '' : ` ${c.tool}`}`;
        assert.notEqual(r.exit, 1, `${cell}: exit 1`);
        if (c.event === 'PreToolUse') {
          assert.equal(r.exit, 2, `${cell}: exit ${String(r.exit)} ${r.stderr}`);
          assert.equal(r.stderr, expectedStderr(f, lang), cell);
          assert.equal(r.stdout, '', cell);
        } else {
          assert.equal(r.exit, 0, `${cell}: exit ${String(r.exit)} ${r.stderr}`);
          assert.equal(r.stdout, '', cell);
          assert.equal(r.stderr, '', cell);
        }
      });
    }
  }
  assert.equal(daemon.connections(), 0, 'no fault run reaches the daemon');
});

test('M08 is caught: with COWORK_TEST_MUTANT=M08 a gating hook exits 0 on an exception', async () => {
  repo.setLanguage('en');
  const json = preToolJson('Edit', repo.dir);
  const plain = await runLoader('PreToolUse', json, { dist: dists.get('b') as string, cwd: repo.dir, env: repo.env });
  const mutant = await runLoader('PreToolUse', json, { dist: dists.get('b') as string, cwd: repo.dir, env: { ...repo.env, COWORK_TEST_MUTANT: 'M08' } });
  assert.equal(plain.exit, 2);
  assert.equal(plain.stderr, LOADER_TEXTS.G4.en);
  assert.equal(mutant.exit, 0, 'the mutant fails open');
  assert.equal(mutant.stdout, '');
  assert.equal(mutant.stderr, '');
  assert.notDeepEqual([mutant.exit, mutant.stderr], [plain.exit, plain.stderr], 'the previous test\'s assertion fails for this cell under M08');
});
