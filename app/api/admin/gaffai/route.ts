import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { callClaude, type AnthropicMessage, type AnthropicContentBlock } from "../../../../lib/gaffai/anthropic";
import { GAFFAI_TOOLS } from "../../../../lib/gaffai/tools";
import { GAFFAI_SYSTEM_PROMPT } from "../../../../lib/gaffai/prompt";
import { TOOL_IMPL, executeMarkPaid, executeCreateFixture, type MarkPaidAction, type CreateFixtureAction } from "../../../../lib/gaffai/toolImpl";

// This app is on Vercel Hobby (see app/api/cron/frequent/route.ts's own
// comment on why the 15-min poller runs via GitHub Actions instead of
// native Vercel Cron) - Hobby allows up to 60s per function, and a
// multi-round tool-calling loop at Haiku speeds needs the headroom.
export const maxDuration = 60;

const MAX_TOOL_ROUNDS = 6;

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

export async function POST(req: Request) {
  try {
    const auth = await authenticate(req);
    if (!auth) return NextResponse.json({ type: "error", error: "Not authorized" }, { status: 403 });
    const { admin, callerId } = auth;

    const body = await req.json();

    // --- Executing a previously proposed action ---
    // This is the ONLY path that can mutate anything, and it's only
    // reachable when the request itself says so explicitly - there is no
    // tool schema the model can emit that reaches these functions, so no
    // model output alone can trigger a mutation. Every field is
    // re-validated fresh against the DB before anything happens.
    if (body.type === "confirm_action") {
      const action = body.action as MarkPaidAction | CreateFixtureAction;
      try {
        if (action.kind === "mark_paid") {
          await executeMarkPaid(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Done — ${action.playerName} is marked as paid for ${action.gameLabel}.` });
        }
        if (action.kind === "create_fixture") {
          await executeCreateFixture(admin, callerId, action);
          return NextResponse.json({ type: "action_result", ok: true, text: `Draft fixture created for ${action.date}. Review and publish it when you're ready.` });
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

      let response = await callClaude(messages, GAFFAI_TOOLS, GAFFAI_SYSTEM_PROMPT);
      let rounds = 0;
      // Reset every round - only reflects whichever tools were called in
      // the round immediately before the model's final answer, not
      // anything called earlier in the conversation.
      let proposalFromLastRound: MarkPaidAction | CreateFixtureAction | null = null;

      while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
        rounds++;
        proposalFromLastRound = null;
        const toolUseBlocks = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

        const toolResults = await Promise.all(
          toolUseBlocks.map(async (block) => {
            const impl = TOOL_IMPL[block.name];
            if (!impl) {
              return { type: "tool_result" as const, tool_use_id: block.id, content: `Unknown tool: ${block.name}`, is_error: true };
            }
            try {
              const result = await impl(admin, block.input ?? {});
              if (block.name === "propose_mark_paid" || block.name === "propose_create_fixture") {
                proposalFromLastRound = result as MarkPaidAction | CreateFixtureAction;
              }
              return { type: "tool_result" as const, tool_use_id: block.id, content: JSON.stringify(result) };
            } catch (err) {
              return { type: "tool_result" as const, tool_use_id: block.id, content: err instanceof Error ? err.message : "Tool failed", is_error: true };
            }
          })
        );

        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
        response = await callClaude(messages, GAFFAI_TOOLS, GAFFAI_SYSTEM_PROMPT);
      }

      if (response.stop_reason === "tool_use") {
        return NextResponse.json({ type: "answer", text: "Struggling to pin that one down, gaffer — try narrowing it down a bit." });
      }

      const finalText = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      if (proposalFromLastRound) {
        return NextResponse.json({ type: "action_proposal", text: finalText || "Here's what I'll do:", action: proposalFromLastRound });
      }
      return NextResponse.json({ type: "answer", text: finalText || "Not sure how to answer that one — try rephrasing?" });
    }

    return NextResponse.json({ type: "error", error: "Unknown request type" }, { status: 400 });
  } catch (err) {
    console.error("gaffai route error", err);
    return NextResponse.json({ type: "error", error: "Something went wrong" }, { status: 500 });
  }
}
