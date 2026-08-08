"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";
import { MOTM_VOTE_WINDOW_MINUTES, kickoffCutoff, nowInLondon, previousMonthKey } from "../lib/time";

// The payment link is just config, not baked into booking logic (statuses
// below), so swapping providers later only touches this one env var.
const PAYMENT_LINK = process.env.NEXT_PUBLIC_PAYMENT_LINK || "";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const MAX_SPOTS = 16;

type Role = "player" | "admin" | "co-owner" | "owner";
type PayStatus = "unpaid" | "pending" | "confirmed";

const STATUS_LABEL: Record<PayStatus, string> = {
  unpaid: "Payment Pending",
  pending: "Awaiting Approval",
  confirmed: "Confirmed",
};

function StatusBadge({ status }: { status: PayStatus }) {
  return <span className={"wcf-status-badge " + status}>{STATUS_LABEL[status]}</span>;
}

function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="wcf-star-picker">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={"wcf-star" + (n <= value ? " on" : "")} onClick={() => onChange(n)} aria-label={`${n} of 5`}>
          ★
        </button>
      ))}
    </div>
  );
}

function RatingForm({
  initial,
  onSave,
  saveLabel,
}: {
  initial: PlayerRating | null;
  onSave: (fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  saveLabel: string;
}) {
  const [fitness, setFitness] = useState(initial?.fitness ?? 3);
  const [attack, setAttack] = useState(initial?.attack ?? 3);
  const [defence, setDefence] = useState(initial?.defence ?? 3);
  const [position, setPosition] = useState<PlayerPosition>(initial?.position ?? "midfield");

  return (
    <div className="wcf-rating-form">
      <div className="wcf-rating-row"><span>Fitness</span><StarPicker value={fitness} onChange={setFitness} /></div>
      <div className="wcf-rating-row"><span>Attack</span><StarPicker value={attack} onChange={setAttack} /></div>
      <div className="wcf-rating-row"><span>Defence</span><StarPicker value={defence} onChange={setDefence} /></div>
      <div className="wcf-rating-row">
        <span>Position</span>
        <select value={position} onChange={(e) => setPosition(e.target.value as PlayerPosition)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>{POSITION_LABEL[p]}</option>
          ))}
        </select>
      </div>
      <button className="wcf-save" onClick={() => onSave(fitness, attack, defence, position)}>{saveLabel}</button>
    </div>
  );
}

interface Profile {
  id: string;
  display_name: string;
  role: Role;
  created_at?: string;
  push_opt_in?: boolean;
}

type Team = "white" | "red";

interface BookingRow {
  id: string;
  player_id: string;
  status: PayStatus;
  waiting: boolean;
  team: Team | null;
  created_at: string;
  player: Profile;
  confirmer: { display_name: string } | null;
}

interface GameRow {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  max_players: number;
  pitch_cost: number;
  team_white_score: number | null;
  team_red_score: number | null;
  published: boolean;
  bookings: BookingRow[];
}

type PotCategory = "pitch" | "socials" | "equipment" | "sponsorship" | "other";

type PlayerPosition = "keeper" | "defence" | "midfield" | "attack";
const POSITION_LABEL: Record<PlayerPosition, string> = { keeper: "Keeper", defence: "Defence", midfield: "Midfield", attack: "Attack" };
const POSITIONS: PlayerPosition[] = ["keeper", "defence", "midfield", "attack"];

interface PlayerRating {
  player_id: string;
  fitness: number;
  attack: number;
  defence: number;
  position: PlayerPosition;
}
const POT_CATEGORY_LABEL: Record<PotCategory, string> = {
  pitch: "Pitch hire",
  socials: "Socials",
  equipment: "Equipment",
  sponsorship: "Sponsorship",
  other: "Other",
};

interface PotEntry {
  id: string;
  amount: number;
  description: string;
  category: PotCategory;
  created_at: string;
}

interface MotmVote {
  id: string;
  game_id: string;
  voter_id: string;
  candidate_id: string;
}

interface FeedReaction {
  id: string;
  item_key: string;
  emoji: string;
  user_id: string;
}

interface AuditLogEntry {
  id: string;
  action: string;
  details: string | null;
  created_at: string;
  actor: { display_name: string } | null;
}

const FEED_REACTION_EMOJI = ["👍", "🔥"] as const;

type FeedItem =
  | { key: string; ts: number; kind: "clip"; clip: ClipRow }
  | { key: string; ts: number; kind: "derived"; icon: string; tone: "amber" | "green" | "blue"; text: React.ReactNode };

interface ClubSettings {
  team_white_name: string;
  team_white_color: string;
  team_red_name: string;
  team_red_color: string;
  default_venue: string;
  default_kickoff: string;
  default_price: number;
  default_pitch: string;
  default_max_players: number;
}

interface AwardRow {
  id: string;
  title: string;
  value: string;
  note: string | null;
}

// Picks black or white text so admin-chosen team colours stay readable
// regardless of how light/dark the colour they picked is.
function readableTextColor(hex: string) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0A1A34" : "#ffffff";
}

interface ClipRow {
  id: string;
  title: string;
  video_url: string | null;
  created_at: string;
  submitted_by: string | null;
  submitter: Profile | null;
}


interface GoalRow {
  id: string;
  game_id: string;
  player_id: string;
  goals: number;
  player: Profile;
}

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// Feed items are dated historical facts, not live status - without a
// visible date, something like "Pot passed £50" reads as a claim about
// right now rather than a moment that happened and may since have moved.
function fmtFeedDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function defaultNewGameDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

const Icon = {
  cal: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M8 2.5v4M16 2.5v4" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  pulse: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M7 12h2.5l1.5-4 3 8 1.5-4H17" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7z" strokeLinejoin="round" />
    </svg>
  ),
  shirt: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 3.5L12 5l4-1.5 4 4-3 3V20H7V10.5l-3-3z" strokeLinejoin="round" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4.5h4.5" />
      <path d="M12 8v4.5l3 2" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" strokeLinejoin="round" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M12 14v3M9 20h6M9.5 17h5l.5 3H9z" strokeLinejoin="round" />
    </svg>
  ),
};

export default function WirralCommunityFootball() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <div className="wcf-root">
      <style>{css}</style>
      {session === undefined ? (
        <div className="wcf-splash">
          <span className="wcf-logo big">
            <img src="/logo.png" alt="Wirral Community Football crest" />
          </span>
        </div>
      ) : session ? (
        <App session={session} />
      ) : (
        <SignIn />
      )}
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setSending(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setVerifying(false);
    if (error) setError(error.message);
  }

  return (
    <div className="wcf-signin">
      <span className="wcf-logo big">
        <img src="/logo.png" alt="Wirral Community Football crest" />
      </span>
      <div className="wcf-wordmark">WIRRAL</div>
      <div className="wcf-wordmark-sub">COMMUNITY FOOTBALL</div>

      {sent ? (
        <form className="wcf-signin-form" onSubmit={verifyCode}>
          <p className="wcf-signin-sent">
            Enter the code emailed to <strong>{email}</strong>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            required
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" disabled={verifying || !code.trim()}>
            {verifying ? "Checking…" : "Verify code"}
          </button>
          {error && <p className="wcf-signin-error">{error}</p>}
          <button type="button" className="wcf-signin-back" onClick={() => { setSent(false); setCode(""); setError(null); }}>
            Use a different email
          </button>
        </form>
      ) : (
        <form className="wcf-signin-form" onSubmit={sendCode}>
          <input
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" disabled={sending || !email.trim()}>
            {sending ? "Sending…" : "Send sign-in code"}
          </button>
          {error && <p className="wcf-signin-error">{error}</p>}
          <button type="button" className="wcf-signin-back" disabled={!email.trim()} onClick={() => setSent(true)}>
            I already have a code
          </button>
        </form>
      )}

      <p className="wcf-privacy-note">
        We only store your name, email, and booking history to run the club — nothing else.
      </p>
    </div>
  );
}

function App({ session }: { session: Session }) {
  const myId = session.user.id;
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [goalRows, setGoalRows] = useState<GoalRow[]>([]);
  const [clubSettings, setClubSettings] = useState<ClubSettings | null>(null);
  const [awards, setAwards] = useState<AwardRow[]>([]);
  const [potEntries, setPotEntries] = useState<PotEntry[]>([]);
  const [motmVotes, setMotmVotes] = useState<MotmVote[]>([]);
  const [feedReactions, setFeedReactions] = useState<FeedReaction[]>([]);
  const [hiddenFeedKeys, setHiddenFeedKeys] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [pushStats, setPushStats] = useState<{ total: number; subscribed: number } | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [selfRatings, setSelfRatings] = useState<PlayerRating[]>([]);
  const [adminRatings, setAdminRatings] = useState<PlayerRating[]>([]);
  const [lineupView, setLineupView] = useState<"sheet" | "fairness">("sheet");
  const [suggestedTeams, setSuggestedTeams] = useState<{ white: string[]; red: string[] } | null>(null);
  const [ratingPlayerId, setRatingPlayerId] = useState<string | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [pushNudgeDismissed, setPushNudgeDismissed] = useState(true);
  useEffect(() => {
    setPushNudgeDismissed(localStorage.getItem("wcf-push-nudge-dismissed") === "true");
  }, []);
  function dismissPushNudge() {
    localStorage.setItem("wcf-push-nudge-dismissed", "true");
    setPushNudgeDismissed(true);
  }
  const [ratingNudgeDismissed, setRatingNudgeDismissed] = useState(true);
  useEffect(() => {
    setRatingNudgeDismissed(localStorage.getItem("wcf-rating-nudge-dismissed") === "true");
  }, []);
  function dismissRatingNudge() {
    localStorage.setItem("wcf-rating-nudge-dismissed", "true");
    setRatingNudgeDismissed(true);
  }
  const prevStatusRef = useRef<Record<string, PayStatus>>({});
  const prevWaitingRef = useRef<Record<string, boolean>>({});

  function notifyError(message: string) {
    setToast({ kind: "error", text: message });
  }
  function notifySuccess(text: string) {
    setToast({ kind: "success", text });
  }

  const [tab, setTab] = useState<"fixtures" | "feed" | "lineup" | "results" | "account" | "admin">("fixtures");
  const [resultsView, setResultsView] = useState<"season" | "table" | "fixtures" | "pot" | "finances">("season");
  const [potAmount, setPotAmount] = useState("");
  const [potDescription, setPotDescription] = useState("");
  const [potEntryKind, setPotEntryKind] = useState<"add" | "deduct">("add");
  const [potCategory, setPotCategory] = useState<PotCategory>("other");
  const [addingPotEntry, setAddingPotEntry] = useState(false);
  const [resultsMonth, setResultsMonth] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [editingLineup, setEditingLineup] = useState(false);
  const [clipTitle, setClipTitle] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [feedView, setFeedView] = useState<"feed" | "clips">("feed");

  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "co-owner" || myProfile?.role === "owner";
  const isOwner = myProfile?.role === "owner";
  const cs: ClubSettings = clubSettings ?? {
    team_white_name: "Whites",
    team_white_color: "#EEF4FC",
    team_red_name: "Reds",
    team_red_color: "#E42A36",
    default_venue: "New venue",
    default_kickoff: "19:00",
    default_price: 5,
    default_pitch: "8-a-side",
    default_max_players: MAX_SPOTS,
  };

  const loadProfile = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, push_opt_in").eq("id", myId).single();
    if (data) setMyProfile(data as Profile);
  }, [myId]);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, created_at").order("display_name");
    if (data) setProfiles(data as Profile[]);
  }, []);

  const loadGames = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select(
        "id, date, kickoff, venue, pitch, price, max_players, pitch_cost, team_white_score, team_red_score, published, bookings(id, player_id, status, waiting, team, created_at, player:profiles!bookings_player_id_fkey(id, display_name, role), confirmer:profiles!bookings_confirmed_by_fkey(display_name))"
      )
      .order("date", { ascending: true });
    if (data) setGames(data as unknown as GameRow[]);
  }, []);

  const loadClubSettings = useCallback(async () => {
    const { data } = await supabase
      .from("club_settings")
      .select(
        "team_white_name, team_white_color, team_red_name, team_red_color, default_venue, default_kickoff, default_price, default_pitch, default_max_players"
      )
      .single();
    if (data) setClubSettings(data as ClubSettings);
  }, []);

  const loadAwards = useCallback(async () => {
    const { data } = await supabase.from("awards").select("id, title, value, note").order("created_at", { ascending: true });
    if (data) setAwards(data as AwardRow[]);
  }, []);

  const loadPotEntries = useCallback(async () => {
    const { data } = await supabase.from("pot_entries").select("id, amount, description, category, created_at").order("created_at", { ascending: false });
    if (data) setPotEntries(data as PotEntry[]);
  }, []);

  const loadMotmVotes = useCallback(async () => {
    const { data } = await supabase.from("motm_votes").select("id, game_id, voter_id, candidate_id");
    if (data) setMotmVotes(data as MotmVote[]);
  }, []);

  const loadFeedReactions = useCallback(async () => {
    const { data } = await supabase.from("feed_reactions").select("id, item_key, emoji, user_id");
    if (data) setFeedReactions(data as FeedReaction[]);
  }, []);

  const loadHiddenFeedItems = useCallback(async () => {
    const { data } = await supabase.from("feed_hidden_items").select("item_key");
    if (data) setHiddenFeedKeys(data.map((r) => r.item_key));
  }, []);

  // RLS scopes what actually comes back: a non-admin only ever gets their
  // own row from either table (self-ratings) or nothing at all
  // (admin-ratings, never visible to players) - no client-side filtering
  // needed on top of that.
  const loadSelfRatings = useCallback(async () => {
    const { data } = await supabase.from("player_self_ratings").select("player_id, fitness, attack, defence, position");
    if (data) setSelfRatings(data as PlayerRating[]);
  }, []);
  const loadAdminRatings = useCallback(async () => {
    const { data } = await supabase.from("player_admin_ratings").select("player_id, fitness, attack, defence, position");
    if (data) setAdminRatings(data as PlayerRating[]);
  }, []);

  const loadClips = useCallback(async () => {
    const { data } = await supabase
      .from("clips")
      .select("id, title, video_url, created_at, submitted_by, submitter:profiles(id, display_name, role)")
      .order("created_at", { ascending: false });
    if (data) setClips(data as unknown as ClipRow[]);
  }, []);

  const loadGoals = useCallback(async () => {
    const { data } = await supabase
      .from("game_stats")
      .select("id, game_id, player_id, goals, player:profiles(id, display_name, role)")
      .order("goals", { ascending: false });
    if (data) setGoalRows(data as unknown as GoalRow[]);
  }, []);

  const loadAll = useCallback(
    () =>
      Promise.all([
        loadProfile(),
        loadProfiles(),
        loadGames(),
        loadClips(),
        loadGoals(),
        loadClubSettings(),
        loadAwards(),
        loadPotEntries(),
        loadMotmVotes(),
        loadFeedReactions(),
        loadHiddenFeedItems(),
        loadSelfRatings(),
        loadAdminRatings(),
      ]),
    [
      loadProfile,
      loadProfiles,
      loadGames,
      loadClips,
      loadGoals,
      loadClubSettings,
      loadAwards,
      loadPotEntries,
      loadMotmVotes,
      loadFeedReactions,
      loadHiddenFeedItems,
      loadSelfRatings,
      loadAdminRatings,
    ]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadAll();
      setLoading(false);
    })();
  }, [loadAll]);

  // PWAs/mobile browsers often suspend the page in the background and just
  // resume the same in-memory state when reopened, rather than reloading -
  // so refetch whenever the app actually comes back into view.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") loadAll();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadAll]);

  useEffect(() => {
    const channel = supabase
      .channel("bookings-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => {
        loadGames();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadGames]);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevWaiting = prevWaitingRef.current;
    const nextStatus: Record<string, PayStatus> = {};
    const nextWaiting: Record<string, boolean> = {};
    games.forEach((g) => {
      const mine = g.bookings.find((b) => b.player_id === myId);
      if (!mine) return;
      nextStatus[g.id] = mine.status;
      nextWaiting[g.id] = mine.waiting;
      if (prevStatus[g.id] && prevStatus[g.id] !== "confirmed" && mine.status === "confirmed") {
        notifySuccess(`✓ Payment confirmed for ${g.venue} · ${fmtDate(g.date)}`);
      }
      if (prevWaiting[g.id] === true && mine.waiting === false) {
        notifySuccess(`🎉 A spot opened up — you're in for ${g.venue} · ${fmtDate(g.date)}!`);
      }
    });
    prevStatusRef.current = nextStatus;
    prevWaitingRef.current = nextWaiting;
  }, [games, myId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Pulls a guaranteed-current session token directly from Supabase
  // (transparently refreshing if needed) rather than trusting the
  // `session` prop, which is only as fresh as the last onAuthStateChange
  // event - on a backgrounded mobile PWA that listener's refresh timer can
  // stall, leaving the prop holding a token that's actually gone stale (or
  // fully invalid) without the UI showing anything's wrong. Confirmed as a
  // real, reproducible failure mode, not just a theory - every admin fetch
  // to a Route Handler goes through this now instead of reading the prop
  // directly.
  async function getFreshAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  useEffect(() => {
    if (!isAdmin || tab !== "account") return;
    (async () => {
      const token = await getFreshAccessToken();
      if (!token) return;
      const res = await fetch("/api/push/stats", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setPushStats(await res.json());
    })();
  }, [isAdmin, tab]);

  // Best-effort - push delivery shouldn't block or fail the booking/fixture
  // action itself, so failures here just log rather than surface a toast.
  async function pushNotify(path: string, body: Record<string, string>) {
    try {
      const token = await getFreshAccessToken();
      if (!token) return console.error("Push notify skipped - no session", path);
      await fetch(`/api/push/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("Push notify failed", path, err);
    }
  }

  // Best-effort, same reasoning as pushNotify - a logging failure shouldn't
  // block or fail the actual admin action it's recording.
  async function logAction(action: string, details: string) {
    try {
      await supabase.from("audit_log").insert({ actor_id: myId, action, details });
    } catch (err) {
      console.error("Audit log failed", action, err);
    }
  }
  async function loadAuditLog() {
    const { data } = await supabase
      .from("audit_log")
      .select("id, action, details, created_at, actor:profiles(display_name)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (data) setAuditLog(data as unknown as AuditLogEntry[]);
  }
  async function toggleAuditLog() {
    if (!showAuditLog) await loadAuditLog();
    setShowAuditLog((v) => !v);
  }

  async function saveSelfRating(fitness: number, attack: number, defence: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_self_ratings")
      .upsert({ player_id: myId, fitness, attack, defence, position, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Saved your self-rating");
    await loadSelfRatings();
  }

  async function saveAdminRating(playerId: string, fitness: number, attack: number, defence: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_admin_ratings")
      .upsert({ player_id: playerId, fitness, attack, defence, position, updated_by: myId, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Rating saved");
    logAction("Rated player", profiles.find((p) => p.id === playerId)?.display_name ?? "someone");
    await loadAdminRatings();
  }

  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      notifyError("Push isn't supported in this browser");
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        notifyError("Notifications were blocked — check your browser/phone settings to allow them");
        return false;
      }
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
      const json = sub.toJSON();
      const { error } = await supabase
        .from("push_subscriptions")
        .upsert(
          { user_id: myId, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_key: json.keys?.auth },
          { onConflict: "endpoint" }
        );
      if (error) return notifyError(error.message), false;
      const { error: profErr } = await supabase.from("profiles").update({ push_opt_in: true }).eq("id", myId);
      if (profErr) return notifyError(profErr.message), false;
      await loadProfile();
      return true;
    } catch (err) {
      notifyError(err instanceof Error ? err.message : "Couldn't enable notifications");
      return false;
    }
  }

  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error("Push unsubscribe failed", err);
    }
    const { error } = await supabase.from("profiles").update({ push_opt_in: false }).eq("id", myId);
    if (error) return notifyError(error.message);
    await loadProfile();
  }

  async function sendTestPush() {
    const token = await getFreshAccessToken();
    if (!token) return notifyError("Your session's expired — refresh the page and sign in again, then retry.");
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Couldn't send a test push" }));
      notifyError(error || "Couldn't send a test push");
      return;
    }
    notifySuccess("Test push sent — should land in a few seconds");
  }

  async function book(gameId: string) {
    // Payment-needed push isn't instant - it's picked up by the frequent
    // cron job 30 min later, only if still unpaid by then (see
    // api/cron/frequent). Firing it here would just nag someone who's
    // already looking at the Pay Now button.
    const { data, error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: myId }).select("waiting").single();
    if (error) {
      if (error.code === "42501") return notifyError("You have an overdue payment — speak to an admin to confirm it before booking again.");
      return notifyError(error.message);
    }
    // "Last spot" is about the physical roster filling up, not payment
    // status - checking here (right when a spot's actually taken) rather
    // than on payment confirmation, which could happen long after the
    // game's already full.
    if (data && !data.waiting) pushNotify("notify-last-spot", { gameId });
  }
  async function addBooking(gameId: string, playerId: string) {
    const { data, error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: playerId }).select("waiting").single();
    if (error) return notifyError(error.message);
    if (data && !data.waiting) pushNotify("notify-last-spot", { gameId });
  }
  async function cancel(bookingId: string) {
    const { error } = await supabase.from("bookings").delete().eq("id", bookingId);
    if (error) notifyError(error.message);
  }
  async function markPaid(bookingId: string) {
    const { error } = await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId);
    if (error) notifyError(error.message);
  }
  async function setBookingStatus(bookingId: string, status: PayStatus) {
    // Not logged to the audit log - happens up to ~16 times a week per
    // fixture, and it's already visible live via the payment status dot on
    // each booking and the Overdue section, so logging it too would just
    // bury the genuinely rare, otherwise-invisible actions (role changes,
    // fixture posts/deletes) under routine noise. Who confirmed it is still
    // tracked on the booking itself (confirmed_by/confirmed_at) so it's
    // there if ever needed, without it being a noisy feed of its own.
    const patch: { status: PayStatus; confirmed_by?: string; confirmed_at?: string } = { status };
    if (status === "confirmed") {
      patch.confirmed_by = myId;
      patch.confirmed_at = new Date().toISOString();
    }
    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    if (error) return notifyError(error.message);
  }

  async function addGame() {
    // Created unpublished - only visible to admins until the first Save,
    // which is when it actually becomes real (see saveGame). Avoids both
    // players glimpsing a "New venue" placeholder and the new-fixture push
    // firing with today's default date before anyone's actually set the
    // real details.
    const { data, error } = await supabase
      .from("games")
      .insert({
        date: defaultNewGameDate(),
        kickoff: cs.default_kickoff,
        venue: cs.default_venue,
        pitch: cs.default_pitch,
        price: cs.default_price,
        max_players: cs.default_max_players,
        published: false,
      })
      .select()
      .single();
    if (error) return notifyError(error.message);
    await loadGames();
    if (data) setEditingId(data.id);
  }
  async function saveGame(id: string, patch: Partial<GameRow>) {
    const { bookings: _bookings, published: _published, ...rest } = patch as GameRow;
    const wasPublished = games.find((g) => g.id === id)?.published;
    const { error } = await supabase.from("games").update({ ...rest, published: true }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    setEditingId(null);
    // First confirm of a draft fixture is what actually announces it -
    // later edits to an already-published fixture don't re-announce.
    if (!wasPublished) {
      pushNotify("notify-new-fixture", { gameId: id });
      logAction("Posted fixture", `${rest.venue} — ${fmtDate(rest.date)}`);
    }
  }
  async function deleteGame(id: string) {
    const game = games.find((g) => g.id === id);
    const { error } = await supabase.from("games").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    if (game) logAction("Deleted fixture", `${game.venue} — ${fmtDate(game.date)}`);
  }
  async function saveResult(gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) {
    const { error: scoreErr } = await supabase
      .from("games")
      .update({ team_white_score: whiteScore, team_red_score: redScore })
      .eq("id", gameId);
    if (scoreErr) return notifyError(scoreErr.message);

    const rows = Object.entries(goals).map(([player_id, goals]) => ({ game_id: gameId, player_id, goals }));
    if (rows.length) {
      const { error: goalsErr } = await supabase.from("game_stats").upsert(rows, { onConflict: "game_id,player_id" });
      if (goalsErr) return notifyError(goalsErr.message);
    }

    await Promise.all([loadGames(), loadGoals()]);
    notifySuccess("Result saved");
  }

  async function saveClubSettings(patch: Partial<ClubSettings>) {
    const { error } = await supabase.from("club_settings").update(patch).eq("id", true);
    if (error) return notifyError(error.message);
    await loadClubSettings();
    notifySuccess("Club settings saved");
  }

  async function addAward(title: string, value: string, note: string) {
    const { error } = await supabase.from("awards").insert({ title, value, note: note || null });
    if (error) return notifyError(error.message);
    await loadAwards();
  }
  async function deleteAward(id: string) {
    const { error } = await supabase.from("awards").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadAwards();
  }

  async function addPotEntry(amount: number, description: string, category: PotCategory) {
    const { error } = await supabase.from("pot_entries").insert({ amount, description, category, created_by: myId });
    if (error) return notifyError(error.message);
    await loadPotEntries();
  }
  async function deletePotEntry(id: string) {
    const { error } = await supabase.from("pot_entries").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadPotEntries();
  }

  async function castMotmVote(gameId: string, candidateId: string) {
    const { error } = await supabase
      .from("motm_votes")
      .upsert({ game_id: gameId, voter_id: myId, candidate_id: candidateId }, { onConflict: "game_id,voter_id" });
    if (error) return notifyError(error.message);
    await loadMotmVotes();
  }

  async function toggleReaction(itemKey: string, emoji: string) {
    const existing = feedReactions.find((r) => r.item_key === itemKey && r.emoji === emoji && r.user_id === myId);
    const { error } = existing
      ? await supabase.from("feed_reactions").delete().eq("id", existing.id)
      : await supabase.from("feed_reactions").insert({ item_key: itemKey, emoji, user_id: myId });
    if (error) return notifyError(error.message);
    await loadFeedReactions();
  }

  async function hideFeedItem(itemKey: string) {
    const { error } = await supabase.from("feed_hidden_items").insert({ item_key: itemKey, hidden_by: myId });
    if (error) return notifyError(error.message);
    notifySuccess("Archived — find it again under \"Show archived\"");
    await loadHiddenFeedItems();
  }
  async function unhideFeedItem(itemKey: string) {
    const { error } = await supabase.from("feed_hidden_items").delete().eq("item_key", itemKey);
    if (error) return notifyError(error.message);
    notifySuccess("Restored to the feed");
    await loadHiddenFeedItems();
  }

  async function addClip(e: React.FormEvent) {
    e.preventDefault();
    if (!clipTitle.trim()) return;
    const { error } = await supabase.from("clips").insert({ title: clipTitle.trim(), video_url: clipUrl.trim() || null, submitted_by: myId });
    if (error) return notifyError(error.message);
    setClipTitle("");
    setClipUrl("");
    await loadClips();
  }
  async function deleteClip(id: string) {
    const { error } = await supabase.from("clips").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadClips();
  }

  async function setTeam(bookingId: string, team: Team | null) {
    const { error } = await supabase.from("bookings").update({ team }).eq("id", bookingId);
    if (error) notifyError(error.message);
  }

  async function applySuggestedTeams() {
    if (!suggestedTeams) return;
    const bookingIdByPlayer = new Map(nextConfirmed.map((b) => [b.player_id, b.id]));
    await Promise.all(
      [...suggestedTeams.white.map((id) => [id, "white"] as const), ...suggestedTeams.red.map((id) => [id, "red"] as const)].map(
        ([playerId, team]) => {
          const bookingId = bookingIdByPlayer.get(playerId);
          return bookingId ? setTeam(bookingId, team) : Promise.resolve();
        }
      )
    );
    setSuggestedTeams(null);
    await loadGames();
    notifySuccess("Applied the suggested split — tweak any individual player in Team Sheet if needed");
  }

  async function renameSelf(name: string) {
    if (!name.trim()) return;
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", myId);
    if (error) return notifyError(error.message);
    await Promise.all([loadProfile(), loadProfiles()]);
  }
  async function setRole(id: string, role: Role) {
    const targetName = profiles.find((p) => p.id === id)?.display_name ?? "someone";
    const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadProfiles();
    logAction("Changed role", `${targetName} → ${ROLE_LABEL[role]}`);
  }
  async function deleteProfile(id: string, name: string) {
    if (!confirm(`Permanently delete ${name}'s account? This removes their login and all their bookings. This can't be undone.`)) return;
    const token = await getFreshAccessToken();
    if (!token) return notifyError("Your session's expired — refresh the page and sign in again, then retry.");
    const res = await fetch("/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetId: id }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Something went wrong" }));
      notifyError(error || "Couldn't delete that account");
      return;
    }
    await Promise.all([loadProfiles(), loadGames()]);
    logAction("Deleted account", name);
  }
  async function addPlayer(email: string, displayName: string) {
    const token = await getFreshAccessToken();
    if (!token) {
      notifyError("Your session's expired — refresh the page and sign in again, then retry.");
      return false;
    }
    const res = await fetch("/api/admin/add-player", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, displayName }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Something went wrong" }));
      notifyError(error || "Couldn't add that player");
      return false;
    }
    notifySuccess(`${displayName || email} can now sign in with that email`);
    await loadProfiles();
    logAction("Added player", displayName || email);
    return true;
  }
  async function generateLoginCode(email: string): Promise<string | null> {
    const token = await getFreshAccessToken();
    if (!token) {
      notifyError("Your session's expired — refresh the page and sign in again, then retry.");
      return null;
    }
    const res = await fetch("/api/admin/generate-login-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notifyError(data.error || "Couldn't generate a code");
      return null;
    }
    logAction("Generated login code", email);
    return data.code as string;
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  const nowUk = nowInLondon();
  const upcomingGames = useMemo(
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, 90) > nowUk).sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)),
    [games, nowUk]
  );
  const pastGames = useMemo(
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, 90) <= nowUk).sort((a, b) => b.date.localeCompare(a.date) || b.kickoff.localeCompare(a.kickoff)),
    [games, nowUk]
  );

  // Same definition as the admin console's "Overdue" section - an
  // unconfirmed, non-waiting booking on a game that's already happened.
  // Mirrors the RLS check in has_overdue_payment() so the UI matches what
  // the database will actually enforce, not just a client-side guess.
  const myOverdueBookings = useMemo(
    () =>
      pastGames.flatMap((g) =>
        g.bookings.filter((b) => b.player_id === myId && !b.waiting && b.status !== "confirmed").map((b) => ({ game: g, booking: b }))
      ),
    [pastGames, myId]
  );
  const iAmOverdue = myOverdueBookings.length > 0;

  // Same "is push actually working on this device" derivation used in
  // AccountPanel - the DB flag alone isn't enough proof (see the toggle
  // fix), and permission is per-device anyway.
  const myPushGranted = typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted";
  const showPushNudge = !myPushGranted && !pushNudgeDismissed;
  const myRating = selfRatings.find((r) => r.player_id === myId) ?? null;
  const showRatingNudge = !myRating && !ratingNudgeDismissed;

  function motmVotingOpen(g: GameRow) {
    return kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk;
  }
  const myMotmVoteByGame = useMemo(() => {
    const map: Record<string, string> = {};
    for (const v of motmVotes) if (v.voter_id === myId) map[v.game_id] = v.candidate_id;
    return map;
  }, [motmVotes, myId]);
  const motmTallyByGame = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const v of motmVotes) {
      map[v.game_id] ??= {};
      map[v.game_id][v.candidate_id] = (map[v.game_id][v.candidate_id] ?? 0) + 1;
    }
    return map;
  }, [motmVotes]);

  const potLedger = useMemo(() => {
    // Counts as soon as a game has any confirmed payment - people pay in
    // advance to secure a spot, so that money is real before kickoff, not
    // after. Games with zero confirmed payments are excluded entirely
    // (rather than showing an immediate -pitch_cost the moment a fixture
    // is created, before anyone's even had a chance to book).
    const autoEntries = games
      .filter((g) => g.bookings.some((b) => !b.waiting && b.status === "confirmed"))
      .map((g) => {
        const confirmedPaid = g.bookings.filter((b) => !b.waiting && b.status === "confirmed").length;
        const amount = confirmedPaid * g.price - g.pitch_cost;
        return {
          id: `game-${g.id}`,
          date: g.date,
          amount,
          description: `${g.venue} · ${fmtDate(g.date)} — ${confirmedPaid} paid × £${g.price} − £${g.pitch_cost} pitch`,
          category: "pitch" as PotCategory,
          kind: "auto" as const,
        };
      });
    const manualEntries = potEntries.map((e) => ({
      id: e.id,
      category: e.category,
      date: e.created_at.slice(0, 10),
      amount: e.amount,
      description: e.description,
      kind: "manual" as const,
    }));
    return [...autoEntries, ...manualEntries].sort((a, b) => b.date.localeCompare(a.date));
  }, [games, potEntries]);
  const potTotal = useMemo(() => potLedger.reduce((sum, e) => sum + e.amount, 0), [potLedger]);

  // Income/expenses computed from source data (games, manual entries)
  // rather than potLedger's already-netted auto entries - a game's net
  // +£30 hides that it was actually £110 in vs £80 pitch cost, and this
  // view is specifically about showing those two sides separately.
  const financeSummary = useMemo(() => {
    let grossIncome = 0;
    let pitchExpense = 0;
    for (const g of games) {
      const confirmedPaid = g.bookings.filter((b) => !b.waiting && b.status === "confirmed").length;
      if (confirmedPaid === 0) continue; // matches potLedger's own inclusion rule
      grossIncome += confirmedPaid * g.price;
      pitchExpense += g.pitch_cost;
    }
    const manualIncome = potEntries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
    const manualExpense = potEntries.filter((e) => e.amount < 0).reduce((sum, e) => sum + Math.abs(e.amount), 0);

    const byCategory = { pitch: pitchExpense, socials: 0, equipment: 0, sponsorship: 0, other: 0 } as Record<PotCategory, number>;
    for (const e of potEntries) {
      if (e.amount < 0) byCategory[e.category] += Math.abs(e.amount);
    }

    const chron = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    const balancePoints = chron.map((e) => {
      running += e.amount;
      return { date: e.date, balance: running };
    });

    const byFixture = potLedger.filter((e) => e.kind === "auto").slice(0, 8);

    return { income: grossIncome + manualIncome, expenses: pitchExpense + manualExpense, byCategory, balancePoints, byFixture };
  }, [games, potEntries, potLedger]);

  function exportFinanceCsv() {
    const rows = [
      ["Date", "Description", "Category", "Amount"],
      ...potLedger.map((e) => [e.date, e.description, POT_CATEGORY_LABEL[e.category], e.amount.toFixed(2)]),
    ];
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wirral-community-football-finances-${nowInLondon().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // The club feed is mostly a view over data that already exists elsewhere
  // (results, joiners, the pot) rather than its own write path - only clips
  // and MOTM votes are genuinely new here, so most of this list is derived,
  // not stored.
  const feedItems = useMemo(() => {
    const items: FeedItem[] = [];

    for (const c of clips) {
      items.push({ key: `clip-${c.id}`, ts: new Date(c.created_at).getTime(), kind: "clip", clip: c });
    }

    for (const g of games) {
      if (g.team_white_score == null || g.team_red_score == null) continue;
      items.push({
        key: `game-${g.id}-fulltime`,
        ts: new Date(kickoffCutoff(g.date, g.kickoff, 90)).getTime(),
        kind: "derived",
        icon: "⚽",
        tone: "blue",
        text: (
          <>
            Full time: <strong>{cs.team_white_name} {g.team_white_score}–{g.team_red_score} {cs.team_red_name}</strong>
          </>
        ),
      });

      if (!motmVotingOpen(g)) {
        const tally = motmTallyByGame[g.id] ?? {};
        const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        const winnerId = ranked[0]?.[0];
        const winner = winnerId ? g.bookings.find((b) => b.player_id === winnerId)?.player : undefined;
        if (winner) {
          items.push({
            key: `motm-${g.id}`,
            ts: new Date(kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES)).getTime(),
            kind: "derived",
            icon: "🏆",
            tone: "amber",
            text: (
              <>
                <strong>{winner.display_name}</strong> voted Man of the Match
              </>
            ),
          });
        }
      }
    }

    // Every £50 the pot's running total crosses, oldest to newest.
    const chron = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const e of chron) {
      const before = running;
      running += e.amount;
      for (let t = Math.floor(before / 50 + 1) * 50; t > before && t <= running; t += 50) {
        items.push({
          key: `pot-${t}`,
          ts: new Date(e.date + "T12:00:00").getTime(),
          kind: "derived",
          icon: "💰",
          tone: "green",
          text: (
            <>
              Community pot passed <strong>£{t}</strong>
            </>
          ),
        });
      }
    }

    for (const p of profiles) {
      if (!p.created_at) continue;
      items.push({
        key: `join-${p.id}`,
        ts: new Date(p.created_at).getTime(),
        kind: "derived",
        icon: "🎉",
        tone: "blue",
        text: (
          <>
            <strong>{p.display_name}</strong> joined the club
          </>
        ),
      });
    }

    // Every 5th appearance (5, 10, 15, 20...) - walked oldest to newest so
    // the running count per player is accurate.
    const chronPast = [...pastGames].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
    const appCounts: Record<string, number> = {};
    for (const g of chronPast) {
      for (const b of g.bookings.filter((bk) => !bk.waiting)) {
        appCounts[b.player_id] = (appCounts[b.player_id] ?? 0) + 1;
        const count = appCounts[b.player_id];
        if (count % 5 === 0) {
          items.push({
            key: `apps-${b.player_id}-${count}`,
            ts: new Date(kickoffCutoff(g.date, g.kickoff, 90)).getTime(),
            kind: "derived",
            icon: "🎖️",
            tone: "amber",
            text: (
              <>
                <strong>{b.player.display_name}</strong> hit {count} appearances!
              </>
            ),
          });
        }
      }
    }

    return items.sort((a, b) => b.ts - a.ts);
  }, [clips, games, pastGames, motmTallyByGame, potLedger, profiles, cs.team_white_name, cs.team_red_name, nowUk]);

  const visibleFeedItems = useMemo(() => {
    const kindMatch = feedItems.filter((item) => (feedView === "clips" ? item.kind === "clip" : item.kind === "derived"));
    if (feedView === "clips") return kindMatch;
    // In the normal feed view, archived items are hidden. The "Show
    // archived" toggle (admin-only) flips to showing *only* the archived
    // ones, so they can be reviewed and restored rather than lost.
    return kindMatch.filter((item) => showArchived === hiddenFeedKeys.includes(item.key));
  }, [feedItems, feedView, hiddenFeedKeys, showArchived]);

  const feedReactionTally = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const r of feedReactions) {
      map[r.item_key] ??= {};
      map[r.item_key][r.emoji] = (map[r.item_key][r.emoji] ?? 0) + 1;
    }
    return map;
  }, [feedReactions]);

  // Player of the Month: computed, not stored - whoever won MOTM the most
  // times in the last fully-completed calendar month, tie-broken by total
  // votes received that month. Needs at least 2 voted games that month to
  // mean anything, and only reveals once the month's over (not a mid-month
  // leaderboard that flips around), staying up for the whole next month.
  const playerOfMonth = useMemo(() => {
    const monthKey = previousMonthKey(nowUk);
    const monthGames = pastGames.filter(
      (g) => g.date.startsWith(monthKey) && g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g)
    );
    if (monthGames.length < 2) return null;

    const wins: Record<string, number> = {};
    const votes: Record<string, number> = {};
    const names: Record<string, string> = {};

    for (const g of monthGames) {
      const tally = motmTallyByGame[g.id] ?? {};
      const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const topCount = ranked[0]?.[1] ?? 0;
      for (const [playerId, count] of ranked) {
        votes[playerId] = (votes[playerId] ?? 0) + count;
        names[playerId] ??= g.bookings.find((b) => b.player_id === playerId)?.player.display_name ?? "";
        if (topCount > 0 && count === topCount) wins[playerId] = (wins[playerId] ?? 0) + 1;
      }
    }

    const contenders = Object.keys(wins);
    if (contenders.length === 0) return null;
    const maxWins = Math.max(...contenders.map((id) => wins[id]));
    let leaders = contenders.filter((id) => wins[id] === maxWins);
    if (leaders.length > 1) {
      const maxVotes = Math.max(...leaders.map((id) => votes[id] ?? 0));
      leaders = leaders.filter((id) => (votes[id] ?? 0) === maxVotes);
    }

    return {
      monthLabel: new Date(monthKey + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      names: leaders.map((id) => names[id]).filter(Boolean),
    };
  }, [pastGames, motmTallyByGame, nowUk]);

  const playerStats = useMemo(() => {
    const tally: Record<string, { name: string; apps: number; goals: number }> = {};
    const pastGameIds = new Set(pastGames.map((g) => g.id));
    pastGames.forEach((g) =>
      g.bookings
        .filter((b) => !b.waiting)
        .forEach((b) => {
          const cur = tally[b.player_id] ?? { name: b.player.display_name, apps: 0, goals: 0 };
          cur.apps += 1;
          tally[b.player_id] = cur;
        })
    );
    goalRows
      .filter((r) => pastGameIds.has(r.game_id))
      .forEach((r) => {
        const cur = tally[r.player_id] ?? { name: r.player.display_name, apps: 0, goals: 0 };
        cur.goals += r.goals;
        tally[r.player_id] = cur;
      });
    return Object.entries(tally)
      .map(([id, row]) => ({ id, ...row }))
      .sort((a, b) => b.apps - a.apps);
  }, [pastGames, goalRows]);

  const nextGame = upcomingGames[0];
  const nextConfirmed = useMemo(
    () => (nextGame ? nextGame.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [nextGame]
  );
  useEffect(() => setEditingLineup(false), [nextGame?.id]);
  useEffect(() => setSuggestedTeams(null), [nextGame?.id]);
  const nextGrouped = useMemo(
    () => ({
      white: nextConfirmed.filter((b) => b.team === "white"),
      red: nextConfirmed.filter((b) => b.team === "red"),
      unassigned: nextConfirmed.filter((b) => !b.team),
    }),
    [nextConfirmed]
  );

  // Admin rating wins if one exists; otherwise fall back to the player's
  // own self-rating; otherwise they're simply unrated.
  const ratingByPlayer = useMemo(() => {
    const map: Record<string, PlayerRating> = {};
    for (const r of selfRatings) map[r.player_id] = r;
    for (const r of adminRatings) map[r.player_id] = r;
    return map;
  }, [selfRatings, adminRatings]);

  // Standalone (not memoized) so the same math can score both the live
  // saved split and a not-yet-applied suggestion before committing to it.
  function teamStats(playerIds: string[]) {
    const ratings = playerIds.map((id) => ratingByPlayer[id]).filter((r): r is PlayerRating => !!r);
    const avg = (key: "fitness" | "attack" | "defence") =>
      ratings.length ? ratings.reduce((sum, r) => sum + r[key], 0) / ratings.length : 0;
    const positions: Record<PlayerPosition, number> = { keeper: 0, defence: 0, midfield: 0, attack: 0 };
    for (const r of ratings) positions[r.position]++;
    return { fitness: avg("fitness"), attack: avg("attack"), defence: avg("defence"), positions, rated: ratings.length, total: playerIds.length };
  }
  function fairnessFlags(white: ReturnType<typeof teamStats>, red: ReturnType<typeof teamStats>) {
    const flags: string[] = [];
    if (white.rated > 0 && red.rated > 0) {
      if (Math.abs(white.fitness - red.fitness) >= 1) flags.push("Noticeable fitness gap between the two teams");
      if (Math.abs(white.attack - red.attack) >= 1) flags.push("One team has significantly stronger attack");
      if (Math.abs(white.defence - red.defence) >= 1) flags.push("One team has significantly stronger defence");
    }
    if (Math.abs(white.positions.keeper - red.positions.keeper) >= 1) flags.push("Keepers aren't evenly split");
    for (const pos of ["defence", "midfield", "attack"] as PlayerPosition[]) {
      if (Math.abs(white.positions[pos] - red.positions[pos]) >= 2) {
        flags.push(`Uneven ${POSITION_LABEL[pos].toLowerCase()} split (${white.positions[pos]} vs ${red.positions[pos]})`);
      }
    }
    return flags;
  }

  const teamFairness = useMemo(() => {
    const white = teamStats(nextGrouped.white.map((b) => b.player_id));
    const red = teamStats(nextGrouped.red.map((b) => b.player_id));
    return { white, red, flags: fairnessFlags(white, red) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextGrouped, ratingByPlayer]);

  // Unrated players default to a neutral 3 rather than 0, so a handful of
  // unrated players don't get treated as "worst on the pitch" and all
  // dumped on one team - they just don't move the needle either way.
  // Keepers are alternated first since you basically always want exactly
  // one specialist per team; everyone else is sorted by ability and
  // greedily assigned to whichever team's running total is currently
  // lower (a simple, explainable balance heuristic, not a black-box
  // optimizer) with a size guard so squads don't end up lopsided.
  function generateBalancedTeams(): { white: string[]; red: string[] } {
    const players = nextConfirmed.map((b) => {
      const r = ratingByPlayer[b.player_id];
      return { id: b.player_id, overall: r ? (r.fitness + r.attack + r.defence) / 3 : 3, position: r?.position ?? null };
    });
    const keepers = players.filter((p) => p.position === "keeper").sort((a, b) => b.overall - a.overall);
    const others = players.filter((p) => p.position !== "keeper").sort((a, b) => b.overall - a.overall);

    const white: string[] = [];
    const red: string[] = [];
    let whiteTotal = 0;
    let redTotal = 0;

    keepers.forEach((k, i) => {
      if (i % 2 === 0) { white.push(k.id); whiteTotal += k.overall; }
      else { red.push(k.id); redTotal += k.overall; }
    });

    others.forEach((p) => {
      const sizeDiff = white.length - red.length;
      if (sizeDiff >= 2) { red.push(p.id); redTotal += p.overall; }
      else if (sizeDiff <= -2) { white.push(p.id); whiteTotal += p.overall; }
      else if (whiteTotal <= redTotal) { white.push(p.id); whiteTotal += p.overall; }
      else { red.push(p.id); redTotal += p.overall; }
    });

    return { white, red };
  }

  const overdueBookings = useMemo(() => {
    const rows: { booking: BookingRow; game: GameRow }[] = [];
    pastGames.forEach((g) => {
      g.bookings
        .filter((b) => !b.waiting && b.status !== "confirmed")
        .forEach((b) => rows.push({ booking: b, game: g }));
    });
    return rows.sort((a, b) => b.game.date.localeCompare(a.game.date));
  }, [pastGames]);

  const resultsMonths = useMemo(() => {
    const set = new Set<string>();
    pastGames.forEach((g) => set.add(g.date.slice(0, 7)));
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [pastGames]);

  const filteredResults = useMemo(
    () => (resultsMonth === "all" ? pastGames : pastGames.filter((g) => g.date.slice(0, 7) === resultsMonth)),
    [pastGames, resultsMonth]
  );

  const headToHead = useMemo(() => {
    const white = { played: 0, won: 0, drawn: 0, lost: 0, points: 0 };
    const red = { played: 0, won: 0, drawn: 0, lost: 0, points: 0 };
    pastGames.forEach((g) => {
      if (g.team_white_score == null || g.team_red_score == null) return;
      white.played++;
      red.played++;
      if (g.team_white_score > g.team_red_score) {
        white.won++; white.points += 3; red.lost++;
      } else if (g.team_white_score < g.team_red_score) {
        red.won++; red.points += 3; white.lost++;
      } else {
        white.drawn++; red.drawn++; white.points += 1; red.points += 1;
      }
    });
    return { white, red };
  }, [pastGames]);

  // Private per-player record - computed from the same past-games data as
  // headToHead above rather than stored anywhere, so it's always in sync
  // and (per the user's request) never has to be back-filled or migrated.
  // Only ever shown to the player themselves in Account.
  const myRecord = useMemo(() => {
    let played = 0, won = 0, drawn = 0, lost = 0;
    pastGames.forEach((g) => {
      if (g.team_white_score == null || g.team_red_score == null) return;
      const myBooking = g.bookings.find((b) => b.player_id === myId && !b.waiting);
      if (!myBooking || !myBooking.team) return;
      played++;
      const diff =
        myBooking.team === "white"
          ? g.team_white_score - g.team_red_score
          : g.team_red_score - g.team_white_score;
      if (diff > 0) won++;
      else if (diff < 0) lost++;
      else drawn++;
    });
    return { played, won, drawn, lost, winPct: played > 0 ? Math.round((won / played) * 100) : null };
  }, [pastGames, myId]);

  const TABS = [
    { k: "fixtures", label: "Fixtures", icon: Icon.cal },
    { k: "feed", label: "Feed", icon: Icon.pulse },
    { k: "lineup", label: "Line-up", icon: Icon.shirt },
    { k: "results", label: "Results", icon: Icon.trophy },
    ...(isAdmin ? [{ k: "admin", label: "Admin", icon: Icon.history } as const] : []),
  ] as const;

  const heading = {
    fixtures: "Upcoming fixtures",
    feed: "Club feed",
    lineup: "Next game line-up",
    results: "Results",
    account: "Your account",
    admin: "Payments & goals",
  }[tab];

  if (loading || !myProfile) {
    return (
      <div className="wcf-splash">
        <span className="wcf-logo big">
          <img src="/logo.png" alt="Wirral Community Football crest" />
        </span>
      </div>
    );
  }

  return (
    <>
      {toast && <div className={"wcf-toast " + toast.kind}>{toast.text}</div>}
      <header className="wcf-top">
        <div className="wcf-brand">
          <span className="wcf-logo">
            <img src="/logo.png" alt="Wirral Community Football crest" />
          </span>
          <div>
            <div className="wcf-wordmark">WIRRAL</div>
            <div className="wcf-wordmark-sub">COMMUNITY FOOTBALL</div>
          </div>
        </div>
        <button
          className={"wcf-role " + (isAdmin ? "admin" : "") + (tab === "account" ? " on" : "")}
          onClick={() => setTab(tab === "account" ? "fixtures" : "account")}
        >
          <span className="dot" />
          {myProfile.display_name}
        </button>
      </header>

      <main className="wcf-main">
        <div className="wcf-heading">
          <h2>{heading}</h2>
          {tab === "fixtures" && isAdmin && (
            <button className="wcf-addbtn" onClick={() => { if (confirm("Add a new fixture?")) addGame(); }}>+ Fixture</button>
          )}
        </div>

        {tab === "fixtures" && (
          <>
            {showPushNudge && (
              <div className="wcf-nudge-banner">
                <div>
                  <strong>🔔 Turn on notifications</strong>
                  <p>Get kickoff reminders, payment nudges and spot alerts — never miss a game.</p>
                </div>
                <div className="wcf-nudge-actions">
                  <button onClick={async () => { if (await enablePush()) dismissPushNudge(); }}>Enable</button>
                  <button className="wcf-ghost" onClick={dismissPushNudge}>Not now</button>
                </div>
              </div>
            )}
            {showRatingNudge && (
              <div className="wcf-nudge-banner">
                <div>
                  <strong>⭐ Rate yourself</strong>
                  <p>Helps admins put together fairer teams — takes 30 seconds.</p>
                </div>
                <div className="wcf-nudge-actions">
                  <button onClick={() => setTab("account")}>Rate now</button>
                  <button className="wcf-ghost" onClick={dismissRatingNudge}>Not now</button>
                </div>
              </div>
            )}
            {iAmOverdue && (
              <div className="wcf-overdue-banner">
                <strong>Overdue payment</strong> — you still owe for{" "}
                {myOverdueBookings.map((o, i) => (
                  <span key={o.booking.id}>
                    {i > 0 ? ", " : ""}
                    {o.game.venue} ({fmtDate(o.game.date)})
                  </span>
                ))}
                . Speak to an admin to confirm you&apos;ve paid before booking your next game.
              </div>
            )}
            {upcomingGames.length === 0 && <p className="wcf-empty">No games on. {isAdmin ? "Add one above." : "Check back soon."}</p>}
            {upcomingGames.map((g) => (
              <GameCard
                key={g.id}
                game={g}
                myId={myId}
                isAdmin={isAdmin}
                overdue={iAmOverdue}
                editing={editingId === g.id}
                onBook={() => book(g.id)}
                onCancel={(bookingId) => cancel(bookingId)}
                onMarkPaid={(bookingId) => markPaid(bookingId)}
                onEdit={() => setEditingId(editingId === g.id ? null : g.id)}
                onSave={(patch) => saveGame(g.id, patch)}
                onDelete={() => deleteGame(g.id)}
              />
            ))}
          </>
        )}

        {tab === "admin" && isAdmin && (
          <AdminConsole
            upcoming={upcomingGames}
            previous={pastGames}
            overdue={overdueBookings}
            goalRows={goalRows}
            cs={cs}
            profiles={profiles}
            expandedId={expandedGameId}
            onToggleExpand={(id) => setExpandedGameId(expandedGameId === id ? null : id)}
            onSetStatus={setBookingStatus}
            onRemoveBooking={cancel}
            onDeleteGame={deleteGame}
            onSaveResult={saveResult}
            onAddBooking={addBooking}
          />
        )}

        {tab === "feed" && (
          <>
            <div className="wcf-subtabs">
              <button className={feedView === "feed" ? "active" : ""} onClick={() => setFeedView("feed")}>Feed</button>
              <button className={feedView === "clips" ? "active" : ""} onClick={() => setFeedView("clips")}>Clips</button>
            </div>

            {feedView === "clips" && (
              <form className="wcf-clip-form" onSubmit={addClip}>
                <input placeholder="Clip title" value={clipTitle} onChange={(e) => setClipTitle(e.target.value)} />
                <input placeholder="YouTube link (optional)" value={clipUrl} onChange={(e) => setClipUrl(e.target.value)} />
                <button type="submit" disabled={!clipTitle.trim()}>Share clip</button>
              </form>
            )}

            {feedView === "feed" && isAdmin && (
              <button className="wcf-ghost wcf-archive-toggle" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Back to feed" : `Show archived${hiddenFeedKeys.length ? ` (${hiddenFeedKeys.length})` : ""}`}
              </button>
            )}

            {visibleFeedItems.length === 0 && (
              <p className="wcf-empty">
                {feedView === "clips"
                  ? "No clips yet — share the first one!"
                  : showArchived
                  ? "Nothing archived."
                  : "Nothing yet — check back after the first game."}
              </p>
            )}
            {visibleFeedItems.map((item) => {
              const tally = feedReactionTally[item.key] ?? {};
              const reactionRow = (
                <div className="wcf-feed-reactions">
                  {FEED_REACTION_EMOJI.map((emoji) => {
                    const count = tally[emoji] ?? 0;
                    const mine = feedReactions.some((r) => r.item_key === item.key && r.emoji === emoji && r.user_id === myId);
                    return (
                      <button
                        key={emoji}
                        className={"wcf-feed-reaction" + (mine ? " mine" : "")}
                        onClick={() => toggleReaction(item.key, emoji)}
                      >
                        {emoji} {count > 0 ? count : ""}
                      </button>
                    );
                  })}
                </div>
              );

              if (item.kind === "clip") {
                const c = item.clip;
                return (
                  <article key={item.key} className="wcf-clip">
                    {c.video_url ? (
                      <a className="wcf-clip-thumb" href={c.video_url} target="_blank" rel="noreferrer">
                        <span>▶</span>
                      </a>
                    ) : (
                      <div className="wcf-clip-thumb">
                        <span>▶</span>
                      </div>
                    )}
                    <div className="wcf-clip-body">
                      <div className="wcf-clip-title">{c.title}</div>
                      <div className="wcf-clip-sub">shared by {c.submitter?.display_name ?? "someone"} · {fmtFeedDate(item.ts)}</div>
                      {reactionRow}
                    </div>
                    {(c.submitted_by === myId || isAdmin) && (
                      <button
                        className="wcf-clip-del"
                        onClick={() => { if (confirm(`Delete "${c.title}"?`)) deleteClip(c.id); }}
                        aria-label="Delete clip"
                      >
                        ×
                      </button>
                    )}
                  </article>
                );
              }

              const isHidden = hiddenFeedKeys.includes(item.key);
              return (
                <article key={item.key} className="wcf-feed-item">
                  <div className={"wcf-feed-icon " + item.tone}>{item.icon}</div>
                  <div className="wcf-feed-body">
                    <div className="wcf-feed-text">{item.text}</div>
                    <div className="wcf-feed-date">{fmtFeedDate(item.ts)}</div>
                    {reactionRow}
                    {isAdmin && (
                      <button
                        className="wcf-feed-archive-btn"
                        onClick={() => {
                          if (isHidden) return unhideFeedItem(item.key);
                          if (confirm("Archive this from the feed? You can restore it later from \"Show archived\".")) hideFeedItem(item.key);
                        }}
                      >
                        {isHidden ? "↺ Restore" : "Archive"}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </>
        )}

        {tab === "lineup" && (
          <>
            {isAdmin && (
              <div className="wcf-subtabs">
                <button className={lineupView === "sheet" ? "active" : ""} onClick={() => setLineupView("sheet")}>Team Sheet</button>
                <button className={lineupView === "fairness" ? "active" : ""} onClick={() => setLineupView("fairness")}>Fairness</button>
              </div>
            )}

            {lineupView === "fairness" && isAdmin && (
              <>
                {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}

                {nextGame && nextConfirmed.length > 0 && (
                  <>
                    {!suggestedTeams ? (
                      <button className="wcf-generate-teams" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                        🔀 Generate recommended teams
                      </button>
                    ) : (
                      <div className="wcf-suggestion-actions">
                        <button className="wcf-generate-teams" onClick={() => setSuggestedTeams(generateBalancedTeams())}>↻ Regenerate</button>
                        <button className="wcf-ghost" onClick={() => setSuggestedTeams(null)}>Discard</button>
                        <button className="wcf-apply-teams" onClick={applySuggestedTeams}>Apply this split</button>
                      </div>
                    )}
                    {suggestedTeams && (
                      <p className="wcf-suggestion-note">
                        Preview only — nothing's saved until you tap "Apply this split", and you can still hand-tweak anyone in Team Sheet afterward.
                      </p>
                    )}
                  </>
                )}

                {nextGame && !suggestedTeams && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && nextConfirmed.length === 0 && (
                  <p className="wcf-empty">No one&apos;s booked in yet.</p>
                )}
                {nextGame && !suggestedTeams && nextConfirmed.length > 0 && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && (
                  <p className="wcf-empty">No one&apos;s assigned to Whites/Reds yet — generate a suggestion above, or assign manually in Team Sheet.</p>
                )}

                {nextGame && (() => {
                  const previewWhiteIds = suggestedTeams?.white ?? nextGrouped.white.map((b) => b.player_id);
                  const previewRedIds = suggestedTeams?.red ?? nextGrouped.red.map((b) => b.player_id);
                  if (previewWhiteIds.length === 0 && previewRedIds.length === 0) return null;
                  const white = teamStats(previewWhiteIds);
                  const red = teamStats(previewRedIds);
                  const flags = fairnessFlags(white, red);
                  const namesFor = (ids: string[]) => ids.map((id) => nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?");
                  return (
                    <>
                      <div className="wcf-fairness-teams">
                        {([["white", white, previewWhiteIds, cs.team_white_name, cs.team_white_color], ["red", red, previewRedIds, cs.team_red_name, cs.team_red_color]] as const).map(
                          ([key, stats, ids, name, color]) => (
                            <div key={key} className="wcf-fairness-card">
                              <div className="wcf-fairness-card-head" style={{ color }}>{name}</div>
                              {suggestedTeams && (
                                <div className="wcf-fairness-preview-names">{namesFor(ids).join(", ")}</div>
                              )}
                              {(["fitness", "attack", "defence"] as const).map((metric) => (
                                <div key={metric} className="wcf-fairness-metric">
                                  <div className="wcf-fairness-metric-top">
                                    <span>{metric[0].toUpperCase()}{metric.slice(1)}</span>
                                    <span>{stats.rated ? stats[metric].toFixed(1) : "—"}</span>
                                  </div>
                                  <div className="wcf-fairness-track">
                                    <div className="wcf-fairness-fill" style={{ width: `${(stats[metric] / 5) * 100}%`, background: color ?? undefined }} />
                                  </div>
                                </div>
                              ))}
                              <div className="wcf-fairness-positions">
                                {POSITIONS.map((p) => (
                                  <span key={p} className="wcf-fairness-pos-tag">{POSITION_LABEL[p]} · {stats.positions[p]}</span>
                                ))}
                              </div>
                              <div className="wcf-fairness-rated-note">{stats.rated} of {stats.total} rated</div>
                            </div>
                          )
                        )}
                      </div>

                      {flags.length === 0 ? (
                        <p className="wcf-fairness-ok">✅ No notable imbalances found.</p>
                      ) : (
                        <div className="wcf-fairness-flags">
                          {flags.map((f) => (
                            <div key={f} className="wcf-fairness-flag">⚠️ {f}</div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}

            {lineupView === "sheet" && (
              <>
            {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}
            {nextGame && (
              <>
                <div className="wcf-lineup-head">
                  <div>
                    <div className="wcf-venue">{nextGame.venue}</div>
                    <div className="wcf-pitch">{fmtDate(nextGame.date)} · {nextGame.kickoff}</div>
                  </div>
                  {isAdmin && (
                    <button className="wcf-ghost" onClick={() => setEditingLineup((v) => !v)}>
                      {editingLineup ? "Lock in" : "Edit line-up"}
                    </button>
                  )}
                </div>
                {nextConfirmed.length === 0 && <p className="wcf-empty">No one&apos;s booked in yet.</p>}

                {isAdmin && editingLineup ? (
                  nextConfirmed.map((b) => (
                    <div key={b.id} className={"wcf-lineup-row" + (b.player_id === myId ? " me-edit" : "")}>
                      <span className="wcf-lineup-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                      <div className="wcf-lineup-picks">
                        <button
                          style={b.team === "white" ? { background: cs.team_white_color, color: readableTextColor(cs.team_white_color), borderColor: cs.team_white_color } : undefined}
                          className="wcf-lineup-pick"
                          onClick={() => setTeam(b.id, b.team === "white" ? null : "white")}
                        >
                          {cs.team_white_name}
                        </button>
                        <button
                          style={b.team === "red" ? { background: cs.team_red_color, color: readableTextColor(cs.team_red_color), borderColor: cs.team_red_color } : undefined}
                          className="wcf-lineup-pick"
                          onClick={() => setTeam(b.id, b.team === "red" ? null : "red")}
                        >
                          {cs.team_red_name}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  ([["white", nextGrouped.white, cs.team_white_name, cs.team_white_color], ["red", nextGrouped.red, cs.team_red_name, cs.team_red_color], ["unassigned", nextGrouped.unassigned, "Unassigned", null]] as const).map(
                    ([key, group, name, color]) =>
                      group.length > 0 && (
                        <div key={key} className="wcf-lineup-group">
                          <div className="wcf-lineup-group-label">{name} · {group.length}</div>
                          {group.map((b) => (
                            <div
                              key={b.id}
                              className={"wcf-lineup-row" + (b.player_id === myId ? " me" : "")}
                              style={b.player_id === myId && color ? { boxShadow: `0 0 0 1px ${color}, 0 0 14px ${color}99` } : undefined}
                            >
                              <span className="wcf-lineup-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                              {color && (
                                <span className="wcf-lineup-badge" style={{ background: color, color: readableTextColor(color) }}>
                                  {name}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                  )
                )}
              </>
            )}
              </>
            )}
          </>
        )}

        {tab === "results" && (
          <>
            <div className="wcf-subtabs">
              <button className={resultsView === "season" ? "active" : ""} onClick={() => setResultsView("season")}>Season</button>
              <button className={resultsView === "table" ? "active" : ""} onClick={() => setResultsView("table")}>Stats</button>
              <button className={resultsView === "fixtures" ? "active" : ""} onClick={() => setResultsView("fixtures")}>Scores</button>
              <button className={resultsView === "pot" ? "active" : ""} onClick={() => setResultsView("pot")}>Pot</button>
              {isAdmin && (
                <button className={resultsView === "finances" ? "active" : ""} onClick={() => setResultsView("finances")}>Finances</button>
              )}
            </div>

            {resultsView === "season" && (
              <>
                {playerOfMonth && (
                  <div className="wcf-shoutout wcf-potm">
                    🏅 Player of the Month — {playerOfMonth.monthLabel}: <strong>{playerOfMonth.names.join(" & ")}</strong>
                  </div>
                )}
                {awards.map((a) => (
                  <div key={a.id} className="wcf-shoutout">
                    {a.title} — <strong>{a.value}</strong>
                    {a.note ? ` · ${a.note}` : ""}
                  </div>
                ))}

                {(headToHead.white.played > 0 || headToHead.red.played > 0) && (
                  <div className="wcf-h2h">
                    <div className="wcf-h2h-title">{cs.team_white_name} v {cs.team_red_name}</div>
                    <div className="wcf-h2h-row wcf-h2h-header">
                      <span>Team</span><span>P</span><span>W</span><span>D</span><span>L</span><span>Pts</span>
                    </div>
                    {([["white", headToHead.white, cs.team_white_name, cs.team_white_color], ["red", headToHead.red, cs.team_red_name, cs.team_red_color]] as const)
                      .slice()
                      .sort((a, b) => b[1].points - a[1].points)
                      .map(([key, row, name, color]) => (
                        <div key={key} className="wcf-h2h-row">
                          <span className="wcf-h2h-team"><span className="wcf-h2h-dot" style={{ background: color }} />{name}</span>
                          <span>{row.played}</span><span>{row.won}</span><span>{row.drawn}</span><span>{row.lost}</span>
                          <span className="wcf-h2h-pts">{row.points}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </>
            )}

            {resultsView === "table" && (
              <div className="wcf-board">
                <p className="wcf-board-note">Confirmed spots across upcoming fixtures, plus goals logged by admins. Sorted by appearances.</p>
                <div className="wcf-board-row wcf-board-header">
                  <span className="wcf-rank" />
                  <span className="wcf-board-name">Player</span>
                  <span className="wcf-board-count">Apps</span>
                  <span className="wcf-board-count">Goals</span>
                </div>
                {playerStats.map((row, i) => (
                  <div key={row.id} className={"wcf-board-row " + (i === 0 ? "lead " : "") + (row.id === myId ? "me" : "")}>
                    <span className="wcf-rank">{i === 0 ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                    <span className="wcf-board-name">
                      {row.name}{row.id === myId ? " (you)" : ""}
                      {row.apps >= 5 && <span className="wcf-apps-badge">🎖️ {Math.floor(row.apps / 5) * 5}</span>}
                    </span>
                    <span className="wcf-board-count">{row.apps}</span>
                    <span className="wcf-board-count">{row.goals || "—"}</span>
                  </div>
                ))}
              </div>
            )}

            {resultsView === "fixtures" && (
              <>
                <select className="wcf-month-filter" value={resultsMonth} onChange={(e) => setResultsMonth(e.target.value)}>
                  <option value="all">All results</option>
                  {resultsMonths.map((m) => (
                    <option key={m} value={m}>
                      {new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
                    </option>
                  ))}
                </select>

                {filteredResults.length === 0 && <p className="wcf-empty">No results yet.</p>}
                {filteredResults.map((g) => {
                  const scorers = goalRows.filter((r) => r.game_id === g.id && r.goals > 0).sort((a, b) => b.goals - a.goals);
                  const hasScore = g.team_white_score != null && g.team_red_score != null;
                  // Who actually played, not who's been payment-confirmed -
                  // those often lag behind by days, and voting closes hours
                  // after kickoff.
                  const candidates = g.bookings.filter((b) => !b.waiting);
                  const votingOpen = motmVotingOpen(g);
                  const tally = motmTallyByGame[g.id] ?? {};
                  const totalVotes = Object.values(tally).reduce((sum, n) => sum + n, 0);
                  const myVote = myMotmVoteByGame[g.id];
                  const ranked = candidates
                    .map((c) => ({ candidate: c, votes: tally[c.player_id] ?? 0 }))
                    .sort((a, b) => b.votes - a.votes);
                  const topVotes = ranked[0]?.votes ?? 0;
                  return (
                    <article key={g.id} className="wcf-result">
                      <div className="wcf-result-head">
                        <div>
                          <div className="wcf-venue">{g.venue}</div>
                          <div className="wcf-pitch">{fmtDate(g.date)}</div>
                        </div>
                        {hasScore && (
                          <div className="wcf-result-score">
                            <span style={{ color: cs.team_white_color }}>{g.team_white_score}</span>
                            <span className="wcf-result-dash">–</span>
                            <span style={{ color: cs.team_red_color }}>{g.team_red_score}</span>
                          </div>
                        )}
                      </div>
                      {scorers.length > 0 && (
                        <div className="wcf-result-scorers">
                          {scorers.map((s) => (
                            <span key={s.id} className="wcf-result-scorer">{s.player.display_name} {s.goals > 1 ? `×${s.goals}` : ""}</span>
                          ))}
                        </div>
                      )}

                      {hasScore && candidates.length > 0 && votingOpen && (
                        <div className="wcf-motm">
                          <div className="wcf-motm-label">Vote Man of the Match · results hidden until voting closes</div>
                          <div className="wcf-motm-candidates">
                            {candidates.map((c) => (
                              <button
                                key={c.id}
                                className={"wcf-motm-vote" + (myVote === c.player_id ? " voted" : "")}
                                onClick={() => castMotmVote(g.id, c.player_id)}
                              >
                                {c.player.display_name}{myVote === c.player_id ? " ✓" : ""}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {hasScore && !votingOpen && totalVotes > 0 && (
                        <div className="wcf-motm wcf-motm-closed">
                          <div className="wcf-motm-winner">
                            🏆 Man of the Match — <strong>{ranked[0].candidate.player.display_name}</strong>
                          </div>
                          {ranked.filter((r) => r.votes > 0).map((r) => (
                            <div key={r.candidate.id} className="wcf-motm-bar-row">
                              <div className="wcf-motm-bar-top">
                                <span className={r.votes === topVotes ? "winner" : ""}>{r.candidate.player.display_name}</span>
                                <span className="wcf-motm-count">{r.votes}</span>
                              </div>
                              <div className="wcf-motm-bar-track">
                                <div
                                  className={"wcf-motm-bar-fill" + (r.votes === topVotes ? " winner" : "")}
                                  style={{ width: `${Math.max(6, (r.votes / topVotes) * 100)}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </>
            )}

            {resultsView === "pot" && (
              <>
                <div className="wcf-pot-total">
                  <div className="wcf-pot-total-label">Community pot</div>
                  <div className={"wcf-pot-total-amount" + (potTotal < 0 ? " negative" : "")}>
                    {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                  </div>
                  <p className="wcf-pot-total-note">
                    Built up from game surpluses (match fees vs pitch hire) plus socials, sponsorship and other contributions.
                    Goes towards equipment, socials and running the club.
                  </p>
                </div>

                {isAdmin && (
                  <>
                    <form
                      className="wcf-pot-add"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const magnitude = Math.abs(Number(potAmount));
                        if (!magnitude || !potDescription.trim()) return;
                        const amount = potEntryKind === "deduct" ? -magnitude : magnitude;
                        setAddingPotEntry(true);
                        await addPotEntry(amount, potDescription.trim(), potCategory);
                        setAddingPotEntry(false);
                        setPotAmount("");
                        setPotDescription("");
                        setPotEntryKind("add");
                        setPotCategory("other");
                      }}
                    >
                      <div className="wcf-pot-kind-toggle">
                        <button
                          type="button"
                          className={potEntryKind === "add" ? "active" : ""}
                          onClick={() => setPotEntryKind("add")}
                        >
                          + Add money
                        </button>
                        <button
                          type="button"
                          className={potEntryKind === "deduct" ? "active deduct" : ""}
                          onClick={() => setPotEntryKind("deduct")}
                        >
                          − Deduct money
                        </button>
                      </div>
                      <select value={potCategory} onChange={(e) => setPotCategory(e.target.value as PotCategory)}>
                        {(Object.keys(POT_CATEGORY_LABEL) as PotCategory[]).map((c) => (
                          <option key={c} value={c}>{POT_CATEGORY_LABEL[c]}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount, e.g. 20"
                        value={potAmount}
                        onChange={(e) => setPotAmount(e.target.value)}
                      />
                      <input
                        placeholder="e.g. Summer BBQ, new bibs, sponsorship"
                        value={potDescription}
                        onChange={(e) => setPotDescription(e.target.value)}
                      />
                      <button
                        type="submit"
                        className={potEntryKind === "deduct" ? "wcf-pot-submit deduct" : "wcf-pot-submit"}
                        disabled={addingPotEntry || !potAmount || !potDescription.trim()}
                      >
                        {addingPotEntry
                          ? "Saving…"
                          : potEntryKind === "deduct"
                          ? "Deduct from pot"
                          : "Add to pot"}
                      </button>
                    </form>

                    {potLedger.length === 0 && <p className="wcf-empty">Nothing in the ledger yet.</p>}
                    {potLedger.map((entry) => (
                      <div key={entry.id} className="wcf-pot-row">
                        <div>
                          <div className="wcf-pot-row-desc">{entry.description}</div>
                          <div className="wcf-pitch">
                            {fmtDate(entry.date)}{entry.kind === "auto" ? " · auto" : ""}
                            <span className="wcf-pot-cat-tag">{POT_CATEGORY_LABEL[entry.category]}</span>
                          </div>
                        </div>
                        <span className={"wcf-pot-row-amount " + (entry.amount < 0 ? "neg" : "pos")}>
                          {entry.amount < 0 ? "−" : "+"}£{Math.abs(entry.amount).toFixed(2)}
                        </span>
                        {entry.kind === "manual" && (
                          <button
                            className="wcf-admin-remove"
                            onClick={() => { if (confirm("Remove this pot entry?")) deletePotEntry(entry.id); }}
                            aria-label="Remove entry"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            {resultsView === "finances" && isAdmin && (
              <>
                <div className="wcf-fin-stats">
                  <div className="wcf-fin-tile">
                    <div className="wcf-fin-tile-label">Income</div>
                    <div className="wcf-fin-tile-value green">£{financeSummary.income.toFixed(2)}</div>
                  </div>
                  <div className="wcf-fin-tile">
                    <div className="wcf-fin-tile-label">Expenses</div>
                    <div className="wcf-fin-tile-value red">£{financeSummary.expenses.toFixed(2)}</div>
                  </div>
                  <div className="wcf-fin-tile">
                    <div className="wcf-fin-tile-label">Net</div>
                    <div className={"wcf-fin-tile-value " + (potTotal < 0 ? "red" : "green")}>
                      {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                    </div>
                  </div>
                </div>

                {financeSummary.balancePoints.length > 0 && (
                  <div className="wcf-fin-card">
                    <div className="wcf-fin-card-head">Balance over time</div>
                    <div className="wcf-fin-chart">
                      {financeSummary.balancePoints.slice(-8).map((p, i) => {
                        const maxAbs = Math.max(1, ...financeSummary.balancePoints.slice(-8).map((q) => Math.abs(q.balance)));
                        const height = (Math.abs(p.balance) / maxAbs) * 100;
                        return (
                          <div key={i} className="wcf-fin-bar-col">
                            <div className={"wcf-fin-bar" + (p.balance < 0 ? " neg" : "")} style={{ height: `${height}%` }} />
                            <div className="wcf-fin-bar-label">{fmtDate(p.date).slice(0, 6)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="wcf-fin-card">
                  <div className="wcf-fin-card-head">By fixture</div>
                  {financeSummary.byFixture.length === 0 && <p className="wcf-empty small">No fixtures with confirmed payments yet.</p>}
                  {financeSummary.byFixture.map((e) => (
                    <div key={e.id} className="wcf-fin-fx-row">
                      <div>
                        <div className="wcf-fin-fx-desc">{e.description.split(" — ")[0]}</div>
                        <div className="wcf-pitch">{fmtDate(e.date)}</div>
                      </div>
                      <span className={"wcf-fin-fx-net " + (e.amount < 0 ? "red" : "green")}>
                        {e.amount < 0 ? "−" : "+"}£{Math.abs(e.amount).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="wcf-fin-card">
                  <div className="wcf-fin-card-head">Where it's gone</div>
                  {(() => {
                    const totalSpend = Object.values(financeSummary.byCategory).reduce((s, v) => s + v, 0);
                    const cats = (Object.keys(financeSummary.byCategory) as PotCategory[]).filter((c) => financeSummary.byCategory[c] > 0);
                    if (cats.length === 0) return <p className="wcf-empty small">Nothing spent yet.</p>;
                    return cats
                      .sort((a, b) => financeSummary.byCategory[b] - financeSummary.byCategory[a])
                      .map((c) => {
                        const amt = financeSummary.byCategory[c];
                        const pct = totalSpend > 0 ? (amt / totalSpend) * 100 : 0;
                        return (
                          <div key={c} className="wcf-fin-cat-row">
                            <div className="wcf-fin-cat-top">
                              <span>{POT_CATEGORY_LABEL[c]}</span>
                              <span>£{amt.toFixed(2)} · {pct.toFixed(0)}%</span>
                            </div>
                            <div className="wcf-fin-cat-track">
                              <div className="wcf-fin-cat-fill" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      });
                  })()}
                </div>

                <button className="wcf-ghost wcf-fin-export" onClick={exportFinanceCsv}>⬇ Export season as CSV</button>
              </>
            )}
          </>
        )}

        {tab === "account" && (
          <AccountPanel
            profile={myProfile}
            email={session.user.email ?? ""}
            isAdmin={isAdmin}
            isOwner={isOwner}
            profiles={profiles}
            clubSettings={cs}
            awards={awards}
            onRename={renameSelf}
            onSetRole={setRole}
            onDeleteProfile={deleteProfile}
            onAddPlayer={addPlayer}
            onGenerateLoginCode={generateLoginCode}
            onSaveClubSettings={saveClubSettings}
            onAddAward={addAward}
            onDeleteAward={deleteAward}
            onSignOut={signOut}
            onEnablePush={enablePush}
            onDisablePush={disablePush}
            onSendTestPush={sendTestPush}
            pushStats={pushStats}
            auditLog={auditLog}
            showAuditLog={showAuditLog}
            onToggleAuditLog={toggleAuditLog}
            myRating={myRating}
            onSaveSelfRating={saveSelfRating}
            adminRatings={adminRatings}
            onSaveAdminRating={saveAdminRating}
            ratingPlayerId={ratingPlayerId}
            onToggleRatingPlayer={(id) => setRatingPlayerId((cur) => (cur === id ? null : id))}
            myRecord={myRecord}
          />
        )}
      </main>

      <nav className="wcf-nav">
        {TABS.map((t) => (
          <button key={t.k} className={"wcf-navbtn " + (tab === t.k ? "active" : "")} onClick={() => setTab(t.k)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

const ROLE_LABEL: Record<Role, string> = { player: "Player", admin: "Admin", "co-owner": "Co-Owner", owner: "Owner" };

function AccountPanel({
  profile,
  email,
  isAdmin,
  isOwner,
  profiles,
  clubSettings,
  awards,
  onRename,
  onSetRole,
  onDeleteProfile,
  onAddPlayer,
  onGenerateLoginCode,
  onSaveClubSettings,
  onAddAward,
  onDeleteAward,
  onSignOut,
  onEnablePush,
  onDisablePush,
  onSendTestPush,
  pushStats,
  auditLog,
  showAuditLog,
  onToggleAuditLog,
  myRating,
  onSaveSelfRating,
  adminRatings,
  onSaveAdminRating,
  ratingPlayerId,
  onToggleRatingPlayer,
  myRecord,
}: {
  profile: Profile;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  profiles: Profile[];
  myRecord: { played: number; won: number; drawn: number; lost: number; winPct: number | null };
  auditLog: AuditLogEntry[];
  showAuditLog: boolean;
  onToggleAuditLog: () => void;
  myRating: PlayerRating | null;
  onSaveSelfRating: (fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  adminRatings: PlayerRating[];
  onSaveAdminRating: (playerId: string, fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  ratingPlayerId: string | null;
  onToggleRatingPlayer: (id: string) => void;
  clubSettings: ClubSettings;
  pushStats: { total: number; subscribed: number } | null;
  awards: AwardRow[];
  onRename: (name: string) => void;
  onSetRole: (id: string, role: Role) => void;
  onDeleteProfile: (id: string, name: string) => void;
  onAddPlayer: (email: string, displayName: string) => Promise<boolean>;
  onGenerateLoginCode: (email: string) => Promise<string | null>;
  onSaveClubSettings: (patch: Partial<ClubSettings>) => void;
  onAddAward: (title: string, value: string, note: string) => Promise<void>;
  onDeleteAward: (id: string) => void;
  onSignOut: () => void;
  onEnablePush: () => Promise<boolean>;
  onDisablePush: () => Promise<void>;
  onSendTestPush: () => Promise<void>;
}) {
  const [name, setName] = useState(profile.display_name);
  const [showRoles, setShowRoles] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [openGuide, setOpenGuide] = useState<"install" | "notifications" | null>(null);
  // push_opt_in is a shared per-user DB flag, but permission is granted
  // per-device/per-browser - deriving "on" from both means a fresh device
  // (or one where permission was never actually granted) correctly shows
  // "Off" instead of a stale "On" that doesn't reflect reality here.
  const pushGranted = typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted";
  const pushOn = !!profile.push_opt_in && pushGranted;

  useEffect(() => setName(profile.display_name), [profile.display_name]);

  return (
    <div className="wcf-account">
      <div className="wcf-account-card">
        <span className="wcf-avatar big">{profile.display_name[0]?.toUpperCase()}</span>
        <div>
          <div className="wcf-account-name">{profile.display_name}</div>
          <div className="wcf-account-email">{email}</div>
        </div>
        <span className={"wcf-role-badge " + profile.role}>{ROLE_LABEL[profile.role]}</span>
      </div>

      <label className="wcf-account-field">
        Display name
        <div className="wcf-account-rename">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button
            onClick={() => {
              if (confirm(`Change your display name to "${name.trim()}"?`)) onRename(name);
            }}
            disabled={!name.trim() || name.trim() === profile.display_name}
          >
            Save
          </button>
        </div>
      </label>

      <div className="wcf-rating-section">
        <h3>Rate yourself</h3>
        <p className="wcf-rating-note">
          Helps admins put together fair teams. Only visible to you and admins — once an admin rates you, theirs takes over.
        </p>
        <RatingForm initial={myRating} onSave={onSaveSelfRating} saveLabel={myRating ? "Update my rating" : "Save my rating"} />
      </div>

      <div className="wcf-record-section">
        <h3>My record</h3>
        <p className="wcf-rating-note">Only visible to you — worked out from every past game you had a spot in.</p>
        {myRecord.played === 0 ? (
          <p className="wcf-record-empty">No results yet — this fills in once you've played a game.</p>
        ) : (
          <>
            <div className="wcf-record-pct">{myRecord.winPct}%<span>win rate</span></div>
            <div className="wcf-record-row">
              <div><strong>{myRecord.played}</strong><span>Played</span></div>
              <div><strong>{myRecord.won}</strong><span>Won</span></div>
              <div><strong>{myRecord.drawn}</strong><span>Drawn</span></div>
              <div><strong>{myRecord.lost}</strong><span>Lost</span></div>
            </div>
          </>
        )}
      </div>

      <div className="wcf-push-section">
        <div className="wcf-push-row">
          <div>
            <div className="wcf-push-label">Game-day notifications</div>
            <div className="wcf-push-sub">Kickoff reminders, payment nudges, spots opening up</div>
          </div>
          <button
            className={"wcf-push-toggle " + (pushOn ? "on" : "")}
            disabled={pushBusy}
            onClick={async () => {
              setPushBusy(true);
              if (pushOn) await onDisablePush();
              else await onEnablePush();
              setPushBusy(false);
            }}
          >
            {pushBusy ? "…" : pushOn ? "On" : "Off"}
          </button>
        </div>
        {pushOn && (
          <button className="wcf-ghost wcf-push-test" onClick={onSendTestPush}>
            Send me a test push
          </button>
        )}
        {!pushOn && (
          <p className="wcf-push-note">
            Note: the app must be added to your Home Screen for notifications to work — see &quot;Add to your home screen&quot; below if you haven&apos;t yet.
          </p>
        )}
      </div>

      <div className="wcf-guides">
        <h3>Getting set up</h3>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("install")}>
          <span>📱 Add to your home screen</span>
          <span className="wcf-guide-arrow">›</span>
        </button>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("notifications")}>
          <span>🔔 Enable notifications</span>
          <span className="wcf-guide-arrow">›</span>
        </button>
      </div>

      {openGuide && (
        <div className="wcf-lightbox" onClick={() => setOpenGuide(null)}>
          <button className="wcf-lightbox-close" onClick={() => setOpenGuide(null)} aria-label="Close">×</button>
          <img
            className="wcf-lightbox-img"
            src={openGuide === "install" ? "/Install_Guide.png" : "/Notifications_Guide.png"}
            alt={openGuide === "install" ? "How to add the app to your home screen" : "How to enable push notifications"}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <button className="wcf-signout" onClick={onSignOut}>Sign out</button>

      {isAdmin && pushStats && (
        <div className="wcf-push-stat">
          🔔 {pushStats.subscribed} of {pushStats.total} players have notifications on
        </div>
      )}

      {isAdmin && <AddPlayerForm onAdd={onAddPlayer} />}
      {isAdmin && <LoginCodeForm onGenerate={onGenerateLoginCode} />}

      {isAdmin && (
        <div className="wcf-roles">
          <h3>Manage roles · {profiles.length}</h3>
          <button className="wcf-ghost wcf-roles-toggle" onClick={() => setShowRoles((v) => !v)}>
            {showRoles ? "Hide players" : "View players"}
          </button>
          {showRoles && profiles.map((p) => {
            const isSelf = p.id === profile.id;
            // Owner rows are fully protected in the UI (SQL Editor only).
            // Co-owner rows can only be touched by the owner. Admins/
            // co-owners can promote a player, but only the owner can
            // touch an existing admin or co-owner's role.
            const canDelete =
              p.role === "player" ? !isSelf : (p.role === "admin" || p.role === "co-owner") ? isOwner && !isSelf : false;
            return (
              <div key={p.id} className="wcf-roles-row">
                <span>{p.display_name}{isSelf ? " (you)" : ""} <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span></span>
                <div className="wcf-roles-actions">
                  {p.role === "player" && (
                    <button
                      className="wcf-ghost"
                      onClick={() => {
                        if (confirm(`Make ${p.display_name} an admin? They'll be able to manage fixtures, payments, and other players.`)) {
                          onSetRole(p.id, "admin");
                        }
                      }}
                    >
                      Make admin
                    </button>
                  )}
                  {p.role === "admin" && isOwner && (
                    <>
                      <button
                        className="wcf-ghost"
                        onClick={() => {
                          const msg = isSelf
                            ? "Remove your own admin access? You'll need the owner (or the SQL Editor) to get it back."
                            : `Remove admin access from ${p.display_name}?`;
                          if (confirm(msg)) onSetRole(p.id, "player");
                        }}
                      >
                        Remove admin
                      </button>
                      <button
                        className="wcf-ghost"
                        onClick={() => {
                          if (confirm(`Make ${p.display_name} a co-owner? Only you'll be able to change or remove that access afterwards.`)) {
                            onSetRole(p.id, "co-owner");
                          }
                        }}
                      >
                        Make co-owner
                      </button>
                    </>
                  )}
                  {p.role === "co-owner" && isOwner && (
                    <button
                      className="wcf-ghost"
                      onClick={() => {
                        const msg = isSelf
                          ? "Remove your own co-owner access? You'll need the owner to get it back."
                          : `Remove co-owner access from ${p.display_name}? They'll become an admin.`;
                        if (confirm(msg)) onSetRole(p.id, "admin");
                      }}
                    >
                      Remove co-owner
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="wcf-ghost danger"
                      onClick={() => onDeleteProfile(p.id, p.display_name)}
                    >
                      Delete
                    </button>
                  )}
                  <button className="wcf-ghost" onClick={() => onToggleRatingPlayer(p.id)}>
                    {adminRatings.some((r) => r.player_id === p.id) ? "Rated ✓" : "Rate"}
                  </button>
                </div>
                {ratingPlayerId === p.id && (
                  <RatingForm
                    initial={adminRatings.find((r) => r.player_id === p.id) ?? null}
                    onSave={(fitness, attack, defence, position) => {
                      onSaveAdminRating(p.id, fitness, attack, defence, position);
                      onToggleRatingPlayer(p.id);
                    }}
                    saveLabel={`Save ${p.display_name}'s rating`}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {isAdmin && (
        <div className="wcf-audit">
          <button className="wcf-ghost wcf-roles-toggle" onClick={onToggleAuditLog}>
            {showAuditLog ? "Hide activity log" : "View activity log"}
          </button>
          {showAuditLog && (
            <>
              {auditLog.length === 0 && <p className="wcf-empty">No activity logged yet.</p>}
              {auditLog.map((entry) => (
                <div key={entry.id} className="wcf-audit-row">
                  <div className="wcf-audit-line">
                    <strong>{entry.actor?.display_name ?? "Someone"}</strong> {entry.action.toLowerCase()}
                    {entry.details ? ` — ${entry.details}` : ""}
                  </div>
                  <div className="wcf-audit-time">
                    {new Date(entry.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {isAdmin && <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />}
      {isAdmin && <AwardsForm awards={awards} onAdd={onAddAward} onDelete={onDeleteAward} />}
    </div>
  );
}

function AddPlayerForm({ onAdd }: { onAdd: (email: string, displayName: string) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    const ok = await onAdd(email.trim(), displayName.trim());
    setAdding(false);
    if (ok) {
      setEmail("");
      setDisplayName("");
    }
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Add a player</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For anyone who can&apos;t self sign up — they can then sign in with this email straight away.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
        <label className="wcf-team-field wide">
          Display name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Defaults to their email" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={adding || !email.trim()}>
        {adding ? "Adding…" : "Add player"}
      </button>
    </form>
  );
}

function LoginCodeForm({ onGenerate }: { onGenerate: (email: string) => Promise<string | null> }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCode(null);
    const result = await onGenerate(email.trim());
    setBusy(false);
    if (result) setCode(result);
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Generate a login code</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For when someone isn&apos;t getting the sign-in email — creates a real code without sending it, so you can read it out to them directly.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Their email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={busy || !email.trim()}>
        {busy ? "Generating…" : "Generate code"}
      </button>
      {code && (
        <div className="wcf-login-code">
          <span className="wcf-login-code-value">{code}</span>
          <span className="wcf-login-code-note">Expires soon — share it with them now, they enter it on the normal sign-in screen</span>
        </div>
      )}
    </form>
  );
}

function ClubSettingsForm({ settings, onSave }: { settings: ClubSettings; onSave: (patch: Partial<ClubSettings>) => void }) {
  const [form, setForm] = useState(settings);

  useEffect(() => setForm(settings), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const kickoffValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.default_kickoff);

  return (
    <div className="wcf-club-settings">
      <h3>Club settings</h3>

      <div className="wcf-team-settings">
        <label className="wcf-team-field">
          Team A name
          <input value={form.team_white_name} onChange={(e) => setForm({ ...form, team_white_name: e.target.value })} />
        </label>
        <label className="wcf-team-field color">
          Colour
          <input type="color" value={form.team_white_color} onChange={(e) => setForm({ ...form, team_white_color: e.target.value })} />
        </label>
        <label className="wcf-team-field">
          Team B name
          <input value={form.team_red_name} onChange={(e) => setForm({ ...form, team_red_name: e.target.value })} />
        </label>
        <label className="wcf-team-field color">
          Colour
          <input type="color" value={form.team_red_color} onChange={(e) => setForm({ ...form, team_red_color: e.target.value })} />
        </label>
        <label className="wcf-team-field wide">
          Default venue for new fixtures
          <input value={form.default_venue} onChange={(e) => setForm({ ...form, default_venue: e.target.value })} placeholder="e.g. Guinea Gap" />
        </label>
        <label className="wcf-team-field wide">
          Default kickoff (24hr, e.g. 19:00)
          <input
            value={form.default_kickoff}
            onChange={(e) => setForm({ ...form, default_kickoff: e.target.value })}
            placeholder="19:00"
            inputMode="numeric"
          />
          {!kickoffValid && <span className="wcf-field-error">Use 24hr HH:MM, e.g. 19:00</span>}
        </label>
        <label className="wcf-team-field wide">
          Default pitch format
          <input
            value={form.default_pitch}
            onChange={(e) => setForm({ ...form, default_pitch: e.target.value })}
            placeholder="e.g. 8-a-side"
          />
        </label>
        <label className="wcf-team-field wide">
          Default match fee (£)
          <input
            type="number"
            min={0}
            step="0.5"
            value={form.default_price}
            onChange={(e) => setForm({ ...form, default_price: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="wcf-team-field wide">
          Default squad size
          <input
            type="number"
            min={1}
            max={MAX_SPOTS}
            value={form.default_max_players}
            onChange={(e) => setForm({ ...form, default_max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
          />
        </label>
      </div>

      <button className="wcf-save" onClick={() => onSave(form)} disabled={!dirty || !kickoffValid}>Save settings</button>
    </div>
  );
}

function AwardsForm({
  awards,
  onAdd,
  onDelete,
}: {
  awards: AwardRow[];
  onAdd: (title: string, value: string, note: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    await onAdd(title.trim(), value.trim(), note.trim());
    setAdding(false);
    setTitle("");
    setValue("");
    setNote("");
  }

  return (
    <div className="wcf-club-settings">
      <h3>Awards & shoutouts</h3>

      {awards.map((a) => (
        <div key={a.id} className="wcf-award-row">
          <span>{a.title} — <strong>{a.value}</strong>{a.note ? ` · ${a.note}` : ""}</span>
          <button
            className="wcf-admin-remove"
            onClick={() => { if (confirm(`Remove "${a.title}"?`)) onDelete(a.id); }}
            aria-label="Remove award"
          >
            ×
          </button>
        </div>
      ))}

      <form onSubmit={submit}>
        <div className="wcf-team-settings">
          <label className="wcf-team-field wide">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 🏆 Player of the Season" required />
          </label>
          <label className="wcf-team-field wide">
            Value
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Marcus, or 30 goals, or anything" required />
          </label>
          <label className="wcf-team-field wide">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. voted by the squad" />
          </label>
        </div>
        <button className="wcf-save" type="submit" disabled={adding || !title.trim() || !value.trim()}>
          {adding ? "Adding…" : "Add award"}
        </button>
      </form>
    </div>
  );
}

function AdminConsole({
  upcoming,
  previous,
  overdue,
  goalRows,
  cs,
  profiles,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onRemoveBooking,
  onDeleteGame,
  onSaveResult,
  onAddBooking,
}: {
  upcoming: GameRow[];
  previous: GameRow[];
  overdue: { booking: BookingRow; game: GameRow }[];
  goalRows: GoalRow[];
  cs: ClubSettings;
  profiles: Profile[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) => Promise<void>;
  onAddBooking: (gameId: string, playerId: string) => void;
}) {
  const shared = { goalRows, cs, profiles, expandedId, onToggleExpand, onSetStatus, onRemoveBooking, onDeleteGame, onSaveResult, onAddBooking };
  return (
    <>
      <h3 className="wcf-admin-section-head">Overdue</h3>
      {overdue.length === 0 && <p className="wcf-empty small">Nothing overdue — everyone's paid up.</p>}
      {overdue.map(({ booking: b, game: g }) => (
        <div key={b.id} className="wcf-overdue-row">
          <div>
            <div className="wcf-admin-player-name">{b.player.display_name}</div>
            <div className="wcf-pitch">{g.venue} · {fmtDate(g.date)} · £{g.price}</div>
          </div>
          <div className="wcf-admin-status">
            <StatusBadge status={b.status} />
            <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Approve</button>
          </div>
          <button
            className="wcf-admin-remove"
            onClick={() => { if (confirm(`Remove ${b.player.display_name} from this game?`)) onRemoveBooking(b.id); }}
            aria-label="Remove from game"
          >
            ×
          </button>
        </div>
      ))}

      <h3 className="wcf-admin-section-head">Upcoming</h3>
      {upcoming.length === 0 && <p className="wcf-empty small">No upcoming fixtures.</p>}
      {upcoming.map((g) => (
        <AdminGameRow key={g.id} game={g} past={false} {...shared} />
      ))}
      <h3 className="wcf-admin-section-head">Previous</h3>
      {previous.length === 0 && <p className="wcf-empty small">No past fixtures yet.</p>}
      {previous.map((g) => (
        <AdminGameRow key={g.id} game={g} past {...shared} />
      ))}
    </>
  );
}

function AdminGameRow({
  game,
  past,
  goalRows,
  cs,
  profiles,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onRemoveBooking,
  onDeleteGame,
  onSaveResult,
  onAddBooking,
}: {
  game: GameRow;
  past: boolean;
  goalRows: GoalRow[];
  cs: ClubSettings;
  profiles: Profile[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) => Promise<void>;
  onAddBooking: (gameId: string, playerId: string) => void;
}) {
  const expanded = expandedId === game.id;
  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const goalsByPlayer: Record<string, number> = {};
  goalRows.filter((r) => r.game_id === game.id).forEach((r) => (goalsByPlayer[r.player_id] = r.goals));
  const [whiteScore, setWhiteScore] = useState(game.team_white_score?.toString() ?? "");
  const [redScore, setRedScore] = useState(game.team_red_score?.toString() ?? "");
  const [goalDraft, setGoalDraft] = useState<Record<string, number>>(goalsByPlayer);
  const [addPlayerId, setAddPlayerId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setWhiteScore(game.team_white_score?.toString() ?? "");
    setRedScore(game.team_red_score?.toString() ?? "");
    setGoalDraft(goalsByPlayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.team_white_score, game.team_red_score, goalRows, expanded]);

  const bookedIds = new Set(game.bookings.map((b) => b.player_id));
  const eligiblePlayers = profiles.filter((p) => !bookedIds.has(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));

  const dirty =
    whiteScore !== (game.team_white_score?.toString() ?? "") ||
    redScore !== (game.team_red_score?.toString() ?? "") ||
    confirmed.some((b) => (goalDraft[b.player_id] ?? 0) !== (goalsByPlayer[b.player_id] ?? 0));

  async function submitResult() {
    setSaving(true);
    await onSaveResult(
      game.id,
      whiteScore === "" ? null : Number(whiteScore),
      redScore === "" ? null : Number(redScore),
      goalDraft
    );
    setSaving(false);
  }

  return (
    <div className="wcf-admin-game">
      <button className="wcf-admin-game-head" onClick={() => onToggleExpand(game.id)}>
        <span className="wcf-admin-game-info">
          <span className="wcf-admin-game-venue">{game.venue}</span>
          <span className="wcf-admin-game-date">{fmtDate(game.date)} · {game.kickoff}</span>
        </span>
        <span className="wcf-admin-game-count">{confirmed.length}/{game.max_players}</span>
      </button>
      {expanded && (
        <div className="wcf-admin-game-body">
          {past && (
            <div className="wcf-admin-score">
              <span>{cs.team_white_name}</span>
              <input type="number" min={0} value={whiteScore} onChange={(e) => setWhiteScore(e.target.value)} />
              <span className="wcf-admin-score-dash">–</span>
              <input type="number" min={0} value={redScore} onChange={(e) => setRedScore(e.target.value)} />
              <span>{cs.team_red_name}</span>
            </div>
          )}
          {confirmed.length === 0 && <p className="wcf-empty small">No one booked in.</p>}
          {confirmed.map((b) => (
            <div key={b.id} className="wcf-admin-player-row">
              <span className="wcf-admin-player-name">
                {b.player.display_name}
                {b.status === "confirmed" && b.confirmer && <span className="wcf-confirmed-by">by {b.confirmer.display_name}</span>}
              </span>
              <div className="wcf-admin-status">
                <StatusBadge status={b.status} />
                {b.status !== "confirmed" ? (
                  <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Approve</button>
                ) : (
                  <button className="wcf-admin-undo" onClick={() => onSetStatus(b.id, "unpaid")}>Undo</button>
                )}
              </div>
              {past && (
                <div className="wcf-admin-goals">
                  <button
                    onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: Math.max(0, (g[b.player_id] ?? 0) - 1) }))}
                    disabled={(goalDraft[b.player_id] ?? 0) <= 0}
                  >
                    −
                  </button>
                  <span>{goalDraft[b.player_id] ?? 0}</span>
                  <button onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: (g[b.player_id] ?? 0) + 1 }))}>+</button>
                </div>
              )}
              <button
                className="wcf-admin-remove"
                onClick={() => { if (confirm(`Remove ${b.player.display_name} from this game?`)) onRemoveBooking(b.id); }}
                aria-label="Remove from game"
              >
                ×
              </button>
            </div>
          ))}

          {past && confirmed.length > 0 && (
            <button className="wcf-save" onClick={submitResult} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save result"}
            </button>
          )}

          {waitingList.length > 0 && (
            <>
              <h4 className="wcf-edit-subhead">Waiting list · {waitingList.length}</h4>
              {waitingList.map((b, i) => (
                <div key={b.id} className="wcf-admin-player-row">
                  <span className="wcf-admin-player-name">{i + 1}. {b.player.display_name}</span>
                  <button
                    className="wcf-admin-remove"
                    onClick={() => { if (confirm(`Remove ${b.player.display_name} from the waiting list?`)) onRemoveBooking(b.id); }}
                    aria-label="Remove from waiting list"
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          )}

          {eligiblePlayers.length > 0 && (
            <div className="wcf-admin-add-player">
              <select value={addPlayerId} onChange={(e) => setAddPlayerId(e.target.value)}>
                <option value="">Add a player who didn&apos;t book…</option>
                {eligiblePlayers.map((p) => (
                  <option key={p.id} value={p.id}>{p.display_name}</option>
                ))}
              </select>
              <button
                className="wcf-ghost"
                disabled={!addPlayerId}
                onClick={() => {
                  onAddBooking(game.id, addPlayerId);
                  setAddPlayerId("");
                }}
              >
                Add
              </button>
            </div>
          )}

          <button
            className="wcf-admin-delete-game"
            onClick={() => {
              const when = past ? "past" : "upcoming";
              if (confirm(`Delete this ${when} fixture: ${game.venue} on ${fmtDate(game.date)}? This removes it completely, along with everyone's bookings.`)) {
                onDeleteGame(game.id);
              }
            }}
          >
            Delete this fixture
          </button>
        </div>
      )}
    </div>
  );
}

function GameCard({
  game,
  myId,
  isAdmin,
  overdue,
  editing,
  onBook,
  onCancel,
  onMarkPaid,
  onEdit,
  onSave,
  onDelete,
}: {
  game: GameRow;
  myId: string;
  isAdmin: boolean;
  overdue: boolean;
  editing: boolean;
  onBook: () => void;
  onCancel: (bookingId: string) => void;
  onMarkPaid: (bookingId: string) => void;
  onEdit: () => void;
  onSave: (patch: Partial<GameRow>) => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState<GameRow>(game);
  const [showWaiting, setShowWaiting] = useState(false);

  useEffect(() => setForm(game), [game, editing]);

  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const myBooking = game.bookings.find((b) => b.player_id === myId);
  const myWaitingPosition = waitingList.findIndex((b) => b.player_id === myId) + 1;
  const full = confirmed.length >= game.max_players;
  const spotsLeft = Math.max(0, game.max_players - confirmed.length);

  return (
    <article className={"wcf-card " + (myBooking ? "in" : "")}>
      <div className="wcf-card-top">
        <div className="wcf-kick">
          <span className="wcf-kick-time">{game.kickoff}</span>
          <span className="wcf-kick-date">{fmtDate(game.date)}</span>
        </div>
        <div className="wcf-card-info">
          <div className="wcf-venue">{game.venue}{!game.published && <span className="wcf-draft-badge">Draft</span>}</div>
          <div className="wcf-pitch">{game.pitch} · £{game.price}</div>
        </div>
        <div className={"wcf-count " + (full ? "full" : "")}>
          <span className="wcf-count-n">{confirmed.length}/{game.max_players}</span>
          <span className="wcf-count-l">{full ? "Full" : `${spotsLeft} left`}</span>
        </div>
      </div>

      <div className="wcf-sheet">
        {Array.from({ length: game.max_players }).map((_, i) => {
          const b = confirmed[i];
          return (
            <div key={i} className={"wcf-slot " + (b ? "taken" : "")}>
              <span className="wcf-slot-num">{i + 1}</span>
              <span className="wcf-slot-name">{b ? b.player.display_name : "—"}</span>
              {b && <span className={"wcf-pay-dot " + b.status} title={b.status} />}
            </div>
          );
        })}
      </div>

      {waitingList.length > 0 && (
        <div className="wcf-waiting">
          <div className="wcf-waiting-summary">
            <span className="wcf-waiting-label">Waiting list · {waitingList.length}</span>
            {myWaitingPosition > 0 && <span className="wcf-waiting-you">You&apos;re #{myWaitingPosition}</span>}
          </div>
          <button className="wcf-waiting-toggle" onClick={() => setShowWaiting((v) => !v)}>
            {showWaiting ? "Hide waiting list" : "View waiting list"}
          </button>
          {showWaiting && (
            <div className="wcf-waiting-list">
              {waitingList.map((b, i) => (
                <div key={b.id} className="wcf-waiting-row">
                  <span>{i + 1}. {b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                  {isAdmin && editing && (
                    <button
                      className="wcf-waiting-remove"
                      onClick={() => {
                        if (confirm(`Remove ${b.player.display_name} from the waiting list?`)) onCancel(b.id);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {myBooking && !myBooking.waiting && (
        <div className={"wcf-payment " + myBooking.status}>
          <div className="wcf-payment-head">
            <span>
              {myBooking.status === "unpaid" && "You're in! Your spot has been reserved."}
              {myBooking.status === "pending" && "Thanks! Your payment has been submitted for verification."}
              {myBooking.status === "confirmed" && "Payment confirmed."}
            </span>
            <StatusBadge status={myBooking.status} />
          </div>
          <p className="wcf-payment-fee">Match fee: £{game.price}</p>
          {myBooking.status === "unpaid" && (
            <>
              <p className="wcf-payment-note">
                {PAYMENT_LINK
                  ? "Tap Pay Now to secure your spot, then press I've paid."
                  : `Pay your organiser £${game.price} to secure your spot, then press I've paid.`}
              </p>
              <div className="wcf-payment-actions">
                {PAYMENT_LINK && (
                  <a className="wcf-pay-now" href={PAYMENT_LINK} target="_blank" rel="noreferrer">
                    Pay Now
                  </a>
                )}
                <button onClick={() => onMarkPaid(myBooking.id)}>I&apos;ve paid</button>
              </div>
            </>
          )}
          {myBooking.status === "pending" && <p className="wcf-payment-note">An organiser will confirm it shortly.</p>}
        </div>
      )}

      <div className="wcf-card-actions">
        {!myBooking && overdue ? (
          <p className="wcf-overdue-note">Overdue payment — speak to an admin before booking your next game.</p>
        ) : (
          <button
            className={"wcf-book " + (myBooking ? "cancel" : "")}
            disabled={!myBooking && full && waitingList.length >= 10}
            onClick={() => {
              if (!myBooking) return onBook();
              if (confirm(myBooking.waiting ? "Leave the waiting list?" : "Give up your spot in this game?")) onCancel(myBooking.id);
            }}
          >
            {myBooking
              ? myBooking.waiting ? "Leave waiting list" : "Give up spot"
              : full ? (waitingList.length >= 10 ? "Waiting list full" : "Join waiting list") : "Grab a spot"}
          </button>
        )}
        {isAdmin && (
          <div className="wcf-admin-actions">
            <button className="wcf-ghost" onClick={onEdit}>{editing ? "Close" : "Edit"}</button>
            <button
              className="wcf-ghost danger"
              onClick={() => {
                if (confirm(`Delete ${game.venue} on ${fmtDate(game.date)}? This removes the fixture and everyone's bookings.`)) onDelete();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {isAdmin && editing && (
        <div className="wcf-edit">
          <label>
            Kickoff
            <input type="time" value={form.kickoff} onChange={(e) => setForm({ ...form, kickoff: e.target.value })} />
          </label>
          <label>
            Date
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </label>
          <label>
            Venue
            <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </label>
          <label>
            Format
            <input value={form.pitch} onChange={(e) => setForm({ ...form, pitch: e.target.value })} />
          </label>
          <label>
            Price £
            <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Pitch cost £
            <input type="number" value={form.pitch_cost} onChange={(e) => setForm({ ...form, pitch_cost: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Max players
            <input
              type="number"
              max={MAX_SPOTS}
              value={form.max_players}
              onChange={(e) => setForm({ ...form, max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
            />
          </label>
          <button className="wcf-save" onClick={() => onSave(form)}>
            {game.published ? "Save changes" : "Confirm & post fixture"}
          </button>
        </div>
      )}
    </article>
  );
}

const css = `
.wcf-root{
  --bg:#0A1A34; --panel:#0F244A; --panel2:#15315F;
  --line:rgba(200,218,245,.13); --white:#EEF4FC; --dim:#8FA6C8;
  --red:#E42A36; --red-hi:#F53A46; --blue:#2E74CC; --green:#33A957; --amber:#E0A733;
  --mono:ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  max-width:520px;margin:0 auto;height:100vh;height:100dvh;overflow:hidden;background:var(--bg);
  color:var(--white);font-family:var(--sans);display:flex;flex-direction:column;
  border-left:1px solid var(--line);border-right:1px solid var(--line);
}
.wcf-root *{box-sizing:border-box}
.wcf-root path{stroke-linecap:round}

.wcf-splash{flex:1;display:flex;align-items:center;justify-content:center}
.wcf-splash .wcf-logo.big{width:96px;height:96px;border-radius:24px}

.wcf-signin{flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center}
.wcf-logo.big{width:96px;height:96px;border-radius:24px;margin-bottom:6px}
.wcf-signin .wcf-wordmark{font-size:30px;margin-top:6px}
.wcf-signin-form{display:flex;flex-direction:column;gap:10px;width:100%;max-width:280px;margin-top:24px}
.wcf-signin-form input{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:12px;border-radius:10px;font-size:14px;font-family:var(--sans)}
.wcf-signin-form button{background:var(--red);color:#fff;border:none;padding:12px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-signin-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signin-error{color:var(--red-hi);font-size:12px;margin:0}
.wcf-signin-sent{color:var(--dim);font-size:14px;max-width:280px;margin:0 0 4px;line-height:1.5}
.wcf-signin-form input[inputmode="numeric"]{letter-spacing:4px;text-align:center;font-family:var(--mono);font-size:18px}
.wcf-signin-back{background:none!important;border:none!important;color:var(--dim)!important;font-weight:600!important;font-size:12px!important;padding:4px!important;cursor:pointer;text-decoration:underline}
.wcf-signin-back:disabled{opacity:.4;cursor:not-allowed;text-decoration:none}
.wcf-privacy-note{color:var(--dim);font-size:11px;max-width:260px;margin-top:32px;line-height:1.5;opacity:.8}

.wcf-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;background:rgba(10,26,52,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.wcf-brand{display:flex;align-items:center;gap:11px}
.wcf-logo{display:block;width:42px;height:42px;flex:0 0 auto;border-radius:11px;overflow:hidden;
  border:1px solid rgba(228,42,54,.4);box-shadow:0 2px 10px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.05)}
.wcf-logo img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 43%}
.wcf-wordmark{font-weight:900;font-size:22px;letter-spacing:1px;line-height:.9;
  color:var(--white);text-shadow:0 1px 0 rgba(0,0,0,.4)}
.wcf-wordmark-sub{font-weight:800;font-size:10px;letter-spacing:2.5px;color:var(--red-hi);margin-top:3px}
.wcf-role{display:flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);
  color:var(--dim);padding:8px 13px;border-radius:999px;font-size:12px;font-weight:800;cursor:pointer;
  font-family:var(--mono);letter-spacing:.5px;transition:.15s;max-width:140px}
.wcf-role span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-role .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.wcf-role.admin .dot{background:var(--green)}
.wcf-role.on{color:#fff;border-color:var(--red)}

.wcf-main{flex:1;padding:14px 14px 92px;overflow-y:auto}
.wcf-heading{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 14px}
.wcf-heading h2{margin:0;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim)}
.wcf-addbtn{background:var(--red);color:#fff;border:none;padding:7px 13px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-empty{color:var(--dim);text-align:center;padding:40px 0;font-size:14px}
.wcf-empty.small{padding:8px 0;font-size:12px}

.wcf-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:14px;position:relative;overflow:hidden}
.wcf-card.in{border-color:rgba(51,169,87,.5)}
.wcf-card.in:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--green)}
.wcf-card-top{display:flex;align-items:center;gap:14px}
.wcf-kick{display:flex;flex-direction:column;min-width:66px}
.wcf-kick-time{font-family:var(--mono);font-size:24px;font-weight:700;line-height:1;color:var(--white)}
.wcf-kick-date{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
.wcf-card-info{flex:1}
.wcf-venue{font-weight:800;font-size:15px}
.wcf-draft-badge{display:inline-block;margin-left:8px;background:rgba(224,167,51,.18);color:var(--amber);border:1px solid rgba(224,167,51,.4);font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:20px;vertical-align:middle}
.wcf-pitch{font-size:12px;color:var(--dim);margin-top:2px;font-family:var(--mono)}
.wcf-count{text-align:right}
.wcf-count-n{display:block;font-family:var(--mono);font-weight:700;font-size:17px;color:var(--blue)}
.wcf-count.full .wcf-count-n{color:var(--dim)}
.wcf-count-l{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}

.wcf-sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:5px 10px;margin:14px 0;padding:12px;
  background:var(--bg);border-radius:10px;border:1px solid var(--line)}
.wcf-slot{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px}
.wcf-slot-num{font-family:var(--mono);color:var(--dim);width:20px;text-align:center;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 0}
.wcf-slot-name{color:var(--dim);flex:1}
.wcf-slot.taken .wcf-slot-name{color:var(--white)}
.wcf-slot.taken .wcf-slot-num{color:var(--green);border-color:rgba(51,169,87,.5)}
.wcf-pay-dot{width:7px;height:7px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.wcf-pay-dot.pending{background:var(--amber)}
.wcf-pay-dot.confirmed{background:var(--green)}

.wcf-waiting{margin:0 0 14px;padding:12px;background:rgba(224,167,51,.08);border:1px dashed rgba(224,167,51,.4);border-radius:10px}
.wcf-waiting-summary{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.wcf-waiting-label{flex:1;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--amber)}
.wcf-waiting-toggle{width:100%;background:var(--amber);color:#2a1c00;border:none;padding:10px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-waiting-toggle:active{opacity:.8}
.wcf-waiting-list{padding-top:10px}
.wcf-waiting-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dim);padding:3px 0}
.wcf-waiting-row span:first-child{flex:1}
.wcf-waiting-you{background:var(--amber);color:#2a1c00;font-weight:800;font-size:10px;text-transform:uppercase;padding:3px 8px;border-radius:999px;flex:0 0 auto}
.wcf-waiting-remove{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;flex:0 0 auto}
.wcf-waiting-remove:hover{color:var(--red-hi)}

.wcf-payment{margin:0 0 14px;padding:12px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--panel2);border:1px solid var(--line)}
.wcf-payment-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:700;color:var(--white)}
.wcf-payment-fee{margin:6px 0 10px;color:var(--dim);font-family:var(--mono)}
.wcf-payment.confirmed{border-color:rgba(51,169,87,.5)}
.wcf-payment.pending .wcf-payment-note{margin:0;color:var(--amber)}
.wcf-payment-actions{display:flex;gap:8px;flex-wrap:wrap}
.wcf-payment-actions button,.wcf-pay-now{background:var(--red);color:#fff;border:none;padding:9px 14px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.wcf-pay-now{background:var(--panel2);border:1px solid var(--line)}

.wcf-status-badge{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.3px;padding:3px 8px;border-radius:999px;background:var(--panel2);color:var(--dim);white-space:nowrap;flex:0 0 auto}
.wcf-status-badge.unpaid{color:var(--dim);border:1px solid var(--line)}
.wcf-status-badge.pending{color:var(--amber);border:1px solid rgba(224,167,51,.4)}
.wcf-status-badge.confirmed{color:var(--green);border:1px solid rgba(51,169,87,.4)}

.wcf-toast{position:sticky;top:0;z-index:6;background:var(--green);color:#04140a;font-weight:800;font-size:13px;text-align:center;padding:10px 14px}
.wcf-toast.error{background:var(--red);color:#fff}

.wcf-card-actions{display:flex;align-items:center;gap:10px}
.wcf-book{flex:1;background:var(--red);color:#fff;border:none;padding:12px;border-radius:10px;font-weight:900;font-size:14px;letter-spacing:.4px;cursor:pointer;transition:.15s}
.wcf-book:hover{background:var(--red-hi)}
.wcf-book.cancel{background:transparent;color:var(--white);border:1px solid var(--line)}
.wcf-book:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-admin-actions{display:flex;gap:6px}
.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px 12px;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer}
.wcf-ghost.danger:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}

.wcf-edit{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wcf-edit label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-edit input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:13px;font-family:var(--sans)}
.wcf-save{grid-column:1/-1;background:var(--green);color:#04140a;border:none;padding:11px;border-radius:9px;font-weight:800;cursor:pointer;font-size:13px}
.wcf-admin-section-head{margin:18px 2px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-admin-section-head:first-child{margin-top:4px}
.wcf-overdue-row{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid rgba(228,42,54,.35);border-radius:12px;padding:11px 13px;margin-bottom:9px;flex-wrap:wrap}
.wcf-overdue-banner{background:linear-gradient(135deg,rgba(228,42,54,.18),rgba(228,42,54,.06));border:1px solid rgba(228,42,54,.4);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5;color:var(--white)}
.wcf-overdue-banner strong{color:var(--red-hi)}
.wcf-overdue-note{font-size:12px;color:var(--red-hi);font-weight:700;text-align:center;margin:0;flex:1}
.wcf-nudge-banner{background:linear-gradient(135deg,rgba(46,116,204,.18),rgba(46,116,204,.06));border:1px solid rgba(46,116,204,.4);border-radius:14px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wcf-nudge-banner strong{font-size:13px;color:var(--white)}
.wcf-nudge-banner p{font-size:12px;color:var(--dim);margin:3px 0 0;line-height:1.4}
.wcf-nudge-actions{display:flex;gap:8px;flex-shrink:0}
.wcf-nudge-actions button{font-size:12px;font-weight:800;padding:8px 14px;border-radius:20px;border:none;background:var(--blue);color:#fff;cursor:pointer}
.wcf-nudge-actions button.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}
.wcf-overdue-row>div:first-child{flex:1;min-width:120px}
.wcf-admin-game{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden}
.wcf-admin-game-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:none;border:none;color:var(--white);padding:13px 14px;cursor:pointer;text-align:left}
.wcf-admin-game-info{display:flex;flex-direction:column;gap:2px}
.wcf-admin-game-venue{font-weight:800;font-size:14px}
.wcf-admin-game-date{font-size:11px;color:var(--dim);font-family:var(--mono)}
.wcf-admin-game-count{font-family:var(--mono);font-weight:700;color:var(--blue);flex:0 0 auto}
.wcf-admin-game-body{padding:0 12px 12px;border-top:1px solid var(--line)}
.wcf-admin-score{display:flex;align-items:center;justify-content:center;gap:9px;padding:12px 0;font-size:12px;font-weight:800}
.wcf-admin-score input{width:44px;text-align:center;background:var(--bg);border:1px solid var(--line);color:var(--white);padding:6px;border-radius:7px;font-family:var(--mono);font-size:13px}
.wcf-admin-score-dash{color:var(--dim)}
.wcf-edit-subhead{margin:14px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--amber)}
.wcf-admin-player-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wcf-admin-player-row:last-child{border-bottom:none}
.wcf-admin-player-name{flex:1;min-width:90px;font-weight:700;font-size:13px}
.wcf-confirmed-by{display:block;font-size:10px;font-weight:600;color:var(--dim);margin-top:1px}
.wcf-admin-status{display:flex;align-items:center;gap:8px}
.wcf-admin-approve{background:var(--green);color:#04140a;border:none;padding:7px 12px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}
.wcf-admin-undo{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer}
.wcf-admin-undo:hover{color:var(--red-hi)}
.wcf-admin-goals{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-weight:700}
.wcf-admin-goals button{width:24px;height:24px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--white);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center}
.wcf-admin-goals button:disabled{opacity:.4;cursor:not-allowed}
.wcf-admin-goals span{width:16px;text-align:center}
.wcf-admin-remove{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;line-height:1;padding:0 2px}
.wcf-admin-remove:hover{color:var(--red-hi)}
.wcf-admin-delete-game{width:100%;background:transparent;border:1px dashed rgba(228,42,54,.4);color:var(--red-hi);padding:10px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer;margin-top:10px}
.wcf-admin-game-body > .wcf-save{width:100%;margin:12px 0}
.wcf-admin-game-body > .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-admin-add-player{display:flex;gap:8px;margin-top:14px}
.wcf-admin-add-player select{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:12px;font-family:var(--sans)}
.wcf-admin-add-player .wcf-ghost:disabled{opacity:.4;cursor:not-allowed}

.wcf-clip-form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wcf-clip-form input{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-clip-form button{background:var(--red);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-clip-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-clip{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px;align-items:flex-start}
.wcf-clip-thumb{width:74px;height:52px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,var(--panel2),var(--bg));display:grid;place-items:center;color:var(--red-hi);font-size:16px;border:1px solid var(--line)}
.wcf-clip-body{flex:1;min-width:0}
.wcf-clip-title{font-weight:800;font-size:14px}
.wcf-clip-sub{font-size:11px;color:var(--dim);margin-top:3px;font-family:var(--mono)}
.wcf-clip-del{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;flex:0 0 auto;line-height:1}
.wcf-clip-del:hover{color:var(--red-hi)}
.wcf-feed-item{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 12px;margin-bottom:10px;align-items:flex-start}
.wcf-feed-icon{width:32px;height:32px;border-radius:9px;flex:0 0 auto;display:grid;place-items:center;font-size:15px}
.wcf-feed-icon.amber{background:rgba(224,167,51,.16)}
.wcf-feed-icon.green{background:rgba(51,169,87,.16)}
.wcf-feed-icon.blue{background:rgba(46,116,204,.16)}
.wcf-feed-body{flex:1;min-width:0}
.wcf-feed-text{font-size:13px;color:var(--white);line-height:1.4}
.wcf-feed-date{font-size:10.5px;color:var(--dim);font-family:var(--mono);margin-top:3px}
.wcf-feed-archive-btn{margin-top:8px;font-size:11px;font-weight:800;padding:5px 11px;border-radius:20px;background:transparent;border:1px solid var(--line);color:var(--dim);cursor:pointer}
.wcf-feed-archive-btn:hover{border-color:var(--red-hi);color:var(--red-hi)}
.wcf-archive-toggle{font-size:11.5px;padding:7px 12px;margin-bottom:12px}
.wcf-feed-reactions{display:flex;gap:6px;margin-top:8px}
.wcf-feed-reaction{font-size:11px;font-family:var(--mono);color:var(--dim);background:var(--panel2);border:1px solid transparent;border-radius:20px;padding:3px 9px;cursor:pointer}
.wcf-feed-reaction.mine{border-color:var(--green);color:var(--green)}

.wcf-subtabs{display:flex;gap:8px;margin:0 2px 12px}
.wcf-subtabs button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:9px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-subtabs button.active{background:var(--red);border-color:var(--red);color:#fff}

.wcf-board{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:8px 14px 14px;overflow:hidden}
.wcf-board-note{font-size:12px;color:var(--dim);margin:10px 2px 12px;line-height:1.4}
.wcf-board-row{display:flex;align-items:center;gap:12px;padding:11px 8px;border-radius:9px;border-bottom:1px solid var(--line)}
.wcf-board-row:last-child{border-bottom:none}
.wcf-board-row.lead{background:rgba(51,169,87,.12);border-bottom:none;margin-bottom:2px}
.wcf-board-row.me{background:rgba(46,116,204,.14)}
.wcf-board-row.me .wcf-board-name{color:var(--blue)}
.wcf-board-header{padding:0 8px 8px;border-bottom:1px solid var(--line)}
.wcf-board-header .wcf-board-name,.wcf-board-header .wcf-board-count{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);font-weight:700;font-family:var(--sans)}
.wcf-rank{font-family:var(--mono);font-weight:700;color:var(--dim);width:26px;text-align:center;display:grid;place-items:center}
.wcf-rank-star{color:var(--green);display:grid;place-items:center}
.wcf-rank-star svg{width:20px;height:20px;fill:var(--green);stroke:var(--green)}
.wcf-board-name{flex:1;font-weight:800;font-size:14px}
.wcf-apps-badge{display:inline-block;margin-left:7px;font-size:10px;font-weight:800;font-family:var(--mono);color:var(--amber);background:rgba(224,167,51,.14);border:1px solid rgba(224,167,51,.35);padding:1px 7px;border-radius:20px;vertical-align:middle}
.wcf-board-count{font-family:var(--mono);font-weight:700;color:var(--blue);width:44px;text-align:right}

.wcf-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--blue)}
.wcf-avatar.big{width:44px;height:44px;font-size:18px}

.wcf-lineup-head{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-lineup-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:9px;transition:box-shadow .2s}
.wcf-lineup-row.me{border-color:transparent}
.wcf-lineup-row.me-edit{background:rgba(46,116,204,.14);border-color:var(--blue)}
.wcf-lineup-name{font-weight:700;font-size:14px}
.wcf-lineup-picks{display:flex;gap:6px}
.wcf-lineup-pick{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 11px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}
.wcf-lineup-badge{font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-fairness-teams{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.wcf-fairness-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px}
.wcf-fairness-card-head{font-weight:800;font-size:13px;margin-bottom:10px}
.wcf-fairness-metric{margin-bottom:8px}
.wcf-fairness-metric-top{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:3px}
.wcf-fairness-metric-top span:last-child{font-family:var(--mono);color:var(--white)}
.wcf-fairness-track{height:6px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-fairness-fill{height:100%;border-radius:5px;background:var(--blue)}
.wcf-fairness-positions{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
.wcf-fairness-pos-tag{font-size:9.5px;font-weight:700;color:var(--dim);background:var(--panel2);padding:2px 7px;border-radius:20px}
.wcf-fairness-rated-note{font-size:10px;color:var(--dim);margin-top:8px;font-family:var(--mono)}
.wcf-fairness-ok{font-size:13px;color:var(--green);font-weight:700;text-align:center;padding:10px}
.wcf-fairness-flags{display:flex;flex-direction:column;gap:8px}
.wcf-fairness-flag{background:rgba(224,167,51,.14);border:1px solid rgba(224,167,51,.35);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--white)}
.wcf-generate-teams{width:100%;background:var(--blue);color:#fff;border:none;padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;margin-bottom:8px}
.wcf-suggestion-actions{display:flex;gap:8px;margin-bottom:8px}
.wcf-suggestion-actions .wcf-generate-teams{flex:1;margin-bottom:0;background:var(--panel2);color:var(--white)}
.wcf-suggestion-actions .wcf-ghost{flex:1}
.wcf-apply-teams{flex:1.4;background:var(--green);color:var(--bg);border:none;padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer}
.wcf-suggestion-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0 0 14px;text-align:center}
.wcf-fairness-preview-names{font-size:11px;color:var(--dim);line-height:1.4;margin-bottom:10px}
.wcf-lineup-group{margin-bottom:6px}
.wcf-lineup-group-label{font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--dim);margin:0 2px 8px}

.wcf-shoutout{background:linear-gradient(135deg,rgba(228,42,54,.16),rgba(51,169,87,.1));border:1px solid rgba(228,42,54,.35);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5}
.wcf-potm{background:linear-gradient(135deg,rgba(224,167,51,.2),rgba(224,167,51,.06));border-color:rgba(224,167,51,.4)}

.wcf-pot-total{background:linear-gradient(135deg,rgba(51,169,87,.16),rgba(46,116,204,.1));border:1px solid rgba(51,169,87,.35);border-radius:16px;padding:18px;margin-bottom:16px;text-align:center}
.wcf-pot-total-label{font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--dim)}
.wcf-pot-total-amount{font-family:var(--mono);font-weight:800;font-size:36px;color:var(--green);margin:4px 0 8px}
.wcf-pot-total-amount.negative{color:var(--red-hi)}
.wcf-pot-total-note{font-size:12px;color:var(--dim);line-height:1.5;margin:0;max-width:340px;margin-left:auto;margin-right:auto}
.wcf-pot-add{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wcf-pot-add input,.wcf-pot-add select{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-pot-kind-toggle{display:flex;gap:8px}
.wcf-pot-kind-toggle button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer}
.wcf-pot-kind-toggle button.active{background:rgba(51,169,87,.18);border-color:var(--green);color:var(--green)}
.wcf-pot-kind-toggle button.active.deduct{background:rgba(230,60,60,.16);border-color:var(--red-hi);color:var(--red-hi)}
.wcf-pot-submit{background:var(--green);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-pot-submit.deduct{background:var(--red-hi)}
.wcf-pot-submit:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-pot-row{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:9px}
.wcf-pot-row>div:first-child{flex:1;min-width:0}
.wcf-pot-row-desc{font-weight:700;font-size:13px}
.wcf-pot-cat-tag{display:inline-block;margin-left:7px;font-size:9.5px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:var(--dim);background:var(--panel2);padding:1px 7px;border-radius:20px}
.wcf-fin-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.wcf-fin-tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 8px;text-align:center}
.wcf-fin-tile-label{font-size:9px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.wcf-fin-tile-value{font-family:var(--mono);font-weight:800;font-size:18px;margin-top:5px;color:var(--white)}
.wcf-fin-tile-value.green{color:var(--green)}
.wcf-fin-tile-value.red{color:var(--red-hi)}
.wcf-fin-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:14px}
.wcf-fin-card-head{font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--dim);margin-bottom:12px}
.wcf-fin-chart{display:flex;align-items:flex-end;gap:6px;height:80px}
.wcf-fin-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.wcf-fin-bar{width:100%;border-radius:4px 4px 0 0;background:var(--blue);min-height:2px}
.wcf-fin-bar.neg{background:var(--red-hi)}
.wcf-fin-bar-label{font-size:8px;color:var(--dim);margin-top:5px;font-family:var(--mono)}
.wcf-fin-fx-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);gap:10px}
.wcf-fin-fx-row:last-child{border-bottom:none;padding-bottom:0}
.wcf-fin-fx-desc{font-size:12.5px;font-weight:700;color:var(--white)}
.wcf-fin-fx-net{font-family:var(--mono);font-weight:800;font-size:13px;flex-shrink:0}
.wcf-fin-fx-net.green{color:var(--green)}
.wcf-fin-fx-net.red{color:var(--red-hi)}
.wcf-fin-cat-row{margin-bottom:10px}
.wcf-fin-cat-row:last-child{margin-bottom:0}
.wcf-fin-cat-top{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px}
.wcf-fin-cat-top span:first-child{color:var(--white);font-weight:600}
.wcf-fin-cat-top span:last-child{color:var(--dim);font-family:var(--mono)}
.wcf-fin-cat-track{height:7px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-fin-cat-fill{height:100%;border-radius:5px;background:var(--amber)}
.wcf-fin-export{width:100%;display:flex;align-items:center;justify-content:center}
.wcf-pot-row-amount{font-family:var(--mono);font-weight:800;font-size:14px;flex:0 0 auto}
.wcf-pot-row-amount.pos{color:var(--green)}
.wcf-pot-row-amount.neg{color:var(--red-hi)}
.wcf-h2h{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-h2h-title{font-weight:800;font-size:13px;margin-bottom:10px}
.wcf-h2h-row{display:grid;grid-template-columns:1fr repeat(5,28px);align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.wcf-h2h-row:last-child{border-bottom:none}
.wcf-h2h-header{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.4px}
.wcf-h2h-row span{text-align:center}
.wcf-h2h-team{display:flex;align-items:center;gap:7px;text-align:left!important;font-weight:700}
.wcf-h2h-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.wcf-h2h-pts{font-weight:800;color:var(--white)}

.wcf-month-filter{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans);margin-bottom:14px}
.wcf-result{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px;margin-bottom:11px}
.wcf-result-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-result-score{font-family:var(--mono);font-weight:800;font-size:18px;display:flex;align-items:center;gap:6px}
.wcf-result-dash{color:var(--dim);font-weight:400}
.wcf-result-scorers{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.wcf-result-scorer{font-size:12px;color:var(--dim)}
.wcf-motm{margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.wcf-motm-label{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.wcf-motm-candidates{display:flex;flex-wrap:wrap;gap:6px}
.wcf-motm-vote{font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:20px;border:1px solid var(--line);background:transparent;color:var(--white);cursor:pointer}
.wcf-motm-vote.voted{background:var(--green);border-color:var(--green);color:var(--bg)}
.wcf-motm-winner{font-size:13px;font-weight:700;color:var(--white);margin-bottom:9px}
.wcf-motm-winner strong{color:var(--amber)}
.wcf-motm-bar-row{margin-bottom:7px}
.wcf-motm-bar-row:last-child{margin-bottom:0}
.wcf-motm-bar-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;font-size:12px}
.wcf-motm-bar-top span:first-child{color:var(--dim);font-weight:600}
.wcf-motm-bar-top span.winner{color:var(--amber)}
.wcf-motm-count{font-family:var(--mono);color:var(--dim);font-size:11px}
.wcf-motm-bar-track{height:6px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-motm-bar-fill{height:100%;border-radius:5px;background:var(--dim)}
.wcf-motm-bar-fill.winner{background:var(--amber)}

.wcf-account{display:flex;flex-direction:column;gap:16px}
.wcf-account-card{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.wcf-account-name{font-weight:800;font-size:15px}
.wcf-account-email{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-role-badge{margin-left:auto;font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-role-badge.admin{color:var(--green);border:1px solid rgba(51,169,87,.4)}
.wcf-role-badge.co-owner{color:var(--blue);border:1px solid rgba(46,116,204,.4)}
.wcf-role-badge.owner{color:var(--red-hi);border:1px solid rgba(228,42,54,.4)}
.wcf-role-badge.small{margin-left:4px;padding:2px 7px;font-size:9px}
.wcf-account-field{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-account-rename{display:flex;gap:8px}
.wcf-account-rename input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:10px;border-radius:9px;font-size:13px;font-family:var(--sans);text-transform:none}
.wcf-account-rename button{background:var(--red);color:#fff;border:none;padding:0 14px;border-radius:9px;font-weight:800;cursor:pointer}
.wcf-account-rename button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signout{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:700;cursor:pointer}
.wcf-signout:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}
.wcf-push-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:9px}
.wcf-rating-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:16px}
.wcf-rating-section h3{font-size:13px;font-weight:800;color:var(--white);margin:0 0 4px}
.wcf-rating-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0 0 12px}
.wcf-record-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:16px}
.wcf-record-section h3{font-size:13px;font-weight:800;color:var(--white);margin:0 0 4px}
.wcf-record-empty{font-size:11px;color:var(--dim);margin:0}
.wcf-record-pct{font-size:32px;font-weight:800;color:var(--white);text-align:center;margin:6px 0 12px}
.wcf-record-pct span{display:block;font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.wcf-record-row{display:flex;justify-content:space-around;text-align:center;border-top:1px solid var(--line);padding-top:10px}
.wcf-record-row>div{display:flex;flex-direction:column;gap:2px}
.wcf-record-row strong{font-size:16px;color:var(--white)}
.wcf-record-row span{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.03em}
.wcf-rating-form{display:flex;flex-direction:column;gap:10px}
.wcf-rating-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-rating-row>span:first-child{font-size:12.5px;font-weight:700;color:var(--white);flex-shrink:0}
.wcf-rating-row select{background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 10px;border-radius:8px;font-size:12.5px;font-family:var(--sans)}
.wcf-star-picker{display:flex;gap:3px}
.wcf-star{background:none;border:none;font-size:20px;color:var(--line);cursor:pointer;padding:0;line-height:1}
.wcf-star.on{color:var(--amber)}
.wcf-push-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-push-label{font-size:13px;font-weight:700;color:var(--white)}
.wcf-push-sub{font-size:11px;color:var(--dim);margin-top:2px}
.wcf-push-toggle{flex:0 0 auto;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-weight:800;font-size:12px;padding:7px 16px;border-radius:20px;cursor:pointer}
.wcf-push-toggle.on{background:var(--green);border-color:var(--green);color:var(--bg)}
.wcf-push-toggle:disabled{opacity:.6;cursor:not-allowed}
.wcf-push-test{align-self:flex-start;font-size:11.5px;padding:7px 12px}
.wcf-push-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0}
.wcf-guides{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;display:flex;flex-direction:column}
.wcf-guides h3{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--dim);margin:8px 10px 4px}
.wcf-guide-row{display:flex;align-items:center;justify-content:space-between;background:transparent;border:none;color:var(--white);font-size:13.5px;font-weight:600;font-family:var(--sans);padding:11px 10px;border-radius:9px;cursor:pointer;text-align:left}
.wcf-guide-row:hover{background:var(--panel2)}
.wcf-guide-arrow{color:var(--dim);font-size:18px}
.wcf-lightbox{position:fixed;inset:0;background:rgba(4,9,20,.92);z-index:100;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 12px 40px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.wcf-lightbox-img{max-width:min(480px,100%);width:100%;border-radius:14px;box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
.wcf-lightbox-close{position:fixed;top:16px;right:16px;width:38px;height:38px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:22px;line-height:1;cursor:pointer;z-index:101}
.wcf-push-stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;font-size:12.5px;color:var(--dim);font-weight:600}
.wcf-audit{margin-bottom:16px}
.wcf-audit-row{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:8px}
.wcf-audit-line{font-size:12.5px;color:var(--white);line-height:1.4}
.wcf-audit-line strong{font-weight:800}
.wcf-audit-time{font-size:10.5px;color:var(--dim);font-family:var(--mono);margin-top:3px}
.wcf-roles{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.wcf-roles h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-roles-toggle{width:100%;margin-bottom:4px}
.wcf-roles-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line);flex-wrap:wrap;min-width:0}
.wcf-roles-row:last-child{border-bottom:none}
.wcf-roles-row>span{min-width:0;overflow-wrap:break-word}
.wcf-roles-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0}

.wcf-club-settings,.wcf-add-player{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-top:16px}
.wcf-club-settings h3,.wcf-add-player h3{margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-award-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line)}
.wcf-award-row:last-of-type{border-bottom:none;margin-bottom:10px}
.wcf-team-settings{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:6px}
.wcf-team-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700;min-width:0}
.wcf-team-field.wide{grid-column:1/-1}
.wcf-team-field input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:13px;font-family:var(--sans);text-transform:none;width:100%;max-width:100%;min-width:0;box-sizing:border-box;display:block}
.wcf-team-field.color input{width:52px;padding:2px;height:38px;cursor:pointer}
.wcf-team-field.narrow input{width:70px}
.wcf-field-error{text-transform:none;letter-spacing:normal;font-weight:600;font-size:11px;color:var(--red-hi);margin-top:2px}
.wcf-club-settings .wcf-save,.wcf-add-player .wcf-save{margin-top:10px}
.wcf-club-settings .wcf-save:disabled,.wcf-add-player .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-login-code{margin-top:12px;background:var(--panel2);border:1px solid rgba(51,169,87,.4);border-radius:10px;padding:14px;text-align:center}
.wcf-login-code-value{display:block;font-family:var(--mono);font-weight:800;font-size:28px;letter-spacing:4px;color:var(--green)}
.wcf-login-code-note{display:block;font-size:11px;color:var(--dim);margin-top:6px;line-height:1.4}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px))}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-sheet{grid-template-columns:1fr} .wcf-edit{grid-template-columns:1fr} }
`;
