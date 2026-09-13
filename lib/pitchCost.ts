// Pitch cost dropped from £55 to £45 starting 7 Sep 2026 - fixtures
// before that date keep the old rate (both as historical record for
// already-played games and for any new one-off added for an earlier
// date), anything on or after gets the new one automatically.
//
// Single source of truth, shared between the real "create fixture" flow
// (app/WirralCommunityFootball.tsx) and GaffAI's propose_create_fixture
// (lib/gaffai/toolImpl.ts) - this used to be duplicated in both places,
// which meant the next pitch-fee change was one edit away from silently
// leaving GaffAI proposing fixtures at a stale price.
export function defaultPitchCost(date: string): number {
  return date >= "2026-09-07" ? 45 : 55;
}
