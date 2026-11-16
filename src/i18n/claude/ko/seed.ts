// src/i18n/claude/ko/seed.ts — the seed rows of the one Claude template registry in ko (A1-4, X-54): exactly G4, PAUSED,
// T-HOOK_LOAD_FAIL, T-SINCE and T-SINCE.touch, texts copied from 07-coordination (§3.16 template rows; test/unit/claude.text.test.ts pins
// them equal to the spec). Plan 6 adds its row modules beside this one; src/i18n/claude.ts registers both languages at module load.
import type { CatalogEntry } from '../../render.js';

export const CLAUDE_SEED_KO: Readonly<Record<string, CatalogEntry>> = {
  "G4": { text: "이 PC에서 cowork-sync 가 실행 중이 아니어서 이 라이브 저장소의 편집이 멈췄습니다. 자동으로 다시 시작되며, 그렇지 않으면 사용자가 /cowork doctor 나 /cowork pause 를 실행할 수 있습니다." },
  "PAUSED": { text: "이 저장소의 cowork-sync 는 사용자가 일시 중지했습니다. 편집은 조율되지 않습니다." },
  "T-HOOK_LOAD_FAIL": { text: "[cowork-sync] 편집이 적용되지 않았습니다: 이 PC에서 cowork-sync 훅 코드({v})를 불러오지 못해 이 라이브 저장소의 편집이 멈췄습니다. 이 사용자는 /cowork doctor 를 실행하거나, /cowork pause 로 조율 없이 계속할 수 있습니다.", params: { v: "text" } },
  "T-SINCE": { text: "cowork-sync: 이 PC에서 사용자가 마지막으로 활동한 뒤(#{from}) 저장 {s}회, 팀원 {k}명이 공유한 변경 {c}건{touch}. 사용자는 /cowork since 로 요약을 볼 수 있습니다.", params: { from: "n", s: "n", c: "n", k: "n", touch: "text" } },
  "T-SINCE.touch": { text: "; {path}(최근 이 PC에서 작업)를 팀원 {name} 쪽에서 변경", params: { path: "path", name: "name" } },
};
