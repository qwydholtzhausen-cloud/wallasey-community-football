"use client";

// The full-screen "Wrapped" story: a player's own month (admins-only test)
// or year, as tap-through cards like an Instagram story. The numbers come
// from lib/wrapped.ts; this file is only the presentation - which cards to
// show, the wording, the gestures and the shareable poster.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WrappedData } from "../lib/wrapped";
import type { ClubRecords, Holder } from "../lib/records";

const CARD_MS = 6000;
const HOLD_MS = 220;

export interface WrappedStoryProps {
  data: WrappedData;
  records: ClubRecords; // the same period's record book
  prev: { apps: number; goals: number; myRate: number } | null; // the period before, for "vs last month"
  periodKey: string; // "2026-08"
  periodLabel: string; // "August 2026"
  periodShort: string; // "August"
  prevShort: string; // "July"
  soFar?: boolean; // the month isn't over yet (admins testing)
  whiteName: string;
  redName: string;
  whiteColor: string;
  redColor: string;
  avatarFor: (playerId: string) => string | null;
  nameFor: (playerId: string) => string;
  myId: string;
  onClose: () => void;
  onShare: () => void;
  onBook: () => void;
  onBootRoom: () => void;
}

interface Card {
  key: string;
  photo: string | null;
  accent: string;
  body: ReactNode;
}

// The generated photos are shot dark with room for text already, so they
// can show at nearly full strength; the older, brighter ones stay dimmed.
const STRONG_PHOTOS = new Set([
  "/wrapped/intro.jpg",
  "/wrapped/glance.jpg",
  "/wrapped/goals.jpg",
  "/wrapped/motm.jpg",
  "/wrapped/partner.jpg",
  "/wrapped/predictions.jpg",
  "/wrapped/club.jpg",
  "/wrapped/summary.jpg",
  "/wrapped/next.jpg",
]);

// Card photos live in public/wrapped/, so a new generated image is a file
// swap with no code change.
const PHOTO = {
  intro: "/wrapped/intro.jpg",
  glance: "/wrapped/glance.jpg",
  record: "/wrapped/record.jpg",
  goals: "/wrapped/goals.jpg",
  motm: "/wrapped/motm.jpg",
  partner: "/wrapped/partner.jpg",
  best: "/wrapped/best.jpg",
  pred: "/wrapped/predictions.jpg",
  club: "/wrapped/club.jpg",
  end: "/wrapped/next.jpg",
  summary: "/wrapped/summary.jpg",
};

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function shortDate(date: string) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// "Reds" -> "Red", so "Basically a Red" reads naturally. Admin-set names
// that don't end in "s" are used as they are.
function singular(team: string) {
  return /[^s]s$/i.test(team) ? team.slice(0, -1) : team;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

// Counts a number up from 0 when its card appears.
function Count({ to }: { to: number }) {
  const [v, setV] = useState(to);
  useEffect(() => {
    if (!to || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setV(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 900);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    setV(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{v}</>;
}

// Falls back to initials if there's no photo or the photo link is broken.
function Face({ name, url, className, style }: { name: string; url: string | null; className: string; style?: CSSProperties }) {
  const [broken, setBroken] = useState(false);
  return url && !broken ? (
    <img className={className} src={url} alt="" style={style} onError={() => setBroken(true)} />
  ) : (
    <span className={className} style={style}>{initials(name)}</span>
  );
}

// "↑ 2 vs July". Nothing at all when there's no previous period to compare.
function Delta({ now, prev, prevShort, suffix = "" }: { now: number; prev: number | undefined; prevShort: string; suffix?: string }) {
  if (prev === undefined) return null;
  const diff = now - prev;
  if (diff === 0) return <span className="wr-delta same">Same as {prevShort}</span>;
  return (
    <span className={"wr-delta " + (diff > 0 ? "up" : "down")}>
      {diff > 0 ? "↑" : "↓"} {Math.abs(diff)}
      {suffix} vs {prevShort}
    </span>
  );
}

// Won/drew/lost as one ring, drawn with three dashed arcs.
function RecordRing({ W, D, L }: { W: number; D: number; L: number }) {
  const total = Math.max(1, W + D + L);
  const r = 54;
  const c = 2 * Math.PI * r;
  const segs = [
    { n: W, color: "#86efac" },
    { n: D, color: "#94a3b8" },
    { n: L, color: "#f8b3b8" },
  ];
  let offset = 0;
  return (
    <svg className="wr-ring" viewBox="0 0 140 140" width="140" height="140" aria-hidden="true">
      <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="14" />
      {segs.map((s, i) => {
        const len = (s.n / total) * c;
        const el =
          s.n > 0 ? (
            <circle
              key={i}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, len - 3)} ${c}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
              style={{ "--len": len } as CSSProperties}
            />
          ) : null;
        offset += len;
        return el;
      })}
    </svg>
  );
}

export function buildWrappedCards(p: Omit<WrappedStoryProps, "onClose">, onReplay: () => void): Card[] {
  const d = p.data;
  const cards: Card[] = [];
  const mainColour = d.red >= d.white ? "red" : "white";
  const mainName = mainColour === "red" ? p.redName : p.whiteName;
  const oneColour = Math.max(d.red, d.white) / d.apps >= 0.8;
  const prev = p.prev ?? undefined;

  cards.push({
    key: "intro",
    photo: PHOTO.intro,
    accent: "#f8b3b8",
    body: (
      <>
        <img className="wr-logo wr-rise" src="/logo.png" alt="" />
        <div className="wr-rise">
          <div className="wr-kicker">Your monthly</div>
          <div className="wr-period">WRAPPED</div>
          <div className="wr-wrapped">{p.periodLabel.toUpperCase()}{p.soFar ? " · SO FAR" : ""}</div>
        </div>
        <div className="wr-h wr-rise" style={{ marginTop: 20 }}>
          {d.firstName}, here&apos;s your {p.periodShort} {p.soFar ? "so far" : "on the pitch"}.
        </div>
        <div className="wr-grow" />
        <div className="wr-tap wr-rise"><i />Tap to relive your month</div>
      </>
    ),
  });

  cards.push({
    key: "glance",
    photo: PHOTO.glance,
    accent: "#7fb0ec",
    body: (
      <>
        <div className="wr-lab wr-rise">At a glance</div>
        <div className="wr-stack">
          <div className="wr-stat wr-rise">
            <b><Count to={d.apps} /><small>of {d.ofGames}</small></b>
            <span>games played</span>
            <Delta now={d.apps} prev={prev?.apps} prevShort={p.prevShort} />
          </div>
          <div className="wr-stat wr-rise">
            <b><Count to={d.goals} /></b>
            <span>{d.goals === 1 ? "goal" : "goals"}</span>
            <Delta now={d.goals} prev={prev?.goals} prevShort={p.prevShort} />
          </div>
          {d.W > 0 ? (
            <div className="wr-stat wr-rise">
              <b><Count to={d.myRate} />%</b>
              <span>win rate</span>
              <Delta now={d.myRate} prev={prev?.myRate} prevShort={p.prevShort} suffix="%" />
            </div>
          ) : (
            // No wins yet: minutes played, not a big 0%.
            <div className="wr-stat wr-rise">
              <b><Count to={d.minutes} /></b>
              <span>minutes played</span>
            </div>
          )}
        </div>
        <div className="wr-grow" />
        <div className="wr-p wr-rise">
          That&apos;s <b>{d.minutes} minutes</b> of football, {d.appsRank === 1 ? "more than anyone" : `the ${ordinal(d.appsRank)} most`} in a squad of {d.squad}.
        </div>
      </>
    ),
  });

  const recordLine =
    d.W > d.L ? "More wins than losses. Keep it going." : d.W === d.L ? "Dead even. Nobody can say you didn't give them a game." : "The results will turn. You kept turning up.";
  cards.push({
    key: "record",
    photo: PHOTO.record,
    accent: "#86efac",
    body: (
      <>
        <div className="wr-lab wr-rise">Your record</div>
        <div className="wr-h wr-rise">{recordLine.split(". ")[0]}.</div>
        <div className="wr-ringrow wr-rise">
          <div className="wr-ringwrap">
            <RecordRing W={d.W} D={d.D} L={d.L} />
            <div className="wr-ringmid"><b>{d.apps}</b><span>GAMES</span></div>
          </div>
          <ul className="wr-legend">
            <li><i style={{ background: "#86efac" }} /><b>{d.W}</b> {d.W === 1 ? "win" : "wins"}</li>
            <li><i style={{ background: "#94a3b8" }} /><b>{d.D}</b> {d.D === 1 ? "draw" : "draws"}</li>
            <li><i style={{ background: "#f8b3b8" }} /><b>{d.L}</b> {d.L === 1 ? "loss" : "losses"}</li>
          </ul>
        </div>
        <div className="wr-grow" />
        <div className="wr-lab wr-rise" style={{ color: "rgba(255,255,255,.7)" }}>Your colours</div>
        <div className="wr-kit wr-rise">
          {d.red > 0 && <div style={{ flexGrow: d.red, background: p.redColor }}>{d.red >= d.white ? `${p.redName} ${d.red}` : d.red}</div>}
          {d.white > 0 && (
            <div className="light" style={{ flexGrow: d.white, background: p.whiteColor }}>{d.white > d.red ? `${p.whiteName} ${d.white}` : d.white}</div>
          )}
        </div>
        <div className="wr-p wr-rise">{oneColour ? `Basically a ${singular(mainName)}.` : "A bit of both."}</div>
      </>
    ),
  });

  // The month as a calendar, each game day coloured by how it went.
  const [yy, mm] = p.periodKey.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const firstDow = (new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const resultByDay: Record<number, string> = {};
  for (const f of d.form) resultByDay[Number(f.date.slice(8, 10))] = f.result;
  cards.push({
    key: "month",
    photo: null,
    accent: "#f5d97a",
    body: (
      <>
        <div className="wr-lab wr-rise">Your {p.periodShort}</div>
        <div className="wr-h wr-rise">{d.apps} nights out of the house.</div>
        <div className="wr-cal wr-rise">
          {["M", "T", "W", "T", "F", "S", "S"].map((l, i) => <span key={"h" + i} className="hd">{l}</span>)}
          {Array.from({ length: firstDow }, (_, i) => <span key={"b" + i} />)}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const r = resultByDay[i + 1];
            return <span key={i} className={"day" + (r ? " r" + r : "")}>{r ?? i + 1}</span>;
          })}
        </div>
        <div className="wr-form wr-rise">
          {d.form.map((f, i) => <i key={i} className={"r" + f.result}>{f.result}</i>)}
        </div>
        <div className="wr-grow" />
        <div className="wr-chips">
          {d.winStreak >= 2 && <div className="wr-chip wr-rise"><span className="k">{d.winStreak}</span><span>wins on the bounce. You were on fire.</span></div>}
          {d.unbeaten >= 3 && d.unbeaten > d.winStreak && <div className="wr-chip wr-rise"><span className="k">{d.unbeaten}</span><span>games unbeaten, your best run</span></div>}
          {d.appsRun >= 3 && <div className="wr-chip wr-rise"><span className="k">{d.appsRun}</span><span>{d.appsRun === d.ofGames ? "games in a row. You never missed one." : "games in a row without missing one"}</span></div>}
          {d.promotions > 0 && <div className="wr-chip wr-rise"><span className="k">{d.promotions}</span><span>{d.promotions === 1 ? "time you got in off the waiting list" : "times you got in off the waiting list"}</span></div>}
        </div>
      </>
    ),
  });

  cards.push({
    key: "goals",
    photo: PHOTO.goals,
    accent: "#86efac",
    body:
      d.goals > 0 ? (
        <>
          <div className="wr-lab wr-rise">In front of goal</div>
          <div className="wr-big wr-rise" style={{ marginTop: 14 }}>
            <Count to={d.goals} />
            <small>{d.goals === 1 ? "goal" : "goals"}</small>
          </div>
          <div className="wr-rise"><Delta now={d.goals} prev={prev?.goals} prevShort={p.prevShort} /></div>
          <div className="wr-p wr-rise">{d.goalsRank === 1 ? "Nobody scored more." : `That's ${(d.goals / d.apps).toFixed(1)} a game. Every one of them counted.`}</div>
          <div className="wr-grow" />
          <div className="wr-chips">
            {d.goalsRank && d.goalsRank > 1 && (
              <div className="wr-chip wr-rise"><span className="k">{ordinal(d.goalsRank)}</span><span>in the club&apos;s scoring charts</span></div>
            )}
            {d.topScorer && d.goalsRank !== 1 && (
              <div className="wr-chip wr-rise"><span className="k">{d.topScorer.goals}</span><span>for the top scorer, {d.topScorer.name}. Something to aim at.</span></div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="wr-lab wr-rise">In front of goal</div>
          <div className="wr-h wr-rise">The goals will come.</div>
          <div className="wr-p wr-rise">None on the scoresheet this time, but you were in the thick of it for {d.minutes} minutes.</div>
          <div className="wr-grow" />
          {d.topScorer && (
            <div className="wr-chip wr-rise"><span className="k">{d.topScorer.goals}</span><span>for the top scorer, {d.topScorer.name}</span></div>
          )}
        </>
      ),
  });

  if (d.motmWins > 0 || d.motmVotes >= 2) {
    cards.push({
      key: "motm",
      photo: PHOTO.motm,
      accent: "#f5d97a",
      body:
        d.motmWins > 0 ? (
          <>
            <div className="wr-lab wr-rise">Man of the Match</div>
            <div className="wr-big wr-rise" style={{ marginTop: 14 }}>
              <Count to={d.motmWins} />
              <small>{d.motmWins === 1 ? "time" : "times"}</small>
            </div>
            <div className="wr-p wr-rise">Voted best on the pitch by the lads you played with.</div>
            <div className="wr-grow" />
            <div className="wr-chip wr-rise"><span className="k">{d.motmVotes}</span><span>MOTM votes in total</span></div>
          </>
        ) : (
          <>
            <div className="wr-lab wr-rise">Man of the Match</div>
            <div className="wr-h wr-rise">Your teammates noticed.</div>
            <div className="wr-big wr-rise" style={{ marginTop: 14 }}>
              <Count to={d.motmVotes} />
              <small>{d.motmVotes === 1 ? "vote" : "votes"}</small>
            </div>
            <div className="wr-p wr-rise">No win yet, but you&apos;re getting votes. It&apos;s coming.</div>
          </>
        ),
    });
  }

  if (d.partner) {
    const pt = d.partner;
    cards.push({
      key: "partner",
      photo: PHOTO.partner,
      accent: "#86efac",
      body: (
        <>
          <div className="wr-lab wr-rise">Who you win with</div>
          <div className="wr-duo wr-rise">
            <Face name={d.firstName} url={p.avatarFor(p.myId)} className="wr-av me" />
            <Face name={pt.name} url={p.avatarFor(pt.playerId)} className="wr-av them" />
            <div className="wr-duo-name">
              {pt.name}
              <small>{pt.together} games on the same side</small>
            </div>
          </div>
          <div className="wr-rate wr-rise">
            <div className="wr-big" style={{ color: "#86efac" }}><Count to={pt.rate} />%</div>
            <span>win rate<br />together</span>
          </div>
          <div className="wr-rise">
            <div className="wr-vs"><i style={{ width: `${pt.rate}%`, background: "#86efac" }} /></div>
            <div className="wr-vs-lab"><span>With {pt.name.split(" ")[0]}: {pt.wins} {pt.wins === 1 ? "win" : "wins"} from {pt.together}</span><span>{pt.rate}%</span></div>
            <div className="wr-vs" style={{ marginTop: 10 }}><i style={{ width: `${d.myRate}%`, background: "rgba(255,255,255,.55)" }} /></div>
            <div className="wr-vs-lab"><span>Your overall</span><span>{d.myRate}%</span></div>
          </div>
          <div className="wr-grow" />
          <div className="wr-p wr-rise">{pt.rate >= 75 ? "Maybe you two should always be on the same side." : "A partnership worth keeping."}</div>
        </>
      ),
    });
  }

  if (d.circle.count > 0) {
    const faces = d.circle.faces.slice(0, 8);
    const n = faces.length;
    cards.push({
      key: "circle",
      photo: null,
      accent: "#b9a6f5",
      body: (
        <>
          <div className="wr-lab wr-rise">Your football circle</div>
          <div className="wr-h wr-rise">
            You shared a side with {d.circle.count} {d.circle.count === 1 ? "player" : "different players"}.
          </div>
          <div className="wr-orbit wr-rise">
            <svg viewBox="0 0 260 260" aria-hidden="true">
              {faces.map((_, i) => {
                const a = (i / n) * Math.PI * 2 - Math.PI / 2;
                return <line key={i} x1="130" y1="130" x2={130 + Math.cos(a) * 104} y2={130 + Math.sin(a) * 104} />;
              })}
            </svg>
            {faces.map((id, i) => {
              const a = (i / n) * Math.PI * 2 - Math.PI / 2;
              return (
                <Face
                  key={id}
                  name={p.nameFor(id)}
                  url={p.avatarFor(id)}
                  className={"wr-orb" + (i === 0 ? " top" : "")}
                  style={{ left: `${50 + Math.cos(a) * 40}%`, top: `${50 + Math.sin(a) * 40}%`, animationDelay: `${0.1 + i * 0.06}s` }}
                />
              );
            })}
            <span className="wr-orb you">YOU</span>
          </div>
          <div className="wr-grow" />
          <div className="wr-chips">
            {d.mostWith && <div className="wr-chip wr-rise"><span className="k">{d.mostWith.together}</span><span>games alongside {d.mostWith.name}, your go-to teammate</span></div>}
            {d.circle.newCount !== null && d.circle.newCount > 0 && (
              <div className="wr-chip wr-rise"><span className="k">{d.circle.newCount}</span><span>{d.circle.newCount === 1 ? "teammate" : "teammates"} you&apos;d never been on a side with before</span></div>
            )}
          </div>
        </>
      ),
    });
  }

  if (d.best) {
    const b = d.best;
    const usName = b.team === "red" ? p.redName : p.whiteName;
    const themName = b.team === "red" ? p.whiteName : p.redName;
    const margin = b.us - b.them;
    cards.push({
      key: "best",
      photo: PHOTO.best,
      accent: "#f5d97a",
      body: (
        <>
          <div className="wr-lab wr-rise">Your best night</div>
          <div className="wr-h wr-rise">{shortDate(b.date)}</div>
          <div className="wr-score wr-rise">
            <div><div className="tm" style={{ color: b.team === "red" ? "#f8b3b8" : "#fff" }}>{usName.toUpperCase()}</div><div className="n"><Count to={b.us} /></div></div>
            <div className="dash">–</div>
            <div><div className="tm">{themName.toUpperCase()}</div><div className="n dim"><Count to={b.them} /></div></div>
          </div>
          <div className="wr-p wr-rise">{margin >= 5 ? "A proper hiding, and you were there for all of it." : margin >= 2 ? "Comfortable. The way you like them." : "Tight, but a win's a win."}</div>
        </>
      ),
    });
  }

  // The period's record book, with anything you hold picked out.
  {
    const r = p.records;
    const mine = (hs: Holder[]) => hs.some((h) => h.playerId === p.myId);
    const names = (hs: Holder[]) => {
      // You first, so a "+3" can never hide you.
      const n = [...hs].sort((a, b) => Number(b.playerId === p.myId) - Number(a.playerId === p.myId)).map((h) => (h.playerId === p.myId ? "You" : h.name));
      return n.length > 2 ? `${n.slice(0, 2).join(", ")} +${n.length - 2}` : n.join(" & ");
    };
    const rows: { k: string; v: string; label: string; who: string; me: boolean }[] = [];
    if (r.mostGoalsInGame && r.mostGoalsInGame.goals >= 2)
      rows.push({ k: "g", v: String(r.mostGoalsInGame.goals), label: "Most goals in a game", who: names(r.mostGoalsInGame.holders), me: mine(r.mostGoalsInGame.holders) });
    if (r.hatTricks.length)
      rows.push({
        k: "h",
        v: String(r.hatTricks.length),
        label: r.hatTricks.length === 1 ? "Hat-trick" : "Hat-tricks",
        who: names(r.hatTricks.map((h) => ({ playerId: h.playerId, name: h.name }))),
        me: r.hatTricks.some((h) => h.playerId === p.myId),
      });
    if (r.biggestWin)
      rows.push({ k: "b", v: `+${r.biggestWin.margin}`, label: "Biggest win", who: `${p.whiteName} ${r.biggestWin.white}–${r.biggestWin.red} ${p.redName}, ${shortDate(r.biggestWin.date)}`, me: false });
    if (r.winStreak) rows.push({ k: "w", v: String(r.winStreak.n), label: "Longest winning run", who: names(r.winStreak.holders), me: mine(r.winStreak.holders) });
    if (r.mostMotmVotesInGame && r.mostMotmVotesInGame.votes >= 2)
      rows.push({ k: "m", v: String(r.mostMotmVotesInGame.votes), label: "Most MOTM votes in a game", who: names(r.mostMotmVotesInGame.holders), me: mine(r.mostMotmVotesInGame.holders) });
    const held = rows.filter((x) => x.me).length;
    if (rows.length >= 2) {
      cards.push({
        key: "records",
        photo: null,
        accent: "#f5d97a",
        body: (
          <>
            <div className="wr-lab wr-rise">The record book</div>
            <div className="wr-h wr-rise">{held > 0 ? "You're in it." : `${p.periodShort}'s best bits.`}</div>
            <div className="wr-rb">
              {rows.slice(0, 5).map((x) => (
                <div key={x.k} className={"wr-rb-row wr-rise" + (x.me ? " me" : "")}>
                  <b>{x.v}</b>
                  <div>
                    <span>{x.label}</span>
                    <em>{x.who}</em>
                  </div>
                </div>
              ))}
            </div>
            <div className="wr-grow" />
            <div className="wr-p wr-rise">The full record book is under Results → Records.</div>
          </>
        ),
      });
    }
  }

  if (d.predictions) {
    const pr = d.predictions;
    const head =
      pr.rank === 1 ? (pr.joint ? "Joint top of the predictions table." : "Top of the predictions table.") : pr.rank <= 3 ? `${ordinal(pr.rank)} in the predictions table.` : "Crystal ball needs a polish.";
    cards.push({
      key: "pred",
      photo: PHOTO.pred,
      accent: "#b9a6f5",
      body: (
        <>
          <div className="wr-lab wr-rise">Crystal ball</div>
          <div className="wr-h wr-rise">{head}</div>
          <div className="wr-big wr-rise" style={{ marginTop: 16 }}>
            <Count to={pr.points} />
            <small>pts</small>
          </div>
          <div className="wr-p wr-rise">From {pr.made} predictions, out of {pr.of} players who had a go.</div>
          <div className="wr-grow" />
          <div className="wr-chip wr-rise"><span className="k">{pr.exact}</span><span>{pr.exact === 0 ? "exact scores. Maybe next month." : pr.exact === 1 ? "exact score called. Spot on." : "exact scores called. Spot on."}</span></div>
        </>
      ),
    });
  }

  const c = d.club;
  const clubHead = c.whiteWins === c.redWins ? `${p.whiteName} and ${p.redName} couldn't be split.` : `${c.whiteWins > c.redWins ? p.whiteName : p.redName} had the edge.`;
  cards.push({
    key: "club",
    photo: PHOTO.club,
    accent: "#7fb0ec",
    body: (
      <>
        <div className="wr-lab wr-rise">The club&apos;s {p.periodShort}</div>
        <div className="wr-h wr-rise">{clubHead}</div>
        <div className="wr-split wr-rise">
          {c.whiteWins > 0 && <div style={{ flex: c.whiteWins, background: p.whiteColor, color: "#111" }}>{p.whiteName.toUpperCase()} {c.whiteWins}</div>}
          {c.draws > 0 && <div style={{ flex: c.draws, background: "#475569" }}>{c.draws}</div>}
          {c.redWins > 0 && <div style={{ flex: c.redWins, background: p.redColor }}>{c.redWins} {p.redName.toUpperCase()}</div>}
        </div>
        <div className="wr-grid wr-rise">
          <div><b><Count to={c.games} /></b><span>games played</span></div>
          <div><b><Count to={c.goals} /></b><span>goals, {(c.goals / Math.max(1, c.games)).toFixed(1)} a game</span></div>
          {c.highest && <div><b>{c.highest.white}–{c.highest.red}</b><span>goal-fest, {shortDate(c.highest.date)}</span></div>}
          <div><b>{d.squad}</b><span>different players this month</span></div>
        </div>
        <div className="wr-grow" />
        <div className="wr-chips">
          {d.topScorer && <div className="wr-chip wr-rise"><span className="k">{d.topScorer.goals}</span><span>goals for {d.topScorer.name}, the top scorer</span></div>}
          {c.mostApps && <div className="wr-chip wr-rise"><span className="k">{c.mostApps.apps}</span><span>games for {c.mostApps.name}, the most of anyone</span></div>}
          {c.sellOutDays !== null && c.sellOutDays >= 1 && (
            <div className="wr-chip wr-rise"><span className="k">{Math.round(c.sellOutDays)}d</span><span>before kickoff, games usually sold out. Book early.</span></div>
          )}
        </div>
      </>
    ),
  });

  cards.push({
    key: "summary",
    photo: PHOTO.summary,
    accent: "#f8b3b8",
    body: (
      <>
        <div className="wr-lab wr-rise">Your final score</div>
        <div className="wr-grow" />
        <div className="wr-poster wr-rise">
          <div className="top">
            <img src="/logo.png" alt="" />
            <div><span>{p.periodLabel.toUpperCase()} WRAPPED</span>Wirral Community Football</div>
          </div>
          <div className="nm">{d.firstName}</div>
          <div className="g">
            <div><span>Games</span><b>{d.apps}</b></div>
            <div><span>Goals</span><b>{d.goals}</b></div>
            <div><span>Record</span><b>{d.W}-{d.D}-{d.L}</b></div>
            {d.W > 0 ? <div><span>Win rate</span><b style={{ color: "#86efac" }}>{d.myRate}%</b></div> : <div><span>Minutes</span><b>{d.minutes}</b></div>}
            {d.partner && <div className="wide"><span>Wins with</span><b>{d.partner.name} · {d.partner.rate}%</b></div>}
            {d.best && (
              <div className="wide">
                <span>Best night</span>
                <b>{d.best.team === "red" ? p.redName : p.whiteName} {d.best.us}–{d.best.them} {d.best.team === "red" ? p.whiteName : p.redName}</b>
              </div>
            )}
          </div>
        </div>
        <div className="wr-acts wr-rise">
          <button className="pri" onClick={p.onShare}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9" /></svg>
            Share
          </button>
          <button className="sec" onClick={onReplay}>Watch again</button>
        </div>
        <div className="wr-grow" />
      </>
    ),
  });

  cards.push({
    key: "next",
    photo: PHOTO.end,
    accent: "#e63946",
    body: (
      <>
        <div className="wr-grow" />
        {p.soFar ? (
          <>
            <div className="wr-h wr-rise" style={{ fontSize: 34 }}>{p.periodShort}&apos;s not<br />over yet.</div>
            <div className="wr-p wr-rise">Still time to add to it. This updates after every game.</div>
          </>
        ) : (
          <>
            <div className="wr-h wr-rise" style={{ fontSize: 34 }}>New month.<br />New games.</div>
            <div className="wr-p wr-rise">Your next chapter starts on the next booking.</div>
          </>
        )}
        <div className="wr-next wr-rise">
          <button className="book" onClick={p.onBook}>Book your next game →</button>
          <button onClick={p.onBootRoom}>Visit the Boot Room</button>
        </div>
      </>
    ),
  });

  return cards;
}

export default function WrappedStory(props: WrappedStoryProps) {
  const [idx, setIdx] = useState(0);
  const [held, setHeld] = useState(false);
  const [drag, setDrag] = useState(0);
  const [closing, setClosing] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);
  const clock = useRef({ start: 0, elapsed: 0, paused: false });
  const pointer = useRef<{ x: number; y: number; holdTimer: number; held: boolean } | null>(null);

  const cards = useMemo(
    () => buildWrappedCards(props, () => setIdx(0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.data, props.prev, props.periodKey, props.soFar]
  );
  const last = cards.length - 1;

  // Warm the photos so each card's background is there when it arrives.
  useEffect(() => {
    for (const c of cards) if (c.photo) new Image().src = c.photo;
  }, [cards]);

  // No page scrolling underneath while the story is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function close() {
    setClosing(true);
    window.setTimeout(props.onClose, 220);
  }
  function go(i: number) {
    setIdx(Math.max(0, Math.min(last, i)));
  }

  // The progress bar and auto-advance run off one clock, paused while the
  // card is held down. Stops on the last card rather than closing itself.
  useEffect(() => {
    clock.current = { start: performance.now(), elapsed: 0, paused: false };
    let raf = 0;
    const tick = (now: number) => {
      const c = clock.current;
      const e = c.paused ? c.elapsed : c.elapsed + (now - c.start);
      if (barRef.current) barRef.current.style.width = `${Math.min(100, (e / CARD_MS) * 100)}%`;
      if (e >= CARD_MS) {
        if (idx < last) setIdx(idx + 1);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idx, last]);

  function pause(p: boolean) {
    const c = clock.current;
    const now = performance.now();
    if (p && !c.paused) c.elapsed += now - c.start;
    if (!p && c.paused) c.start = now;
    c.paused = p;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
      else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Tap the left third to go back, anywhere else to go forward; hold to
  // pause; drag down to close.
  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const holdTimer = window.setTimeout(() => {
      if (!pointer.current) return;
      pointer.current.held = true;
      pause(true);
      setHeld(true);
    }, HOLD_MS);
    pointer.current = { x: e.clientX, y: e.clientY, holdTimer, held: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const p = pointer.current;
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 10) {
      window.clearTimeout(p.holdTimer);
      setDrag(dy);
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    const p = pointer.current;
    if (!p) return;
    pointer.current = null;
    window.clearTimeout(p.holdTimer);
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    setDrag(0);
    if (p.held) {
      setHeld(false);
      pause(false);
    }
    if (dy > 90) return close();
    if (p.held) return;
    if (Math.abs(dx) > 50) return go(dx < 0 ? idx + 1 : idx - 1);
    if (Math.abs(dy) < 10) {
      const w = (e.currentTarget as HTMLElement).clientWidth;
      go(e.clientX < w / 3 ? idx - 1 : idx + 1);
    }
  }
  function onPointerCancel() {
    const p = pointer.current;
    if (!p) return;
    window.clearTimeout(p.holdTimer);
    pointer.current = null;
    setDrag(0);
    if (p.held) {
      setHeld(false);
      pause(false);
    }
  }

  const card = cards[idx];
  const style: CSSProperties = drag ? { transform: `translateY(${drag}px) scale(${1 - Math.min(drag, 300) / 1800})`, transition: "none" } : {};

  return (
    <div
      className={"wr-story" + (closing ? " closing" : "") + (held ? " held" : "")}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={`${props.periodLabel} Wrapped`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <style>{wrappedCss}</style>
      <div key={card.key} className="wr-card" style={{ "--acc": card.accent } as CSSProperties}>
        {card.photo && <div className={"wr-photo" + (STRONG_PHOTOS.has(card.photo) ? " strong" : "")} style={{ backgroundImage: `url(${card.photo})` }} />}
        <div className="wr-glow" />
        <div className="wr-in">{card.body}</div>
      </div>
      <div className="wr-top">
        <div className="wr-segs">
          {cards.map((c, i) => (
            <i key={c.key}>
              <b ref={i === idx ? (el) => { barRef.current = el; } : undefined} style={i < idx ? { width: "100%" } : i > idx ? { width: 0 } : undefined} />
            </i>
          ))}
        </div>
        <div className="wr-bar">
          <img src="/logo.png" alt="" />
          <span>{props.periodShort} {props.soFar ? "so far" : "Wrapped"}</span>
          <span className="sp" />
          <button onClick={close} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 4l10 10M14 4L4 14" /></svg>
          </button>
        </div>
      </div>
      <div className="wr-paused">PAUSED</div>
    </div>
  );
}

// ── The shareable poster (1080x1350, same size as the result and Player
// of the Month cards). Drawn on a canvas, like those two.
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function drawWrappedCard(opts: {
  data: WrappedData;
  periodLabel: string;
  whiteName: string;
  redName: string;
}): Promise<Blob> {
  const { data: d } = opts;
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Canvas isn't supported on this device");
  const ctx: CanvasRenderingContext2D = ctx2d;

  await document.fonts.ready;
  const rootStyle = getComputedStyle(document.documentElement);
  const sora = rootStyle.getPropertyValue("--font-sora").trim() || "sans-serif";
  const inter = rootStyle.getPropertyValue("--font-inter").trim() || "sans-serif";
  const soraFont = (weight: number, size: number) => `${weight} ${size}px ${sora}`;
  const interFont = (weight: number, size: number) => `${weight} ${size}px ${inter}`;
  const spaced = (px: number) => ((ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`);
  function fit(text: string, maxWidth: number, fontFn: (w: number, s: number) => string, weight: number, maxSize: number, minSize: number) {
    let size = maxSize;
    ctx.font = fontFn(weight, size);
    const w = ctx.measureText(text).width;
    if (w > maxWidth) size = Math.max(minSize, Math.floor(maxSize * (maxWidth / w)));
    ctx.font = fontFn(weight, size);
    return size;
  }

  // Ground: the story's poster gradient, red and violet glows on navy.
  ctx.fillStyle = "#0d0d1a";
  ctx.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(13,13,26,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  // The same photo as the story's final card, dimmed under the glows.
  try {
    const bg = await loadImg("/wrapped/summary.jpg");
    const scale = Math.max(W / bg.width, H / bg.height);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(bg, W / 2 - (bg.width * scale) / 2, H / 2 - (bg.height * scale) / 2, bg.width * scale, bg.height * scale);
    ctx.globalAlpha = 1;
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(13,13,26,0.55)");
    scrim.addColorStop(0.5, "rgba(13,13,26,0.75)");
    scrim.addColorStop(1, "rgba(13,13,26,0.9)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } catch {
    // Photo failed to load (offline etc.) - the glows alone still work.
  }
  glow(W, 0, 900, "rgba(230,57,70,0.45)");
  glow(0, H, 1000, "rgba(139,107,232,0.45)");
  glow(W * 0.8, H * 0.75, 600, "rgba(127,176,236,0.18)");

  const pad = 80;
  const white = "#F5F6F8";
  const pink = "#f8b3b8";
  const dim = "rgba(245,246,248,0.62)";

  // Header: crest + label.
  try {
    const crest = await loadImg("/logo.png");
    const ch = 110;
    const cw = (crest.width / crest.height) * ch;
    ctx.drawImage(crest, pad, pad, cw, ch);
  } catch {
    // Crest failed to load (offline etc.) - the text still carries it.
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = pink;
  ctx.font = interFont(700, 24);
  spaced(24 * 0.24);
  ctx.fillText(`${opts.periodLabel.toUpperCase()} WRAPPED`, pad + 110, pad + 22);
  ctx.fillStyle = white;
  ctx.font = soraFont(800, 30);
  spaced(30 * 0.06);
  ctx.fillText("WIRRAL COMMUNITY FOOTBALL", pad + 110, pad + 58);
  spaced(0);

  // Name.
  const nameSize = fit(d.firstName, W - pad * 2, soraFont, 800, 150, 60);
  ctx.fillStyle = white;
  ctx.font = soraFont(800, nameSize);
  spaced(nameSize * -0.03);
  ctx.fillText(d.firstName, pad, 290);
  spaced(0);

  // Stats: two columns, then full-width rows.
  const pairs: [string, string, string?][] = [
    ["GAMES", String(d.apps)],
    ["GOALS", String(d.goals)],
    ["RECORD", `${d.W}-${d.D}-${d.L}`],
    d.W > 0 ? ["WIN RATE", `${d.myRate}%`, "#86efac"] : ["MINUTES", String(d.minutes)],
  ];
  const wide: [string, string][] = [];
  if (d.partner) wide.push(["WINS WITH", `${d.partner.name} · ${d.partner.rate}%`]);
  if (d.best) {
    const us = d.best.team === "red" ? opts.redName : opts.whiteName;
    const them = d.best.team === "red" ? opts.whiteName : opts.redName;
    wide.push(["BEST NIGHT", `${us} ${d.best.us}–${d.best.them} ${them}`]);
  }

  let y = 520;
  const colW = (W - pad * 2) / 2;
  pairs.forEach(([label, value, color], i) => {
    const x = pad + (i % 2) * colW;
    const rowY = y + Math.floor(i / 2) * 170;
    ctx.fillStyle = dim;
    ctx.font = interFont(700, 24);
    spaced(24 * 0.18);
    ctx.fillText(label, x, rowY);
    spaced(0);
    ctx.fillStyle = color ?? white;
    fit(value, colW - 30, soraFont, 800, 84, 40);
    ctx.fillText(value, x, rowY + 38);
  });
  y += 2 * 170 + 10;
  for (const [label, value] of wide) {
    ctx.fillStyle = dim;
    ctx.font = interFont(700, 24);
    spaced(24 * 0.18);
    ctx.fillText(label, pad, y);
    spaced(0);
    ctx.fillStyle = white;
    fit(value, W - pad * 2, soraFont, 800, 56, 30);
    ctx.fillText(value, pad, y + 36);
    y += 130;
  }

  // Footer.
  ctx.fillStyle = dim;
  ctx.font = interFont(600, 22);
  spaced(22 * 0.12);
  ctx.textBaseline = "alphabetic";
  ctx.fillText("wirral-community-football.com", pad, H - pad + 6);
  spaced(0);
  ctx.fillStyle = "#e63946";
  ctx.fillRect(0, H - 8, W, 8);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't generate the image"))), "image/png");
  });
}

const wrappedCss = `
.wr-story{position:fixed;inset:0;z-index:3000;background:#000;color:#fff;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;
  animation:wr-open .32s cubic-bezier(.2,.8,.2,1);transition:transform .25s ease,opacity .22s ease;font-family:var(--sans)}
.wr-story.closing{opacity:0;transform:scale(.96)}
@keyframes wr-open{from{opacity:0;transform:scale(.94)}}
.wr-card{position:absolute;inset:0;display:flex;flex-direction:column;background:#0d0d1a;
  padding:calc(env(safe-area-inset-top,0px) + 92px) 24px calc(env(safe-area-inset-bottom,0px) + 32px)}
.wr-photo{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.55}
.wr-photo.strong{opacity:.92}
.wr-photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(8,8,18,.55) 0%,rgba(8,8,18,.2) 35%,rgba(8,8,18,.92) 78%)}
.wr-glow{position:absolute;left:-160px;bottom:-200px;width:420px;height:420px;border-radius:50%;filter:blur(60px);opacity:.45;background:var(--acc)}
.wr-in{position:relative;z-index:1;flex:1;display:flex;flex-direction:column;min-height:0;max-width:480px;width:100%;margin:0 auto}
.wr-top{position:absolute;z-index:3;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 0;background:linear-gradient(180deg,rgba(0,0,0,.45),transparent)}
.wr-segs{display:flex;gap:4px}
.wr-segs i{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.28);overflow:hidden}
.wr-segs b{display:block;height:100%;width:0;background:#fff}
.wr-bar{display:flex;align-items:center;gap:8px;margin-top:8px;padding-left:2px;font-size:12.5px;font-weight:700}
.wr-bar img{width:24px;height:24px;object-fit:contain}
.wr-bar .sp{flex:1}
.wr-bar button{width:40px;height:40px;border:0;background:transparent;color:#fff;display:grid;place-items:center;padding:0;cursor:pointer}
.wr-paused{position:absolute;z-index:3;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);transform:translateX(-50%);font-size:11px;font-weight:700;letter-spacing:.1em;padding:5px 10px;border-radius:20px;background:rgba(0,0,0,.55);opacity:0;transition:opacity .15s}
.wr-story.held .wr-paused{opacity:1}

.wr-lab{font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--acc)}
.wr-h{font-family:var(--display);font-weight:800;font-size:30px;line-height:1.08;letter-spacing:-.015em;margin-top:10px;text-wrap:balance}
.wr-big{font-family:var(--display);font-weight:800;font-size:108px;line-height:.9;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.wr-big small{font-size:24px;letter-spacing:-.01em;margin-left:8px;color:rgba(255,255,255,.75)}
.wr-p{font-size:15px;line-height:1.5;color:rgba(255,255,255,.84);margin-top:10px}
.wr-p b{color:#fff}
.wr-grow{flex:1;min-height:12px}
.wr-chips{display:flex;flex-direction:column;gap:8px}
.wr-chip{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:14px;padding:11px 13px;font-size:13.5px;line-height:1.35}
.wr-chip .k{font-family:var(--display);font-weight:800;font-size:20px;min-width:42px;color:var(--acc);font-variant-numeric:tabular-nums}

.wr-logo{width:84px;height:84px;object-fit:contain;filter:drop-shadow(0 6px 24px rgba(0,0,0,.6))}
.wr-period{font-family:var(--display);font-weight:800;font-size:clamp(52px,17vw,84px);line-height:.95;letter-spacing:-.035em;margin-top:18px;background:linear-gradient(180deg,#fff 30%,#f8b3b8);-webkit-background-clip:text;background-clip:text;color:transparent}
.wr-wrapped{font-family:var(--display);font-weight:800;font-size:22px;letter-spacing:.3em;color:#f8b3b8;margin-top:6px}
.wr-tap{display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,.62)}
.wr-tap i{width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(255,255,255,.5);animation:wr-pulse 1.6s ease-out infinite}
@keyframes wr-pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.35)}100%{box-shadow:0 0 0 12px rgba(255,255,255,0)}}

.wr-kit{display:flex;height:54px;border-radius:14px;overflow:hidden;margin-top:18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
.wr-kit div{display:flex;align-items:center;justify-content:center;padding:0 10px;font-family:var(--display);font-weight:800;font-size:15px;min-width:40px;white-space:nowrap}
.wr-kit div:first-child:not(:last-child){justify-content:flex-start}
.wr-kit .light{color:#111}
.wr-rec{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}
.wr-rec div{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px 8px 10px;text-align:center}
.wr-rec b{display:block;font-family:var(--display);font-size:34px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.wr-rec div>span{font-size:10.5px;letter-spacing:.14em;font-weight:700;color:rgba(255,255,255,.65)}
.wr-rec .w b{color:#86efac}.wr-rec .l b{color:#f8b3b8}

.wr-duo{display:flex;align-items:center;margin-top:22px}
.wr-av{width:78px;height:78px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:26px;box-shadow:0 0 0 3px #0d0d1a;object-fit:cover;flex:none}
.wr-av.me{background:linear-gradient(135deg,#e63946,#8b6be8)}
.wr-av.them{background:linear-gradient(135deg,#7fb0ec,#86efac);color:#0d1a14;margin-left:-16px}
.wr-duo-name{margin-left:14px;font-family:var(--display);font-weight:800;font-size:22px;line-height:1.1;min-width:0}
.wr-duo-name small{display:block;font-family:var(--sans);font-size:12px;font-weight:600;color:rgba(255,255,255,.68);margin-top:3px}
.wr-rate{display:flex;align-items:baseline;gap:10px;margin-top:18px}
.wr-rate .wr-big{font-size:88px}
.wr-rate>span{font-size:14px;line-height:1.35;color:rgba(255,255,255,.8)}
.wr-vs{height:8px;border-radius:4px;background:rgba(255,255,255,.14);margin-top:6px;overflow:hidden}
.wr-vs i{display:block;height:100%;border-radius:4px;animation:wr-grow 1s cubic-bezier(.2,.8,.2,1) both}
@keyframes wr-grow{from{width:0}}
.wr-vs-lab{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:rgba(255,255,255,.72);margin-top:10px}

.wr-score{display:flex;align-items:center;gap:14px;margin-top:16px}
.wr-score .tm{font-family:var(--display);font-weight:800;font-size:15px;letter-spacing:.08em}
.wr-score .n{font-family:var(--display);font-weight:800;font-size:96px;line-height:.9;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.wr-score .n.dim{color:rgba(255,255,255,.55)}
.wr-score .dash{font-size:50px;font-family:var(--display);font-weight:800;color:rgba(255,255,255,.4)}

.wr-split{display:flex;height:38px;border-radius:12px;overflow:hidden;margin-top:14px;font-family:var(--display);font-weight:800;font-size:12.5px}
.wr-split div{display:flex;align-items:center;justify-content:center;min-width:34px;white-space:nowrap;padding:0 6px}
.wr-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.wr-grid div{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:11px 12px}
.wr-grid b{display:block;font-family:var(--display);font-weight:800;font-size:28px;line-height:1;font-variant-numeric:tabular-nums}
.wr-grid div>span{display:block;font-size:11.5px;color:rgba(255,255,255,.7);margin-top:5px;line-height:1.3}

.wr-poster{background:linear-gradient(160deg,rgba(230,57,70,.3),rgba(139,107,232,.3) 55%,rgba(127,176,236,.2)),rgba(20,16,36,.62);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 24px 60px -20px rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:18px 18px 20px}
.wr-poster .top{display:flex;align-items:center;gap:10px}
.wr-poster .top img{width:38px;height:38px;object-fit:contain}
.wr-poster .top div{font-family:var(--display);font-weight:800;font-size:13px;letter-spacing:.1em;line-height:1.3}
.wr-poster .top div span{display:block;color:#f8b3b8;font-size:10.5px;letter-spacing:.2em}
.wr-poster .nm{font-family:var(--display);font-weight:800;font-size:28px;margin-top:14px}
.wr-poster .g{display:grid;grid-template-columns:1fr 1fr;gap:12px 10px;margin-top:12px}
.wr-poster .g span{display:block;font-size:10px;letter-spacing:.16em;font-weight:700;color:rgba(255,255,255,.6);text-transform:uppercase}
.wr-poster .g b{display:block;font-family:var(--display);font-weight:800;font-size:21px;margin-top:3px;line-height:1.15}
.wr-poster .g .wide{grid-column:1/-1}
.wr-acts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.wr-acts button{height:48px;border-radius:14px;border:0;font:inherit;font-weight:700;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}
.wr-acts .pri{background:#fff;color:#0d0d1a}
.wr-acts .sec{background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}

.wr-card .wr-rise{animation:wr-rise .6s cubic-bezier(.2,.8,.2,1) both}
.wr-in>.wr-rise:nth-child(2){animation-delay:.08s}.wr-in>.wr-rise:nth-child(3){animation-delay:.16s}
.wr-in>.wr-rise:nth-child(4){animation-delay:.24s}.wr-in>.wr-rise:nth-child(n+5){animation-delay:.32s}
@keyframes wr-rise{from{opacity:0;transform:translateY(18px)}}
@media (prefers-reduced-motion:reduce){.wr-card .wr-rise,.wr-story,.wr-vs i,.wr-orb,.wr-ring circle[style]{animation:none}}

.wr-kicker{font-family:var(--display);font-weight:700;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.8);margin-top:18px}
.wr-period{margin-top:2px}
.wr-stack{display:flex;flex-direction:column;gap:22px;margin-top:22px}
.wr-stat b{display:block;font-family:var(--display);font-weight:800;font-size:64px;line-height:.95;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.wr-stat b small{font-size:22px;letter-spacing:0;margin-left:8px;color:rgba(255,255,255,.7)}
.wr-stat>span:not(.wr-delta){display:block;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.7);margin-top:4px}
.wr-delta{display:inline-flex;align-items:center;gap:4px;margin-top:8px;font-size:12px;font-weight:700;padding:3px 8px;border-radius:8px;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.wr-delta.up{color:#86efac}.wr-delta.down{color:#f8b3b8}.wr-delta.same{color:rgba(255,255,255,.7)}
.wr-ringrow{display:flex;align-items:center;gap:22px;margin-top:22px}
.wr-ringwrap{position:relative;width:140px;height:140px;flex:none}
.wr-ring circle[style]{animation:wr-arc 1s cubic-bezier(.2,.8,.2,1) both}
@keyframes wr-arc{from{stroke-dasharray:0 999}}
.wr-ringmid{position:absolute;inset:0;display:grid;place-items:center;align-content:center;text-align:center}
.wr-ringmid b{font-family:var(--display);font-weight:800;font-size:36px;line-height:1}
.wr-ringmid span{font-size:10px;font-weight:700;letter-spacing:.16em;color:rgba(255,255,255,.65);margin-top:3px}
.wr-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px;font-size:15px;color:rgba(255,255,255,.85)}
.wr-legend li{display:flex;align-items:center;gap:9px}
.wr-legend i{width:10px;height:10px;border-radius:50%}
.wr-legend b{font-family:var(--display);font-size:20px}
.wr-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-top:20px}
.wr-cal span{aspect-ratio:1;display:grid;place-items:center;border-radius:8px;font-size:11px;color:rgba(255,255,255,.35)}
.wr-cal .hd{aspect-ratio:auto;font-weight:700;color:rgba(255,255,255,.6);letter-spacing:.08em}
.wr-cal .day{background:rgba(255,255,255,.05)}
.wr-cal .rW,.wr-cal .rD,.wr-cal .rL{font-family:var(--display);font-weight:800;font-size:13px;color:#0d0d1a}
.wr-cal .rW{background:#86efac;box-shadow:0 0 14px rgba(134,239,172,.45)}
.wr-cal .rD{background:#cbd5e1}
.wr-cal .rL{background:#f8b3b8}
.wr-form{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.wr-form i{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-family:var(--display);font-weight:800;font-size:12px;color:#0d0d1a}
.wr-form .rW{background:#86efac}.wr-form .rD{background:#cbd5e1}.wr-form .rL{background:#f8b3b8}
.wr-orbit{position:relative;width:min(100%,280px);aspect-ratio:1;margin:18px auto 0}
.wr-orbit svg{position:absolute;inset:0;width:100%;height:100%}
.wr-orbit line{stroke:rgba(185,166,245,.35);stroke-width:1.2}
.wr-orb{position:absolute;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;display:grid;place-items:center;object-fit:cover;font-family:var(--display);font-weight:800;font-size:15px;background:linear-gradient(135deg,#2a2f4a,#3b3470);box-shadow:0 0 0 2px rgba(185,166,245,.55);animation:wr-pop .5s cubic-bezier(.2,.8,.2,1) both}
.wr-orb.top{box-shadow:0 0 0 3px #b9a6f5,0 0 18px rgba(185,166,245,.6)}
.wr-orb.you{left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;font-size:15px;letter-spacing:.08em;background:linear-gradient(135deg,#e63946,#8b6be8);box-shadow:0 0 0 3px #0d0d1a,0 0 30px rgba(230,57,70,.45)}
@keyframes wr-pop{from{opacity:0;transform:scale(.4)}}
.wr-next{display:flex;flex-direction:column;gap:10px;margin-top:22px}
.wr-next button{height:52px;border-radius:14px;border:0;font:inherit;font-weight:700;font-size:15px;cursor:pointer;background:rgba(255,255,255,.1);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
.wr-next .book{background:#e63946;box-shadow:0 10px 30px -8px rgba(230,57,70,.7)}

.wr-rb{display:flex;flex-direction:column;gap:8px;margin-top:18px}
.wr-rb-row{display:grid;grid-template-columns:56px minmax(0,1fr);gap:12px;align-items:center;min-height:60px;padding:10px 12px;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}
.wr-rb-row>b{font-family:var(--display);font-weight:800;font-size:26px;text-align:center;font-variant-numeric:tabular-nums;color:var(--acc)}
.wr-rb-row span{display:block;font-size:13.5px;font-weight:700}
.wr-rb-row em{display:block;font-style:normal;font-size:12.5px;color:rgba(255,255,255,.72);margin-top:2px;line-height:1.35}
.wr-rb-row.me{background:rgba(245,217,122,.14);border-color:rgba(245,217,122,.55);box-shadow:0 0 24px -8px rgba(245,217,122,.6)}
.wr-rb-row.me em{color:#f5d97a;font-weight:700}

/* The Fixtures banner that opens it. */
.wr-banner-wrap{position:relative;margin-bottom:14px}
.wr-banner{position:relative;display:block;width:100%;text-align:left;border:0;cursor:pointer;padding:14px 40px 14px 14px;border-radius:18px;color:#fff;font:inherit;overflow:hidden;
  background:radial-gradient(120% 140% at 100% 0%,rgba(230,57,70,.55),transparent 55%),radial-gradient(120% 140% at 0% 100%,rgba(139,107,232,.55),transparent 60%),#1a1430;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
.wr-banner::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.14) 45%,transparent 60%);transform:translateX(-100%);animation:wr-sheen 3.6s ease-in-out infinite;pointer-events:none}
@keyframes wr-sheen{0%,55%{transform:translateX(-100%)}85%,100%{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.wr-banner::after{animation:none}}
.wr-banner .row{display:flex;align-items:center;gap:12px;position:relative;z-index:1}
.wr-banner .yr{flex:none;width:52px;height:52px;border-radius:14px;background:rgba(13,13,26,.55);display:grid;place-items:center;align-content:center;font-family:var(--display);font-weight:800;font-size:13px;line-height:1;text-align:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.wr-banner .yr span{display:block;font-size:8px;letter-spacing:.14em;color:#f8b3b8;margin-top:4px}
.wr-banner .copy{flex:1;min-width:0}
.wr-banner .h{display:block;font-family:var(--display);font-weight:800;font-size:15.5px;line-height:1.2}
.wr-banner .s{display:block;font-size:12.5px;color:#d8d4ec;margin-top:3px;line-height:1.35}
.wr-banner .tag{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.12em;color:#0d0d1a;background:#f5d97a;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:2px}
.wr-banner-x{position:absolute;top:4px;right:4px;z-index:2;width:36px;height:36px;border:0;background:transparent;color:rgba(255,255,255,.6);font-size:18px;cursor:pointer;line-height:1;padding:0;display:grid;place-items:center}
`;

// Exported for the banner, which lives on the Fixtures tab.
export const wrappedBannerCss = wrappedCss;
