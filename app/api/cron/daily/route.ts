import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sendPushToUsers, sendPushBroadcast } from "../../../../lib/push";
import { kickoffCutoff, nowInLondon, previousMonthKey, MOTM_VOTE_WINDOW_MINUTES, MATCH_DURATION_MINUTES } from "../../../../lib/time";
import { generateWeeklyDigest } from "../../../../lib/gaffai/digest";

interface CronBooking {
  player_id: string;
  status: string;
  waiting: boolean;
}
interface CronGame {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: CronBooking[];
}

function fmtDate(date: string) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// Runs once daily (Vercel Hobby's cron minimum interval - see the kickoff
// reminder note in the backlog for why that one isn't here yet). Handles
// the two notifications that are fine on a daily cadence: MOTM winners for
// games whose voting window has just closed, and Player of the Month once
// a new calendar month begins.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceKey);

  const nowUk = nowInLondon();

  const { data: games } = await admin
    .from("games")
    .select("id, date, kickoff, venue, team_white_score, team_red_score, bookings(player_id, status, waiting)")
    .not("team_white_score", "is", null)
    .not("team_red_score", "is", null);
  const typedGames = (games ?? []) as unknown as CronGame[];

  const { data: votes } = await admin.from("motm_votes").select("game_id, candidate_id");
  const allVotes = votes ?? [];

  const { data: notified } = await admin.from("notified_events").select("event_key");
  const notifiedKeys = new Set((notified ?? []).map((r) => r.event_key));

  async function markNotified(key: string) {
    await admin.from("notified_events").insert({ event_key: key });
  }

  // --- MOTM winner announcements ---
  for (const g of typedGames) {
    const key = `motm-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    if (kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk) continue;

    const gameVotes = allVotes.filter((v) => v.game_id === g.id);
    if (gameVotes.length === 0) {
      await markNotified(key);
      continue;
    }

    const tally: Record<string, number> = {};
    for (const v of gameVotes) tally[v.candidate_id] = (tally[v.candidate_id] ?? 0) + 1;
    // Joint winners when the top count is shared, same as the app.
    const topCount = Math.max(...Object.values(tally));
    const winnerIds = Object.keys(tally).filter((id) => tally[id] === topCount);

    const { data: winnerProfiles } = await admin.from("profiles").select("id, display_name").in("id", winnerIds);
    const names = (winnerProfiles ?? []).map((p) => p.display_name).join(" & ");
    const score = `${g.team_white_score}–${g.team_red_score}`;
    const votesLabel = `${topCount} of ${gameVotes.length} vote${gameVotes.length === 1 ? "" : "s"}`;
    // Everyone who actually played, not just payment-confirmed ones - same
    // reasoning as the kickoff reminder. The winner gets their own message.
    const playedIds = g.bookings.filter((b) => !b.waiting).map((b) => b.player_id);

    await sendPushToUsers(
      winnerIds.filter((id) => playedIds.includes(id)),
      {
        title: winnerIds.length > 1 ? "You're joint Man of the Match 🏆" : "You're Man of the Match 🏆",
        body: `${votesLabel} from the ${score} game on ${fmtDate(g.date)}. Nice one.`,
        url: "/",
      }
    );
    await sendPushToUsers(
      playedIds.filter((id) => !winnerIds.includes(id)),
      {
        title: "Man of the Match 🏆",
        body: names ? `${names} won Man of the Match for the ${score} game on ${fmtDate(g.date)}.` : "Man of the Match has been decided.",
        url: "/",
      }
    );
    await markNotified(key);
  }

  // --- Player of the Month ---
  const monthKey = previousMonthKey(nowUk);
  const potmKey = `potm-${monthKey}`;
  if (!notifiedKeys.has(potmKey)) {
    const monthGames = typedGames.filter((g) => g.date.startsWith(monthKey));
    if (monthGames.length >= 2) {
      const wins: Record<string, number> = {};
      const voteTotals: Record<string, number> = {};
      for (const g of monthGames) {
        const gameVotes = allVotes.filter((v) => v.game_id === g.id);
        if (gameVotes.length === 0) continue;
        const tally: Record<string, number> = {};
        for (const v of gameVotes) tally[v.candidate_id] = (tally[v.candidate_id] ?? 0) + 1;
        const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        const topCount = ranked[0][1];
        for (const [id, count] of ranked) {
          voteTotals[id] = (voteTotals[id] ?? 0) + count;
          if (count === topCount) wins[id] = (wins[id] ?? 0) + 1;
        }
      }
      const contenders = Object.keys(wins);
      if (contenders.length > 0) {
        const maxWins = Math.max(...contenders.map((id) => wins[id]));
        let leaders = contenders.filter((id) => wins[id] === maxWins);
        if (leaders.length > 1) {
          const maxVotes = Math.max(...leaders.map((id) => voteTotals[id] ?? 0));
          leaders = leaders.filter((id) => (voteTotals[id] ?? 0) === maxVotes);
        }
        const { data: winners } = await admin.from("profiles").select("display_name").in("id", leaders);
        const names = (winners ?? []).map((w) => w.display_name).join(" & ");
        const monthLabel = new Date(monthKey + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });

        if (names) {
          await sendPushBroadcast({
            title: "Player of the Month 🏅",
            body: `${names} is Player of the Month for ${monthLabel}.`,
            url: "/",
          });
        }
      }
    }
    await markNotified(potmKey);
  }

  // --- GaffAI weekly digest for admins, Monday mornings only ---
  // Reuses notified_events for idempotency exactly like MOTM/POTM above -
  // no backfill needed since the key is forward-looking only (today's
  // date), never reinterpreting historical rows the way a "this is new"
  // checkpoint over existing data would. Wrapped in try/catch so a
  // digest failure (e.g. the Anthropic call timing out) can never take
  // down the MOTM/POTM logic above it, which has already completed by
  // this point regardless.
  const todayStr = nowUk.slice(0, 10);
  const isMonday = new Date(todayStr + "T00:00:00Z").getUTCDay() === 1;
  const digestKey = `gaffai-digest-${todayStr}`;
  if (isMonday && !notifiedKeys.has(digestKey)) {
    try {
      const { data: adminProfiles } = await admin.from("profiles").select("id").in("role", ["admin", "co-owner", "owner"]);
      const adminIds = (adminProfiles ?? []).map((p) => p.id);
      if (adminIds.length > 0) {
        const digestText = await generateWeeklyDigest(admin);
        await admin.from("gaffai_conversations").insert(adminIds.map((id) => ({ admin_id: id, role: "assistant" as const, text: digestText })));
        await sendPushToUsers(adminIds, {
          title: "GaffAI's weekly digest",
          body: digestText.length > 100 ? `${digestText.slice(0, 97)}...` : digestText,
          url: "/",
        });
      }
      await markNotified(digestKey);
    } catch (err) {
      console.error("GaffAI weekly digest failed", err);
    }
  }

  // --- Season history for the end-of-season Wrapped ---
  // Each part is wrapped on its own so a failure (or the tables not
  // existing yet) never touches the notifications above.
  try {
    await saveGameWeather(admin, typedGames, nowUk);
  } catch (err) {
    console.error("Saving game weather failed", err);
  }
  try {
    await saveMonthlySnapshots(admin, typedGames, allVotes, nowUk);
  } catch (err) {
    console.error("Saving monthly snapshots failed", err);
  }

  return NextResponse.json({ ok: true });
}

// Weather at kickoff for every played game that doesn't have it yet. The
// fixture card's forecast is fetched live and never stored, so this is
// the only record of what the night was like. Open-Meteo's forecast API
// keeps the last 92 days, which also covers everything played so far.
async function saveGameWeather(admin: SupabaseClient, games: CronGame[], nowUk: string) {
  const { data: saved, error } = await admin.from("game_weather").select("game_id");
  if (error) return; // table not created yet
  const have = new Set((saved ?? []).map((r) => r.game_id));
  const oldest = new Date(Date.UTC(+nowUk.slice(0, 4), +nowUk.slice(5, 7) - 1, +nowUk.slice(8, 10) - 90)).toISOString().slice(0, 10);
  const todo = games.filter(
    (g) => !have.has(g.id) && g.date >= oldest && kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= nowUk
  );
  if (todo.length === 0) return;
  const res = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=53.43&longitude=-3.06&hourly=temperature_2m,weathercode&past_days=92&forecast_days=1&timezone=Europe%2FLondon"
  );
  if (!res.ok) return;
  const data = await res.json();
  const times: string[] = data?.hourly?.time ?? [];
  const rows = todo.flatMap((g) => {
    const i = times.indexOf(`${g.date}T${g.kickoff.slice(0, 2)}:00`);
    if (i < 0) return [];
    return [{ game_id: g.id, temp_c: data.hourly.temperature_2m[i], weather_code: data.hourly.weathercode[i] }];
  });
  if (rows.length > 0) await admin.from("game_weather").upsert(rows, { onConflict: "game_id" });
}

// One snapshot per finished month, as it stood: Player of the Month (same
// tie-breaks as the app: MOTM wins, then votes, then goals), the Whites v
// Reds table and the top scorers. Fills any missing month from the first
// game up to last month, so August is taken on the first run.
async function saveMonthlySnapshots(
  admin: SupabaseClient,
  games: CronGame[],
  votes: { game_id: string; candidate_id: string }[],
  nowUk: string
) {
  const { data: saved, error } = await admin.from("monthly_snapshots").select("month_key");
  if (error) return; // table not created yet
  const have = new Set((saved ?? []).map((r) => r.month_key));
  const lastFinished = previousMonthKey(nowUk);
  const months = [...new Set(games.map((g) => g.date.slice(0, 7)))].filter((m) => m <= lastFinished && !have.has(m)).sort();
  if (months.length === 0) return;

  const { data: stats } = await admin.from("game_stats").select("game_id, player_id, goals");
  const { data: profiles } = await admin.from("profiles").select("id, display_name");
  const nameOf = (id: string) => (profiles ?? []).find((p) => p.id === id)?.display_name ?? "";

  for (const month of months) {
    const monthGames = games.filter((g) => g.date.startsWith(month));
    const ids = new Set(monthGames.map((g) => g.id));
    const goals: Record<string, number> = {};
    for (const r of stats ?? []) if (ids.has(r.game_id) && r.goals > 0) goals[r.player_id] = (goals[r.player_id] ?? 0) + r.goals;

    const wins: Record<string, number> = {};
    const voteTotals: Record<string, number> = {};
    for (const g of monthGames) {
      const tally: Record<string, number> = {};
      for (const v of votes) if (v.game_id === g.id) tally[v.candidate_id] = (tally[v.candidate_id] ?? 0) + 1;
      const top = Math.max(0, ...Object.values(tally));
      for (const [id, c] of Object.entries(tally)) {
        voteTotals[id] = (voteTotals[id] ?? 0) + c;
        if (top > 0 && c === top) wins[id] = (wins[id] ?? 0) + 1;
      }
    }
    let leaders = Object.keys(wins);
    for (const score of [(id: string) => wins[id] ?? 0, (id: string) => voteTotals[id] ?? 0, (id: string) => goals[id] ?? 0]) {
      if (leaders.length <= 1) break;
      const best = Math.max(...leaders.map(score));
      leaders = leaders.filter((id) => score(id) === best);
    }

    const side = () => ({ played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, points: 0 });
    const white = side();
    const red = side();
    for (const g of monthGames) {
      const w = g.team_white_score!;
      const r = g.team_red_score!;
      white.played++; red.played++;
      white.goalsFor += w; white.goalsAgainst += r; red.goalsFor += r; red.goalsAgainst += w;
      if (w > r) { white.won++; white.points += 3; red.lost++; }
      else if (r > w) { red.won++; red.points += 3; white.lost++; }
      else { white.drawn++; red.drawn++; white.points++; red.points++; }
    }

    const data = {
      games: monthGames.length,
      goals: monthGames.reduce((sum, g) => sum + g.team_white_score! + g.team_red_score!, 0),
      // Needs 2+ games, same as the Player of the Month card.
      playerOfTheMonth:
        monthGames.length >= 2
          ? leaders.map((id) => ({ id, name: nameOf(id), motmWins: wins[id] ?? 0, votes: voteTotals[id] ?? 0, goals: goals[id] ?? 0 }))
          : [],
      table: { white, red },
      topScorers: Object.entries(goals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, n]) => ({ id, name: nameOf(id), goals: n })),
    };
    await admin.from("monthly_snapshots").insert({ month_key: month, data });
  }
}
