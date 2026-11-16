// The PR leg's time against 11-testing §3.11's budgets (Plan 3 Task 16; rulings R3-51, R3-55): ci.yml's last step of each job writes
// one line to the job summary — the `sim` job `SIM <m> min of the 20-minute leg budget (11-testing §3.11)` from its run-seeds report
// (the run's wall time, with each profile group's seed count and summed seed minutes), the `test` job `npm test <n> min` — and, when
// the SIM part is over 20 minutes, a `::warning::` annotation. It never fails the job: a leg over budget is reported, not failed (R3-51).
//
// Usage: tsx tools/sim/leg-budget.ts --report <sim-seeds.json>    (SIM minutes)
//        tsx tools/sim/leg-budget.ts --npm-test-since <unix s>     (npm test minutes: now − the start the job recorded)
// Each line goes to stdout and, when GITHUB_STEP_SUMMARY is set, is appended to that file. Exit 0 always (an unreadable report is a
// warning line too).
// tools/ is outside src/, so the L-CLOCK lint does not apply to Date.now() here.
import { appendFileSync, readFileSync } from 'node:fs';

/** 11-testing §3.11: the SIM part of one PR leg. */
export const SIM_LEG_BUDGET_MIN = 20;

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

/** The summary lines (and annotations) for a run-seeds report's JSON text. */
export function simLines(text: string): string[] {
  let r: { wallMs?: unknown; runs?: unknown; results?: unknown };
  try {
    r = JSON.parse(text) as typeof r;
  } catch {
    return [`::warning title=SIM leg budget::the run-seeds report is not JSON: no SIM minutes for this leg`];
  }
  const wall = typeof r.wallMs === 'number' ? r.wallMs : null;
  const results = Array.isArray(r.results) ? (r.results as Array<{ profile?: unknown; ms?: unknown }>) : [];
  const runs = Array.isArray(r.runs) ? (r.runs as Array<{ profile?: unknown; seeds?: unknown }>) : [];
  if (wall === null) return ['::warning title=SIM leg budget::the run-seeds report has no wallMs: no SIM minutes for this leg'];
  const groups = runs.map((g) => {
    const mine = results.filter((x) => x.profile === g.profile);
    const ms = mine.reduce((s, x) => s + (typeof x.ms === 'number' ? x.ms : 0), 0);
    return `${String(g.profile)} ${Array.isArray(g.seeds) ? g.seeds.length : 0} seeds (${minutes(ms)} seed-min)`;
  });
  const lines = [`SIM ${minutes(wall)} min of the ${SIM_LEG_BUDGET_MIN}-minute leg budget (11-testing §3.11): ${groups.join(', ')}`];
  if (wall > SIM_LEG_BUDGET_MIN * 60_000) {
    lines.push(`::warning title=SIM leg budget::SIM ${minutes(wall)} min is over the ${SIM_LEG_BUDGET_MIN}-minute leg budget (11-testing §3.11); reported, never failed (R3-51)`);
  }
  return lines;
}

/** The npm test line: the minutes since `sinceS` (unix seconds) at `nowMs`. */
export function npmTestLine(sinceS: number, nowMs: number): string {
  return `npm test ${minutes(nowMs - sinceS * 1_000)} min`;
}

function main(argv: readonly string[]): void {
  let lines: string[];
  if (argv.length === 2 && argv[0] === '--report') {
    let text: string;
    try {
      text = readFileSync(argv[1]!, 'utf8');
    } catch {
      text = '';
    }
    lines = text === '' ? [`::warning title=SIM leg budget::no run-seeds report at ${argv[1]}: no SIM minutes for this leg`] : simLines(text);
  } else if (argv.length === 2 && argv[0] === '--npm-test-since' && /^[0-9]+$/.test(argv[1]!)) {
    lines = [npmTestLine(Number(argv[1]), Date.now())];
  } else {
    lines = ['::warning title=leg budget::usage: leg-budget.ts --report <file> | --npm-test-since <unix s>'];
  }
  for (const l of lines) process.stdout.write(`${l}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    try {
      appendFileSync(summary, lines.filter((l) => !l.startsWith('::')).map((l) => `${l}\n`).join(''), 'utf8');
    } catch {
      // the summary is a report, never a gate
    }
  }
}

if (process.argv[1] !== undefined && /leg-budget\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
