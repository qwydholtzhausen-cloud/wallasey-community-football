// A player's trophy cabinet: everything they've won, from rows the app
// already has loaded (games, goals, closed MOTM votes, Player of the Month,
// club records). Pure and DB-free, like lib/records.ts.
import type { ClubRecords } from "./records";

export type TrophyKind = "debut" | "matchball" | "motm" | "potm" | "record" | "apps";

export interface Trophy {
  kind: TrophyKind;
  key: string; // stable per trophy, for "new since you last looked"
  title: string; // "Hat-trick"
  detail: string; // "Thu 8 Oct · Reds 8–2 Whites · 3 goals"
  date: string | null; // YYYY-MM-DD, for ordering
  n?: number; // milestone number, goals, etc.
}

export interface CabinetGame {
  id: string;
  date: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null }[];
}

export const APPS_MILESTONES = [10, 25, 50, 100, 150, 200];

const shortDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthName = (k: string) => new Date(k + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export function computeCabinet(input: {
  playerId: string;
  games: CabinetGame[]; // played, scored games (all seasons), any order
  goals: { game_id: string; player_id: string; goals: number }[];
  motmWinnerIdsByGame: Record<string, string[]>; // closed votes only
  potmMonths: { monthKey: string; winnerIds: string[] }[]; // announced months only
  records: ClubRecords | null; // this season's club records
  team: (t: "white" | "red") => string; // "Whites" / "Reds"
}): Trophy[] {
  const { playerId, team } = input;
  const played = [...input.games]
    .filter((g) => g.team_white_score != null && g.team_red_score != null && g.bookings.some((b) => b.player_id === playerId && !b.waiting))
    .sort((a, b) => a.date.localeCompare(b.date));
  const goalsIn = (gameId: string) => input.goals.filter((r) => r.game_id === gameId && r.player_id === playerId).reduce((s, r) => s + r.goals, 0);
  const score = (g: CabinetGame) => {
    const w = g.team_white_score!, r = g.team_red_score!;
    return w >= r ? `${team("white")} ${w}–${r} ${team("red")}` : `${team("red")} ${r}–${w} ${team("white")}`;
  };
  const out: Trophy[] = [];

  if (played[0]) out.push({ kind: "debut", key: "debut", title: "Debut cap", detail: `First game · ${shortDate(played[0].date)} · ${score(played[0])}`, date: played[0].date });

  for (const g of played) {
    const n = goalsIn(g.id);
    if (n >= 3) out.push({ kind: "matchball", key: `matchball-${g.id}`, title: n === 3 ? "Hat-trick" : `${n}-goal haul`, detail: `${shortDate(g.date)} · ${score(g)} · ${n} goals`, date: g.date, n });
  }

  for (const g of played) {
    if ((input.motmWinnerIdsByGame[g.id] ?? []).includes(playerId)) out.push({ kind: "motm", key: `motm-${g.id}`, title: "Man of the Match", detail: `${shortDate(g.date)} · ${score(g)}`, date: g.date });
  }

  for (const m of input.potmMonths) {
    if (m.winnerIds.includes(playerId)) out.push({ kind: "potm", key: `potm-${m.monthKey}`, title: "Player of the Month", detail: monthName(m.monthKey) + (m.winnerIds.length > 1 ? " (joint)" : ""), date: `${m.monthKey}-28` });
  }

  const r = input.records;
  if (r) {
    const held: { key: string; title: string; detail: string; holders: { playerId: string; date?: string }[] }[] = [];
    if (r.mostGoalsInGame) held.push({ key: "goals", title: "Most goals in a game", detail: `${r.mostGoalsInGame.goals} goals`, holders: r.mostGoalsInGame.holders });
    if (r.mostMotmVotesInGame) held.push({ key: "votes", title: "Most MOTM votes in a game", detail: `${r.mostMotmVotesInGame.votes} votes`, holders: r.mostMotmVotesInGame.holders });
    if (r.winStreak) held.push({ key: "streak", title: "Longest winning run", detail: `${r.winStreak.n} wins in a row`, holders: r.winStreak.holders });
    if (r.gamesInARow) held.push({ key: "inarow", title: "Most games in a row", detail: `${r.gamesInARow.n} games`, holders: r.gamesInARow.holders });
    if (r.motmWins) held.push({ key: "motmwins", title: "Most MOTM wins", detail: `${r.motmWins.n} wins`, holders: r.motmWins.holders });
    for (const h of held) {
      const mine = h.holders.find((x) => x.playerId === playerId);
      if (mine) out.push({ kind: "record", key: `record-${h.key}`, title: "Club record", detail: `${h.title} · ${h.detail}${h.holders.length > 1 ? " (shared)" : ""}`, date: mine.date ?? null });
    }
  }

  APPS_MILESTONES.forEach((m) => {
    if (played.length >= m) out.push({ kind: "apps", key: `apps-${m}`, title: `${m} appearances`, detail: `Reached ${shortDate(played[m - 1].date)}`, date: played[m - 1].date, n: m });
  });

  return out;
}
