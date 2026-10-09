import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashNewPath, hashRouteB, hashRouteC, isFilterFailure } from '../../src/data/blobRoutes.js';
import { isOid, parseOid, type Oid } from '../../src/git/oid.js';
import { GitRepo, type RepoContext } from '../../src/git/repo.js';
import type { GitCallOptions } from '../../src/git/flags.js';
import type { GitRunner } from '../../src/git/runner.js';
import { fixtureContext, makeRepoFixture, type RepoFixture } from '../helpers/repoFixture.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The staged copy of p (glossary §26.1 W1): <gitdir>/cowork/tmp/stage/<p>. */
async function stage(f: RepoFixture, path: string, bytes: Buffer): Promise<string> {
  const file = join(f.paths.coworkDir, 'tmp', 'stage', ...path.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

async function looseObjects(repo: GitRepo): Promise<number> {
  const out = (await repo.run(['count-objects', '-v'])).stdout.toString('utf8');
  const m = /^count: (\d+)$/m.exec(out);
  assert.ok(m, out);
  return Number(m[1]);
}

/** What `git add` stores for these bytes written to the working file p (the real index; test only). */
async function addStores(f: RepoFixture, path: string, bytes: Buffer): Promise<Oid> {
  const abs = join(f.paths.workTree, ...path.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  await f.repo.run(['add', '--', path]);
  const rec = (await f.repo.run(['ls-files', '-s', '-z', '--', path])).stdout.toString('utf8').split('\0')[0] ?? '';
  return parseOid(rec.split(' ')[1] ?? '');
}

const spyOn = (runner: GitRunner, seen: Array<{ args: string[]; opts: GitCallOptions }>): GitRunner => ({
  run(args, opts) {
    seen.push({ args: [...args], opts: { ...opts } });
    return runner.run(args, opts);
  },
});

test('route (b) of a stage copy equals the blob git add stores for the same bytes at p', async () => {
  for (const autocrlf of [true, false]) {
    const f = await makeRepoFixture(`routeb-${autocrlf}`, { autocrlf });
    try {
      const seen: Array<{ args: string[]; opts: GitCallOptions }> = [];
      const repo = new GitRepo(spyOn(f.runner, seen), f.paths, fixtureContext);
      // An LF-stored tracked path and a new path. (Never an i/crlf-stored path: route (b) has no index
      // context and VERIFIED disagrees with git add there, 01-engine §3.3; DISK_EQ covers that case.)
      // Every variant's stored form is new to the repository, so write=false can be checked.
      const variants: Array<[string, Buffer]> = [
        ['src/a.txt', Buffer.from('one\ntwo\nthree\nfour\n')],
        ['src/a.txt', Buffer.from('one\r\ntwo\r\nthree\r\nfive\r\n')],
        ['src/a.txt', Buffer.concat([BOM, Buffer.from('one\r\n둘\r\nthree')])],
        ['docs/새 파일.md', Buffer.from('new\r\nfile\r\n')],
        ['docs/새 파일.md', Buffer.from('new\nfile\nsecond\n')],
      ];
      for (const [path, bytes] of variants) {
        const file = await stage(f, path, bytes);
        seen.length = 0;
        const idOnly = await hashRouteB(repo, path, file, false);
        assert.ok(isOid(idOnly), `route (b) id for ${path}`);
        assert.equal(await f.repo.hasObject(idOnly, 'blob'), false, 'write=false stores nothing');
        // One attribute-reading hash-object call at the repository root, --path=<p>, the staged copy
        // after --, no -w, no work tree (ENG-08); the runner adds attr.tree and the required filters.
        assert.equal(seen.length, 1);
        const call = seen[0]!;
        assert.deepEqual(call.args, ['hash-object', `--path=${path}`, '--', file]);
        assert.equal(call.opts.cwd, f.paths.workTree);
        assert.equal(call.opts.class, 'attr');
        assert.equal(call.opts.workTree, undefined, 'never --work-tree');

        const written = await hashRouteB(repo, path, file, true);
        assert.equal(written, idOnly);
        assert.equal(await f.repo.hasObject(written as Oid, 'blob'), true, 'write=true stores the blob');
        assert.equal(await addStores(f, path, bytes), idOnly, `autocrlf=${autocrlf} ${path} ${JSON.stringify(bytes.toString('latin1'))}`);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('a failing required clean filter gives FilterFailure and stores nothing', async () => {
  const f = await makeRepoFixture('routeb-filter', {
    files: {
      '.gitattributes': Buffer.from('*.sec filter=bad\n'),
      'keys.sec': Buffer.from('k=PLACEHOLDER\n'),
      'src/a.txt': Buffer.from('one\n'),
    },
  });
  try {
    const head = await f.repo.resolve('HEAD');
    assert.ok(head);
    // The driver is discovered (D3), so every call carries filter.bad.required=true; attributes come from EPOCH_BASE.
    const ctx = (): RepoContext => ({ ...fixtureContext(), attrTree: head, filterDrivers: ['bad'] });
    const repo = new GitRepo(f.runner, f.paths, ctx);
    await f.repo.run(['config', 'filter.bad.clean', 'node -e "process.exit(3)"']);
    // The working-tree .gitattributes no longer names the filter: attr.tree (EPOCH_BASE) still does.
    await writeFile(join(f.paths.workTree, '.gitattributes'), '');

    const before = await looseObjects(repo);
    const file = await stage(f, 'keys.sec', Buffer.from('k=REAL v2\n'));
    const r = await hashRouteB(repo, 'keys.sec', file, true);
    assert.deepEqual(r, { failed: 'filter', path: 'keys.sec' });
    assert.equal(isFilterFailure(r), true);
    const fresh = await stage(f, 'new.sec', Buffer.from('k=REAL new\n'));
    assert.deepEqual(await hashNewPath(repo, 'new.sec', fresh, true), { failed: 'filter', path: 'new.sec' });
    assert.equal(await looseObjects(repo), before, 'no object was stored');

    // Positive control: the same calls with a working clean filter store the clean output.
    await f.repo.run(['config', 'filter.bad.clean', 'node -e "process.stdin.pipe(process.stdout)"']);
    const okId = await hashRouteB(repo, 'keys.sec', file, true);
    assert.ok(isOid(okId));
    assert.equal(isFilterFailure(okId), false);
    assert.equal((await f.repo.readBlob(okId)).toString('utf8'), 'k=REAL v2\n');

    assert.equal(isFilterFailure(null), false);
    assert.equal(isFilterFailure('filter'), false);
    assert.equal(isFilterFailure({ failed: 'filter' }), false);
    assert.equal(isFilterFailure({ failed: 'other', path: 'x' }), false);
  } finally {
    await f.cleanup();
  }
});

test('hashNewPath stores LF for a CRLF new file on autocrlf=true and autocrlf=false repos', async () => {
  for (const autocrlf of [true, false]) {
    const f = await makeRepoFixture(`newpath-${autocrlf}`, {
      autocrlf,
      files: { '.gitattributes': Buffer.from('*.raw -text\n'), 'src/a.txt': Buffer.from('one\n') },
    });
    try {
      const head = await f.repo.resolve('HEAD');
      assert.ok(head);
      const repo = new GitRepo(f.runner, f.paths, () => ({ ...fixtureContext(), attrTree: head }));
      const crlf = Buffer.from('alpha\r\nbeta\r\n');
      const file = await stage(f, 'src/new.txt', crlf);
      const id = await hashNewPath(repo, 'src/new.txt', file, true);
      assert.ok(isOid(id));
      assert.equal((await repo.readBlob(id)).toString('latin1'), 'alpha\nbeta\n');
      const bomFile = await stage(f, 'src/new-bom.txt', Buffer.concat([BOM, crlf]));
      const bomId = await hashNewPath(repo, 'src/new-bom.txt', bomFile, true);
      assert.ok(isOid(bomId));
      assert.ok((await repo.readBlob(bomId)).equals(Buffer.concat([BOM, Buffer.from('alpha\nbeta\n')])), 'BOM kept, endings LF');
      // Without the DAT-07 override an autocrlf=false peer would store CRLF.
      const plain = await hashRouteB(repo, 'src/new.txt', file, false);
      if (autocrlf) assert.equal(plain, id);
      else assert.notEqual(plain, id);
      // EPOCH_BASE attributes still decide: -text keeps the bytes.
      const raw = await stage(f, 'data/x.raw', crlf);
      const rawId = await hashNewPath(repo, 'data/x.raw', raw, true);
      assert.ok(isOid(rawId));
      assert.ok((await repo.readBlob(rawId)).equals(crlf));
      // write=false: the id only.
      const other = await stage(f, 'src/other.txt', Buffer.from('gamma\r\n'));
      const otherId = await hashNewPath(repo, 'src/other.txt', other, false);
      assert.ok(isOid(otherId));
      assert.equal(await repo.hasObject(otherId, 'blob'), false);
      assert.equal(otherId, await repo.hashBytes(Buffer.from('gamma\n'), false));
    } finally {
      await f.cleanup();
    }
  }
});

test("a user's core.safecrlf=true does not turn a CRLF new file's write into a FilterFailure", async () => {
  // Ruling P2-SAFECRLF: without the forced -c core.safecrlf=false, `hash-object -w` with
  // core.autocrlf=input dies rc 128 ("CRLF would be replaced by LF") while the id-only call succeeds.
  for (const autocrlf of [true, false]) {
    const f = await makeRepoFixture(`safecrlf-${autocrlf}`, { autocrlf });
    try {
      await f.repo.run(['config', 'core.safecrlf', 'true']);
      const crlf = Buffer.from(`delta\r\nepsilon ${autocrlf}\r\n`);
      const file = await stage(f, 'src/crlf-new.txt', crlf);
      const idOnly = await hashNewPath(f.repo, 'src/crlf-new.txt', file, false);
      assert.ok(isOid(idOnly), `autocrlf=${autocrlf}: id only ${JSON.stringify(idOnly)}`);
      const written = await hashNewPath(f.repo, 'src/crlf-new.txt', file, true);
      assert.equal(written, idOnly, `autocrlf=${autocrlf}: write=true gives the same id, not a FilterFailure`);
      assert.equal((await f.repo.readBlob(idOnly)).toString('latin1'), `delta\nepsilon ${autocrlf}\n`, 'stored LF');
    } finally {
      await f.cleanup();
    }
  }
});

test('route (c) with write=false writes no object', async () => {
  const f = await makeRepoFixture('routec', { autocrlf: true });
  try {
    const bytes = Buffer.concat([BOM, Buffer.from('canon output\r\nrow two\r\n'), Buffer.from([0xb0, 0xa1, 0x0a])]);
    const before = await looseObjects(f.repo);
    const id = await hashRouteC(f.repo, bytes, false);
    assert.ok(isOid(id));
    assert.equal(await f.repo.hasObject(id, 'blob'), false);
    assert.equal(await looseObjects(f.repo), before, 'no loose object');
    const written = await hashRouteC(f.repo, bytes, true);
    assert.equal(written, id);
    assert.equal(await f.repo.hasObject(id, 'blob'), true);
    assert.equal(await looseObjects(f.repo), before + 1);
    // Stored form in, stored form out: no filter and no ending conversion even on an autocrlf=true clone.
    assert.ok((await f.repo.readBlob(id)).equals(bytes));
  } finally {
    await f.cleanup();
  }
});
