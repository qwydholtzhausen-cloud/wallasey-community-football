import { useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { Avatar, avatarFor } from "./shared";

// Game Stories: a swipe-through story of each night, grouped by month at the
// top of the Feed. Deliberately about the GAME, never "you" - your own
// goals, results and streaks are Wrapped's job.

export type StoryGame = {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  white: { name: string; color: string; score: number };
  red: { name: string; color: string; score: number };
  played: number;
  waiting: number;
  // "Reds by 7, the joint second-biggest win of the season (31 Aug was by 8)."
  marginLine: string;
  scorers: { name: string; avatarUrl?: string | null; goals: number; side: "white" | "red" }[];
  ownGoals: number;
  predictions: { white: number; red: number; draw: number; exact: number };
  motm: { winners: string[]; votes: number; top: { name: string; votes: number }[] } | null;
};

const RATING_WORDS = ["Scrappy", "Average", "Decent", "Great game", "Classic"];
const WEATHER = (code: number) => (code === 0 ? ["☀️", "clear"] : code <= 2 ? ["🌤️", "partly cloudy"] : code === 3 ? ["☁️", "overcast"] : code === 45 || code === 48 ? ["🌫️", "foggy"] : code <= 57 ? ["🌦️", "drizzle"] : code <= 67 ? ["🌧️", "rain"] : code <= 77 ? ["❄️", "snow"] : code <= 82 ? ["🌦️", "showers"] : ["⛈️", "stormy"]);
const longDate = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

export function StoryRings({
  games,
  seen,
  monthLabel,
  otherMonthLabel,
  onOtherMonth,
  onOpen,
}: {
  games: { id: string; date: string }[];
  seen: Set<string>;
  monthLabel: string;
  otherMonthLabel: string | null;
  onOtherMonth: () => void;
  onOpen: (id: string) => void;
}) {
  if (games.length === 0 && !otherMonthLabel) return null;
  return (
    <div className="wcf-stories">
      <div className="wcf-stories-head">
        <b>{monthLabel}&apos;s games</b>
        {otherMonthLabel && <button type="button" onClick={onOtherMonth}>{otherMonthLabel}</button>}
      </div>
      <div className="wcf-stories-row">
        {games.length === 0 && <span className="wcf-stories-none">No games yet this month.</span>}
        {games.map((g) => {
          const d = new Date(g.date + "T12:00:00");
          return (
            <button key={g.id} type="button" className={"wcf-story-ring" + (seen.has(g.id) ? " seen" : "")} onClick={() => onOpen(g.id)}>
              <span className="r">
                <span>
                  <small>{d.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase()}</small>
                  {d.getDate()}
                </span>
              </span>
              {d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Card = { bg: string; body: React.ReactNode };

export function GameStory({ game, motmClosed, onClose }: { game: StoryGame; motmClosed: boolean; onClose: () => void }) {
  const [extra, setExtra] = useState<{ weather: { temp: number; code: number } | null; rating: { n: number; avg: number } | null } | null>(null);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  // A press longer than this pauses the story (like holding a finger on
  // it) and doesn't count as a tap to skip.
  const pressAt = useRef(0);
  const held = () => Date.now() - pressAt.current > 300;
  useEffect(() => {
    let off = false;
    (async () => {
      const [{ data: wx }, { data: rt }] = await Promise.all([
        supabase.from("game_weather").select("temp_c, weather_code").eq("game_id", game.id).maybeSingle(),
        supabase.rpc("game_rating_summary", { p_game_id: game.id }),
      ]);
      if (off) return;
      const row = Array.isArray(rt) ? rt[0] : rt;
      setExtra({
        weather: wx ? { temp: Math.round(Number(wx.temp_c)), code: Number(wx.weather_code) } : null,
        rating: row && Number(row.ratings) >= 3 && row.average != null ? { n: Number(row.ratings), avg: Number(row.average) } : null,
      });
    })().catch(() => setExtra({ weather: null, rating: null }));
    return () => { off = true; };
  }, [game.id]);

  const winner = game.white.score === game.red.score ? null : game.white.score > game.red.score ? game.white : game.red;
  const totalGoals = game.white.score + game.red.score;
  const hatTricks = game.scorers.filter((s) => s.goals >= 3);
  const preds = game.predictions;
  const predTotal = preds.white + preds.red + preds.draw;
  const cards: Card[] = [];
  const wx = extra?.weather ? WEATHER(extra.weather.code) : null;
  cards.push({
    bg: "/pitch-goal-night.jpg",
    body: (
      <>
        <div className="k">{longDate(game.date).toUpperCase()} · THE NIGHT</div>
        <div className="h">{game.venue}, {game.kickoff}</div>
        <div className="meta">
          {wx && extra?.weather && <div><i>{wx[0]}</i>{extra.weather.temp}°C and {wx[1]}</div>}
          <div><i>👥</i>{game.played} played{game.waiting ? `, ${game.waiting} on the waiting list` : ""}</div>
          <div><i>⚽</i>{game.pitch}</div>
        </div>
      </>
    ),
  });
  cards.push({
    bg: "/results-bg.jpg",
    body: (
      <>
        <div className="k">FULL TIME</div>
        <div className="bigsc" style={{ color: game.white.color }}>{game.white.score}<small>{game.white.name.toUpperCase()}</small></div>
        <div className="bigsc" style={{ color: game.red.color }}>{game.red.score}<small>{game.red.name.toUpperCase()}</small></div>
        <div className="s">{game.marginLine}</div>
      </>
    ),
  });
  if (game.scorers.length > 0) {
    const shown = [...game.scorers].sort((a, b) => b.goals - a.goals).slice(0, 5);
    const rest = game.scorers.length - shown.length;
    const title =
      hatTricks.length >= 2 && hatTricks.every((h) => h.side === hatTricks[0].side)
        ? `${hatTricks.length === 2 ? "Two" : hatTricks.length} hat-tricks for the ${hatTricks[0].side === "white" ? game.white.name : game.red.name}`
        : hatTricks.length >= 2
          ? `${hatTricks.length} hat-tricks`
          : hatTricks.length === 1
            ? `Hat-trick for ${hatTricks[0].name.split(" ")[0]}`
            : `${totalGoals} goals`;
    cards.push({
      bg: "/pitch-night.jpg",
      body: (
        <>
          <div className="k">THE GOALS · {totalGoals}</div>
          <div className="h">{title}</div>
          <div className="sclist">
            {shown.map((s, k) => (
              <div key={s.name} style={{ animationDelay: `${k * 0.1}s` }}>
                <Avatar name={s.name} avatarUrl={s.avatarUrl} className="wcf-avatar-chip" background={avatarFor(s.name).gradient} />
                {s.name}
                <span className="side" style={{ background: s.side === "white" ? game.white.color : game.red.color }} />
                <em>{s.goals}</em>
              </div>
            ))}
            {(rest > 0 || game.ownGoals > 0) && (
              <div className="more">
                {rest > 0 ? `+ ${rest} more ${rest === 1 ? "scorer" : "scorers"}` : ""}
                {rest > 0 && game.ownGoals > 0 ? " · " : ""}
                {game.ownGoals > 0 ? `${game.ownGoals} own ${game.ownGoals === 1 ? "goal" : "goals"}` : ""}
              </div>
            )}
          </div>
        </>
      ),
    });
  }
  if (predTotal >= 3) {
    const side = preds.white > preds.red && preds.white > preds.draw ? "white" : preds.red > preds.white && preds.red > preds.draw ? "red" : null;
    const top = side === "white" ? preds.white : side === "red" ? preds.red : 0;
    cards.push({
      bg: "/celebration.jpg",
      body: (
        <>
          <div className="k">THE CROWD&apos;S CALL · {predTotal} PREDICTIONS</div>
          <div className="h">
            {side ? `${top} of ${predTotal} backed the ${side === "white" ? game.white.name : game.red.name}` : "The predictions were split"}
          </div>
          <div className="split">
            {preds.white > 0 && <div style={{ ["--w" as string]: `${(preds.white / predTotal) * 100}%`, background: game.white.color, color: "#0d0d1a" }}>{preds.white}</div>}
            {preds.draw > 0 && <div style={{ ["--w" as string]: `${(preds.draw / predTotal) * 100}%`, background: "#475569" }}>{preds.draw}</div>}
            {preds.red > 0 && <div style={{ ["--w" as string]: `${(preds.red / predTotal) * 100}%`, background: game.red.color }}>{preds.red}</div>}
          </div>
          <div className="s">
            {preds.exact === 0
              ? `Nobody called ${game.white.score}–${game.red.score} exactly.`
              : `${preds.exact} called ${game.white.score}–${game.red.score} exactly.`}
            {winner && side && (side === "white" ? game.white : game.red) !== winner ? " The crowd got it wrong." : ""}
          </div>
        </>
      ),
    });
  }
  if (motmClosed && game.motm && game.motm.winners.length > 0) {
    const max = game.motm.top[0]?.votes || 1;
    cards.push({
      bg: "/results-bg.jpg",
      body: (
        <>
          <div className="k">MAN OF THE MATCH · {game.motm.votes} VOTES</div>
          <div className="h">{game.motm.winners.join(" & ")}</div>
          <div className="vbars">
            {game.motm.top.map((t, k) => (
              <div key={t.name} className={"vb" + (game.motm!.winners.includes(t.name) ? " win" : "")}>
                <span>{t.name}</span>
                <span className="t"><i style={{ ["--w" as string]: `${(t.votes / max) * 100}%`, animationDelay: `${k * 0.08}s` }} /></span>
                <span>{t.votes}</span>
              </div>
            ))}
          </div>
        </>
      ),
    });
  }
  if (extra?.rating) {
    const r = extra.rating;
    const lit = Math.round(r.avg);
    cards.push({
      bg: "/floodlight-haze.jpg",
      body: (
        <>
          <div className="k">HOW WAS TONIGHT?</div>
          <div className="bignum">{r.avg.toFixed(1)}<small>/ 5 · {RATING_WORDS[Math.min(5, Math.max(1, lit)) - 1]}</small></div>
          <div className="heat">{[1, 2, 3, 4, 5].map((k) => <i key={k} className={k <= lit ? "on" : ""} />)}</div>
          <div className="heat-ends"><span>Scrappy</span><span>Classic</span></div>
          <div className="s">From {r.n} ratings.</div>
        </>
      ),
    });
  }

  const DUR = 4500;
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => (i + 1 < cards.length ? setI(i + 1) : onClose()), DUR);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, paused, cards.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((n) => Math.min(cards.length - 1, n + 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, onClose]);
  const card = cards[Math.min(i, cards.length - 1)];
  return (
    <div className="wcf-story" role="dialog" aria-label={`Story of ${longDate(game.date)}`}>
      <div className="bars">
        {cards.map((_, k) => (
          <i key={k} className={k < i ? "done" : k === i ? (paused ? "run paused" : "run") : ""} style={{ ["--dur" as string]: `${DUR}ms` }}>
            <b key={k === i ? `run-${i}` : k} />
          </i>
        ))}
      </div>
      <div className="top">
        <img src="/crest.png" alt="" />
        {new Date(game.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · {game.white.name} v {game.red.name}
        <button type="button" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div key={i} className="card" style={{ backgroundImage: `url(${card.bg})` }}>
        {card.body}
      </div>
      <div
        className="tapzones"
        onPointerDown={() => { pressAt.current = Date.now(); setPaused(true); }}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button type="button" aria-label="Back" onClick={() => { if (!held()) setI((n) => Math.max(0, n - 1)); }} />
        <button type="button" aria-label="Next" onClick={() => { if (!held()) (i + 1 < cards.length ? setI(i + 1) : onClose()); }} />
      </div>
    </div>
  );
}
