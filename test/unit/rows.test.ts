import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { BOM, conflictMarkerRows, form, hasRestoreMarkerRow, isBinaryBytes, rows, stripEnding } from '../../src/data/rows.js';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');
const strs = (rs: Buffer[]): string[] => rs.map((r) => r.toString('latin1'));

test('rows and form follow 03-data §2', () => {
  assert.deepEqual([...BOM], [0xef, 0xbb, 0xbf]);

  // Row k runs up to and including the k-th LF; a CR before the LF belongs to the row.
  assert.deepEqual(strs(rows(b('a\nb\r\nc\n'))), ['a\n', 'b\r\n', 'c\n']);
  // A non-empty unterminated last row is a row; an empty one is not.
  assert.deepEqual(strs(rows(b('a\nlast'))), ['a\n', 'last']);
  assert.deepEqual(strs(rows(b('a\n'))), ['a\n']);
  assert.deepEqual(rows(Buffer.alloc(0)), []);
  assert.deepEqual(strs(rows(b('\n\n'))), ['\n', '\n']);
  // The BOM belongs to row 1; a lone CR stays inside its row.
  const bomCrlf = Buffer.concat([BOM, b('x\r\ny\rz\r\n')]);
  const r = rows(bomCrlf);
  assert.equal(r.length, 2);
  assert.ok(r[0]!.equals(Buffer.concat([BOM, b('x\r\n')])));
  assert.equal(r[1]!.toString('latin1'), 'y\rz\r\n');
  assert.ok(Buffer.concat(r).equals(bomCrlf), 'rows concatenate back to the blob');
  // cp949 bytes with no 0x0A trail bytes keep their rows (0xB0A1 is one Hangul syllable).
  const cp949 = Buffer.from([0xb0, 0xa1, 0x0d, 0x0a, 0xc7, 0xd1]);
  assert.deepEqual(rows(cp949).map((x) => [...x]), [[0xb0, 0xa1, 0x0d, 0x0a], [0xc7, 0xd1]]);

  // stripEnding removes exactly one CRLF or LF.
  assert.equal(stripEnding(b('a\r\n')).toString('latin1'), 'a');
  assert.equal(stripEnding(b('a\n')).toString('latin1'), 'a');
  assert.equal(stripEnding(b('a\r\r\n')).toString('latin1'), 'a\r');
  assert.equal(stripEnding(b('a\r')).toString('latin1'), 'a\r');
  assert.equal(stripEnding(b('a')).toString('latin1'), 'a');

  // form: crlf = count of CR LF, lf = count of LF without a CR before it; lone CR ignored.
  assert.deepEqual(form(b('a\nb\n')), { bom: false, eol: 'LF' });
  assert.deepEqual(form(b('a\r\nb\r\n')), { bom: false, eol: 'CRLF' });
  assert.deepEqual(form(b('a\r\nb\n')), { bom: false, eol: 'MIXED' });
  assert.deepEqual(form(b('no terminator')), { bom: false, eol: 'NONE' });
  assert.deepEqual(form(Buffer.alloc(0)), { bom: false, eol: 'NONE' });
  assert.deepEqual(form(b('lone\rcr\r')), { bom: false, eol: 'NONE' });
  assert.deepEqual(form(b('a\rb\n')), { bom: false, eol: 'LF' });
  assert.deepEqual(form(Buffer.concat([BOM, b('x\r\ny\r\n')])), { bom: true, eol: 'CRLF' });
  assert.deepEqual(form(BOM), { bom: true, eol: 'NONE' });
  assert.deepEqual(form(Buffer.concat([BOM, b('x\n')])), { bom: true, eol: 'LF' });
  // A BOM that is not at offset 0 is not a BOM.
  assert.deepEqual(form(Buffer.concat([b('x\n'), BOM])), { bom: false, eol: 'LF' });
  assert.deepEqual(form(cp949), { bom: false, eol: 'CRLF' });
});

test('isBinaryBytes looks at the first 8,000 bytes only', () => {
  assert.equal(isBinaryBytes(Buffer.alloc(0)), false);
  assert.equal(isBinaryBytes(b('plain text\n')), false);
  assert.equal(isBinaryBytes(Buffer.from([0x41, 0x00, 0x42])), true);
  const at = (i: number, len: number): Buffer => {
    const buf = Buffer.alloc(len, 0x61);
    buf[i] = 0x00;
    return buf;
  };
  assert.equal(isBinaryBytes(at(0, 10)), true);
  assert.equal(isBinaryBytes(at(7_999, 8_000)), true, 'NUL at the last sniffed byte');
  assert.equal(isBinaryBytes(at(7_999, 20_000)), true);
  assert.equal(isBinaryBytes(at(8_000, 8_001)), false, 'NUL just past the sniff window');
  assert.equal(isBinaryBytes(at(15_000, 20_000)), false);
});

test('conflictMarkerRows strips one CR and matches exactly the four marker shapes; hasRestoreMarkerRow matches only cowork: labels', () => {
  const blob = b([
    'keep\n',
    '<<<<<<< ours\n',
    '||||||| base\r\n',
    '=======\r\n',
    '>>>>>>> theirs\n',
    '<<<<<<<< eight\n', // 8 '<': not a 7-wide marker
    '<<<<<<<nospace\n',
    '======= trailing\n', // '=' marker must end the row
    '========\n',
    '=======\r\r\n', // only one CR is stripped
    ' <<<<<<< indented\n',
    '>>>>>>> last-unterminated',
  ].join(''));
  assert.deepEqual([...conflictMarkerRows(blob)].sort(), [
    '<<<<<<< ours',
    '=======',
    '>>>>>>> last-unterminated',
    '>>>>>>> theirs',
    '||||||| base',
  ]);
  // LF and CRLF spellings of one marker give one key.
  assert.deepEqual([...conflictMarkerRows(b('=======\n=======\r\n'))], ['=======']);
  assert.equal(conflictMarkerRows(b('no markers\n')).size, 0);
  assert.equal(conflictMarkerRows(Buffer.alloc(0)).size, 0);
  // Keys are latin1, so non-UTF-8 label bytes survive as one key per byte.
  const latin = Buffer.concat([b('<<<<<<< '), Buffer.from([0xb0, 0xa1]), b('\n')]);
  assert.deepEqual([...conflictMarkerRows(latin)], [`<<<<<<< ${String.fromCharCode(0xb0, 0xa1)}`]);
  // A marker in row 1 of a BOM file is still found (the BOM is ignored for matching).
  assert.deepEqual([...conflictMarkerRows(Buffer.concat([BOM, b('<<<<<<< x\r\n')]))], ['<<<<<<< x']);

  assert.equal(hasRestoreMarkerRow(b('a\n<<<<<<< cowork:current\nb\n')), true);
  assert.equal(hasRestoreMarkerRow(b('a\n||||||| cowork:base\r\n')), true);
  assert.equal(hasRestoreMarkerRow(b('>>>>>>> cowork:yours 01HXYZ')), true);
  assert.equal(hasRestoreMarkerRow(Buffer.concat([BOM, b('<<<<<<< cowork:current\n')])), true);
  assert.equal(hasRestoreMarkerRow(b('<<<<<<< ours\n=======\n>>>>>>> theirs\n')), false);
  assert.equal(hasRestoreMarkerRow(b('======= cowork:x\n')), false, "'=' is not a restore marker shape");
  assert.equal(hasRestoreMarkerRow(b(' <<<<<<< cowork:current\n')), false, 'must start the row');
  assert.equal(hasRestoreMarkerRow(b('x <<<<<<< cowork:current\n')), false);
  assert.equal(hasRestoreMarkerRow(b('<<<<<<<< cowork:current\n')), false, '8 wide is not the restore marker');
  assert.equal(hasRestoreMarkerRow(Buffer.alloc(0)), false);
});
