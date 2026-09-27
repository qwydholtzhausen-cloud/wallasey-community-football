// "Wrapped": a player's own story of a period (a month while admins test
// it, then the whole year). Pure and DB-free like lib/predictions.ts - the
// app already has every row this needs loaded (games with their bookings
// and teams, goals, MOTM votes, predictions), so it's all computed on the
// device, nothing stored.
import { predictionPoints } from "./predictions";
import { MATCH_LENGTH_MINUTES } from "./time";
import { soldOutDaysBeforeKickoff, type RecordsGame } from "./records";

type Team = "white" | "red";

// Same game shape as lib/records.ts, which also works out sell-out times.
export type WrappedGame = RecordsGame;

export interface WrappedInput {
  games: WrappedGame[]; // the period's games, already played
  playerId: string;
  goals: { game_id: string; player_id: string; goals: number }[];
  motmTallyByGame: Record<string, Record<string, number>>; // only games whose voting has closed
  predictions: { game_id: string; player_id: string; predicted_white: number; predicted_red: number }[];
  // Games before the period, only used to tell who's new to your circle.
  earlierGames?: WrappedGame[];
}

// A pairing only counts after this many games on the same side, so one
// lucky night together can't come out as "100% win rate".
export const WRAPPED_MIN_TOGETHER = 3;
// Fewer than this and there's no story worth telling - no banner at all.
export const WRAPPED_MIN_APPS = 2;
// Predictions only get a card once someone's genuinely played along.
const MIN_PREDICTIONS = 3;

export type Result = "W" | "D" | "L";

export interface WrappedData {
  firstName: string;
  apps: number;
  ofGames: number;
  squad: number;
  appsRank: number; // 1 = most games; ties share a rank
  appsRun: number; // longest run of consecutive club games played
  minutes: number;
  W: number;
  D: number;
  L: number;
  white: number;
  red: number;
  goals: number;
  goalsRank: number | null; // null when 0 goals
  topScorer: { name: string; goals: number } | null;
  motmWins: number;
  motmVotes: number; // total MOTM votes received
  promotions: number; // times you got in off the waiting list
  partner: { playerId: string; name: string; together: number; wins: number; rate: number } | null;
  myRate: number;
  mostWith: { playerId: string; name: string; together: number } | null;
  // Opponents: who's beaten you most, and who you've had the better of.
  nemesis: { playerId: string; name: string; met: number; beatYou: number; youBeat: number } | null;
  favourite: { playerId: string; name: string; met: number; beatYou: number; youBeat: number } | null;
  best: { date: string; team: Team; us: number; them: number } | null;
  unbeaten: number;
  winStreak: number;
  form: { date: string; result: Result }[]; // your games, oldest first
  circle: { count: number; newCount: number | null; faces: string[] }; // teammates on your side, most games first
  predictions: { made: number; points: number; exact: number; rank: number; joint: boolean; of: number } | null;
  club: {
    games: number;
    goals: number;
    whiteWins: number;
    redWins: number;
    draws: number;
    highest: { date: string; white: number; red: number } | null;
    mostApps: { name: string; apps: number } | null;
    sellOutDays: number | null; // average days before kickoff games sold out
  };
}

function resultFor(g: WrappedGame, team: Team): Result {
  const w = g.team_white_score ?? 0;
  const r = g.team_red_score ?? 0;
  if (w === r) return "D";
  return (team === "white") === w > r ? "W" : "L";
}

export function computeWrapped(input: WrappedInput): WrappedData | null {
  const games = input.games
    .filter((g) => g.team_white_score != null && g.team_red_score != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const me = input.playerId;

  // Everyone who played (with a team) in each game.
  const slots = games.flatMap((g) =>
    g.bookings.filter((b) => !b.waiting && b.team).map((b) => ({ game: g, playerId: b.player_id, team: b.team as Team, name: b.player.display_name }))
  );
  const mine = slots.filter((s) => s.playerId === me);
  if (mine.length < WRAPPED_MIN_APPS) return null;

  const names: Record<string, string> = {};
  const apps: Record<string, number> = {};
  for (const s of slots) {
    names[s.playerId] = s.name;
    apps[s.playerId] = (apps[s.playerId] ?? 0) + 1;
  }
  const goalsBy: Record<string, number> = {};
  const gameIds = new Set(games.map((g) => g.id));
  for (const r of input.goals) if (gameIds.has(r.game_id)) goalsBy[r.player_id] = (goalsBy[r.player_id] ?? 0) + r.goals;
  const rankIn = (map: Record<string, number>, mineVal: number) => 1 + Object.values(map).filter((v) => v > mineVal).length;

  const rec = { W: 0, D: 0, L: 0 };
  const colours = { white: 0, red: 0 };
  for (const m of mine) {
    rec[resultFor(m.game, m.team)]++;
    colours[m.team]++;
  }

  // Longest run of the club's games played back to back, and longest
  // unbeaten run within the games played.
  const myGameIds = new Set(mine.map((m) => m.game.id));
  let appsRun = 0;
  let run = 0;
  for (const g of games) {
    run = myGameIds.has(g.id) ? run + 1 : 0;
    appsRun = Math.max(appsRun, run);
  }
  let unbeaten = 0;
  let winStreak = 0;
  let winRun = 0;
  run = 0;
  for (const m of mine) {
    const r = resultFor(m.game, m.team);
    run = r === "L" ? 0 : run + 1;
    winRun = r === "W" ? winRun + 1 : 0;
    unbeaten = Math.max(unbeaten, run);
    winStreak = Math.max(winStreak, winRun);
  }

  // Partnerships: games on the same side as me.
  const pair: Record<string, { together: number; wins: number }> = {};
  for (const m of mine) {
    const won = resultFor(m.game, m.team) === "W";
    for (const o of slots) {
      if (o.game.id !== m.game.id || o.playerId === me || o.team !== m.team) continue;
      const p = (pair[o.playerId] ??= { together: 0, wins: 0 });
      p.together++;
      if (won) p.wins++;
    }
  }
  const pairs = Object.entries(pair).map(([playerId, p]) => ({ playerId, name: names[playerId], ...p, rate: p.wins / p.together }));
  const bestPair = pairs
    .filter((p) => p.together >= WRAPPED_MIN_TOGETHER && p.wins > 0)
    .sort((a, b) => b.rate - a.rate || b.together - a.together || a.name.localeCompare(b.name))[0];

  // Opponents: everyone on the other side of a game you played. A nemesis
  // needs 3+ meetings and 2+ wins over you, so one bad night doesn't make
  // one; the same thresholds the other way round for your "favourite".
  const opp: Record<string, { met: number; beatYou: number; youBeat: number }> = {};
  for (const m of mine) {
    const r = resultFor(m.game, m.team);
    for (const o of slots) {
      if (o.game.id !== m.game.id || o.team === m.team) continue;
      const x = (opp[o.playerId] ??= { met: 0, beatYou: 0, youBeat: 0 });
      x.met++;
      if (r === "L") x.beatYou++;
      if (r === "W") x.youBeat++;
    }
  }
  const opps = Object.entries(opp).map(([playerId, x]) => ({ playerId, name: names[playerId], ...x }));
  const nemesis = opps
    .filter((x) => x.met >= 3 && x.beatYou >= 2)
    .sort((a, b) => b.beatYou - a.beatYou || b.beatYou / b.met - a.beatYou / a.met || b.met - a.met || a.name.localeCompare(b.name))[0];
  const favourite = opps
    .filter((x) => x.met >= 3 && x.youBeat >= 2)
    .sort((a, b) => b.youBeat - a.youBeat || b.youBeat / b.met - a.youBeat / a.met || b.met - a.met || a.name.localeCompare(b.name))[0];

  // Your circle: everyone who's been on your side. "New" means you'd
  // never been on the same side before this period.
  const byTogether = [...pairs].sort((a, b) => b.together - a.together || a.name.localeCompare(b.name));
  let newCount: number | null = null;
  // Only meaningful if you'd actually played before this period - in
  // your first month everyone is "new", which says nothing.
  const playedBefore = input.earlierGames?.some((g) => g.bookings.some((b) => b.player_id === me && !b.waiting && b.team));
  if (input.earlierGames && playedBefore) {
    const before = new Set<string>();
    for (const g of input.earlierGames) {
      const myTeam = g.bookings.find((b) => b.player_id === me && !b.waiting)?.team;
      if (!myTeam) continue;
      for (const b of g.bookings) if (!b.waiting && b.team === myTeam && b.player_id !== me) before.add(b.player_id);
    }
    newCount = pairs.filter((p) => !before.has(p.playerId)).length;
  }

  // Best night = biggest winning margin, most goals scored as the tiebreak.
  const wins = mine
    .filter((m) => resultFor(m.game, m.team) === "W")
    .map((m) => {
      const us = m.team === "white" ? m.game.team_white_score! : m.game.team_red_score!;
      const them = m.team === "white" ? m.game.team_red_score! : m.game.team_white_score!;
      return { date: m.game.date, team: m.team, us, them };
    })
    .sort((a, b) => b.us - b.them - (a.us - a.them) || b.us - a.us);

  // MOTM: most votes in a game wins it; ties are joint winners.
  let motmWins = 0;
  let motmVotes = 0;
  for (const g of games) {
    const tally = input.motmTallyByGame[g.id];
    if (!tally) continue;
    const top = Math.max(0, ...Object.values(tally));
    if (top > 0 && tally[me] === top) motmWins++;
    motmVotes += tally[me] ?? 0;
  }
  const promotions = games.filter((g) => g.bookings.some((b) => b.player_id === me && !b.waiting && b.team && b.promoted_at)).length;
  const sellOuts = games.map(soldOutDaysBeforeKickoff).filter((d): d is number => d !== null);

  // Predictions table over the same games.
  const gameById = new Map(games.map((g) => [g.id, g]));
  const predPts: Record<string, number> = {};
  let made = 0;
  let exact = 0;
  for (const p of input.predictions) {
    const g = gameById.get(p.game_id);
    if (!g) continue;
    const pts = predictionPoints(p.predicted_white, p.predicted_red, g.team_white_score!, g.team_red_score!);
    predPts[p.player_id] = (predPts[p.player_id] ?? 0) + pts;
    if (p.player_id === me) {
      made++;
      if (pts === 3) exact++;
    }
  }
  const myPts = predPts[me] ?? 0;

  const myGoals = goalsBy[me] ?? 0;
  const topScorerId = Object.keys(goalsBy).sort((a, b) => goalsBy[b] - goalsBy[a] || (names[a] ?? "").localeCompare(names[b] ?? ""))[0];
  const mostAppsId = Object.keys(apps).sort((a, b) => apps[b] - apps[a] || names[a].localeCompare(names[b]))[0];
  const highest = [...games].sort(
    (a, b) => b.team_white_score! + b.team_red_score! - (a.team_white_score! + a.team_red_score!) || a.date.localeCompare(b.date)
  )[0];

  return {
    firstName: (names[me] ?? "").trim().split(/\s+/)[0] || "You",
    apps: mine.length,
    ofGames: games.length,
    squad: Object.keys(apps).length,
    appsRank: rankIn(apps, mine.length),
    appsRun,
    minutes: mine.length * MATCH_LENGTH_MINUTES,
    ...rec,
    ...colours,
    goals: myGoals,
    goalsRank: myGoals > 0 ? rankIn(goalsBy, myGoals) : null,
    topScorer: topScorerId && goalsBy[topScorerId] > 0 ? { name: names[topScorerId] ?? "", goals: goalsBy[topScorerId] } : null,
    motmWins,
    motmVotes,
    promotions,
    partner: bestPair
      ? { playerId: bestPair.playerId, name: bestPair.name, together: bestPair.together, wins: bestPair.wins, rate: Math.round(bestPair.rate * 100) }
      : null,
    myRate: Math.round((rec.W / mine.length) * 100),
    nemesis: nemesis ?? null,
    favourite: favourite ?? null,
    mostWith: byTogether[0] ? { playerId: byTogether[0].playerId, name: byTogether[0].name, together: byTogether[0].together } : null,
    best: wins[0] ?? null,
    unbeaten,
    winStreak,
    form: mine.map((m) => ({ date: m.game.date, result: resultFor(m.game, m.team) })),
    circle: { count: pairs.length, newCount, faces: byTogether.map((p) => p.playerId) },
    predictions:
      made >= MIN_PREDICTIONS
        ? {
            made,
            points: myPts,
            exact,
            rank: rankIn(predPts, myPts),
            joint: Object.entries(predPts).some(([id, v]) => id !== me && v === myPts),
            of: Object.keys(predPts).length,
          }
        : null,
    club: {
      games: games.length,
      goals: games.reduce((s, g) => s + g.team_white_score! + g.team_red_score!, 0),
      whiteWins: games.filter((g) => g.team_white_score! > g.team_red_score!).length,
      redWins: games.filter((g) => g.team_red_score! > g.team_white_score!).length,
      draws: games.filter((g) => g.team_white_score === g.team_red_score).length,
      highest: highest ? { date: highest.date, white: highest.team_white_score!, red: highest.team_red_score! } : null,
      mostApps: mostAppsId ? { name: names[mostAppsId], apps: apps[mostAppsId] } : null,
      sellOutDays: sellOuts.length ? sellOuts.reduce((a, b) => a + b, 0) / sellOuts.length : null,
    },
  };
}
