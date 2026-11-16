// src/claude/wire/ndjson.ts — newline-delimited JSON frames, ≤ 1 MiB each (SEC-22), and the wire tier's canonical JSON line (A1-3).
// The client tier may not reach Plan 2's src/board/canonicalJson.ts (L-HOOK-THIN), so this is its own writer, byte-equal to Plan 2's
// canonicalBytes on every value both accept (parity test, X5-45) and the encoding the evidence tag signs (evidenceTag).
import { C } from './constants.js';
import type { WireJson } from './frames.js';

export class FrameTooLarge extends Error {}

/** The deepest nesting written: Plan 2's MAX_JSON_DEPTH (a scalar is depth 0, a container 1 + its deepest member). The wire tier's one copy:
 *  schema.ts bounds its WireJson fields with it, and the parity test pins it equal to Plan 2's. */
export const MAX_DEPTH = 64;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(v: unknown, out: string[], open: Set<object>, depth: number): void {
  if (v === null) { out.push('null'); return; }
  switch (typeof v) {
    case 'boolean': out.push(v ? 'true' : 'false'); return;
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJsonLine: non-finite number ${String(v)}`);
      out.push(JSON.stringify(v));   // ES Number::toString; -0 is written 0
      return;
    case 'string': out.push(JSON.stringify(v)); return;
    case 'object': break;
    default: throw new TypeError(`canonicalJsonLine: ${typeof v} is not JSON`);
  }
  const o = v as object;
  if (depth > MAX_DEPTH) throw new TypeError(`canonicalJsonLine: nesting deeper than ${MAX_DEPTH}`);
  if (open.has(o)) throw new TypeError('canonicalJsonLine: cyclic value');
  open.add(o);
  if (Array.isArray(o)) {
    const arr = o as unknown[];
    out.push('[');
    for (let i = 0; i < arr.length; i++) {
      if (!(i in arr)) throw new TypeError(`canonicalJsonLine: sparse array hole at index ${i}`);
      if (i > 0) out.push(',');
      write(arr[i], out, open, depth + 1);
    }
    out.push(']');
  } else {
    if (!isPlainObject(o)) throw new TypeError('canonicalJsonLine: not a plain object');
    const rec = o as Record<string, unknown>;
    // An undefined member is omitted (as Plan 2's canonicalJson and JSON.stringify do); sort() orders by UTF-16 code units.
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      if (i > 0) out.push(',');
      out.push(JSON.stringify(k), ':');
      write(rec[k], out, open, depth + 1);
    }
    out.push('}');
  }
  open.delete(o);
}

/** A1-3: object keys sorted by UTF-16 code unit at every depth, no insignificant whitespace, strings escaped as JSON.stringify does, -0 written 0,
 *  non-finite numbers and undefined (top level or array element) throw TypeError; an undefined object member is omitted. */
export function canonicalJsonLine(v: WireJson): string {
  const out: string[] = [];
  write(v, out, new Set(), 1);
  return out.join('');
}

/** = Buffer.from(canonicalJsonLine(f) + '\n', 'utf8') (A1-3). */
export function encodeFrame(f: object): Buffer {
  return Buffer.from(canonicalJsonLine(f as WireJson) + '\n', 'utf8');
}

/** Newline-delimited JSON, ≤ 1 MiB per frame (SEC-22): push() returns the complete lines (UTF-8 decoded, without the '\n') and throws
 *  FrameTooLarge as soon as a line, finished or not, holds more than C.FRAME_MAX_BYTES bytes. Bytes are kept until their line is complete,
 *  so a chunk boundary inside a multibyte sequence is harmless. */
export class LineReader {
  private parts: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(0x0a, start); nl >= 0; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl);
      this.check(piece.length);
      lines.push((this.size === 0 ? piece : Buffer.concat([...this.parts, piece], this.size + piece.length)).toString('utf8'));
      this.parts = [];
      this.size = 0;
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    this.check(rest.length);
    if (rest.length > 0) {
      this.parts.push(Buffer.from(rest));   // a copy: the caller may reuse its chunk
      this.size += rest.length;
    }
    return lines;
  }

  private check(more: number): void {
    if (this.size + more > C.FRAME_MAX_BYTES) throw new FrameTooLarge(`frame over ${C.FRAME_MAX_BYTES} bytes`);
  }
}
