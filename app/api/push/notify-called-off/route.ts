import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

// One push to everyone who was booked on a game an admin has just called
// off (the credits and inbox messages are already done by the database).
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { gameId } = await req.json();
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const asCaller = createClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
  if (!callerProfile || !["admin", "co-owner", "owner"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const { data: game } = await admin.from("games").select("date, kickoff, called_off_at, called_off_reason, bookings(player_id, waiting)").eq("id", gameId).single();
  if (!game || !game.called_off_at) return NextResponse.json({ error: "Game isn't called off" }, { status: 400 });

  const when = new Date(game.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const why = game.called_off_reason ? ` ${game.called_off_reason}.` : "";
  const bookings = (game.bookings ?? []) as { player_id: string; waiting: boolean }[];
  const playing = bookings.filter((b) => !b.waiting).map((b) => b.player_id);
  const waiting = bookings.filter((b) => b.waiting).map((b) => b.player_id);
  if (playing.length)
    await sendPushToUsers(playing, { title: `${when}'s game is called off`, body: `Sorry, it's off.${why} If you'd paid, a game credit is in your account for your next game.`, url: "/" });
  if (waiting.length) await sendPushToUsers(waiting, { title: `${when}'s game is called off`, body: `Sorry, it's off.${why} You were on the waiting list, so there's nothing to do.`, url: "/" });
  return NextResponse.json({ ok: true, sent: playing.length + waiting.length });
}
