import type { SupabaseClient } from "@supabase/supabase-js";
import { kickoffCutoff, nowInLondon, previousMonthKey, MOTM_VOTE_WINDOW_MINUTES, MATCH_DURATION_MINUTES } from "../time";
import { assignToTeams, computePerformanceStats, performanceBonus, type RatedPlayer, type GameForPerformance } from "../teamBalance";

// Same "pretend UTC" trick as everywhere else this pattern's used
// (app/api/cron/frequent/route.ts, app/WirralCommunityFootball.tsx) -
// kickoffCutoff/nowInLondon return real UK wall-clock digits formatted as
// if they were UTC, so parsing with a literal "Z" keeps both sides
// consistent regardless of what timezone this function runs in.
function toMs(pseudoUtc: string) {
  return new Date(pseudoUtc + ":00Z").getTime();
}

// Mirrors the pure function of the same name in app/WirralCommunityFootball.tsx
// (line ~1217) - a 2-line constant, not worth a shared-lib refactor for.
function defaultPitchCost(date: string) {
  return date >= "2026-09-07" ? 45 : 55;
}

// Deliberately not using embedded-relationship syntax (profiles!x_fkey(...))
// anywhere in this file - most call sites here would need a table to have
// exactly one FK to profiles or the exact constraint name, and getting
// that wrong is a silent runtime bug in a tool the model is calling live.
// One extra round trip to resolve names in JS is a non-issue at this
// traffic level and removes the risk entirely.
async function namesById(admin: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return {};
  const { data } = await admin.from("profiles").select("id, display_name").in("id", uniqueIds);
  return Object.fromEntries((data ?? []).map((p) => [p.id, p.display_name]));
}

interface RatingSummary {
  scale: 5;
  fitness: number;
  attack: number;
  defence: number;
  goalkeeping: number;
  overall_out_of_5: number;
  position: string | null;
  source: "self" | "admin";
}

// Batch version of the same self/admin merge logic as the client's
// ratingByPlayer useMemo (admin overrides self, normalized /2) - this is
// what actually fixed the "highest rated player in the next fixture"
// question, which previously required one get_player_detail call per
// roster player (12-16 round trips) and both timed out and, when it
// didn't, reasoned off an incomplete, inconsistent partial sample.
// overall_out_of_5 matches the app's own definition everywhere it's used
// (fitness+attack+defence)/3 - goalkeeping deliberately excluded, same
// as generateBalancedTeams/nextConfirmedRatings. Both the field name and
// the explicit scale:5 exist so the model can't report this as if it
// were the raw /10 admin scale - admins enter ratings out of 10, but
// every number here (whether it started as self or admin) has already
// been normalized down for direct comparison.
async function ratingsById(admin: SupabaseClient, ids: string[]): Promise<Record<string, RatingSummary | null>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const result: Record<string, RatingSummary | null> = {};
  for (const id of uniqueIds) result[id] = null;
  if (uniqueIds.length === 0) return result;

  const [{ data: selfRatings }, { data: adminRatings }] = await Promise.all([
    admin.from("player_self_ratings").select("player_id, fitness, attack, defence, goalkeeping, position").in("player_id", uniqueIds),
    admin.from("player_admin_ratings").select("player_id, fitness, attack, defence, goalkeeping, position").in("player_id", uniqueIds),
  ]);

  for (const r of selfRatings ?? []) {
    result[r.player_id] = {
      scale: 5,
      fitness: r.fitness,
      attack: r.attack,
      defence: r.defence,
      goalkeeping: r.goalkeeping,
      overall_out_of_5: (r.fitness + r.attack + r.defence) / 3,
      position: r.position,
      source: "self",
    };
  }
  for (const r of adminRatings ?? []) {
    const fitness = r.fitness / 2;
    const attack = r.attack / 2;
    const defence = r.defence / 2;
    const goalkeeping = r.goalkeeping / 2;
    result[r.player_id] = { scale: 5, fitness, attack, defence, goalkeeping, overall_out_of_5: (fitness + attack + defence) / 3, position: r.position, source: "admin" };
  }
  return result;
}

export interface MarkPaidAction {
  kind: "mark_paid";
  bookingId: string;
  playerName: string;
  gameLabel: string;
  amount: number;
}
export interface CreateFixtureAction {
  kind: "create_fixture";
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  maxPlayers: number;
}

async function findGames(
  admin: SupabaseClient,
  args: { date_from?: string; date_to?: string; venue_contains?: string; published_only?: boolean; sort?: "asc" | "desc"; limit?: number }
) {
  let query = admin
    .from("games")
    .select("id, date, kickoff, venue, price, published, team_white_score, team_red_score, bookings(status, waiting)");
  if (args.date_from) query = query.gte("date", args.date_from);
  if (args.date_to) query = query.lte("date", args.date_to);
  if (args.venue_contains) query = query.ilike("venue", `%${args.venue_contains}%`);
  if (args.published_only) query = query.eq("published", true);
  query = query.order("date", { ascending: args.sort !== "desc" }).limit(args.limit ?? 20);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((g) => {
    const bookings = (g.bookings ?? []) as { status: string; waiting: boolean }[];
    const confirmed = bookings.filter((b) => !b.waiting);
    return {
      id: g.id,
      date: g.date,
      kickoff: g.kickoff,
      venue: g.venue,
      price: g.price,
      published: g.published,
      team_white_score: g.team_white_score,
      team_red_score: g.team_red_score,
      confirmed_count: confirmed.length,
      unpaid_count: confirmed.filter((b) => b.status === "unpaid").length,
      pending_count: confirmed.filter((b) => b.status === "pending").length,
      waiting_count: bookings.filter((b) => b.waiting).length,
    };
  });
}

// find_games/get_game_detail both require a specific game to already be
// known - this is the general "most recent activity" primitive that
// isn't scoped to one fixture, e.g. "who booked most recently" or "last
// N people to book" across the whole club.
async function findRecentBookings(admin: SupabaseClient, args: { limit?: number; game_id?: string; waiting?: boolean }) {
  let query = admin
    .from("bookings")
    .select("player_id, status, waiting, created_at, promoted_at, games(date, venue)")
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 10);
  if (args.game_id) query = query.eq("game_id", args.game_id);
  if (args.waiting !== undefined) query = query.eq("waiting", args.waiting);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  type Row = { player_id: string; status: string; waiting: boolean; created_at: string; promoted_at: string | null; games: { date: string; venue: string } | { date: string; venue: string }[] | null };
  const rows = (data ?? []) as Row[];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.player_id)
  );
  return rows.map((r) => {
    const g = Array.isArray(r.games) ? r.games[0] : r.games;
    return {
      player_name: nameOf[r.player_id] ?? "Unknown",
      game_date: g?.date ?? null,
      game_venue: g?.venue ?? null,
      status: r.status,
      waiting: r.waiting,
      booked_at: r.created_at,
      promoted_at: r.promoted_at,
    };
  });
}

async function getMotmWinnerRaw(admin: SupabaseClient, gameId: string) {
  const { data: game } = await admin.from("games").select("id, date, kickoff").eq("id", gameId).single();
  if (!game) throw new Error("Game not found");

  const votingOpen = toMs(kickoffCutoff(game.date, game.kickoff, MOTM_VOTE_WINDOW_MINUTES)) > toMs(nowInLondon());
  if (votingOpen) return { game_id: gameId, voting_open: true, winners: [] as { name: string; votes: number }[], total_votes: 0 };

  const { data: votes } = await admin.from("motm_votes").select("candidate_id").eq("game_id", gameId);
  const rows = votes ?? [];
  const tally: Record<string, number> = {};
  for (const v of rows) tally[v.candidate_id] = (tally[v.candidate_id] ?? 0) + 1;
  const nameOf = await namesById(admin, Object.keys(tally));

  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const topVotes = ranked[0]?.[1] ?? 0;
  const winners = topVotes > 0 ? ranked.filter(([, count]) => count === topVotes).map(([id, count]) => ({ name: nameOf[id] ?? "Unknown", votes: count })) : [];

  return { game_id: gameId, voting_open: false, winners, total_votes: rows.length };
}

async function getMotmWinner(admin: SupabaseClient, args: { game_id: string }) {
  return getMotmWinnerRaw(admin, args.game_id);
}

async function getGameDetail(admin: SupabaseClient, args: { game_id: string }) {
  const { data: game, error } = await admin
    .from("games")
    .select("id, date, kickoff, venue, pitch, price, max_players, published, team_white_score, team_red_score")
    .eq("id", args.game_id)
    .single();
  if (error || !game) throw new Error("Game not found");

  const { data: bookingsRaw } = await admin
    .from("bookings")
    .select("id, player_id, status, waiting, team, pot_exempt_reason, created_at, promoted_at")
    .eq("game_id", args.game_id);
  const bookingRows = bookingsRaw ?? [];
  const playerIds = bookingRows.map((b) => b.player_id);
  const [bookingNames, bookingRatings] = await Promise.all([namesById(admin, playerIds), ratingsById(admin, playerIds)]);
  const bookings = bookingRows.map((b) => ({
    booking_id: b.id,
    player_name: bookingNames[b.player_id] ?? "Unknown",
    status: b.status,
    waiting: b.waiting,
    team: b.team,
    pot_exempt: !!b.pot_exempt_reason,
    created_at: b.created_at,
    promoted_at: b.promoted_at,
    // Already normalized/merged (admin overrides self, /2 scaled) -
    // don't re-derive this per player, use it directly, e.g. for
    // "who's rated highest in this game's roster."
    rating: bookingRatings[b.player_id] ?? null,
  }));

  const { data: goalRowsRaw } = await admin.from("game_stats").select("player_id, goals, own_goals").eq("game_id", args.game_id);
  const scorerRows = (goalRowsRaw ?? []).filter((r) => r.goals > 0 || r.own_goals > 0);
  const scorerNames = await namesById(
    admin,
    scorerRows.map((r) => r.player_id)
  );
  const scorers = scorerRows.map((r) => ({ player_name: scorerNames[r.player_id] ?? "Unknown", goals: r.goals, own_goals: r.own_goals }));

  const motm = await getMotmWinnerRaw(admin, args.game_id);

  return { game, bookings, scorers, motm };
}

async function findPlayers(admin: SupabaseClient, args: { name_contains?: string; role?: string; limit?: number }) {
  let query = admin.from("profiles").select("id, display_name, role, push_opt_in");
  if (args.name_contains) query = query.ilike("display_name", `%${args.name_contains}%`);
  if (args.role) query = query.eq("role", args.role);
  query = query.order("display_name").limit(args.limit ?? 20);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function getPlayerDetail(admin: SupabaseClient, args: { player_id: string }) {
  const { data: profile } = await admin.from("profiles").select("id, display_name, role, push_opt_in").eq("id", args.player_id).single();
  if (!profile) throw new Error("Player not found");

  const nowUkStr = nowInLondon();
  const nowMs = toMs(nowUkStr);
  const seasonYear = nowUkStr.slice(0, 4);

  const [selfRatingRes, adminRatingRes, contactRes, overdueRes, bookingsRes] = await Promise.all([
    admin.from("player_self_ratings").select("fitness, attack, defence, goalkeeping, position").eq("player_id", args.player_id).maybeSingle(),
    admin.from("player_admin_ratings").select("fitness, attack, defence, goalkeeping, position").eq("player_id", args.player_id).maybeSingle(),
    admin.from("emergency_contacts").select("contact_name, contact_phone").eq("player_id", args.player_id).maybeSingle(),
    admin.rpc("has_overdue_payment", { check_player_id: args.player_id }),
    admin.from("bookings").select("game_id, waiting, games(date, kickoff)").eq("player_id", args.player_id),
  ]);

  const adminRating = adminRatingRes.data;
  // Admin ratings are entered out of 10 for finer precision - normalize
  // to the same /5 scale self-ratings use, mirroring the ratingByPlayer
  // useMemo in app/WirralCommunityFootball.tsx (lines ~3286-3297), so
  // nothing downstream (or GaffAI's own phrasing) treats them as
  // directly comparable raw numbers.
  const normalizedAdminRating = adminRating
    ? {
        scale: 5 as const,
        fitness: adminRating.fitness / 2,
        attack: adminRating.attack / 2,
        defence: adminRating.defence / 2,
        goalkeeping: adminRating.goalkeeping / 2,
        overall_out_of_5: (adminRating.fitness / 2 + adminRating.attack / 2 + adminRating.defence / 2) / 3,
        position: adminRating.position,
      }
    : null;

  type BookingWithGame = { game_id: string; waiting: boolean; games: { date: string; kickoff: string } | { date: string; kickoff: string }[] | null };
  const bookings = (bookingsRes.data ?? []) as BookingWithGame[];
  const pastSeasonGameIds: string[] = [];
  for (const b of bookings) {
    const g = Array.isArray(b.games) ? b.games[0] : b.games;
    if (!g || b.waiting) continue;
    if (g.date.slice(0, 4) !== seasonYear) continue;
    if (toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) > nowMs) continue; // hasn't happened yet
    pastSeasonGameIds.push(b.game_id);
  }
  const apps = pastSeasonGameIds.length;

  let goals = 0;
  let motmRecognitions = 0;
  if (pastSeasonGameIds.length > 0) {
    const { data: goalRows } = await admin.from("game_stats").select("goals").eq("player_id", args.player_id).in("game_id", pastSeasonGameIds);
    goals = (goalRows ?? []).reduce((sum, r) => sum + r.goals, 0);

    const { data: votesForGames } = await admin.from("motm_votes").select("game_id, candidate_id").in("game_id", pastSeasonGameIds);
    const byGame: Record<string, Record<string, number>> = {};
    for (const v of votesForGames ?? []) {
      (byGame[v.game_id] ??= {})[v.candidate_id] = (byGame[v.game_id][v.candidate_id] ?? 0) + 1;
    }
    for (const gid of pastSeasonGameIds) {
      const tally = byGame[gid] ?? {};
      const topVotes = Math.max(0, ...Object.values(tally));
      if (topVotes > 0 && tally[args.player_id] === topVotes) motmRecognitions++;
    }
  }

  return {
    id: profile.id,
    display_name: profile.display_name,
    role: profile.role,
    push_opt_in: profile.push_opt_in,
    self_rating: selfRatingRes.data ?? null,
    admin_rating_normalized_to_5: normalizedAdminRating,
    emergency_contact: contactRes.data ?? null,
    has_overdue_payment: !!overdueRes.data,
    season_year: seasonYear,
    season_apps: apps,
    season_goals: goals,
    season_motm_recognitions: motmRecognitions,
  };
}

// Mirrors has_overdue_payment()'s own SQL (supabase/schema.sql) as one
// query rather than N RPC calls: waiting=false, status != 'confirmed',
// and the game's calendar date has already passed (that function compares
// against a plain date, not a kickoff-cutoff time - matching it exactly).
// Two flat queries regardless of squad size, rather than get_player_detail
// per player - that's the one that timed out asking this exact question
// against a ~40-player squad (each detail call runs 5 sub-queries; N of
// those blows both the tool-round cap and the request timeout).
// Mirrors myRecord's exact definition in app/WirralCommunityFootball.tsx
// (line ~3611) - all-time by default (that's what the app's own record
// is), a booking only counts as "played" if it has a team assigned (not
// just booked), and win% is round(won/played*100). One flat pass over
// every scored game rather than per-player, so "who's got the highest
// win percentage" or "who's lost the most" - across everyone, not one
// player - is a single call, not one per player.
// Splitting a squad into two balanced sides is a real constraint problem
// (keep sizes even, alternate keepers, minimize the rating gap) - not
// something to leave to the model's own reasoning. Tested it freeform
// first and it duplicated players across both teams and reported an
// "8.5/5" average on a 5-point scale. assignToTeams/computePerformanceStats
// are shared with generateBalancedTeams in app/WirralCommunityFootball.tsx
// (the real in-app "Generate recommended teams" button) via lib/teamBalance
// - one source of truth for both surfaces. This version skips that
// function's random jitter/shuffle - deterministic on purpose, so the
// same question asked twice gives the same answer instead of a different
// "recommended" split each time. "overall" here is the rated /5 score
// plus the bounded performance bonus, not the raw rating alone.
async function suggestBalancedTeams(admin: SupabaseClient, args: { game_id: string }) {
  const { data: bookingsRaw } = await admin.from("bookings").select("player_id").eq("game_id", args.game_id).eq("waiting", false);
  const bookingRows = bookingsRaw ?? [];
  if (bookingRows.length === 0) throw new Error("No confirmed players found for that game.");
  const playerIds = bookingRows.map((b) => b.player_id);

  const [nameOf, ratings, { data: games }, { data: goalRows }, { data: motmVotesRaw }] = await Promise.all([
    namesById(admin, playerIds),
    ratingsById(admin, playerIds),
    admin.from("games").select("id, team_white_score, team_red_score, bookings(player_id, waiting, team)"),
    admin.from("game_stats").select("game_id, player_id, goals"),
    admin.from("motm_votes").select("game_id, candidate_id"),
  ]);

  const performance = computePerformanceStats(
    (games ?? []) as GameForPerformance[],
    goalRows ?? [],
    motmVotesRaw ?? [],
    playerIds
  );

  const players: RatedPlayer[] = playerIds.map((id) => {
    const base = ratings[id]?.overall_out_of_5 ?? 3; // unrated defaults to a neutral 3, same as generateBalancedTeams
    const overall = Math.max(0, Math.min(5, base + performanceBonus(performance[id])));
    return { id, overall, position: ratings[id]?.position ?? null };
  });

  const ranked = [...players].sort((a, b) => b.overall - a.overall);
  const { white, red } = assignToTeams(ranked);

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const label = (p: RatedPlayer) => ({ name: nameOf[p.id] ?? "Unknown", overall_out_of_5: round1(p.overall) });
  const avg = (side: RatedPlayer[]) => (side.length ? round1(side.reduce((sum, p) => sum + p.overall, 0) / side.length) : null);

  return {
    white: white.map(label),
    red: red.map(label),
    white_avg_out_of_5: avg(white),
    red_avg_out_of_5: avg(red),
  };
}

async function getPlayerRecords(admin: SupabaseClient, args: { player_id?: string; season_year?: string }) {
  const { data: games } = await admin
    .from("games")
    .select("date, team_white_score, team_red_score, bookings(player_id, waiting, team)")
    .not("team_white_score", "is", null)
    .not("team_red_score", "is", null);

  type Row = { date: string; team_white_score: number | null; team_red_score: number | null; bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null }[] | null };
  const rows = (games ?? []) as Row[];

  const byPlayer: Record<string, { played: number; won: number; drawn: number; lost: number }> = {};
  for (const g of rows) {
    if (g.team_white_score == null || g.team_red_score == null) continue;
    if (args.season_year && g.date.slice(0, 4) !== args.season_year) continue;
    for (const b of g.bookings ?? []) {
      if (b.waiting || !b.team) continue;
      if (args.player_id && b.player_id !== args.player_id) continue;
      const rec = (byPlayer[b.player_id] ??= { played: 0, won: 0, drawn: 0, lost: 0 });
      rec.played++;
      const diff = b.team === "white" ? g.team_white_score - g.team_red_score : g.team_red_score - g.team_white_score;
      if (diff > 0) rec.won++;
      else if (diff < 0) rec.lost++;
      else rec.drawn++;
    }
  }

  const ids = Object.keys(byPlayer);
  const nameOf = await namesById(admin, ids);
  return ids.map((id) => {
    const r = byPlayer[id];
    return { name: nameOf[id] ?? "Unknown", played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, win_pct: r.played > 0 ? Math.round((r.won / r.played) * 100) : null };
  });
}

async function findUnratedPlayers(admin: SupabaseClient, args: { role?: string }) {
  let profileQuery = admin.from("profiles").select("id, display_name, role");
  if (args.role) profileQuery = profileQuery.eq("role", args.role);
  const [{ data: profiles }, { data: selfRatings }, { data: adminRatings }] = await Promise.all([
    profileQuery,
    admin.from("player_self_ratings").select("player_id"),
    admin.from("player_admin_ratings").select("player_id"),
  ]);

  const selfSet = new Set((selfRatings ?? []).map((r) => r.player_id));
  const adminSet = new Set((adminRatings ?? []).map((r) => r.player_id));

  return (profiles ?? [])
    .filter((p) => !selfSet.has(p.id) || !adminSet.has(p.id))
    .map((p) => ({ name: p.display_name, has_self_rating: selfSet.has(p.id), has_admin_rating: adminSet.has(p.id) }));
}

async function findOverduePlayers(admin: SupabaseClient) {
  const todayUk = nowInLondon().slice(0, 10);
  const { data } = await admin.from("bookings").select("player_id, status, games(date, venue)").eq("waiting", false).neq("status", "confirmed");

  type Row = { player_id: string; status: string; games: { date: string; venue: string } | { date: string; venue: string }[] | null };
  const rows = (data ?? []) as Row[];
  const overdue = rows.filter((b) => {
    const g = Array.isArray(b.games) ? b.games[0] : b.games;
    return g && g.date < todayUk;
  });

  const nameOf = await namesById(
    admin,
    overdue.map((b) => b.player_id)
  );
  const byPlayer: Record<string, { name: string; games: { date: string; venue: string; status: string }[] }> = {};
  for (const b of overdue) {
    const g = Array.isArray(b.games) ? b.games[0] : b.games;
    if (!g) continue;
    byPlayer[b.player_id] ??= { name: nameOf[b.player_id] ?? "Unknown", games: [] };
    byPlayer[b.player_id].games.push({ date: g.date, venue: g.venue, status: b.status });
  }
  return Object.values(byPlayer);
}

async function getPaymentStatus(admin: SupabaseClient, args: { game_id: string }) {
  const { data: game } = await admin.from("games").select("id, date, venue, price").eq("id", args.game_id).single();
  if (!game) throw new Error("Game not found");

  const { data: bookingsRaw } = await admin
    .from("bookings")
    .select("player_id, status, pot_exempt_reason")
    .eq("game_id", args.game_id)
    .eq("waiting", false);
  const rows = bookingsRaw ?? [];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.player_id)
  );
  const named = rows.map((r) => ({ name: nameOf[r.player_id] ?? "Unknown", status: r.status, exempt: !!r.pot_exempt_reason }));

  return {
    game: { date: game.date, venue: game.venue, price: game.price },
    unpaid: named.filter((r) => r.status === "unpaid" && !r.exempt).map((r) => r.name),
    pending: named.filter((r) => r.status === "pending" && !r.exempt).map((r) => r.name),
    confirmed: named.filter((r) => r.status === "confirmed" || r.exempt).map((r) => r.name),
  };
}

// Mirrors the playerOfMonth useMemo in app/WirralCommunityFootball.tsx
// exactly: wins -> total votes -> total goals, in that order, computed
// against real DB data rather than the client's already-loaded state.
async function getPlayerOfMonth(admin: SupabaseClient, args: { month?: string }) {
  const monthKey = args.month ?? previousMonthKey(nowInLondon());
  const [y, m] = monthKey.split("-").map(Number);
  const nextMonthKey = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;

  const { data: games } = await admin
    .from("games")
    .select("id, date, kickoff, team_white_score, team_red_score")
    .gte("date", `${monthKey}-01`)
    .lt("date", `${nextMonthKey}-01`);

  const nowMs = toMs(nowInLondon());
  const monthGames = (games ?? []).filter(
    (g) => g.team_white_score != null && g.team_red_score != null && toMs(kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES)) <= nowMs
  );
  if (monthGames.length < 2) return { month: monthKey, winners: [], note: "Not enough qualifying games played that month yet." };

  const gameIds = monthGames.map((g) => g.id);
  const [{ data: votes }, { data: goalRows }] = await Promise.all([
    admin.from("motm_votes").select("game_id, candidate_id").in("game_id", gameIds),
    admin.from("game_stats").select("player_id, goals").in("game_id", gameIds),
  ]);

  const wins: Record<string, number> = {};
  const voteTotals: Record<string, number> = {};
  const goalTotals: Record<string, number> = {};
  for (const r of goalRows ?? []) goalTotals[r.player_id] = (goalTotals[r.player_id] ?? 0) + r.goals;

  const tallyByGame: Record<string, Record<string, number>> = {};
  for (const v of votes ?? []) {
    (tallyByGame[v.game_id] ??= {})[v.candidate_id] = (tallyByGame[v.game_id][v.candidate_id] ?? 0) + 1;
  }
  for (const g of monthGames) {
    const tally = tallyByGame[g.id] ?? {};
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const topCount = ranked[0]?.[1] ?? 0;
    for (const [playerId, count] of ranked) {
      voteTotals[playerId] = (voteTotals[playerId] ?? 0) + count;
      if (topCount > 0 && count === topCount) wins[playerId] = (wins[playerId] ?? 0) + 1;
    }
  }

  const contenders = Object.keys(wins);
  if (contenders.length === 0) return { month: monthKey, winners: [], note: "No MOTM votes recorded that month yet." };
  const maxWins = Math.max(...contenders.map((id) => wins[id]));
  let leaders = contenders.filter((id) => wins[id] === maxWins);
  if (leaders.length > 1) {
    const maxVotes = Math.max(...leaders.map((id) => voteTotals[id] ?? 0));
    leaders = leaders.filter((id) => (voteTotals[id] ?? 0) === maxVotes);
  }
  if (leaders.length > 1) {
    const maxGoals = Math.max(...leaders.map((id) => goalTotals[id] ?? 0));
    leaders = leaders.filter((id) => (goalTotals[id] ?? 0) === maxGoals);
  }

  const nameOf = await namesById(admin, leaders);
  return {
    month: monthKey,
    winners: leaders.map((id) => ({ name: nameOf[id] ?? "Unknown", wins: wins[id], votes: voteTotals[id] ?? 0, goals: goalTotals[id] ?? 0 })),
  };
}

async function findAuditLogEntries(
  admin: SupabaseClient,
  args: { action_contains?: string; player_name_contains?: string; date_from?: string; date_to?: string; limit?: number }
) {
  let query = admin.from("audit_log").select("actor_id, action, details, created_at").order("created_at", { ascending: false }).limit(args.limit ?? 20);
  if (args.action_contains) query = query.ilike("action", `%${args.action_contains}%`);
  if (args.player_name_contains) query = query.ilike("details", `%${args.player_name_contains}%`);
  if (args.date_from) query = query.gte("created_at", args.date_from);
  if (args.date_to) query = query.lte("created_at", args.date_to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.actor_id).filter((id): id is string => !!id)
  );
  return rows.map((r) => ({ action: r.action, details: r.details, when: r.created_at, by: r.actor_id ? nameOf[r.actor_id] ?? "Unknown" : "System" }));
}

async function proposeMarkPaid(admin: SupabaseClient, args: { booking_id: string }): Promise<MarkPaidAction> {
  const { data: booking, error } = await admin.from("bookings").select("id, status, player_id, games(date, venue, price)").eq("id", args.booking_id).single();
  if (error || !booking) throw new Error("Booking not found");
  if (booking.status === "confirmed") throw new Error("That booking is already marked as paid.");

  const game = Array.isArray(booking.games) ? booking.games[0] : booking.games;
  if (!game) throw new Error("Couldn't find the game for that booking.");
  const nameOf = await namesById(admin, [booking.player_id]);

  return {
    kind: "mark_paid",
    bookingId: booking.id,
    playerName: nameOf[booking.player_id] ?? "Unknown",
    gameLabel: `${game.venue} — ${game.date}`,
    amount: game.price,
  };
}

async function proposeCreateFixture(
  admin: SupabaseClient,
  args: { date: string; kickoff?: string; venue?: string; pitch?: string; price?: number; max_players?: number }
): Promise<CreateFixtureAction> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("Date must be in YYYY-MM-DD format.");

  const { data: settings } = await admin
    .from("club_settings")
    .select("default_venue, default_kickoff, default_price, default_pitch, default_max_players")
    .single();

  return {
    kind: "create_fixture",
    date: args.date,
    kickoff: args.kickoff ?? settings?.default_kickoff ?? "19:00",
    venue: args.venue ?? settings?.default_venue ?? "New venue",
    pitch: args.pitch ?? settings?.default_pitch ?? "8-a-side",
    price: args.price ?? settings?.default_price ?? 5,
    maxPlayers: args.max_players ?? settings?.default_max_players ?? 16,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolImplFn = (admin: SupabaseClient, args: any) => Promise<unknown>;

export const TOOL_IMPL: Record<string, ToolImplFn> = {
  find_games: findGames,
  find_recent_bookings: findRecentBookings,
  get_game_detail: getGameDetail,
  find_players: findPlayers,
  get_player_detail: getPlayerDetail,
  get_player_records: getPlayerRecords,
  suggest_balanced_teams: suggestBalancedTeams,
  find_unrated_players: findUnratedPlayers,
  find_overdue_players: findOverduePlayers,
  get_payment_status: getPaymentStatus,
  get_motm_winner: getMotmWinner,
  get_player_of_month: getPlayerOfMonth,
  find_audit_log_entries: findAuditLogEntries,
  propose_mark_paid: proposeMarkPaid,
  propose_create_fixture: proposeCreateFixture,
};

// Never reachable via any tool schema the model can emit - the only two
// code paths that mutate anything, called directly by the route handler
// when (and only when) the incoming request is literally
// { type: "confirm_action" }.
export async function executeMarkPaid(admin: SupabaseClient, callerId: string, action: MarkPaidAction) {
  const { data: booking } = await admin.from("bookings").select("id, status").eq("id", action.bookingId).single();
  if (!booking) throw new Error("That booking no longer exists.");
  if (booking.status === "confirmed") throw new Error("That booking is already marked as paid.");

  const { error } = await admin
    .from("bookings")
    .update({ status: "confirmed", confirmed_by: callerId, confirmed_at: new Date().toISOString() })
    .eq("id", action.bookingId);
  if (error) throw new Error(error.message);

  // Deliberately logged even though the equivalent manual click isn't
  // (see setBookingStatus's own comment on why routine confirms are kept
  // out of the audit log) - GaffAI executing this from typed language is
  // a different, less directly-visible trust surface than the obvious
  // status-dot click, and deserves its own trail specifically for that
  // reason, even though the end state is identical.
  await admin.from("audit_log").insert({ actor_id: callerId, action: "GaffAI marked booking paid", details: `${action.playerName} — ${action.gameLabel}` });
}

export async function executeCreateFixture(admin: SupabaseClient, callerId: string, action: CreateFixtureAction) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(action.date)) throw new Error("Invalid date.");

  const { error } = await admin.from("games").insert({
    date: action.date,
    kickoff: action.kickoff,
    venue: action.venue,
    pitch: action.pitch,
    price: action.price,
    max_players: action.maxPlayers,
    pitch_cost: defaultPitchCost(action.date),
    published: false,
  });
  if (error) throw new Error(error.message);

  await admin.from("audit_log").insert({ actor_id: callerId, action: "GaffAI created draft fixture", details: `${action.venue} — ${action.date}` });
}
