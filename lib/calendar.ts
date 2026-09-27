// "Add to calendar" for a fixture. Shared by the .ics route
// (app/api/calendar/[gameId]/route.ts) and the fixture card's Google
// Calendar link, so both describe a game identically.
//
// Times are written as UK wall-clock with TZID=Europe/London and a full
// VTIMEZONE block, rather than converted to UTC here. The app stores
// kickoff as UK wall-clock (see lib/time.ts), and letting the calendar app
// apply the BST/GMT rules means a game either side of the October clock
// change still lands at 20:00, never 19:00 or 21:00.
import { kickoffCutoff, MATCH_DURATION_MINUTES } from "./time";

export const CALENDAR_SITE = "https://www.wirral-community-football.com";

export interface CalendarGame {
  id: string;
  date: string; // YYYY-MM-DD, UK
  kickoff: string; // HH:MM, UK
  venue: string;
  pitch: string;
  price: number;
}

// "2026-10-05" + "20:00" -> "20261005T200000" (UK wall-clock, no zone)
function wallClock(date: string, kickoff: string, plusMinutes = 0) {
  const iso = kickoffCutoff(date, kickoff, plusMinutes); // pure wall-clock arithmetic
  return iso.replace(/[-:]/g, "") + "00";
}

// RFC 5545 text escaping.
function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// Byte length via TextEncoder rather than Node's Buffer: this module is
// also imported by the fixture card, which runs in the browser.
const bytes = (s: string) => new TextEncoder().encode(s).length;

// RFC 5545 wants lines no longer than 75 octets; longer ones continue on
// the next line after a single leading space.
function fold(line: string) {
  const out: string[] = [];
  let rest = line;
  while (bytes(rest) > 75) {
    let cut = 75;
    while (bytes(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function calendarTitle(g: CalendarGame) {
  return `Football — ${g.venue}`;
}

export function calendarDetails(g: CalendarGame) {
  return `${g.pitch} · £${g.price}. Your booking and the line-up: ${CALENDAR_SITE}`;
}

export function buildIcs(g: CalendarGame, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wirral Community Football//Fixtures//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/London",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:BST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    // One stable UID per game, so adding it again updates the existing
    // entry (e.g. after a kickoff change) instead of creating a duplicate.
    `UID:game-${g.id}@wirral-community-football.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/London:${wallClock(g.date, g.kickoff)}`,
    `DTEND;TZID=Europe/London:${wallClock(g.date, g.kickoff, MATCH_DURATION_MINUTES)}`,
    `SUMMARY:${esc(calendarTitle(g))}`,
    `LOCATION:${esc(g.venue)}`,
    `DESCRIPTION:${esc(calendarDetails(g))}`,
    `URL:${CALENDAR_SITE}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(`Football at ${g.kickoff} — ${g.venue}`)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// Google Calendar's own "add event" page. Local times plus ctz, for the
// same reason as the .ics above.
export function googleCalendarUrl(g: CalendarGame) {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: calendarTitle(g),
    dates: `${wallClock(g.date, g.kickoff)}/${wallClock(g.date, g.kickoff, MATCH_DURATION_MINUTES)}`,
    ctz: "Europe/London",
    location: g.venue,
    details: calendarDetails(g),
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
