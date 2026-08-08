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

interface GameRef {
  id: string;
  venue: string;
  date: string;
  price: number;
}

interface GameRefWithKickoff extends GameRef {
  kickoff: string;
}

function fmtDateLabel(date: string) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// Triggered every ~15 min by a GitHub Actions schedule (not Vercel Cron -
// Hobby's cron only runs once a day, too coarse for anything time-based on
// this scale). Two independent jobs share the one poll: the kickoff+team
// reminder, and the payment-needed nudge - both use notified_events for
// idempotency rather than the window/delay timing being exact.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: notified } = await admin.from("notified_events").select("event_key");
  const notifiedKeys = new Set((notified ?? []).map((r) => r.event_key));
  async function markNotified(key: string) {
    await admin.from("notified_events").insert({ event_key: key });
  }

  // --- Kickoff + team reminder, ~1hr before kickoff ---
  const nowMs = toMs(nowInLondon());
  const { data: games } = await admin.from("games").select("id, date, kickoff, venue, bookings(player_id, status, waiting, team)");
  const { data: settings } = await admin.from("club_settings").select("team_white_name, team_red_name").single();
  const whiteLabel = settings?.team_white_name || "Whites";
  const redLabel = settings?.team_red_name || "Reds";

  for (const g of games ?? []) {
    const key = `kickoff-${g.id}`;
    if (notifiedKeys.has(key)) continue;

    const minutesUntilKickoff = (toMs(kickoffCutoff(g.date, g.kickoff, 0)) - nowMs) / 60000;
    if (minutesUntilKickoff < 45 || minutesUntilKickoff > 70) continue;

    // Everyone with an actual spot, not just payment-confirmed ones -
    // payment confirmation is an admin action that often lags well behind
    // kickoff, so gating on it here would mean most players never get
    // this reminder at all.
    const confirmed = (g.bookings as Booking[]).filter((b) => !b.waiting);
    if (confirmed.length === 0) {
      await markNotified(key);
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

    await markNotified(key);
  }

  // --- Payment-needed nudge, 30 min after booking if still unpaid ---
  // Deliberately not instant: right after booking, the player's already
  // looking at the Pay Now button in-app, so a push at that exact moment
  // is redundant. Re-checking status here (not just delaying the original
  // instant push) means someone who pays within the window never gets a
  // needless nag at all.
  const { data: unpaidBookings } = await admin
    .from("bookings")
    .select("id, player_id, created_at, game:games(id, venue, date, price)")
    .eq("status", "unpaid")
    .eq("waiting", false);

  for (const b of unpaidBookings ?? []) {
    const key = `payment-${b.id}`;
    if (notifiedKeys.has(key)) continue;

    const ageMinutes = (Date.now() - new Date(b.created_at).getTime()) / 60000;
    if (ageMinutes < 30) continue;

    const game = (Array.isArray(b.game) ? b.game[0] : b.game) as GameRef | null;
    if (!game) {
      await markNotified(key);
      continue;
    }

    await sendPushToUsers([b.player_id], {
      title: "Payment needed",
      body: `You're booked for ${game.venue} on ${fmtDateLabel(game.date)} — pay £${game.price} ahead of kick-off.`,
      url: "/",
    });
    await markNotified(key);
  }

  // --- Overdue reminder, once the game's finished if still unconfirmed ---
  // A second, later nudge before the hard booking-block kicks in (that
  // happens the day after the game - see has_overdue_payment() in SQL).
  // Fires same-evening, well before that block, using the same "game's
  // finished" cutoff as the rest of the app (kickoff + 90 min) - so it's
  // a heads-up, not just a restatement of a block that's already active.
  const { data: unconfirmedBookings } = await admin
    .from("bookings")
    .select("id, player_id, game:games(id, venue, date, kickoff, price)")
    .neq("status", "confirmed")
    .eq("waiting", false);

  for (const b of unconfirmedBookings ?? []) {
    const key = `overdue-${b.id}`;
    if (notifiedKeys.has(key)) continue;

    const game = (Array.isArray(b.game) ? b.game[0] : b.game) as GameRefWithKickoff | null;
    if (!game) {
      await markNotified(key);
      continue;
    }
    if (toMs(kickoffCutoff(game.date, game.kickoff, 90)) > nowMs) continue;

    await sendPushToUsers([b.player_id], {
      title: "Still unpaid ⚠️",
      body: `You still owe £${game.price} for ${game.venue} on ${fmtDateLabel(game.date)} — pay now to avoid being blocked from booking your next game.`,
      url: "/",
    });
    await markNotified(key);
  }

  return NextResponse.json({ ok: true });
}
