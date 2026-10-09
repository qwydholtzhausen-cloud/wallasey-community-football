// Game credits: what a credit is worth and what a booking still owes once
// one's been put towards it. Shared by the app and GaffAI so both do the
// same sums.

export type CreditStatus = "awaiting_check" | "available" | "used" | "cancelled" | "declined";

export interface CreditRow {
  id: string;
  player_id: string;
  status: CreditStatus;
  // Pounds this credit covers (one ordinary game).
  value: number;
  source: "dropout" | "admin";
  source_game_id: string | null;
  note: string | null;
  created_at: string;
  used_on_booking_id: string | null;
  used_at: string | null;
  player?: { display_name: string } | null;
  source_game?: { date: string; price: number } | null;
}

export const CREDIT_VALUE = 5;

export const CREDIT_SELECT =
  "id, player_id, status, value, source, source_game_id, note, created_at, used_on_booking_id, used_at, player:profiles!player_credits_player_id_fkey(display_name), source_game:games!player_credits_source_game_id_fkey(date, price)";

// The credit spent on each booking, by booking id.
export function creditsByBooking(credits: CreditRow[]): Map<string, CreditRow> {
  const m = new Map<string, CreditRow>();
  for (const c of credits) if (c.status === "used" && c.used_on_booking_id) m.set(c.used_on_booking_id, c);
  return m;
}

// What's still to pay on a booking: the game's price less any credit put
// towards it (never below zero).
export function amountDue(price: number, credit: CreditRow | undefined | null): number {
  return Math.max(0, price - (credit?.value ?? 0));
}

export const creditLabel = (n: number) => `${n} game credit${n === 1 ? "" : "s"}`;
