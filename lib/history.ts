// Results › History ("Our story"): the club's story, worked out from the
// games every time - firsts, records, milestones, Player of the Month -
// plus the moments admins add by hand (history_moments), each slotted in
// on the day it happened. Grouped into a chapter per month.

export type HGame = {
  id: string;
  date: string;
  kickoff: string;
  pitch: string;
  max_players: number;
  special?: boolean;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: { player_id: string; waiting: boolean; team: "white" | "red" | null; promoted_at: string | null }[];
};
export type HGoal = { game_id: string; player_id: string; goals: number };
export type HPerson = { id: string; display_name: string; created_at?: string };
export type HMoment = { id: string; happened_on: string; title: string; body: string | null; kind: "note" | "goal"; player_ids: string[] };

export type Scene =
  | { type: "people"; ids: string[] }
  | { type: "score"; left: { name: string; goals: number; red: boolean }; right: { name: string; goals: number; red: boolean } }
  | { type: "goal"; id: string | null; date: string }
  | { type: "matchball"; scorerId: string; goals: number; signatures: string[]; plate: [string, string]; balls: boolean }
  | { type: "mosaic"; ids: string[] }
  | { type: "count"; n: number; label: string }
  | { type: "chain"; steps: { id: string; goals: number; date: string }[] }
  | { type: "twin"; kickoffs: string[]; soldOut: boolean; venues: string }
  // The first Man of the Match: that game's count, then the medal.
  | { type: "motmcount"; top: { id: string; votes: number; goals: number }[]; total: number; rest: number; headline: string; stamp: string }
  // An admin-added "Golden Glove" moment: the save, then the trophy.
  | { type: "glove"; id: string }
  // The premium (V4) scenes: a build-up, then the payoff.
  | { type: "live"; ids: string[]; total: number }
  | { type: "callup"; ids: string[]; max: number; head: string }
  | { type: "potm"; id: string; month: string; rows: { id: string; wins: number; votes: number }[]; note: string | null; stats: { wins: number; votes: number; goals: number } }
  | { type: "totm"; month: string; qualified: number; table: { id: string; rating: number }[]; team: { id: string; line: "front" | "mid" | "back"; captain: boolean; rating: number }[] }
  | { type: "goals"; n: number; head: string; game: number; score: string; scorers: { id: string; goals: number }[] }
  | { type: "xi"; foot: string }
  | { type: "ft"; season: number; stats: { games: number; goals: number; players: number; members: number } }
  | { type: "award"; award: "pots" | "pp" | "gs"; ids: string[]; line: string };

export type HEvent = {
  key: string;
  date: string; // YYYY-MM-DD
  order: number; // same-day order
  title: string;
  text: string;
  scene: Scene | null;
  added?: { id: string }; // added by an admin
};
export type Chapter = { monthKey: string; title: string; events: HEvent[] };

const scored = (g: HGame) => g.team_white_score != null && g.team_red_score != null;
const playing = (g: HGame) => g.bookings.filter((b) => !b.waiting && b.team);
const first = (n: string) => n.split(" ")[0].replace(/[()]/g, "");
const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const day = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const num = (n: number) => words[n] ?? String(n);
const Num = (n: number) => { const w = num(n); return w[0].toUpperCase() + w.slice(1); };

export function computeHistory(input: {
  games: HGame[];
  goals: HGoal[];
  people: HPerson[];
  motmWinnerIdsByGame: Record<string, string[]>;
  motmVotes: { game_id: string; candidate_id: string }[];
  potm: { monthKey: string; winnerIds: string[] }[];
  moments: HMoment[];
  teams: { white: string; red: string };
  // Games still to come, for "Next: the first 11-a-side".
  upcoming?: HGame[];
  // The first Team of the Month, once it's out (app/ui/totm.tsx data).
  totm?: { launched: string; monthLabel: string; qualified: number; table: { id: string; rating: number }[]; team: { id: string; line: "front" | "mid" | "back"; captain: boolean; rating: number }[] } | null;
}) {
  const { teams } = input;
  const name = new Map(input.people.map((p) => [p.id, p.display_name]));
  const nm = (id: string) => name.get(id) ?? "A player";
  const games = input.games.filter(scored).sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
  const goalsBy = new Map<string, HGoal[]>();
  input.goals.forEach((g) => goalsBy.set(g.game_id, [...(goalsBy.get(g.game_id) ?? []), g]));
  const ev: HEvent[] = [];
  const scoreScene = (g: HGame, winnerFirst = false): Scene => {
    const w = { name: teams.white.toUpperCase(), goals: g.team_white_score!, red: false };
    const r = { name: teams.red.toUpperCase(), goals: g.team_red_score!, red: true };
    const redFirst = winnerFirst ? r.goals >= w.goals : r.goals >= w.goals;
    return { type: "score", left: redFirst ? r : w, right: redFirst ? w : r };
  };
  const sigsFor = (g: HGame) => playing(g).map((b) => first(nm(b.player_id)));

  // Members, in the order they joined.
  const members = input.people.filter((p) => p.created_at).sort((a, b) => a.created_at!.localeCompare(b.created_at!));
  if (members.length >= 2)
    ev.push({ key: "app-live", date: members[0].created_at!.slice(0, 10), order: 0, title: "The app goes live", text: "The first two members sign up.", scene: { type: "live", ids: members.slice(0, 2).map((m) => m.id), total: input.people.length } });
  for (const m of [50, 100, 150, 200, 300, 400, 500]) {
    if (members.length < m) break;
    const at = members[m - 1].created_at!.slice(0, 10);
    const weeks = Math.round((Date.parse(at) - Date.parse(members[0].created_at!.slice(0, 10))) / (7 * 86400000));
    ev.push({ key: "members-" + m, date: at, order: 60, title: `${m} members`, text: m === 50 ? `${weeks > 1 ? `${Num(weeks)} weeks` : "Days"} after the first sign-up. The first ${m} accounts, in the order they joined:` : `${m} accounts and counting.`, scene: m === 50 ? { type: "mosaic", ids: members.slice(0, 50).map((x) => x.id) } : { type: "count", n: m, label: "members" } });
  }

  if (games.length) {
    const g0 = games[0];
    ev.push({ key: "first-game", date: g0.date, order: 10, title: "The first ever game", text: `${Num(playing(g0).length)} players${playing(g0).length >= g0.max_players ? ", and it was full from the start" : ""}.`, scene: scoreScene(g0) });
    const w0 = input.motmWinnerIdsByGame[g0.id] ?? [];
    if (w0.length) {
      const votes = (id: string) => input.motmVotes.filter((v) => v.game_id === g0.id && v.candidate_id === id).length;
      const goals = (id: string) => (goalsBy.get(g0.id) ?? []).find((x) => x.player_id === id)?.goals ?? 0;
      const one = w0[0];
      // The count, top three, as it was cast - a shared win keeps the faces.
      const tally = new Map<string, number>();
      input.motmVotes.filter((v) => v.game_id === g0.id).forEach((v) => tally.set(v.candidate_id, (tally.get(v.candidate_id) ?? 0) + 1));
      const total = [...tally.values()].reduce((a, b) => a + b, 0);
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => ({ id, votes: n, goals: goals(id) }));
      const won = g0.team_white_score! === g0.team_red_score! ? `${g0.team_white_score}–${g0.team_red_score}` : g0.team_red_score! > g0.team_white_score! ? `${teams.red} ${g0.team_red_score}–${g0.team_white_score} ${teams.white}` : `${teams.white} ${g0.team_white_score}–${g0.team_red_score} ${teams.red}`;
      const [y, mo, dd] = g0.date.split("-");
      ev.push({
        key: "first-motm",
        date: g0.date,
        order: 30,
        title: "The first Man of the Match",
        text: w0.length > 1 ? "A shared first Man of the Match." : goals(one) ? `${Num(goals(one))} ${goals(one) === 1 ? "goal" : "goals"} and ${num(votes(one))} votes.` : `${Num(votes(one))} votes.`,
        scene: w0.length === 1 && total > 0
          ? { type: "motmcount", top, total, rest: total - top.reduce((a, t) => a + t.votes, 0), headline: `${day(g0.date).toUpperCase()} · ${won.toUpperCase()}`, stamp: `${dd}·${mo}·${y.slice(2)}` }
          : { type: "people", ids: w0 },
      });
    }
  }

  // First time anyone came off the waiting list.
  const promo = games.find((g) => g.bookings.some((b) => b.promoted_at));
  if (promo) {
    const ids = promo.bookings.filter((b) => b.promoted_at).map((b) => b.player_id);
    ev.push({ key: "first-promotion", date: promo.date, order: 40, title: "First time off the waiting list", text: ids.length > 1 ? `${Num(ids.length)} spots opened up, and the first ${num(ids.length)} in the queue got their game.` : "A spot opened up, and the first in the queue got their game.", scene: { type: "callup", ids: ids.slice(0, 2), max: promo.max_players, head: `${day(promo.date).toUpperCase()} · ${promo.kickoff}` } });
  }

  // Most goals by one player in a game: every time the record went up.
  const chain: { id: string; goals: number; date: string; game: HGame }[] = [];
  for (const g of games) {
    const top = (goalsBy.get(g.id) ?? []).reduce<HGoal | null>((m, x) => (!m || x.goals > m.goals ? x : m), null);
    if (top && top.goals > (chain.at(-1)?.goals ?? 0)) chain.push({ id: top.player_id, goals: top.goals, date: g.date, game: g });
  }
  const hat = games.find((g) => (goalsBy.get(g.id) ?? []).some((x) => x.goals >= 3));
  if (hat) {
    const s = (goalsBy.get(hat.id) ?? []).filter((x) => x.goals >= 3).sort((a, b) => b.goals - a.goals)[0];
    ev.push({ key: "first-hattrick", date: hat.date, order: 20, title: "The first hat-trick, and the first match ball", text: `${nm(s.player_id)}: ${num(s.goals)} goals in a ${hat.team_white_score}–${hat.team_red_score}, and the match ball, signed by everyone who played.`, scene: { type: "matchball", scorerId: s.player_id, goals: s.goals, signatures: sigsFor(hat), plate: [`FIRST HAT-TRICK · ${s.goals} GOALS`, day(hat.date).toUpperCase() + " " + hat.date.slice(0, 4)], balls: false } });
  }
  if (chain.length >= 3) {
    const last = chain[chain.length - 1];
    ev.push({ key: "record-chain", date: last.date, order: 70, title: "The record that keeps falling", text: `Most goals by one player in a game. Broken ${num(chain.length - 1)} times:`, scene: { type: "chain", steps: chain.slice(-6).map((c) => ({ id: c.id, goals: c.goals, date: c.date })) } });
  }
  const rec = chain.at(-1);
  if (rec && rec.goals >= 4 && rec.game.id !== hat?.id) {
    const g = rec.game;
    const total = g.team_white_score! + g.team_red_score!;
    const highest = games.every((x) => x.team_white_score! + x.team_red_score! <= total);
    ev.push({ key: "record-" + g.id, date: g.date, order: 50, title: `${nm(rec.id)}'s ${num(rec.goals)}`, text: `The club record, in a ${g.team_white_score}–${g.team_red_score}${highest ? ` that's also the highest-scoring game ever (${total})` : ""}.`, scene: { type: "matchball", scorerId: rec.id, goals: rec.goals, signatures: sigsFor(g), plate: [`CLUB RECORD · ${rec.goals} GOALS`, day(g.date).toUpperCase() + " " + g.date.slice(0, 4)], balls: true } });
  }

  // Biggest win: the first game to reach the margin that still stands.
  let best: HGame | null = null;
  const margin = (g: HGame) => Math.abs(g.team_white_score! - g.team_red_score!);
  for (const g of games) if (!best || margin(g) > margin(best)) best = g;
  if (best && margin(best) >= 5) {
    const equalled = games.filter((g) => g.id !== best!.id && margin(g) === margin(best!) && g.date > best!.date);
    const w = best.team_white_score! > best.team_red_score!;
    ev.push({ key: "biggest-win", date: best.date, order: 45, title: "The biggest win", text: `${Math.max(best.team_white_score!, best.team_red_score!)}–${Math.min(best.team_white_score!, best.team_red_score!)} to the ${w ? teams.white : teams.red}.${equalled.length ? ` ${day(equalled.at(-1)!.date)} equalled it, but nobody's beaten it.` : " Nobody's beaten it."}`, scene: scoreScene(best) });
  }

  // Club goals: 100, 150, then every 100.
  let total = 0;
  const marks = [100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  let mi = 0;
  games.forEach((g, i) => {
    total += g.team_white_score! + g.team_red_score!;
    while (mi < marks.length && total >= marks[mi]) {
      const m = marks[mi];
      const prev = ev.filter((e) => e.key.startsWith("goals-")).at(-1);
      const gap = prev ? Math.round((Date.parse(g.date) - Date.parse(prev.date)) / 86400000) : 0;
      const scorers = (goalsBy.get(g.id) ?? []).filter((x) => x.goals > 0).sort((a, b) => b.goals - a.goals).slice(0, 4).map((x) => ({ id: x.player_id, goals: x.goals }));
      const long = new Date(g.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
      ev.push({ key: "goals-" + m, date: g.date, order: 65, title: `${m} club goals`, text: prev ? `${gap <= 1 ? "A day" : `${Num(gap)} days`} after the ${prev.title.split(" ")[0]}th.` : `Reached in the club's ${nth(i + 1)} game.`, scene: { type: "goals", n: m, head: long, game: i + 1, score: `${teams.white} ${g.team_white_score}–${g.team_red_score} ${teams.red}`, scorers } });
      mi++;
    }
  });

  // The first night with two games on it.
  const byDate = new Map<string, HGame[]>();
  games.forEach((g) => byDate.set(g.date, [...(byDate.get(g.date) ?? []), g]));
  const twin = [...byDate.entries()].find(([, gs]) => gs.length >= 2);
  if (twin) {
    const [d, gs] = twin;
    const sold = gs.every((g) => playing(g).length >= g.max_players);
    ev.push({ key: "first-twin", date: d, order: 15, title: "The first two-game night", text: `One night, ${num(gs.length)} pitches, ${num(gs.length)} kick-offs${sold ? (gs.length === 2 ? ", and both sold out" : ", and all sold out") : ""}.`, scene: { type: "twin", kickoffs: gs.map((g) => g.kickoff), soldOut: sold, venues: "" } });
  }

  // The first 11-a-side.
  const big = games.find((g) => g.max_players >= 20 || /11/.test(g.pitch));
  if (big) ev.push({ key: "first-11", date: big.date, order: 12, title: "The first 11-a-side", text: `${playing(big).length} players, ${big.kickoff} kick-off.`, scene: { type: "xi", foot: `${teams.white} ${big.team_white_score}–${big.team_red_score} ${teams.red}` } });

  // Player of the Month, announced on the 1st of the next month.
  for (const p of input.potm) {
    if (!p.winnerIds.length) continue;
    const [y, m] = p.monthKey.split("-").map(Number);
    const ann = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
    // The month's table, the way it was decided: wins, then votes, then goals.
    const st = new Map<string, { id: string; wins: number; votes: number; goals: number }>();
    const row = (id: string) => st.get(id) ?? (st.set(id, { id, wins: 0, votes: 0, goals: 0 }), st.get(id)!);
    const monthGames = games.filter((g) => g.date.startsWith(p.monthKey));
    const ids = new Set(monthGames.map((g) => g.id));
    for (const g of monthGames) (input.motmWinnerIdsByGame[g.id] ?? []).forEach((id) => row(id).wins++);
    input.motmVotes.forEach((v) => ids.has(v.game_id) && row(v.candidate_id).votes++);
    input.goals.forEach((x) => ids.has(x.game_id) && st.has(x.player_id) && (row(x.player_id).goals += x.goals));
    const win = p.winnerIds[0];
    const rows = [...st.values()].sort((a, b) => Number(b.id === win) - Number(a.id === win) || b.wins - a.wins || b.votes - a.votes || b.goals - a.goals).slice(0, 4);
    const [a, b] = rows;
    const note = !b || b.wins !== a.wins ? null : b.votes !== a.votes ? `Level on wins · decided on votes, ${a.votes}–${b.votes}` : `Level on wins and votes · decided on goals, ${a.goals}–${b.goals}`;
    const one = p.winnerIds.length === 1 && rows[0]?.id === win;
    ev.push({ key: "potm-" + p.monthKey, date: ann, order: 5, title: `${label}'s Player of the Month`, text: p.winnerIds.length > 1 ? `Shared between ${p.winnerIds.map((id) => first(nm(id))).join(" and ")}.` : `${nm(p.winnerIds[0])}.`, scene: one ? { type: "potm", id: win, month: label, rows: rows.map(({ id, wins, votes }) => ({ id, wins, votes })), note, stats: { wins: a.wins, votes: a.votes, goals: a.goals } } : { type: "people", ids: p.winnerIds } });
  }

  // The first Team of the Month, on the day Team of the Month launched.
  if (input.totm)
    ev.push({
      key: "first-totm",
      date: input.totm.launched,
      order: 6,
      title: "The first Team of the Month",
      text: `${input.totm.monthLabel}'s best eight, by match rating, captained by the Player of the Month.`,
      scene: {
        type: "totm",
        month: input.totm.monthLabel,
        qualified: input.totm.qualified,
        // The eight first (the captain is always in it), then the rest, each by rating.
        table: [...input.totm.table].sort((a, b) => Number(input.totm!.team.some((t) => t.id === b.id)) - Number(input.totm!.team.some((t) => t.id === a.id)) || b.rating - a.rating).slice(0, 10),
        team: input.totm.team,
      },
    });

  // Full time on a season: its last game, once there are none left that year in December.
  const years = [...new Set(games.map((g) => g.date.slice(0, 4)))];
  for (const y of years) {
    const yg = games.filter((g) => g.date.startsWith(y));
    const lastG = yg[yg.length - 1];
    if (!lastG.date.startsWith(`${y}-12`) || (input.upcoming ?? []).some((g) => g.date.startsWith(y))) continue;
    const pl = new Set(yg.flatMap((g) => playing(g).map((b) => b.player_id)));
    const season = Number(y) - 2025;
    ev.push({ key: "season-ft-" + y, date: lastG.date, order: 95, title: `Season ${num(season).replace(/^./, (c) => c.toUpperCase())}: full time`, text: `The last game of ${y}.`, scene: { type: "ft", season, stats: { games: yg.length, goals: yg.reduce((t, g) => t + g.team_white_score! + g.team_red_score!, 0), players: pl.size, members: input.people.length } } });
  }

  // Moments added by admins, on the day they happened.
  for (const m of input.moments)
    ev.push({
      key: "moment-" + m.id,
      date: m.happened_on,
      order: m.kind === "goal" ? 18 : 25,
      title: m.title,
      text: m.body ?? "",
      // Award titles get their scenes: the winner is the first player picked
      // (the rest are the shortlist). "Golden Glove" gets the save.
      scene:
        m.kind === "goal"
          ? { type: "goal", id: m.player_ids[0] ?? null, date: m.happened_on }
          : /golden glove/i.test(m.title) && m.player_ids.length === 1
            ? { type: "glove", id: m.player_ids[0] }
            : m.player_ids.length && /players.?\s*player/i.test(m.title)
              ? { type: "award", award: "pp", ids: m.player_ids, line: m.body ?? "" }
              : m.player_ids.length && /player of the season/i.test(m.title)
                ? { type: "award", award: "pots", ids: m.player_ids, line: m.body ?? "" }
                : m.player_ids.length && /goal of the season/i.test(m.title)
                  ? { type: "award", award: "gs", ids: m.player_ids, line: m.body ?? "" }
                  : m.player_ids.length
                    ? { type: "people", ids: m.player_ids }
                    : null,
      added: { id: m.id },
    });

  ev.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  // A chapter per month.
  const chapters: Chapter[] = [];
  for (const e of ev) {
    const mk = e.date.slice(0, 7);
    if (chapters.at(-1)?.monthKey !== mk) chapters.push({ monthKey: mk, title: "", events: [] });
    chapters.at(-1)!.events.push(e);
  }
  chapters.forEach((c, i) => {
    const has = (p: string) => c.events.some((e) => e.key.startsWith(p));
    c.title = i === 0 ? "Where it began" : has("record") ? "Records fall" : has("first-twin") || has("first-11") ? "Bigger nights" : has("goals-") || has("members-") ? "Milestones" : "The story continues";
  });

  // The next "first" on the calendar, shown at the top as what's coming.
  const nextBig = !big ? (input.upcoming ?? []).filter((g) => !scored(g) && (g.max_players >= 20 || /11/.test(g.pitch))).sort((a, b) => a.date.localeCompare(b.date))[0] : undefined;
  const upcoming = nextBig
    ? { title: "Next: the first 11-a-side", date: nextBig.date, kickoff: nextBig.kickoff, text: `${day(nextBig.date)}, ${nextBig.kickoff} · ${nextBig.bookings.filter((b) => !b.waiting).length} booked${nextBig.bookings.some((b) => b.waiting) ? `, ${nextBig.bookings.filter((b) => b.waiting).length} waiting` : ""}` }
    : null;

  const players = new Set(games.flatMap((g) => playing(g).map((b) => b.player_id)));
  return {
    chapters,
    upcoming,
    totals: { members: input.people.length, games: games.length, goals: total, players: players.size },
  };
}
