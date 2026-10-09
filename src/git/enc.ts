import { Buffer } from 'node:buffer';

/** Glossary §4: the encoded branch name may be at most this many bytes. */
export const ENC_MAX_BYTES = 150;

/** Thrown when enc(b) would exceed ENC_MAX_BYTES; v1 refuses such a branch. */
export class EncTooLongError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'EncTooLongError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === 0x5f || // _
    b === 0x2d // -
  );
}

/**
 * Glossary §4: percent-encode every UTF-8 byte of the branch name outside [A-Za-z0-9_-]
 * as %XX (uppercase hex). The result is ASCII, so its length is its byte length.
 */
export function enc(branch: string): string {
  if (branch.length === 0) {
    throw new Error('enc: the branch name is empty');
  }
  if (LONE_SURROGATE.test(branch)) {
    throw new Error('enc: the branch name contains a lone UTF-16 surrogate');
  }
  let out = '';
  for (const b of Buffer.from(branch, 'utf8')) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    if (out.length > ENC_MAX_BYTES) {
      throw new EncTooLongError(`enc: the encoded branch name exceeds ${ENC_MAX_BYTES} bytes`);
    }
  }
  return out;
}
