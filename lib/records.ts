import { motmWinners, goalsLookup } from "./motm";
// Club records for a season: single-game bests (most goals in a game,
// hat-tricks, biggest win), players' runs (win streaks, games in a row),
// MOTM, the waiting list, and how early games sell out. Pure and DB-free
// like lib/wrapped.ts - computed from rows the app already has loaded.
import { kickoffCutoff, pseudoUtcFromRealInstant } from "./time";

type Team = "white" | "red";

export interface RecordsGame {
  id: string;
  date: string; // YYYY-MM-DD, UK
  kickoff: string; // HH:MM, UK
  max_players: number;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: {
    player_id: string;
    waiting: boolean;
    team: Team | null;
    created_at: string; // real instant
    promoted_at: string | null; // real instant
    player: { display_name: string };
  }[];
}

export interface RecordsInput {
  games: RecordsGame[]; // the season's games, already played
  goals: { game_id: string; player_id: string; goals: number }[];
  motmTallyByGame: Record<string, Record<string, number>>; // only games whose voting has closed
  names: (playerId: string) => string;
}

export interface Holder {
  playerId: string;
  name: string;
  date?: string;
}

export interface ClubRecords {
  mostGoalsInGame: { goals: number; holders: Holder[] } | null;
  hatTricks: { playerId: string; name: string; date: string; goals: number }[];
  biggestWin: { margin: number; date: string; white: number; red: number } | null;
  highestScoring: { total: number; date: string; white: number; red: number } | null;
  mostMotmVotesInGame: { votes: number; holders: Holder[] } | null;
  winStreak: { n: number; holders: Holder[] } | null;
  unbeaten: { n: number; holders: Holder[] } | null;
  gamesInARow: { n: number; holders: Holder[] } | null;
  motmWins: { n: number; holders: Holder[] } | null;
  motmVotes: { n: number; holders: Holder[] } | null;
  promotions: { n: number; holders: Holder[] } | null;
  sellOut: { earliest: { days: number; date: string } | null; averageDays: number | null; soldOut: number; of: number };
}

// A game is "sold out" at the moment the first person had to join the
// waiting list, or when the last spot was taken - whichever came first.
// Anyone promoted later was on the waiting list from their created_at.
// Cancelled bookings are deleted, so this can only ever run a little late,
// never early. Returns days before kickoff, or null if it never filled.
export function soldOutDaysBeforeKickoff(g: RecordsGame): number | null {
  const all = g.bookings.map((b) => b.created_at).sort();
  const waitlisted = g.bookings.filter((b) => b.waiting || b.promoted_at).map((b) => b.created_at).sort();
  const lastSpot = all.length >= g.max_players ? all[g.max_players - 1] : undefined;
  const full = [waitlisted[0], lastSpot].filter((t): t is string => !!t).sort()[0];
  if (!full) return null;
  // Both sides as UK wall-clock, so BST can't skew it by an hour.
  const ms = (pseudo: string) => new Date(pseudo + ":00Z").getTime();
  const diff = ms(kickoffCutoff(g.date, g.kickoff, 0)) - ms(pseudoUtcFromRealInstant(full));
  return Math.max(0, diff / 86400000);
}

// Everyone tied on the top value, as holders.
function leaders(values: Record<string, number>, names: (id: string) => string, min = 1): { n: number; holders: Holder[] } | null {
  const top = Math.max(0, ...Object.values(values));
  if (top < min) return null;
  const holders = Object.keys(values)
    .filter((id) => values[id] === top)
    .map((id) => ({ playerId: id, name: names(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { n: top, holders };
}

export function computeRecords(input: RecordsInput): ClubRecords {
  const games = input.games
    .filter((g) => g.team_white_score != null && g.team_red_score != null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
  const gameById = new Map(games.map((g) => [g.id, g]));
  const { names } = input;

  // Single-game goal records.
  let mostGoals: { goals: number; holders: Holder[] } | null = null;
  const hatTricks: ClubRecords["hatTricks"] = [];
  for (const r of input.goals) {
    const g = gameById.get(r.game_id);
    if (!g || r.goals <= 0) continue;
    const h = { playerId: r.player_id, name: names(r.player_id), date: g.date };
    if (!mostGoals || r.goals > mostGoals.goals) mostGoals = { goals: r.goals, holders: [h] };
    else if (r.goals === mostGoals.goals) mostGoals.holders.push(h);
    if (r.goals >= 3) hatTricks.push({ ...h, goals: r.goals });
  }
  mostGoals?.holders.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  hatTricks.sort((a, b) => b.goals - a.goals || b.date.localeCompare(a.date));

  const score = (g: RecordsGame) => ({ date: g.date, white: g.team_white_score!, red: g.team_red_score! });
  const biggest = [...games].sort(
    (a, b) => Math.abs(b.team_white_score! - b.team_red_score!) - Math.abs(a.team_white_score! - a.team_red_score!) || b.date.localeCompare(a.date)
  )[0];
  const highest = [...games].sort(
    (a, b) => b.team_white_score! + b.team_red_score! - (a.team_white_score! + a.team_red_score!) || b.date.localeCompare(a.date)
  )[0];

  // MOTM: most votes in one game, plus season totals of wins and votes.
  const goalsIn = goalsLookup(input.goals);
  let bestVotes: { votes: number; holders: Holder[] } | null = null;
  const motmWins: Record<string, number> = {};
  const motmVotes: Record<string, number> = {};
  for (const g of games) {
    const tally = input.motmTallyByGame[g.id];
    if (!tally) continue;
    const winners = motmWinners(tally, goalsIn(g.id));
    for (const [id, n] of Object.entries(tally)) {
      motmVotes[id] = (motmVotes[id] ?? 0) + n;
      if (winners.includes(id)) motmWins[id] = (motmWins[id] ?? 0) + 1;
      const h = { playerId: id, name: names(id), date: g.date };
      if (!bestVotes || n > bestVotes.votes) bestVotes = { votes: n, holders: [h] };
      else if (n === bestVotes.votes) bestVotes.holders.push(h);
    }
  }

  // Runs, walked game by game in date order.
  const winRun: Record<string, number> = {};
  const unbeatenRun: Record<string, number> = {};
  const inARow: Record<string, number> = {};
  const bestWin: Record<string, number> = {};
  const bestUnbeaten: Record<string, number> = {};
  const bestInARow: Record<string, number> = {};
  const promotions: Record<string, number> = {};
  const everyone = new Set<string>();
  // Two-game nights: playing either game that night keeps your run going.
  const playedOn = playedByDate(games);
  for (const g of games) {
    const w = g.team_white_score!;
    const r = g.team_red_score!;
    const played = new Map<string, Team>();
    for (const b of g.bookings) {
      if (b.waiting || !b.team) continue;
      played.set(b.player_id, b.team);
      everyone.add(b.player_id);
      if (b.promoted_at) promotions[b.player_id] = (promotions[b.player_id] ?? 0) + 1;
    }
    for (const id of everyone) {
      const team = played.get(id);
      if (!team) {
        if (!playedOn.get(g.date)?.has(id)) inARow[id] = 0;
        continue;
      }
      inARow[id] = (inARow[id] ?? 0) + 1;
      bestInARow[id] = Math.max(bestInARow[id] ?? 0, inARow[id]);
      const won = w !== r && (team === "white") === w > r;
      const lost = w !== r && !won;
      winRun[id] = won ? (winRun[id] ?? 0) + 1 : 0;
      unbeatenRun[id] = lost ? 0 : (unbeatenRun[id] ?? 0) + 1;
      bestWin[id] = Math.max(bestWin[id] ?? 0, winRun[id]);
      bestUnbeaten[id] = Math.max(bestUnbeaten[id] ?? 0, unbeatenRun[id]);
    }
  }

  const soldOut = games.map(soldOutDaysBeforeKickoff);
  const sold = soldOut.map((d, i) => ({ d, date: games[i].date })).filter((x): x is { d: number; date: string } => x.d !== null);
  const earliest = [...sold].sort((a, b) => b.d - a.d)[0];

  return {
    mostGoalsInGame: mostGoals,
    hatTricks,
    biggestWin: biggest ? { margin: Math.abs(biggest.team_white_score! - biggest.team_red_score!), ...score(biggest) } : null,
    highestScoring: highest ? { total: highest.team_white_score! + highest.team_red_score!, ...score(highest) } : null,
    mostMotmVotesInGame: bestVotes,
    winStreak: leaders(bestWin, names, 2),
    unbeaten: leaders(bestUnbeaten, names, 2),
    gamesInARow: leaders(bestInARow, names, 2),
    motmWins: leaders(motmWins, names),
    motmVotes: leaders(motmVotes, names),
    promotions: leaders(promotions, names),
    sellOut: {
      earliest: earliest ? { days: earliest.d, date: earliest.date } : null,
      averageDays: sold.length ? sold.reduce((s, x) => s + x.d, 0) / sold.length : null,
      soldOut: sold.length,
      of: games.length,
    },
  };
}

// One player's season bests, for the "Your bests" card on Records. Same
// walk as computeRecords, just for one person, and each best is compared
// with the club record so a tile can say when yours *is* the record.
export interface PersonalBests {
  games: number;
  mostGoals: { goals: number; date: string } | null;
  hatTricks: number;
  winStreak: number;
  unbeaten: number;
  gamesInARow: number;
  motmWins: number;
  motmVotes: number;
}

export function computePersonalBests(input: RecordsInput, playerId: string): PersonalBests {
  const games = input.games
    .filter((g) => g.team_white_score != null && g.team_red_score != null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
  const gameIds = new Set(games.map((g) => g.id));
  const dateOf = new Map(games.map((g) => [g.id, g.date]));

  let mostGoals: PersonalBests["mostGoals"] = null;
  let hatTricks = 0;
  for (const r of input.goals) {
    if (r.player_id !== playerId || !gameIds.has(r.game_id) || r.goals <= 0) continue;
    if (!mostGoals || r.goals > mostGoals.goals) mostGoals = { goals: r.goals, date: dateOf.get(r.game_id)! };
    if (r.goals >= 3) hatTricks++;
  }

  const playedOn = playedByDate(games);
  let played = 0;
  let win = 0, bestWin = 0, unb = 0, bestUnb = 0, row = 0, bestRow = 0;
  let motmWins = 0, motmVotes = 0;
  for (const g of games) {
    const b = g.bookings.find((x) => x.player_id === playerId && !x.waiting && x.team);
    if (!b) {
      if (!playedOn.get(g.date)?.has(playerId)) row = 0;
      continue;
    }
    played++;
    row++;
    bestRow = Math.max(bestRow, row);
    const w = g.team_white_score!;
    const r = g.team_red_score!;
    const won = w !== r && (b.team === "white") === w > r;
    const lost = w !== r && !won;
    win = won ? win + 1 : 0;
    unb = lost ? 0 : unb + 1;
    bestWin = Math.max(bestWin, win);
    bestUnb = Math.max(bestUnb, unb);
    const tally = input.motmTallyByGame[g.id];
    if (tally) {
      motmVotes += tally[playerId] ?? 0;
      if (motmWinners(tally, goalsLookup(input.goals)(g.id)).includes(playerId)) motmWins++;
    }
  }
  return { games: played, mostGoals, hatTricks, winStreak: bestWin, unbeaten: bestUnb, gamesInARow: bestRow, motmWins, motmVotes };
}

// Who played (on a team, not waiting) on each date - a night can have two
// games, and turning up for either one counts as not missing that night.
export function playedByDate(games: { date: string; bookings: { player_id: string; waiting?: boolean | null; team?: string | null }[] }[]) {
  const m = new Map<string, Set<string>>();
  for (const g of games) {
    for (const b of g.bookings) {
      if (b.waiting || !b.team) continue;
      if (!m.has(g.date)) m.set(g.date, new Set());
      m.get(g.date)!.add(b.player_id);
    }
  }
  return m;
}
