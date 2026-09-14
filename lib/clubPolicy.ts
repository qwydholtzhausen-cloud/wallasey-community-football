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
