// The First XI matchday programme's facts. Pure and DB-free like
// lib/records.ts, and worked out only from games played before the match,
// so the programme reads the same on the morning of the game and in
// History years later.
import { FIRST_XI_CAPTAINS, FIRST_XI_REDS } from "./firstXI";

export interface ProgGame {
  id: string;
  date: string;
  kickoff: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null; player: { display_name: string } }[];
}

export interface ProgPerson {
  id: string;
  name: string;
}

export interface SideTape {
  apps: number;
  wins: number;
  rate: number;
  goals: number;
  motm: number;
}

export interface Programme {
  game: ProgGame;
  reds: ProgPerson[];
  whites: ProgPerson[];
  captains: string[]; // player ids
  waiting: number;
  firstDate: string | null;
  games: number;
  goals: number;
  players: number;
  hatTricks: number;
  goal100: string | null;
  h2h: { reds: number; whites: number; draws: number; redGoals: number; whiteGoals: number };
  form: { date: string; white: number; red: number }[];
  // How many straight wins the other side had before the latest game, when
  // the latest game was a win (0 otherwise). Counted over every game, not
  // just the six in the form guide.
  runEnded: number;
  tape: { reds: SideTape; whites: SideTape };
  watch: { goalscorer: Stat | null; squadsPick: Stat | null; everPresent: Stat | null };
  originals: ProgPerson[];
  records: {
    biggestWin: { date: string; white: number; red: number } | null;
    mostGoals: { date: string; white: number; red: number } | null;
    bestHaul: { name: string; id: string; goals: number; date: string } | null;
  };
  twoGameNight: string | null;
}

export interface Stat extends ProgPerson {
  apps: number;
  goals: number;
  motm: number;
}

export function computeProgramme(input: {
  game: ProgGame;
  games: ProgGame[]; // any order, any games
  goals: { game_id: string; player_id: string; goals: number }[];
  motmWinnerIdsByGame: Record<string, string[]>;
}): Programme {
  const { game } = input;
  const scored = input.games
    .filter((g) => g.id !== game.id && g.date < game.date && g.team_white_score != null && g.team_red_score != null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
  const ids = new Set(scored.map((g) => g.id));
  const goalRows = input.goals.filter((r) => ids.has(r.game_id) && r.goals > 0);

  const squad = game.bookings.filter((b) => !b.waiting).map((b) => ({ id: b.player_id, name: b.player.display_name, team: b.team }));
  // Each player's side on the game once an admin sets it; anyone without one
  // yet (say, promoted from the waiting list) goes by the announced Reds list.
  const isRed = (p: { name: string; team: string | null }) => (p.team ? p.team === "red" : FIRST_XI_REDS.includes(p.name));
  const byName = (a: ProgPerson, b: ProgPerson) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  const reds = squad.filter(isRed).map(({ id, name }) => ({ id, name })).sort(byName);
  const whites = squad.filter((p) => !isRed(p)).map(({ id, name }) => ({ id, name })).sort(byName);
  const captains = squad.filter((p) => FIRST_XI_CAPTAINS.includes(p.name)).map((p) => p.id);

  // The club so far.
  let runningGoals = 0;
  let goal100: string | null = null;
  for (const g of scored) {
    runningGoals += g.team_white_score! + g.team_red_score!;
    if (!goal100 && runningGoals >= 100) goal100 = g.date;
  }
  const played = new Set(scored.flatMap((g) => g.bookings.filter((b) => !b.waiting).map((b) => b.player_id)));
  const perGame = new Map<string, number>();
  for (const r of goalRows) perGame.set(r.game_id + "|" + r.player_id, (perGame.get(r.game_id + "|" + r.player_id) ?? 0) + r.goals);
  const hatTricks = [...perGame.values()].filter((n) => n >= 3).length;

  const h2h = { reds: 0, whites: 0, draws: 0, redGoals: 0, whiteGoals: 0 };
  for (const g of scored) {
    h2h.redGoals += g.team_red_score!;
    h2h.whiteGoals += g.team_white_score!;
    if (g.team_red_score! > g.team_white_score!) h2h.reds++;
    else if (g.team_white_score! > g.team_red_score!) h2h.whites++;
    else h2h.draws++;
  }
  const form = scored.slice(-6).map((g) => ({ date: g.date, white: g.team_white_score!, red: g.team_red_score! }));
  const winner = (g: (typeof scored)[number]) => (g.team_red_score! > g.team_white_score! ? "red" : g.team_white_score! > g.team_red_score! ? "white" : null);
  let runEnded = 0;
  const latestWin = scored.length ? winner(scored[scored.length - 1]) : null;
  if (latestWin)
    for (let i = scored.length - 2; i >= 0; i--) {
      const w = winner(scored[i]);
      if (w && w !== latestWin) runEnded++;
      else break;
    }

  // Per player.
  const stat = (p: ProgPerson): Stat => {
    let apps = 0;
    let motm = 0;
    for (const g of scored) {
      if (g.bookings.some((b) => b.player_id === p.id && !b.waiting)) apps++;
      if ((input.motmWinnerIdsByGame[g.id] ?? []).includes(p.id)) motm++;
    }
    const goals = goalRows.filter((r) => r.player_id === p.id).reduce((s, r) => s + r.goals, 0);
    return { ...p, apps, goals, motm };
  };
  const side = (people: ProgPerson[]): SideTape => {
    const set = new Set(people.map((p) => p.id));
    let apps = 0;
    let wins = 0;
    let motm = 0;
    for (const g of scored) {
      for (const b of g.bookings) {
        if (b.waiting || !set.has(b.player_id) || !b.team) continue;
        apps++;
        const m = b.team === "white" ? g.team_white_score! - g.team_red_score! : g.team_red_score! - g.team_white_score!;
        if (m > 0) wins++;
      }
      motm += (input.motmWinnerIdsByGame[g.id] ?? []).filter((id) => set.has(id)).length;
    }
    const goals = goalRows.filter((r) => set.has(r.player_id)).reduce((s, r) => s + r.goals, 0);
    return { apps, wins, rate: apps ? Math.round((100 * wins) / apps) : 0, goals, motm };
  };
  const stats = [...reds, ...whites].map(stat);
  const goalscorer = [...stats].sort((a, b) => b.goals - a.goals || b.apps - a.apps)[0] ?? null;
  const squadsPick = stats.filter((s) => s.id !== goalscorer?.id).sort((a, b) => b.motm - a.motm || b.goals - a.goals)[0] ?? null;
  const everPresent = stats.filter((s) => s.id !== goalscorer?.id && s.id !== squadsPick?.id).sort((a, b) => b.apps - a.apps)[0] ?? null;

  const first = scored[0];
  const originals = first ? [...reds, ...whites].filter((p) => first.bookings.some((b) => b.player_id === p.id && !b.waiting)).sort(byName) : [];

  const margin = (g: ProgGame) => Math.abs(g.team_red_score! - g.team_white_score!);
  const total = (g: ProgGame) => g.team_red_score! + g.team_white_score!;
  const big = [...scored].sort((a, b) => margin(b) - margin(a) || a.date.localeCompare(b.date))[0];
  const most = [...scored].sort((a, b) => total(b) - total(a) || a.date.localeCompare(b.date))[0];
  let bestHaul: Programme["records"]["bestHaul"] = null;
  for (const [key, n] of perGame) {
    if (!bestHaul || n > bestHaul.goals) {
      const [gid, pid] = key.split("|");
      const g = scored.find((x) => x.id === gid)!;
      const name = g.bookings.find((b) => b.player_id === pid)?.player.display_name ?? "A player";
      bestHaul = { id: pid, name, goals: n, date: g.date };
    }
  }
  const byDate = new Map<string, number>();
  for (const g of scored) byDate.set(g.date, (byDate.get(g.date) ?? 0) + 1);
  const twoGameNight = [...byDate.entries()].find(([, n]) => n >= 2)?.[0] ?? null;

  return {
    game,
    reds,
    whites,
    captains,
    waiting: game.bookings.filter((b) => b.waiting).length,
    firstDate: first?.date ?? null,
    games: scored.length,
    goals: h2h.redGoals + h2h.whiteGoals,
    players: played.size,
    hatTricks,
    goal100,
    h2h,
    form,
    runEnded,
    tape: { reds: side(reds), whites: side(whites) },
    watch: { goalscorer, squadsPick, everPresent },
    originals,
    records: {
      biggestWin: big ? { date: big.date, white: big.team_white_score!, red: big.team_red_score! } : null,
      mostGoals: most ? { date: most.date, white: most.team_white_score!, red: most.team_red_score! } : null,
      bestHaul,
    },
    twoGameNight,
  };
}
