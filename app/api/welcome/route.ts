import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendWelcome } from "../../../lib/welcome";

// A new member has just told us their name (or skipped it): send their
// welcome message now rather than waiting for the cron. Only for an
// active member, and only once (sendWelcome claims the key first).
export async function POST(req: Request) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const asCaller = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
    if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { data: profile } = await admin.from("profiles").select("*").eq("id", userData.user.id).single();
    if (!profile || (profile.status ?? "active") !== "active") return NextResponse.json({ ok: true, sent: false });
    const sent = await sendWelcome(admin, profile.id);
    return NextResponse.json({ ok: true, sent });
  } catch (err) {
    console.error("welcome failed", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
