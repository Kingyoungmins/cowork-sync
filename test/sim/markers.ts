// Edit markers and their reference model (Plan 3 Task 13; TST-08, 11-testing §2 *marker*, glossary §21 INV-NOLOSS's accounting
// input, rulings R3-48 and R3-64).
//
// Every generated edit of the `holds` profile (and of every profile run with a MarkerModel) carries one fresh marker
// `CWM_<run>_<n>_<peer>`: <run> is the seed without characters outside [0-9A-Za-z] (markerRun), <n> numbers the run's markers across
// authors from 1 (a counter, never a random draw, so a generator's draws are the same with or without markers), <peer> the author
// (`p<i>` or `team`). A marker is ASCII, so it is found in any file by a latin1 scan (findMarkers) and placed without touching a
// byte of the file's own text: `place` works on raw bytes, keeps a leading UTF-8 BOM first, writes the file's dominant ending,
// never adds a final EOL a file did not have, never splits a cp949 byte pair (it inserts only at a row start or before a row's
// EOL), and appends to a binary file (a NUL in its first 8,000 bytes, DAT-04) after its last byte.
//
// The model (TST-08, R3-48) is what INV-NOLOSS checks against: `live()` — every marker written to a synced path and not since
// removed by an informed edit of a peer that had it (its A blob or its disk held it) — is an obligation; `retired()` holds the
// informed removals (R3-64's resurrection clause reads it); `discarded()` the markers a human `--discard` accounted for (with the
// hold id); `exempt()` the markers written to a path that was not synced at the write (temp, secret-like without a record, locally
// excluded, NOT_ADMITTED without a record) — no obligation until a later edit moves them to a synced path; `lateWrites()` the
// markers written through a `.old` handle after the writer's P1 rename (F-ED-4, ENG-35: they must be in a hold record by the next
// check). Each marker has one place in the model at a time: live, retired, discarded or exempt.

/** The marker grammar (contract: every /CWM_[0-9A-Za-z]+_[0-9]+_[0-9A-Za-z]+/ match). */
const MARKER_RE = /CWM_[0-9A-Za-z]+_[0-9]+_[0-9A-Za-z]+/g;
const TOKEN_RE = /^[0-9A-Za-z]+$/;
/** DAT-04: binary = a NUL in the first 8,000 bytes. */
const BINARY_PROBE = 8_000;
const BOM = 'ï»¿';   // EF BB BF read as latin1

/** The seed without characters outside [0-9A-Za-z] ('holds-12' → 'holds12'). */
export function markerRun(seed: string): string {
  return seed.replace(/[^0-9A-Za-z]/g, '');
}

/** Every marker in byte order (a latin1 scan: markers are ASCII, so non-UTF-8 and binary neighbours cannot hide one). */
export function findMarkers(bytes: Buffer): string[] {
  return bytes.toString('latin1').match(MARKER_RE) ?? [];
}

/** A row of a latin1 body: [start, end) is its text, eol its ending ('' for a last row without one). */
interface Row { start: number; end: number; eol: '' | '\n' | '\r\n'; }

function rowsOf(body: string): Row[] {
  const out: Row[] = [];
  let start = 0;
  while (start < body.length) {
    const lf = body.indexOf('\n', start);
    if (lf < 0) {
      out.push({ start, end: body.length, eol: '' });
      break;
    }
    const crlf = lf > start && body.charCodeAt(lf - 1) === 0x0d;
    out.push({ start, end: crlf ? lf - 1 : lf, eol: crlf ? '\r\n' : '\n' });
    start = lf + 1;
  }
  return out;
}

/** The dominant ending: CRLF when more rows end in CRLF than in a bare LF, else LF (also for a file without endings). */
function dominantEol(rows: readonly Row[]): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (const r of rows) {
    if (r.eol === '\r\n') crlf++;
    else if (r.eol === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

export interface MarkerOwner { peer: string; path: string; }

export class MarkerModel {
  readonly run: string;
  private n = 0;
  private readonly liveSet = new Map<string, MarkerOwner>();
  private readonly retiredSet = new Set<string>();
  private readonly discardedSet = new Map<string, string>();
  private readonly exemptSet = new Map<string, MarkerOwner>();
  private readonly late = new Set<string>();

  constructor(run: string) {
    if (!TOKEN_RE.test(run)) throw new Error(`MarkerModel: the run must match [0-9A-Za-z]+ (markerRun(seed)), got ${JSON.stringify(run)}`);
    this.run = run;
  }

  /** CWM_<run>_<n>_<peer>, n counting this run's markers from 1 across authors. */
  mint(peer: string): string {
    if (!TOKEN_RE.test(peer)) throw new Error(`MarkerModel.mint: the peer must match [0-9A-Za-z]+, got ${JSON.stringify(peer)}`);
    this.n += 1;
    return `CWM_${this.run}_${this.n}_${peer}`;
  }

  /**
   * `bytes` with `marker` placed at row `at`: 'line' inserts `<marker><EOL>` before row `at` (at ≥ the row count appends a final row),
   * 'suffix' inserts ` <marker>` before row `at`'s EOL (at ≥ the row count suffixes the last row); EOL = the file's dominant ending.
   * A leading UTF-8 BOM stays first, a missing final EOL stays missing, every other byte is kept; a binary buffer (DAT-04) gets
   * `<marker>\n` after its last byte in either mode; an empty file becomes one LF row.
   */
  place(bytes: Buffer, marker: string, at: number, mode: 'line' | 'suffix'): Buffer {
    if (findMarkers(Buffer.from(marker, 'latin1')).join() !== marker) throw new Error(`MarkerModel.place: not a marker: ${JSON.stringify(marker)}`);
    if (!Number.isSafeInteger(at) || at < 0) throw new RangeError(`MarkerModel.place: row must be an integer >= 0, got ${at}`);
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return Buffer.concat([bytes, Buffer.from(`${marker}\n`, 'latin1')]);
    const s = bytes.toString('latin1');
    const bom = s.startsWith(BOM) ? BOM : '';
    const body = s.slice(bom.length);
    const rows = rowsOf(body);
    const eol = dominantEol(rows);
    let out: string;
    if (rows.length === 0) {
      out = `${marker}${eol}`;
    } else if (mode === 'line') {
      if (at < rows.length) {
        const r = rows[at] as Row;
        out = `${body.slice(0, r.start)}${marker}${eol}${body.slice(r.start)}`;
      } else {
        const last = rows[rows.length - 1] as Row;
        // A final row: after the last EOL, or — the file had none — after a new EOL, the marker row again without one.
        out = last.eol === '' ? `${body}${eol}${marker}` : `${body}${marker}${eol}`;
      }
    } else {
      const r = rows[Math.min(at, rows.length - 1)] as Row;
      out = `${body.slice(0, r.end)} ${marker}${body.slice(r.end)}`;
    }
    return Buffer.from(`${bom}${out}`, 'latin1');
  }

  /**
   * One write of `path` by `peer` (TST-08): `added` = findMarkers(after) − findMarkers(before), `removed` = the reverse. An added
   * marker becomes live for this path (already live: its path moves, its author stays; retired or discarded: live again for the
   * re-adding peer); with `synced` false (the path is not synced at the write, R3-48) it is exempt instead. A removed marker is
   * retired only by an informed edit (`informed`) of a peer whose A blob or disk held it (`peerHad`), and only at the path the model
   * has it live at (the old name of a move retires nothing); a removed exempt marker leaves the exempt set.
   */
  noteEdit(peer: string, path: string, added: readonly string[], removed: readonly string[], informed: boolean, peerHad: (m: string) => boolean, synced = true): void {
    for (const m of added) {
      const owner = this.liveSet.get(m) ?? this.exemptSet.get(m);
      const author = owner?.peer ?? peer;
      this.liveSet.delete(m);
      this.exemptSet.delete(m);
      this.retiredSet.delete(m);
      this.discardedSet.delete(m);
      (synced ? this.liveSet : this.exemptSet).set(m, { peer: author, path });
    }
    for (const m of removed) {
      const live = this.liveSet.get(m);
      if (live !== undefined) {
        if (informed && live.path === path && peerHad(m)) {
          this.liveSet.delete(m);
          this.retiredSet.add(m);
        }
        continue;
      }
      if (this.exemptSet.get(m)?.path === path) this.exemptSet.delete(m);
    }
  }

  /** A human `--discard` of hold `holdId` accounted for `markers`: the live ones leave live() for discarded(); others are ignored. */
  noteDiscard(holdId: string, markers: readonly string[]): void {
    for (const m of markers) {
      if (!this.liveSet.has(m)) continue;
      this.liveSet.delete(m);
      this.discardedSet.set(m, holdId);
    }
  }

  /** The marker was written through a `.old` handle after P1 (write_during_apply 'old_handle'; F-ED-4, ENG-35). */
  noteLateWrite(marker: string): void {
    this.late.add(marker);
  }

  live(): ReadonlyMap<string, MarkerOwner> {
    return this.liveSet;
  }

  exempt(): ReadonlyMap<string, MarkerOwner> {
    return this.exemptSet;
  }

  discarded(): ReadonlyMap<string, string> {
    return this.discardedSet;
  }

  lateWrites(): ReadonlySet<string> {
    return this.late;
  }

  retired(): ReadonlySet<string> {
    return this.retiredSet;
  }
}
