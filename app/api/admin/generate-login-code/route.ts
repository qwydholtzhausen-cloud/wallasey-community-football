import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Emergency bypass for "the OTP email never arrived" - generates a real,
// valid sign-in code via Supabase's Admin API without ever sending an
// email. Admin reads the code out to the player through some other
// channel (WhatsApp, phone), they type it into the normal sign-in
// screen exactly as if it had emailed them - same verifyOtp flow, no
// new client-side code path.
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { email } = await req.json();
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const callerId = userData.user.id;

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", callerId).single();
  if (!callerProfile || !["admin", "co-owner", "owner"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: email.trim() });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const code = data.properties?.email_otp;
  if (!code) return NextResponse.json({ error: "Supabase didn't return a code - the account may not exist yet" }, { status: 400 });

  return NextResponse.json({ ok: true, code });
}
