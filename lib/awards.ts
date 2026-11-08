// Season awards (supabase/schema.sql, award_*). Nothing about a season is
// fixed here: admins set its dates, games to vote and awards in the app.
// This file only knows the shapes, the phases, the three ways an award can
// be decided, and some ideas to start from.

export type AwardKind = "player" | "shortlist" | "auto";
export type AutoRule = "most_motm" | "most_goals" | "most_apps";

export interface AwardSeason {
  season: number;
  title: string;
  min_games: number;
  nominations_from: string;
  opens_at: string;
  late_nominations_until: string;
  closes_at: string;
  reveal_at: string;
}
export interface AwardCategory {
  id: string;
  season: number;
  name: string;
  description: string | null;
  kind: AwardKind;
  auto_rule: AutoRule | null;
  allow_suggestions: boolean;
  sort: number;
}
export interface AwardNomination {
  id: string;
  category_id: string;
  status: "suggested" | "shortlisted" | "declined";
  player_id: string | null;
  game_id: string | null;
  title: string;
  detail: string | null;
  suggested_by: string | null;
  created_at: string;
}
export interface AwardVote {
  category_id: string;
  player_id: string | null;
  nomination_id: string | null;
}

export const KIND_LABEL: Record<AwardKind, string> = {
  player: "The squad picks any player",
  shortlist: "The squad picks from your shortlist",
  auto: "Worked out from the stats",
};
export const AUTO_RULES: { key: AutoRule; label: string; sub?: string }[] = [
  { key: "most_motm", label: "Most MOTM wins", sub: "Ties go to MOTM votes, then shared" },
  { key: "most_goals", label: "Most goals" },
  { key: "most_apps", label: "Most appearances" },
];

// Starting points for the Add awards sheet; every one is editable after.
export const AWARD_IDEAS: { name: string; description: string; kind: AwardKind; auto_rule?: AutoRule; allow_suggestions?: boolean }[] = [
  { name: "Players' Player", description: "The one the squad rates most.", kind: "player" },
  { name: "Unsung Hero", description: "Does the work, rarely gets the credit.", kind: "player" },
  { name: "Goal of the Season", description: "The best goal scored this season.", kind: "shortlist", allow_suggestions: true },
  { name: "Golden Glove", description: "The best keeper.", kind: "shortlist" },
  { name: "Moment of the Season", description: "The night everyone still talks about.", kind: "shortlist" },
  { name: "Player of the Season", description: "Most Man of the Match wins.", kind: "auto", auto_rule: "most_motm" },
  { name: "Golden Boot", description: "Most goals.", kind: "auto", auto_rule: "most_goals" },
  { name: "Mr Reliable", description: "Most appearances.", kind: "auto", auto_rule: "most_apps" },
  { name: "Best Newcomer", description: "The best new face this season.", kind: "player" },
  { name: "Most Improved", description: "Who's come on the most.", kind: "player" },
];

export type AwardPhase = "before" | "nominations" | "voting" | "closed" | "revealed";
export function awardPhase(s: AwardSeason, nowMs: number): AwardPhase {
  const t = (iso: string) => Date.parse(iso);
  if (nowMs >= t(s.reveal_at)) return "revealed";
  if (nowMs > t(s.closes_at)) return "closed";
  if (nowMs >= t(s.opens_at)) return "voting";
  if (nowMs >= t(s.nominations_from)) return "nominations";
  return "before";
}

// A UK wall-clock time ("2026-12-15T08:00") as a real instant, whatever
// the clocks are doing that day.
export function londonToIso(wall: string): string {
  const asUtc = Date.parse(wall + ":00Z");
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(asUtc));
  const p = (k: string) => parts.find((x) => x.type === k)?.value ?? "00";
  const shownAsUtc = Date.parse(`${p("year")}-${p("month")}-${p("day")}T${p("hour") === "24" ? "00" : p("hour")}:${p("minute")}:00Z`);
  return new Date(asUtc - (shownAsUtc - asUtc)).toISOString();
}
// The other way, for the date inputs: "2026-12-15T08:00".
export function isoToLondonWall(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const p = (k: string) => parts.find((x) => x.type === k)?.value ?? "00";
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour") === "24" ? "00" : p("hour")}:${p("minute")}`;
}
export function fmtAwardDate(iso: string, withTime = true): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
  if (!withTime) return day;
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return `${day}, ${time}`;
}

const addDays = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// Dates read off the fixture list: voting opens two weeks before the
// season's last game, closes that night, Awards Night is the next evening.
// Only a suggestion - the admin sees it and can change any of them.
export function suggestDates(lastGameDate: string, today: string) {
  const opensDay = addDays(lastGameDate, -13);
  return {
    nominations_from: londonToIso(`${today < opensDay ? today : addDays(opensDay, -14)}T00:00`),
    opens_at: londonToIso(`${opensDay}T08:00`),
    late_nominations_until: londonToIso(`${addDays(opensDay, 7)}T23:59`),
    closes_at: londonToIso(`${lastGameDate}T23:59`),
    reveal_at: londonToIso(`${addDays(lastGameDate, 1)}T20:00`),
  };
}
