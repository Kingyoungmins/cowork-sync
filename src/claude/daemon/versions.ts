// Task 5 phase 1 — VersionPolicy (CCI-52, R2-I3). Semver with prerelease ordering; "previous" = own hookProto − 1.
// 'serve_then_drain' makes the server call ClaudeDaemon.close('version') (→ Engine.drain(null), listener closed) right
// after that reply is written; a newer hello triggers the same (Phase 3's composition). judge never throws (R-F2-14).

/** Pure semver compare: numeric dot parts, then a prerelease orders before the same version without one and two
 *  prerelease identifiers compare per semver §11 (numeric numerically, alphanumeric lexically, fewer fields lower). */
export function semverCompare(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string[] | null } => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (m === null) throw new TypeError(`semverCompare: ${JSON.stringify(v)} is not a semver`);
    const core = [Number(m[1]), Number(m[2]), Number(m[3])];
    const pre = m[4] === undefined ? null : m[4].split('.');
    return { core, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;           // 1.0.0 > 1.0.0-rc.1
  if (pb.pre === null) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;        // fewer fields is lower
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;                  // numeric identifiers always have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export class VersionPolicy {
  private readonly ownVersion: string;
  private readonly ownProto: number;

  constructor(own: { pluginVersion: string; hookProto: number }) {
    this.ownVersion = own.pluginVersion;
    this.ownProto = own.hookProto;
  }

  /** Newer caller (semver) → 'serve_then_drain' (reply normally, then drain and exit); older caller with hook_proto
   *  current or previous → 'serve'; else 'restart_required' (edit-class G1 VERSION_RESTART {v}). A5-10: semver with
   *  prerelease ordering (1.0.0-rc.1 < 1.0.0); "previous" = own hookProto − 1. Total (R-F2-14; F2 #46, #101): a caller
   *  or own version semverCompare cannot parse is 'restart_required', never a throw — the server calls judge on every
   *  hook and hello, and the schema admits only semver plugin versions (REL-01), so this is the fail-closed backstop. */
  judge(callerVersion: string, callerProto: number): 'serve' | 'serve_then_drain' | 'restart_required' {
    let order: number;
    try {
      order = semverCompare(callerVersion, this.ownVersion);
    } catch (e) {
      if (e instanceof TypeError) return 'restart_required';
      throw e;
    }
    if (order > 0) return 'serve_then_drain';
    if (callerProto === this.ownProto || callerProto === this.ownProto - 1 || callerProto > this.ownProto) return 'serve';
    return 'restart_required';
  }
}
