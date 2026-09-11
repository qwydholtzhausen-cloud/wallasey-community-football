import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers, sendPushBroadcast } from "../../../../lib/push";
import { kickoffCutoff, nowInLondon, MATCH_DURATION_MINUTES } from "../../../../lib/time";
import { ensureFreshMonzoToken, registerMonzoWebhook } from "../../../../lib/monzo";

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

  // There's deliberately no pre-kickoff removal for non-payment anymore -
  // fixtures get posted weeks ahead, and any fixed deadline (whether tied
  // to booking time or to kickoff) ends up either nagging someone whose
  // game is still ages off or catching a last-minute booker unfairly.
  // Nobody now loses their spot automatically before a game. The
  // enforcement is entirely post-game instead: the reminder just below,
  // plus has_overdue_payment() in SQL, which blocks booking your *next*
  // game while a past one's still unpaid - real teeth, without ever
  // deleting someone's booking out from under them.

  // --- Overdue reminder, once the game's finished if still unconfirmed ---
  // A second, later nudge before the hard booking-block kicks in (that
  // happens the day after the game - see has_overdue_payment() in SQL).
  // Fires same-evening, well before that block, using the same "game's
  // finished" cutoff as the rest of the app (kickoff + MATCH_DURATION_MINUTES)
  // - so it's a heads-up, not just a restatement of a block that's already active.
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
    if (toMs(kickoffCutoff(game.date, game.kickoff, MATCH_DURATION_MINUTES)) > nowMs) continue;

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
  // confirmed over (kickoff + MATCH_DURATION_MINUTES, same cutoff as
  // everywhere else), giving the remaining runway to MOTM's actual deadline.
  for (const g of games ?? []) {
    const key = `score-reminder-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    if (toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) > nowMs) continue;
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

  // --- New fixture announcements, batched ~30 min after publishing ---
  // Publishing a fixture used to push instantly, which was fine one at a
  // time but meant confirming a batch of drafts (the "Fixtures" bulk-add
  // tool) fired one push per confirm - up to N notifications landing
  // within a few minutes of each other. published_at (set once, when a
  // draft is first confirmed - see saveGame) is real UTC, not the
  // pretend-UTC trick nowUkStr/nowMs use above, so this deliberately
  // compares against a genuine Date.now() rather than reusing nowMs.
  const { data: unannounced } = await admin
    .from("games")
    .select("id, date, venue")
    .eq("published", true)
    .not("published_at", "is", null)
    .lte("published_at", new Date(Date.now() - 30 * 60 * 1000).toISOString());
  const dueGames = (unannounced ?? []).filter((g) => !notifiedKeys.has(`fixture-announced-${g.id}`));

  if (dueGames.length === 1) {
    const g = dueGames[0];
    const dateLabel = new Date(g.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    await sendPushBroadcast({ title: "New fixture posted", body: `${g.venue}, ${dateLabel} — tap to grab a spot.`, url: "/" });
    await markNotified(`fixture-announced-${g.id}`);
  } else if (dueGames.length > 1) {
    await sendPushBroadcast({
      title: "New fixtures posted",
      body: `${dueGames.length} new fixtures are up — tap to see them and grab a spot.`,
      url: "/",
    });
    for (const g of dueGames) await markNotified(`fixture-announced-${g.id}`);
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

  // --- Monzo: keep the access token fresh, retry webhook registration ---
  // ensureFreshMonzoToken silently no-ops until a Monzo account is
  // actually connected, and only calls Monzo's refresh endpoint once the
  // 30-hour access token is within 3 hours of expiring - so this runs
  // every ~15 min but only does real work rarely. Registration is
  // retried here in case it failed at OAuth-callback time (e.g. Monzo's
  // API hiccuped right after approval).
  const monzoToken = await ensureFreshMonzoToken(admin);
  if (monzoToken?.account_id && !monzoToken.webhook_registered) {
    await registerMonzoWebhook(admin, monzoToken.access_token, monzoToken.account_id);
  }

  return NextResponse.json({ ok: true });
}
