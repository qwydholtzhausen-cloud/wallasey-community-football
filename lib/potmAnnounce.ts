import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushBroadcast } from "./push";
import { kickoffCutoff, previousMonthKey, monthReleaseAt, MOTM_VOTE_WINDOW_MINUTES } from "./time";
import { motmWinners, goalsLookup } from "./motm";

// Player of the Month announcement (push to everyone), once per month.
// Announced when the month's last published game is played and its vote has
// closed, at the 8am release (lib/time.ts monthReleaseAt) - the same moment
// the app's Season card and Wrapped switch over - else last month's on the
// 1st. The potm-YYYY-MM key stops it going out twice. Tie-breaks match the
// app: MOTM wins, then votes, then goals that month.
export async function announcePlayerOfMonth(
  admin: SupabaseClient,
  nowUk: string,
  notifiedKeys: Set<string>,
  markNotified: (key: string) => Promise<void>
) {
  const { data: games } = await admin
    .from("games")
    .select("id, date, kickoff, published, team_white_score, team_red_score")
    .gte("date", `${previousMonthKey(nowUk)}-01`)
    .lte("date", `${nowUk.slice(0, 7)}-31`);
  const all = (games ?? []) as { id: string; date: string; kickoff: string; published: boolean; team_white_score: number | null; team_red_score: number | null }[];
  const typedGames = all.filter((g) => g.team_white_score != null && g.team_red_score != null);
  const { data: votes } = await admin.from("motm_votes").select("game_id, candidate_id").in("game_id", typedGames.map((g) => g.id));
  const allVotes = votes ?? [];
  const { data: allGoalRows } = await admin.from("game_stats").select("game_id, player_id, goals").in("game_id", typedGames.map((g) => g.id));
  const goalsIn = goalsLookup(allGoalRows);

  const thisMonth = nowUk.slice(0, 7);
  const thisMonthRows = all.filter((g) => g.published && g.date.startsWith(thisMonth));
  const lastThisMonth = [...(thisMonthRows ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)).at(-1);
  const thisMonthFinished =
    (thisMonthRows ?? []).length > 0 &&
    (thisMonthRows ?? []).every(
      (g) => g.team_white_score != null && g.team_red_score != null && kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) <= nowUk
    ) &&
    nowUk >= monthReleaseAt(lastThisMonth!.date, lastThisMonth!.kickoff);
  const monthKey = thisMonthFinished ? thisMonth : previousMonthKey(nowUk);
  const potmKey = `potm-${monthKey}`;
  if (!notifiedKeys.has(potmKey)) {
    const monthGames = typedGames.filter((g) => g.date.startsWith(monthKey));
    if (monthGames.length >= 2) {
      const wins: Record<string, number> = {};
      const voteTotals: Record<string, number> = {};
      for (const g of monthGames) {
        const gameVotes = allVotes.filter((v) => v.game_id === g.id);
        if (gameVotes.length === 0) continue;
        const tally: Record<string, number> = {};
        for (const v of gameVotes) tally[v.candidate_id] = (tally[v.candidate_id] ?? 0) + 1;
        const gameWinners = motmWinners(tally, goalsIn(g.id));
        for (const [id, count] of Object.entries(tally)) {
          voteTotals[id] = (voteTotals[id] ?? 0) + count;
          if (gameWinners.includes(id)) wins[id] = (wins[id] ?? 0) + 1;
        }
      }
      const contenders = Object.keys(wins);
      if (contenders.length > 0) {
        const maxWins = Math.max(...contenders.map((id) => wins[id]));
        let leaders = contenders.filter((id) => wins[id] === maxWins);
        if (leaders.length > 1) {
          const maxVotes = Math.max(...leaders.map((id) => voteTotals[id] ?? 0));
          leaders = leaders.filter((id) => (voteTotals[id] ?? 0) === maxVotes);
        }
        // Then goals that month, same as the app's Player of the Month card.
        if (leaders.length > 1) {
          const monthIds = new Set(monthGames.map((g) => g.id));
          const monthGoals = (id: string) => (allGoalRows ?? []).filter((r) => r.player_id === id && monthIds.has(r.game_id)).reduce((sum, r) => sum + r.goals, 0);
          const maxGoals = Math.max(...leaders.map(monthGoals));
          leaders = leaders.filter((id) => monthGoals(id) === maxGoals);
        }
        const { data: winners } = await admin.from("profiles").select("display_name").in("id", leaders);
        const names = (winners ?? []).map((w) => w.display_name).join(" & ");
        const monthLabel = new Date(monthKey + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });

        if (names) {
          await sendPushBroadcast({
            title: "Player of the Month 🏅",
            body: `${names} is Player of the Month for ${monthLabel}.`,
            url: "/",
          });
        }
      }
    }
    await markNotified(potmKey);
  }
}
