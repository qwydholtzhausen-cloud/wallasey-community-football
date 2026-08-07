import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";
import { kickoffCutoff, nowInLondon } from "../../../../lib/time";

// Both sides of this comparison come from the same "pretend UTC" trick in
// lib/time.ts (real UK wall-clock digits, formatted as if they were UTC) -
// parsing with a literal "Z" here keeps that consistent regardless of
// whatever timezone this function happens to execute in.
function toMs(pseudoUtc: string) {
  return new Date(pseudoUtc + ":00Z").getTime();
}

interface Booking {
  player_id: string;
  status: string;
  waiting: boolean;
  team: "white" | "red" | null;
}

// Triggered every ~15 min by a GitHub Actions schedule (not Vercel Cron -
// Hobby's cron only runs once a day, too coarse for "kickoff in 1 hour").
// The 45-70 min window is wider than the 15 min polling interval to absorb
// GitHub Actions' own scheduling jitter; notified_events is what actually
// guarantees each game only gets one reminder, not the window's precision.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceKey);

  const nowMs = toMs(nowInLondon());

  const { data: games } = await admin.from("games").select("id, date, kickoff, venue, bookings(player_id, status, waiting, team)");
  const { data: settings } = await admin.from("club_settings").select("team_white_name, team_red_name").single();
  const whiteLabel = settings?.team_white_name || "Whites";
  const redLabel = settings?.team_red_name || "Reds";

  const { data: notified } = await admin.from("notified_events").select("event_key");
  const notifiedKeys = new Set((notified ?? []).map((r) => r.event_key));

  for (const g of games ?? []) {
    const key = `kickoff-${g.id}`;
    if (notifiedKeys.has(key)) continue;

    const minutesUntilKickoff = (toMs(kickoffCutoff(g.date, g.kickoff, 0)) - nowMs) / 60000;
    if (minutesUntilKickoff < 45 || minutesUntilKickoff > 70) continue;

    const confirmed = (g.bookings as Booking[]).filter((b) => !b.waiting && b.status === "confirmed");
    if (confirmed.length === 0) {
      await admin.from("notified_events").insert({ event_key: key });
      continue;
    }

    await Promise.all(
      confirmed.map((b) => {
        // Falls back to a generic message when team assignment hasn't
        // happened yet for this game, rather than saying "you're on null".
        const teamLabel = b.team === "white" ? whiteLabel : b.team === "red" ? redLabel : null;
        const body = teamLabel
          ? `You're on ${teamLabel} — kickoff at ${g.venue} is in about an hour.`
          : `Match is in about an hour at ${g.venue}.`;
        return sendPushToUsers([b.player_id], { title: "Kickoff in 1 hour ⏰", body, url: "/" });
      })
    );

    await admin.from("notified_events").insert({ event_key: key });
  }

  return NextResponse.json({ ok: true });
}
