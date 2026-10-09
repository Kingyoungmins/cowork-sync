// RFC 8785 (JSON Canonicalization Scheme) serializer: the byte form of ops.jsonl lines, protocol.json and
// checkpoint/state.json, identical on every OS and Node version.
//
// Members sorted by the UTF-16 code units of their names, no whitespace, numbers in the ECMAScript
// Number-to-String form, strings escaped only where JSON requires it (" \ and controls below U+0020,
// with the short forms \b \f \n \r \t and lowercase \u00XX otherwise). Out of the I-JSON domain RFC 8785
// assumes: a lone surrogate is written as a lowercase \uXXXX escape (as JSON.stringify does), so the output
// is always valid UTF-8; a non-finite number and any value outside the Json type throw; an object member
// whose value is undefined is omitted (as JSON.stringify does), so optional TypeScript fields need no care;
// a sparse-array hole throws (JSON.parse never makes one); nesting past MAX_JSON_DEPTH throws.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * The deepest nesting canonicalJson writes and parseOpLine accepts (controller ruling P2-DEPTH). A scalar is
 * depth 0 and an array or object is 1 + its deepest member, so an op object holding a 63-deep array is at the
 * cap. A structural bound, so the result never depends on the native stack (JIT state, caller depth, OS).
 */
export const MAX_JSON_DEPTH = 64;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `depth` is the depth v has if it is a container; recursion is bounded by MAX_JSON_DEPTH frames. */
function write(v: unknown, out: string[], open: Set<object>, depth: number): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(v)) throw new RangeError(`canonicalJson: non-finite number ${String(v)}`);
      // ES Number::toString, which RFC 8785 §3.2.2.3 adopts; -0 is written as 0.
      out.push(JSON.stringify(v));
      return;
    case 'string':
      out.push(JSON.stringify(v));
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof v} is not JSON`);
  }
  const o = v as object;
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`canonicalJson: nesting deeper than ${MAX_JSON_DEPTH}`);
  if (open.has(o)) throw new TypeError('canonicalJson: cyclic value');
  open.add(o);
  if (Array.isArray(o)) {
    const arr = o as unknown[];
    out.push('[');
    for (let i = 0; i < arr.length; i++) {
      // forEach skips holes, which wrote "[,1]" or silently dropped the element.
      if (!(i in arr)) throw new TypeError(`canonicalJson: sparse array hole at index ${i}`);
      if (i > 0) out.push(',');
      write(arr[i], out, open, depth + 1);
    }
    out.push(']');
  } else {
    if (!isPlainObject(o)) throw new TypeError(`canonicalJson: ${o.constructor?.name ?? 'object'} is not a plain object`);
    const rec = o as Record<string, unknown>;
    // Array.prototype.sort without a comparator orders strings by UTF-16 code units (RFC 8785 §3.2.3).
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (i > 0) out.push(',');
      out.push(JSON.stringify(k), ':');
      write(rec[k], out, open, depth + 1);
    }
    out.push('}');
  }
  open.delete(o);
}

export function canonicalJson(v: Json): string {
  const out: string[] = [];
  write(v, out, new Set(), 1);
  return out.join('');
}

/** canonicalJson as UTF-8, no BOM. */
export function canonicalBytes(v: Json): Buffer {
  return Buffer.from(canonicalJson(v), 'utf8');
}
