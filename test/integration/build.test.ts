import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_VERSION } from '../../src/version.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildScript = join(repoRoot, 'tools', 'build', 'build.mjs');
const ENTRY_NAMES = ['cli', 'core', 'daemon', 'hook', 'mcp', 'viz', 'worker'];

interface Metafile {
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;
}

test('build produces exactly the seven dist entry points, each runnable on its own', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cowork-build-'));
  const out = join(tmp, 'dist');
  const metaPath = join(tmp, 'meta', 'metafile.json');
  try {
    const first = spawnSync(process.execPath, [buildScript, '--outdir', out], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(first.status, 0, `build failed:\n${first.stdout}\n${first.stderr}`);
    writeFileSync(join(out, 'stale.js'), 'leftover from an earlier build\n');

    const r = spawnSync(process.execPath, [buildScript, '--outdir', out, '--metafile', metaPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readdirSync(out).sort(), ENTRY_NAMES.map((n) => `${n}.js`));

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile;
    const outputs = Object.keys(meta.outputs);
    assert.equal(outputs.length, 7, `metafile outputs: ${outputs.join(', ')}`);
    for (const [file, info] of Object.entries(meta.outputs)) {
      for (const imp of info.imports) {
        assert.equal(imp.external, true, `${file} bundles ${imp.path} instead of importing a built-in`);
        assert.ok(imp.path.startsWith('node:'), `${file} imports non-builtin ${imp.path}`);
      }
    }

    for (const name of ENTRY_NAMES) {
      const file = join(out, `${name}.js`);
      const v = spawnSync(process.execPath, [file, '--version'], { encoding: 'utf8' });
      assert.equal(v.status, 0, `${name}.js --version failed: ${v.stderr}`);
      assert.equal(v.stdout, `cowork-sync ${name} ${PLUGIN_VERSION}\n`);

      const noop = spawnSync(process.execPath, [file], { encoding: 'utf8', input: '' });
      assert.equal(noop.status, 0, `${name}.js without arguments failed: ${noop.stderr}`);
      assert.equal(noop.stdout, '');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('build refuses an unknown argument', () => {
  const r = spawnSync(process.execPath, [buildScript, '--bogus'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --bogus/);
});

// Final review #10: the build empties --outdir first, so a mistyped --outdir (the repo, a parent of
// it, the sources, or any unrelated folder) must be refused before anything is deleted. Run against
// a throwaway copy of the script and esbuild, never against this repository.
test('build refuses an --outdir it must not empty, and deletes nothing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cowork-build-guard-'));
  const fake = join(tmp, 'repo');
  try {
    mkdirSync(join(fake, 'tools', 'build'), { recursive: true });
    copyFileSync(buildScript, join(fake, 'tools', 'build', 'build.mjs'));
    for (const pkg of ['esbuild', '@esbuild']) {
      cpSync(join(repoRoot, 'node_modules', pkg), join(fake, 'node_modules', pkg), { recursive: true });
    }
    mkdirSync(join(fake, 'src', 'entry'), { recursive: true });
    const keep = join(fake, 'src', 'entry', 'keep.ts');
    writeFileSync(keep, 'export {};\n');
    const notes = join(tmp, 'notes', 'notes.txt');
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, 'not a build output\n');
    // The same folders reached through a link (macOS: /var -> /private/var; Windows: a junction).
    const link = join(tmp, 'link');
    symlinkSync(fake, link, process.platform === 'win32' ? 'junction' : 'dir');

    for (const outdir of [fake, tmp, join(fake, 'src'), join(fake, 'src', 'entry', 'out'), dirname(notes), join(link, 'src', 'entry', 'out')]) {
      const r = spawnSync(process.execPath, [join(fake, 'tools', 'build', 'build.mjs'), '--outdir', outdir], {
        cwd: fake,
        encoding: 'utf8',
      });
      assert.equal(r.status, 2, `--outdir ${outdir} was not refused:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /refus/, outdir);
      assert.ok(existsSync(keep), `--outdir ${outdir} deleted the sources`);
      assert.ok(existsSync(notes), `--outdir ${outdir} deleted an unrelated folder's files`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
