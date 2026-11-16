// Plan 5 Task 4: the loader's private copies equal the shared modules (A4-2, P5-EC-7; R1-211 language rule, R5-47, X-53, X-60, X-61). Every sample runs
// the bundled loader of a test-form build and compares what it sent or wrote with the shared function: canonRoot + findRepo + liveState
// (src/data/canonRoot.ts), seatKeyOf, evidenceFor + evidenceTag, normArgs (src/claude/wire/hookInput.ts), resolveDataDir (src/data/pluginDataDir.ts)
// and loaderLang (src/claude/text/claudeText.ts). Samples come from fast-check (fc.sample, fixed seeds) and run four at a time.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import fc from 'fast-check';
import { LOADER_TEXTS, loaderLang } from '../../src/claude/text/claudeText.js';
import type { EvidenceRecord } from '../../src/claude/wire/frames.js';
import { evidenceFor, evidenceTag, normArgs, parseHookInput, seatKeyOf } from '../../src/claude/wire/hookInput.js';
import { canonicalJsonLine } from '../../src/claude/wire/ndjson.js';
import { canonRoot, findRepo, liveState, sameRoot } from '../../src/data/canonRoot.js';
import { resolveDataDir } from '../../src/data/pluginDataDir.js';
import { realRootProbe } from '../../src/ports/fs.js';
import { fakeDaemon, type FakeDaemon } from '../helpers/fakeDaemon.js';
import { buildDist, copyDist, hookJson, loaderRepo, pooled, preToolJson, runLoader, type LoaderRepo } from '../helpers/loaderRun.js';

const PLATFORM = process.platform;
const FOLDS = PLATFORM === 'win32' || PLATFORM === 'darwin';
let live: LoaderRepo;
let nonlive: LoaderRepo;
let daemon: FakeDaemon;
let dist = '';
before(async () => {
  live = await loaderRepo({ label: 'loader-parity', live: true });
  nonlive = await loaderRepo({ label: 'loader-parity-nonlive' });
  daemon = await fakeDaemon(live.endpoint as string, live.key as Buffer);
  dist = buildDist(join(live.base, 'build'));
  mkdirSync(join(live.dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(live.dir, 'src', 'deep', 'x.ts'), 'x\n');
  writeFileSync(join(live.dir, 'README.md'), '# r\n');
});
after(async () => {
  await daemon?.close();
  await live?.cleanup();
  await nonlive?.cleanup();
});

const hookOf = (pred: (h: Record<string, unknown>, p: Record<string, unknown>) => boolean): Record<string, unknown> | undefined =>
  daemon.frames().map((f) => f.frame).find((f) => f['t'] === 'hook' && pred(f['h'] as Record<string, unknown>, f['payload'] as Record<string, unknown>));

test('the loader copies equal Task 1\'s functions', { timeout: 1_200_000 }, async (t) => {
  await t.test('canonRoot + findRepo + liveState: 300 spellings of paths inside the temp tree', async () => {
    const existing = [live.dir, join(live.dir, 'src'), join(live.dir, 'src', 'deep'), join(live.dir, 'src', 'deep', 'x.ts'), join(live.dir, 'README.md')];
    const spelling = fc.record({
      base: fc.constantFrom(...existing),
      flips: fc.array(fc.boolean(), { minLength: 400, maxLength: 400 }),
      slashes: fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
      nfd: fc.boolean(),
      tail: fc.array(fc.constantFrom('new', 'N2', 'd\u{E9}j\u{E0}', '\u{ACF5} \u{BC31}', 'z.ts'), { maxLength: 3 }),
      // An edit-class file_path reaches canonRoot through path.resolve; a cwd reaches it as given, so trailing separators ride the cwd route.
      via: fc.constantFrom<'edit' | 'cwd'>('edit', 'edit', 'cwd'),
      trailing: fc.constantFrom('', '', '/', '//', PLATFORM === 'win32' ? '\\' : '/'),
    }).map((s) => {
      let p = join(s.base, ...s.tail);
      if (FOLDS) p = [...p].map((c, i) => (s.flips[i % s.flips.length] ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join('');
      if (PLATFORM === 'win32') { let k = 0; p = p.replace(/\\/g, () => (s.slashes[k++ % s.slashes.length] ? '/' : '\\')); }
      return { path: (s.nfd ? p.normalize('NFD') : p.normalize('NFC')) + s.trailing, via: s.via };
    });
    const samples = fc.sample(spelling, { numRuns: 300, seed: 4401 });
    const results = await pooled(samples, 4, async (s, i) => {
      if (s.via === 'cwd') {
        return runLoader('UserPromptSubmit', hookJson('UserPromptSubmit', s.path, { prompt_id: `cwd_root_${i}` }), { dist, cwd: live.dir, env: live.env });
      }
      const json = preToolJson('Edit', live.dir, { filePath: s.path });
      json['tool_use_id'] = `toolu_root_${i}`;
      return runLoader('PreToolUse', json, { dist, cwd: live.dir, env: live.env });
    });
    let reached = 0;
    samples.forEach((s, i) => {
      const target = canonRoot(s.via === 'cwd' ? s.path : resolve(live.dir, s.path), realRootProbe, PLATFORM);
      const loc = findRepo(target, realRootProbe, PLATFORM);
      const isLive = loc !== null && loc.kind === 'dir' && liveState(loc, realRootProbe, PLATFORM) === 'live';
      const hook = s.via === 'cwd' ? hookOf((h) => h['prompt_id'] === `cwd_root_${i}`) : hookOf((_h, p) => p['tool_use_id'] === `toolu_root_${i}`);
      // An Edit of the root directory itself has no repo-relative path: core refuses it (G4), so only edit targets inside a live root send a frame.
      if (isLive && (s.via === 'cwd' || !sameRoot(target, loc.root, PLATFORM))) {
        reached += 1;
        assert.ok(hook !== undefined, `${s.via} ${JSON.stringify(s.path)}: live by the shared functions, but no frame (exit ${String(results[i]!.exit)} ${results[i]!.stderr})`);
        assert.equal((hook['h'] as { repo_root: string }).repo_root, loc.root, `${s.via} ${JSON.stringify(s.path)}`);
      } else {
        assert.equal(hook, undefined, `${s.via} ${JSON.stringify(s.path)}: not live (or the root itself) by the shared functions, yet a frame`);
      }
    });
    assert.ok(reached >= 200, `most spellings are live (${reached})`);
    assert.ok(samples.some((s) => s.via === 'cwd' && s.path.length > 0 && /[\\/]$/.test(s.path)), 'trailing separators were exercised');
  });

  await t.test('seatKeyOf: 200 random CLAUDE_CODE_MESSAGING_SOCKET values (and unset); the ppid is this process', async () => {
    const value = fc.stringOf(fc.oneof(fc.char(), fc.constantFrom('\\', '/', '.', ':', '\u{ACF5}', '\u{1F600}', ' ')), { maxLength: 40 }).filter((s) => !s.includes('\u{0}'));
    const sockets: Array<string | undefined> = [undefined, '', ...fc.sample(value, { numRuns: 199, seed: 4402 })];
    await pooled(sockets, 4, async (socket, i) => {
      const json = hookJson('UserPromptExpansion', live.dir, { prompt: '/cowork save "x"', command_args: 'save "x"', prompt_id: `seat-${i}` });
      const res = await runLoader('UserPromptExpansion', json, { dist, cwd: live.dir, env: { ...live.env, CLAUDE_CODE_MESSAGING_SOCKET: socket } });
      assert.equal(res.exit, 0, res.stderr);
    });
    sockets.forEach((socket, i) => {
      const want = seatKeyOf(socket === undefined ? {} : { CLAUDE_CODE_MESSAGING_SOCKET: socket }, process.pid);
      const hook = hookOf((h) => h['prompt_id'] === `seat-${i}`);
      assert.ok(hook !== undefined, `seat ${i}: a frame`);
      assert.equal((hook['h'] as { seat_key: string }).seat_key, want, `core, ${JSON.stringify(socket)}`);
      assert.equal(((hook['payload'] as { evidence: { seat_key: string } }).evidence).seat_key, want, `the loader's copy, ${JSON.stringify(socket)}`);
    });
  });

  const evidencePath = join(nonlive.gitdir, 'cowork', 'tmp', 'evidence.jsonl');
  const lines = (): Map<string, string> => new Map((existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').split('\n').filter((l) => l !== '') : [])
    .map((l) => [String((JSON.parse(l) as { prompt_id: string }).prompt_id), l]));

  await t.test('evidenceFor + evidenceTag: 200 random UserPromptExpansion inputs', async () => {
    rmSync(evidencePath, { force: true });
    const input = fc.record({
      expansion_type: fc.constantFrom('slash_command', 'slash_command', 'slash_command', 'prompt', 'skill'),
      command_name: fc.constantFrom<unknown>('cowork', 'cowork', 'cowork', 'cowork-sync:cowork', 'cowork-sync:cowork', 'other', 5),
      verb: fc.constantFrom('save', 'start', 'done', 'resolve', 'release', 'pause', 'stop', 'status', 'pausex', ''),
      tail: fc.stringOf(fc.constantFrom('a', ' ', '"', "'", '\\', '#', 'x y', '\t', '\u{ACF5}'), { maxLength: 16 }),
      nonce: fc.constantFrom('', '', '', ' cws-0123456789abcdef', ' cws-0123'),
      prompt_id: fc.constantFrom<'id' | null | 'absent'>('id', 'id', 'id', 'id', null, 'absent'),
    });
    const samples = fc.sample(input, { numRuns: 200, seed: 4403 }).map((s, i) => {
      const args = `${s.verb} ${s.tail}`;
      const json: Record<string, unknown> = hookJson('UserPromptExpansion', nonlive.dir, {
        expansion_type: s.expansion_type, command_name: s.command_name, command_args: args, prompt: `/cowork ${args}${s.nonce}`, prompt_id: `ev-${i}`,
      });
      if (s.prompt_id === null) json['prompt_id'] = null;
      if (s.prompt_id === 'absent') delete json['prompt_id'];
      return json;
    });
    await pooled(samples, 4, async (json) => {
      const res = await runLoader('UserPromptExpansion', json, { dist, cwd: nonlive.dir, env: nonlive.env });
      assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', '']);
    });
    const written = lines();
    let expectedLines = 0;
    samples.forEach((json, i) => {
      const line = written.get(`ev-${i}`);
      const mono = line === undefined ? 1n : BigInt((JSON.parse(line) as { mono_ns: string }).mono_ns);
      let want: EvidenceRecord | null;
      try {
        want = evidenceFor(parseHookInput('UserPromptExpansion', json), seatKeyOf({}, process.pid), mono);
      } catch {
        want = null;
      }
      if (want === null) {
        assert.equal(line, undefined, `sample ${i}: no evidence by evidenceFor, yet a line`);
        return;
      }
      expectedLines += 1;
      assert.ok(line !== undefined, `sample ${i}: evidenceFor gives a record, but no line (${JSON.stringify(json['command_args'])})`);
      assert.equal(line, canonicalJsonLine({ ...want, tag: evidenceTag(nonlive.key as Buffer, want) }), `sample ${i}`);
    });
    assert.equal(written.size, expectedLines);
    assert.ok(expectedLines >= 20, `enough records (${expectedLines})`);
  });

  await t.test('normArgs: 300 command_args with quoted words give the same args_sha256', async () => {
    rmSync(evidencePath, { force: true });
    const tail = fc.stringOf(fc.oneof(
      fc.constantFrom('a', 'b', ' ', '  ', '\t', '\n', '"', "'", '\\', '#', '$', '`', '\u{E9}', '\u{ACF5}', '\r'),
      fc.constantFrom('"q w"', "'s t'", '"a\\"b"', '"x\\\\y"', '\\ ', '\\\n', '"\\$"', "'\\'", '"#"', ' #c'),
    ), { maxLength: 24 });
    const args = fc.sample(tail, { numRuns: 300, seed: 4404 }).map((s) => `save ${s}`);
    await pooled(args, 4, async (a, i) => {
      const json = hookJson('UserPromptExpansion', nonlive.dir, { command_args: a, prompt: '/cowork save', prompt_id: `na-${i}` });
      const res = await runLoader('UserPromptExpansion', json, { dist, cwd: nonlive.dir, env: nonlive.env });
      assert.equal(res.exit, 0);
    });
    const written = lines();
    args.forEach((a, i) => {
      const line = written.get(`na-${i}`);
      assert.ok(line !== undefined, `sample ${i}: a line`);
      const o = JSON.parse(line) as { args_sha256: string; verb: string };
      const want = normArgs(a);
      assert.equal(o.verb, want.verb);
      assert.equal(o.args_sha256, want.argsSha256, `args ${JSON.stringify(a)} (args_norm ${JSON.stringify(want.argsNorm)})`);
    });
  });

  await t.test('resolveDataDir + loaderLang: the loader reads user.json from exactly the shared directory', async () => {
    const home = join(live.base, 'parity-home');
    const absData = join(live.base, 'parity-data');
    const cfg = join(live.base, 'parity-cfg');
    const cacheRoot = join(home, '.claude', 'plugins', 'cache', 'test-market', 'cowork-sync', '0.6.0');
    const ownRoot = join(home, '.claude', 'plugins', 'cache', 'own-market', 'cowork-sync', '9.9.9');
    const ownDist = copyDist(dist, ownRoot);
    const cwd = join(live.base, 'parity-cwd');
    mkdirSync(cwd, { recursive: true });
    const osLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const base = loaderLang(null, osLocale);
    const opposite = base === 'ko' ? 'en' : 'ko';
    type Row = { what: string; env: Record<string, string | undefined>; dist?: string };
    const rows: Row[] = [
      { what: 'absolute CLAUDE_PLUGIN_DATA', env: { CLAUDE_PLUGIN_DATA: absData } },
      { what: 'the variable needs no plugin id', env: { CLAUDE_PLUGIN_DATA: absData, CLAUDE_PLUGIN_ROOT: join(live.base, 'not', 'a', 'plugin') } },
      { what: 'a trailing separator', env: { CLAUDE_PLUGIN_DATA: `${absData}${PLATFORM === 'win32' ? '\\' : '/'}` } },
      { what: 'a cache-shaped CLAUDE_PLUGIN_ROOT', env: { CLAUDE_PLUGIN_ROOT: cacheRoot } },
      { what: 'the plugin root with a trailing separator', env: { CLAUDE_PLUGIN_ROOT: `${cacheRoot}/` } },
      { what: 'an absolute CLAUDE_CONFIG_DIR', env: { CLAUDE_PLUGIN_ROOT: cacheRoot, CLAUDE_CONFIG_DIR: cfg } },
      { what: 'a relative CLAUDE_CONFIG_DIR is ignored', env: { CLAUDE_PLUGIN_ROOT: cacheRoot, CLAUDE_CONFIG_DIR: 'cfg' } },
      { what: 'a relative CLAUDE_PLUGIN_DATA fails closed', env: { CLAUDE_PLUGIN_DATA: 'd', CLAUDE_PLUGIN_ROOT: cacheRoot } },
      { what: 'an empty CLAUDE_PLUGIN_DATA counts as unset', env: { CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: cacheRoot } },
      { what: 'a UNC CLAUDE_PLUGIN_DATA fails closed', env: { CLAUDE_PLUGIN_DATA: '\\\\server\\share\\d', CLAUDE_PLUGIN_ROOT: cacheRoot } },
      { what: 'no variable and a plugin root of another shape', env: {} },
      { what: 'the loader\'s own dist/.. when CLAUDE_PLUGIN_ROOT is unset', env: {}, dist: ownDist },
      ...(PLATFORM === 'win32' ? [{ what: 'a variable name in another case (win32)', env: { claude_plugin_data: absData } }] : []),
    ];
    const decoys = [absData, join(cwd, 'd'), join(home, '.claude', 'plugins', 'data', 'cowork-sync-test-market'), join(cfg, 'plugins', 'data', 'cowork-sync-test-market'),
      join(home, '.claude', 'plugins', 'data', 'cowork-sync-own-market'), join(home, '.claude', 'plugins', 'data', 'cowork-sync'), join(dirname(dist), '..', 'plugins', 'data')];
    for (const row of rows) {
      const rowDist = row.dist ?? dist;
      const pluginRoot = row.env['CLAUDE_PLUGIN_ROOT'] || row.env['claude_plugin_root'] || dirname(rowDist);
      const expected = resolveDataDir(row.env, home, PLATFORM, pluginRoot);
      for (const d of [...decoys, ...(expected === null ? [] : [expected])]) rmSync(join(d, 'user.json'), { force: true });
      const put = (d: string, lang: string): void => {
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'user.json'), JSON.stringify({ language: lang }));
      };
      if (expected === null) for (const d of decoys) put(d, opposite);
      else put(expected, opposite);
      const res = await runLoader('PreToolUse', null, { dist: rowDist, cwd, env: { USERPROFILE: home, HOME: home, ...row.env }, stdin: '{"a":' });
      const lang = loaderLang(expected === null ? null : opposite, osLocale);
      assert.equal(res.exit, 2, row.what);
      assert.equal(res.stderr, LOADER_TEXTS.G4[lang], `${row.what}: expected ${String(expected)} → ${lang}`);
    }
  });

  await t.test('canonRoot + findRepo through a dangling or looping link (P5-T4-1): in a live repo the edit is gated as usual, never G4 from the walk', async () => {
    // Real links inside the live repo: junctions on win32 (no privilege needed), symlinks elsewhere (the type argument is ignored there).
    const gone = join(live.dir, 'gone-target');
    mkdirSync(gone, { recursive: true });
    const dangling = join(live.dir, 'dangling-link');
    symlinkSync(gone, dangling, 'junction');
    rmSync(gone, { recursive: true });
    const loopA = join(live.dir, 'loop-a');
    const loopB = join(live.dir, 'loop-b');
    symlinkSync(loopB, loopA, 'junction');
    symlinkSync(loopA, loopB, 'junction');
    try {
      const cases: Array<{ what: string; via: 'edit' | 'cwd'; path: string; rel: string }> = [
        { what: 'a dangling link at the leaf', via: 'edit', path: dangling, rel: 'dangling-link' },
        { what: 'a dangling link at an ancestor', via: 'edit', path: join(dangling, 'sub', 'x.ts'), rel: 'dangling-link/sub/x.ts' },
        { what: 'a link loop at the leaf', via: 'edit', path: loopA, rel: 'loop-a' },
        { what: 'a link loop at an ancestor', via: 'edit', path: join(loopA, 'deeper', 'x.ts'), rel: 'loop-a/deeper/x.ts' },
        { what: 'a cwd under a dangling link', via: 'cwd', path: join(dangling, 'sub'), rel: '' },
        { what: 'a cwd under a link loop', via: 'cwd', path: join(loopA, 'sub'), rel: '' },
      ];
      const results = await pooled(cases, 4, async (c, i) => {
        if (c.via === 'cwd') return runLoader('UserPromptSubmit', hookJson('UserPromptSubmit', c.path, { prompt_id: `link_cwd_${i}` }), { dist, cwd: live.dir, env: live.env });
        const json = preToolJson('Edit', live.dir, { filePath: c.path });
        json['tool_use_id'] = `toolu_link_${i}`;
        return runLoader('PreToolUse', json, { dist, cwd: live.dir, env: live.env });
      });
      cases.forEach((c, i) => {
        const res = results[i]!;
        assert.deepEqual([res.exit, res.stdout, res.stderr], [0, '', ''], `${c.what}: gated as usual (the daemon answers none), not G4`);
        const target = canonRoot(c.path, realRootProbe, PLATFORM);
        const loc = findRepo(target, realRootProbe, PLATFORM);
        assert.ok(loc !== null && loc.kind === 'dir' && liveState(loc, realRootProbe, PLATFORM) === 'live', `${c.what}: live by the shared functions`);
        const hook = c.via === 'cwd' ? hookOf((h) => h['prompt_id'] === `link_cwd_${i}`) : hookOf((_h, p) => p['tool_use_id'] === `toolu_link_${i}`);
        assert.ok(hook !== undefined, `${c.what}: a frame`);
        assert.equal((hook['h'] as { repo_root: string }).repo_root, loc.root, c.what);
        if (c.via === 'edit') assert.equal((hook['payload'] as { path: string }).path, c.rel, `${c.what}: the repo-relative path keeps the link's name`);
      });
    } finally {
      for (const l of [dangling, loopA, loopB]) rmSync(l, { force: true });
    }
  });
});
