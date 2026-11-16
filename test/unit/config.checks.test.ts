// TeamConfig.checks.checkpoint (Plan 3 Task 12a, contract addition 1; 05-holds HLD-51 status input, CS-12; glossary §17): read
// leniently by readTeamConfig — a string array is kept, a missing or mistyped key keeps the default []; it is the input of
// StatusInputs.noChecksConfigured (CS_NO_CHECKS_CONFIGURED in the ok ladder, R3-61). Real git; never mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TEAM_CONFIG, readTeamConfig } from '../../src/data/config.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const CONFIG_PATH = '.cowork/config.json';

test('readTeamConfig keeps a string array checks.checkpoint and gives [] for a missing or mistyped key', { timeout: 10 * 60_000 }, async () => {
  const f = await makeRepoFixture('cfg-checks');
  try {
    assert.deepEqual(DEFAULT_TEAM_CONFIG.checks, { checkpoint: [] }, 'the default is an empty list');
    // Absent file: the default.
    const none = await commitFiles(f, { 'README.md': '# x\n' });
    assert.deepEqual((await readTeamConfig(f.repo, none)).config.checks, { checkpoint: [] });
    // A string array is kept as given, order and duplicates included.
    const good = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ checks: { checkpoint: ['npm test', 'npm run lint', 'npm test'] } }) });
    const g = await readTeamConfig(f.repo, good);
    assert.equal(g.invalid, false);
    assert.deepEqual(g.config.checks.checkpoint, ['npm test', 'npm run lint', 'npm test']);
    // An empty array is a configured empty list (CS_NO_CHECKS_CONFIGURED's input).
    const empty = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ checks: { checkpoint: [] } }) });
    assert.deepEqual((await readTeamConfig(f.repo, empty)).config.checks.checkpoint, []);
    // A missing key or a mistyped one keeps the default; the rest of the config is still read (lenient, never invalid).
    const cases: Array<[string, unknown]> = [
      ['no checks key', { sync: { include: ['src/**'] } }],
      ['checks not an object', { checks: 'npm test', sync: { include: ['src/**'] } }],
      ['checks an array', { checks: ['npm test'], sync: { include: ['src/**'] } }],
      ['no checkpoint key', { checks: { other: ['x'] }, sync: { include: ['src/**'] } }],
      ['checkpoint a string', { checks: { checkpoint: 'npm test' }, sync: { include: ['src/**'] } }],
      ['checkpoint with a number', { checks: { checkpoint: ['npm test', 3] }, sync: { include: ['src/**'] } }],
      ['checkpoint null', { checks: { checkpoint: null }, sync: { include: ['src/**'] } }],
    ];
    for (const [why, doc] of cases) {
      const c = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify(doc) });
      const r = await readTeamConfig(f.repo, c);
      assert.equal(r.invalid, false, why);
      assert.deepEqual(r.config.checks, { checkpoint: [] }, why);
      assert.deepEqual(r.config.sync.include, ['src/**'], `${why}: the other keys are read`);
    }
    // Each read is a fresh copy: mutating one result never reaches the default or a later read.
    g.config.checks.checkpoint.push('mutated');
    assert.deepEqual(DEFAULT_TEAM_CONFIG.checks.checkpoint, []);
    assert.deepEqual((await readTeamConfig(f.repo, good)).config.checks.checkpoint, ['npm test', 'npm run lint', 'npm test']);
  } finally {
    await f.cleanup();
  }
});
