// A postponed game (games.postponed_at, set from the fixture editor): new
// date TBC. It keeps its bookings, teams and payments, but is out of every
// list, count and reminder. Only the players booked on it (and admins) see
// it, as a POSTPONED card. Saving a new date in the editor clears it.
export const isPostponed = (g: { postponed_at?: string | null }) => !!g.postponed_at;
