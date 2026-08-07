import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers, sendPushBroadcast } from "../../../../lib/push";
import { kickoffCutoff, nowInLondon, previousMonthKey, MOTM_VOTE_WINDOW_MINUTES } from "../../../../lib/time";

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
    const [winnerId] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];

    const { data: winnerProfile } = await admin.from("profiles").select("display_name").eq("id", winnerId).single();
    const confirmedIds = g.bookings.filter((b) => !b.waiting && b.status === "confirmed").map((b) => b.player_id);

    await sendPushToUsers(confirmedIds, {
      title: "Man of the Match 🏆",
      body: winnerProfile ? `${winnerProfile.display_name} won Man of the Match for ${g.venue}.` : "Man of the Match has been decided.",
      url: "/",
    });
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

  return NextResponse.json({ ok: true });
}
