"use client";

import { useEffect, useMemo, useState } from "react";

interface Player {
  id: string;
  name: string;
}

interface Game {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  maxPlayers: number;
  players: Player[];
}

interface Clip {
  id: string;
  title: string;
  game: string;
  by: string;
}

interface Post {
  id: string;
  by: string;
  text: string;
  likes: number;
}

interface GameCardProps {
  game: Game;
  booked: boolean;
  isAdmin: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onSave: (patch: Partial<Game>) => void;
  onDelete: () => void;
}

const CURRENT_USER: Player = { id: "u_you", name: "You" };
const MAX_SPOTS = 16;

const seedGames: Game[] = [
  {
    id: "g1",
    date: "2026-08-06",
    kickoff: "19:30",
    venue: "Leasowe Rec",
    pitch: "8-a-side · Astro",
    price: 6,
    maxPlayers: 16,
    players: ["Marcus", "Deniz", "Sam", "Theo", "Jay", "Leon", "Ollie", "Craig", "Ste", "Danny"].map((n) => ({ id: "u_" + n.toLowerCase(), name: n })),
  },
  {
    id: "g2",
    date: "2026-08-10",
    kickoff: "11:00",
    venue: "Wallasey Leisure Centre",
    pitch: "7-a-side · Grass",
    price: 5,
    maxPlayers: 16,
    players: ["Marcus", "Deniz", "Nadia", "Sam", "Craig"].map((n) => ({ id: "u_" + n.toLowerCase(), name: n })),
  },
  {
    id: "g3",
    date: "2026-08-13",
    kickoff: "20:00",
    venue: "Bidston Astro",
    pitch: "6-a-side · Pitch 1",
    price: 6,
    maxPlayers: 16,
    players: [],
  },
];

const seedClips: Clip[] = [
  { id: "c1", title: "Sam's worldie vs the Tuesday lot", game: "Leasowe · 30 Jul", by: "Marcus" },
  { id: "c2", title: "Nadia nutmeg + finish", game: "Wallasey LC · 27 Jul", by: "Deniz" },
];

const seedPosts: Post[] = [
  { id: "p1", by: "Marcus", text: "Cracking game last night. Whoever left the bibs — they're in my car.", likes: 4 },
  { id: "p2", by: "Deniz", text: "Need two more for Sunday 7s, who's about?", likes: 2 },
];

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
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
  const [games, setGames] = useState<Game[]>(seedGames);
  const [clips, setClips] = useState<Clip[]>(seedClips);
  const [posts, setPosts] = useState<Post[]>(seedPosts);
  const [tab, setTab] = useState<"fixtures" | "clips" | "table" | "feed">("fixtures");
  const [isAdmin, setIsAdmin] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const isBooked = (g: Game) => g.players.some((p) => p.id === CURRENT_USER.id);

  function toggleBooking(gameId: string) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const already = g.players.some((p) => p.id === CURRENT_USER.id);
        if (already) return { ...g, players: g.players.filter((p) => p.id !== CURRENT_USER.id) };
        if (g.players.length >= g.maxPlayers) return g;
        return { ...g, players: [...g.players, CURRENT_USER] };
      })
    );
  }

  const updateGame = (id: string, patch: Partial<Game>) => setGames((p) => p.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const deleteGame = (id: string) => setGames((p) => p.filter((g) => g.id !== id));

  function addGame() {
    const id = `g_${Date.now()}`;
    setGames((p) => [...p, { id, date: "2026-08-20", kickoff: "19:00", venue: "New venue", pitch: "8-a-side", price: 6, maxPlayers: MAX_SPOTS, players: [] }]);
    setEditingId(id);
  }

  function addPost() {
    if (!draft.trim()) return;
    setPosts((p) => [{ id: `p${Date.now()}`, by: CURRENT_USER.name, text: draft.trim(), likes: 0 }, ...p]);
    setDraft("");
  }

  const likePost = (id: string) => setPosts((p) => p.map((x) => (x.id === id ? { ...x, likes: x.likes + 1 } : x)));

  const leaderboard = useMemo(
    () => {
      const tally: Record<string, number> = {};
      games.forEach((g) => g.players.forEach((p) => {
        tally[p.name] = (tally[p.name] || 0) + 1;
      }));
      return Object.entries(tally)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    },
    [games]
  );

  const TABS = [
    { k: "fixtures", label: "Fixtures", icon: Icon.cal },
    { k: "clips", label: "Clips", icon: Icon.play },
    { k: "table", label: "Table", icon: Icon.star },
    { k: "feed", label: "Feed", icon: Icon.chat },
  ] as const;

  const heading = { fixtures: "Upcoming fixtures", clips: "Match clips", table: "Attendance table", feed: "Team feed" }[tab];

  return (
    <div className="wcf-root">
      <style>{css}</style>

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
          className={"wcf-role " + (isAdmin ? "on" : "")}
          onClick={() => {
            setIsAdmin((v) => !v);
            setEditingId(null);
          }}
          title="In the real app this comes from your account's role in the database"
        >
          <span className="dot" />{isAdmin ? "Admin" : "Player"}
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
                booked={isBooked(g)}
                isAdmin={isAdmin}
                editing={editingId === g.id}
                onToggle={() => toggleBooking(g.id)}
                onEdit={() => setEditingId(editingId === g.id ? null : g.id)}
                onSave={(patch) => {
                  updateGame(g.id, patch);
                  setEditingId(null);
                }}
                onDelete={() => deleteGame(g.id)}
              />
            ))}
          </>
        )}

        {tab === "clips" && (
          <>
            {isAdmin && (
              <button
                className="wcf-add"
                onClick={() =>
                  setClips((c) => [
                    { id: `c${Date.now()}`, title: "New clip", game: "Paste a YouTube link", by: CURRENT_USER.name },
                    ...c,
                  ])
                }
              >
                + Add clip
              </button>
            )}
            {clips.map((c) => (
              <article key={c.id} className="wcf-clip">
                <div className="wcf-clip-thumb">
                  <span>▶</span>
                </div>
                <div>
                  <div className="wcf-clip-title">{c.title}</div>
                  <div className="wcf-clip-sub">{c.game} · shared by {c.by}</div>
                </div>
              </article>
            ))}
          </>
        )}

        {tab === "table" && (
          <div className="wcf-board">
            <p className="wcf-board-note">Games played across upcoming fixtures. Top attendees get first dibs on spots.</p>
            {leaderboard.map((row, i) => (
              <div key={row.name} className={"wcf-board-row " + (i === 0 ? "lead" : "")}> 
                <span className="wcf-rank">{i === 0 ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                <span className="wcf-board-name">{row.name}</span>
                <span className="wcf-board-count">{row.count}</span>
              </div>
            ))}
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
            {posts.map((p) => (
              <article key={p.id} className="wcf-post">
                <div className="wcf-post-head">
                  <span className="wcf-avatar">{p.by[0]}</span>
                  <span className="wcf-post-by">{p.by}</span>
                </div>
                <p className="wcf-post-text">{p.text}</p>
                <button className="wcf-like" onClick={() => likePost(p.id)}>
                  ♥ {p.likes}
                </button>
              </article>
            ))}
          </>
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
    </div>
  );
}

function GameCard({ game, booked, isAdmin, editing, onToggle, onEdit, onSave, onDelete }: GameCardProps) {
  const spotsLeft = game.maxPlayers - game.players.length;
  const full = spotsLeft <= 0;
  const [form, setForm] = useState<Game>(game);

  useEffect(() => {
    setForm(game);
  }, [game, editing]);

  return (
    <article className={"wcf-card " + (booked ? "in" : "")}> 
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
          <span className="wcf-count-n">{game.players.length}/{game.maxPlayers}</span>
          <span className="wcf-count-l">{full ? "Full" : `${spotsLeft} left`}</span>
        </div>
      </div>

      <div className="wcf-sheet">
        {Array.from({ length: game.maxPlayers }).map((_, i) => {
          const p = game.players[i];
          return (
            <div key={i} className={"wcf-slot " + (p ? "taken" : "")}> 
              <span className="wcf-slot-num">{i + 1}</span>
              <span className="wcf-slot-name">{p ? p.name : "—"}</span>
            </div>
          );
        })}
      </div>

      <div className="wcf-card-actions">
        <button className={"wcf-book " + (booked ? "cancel" : "")} onClick={onToggle} disabled={full && !booked}>
          {booked ? "Give up spot" : full ? "Full" : "Grab a spot"}
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
              value={form.maxPlayers}
              onChange={(e) => setForm({
                ...form,
                maxPlayers: Math.min(MAX_SPOTS, Number(e.target.value) || 0),
              })}
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
  --red:#E42A36; --red-hi:#F53A46; --blue:#2E74CC; --green:#33A957;
  --mono:ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  max-width:520px;margin:0 auto;min-height:100vh;background:var(--bg);
  color:var(--white);font-family:var(--sans);display:flex;flex-direction:column;
  border-left:1px solid var(--line);border-right:1px solid var(--line);
}
.wcf-root *{box-sizing:border-box}
.wcf-root path{stroke-linecap:round}

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
  font-family:var(--mono);letter-spacing:.5px;transition:.15s}
.wcf-role .dot{width:8px;height:8px;border-radius:50%;background:var(--dim)}
.wcf-role.on{color:#fff;background:var(--red);border-color:var(--red)}
.wcf-role.on .dot{background:#fff}

.wcf-main{flex:1;padding:14px 14px 92px;overflow-y:auto}
.wcf-heading{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 14px}
.wcf-heading h2{margin:0;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim)}
.wcf-addbtn{background:var(--red);color:#fff;border:none;padding:7px 13px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-empty{color:var(--dim);text-align:center;padding:40px 0;font-size:14px}
.wcf-add{width:100%;background:transparent;border:1px dashed var(--line);color:var(--red-hi);
  padding:12px;border-radius:12px;font-weight:800;cursor:pointer;margin-bottom:14px;font-size:13px}

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
.wcf-slot-name{color:var(--dim)}
.wcf-slot.taken .wcf-slot-name{color:var(--white)}
.wcf-slot.taken .wcf-slot-num{color:var(--green);border-color:rgba(51,169,87,.5)}

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

.wcf-clip{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px;align-items:center}
.wcf-clip-thumb{width:74px;height:52px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,var(--panel2),var(--bg));display:grid;place-items:center;color:var(--red-hi);font-size:16px;border:1px solid var(--line)}
.wcf-clip-title{font-weight:800;font-size:14px}
.wcf-clip-sub{font-size:11px;color:var(--dim);margin-top:3px;font-family:var(--mono)}

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
.wcf-post-by{font-weight:800;font-size:13px}
.wcf-post-text{font-size:14px;line-height:1.45;margin:0 0 9px;color:#dbe5f4}
.wcf-like{background:transparent;border:1px solid var(--line);color:var(--dim);padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--mono)}
.wcf-like:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px))}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-sheet{grid-template-columns:1fr} .wcf-edit{grid-template-columns:1fr} }
`;
