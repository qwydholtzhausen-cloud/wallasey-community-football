import type { AnthropicToolDef } from "./anthropic";

// General, parameterized primitives - deliberately not one tool per demo
// question, so the model can compose them for whatever's actually asked.
export const GAFFAI_TOOLS: AnthropicToolDef[] = [
  {
    name: "find_games",
    description:
      "Look up fixtures by date range, venue, or published status. Returns each game's id, date, kickoff, venue, price, and booking counts (confirmed, unpaid, pending, waiting). Use this to find a game_id before calling get_game_detail or get_payment_status.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD, inclusive" },
        date_to: { type: "string", description: "YYYY-MM-DD, inclusive" },
        venue_contains: { type: "string" },
        published_only: { type: "boolean", description: "Only include fixtures already visible to players" },
        limit: { type: "number", description: "Default 20" },
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
        limit: { type: "number", description: "Default 20" },
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
];
