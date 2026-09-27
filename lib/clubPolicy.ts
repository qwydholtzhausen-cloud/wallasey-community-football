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

// "Add to calendar" on booked fixtures (2026-09-27). Admins only while it's
// tested on real phones - how an iPhone's Home Screen app hands a calendar
// file to the Calendar app can only really be checked on a device. Flip to
// true to give it to everyone.
export const CALENDAR_BUTTON_OPEN_TO_ALL = false;
