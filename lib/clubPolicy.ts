// Small, deliberately manual policy toggles for rules the club wants to
// pause without ripping out the code - flipping back later is a
// one-line change instead of reconstructing deleted logic. Read by both
// the actual enforcement (app/api/cron/frequent/route.ts) and GaffAI's
// own understanding of the rule (lib/gaffai/prompt.ts), so the real
// behavior and what GaffAI tells admins about it can never silently
// drift apart - the exact class of bug the earlier duplicated
// defaultPitchCost function risked before it was made shared.

// Requested 2026-09-14 - the 48h-before-kickoff auto-removal for unpaid
// bookings was too much hassle to manage day to day. While false: an
// unpaid booking is simply left in place past kickoff; once the game
// finishes, the existing overdue-reminder (frequent cron) and
// has_overdue_payment() (supabase/schema.sql) take over and block the
// player from booking anything new until it's resolved (marked paid, or
// otherwise cleared) - that flow already existed for the "day after"
// case, it just rarely engaged before now because removal deleted the
// booking first.
export const AUTO_REMOVE_UNPAID_BOOKINGS = false;

// The Boot Room soft launch (2026-09-26): while false, only admins saw the
// Boot Room pill in the Feed tab, so they could seed it first. Opened to
// every member 2026-09-27. Setting it back to false hides it from players
// again without touching anyone's listings.
export const BOOT_ROOM_OPEN_TO_ALL = true;

// "Add to calendar" on booked fixtures (2026-09-27): admins-only first, as
// the iPhone Home Screen app's hand-off to Calendar could only be checked
// on a real device. Confirmed working on the owner's iPhone and opened to
// everyone the same day.
export const CALENDAR_BUTTON_OPEN_TO_ALL = true;

// Monthly "Wrapped" (2026-09-27): a player's own story of a month, opened
// from a banner on Fixtures. Admins-only while tested on real months; it
// opens to every member on this UK date (Tuesday 29 September 2026, the
// day after September's last game). Set it to a far-future date to hide it
// from players again.
export const WRAPPED_OPEN_TO_ALL_FROM = "2026-09-29";

// Before the open date, admins see the month in progress ("September so
// far"), updating as each score goes in, so there's something to test.
export const WRAPPED_ADMIN_PREVIEW_MONTH_SO_FAR = true;

// Players' first Wrapped: nobody but admins sees a month before this one,
// so opening it up never shows players the August story.
export const WRAPPED_FIRST_MONTH_FOR_ALL = "2026-09";

// Monzo auto-payment matching is built but parked (backlog), and its
// monzo_transactions table isn't in the live database yet. While this is
// false the app doesn't ask for it, so every open isn't a failed request.
// Flip to true once the table exists.
export const MONZO_MATCHING_LIVE = false;

// Game credits (scoped 2026-10-08): a player who'd paid and drops out gets a
// credit they can spend on any game ("Use credit"), confirming it straight
// away; on a dearer game it covers £5 and they pay the difference. Off until
// the player_credits SQL (supabase/schema.sql) is run on the live database -
// the app doesn't ask for the table while this is false. The env var is
// only for local screenshot previews and is never set in Vercel.
export const GAME_CREDITS_LIVE = false || process.env.NEXT_PUBLIC_CREDITS_PREVIEW === "1";
