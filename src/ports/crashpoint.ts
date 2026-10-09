// crashpoint port (11-testing §3.2, §3.6). Production code calls
// crashpoint("<name>") exactly at the anchored step of the catalogue in
// test/crashpoints.json. With no handler installed (release and normal runs)
// the call does nothing. A test harness installs a handler that decides:
// SIM throws KilledAt(name), STRESS kills the process, an observer only counts.

export class KilledAt extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`killed at crashpoint ${point}`);
    this.name = 'KilledAt';
    this.point = point;
  }
}

let handler: ((name: string) => void) | null = null;

export function crashpoint(name: string): void {
  if (handler !== null) handler(name);
}

// Test builds only (TEST_SEAM_IN_RELEASE is enforced by the dist lint later). Returns the handler it replaced, so a
// harness that installs its own can put the caller's back afterwards.
export function setCrashHandler(h: ((name: string) => void) | null): ((name: string) => void) | null {
  const previous = handler;
  handler = h;
  return previous;
}
