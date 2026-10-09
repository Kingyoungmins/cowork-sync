// Plan 8a Task 13: the page's text/event-stream parser (12 §3.10.5 "The page reads the stream with fetch and a ReadableStream
// reader, parsing text/event-stream itself"; R-V33): chunks split anywhere, every line ending, comments, multi-line data, ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, type SseEvent } from '../../../src/viz/ui/sse.js';

/** Every event the parser emits for `chunks` pushed in order, then end(). */
function parse(chunks: readonly string[]): SseEvent[] {
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

const STREAM = [
  ': a comment line\n',
  'id: 1\nevent: timeline\ndata: {"type":"timeline"}\n\n',
  ':\n',
  'id: 2\nevent: overlay\ndata: first line\ndata: second line\ndata:\n\n',
  'event: bye\ndata: {"type":"bye"}\n\n',
  'data:no space\nid: 3\n\n',
].join('');
const EXPECTED: SseEvent[] = [
  { id: '1', event: 'timeline', data: '{"type":"timeline"}' },
  { id: '2', event: 'overlay', data: 'first line\nsecond line\n' },
  { id: null, event: 'bye', data: '{"type":"bye"}' },
  { id: '3', event: 'message', data: 'no space' },
];

test('sse parser: chunks split anywhere, LF, CRLF and CR, comment lines, multi-line data, ids', () => {
  // One chunk, then every single split point, then one character per chunk.
  assert.deepEqual(parse([STREAM]), EXPECTED);
  for (let i = 0; i <= STREAM.length; i++) assert.deepEqual(parse([STREAM.slice(0, i), STREAM.slice(i)]), EXPECTED, `split at ${i}`);
  assert.deepEqual(parse([...STREAM]), EXPECTED);

  // The same stream with CRLF and with CR line endings, split at every point (a CR that ends a chunk waits for the next one).
  for (const eol of ['\r\n', '\r']) {
    const s = STREAM.replace(/\n/g, eol);
    assert.deepEqual(parse([s]), EXPECTED, JSON.stringify(eol));
    for (let i = 0; i <= s.length; i++) assert.deepEqual(parse([s.slice(0, i), s.slice(i)]), EXPECTED, `${JSON.stringify(eol)} split at ${i}`);
  }
  // Mixed endings in one stream: a CR then an LF in the next chunk is one line break, never an empty line in between.
  assert.deepEqual(parse(['id: 7\r', '\nevent: a\rdata: x\r\n', '\r', '\n']), [{ id: '7', event: 'a', data: 'x' }]);

  // A block with no data dispatches nothing (an id alone, an event alone, comments alone).
  assert.deepEqual(parse(['id: 9\n\n', 'event: x\n\n', ': keep-alive\n\n']), []);
  // A partial event at the end of the stream is discarded; a leading byte-order mark is dropped once.
  assert.deepEqual(parse(['data: done\n\n', 'data: half']), [{ id: null, event: 'message', data: 'done' }]);
  assert.deepEqual(parse(['\u{FEFF}data: x\n\n']), [{ id: null, event: 'message', data: 'x' }]);
  // Only one leading space of a value is removed; a field without a colon is a field with an empty value; unknown fields
  // and retry are ignored; an id containing NUL is ignored.
  assert.deepEqual(parse(['data:  two spaces\nretry: 10\nfoo: bar\n\n']), [{ id: null, event: 'message', data: ' two spaces' }]);
  assert.deepEqual(parse(['data\ndata\n\n']), [{ id: null, event: 'message', data: '\n' }]);
  assert.deepEqual(parse([`id: 1${String.fromCharCode(0)}2\ndata: z\n\n`]), [{ id: null, event: 'message', data: 'z' }]);
  // The event name resets after each dispatch; a later id in the same block wins.
  assert.deepEqual(parse(['event: a\ndata: 1\n\ndata: 2\nid: 4\nid: 5\n\n']), [
    { id: null, event: 'a', data: '1' },
    { id: '5', event: 'message', data: '2' },
  ]);
  // Nothing after end() is parsed.
  const out: SseEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  p.end();
  p.push('data: late\n\n');
  assert.deepEqual(out, []);
});
