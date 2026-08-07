import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Aggregate count only, never per-player detail - admins can see "how many
// people will actually get pushed," not who specifically has it off. That's
// a personal preference, not something worth exposing name-by-name.
export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
  if (!callerProfile || !["admin", "co-owner", "owner"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { count: total } = await admin.from("profiles").select("id", { count: "exact", head: true });
  // Counting distinct users with a real subscription row, not the push_opt_in
  // flag - that flag can be true with no working subscription behind it (see
  // the toggle-state fix), so this is the number that actually matches
  // "will receive a push," not just "said yes at some point."
  const { data: subs } = await admin.from("push_subscriptions").select("user_id");
  const subscribed = new Set((subs ?? []).map((s) => s.user_id)).size;

  return NextResponse.json({ total: total ?? 0, subscribed });
}
