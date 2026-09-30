import type { SupabaseClient } from "@supabase/supabase-js";
import { kickoffCutoff, nowInLondon, previousMonthKey, nextMonthStart, monthReleaseAt, pseudoUtcFromRealInstant, MATCH_DURATION_MINUTES, MOTM_VOTE_WINDOW_MINUTES } from "../time";
import { computeWrapped, WRAPPED_MIN_APPS, type WrappedGame } from "../wrapped";
import { wrappedThemeFor } from "../wrappedThemes";

// GaffAI's two back-end checks, both plain queries with no AI call:
//  - app health: are the background jobs running, are the tables the app
//    expects actually in the live database, is anything that should have
//    been saved (scores, weather, snapshots) missing, is Monzo connected.
//  - Wrapped check: before a month's Wrapped goes out, is every game's data
//    in, and what will each player's story say.
// Problems show as GaffAI alerts (so they also reach the Monday digest);
// the full reports are the get_app_health and review_wrapped tools.

export interface HealthProblem {
  key: string; // content-addressed like every other nudge key
  text: string;
}

const toMs = (pseudoUtc: string) => new Date(pseudoUtc + ":00Z").getTime();
const HOUR = 3600 * 1000;

// Each cron stamps a notified_events row when it finishes, so a job that
// silently stops (like the GitHub schedule drifting, Sep 2026) shows up.
export async function recordHeartbeat(admin: SupabaseClient, job: "daily" | "frequent") {
  await admin.from("notified_events").upsert({ event_key: `heartbeat-${job}`, notified_at: new Date().toISOString() }, { onConflict: "event_key" });
}

// The tables and columns added by SQL blocks that had to be run by hand -
// game_ratings was missing in prod for a day in Sep 2026 without anyone
// knowing. [table, columns to select]
const EXPECTED: [string, string][] = [
  ["game_ratings", "game_id"],
  ["game_weather", "game_id"],
  ["monthly_snapshots", "month_key"],
  ["booking_cancellations", "player_id"],
  ["app_days", "player_id"],
  ["notification_sends", "player_id"],
  ["wrapped_events", "player_id"],
  ["rating_history", "player_id"],
  ["join_requests", "player_id"],
  ["motm_votes", "tag"],
  ["profiles", "last_active_at, status"],
];

function fmtWhen(realIso: string) {
  const uk = pseudoUtcFromRealInstant(realIso);
  const d = new Date(uk.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${d} ${uk.slice(11)}`;
}
function fmtDate(date: string) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

interface GameRow {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  published: boolean;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean }[];
}

export async function checkAppHealth(admin: SupabaseClient) {
  const now = nowInLondon();
  const problems: HealthProblem[] = [];
  const fine: string[] = [];

  // Background jobs. No heartbeat yet just means it hasn't run since this
  // check shipped, which isn't a problem.
  const { data: beats } = await admin.from("notified_events").select("event_key, notified_at").in("event_key", ["heartbeat-daily", "heartbeat-frequent"]);
  const beat = (job: string) => beats?.find((b) => b.event_key === `heartbeat-${job}`)?.notified_at as string | undefined;
  const jobs: [string, string, number][] = [
    ["frequent", "The 5-minute background job (reminders, payment nudges, Wrapped and Player of the Month releases, Monzo)", 30 * 60 * 1000],
    ["daily", "The daily 7am job (MOTM results, weather, monthly snapshots, the Monday digest)", 27 * HOUR],
  ];
  for (const [job, label, maxAge] of jobs) {
    const last = beat(job);
    if (!last) continue;
    if (Date.now() - new Date(last).getTime() > maxAge) {
      problems.push({ key: `health-job-${job}-${last}`, text: `${label} hasn't run since ${fmtWhen(last)}. Check the Supabase pg_cron schedule (5-minute job) or Vercel's cron (daily job).` });
    } else fine.push(`${job} job last ran ${fmtWhen(last)}`);
  }

  // Tables and columns the app expects.
  const missing: string[] = [];
  await Promise.all(
    EXPECTED.map(async ([table, cols]) => {
      const { error } = await admin.from(table).select(cols).limit(1);
      if (error) missing.push(`${table} (${cols})`);
    })
  );
  const { error: fnError } = await admin.rpc("game_rating_summary", { p_game_id: "00000000-0000-0000-0000-000000000000" });
  if (fnError && /could not find|does not exist|PGRST202/i.test(`${fnError.code} ${fnError.message}`)) missing.push("game_rating_summary() function");
  if (missing.length) {
    missing.sort();
    problems.push({ key: `health-missing-${missing.join(",")}`, text: `Missing from the live database: ${missing.join(", ")}. The features using them fail quietly until their SQL block from supabase/schema.sql is run in Supabase.` });
  } else fine.push("every expected table and column is in the live database");

  // Played games: scores entered, weather saved.
  const { data: gameData } = await admin
    .from("games")
    .select("id, date, kickoff, venue, published, team_white_score, team_red_score, bookings(player_id, waiting)")
    .gte("date", "2026-08-01")
    .lte("date", now.slice(0, 10));
  const played = ((gameData ?? []) as GameRow[]).filter((g) => g.published && g.bookings.some((b) => !b.waiting) && kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= now);

  const noScore = played.filter((g) => g.team_white_score == null && kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES + 18 * 60) <= now);
  if (noScore.length) {
    problems.push({
      key: `health-noscore-${noScore.map((g) => g.id).sort().join(",")}`,
      text: `No score entered for ${noScore.map((g) => `${g.venue} on ${fmtDate(g.date)}`).join(", ")}. Until it is, that game is missing from results, records, Player of the Month and Wrapped.`,
    });
  } else fine.push("every played game has a score");

  const { data: wx, error: wxError } = await admin.from("game_weather").select("game_id");
  if (!wxError) {
    const have = new Set((wx ?? []).map((w) => w.game_id));
    // The daily job saves it the morning after; Open-Meteo keeps 92 days.
    const oldest = kickoffCutoff(now.slice(0, 10), "00:00", -88 * 24 * 60).slice(0, 10);
    const noWx = played.filter((g) => !have.has(g.id) && g.date >= oldest && kickoffCutoff(g.date, g.kickoff, 36 * 60) <= now);
    if (noWx.length) {
      problems.push({
        key: `health-noweather-${noWx.map((g) => g.id).sort().join(",")}`,
        text: `Kickoff weather wasn't saved for ${noWx.map((g) => fmtDate(g.date)).join(", ")}. The weather card needs it, and it can only be fetched for about 90 days after a game.`,
      });
    } else fine.push("weather saved for every recent game");
  }

  // Last month's snapshot (saved by the daily job from the 1st).
  const lastMonth = previousMonthKey(now);
  if (Number(now.slice(8, 10)) >= 3 && played.some((g) => g.date.startsWith(lastMonth))) {
    const { data: snap, error } = await admin.from("monthly_snapshots").select("month_key").eq("month_key", lastMonth);
    if (!error && !snap?.length) problems.push({ key: `health-nosnapshot-${lastMonth}`, text: `${lastMonth}'s monthly snapshot wasn't saved. The end-of-season Wrapped uses these for month-by-month stats.` });
    else if (!error) fine.push(`${lastMonth} snapshot saved`);
  }

  // Monzo, only once it's been connected.
  const { data: monzo } = await admin.from("monzo_tokens").select("expires_at, webhook_registered, updated_at").eq("id", true).maybeSingle();
  if (monzo) {
    if (new Date(monzo.expires_at).getTime() < Date.now()) {
      problems.push({ key: `health-monzo-expired-${monzo.expires_at}`, text: `The Monzo connection expired on ${fmtWhen(monzo.expires_at)} and didn't refresh, so payments aren't being matched automatically. Reconnect Monzo from Club settings.` });
    } else if (!monzo.webhook_registered) {
      problems.push({ key: "health-monzo-webhook", text: "Monzo is connected but its payment webhook isn't registered, so new payments aren't coming in. The 5-minute job retries it; if this stays, reconnect Monzo." });
    } else fine.push("Monzo connected and receiving payments");
  }

  return { checked_at: now, problems: problems.map((p) => p.text), fine, _problems: problems };
}

export async function computeHealthNudges(admin: SupabaseClient): Promise<HealthProblem[]> {
  return (await checkAppHealth(admin))._problems;
}

// ── Wrapped check ──────────────────────────────────────────────────────

// PostgREST caps a request at 1000 rows; these tables pass that over a season.
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

interface WrappedGameRow {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  published: boolean;
  max_players: number;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null; created_at: string; promoted_at: string | null; player: { display_name: string } | null }[];
}

// period: "YYYY-MM" for a month, "YYYY" for the season. Everything a
// player's story is built from, per player, plus what's missing.
export async function checkWrapped(admin: SupabaseClient, period?: string) {
  const now = nowInLondon();
  const key = period && /^\d{4}(-\d{2})?$/.test(period) ? period : now.slice(0, 7);
  const isMonth = key.length === 7;
  const start = isMonth ? `${key}-01` : `${key}-01-01`;
  const end = isMonth ? nextMonthStart(key) : `${Number(key) + 1}-01-01`;

  const [{ data: gameData, error: gamesError }, goals, votes, predictions, { data: ratingRows }, { data: wx }] = await Promise.all([
    admin
      .from("games")
      .select("id, date, kickoff, venue, published, max_players, team_white_score, team_red_score, bookings(player_id, waiting, team, created_at, promoted_at, player:profiles!bookings_player_id_fkey(display_name))")
      .lt("date", end)
      .order("date"),
    fetchAll<{ game_id: string; player_id: string; goals: number }>((f, t) => admin.from("game_stats").select("game_id, player_id, goals").range(f, t)),
    // Without the "Why?" tag column (its SQL not run yet), still read the votes.
    fetchAll<{ game_id: string; candidate_id: string; tag?: string | null }>((f, t) => admin.from("motm_votes").select("game_id, candidate_id, tag").range(f, t)).then(async (rows) =>
      rows.length ? rows : fetchAll<{ game_id: string; candidate_id: string; tag?: string | null }>((f, t) => admin.from("motm_votes").select("game_id, candidate_id").range(f, t))
    ),
    fetchAll<{ game_id: string; player_id: string; predicted_white: number; predicted_red: number }>((f, t) =>
      admin.from("score_predictions").select("game_id, player_id, predicted_white, predicted_red").range(f, t)
    ),
    fetchAll<{ game_id: string; rating: number }>((f, t) => admin.from("game_ratings").select("game_id, rating").gte("created_at", `${start}T00:00:00Z`).range(f, t)).then((data) => ({ data })),
    admin.from("game_weather").select("game_id, temp_c, weather_code"),
  ]);

  if (gamesError) throw new Error(`Couldn't read games: ${gamesError.message}`);
  const all = ((gameData ?? []) as unknown as WrappedGameRow[]).filter((g) => g.published);
  const inPeriod = all.filter((g) => g.date >= start);
  const votingClosed = (g: WrappedGameRow) => kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) <= now;
  const hasPlayers = (g: WrappedGameRow) => g.bookings.some((b) => !b.waiting);
  const played = inPeriod.filter((g) => hasPlayers(g) && kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= now);
  const upcoming = inPeriod.filter((g) => !played.includes(g));
  const last = inPeriod.at(-1);
  const releaseAt = isMonth && last ? monthReleaseAt(last.date, last.kickoff) : null;

  // Per game: what's in and what isn't.
  const wxById = new Map((wx ?? []).map((w) => [w.game_id, w]));
  const ratingsBy: Record<string, number[]> = {};
  for (const r of ratingRows ?? []) (ratingsBy[r.game_id] ??= []).push(r.rating);
  const votesBy: Record<string, number> = {};
  const tagged: Record<string, number> = {};
  for (const v of votes) {
    votesBy[v.game_id] = (votesBy[v.game_id] ?? 0) + 1;
    if (v.tag) tagged[v.game_id] = (tagged[v.game_id] ?? 0) + 1;
  }
  const gameReport = played.map((g) => {
    const r = ratingsBy[g.id] ?? [];
    const gaps: string[] = [];
    if (g.team_white_score == null) gaps.push("no score");
    if (votingClosed(g) && !votesBy[g.id]) gaps.push("no MOTM votes");
    if (!wxById.has(g.id) && kickoffCutoff(g.date, g.kickoff, 36 * 60) <= now) gaps.push("no weather");
    return {
      date: g.date,
      venue: g.venue,
      score: g.team_white_score == null ? null : `${g.team_white_score}-${g.team_red_score}`,
      players: g.bookings.filter((b) => !b.waiting).length,
      motm_votes: votesBy[g.id] ?? 0,
      why_tags: tagged[g.id] ?? 0,
      ratings: r.length,
      average_rating: r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10 : null,
      weather: wxById.has(g.id) ? `${Number(wxById.get(g.id)!.temp_c)}C code ${wxById.get(g.id)!.weather_code}` : null,
      gaps,
    };
  });

  // Every player's story, from the same lib/wrapped.ts the app uses.
  const toWrapped = (g: WrappedGameRow): WrappedGame => ({
    ...g,
    bookings: g.bookings.map((b) => ({ ...b, player: { display_name: b.player?.display_name ?? "Former player" } })),
  });
  const scored = all.filter((g) => g.team_white_score != null && g.team_red_score != null && votingClosed(g)).map(toWrapped);
  const periodGames = scored.filter((g) => g.date >= start);
  const earlier = scored.filter((g) => g.date < start);
  const tallyByGame: Record<string, Record<string, number>> = {};
  for (const v of votes) ((tallyByGame[v.game_id] ??= {})[v.candidate_id] = (tallyByGame[v.game_id]?.[v.candidate_id] ?? 0) + 1);
  const theme = isMonth ? wrappedThemeFor(key) : null;
  const periodIds = new Set(periodGames.map((g) => g.id));

  const playerIds = [...new Set(periodGames.flatMap((g) => g.bookings.filter((b) => !b.waiting && b.team).map((b) => b.player_id)))];
  const players = playerIds.flatMap((playerId) => {
    const d = computeWrapped({ games: periodGames, playerId, goals, motmTallyByGame: tallyByGame, predictions, earlierGames: earlier });
    if (!d) return [];
    const tags: Record<string, number> = {};
    for (const v of votes) if (v.candidate_id === playerId && v.tag && periodIds.has(v.game_id)) tags[v.tag] = (tags[v.tag] ?? 0) + 1;
    const topTag = Object.entries(tags).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const myGames = periodGames.filter((g) => g.bookings.some((b) => b.player_id === playerId && !b.waiting && b.team));
    const ratedGames = myGames.filter((g) => (ratingsBy[g.id]?.length ?? 0) >= 3).length;
    const weatherGames = myGames.filter((g) => wxById.has(g.id)).length;
    return [
      {
        name: myGames[0]?.bookings.find((b) => b.player_id === playerId)?.player.display_name ?? d.firstName,
        intro_line: theme ? `${d.firstName}, ${theme.line({ ...d, topTag })}` : null,
        apps: `${d.apps} of ${d.ofGames}`,
        record: `W${d.W} D${d.D} L${d.L}`,
        win_rate: d.myRate,
        goals: d.goals,
        goals_rank: d.goalsRank,
        motm_wins: d.motmWins,
        motm_votes: d.motmVotes,
        why_tags: tags,
        partner: d.partner ? `${d.partner.name} (${d.partner.wins}/${d.partner.together} won together)` : null,
        nemesis: d.nemesis ? `${d.nemesis.name} (beat them ${d.nemesis.youBeat}, lost ${d.nemesis.beatYou} of ${d.nemesis.met})` : null,
        best_win: d.best ? `${d.best.us}-${d.best.them} on ${d.best.date}` : null,
        heaviest_defeat: d.worst ? `${d.worst.us}-${d.worst.them} on ${d.worst.date}` : null,
        win_streak: d.winStreak,
        unbeaten_run: d.unbeaten,
        predictions: d.predictions ? `${d.predictions.made} made, ${d.predictions.points} pts, rank ${d.predictions.rank} of ${d.predictions.of}` : null,
        games_with_3_plus_ratings: ratedGames,
        games_with_weather: weatherGames,
      },
    ];
  });

  const gaps: string[] = [];
  for (const g of gameReport) if (g.gaps.length) gaps.push(`${fmtDate(g.date)} ${g.venue}: ${g.gaps.join(", ")}`);
  if (played.length && !gameReport.some((g) => g.ratings >= 3)) gaps.push(`No game ${isMonth ? "this month" : "this season"} has 3+ "How was tonight?" ratings yet, so nobody gets the best-rated card.`);
  if (played.some(votingClosed) && !gameReport.some((g) => g.why_tags > 0)) gaps.push('No MOTM vote has a "Why?" tag yet, so nobody gets the Why? card.');

  return {
    period: key,
    theme: theme ? theme.word : null,
    release: releaseAt ? `${releaseAt.slice(0, 10)} ${releaseAt.slice(11)} (8am the morning after the last game's vote closes)` : null,
    games_played: played.length,
    games_still_to_play: upcoming.map((g) => `${g.date} ${g.kickoff} ${g.venue}`),
    players_getting_it: players.length,
    min_games_for_a_wrapped: WRAPPED_MIN_APPS,
    data_gaps: gaps,
    games: gameReport,
    players,
  };
}

// From the 15th of a month until its Wrapped goes out: only when data's
// actually missing, keyed on what's missing so a new gap brings it back.
export async function computeWrappedGapsNudge(admin: SupabaseClient): Promise<HealthProblem | null> {
  const now = nowInLondon();
  if (Number(now.slice(8, 10)) < 15) return null;
  const monthKey = now.slice(0, 7);
  if (monthKey.endsWith("-12")) return null; // December has no monthly Wrapped
  const r = await checkWrapped(admin, monthKey);
  if (!r.games_played || !r.data_gaps.length) return null;
  if (r.release && toMs(r.release.slice(0, 10) + "T" + r.release.slice(11, 16)) <= toMs(now)) return null;
  return {
    key: `wrapped-gaps-${monthKey}-${r.data_gaps.join("|")}`,
    text: `Before this month's Wrapped goes out${r.release ? ` (${fmtDate(r.release.slice(0, 10))} ${r.release.slice(11, 16)})` : ""}: ${r.data_gaps.join(" ")} Ask me to "review this month's Wrapped" for everyone's story.`,
  };
}

// The morning of a month's last game, the daily job asks GaffAI to read
// every player's story and flag anything thin, wrong or awkward, with the
// day still left to fix it. Only the facts go in; nothing is sent to players.
export const WRAPPED_REVIEW_PROMPT = `You are GaffAI, checking every player's monthly Wrapped for the club's admins before it goes out to the players. You're given the month's games and, per player, the facts their story cards are built from (the last game of the month isn't played yet, so it's missing). Write a short report for the admins, plain sentences, no markdown, no emojis:
1. Data gaps that will visibly break or thin out cards (missing scores, weather, votes), and what to do about each.
2. Anything that looks like a bug: numbers that don't add up, a win rate that doesn't match the record, a stat that contradicts another.
3. Players whose story could land badly: very thin (few stats to show), or where a card could read as a dig (heavy defeats, a lopsided nemesis, zero wins). Name them and say which card.
4. One line on the standout stories, so the admins know what the month will feel like.
Keep the whole report under 200 words. If everything is fine, say so in a sentence. Never invent a fact that isn't in the data.`;
