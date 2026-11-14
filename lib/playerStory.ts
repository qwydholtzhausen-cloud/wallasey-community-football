// A player's season as a story, for the player page (app/ui/playerpage.tsx).
// Pure: the app hands in the player's own played games for the season
// (oldest first) and their trophy cabinet, and gets back everything the
// page shows - headline, numbers, form and streaks, the record book,
// signature moments, honours and milestones. Every line is only written
// when the data supports it, so a two-game player gets a short, true page.

import type { Trophy, TrophyKind } from "./cabinet";
import { APPS_MILESTONES } from "./cabinet";

export interface StoryGame {
  id: string;
  date: string; // YYYY-MM-DD
  team: "white" | "red";
  us: number; // their side's goals
  them: number;
  goals: number; // goals they scored
  votes: number; // MOTM votes they got (closed votes only)
  topVotes: number; // most votes anyone got that night
  motm: boolean; // they won Man of the Match
  motmName: string | null; // who did, when it wasn't them
  special: boolean; // a one-off special (the First XI)
}

export interface StoryInput {
  games: StoryGame[];
  firstClubGameDate: string | null;
  clubGames: number; // games the club has played this season
  appsRank: number; // 1 = most games at the club
  goalsRank: number; // 1 = most goals (0 when no goals)
  memberNo: number | null;
  joined: string | null; // YYYY-MM-DD
  teamName: (t: "white" | "red") => string;
  firstName: string;
  trophies: Trophy[];
  year: number;
}

export type Res = "W" | "D" | "L";
export interface Num { v: string; l: string; s: string; gold?: boolean }
export interface Run { n: number; from: string; to: string; times: number }
export interface Moment { date: string; d: string; h: string; p: string; sc?: string; gold?: boolean }
export interface Honour { kind: TrophyKind; k: string; b: string; p: string; more: string[]; x: number; keys: string[] }
export interface Milestone { kind: TrophyKind; n?: number; b: string; d: string; key: string }

export interface Story {
  short: boolean;
  big: string;
  kicker: string;
  line: string;
  numsTitle: string;
  nums: Num[];
  last: { r: Res; d: string }[];
  streak: { kind: "win" | "unbeaten"; n: number } | null;
  bestWin: Run | null;
  bestUnbeaten: Run | null;
  strip: { r: Res; goals: number; tip: string }[];
  records: { k: string; v: string; p: string; gold?: boolean }[];
  momTitle: string;
  moments: Moment[];
  honours: Honour[];
  milestones: Milestone[];
  nextMilestone: string | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const at = (d: string) => new Date(d + "T12:00:00Z");
export const dayLabel = (d: string) => { const x = at(d); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
export const shortDay = (d: string) => { const x = at(d); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const ord = (n: number) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = one + "s") => (n === 1 ? one : many);
// "an 8–1 win", "an 11–0 win", "a 6–6 draw"
const a = (n: number) => (/^(8|11|18)/.test(String(n)) ? "an" : "a");

export const resultOf = (g: StoryGame): Res => (g.us === g.them ? "D" : g.us > g.them ? "W" : "L");

function bestRun(games: StoryGame[], ok: (r: Res) => boolean): Run | null {
  let best: Run | null = null;
  let cur = 0, start = "";
  const runs: number[] = [];
  games.forEach((g, i) => {
    if (ok(resultOf(g))) {
      if (cur === 0) start = g.date;
      cur++;
      if (!best || cur > best.n) best = { n: cur, from: start, to: g.date, times: 0 };
    } else {
      if (cur) runs.push(cur);
      cur = 0;
    }
    if (i === games.length - 1 && cur) runs.push(cur);
  });
  if (!best) return null;
  const b = best as Run;
  b.times = runs.filter((r) => r === b.n).length;
  return b;
}

const LEAD_ORDER: TrophyKind[] = ["potm", "record", "totm", "ximedal", "matchball", "motm", "xipennant"];

function honoursFrom(trophies: Trophy[]): { honours: Honour[]; milestones: Milestone[] } {
  const by = (k: TrophyKind) => trophies.filter((t) => t.kind === k).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const honours: Honour[] = [];
  const add = (kind: TrophyKind, h: Omit<Honour, "kind" | "keys" | "x"> & { list: Trophy[] }) =>
    honours.push({ kind, k: h.k, b: h.b, p: h.p, more: h.more, x: h.list.length, keys: h.list.map((t) => t.key) });
  const potm = by("potm");
  if (potm.length) add("potm", { list: potm, k: "Player of the Month", b: potm.map((t) => t.detail.split(" · ")[0].replace(/ \d{4}$/, "")).join(" & "), p: potm.length > 1 ? `Voted the month's best, ${word(potm.length)} times.` : "Voted the month's best.", more: potm.map((t) => t.detail) });
  for (const t of by("record")) {
    const [label, value] = t.detail.split(" · ");
    honours.push({ kind: "record", k: "Club record", b: value ? `${label}` : t.title, p: value ? cap(value) + "." : t.detail, more: [t.detail], x: 1, keys: [t.key] });
  }
  const totm = by("totm");
  if (totm.length) add("totm", { list: totm, k: "Team of the Month", b: totm.map((t) => t.detail.replace(/ \d{4}.*$/, "")).join(" & "), p: totm.length > 1 ? `Picked in the month's best XI, ${word(totm.length)} times.` : "Picked in the month's best XI.", more: [...totm].reverse().map((t) => t.detail) });
  const xm = by("ximedal");
  if (xm.length) add("ximedal", { list: xm, k: "The First XI", b: "Man of the Match", p: xm[0].detail, more: xm.map((t) => t.detail) });
  const mb = by("matchball");
  if (mb.length) add("matchball", { list: mb, k: "Match ball", b: mb.length > 1 ? `${word(mb.length)} hat-tricks` : "Hat-trick", p: mb[mb.length - 1].detail, more: mb.map((t) => t.detail) });
  const motm = by("motm");
  if (motm.length) add("motm", { list: motm, k: "Man of the Match", b: motm.length > 1 ? `${cap(word(motm.length))} times` : "Once", p: motm.length > 1 ? "Voted best on the night by the squad." : motm[0].detail, more: [...motm].reverse().map((t) => t.detail) });
  const pen = by("xipennant"), card = by("xicard");
  if (pen.length || card.length) {
    const c = card[0];
    honours.push({ kind: "xipennant", k: "The First XI", b: c ? c.detail.split(" · ")[0] : "In the side", p: (pen[0] ?? c).detail.split(" · ").slice(-2).join(", ") + ".", more: [...pen, ...card].map((t) => `${t.title} · ${t.detail.split(" · ").pop()}`), x: 1, keys: [...pen, ...card].map((t) => t.key) });
  }
  honours.sort((a, b) => LEAD_ORDER.indexOf(a.kind) - LEAD_ORDER.indexOf(b.kind));
  const milestones: Milestone[] = [];
  for (const t of by("debut")) milestones.push({ kind: "debut", b: "Debut cap", d: t.detail.replace(/^First game · /, "").replace(/ (Whites|Reds)$/, ""), key: t.key });
  for (const t of by("apps")) milestones.push({ kind: "apps", n: t.n, b: `${t.n} games`, d: t.detail.replace(/^Reached /, ""), key: t.key });
  return { honours, milestones };
}

export function buildStory(input: StoryInput): Story {
  const G = input.games;
  const apps = G.length;
  const R = G.map(resultOf);
  const W = R.filter((r) => r === "W").length, D = R.filter((r) => r === "D").length, L = R.filter((r) => r === "L").length;
  const goals = G.reduce((s, g) => s + g.goals, 0);
  const scoredIn = G.filter((g) => g.goals > 0).length;
  const votes = G.reduce((s, g) => s + g.votes, 0);
  const motmWins = G.filter((g) => g.motm).length;
  const maxGoals = Math.max(0, ...G.map((g) => g.goals));
  const short = apps < 6;
  const sc = (g: StoryGame) => `${input.teamName(g.team)} ${g.us}–${g.them}`;
  const resWord = (g: StoryGame) => ({ W: "win", D: "draw", L: "defeat" })[resultOf(g)];
  const inA = (g: StoryGame) => `${a(g.us)} ${g.us}–${g.them} ${resWord(g)}`;
  const closeCall = G.find((g) => !g.motm && g.votes > 0 && g.votes === g.topVotes);
  const debut = G[0];
  const firstNight = !!debut && debut.date === input.firstClubGameDate;

  // Headline: goals for the club's top scorers, games for everyone else.
  const goalsBig = goals > 0 && ((input.goalsRank > 0 && input.goalsRank <= 3) || goals > apps);
  const big = String(goalsBig ? goals : apps);
  const kicker = [input.memberNo ? `Member Nº ${String(input.memberNo).padStart(3, "0")}` : null, input.joined ? `since ${shortDay(input.joined)}` : null].filter(Boolean).join(" · ");
  let line: string;
  if (!apps) line = "The first game's still to come.";
  else if (goalsBig && input.goalsRank === 1) line = `${goals} goals. Nobody's scored more.`;
  else if (firstNight) line = "There from the very first night.";
  else if (short) line = `${cap(word(apps))} ${plural(apps, "game")} in${goals ? ", and off the mark." : "."}`;
  else if (goalsBig) line = goals > apps ? `${goals} goals in ${apps} games.` : `${goals} goals, ${ord(input.goalsRank)} at the club.`;
  else line = input.appsRank <= 5 ? `${apps} games, ${ord(input.appsRank)} most at the club.` : `${apps} games and counting.`;

  const nums: Num[] = [
    { v: String(apps), l: plural(apps, "Game"), s: input.appsRank > 0 && input.appsRank <= 10 && apps > 0 ? (input.appsRank === 1 ? "the most at the club" : `${ord(input.appsRank)} most at the club`) : `of the club's ${input.clubGames}`, gold: !goalsBig },
    { v: String(W), l: plural(W, "Win"), s: `${W} won, ${D} drawn, ${L} lost` },
    { v: String(goals), l: plural(goals, "Goal"), s: goals ? (goals === 1 ? `on ${dayLabel(G.find((g) => g.goals > 0)!.date)}` : scoredIn === 1 ? "all in one game" : `in ${word(scoredIn)} different games`) : "still to come", gold: goalsBig },
    { v: String(votes), l: plural(votes, "MOTM vote"), s: "from the squad" },
    { v: String(motmWins), l: plural(motmWins, "MOTM win"), s: motmWins ? (motmWins === 1 ? "voted best on the night once" : `voted best on the night ${word(motmWins)} times`) : closeCall ? `so close on ${shortDay(closeCall.date)}` : "still to come" },
    { v: apps ? (goals / apps).toFixed(1) : "0.0", l: "Per game", s: maxGoals >= 2 ? `goals, best ${maxGoals} in a game` : "goals" },
  ];

  // Form and streaks.
  const last = G.slice(-5).map((g) => ({ r: resultOf(g), d: shortDay(g.date) }));
  let w = 0; for (let i = R.length - 1; i >= 0 && R[i] === "W"; i--) w++;
  let u = 0; for (let i = R.length - 1; i >= 0 && R[i] !== "L"; i--) u++;
  const streak = w >= 2 ? { kind: "win" as const, n: w } : u >= 2 ? { kind: "unbeaten" as const, n: u } : null;
  const bestWin = bestRun(G, (r) => r === "W");
  const bestUnbeaten = bestRun(G, (r) => r !== "L");
  const strip = G.map((g) => ({ r: resultOf(g), goals: g.goals, tip: `${dayLabel(g.date)} · ${input.teamName(g.team)} ${({ W: "won", D: "drew", L: "lost" })[resultOf(g)]} ${g.us}–${g.them}` }));

  // The record book: only for a real season's worth, and only true records.
  const records: Story["records"] = [];
  if (!short) {
    if (input.memberNo) records.push({ k: input.memberNo <= 10 ? "Founding member" : "Member", v: `Nº ${String(input.memberNo).padStart(3, "0")}`, gold: true, p: input.memberNo === 1 ? `First to sign up${input.joined ? `, on ${shortDay(input.joined)}` : ""}.` : input.joined ? `Signed up on ${dayLabel(input.joined)}.` : "One of the club's members." });
    const biggest = [...G].filter((g) => g.us - g.them >= 3).sort((a, b) => b.us - b.them - (a.us - a.them) || b.us - a.us)[0];
    if (biggest) records.push({ k: "Biggest win", v: `${biggest.us}–${biggest.them}`, p: `${dayLabel(biggest.date)} with the ${input.teamName(biggest.team)}.${biggest.goals ? ` ${cap(word(biggest.goals))} of the goals from ${input.firstName}.` : ""}` });
    if (maxGoals >= 2) {
      const tops = G.filter((g) => g.goals === maxGoals);
      records.push({ k: "Most in a game", v: String(maxGoals), p: tops.length > 1 ? `${tops.length === 2 ? "Twice" : cap(word(tops.length)) + " times"}, most recently ${dayLabel(tops[tops.length - 1].date)}.` : `${dayLabel(tops[0].date)}, ${inA(tops[0])}.` });
    }
    const mostVotes = [...G].sort((a, b) => b.votes - a.votes)[0];
    if (mostVotes && mostVotes.votes >= 3) records.push({ k: "Most MOTM votes in a game", v: String(mostVotes.votes), p: `${dayLabel(mostVotes.date)}, ${sc(mostVotes)}.` });
  }

  // Signature moments, oldest first, only what really happened.
  const moments: Moment[] = [];
  const push = (g: StoryGame, h: string, p: string, gold = false, score = true) => moments.push({ date: g.date, d: dayLabel(g.date), h, p, sc: score ? sc(g) : undefined, gold });
  if (debut) {
    if (firstNight) push(debut, "The first ever game", `On the pitch the night the club began. ${input.teamName(debut.team)} ${({ W: "won it", D: "drew it", L: "lost it" })[resultOf(debut)]}.`, true);
    else push(debut, "Debut", `First game, for the ${input.teamName(debut.team)}.`);
  }
  const firstGoal = G.find((g) => g.goals > 0);
  if (firstGoal) {
    if (firstGoal === debut) { moments.pop(); push(firstGoal, firstNight ? "Scored on the first night" : "Scored on debut", `${firstGoal.goals > 1 ? cap(word(firstGoal.goals)) + " goals" : "A goal"} first time out, in ${inA(firstGoal)}.`, true); }
    else if (firstGoal.goals >= 3) push(firstGoal, firstGoal.goals >= 4 ? `${cap(word(firstGoal.goals))} in one night` : "Hat-trick", `Off the mark with ${word(firstGoal.goals)}, in ${inA(firstGoal)}.`, true);
    else push(firstGoal, "Off the mark", `${firstGoal.goals === 2 ? "Two first goals" : "The first goal"}, in ${inA(firstGoal)}.`, short);
  }
  const hat = G.find((g) => g.goals >= 3);
  if (hat && hat !== firstGoal) push(hat, hat.goals >= 4 ? `${cap(word(hat.goals))} in one night` : "Hat-trick", `${cap(word(hat.goals))} goals in ${inA(hat)}.${hat.motm ? ` Man of the Match too, with ${word(hat.votes)} ${plural(hat.votes, "vote")}.` : ""}`, true);
  else {
    const brace = G.find((g) => g.goals === 2 && g !== firstGoal);
    if (brace) push(brace, `Two in ${a(brace.us)} ${brace.us}–${brace.them}`, `A brace${brace.motm ? ", and Man of the Match" : ""}.`, false, false);
  }
  G.filter((g) => g.motm && !g.special && !(hat && g === hat) && !moments.some((m) => m.date === g.date && /Two in/.test(m.h))).slice(0, 2).forEach((g) => push(g, "Man of the Match", `${cap(word(g.votes))} ${plural(g.votes, "vote")} from the squad${g.goals ? `, and ${g.goals === 1 ? "a goal" : word(g.goals) + " goals"}` : ""}.`, true));
  if (closeCall && !motmWins) push(closeCall, "Level for Man of the Match", `${cap(word(closeCall.votes))} ${plural(closeCall.votes, "vote")}, joint top of the night.${closeCall.motmName ? ` It went to ${closeCall.motmName.split(" ")[0]} on goals.` : ""}`, true);
  const xi = G.find((g) => g.special);
  if (xi) push(xi, "The First XI", `In the side for the club's first 11-a-side${xi.motm ? ", and Man of the Match on the day" : ""}.`, true, false);
  if (short) { const fw = G.find((g) => resultOf(g) === "W"); if (fw && fw !== debut && !moments.some((m) => m.date === fw.date)) push(fw, "First win", `${sc(fw)}.`, false, false); }
  moments.sort((a, b) => a.date.localeCompare(b.date));
  while (moments.length > 6) { const i = moments.findIndex((m) => !m.gold); moments.splice(i >= 0 ? i : moments.length - 1, 1); }

  const { honours, milestones } = honoursFrom(input.trophies);
  const nextM = APPS_MILESTONES.find((m) => m > apps);
  const nextMilestone = nextM && apps > 0 ? `Next: the ${nextM}-game shirt, ${word(nextM - apps)} ${plural(nextM - apps, "game")} away.` : null;

  return {
    short, big, kicker, line,
    numsTitle: short ? "So far" : `${input.year} in numbers`,
    nums, last, streak, bestWin, bestUnbeaten, strip, records,
    momTitle: short ? "First steps" : "Signature moments",
    moments, honours, milestones, nextMilestone,
  };
}
