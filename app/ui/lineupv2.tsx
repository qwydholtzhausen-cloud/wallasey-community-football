"use client";

import { useMemo, useState } from "react";
import { Avatar, readableTextColor } from "./shared";
import { useCountdown } from "./calmlineup";
import type { BookingRow, GameRow } from "../WirralCommunityFootball";

// Line-up V2 (admins first, LINEUP_V2_OPEN_TO_ALL_FROM): a matchday header
// with a fill bar, the squad numbered in booking order with the waiting
// list, and once teams are out a TV-style team sheet: the WHITES v REDS
// strip, the pitch from the gantry camera with name plates (tap one for a
// caption) and the two teams "on paper". The prediction panel, predictor
// league and admin tools are the existing ones around it.

type Stat = { apps: number; goals: number };
type Token = { booking: BookingRow; isRed: boolean; x: number; y: number; role: string };
type Team = { name: string; color: string };

const firstName = (n: string) => n.trim().split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase());

// "Dan E" and "Dan H" rather than two "Dan"s.
function shortNames(bookings: BookingRow[]): Map<string, string> {
  const count = new Map<string, number>();
  bookings.forEach((b) => count.set(firstName(b.player.display_name), (count.get(firstName(b.player.display_name)) ?? 0) + 1));
  const out = new Map<string, string>();
  bookings.forEach((b) => {
    const f = firstName(b.player.display_name);
    const second = b.player.display_name.trim().split(/\s+/)[1];
    out.set(b.player_id, (count.get(f) ?? 0) > 1 && second ? `${f} ${second[0].toUpperCase()}` : f);
  });
  return out;
}

export function LineupHero({ game, booked, weather }: { game: GameRow; booked: number; weather: string | null }) {
  const cd = useCountdown(game.date, game.kickoff);
  const waiting = game.bookings.filter((b) => b.waiting).length;
  const full = booked >= game.max_players;
  return (
    <section className="lv-hero">
      <div className="ph" />
      <div className="tx">
        <small>Next game · {new Date(game.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</small>
        <b>{game.venue}</b>
        <span className={"when" + (cd.live ? " live" : "")}>
          <i />
          {cd.text}
          {weather ? ` · ${weather}` : ""}
        </span>
        <div className="fill">
          <span className="pips">
            {Array.from({ length: game.max_players }, (_, i) => (
              <i key={i} className={i < booked ? "on" : undefined} />
            ))}
          </span>
          <em>
            {booked}/{game.max_players}
            {full ? " · Full" : ` · ${game.max_players - booked} left`}
            {waiting > 0 ? ` · ${waiting} waiting` : ""}
          </em>
        </div>
      </div>
    </section>
  );
}

export function LineupSquad({
  game,
  confirmed,
  stats,
  myId,
  onOpen,
}: {
  game: GameRow;
  confirmed: BookingRow[];
  stats: Map<string, Stat>;
  myId: string;
  onOpen: (id: string) => void;
}) {
  const squad = useMemo(() => [...confirmed].sort((a, b) => a.created_at.localeCompare(b.created_at)), [confirmed]);
  const waiting = useMemo(() => game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)), [game.bookings]);
  const names = useMemo(() => shortNames([...squad, ...waiting]), [squad, waiting]);
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] ?? "th");
  return (
    <>
      <section className="lv-card">
        <header>
          <h4>The squad</h4>
          <span>In booking order</span>
        </header>
        <div className="lv-grid">
          {squad.map((b, i) => {
            const g = stats.get(b.player_id)?.goals ?? 0;
            return (
              <button key={b.id} className={"lv-p" + (b.player_id === myId ? " me" : "")} onClick={() => onOpen(b.player_id)}>
                <span className="no">{i + 1}</span>
                <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="lv-face" />
                <b>{b.player_id === myId ? "You" : names.get(b.player_id)}</b>
                <small>
                  {g} goal{g === 1 ? "" : "s"}
                </small>
              </button>
            );
          })}
        </div>
        {waiting.length > 0 && (
          <div className="lv-bench">
            <small>Waiting list</small>
            {waiting.map((b, i) => (
              <button key={b.id} className={"bp" + (b.player_id === myId ? " me" : "")} onClick={() => onOpen(b.player_id)}>
                <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="lv-face sm" />
                <b>{b.player_id === myId ? "You" : names.get(b.player_id)}</b>
                <em>{nth(i + 1)}</em>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="lv-soon">
        <div className="ghost" />
        <div className="tx">
          <small>Teams</small>
          <b>Picked before kick-off</b>
          <span>You&apos;ll get a notification when they&apos;re out, then you can predict the score.</span>
        </div>
      </section>
    </>
  );
}

// Formation from the slot roles: "1-3-3-1".
function formation(tokens: Token[]) {
  const n = (r: string) => tokens.filter((t) => t.role === r).length;
  const parts = [n("Goalkeeper"), n("Defence"), n("Midfield"), n("Attack"), n("Outfield")].filter((x) => x > 0);
  return parts.join("-");
}

export function LineupTeams({
  tokens,
  arranged,
  white,
  red,
  stats,
  wins,
  myId,
  onOpen,
}: {
  tokens: Token[];
  arranged: boolean;
  white: Team;
  red: Team;
  stats: Map<string, Stat>;
  wins: Record<string, number>;
  myId: string;
  onOpen: (id: string, team: Team) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const names = useMemo(() => shortNames(tokens.map((t) => t.booking)), [tokens]);
  const reds = useMemo(() => tokens.filter((t) => t.isRed), [tokens]);
  const whites = useMemo(() => tokens.filter((t) => !t.isRed), [tokens]);
  // The tilted pitch squeezes the far half, so the auto formation's rows
  // are re-spaced for it (keeper, then back row to front row), the near
  // side given more room; the two front men stay clear of each other.
  // Positions an admin arranged by hand are kept, just eased away from
  // halfway.
  const yOf = useMemo(() => {
    if (arranged) return (t: Token) => (t.y < 50 ? 4 + t.y * 0.86 : 100 - (4 + (100 - t.y) * 0.86));
    const rowsOf = (list: Token[]) => [...new Set(list.filter((t) => t.role !== "Goalkeeper").map((t) => Math.round(t.y * 10)))].sort((a, b) => a - b);
    const redRows = rowsOf(reds), whiteRows = rowsOf(whites).reverse();
    const lerp = (a: number, b: number, i: number, n: number) => (n <= 1 ? b : a + ((b - a) * i) / (n - 1));
    return (t: Token) => {
      if (t.role === "Goalkeeper") return t.isRed ? 8.5 : 89;
      const rows = t.isRed ? redRows : whiteRows;
      const i = rows.indexOf(Math.round(t.y * 10));
      return t.isRed ? lerp(22.5, 45, i, rows.length) : lerp(78.5, 58, i, rows.length);
    };
  }, [arranged, reds, whites]);
  const sum = (list: Token[], f: (id: string) => number) => list.reduce((a, t) => a + f(t.booking.player_id), 0);
  const rows = [
    { label: "Goals", w: sum(whites, (id) => stats.get(id)?.goals ?? 0), r: sum(reds, (id) => stats.get(id)?.goals ?? 0) },
    { label: "Games won", w: sum(whites, (id) => wins[id] ?? 0), r: sum(reds, (id) => wins[id] ?? 0) },
    { label: "Appearances", w: sum(whites, (id) => stats.get(id)?.apps ?? 0), r: sum(reds, (id) => stats.get(id)?.apps ?? 0) },
  ];
  const pick = tokens.find((t) => t.booking.player_id === picked) ?? null;
  const order = [...whites, ...reds];
  return (
    <>
      <section className="lv-tv">
        <span className="t w">
          <i style={{ background: white.color }} />
          {white.name.toUpperCase()}
        </span>
        <span className="n">{whites.length}</span>
        <span className="v">v</span>
        <span className="n">{reds.length}</span>
        <span className="t r">
          {red.name.toUpperCase()}
          <i style={{ background: red.color }} />
        </span>
      </section>
      <section className="lv-pitch" onClick={() => setPicked(null)}>
        <div className="stand" />
        <div className="beam l" />
        <div className="beam r" />
        <div className="rib top">
          <i style={{ background: red.color }} />
          {red.name.toUpperCase()} · {formation(reds)}
        </div>
        <div className="rib bot">
          <i style={{ background: white.color }} />
          {white.name.toUpperCase()} · {formation(whites)}
        </div>
        <div className="plane">
          <div className="grass" />
          <svg viewBox="0 0 100 160" preserveAspectRatio="none" aria-hidden="true">
            <rect x="3" y="3" width="94" height="154" />
            <line x1="3" y1="80" x2="97" y2="80" />
            <circle cx="50" cy="80" r="13" />
            <rect x="28" y="3" width="44" height="18" />
            <rect x="28" y="139" width="44" height="18" />
          </svg>
          {tokens.map((t) => {
            const me = t.booking.player_id === myId;
            const team = t.isRed ? red : white;
            return (
              <button
                key={t.booking.id}
                className={"lv-tok" + (me ? " me" : "") + (picked === t.booking.player_id ? " pick" : "")}
                style={{ left: `${t.x}%`, top: `${yOf(t)}%`, ["--d" as string]: `${order.indexOf(t) * 70}ms`, ["--tc" as string]: team.color, ["--tx" as string]: readableTextColor(team.color) }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPicked(picked === t.booking.player_id ? null : t.booking.player_id);
                }}
                aria-label={t.booking.player.display_name}
              >
                <span className="sh" />
                <span className="up">
                  <Avatar name={t.booking.player.display_name} avatarUrl={t.booking.player.avatar_url} className="lv-face" />
                  <b>{me ? "YOU" : (names.get(t.booking.player_id) ?? "").toUpperCase()}</b>
                </span>
              </button>
            );
          })}
        </div>
        {pick && (
          <button
            className="l3"
            style={{ ["--tc" as string]: (pick.isRed ? red : white).color }}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(pick.booking.player_id, pick.isRed ? red : white);
            }}
          >
            <Avatar name={pick.booking.player.display_name} avatarUrl={pick.booking.player.avatar_url} className="ph" />
            <span className="tx">
              <b>{pick.booking.player.display_name.toUpperCase()}</b>
              <small>
                {(pick.isRed ? red : white).name.toUpperCase()} · {stats.get(pick.booking.player_id)?.apps ?? 0} APPS · {stats.get(pick.booking.player_id)?.goals ?? 0} GOALS ·{" "}
                {wins[pick.booking.player_id] ?? 0} WINS
              </small>
            </span>
            <em>Card ›</em>
          </button>
        )}
      </section>
      <section className="lv-card">
        <header>
          <h4>On paper</h4>
          <span>This season</span>
        </header>
        {rows.map((r) => (
          <div key={r.label} className="lv-bar">
            <b>{r.w}</b>
            <span style={{ background: red.color }}>
              <i style={{ width: `${(r.w / (r.w + r.r || 1)) * 100}%`, background: white.color }} />
            </span>
            <b>{r.r}</b>
            <small>{r.label}</small>
          </div>
        ))}
      </section>
    </>
  );
}

export const lineupV2Css = `
.lv-hero,.lv-card,.lv-soon,.lv-tv,.lv-pitch{box-sizing:border-box;min-width:0}
.lv-hero small,.lv-card small,.lv-soon small{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.lv-face{width:var(--s,52px);height:var(--s,52px);border-radius:50%;object-fit:cover;background:#1e293b;display:grid;place-items:center;font:800 18px var(--display);color:#94a3b8;flex:none;box-shadow:0 0 0 2px rgba(255,255,255,.12)}
.lv-face.sm{--s:30px;font-size:13px}
.lv-hero{position:relative;overflow:hidden;margin:2px 0 14px;border-radius:22px;min-height:190px;display:flex;align-items:flex-end;border:1px solid rgba(245,217,122,.28);box-shadow:0 26px 50px -30px #000}
.lv-hero .ph{position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,10,16,.2),rgba(8,10,16,.55) 45%,rgba(8,10,16,.96)),url(/pitch-night.jpg) center 40%/cover}
.lv-hero .tx{position:relative;padding:16px 18px;width:100%;box-sizing:border-box}
.lv-hero b{display:block;margin-top:4px;font:800 30px/1 var(--display);color:#fff}
.lv-hero .when{display:flex;align-items:center;gap:7px;margin-top:7px;font:600 13px var(--sans);color:#cbd5e1}
.lv-hero .when i{width:7px;height:7px;border-radius:50%;background:#64748b;flex:none}
.lv-hero .when.live i{background:#4ade80;box-shadow:0 0 8px #4ade80}
.lv-hero .fill{display:flex;align-items:center;gap:10px;margin-top:12px}
.lv-hero .pips{display:flex;gap:3px;flex:1;min-width:0}
.lv-hero .pips i{flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.12)}
.lv-hero .pips i.on{background:#f5d97a;box-shadow:0 0 6px rgba(245,217,122,.6)}
.lv-hero .fill em{font:700 11.5px var(--sans);font-style:normal;color:#f5d97a;white-space:nowrap}
.lv-card{margin:0 0 14px;border-radius:22px;padding:16px;background:#0f1424;border:1px solid rgba(245,217,122,.18);box-shadow:0 22px 44px -28px #000}
.lv-card header{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(245,217,122,.25)}
.lv-card h4{margin:0;font:700 22px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff}
.lv-card header span{margin-left:auto;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8;white-space:nowrap}
.lv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 6px}
.lv-p{position:relative;display:grid;justify-items:center;gap:4px;text-align:center;padding:0;border:0;background:none;color:#fff;cursor:pointer;min-width:0}
.lv-p .no{position:absolute;top:-4px;left:calc(50% - 30px);z-index:1;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#0b0f1c;border:1px solid rgba(245,217,122,.5);font:700 10px/16px var(--font-oswald),sans-serif;color:#f5d97a}
.lv-p b{font:700 12.5px var(--sans);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv-card .lv-p small{font:500 10.5px var(--sans);letter-spacing:0;text-transform:none;color:#94a3b8;white-space:nowrap}
.lv-p.me .lv-face{box-shadow:0 0 0 2px #f5d97a,0 0 18px rgba(245,217,122,.6)}
.lv-p.me b{color:#f5d97a}
.lv-bench{display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.12);flex-wrap:wrap}
.lv-card .lv-bench small{color:#94a3b8;margin-right:auto}
.lv-bench .bp{display:flex;align-items:center;gap:7px;padding:4px 10px 4px 4px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#fff;cursor:pointer}
.lv-bench .bp.me{border-color:rgba(245,217,122,.5)}
.lv-bench .bp b{font:700 12px var(--sans)}.lv-bench .bp em{font:600 10.5px var(--sans);font-style:normal;color:#94a3b8}
.lv-soon{position:relative;overflow:hidden;margin:0 0 14px;border-radius:22px;padding:18px;border:1px dashed rgba(255,255,255,.14);background:#0b101c}
.lv-soon .ghost{position:absolute;right:-30px;top:-10px;width:170px;height:150px;border:2px solid rgba(255,255,255,.06);border-radius:6px;transform:rotate(-8deg)}
.lv-soon .ghost::after{content:"";position:absolute;left:0;right:0;top:50%;border-top:2px solid rgba(255,255,255,.06)}
.lv-soon .tx{position:relative}.lv-soon b{display:block;margin-top:4px;font:800 18px var(--display);color:#fff}.lv-soon span{display:block;margin-top:4px;font:500 13px/1.45 var(--sans);color:#94a3b8;max-width:28ch}
.lv-tv{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:10px 12px;border-radius:14px;background:linear-gradient(90deg,rgba(238,244,252,.12),rgba(15,20,36,.9) 40%,rgba(15,20,36,.9) 60%,rgba(228,42,54,.18));border:1px solid rgba(255,255,255,.1);font:800 15px var(--font-oswald),sans-serif;letter-spacing:.12em;color:#fff}
.lv-tv .t{display:flex;align-items:center;gap:7px;flex:1;min-width:0}.lv-tv .t.r{justify-content:flex-end}
.lv-tv .t i{width:12px;height:12px;border-radius:3px;flex:none}
.lv-tv .n{font-size:22px;color:#f5d97a}.lv-tv .v{color:#64748b;font-size:12px}
.lv-pitch{position:relative;height:568px;margin:0 0 14px;border-radius:22px;overflow:hidden;background:radial-gradient(70% 50% at 50% 60%,#0f2a19,#05080d 75%);border:1px solid rgba(255,255,255,.1);perspective:1300px;perspective-origin:50% -20%}
.lv-pitch .stand{position:absolute;left:0;right:0;top:0;height:52px;background:linear-gradient(180deg,#0b0f18,#151d2e 65%,rgba(21,29,46,0))}
.lv-pitch .stand::after{content:"";position:absolute;left:6%;right:6%;top:10px;height:6px;background:radial-gradient(circle,#fff 0 1.5px,transparent 2.5px) 0 0/22px 6px;filter:drop-shadow(0 0 4px #dbeafe);opacity:.9}
.lv-pitch .beam{position:absolute;top:-20px;width:120px;height:420px;background:linear-gradient(180deg,rgba(220,235,255,.3),transparent 75%);filter:blur(6px);pointer-events:none}
.lv-pitch .beam.l{left:10px;transform:rotate(-18deg);transform-origin:50% 0}.lv-pitch .beam.r{right:10px;transform:rotate(18deg);transform-origin:50% 0}
.lv-pitch .plane{position:absolute;left:50%;top:30px;width:min(296px,calc(100% - 16px));height:530px;transform:translateX(-50%) rotateX(36deg);transform-origin:50% 0;transform-style:preserve-3d;z-index:1}
.lv-pitch .grass{position:absolute;inset:0;background:repeating-linear-gradient(0deg,#1c6a37 0 31px,#1f7540 31px 62px);box-shadow:0 0 80px rgba(60,200,110,.25);border-radius:2px}
.lv-pitch .grass::after{content:"";position:absolute;inset:0;background:radial-gradient(60% 40% at 50% 30%,rgba(255,255,255,.12),transparent 70%)}
.lv-pitch svg{position:absolute;inset:6px;width:calc(100% - 12px);height:calc(100% - 12px);fill:none;stroke:rgba(255,255,255,.7)}
.lv-pitch svg *{vector-effect:non-scaling-stroke;stroke-width:1.6}
.lv-pitch .rib{position:absolute;left:12px;z-index:4;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 8px;font:800 10.5px var(--font-oswald),sans-serif;letter-spacing:.14em;color:#fff;background:rgba(5,8,14,.82);border-left:3px solid #f5d97a;clip-path:polygon(0 0,100% 0,94% 100%,0 100%)}
.lv-pitch .rib.top{top:10px}.lv-pitch .rib.bot{bottom:10px}
.lv-pitch .rib i{width:9px;height:9px;border-radius:2px}
.lv-tok{position:absolute;width:0;height:0;padding:0;border:0;background:none;transform-style:preserve-3d;cursor:pointer}
.lv-tok .sh{position:absolute;left:-15px;top:-5px;width:30px;height:10px;border-radius:50%;background:rgba(0,0,0,.5)}
.lv-tok .up{position:absolute;left:-40px;bottom:0;width:80px;display:grid;justify-items:center;transform:rotateX(-36deg);transform-origin:50% 100%;transition:transform .3s;animation:lvIn .5s cubic-bezier(.2,1.5,.4,1) var(--d) both}
.lv-tok .lv-face{--s:38px;font-size:14px;box-shadow:0 0 0 2.5px var(--tc)}
.lv-tok b{margin-top:-5px;position:relative;z-index:1;padding:2px 8px;font:800 10px/1.25 var(--font-oswald),sans-serif;letter-spacing:.08em;white-space:nowrap;max-width:76px;overflow:hidden;text-overflow:ellipsis;clip-path:polygon(6% 0,100% 0,94% 100%,0 100%);background:var(--tc);color:var(--tx)}
.lv-tok.me .lv-face{box-shadow:0 0 0 2.5px #f5d97a,0 0 22px #f5d97a}.lv-tok.me b{background:#f5d97a;color:#1a1405}
.lv-tok.pick .up{animation:none;transform:rotateX(-36deg) translateY(-8px) scale(1.12)}
@keyframes lvIn{from{opacity:0;transform:rotateX(-36deg) translateY(-60px)}}
.lv-pitch .l3{position:absolute;left:10px;right:10px;bottom:44px;z-index:5;display:flex;align-items:center;gap:10px;padding:8px 12px 8px 8px;border:0;border-left:4px solid var(--tc);background:linear-gradient(90deg,#0b1220 70%,rgba(11,18,32,.88));clip-path:polygon(0 0,100% 0,97% 100%,0 100%);text-align:left;color:#fff;cursor:pointer;animation:lvL3 .45s cubic-bezier(.2,1,.3,1) both}
@keyframes lvL3{from{transform:translateX(-110%)}}
.lv-pitch .l3 .ph{width:44px;height:44px;border-radius:50%;object-fit:cover;background:#1e293b;display:grid;place-items:center;font:800 16px var(--display);color:#94a3b8;box-shadow:0 0 0 2px #f5d97a;flex:none}
.lv-pitch .l3 .tx{flex:1;min-width:0}
.lv-pitch .l3 b{display:block;font:800 15px var(--font-oswald),sans-serif;letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lv-pitch .l3 small{display:block;margin-top:2px;font:700 9.5px var(--font-oswald),sans-serif;letter-spacing:.12em;color:#f5d97a}
.lv-pitch .l3 em{font:700 11px var(--sans);font-style:normal;color:#cbd5e1;margin-right:10px;white-space:nowrap}
.lv-bar{display:grid;grid-template-columns:34px 1fr 34px;align-items:center;gap:10px;margin-top:10px}
.lv-bar b{font:800 18px var(--display);text-align:center;color:#fff}
.lv-bar span{display:flex;height:10px;border-radius:5px;overflow:hidden}
.lv-card .lv-bar small{grid-column:1/-1;margin-top:-4px;text-align:center;color:#94a3b8;letter-spacing:.2em}
@media (prefers-reduced-motion: reduce){.lv-tok .up,.lv-pitch .l3{animation:none!important}}
`;
