import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { callClaude, type AnthropicMessage, type AnthropicContentBlock } from "../../../../lib/gaffai/anthropic";
import { GAFFAI_TOOLS } from "../../../../lib/gaffai/tools";
import { GAFFAI_SYSTEM_PROMPT } from "../../../../lib/gaffai/prompt";
import {
  TOOL_IMPL,
  executeMarkPaid,
  executeCreateFixture,
  executeSendReminder,
  executePublishFixture,
  executeMatchdayPush,
  executeSetPotExempt,
  executeRemoveDuplicate,
  executeBookingInvite,
  computeNudges,
  type BookingInviteAction,
  type MarkPaidAction,
  type CreateFixtureAction,
  type SendReminderAction,
  type PublishFixtureAction,
  type MatchdayPushAction,
  type SetPotExemptAction,
  type RemoveDuplicateAction,
} from "../../../../lib/gaffai/toolImpl";
import { nowInLondon } from "../../../../lib/time";

// This app is on Vercel Hobby (see app/api/cron/frequent/route.ts's own
// comment on why the 15-min poller runs via GitHub Actions instead of
// native Vercel Cron) - Hobby allows up to 60s per function, and a
// multi-round tool-calling loop at Haiku speeds needs the headroom.
export const maxDuration = 300;

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_RESULT_CHARS = 40000;

async function authenticate(req: Request): Promise<{ admin: SupabaseClient; callerId: string } | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return null;

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
  if (!callerProfile || !["admin", "co-owner", "owner"].includes(callerProfile.role)) return null;

  return { admin, callerId: userData.user.id };
}

type ToolUseBlock = Extract<AnthropicContentBlock, { type: "tool_use" }>;
type TextBlock = Extract<AnthropicContentBlock, { type: "text" }>;

// Best-effort - a persistence hiccup should never turn an otherwise-
// successful answer into a 500. Only real message/answer exchanges get
// saved here; nudges and confirm_action requests aren't conversation
// turns. Deliberately just role+text, nothing about any action that was
// proposed - see the client's GaffAIAction handling for why a reloaded
// history row never resurrects a stale, possibly-now-invalid proposal.
function describeAction(a: MarkPaidAction | CreateFixtureAction | SendReminderAction | PublishFixtureAction | MatchdayPushAction | SetPotExemptAction | RemoveDuplicateAction | BookingInviteAction): string {
  switch (a.kind) {
    case "booking_invite":
      return `**Ready to send to ${a.players.length} player${a.players.length === 1 ? "" : "s"}** (inbox + push) about ${a.gameLabel}, ${a.spacesLeft} space${a.spacesLeft === 1 ? "" : "s"} left:\n${a.players.map((p) => p.name).join(", ")}\n\n> ${a.message}`;
    case "send_reminder":
      return `**Ready to send to ${a.playerName}** (inbox + push):\n\n> ${a.message}`;
    case "mark_paid":
      return `**Ready to mark paid:** ${a.playerName}, ${a.gameLabel} (£${a.amount}).`;
    case "create_fixture":
      return `**Ready to create a draft fixture:** ${a.venue}, ${a.date} ${a.kickoff}, ${a.pitch}, £${a.price}, ${a.maxPlayers} places.`;
    case "publish_fixture":
      return `**Ready to publish:** ${a.venue}, ${a.date}.`;
    case "matchday_push":
      return `**Ready to push** ${a.targetCount} players about ${a.venue} today (${a.spotsLeft} spots left).`;
    case "set_pot_exempt":
      return `**Ready to make free:** ${a.playerName}, ${a.gameLabel} (${a.reason}).`;
    case "remove_duplicate":
      return `**Ready to remove** the unused ${a.removeName} account (keeping ${a.keepName}).`;
  }
}

async function persistTurn(admin: SupabaseClient, callerId: string, userText: string, replyText: string) {
  try {
    await admin.from("gaffai_conversations").insert([
      { admin_id: callerId, role: "user", text: userText },
      { admin_id: callerId, role: "assistant", text: replyText },
    ]);
  } catch (err) {
    console.error("gaffai conversation persist failed", err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await authenticate(req);
    if (!auth) return NextResponse.json({ type: "error", error: "Not authorized" }, { status: 403 });
    const { admin, callerId } = auth;

    const body = await req.json();

    // --- Proactive nudges, computed fresh every call ---
    // Deliberately NOT a "has this changed since you last looked" check -
    // this app already tried that shape once (a nav-tab "something's new"
    // dot, removed 2026-08-12 after a time-axis bug, but then still kept
    // removed because an ambient signal with no content and no per-item
    // dismissal was judged "more likely to confuse than help"). These are
    // live, content-ful facts recomputed every time, filtered against
    // this admin's own gaffai_dismissed_nudges by content-addressed key
    // (dismissing is per admin, not club-wide) - a nudge only
    // reappears because the underlying facts genuinely changed, never
    // because of clock drift.
    if (body.type === "nudges") {
      const nudges = await computeNudges(admin, callerId);
      return NextResponse.json({ type: "nudges", nudges });
    }

    // --- Executing a previously proposed action ---
    // This is the ONLY path that can mutate anything, and it's only
    // reachable when the request itself says so explicitly - there is no
    // tool schema the model can emit that reaches these functions, so no
    // model output alone can trigger a mutation. Every field is
    // re-validated fresh against the DB before anything happens.
    if (body.type === "confirm_action") {
      const action = body.action as MarkPaidAction | CreateFixtureAction | SendReminderAction | PublishFixtureAction | MatchdayPushAction | SetPotExemptAction | RemoveDuplicateAction | BookingInviteAction;
      try {
        if (action.kind === "mark_paid") {
          await executeMarkPaid(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Done — ${action.playerName} is marked as paid for ${action.gameLabel}.` });
        }
        if (action.kind === "create_fixture") {
          await executeCreateFixture(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Draft fixture created for ${action.date}. Review and publish it when you're ready.` });
        }
        if (action.kind === "send_reminder") {
          await executeSendReminder(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Done — sent to ${action.playerName}.` });
        }
        if (action.kind === "publish_fixture") {
          await executePublishFixture(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Published — ${action.venue} on ${action.date} is now visible to players.` });
        }
        if (action.kind === "matchday_push") {
          await executeMatchdayPush(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Sent — pushed to players not yet booked on ${action.venue} today.` });
        }
        if (action.kind === "set_pot_exempt") {
          await executeSetPotExempt(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Done — ${action.playerName}'s booking for ${action.gameLabel} is now free (${action.reason}).` });
        }
        if (action.kind === "booking_invite") {
          const r = await executeBookingInvite(admin, callerId, action);
          return NextResponse.json({
            type: "action_result",
            ok: true,
            text: `Sent to ${r.sent} player${r.sent === 1 ? "" : "s"} (inbox + push)${r.skipped ? `; ${r.skipped} skipped as they've booked since` : ""}.`,
          });
        }
        if (action.kind === "remove_duplicate") {
          await executeRemoveDuplicate(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Done — removed the unused ${action.removeName} account. ${action.keepName} is untouched.` });
        }
        return NextResponse.json({ type: "error", error: "Unknown action" }, { status: 400 });
      } catch (err) {
        return NextResponse.json({ type: "action_result", ok: false, text: err instanceof Error ? err.message : "Couldn't complete that." });
      }
    }

    // --- A question or instruction ---
    if (body.type === "message") {
      const text = String(body.text ?? "").slice(0, 2000);
      const historyIn = Array.isArray(body.history) ? body.history.slice(-20) : [];
      const messages: AnthropicMessage[] = [
        ...historyIn.map((h: { role: "user" | "assistant"; text: string }) => ({ role: h.role, content: h.text })),
        { role: "user", content: text },
      ];

      // The model has no inherent sense of "now" - without this, "last
      // month," "the most recent game," "this week" are all guesses.
      // Computed fresh per request rather than baked into the static
      // prompt, since it has to stay current.
      const nowUk = nowInLondon();
      const weekday = new Date(nowUk + ":00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

      // Lets it personalize, and lets find_admin_messages answer "have I
      // sent..." questions by passing this id as sender_id - without this
      // it has no way to distinguish "sent by this admin" from "sent by
      // any admin."
      const { data: callerProfile } = await admin.from("profiles").select("display_name").eq("id", callerId).single();
      const callerName = callerProfile?.display_name ?? "an admin";

      // Standing facts are club-wide (any admin's save_standing_fact
      // applies to every future conversation, not just theirs) - fetched
      // fresh and injected directly rather than left for the model to
      // fetch via a tool, so recall never depends on it remembering to
      // check. The [id:...] tag is only so forget_standing_fact has
      // something real to target - the prompt tells the model never to
      // read one aloud.
      const { data: facts } = await admin.from("gaffai_facts").select("id, fact").order("created_at", { ascending: true }).limit(50);
      const factsSection =
        facts && facts.length > 0
          ? `\n\nStanding facts admins have told you to remember - apply these unless this conversation directly contradicts one. The [id:...] tag is for forget_standing_fact only, never read it aloud:\n${facts.map((f) => `- [id:${f.id}] ${f.fact}`).join("\n")}`
          : "";

      const systemPrompt = `${GAFFAI_SYSTEM_PROMPT}\n\nCurrent date/time: ${weekday} ${nowUk.slice(0, 10)}, ${nowUk.slice(11)} (Europe/London). Use this as "now" for anything relative - "last month," "this week," "the most recent game," etc.\n\nYou're talking to ${callerName}. Their id, for tool params that need it (like find_admin_messages' sender_id), is ${callerId}.${factsSection}`;

      const startedAt = Date.now();
      const used = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const tally = (r: typeof response) => {
        used.input += r.usage?.input_tokens ?? 0;
        used.output += r.usage?.output_tokens ?? 0;
        used.cacheRead += r.usage?.cache_read_input_tokens ?? 0;
        used.cacheWrite += r.usage?.cache_creation_input_tokens ?? 0;
      };
      let response = await callClaude(messages, GAFFAI_TOOLS, systemPrompt);
      tally(response);
      let rounds = 0;
      // Reset every round - only reflects whichever tools were called in
      // the round immediately before the model's final answer, not
      // anything called earlier in the conversation.
      let proposalFromLastRound: MarkPaidAction | CreateFixtureAction | SendReminderAction | PublishFixtureAction | MatchdayPushAction | SetPotExemptAction | RemoveDuplicateAction | BookingInviteAction | null = null;

      while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
        rounds++;
        const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const impl = TOOL_IMPL[block.name];
            if (!impl) {
              return { type: "tool_result" as const, tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
            }
            try {
              const result = await impl(admin, block.input ?? {}, callerId);
              if (
                block.name === "propose_mark_paid" ||
                block.name === "propose_create_fixture" ||
                block.name === "propose_send_reminder" ||
                block.name === "propose_publish_fixture" ||
                block.name === "propose_matchday_push" ||
                block.name === "propose_set_pot_exempt" ||
                block.name === "propose_remove_duplicate_account" ||
                block.name === "propose_booking_invite"
              ) {
                proposalFromLastRound = result as MarkPaidAction | CreateFixtureAction | SendReminderAction | PublishFixtureAction | MatchdayPushAction | SetPotExemptAction | RemoveDuplicateAction | BookingInviteAction;
              }
              // A broad query can return thousands of rows; past this size
              // it costs more than it helps, so cut it and say so.
              const json = JSON.stringify(result);
              const content =
                json.length > MAX_TOOL_RESULT_CHARS
                  ? `${json.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[cut: result was ${json.length} characters. Narrow it with filters, a smaller select, count_only, or a lower limit.]`
                  : json;
              return { type: "tool_result" as const, tool_use_id: block.id, content };
            } catch (err) {
              return { type: "tool_result" as const, tool_use_id: block.id, content: err instanceof Error ? err.message : "Tool failed", is_error: true };
            }
          })
        );

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        response = await callClaude(messages, GAFFAI_TOOLS, systemPrompt);
        tally(response);
      }
      // One line per question in the Vercel logs: rounds, time, tokens and
      // an approximate cost (Opus 5.5: $4/M input, $20/M output, cache
      // reads $0.20/M, cache writes ~$5/M).
      const cost = (used.input * 4 + used.output * 20 + used.cacheRead * 0.2 + used.cacheWrite * 5) / 1e6;
      console.log(
        `gaffai usage rounds=${rounds + 1} secs=${((Date.now() - startedAt) / 1000).toFixed(1)} in=${used.input} out=${used.output} cache_read=${used.cacheRead} cache_write=${used.cacheWrite} approx_usd=${cost.toFixed(3)}`
      );

      if (response.stop_reason === "refusal") {
        const refused = "That one's outside what I can help with, gaffer - try asking it a different way.";
        await persistTurn(admin, callerId, text, refused);
        return NextResponse.json({ type: "answer", text: refused });
      }

      if (response.stop_reason === "tool_use") {
        const fallback = "Struggling to pin that one down, gaffer — try narrowing it down a bit.";
        await persistTurn(admin, callerId, text, fallback);
        return NextResponse.json({ type: "answer", text: fallback });
      }

      const finalText = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      if (proposalFromLastRound) {
        // Always spell out exactly what Confirm will do, whatever the model
        // wrote, so the admin never has to ask "what am I confirming?".
        const replyText = `${finalText ? finalText + "\n\n" : ""}${describeAction(proposalFromLastRound)}`;
        await persistTurn(admin, callerId, text, replyText);
        return NextResponse.json({ type: "action_proposal", text: replyText, action: proposalFromLastRound });
      }
      const replyText = finalText || "Not sure how to answer that one — try rephrasing?";
      await persistTurn(admin, callerId, text, replyText);
      return NextResponse.json({ type: "answer", text: replyText });
    }

    return NextResponse.json({ type: "error", error: "Unknown request type" }, { status: 400 });
  } catch (err) {
    console.error("gaffai route error", err);
    const msg = err instanceof Error ? err.message : "";
    // Say plainly when it's the AI account, not the question - otherwise
    // an empty credit balance just looks like GaffAI being broken.
    if (/credit balance is too low/i.test(msg)) {
      return NextResponse.json({ type: "answer", text: "I'm out of AI credit, gaffer - the club's Anthropic account needs topping up (console.anthropic.com → Plans & Billing) before I can answer anything." });
    }
    const limitReset = msg.match(/reached your specified API usage limits.*?regain access on (\S+) at (\d\d:\d\d) UTC/i);
    if (limitReset) {
      return NextResponse.json({
        type: "answer",
        text: `I've hit the club's monthly AI spend limit, gaffer - I'm back on ${limitReset[1]} at ${limitReset[2]} UTC, or sooner if an admin raises the limit (console.anthropic.com → Settings → Limits).`,
      });
    }
    if (/Anthropic API error (429|529)|overloaded/i.test(msg)) {
      return NextResponse.json({ type: "answer", text: "The AI service is busy right now - give it a minute and ask again." });
    }
    if (/abort/i.test(msg)) {
      return NextResponse.json({ type: "answer", text: "That one took too long to work out - try asking something a bit narrower." });
    }
    return NextResponse.json({ type: "error", error: "Something went wrong" }, { status: 500 });
  }
}
