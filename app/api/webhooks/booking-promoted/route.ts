import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";

// Target of a Supabase Database Webhook (configured in the Supabase
// dashboard, not SQL) watching public.bookings for UPDATE. Waiting-list
// promotion happens inside a Postgres trigger, which has no way to make an
// outbound push call itself - this is the bridge for that one event.
export async function POST(req: Request) {
  const secret = req.headers.get("x-webhook-secret");
  if (!secret || secret !== process.env.SUPABASE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  }

  const payload = await req.json();
  if (payload.table !== "bookings" || payload.type !== "UPDATE") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const wasWaiting = payload.old_record?.waiting;
  const isWaiting = payload.record?.waiting;
  if (!wasWaiting || isWaiting) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const playerId = payload.record?.player_id;
  const gameId = payload.record?.game_id;
  if (!playerId || !gameId) return NextResponse.json({ ok: true, skipped: true });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: game } = await admin.from("games").select("venue, date").eq("id", gameId).single();
  const dateLabel = game ? new Date(game.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";

  await sendPushToUsers([playerId], {
    title: "You're in ⚽",
    body: game ? `A spot opened up for ${game.venue} on ${dateLabel} — you're confirmed.` : "A spot opened up — you're confirmed.",
    url: "/",
  });

  return NextResponse.json({ ok: true });
}
