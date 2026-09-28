// Shared UK-timezone-safe date/time helpers - used by both the client
// component and server-side cron routes, so kickoff-cutoff logic can't
// drift between the two (a past bug came from exactly that kind of
// duplication going stale in one place but not the other).

export const MOTM_VOTE_WINDOW_MINUTES = 300;

// How long after kickoff a fixture is treated as finished - drives when it
// moves from "upcoming" to "past", when the score-entry/overdue-payment
// reminders fire, and the timestamp on its "Full time" feed item. Not the
// real match length (a 5-a-side rarely runs the full 90), just the buffer
// this app waits before treating a game as over.
export const MATCH_DURATION_MINUTES = 65;

// The real length of a game, as opposed to the buffer above. Used where the
// actual playing time matters: a calendar entry's end time and the minutes
// played in Wrapped.
export const MATCH_LENGTH_MINUTES = 60;

// Converts any real instant (a Date, or a genuine ISO UTC string like a
// `created_at` column) into the same "wall-clock digits as if they were
// UTC" string nowInLondon()/kickoffCutoff() produce, so it can be safely
// toMs()'d alongside their output. Comparing a real UTC epoch straight
// against a toMs()'d pretend-UTC value silently drifts by an hour during
// BST - this conversion is what avoids that, not a shortcut around it.
export function pseudoUtcFromRealInstant(input: Date | string) {
  const date = typeof input === "string" ? new Date(input) : input;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// Current UK wall-clock time as "YYYY-MM-DDTHH:MM", regardless of the
// server/browser's own timezone.
export function nowInLondon() {
  return pseudoUtcFromRealInstant(new Date());
}

// A fixture's date+kickoff plus a buffer, as "YYYY-MM-DDTHH:MM" in the
// same wall-clock frame - pure calendar arithmetic via Date.UTC, never
// touching the actual local timezone of whatever machine runs this.
export function kickoffCutoff(date: string, kickoff: string, bufferMinutes: number) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = kickoff.split(":").map(Number);
  const cutoff = new Date(Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, m || 0) + bufferMinutes * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${cutoff.getUTCFullYear()}-${pad(cutoff.getUTCMonth() + 1)}-${pad(cutoff.getUTCDate())}T${pad(cutoff.getUTCHours())}:${pad(cutoff.getUTCMinutes())}`;
}

// "2026-08" -> "2026-07" etc, handling year rollover via Date.UTC rather
// than manual month/year arithmetic.
export function previousMonthKey(nowUkStr: string) {
  const [y, mo] = nowUkStr.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// When a finished month's Wrapped and Player of the Month are released: 8am
// UK on the morning after the month's last game's MOTM vote closes. A vote
// closing at 1am releases at 8am that day; one closing after 8am releases at
// 8am the next day. Same pretend-UTC frame as kickoffCutoff().
export const MONTH_RELEASE_HOUR = 8;
export function monthReleaseAt(lastGameDate: string, lastGameKickoff: string) {
  const closes = kickoffCutoff(lastGameDate, lastGameKickoff, MOTM_VOTE_WINDOW_MINUTES);
  const release = `${String(MONTH_RELEASE_HOUR).padStart(2, "0")}:00`;
  if (closes.slice(11, 16) <= release) return `${closes.slice(0, 10)}T${release}`;
  return kickoffCutoff(closes.slice(0, 10), release, 24 * 60);
}
