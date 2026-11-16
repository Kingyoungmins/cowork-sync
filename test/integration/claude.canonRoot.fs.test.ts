// Plan 5 Task 1: the real probe — several spellings of one folder reach one canonical root and one endpoint input (TC-CCI-16 root half,
// 09 test 20 spelling half, R1-203). Real files under makeTempRoot() (its path holds a space and non-ASCII characters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonRoot, endpointRoot, findRepo } from '../../src/data/canonRoot.js';
import { realRootProbe } from '../../src/ports/fs.js';
import { makeTempRoot } from '../helpers/tmp.js';

/** Runs cmd.exe with one verbatim command line (fixed argv; the child exits on its own, nothing kills it); /u makes its output UTF-16LE. */
function cmd(line: string): { status: number | null; out: string } {
  const r = spawnSync('cmd.exe', ['/u', '/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true });
  return { status: r.status, out: r.stdout.toString('utf16le').trim() };
}

test('the real probe: an 8.3 name, an NFD spelling and a junction or symlink reach one canonical root', async (t) => {
  const tmp = await makeTempRoot('canon-root');
  try {
    const repo = join(tmp.root, 'Long Repository Name');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const p = process.platform;
    const want = canonRoot(repo, realRootProbe, p);
    const wantEndpoint = endpointRoot(join(repo, '.git'), realRootProbe, p);
    const spellings: Array<[string, string]> = [['as created', repo]];
    if (p === 'win32') {
      spellings.push(['other letter case', repo.toUpperCase()], ['forward slashes', repo.split('\\').join('/')]);
      const short = cmd(`for %I in ("${repo}") do @echo %~sI`);
      if (short.status === 0 && short.out.includes('~')) spellings.push(['8.3 short name', short.out]);
      else t.diagnostic(`8.3 case skipped: 8.3 name generation is off on this volume (cmd printed ${JSON.stringify(short.out)})`);
      const link = join(dirname(tmp.root), 'junction to repo');
      const mk = cmd(`mklink /J "${link}" "${repo}"`);
      assert.equal(mk.status, 0, `mklink /J: ${mk.out}`);
      spellings.push(['junction', link]);
    } else if (p === 'darwin') {
      const nfc = join(tmp.root, 'r\u{E9}po');
      mkdirSync(join(nfc, '.git'), { recursive: true });
      const nfcWant = canonRoot(nfc, realRootProbe, p);
      assert.equal(canonRoot(join(tmp.root, 're\u{301}po'), realRootProbe, p), nfcWant, 'NFD spelling');
      assert.equal(endpointRoot(join(tmp.root, 're\u{301}po', '.git'), realRootProbe, p), endpointRoot(join(nfc, '.git'), realRootProbe, p));
      spellings.push(['other letter case', repo.toUpperCase()]);
    } else {
      const link = join(dirname(tmp.root), 'symlinked parent');
      symlinkSync(tmp.root, link, 'dir');
      spellings.push(['symlinked parent', join(link, 'Long Repository Name')]);
    }
    for (const [name, spelling] of spellings) {
      assert.equal(canonRoot(spelling, realRootProbe, p), want, name);
      assert.equal(endpointRoot(join(spelling, '.git'), realRootProbe, p), wantEndpoint, name);
      // A not-yet-existing file resolves through its nearest ancestor, and findRepo finds the same root from it.
      assert.equal(canonRoot(join(spelling, 'src', 'new dir', 'b.ts'), realRootProbe, p), `${want}/src/new dir/b.ts`, name);
      assert.deepEqual(findRepo(join(spelling, 'src', 'a.ts'), realRootProbe, p), { kind: 'dir', root: want, gitdir: `${want}/.git` }, name);
    }
    assert.ok(!want.includes('\\') && want === want.normalize('NFC'));
    if (p === 'win32') assert.match(want, /^[a-z]:\//);
  } finally {
    await tmp.cleanup();
  }
});
