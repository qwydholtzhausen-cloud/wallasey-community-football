// Pure scoring/aggregation logic for the score prediction game - kept
// framework-free and DB-free so it can be unit-tested in isolation before
// ever touching real data (real prizes riding on this being right).

export type MatchResult = "white" | "red" | "draw";

function resultOf(whiteScore: number, redScore: number): MatchResult {
  if (whiteScore > redScore) return "white";
  if (whiteScore < redScore) return "red";
  return "draw";
}

// 3 pts for the exact scoreline, 1 pt for correctly calling the result
// (right side wins, or a correctly-called draw), 0 otherwise.
export function predictionPoints(predictedWhite: number, predictedRed: number, actualWhite: number, actualRed: number): number {
  if (predictedWhite === actualWhite && predictedRed === actualRed) return 3;
  if (resultOf(predictedWhite, predictedRed) === resultOf(actualWhite, actualRed)) return 1;
  return 0;
}

export interface ScoredPrediction {
  playerId: string;
  playerName: string;
  gameId: string;
  gameDate: string; // "YYYY-MM-DD"
  predictedWhite: number;
  predictedRed: number;
  actualWhite: number;
  actualRed: number;
}

export interface LeaderboardRow {
  playerId: string;
  playerName: string;
  points: number;
  exactCount: number;
  gamesGuessed: number;
}

// Points desc, tie-broken by most exact-score calls, then alphabetically -
// fully deterministic, no arbitrary ordering left to object-key iteration
// order or insertion order.
export function buildLeaderboard(predictions: ScoredPrediction[]): LeaderboardRow[] {
  const byPlayer: Record<string, LeaderboardRow> = {};
  for (const p of predictions) {
    const pts = predictionPoints(p.predictedWhite, p.predictedRed, p.actualWhite, p.actualRed);
    const row = (byPlayer[p.playerId] ??= {
      playerId: p.playerId,
      playerName: p.playerName,
      points: 0,
      exactCount: 0,
      gamesGuessed: 0,
    });
    row.points += pts;
    row.exactCount += pts === 3 ? 1 : 0;
    row.gamesGuessed += 1;
  }
  return Object.values(byPlayer).sort(
    (a, b) => b.points - a.points || b.exactCount - a.exactCount || a.playerName.localeCompare(b.playerName)
  );
}

// Buckets by the game's "YYYY-MM" (same convention as everywhere else in
// the app - copyFixtureUpdate, Stats season filter, etc.) and builds one
// leaderboard per month.
export function buildMonthlyLeaderboards(predictions: ScoredPrediction[]): Record<string, LeaderboardRow[]> {
  const byMonth: Record<string, ScoredPrediction[]> = {};
  for (const p of predictions) {
    const key = p.gameDate.slice(0, 7);
    (byMonth[key] ??= []).push(p);
  }
  const result: Record<string, LeaderboardRow[]> = {};
  for (const key of Object.keys(byMonth)) {
    result[key] = buildLeaderboard(byMonth[key]);
  }
  return result;
}

// Everyone tied at the top - empty if nobody scored any points at all
// (a month with zero correct guesses has no real winner, same philosophy
// as Player of the Month returning null rather than an empty-handed "winner").
export function topScorers(leaderboard: LeaderboardRow[]): LeaderboardRow[] {
  if (leaderboard.length === 0 || leaderboard[0].points <= 0) return [];
  const max = leaderboard[0].points;
  return leaderboard.filter((r) => r.points === max);
}
