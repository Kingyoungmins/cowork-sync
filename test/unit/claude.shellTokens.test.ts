// Plan 5 Task 1: the shell tokenizer of the advisory shell gate (CCI-28 tokenizer half; classify and writesFiles are Task 10's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, tokenize, writesFiles, type ShellSegment } from '../../src/claude/wire/shellTokens.js';

const seg = (argv: string[], o: Partial<ShellSegment> = {}): ShellSegment => ({ argv, redirects: [], cwd: null, gitC: null, ...o });

test('tokenize splits chains, strips cd and env prefixes, honours git -C and normalizes PowerShell aliases', () => {
  assert.deepEqual(tokenize('cd sub && FOO=1 git -C . commit -m x; rm a', 'Bash'), [
    seg(['git', 'commit', '-m', 'x'], { cwd: 'sub', gitC: '.' }),
    seg(['rm', 'a']),
  ]);
  assert.deepEqual(tokenize('echo x > a.txt | sort >> b.txt', 'Bash'), [
    seg(['echo', 'x'], { redirects: [{ op: '>', target: 'a.txt' }] }),
    seg(['sort'], { redirects: [{ op: '>>', target: 'b.txt' }] }),
  ]);
  assert.deepEqual(tokenize("sc .\\a.txt 'x'; ri .git\\cowork\\live", 'PowerShell'), [
    seg(['Set-Content', '.\\a.txt', 'x']),
    seg(['Remove-Item', '.git\\cowork\\live']),
  ]);
  // Quotes and escaped spaces keep one token.
  assert.deepEqual(tokenize('echo "a b" c\\ d \'e f\'', 'Bash'), [seg(['echo', 'a b', 'c d', 'e f'])]);
  assert.deepEqual(tokenize('Write-Output "a `"b`" c" \'it\'\'s\'', 'PowerShell'), [seg(['Write-Output', 'a "b" c', "it's"])]);
  // Newline-separated commands split; || and & split; empty segments vanish.
  assert.deepEqual(tokenize('git status\nrm -rf x\n\n', 'Bash'), [seg(['git', 'status']), seg(['rm', '-rf', 'x'])]);
  assert.deepEqual(tokenize('a || b & c;;', 'Bash'), [seg(['a']), seg(['b']), seg(['c'])]);
  // A cd chain applies to the && chain it starts and ends at the next ; or newline.
  assert.deepEqual(tokenize('cd a && cd b && x && y | z; w', 'Bash'), [
    seg(['x'], { cwd: 'a/b' }), seg(['y'], { cwd: 'a/b' }), seg(['z'], { cwd: 'a/b' }), seg(['w']),
  ]);
  assert.deepEqual(tokenize('cd /abs && x', 'Bash'), [seg(['x'], { cwd: '/abs' })]);
  // Several env prefixes, then the command; an assignment alone is no command.
  assert.deepEqual(tokenize('A=1 B="x y" npm test', 'Bash'), [seg(['npm', 'test'])]);
  assert.deepEqual(tokenize('A=1', 'Bash'), []);
  // Redirection forms: glued, fd-numbered, &> and >|; a descriptor duplication is no file; an input redirection is no write.
  assert.deepEqual(tokenize('cmd >out.txt 2>err.log &>all.log >|f 2>&1 <in.txt', 'Bash'), [
    seg(['cmd'], { redirects: [{ op: '>', target: 'out.txt' }, { op: '>', target: 'err.log' }, { op: '>', target: 'all.log' }, { op: '>', target: 'f' }] }),
  ]);
  assert.deepEqual(tokenize('echo "a > b" \'>\' > "my file.txt"', 'Bash'), [seg(['echo', 'a > b', '>'], { redirects: [{ op: '>', target: 'my file.txt' }] })]);
  // git -C composes; other global options stay.
  assert.deepEqual(tokenize('git -C a -C b -c core.x=1 status', 'Bash'), [seg(['git', '-c', 'core.x=1', 'status'], { gitC: 'a/b' })]);
  // PowerShell: cmdlet names in any case and the common aliases normalize; Bash keeps rm as rm.
  assert.deepEqual(tokenize('set-content a x; RI b; del c; gc d | out-file e', 'PowerShell'), [
    seg(['Set-Content', 'a', 'x']), seg(['Remove-Item', 'b']), seg(['Remove-Item', 'c']), seg(['Get-Content', 'd']), seg(['Out-File', 'e']),
  ]);
  assert.deepEqual(tokenize('cd sub; rm a', 'PowerShell'), [seg(['Remove-Item', 'a'])], 'cd ends at ; in PowerShell too');
  assert.deepEqual(tokenize('cd sub && rm a', 'PowerShell'), [seg(['Remove-Item', 'a'], { cwd: 'sub' })]);
  assert.deepEqual(tokenize('Get-Content a > b.txt', 'PowerShell'), [seg(['Get-Content', 'a'], { redirects: [{ op: '>', target: 'b.txt' }] })]);
  // Comments.
  assert.deepEqual(tokenize('echo a # rm b\nls', 'Bash'), [seg(['echo', 'a']), seg(['ls'])]);
  assert.deepEqual(tokenize('echo a#b', 'Bash'), [seg(['echo', 'a#b'])]);
  // Monitor commands tokenize like Bash.
  assert.deepEqual(tokenize('tail -f log > copy.txt', 'Monitor'), [seg(['tail', '-f', 'log'], { redirects: [{ op: '>', target: 'copy.txt' }] })]);
  assert.deepEqual(tokenize('', 'Bash'), []);
});

test('tokenize skips here-document bodies and reads a PowerShell here-string as one word', () => {
  const catTo = (target: string): ShellSegment => seg(['cat'], { redirects: [{ op: '>', target }] });
  // Review probe (a): a body line is file content, not a command (no SHELL_GIT deny for writing a script).
  assert.deepEqual(tokenize("cat > deploy.sh <<'EOF'\ngit checkout main\nEOF", 'Bash'), [catTo('deploy.sh')]);
  // Review probe (b): an apostrophe in the body opens no quote, so the command after the terminator is seen.
  assert.deepEqual(tokenize("cat > notes.txt <<'EOF'\nit's done\nEOF\ngit reset --hard", 'Bash'), [catTo('notes.txt'), seg(['git', 'reset', '--hard'])]);
  // Unquoted, double-quoted and backslash-quoted delimiters; the rest of the command line (a redirect, a pipe) stays the command's.
  assert.deepEqual(tokenize('cat <<EOF > out.txt\nrm -rf x\nEOF\nls', 'Bash'), [catTo('out.txt'), seg(['ls'])]);
  assert.deepEqual(tokenize('cat <<"END" | tee t.txt\ngit push\nEND\nls', 'Bash'), [seg(['cat']), seg(['tee', 't.txt']), seg(['ls'])]);
  assert.deepEqual(tokenize('cat << \\X\ngit push\nX\nls', 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize('cat 0<<EOF\ngit push\nEOF\nls', 'Bash'), [seg(['cat']), seg(['ls'])], 'a descriptor prefix');
  // <<- strips leading tabs from the terminator line; << does not, so there a tab-indented EOF is body.
  assert.deepEqual(tokenize('cat <<-EOF\n\tgit push\n\tEOF\nls', 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize("cat <<- 'EOF'\n\tx\n\t\tEOF\nls", 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize('cat <<EOF\n\tEOF\nls\nEOF\npwd', 'Bash'), [seg(['cat']), seg(['pwd'])]);
  // Two here-documents on one line are read in order; a CRLF terminator line ends one; an unterminated one runs to the end, as in Bash.
  assert.deepEqual(tokenize('cat <<A <<B\ngit push\nA\nrm x\nB\nls', 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize('cat <<EOF\r\ngit push\r\nEOF\r\nls', 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize('cat <<EOF\ngit push', 'Bash'), [seg(['cat'])]);
  // A comment after the delimiter word; a here-document in a chain; Monitor reads it as Bash does.
  assert.deepEqual(tokenize('cat <<EOF # note\ngit push\nEOF\nls', 'Bash'), [seg(['cat']), seg(['ls'])]);
  assert.deepEqual(tokenize('cd sub && cat <<EOF > a.txt && git add a.txt\nx\nEOF', 'Bash'), [
    seg(['cat'], { cwd: 'sub', redirects: [{ op: '>', target: 'a.txt' }] }), seg(['git', 'add', 'a.txt'], { cwd: 'sub' }),
  ]);
  assert.deepEqual(tokenize('cat <<EOF\ngit push\nEOF', 'Monitor'), [seg(['cat'])]);
  // A Bash here-string (<<<) is no here-document, and an arithmetic shift is neither: the next line is still a command.
  assert.deepEqual(tokenize('cat <<< "it\'s"\ngit push', 'Bash'), [seg(['cat']), seg(['git', 'push'])]);
  for (const cmd of ['echo $((1<<4))\ngit reset --hard', 'x=$(( 1 << 2 ))\ngit reset --hard', '(( y = 1<<3 ))\ngit reset --hard']) {
    const segs = tokenize(cmd, 'Bash');
    assert.deepEqual(segs[segs.length - 1], seg(['git', 'reset', '--hard']), JSON.stringify(cmd));
  }
  // PowerShell here-strings: @'…'@ and @"…"@ are one word that ends at a line starting '@ or "@; quotes inside are content.
  assert.deepEqual(tokenize("Set-Content a.txt @'\nit's done\ngit checkout main\n'@; git reset --hard", 'PowerShell'), [
    seg(['Set-Content', 'a.txt', "it's done\ngit checkout main"]), seg(['git', 'reset', '--hard']),
  ]);
  assert.deepEqual(tokenize('sc a.txt @"\nsay "hi" it\'s\n"@\ngit push', 'PowerShell'), [seg(['Set-Content', 'a.txt', 'say "hi" it\'s']), seg(['git', 'push'])]);
  assert.deepEqual(tokenize("sc a.txt @'  \r\nx\r\n'@\r\nls", 'PowerShell'), [seg(['Set-Content', 'a.txt', 'x']), seg(['Get-ChildItem'])], 'CRLF, blanks after the header');
  assert.deepEqual(tokenize("sc a.txt @'\n'@", 'PowerShell'), [seg(['Set-Content', 'a.txt', ''])], 'an empty here-string');
  assert.deepEqual(tokenize("sc a.txt @'\nx '@ y\n'@ | Out-File b.txt", 'PowerShell'), [seg(['Set-Content', 'a.txt', "x '@ y"]), seg(['Out-File', 'b.txt'])],
    "a '@ not at a line start is content");
  assert.deepEqual(tokenize("sc a.txt @'\nx\ngit push", 'PowerShell'), [seg(['Set-Content', 'a.txt', 'x\ngit push'])],
    'unterminated: PowerShell refuses to parse it, so nothing after it runs');
});

test('classify and writesFiles are declared for Task 10', () => {
  assert.throws(() => classify([], { gitdir: '/r/.git', root: '/r', dataDir: '/d', platform: 'linux' }), /Plan 5 Task 10/);
  assert.throws(() => writesFiles([]), /Plan 5 Task 10/);
});
