import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { targetId } = await req.json();
  if (!targetId) return NextResponse.json({ error: "Missing targetId" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const callerId = userData.user.id;

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", callerId).single();
  if (!callerProfile || !["admin", "owner"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (callerId === targetId) {
    return NextResponse.json({ error: "You can't delete your own account this way" }, { status: 400 });
  }

  const { data: targetProfile } = await admin.from("profiles").select("role").eq("id", targetId).single();
  if (!targetProfile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  if (targetProfile.role === "owner") {
    return NextResponse.json({ error: "Can't delete the owner account" }, { status: 403 });
  }
  if (targetProfile.role === "admin" && callerProfile.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can delete an admin's account" }, { status: 403 });
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
