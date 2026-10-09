// The refname table of checkRefName (src/git/repo.ts; netcall.ts re-exports it, and GitRepo's readRef, casRef and
// deleteLocalRef call it: test/unit/repo.refname.test.ts). Every row's verdict is git's own: measured with
// `git check-ref-format <ref>` on git 2.55 (rc 0 valid, rc 1 invalid), and re-checked against the installed git by the
// integration test "checkRefName agrees with git check-ref-format on every row of its table", so it cannot drift.

/** [ref, valid by git check-ref-format] */
export const REF_NAME_TABLE: ReadonlyArray<readonly [string, boolean]> = [
  // Plain names, and characters git allows.
  ['refs/heads/main', true],
  ['refs/heads/feat+x', true],
  ['refs/heads/a./b', true],                 // an inner component may END with '.'; only the whole name may not
  ['refs/heads/a.lockx', true],
  ['refs/heads/x.loc', true],
  ['refs/heads/a@b', true],
  ['refs/heads/@', true],
  ['refs/@', true],
  ['refs/heads/-x', true],
  ['refs/heads/a.b/c.d', true],
  ['refs/heads/café', true],
  // A component starting with '.' (git check-ref-format rule 1).
  ['refs/heads/.a', false],
  ['refs/heads/a/.b', false],
  ['refs/.heads/a', false],
  ['refs/heads/a/.', false],
  ['refs/heads/a/..', false],
  ['refs/heads/.lock', false],
  // A component ending with '.lock', anywhere in the path (rule 1).
  ['refs/heads/a.lock', false],
  ['refs/heads/a.lock/b', false],
  ['refs/a.lock/heads/b', false],
  // The name ending with '.' (rule 7).
  ['refs/heads/a.', false],
  ['refs/heads/a/b.', false],
  // The rules checkRefName already had.
  ['refs/heads/x..y', false],
  ['refs/heads/sp ace', false],
  ['refs/heads/a:b', false],
  ['refs/heads/a~1', false],
  ['refs/heads/a^b', false],
  ['refs/heads/a?b', false],
  ['refs/heads/*', false],
  ['refs/heads/a[b', false],
  ['refs/heads/a\\b', false],
  ['refs/heads/x@{1}', false],
  ['refs/heads//x', false],
  ['refs/heads/x/', false],
  ['refs/heads/a\tb', false],
  ['refs/heads/a\u007fb', false],
  ['refs/', false],
];
