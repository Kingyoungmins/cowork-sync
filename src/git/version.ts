export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Glossary §18: git ≥ 2.43. */
export const GIT_FLOOR: GitVersion = Object.freeze({ major: 2, minor: 43, patch: 0, raw: '2.43.0' });

const PREFIX = 'git version ';
const NUMBERS = /^(\d+)\.(\d+)(?:\.(\d+))?/;

/** Parses the first line of `git version` output, e.g. "git version 2.55.0.windows.3". */
export function parseGitVersion(stdout: string): GitVersion {
  const firstLine = (stdout.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/)[0] ?? '').trim();
  if (!firstLine.startsWith(PREFIX)) {
    throw new Error(`parseGitVersion: unexpected output ${JSON.stringify(firstLine.slice(0, 80))}`);
  }
  const raw = firstLine.slice(PREFIX.length).trim();
  const m = NUMBERS.exec(raw);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new Error(`parseGitVersion: no version number in ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    raw,
  };
}

export function meetsFloor(v: GitVersion): boolean {
  if (v.major !== GIT_FLOOR.major) return v.major > GIT_FLOOR.major;
  if (v.minor !== GIT_FLOOR.minor) return v.minor > GIT_FLOOR.minor;
  return v.patch >= GIT_FLOOR.patch;
}
