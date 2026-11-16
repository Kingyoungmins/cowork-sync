// The executed form of one merge-file call (ruling G1-FILEFORM, audit #1 #2): runMergeFile runs the callers' `merge-file -p --object-id
// … <cur> <base> <other>` as `merge-file -p … -L l1 -L l2 -L l3 <dir>/0.<cur> <dir>/1.<base> <dir>/2.<other>` over the objects' stored
// bytes, so a test that reads a recorded call finds the three side oids in the scratch file names.
import { basename } from 'node:path';

/** The three side oids (current, base, other) of one executed merge-file call, in order. */
export function mergeSides(args: readonly string[]): string[] {
  return args.slice(-3).map((f) => {
    const name = basename(f.replace(/\\/g, '/'));
    if (!/^[012]\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) throw new Error(`mergeSides: not a runMergeFile scratch file ${JSON.stringify(f)}`);
    return name.slice(2);
  });
}

/** The three -L labels of one executed merge-file call (runMergeFile always passes three). */
export function mergeLabels(args: readonly string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === '-L' ? [a] : []));
}
