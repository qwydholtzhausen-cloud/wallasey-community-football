import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToUsers } from "../../../../lib/push";
import { ensureFreshMonzoToken } from "../../../../lib/monzo";

// Monzo's payment-reference codes: 5 chars from generate_payment_code()'s
// charset (no 0/O/1/I/L), case-insensitive, picked out of whatever else is
// in the transfer reference (people often add their own text around it).
const CODE_PATTERN = /\b[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}\b/i;

interface OutstandingBooking {
  id: string;
  game_id: string;
  price_pence: number;
}

// Every non-empty combination of outstanding bookings whose prices sum to
// the paid amount. Outstanding lists here are small (a handful of games at
// most), so a plain 2^n scan is fine - this exists to tell a single exact
// game match apart from a genuinely ambiguous one (e.g. two different games
// that happen to both cost the amount paid, or a subset that could be
// explained two different ways).
function findMatchingCombinations(bookings: OutstandingBooking[], amountPence: number): OutstandingBooking[][] {
  const matches: OutstandingBooking[][] = [];
  const n = bookings.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    const combo: OutstandingBooking[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        sum += bookings[i].price_pence;
        combo.push(bookings[i]);
      }
    }
    if (sum === amountPence) matches.push(combo);
  }
  return matches;
}

export async function POST(req: NextRequest) {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  let body: { type?: string; data?: { id?: string } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (body.type !== "transaction.created" || !body.data?.id) return NextResponse.json({ ok: true });
  const txnId = body.data.id;

  // Never trust the webhook payload for the amount/reference - anyone who
  // guesses this URL can POST arbitrary JSON at it. Re-fetch the
  // transaction from Monzo directly using our own stored access token,
  // which only succeeds for transactions on the connected account.
  const token = await ensureFreshMonzoToken(admin);
  if (!token) return NextResponse.json({ ok: true });

  const { data: already } = await admin.from("monzo_transactions").select("id").eq("id", txnId).maybeSingle();
  if (already) return NextResponse.json({ ok: true });

  const txnRes = await fetch(`https://api.monzo.com/transactions/${txnId}`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!txnRes.ok) return new NextResponse("Could not verify transaction", { status: 502 });
  const { transaction } = (await txnRes.json()) as {
    transaction: { amount: number; currency: string; notes: string; decline_reason?: string };
  };

  // Negative amount = money leaving the account (this account may well be
  // used for the holder's everyday spending, not just match fees) -
  // nothing to record or flag, just not a payment to match. Declined
  // transactions still fire this event and get skipped the same way.
  if (transaction.amount <= 0 || transaction.currency !== "GBP" || transaction.decline_reason) {
    return NextResponse.json({ ok: true });
  }

  const amountPence = transaction.amount;
  const codeMatch = transaction.notes?.match(CODE_PATTERN);
  const code = codeMatch ? codeMatch[0].toUpperCase() : null;

  // Only pushes admins when a player was actually identified - there's
  // something concrete to check. A payment with no recognisable reference
  // at all is more likely a stray personal transaction on this account
  // than a match fee, so it's logged for the record but doesn't interrupt
  // anyone; it's still visible in the unmatched list if needed.
  async function recordUnmatched(reason: string, playerId?: string) {
    await admin.from("monzo_transactions").insert({ id: txnId, amount_pence: amountPence, code, player_id: playerId ?? null, outcome: "unmatched", reason });
    if (!playerId) return;
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin");
    const adminIds = (admins ?? []).map((p) => p.id as string);
    if (adminIds.length > 0) {
      await sendPushToUsers(adminIds, {
        title: "Payment needs a manual check 👀",
        body: `£${(amountPence / 100).toFixed(2)} came in but couldn't be auto-matched (${reason}).`,
        url: "/",
      });
    }
  }

  if (!code) {
    await recordUnmatched("no reference found on the payment");
    return NextResponse.json({ ok: true });
  }

  const { data: player } = await admin.from("profiles").select("id, display_name").eq("payment_code", code).maybeSingle();
  if (!player) {
    await recordUnmatched("reference didn't match a player");
    return NextResponse.json({ ok: true });
  }

  const { data: bookingRows } = await admin
    .from("bookings")
    .select("id, game_id, status, waiting, games(price)")
    .eq("player_id", player.id)
    .eq("waiting", false)
    .in("status", ["unpaid", "pending"]);

  const outstanding: OutstandingBooking[] = ((bookingRows ?? []) as unknown as { id: string; game_id: string; games: { price: number } | null }[])
    .filter((b) => b.games)
    .map((b) => ({ id: b.id, game_id: b.game_id, price_pence: Math.round((b.games!.price ?? 0) * 100) }));

  if (outstanding.length === 0) {
    await recordUnmatched("no outstanding bookings for this player", player.id);
    return NextResponse.json({ ok: true });
  }

  const combos = findMatchingCombinations(outstanding, amountPence);
  if (combos.length !== 1) {
    await recordUnmatched(combos.length === 0 ? "amount didn't match any combination of their bookings" : "amount matches more than one possible combination", player.id);
    return NextResponse.json({ ok: true });
  }

  const matched = combos[0];
  const matchedIds = matched.map((b) => b.id);
  await admin
    .from("bookings")
    .update({ status: "confirmed", auto_confirmed: true, confirmed_at: new Date().toISOString() })
    .in("id", matchedIds);

  await admin.from("monzo_transactions").insert({
    id: txnId,
    amount_pence: amountPence,
    code,
    player_id: player.id,
    outcome: "confirmed",
    matched_booking_ids: matchedIds,
  });

  await sendPushToUsers([player.id], {
    title: "Payment received ✅",
    body: matchedIds.length === 1 ? "Your match fee is confirmed - no need to do anything else." : `${matchedIds.length} match fees confirmed - no need to do anything else.`,
    url: "/",
  });

  return NextResponse.json({ ok: true });
}
