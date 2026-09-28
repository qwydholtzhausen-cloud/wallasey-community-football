// Man of the Match for one game - the club's rule, used everywhere a
// winner is decided (Scores, Feed, Records, player cards, Player of the
// Month, Wrapped, team balancing, GaffAI and the cron pushes):
//   1. most votes wins;
//   2. a tie on votes goes to whoever scored more goals in that game;
//   3. still level = joint winners.
// e.g. Mon 7 Sep 2026 (5-5): Adam Stanley and Gary McKay 4 votes each,
// Gary scored 3 to Adam's 2, so it's Gary's.
export function motmWinners(tally: Record<string, number> | undefined | null, goalsInGame: (playerId: string) => number): string[] {
  if (!tally) return [];
  const top = Math.max(0, ...Object.values(tally));
  if (top === 0) return [];
  let winners = Object.keys(tally).filter((id) => tally[id] === top);
  if (winners.length > 1) {
    const best = Math.max(...winners.map(goalsInGame));
    winners = winners.filter((id) => goalsInGame(id) === best);
  }
  return winners;
}

// Goals per player per game, for the tie-break above.
export function goalsLookup(rows: { game_id: string; player_id: string; goals: number }[] | null | undefined) {
  const map = new Map<string, number>();
  for (const r of rows ?? []) map.set(`${r.game_id}:${r.player_id}`, (map.get(`${r.game_id}:${r.player_id}`) ?? 0) + r.goals);
  return (gameId: string) => (playerId: string) => map.get(`${gameId}:${playerId}`) ?? 0;
}
