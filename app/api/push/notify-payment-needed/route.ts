import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { bookingId } = await req.json();
  if (!bookingId) return NextResponse.json({ error: "Missing bookingId" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: booking } = await admin
    .from("bookings")
    .select("id, player_id, status, waiting, game:games(id, date, venue, price)")
    .eq("id", bookingId)
    .single();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
  const isAdmin = callerProfile && ["admin", "co-owner", "owner"].includes(callerProfile.role);
  if (booking.player_id !== userData.user.id && !isAdmin) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  if (booking.waiting || booking.status !== "unpaid") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const game = Array.isArray(booking.game) ? booking.game[0] : booking.game;
  if (!game) return NextResponse.json({ ok: true, skipped: true });

  const dateLabel = new Date(game.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  await sendPushToUsers([booking.player_id], {
    title: "Payment needed",
    body: `You're booked for ${game.venue} on ${dateLabel} — pay £${game.price} to keep your spot.`,
    url: "/",
  });

  return NextResponse.json({ ok: true });
}
