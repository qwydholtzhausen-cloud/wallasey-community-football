import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { messageId } = await req.json();
  if (!messageId) return NextResponse.json({ error: "Missing messageId" }, { status: 400 });

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

  const { data: message } = await admin.from("admin_messages").select("recipient_id, message").eq("id", messageId).single();
  if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

  await sendPushToUsers([message.recipient_id], {
    title: "Message from an admin",
    body: message.message.length > 100 ? `${message.message.slice(0, 97)}...` : message.message,
    url: "/",
  });

  return NextResponse.json({ ok: true });
}
