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
  const nowUkStr = nowInLondon();
  const nowMs = toMs(nowUkStr);
  const { data: games } = await admin
    .from("games")
    .select("id, date, kickoff, venue, max_players, team_white_score, team_red_score, bookings(player_id, status, waiting, team)");
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

  // --- Unpaid bookings on upcoming games: day-5 warning, day-7 removal ---
  // For fixtures posted well in advance (a month's worth at once, say),
  // this reclaims a spot from someone who booked but never actually paid,
  // rather than letting it sit held for weeks while someone who'd pay
  // can't get in. Scoped to "unpaid" specifically, not "pending" -
  // someone who's already tapped "I've paid" has taken action and
  // shouldn't be punished for admin not having gotten to confirming it
  // yet. Only touches games that haven't kicked off yet - once a game's
  // played, the existing overdue reminder + booking-block flow takes
  // over instead, which is a warning rather than a removal.
  //
  // The day-5 warning is a notification only - it never deletes anything.
  // The ONLY code path anywhere in the app that removes someone from a
  // booking for non-payment is the day-7 block below; this just gives
  // them a heads-up two days ahead of it.
  const { data: staleUnpaid } = await admin
    .from("bookings")
    .select(
      "id, player_id, created_at, promoted_at, player:profiles!bookings_player_id_fkey(display_name), game:games(id, venue, date, kickoff, price)"
    )
    .eq("status", "unpaid")
    .eq("waiting", false);

  for (const b of staleUnpaid ?? []) {
    // promoted_at, not created_at, when this booking came off the waiting
    // list - otherwise someone who waited 5 days before a spot opened up
    // only gets 2 days left to pay instead of the intended 7, since the
    // clock should start when they actually got a real, payable spot.
    const windowStart = b.promoted_at ?? b.created_at;
    const ageDays = (Date.now() - new Date(windowStart).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays < 5) continue;

    const game = (Array.isArray(b.game) ? b.game[0] : b.game) as GameRefWithKickoff | null;
    if (!game) continue;
    if (toMs(kickoffCutoff(game.date, game.kickoff, 0)) <= nowMs) continue; // already past - overdue flow below handles it instead

    if (ageDays < 7) {
      // Day-5 warning - notification only, no delete. Also drops a copy
      // into the in-app inbox (sender_id null - system-generated, not
      // from a specific admin) so it's still visible with a read receipt
      // to players who don't have push working, which is exactly the gap
      // the inbox exists to cover.
      const key = `pre-removal-${b.id}`;
      if (notifiedKeys.has(key)) continue;
      await sendPushToUsers([b.player_id], {
        title: "You'll lose this spot soon ⚠️",
        body: `You'll be removed from ${game.venue} on ${fmtDateLabel(game.date)} in 2 days unless you pay — pay now to keep your spot.`,
        url: "/",
      });
      await admin.from("admin_messages").insert({
        recipient_id: b.player_id,
        sender_id: null,
        message: `You're still down as owing £${game.price} for ${game.venue} on ${fmtDateLabel(game.date)}. You'll be removed from the game in 2 days unless you pay — sort it when you get a sec.`,
      });
      await markNotified(key);
      continue;
    }

    // Day-7 removal - the one and only place that actually deletes a
    // booking for non-payment.
    const player = Array.isArray(b.player) ? b.player[0] : b.player;

    const { error: deleteErr } = await admin.from("bookings").delete().eq("id", b.id);
    if (deleteErr) {
      console.error("frequent cron: failed to remove stale unpaid booking", b.id, deleteErr.message);
      continue;
    }

    await sendPushToUsers([b.player_id], {
      title: "Removed from booking",
      body: `You were removed from ${game.venue} on ${fmtDateLabel(game.date)} — no payment within 7 days of booking. Book again if you still want a spot.`,
      url: "/",
    });
    await admin.from("audit_log").insert({
      actor_id: null,
      action: "Auto-removed unpaid booking",
      details: `${player?.display_name ?? "Unknown player"} — ${game.venue}, ${fmtDateLabel(game.date)} (unpaid 7+ days)`,
    });
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

  // --- Score-entry reminder, once the game's finished if no result yet ---
  // MOTM voting closes 5 hours after kickoff regardless of whether a score
  // has been entered - the player-facing voting UI only shows once a
  // result's in, so an admin being slow here can quietly cost the whole
  // MOTM window for that game. Nudges every admin as soon as the game's
  // confirmed over (kickoff + 90min, same cutoff as everywhere else),
  // giving the full ~3.5hr runway to MOTM's actual deadline.
  for (const g of games ?? []) {
    const key = `score-reminder-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    if (toMs(kickoffCutoff(g.date, g.kickoff, 90)) > nowMs) continue;
    if (g.team_white_score != null && g.team_red_score != null) continue;

    const { data: admins } = await admin.from("profiles").select("id").in("role", ["admin", "co-owner", "owner"]);
    const adminIds = (admins ?? []).map((p) => p.id);
    if (adminIds.length === 0) {
      await markNotified(key);
      continue;
    }

    await sendPushToUsers(adminIds, {
      title: "Score needed 📋",
      body: `${g.venue} on ${fmtDateLabel(g.date)} has finished — enter the result so MOTM voting can open.`,
      url: "/",
    });
    await markNotified(key);
  }

  // --- Game day: let non-booked players know spots remain ---
  // A wider net than "last spot" (which only fires as the roster's about
  // to fill) - for games that just aren't filling naturally, this reaches
  // everyone who hasn't engaged with this fixture at all yet. Fires once,
  // same day, once it's a sensible morning hour and before kickoff.
  const todayDate = nowUkStr.slice(0, 10);
  for (const g of games ?? []) {
    const key = `spots-available-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    if (g.date !== todayDate) continue;
    if (nowUkStr.slice(11, 16) < "09:00") continue;
    if (toMs(kickoffCutoff(g.date, g.kickoff, 0)) <= nowMs) continue;

    const gameBookings = g.bookings as Booking[];
    const takenSpots = gameBookings.filter((b) => !b.waiting).length;
    const spotsLeft = g.max_players - takenSpots;
    if (spotsLeft <= 0) {
      await markNotified(key);
      continue;
    }

    const bookedIds = new Set(gameBookings.map((b) => b.player_id));
    const { data: everyone } = await admin.from("profiles").select("id").eq("push_opt_in", true);
    const targetIds = (everyone ?? []).map((p) => p.id).filter((id) => !bookedIds.has(id));

    await sendPushToUsers(targetIds, {
      title: "Spots available today ⚽",
      body: `${g.venue} today at ${g.kickoff} still has ${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} — grab one before kickoff.`,
      url: "/",
    });
    await markNotified(key);
  }

  // --- Welcome message for new players, via inbox + push ---
  // Not time-window-gated like the reminders above - fires the first
  // frequent-cron run after a profile exists, whether it came from
  // self-signup or an admin-invited add. Goes through the inbox (not
  // just a push) since this is exactly the audience the inbox was
  // built for: people who joined online with no other channel to reach
  // them, who'd otherwise get no orientation to the club at all.
  const { data: allProfiles } = await admin.from("profiles").select("id, display_name");
  for (const p of allProfiles ?? []) {
    const key = `welcome-${p.id}`;
    if (notifiedKeys.has(key)) continue;

    const firstName = p.display_name.split(" ")[0];
    await admin.from("admin_messages").insert({
      recipient_id: p.id,
      sender_id: null,
      message: `Welcome to Wirral Community Football, ${firstName}! 👋 Head to Fixtures to browse upcoming games and grab a spot — payment details show up once you're booked. Worth turning on notifications in Account too, so you don't miss spots opening up or payment reminders. See you on the pitch!`,
    });
    await sendPushToUsers([p.id], {
      title: "Welcome to the club! ⚽",
      body: "Head to Fixtures to grab a spot on the next game.",
      url: "/",
    });
    await markNotified(key);
  }

  return NextResponse.json({ ok: true });
}
