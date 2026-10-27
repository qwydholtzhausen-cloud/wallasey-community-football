// The First XI: the club's first 11-a-side (Sun 1 Nov 2026, moved from 25 Oct). One game
// gets a matchday programme, a one-off Man of the Match medal and a
// pennant for everyone who played. Everything here is about that game.

export const FIRST_XI_GAME_ID = "2b0b3006-3dce-40c7-b5c4-a51a5e19af54";

// Voted by each team (16 Oct 2026).
export const FIRST_XI_CAPTAINS = ["Rich Parry", "Adam Stanley"];

// Announced 16 Oct 2026. Used until an admin sets sides on the game itself
// (bookings.team), which then wins.
export const FIRST_XI_REDS = [
  "Qwyd Holtzhausen",
  "Chris Hogan",
  "Liam Mcallister",
  "Wayne Parry",
  "Rich Parry",
  "Lewis Francom",
  "Callum McKay",
  "Loysie (Chris)",
  "dagzy",
  "Matty Rowland",
  "Callum Blake",
];

export const FIRST_XI_DATE_LABEL = "01.11.26";

// Admins see it first to test; everyone from this UK date (Tue 20 Oct, so
// Monday 19th's game and its MOTM vote are in the story).
export const FIRST_XI_OPEN_TO_ALL_FROM = "2026-10-20";

// Match week (the owner's call, 19 Oct): the takeover runs from this UK date
// up to the game, counting down in days, then the matchday version takes
// over on the day. "9999-12-31" = the day only.
// Players from the same UK date the programme opens to everyone (the
// owner's call, 19 Oct). Admins from FIRST_XI_TAKEOVER_ADMINS_FROM.
export const FIRST_XI_TAKEOVER_FROM = "2026-10-20";
export const FIRST_XI_TAKEOVER_ADMINS_FROM = "2026-10-19";

