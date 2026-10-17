// Team of the Month: the month's best eight (our games are 8-a-side), on
// points, captained by the Player of the Month. Pure and DB-free like
// lib/cabinet.ts and lib/records.ts: worked out from rows the app already
// has, for months whose Player of the Month has been announced only, so it
// can never spoil a month in progress.
//
// The fair rating (agreed 16 Oct 2026). Every game you play gets a match
// rating out of 10, half what your team did and half what the squad saw:
//   Team's night (0-5): 3 a win, 1 a draw, 0 a loss, ±1 for the margin
//     (capped at 3 goals either way), plus 1 so a heavy defeat is 0.
//   Squad's verdict (0-5): your share of that night's Man of the Match
//     votes (20% of the votes = 4, a share so 8 or 16 voters count the
//     same), plus 1 for winning Man of the Match.
// Your month is your average per game, not a total, with two "average"
// games added, so playing more doesn't win it on its own and a lucky short
// run can't either. Your own goals count through the result and the votes.
// 3+ games to qualify. Ties: Man of the Match wins, then games, then name.

export const TOTM_SIZE = 8;
export const TOTM_MIN_GAMES = 3;
export const TOTM_RATING = { win: 3, draw: 1, marginCap: 3, fullShare: 0.2, shareMax: 4, motm: 1, priorGames: 2 } as const;

export interface TotmGame {
  id: string;
  date: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null }[];
}

export type TotmLine = "front" | "mid" | "back";

export interface TotmPlayer {
  id: string;
  rating: number; // out of 10, smoothed
  team: number; // average team's night, out of 5
  squad: number; // average squad's verdict, out of 5
  apps: number;
  wins: number;
  draws: number;
  goals: number;
  motm: number;
  votes: number;
  margin: number; // your side's goal difference, capped per game
  captain: boolean;
}

export interface TeamOfMonth {
  monthKey: string;
  games: number;
  qualified: number;
  // The eight, highest points first, each with a line on the pitch.
  team: (TotmPlayer & { line: TotmLine })[];
  // Everyone who qualified (and the captain), for "How the points work".
  table: TotmPlayer[];
}

export function computeTeamOfMonth(input: {
  monthKey: string;
  games: TotmGame[]; // scored games with closed votes; any month, any order
  goals: { game_id: string; player_id: string; goals: number }[];
  motmWinnerIdsByGame: Record<string, string[]>;
  motmTallyByGame: Record<string, Record<string, number>>;
  captainIds: string[]; // that month's Player of the Month winner(s)
  name: (id: string) => string;
}): TeamOfMonth | null {
  const games = input.games.filter((g) => g.date.startsWith(input.monthKey) && g.team_white_score != null && g.team_red_score != null);
  if (games.length === 0) return null;
  const rows = new Map<string, TotmPlayer & { sumTeam: number; sumSquad: number; rated: number }>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r)
      rows.set(id, (r = { id, rating: 0, team: 0, squad: 0, apps: 0, wins: 0, draws: 0, goals: 0, motm: 0, votes: 0, margin: 0, captain: false, sumTeam: 0, sumSquad: 0, rated: 0 }));
    return r;
  };
  const R = TOTM_RATING;
  let allSum = 0;
  let allN = 0;
  for (const g of games) {
    const w = g.team_white_score!;
    const r = g.team_red_score!;
    const winner = w > r ? "white" : r > w ? "red" : null;
    const tally = input.motmTallyByGame[g.id] ?? {};
    const voters = Object.values(tally).reduce((s, n) => s + n, 0);
    const winners = input.motmWinnerIdsByGame[g.id] ?? [];
    for (const b of g.bookings) {
      if (b.waiting) continue;
      const p = row(b.player_id);
      p.apps++;
      if (!winner) p.draws++;
      else if (b.team === winner) p.wins++;
      const myVotes = tally[b.player_id] ?? 0;
      p.votes += myVotes;
      if (winners.includes(b.player_id)) p.motm++;
      // Only a game you were on a side for can be rated.
      if (!b.team) continue;
      const m = b.team === "white" ? w - r : r - w;
      const capped = Math.max(-R.marginCap, Math.min(R.marginCap, m));
      p.margin += capped;
      const team = (m > 0 ? R.win : m === 0 ? R.draw : 0) + capped / R.marginCap + 1;
      const share = voters ? myVotes / voters : 0;
      const squad = Math.min(R.shareMax, (R.shareMax * share) / R.fullShare) + (winners.includes(b.player_id) ? R.motm : 0);
      p.sumTeam += team;
      p.sumSquad += squad;
      p.rated++;
      allSum += team + squad;
      allN++;
    }
  }
  const ids = new Set(games.map((g) => g.id));
  for (const gr of input.goals) if (ids.has(gr.game_id) && gr.goals > 0) row(gr.player_id).goals += gr.goals;
  const avg = allN ? allSum / allN : 0;
  for (const p of rows.values()) {
    p.team = p.rated ? p.sumTeam / p.rated : 0;
    p.squad = p.rated ? p.sumSquad / p.rated : 0;
    p.rating = (p.sumTeam + p.sumSquad + R.priorGames * avg) / (p.rated + R.priorGames);
    p.captain = input.captainIds.includes(p.id);
  }
  const order = (a: TotmPlayer, b: TotmPlayer) =>
    b.rating - a.rating || b.motm - a.motm || b.apps - a.apps || input.name(a.id).localeCompare(input.name(b.id));
  const table: TotmPlayer[] = [...rows.values()].map(({ sumTeam, sumSquad, rated, ...p }) => p).filter((p) => p.apps >= TOTM_MIN_GAMES || p.captain).sort(order);
  const qualified = table.filter((p) => p.apps >= TOTM_MIN_GAMES).length;

  // The captain always makes it: if Player of the Month isn't in the top
  // eight on rating, they take the last place.
  let team = table.slice(0, TOTM_SIZE);
  for (const cap of table.filter((p) => p.captain && !team.includes(p))) {
    const drop = [...team].reverse().find((p) => !p.captain);
    if (drop) team = team.filter((p) => p !== drop);
    team.push(cap);
  }
  team.sort(order);
  if (team.length < TOTM_SIZE) return null;

  // We don't record positions, so the shape comes from goals: the top two
  // scorers up front, the next three in midfield, the rest at the back.
  const byGoals = [...team].sort((a, b) => b.goals - a.goals || order(a, b));
  const lineOf = (p: TotmPlayer): TotmLine => {
    const i = byGoals.indexOf(p);
    return i < 2 ? "front" : i < 5 ? "mid" : "back";
  };
  return { monthKey: input.monthKey, games: games.length, qualified, team: team.map((p) => ({ ...p, line: lineOf(p) })), table };
}
