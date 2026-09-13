import type { AnthropicToolDef } from "./anthropic";

// General, parameterized primitives - deliberately not one tool per demo
// question, so the model can compose them for whatever's actually asked.
export const GAFFAI_TOOLS: AnthropicToolDef[] = [
  {
    name: "find_games",
    description:
      "Look up fixtures by date range, venue, or published status. Returns each game's id, date, kickoff, venue, price, and booking counts (confirmed, unpaid, pending, waiting). Use this to find a game_id before calling get_game_detail or get_payment_status. For 'the last game,' 'most recent,' or 'who won MOTM last time' - set sort:\"desc\" and date_to to today (see the current date/time given to you) rather than leaving dates unbounded, otherwise you'll get the oldest fixtures on record, not the newest.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD, inclusive" },
        date_to: { type: "string", description: "YYYY-MM-DD, inclusive" },
        venue_contains: { type: "string" },
        published_only: { type: "boolean", description: "Only include fixtures already visible to players" },
        sort: { type: "string", enum: ["asc", "desc"], description: "Sort by date - default asc (oldest first). Use desc for 'most recent'/'last game' questions." },
        limit: { type: "number", description: "Default 100 - the club has ~25 fixtures on record and growing, so don't lower this for a 'how many total/all fixtures' question or you'll undercount." },
      },
    },
  },
  {
    name: "get_fixture_counts",
    description:
      "Exact counts of fixtures - total, already played, and still upcoming. Use this for any 'how many fixtures/games' question instead of calling find_games twice (played + upcoming) and adding them up yourself - that's an easy place to make an arithmetic mistake.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_recent_bookings",
    description:
      "The most recent booking events, newest first - who booked, when, for which game, and their status. Not scoped to one game unless game_id is given, so this is the right tool for 'who booked most recently' or 'last N people to book' across the whole club, not just one fixture.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 10" },
        game_id: { type: "string", description: "Only bookings for this specific game" },
        waiting: { type: "boolean", description: "Filter to only waiting-list (true) or only confirmed-spot (false) bookings" },
      },
    },
  },
  {
    name: "get_game_detail",
    description:
      "Full detail for one fixture: every booking (with its booking_id, player name, payment status, team, timestamps), goal scorers, and the resolved Man of the Match winner(s) for that game.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "find_players",
    description: "Look up players by (partial) name or role. Returns id, display_name, role, push_opt_in.",
    input_schema: {
      type: "object",
      properties: {
        name_contains: { type: "string" },
        role: { type: "string", enum: ["player", "admin", "co-owner", "owner"] },
        limit: { type: "number", description: "Default 100 - the club has 60+ registered profiles, so don't lower this for a 'how many/list all players' question or you'll undercount." },
      },
    },
  },
  {
    name: "get_player_detail",
    description:
      "Full detail for one player: role, self and admin ratings (admin rating already normalized to the same /5 scale as self), emergency contact, whether they're currently blocked from booking due to an overdue payment, and this season's apps/goals/MOTM recognitions.",
    input_schema: { type: "object", properties: { player_id: { type: "string" } }, required: ["player_id"] },
  },
  {
    name: "get_player_records",
    description:
      "Win/loss/draw record and win percentage - pass player_id for one player, or omit it to get every player at once in one call (needed for 'who has the highest win percentage' or 'who's lost the most games' - don't call this per player, that's too many round trips). All-time by default; pass season_year to scope it, e.g. \"2026\".",
    input_schema: {
      type: "object",
      properties: {
        player_id: { type: "string" },
        season_year: { type: "string", description: "e.g. '2026' - filters to games in that calendar year" },
      },
    },
  },
  {
    name: "find_unrated_players",
    description:
      "Every player missing a self-rating and/or an admin-rating, in one efficient call. Use this instead of checking players one by one with get_player_detail - that's far too many round trips for this question and will time out.",
    input_schema: { type: "object", properties: { role: { type: "string", enum: ["player", "admin", "co-owner", "owner"] } } },
  },
  {
    name: "find_players_without_emergency_contact",
    description: "Every player who hasn't added an emergency contact yet, in one efficient call - useful for chasing this up since it matters if someone's ever injured at a game.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_push_notification_issues",
    description:
      "Players whose notifications look broken - opted in (push_opt_in) but with no actual working device subscription behind it, so they think they're getting reminders but aren't. Also returns overall counts (opted in vs actually subscribed).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_possible_duplicate_players",
    description:
      "Players who share the exact same display name (case-insensitive) - likely duplicate profiles from someone signing up twice. Check this before trusting a headcount or 'has X ever played' question if the name seems generic, since a duplicate profile silently splits that person's real history across two records.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_players_without_bookings",
    description:
      "Every player who has never booked a single game, checked against their complete booking history in one call. Use this rather than cross-referencing find_players against find_recent_bookings or find_games yourself - those are capped/paginated and will give you an incomplete, wrong answer (false positives and false negatives) for this specific question.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_overdue_players",
    description:
      "Every player currently blocked from booking a new game because they have an unconfirmed, non-waiting booking on a game that's already happened - mirrors the exact rule the app enforces.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_payment_status",
    description: "Payment breakdown for one fixture: which confirmed (non-waiting) players are unpaid, pending, or confirmed.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "get_motm_winner",
    description:
      "The Man of the Match winner(s) for one specific game, resolved with the real tiebreak rule (most votes wins; a tie on votes means joint winners - never an arbitrary pick). Returns voting_open:true with no winners if voting hasn't closed yet.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "get_player_of_month",
    description:
      "Player of the Month for a given month (defaults to last month), resolved with the real tiebreak chain: most game-level MOTM wins, then most total votes, then most goals that month. Can return multiple joint winners.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM, defaults to last month" } } },
  },
  {
    name: "find_audit_log_entries",
    description:
      "Search the admin activity log - who removed/added/changed what and when. Use this to explain past decisions, e.g. why someone was removed from a game.",
    input_schema: {
      type: "object",
      properties: {
        action_contains: { type: "string" },
        player_name_contains: { type: "string" },
        date_from: { type: "string" },
        date_to: { type: "string" },
        limit: { type: "number", description: "Default 20" },
      },
    },
  },
  {
    name: "suggest_balanced_teams",
    description:
      "Compute an actual balanced team split for a game's confirmed players - a real calculation (rating plus a bounded bonus for goals/MOTM/clean-sheets/win-rate, keepers alternated, sizes kept even), not something to estimate in your own reasoning. Splitting a squad into two fair sides is a constraint problem you will get wrong (duplicate players, impossible averages) if you try it freeform - always call this instead.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "get_club_settings",
    description: "The club's current configured settings - team names/colours for the season, and the default venue/kickoff/price/pitch/squad size used for new fixtures.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_awards",
    description: "Awards the club has handed out - title, value, and any note. Optionally filter by (partial) title.",
    input_schema: { type: "object", properties: { title_contains: { type: "string" } } },
  },
  {
    name: "find_admin_messages",
    description:
      "Messages an admin has sent to a player - who sent it, who received it, whether it's been read, and when. Every admin can see every message here (not just ones they personally sent), same as the in-app admin console. Filter by player name, sender, and/or unread_only. For 'have I sent...' or 'my messages' questions, pass sender_id as the caller's own id (given to you in the system prompt) - without it you'll return messages from every admin, not just the one asking. For 'how many total/unread' questions, quote total_count/unread_count directly - they're real counts, not the length of the messages list, which is capped.",
    input_schema: {
      type: "object",
      properties: {
        player_name_contains: { type: "string" },
        sender_id: { type: "string", description: "Filter to messages sent by this admin's id" },
        unread_only: { type: "boolean" },
        limit: { type: "number", description: "Default 30" },
      },
    },
  },
  {
    name: "find_unmatched_payments",
    description: "Monzo payments that came in but couldn't be automatically matched to a booking - amount, any reference code, and why it didn't match. If the response has connected:false, Monzo hasn't actually been connected yet (the setup guide hasn't been completed) - say so plainly, don't report that as zero unmatched payments.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "Default 30" } } },
  },
  {
    name: "get_prediction_leaderboard",
    description:
      "The score-prediction game leaderboard (3pts for an exact scoreline, 1pt for calling the right result, 0 otherwise) - only counts games that have actually been scored. Omit month for the all-time table, or pass one (\"2026-09\") to scope it.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } },
  },
  {
    name: "get_pot_summary",
    description:
      "The club pot's real balance - not just manual entries, but the same auto-computed match-day surplus/deficit (confirmed payments minus pitch cost) the app itself tracks. Returns total balance, income vs expense, expense by category, and the most recent ledger entries.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_mark_paid",
    description:
      "Prepare (but do NOT execute) marking a specific booking as paid. Returns a proposal for the admin to confirm - this never changes anything by itself. Get the booking_id from get_game_detail first.",
    input_schema: { type: "object", properties: { booking_id: { type: "string" } }, required: ["booking_id"] },
  },
  {
    name: "propose_create_fixture",
    description:
      "Prepare (but do NOT execute) creating a new draft fixture. Any field left out uses the club's usual defaults. Returns a proposal for the admin to confirm - this never creates anything by itself.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        kickoff: { type: "string", description: "HH:MM, 24h" },
        venue: { type: "string" },
        pitch: { type: "string" },
        price: { type: "number" },
        max_players: { type: "number" },
      },
      required: ["date"],
    },
  },
  {
    name: "propose_send_reminder",
    description:
      "Prepare (but do NOT send) a direct message to one player - e.g. nudging them about an unpaid booking, a missed rating, or anything else worth a quick word. Returns a proposal for the admin to confirm - this never sends anything by itself. Look up the player's id with find_players first. Write the message text yourself from the context of the conversation - keep it short and direct, like a real admin would type it - unless the admin already gave you exact wording to use.",
    input_schema: {
      type: "object",
      properties: {
        player_id: { type: "string" },
        message: { type: "string", description: "The exact text to send to the player." },
      },
      required: ["player_id", "message"],
    },
  },
];
