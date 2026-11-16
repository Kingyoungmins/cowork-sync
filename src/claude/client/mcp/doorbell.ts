// src/claude/client/mcp/doorbell.ts — CCI-49, SEC-24, INV-TOKEN: the one file that names the messaging token (lint L-TOKEN, which scans src/**,
// test/** and tools/**). Plan 5 Task 2 creates it with TOKEN_ENV only (A2-3); Task 14 adds Doorbell, the token's only reader.

/** A2-3: the only spelling of the name in the repository (09 test 22); the lint rule and every test that plants a canary token compose the name
 *  from this constant (env[TOKEN_ENV]). */
export const TOKEN_ENV = 'CLAUDE_CODE_MESSAGING_TOKEN' as const;
