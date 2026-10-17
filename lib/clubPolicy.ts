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
// away; on a dearer game it covers £5 and they pay the difference. The
// player_credits SQL (supabase/schema.sql) went onto the live database on
// 9 Oct 2026 and passed a live check, so it's on. Setting this to false
// hides credits in the app again (the database keeps earning them).
export const GAME_CREDITS_LIVE = true;

// "For you" (2026-10-17): the cards at the top of Fixtures (MOTM vote, rate
// the game, money owed, the programme, Wrapped, rate yourself) as one
// carousel. Admins-only while tested on real phones; opens to every member
// on this UK date. Far future = admins only.
// Opened to every member 2026-10-17 (the owner's call after admin previews).
export const FOR_YOU_OPEN_TO_ALL_FROM = "2026-10-17";

// One house style (2026-10-17): one set of labels, tabs, buttons and card
// edges across the app (app/ui/houseStyle.ts). Admins first, every member
// from this UK date. Far future = admins only.
// Opened to every member 2026-10-17 (the owner's call after admin previews).
export const HOUSE_STYLE_OPEN_TO_ALL_FROM = "2026-10-17";

// Movement (2026-10-17): swipe between the nav tabs, a pill that slides
// along the nav, and a game card that grows into its squad list. Admins
// first, every member from this UK date. Off for "reduce motion" anyway.
// Opened to every member 2026-10-17 (the owner's call after admin previews).
export const MOVEMENT_OPEN_TO_ALL_FROM = "2026-10-17";

// Season cards (2026-10-17): the top of a player's profile as a
// collectible that levels up with games (Bronze, Silver 5+, Gold 15+;
// Golden Boot and Squad's Pick editions). Admins first, every member from
// this UK date. Far future = admins only.
// Opened to every member 2026-10-17 (the owner's call after admin previews).
export const SEASON_CARDS_OPEN_TO_ALL_FROM = "2026-10-17";

// Occasions (2026-10-17): the matchday takeover reused for the Christmas
// game, every 50th club game, the year's last game and Wrapped day
// (lib/occasions.ts). Admins first, every member from this UK date. Admins
// can preview any of them with ?occasion=christmas|milestone|finale|wrapped.
// Opened to every member 2026-10-17 (the owner's call after admin previews).
export const OCCASIONS_OPEN_TO_ALL_FROM = "2026-10-17";

// Team of the Month (lib/teamOfMonth.ts). Trophies and the Season card
// go back to TOTM_FIRST_MONTH quietly; the push and the full-screen reveal
// start with TOTM_REVEAL_FROM (October's, out Fri 30 Oct 2026).
export const TOTM_FIRST_MONTH = "2026-08";
export const TOTM_REVEAL_FROM = "2026-10";
// Hidden from everyone (card, cabinet trophies, Wrapped-day card) until
// October's release, UK time - the owner's call 2026-10-17. August and
// September appear alongside October then. "" = show straight away.
export const TOTM_VISIBLE_FROM = "2026-10-30T08:00";

// Calmer Fixtures (2026-10-17): one line per game in a month card, the
// actions behind a tap, a slim called-off notice, the reminder ask in For
// you (app/ui/calmfixtures.tsx). Admins first, every member from this UK
// date. Far future = admins only.
export const CALM_FIXTURES_OPEN_TO_ALL_FROM = "9999-12-31";

// Calm Feed (2026-10-17): the last two weeks as moments that link to
// Results instead of repeating it (app/ui/calmfeed.tsx). Admins first,
// every member from this UK date. Far future = admins only.
export const CALM_FEED_OPEN_TO_ALL_FROM = "9999-12-31";

// Calm Results (2026-10-17): Scores, Season and History; Stats and Records
// fold into Season, the Pot opens from Account and Admin
// (app/ui/calmresults.tsx). Admins first, every member from this UK date.
export const CALM_RESULTS_OPEN_TO_ALL_FROM = "9999-12-31";
