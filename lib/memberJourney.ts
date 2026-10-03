import type { SupabaseClient } from "@supabase/supabase-js";
import { kickoffCutoff, nowInLondon, MATCH_DURATION_MINUTES } from "./time";

// Where each member is in their journey with the club - signed up, first
// booking, first game, regular, drifting away - worked out fresh from the
// raw rows every time. Shared by the welcome/first-game messages (cron),
// GaffAI's "Needs you" alerts and its get_member_journey tool, so all three
// always count people the same way.

export interface JourneyGame {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  max_players: number;
  published: boolean;
  team_white_score: number | null;
  bookings: { player_id: string; waiting: boolean }[];
}

export interface JourneyPerson {
  id: string;
  name: string;
  joined: string;
}

const DAY = 86400000;

export function fmtJourneyDate(date: string) {
  return new Date(date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// The first published game still to come that has a free spot.
export function nextOpenGame(games: JourneyGame[], nowUk: string) {
  return (
    games
      .filter((g) => g.published && kickoffCutoff(g.date, g.kickoff, 0) > nowUk)
      .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff))
      .find((g) => g.bookings.filter((b) => !b.waiting).length < g.max_players) ?? null
  );
}

export async function computeJourney(admin: SupabaseClient) {
  const nowUk = nowInLondon();
  const now = Date.now();
  const [{ data: allProfiles }, { data: usersPage }, { data: games }] = await Promise.all([
    admin.from("profiles").select("*"),
    admin.auth.admin.listUsers({ perPage: 1000 }),
    admin.from("games").select("id, date, kickoff, venue, pitch, price, max_players, published, team_white_score, bookings(player_id, waiting)"),
  ]);
  // Members only: people waiting for approval have their own GaffAI nudge.
  const profiles = ((allProfiles ?? []) as { id: string; display_name: string; created_at: string; status?: string; is_test?: boolean }[]).filter(
    (p) => (p.status ?? "active") === "active" && !p.is_test
  );
  const gameRows = (games ?? []) as JourneyGame[];
  const confirmedEmail = new Set((usersPage?.users ?? []).filter((u) => u.email_confirmed_at).map((u) => u.id));

  const played: Record<string, string[]> = {};
  const upcoming: Record<string, number> = {};
  const waiting: Record<string, number> = {};
  const everBooked = new Set<string>();
  for (const g of gameRows) {
    const future = kickoffCutoff(g.date, g.kickoff, 0) > nowUk;
    const over = kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= nowUk;
    for (const b of g.bookings ?? []) {
      everBooked.add(b.player_id);
      if (future && b.waiting) waiting[b.player_id] = (waiting[b.player_id] ?? 0) + 1;
      if (b.waiting) continue;
      if (future) upcoming[b.player_id] = (upcoming[b.player_id] ?? 0) + 1;
      else if (over && g.team_white_score != null) (played[b.player_id] ??= []).push(g.date);
    }
  }
  const person = (p: { id: string; display_name: string; created_at: string }): JourneyPerson => ({ id: p.id, name: p.display_name, joined: p.created_at.slice(0, 10) });
  const daysSince = (date: string) => (now - new Date(date + "T12:00:00Z").getTime()) / DAY;
  const lastPlayed = (id: string) => (played[id] ?? []).sort().at(-1) ?? null;
  const nothingAhead = (id: string) => !upcoming[id] && !waiting[id];
  const list = profiles ?? [];

  const open = nextOpenGame(gameRows, nowUk);
  return {
    nowUk,
    nextOpen: open ? { date: open.date, kickoff: open.kickoff, venue: open.venue, daysAway: Math.round(daysSince(open.date) * -1) } : null,
    // Signed up more than a day ago but never confirmed their email, so they can't log in.
    unconfirmed: list.filter((p) => !confirmedEmail.has(p.id) && now - new Date(p.created_at).getTime() > DAY).map(person),
    // Joined 2+ weeks ago and never booked anything, not even a waiting list.
    neverBooked: list.filter((p) => confirmedEmail.has(p.id) && !everBooked.has(p.id) && now - new Date(p.created_at).getTime() > 14 * DAY).map(person),
    // Played exactly one game, 2+ weeks ago, and nothing booked since.
    oneAndDone: list
      .filter((p) => (played[p.id]?.length ?? 0) === 1 && daysSince(lastPlayed(p.id)!) >= 14 && nothingAhead(p.id))
      .map((p) => ({ ...person(p), lastPlayed: lastPlayed(p.id)! })),
    // Played 2+ games, not for 4+ weeks, and nothing booked.
    lapsed: list
      .filter((p) => (played[p.id]?.length ?? 0) >= 2 && daysSince(lastPlayed(p.id)!) >= 28 && nothingAhead(p.id))
      .map((p) => ({ ...person(p), lastPlayed: lastPlayed(p.id)!, games: played[p.id].length })),
    counts: {
      members: list.length,
      playedOnce: list.filter((p) => (played[p.id]?.length ?? 0) === 1).length,
      regulars: list.filter((p) => (played[p.id]?.length ?? 0) >= 5).length,
      neverBookedAtAll: list.filter((p) => !everBooked.has(p.id)).length,
    },
  };
}
