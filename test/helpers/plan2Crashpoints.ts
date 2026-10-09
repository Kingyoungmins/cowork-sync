// The crashpoints Plan 2 places (one list for the placement test and the SIM crash matrix): the 13 names of 01-engine
// ENG-59 and registry.cas (HLD-01, two call sites), sorted by code unit. test/unit/crashpoints-placed.test.ts pins them
// as exactly the crashpoint() call sites in src/; test/integration/sim.crash.test.ts kills each one.
export const PLAN2_CRASHPOINTS: readonly string[] = Object.freeze([
  'apply.between_groups',
  'apply.group.mid',
  'apply.group.phase1',
  'apply.group.phase2',
  'apply.intent',
  'apply.state',
  'join.first_apply',
  'publish.landed',
  'publish.out_built',
  'publish.sent',
  'recover.displaced',
  'recover.reanchor',
  'registry.cas',
  'snapshot.index_written',
]);

/** The genesis yield point (L0 and B0 built, before their push; the Scheduler port's onYield), killed with the crashpoints. */
export const GENESIS_YIELD = 'start.beforeGenesisPush';
