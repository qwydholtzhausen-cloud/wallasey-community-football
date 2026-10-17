// Occasions (2026-10-17): the First XI's matchday takeover turned into a
// reusable frame for the club's other big days. Each one switches itself on
// by date - no admin action - and only ever on the day:
// - Season finale: the last game of the calendar year (December only)
// - Christmas: the last game on or before 24 December
// - Club milestone: every 50th game the club has played (50, 100, ...)
// - Wrapped day: the morning a month's Wrapped comes out, 8am to midnight
// The First XI's own takeover outranks all of these on its day.

export type OccKind = "finale" | "christmas" | "milestone" | "wrapped";
type G = { id: string; date: string; kickoff: string; published?: boolean; called_off_at?: string | null };
export type Occasion<T extends G = G> = { kind: OccKind; game: T | null; number: number };

export function findOccasion<T extends G>({
  games,
  today,
  wrappedDay,
  preview,
}: {
  games: T[];
  today: string; // YYYY-MM-DD, UK
  wrappedDay: boolean;
  preview?: string | null; // admins: ?occasion=christmas etc.
}): Occasion<T> | null {
  const valid = games
    .filter((g) => g.published !== false && !g.called_off_at)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
  if (preview && ["finale", "christmas", "milestone", "wrapped"].includes(preview)) {
    const next = valid.find((g) => g.date >= today) ?? valid.at(-1) ?? null;
    return { kind: preview as OccKind, game: preview === "wrapped" ? null : next, number: 50 };
  }
  const game = valid.find((g) => g.date === today) ?? null;
  if (game) {
    const y = today.slice(0, 4);
    const lastOfYear = valid.filter((g) => g.date.startsWith(y)).at(-1);
    if (today.slice(5, 7) === "12" && lastOfYear && lastOfYear.date === today) return { kind: "finale", game, number: 0 };
    const xmasEve = `${y}-12-24`;
    const lastBeforeXmas = valid.filter((g) => g.date <= xmasEve && g.date >= `${y}-12-01`).at(-1);
    if (lastBeforeXmas && lastBeforeXmas.date === today) return { kind: "christmas", game, number: 0 };
    const n = valid.findIndex((g) => g.id === game.id) + 1;
    if (n > 0 && n % 50 === 0) return { kind: "milestone", game, number: n };
  }
  if (wrappedDay) return { kind: "wrapped", game: null, number: 0 };
  return null;
}
