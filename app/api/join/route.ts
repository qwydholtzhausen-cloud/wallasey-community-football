import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../lib/push";

// A new sign-up waiting for approval sends their name, who they know at
// the club and (optionally) their mobile, and every admin gets a push.
// Only a 'pending' profile can use this; the status itself is changed only
// by an admin (app/api/admin/member-approval).
export async function POST(req: Request) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const asCaller = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
    if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const me = userData.user.id;
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const body = await req.json().catch(() => ({}));
    const displayName = String(body.displayName ?? "").trim().replace(/\s+/g, " ");
    const referral = String(body.referral ?? "").trim().slice(0, 200);
    const mobile = String(body.mobile ?? "").replace(/[^\d+]/g, "").slice(0, 16);
    if (displayName.length < 2 || displayName.length > 40) return NextResponse.json({ error: "Please enter your name" }, { status: 400 });

    const { data: profile } = await admin.from("profiles").select("*").eq("id", me).single();
    if (!profile || profile.status !== "pending") return NextResponse.json({ error: "Nothing to request" }, { status: 400 });
    const { data: existing } = await admin.from("join_requests").select("player_id").eq("player_id", me).maybeSingle();
    const firstRequest = !existing;

    const { error } = await admin.from("profiles").update({ display_name: displayName }).eq("id", me);
    if (error) throw error;
    const { error: reqErr } = await admin
      .from("join_requests")
      .upsert({ player_id: me, referral_note: referral || null, mobile: mobile || null }, { onConflict: "player_id" });
    if (reqErr) throw reqErr;

    if (firstRequest) {
      const { data: admins } = await admin.from("profiles").select("id").in("role", ["admin", "co-owner", "owner"]);
      await sendPushToUsers((admins ?? []).map((a) => a.id), {
        title: "New member request",
        body: `${displayName} wants to join.${referral ? ` Knows: "${referral.slice(0, 60)}".` : ""} Tap to let them in.`,
        url: "/",
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("join request failed", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
