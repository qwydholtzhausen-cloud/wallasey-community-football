import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const result = await sendPushToUsers([userData.user.id], {
    title: "Test push 🔔",
    body: "If you can see this, notifications are working on this device.",
  });

  if (result.sent === 0) {
    return NextResponse.json(
      { error: "No active subscription found for this device - try toggling notifications off and back on" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true, ...result });
}
