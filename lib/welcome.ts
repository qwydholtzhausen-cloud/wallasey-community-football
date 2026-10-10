import type { SupabaseClient } from "@supabase/supabase-js";
import { kickoffCutoff, nowInLondon } from "./time";
import { nextOpenGame, fmtJourneyDate, type JourneyGame } from "./memberJourney";
import { sendPushToUsers } from "./push";

// The welcome message a new member gets in their inbox (plus a push).
// Sent straight from the app once they've told us their name (POST
// /api/welcome), or by the frequent cron for anyone who never got that
// far. Whoever claims the notified_events key first sends it, so it only
// ever goes once.

type Toms = (s: string) => number;
const toMs: Toms = (s) => new Date(s + ":00Z").getTime();

// When every game is full: the one where a newcomer would be nearest the
// front of the queue (fewest waiting, soonest first).
export function bestChance(games: JourneyGame[], nowUk: string) {
  const full = games
    .filter((g) => g.published && kickoffCutoff(g.date, g.kickoff, 0) > nowUk)
    .filter((g) => g.bookings.filter((b) => !b.waiting).length >= g.max_players)
    .map((g) => ({ game: g, waiting: g.bookings.filter((b) => b.waiting).length }))
    .sort((a, b) => a.waiting - b.waiting || a.game.date.localeCompare(b.game.date) || a.game.kickoff.localeCompare(b.game.kickoff));
  return full[0] ? { game: full[0].game, place: full[0].waiting + 1 } : null;
}

const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

export function welcomeContent(firstName: string, games: JourneyGame[], nowUk: string) {
  const open = nextOpenGame(games, nowUk);
  const openDays = open ? (toMs(kickoffCutoff(open.date, open.kickoff, 0)) - toMs(nowUk)) / 86400000 : null;
  const best = bestChance(games, nowUk);
  const bestLine = best ? ` Your best chance right now is ${fmtJourneyDate(best.game.date)}, where you'd be ${nth(best.place)} in line.` : "";
  const whereToStart = !open
    ? `Games are all full right now, so join the waiting list on any game in Fixtures: if someone drops out you move up, and you'll get a message the moment you're in.${bestLine}`
    : openDays! <= 10
      ? `The next game with a free spot is ${fmtJourneyDate(open.date)} at ${open.kickoff} (${open.venue}), so head to Fixtures and grab it.`
      : `Games book up a few weeks ahead: the next one with a free spot is ${fmtJourneyDate(open.date)} (${open.venue}). For anything sooner, join the waiting list on a game in Fixtures: if someone drops out you move up, and you'll get a message the moment you're in.`;
  return {
    message: `Welcome to Wirral Community Football, ${firstName}! 👋 ${whereToStart} Payment details show up once you're booked. Worth turning on notifications in Account, so you don't miss a spot opening up. See you on the pitch!`,
    title: "Welcome to the club! ⚽",
    body:
      open && openDays! <= 10
        ? `Next free spot: ${fmtJourneyDate(open.date)}. Head to Fixtures to grab it.`
        : best
          ? `Best chance: ${fmtJourneyDate(best.game.date)}, ${nth(best.place)} in line. Open the app to join the waiting list.`
          : "Games book up fast. Open the app to see the next free spot and join a waiting list.",
  };
}

// Claims welcome-<id>, then sends. Returns false if it had already gone.
export async function sendWelcome(admin: SupabaseClient, profileId: string, games?: JourneyGame[]) {
  const { error: claimErr } = await admin.from("notified_events").insert({ event_key: `welcome-${profileId}` });
  if (claimErr) return false;
  const { data: p } = await admin.from("profiles").select("*").eq("id", profileId).single();
  const rows =
    games ??
    (((await admin.from("games").select("id, date, kickoff, venue, pitch, price, max_players, published, team_white_score, bookings(player_id, waiting)")).data ?? []) as unknown as JourneyGame[]);
  const c = welcomeContent(String(p?.display_name ?? "").split(" ")[0], rows, nowInLondon());
  await admin.from("admin_messages").insert({ recipient_id: profileId, sender_id: null, message: c.message });
  await sendPushToUsers([profileId], { title: c.title, body: c.body, url: "/" });
  return true;
}
