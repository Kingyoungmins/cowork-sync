import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INSERTION_MERGE, DEFAULT_TEAM_CONFIG, genesisBudget, readTeamConfig, type TeamConfig,
} from '../../src/data/config.js';
import { wildmatch } from '../../src/data/scope.js';
import { commitFiles } from '../helpers/commitFiles.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const CONFIG_PATH = '.cowork/config.json';

test('readTeamConfig: absent gives defaults; malformed JSON gives defaults and invalid; a mistyped field is ignored', async () => {
  const f = await makeRepoFixture('cfg-read');
  try {
    // defaults are the documented ones
    assert.deepEqual([...DEFAULT_INSERTION_MERGE], ['CHANGELOG*', 'HISTORY*', 'NEWS*', '*.md', '*.txt']);
    assert.equal(DEFAULT_TEAM_CONFIG.sync.maxNewFileBytes, 1_048_576);
    assert.deepEqual(DEFAULT_TEAM_CONFIG.sync.include, []);
    assert.deepEqual(DEFAULT_TEAM_CONFIG.sync.exclude, []);
    assert.deepEqual(DEFAULT_TEAM_CONFIG.sync.allowSecretLike, []);
    assert.deepEqual(DEFAULT_TEAM_CONFIG.merge.insertionMerge, [...DEFAULT_INSERTION_MERGE]);

    // absent: the file is not in the tree
    const absent = await commitFiles(f, { 'README.md': '# x\n' });
    assert.deepEqual(await readTeamConfig(f.repo, absent), { config: DEFAULT_TEAM_CONFIG, invalid: false, reason: null });

    // .cowork/config.json is a directory, not a file: treated as absent
    const asDir = await commitFiles(f, { '.cowork/config.json/x': '{}' });
    assert.deepEqual(await readTeamConfig(f.repo, asDir), { config: DEFAULT_TEAM_CONFIG, invalid: false, reason: null });

    // not a UTF-8 JSON object: defaults + invalid
    const bad: Array<[string, string | Buffer]> = [
      ['malformed', '{ "sync": '],
      ['empty', ''],
      ['array', '[1,2]'],
      ['string', '"x"'],
      ['null', 'null'],
      ['number', '7'],
      ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])],
      ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
    ];
    for (const [why, bytes] of bad) {
      const c = await commitFiles(f, { [CONFIG_PATH]: bytes });
      const r = await readTeamConfig(f.repo, c);
      assert.equal(r.invalid, true, why);
      assert.deepEqual(r.config, DEFAULT_TEAM_CONFIG, why);
    }

    // a valid object: fields are taken, the rest default
    const good = await commitFiles(f, {
      [CONFIG_PATH]: JSON.stringify({
        schema: 'cowork-config/1',
        sync: { include: ['src/**'], exclude: ['dist/**', '*.log'], allowSecretLike: ['.env'], maxNewFileBytes: 4096 },
        merge: { insertionMerge: ['*.rst'] },
        host: { pushBudgetPerMin: 8 },
        unknownKey: { x: 1 },
      }),
    });
    const g = await readTeamConfig(f.repo, good);
    assert.equal(g.invalid, false);
    const want: TeamConfig = {
      sync: { include: ['src/**'], exclude: ['dist/**', '*.log'], allowSecretLike: ['.env'], maxNewFileBytes: 4096 },
      merge: { insertionMerge: ['*.rst'] },
      host: { pushBudgetPerMin: 8 },
    };
    assert.deepEqual(g.config, want);

    // a mistyped field is ignored (the default stays), the others are kept
    const mistyped = await commitFiles(f, {
      [CONFIG_PATH]: JSON.stringify({
        sync: { include: 'src/**', exclude: ['dist/**', 3], allowSecretLike: ['.env'], maxNewFileBytes: '10' },
        merge: { insertionMerge: { a: 1 } },
        host: 'fast',
      }),
    });
    const m = await readTeamConfig(f.repo, mistyped);
    assert.equal(m.invalid, false);
    assert.deepEqual(m.config.sync.include, []);
    assert.deepEqual(m.config.sync.exclude, []);
    assert.deepEqual(m.config.sync.allowSecretLike, ['.env']);
    assert.equal(m.config.sync.maxNewFileBytes, 1_048_576);
    assert.deepEqual(m.config.merge.insertionMerge, [...DEFAULT_INSERTION_MERGE]);
    assert.equal(genesisBudget(m.config), 12);

    // the sync section itself of the wrong type
    const wrongSection = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: [1], merge: 5, host: null }) });
    const w = await readTeamConfig(f.repo, wrongSection);
    assert.equal(w.invalid, false);
    assert.deepEqual(w.config, DEFAULT_TEAM_CONFIG);

    // maxNewFileBytes: above the 1 MiB maximum is clamped, negative and fractional are ignored, 0 is allowed
    for (const [v, expect] of [[2_000_000, 1_048_576], [0, 0], [-5, 1_048_576], [1.5, 1_048_576], [1_048_576, 1_048_576]] as const) {
      const c = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: { maxNewFileBytes: v } }) });
      assert.equal((await readTeamConfig(f.repo, c)).config.sync.maxNewFileBytes, expect, String(v));
    }

    // an invalid glob makes the whole config invalid (glossary §17), with a reason; defaults at first read
    const B = String.fromCharCode(91); // '['
    const badGlobs: Array<[string, unknown]> = [
      ['sync.exclude', { sync: { exclude: ['dist/**', `a${B}z-a]b`] } }],
      ['sync.include', { sync: { include: [`unterminated${B}`] } }],
      ['merge.insertionMerge', { merge: { insertionMerge: [`${B}z-a]`] } }],
    ];
    for (const [field, body] of badGlobs) {
      const c = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify(body) });
      const r = await readTeamConfig(f.repo, c);
      assert.equal(r.invalid, true, field);
      assert.deepEqual(r.config, DEFAULT_TEAM_CONFIG, field);
      assert.ok((r.reason ?? '').includes(field), field);
    }
    // allowSecretLike holds exact paths, not globs: brackets are literal, the config stays valid,
    // and an entry that can never be a path is ignored and noted
    const exact = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: { allowSecretLike: [`app/api/${B}r-i]/credentials.ts`, `x${B}`, '/abs/.env', '../up/.env', '.env'] } }) });
    const ex = await readTeamConfig(f.repo, exact);
    assert.equal(ex.invalid, false);
    assert.deepEqual(ex.config.sync.allowSecretLike, [`app/api/${B}r-i]/credentials.ts`, `x${B}`, '.env']);
    assert.ok((ex.reason ?? '').includes('/abs/.env') && (ex.reason ?? '').includes('../up/.env'), String(ex.reason));
    // empty and slash-only patterns match nothing and are ignored, not invalid
    const empties = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: { exclude: ['', '/', 'dist/**'] }, merge: { insertionMerge: [''] } }) });
    const em = await readTeamConfig(f.repo, empties);
    assert.equal(em.invalid, false);
    assert.equal(em.reason, null);
    assert.equal(wildmatch('', 'a'), false);
    assert.equal(wildmatch('/', 'a'), false);

    // valid globs, including a closed bracket class, stay valid
    const okGlobs = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: { exclude: [`a${B}a-z]b`, '**/x/**'] } }) });
    assert.equal((await readTeamConfig(f.repo, okGlobs)).invalid, false);

    // reads are per EPOCH_BASE commit: a later commit with other bytes is a different answer
    const other = await commitFiles(f, { [CONFIG_PATH]: JSON.stringify({ sync: { exclude: ['x'] } }) });
    assert.deepEqual((await readTeamConfig(f.repo, other)).config.sync.exclude, ['x']);
    assert.deepEqual((await readTeamConfig(f.repo, good)).config.sync.exclude, ['dist/**', '*.log']);

    // the returned config is a copy: mutating it never changes the defaults
    const r1 = await readTeamConfig(f.repo, absent);
    r1.config.sync.exclude.push('mutated');
    r1.config.merge.insertionMerge.push('mutated');
    assert.deepEqual(DEFAULT_TEAM_CONFIG.sync.exclude, []);
    assert.deepEqual(DEFAULT_TEAM_CONFIG.merge.insertionMerge, [...DEFAULT_INSERTION_MERGE]);
    assert.deepEqual((await readTeamConfig(f.repo, absent)).config.sync.exclude, []);
  } finally {
    await f.cleanup();
  }
});

test('genesisBudget: 6 → 6, 24 → 24, 7 → 7, absent → 12, 30 → 12, "fast" → 12, 7.5 → 12', () => {
  const withBudget = (v: unknown): TeamConfig => ({ ...DEFAULT_TEAM_CONFIG, host: { pushBudgetPerMin: v } });
  assert.equal(genesisBudget(withBudget(6)), 6);
  assert.equal(genesisBudget(withBudget(24)), 24);
  assert.equal(genesisBudget(withBudget(7)), 7);
  assert.equal(genesisBudget(withBudget(undefined)), 12);
  assert.equal(genesisBudget(DEFAULT_TEAM_CONFIG), 12);
  assert.equal(genesisBudget(withBudget(30)), 12);
  assert.equal(genesisBudget(withBudget('fast')), 12);
  assert.equal(genesisBudget(withBudget(7.5)), 12);
  // ruling R-19: out of range gives the default, it is not clamped
  assert.equal(genesisBudget(withBudget(5)), 12);
  assert.equal(genesisBudget(withBudget(25)), 12);
  assert.equal(genesisBudget(withBudget(0)), 12);
  assert.equal(genesisBudget(withBudget(-12)), 12);
  assert.equal(genesisBudget(withBudget('8')), 12);
  assert.equal(genesisBudget(withBudget(null)), 12);
  assert.equal(genesisBudget(withBudget(NaN)), 12);
  assert.equal(genesisBudget(withBudget(true)), 12);
  assert.equal(genesisBudget(withBudget([8])), 12);
});
