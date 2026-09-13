import type { SupabaseClient } from "@supabase/supabase-js";
import { kickoffCutoff, nowInLondon, previousMonthKey, MOTM_VOTE_WINDOW_MINUTES, MATCH_DURATION_MINUTES } from "../time";
import { assignToTeams, computePerformanceStats, performanceBonus, type RatedPlayer, type GameForPerformance } from "../teamBalance";
import { buildLeaderboard, topScorers, type ScoredPrediction } from "../predictions";
import { sendPushToUsers } from "../push";
import { defaultPitchCost } from "../pitchCost";

// Same "pretend UTC" trick as everywhere else this pattern's used
// (app/api/cron/frequent/route.ts, app/WirralCommunityFootball.tsx) -
// kickoffCutoff/nowInLondon return real UK wall-clock digits formatted as
// if they were UTC, so parsing with a literal "Z" keeps both sides
// consistent regardless of what timezone this function runs in.
function toMs(pseudoUtc: string) {
  return new Date(pseudoUtc + ":00Z").getTime();
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
export interface SendReminderAction {
  kind: "send_reminder";
  playerId: string;
  playerName: string;
  message: string;
}
export interface PublishFixtureAction {
  kind: "publish_fixture";
  gameId: string;
  venue: string;
  date: string;
}

// Exact split, computed once, rather than leaving "how many total" to two
// separate find_games calls plus the model's own addition - confirmed
// real failure mode (reported 25 total/16 upcoming against an actual 23
// total/14 upcoming). Uses the same "played" definition as the rest of
// the app (kickoff + match duration has passed, pastGames/upcomingGames
// in app/WirralCommunityFootball.tsx) rather than "has a score entered" -
// a played-but-not-yet-scored game is still past, not upcoming.
async function getFixtureCounts(admin: SupabaseClient) {
  const { data } = await admin.from("games").select("date, kickoff");
  const nowMs = toMs(nowInLondon());
  const rows = data ?? [];
  const played = rows.filter((g) => toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) <= nowMs).length;
  return { total: rows.length, played, upcoming: rows.length - played };
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
  query = query.order("date", { ascending: args.sort !== "desc" }).limit(args.limit ?? 100);

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
  query = query.order("display_name").limit(args.limit ?? 100);
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

  const players = (profiles ?? [])
    .filter((p) => !selfSet.has(p.id) || !adminSet.has(p.id))
    .map((p) => ({ name: p.display_name, has_self_rating: selfSet.has(p.id), has_admin_rating: adminSet.has(p.id) }));
  // count is explicit so the model states a number it was handed, not
  // one it counted off the list itself - confirmed real failure mode
  // (misreported 50 instead of 51 for this exact question) worth
  // guarding against everywhere a headline count is likely to get quoted.
  return { count: players.length, players };
}

// Two unbounded flat queries, same shape as find_unrated_players - the
// model tried answering this by cross-referencing find_players against
// find_recent_bookings itself and got it wrong both ways (missed someone
// who'd genuinely never booked, and wrongly flagged four people who had -
// find_recent_bookings is capped/paginated by design, so it's never a
// complete picture of "everyone who's ever booked," only a recent slice.
async function findPlayersWithoutEmergencyContact(admin: SupabaseClient) {
  const [{ data: profiles }, { data: contacts }] = await Promise.all([
    admin.from("profiles").select("id, display_name"),
    admin.from("emergency_contacts").select("player_id"),
  ]);
  const hasContact = new Set((contacts ?? []).map((c) => c.player_id));
  const players = (profiles ?? []).filter((p) => !hasContact.has(p.id)).map((p) => ({ name: p.display_name }));
  return { count: players.length, players };
}

// Same shape of bug this exists to catch as find_unrated_players/
// find_players_without_bookings: push_opt_in (a DB flag) and an actual
// working push_subscriptions row can drift apart - see the real Liam
// bug fixed earlier (lib/push.ts's stale-subscription cleanup never used
// to reset push_opt_in, so the toggle kept showing "on" with nothing
// behind it). That root cause is fixed now, but this gives visibility
// into current state without needing to re-diagnose it by hand again.
async function findPushNotificationIssues(admin: SupabaseClient) {
  const [{ data: profiles }, { data: subs }] = await Promise.all([
    admin.from("profiles").select("id, display_name, push_opt_in"),
    admin.from("push_subscriptions").select("user_id"),
  ]);
  const subscribedSet = new Set((subs ?? []).map((s) => s.user_id));
  const rows = profiles ?? [];
  const optedIn = rows.filter((p) => p.push_opt_in);
  const broken = optedIn.filter((p) => !subscribedSet.has(p.id)).map((p) => ({ id: p.id, name: p.display_name }));
  return {
    total_players: rows.length,
    opted_in: optedIn.length,
    actually_receiving: optedIn.length - broken.length,
    broken_opted_in_but_no_working_subscription: broken,
  };
}

// Exact case-insensitive name match only, deliberately not fuzzy - a
// loose similarity threshold risks false positives (flagging two
// genuinely different players with similar names), where an exact match
// is a strong, safe signal on its own. Confirmed real case: two separate
// "Chris Hogan" profiles, one active and one that's never booked, which
// has already caused two other tools to give wrong answers by silently
// conflating them before this existed.
async function findPossibleDuplicatePlayers(admin: SupabaseClient) {
  const { data: profiles } = await admin.from("profiles").select("id, display_name, role, created_at");
  const byName: Record<string, { id: string; display_name: string; role: string; created_at: string }[]> = {};
  for (const p of profiles ?? []) {
    const key = p.display_name.trim().toLowerCase();
    (byName[key] ??= []).push(p);
  }
  return Object.values(byName)
    .filter((group) => group.length > 1)
    .map((group) => ({
      name: group[0].display_name,
      count: group.length,
      profiles: group.map((p) => ({ role: p.role, created_at: p.created_at })),
    }));
}

async function findPlayersWithoutBookings(admin: SupabaseClient) {
  const [{ data: profiles }, { data: bookings }] = await Promise.all([
    admin.from("profiles").select("id, display_name"),
    admin.from("bookings").select("player_id"),
  ]);
  const bookedSet = new Set((bookings ?? []).map((b) => b.player_id));
  const players = (profiles ?? []).filter((p) => !bookedSet.has(p.id)).map((p) => ({ name: p.display_name }));
  return { count: players.length, players };
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
  const byPlayer: Record<string, { player_id: string; name: string; games: { date: string; venue: string; status: string }[] }> = {};
  for (const b of overdue) {
    const g = Array.isArray(b.games) ? b.games[0] : b.games;
    if (!g) continue;
    byPlayer[b.player_id] ??= { player_id: b.player_id, name: nameOf[b.player_id] ?? "Unknown", games: [] };
    byPlayer[b.player_id].games.push({ date: g.date, venue: g.venue, status: b.status });
  }
  const players = Object.values(byPlayer);
  return { count: players.length, players };
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

async function getClubSettings(admin: SupabaseClient) {
  const { data, error } = await admin
    .from("club_settings")
    .select("team_white_name, team_white_color, team_red_name, team_red_color, default_venue, default_kickoff, default_price, default_pitch, default_max_players")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function findAwards(admin: SupabaseClient, args: { title_contains?: string }) {
  let query = admin.from("awards").select("title, value, note, created_at").order("created_at", { ascending: false });
  if (args.title_contains) query = query.ilike("title", `%${args.title_contains}%`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const awards = data ?? [];
  return { count: awards.length, awards };
}

// player_name_contains resolves to recipient ids FIRST, then filters the
// query itself - filtering the already-limited result set after the fact
// would silently miss matches once there are more than `limit` messages
// total (same class of bug as the earlier never-booked-players fix).
async function findAdminMessages(admin: SupabaseClient, args: { player_name_contains?: string; sender_id?: string; unread_only?: boolean; limit?: number }) {
  let recipientIds: string[] | null = null;
  if (args.player_name_contains) {
    const { data: matches } = await admin.from("profiles").select("id").ilike("display_name", `%${args.player_name_contains}%`);
    recipientIds = (matches ?? []).map((p) => p.id);
    if (recipientIds.length === 0) return { total_count: 0, unread_count: 0, messages: [] };
  }

  // total_count/unread_count come from their own exact head-counts,
  // never from the length of the (limited) returned list - confirmed
  // real failure mode: asked for a total+unread breakdown and the model
  // reported 79 unread against an actual 47, having derived it from a
  // capped 30-row page instead of a real count.
  let totalQuery = admin.from("admin_messages").select("*", { count: "exact", head: true });
  let unreadQuery = admin.from("admin_messages").select("*", { count: "exact", head: true }).is("read_at", null);
  if (recipientIds) {
    totalQuery = totalQuery.in("recipient_id", recipientIds);
    unreadQuery = unreadQuery.in("recipient_id", recipientIds);
  }
  if (args.sender_id) {
    totalQuery = totalQuery.eq("sender_id", args.sender_id);
    unreadQuery = unreadQuery.eq("sender_id", args.sender_id);
  }
  const [{ count: totalCount }, { count: unreadCount }] = await Promise.all([totalQuery, unreadQuery]);

  let query = admin.from("admin_messages").select("recipient_id, sender_id, message, created_at, read_at").order("created_at", { ascending: false }).limit(args.limit ?? 30);
  if (recipientIds) query = query.in("recipient_id", recipientIds);
  if (args.sender_id) query = query.eq("sender_id", args.sender_id);
  if (args.unread_only) query = query.is("read_at", null);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const ids = [...rows.map((r) => r.recipient_id), ...rows.map((r) => r.sender_id).filter((id): id is string => !!id)];
  const nameOf = await namesById(admin, ids);
  const messages = rows.map((r) => ({
    recipient: nameOf[r.recipient_id] ?? "Unknown",
    sender: r.sender_id ? nameOf[r.sender_id] ?? "Unknown" : "System",
    message: r.message,
    sent_at: r.created_at,
    read_at: r.read_at,
    is_read: !!r.read_at,
  }));
  return {
    total_count: totalCount ?? 0,
    unread_count: unreadCount ?? 0,
    note: `messages below is the ${messages.length} most recent${args.unread_only ? " unread" : ""}, not necessarily all of them - use total_count/unread_count for the real totals`,
    messages,
  };
}

async function findUnmatchedPayments(admin: SupabaseClient, args: { limit?: number }) {
  const { data, error } = await admin
    .from("monzo_transactions")
    .select("amount_pence, code, reason, player_id, created_at")
    .eq("outcome", "unmatched")
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 30);
  // The table doesn't exist until Monzo's actually been connected (the
  // holder still needs to complete that guide) - a clean, expected state
  // to explain, not a real error to surface raw.
  if (error?.code === "PGRST205") return { connected: false, count: 0, payments: [] };
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.player_id).filter((id): id is string => !!id)
  );
  const payments = rows.map((r) => ({
    amount: r.amount_pence / 100,
    code: r.code,
    guessed_player: r.player_id ? nameOf[r.player_id] ?? "Unknown" : null,
    reason_unmatched: r.reason,
    received_at: r.created_at,
  }));
  return { connected: true, count: payments.length, payments };
}

// buildLeaderboard/topScorers are the exact same pure functions the
// client uses (lib/predictions.ts) - framework/DB-free by design, so
// reused directly rather than reimplemented here.
async function getPredictionLeaderboard(admin: SupabaseClient, args: { month?: string }) {
  const { data: predictions } = await admin.from("score_predictions").select("player_id, game_id, predicted_white, predicted_red");
  const rows = predictions ?? [];
  if (rows.length === 0) return { leaderboard: [], top_scorers: [] };

  const gameIds = [...new Set(rows.map((r) => r.game_id))];
  const [{ data: games }, nameOf] = await Promise.all([
    admin.from("games").select("id, date, team_white_score, team_red_score").in("id", gameIds),
    namesById(
      admin,
      rows.map((r) => r.player_id)
    ),
  ]);
  const gameById = Object.fromEntries((games ?? []).map((g) => [g.id, g]));

  const scored: ScoredPrediction[] = [];
  for (const r of rows) {
    const g = gameById[r.game_id];
    if (!g || g.team_white_score == null || g.team_red_score == null) continue; // only scored games count
    if (args.month && g.date.slice(0, 7) !== args.month) continue;
    scored.push({
      playerId: r.player_id,
      playerName: nameOf[r.player_id] ?? "Unknown",
      gameId: r.game_id,
      gameDate: g.date,
      predictedWhite: r.predicted_white,
      predictedRed: r.predicted_red,
      actualWhite: g.team_white_score,
      actualRed: g.team_red_score,
    });
  }

  const leaderboard = buildLeaderboard(scored);
  return {
    leaderboard: leaderboard.map((r) => ({ name: r.playerName, points: r.points, exact_calls: r.exactCount, games_guessed: r.gamesGuessed })),
    top_scorers: topScorers(leaderboard).map((r) => r.playerName),
  };
}

// Mirrors potLedger/financeSummary in app/WirralCommunityFootball.tsx
// exactly (lines ~2882-2936) - the real pot balance is NOT just the
// pot_entries table, it's that plus an auto-computed entry per game
// (confirmed paid bookings x price, minus pitch cost), only counting
// games with at least one confirmed booking. Getting this wrong would
// mean reporting a balance nowhere close to the real one.
async function getPotSummary(admin: SupabaseClient) {
  const [{ data: games }, { data: potEntries }] = await Promise.all([
    admin.from("games").select("id, date, venue, price, pitch_cost, bookings(waiting, status, pot_exempt_reason)"),
    admin.from("pot_entries").select("amount, description, category, created_at"),
  ]);

  type GameRow = {
    id: string;
    date: string;
    venue: string;
    price: number;
    pitch_cost: number;
    bookings: { waiting: boolean; status: string; pot_exempt_reason: string | null }[] | null;
  };
  const gameRows = (games ?? []) as GameRow[];

  let grossIncome = 0;
  let pitchExpense = 0;
  const autoEntries: { date: string; amount: number; description: string }[] = [];
  for (const g of gameRows) {
    const bookings = g.bookings ?? [];
    const confirmedTotal = bookings.filter((b) => !b.waiting && b.status === "confirmed").length;
    if (confirmedTotal === 0) continue; // matches the app's own inclusion rule
    const confirmedPaid = bookings.filter((b) => !b.waiting && b.status === "confirmed" && !b.pot_exempt_reason).length;
    const amount = confirmedPaid * g.price - g.pitch_cost;
    grossIncome += confirmedPaid * g.price;
    pitchExpense += g.pitch_cost;
    autoEntries.push({ date: g.date, amount, description: `${g.venue} - ${confirmedPaid} paid x £${g.price} - £${g.pitch_cost} pitch` });
  }
  const autoNet = autoEntries.reduce((sum, e) => sum + e.amount, 0);

  const manualRows = potEntries ?? [];
  const manualNet = manualRows.reduce((sum, e) => sum + e.amount, 0);
  const manualIncome = manualRows.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
  const manualExpense = manualRows.filter((e) => e.amount < 0).reduce((sum, e) => sum + Math.abs(e.amount), 0);

  const byCategory: Record<string, number> = { pitch: pitchExpense, socials: 0, equipment: 0, sponsorship: 0, other: 0 };
  for (const e of manualRows) {
    if (e.amount < 0) byCategory[e.category] = (byCategory[e.category] ?? 0) + Math.abs(e.amount);
  }

  const recentEntries = [
    ...autoEntries.map((e) => ({ ...e, kind: "auto" as const })),
    ...manualRows.map((e) => ({ date: e.created_at.slice(0, 10), amount: e.amount, description: e.description, kind: "manual" as const })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  return {
    total_balance: autoNet + manualNet,
    total_income: grossIncome + manualIncome,
    total_expense: pitchExpense + manualExpense,
    expense_by_category: byCategory,
    recent_entries: recentEntries,
  };
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

async function proposeSendReminder(admin: SupabaseClient, args: { player_id: string; message: string }): Promise<SendReminderAction> {
  const message = (args.message ?? "").trim();
  if (!message) throw new Error("Message can't be empty.");
  const nameOf = await namesById(admin, [args.player_id]);
  const playerName = nameOf[args.player_id];
  if (!playerName) throw new Error("Player not found.");
  return { kind: "send_reminder", playerId: args.player_id, playerName, message };
}

async function proposePublishFixture(admin: SupabaseClient, args: { game_id: string }): Promise<PublishFixtureAction> {
  const { data: game, error } = await admin.from("games").select("id, published, venue, date").eq("id", args.game_id).single();
  if (error || !game) throw new Error("Fixture not found.");
  if (game.published) throw new Error("That fixture's already published.");
  return { kind: "publish_fixture", gameId: game.id, venue: game.venue, date: game.date };
}

// Unlike the four propose_*/confirm_action pairs, these run immediately
// with no confirmation step - a "fact" is GaffAI's own internal note
// about how to talk about the club, not real club data (no booking,
// payment, message, or fixture is ever touched), and forget_standing_fact
// undoes a wrong one instantly. The "act on almost nothing" principle is
// about mutating the club's actual data, which this never does.
async function saveStandingFact(admin: SupabaseClient, args: { fact: string }, callerId?: string) {
  const fact = (args.fact ?? "").trim();
  if (!fact) throw new Error("Fact can't be empty.");
  const { error } = await admin.from("gaffai_facts").insert({ fact, created_by: callerId ?? null });
  if (error) throw new Error(error.message);
  return { saved: true };
}

async function forgetStandingFact(admin: SupabaseClient, args: { fact_id: string }) {
  const { error } = await admin.from("gaffai_facts").delete().eq("id", args.fact_id);
  if (error) throw new Error(error.message);
  return { forgotten: true };
}

async function findClips(admin: SupabaseClient, args: { title_contains?: string; submitted_by_name_contains?: string; limit?: number }) {
  let submitterIds: string[] | null = null;
  if (args.submitted_by_name_contains) {
    const { data: matches } = await admin.from("profiles").select("id").ilike("display_name", `%${args.submitted_by_name_contains}%`);
    submitterIds = (matches ?? []).map((p) => p.id);
    if (submitterIds.length === 0) return { count: 0, clips: [] };
  }

  let query = admin.from("clips").select("id, title, video_url, submitted_by, created_at").order("created_at", { ascending: false }).limit(args.limit ?? 30);
  if (args.title_contains) query = query.ilike("title", `%${args.title_contains}%`);
  if (submitterIds) query = query.in("submitted_by", submitterIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.submitted_by).filter((id): id is string => !!id)
  );
  const clips = rows.map((r) => ({
    title: r.title,
    video_url: r.video_url,
    submitted_by: r.submitted_by ? nameOf[r.submitted_by] ?? "Unknown" : "Unknown",
    submitted_at: r.created_at,
  }));
  return { count: clips.length, clips };
}

// Read-only close of the loop on the flag-a-wrong-answer feature - it
// could always be written to (the client flag button), but nothing
// could ever read it back until now, making it a write-only sink.
async function findFlaggedFeedback(admin: SupabaseClient, args: { limit?: number }) {
  const { data, error } = await admin
    .from("gaffai_feedback")
    .select("question, answer, flagged_by, created_at")
    .order("created_at", { ascending: false })
    .limit(args.limit ?? 30);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const nameOf = await namesById(
    admin,
    rows.map((r) => r.flagged_by).filter((id): id is string => !!id)
  );
  const feedback = rows.map((r) => ({
    question: r.question,
    answer: r.answer,
    flagged_by: r.flagged_by ? nameOf[r.flagged_by] ?? "Unknown" : "Unknown",
    flagged_at: r.created_at,
  }));
  return { count: feedback.length, feedback };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolImplFn = (admin: SupabaseClient, args: any, callerId?: string) => Promise<unknown>;

export const TOOL_IMPL: Record<string, ToolImplFn> = {
  find_games: findGames,
  get_fixture_counts: getFixtureCounts,
  find_recent_bookings: findRecentBookings,
  get_game_detail: getGameDetail,
  find_players: findPlayers,
  get_player_detail: getPlayerDetail,
  get_player_records: getPlayerRecords,
  suggest_balanced_teams: suggestBalancedTeams,
  find_unrated_players: findUnratedPlayers,
  find_players_without_bookings: findPlayersWithoutBookings,
  find_players_without_emergency_contact: findPlayersWithoutEmergencyContact,
  find_push_notification_issues: findPushNotificationIssues,
  find_possible_duplicate_players: findPossibleDuplicatePlayers,
  find_overdue_players: findOverduePlayers,
  get_payment_status: getPaymentStatus,
  get_motm_winner: getMotmWinner,
  get_player_of_month: getPlayerOfMonth,
  find_audit_log_entries: findAuditLogEntries,
  get_club_settings: getClubSettings,
  find_awards: findAwards,
  find_admin_messages: findAdminMessages,
  find_unmatched_payments: findUnmatchedPayments,
  get_prediction_leaderboard: getPredictionLeaderboard,
  get_pot_summary: getPotSummary,
  propose_mark_paid: proposeMarkPaid,
  propose_create_fixture: proposeCreateFixture,
  propose_send_reminder: proposeSendReminder,
  propose_publish_fixture: proposePublishFixture,
  save_standing_fact: saveStandingFact,
  forget_standing_fact: forgetStandingFact,
  find_clips: findClips,
  find_flagged_feedback: findFlaggedFeedback,
};

export interface Nudge {
  key: string;
  text: string;
}

// Content-addressed, not time-addressed - a nudge's key encodes WHICH
// people/game it's about, not when it was computed. Dismissing means
// "I know about this specific set of facts," so it naturally reappears
// only once the facts genuinely change (someone new becomes affected, or
// drops off) - never because of a stored "last seen" timestamp drifting,
// which is exactly what broke the app's earlier "something's new" nav
// dots (removed 2026-08-12) and got the whole feature category pulled
// even after that specific bug was fixed.
function contentKey(prefix: string, ids: string[]): string {
  return `${prefix}-${[...new Set(ids)].sort().join(",")}`;
}

// Only the single soonest upcoming game, and only once kickoff's within
// the same 72h window the app's own payment-warning push already uses
// (app/api/cron/frequent/route.ts) - a game three weeks out with an
// unpaid booking isn't news yet, it's not due. Nudging about it this
// early would reintroduce exactly the too-early nagging the 48h/72h
// payment redesign (this session, earlier) exists to prevent.
async function computeUnpaidNextGameNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const nowMs = toMs(nowInLondon());
  const { data: games } = await admin.from("games").select("id, date, kickoff, venue");
  const upcoming = (games ?? [])
    .filter((g) => toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) > nowMs)
    .sort((a, b) => (a.date + a.kickoff).localeCompare(b.date + b.kickoff));
  const nextGame = upcoming[0];
  if (!nextGame) return null;

  const hoursToKickoff = (toMs(kickoffCutoff(nextGame.date, nextGame.kickoff, 0)) - nowMs) / 3600000;
  if (hoursToKickoff > 72) return null;

  const { data: bookings } = await admin.from("bookings").select("player_id, status, pot_exempt_reason").eq("game_id", nextGame.id).eq("waiting", false);
  const unpaidCount = (bookings ?? []).filter((b) => b.status === "unpaid" && !b.pot_exempt_reason).length;
  if (unpaidCount === 0) return null;

  // Keyed on the game alone (not the affected players) - dismissing this
  // one means "I know, stop nagging about THIS game," not "tell me the
  // moment the count changes." Matches how a human would actually want
  // to acknowledge it.
  return {
    key: `unpaid-${nextGame.id}`,
    text: `${unpaidCount} unpaid for ${nextGame.venue} on ${nextGame.date} (kicks off within 72h).`,
  };
}

async function computeOverdueNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const { players } = await findOverduePlayers(admin);
  if (players.length === 0) return null;
  const ids = players.map((p) => p.player_id);
  const names = players.map((p) => p.name).join(", ");
  return {
    key: contentKey("overdue", ids),
    text: `${players.length} player${players.length === 1 ? "" : "s"} currently blocked from booking (unpaid on a past game): ${names}.`,
  };
}

async function computePushIssuesNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const result = await findPushNotificationIssues(admin);
  const broken = result.broken_opted_in_but_no_working_subscription;
  if (broken.length === 0) return null;
  const ids = broken.map((p) => p.id);
  const names = broken.map((p) => p.name).join(", ");
  return {
    key: contentKey("push-issues", ids),
    text:
      broken.length === 1
        ? `1 player thinks notifications are on but isn't actually receiving them: ${names}.`
        : `${broken.length} players think notifications are on but aren't actually receiving them: ${names}.`,
  };
}

// Only genuinely time-sensitive, same discipline as the unpaid-next-game
// nudge only firing inside a 72h window - a draft fixture dated months
// out and still unpublished is completely normal (it just hasn't been
// announced yet), not something to nag about. A draft whose kickoff is
// within a week and STILL hasn't been published is a real risk though:
// players lose booking lead time every day it sits unpublished. Now that
// GaffAI can actually publish one on request (propose_publish_fixture),
// surfacing this proactively closes the loop instead of only fixing it
// when asked.
async function computeUnpublishedDraftsNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const nowMs = toMs(nowInLondon());
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const { data: games } = await admin.from("games").select("id, date, venue, kickoff").eq("published", false);
  const soonDrafts = (games ?? []).filter((g) => {
    const kickoffMs = toMs(kickoffCutoff(g.date, g.kickoff, 0));
    return kickoffMs > nowMs && kickoffMs - nowMs <= sevenDaysMs;
  });
  if (soonDrafts.length === 0) return null;

  const ids = soonDrafts.map((g) => g.id);
  const labels = soonDrafts.map((g) => `${g.venue} (${g.date})`).join(", ");
  return {
    key: contentKey("unpublished-drafts", ids),
    text:
      soonDrafts.length === 1
        ? `1 draft fixture kicks off within a week and still isn't published: ${labels}.`
        : `${soonDrafts.length} draft fixtures kick off within a week and still aren't published: ${labels}.`,
  };
}

// A strict, unbroken decline over a fixed run length - not an average or
// a percentage threshold - is deliberately the simplest signal that
// won't fire on ordinary week-to-week noise. This club plays maybe one
// or two games a week, so there's rarely enough data for anything
// looser (a moving average, a slope fit) to be reliable; a flat streak
// of "every one of the last N was lower than the one before" is legible
// and hard to trigger by chance at this scale.
function isDecliningRun(valuesOldestFirst: number[], runLength: number): boolean {
  if (valuesOldestFirst.length < runLength) return false;
  const recent = valuesOldestFirst.slice(-runLength);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] >= recent[i - 1]) return false;
  }
  return true;
}

const TREND_RUN_LENGTH = 3;

// Unlike the four point-in-time nudges above (all "is this true right
// now"), this looks across several past games for a genuine trend -
// closer to the original MOTM-pattern analysis that kicked off this
// whole project than anything else GaffAI computes unprompted. Keyed on
// the specific games forming the decline, so it naturally clears the
// moment a newer game breaks the streak (a different set of games is a
// different key, not the same nudge staying dismissed forever).
async function computeMotmTurnoutTrendNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const nowMs = toMs(nowInLondon());
  const { data: games } = await admin.from("games").select("id, date, kickoff");
  const played = (games ?? [])
    .filter((g) => toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) <= nowMs)
    .sort((a, b) => (a.date + a.kickoff).localeCompare(b.date + b.kickoff));
  const recentGames = played.slice(-TREND_RUN_LENGTH);
  if (recentGames.length < TREND_RUN_LENGTH) return null;

  const gameIds = recentGames.map((g) => g.id);
  const { data: votes } = await admin.from("motm_votes").select("game_id").in("game_id", gameIds);
  const countByGame: Record<string, number> = Object.fromEntries(gameIds.map((id) => [id, 0]));
  for (const v of votes ?? []) countByGame[v.game_id] = (countByGame[v.game_id] ?? 0) + 1;
  const counts = gameIds.map((id) => countByGame[id]);

  if (!isDecliningRun(counts, TREND_RUN_LENGTH)) return null;

  return {
    key: contentKey("motm-turnout-decline", gameIds),
    text: `MOTM voting turnout has dropped for ${TREND_RUN_LENGTH} games running (${counts.join(" → ")} votes) - might be worth a reminder to vote.`,
  };
}

async function computeAttendanceTrendNudge(admin: SupabaseClient): Promise<Nudge | null> {
  const nowMs = toMs(nowInLondon());
  const { data: games } = await admin.from("games").select("id, date, kickoff, bookings(waiting)");
  type GameWithBookings = { id: string; date: string; kickoff: string; bookings: { waiting: boolean }[] | null };
  const played = ((games ?? []) as GameWithBookings[])
    .filter((g) => toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) <= nowMs)
    .sort((a, b) => (a.date + a.kickoff).localeCompare(b.date + b.kickoff));
  const recentGames = played.slice(-TREND_RUN_LENGTH);
  if (recentGames.length < TREND_RUN_LENGTH) return null;

  // Same "confirmed_count" definition find_games itself uses - every
  // non-waiting-list booking counts as a real spot, regardless of its
  // payment status (unpaid/pending/confirmed are payment states of an
  // actual booked spot, not attendance states).
  const counts = recentGames.map((g) => (g.bookings ?? []).filter((b) => !b.waiting).length);
  if (!isDecliningRun(counts, TREND_RUN_LENGTH)) return null;

  return {
    key: contentKey(
      "attendance-decline",
      recentGames.map((g) => g.id)
    ),
    text: `Attendance has dropped for ${TREND_RUN_LENGTH} games running (${counts.join(" → ")} players) - worth checking in with the group?`,
  };
}

// Pure deterministic queries, same as suggest_balanced_teams - no
// Anthropic API call anywhere in here, so computing this on every app
// load costs nothing beyond a handful of fast Supabase round trips.
export async function computeNudges(admin: SupabaseClient): Promise<Nudge[]> {
  const [unpaid, overdue, pushIssues, unpublishedDrafts, motmTrend, attendanceTrend] = await Promise.all([
    computeUnpaidNextGameNudge(admin),
    computeOverdueNudge(admin),
    computePushIssuesNudge(admin),
    computeUnpublishedDraftsNudge(admin),
    computeMotmTurnoutTrendNudge(admin),
    computeAttendanceTrendNudge(admin),
  ]);
  const candidates = [unpaid, overdue, pushIssues, unpublishedDrafts, motmTrend, attendanceTrend].filter((n): n is Nudge => n !== null);
  if (candidates.length === 0) return [];

  const { data: dismissed } = await admin.from("gaffai_dismissed_nudges").select("nudge_key");
  const dismissedSet = new Set((dismissed ?? []).map((d) => d.nudge_key));
  return candidates.filter((n) => !dismissedSet.has(n.key));
}

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

// Mirrors sendAdminMessage exactly (app/WirralCommunityFootball.tsx
// ~line 1911): same admin_messages insert shape, same push payload as
// app/api/push/notify-admin-message/route.ts (sendPushToUsers imported
// directly rather than hit over HTTP, since this already runs
// server-side with the service-role client). Logged as "GaffAI sent
// reminder message" rather than reusing the manual flow's plain "Sent
// message" label - same reasoning as the other two GaffAI actions: a
// typed-language-to-mutation pathway is a different, less visible trust
// surface than the obvious in-app composer, even though the end state
// (a row in admin_messages) is identical.
export async function executeSendReminder(admin: SupabaseClient, callerId: string, action: SendReminderAction) {
  const { data, error } = await admin
    .from("admin_messages")
    .insert({ recipient_id: action.playerId, sender_id: callerId, message: action.message })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const excerpt = action.message.length > 80 ? `${action.message.slice(0, 77)}...` : action.message;
  await admin.from("audit_log").insert({ actor_id: callerId, action: "GaffAI sent reminder message", details: `${action.playerName} — "${excerpt}"` });

  if (data) {
    await sendPushToUsers([action.playerId], {
      title: "Message from an admin",
      body: action.message.length > 100 ? `${action.message.slice(0, 97)}...` : action.message,
      url: "/",
    });
  }
}

// Narrower than the manual saveGame (app/WirralCommunityFootball.tsx
// ~line 2147), which doubles as "save edits to any fixture, published or
// not" - propose_publish_fixture already rejected an already-published
// game at proposal time, so this only ever does a draft->published
// transition and can always set published_at fresh (saveGame's
// conditional "only set published_at the first time" logic doesn't
// apply here - there is no "already published" path to protect).
// published_at is what the frequent cron polls to decide when to
// announce a fixture, so this alone is enough for the normal
// announcement flow to pick it up.
export async function executePublishFixture(admin: SupabaseClient, callerId: string, action: PublishFixtureAction) {
  const { data: game } = await admin.from("games").select("id, published").eq("id", action.gameId).single();
  if (!game) throw new Error("That fixture no longer exists.");
  if (game.published) throw new Error("That fixture's already published.");

  const { error } = await admin.from("games").update({ published: true, published_at: new Date().toISOString() }).eq("id", action.gameId);
  if (error) throw new Error(error.message);

  await admin.from("audit_log").insert({ actor_id: callerId, action: "GaffAI published fixture", details: `${action.venue} — ${action.date}` });
}
