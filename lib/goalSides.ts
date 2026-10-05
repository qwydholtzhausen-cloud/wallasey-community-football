// Someone who swaps sides mid-match can score for both teams. game_stats
// keeps `goals` as their total for the night (so every total - records,
// POTM, Wrapped, GaffAI - stays right untouched), and `goals_other_side`
// says how many of those went in for the side they didn't finish on (the
// side on their booking). Only per-team scorer lists need this.
type Side = "white" | "red";

export function scorersForSide<R extends { player_id: string; goals: number; goals_other_side?: number | null }>(
  rows: R[],
  side: Side,
  teamOf: (playerId: string) => Side | null | undefined
): R[] {
  return rows
    .flatMap((r) => {
      const team = teamOf(r.player_id);
      if (!team) return [];
      const other = Math.min(r.goals, Math.max(0, r.goals_other_side ?? 0));
      const n = team === side ? r.goals - other : other;
      return n > 0 ? [{ ...r, goals: n }] : [];
    })
    .sort((a, b) => b.goals - a.goals);
}
