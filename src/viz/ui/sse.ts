// The page's text/event-stream parser (12 §3.10.5: the page reads the stream with fetch and a ReadableStream reader and parses
// text/event-stream itself, because EventSource cannot send the session header). The WHATWG event-stream interpretation:
// lines end in CRLF, LF or CR (a CR that ends a chunk waits for the next one); a line starting with ':' is a comment; `data`
// lines join with LF; a blank line dispatches. Pure and DOM-free (R-V33): bundled into the page, unit-tested under Node.

export interface SseEvent { id: string | null; event: string; data: string; }

const NUL = String.fromCharCode(0);
const BOM = '\u{FEFF}';

/**
 * `on` receives each dispatched event: `id` is the id field given in that event's block (null when the block has none; an id
 * containing NUL is ignored), `event` its event field or 'message', `data` its data lines joined by LF. A block without data
 * dispatches nothing; `end()` discards a partial block, and nothing pushed after it is parsed.
 */
export function createSseParser(on: (e: SseEvent) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  let crPending = false;               // the previous chunk ended in CR: an LF at the start of this one belongs to it
  let first = true;                    // a leading byte-order mark is dropped once
  let ended = false;
  let data: string[] = [];
  let event = '';
  let id: string | null = null;

  const dispatch = (): void => {
    if (data.length > 0) on({ id, event: event === '' ? 'message' : event, data: data.join('\n') });
    data = [];
    event = '';
    id = null;
  };
  const line = (l: string): void => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes(NUL)) id = value;
    // retry and every other field: ignored
  };

  return {
    push(chunk: string): void {
      if (ended || chunk === '') return;
      let c = chunk;
      if (first) {
        first = false;
        if (c.startsWith(BOM)) c = c.slice(BOM.length);
      }
      if (crPending && c.startsWith('\n')) c = c.slice(1);
      crPending = false;
      buf += c;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch !== '\n' && ch !== '\r') continue;
        line(buf.slice(start, i));
        if (ch === '\r') {
          if (i + 1 === buf.length) crPending = true;
          else if (buf[i + 1] === '\n') i++;
        }
        start = i + 1;
      }
      buf = buf.slice(start);
    },
    end(): void {
      ended = true;
      buf = '';
      data = [];
    },
  };
}
