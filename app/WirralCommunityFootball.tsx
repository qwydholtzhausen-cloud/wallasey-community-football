"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";

// Payment provider is intentionally just config, not baked into booking logic
// (statuses below), so swapping to Stripe/Open Banking later only touches this.
const PAYMENT_PROVIDER_LABEL = "Monzo";
const PAYMENT_LINK = process.env.NEXT_PUBLIC_PAYMENT_LINK || "";
const MAX_SPOTS = 16;

type Role = "player" | "admin" | "owner";
type PayStatus = "unpaid" | "pending" | "confirmed";

const STATUS_LABEL: Record<PayStatus, string> = {
  unpaid: "Payment Pending",
  pending: "Awaiting Approval",
  confirmed: "Confirmed",
};

function StatusBadge({ status }: { status: PayStatus }) {
  return <span className={"wcf-status-badge " + status}>{STATUS_LABEL[status]}</span>;
}

interface Profile {
  id: string;
  display_name: string;
  role: Role;
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
}

interface GameRow {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  max_players: number;
  team_white_score: number | null;
  team_red_score: number | null;
  bookings: BookingRow[];
}

interface ClubSettings {
  team_white_name: string;
  team_white_color: string;
  team_red_name: string;
  team_red_color: string;
  record_holder_name: string | null;
  record_goals: number | null;
  record_note: string | null;
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
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const prevStatusRef = useRef<Record<string, PayStatus>>({});
  const prevWaitingRef = useRef<Record<string, boolean>>({});

  function notifyError(message: string) {
    setToast({ kind: "error", text: message });
  }
  function notifySuccess(text: string) {
    setToast({ kind: "success", text });
  }

  const [tab, setTab] = useState<"fixtures" | "clips" | "lineup" | "results" | "account" | "admin">("fixtures");
  const [resultsView, setResultsView] = useState<"season" | "table" | "fixtures">("season");
  const [resultsMonth, setResultsMonth] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [clipTitle, setClipTitle] = useState("");
  const [clipUrl, setClipUrl] = useState("");

  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "owner";
  const isOwner = myProfile?.role === "owner";
  const cs: ClubSettings = clubSettings ?? {
    team_white_name: "Whites",
    team_white_color: "#EEF4FC",
    team_red_name: "Reds",
    team_red_color: "#E42A36",
    record_holder_name: null,
    record_goals: null,
    record_note: null,
  };

  const loadProfile = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role").eq("id", myId).single();
    if (data) setMyProfile(data as Profile);
  }, [myId]);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role").order("display_name");
    if (data) setProfiles(data as Profile[]);
  }, []);

  const loadGames = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select(
        "id, date, kickoff, venue, pitch, price, max_players, team_white_score, team_red_score, bookings(id, player_id, status, waiting, team, created_at, player:profiles(id, display_name, role))"
      )
      .order("date", { ascending: true });
    if (data) setGames(data as unknown as GameRow[]);
  }, []);

  const loadClubSettings = useCallback(async () => {
    const { data } = await supabase
      .from("club_settings")
      .select("team_white_name, team_white_color, team_red_name, team_red_color, record_holder_name, record_goals, record_note")
      .single();
    if (data) setClubSettings(data as ClubSettings);
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

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadProfile(), loadProfiles(), loadGames(), loadClips(), loadGoals(), loadClubSettings()]);
      setLoading(false);
    })();
  }, [loadProfile, loadProfiles, loadGames, loadClips, loadGoals, loadClubSettings]);

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

  async function book(gameId: string) {
    const { error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: myId });
    if (error) notifyError(error.message);
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
    const { error } = await supabase.from("bookings").update({ status }).eq("id", bookingId);
    if (error) notifyError(error.message);
  }

  async function addGame() {
    const { data, error } = await supabase
      .from("games")
      .insert({ date: defaultNewGameDate(), kickoff: "19:00", venue: "New venue", pitch: "8-a-side", price: 6, max_players: MAX_SPOTS })
      .select()
      .single();
    if (error) return notifyError(error.message);
    await loadGames();
    if (data) setEditingId(data.id);
  }
  async function saveGame(id: string, patch: Partial<GameRow>) {
    const { bookings: _bookings, ...rest } = patch as GameRow;
    const { error } = await supabase.from("games").update(rest).eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    setEditingId(null);
  }
  async function deleteGame(id: string) {
    const { error } = await supabase.from("games").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
  }
  async function adjustGoal(gameId: string, playerId: string, delta: number) {
    const current = goalRows.find((g) => g.game_id === gameId && g.player_id === playerId)?.goals ?? 0;
    const next = Math.max(0, current + delta);
    const { error } = await supabase.from("game_stats").upsert({ game_id: gameId, player_id: playerId, goals: next }, { onConflict: "game_id,player_id" });
    if (error) return notifyError(error.message);
    await loadGoals();
  }
  async function saveTeamScore(gameId: string, side: "team_white_score" | "team_red_score", value: number | null) {
    const { error } = await supabase.from("games").update({ [side]: value }).eq("id", gameId);
    if (error) return notifyError(error.message);
    await loadGames();
  }

  async function saveClubSettings(patch: Partial<ClubSettings>) {
    const { error } = await supabase.from("club_settings").update(patch).eq("id", true);
    if (error) return notifyError(error.message);
    await loadClubSettings();
    notifySuccess("Club settings saved");
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

  async function renameSelf(name: string) {
    if (!name.trim()) return;
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", myId);
    if (error) return notifyError(error.message);
    await Promise.all([loadProfile(), loadProfiles()]);
  }
  async function setRole(id: string, role: Role) {
    const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadProfiles();
  }
  async function deleteProfile(id: string, name: string) {
    if (!confirm(`Permanently delete ${name}'s account? This removes their login and all their bookings. This can't be undone.`)) return;
    const res = await fetch("/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ targetId: id }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Something went wrong" }));
      notifyError(error || "Couldn't delete that account");
      return;
    }
    await Promise.all([loadProfiles(), loadGames()]);
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  const playerStats = useMemo(() => {
    const tally: Record<string, { name: string; apps: number; goals: number }> = {};
    games.forEach((g) =>
      g.bookings
        .filter((b) => !b.waiting)
        .forEach((b) => {
          const cur = tally[b.player_id] ?? { name: b.player.display_name, apps: 0, goals: 0 };
          cur.apps += 1;
          tally[b.player_id] = cur;
        })
    );
    goalRows.forEach((r) => {
      const cur = tally[r.player_id] ?? { name: r.player.display_name, apps: 0, goals: 0 };
      cur.goals += r.goals;
      tally[r.player_id] = cur;
    });
    return Object.entries(tally)
      .map(([id, row]) => ({ id, ...row }))
      .sort((a, b) => b.apps - a.apps);
  }, [games, goalRows]);

  const today = new Date().toISOString().slice(0, 10);
  const upcomingGames = useMemo(() => games.filter((g) => g.date >= today).sort((a, b) => a.date.localeCompare(b.date)), [games, today]);
  const pastGames = useMemo(() => games.filter((g) => g.date < today).sort((a, b) => b.date.localeCompare(a.date)), [games, today]);
  const nextGame = upcomingGames[0];
  const nextConfirmed = useMemo(
    () => (nextGame ? nextGame.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [nextGame]
  );

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

  const TABS = [
    { k: "fixtures", label: "Fixtures", icon: Icon.cal },
    { k: "clips", label: "Clips", icon: Icon.play },
    { k: "lineup", label: "Line-up", icon: Icon.shirt },
    { k: "results", label: "Results", icon: Icon.trophy },
    ...(isAdmin ? [{ k: "admin", label: "Admin", icon: Icon.history } as const] : []),
  ] as const;

  const heading = {
    fixtures: "Upcoming fixtures",
    clips: "Match clips",
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
            {upcomingGames.length === 0 && <p className="wcf-empty">No games on. {isAdmin ? "Add one above." : "Check back soon."}</p>}
            {upcomingGames.map((g) => (
              <GameCard
                key={g.id}
                game={g}
                myId={myId}
                isAdmin={isAdmin}
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
            expandedId={expandedGameId}
            onToggleExpand={(id) => setExpandedGameId(expandedGameId === id ? null : id)}
            onSetStatus={setBookingStatus}
            onAdjustGoal={adjustGoal}
            onRemoveBooking={cancel}
            onDeleteGame={deleteGame}
            onSaveTeamScore={saveTeamScore}
          />
        )}

        {tab === "clips" && (
          <>
            <form className="wcf-clip-form" onSubmit={addClip}>
              <input placeholder="Clip title" value={clipTitle} onChange={(e) => setClipTitle(e.target.value)} />
              <input placeholder="YouTube link (optional)" value={clipUrl} onChange={(e) => setClipUrl(e.target.value)} />
              <button type="submit" disabled={!clipTitle.trim()}>Share clip</button>
            </form>
            {clips.length === 0 && <p className="wcf-empty">No clips yet.</p>}
            {clips.map((c) => (
              <article key={c.id} className="wcf-clip">
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
                  <div className="wcf-clip-sub">shared by {c.submitter?.display_name ?? "someone"}</div>
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
            ))}
          </>
        )}

        {tab === "lineup" && (
          <>
            {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}
            {nextGame && (
              <>
                <div className="wcf-lineup-head">
                  <div className="wcf-venue">{nextGame.venue}</div>
                  <div className="wcf-pitch">{fmtDate(nextGame.date)} · {nextGame.kickoff}</div>
                </div>
                {nextConfirmed.length === 0 && <p className="wcf-empty">No one&apos;s booked in yet.</p>}
                {nextConfirmed.map((b) => (
                  <div key={b.id} className="wcf-lineup-row">
                    <span className="wcf-lineup-name">{b.player.display_name}</span>
                    {isAdmin ? (
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
                    ) : (
                      <span
                        className="wcf-lineup-badge"
                        style={
                          b.team === "white"
                            ? { background: cs.team_white_color, color: readableTextColor(cs.team_white_color) }
                            : b.team === "red"
                            ? { background: cs.team_red_color, color: readableTextColor(cs.team_red_color) }
                            : undefined
                        }
                      >
                        {b.team === "white" ? cs.team_white_name : b.team === "red" ? cs.team_red_name : "Unassigned"}
                      </span>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === "results" && (
          <>
            <div className="wcf-subtabs">
              <button className={resultsView === "season" ? "active" : ""} onClick={() => setResultsView("season")}>Season</button>
              <button className={resultsView === "table" ? "active" : ""} onClick={() => setResultsView("table")}>Table</button>
              <button className={resultsView === "fixtures" ? "active" : ""} onClick={() => setResultsView("fixtures")}>Fixtures</button>
            </div>

            {resultsView === "season" && (
              <>
                {clubSettings?.record_holder_name && (
                  <div className="wcf-shoutout">
                    🏆 Most goals in a game — <strong>{clubSettings.record_holder_name}</strong> ({clubSettings.record_goals})
                    {clubSettings.record_note ? ` · ${clubSettings.record_note}` : ""}
                  </div>
                )}

                {(headToHead.white.played > 0 || headToHead.red.played > 0) && (
                  <div className="wcf-h2h">
                    <div className="wcf-h2h-title">{cs.team_white_name} v {cs.team_red_name}</div>
                    <div className="wcf-h2h-row wcf-h2h-header">
                      <span>Team</span><span>P</span><span>W</span><span>D</span><span>L</span><span>Pts</span>
                    </div>
                    {([["white", headToHead.white, cs.team_white_name, cs.team_white_color], ["red", headToHead.red, cs.team_red_name, cs.team_red_color]] as const).map(
                      ([key, row, name, color]) => (
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
                    <span className="wcf-board-name">{row.name}{row.id === myId ? " (you)" : ""}</span>
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
                    </article>
                  );
                })}
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
            onRename={renameSelf}
            onSetRole={setRole}
            onDeleteProfile={deleteProfile}
            onSaveClubSettings={saveClubSettings}
            onSignOut={signOut}
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

const ROLE_LABEL: Record<Role, string> = { player: "Player", admin: "Admin", owner: "Owner" };

function AccountPanel({
  profile,
  email,
  isAdmin,
  isOwner,
  profiles,
  clubSettings,
  onRename,
  onSetRole,
  onDeleteProfile,
  onSaveClubSettings,
  onSignOut,
}: {
  profile: Profile;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  profiles: Profile[];
  clubSettings: ClubSettings;
  onRename: (name: string) => void;
  onSetRole: (id: string, role: Role) => void;
  onDeleteProfile: (id: string, name: string) => void;
  onSaveClubSettings: (patch: Partial<ClubSettings>) => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState(profile.display_name);

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
          <button onClick={() => onRename(name)} disabled={!name.trim() || name.trim() === profile.display_name}>
            Save
          </button>
        </div>
      </label>

      <button className="wcf-signout" onClick={onSignOut}>Sign out</button>

      {isAdmin && (
        <div className="wcf-roles">
          <h3>Manage roles</h3>
          {profiles.map((p) => {
            const isSelf = p.id === profile.id;
            // Owner rows are fully protected in the UI. Admins can only
            // touch player rows; only the owner can manage other admins.
            const canManageRole = p.role === "owner" ? false : p.role === "player" ? true : isOwner;
            const canDelete = p.role !== "owner" && !isSelf && (p.role === "player" || isOwner);
            return (
              <div key={p.id} className="wcf-roles-row">
                <span>{p.display_name}{isSelf ? " (you)" : ""} <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span></span>
                <div className="wcf-roles-actions">
                  {canManageRole && (
                    <button
                      className="wcf-ghost"
                      onClick={() => {
                        if (p.role === "admin") {
                          const msg = isSelf
                            ? "Remove your own admin access? You'll need the owner (or the SQL Editor) to get it back."
                            : `Remove admin access from ${p.display_name}?`;
                          if (confirm(msg)) onSetRole(p.id, "player");
                        } else {
                          onSetRole(p.id, "admin");
                        }
                      }}
                    >
                      {p.role === "admin" ? "Remove admin" : "Make admin"}
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
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAdmin && <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />}
    </div>
  );
}

function ClubSettingsForm({ settings, onSave }: { settings: ClubSettings; onSave: (patch: Partial<ClubSettings>) => void }) {
  const [form, setForm] = useState(settings);

  useEffect(() => setForm(settings), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

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
      </div>

      <h4 className="wcf-edit-subhead">Most goals in a game (shoutout)</h4>
      <div className="wcf-team-settings">
        <label className="wcf-team-field">
          Player name
          <input
            value={form.record_holder_name ?? ""}
            onChange={(e) => setForm({ ...form, record_holder_name: e.target.value || null })}
          />
        </label>
        <label className="wcf-team-field narrow">
          Goals
          <input
            type="number"
            min={0}
            value={form.record_goals ?? ""}
            onChange={(e) => setForm({ ...form, record_goals: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        <label className="wcf-team-field wide">
          Note (optional)
          <input
            value={form.record_note ?? ""}
            onChange={(e) => setForm({ ...form, record_note: e.target.value || null })}
            placeholder="e.g. vs Bidston Astro, March 2026"
          />
        </label>
      </div>

      <button className="wcf-save" onClick={() => onSave(form)} disabled={!dirty}>Save settings</button>
    </div>
  );
}

function AdminConsole({
  upcoming,
  previous,
  overdue,
  goalRows,
  cs,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onAdjustGoal,
  onRemoveBooking,
  onDeleteGame,
  onSaveTeamScore,
}: {
  upcoming: GameRow[];
  previous: GameRow[];
  overdue: { booking: BookingRow; game: GameRow }[];
  goalRows: GoalRow[];
  cs: ClubSettings;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onAdjustGoal: (gameId: string, playerId: string, delta: number) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveTeamScore: (gameId: string, side: "team_white_score" | "team_red_score", value: number | null) => void;
}) {
  const shared = { goalRows, cs, expandedId, onToggleExpand, onSetStatus, onAdjustGoal, onRemoveBooking, onDeleteGame, onSaveTeamScore };
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
  expandedId,
  onToggleExpand,
  onSetStatus,
  onAdjustGoal,
  onRemoveBooking,
  onDeleteGame,
  onSaveTeamScore,
}: {
  game: GameRow;
  past: boolean;
  goalRows: GoalRow[];
  cs: ClubSettings;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onAdjustGoal: (gameId: string, playerId: string, delta: number) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveTeamScore: (gameId: string, side: "team_white_score" | "team_red_score", value: number | null) => void;
}) {
  const expanded = expandedId === game.id;
  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const goalsByPlayer: Record<string, number> = {};
  goalRows.filter((r) => r.game_id === game.id).forEach((r) => (goalsByPlayer[r.player_id] = r.goals));
  const [whiteScore, setWhiteScore] = useState(game.team_white_score?.toString() ?? "");
  const [redScore, setRedScore] = useState(game.team_red_score?.toString() ?? "");
  useEffect(() => {
    setWhiteScore(game.team_white_score?.toString() ?? "");
    setRedScore(game.team_red_score?.toString() ?? "");
  }, [game.team_white_score, game.team_red_score]);

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
              <input
                type="number"
                min={0}
                value={whiteScore}
                onChange={(e) => setWhiteScore(e.target.value)}
                onBlur={() => onSaveTeamScore(game.id, "team_white_score", whiteScore === "" ? null : Number(whiteScore))}
              />
              <span className="wcf-admin-score-dash">–</span>
              <input
                type="number"
                min={0}
                value={redScore}
                onChange={(e) => setRedScore(e.target.value)}
                onBlur={() => onSaveTeamScore(game.id, "team_red_score", redScore === "" ? null : Number(redScore))}
              />
              <span>{cs.team_red_name}</span>
            </div>
          )}
          {confirmed.length === 0 && <p className="wcf-empty small">No one booked in.</p>}
          {confirmed.map((b) => (
            <div key={b.id} className="wcf-admin-player-row">
              <span className="wcf-admin-player-name">{b.player.display_name}</span>
              <div className="wcf-admin-status">
                <StatusBadge status={b.status} />
                {b.status !== "confirmed" ? (
                  <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Approve</button>
                ) : (
                  <button className="wcf-admin-undo" onClick={() => onSetStatus(b.id, "unpaid")}>Undo</button>
                )}
              </div>
              <div className="wcf-admin-goals">
                <button onClick={() => onAdjustGoal(game.id, b.player_id, -1)} disabled={(goalsByPlayer[b.player_id] ?? 0) <= 0}>−</button>
                <span>{goalsByPlayer[b.player_id] ?? 0}</span>
                <button onClick={() => onAdjustGoal(game.id, b.player_id, 1)}>+</button>
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
  editing: boolean;
  onBook: () => void;
  onCancel: (bookingId: string) => void;
  onMarkPaid: (bookingId: string) => void;
  onEdit: () => void;
  onSave: (patch: Partial<GameRow>) => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState<GameRow>(game);

  useEffect(() => setForm(game), [game, editing]);

  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const myBooking = game.bookings.find((b) => b.player_id === myId);
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
          <div className="wcf-venue">{game.venue}</div>
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
          <div className="wcf-waiting-label">Waiting list</div>
          {waitingList.map((b, i) => (
            <div key={b.id} className="wcf-waiting-row">
              <span>{i + 1}. {b.player.display_name}</span>
              {b.player_id === myId && <span className="wcf-waiting-you">you</span>}
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
                  ? `Tap Pay Now to pay with ${PAYMENT_PROVIDER_LABEL}, then press I've paid.`
                  : `Pay your organiser £${game.price} via ${PAYMENT_PROVIDER_LABEL}, then press I've paid.`}
              </p>
              <div className="wcf-payment-actions">
                {PAYMENT_LINK && (
                  <a className="wcf-pay-now" href={PAYMENT_LINK} target="_blank" rel="noreferrer">
                    Pay Now with {PAYMENT_PROVIDER_LABEL}
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
        <button
          className={"wcf-book " + (myBooking ? "cancel" : "")}
          onClick={() => {
            if (!myBooking) return onBook();
            if (confirm(myBooking.waiting ? "Leave the waiting list?" : "Give up your spot in this game?")) onCancel(myBooking.id);
          }}
        >
          {myBooking ? (myBooking.waiting ? "Leave waiting list" : "Give up spot") : full ? "Join waiting list" : "Grab a spot"}
        </button>
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
            <input value={form.kickoff} onChange={(e) => setForm({ ...form, kickoff: e.target.value })} />
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
            Max players
            <input
              type="number"
              max={MAX_SPOTS}
              value={form.max_players}
              onChange={(e) => setForm({ ...form, max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
            />
          </label>
          <button className="wcf-save" onClick={() => onSave(form)}>Save changes</button>
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
  max-width:520px;margin:0 auto;min-height:100vh;background:var(--bg);
  color:var(--white);font-family:var(--sans);display:flex;flex-direction:column;
  border-left:1px solid var(--line);border-right:1px solid var(--line);
}
.wcf-root *{box-sizing:border-box}
.wcf-root path{stroke-linecap:round}

.wcf-splash{flex:1;min-height:100vh;display:flex;align-items:center;justify-content:center}
.wcf-splash .wcf-logo.big{width:96px;height:96px;border-radius:24px}

.wcf-signin{flex:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center}
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

.wcf-waiting{margin:0 0 14px;padding:10px 12px;background:rgba(224,167,51,.08);border:1px dashed rgba(224,167,51,.4);border-radius:10px}
.wcf-waiting-label{font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--amber);margin-bottom:6px}
.wcf-waiting-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dim);padding:2px 0}
.wcf-waiting-row span:first-child{flex:1}
.wcf-waiting-you{color:var(--amber);font-weight:700;font-size:10px;text-transform:uppercase}
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
.wcf-admin-player-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wcf-admin-player-row:last-child{border-bottom:none}
.wcf-admin-player-name{flex:1;min-width:90px;font-weight:700;font-size:13px}
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

.wcf-clip-form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wcf-clip-form input{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-clip-form button{background:var(--red);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-clip-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-clip{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px;align-items:center}
.wcf-clip-thumb{width:74px;height:52px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,var(--panel2),var(--bg));display:grid;place-items:center;color:var(--red-hi);font-size:16px;border:1px solid var(--line)}
.wcf-clip-body{flex:1;min-width:0}
.wcf-clip-title{font-weight:800;font-size:14px}
.wcf-clip-sub{font-size:11px;color:var(--dim);margin-top:3px;font-family:var(--mono)}
.wcf-clip-del{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;flex:0 0 auto;line-height:1}
.wcf-clip-del:hover{color:var(--red-hi)}

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
.wcf-board-count{font-family:var(--mono);font-weight:700;color:var(--blue);width:44px;text-align:right}

.wcf-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--blue)}
.wcf-avatar.big{width:44px;height:44px;font-size:18px}

.wcf-lineup-head{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-lineup-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:9px}
.wcf-lineup-name{font-weight:700;font-size:14px}
.wcf-lineup-picks{display:flex;gap:6px}
.wcf-lineup-pick{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 11px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}
.wcf-lineup-badge{font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}

.wcf-shoutout{background:linear-gradient(135deg,rgba(228,42,54,.16),rgba(51,169,87,.1));border:1px solid rgba(228,42,54,.35);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5}
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

.wcf-account{display:flex;flex-direction:column;gap:16px}
.wcf-account-card{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.wcf-account-name{font-weight:800;font-size:15px}
.wcf-account-email{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-role-badge{margin-left:auto;font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-role-badge.admin{color:var(--green);border:1px solid rgba(51,169,87,.4)}
.wcf-role-badge.owner{color:var(--red-hi);border:1px solid rgba(228,42,54,.4)}
.wcf-role-badge.small{margin-left:4px;padding:2px 7px;font-size:9px}
.wcf-account-field{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-account-rename{display:flex;gap:8px}
.wcf-account-rename input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:10px;border-radius:9px;font-size:13px;font-family:var(--sans);text-transform:none}
.wcf-account-rename button{background:var(--red);color:#fff;border:none;padding:0 14px;border-radius:9px;font-weight:800;cursor:pointer}
.wcf-account-rename button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signout{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:700;cursor:pointer}
.wcf-signout:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}
.wcf-roles{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.wcf-roles h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-roles-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wcf-roles-row:last-child{border-bottom:none}
.wcf-roles-actions{display:flex;gap:6px;flex:0 0 auto}

.wcf-club-settings{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-top:16px}
.wcf-club-settings h3{margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-team-settings{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:6px}
.wcf-team-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-team-field.wide{grid-column:1/-1}
.wcf-team-field input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:13px;font-family:var(--sans);text-transform:none}
.wcf-team-field.color input{width:52px;padding:2px;height:38px;cursor:pointer}
.wcf-team-field.narrow input{width:70px}
.wcf-club-settings .wcf-save{margin-top:10px}
.wcf-club-settings .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px))}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-sheet{grid-template-columns:1fr} .wcf-edit{grid-template-columns:1fr} }
`;
