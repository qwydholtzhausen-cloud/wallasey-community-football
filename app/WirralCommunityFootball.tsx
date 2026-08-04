"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";

// TODO: swap in the real Revolut handle/link before going live with payments.
const REVOLUT_HANDLE = "@your-revolut-handle";
const MAX_SPOTS = 16;

type Role = "player" | "admin";
type PayStatus = "unpaid" | "pending" | "confirmed";

interface Profile {
  id: string;
  display_name: string;
  role: Role;
}

interface BookingRow {
  id: string;
  player_id: string;
  status: PayStatus;
  waiting: boolean;
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
  bookings: BookingRow[];
}

interface ClipRow {
  id: string;
  title: string;
  video_url: string | null;
  created_at: string;
  submitted_by: string | null;
  submitter: Profile | null;
}

interface PostRow {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  author: Profile;
  post_likes: { user_id: string }[];
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
  chat: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 5.5h16v11H9l-4 3.5v-3.5H4z" strokeLinejoin="round" />
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
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined },
    });
    setSending(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="wcf-signin">
      <span className="wcf-logo big">
        <img src="/logo.png" alt="Wirral Community Football crest" />
      </span>
      <div className="wcf-wordmark">WIRRAL</div>
      <div className="wcf-wordmark-sub">COMMUNITY FOOTBALL</div>

      {sent ? (
        <p className="wcf-signin-sent">
          Check <strong>{email}</strong> for a sign-in link.
        </p>
      ) : (
        <form className="wcf-signin-form" onSubmit={sendLink}>
          <input
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" disabled={sending || !email.trim()}>
            {sending ? "Sending…" : "Send sign-in link"}
          </button>
          {error && <p className="wcf-signin-error">{error}</p>}
        </form>
      )}
    </div>
  );
}

function App({ session }: { session: Session }) {
  const myId = session.user.id;
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [goalRows, setGoalRows] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<"fixtures" | "clips" | "table" | "feed" | "account">("fixtures");
  const [tableView, setTableView] = useState<"attendance" | "goals">("attendance");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [clipTitle, setClipTitle] = useState("");
  const [clipUrl, setClipUrl] = useState("");

  const isAdmin = myProfile?.role === "admin";

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
        "id, date, kickoff, venue, pitch, price, max_players, bookings(id, player_id, status, waiting, created_at, player:profiles(id, display_name, role))"
      )
      .order("date", { ascending: true });
    if (data) setGames(data as unknown as GameRow[]);
  }, []);

  const loadClips = useCallback(async () => {
    const { data } = await supabase
      .from("clips")
      .select("id, title, video_url, created_at, submitted_by, submitter:profiles(id, display_name, role)")
      .order("created_at", { ascending: false });
    if (data) setClips(data as unknown as ClipRow[]);
  }, []);

  const loadPosts = useCallback(async () => {
    const { data } = await supabase
      .from("posts")
      .select("id, text, created_at, author_id, author:profiles(id, display_name, role), post_likes(user_id)")
      .order("created_at", { ascending: false });
    if (data) setPosts(data as unknown as PostRow[]);
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
      await Promise.all([loadProfile(), loadProfiles(), loadGames(), loadClips(), loadPosts(), loadGoals()]);
      setLoading(false);
    })();
  }, [loadProfile, loadProfiles, loadGames, loadClips, loadPosts, loadGoals]);

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

  async function book(gameId: string) {
    await supabase.from("bookings").insert({ game_id: gameId, player_id: myId });
  }
  async function cancel(bookingId: string) {
    await supabase.from("bookings").delete().eq("id", bookingId);
  }
  async function markPaid(bookingId: string) {
    await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId);
  }
  async function confirmPayment(bookingId: string) {
    await supabase.from("bookings").update({ status: "confirmed" }).eq("id", bookingId);
  }

  async function addGame() {
    const { data } = await supabase
      .from("games")
      .insert({ date: defaultNewGameDate(), kickoff: "19:00", venue: "New venue", pitch: "8-a-side", price: 6, max_players: MAX_SPOTS })
      .select()
      .single();
    await loadGames();
    if (data) setEditingId(data.id);
  }
  async function saveGame(id: string, patch: Partial<GameRow>) {
    const { bookings: _bookings, ...rest } = patch as GameRow;
    await supabase.from("games").update(rest).eq("id", id);
    await loadGames();
    setEditingId(null);
  }
  async function deleteGame(id: string) {
    await supabase.from("games").delete().eq("id", id);
    await loadGames();
  }
  async function saveGoals(gameId: string, entries: Record<string, number>) {
    const rows = Object.entries(entries).map(([player_id, goals]) => ({ game_id: gameId, player_id, goals }));
    if (rows.length) await supabase.from("game_stats").upsert(rows, { onConflict: "game_id,player_id" });
    await loadGoals();
  }

  async function addClip(e: React.FormEvent) {
    e.preventDefault();
    if (!clipTitle.trim()) return;
    await supabase.from("clips").insert({ title: clipTitle.trim(), video_url: clipUrl.trim() || null, submitted_by: myId });
    setClipTitle("");
    setClipUrl("");
    await loadClips();
  }
  async function deleteClip(id: string) {
    await supabase.from("clips").delete().eq("id", id);
    await loadClips();
  }

  async function addPost() {
    if (!draft.trim()) return;
    await supabase.from("posts").insert({ text: draft.trim(), author_id: myId });
    setDraft("");
    await loadPosts();
  }
  async function deletePost(id: string) {
    await supabase.from("posts").delete().eq("id", id);
    await loadPosts();
  }
  async function toggleLike(post: PostRow) {
    const already = post.post_likes.some((l) => l.user_id === myId);
    if (already) await supabase.from("post_likes").delete().eq("post_id", post.id).eq("user_id", myId);
    else await supabase.from("post_likes").insert({ post_id: post.id, user_id: myId });
    await loadPosts();
  }

  async function renameSelf(name: string) {
    if (!name.trim()) return;
    await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", myId);
    await Promise.all([loadProfile(), loadProfiles()]);
  }
  async function setRole(id: string, role: Role) {
    await supabase.from("profiles").update({ role }).eq("id", id);
    await loadProfiles();
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  const attendanceLeaderboard = useMemo(() => {
    const tally: Record<string, { name: string; count: number }> = {};
    games.forEach((g) =>
      g.bookings
        .filter((b) => !b.waiting)
        .forEach((b) => {
          const cur = tally[b.player_id] ?? { name: b.player.display_name, count: 0 };
          cur.count += 1;
          tally[b.player_id] = cur;
        })
    );
    return Object.values(tally).sort((a, b) => b.count - a.count);
  }, [games]);

  const goalsLeaderboard = useMemo(() => {
    const tally: Record<string, { name: string; count: number }> = {};
    goalRows.forEach((r) => {
      const cur = tally[r.player_id] ?? { name: r.player.display_name, count: 0 };
      cur.count += r.goals;
      tally[r.player_id] = cur;
    });
    return Object.values(tally)
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [goalRows]);

  const TABS = [
    { k: "fixtures", label: "Fixtures", icon: Icon.cal },
    { k: "clips", label: "Clips", icon: Icon.play },
    { k: "table", label: "Table", icon: Icon.star },
    { k: "feed", label: "Feed", icon: Icon.chat },
  ] as const;

  const heading = {
    fixtures: "Upcoming fixtures",
    clips: "Match clips",
    table: tableView === "attendance" ? "Attendance table" : "Goalscorers",
    feed: "Team feed",
    account: "Your account",
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
          {tab === "fixtures" && isAdmin && <button className="wcf-addbtn" onClick={addGame}>+ Fixture</button>}
        </div>

        {tab === "fixtures" && (
          <>
            {games.length === 0 && <p className="wcf-empty">No games on. {isAdmin ? "Add one above." : "Check back soon."}</p>}
            {games.map((g) => (
              <GameCard
                key={g.id}
                game={g}
                myId={myId}
                isAdmin={isAdmin}
                editing={editingId === g.id}
                goals={goalRows.filter((r) => r.game_id === g.id)}
                onBook={() => book(g.id)}
                onCancel={(bookingId) => cancel(bookingId)}
                onMarkPaid={(bookingId) => markPaid(bookingId)}
                onConfirmPayment={(bookingId) => confirmPayment(bookingId)}
                onEdit={() => setEditingId(editingId === g.id ? null : g.id)}
                onSave={(patch) => saveGame(g.id, patch)}
                onDelete={() => deleteGame(g.id)}
                onSaveGoals={(entries) => saveGoals(g.id, entries)}
              />
            ))}
          </>
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
                  <button className="wcf-clip-del" onClick={() => deleteClip(c.id)} aria-label="Delete clip">×</button>
                )}
              </article>
            ))}
          </>
        )}

        {tab === "table" && (
          <div>
            <div className="wcf-subtabs">
              <button className={tableView === "attendance" ? "active" : ""} onClick={() => setTableView("attendance")}>Attendance</button>
              <button className={tableView === "goals" ? "active" : ""} onClick={() => setTableView("goals")}>Goalscorers</button>
            </div>
            <div className="wcf-board">
              {tableView === "attendance" ? (
                <>
                  <p className="wcf-board-note">Confirmed spots across upcoming fixtures. Top attendees get first dibs.</p>
                  {attendanceLeaderboard.map((row, i) => (
                    <div key={row.name} className={"wcf-board-row " + (i === 0 ? "lead" : "")}>
                      <span className="wcf-rank">{i === 0 ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                      <span className="wcf-board-name">{row.name}</span>
                      <span className="wcf-board-count">{row.count}</span>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p className="wcf-board-note">Goals logged by admins after each game.</p>
                  {goalsLeaderboard.length === 0 && <p className="wcf-empty">No goals logged yet.</p>}
                  {goalsLeaderboard.map((row, i) => (
                    <div key={row.name} className={"wcf-board-row " + (i === 0 ? "lead" : "")}>
                      <span className="wcf-rank">{i === 0 ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                      <span className="wcf-board-name">{row.name}</span>
                      <span className="wcf-board-count">{row.count}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        )}

        {tab === "feed" && (
          <>
            <div className="wcf-compose">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPost()}
                placeholder="Say something to the group…"
              />
              <button onClick={addPost} disabled={!draft.trim()}>
                Post
              </button>
            </div>
            {posts.map((p) => {
              const liked = p.post_likes.some((l) => l.user_id === myId);
              return (
                <article key={p.id} className="wcf-post">
                  <div className="wcf-post-head">
                    <span className="wcf-avatar">{p.author.display_name[0]}</span>
                    <span className="wcf-post-by">{p.author.display_name}</span>
                    {(p.author_id === myId || isAdmin) && (
                      <button className="wcf-post-del" onClick={() => deletePost(p.id)} aria-label="Delete post">×</button>
                    )}
                  </div>
                  <p className="wcf-post-text">{p.text}</p>
                  <button className={"wcf-like " + (liked ? "liked" : "")} onClick={() => toggleLike(p)}>
                    ♥ {p.post_likes.length}
                  </button>
                </article>
              );
            })}
          </>
        )}

        {tab === "account" && (
          <AccountPanel
            profile={myProfile}
            email={session.user.email ?? ""}
            isAdmin={isAdmin}
            profiles={profiles}
            onRename={renameSelf}
            onSetRole={setRole}
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

function AccountPanel({
  profile,
  email,
  isAdmin,
  profiles,
  onRename,
  onSetRole,
  onSignOut,
}: {
  profile: Profile;
  email: string;
  isAdmin: boolean;
  profiles: Profile[];
  onRename: (name: string) => void;
  onSetRole: (id: string, role: Role) => void;
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
        <span className={"wcf-role-badge " + profile.role}>{profile.role === "admin" ? "Admin" : "Player"}</span>
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
          {profiles.map((p) => (
            <div key={p.id} className="wcf-roles-row">
              <span>{p.display_name}{p.id === profile.id ? " (you)" : ""}</span>
              <button className="wcf-ghost" onClick={() => onSetRole(p.id, p.role === "admin" ? "player" : "admin")}>
                {p.role === "admin" ? "Remove admin" : "Make admin"}
              </button>
            </div>
          ))}
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
  goals,
  onBook,
  onCancel,
  onMarkPaid,
  onConfirmPayment,
  onEdit,
  onSave,
  onDelete,
  onSaveGoals,
}: {
  game: GameRow;
  myId: string;
  isAdmin: boolean;
  editing: boolean;
  goals: GoalRow[];
  onBook: () => void;
  onCancel: (bookingId: string) => void;
  onMarkPaid: (bookingId: string) => void;
  onConfirmPayment: (bookingId: string) => void;
  onEdit: () => void;
  onSave: (patch: Partial<GameRow>) => void;
  onDelete: () => void;
  onSaveGoals: (entries: Record<string, number>) => void;
}) {
  const [form, setForm] = useState<GameRow>(game);
  const [goalDraft, setGoalDraft] = useState<Record<string, number>>({});

  useEffect(() => setForm(game), [game, editing]);
  useEffect(() => {
    const seeded: Record<string, number> = {};
    goals.forEach((g) => (seeded[g.player_id] = g.goals));
    setGoalDraft(seeded);
  }, [goals, editing]);

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
            </div>
          ))}
        </div>
      )}

      {myBooking && !myBooking.waiting && (
        <div className={"wcf-payment " + myBooking.status}>
          {myBooking.status === "unpaid" && (
            <>
              <p>Secure your spot — send £{game.price} to <strong>{REVOLUT_HANDLE}</strong> on Revolut.</p>
              <button onClick={() => onMarkPaid(myBooking.id)}>I&apos;ve paid</button>
            </>
          )}
          {myBooking.status === "pending" && <p>Payment marked as sent — waiting on admin to confirm.</p>}
          {myBooking.status === "confirmed" && <p>✓ Payment confirmed</p>}
        </div>
      )}

      <div className="wcf-card-actions">
        <button className={"wcf-book " + (myBooking ? "cancel" : "")} onClick={() => (myBooking ? onCancel(myBooking.id) : onBook())}>
          {myBooking ? (myBooking.waiting ? "Leave waiting list" : "Give up spot") : full ? "Join waiting list" : "Grab a spot"}
        </button>
        {isAdmin && (
          <div className="wcf-admin-actions">
            <button className="wcf-ghost" onClick={onEdit}>{editing ? "Close" : "Edit"}</button>
            <button className="wcf-ghost danger" onClick={onDelete}>Delete</button>
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

          {confirmed.length > 0 && (
            <>
              <h4 className="wcf-edit-subhead">Payments</h4>
              {confirmed.map((b) => (
                <div key={b.id} className="wcf-payment-row">
                  <span>{b.player.display_name}</span>
                  <span className={"wcf-pay-badge " + b.status}>{b.status}</span>
                  {b.status !== "confirmed" && (
                    <button className="wcf-ghost" onClick={() => onConfirmPayment(b.id)}>Confirm</button>
                  )}
                </div>
              ))}

              <h4 className="wcf-edit-subhead">Log goals</h4>
              {confirmed.map((b) => (
                <label key={b.id} className="wcf-goal-row">
                  {b.player.display_name}
                  <input
                    type="number"
                    min={0}
                    value={goalDraft[b.player_id] ?? 0}
                    onChange={(e) => setGoalDraft((g) => ({ ...g, [b.player_id]: Number(e.target.value) || 0 }))}
                  />
                </label>
              ))}
              <button className="wcf-save" onClick={() => onSaveGoals(goalDraft)}>Save goals</button>
            </>
          )}
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
.wcf-signin-sent{color:var(--dim);font-size:14px;max-width:280px;margin-top:24px;line-height:1.5}

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
.wcf-waiting-row{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dim);padding:2px 0}
.wcf-waiting-you{color:var(--amber);font-weight:700;font-size:10px;text-transform:uppercase}

.wcf-payment{margin:0 0 14px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--panel2);border:1px solid var(--line)}
.wcf-payment p{margin:0 0 8px}
.wcf-payment.confirmed{border-color:rgba(51,169,87,.5)}
.wcf-payment.confirmed p{margin:0;color:var(--green);font-weight:700}
.wcf-payment.pending p{margin:0;color:var(--amber)}
.wcf-payment button{background:var(--red);color:#fff;border:none;padding:9px 14px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer}

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
.wcf-edit-subhead{grid-column:1/-1;margin:8px 0 0;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-payment-row{grid-column:1/-1;display:flex;align-items:center;gap:10px;font-size:13px;padding:4px 0}
.wcf-payment-row span:first-child{flex:1}
.wcf-pay-badge{font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:3px 7px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-pay-badge.pending{color:var(--amber)}
.wcf-pay-badge.confirmed{color:var(--green)}
.wcf-goal-row{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;text-transform:none;font-weight:400;color:var(--white)}
.wcf-goal-row input{width:64px;background:var(--bg);border:1px solid var(--line);color:var(--white);padding:7px;border-radius:8px;font-size:13px}

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
.wcf-rank{font-family:var(--mono);font-weight:700;color:var(--dim);width:26px;text-align:center;display:grid;place-items:center}
.wcf-rank-star{color:var(--green);display:grid;place-items:center}
.wcf-rank-star svg{width:20px;height:20px;fill:var(--green);stroke:var(--green)}
.wcf-board-name{flex:1;font-weight:800;font-size:14px}
.wcf-board-count{font-family:var(--mono);font-weight:700;color:var(--blue)}

.wcf-compose{display:flex;gap:8px;margin-bottom:16px}
.wcf-compose input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-compose button{background:var(--red);color:#fff;border:none;padding:0 16px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-compose button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-post{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px;margin-bottom:11px}
.wcf-post-head{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.wcf-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--blue)}
.wcf-avatar.big{width:44px;height:44px;font-size:18px}
.wcf-post-by{font-weight:800;font-size:13px;flex:1}
.wcf-post-del{background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;line-height:1}
.wcf-post-del:hover{color:var(--red-hi)}
.wcf-post-text{font-size:14px;line-height:1.45;margin:0 0 9px;color:#dbe5f4}
.wcf-like{background:transparent;border:1px solid var(--line);color:var(--dim);padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--mono)}
.wcf-like:hover,.wcf-like.liked{color:var(--red-hi);border-color:rgba(228,42,54,.5)}

.wcf-account{display:flex;flex-direction:column;gap:16px}
.wcf-account-card{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.wcf-account-name{font-weight:800;font-size:15px}
.wcf-account-email{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-role-badge{margin-left:auto;font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-role-badge.admin{color:var(--green);border:1px solid rgba(51,169,87,.4)}
.wcf-account-field{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-account-rename{display:flex;gap:8px}
.wcf-account-rename input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:10px;border-radius:9px;font-size:13px;font-family:var(--sans);text-transform:none}
.wcf-account-rename button{background:var(--red);color:#fff;border:none;padding:0 14px;border-radius:9px;font-weight:800;cursor:pointer}
.wcf-account-rename button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signout{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:700;cursor:pointer}
.wcf-signout:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}
.wcf-roles{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.wcf-roles h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-roles-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;font-size:13px;border-bottom:1px solid var(--line)}
.wcf-roles-row:last-child{border-bottom:none}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px))}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-sheet{grid-template-columns:1fr} .wcf-edit{grid-template-columns:1fr} }
`;
