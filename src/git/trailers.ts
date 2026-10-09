// Commit subject and trailer formatting and parsing (glossary §5, ENG-12).
export interface Trailer { key: string; value: string; }

/** Subject prefix of live code and board commits (glossary §5). */
export const SKIP_SUBJECT_PREFIX = '[skip ci] ***NO_CI***';

const KEY_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):(?: (.*))?$/;

function checkField(what: string, s: string): void {
  if (/[\r\n\0]/.test(s)) throw new Error(`formatMessage: CR, LF or NUL inside ${what}`);
}

/** `subject`, a blank line, then one `Key: value` line per trailer; LF only. A CR or LF inside a field throws. */
export function formatMessage(subject: string, trailers: readonly Trailer[]): Buffer {
  checkField('subject', subject);
  const lines: string[] = [subject];
  if (trailers.length > 0) {
    lines.push('');
    for (const t of trailers) {
      checkField('key', t.key);
      checkField('value', t.value);
      if (!KEY_RE.test(t.key)) throw new Error(`formatMessage: invalid trailer key ${JSON.stringify(t.key)}`);
      lines.push(`${t.key}: ${t.value}`);
    }
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Subject = the first line; trailers = the `Key: value` lines of the last paragraph (never the subject's own paragraph). */
export function parseMessage(raw: string): { subject: string; trailers: Trailer[] } {
  const lines = raw.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const subject = lines[0] ?? '';
  let start = lines.length;
  while (start > 0 && lines[start - 1] !== '') start--;
  const trailers: Trailer[] = [];
  if (start > 0) {
    for (const line of lines.slice(start)) {
      const m = TRAILER_LINE.exec(line);
      if (m !== null) trailers.push({ key: m[1] as string, value: m[2] ?? '' });
    }
  }
  return { subject, trailers };
}
