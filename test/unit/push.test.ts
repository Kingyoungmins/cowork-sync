import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT, OidError, parseOid, type Oid, type OidOrAbsent } from '../../src/git/oid.js';
import { buildPushArgv, parsePorcelain, pushSpec, type PushSpec } from '../../src/git/push.js';

const B = parseOid('b'.repeat(40));
const C = parseOid('c'.repeat(40));
const T = parseOid('a'.repeat(40));
const BOARD = 'refs/cowork/main/board';
const CODE = 'refs/cowork/main/code';
const URL = 'file:///srv/remote.git';

test("pushSpec refuses an empty or invalid oid, a ref without refs/, a '+' and a ':'", () => {
  assert.deepEqual(pushSpec(B, BOARD, T), { ref: BOARD, newOid: B, lease: T });
  assert.deepEqual(pushSpec(B, BOARD, ABSENT), { ref: BOARD, newOid: B, lease: ABSENT });
  assert.ok(Object.isFrozen(pushSpec(B, BOARD, T)));
  // 01-engine test 3 (push part) and mutant M34's shape: an empty oid would make `:<ref>`, a deletion.
  for (const bad of ['', 'abc', 'B'.repeat(40), `${'b'.repeat(40)} `, 'b'.repeat(39), 'g'.repeat(40), ABSENT]) {
    assert.throws(() => pushSpec(bad as Oid, BOARD, T), OidError, JSON.stringify(bad));
  }
  for (const badLease of ['', 'xyz', 'A'.repeat(40), 'absent']) {
    assert.throws(() => pushSpec(B, BOARD, badLease as OidOrAbsent), OidError, JSON.stringify(badLease));
  }
  for (const ref of ['heads/main', 'board', '', 'refs/', '+refs/cowork/main/board', 'refs/cowork/+main/board', ':refs/cowork/main/board',
    'refs/cowork/main:board', 'refs/cowork/main/board:refs/x', 'refs/cowork/ma in/board', 'refs/cowork/../board', 'refs/cowork/main/board/',
    'refs/cowork/*/board', 'refs/cowork/main/board.lock', 'refs/cowork/main//board', `refs/cowork/main/board${String.fromCharCode(10)}`]) {
    assert.throws(() => pushSpec(B, ref, T), /pushSpec/, JSON.stringify(ref));
  }
});

test("buildPushArgv never contains --atomic, --force or a '+' refspec and renders an ABSENT lease as an empty expect", () => {
  const specs = [pushSpec(B, BOARD, T), pushSpec(C, CODE, ABSENT)];
  assert.deepEqual(buildPushArgv(URL, specs, []), [
    'push', '--porcelain', '--no-verify',
    `--force-with-lease=${BOARD}:${T}`, `--force-with-lease=${CODE}:`,
    URL, `${B}:${BOARD}`, `${C}:${CODE}`,
  ]);
  assert.deepEqual(buildPushArgv(URL, [pushSpec(B, BOARD, T)], ['ci.skip']), [
    'push', '--porcelain', '--no-verify', '-o', 'ci.skip', `--force-with-lease=${BOARD}:${T}`, URL, `${B}:${BOARD}`,
  ]);
  const shapes: Array<{ specs: PushSpec[]; opts: string[] }> = [
    { specs, opts: [] },
    { specs: [pushSpec(B, BOARD, ABSENT)], opts: ['ci.skip', 'x=y'] },
    { specs: [pushSpec(C, 'refs/cowork-ci/run-1/main/code', T), pushSpec(B, 'refs/cowork-ci/run-1/main/board', B)], opts: [] },
  ];
  for (const s of shapes) {
    const argv = buildPushArgv(URL, s.specs, s.opts);
    assert.ok(!argv.includes('--atomic'), 'no --atomic (glossary §26.2 item 1)');
    assert.ok(!argv.includes('--force') && !argv.includes('-f'), 'no --force');
    assert.ok(!argv.some((a) => a.startsWith('+')), "no '+' refspec");
    assert.ok(!argv.some((a) => a.startsWith(':')), 'no deletion refspec');
    assert.equal(argv.filter((a) => a.startsWith('--force-with-lease=')).length, s.specs.length, 'one lease per ref');
  }
  // A spec that did not come from pushSpec is re-validated, and the argv shape is refused before any git call.
  const forged = { ref: '+refs/cowork/main/board', newOid: B, lease: T } as PushSpec;
  assert.throws(() => buildPushArgv(URL, [forged], []), /pushSpec/);
  assert.throws(() => buildPushArgv(URL, [{ ref: BOARD, newOid: '' as Oid, lease: T }], []), OidError);
  assert.throws(() => buildPushArgv(URL, [], []), /no refspec/);
  assert.throws(() => buildPushArgv(URL, [pushSpec(B, BOARD, T), pushSpec(C, BOARD, T)], []), /twice/);
  assert.throws(() => buildPushArgv('--upload-pack=evil', specs, []), /url/);
  assert.throws(() => buildPushArgv('', specs, []), /url/);
  assert.throws(() => buildPushArgv(`${URL}${String.fromCharCode(10)}x`, specs, []), /url/);
  assert.throws(() => buildPushArgv(URL, specs, ['a\nb']), /push option/);
  assert.throws(() => buildPushArgv(URL, specs, ['']), /push option/);
});

test("parsePorcelain maps '!', ' ', '*', '+', '=' and a missing line", () => {
  const lines = [
    `To ${URL}`,
    `!\t${B}:refs/a\t[rejected] (stale info)`,
    ` \t${B}:refs/b\t${'1'.repeat(7)}..${'2'.repeat(7)}`,
    `*\t${B}:refs/c\t[new reference]`,
    `+\t${B}:refs/d\t${'1'.repeat(7)}...${'2'.repeat(7)} (forced update)`,
    `=\t${B}:refs/e\t[up to date]`,
    `!\t${B}:refs/g\t[remote rejected] (pre-receive hook declined)`,
    `-\t:refs/h\t[deleted]`,
    `*\t${B}:refs/not-asked\t[new reference]`,
    'Done',
    '',
  ];
  const refs = ['refs/a', 'refs/b', 'refs/c', 'refs/d', 'refs/e', 'refs/f', 'refs/g', 'refs/h'];
  const expected = new Map([
    ['refs/a', 'rejected'], ['refs/b', 'ok'], ['refs/c', 'ok'], ['refs/d', 'ok'], ['refs/e', 'ok'],
    ['refs/f', 'none'], ['refs/g', 'rejected'], ['refs/h', 'ok'],
  ]);
  assert.deepEqual(parsePorcelain(Buffer.from(lines.join('\n'), 'utf8'), refs), expected);
  // CRLF endings, a transport failure with no porcelain at all, and an empty ref list.
  assert.deepEqual(parsePorcelain(Buffer.from(lines.join('\r\n'), 'utf8'), refs), expected);
  assert.deepEqual(parsePorcelain(Buffer.alloc(0), [BOARD, CODE]), new Map([[BOARD, 'none'], [CODE, 'none']]));
  assert.deepEqual(parsePorcelain(Buffer.from(lines.join('\n'), 'utf8'), []), new Map());
  // A summary or a from-side that mentions another ref never names the ref (the destination is after the last ':').
  const tricky = Buffer.from(`!\t${B}:${CODE}\t[rejected] (${BOARD} moved)\n`, 'utf8');
  assert.deepEqual(parsePorcelain(tricky, [BOARD, CODE]), new Map([[BOARD, 'none'], [CODE, 'rejected']]));
  // An unknown flag with a per-ref line is a status other than ok (a rejection, PRO-54 (c)), never 'none'.
  assert.deepEqual(parsePorcelain(Buffer.from(`?\t${B}:${BOARD}\t[odd]\n`, 'utf8'), [BOARD]), new Map([[BOARD, 'rejected']]));
});
