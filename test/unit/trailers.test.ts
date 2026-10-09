import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage, parseMessage, SKIP_SUBJECT_PREFIX, type Trailer } from '../../src/git/trailers.js';

test('formatMessage and parseMessage round-trip; trailers come only from the last paragraph; a CR or LF inside a field throws', () => {
  const subject = `${SKIP_SUBJECT_PREFIX} board`;
  const trailers: Trailer[] = [
    { key: 'skip-checks', value: 'true' },
    { key: 'Cowork-Proto', value: '1' },
    { key: 'Cowork-Writer', value: 'p1a2b3/e1/7' },
    { key: 'Cowork-CS-Paths', value: 'c1 eJzLSM3JyVcozy/KSQEAGgsEXQ==' },
    { key: 'Cowork-Saved-Live', value: 'a: b  c ' },
  ];
  const buf = formatMessage(subject, trailers);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), `${subject}\n\n${trailers.map((t) => `${t.key}: ${t.value}`).join('\n')}\n`);
  assert.ok(!buf.includes(0x0d), 'LF only');
  assert.deepEqual(parseMessage(buf.toString('utf8')), { subject, trailers });
  // git's own output may add a second trailing newline; the parse is the same.
  assert.deepEqual(parseMessage(`${buf.toString('utf8')}\n`), { subject, trailers });

  // Subject only: no trailers, no blank line.
  assert.equal(formatMessage('cowork-merge', []).toString('utf8'), 'cowork-merge\n');
  assert.deepEqual(parseMessage('cowork-merge\n'), { subject: 'cowork-merge', trailers: [] });
  assert.deepEqual(parseMessage('cowork-merge'), { subject: 'cowork-merge', trailers: [] });

  // A Key: value line outside the last paragraph is not a trailer; a single paragraph is the subject.
  assert.deepEqual(
    parseMessage('subject\n\nCowork-Base: aaa\n\nbody text\nmore body\n'),
    { subject: 'subject', trailers: [] },
  );
  assert.deepEqual(
    parseMessage('subject\n\nbody\n\nCowork-Base: aaa\nCowork-Proto: 1\n'),
    { subject: 'subject', trailers: [{ key: 'Cowork-Base', value: 'aaa' }, { key: 'Cowork-Proto', value: '1' }] },
  );
  assert.deepEqual(parseMessage('Cowork-Base: aaa\n'), { subject: 'Cowork-Base: aaa', trailers: [] });
  // Non-trailer lines in the last paragraph are skipped, trailer lines kept.
  assert.deepEqual(
    parseMessage('subject\n\nCowork-Base: aaa\nfree text\nCowork-Proto: 1\n'),
    { subject: 'subject', trailers: [{ key: 'Cowork-Base', value: 'aaa' }, { key: 'Cowork-Proto', value: '1' }] },
  );

  // A CR or LF inside a field throws; so does a key that is not a token.
  assert.throws(() => formatMessage('a\nb', []), /subject/);
  assert.throws(() => formatMessage('a\rb', []), /subject/);
  assert.throws(() => formatMessage('s', [{ key: 'K', value: 'x\ny' }]), /value/);
  assert.throws(() => formatMessage('s', [{ key: 'K', value: 'x\ry' }]), /value/);
  assert.throws(() => formatMessage('s', [{ key: 'K\n', value: 'x' }]), /key/);
  assert.throws(() => formatMessage('s', [{ key: 'K: x', value: 'x' }]), /key/);
  assert.throws(() => formatMessage('s', [{ key: '', value: 'x' }]), /key/);
  assert.throws(() => formatMessage('s', [{ key: 'K', value: 'x\0y' }]), /value/);
});

test('SKIP_SUBJECT_PREFIX is the glossary §5 marker', () => {
  assert.equal(SKIP_SUBJECT_PREFIX, '[skip ci] ***NO_CI***');
});
