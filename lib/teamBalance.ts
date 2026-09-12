// Shared between the in-app "Generate recommended teams" button
// (app/WirralCommunityFootball.tsx) and GaffAI's suggest_balanced_teams
// tool (lib/gaffai/toolImpl.ts) - one source of truth so the two surfaces
// can never silently drift apart. Pure functions only: callers fetch
// their own data (the client already has it loaded; the server tool
// queries Supabase) and pass in plain arrays.

export interface RatedPlayer {
  id: string;
  overall: number;
  position: string | null;
}

// Just the keeper-alternate + greedy-assign-to-the-lower-total step.
// Callers are responsible for the ranking order they pass in (the client
// applies a random jitter/shuffle first so "regenerate" gives a genuinely
// different option each time; GaffAI sorts by raw overall for a
// repeatable chat answer) - this function only ever consumes that order,
// it doesn't produce it.
export function assignToTeams<T extends RatedPlayer>(ranked: T[], keeperStartsWhite = true): { white: T[]; red: T[] } {
  const keepers = ranked.filter((p) => p.position === "keeper");
  const others = ranked.filter((p) => p.position !== "keeper");

  const white: T[] = [];
  const red: T[] = [];
  let whiteTotal = 0;
  let redTotal = 0;

  keepers.forEach((k, i) => {
    const onWhite = keeperStartsWhite ? i % 2 === 0 : i % 2 === 1;
    if (onWhite) {
      white.push(k);
      whiteTotal += k.overall;
    } else {
      red.push(k);
      redTotal += k.overall;
    }
  });

  others.forEach((p) => {
    const sizeDiff = white.length - red.length;
    if (sizeDiff >= 2) {
      red.push(p);
      redTotal += p.overall;
    } else if (sizeDiff <= -2) {
      white.push(p);
      whiteTotal += p.overall;
    } else if (whiteTotal <= redTotal) {
      white.push(p);
      whiteTotal += p.overall;
    } else {
      red.push(p);
      redTotal += p.overall;
    }
  });

  return { white, red };
}

export interface PerformanceStats {
  played: number;
  win_pct: number | null;
  goals_per_game: number;
  motm_per_game: number;
  clean_sheet_rate: number;
}

// Bounded and gated on purpose: win% only counts with 3+ games (a 1-game
// 100% record shouldn't swing anything), goals/MOTM/clean-sheets are
// rates-per-game rather than raw totals (so appearance count alone can't
// inflate someone's score), and the total possible bonus stays well
// below the base rating's own 0-5 range - a nudge, not a replacement for
// the rating itself.
export function performanceBonus(perf: PerformanceStats): number {
  let bonus = 0;
  bonus += Math.min(perf.goals_per_game * 0.4, 0.6);
  bonus += Math.min(perf.motm_per_game * 1.0, 0.6);
  bonus += Math.min(perf.clean_sheet_rate * 0.4, 0.4);
  if (perf.played >= 3 && perf.win_pct != null) bonus += ((perf.win_pct - 50) / 100) * 0.6;
  return bonus;
}

export interface GameForPerformance {
  id: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null }[];
}
export interface GoalRowForPerformance {
  game_id: string;
  player_id: string;
  goals: number;
}
export interface MotmVoteForPerformance {
  game_id: string;
  candidate_id: string;
}

export function computePerformanceStats(
  games: GameForPerformance[],
  goalRows: GoalRowForPerformance[],
  motmVotes: MotmVoteForPerformance[],
  playerIds: string[]
): Record<string, PerformanceStats> {
  const idSet = new Set(playerIds);
  const acc: Record<string, { played: number; won: number; goals: number; motm: number; cleanSheets: number }> = {};
  for (const id of playerIds) acc[id] = { played: 0, won: 0, goals: 0, motm: 0, cleanSheets: 0 };

  const relevantGameIds = new Set<string>();
  for (const g of games) {
    if (g.team_white_score == null || g.team_red_score == null) continue;
    for (const b of g.bookings) {
      if (b.waiting || !b.team || !idSet.has(b.player_id)) continue;
      relevantGameIds.add(g.id);
      const rec = acc[b.player_id];
      rec.played++;
      const diff = b.team === "white" ? g.team_white_score - g.team_red_score : g.team_red_score - g.team_white_score;
      if (diff > 0) rec.won++;
      const concededZero = b.team === "white" ? g.team_red_score === 0 : g.team_white_score === 0;
      if (concededZero) rec.cleanSheets++;
    }
  }

  for (const r of goalRows) {
    if (relevantGameIds.has(r.game_id) && acc[r.player_id]) acc[r.player_id].goals += r.goals;
  }

  const tallyByGame: Record<string, Record<string, number>> = {};
  for (const v of motmVotes) {
    if (!relevantGameIds.has(v.game_id)) continue;
    (tallyByGame[v.game_id] ??= {})[v.candidate_id] = (tallyByGame[v.game_id][v.candidate_id] ?? 0) + 1;
  }
  for (const gid of relevantGameIds) {
    const tally = tallyByGame[gid] ?? {};
    const topVotes = Math.max(0, ...Object.values(tally));
    if (topVotes === 0) continue;
    for (const pid of playerIds) if (tally[pid] === topVotes) acc[pid].motm++;
  }

  const result: Record<string, PerformanceStats> = {};
  for (const id of playerIds) {
    const r = acc[id];
    result[id] = {
      played: r.played,
      win_pct: r.played > 0 ? Math.round((r.won / r.played) * 100) : null,
      goals_per_game: r.played > 0 ? r.goals / r.played : 0,
      motm_per_game: r.played > 0 ? r.motm / r.played : 0,
      clean_sheet_rate: r.played > 0 ? r.cleanSheets / r.played : 0,
    };
  }
  return result;
}
