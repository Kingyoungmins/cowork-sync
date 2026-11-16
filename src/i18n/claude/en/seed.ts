// src/i18n/claude/en/seed.ts — the seed rows of the one Claude template registry in en (A1-4, X-54): exactly G4, PAUSED,
// T-HOOK_LOAD_FAIL, T-SINCE and T-SINCE.touch, texts copied from 07-coordination (§3.16 template rows; test/unit/claude.text.test.ts pins
// them equal to the spec). Plan 6 adds its row modules beside this one; src/i18n/claude.ts registers both languages at module load.
import type { CatalogEntry } from '../../render.js';

export const CLAUDE_SEED_EN: Readonly<Record<string, CatalogEntry>> = {
  "G4": { text: "cowork-sync is not running on this PC, so edits in this live repo are paused. It restarts automatically; if not, the user can run /cowork doctor or /cowork pause." },
  "PAUSED": { text: "cowork-sync is paused for this repo by the user; edits are not coordinated." },
  "T-HOOK_LOAD_FAIL": { text: "[cowork-sync] This edit was not made: cowork-sync's hook code ({v}) failed to load on this PC, so edits in this live repo are paused. This user can run /cowork doctor, or /cowork pause to continue without coordination.", params: { v: "text" } },
  "T-SINCE": { text: "cowork-sync: since this user's last activity on this PC (#{from}): {s} saves and {c} shared change-sets by {k} teammates{touch}. The user can see the summary with /cowork since.", params: { from: "n", s: "n", c: "n", k: "n", touch: "text" } },
  "T-SINCE.touch": { text: "; {path} (recently changed here) was changed by teammate {name}", params: { path: "path", name: "name" } },
};
