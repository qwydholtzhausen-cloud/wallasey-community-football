import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Emergency bypass for "the OTP email never arrived" - generates a real,
// valid sign-in code via Supabase's Admin API without ever sending an
// email. Admin reads the code out to the player through some other
// channel (WhatsApp, phone), they type it into the normal sign-in
// screen exactly as if it had emailed them - same verifyOtp flow, no
// new client-side code path.
export async function POST(req: Request) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "No session token was sent with the request" }, { status: 401 });

    const { email } = await req.json();
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const asCaller = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
    if (userErr || !userData.user) {
      console.error("generate-login-code: caller token rejected", userErr?.message);
      return NextResponse.json({ error: `Session check failed: ${userErr?.message ?? "no user returned"}` }, { status: 401 });
    }
    const callerId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerProfile, error: profileErr } = await admin.from("profiles").select("role").eq("id", callerId).single();
    if (profileErr || !callerProfile) {
      console.error("generate-login-code: caller profile lookup failed", profileErr?.message);
      return NextResponse.json({ error: `Couldn't look up your profile: ${profileErr?.message ?? "not found"}` }, { status: 403 });
    }
    if (!["admin", "co-owner", "owner"].includes(callerProfile.role)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }

    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: email.trim() });
    if (error) {
      console.error("generate-login-code: generateLink failed", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const code = data.properties?.email_otp;
    if (!code) return NextResponse.json({ error: "Supabase didn't return a code - the account may not exist yet" }, { status: 400 });

    return NextResponse.json({ ok: true, code });
  } catch (err) {
    console.error("generate-login-code: unhandled error", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
