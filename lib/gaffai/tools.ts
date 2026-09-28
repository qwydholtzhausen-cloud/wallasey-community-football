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
  {
    name: "propose_publish_fixture",
    description:
      "Prepare (but do NOT execute) publishing a draft fixture, making it visible to players so they can book. Returns a proposal for the admin to confirm - this never publishes anything by itself. Look up the game_id with find_games first (unpublished drafts show up there too, with published:false) - fails if the fixture is already published.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "propose_matchday_push",
    description:
      "Prepare (but do NOT send) a push notification to every opted-in player not yet booked onto today's game, letting them know spots are still open. Returns a proposal for the admin to confirm (including how many players it'll reach) - this never sends anything by itself. Only works for a PUBLISHED fixture happening TODAY that still has room (confirmed bookings below max players) - fails otherwise.",
    input_schema: { type: "object", properties: { game_id: { type: "string" } }, required: ["game_id"] },
  },
  {
    name: "save_standing_fact",
    description:
      "Remember a durable fact/rule/correction so EVERY future conversation (with any admin, not just this one) applies it automatically going forward. Use this when an admin tells you something that should stick - a changed default, a naming correction, a standing preference for how you should answer certain things - not for one-off questions or requests, and not for anything that's really just a normal answer. Runs immediately, no confirmation needed - this only ever writes your own internal note, never club data (no booking, payment, message, or fixture is touched), and forget_standing_fact undoes it instantly if it turns out wrong.",
    input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
  },
  {
    name: "forget_standing_fact",
    description:
      "Remove a previously saved standing fact - e.g. it's out of date or was wrong. Use the internal [id:...] tag shown next to each fact in your system prompt, never a guessed id.",
    input_schema: { type: "object", properties: { fact_id: { type: "string" } }, required: ["fact_id"] },
  },
  {
    name: "find_boot_room_listings",
    description:
      "The Boot Room: members' own trades and businesses (it replaced the old Clips page in the Feed tab). Use for anything like 'who in the club can fix a boiler', 'do we have a PT', or 'what's Mo listed for'. Matches the search text against business name, description, tags and the owner's name. Returns each listing's owner, category, tags, whether they've added a WhatsApp number, and how many members recommend them (an endorsement count, not a star rating).",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Free text, e.g. 'boiler', 'photographer', or a member's name. Omit to list everything." },
        category: { type: "string", enum: ["trade", "fitness", "business", "home"], description: "trade = Trades & Motors, fitness = Health & Fitness, business = Business & Creative, home = Home & Personal" },
        limit: { type: "number", description: "Default 30" },
      },
    },
  },
  {
    name: "get_wrapped_engagement",
    description:
      "How many people opened their monthly Wrapped (the full-screen story of their month), watched it to the final card, and shared it - with names, plus who has a Wrapped but hasn't opened it yet. Use for 'how many people watched Wrapped', 'who shared their Wrapped', 'has everyone seen September's'. This isn't shown anywhere in the app; you're the only way admins see it.",
    input_schema: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM, e.g. 2026-09. Omit for the most recent month with any views." } },
    },
  },
  {
    name: "find_dropouts",
    description:
      "Bookings that were removed before a game: who, which game, how long before kickoff, whether they were on the waiting list, and why (self = they gave up their spot, admin = an admin removed them, system = auto-removed for not paying). Recorded from 28 Sep 2026 onwards; earlier drop-outs weren't kept. Use for 'who drops out most', 'late drop-outs this month', 'has X pulled out of games', 'how reliable is X'. A cancelled/deleted fixture never counts. Not shown in the app.",
    input_schema: {
      type: "object",
      properties: {
        player_name_contains: { type: "string", description: "Only this player (partial name match)" },
        days: { type: "number", description: "How far back, default 60" },
        within_hours: { type: "number", description: "Only drop-outs this close to kickoff, e.g. 24 for late drop-outs" },
        include_waiting_list: { type: "boolean", description: "Include people leaving the waiting list (default false - usually not a drop-out)" },
      },
    },
  },
  {
    name: "get_notification_stats",
    description:
      "How many people each kind of push notification reached and how many tapped it (open rate), e.g. teams are out, vote for Man of the Match, kickoff reminders, payment nudges. Recorded from 28 Sep 2026. Use for 'are people opening the notifications', 'which notifications work', 'did anyone tap the teams message'. Not shown in the app.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back, default 30" },
        kind_contains: { type: "string", description: "Only kinds matching this, e.g. 'teams' or 'kickoff'" },
      },
    },
  },
  {
    name: "find_inactive_players",
    description:
      "When members last opened the app, and who has gone quiet: players who haven't opened it in N days, and whether they have any upcoming bookings or when they last played. Tracking started 28 Sep 2026, so anyone with no record yet simply hasn't opened the app since then. Use for 'who's gone quiet', 'who hasn't been on the app', 'when did X last use the app'. Not shown in the app.",
    input_schema: {
      type: "object",
      properties: {
        inactive_days: { type: "number", description: "Not opened in at least this many days, default 21" },
        player_name_contains: { type: "string", description: "Look up one player's last active time instead" },
      },
    },
  },
  {
    name: "find_flagged_feedback",
    description:
      "Answers an admin has flagged as wrong for later review (via the flag button on a GaffAI reply) - the original question, the answer that was flagged, who flagged it, and when. Use this for anything like 'what have people flagged about you' or 'any known mistakes to review'.",
    input_schema: { type: "object", properties: { limit: { type: "number", description: "Default 30" } } },
  },
  {
    name: "get_average_age",
    description:
      "Average age across every player who's added their date of birth, plus how many have (and haven't) set it - so you can tell a genuinely young squad apart from just a small sample. Date of birth is optional and most players may not have set it.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_upcoming_birthdays",
    description:
      "Players whose birthday falls within the next N days (default 14), based on month/day only - the year on file doesn't matter. Returns the age they're turning, how many days away, and their next booked game if they have one (next_game: booking_id/venue/date, already looked up - don't call find_games separately to get this). Only includes players who've added their date of birth.",
    input_schema: { type: "object", properties: { days: { type: "number", description: "Default 14" } } },
  },
  {
    name: "propose_set_pot_exempt",
    description:
      "Prepare (but do NOT execute) marking a specific booking as pot-exempt (free - doesn't count toward pot income) - e.g. a birthday freebie, a prize, or a carried-over credit. Returns a proposal for the admin to confirm - this never changes anything by itself. Get the booking_id from get_game_detail (or find the player's next booked game after find_upcoming_birthdays). reason defaults to 'birthday'.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        reason: { type: "string", enum: ["birthday", "prize", "carried_over", "other"], description: "Defaults to 'birthday'" },
      },
      required: ["booking_id"],
    },
  },
];
