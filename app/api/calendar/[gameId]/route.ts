import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildIcs } from "../../../../lib/calendar";

// Serves one fixture as a calendar file. No sign-in: an iPhone opens this
// in its own calendar handler, which can't send the app's session, and a
// fixture's date, venue and price aren't private - they're on the Fixtures
// tab for every member. It only ever returns published games, looked up by
// their unguessable id, and never who's booked.
export async function GET(_req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return new NextResponse("Not found", { status: 404 });

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data: game } = await admin
    .from("games")
    .select("id, date, kickoff, venue, pitch, price, published")
    .eq("id", gameId)
    .maybeSingle();
  if (!game || !game.published) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(buildIcs(game), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // inline, so iOS shows its "Add to Calendar" sheet rather than
      // treating it as a download.
      "Content-Disposition": `inline; filename="football-${game.date}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
