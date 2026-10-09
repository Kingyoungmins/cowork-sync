// Every code of the 12-visualizer section 3.11 table, by group; the closed code sets of R-V43; the page subset (R-V15).
// Imports nothing: this file is part of the page's client program (R-V35).

export type CodeGroup = 'cli' | 'page' | 'scene' | 'icon' | 'card' | 'recording' | 'control' | 'log' | 'reused';

/** UI_VIZ_DEMO_CAPTION_<n> as defined: the Plan 2 storyboard's captions (12 section 3.9.3). */
export const DEMO_CAPTION_CODES: readonly string[] = Object.freeze([
  'UI_VIZ_DEMO_CAPTION_1', 'UI_VIZ_DEMO_CAPTION_2', 'UI_VIZ_DEMO_CAPTION_3', 'UI_VIZ_DEMO_CAPTION_4', 'UI_VIZ_DEMO_CAPTION_5',
]);

const PH: readonly string[] = [
  'PH_OK', 'PH_OFFLINE', 'PH_PAUSED', 'PH_FROZEN', 'PH_NOT_COORDINATED', 'PH_PRESUMED_ABSENT', 'PH_LEFT', 'PH_SLOWED',
];
const SS: readonly string[] = ['SS_FULL', 'SS_HOOK_ONLY', 'SS_NO_MCP', 'SS_NO_HOOKS', 'SS_DEGRADED', 'SS_PAUSED', 'SS_PULL_MODE'];

/** Exactly the 12 section 3.11 table, plus the codes a ruling adds to it ahead of the spec text (R-V67: VIZ_LOG_DROPPED). */
export const VIZ_CODES: Readonly<Record<CodeGroup, readonly string[]>> = Object.freeze({
  cli: Object.freeze([
    'UI_VIZ_OPENED', 'UI_VIZ_URL', 'UI_VIZ_OPEN_FAILED', 'UI_VIZ_TERMINAL_ONLY',
    'RF_VIZ_START_FAILED', 'RF_VIZ_BIND_FAILED', 'RF_VIZ_NO_ROOMS', 'RF_VIZ_REPO_NOT_LIVE', 'RF_VIZ_DEMO_INVALID',
  ]),
  page: Object.freeze([
    'UI_VIZ_STOPPED', 'UI_VIZ_LINK_EXPIRED', 'UI_VIZ_LINK_REUSED', 'UI_VIZ_NEED_LINK', 'UI_VIZ_BAD_HOST', 'UI_VIZ_NOT_FOUND', 'UI_VIZ_NO_ROOMS',
    'UI_VIZ_ROOM_AMBIGUOUS', 'UI_VIZ_ROOM_DOWN', 'UI_VIZ_ROOM_GONE', 'UI_VIZ_NO_BOARD', 'UI_VIZ_RECONNECTING', 'UI_VIZ_VERSION_SKEW',
    'UI_VIZ_NEWER_PROTOCOL', 'UI_VIZ_CHECKPOINT_MISMATCH', 'UI_VIZ_INCIDENT_FROZEN', 'UI_VIZ_STATUS_UNREADABLE', 'UI_VIZ_LAST_FETCH',
    'UI_VIZ_BOARD_FULL', 'UI_VIZ_BOARD_NEAR_FULL', 'UI_VIZ_DEMO_BANNER', ...DEMO_CAPTION_CODES, 'UI_VIZ_CAUGHT_UP', 'UI_VIZ_NEW_PILL',
    'UI_VIZ_MORE', 'UI_VIZ_SEEN_AGO', 'UI_VIZ_SEEN_BEFORE_OPEN',
  ]),
  scene: Object.freeze([
    'UI_VIZ_YOU', 'UI_VIZ_LAST_SHARED_HERE', 'UI_VIZ_HOLDING', 'UI_VIZ_SHELF_DESK', 'UI_VIZ_BIG_TABLE', 'UI_VIZ_GRANT_PAUSE',
    'UI_VIZ_HOST_REFUSED', 'UI_VIZ_LABEL_UNVERIFIED', 'UI_VIZ_SCENE_SUMMARY', 'UI_VIZ_SIGN_BASE_MOVE', 'UI_VIZ_TAG_RESERVED',
    'UI_VIZ_TAG_LINES', 'UI_VIZ_TAG_CHECKS', 'UI_VIZ_CHIP_ASKED_AGAIN', 'UI_VIZ_BUBBLE_GO_FIRST', 'UI_VIZ_BADGE_VERSION',
    'UI_VIZ_BADGE_RULES', 'UI_VIZ_BADGE_CREDIT', 'UI_VIZ_BADGE_HEALTH',
  ]),
  icon: Object.freeze([
    'UI_VIZ_ICON_QUEUED', 'UI_VIZ_ICON_ASKED', 'UI_VIZ_ICON_AWAITING_HUMAN', 'UI_VIZ_ICON_UNDELIVERABLE', 'UI_VIZ_ICON_ACCEPTED',
    'UI_VIZ_ICON_DECLINED', 'UI_VIZ_ICON_LATER', 'UI_VIZ_ICON_DAEMON', 'UI_VIZ_ICON_WAKE',
  ]),
  card: Object.freeze([
    'UI_VIZ_CARD_ROOM_OPEN', 'UI_VIZ_CARD_JOIN', 'UI_VIZ_CARD_REJOIN', 'UI_VIZ_CARD_LEAVE', 'UI_VIZ_CARD_SEAT_START', 'UI_VIZ_CARD_SEAT_END',
    'UI_VIZ_CARD_REQUEST', 'UI_VIZ_CARD_ANSWER', 'UI_VIZ_CARD_NOTE', 'UI_VIZ_CARD_K4', 'UI_VIZ_CARD_CONFLICT', 'UI_VIZ_CARD_BREACH',
    'UI_VIZ_CARD_ABSENT', 'UI_VIZ_CARD_SAVE', 'UI_VIZ_CARD_FREEZE', 'UI_VIZ_CARD_THAW', 'UI_VIZ_CARD_SLOWED', 'UI_VIZ_CARD_NONRETRYABLE',
    'UI_VIZ_CARD_BASE_MOVE', 'UI_VIZ_CARD_BOARD_FULL', 'UI_VIZ_CARD_VERSION', 'UI_VIZ_CARD_RULES', 'UI_VIZ_CARD_HEALTH', 'UI_VIZ_CARD_PUBLISH',
  ]),
  recording: Object.freeze([
    'UI_VIZ_RECORD_NOTICE', 'UI_VIZ_RECORD_UNSUPPORTED', 'UI_VIZ_RECORD_CAP', 'UI_VIZ_RECORD_SIZE', 'UI_VIZ_RECORD_INTERRUPTED',
    'UI_VIZ_ANON_ROOM', 'UI_VIZ_ANON_NAME_APRICOT', 'UI_VIZ_ANON_NAME_AMBER', 'UI_VIZ_ANON_NAME_SKY', 'UI_VIZ_ANON_NAME_GREEN',
    'UI_VIZ_ANON_NAME_LEMON', 'UI_VIZ_ANON_NAME_BLUE', 'UI_VIZ_ANON_NAME_PINK', 'UI_VIZ_ACC_BEANIE', 'UI_VIZ_ACC_HEADPHONES',
    'UI_VIZ_ACC_SUNGLASSES', 'UI_VIZ_ACC_SCARF', 'UI_VIZ_ACC_SPROUT', 'UI_VIZ_ACC_CAP', 'UI_VIZ_ACC_BOW', 'UI_VIZ_ACC_GLASSES',
  ]),
  control: Object.freeze([
    'UI_VIZ_CTRL_PLAY', 'UI_VIZ_CTRL_PAUSE', 'UI_VIZ_CTRL_LIVE', 'UI_VIZ_CTRL_SPEED', 'UI_VIZ_CTRL_LOAD_EARLIER', 'UI_VIZ_CTRL_RECORD',
    'UI_VIZ_CTRL_REDUCED_MOTION', 'UI_VIZ_CTRL_LANGUAGE', 'UI_VIZ_CTRL_ZOOM', 'UI_VIZ_CTRL_COARSE', 'UI_VIZ_CTRL_ANONYMIZE',
    'UI_VIZ_FILTER_ALL', 'UI_VIZ_FILTER_PERSON', 'UI_VIZ_FILTER_FILE', 'UI_VIZ_FILTER_CONVERSATION', 'UI_VIZ_FILTER_ACTIVITY',
    'UI_VIZ_FILTER_CONFLICTS', 'UI_VIZ_FILTER_SYSTEM',
  ]),
  log: Object.freeze([
    'SEC_VIZ_BAD_HOST', 'SEC_VIZ_BAD_ORIGIN', 'SEC_VIZ_BAD_TOKEN', 'SEC_VIZ_LAUNCH_REUSED', 'SEC_VIZ_LAUNCH_EXPIRED', 'SEC_VIZ_METHOD',
    'SEC_VIZ_LIMIT', 'VIZ_EXIT_IDLE', 'VIZ_EXIT_LIFETIME', 'VIZ_EXIT_LAUNCH_UNUSED', 'VIZ_EXIT_LAUNCH_REUSED', 'VIZ_EXIT_PLUGIN_REMOVED',
    'VIZ_EXIT_SIGNAL',
    // R-V67: the viewer log's own marker for lines dropped while a rotation was blocked (spec-edit list 12 §3.10.10 and the §3.11
    // "Log only" row, not yet in the spec text).
    'VIZ_LOG_DROPPED',
  ]),
  reused: Object.freeze([
    ...PH, ...SS, 'UI_DUR_S', 'UI_DUR_MIN', 'UI_DUR_H', 'UI_INTERNAL_ERROR', 'SEC_SECRET_REDACTED', 'SEC_RECORD_INVALID',
    'SEC_REFUSE_RUNTIME_INTEGRITY', 'RF_UNKNOWN_FLAG', 'START_TOOL_VERSION',
  ]),
});

export const ALL_VIZ_CODES: ReadonlySet<string> = new Set(Object.values(VIZ_CODES).flat());

/** The prefixes of the /api/v1/strings page subset (12 section 3.10.5). */
export const PAGE_SUBSET_PREFIXES: readonly string[] = Object.freeze(['UI_VIZ_', 'PH_', 'SS_', 'UI_DUR_']);

// R-V43: closed sets for code-typed served fields. A later plan that posts a new reason or health code adds it here in the commit that
// adds the fold effect. No set holds a code prefixed UI_, RF_, SEC_, VIZ_, PH_, SS_ or START_ (tested).
/** glossary section 14 freeze_reasons. */
export const FREEZE_REASON_CODES: ReadonlySet<string> = new Set(['EPOCH', 'MASS', 'PAUSED', 'INCIDENT', 'CONFIG', 'NOHOOKS']);
/** What Plan 2 posts (HOST_THROTTLED) and PRO-06's BOARD_FULL. */
export const HEALTH_REASON_CODES: ReadonlySet<string> = new Set(['HOST_THROTTLED', 'BOARD_FULL']);
/** glossary section 14 publish_pause. */
export const PUBLISH_PAUSE_CODES: ReadonlySet<string> = new Set(['OFFLINE', 'AUTH', 'NONRETRYABLE', 'VERSION']);
/** glossary section 14 state. */
export const STATUS_STATES: ReadonlySet<string> = new Set(['ok', 'degraded', 'offline', 'frozen', 'incident', 'paused', 'refused', 'down']);
/** 10-product section 3.14. */
export const PH_CODES: ReadonlySet<string> = new Set(PH);
export const SS_CODES: ReadonlySet<string> = new Set(SS);
export const CHARACTER_BADGES: ReadonlySet<string> = new Set([
  'UI_VIZ_BADGE_VERSION', 'UI_VIZ_BADGE_RULES', 'UI_VIZ_BADGE_CREDIT', 'UI_VIZ_BADGE_HEALTH',
]);
/** The codes a reason parameter may nest: FREEZE_REASON_CODES, HEALTH_REASON_CODES and PUBLISH_PAUSE_CODES. */
export const REASON_CODES: ReadonlySet<string> = new Set([...FREEZE_REASON_CODES, ...HEALTH_REASON_CODES, ...PUBLISH_PAUSE_CODES]);

/** The /api/v1/strings subset: the codes with a PAGE_SUBSET_PREFIXES prefix, REASON_CODES and UI_INTERNAL_ERROR. */
export const PAGE_CODES: ReadonlySet<string> = new Set([
  ...[...ALL_VIZ_CODES].filter((c) => PAGE_SUBSET_PREFIXES.some((p) => c.startsWith(p))),
  ...REASON_CODES,
  'UI_INTERNAL_ERROR',
]);
