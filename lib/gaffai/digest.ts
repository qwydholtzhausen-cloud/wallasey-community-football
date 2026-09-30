import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude, type AnthropicTextBlock } from "./anthropic";
import { TOOL_IMPL, computeNudges } from "./toolImpl";
import { checkWrapped, WRAPPED_REVIEW_PROMPT } from "./health";

const DIGEST_SYSTEM_PROMPT = `You are GaffAI, writing a short weekly digest for the club's admins - not answering a question, just summarizing what's noteworthy from the past week in 3-5 sentences. Same voice as always: direct, a little dry, light football-manager-slang is fine ("gaffer," "the lads," "clean sheet"), don't overdo it. No headers, no bullet points, no markdown - just flowing sentences, like you're saying it out loud. Skip anything unremarkable - if nothing much happened, say so briefly rather than padding it out. Prioritize anything in "active_nudges" - those are the genuinely time-sensitive things, everything else (fixture counts, pot balance) is just background color unless it's actually notable. Never invent a fact that isn't in the data given to you.`;

// One-shot, no tools, no multi-turn loop - unlike the main chat route,
// this isn't a conversation, it's a single summarization pass over facts
// already computed deterministically (the exact same ones nudges use,
// via TOOL_IMPL/computeNudges directly rather than duplicating any of
// that logic). Called once a week by the daily cron (app/api/cron/daily/
// route.ts) on Mondays, and delivered by inserting straight into
// gaffai_conversations for every admin - see that route for the
// idempotency/delivery side of this.
export async function generateWeeklyDigest(admin: SupabaseClient): Promise<string> {
  const [fixtureCounts, potSummary, nudges] = await Promise.all([
    TOOL_IMPL.get_fixture_counts(admin, {}),
    TOOL_IMPL.get_pot_summary(admin, {}),
    computeNudges(admin),
  ]);

  const facts = {
    fixture_counts: fixtureCounts,
    pot_summary: potSummary,
    active_nudges: nudges.map((n) => n.text),
  };

  const response = await callClaude([{ role: "user", content: JSON.stringify(facts) }], [], DIGEST_SYSTEM_PROMPT);

  const text = response.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text || "Quiet week - nothing major to flag.";
}

// Same one-shot pattern for the Wrapped check (lib/gaffai/health.ts): the
// facts every player's story is built from, read over once. Null when
// nobody has enough games for a Wrapped yet.
export async function generateWrappedReview(admin: SupabaseClient, monthKey: string): Promise<string | null> {
  const report = await checkWrapped(admin, monthKey);
  if (report.players_getting_it === 0) return null;
  // One line per player keeps this well inside the request timeout (the
  // full JSON of 30 players ran past it).
  const facts = [
    `Period ${report.period}${report.theme ? ` (${report.theme})` : ""}. Release: ${report.release ?? "unknown"}. Games played ${report.games_played}; still to play: ${report.games_still_to_play.join("; ") || "none"}. ${report.players_getting_it} players get a Wrapped.`,
    `Data gaps: ${report.data_gaps.join(" ") || "none"}`,
    "Players:",
    ...report.players.map((p) =>
      [
        p.name,
        p.intro_line && `intro "${p.intro_line}"`,
        `apps ${p.apps}`,
        p.record,
        `win ${p.win_rate}%`,
        `goals ${p.goals}${p.goals_rank ? ` (#${p.goals_rank})` : ""}`,
        `MOTM ${p.motm_wins} wins/${p.motm_votes} votes`,
        Object.keys(p.why_tags).length ? `tags ${Object.entries(p.why_tags).map(([t, n]) => `${t}x${n}`).join(" ")}` : null,
        p.partner && `partner ${p.partner}`,
        p.nemesis && `nemesis ${p.nemesis}`,
        p.best_win && `best ${p.best_win}`,
        p.heaviest_defeat && `worst ${p.heaviest_defeat}`,
        `win streak ${p.win_streak}`,
        p.predictions && `predictions ${p.predictions}`,
      ]
        .filter(Boolean)
        .join(" | ")
    ),
  ].join("\n");
  const response = await callClaude([{ role: "user", content: facts }], [], WRAPPED_REVIEW_PROMPT);
  const text = response.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text ? `Wrapped check for ${monthKey}: ${text}` : null;
}
