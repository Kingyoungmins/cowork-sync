// cs/<enc(b)>.reverts.jsonl (Plan 3 Task 17; glossary §6, §20 "Revert", §29.3; 05-holds Algorithm REV step 8, §8 Q18): one
// canonical JSON line {cs, of, t_local_ms, written} per confirmed revert plus one per clean-rebase move of the mark, fsynced
// before the caller's next state update, a torn last line dropped, lines older than 14 days of local time pruned at the next
// append. FaultFs over the real disk of a temp root (spaces and non-ASCII) and a virtual clock; nothing is pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalBytes } from '../../src/board/canonicalJson.js';
import { ABSENT, type Oid } from '../../src/git/oid.js';
import { RevertsJournal, type RevertLine } from '../../src/holds/revertCs.js';
import { realFs } from '../../src/ports/fs.js';
import { FaultFs } from '../sim/faultfs.js';
import { VirtualClock } from '../sim/vclock.js';
import { makeTempRoot } from '../helpers/tmp.js';

const DAY = 86_400_000;
const PEER = 'a'.repeat(32);
const OF = `${PEER}/human/4`;
const CS = `${PEER}/human/9`;
const X = '1'.repeat(40) as Oid;
const Y = '2'.repeat(40) as Oid;

async function withJournal(fn: (j: RevertsJournal, file: string, fs: FaultFs, clock: VirtualClock) => Promise<void>): Promise<void> {
  const { root, cleanup } = await makeTempRoot('reverts journal');
  try {
    const file = join(root, 'cowork', 'cs', 'main.reverts.jsonl');
    const fs = new FaultFs(realFs);
    const clock = new VirtualClock({ wallOffsetMs: 1_000_000_000, startMono: 1_000 });
    await fn(new RevertsJournal(fs, file, clock), file, fs, clock);
  } finally {
    await cleanup();
  }
}

test('append writes one canonical JSON line and resolves only after fsync; lines() drops a torn last line; lines older than 14 days of local time are pruned at the next append', async () => {
  await withJournal(async (j, file, fs, clock) => {
    assert.deepEqual(await j.lines(), [], 'a missing file holds no line');
    const t0 = Math.floor(clock.wallMs());
    const first: RevertLine = { cs: CS, of: OF, t_local_ms: t0, written: { 'src/n.ts': ABSENT, 'src/a.ts': X } };
    // The fsynced write (writeFileExclusive: open, write, fsync, close) completes before the rename that publishes it, and the
    // append has not resolved when that rename starts.
    let resolved = false;
    let atRename: string[] | null = null;
    fs.interpose('rename', 'reverts.jsonl', async () => {
      atRename = [...fs.calls];
      assert.equal(resolved, false, 'append resolves only after its fsynced write is in place');
    });
    await j.append(first).then(() => {
      resolved = true;
    });
    assert.ok(atRename !== null, 'the line is published by a rename');
    const seq = (atRename as string[]).filter((c) => c.includes('reverts.jsonl'));
    assert.ok(seq.some((c) => c.startsWith('writeFileExclusive ') && c.endsWith('.tmp')), `an fsynced temp write first: ${JSON.stringify(seq)}`);
    const bytes = await readFile(file);
    assert.equal(bytes.toString('utf8'), `${canonicalBytes({ cs: CS, of: OF, t_local_ms: t0, written: { 'src/a.ts': X, 'src/n.ts': ABSENT } }).toString('utf8')}\n`,
      'one canonical JSON line (members sorted, no whitespace), LF');
    assert.deepEqual(await j.lines(), [first]);

    // A torn last line (a crash inside a non-atomic writer) is dropped; the complete lines before it stay.
    await appendFile(file, '{"cs":"');
    assert.deepEqual(await j.lines(), [first], 'the torn tail is not a line');
    // A second append keeps the complete lines and replaces the torn tail.
    clock.advance(DAY);
    const second: RevertLine = { cs: `${PEER}/human/10`, of: OF, t_local_ms: Math.floor(clock.wallMs()), written: { 'src/b.ts': Y } };
    await j.append(second);
    assert.deepEqual(await j.lines(), [first, second]);
    assert.equal((await readFile(file, 'utf8')).split('\n').length, 3, 'two LF-terminated lines, no torn tail');

    // 14 days of local time after the first line, the next append prunes it (the second, 13 days old, stays).
    clock.advance(13 * DAY + 1);
    const third: RevertLine = { cs: `${PEER}/human/11`, of: OF, t_local_ms: Math.floor(clock.wallMs()), written: { 'src/c.ts': X } };
    assert.deepEqual(await j.lines(), [first, second], 'nothing is pruned before an append');
    await j.append(third);
    assert.deepEqual(await j.lines(), [second, third], 'the line older than 14 days left at this append');

    // A line that is no revert line (a hand edit) is skipped, never a crash; an invalid line is refused before any write.
    await writeFile(file, `${(await readFile(file, 'utf8'))}{"cs":"x"}\n`);
    assert.deepEqual(await j.lines(), [second, third]);
    await assert.rejects(j.append({ cs: 'not a cs id', of: OF, t_local_ms: 1, written: {} }), TypeError);
  });
});

test('ofCs returns the of value every line of a cs carries, and a rebase line repeats of and t_local_ms with the whole current written map', async () => {
  await withJournal(async (j, file, _fs, clock) => {
    await mkdir(dirname(file), { recursive: true });
    const t0 = Math.floor(clock.wallMs()) - 5;
    await j.append({ cs: CS, of: OF, t_local_ms: t0, written: { 'src/a.ts': X, 'src/b.ts': Y } });
    await j.append({ cs: `${PEER}/human/12`, of: `${PEER}/human/3`, t_local_ms: t0 + 5, written: { 'src/z.ts': X } });
    assert.equal(await j.ofCs(CS), OF);
    assert.equal(await j.ofCs(`${PEER}/human/12`), `${PEER}/human/3`);
    assert.equal(await j.ofCs(`${PEER}/human/99`), null, 'no line: no "revert of" label');
    // The mark of src/a.ts moved (a clean HLD-41 rebase): the line carries every path of the current map, src/b.ts's oid included.
    const Z = '3'.repeat(40) as Oid;
    assert.equal(await j.appendMove(CS, new Map<string, Oid | 'ABSENT'>([['src/a.ts', Z], ['src/b.ts', Y]])), true);
    const lines = await j.byCs(CS);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1], { cs: CS, of: OF, t_local_ms: t0, written: { 'src/a.ts': Z, 'src/b.ts': Y } }, 'of and t_local_ms repeat the original line');
    assert.equal(await j.ofCs(CS), OF, 'the label is unchanged by the extra line');
    assert.equal(await j.appendMove(`${PEER}/human/99`, new Map([['x', X]])), false, 'no original line: nothing to repeat, nothing appended');
    assert.equal((await j.lines()).length, 3);
  });
});
