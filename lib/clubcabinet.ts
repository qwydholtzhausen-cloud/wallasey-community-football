// The club's trophy cabinet on History: one shelf per season. Player of the
// Month cups as they're announced, then the season awards. Won awards are
// gold; the next to come wait as glass outlines. Pure and DB-free: built
// from the History timeline (lib/history.ts) and the season's goals.
import type { Chapter } from "./history";
import { monthReleaseAt } from "./time";

export type CabKind = "potm" | "pots" | "gb" | "pp" | "gg" | "gots";

export interface CabItem {
  key: string; // stable per award, for "presented to you yet?"
  kind: CabKind;
  won: boolean;
  season: boolean; // a season award (after the month cups, with a gap)
  date: string | null; // YYYY-MM-DD it was announced/awarded
  plateTop: string; // "AUGUST 2026"
  plateName: string; // "ADAM STANLEY", or "SUN 1 NOV" while it waits
  engrave: string | null; // round the bowl of a won cup
  eyebrow: string; // "Player of the Month · August"
  title: string; // the winner, or what's coming
  line: string;
  winnerIds: string[];
  race: { id: string; a: string; b: string }[] | null; // tap to lift: how it was won (or the race so far)
  raceTitle: string;
  raceNote: string;
}

export interface CabGame {
  id: string;
  date: string;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null }[];
}

const MONTH = (k: string) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
const DAY = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const SEASON: { kind: CabKind; name: string; eyebrow: string; waiting: string }[] = [
  { kind: "pots", name: "Player of the Season", eyebrow: "Season award · The big one", waiting: "The club's top award, presented after the last game in December." },
  { kind: "gb", name: "Golden Boot", eyebrow: "Season award · Top scorer", waiting: "Most goals by the last game in December." },
  { kind: "pp", name: "Players' Player", eyebrow: "Season award", waiting: "Voted for by the players, in December." },
  { kind: "gg", name: "Golden Glove", eyebrow: "Season award", waiting: "The season's best keeper, in December." },
  { kind: "gots", name: "Goal of the Season", eyebrow: "Season award", waiting: "Voted for in December." },
];

export function computeClubCabinet(input: {
  year: number; // the season (calendar year)
  today: string; // YYYY-MM-DD, London
  chapters: Chapter[];
  games: CabGame[]; // played games, any season
  goals: { game_id: string; player_id: string; goals: number }[];
  names: Map<string, string>; // real players only (test accounts are already left out)
  // Each month's last published game (played or not): Player of the Month is
  // out at 08:00 after its vote closes, with Wrapped (lib/time.ts monthReleaseAt).
  lastGameOf: (monthKey: string) => { date: string; kickoff: string } | null;
}): CabItem[] {
  const { year, today, names } = input;
  const nm = (id: string) => names.get(id) ?? "A player";
  const up = (s: string) => s.toUpperCase();
  const joint = (ids: string[]) => ids.map((id) => nm(id).split(" ")[0]).join(" & ");
  const events = input.chapters.flatMap((c) => c.events);
  const out: CabItem[] = [];

  // Player of the Month: a gold cup per announced month this season.
  const releaseDay = (k: string, fallback: string) => { const g = input.lastGameOf(k); return g ? monthReleaseAt(g.date, g.kickoff).slice(0, 10) : fallback; };
  const months = events.filter((e) => e.key.startsWith(`potm-${year}-`)).sort((a, b) => a.key.localeCompare(b.key));
  for (const e of months) {
    const k = e.key.slice(5), label = MONTH(k), s = e.scene;
    const solo = s?.type === "potm";
    const ids = solo ? [s.id] : s?.type === "people" ? s.ids : [];
    if (!ids.length) continue;
    const who = ids.length > 1 ? joint(ids) : nm(ids[0]);
    out.push({
      key: e.key, kind: "potm", won: true, season: false, date: releaseDay(k, e.date),
      plateTop: up(`${label} ${year}`), plateName: up(who), engrave: up(`${who} · ${label} ${year}`),
      eyebrow: `Player of the Month · ${label}`, title: who,
      line: solo ? (s.note ? s.note.replace(" · d", ". D") + "." : `${plural(s.stats.wins, "MOTM win")}, ${s.stats.votes} votes, ${plural(s.stats.goals, "goal")}.`) : "Shared.",
      winnerIds: ids,
      race: solo ? s.rows.slice(0, 3).map((r) => ({ id: r.id, a: plural(r.wins, "win"), b: plural(r.votes, "vote") })) : null,
      raceTitle: `${label} · The race`, raceNote: solo ? (s.note ?? "Most MOTM wins, then votes, then goals") : "",
    });
  }
  // The month being played for now waits on its plinth (never its leader:
  // no Player of the Month spoilers before it's out).
  const cur = today.slice(0, 7);
  const played = input.games.some((g) => g.date.startsWith(cur));
  if (cur.startsWith(`${year}-`) && played && !months.some((e) => e.key === `potm-${cur}`)) {
    const g = input.lastGameOf(cur), label = MONTH(cur);
    const ann = g ? monthReleaseAt(g.date, g.kickoff).slice(0, 10) : `${cur}-28`;
    out.push({
      key: `potm-${cur}`, kind: "potm", won: false, season: false, date: null,
      plateTop: up(`${label} ${year}`), plateName: up(DAY(ann)), engrave: null,
      eyebrow: `Player of the Month · ${label}`, title: `Out ${DAY(ann)}, 8am`,
      line: "The plinth is ready. The gold pours in when the winner is named.",
      winnerIds: [], race: null, raceTitle: "", raceNote: "",
    });
  }

  // The season's goals, for the Golden Boot.
  const seasonGames = input.games.filter((g) => g.date.startsWith(`${year}-`));
  const ids = new Set(seasonGames.map((g) => g.id));
  const goals = new Map<string, number>(), apps = new Map<string, number>();
  for (const x of input.goals) if (ids.has(x.game_id) && names.has(x.player_id)) goals.set(x.player_id, (goals.get(x.player_id) ?? 0) + x.goals);
  for (const g of seasonGames) for (const b of g.bookings) if (!b.waiting && b.team) apps.set(b.player_id, (apps.get(b.player_id) ?? 0) + 1);
  const scorers = [...goals.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (apps.get(a[0]) ?? 0) - (apps.get(b[0]) ?? 0) || nm(a[0]).localeCompare(nm(b[0])));
  const ft = events.find((e) => e.key === `season-ft-${year}`);
  const bootRace = scorers.slice(0, 3).map(([id, n]) => ({ id, a: plural(n, "goal"), b: plural(apps.get(id) ?? 0, "app") }));

  // Admin-added award moments this season: the first player picked won.
  const award = (kind: CabKind) =>
    events.find((e) => e.date.startsWith(`${year}-`) && e.added && ((kind === "gg" && e.scene?.type === "glove") || (e.scene?.type === "award" && { pots: "pots", pp: "pp", gots: "gs" }[kind as string] === e.scene.award)));

  for (const a of SEASON) {
    const base = { key: `${a.kind}-${year}`, kind: a.kind, season: true, eyebrow: a.eyebrow, plateTop: up(a.name), raceTitle: "", raceNote: "", race: null as CabItem["race"] };
    if (a.kind === "gb") {
      const top = scorers.length ? scorers.filter(([, n]) => n === scorers[0][1]).map(([id]) => id) : [];
      const live = { race: bootRace.length ? bootRace : null, raceTitle: ft ? "Golden Boot · Final" : "Golden Boot · The race so far", raceNote: ft ? `Season ${year - 2025}` : "Live from the Season leaderboard · awarded in December" };
      if (ft && top.length) {
        const who = top.length > 1 ? joint(top) : nm(top[0]);
        out.push({ ...base, ...live, won: true, date: ft.date, plateName: up(who), engrave: null, title: who, line: `${plural(scorers[0][1], "goal")} in Season ${year - 2025}.`, winnerIds: top });
      } else {
        const lead = scorers[0];
        out.push({ ...base, ...live, won: false, date: null, plateName: `DEC ${year}`, engrave: null, title: a.name, line: a.waiting + (lead ? ` ${nm(lead[0])} leads with ${lead[1]}.` : ""), winnerIds: [] });
      }
      continue;
    }
    const e = award(a.kind);
    const s = e?.scene;
    const win = s?.type === "award" ? s.ids[0] : s?.type === "glove" ? s.id : null;
    if (e && win) {
      out.push({ ...base, won: true, date: e.date, plateName: up(nm(win)), engrave: a.kind === "pots" ? up(`${nm(win)} · Season ${year - 2025}`) : null, title: nm(win), line: e.text || `Season ${year - 2025}.`, winnerIds: [win] });
    } else {
      out.push({ ...base, won: false, date: null, plateName: `DEC ${year}`, engrave: null, title: a.name, line: a.waiting, winnerIds: [] });
    }
  }
  return out;
}
