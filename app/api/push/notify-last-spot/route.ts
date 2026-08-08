import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { gameId } = await req.json();
  if (!gameId) return NextResponse.json({ error: "Missing gameId" }, { status: 400 });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const asCaller = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userErr } = await asCaller.auth.getUser(token);
  if (userErr || !userData.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: game } = await admin
    .from("games")
    .select("id, date, venue, max_players, bookings(player_id, waiting)")
    .eq("id", gameId)
    .single();
  if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  // "Filled" means a physical spot taken, same definition used everywhere
  // else in the app (the roster grid, the waiting-list trigger) - not
  // gated on payment status, since most bookings sit unpaid/pending for a
  // while and the game fills up on booking count long before that.
  const takenSpots = game.bookings.filter((b) => !b.waiting);
  // Re-check server-side rather than trusting the caller's claim - only
  // fire on the exact moment a game hits one spot left, not every request.
  if (takenSpots.length !== game.max_players - 1) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const alreadyOnGame = new Set(game.bookings.map((b) => b.player_id));
  const { data: everyone } = await admin.from("profiles").select("id").eq("push_opt_in", true);
  const targetIds = (everyone ?? []).map((p) => p.id).filter((id) => !alreadyOnGame.has(id));

  const dateLabel = new Date(game.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  await sendPushToUsers(targetIds, {
    title: "Last spot going",
    body: `${game.venue} on ${dateLabel} has 1 spot left. Book now before it's gone.`,
    url: "/",
  });

  return NextResponse.json({ ok: true });
}
