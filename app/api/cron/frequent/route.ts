import { NextResponse } from "next/server";
import { wrappedThemeFor } from "../../../../lib/wrappedThemes";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers, sendPushBroadcast } from "../../../../lib/push";
import { kickoffCutoff, nowInLondon, previousMonthKey, monthReleaseAt, nextMonthStart, MONTH_RELEASE_HOUR, MATCH_DURATION_MINUTES, MOTM_VOTE_WINDOW_MINUTES } from "../../../../lib/time";
import { ensureFreshMonzoToken, registerMonzoWebhook } from "../../../../lib/monzo";
import { AUTO_REMOVE_UNPAID_BOOKINGS, WRAPPED_OPEN_TO_ALL_FROM, WRAPPED_FIRST_MONTH_FOR_ALL } from "../../../../lib/clubPolicy";
import { nextOpenGame, fmtJourneyDate, type JourneyGame } from "../../../../lib/memberJourney";
import { announcePlayerOfMonth } from "../../../../lib/potmAnnounce";
import { recordHeartbeat } from "../../../../lib/gaffai/health";

// Both sides of this comparison come from the same "pretend UTC" trick in
// lib/time.ts (real UK wall-clock digits, formatted as if they were UTC) -
// parsing with a literal "Z" here keeps that consistent regardless of
// whatever timezone this function happens to execute in.
function toMs(pseudoUtc: string) {
  return new Date(pseudoUtc + ":00Z").getTime();
}

interface Booking {
  id: string;
  player_id: string;
  status: string;
  waiting: boolean;
  team: "white" | "red" | null;
  pot_exempt_reason: string | null;
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

  // --- Kickoff + team reminder, before kickoff ---
  // The window is deliberately wide (2 hours to 15 min before kickoff):
  // GitHub runs this "every 15 minutes" schedule late and irregularly -
  // on 24 Sep 2026 it ran at 19:29 for an 8pm game - and the old 45-70
  // minute window missed 9 of 10 games in Aug/Sep. The first run that
  // lands anywhere in the window sends it, once per game, and the wording
  // gives the kickoff time rather than "in about an hour".
  const nowUkStr = nowInLondon();
  const nowMs = toMs(nowUkStr);
  const { data: games } = await admin
    .from("games")
    .select("id, date, kickoff, venue, pitch, price, published, max_players, team_white_score, team_red_score, bookings(id, player_id, status, waiting, team, pot_exempt_reason)");
  const { data: settings } = await admin.from("club_settings").select("team_white_name, team_red_name").single();
  const whiteLabel = settings?.team_white_name || "Whites";
  const redLabel = settings?.team_red_name || "Reds";

  for (const g of games ?? []) {
    const key = `kickoff-${g.id}`;
    if (notifiedKeys.has(key)) continue;

    const minutesUntilKickoff = (toMs(kickoffCutoff(g.date, g.kickoff, 0)) - nowMs) / 60000;
    if (minutesUntilKickoff < 15 || minutesUntilKickoff > 120) continue;

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
        const body = teamLabel ? `You're on ${teamLabel} at ${g.venue}.` : `See you at ${g.venue}.`;
        return sendPushToUsers([b.player_id], { title: `Kickoff at ${g.kickoff} ⏰`, body, url: "/" });
      })
    );

    await markNotified(key);
  }

  // --- Teams are out ---
  // Once an admin saves the Team Sheet for an upcoming game, each player is
  // told which side they're on. Predictions open at the same moment, so
  // this is also the only nudge that they can now guess the score. There's
  // no "teams saved at" timestamp, so it fires the first time a run sees
  // teams on both sides; once per game. Skipped inside the last half hour,
  // where the kickoff reminder already says which team you're on.
  for (const g of games ?? []) {
    const key = `teams-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    const minutesUntilKickoff = (toMs(kickoffCutoff(g.date, g.kickoff, 0)) - nowMs) / 60000;
    if (minutesUntilKickoff < 30) continue;
    const playing = (g.bookings as Booking[]).filter((b) => !b.waiting);
    const whites = playing.filter((b) => b.team === "white");
    const reds = playing.filter((b) => b.team === "red");
    if (whites.length < 2 || reds.length < 2) continue;

    const when = `${fmtDateLabel(g.date)}, ${g.kickoff}`;
    await Promise.all(
      [...whites, ...reds].map((b) =>
        sendPushToUsers([b.player_id], {
          title: "Teams are out 👕",
          body: `${when}: you're on ${b.team === "white" ? whiteLabel : redLabel}. Predictions are open, so guess the score.`,
          url: "/",
        })
      )
    );
    await markNotified(key);
  }

  // --- MOTM voting is open ---
  // Sent to the players who played as soon as the score's in, while there's
  // still a sensible amount of the 5-hour window left. Games scored after
  // voting has closed (or with under 20 minutes left) never send it.
  for (const g of games ?? []) {
    const key = `motm-open-${g.id}`;
    if (notifiedKeys.has(key)) continue;
    if (g.team_white_score == null || g.team_red_score == null) continue;
    const closes = kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES);
    if ((toMs(closes) - nowMs) / 60000 < 20) continue;
    const playedIds = (g.bookings as Booking[]).filter((b) => !b.waiting).map((b) => b.player_id);
    if (playedIds.length === 0) {
      await markNotified(key);
      continue;
    }
    const [h, m] = closes.slice(11).split(":").map(Number);
    const closesLabel = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
    await sendPushToUsers(playedIds, {
      title: "Vote for Man of the Match 🗳️",
      body: `${whiteLabel} ${g.team_white_score}–${g.team_red_score} ${redLabel}. Who was best? Voting closes at ${closesLabel}.`,
      url: "/",
    });
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

  // --- Unpaid bookings on upcoming games: warn at 72h, remove at 48h
  // before kickoff ---
  // Anchored off kickoff, not booking time. Fixtures often get posted
  // weeks ahead, and the old day-5/day-7 rule (clock starting the moment
  // someone booked) meant a spot reserved a month out - not yet paid
  // because it wasn't due yet - got silently removed while the game was
  // still ages away. Nothing happens at all until the game's actually
  // close. Scoped to "unpaid" specifically, not "pending" - someone
  // who's already tapped "I've paid" has taken action and shouldn't be
  // punished for admin not having gotten to confirming it yet. Only
  // touches games that haven't kicked off yet - once a game's played,
  // the existing overdue reminder + booking-block flow takes over
  // instead, which is a warning rather than a removal.
  //
  // A booking made within the 48h window itself is fully exempt from
  // this whole block, not just given a shorter deadline - there's no
  // fair cutoff to hold a last-minute booker to, so this path just never
  // touches them. They still got the earlier "payment needed" nudge
  // above, and if still unpaid once the game's played, the post-game
  // overdue flow (below) picks it up from there instead.
  //
  // Just outside that window is its own edge case: a booking made at,
  // say, 48h01m before kickoff would otherwise see both the 72h warning
  // and 48h removal deadlines already in the past the moment it's made,
  // so it'd get warned and removed within minutes of being booked -
  // exactly the kind of last-minute punishment the exemption above
  // exists to prevent. MIN_GRACE_HOURS floors both deadlines off the
  // booking time itself, so anyone this close to the boundary still gets
  // a real warning-then-removal ramp instead of an instant hit. It only
  // ever pushes the deadlines later, never earlier, so it has no effect
  // on a normal booking make weeks out.
  //
  // The 72h warning is a notification only - it never deletes anything.
  // The ONLY code path anywhere in the app that removes someone from a
  // booking for non-payment is the 48h block below, and it's currently
  // disabled - see AUTO_REMOVE_UNPAID_BOOKINGS in lib/clubPolicy.ts for
  // why and what happens instead (the existing post-game overdue block
  // takes over). When enabled, this warning just gives a heads-up a day
  // ahead of the removal.
  const REMOVAL_HOURS_BEFORE_KICKOFF = 48;
  const WARNING_HOURS_BEFORE_KICKOFF = 72;
  const MIN_GRACE_HOURS = 3;

  const { data: staleUnpaid } = await admin
    .from("bookings")
    .select(
      "id, player_id, created_at, promoted_at, player:profiles!bookings_player_id_fkey(display_name), game:games(id, venue, date, kickoff, price)"
    )
    .eq("status", "unpaid")
    .eq("waiting", false);

  for (const b of staleUnpaid ?? []) {
    const game = (Array.isArray(b.game) ? b.game[0] : b.game) as GameRefWithKickoff | null;
    if (!game) continue;
    const kickoffMs = toMs(kickoffCutoff(game.date, game.kickoff, 0));
    if (kickoffMs <= nowMs) continue; // already past - overdue flow below handles it instead

    // promoted_at, not created_at, when this booking came off the
    // waiting list - exemption/grace is based on when they actually got
    // a real, payable spot, not from when they first joined the queue.
    const windowStartMs = new Date(b.promoted_at ?? b.created_at).getTime();
    if (kickoffMs - windowStartMs <= REMOVAL_HOURS_BEFORE_KICKOFF * 3600000) continue; // booked within the window - exempt, always

    const warnAtMs = Math.max(kickoffMs - WARNING_HOURS_BEFORE_KICKOFF * 3600000, windowStartMs + MIN_GRACE_HOURS * 3600000);
    const removalAtMs = Math.max(
      kickoffMs - REMOVAL_HOURS_BEFORE_KICKOFF * 3600000,
      warnAtMs + (WARNING_HOURS_BEFORE_KICKOFF - REMOVAL_HOURS_BEFORE_KICKOFF) * 3600000
    );

    if (nowMs < warnAtMs) continue;

    if (!AUTO_REMOVE_UNPAID_BOOKINGS || nowMs < removalAtMs) {
      // Warning - notification only, no delete. Also drops a copy into
      // the in-app inbox (sender_id null - system-generated, not from a
      // specific admin) so it's still visible with a read receipt to
      // players who don't have push working, which is exactly the gap
      // the inbox exists to cover. Wording depends on
      // AUTO_REMOVE_UNPAID_BOOKINGS (lib/clubPolicy.ts) so it never
      // promises a removal that won't actually happen while it's off.
      const key = `pre-removal-${b.id}`;
      if (notifiedKeys.has(key)) continue;
      const pushBody = AUTO_REMOVE_UNPAID_BOOKINGS
        ? `You'll be removed from ${game.venue} on ${fmtDateLabel(game.date)} in about ${Math.max(1, Math.round((removalAtMs - nowMs) / 3600000))}h unless you pay — pay now to keep your spot.`
        : `You still owe £${game.price} for ${game.venue} on ${fmtDateLabel(game.date)}. Pay before kick-off, or you'll be blocked from booking your next game once this one finishes, until it's sorted.`;
      const inboxBody = AUTO_REMOVE_UNPAID_BOOKINGS
        ? `You're still down as owing £${game.price} for ${game.venue} on ${fmtDateLabel(game.date)}. You'll be removed from the game in about ${Math.max(1, Math.round((removalAtMs - nowMs) / 3600000))}h unless you pay — sort it when you get a sec.`
        : `You're still down as owing £${game.price} for ${game.venue} on ${fmtDateLabel(game.date)}. Pay before kick-off, or you'll be blocked from booking your next game once this one finishes.`;
      await sendPushToUsers([b.player_id], {
        title: AUTO_REMOVE_UNPAID_BOOKINGS ? "You'll lose this spot soon ⚠️" : "Still owe for this one ⚠️",
        body: pushBody,
        url: "/",
      });
      await admin.from("admin_messages").insert({
        recipient_id: b.player_id,
        sender_id: null,
        message: inboxBody,
      });
      await markNotified(key);
      continue;
    }

    // Removal - the one and only place that actually deletes a booking
    // for non-payment. Unreachable while AUTO_REMOVE_UNPAID_BOOKINGS is
    // false (lib/clubPolicy.ts) - the branch above always takes over
    // first in that case.
    const player = Array.isArray(b.player) ? b.player[0] : b.player;

    const { error: deleteErr } = await admin.from("bookings").delete().eq("id", b.id);
    if (deleteErr) {
      console.error("frequent cron: failed to remove stale unpaid booking", b.id, deleteErr.message);
      continue;
    }

    await sendPushToUsers([b.player_id], {
      title: "Removed from booking",
      body: `You were removed from ${game.venue} on ${fmtDateLabel(game.date)} — no payment within 48 hours of kick-off. Book again if you still want a spot.`,
      url: "/",
    });
    await admin.from("audit_log").insert({
      actor_id: null,
      action: "Auto-removed unpaid booking",
      details: `${player?.display_name ?? "Unknown player"} — ${game.venue}, ${fmtDateLabel(game.date)} (unpaid within 48h of kick-off)`,
    });
  }

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

  // --- First game: a hello on the morning of it, and a follow-up after ---
  // "First" = no earlier game they've actually played. Both are tied to
  // dates (today / yesterday), so nobody gets one for a game long past.
  // Inbox + push, since most members don't have notifications on.
  type CronGame = Omit<JourneyGame, "bookings"> & { team_red_score: number | null; bookings: Booking[] };
  const allGames = (games ?? []) as unknown as CronGame[];
  const playedBefore = (playerId: string, beforeDate: string) =>
    allGames.some((x) => x.date < beforeDate && x.team_white_score != null && x.bookings.some((b) => b.player_id === playerId && !b.waiting));
  // select("*"), not named columns: payment_code is in schema.sql but not on
  // the live database, and naming it made this whole query fail - so every
  // first-game message went out with a blank name ("...with us,  👋").
  const { data: codeRows } = await admin.from("profiles").select("*");
  const profileOf = (id: string) => (codeRows ?? []).find((p) => p.id === id);
  const yesterday = new Date(Date.UTC(+todayDate.slice(0, 4), +todayDate.slice(5, 7) - 1, +todayDate.slice(8, 10) - 1)).toISOString().slice(0, 10);
  const hhmm = nowUkStr.slice(11, 16);

  for (const g of allGames) {
    if (g.date !== todayDate || !g.published || hhmm < "09:00") continue;
    if (toMs(kickoffCutoff(g.date, g.kickoff, 0)) - nowMs < 60 * 60000) continue;
    for (const b of g.bookings.filter((x) => !x.waiting)) {
      const key = `first-game-${b.player_id}`;
      if (notifiedKeys.has(key) || playedBefore(b.player_id, g.date)) continue;
      const p = profileOf(b.player_id);
      const pay =
        b.status === "unpaid"
          ? ` It's £${g.price}: pay by bank transfer${p?.payment_code ? ` with your reference ${p.payment_code}` : ""} (details in Account).`
          : "";
      await admin.from("admin_messages").insert({
        recipient_id: b.player_id,
        sender_id: null,
        message: `Tonight's your first game with us, ${(p?.display_name ?? "").split(" ")[0]} 👋 ${g.venue}, kicking off at ${g.kickoff} (${g.pitch}). Your team will be on the Line-up tab once it's picked.${pay} Say hello to one of the admins when you get there. Enjoy it!`,
      });
      await sendPushToUsers([b.player_id], { title: "Your first game is tonight 👋", body: `${g.venue}, ${g.kickoff}. Check the Line-up tab for your team.`, url: "/" });
      await markNotified(key);
    }
  }

  if (hhmm >= "10:00") {
    for (const g of allGames) {
      if (g.date !== yesterday || g.team_white_score == null) continue;
      for (const b of g.bookings.filter((x) => !x.waiting)) {
        const key = `after-first-game-${b.player_id}`;
        if (notifiedKeys.has(key) || playedBefore(b.player_id, g.date)) continue;
        const p = profileOf(b.player_id);
        const nextBooked = allGames
          .filter((x) => kickoffCutoff(x.date, x.kickoff, 0) > nowUkStr && x.bookings.some((y) => y.player_id === b.player_id && !y.waiting))
          .sort((x, y) => x.date.localeCompare(y.date))[0];
        const open = nextOpenGame(allGames as unknown as JourneyGame[], nowUkStr);
        const next = nextBooked
          ? `See you on ${fmtJourneyDate(nextBooked.date)}!`
          : open
            ? `The next game with a free spot is ${fmtJourneyDate(open.date)}, and you can join the waiting list on any sooner game in Fixtures.`
            : "Games are full at the moment, but join the waiting list on any game in Fixtures and you'll get a message if a spot opens.";
        await admin.from("admin_messages").insert({
          recipient_id: b.player_id,
          sender_id: null,
          message: `Good to have you at your first game last night, ${(p?.display_name ?? "").split(" ")[0]}! ${next} You can also vote for Man of the Match and see the stats on the Results tab.`,
        });
        await sendPushToUsers([b.player_id], {
          title: "Good to have you last night ⚽",
          body: nextBooked ? `See you on ${fmtJourneyDate(nextBooked.date)}.` : "Open the app to book your next game.",
          url: "/",
        });
        await markNotified(key);
      }
    }
  }

  // --- Birthday: the player hears their game is free ---
  // Sent when an admin makes a booking free for a birthday (the free game
  // itself stays an admin decision, often prompted by GaffAI).
  for (const g of allGames) {
    if (kickoffCutoff(g.date, g.kickoff, 0) <= nowUkStr) continue;
    for (const b of g.bookings.filter((x) => x.pot_exempt_reason === "birthday" && !x.waiting)) {
      const key = `birthday-free-${b.id}`;
      if (notifiedKeys.has(key)) continue;
      if (hhmm < "09:00" || hhmm >= "21:00") continue;
      await admin.from("admin_messages").insert({
        recipient_id: b.player_id,
        sender_id: null,
        message: `Happy birthday from everyone at Wirral Community Football 🎂 Your game on ${fmtJourneyDate(g.date)} is on us. Have a good one!`,
      });
      await sendPushToUsers([b.player_id], { title: "Happy birthday 🎂", body: `Your game on ${fmtJourneyDate(g.date)} is on us.`, url: "/" });
      await markNotified(key);
    }
  }

  // --- Welcome message for new players, via inbox + push ---
  // Not time-window-gated like the reminders above - fires the first
  // frequent-cron run after a profile exists, whether it came from
  // self-signup or an admin-invited add. Goes through the inbox (not
  // just a push) since this is exactly the audience the inbox was
  // built for: people who joined online with no other channel to reach
  // them, who'd otherwise get no orientation to the club at all.
  // Waiting-for-approval members get theirs once an admin lets them in.
  const { data: allProfiles } = await admin.from("profiles").select("*");
  for (const p of (allProfiles ?? []) as { id: string; display_name: string; status?: string }[]) {
    if ((p.status ?? "active") !== "active") continue;
    const key = `welcome-${p.id}`;
    if (notifiedKeys.has(key)) continue;

    const firstName = p.display_name.split(" ")[0];
    // Honest about how far ahead games fill: if the next free spot is weeks
    // away, say when it is and point to the waiting lists for sooner games,
    // rather than "grab a spot" and a page of full games.
    const open = nextOpenGame((games ?? []) as unknown as JourneyGame[], nowUkStr);
    const openDays = open ? (toMs(kickoffCutoff(open.date, open.kickoff, 0)) - nowMs) / 86400000 : null;
    const whereToStart = !open
      ? "Games are all full right now, so join the waiting list on any game in Fixtures: if someone drops out you move up, and you'll get a message the moment you're in."
      : openDays! <= 10
        ? `The next game with a free spot is ${fmtJourneyDate(open.date)} at ${open.kickoff} (${open.venue}), so head to Fixtures and grab it.`
        : `Games book up a few weeks ahead: the next one with a free spot is ${fmtJourneyDate(open.date)} (${open.venue}). For anything sooner, join the waiting list on a game in Fixtures: if someone drops out you move up, and you'll get a message the moment you're in.`;
    await admin.from("admin_messages").insert({
      recipient_id: p.id,
      sender_id: null,
      message: `Welcome to Wirral Community Football, ${firstName}! 👋 ${whereToStart} Payment details show up once you're booked. Worth turning on notifications in Account, so you don't miss a spot opening up. See you on the pitch!`,
    });
    await sendPushToUsers([p.id], {
      title: "Welcome to the club! ⚽",
      body: open && openDays! <= 10 ? `Next free spot: ${fmtJourneyDate(open.date)}. Head to Fixtures to grab it.` : "Games book up fast. Open the app to see the next free spot and join a waiting list.",
      url: "/",
    });
    await markNotified(key);
  }

  // --- "Your September, wrapped": one push per month, when it goes live ---
  // Same rule as the app's banner: a month's Wrapped goes live once every
  // published game in it has been played, scored and had its MOTM vote
  // close, released at 8am the next morning (lib/time.ts monthReleaseAt),
  // together with Player of the Month. Only between 8am and 9pm. Only to players who actually have one (2+ games that
  // month). No backfill needed: WRAPPED_FIRST_MONTH_FOR_ALL means no
  // month before September 2026 can ever qualify.
  const nowHour = Number(nowUkStr.slice(11, 13));
  if (nowHour >= MONTH_RELEASE_HOUR && nowHour < 21) {
    try {
      await announcePlayerOfMonth(admin, nowUkStr, notifiedKeys, markNotified);
    } catch (err) {
      console.error("Player of the Month announcement failed", err);
    }
  }
  if (nowUkStr.slice(0, 10) >= WRAPPED_OPEN_TO_ALL_FROM && nowHour >= MONTH_RELEASE_HOUR && nowHour < 21) {
    const thisMonth = nowUkStr.slice(0, 7);
    const { data: monthRows } = await admin
      .from("games")
      .select("date, kickoff, published, team_white_score, team_red_score, bookings(player_id, waiting, team)")
      .gte("date", `${previousMonthKey(nowUkStr)}-01`)
      .lt("date", nextMonthStart(thisMonth));
    const inMonth = (key: string) => (monthRows ?? []).filter((g) => g.published && g.date.startsWith(key));
    const thisMonthGames = inMonth(thisMonth);
    const lastGame = [...thisMonthGames].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)).at(-1);
    const thisMonthDone =
      thisMonthGames.length > 0 &&
      thisMonthGames.every(
        (g) => g.team_white_score != null && g.team_red_score != null && kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) <= nowUkStr
      ) &&
      nowUkStr >= monthReleaseAt(lastGame!.date, lastGame!.kickoff);
    const monthKey = thisMonthDone ? thisMonth : previousMonthKey(nowUkStr);
    const key = `wrapped-${monthKey}`;
    if (monthKey >= WRAPPED_FIRST_MONTH_FOR_ALL && !notifiedKeys.has(key)) {
      const apps: Record<string, number> = {};
      for (const g of inMonth(monthKey)) {
        if (g.team_white_score == null) continue;
        for (const b of (g.bookings ?? []) as Booking[]) if (!b.waiting && b.team) apps[b.player_id] = (apps[b.player_id] ?? 0) + 1;
      }
      const recipients = Object.keys(apps).filter((id) => apps[id] >= 2);
      if (recipients.length > 0) {
        const monthName = new Date(monthKey + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
        await sendPushToUsers(recipients, {
          title: wrappedThemeFor(monthKey)?.push.title ?? `Your ${monthName}, wrapped 🎁`,
          body: wrappedThemeFor(monthKey)?.push.body ?? "Your games, goals, who you win with and your nemesis. Tap to watch.",
          url: "/",
        });
      }
      await markNotified(key);
    }
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

  // Last, so a run that dies part-way doesn't count as a healthy one.
  await recordHeartbeat(admin, "frequent").catch(() => undefined);
  return NextResponse.json({ ok: true });
}
