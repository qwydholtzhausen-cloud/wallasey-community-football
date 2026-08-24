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

// Current UK wall-clock time as "YYYY-MM-DDTHH:MM", regardless of the
// server/browser's own timezone.
export function nowInLondon() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
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
