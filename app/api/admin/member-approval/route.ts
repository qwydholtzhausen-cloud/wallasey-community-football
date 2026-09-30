import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

// An admin lets a waiting member in, or declines them. Logged in the audit
// log with who did it. Letting in sends a "You're in" push; the usual
// welcome message follows from the frequent cron once they're active.
export async function POST(req: Request) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const asCaller = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
    if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const callerId = userData.user.id;
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const { data: caller } = await admin.from("profiles").select("role").eq("id", callerId).single();
    if (!caller || !["admin", "co-owner", "owner"].includes(caller.role)) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

    const { playerId, action } = await req.json().catch(() => ({}));
    if (typeof playerId !== "string" || (action !== "approve" && action !== "decline")) return NextResponse.json({ error: "Bad request" }, { status: 400 });

    const { data: target } = await admin.from("profiles").select("*").eq("id", playerId).single();
    if (!target) return NextResponse.json({ error: "Player not found" }, { status: 404 });
    if (target.status === "active") return NextResponse.json({ error: `${target.display_name} is already in` }, { status: 400 });
    const { data: request } = await admin.from("join_requests").select("*").eq("player_id", playerId).maybeSingle();

    const status = action === "approve" ? "active" : "declined";
    const { error } = await admin.from("profiles").update({ status, approved_by: callerId, approved_at: new Date().toISOString() }).eq("id", playerId);
    if (error) throw error;
    await admin.from("audit_log").insert({
      actor_id: callerId,
      action: action === "approve" ? "Let in new member" : "Declined new member",
      details: target.display_name + (request?.referral_note ? ` (knows: ${request.referral_note})` : ""),
    });
    if (action === "approve") {
      await sendPushToUsers([playerId], {
        title: `You're in, ${String(target.display_name).split(" ")[0]}!`,
        body: "Welcome to Wirral Community Football. Your first game is a tap away.",
        url: "/",
      });
    }
    return NextResponse.json({ ok: true, name: target.display_name, mobile: request?.mobile ?? null });
  } catch (err) {
    console.error("member approval failed", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
