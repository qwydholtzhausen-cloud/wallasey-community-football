"use client";

// The full-time card (admins first, FULLTIME_CARD_OPEN_TO_ALL_FROM): one card
// for a finished game - the score as the headline, a one-line caption,
// both teams in their own panels (scorers first, then everyone else who
// played, own goals with the side they counted for), the squad's rating,
// and Man of the Match as the finale (a gold ring draws round the face).
// Results shows it in full for the latest game; the Feed shows it compact.
// The build-up plays once per game per phone, then it just sits there.

import { useEffect, useState, type ReactNode } from "react";
import { Avatar, avatarFor, motionAllowed } from "./shared";

export type FtSide = "white" | "red";
export type FtPlayer = { id: string; name: string; goals: number; me?: boolean };
export type FtOwnGoal = { id: string; name: string; n: number };
export type FtWinner = { id: string; name: string; avatarUrl?: string | null; team: FtSide | null };

export type FullTimeCardProps = {
  animKey: string; // localStorage key: the build-up plays once
  dateLabel: string; // "Mon 9 Nov"
  venue: string;
  white: number;
  red: number;
  whiteName: string;
  redName: string;
  whiteColor: string;
  redColor: string;
  // Full card only: who played on each side, and own goals by the side they counted for.
  teams?: { white: FtPlayer[]; red: FtPlayer[]; ogWhite: FtOwnGoal[]; ogRed: FtOwnGoal[] } | null;
  rating?: { average: number; ratings: number } | null;
  motm?: { winners: FtWinner[]; votes: number; total: number } | null;
  vote?: { closes: string; voted: number; of: number; canVote: boolean; myVote: boolean } | null;
  compact?: boolean;
  primary?: { label: string; onClick: () => void } | null;
  onShare?: (() => void) | null;
  onPlayer?: (id: string) => void;
  footer?: ReactNode; // replaces the default footer (the Feed puts its reactions here)
};

// "Lewis Francom" -> "Lewis F", "ADRIAN" -> "Adrian", "dagzy" -> "Dagzy".
export function ftShort(name: string) {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  const cap = (w: string) => (w === w.toUpperCase() && w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1));
  if (parts.length === 0) return name;
  if (parts.length === 1) return cap(parts[0]);
  return `${cap(parts[0])} ${parts[parts.length - 1][0].toUpperCase()}`;
}

// The line under the score.
export function ftCaption(white: number, red: number, whiteName: string, redName: string) {
  if (white === red) return "Honours even.";
  const team = white > red ? whiteName : redName;
  const m = Math.abs(white - red);
  return m >= 4 ? `${team} ran riot.` : m === 1 ? `${team} edge it.` : `${team} take it.`;
}

const brightRed = (c: string) => (c.toLowerCase() === "#e63946" ? "#ff4d5a" : c);

export function FullTimeCard(p: FullTimeCardProps) {
  // Play the build-up the first time this game's card is seen on this phone.
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (!motionAllowed()) return;
    try {
      if (localStorage.getItem(p.animKey)) return;
      localStorage.setItem(p.animKey, "1");
    } catch {
      return;
    }
    setPlay(true);
  }, [p.animKey]);

  const redCol = brightRed(p.redColor);
  const words = (n: string) => n.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  const team = (side: FtSide) => {
    const list = p.teams?.[side] ?? [];
    const og = side === "white" ? (p.teams?.ogWhite ?? []) : (p.teams?.ogRed ?? []);
    const scorers = list.filter((x) => x.goals > 0).sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name));
    const rest = list.filter((x) => x.goals === 0).sort((a, b) => a.name.localeCompare(b.name));
    const nm = (x: FtPlayer) => (x.me ? "You" : ftShort(x.name));
    return (
      <div className={"ft-tb " + side} style={{ ["--tc" as string]: side === "white" ? p.whiteColor : redCol }}>
        <div className="ft-th">
          <u />
          {side === "white" ? p.whiteName : p.redName}
          <small>{list.length} played</small>
        </div>
        {scorers.length + og.length > 0 && (
          <div className="ft-ps">
            {scorers.map((x) => (
              <button key={x.id} className={"ft-p sc" + (x.goals >= 3 ? " gold" : "") + (x.me ? " me" : "")} onClick={() => p.onPlayer?.(x.id)}>
                {nm(x)}
                {x.goals > 1 && <em>{x.goals}</em>}
                {x.goals >= 3 && <i>{x.goals >= 6 ? "DHT" : "HT"}</i>}
              </button>
            ))}
            {og.map((x) => (
              <button key={"og" + x.id} className="ft-p sc og" onClick={() => p.onPlayer?.(x.id)} title="Own goal">
                {ftShort(x.name)}
                <b>OG</b>
                {x.n > 1 && <em>{x.n}</em>}
              </button>
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <div className={"ft-ps dim" + (scorers.length + og.length === 0 ? " only" : "")}>
            {rest.map((x) => (
              <button key={x.id} className={"ft-p" + (x.me ? " me" : "")} onClick={() => p.onPlayer?.(x.id)}>
                {nm(x)}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const m = p.motm && p.motm.winners.length > 0 && p.motm.total > 0 ? p.motm : null;
  const single = m && m.winners.length === 1 ? m.winners[0] : null;
  const teamPill = (t: FtSide | null) =>
    t ? (
      <span className={"ft-tp " + t} style={{ ["--tc" as string]: t === "white" ? p.whiteColor : redCol }}>
        <u />
        {t === "white" ? p.whiteName : p.redName}
      </span>
    ) : null;
  let wordIdx = 0;

  return (
    <article className={"ft" + (p.compact ? " compact" : "") + (play ? " play" : "")}>
      <style>{fullTimeCss}</style>
      <div className="ft-ph" aria-hidden="true" />
      <div className="ft-ey">
        <span>
          Full time · {p.dateLabel} · {p.venue}
        </span>
        <i />
      </div>
      <div className="ft-sb" aria-label={`${p.whiteName} ${p.white}, ${p.redName} ${p.red}`}>
        <div className="ft-tm" style={{ ["--tc" as string]: p.whiteColor }}>
          <u />
          {p.whiteName}
        </div>
        <div className="ft-sc">
          <span className="m">
            <b style={{ color: p.whiteColor }}>{p.white}</b>
          </span>
          <span className="dash">–</span>
          <span className="m r">
            <b style={{ color: redCol }}>{p.red}</b>
          </span>
        </div>
        <div className="ft-tm r" style={{ ["--tc" as string]: redCol }}>
          <u />
          {p.redName}
        </div>
      </div>
      <div className="ft-hl">{ftCaption(p.white, p.red, p.whiteName, p.redName)}</div>

      {!p.compact && p.teams && (
        <div className="ft-tms">
          {team("white")}
          {team("red")}
        </div>
      )}

      {!p.compact && p.rating && p.rating.ratings > 0 && (
        <div className="ft-rt">
          <span aria-hidden="true">
            {[1, 2, 3, 4, 5].map((n) => (
              <i key={n} className={n <= Math.round(p.rating!.average) ? "on" : ""} />
            ))}
          </span>
          Rated {p.rating.average.toFixed(1)} by {p.rating.ratings} {p.rating.ratings === 1 ? "player" : "players"}
        </div>
      )}

      {p.vote ? (
        <div className="ft-mm open">
          <div className="ey2">Man of the Match · voting open</div>
          <div className="q">{p.vote.canVote ? (p.vote.myVote ? "You've voted. Change your mind?" : "Who was your Man of the Match?") : "Who'll be Man of the Match?"}</div>
          <div className="meta">
            {p.vote.voted} of {p.vote.of} have voted · result at {p.vote.closes}
          </div>
          {p.vote.canVote && p.primary && (
            <button className="ft-vote" onClick={p.primary.onClick}>
              {p.vote.myVote ? "Change your vote" : "Vote now"}
            </button>
          )}
        </div>
      ) : m ? (
        <div className="ft-mm">
          <div className={"faces" + (single ? "" : " two")}>
            {single && (
              <svg className="ring" viewBox="0 0 122 122" aria-hidden="true">
                <defs>
                  <linearGradient id="ftRingG" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0" stopColor="#c9a24a" />
                    <stop offset=".5" stopColor="#fff3c4" />
                    <stop offset="1" stopColor="#c9a24a" />
                  </linearGradient>
                </defs>
                <circle cx="61" cy="61" r="58" />
              </svg>
            )}
            {m.winners.slice(0, 2).map((w) => (
              <button key={w.id} className="face-b" onClick={() => p.onPlayer?.(w.id)} aria-label={w.name}>
                <Avatar name={w.name} avatarUrl={w.avatarUrl} className="ft-face" background={avatarFor(w.name).gradient} />
              </button>
            ))}
          </div>
          <div className="ey2">{m.winners.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</div>
          <div className={"nm" + (m.winners.length > 1 ? " joint" : "")}>
            {m.winners.slice(0, 2).map((w, wi) => (
              <span key={w.id} className="who">
                {wi > 0 && <span className="amp">&amp;</span>}
                {words(w.name).map((x) => (
                  <span key={x + wordIdx} className="w">
                    <b style={{ ["--d" as string]: `${1.95 + 0.12 * wordIdx++}s` }}>{x}</b>
                  </span>
                ))}
              </span>
            ))}
          </div>
          <div className="meta">
            {single && teamPill(single.team)}
            <span>
              <b>
                {m.votes} of {m.total}
              </b>{" "}
              votes
            </span>
          </div>
          {single && (
            <div className="bar">
              <i style={{ width: `${Math.round((m.votes / m.total) * 100)}%` }} />
            </div>
          )}
        </div>
      ) : null}

      {p.footer ?? (
        <div className="ft-ft">
          {p.primary && !p.vote ? (
            <button className="pri" onClick={p.primary.onClick}>
              {p.primary.label}
            </button>
          ) : (
            <span className="sp" />
          )}
          {p.onShare && (
            <button className="sh" onClick={p.onShare}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9" />
              </svg>
              Share
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export const fullTimeCss = `
.ft{position:relative;margin:0 0 16px;border-radius:24px;overflow:hidden;background:#0a0f1d;box-shadow:0 26px 50px -28px #000,inset 0 0 0 1px rgba(255,255,255,.07);isolation:isolate;text-align:left}
:where(.ft button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.ft-ph{position:absolute;inset:0 0 auto 0;height:300px;background:url(/wrapped/bank/month-floodlights.jpg) center 35%/cover;opacity:.55;z-index:-2}
.ft-ph::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,15,29,.15) 0%,rgba(10,15,29,.7) 55%,#0a0f1d 100%)}
.ft-ey{display:flex;align-items:center;gap:8px;padding:18px 18px 0;font:700 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a;white-space:nowrap}
.ft-ey span{overflow:hidden;text-overflow:ellipsis}
.ft-ey i{flex:1;min-width:16px;height:1px;background:linear-gradient(90deg,rgba(245,217,122,.7),transparent);transform-origin:left}
.ft-sb{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;padding:22px 12px 6px}
.ft-tm{display:grid;gap:7px;justify-items:center;font:700 13px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#cbd5e1;text-align:center;overflow-wrap:anywhere}
.ft-tm u{display:block;width:34px;height:3px;border-radius:2px;background:var(--tc)}
.ft-tm.r u{box-shadow:0 0 12px color-mix(in srgb,var(--tc) 70%,transparent)}
.ft-sc{display:flex;align-items:center;gap:12px;font:800 76px/1 var(--display);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.ft-sc .m{overflow:hidden;height:76px;display:inline-block}
.ft-sc .m b{display:block}
.ft-sc .dash{font-size:32px;color:rgba(255,255,255,.35)}
.ft-hl{text-align:center;font:700 italic 17px var(--font-playfair),Georgia,serif;color:#e2e8f0;margin:2px 14px 14px}
.ft-tms{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;padding:0 12px 2px}
.ft-tb{min-width:0;padding:11px 11px 12px;border-radius:16px;background:linear-gradient(180deg,color-mix(in srgb,var(--tc) 9%,transparent),color-mix(in srgb,var(--tc) 2%,transparent));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tc) 20%,transparent)}
.ft-tb.red{background:linear-gradient(180deg,color-mix(in srgb,var(--tc) 15%,transparent),color-mix(in srgb,var(--tc) 3%,transparent));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tc) 28%,transparent)}
.ft-th{display:flex;align-items:center;gap:7px;font:700 12px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#fff;margin-bottom:9px;min-width:0}
.ft-th u{flex:none;width:14px;height:4px;border-radius:2px;background:var(--tc)}
.ft-th small{margin-left:auto;font:600 9.5px var(--sans);letter-spacing:0;text-transform:none;color:#64748b;white-space:nowrap}
.ft-ps{display:flex;flex-wrap:wrap;gap:5px 9px;font:600 12.5px/1.35 var(--sans)}
.ft-ps.dim{margin-top:7px;padding-top:7px;border-top:1px dashed rgba(255,255,255,.1);gap:3px 8px;font-weight:500;font-size:11.5px;color:#7c8597}
.ft-ps.dim.only{margin-top:0;padding-top:0;border-top:0}
.ft .ft-p{white-space:nowrap;display:inline-flex;align-items:baseline;gap:3px;color:inherit}
.ft .ft-p.sc{color:#f1f5f9}
.ft-p.sc::before{content:"⚽";font-size:9px;margin-right:2px;opacity:.75}
.ft-p em{font-style:normal;font:700 10.5px var(--font-oswald),sans-serif;color:#94a3b8}
.ft .ft-p.gold{color:#f5d97a}
.ft-p i{font-style:normal;font:700 8px var(--font-oswald),sans-serif;letter-spacing:.12em;color:#0a0f1d;background:#f5d97a;border-radius:3px;padding:1px 3px;align-self:center}
.ft .ft-p.og{color:#cbd5e1;font-style:italic}
.ft-p.og b{font:700 8px var(--font-oswald),sans-serif;font-style:normal;letter-spacing:.12em;color:#fdba74;border:1px solid rgba(253,186,116,.55);border-radius:3px;padding:0 3px;align-self:center}
.ft .ft-p.me{color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.4);text-underline-offset:3px}
.ft-rt{display:flex;justify-content:center;align-items:center;gap:8px;margin:14px 12px 0;font:600 11.5px var(--sans);color:#94a3b8}
.ft-rt span{display:flex;gap:3px}.ft-rt span i{width:16px;height:4px;border-radius:2px;background:rgba(255,255,255,.14)}.ft-rt span i.on{background:#f5d97a}
.ft-mm{position:relative;margin:18px 0 0;padding:18px 150px 16px 18px;min-height:132px}
.ft-mm::before{content:"";position:absolute;left:18px;right:18px;top:0;height:1px;background:linear-gradient(90deg,transparent,#f5d97a,transparent)}
.ft-mm::after{content:"";position:absolute;right:-40px;top:-30px;width:240px;height:220px;background:radial-gradient(circle,rgba(245,217,122,.13),transparent 62%);pointer-events:none;z-index:-1}
.ft-mm .faces{position:absolute;right:13px;top:50%;width:122px;height:122px;margin-top:-61px}
.ft-mm .faces .face-b{position:absolute;inset:9px;border-radius:50%}
.ft-face{width:104px;height:104px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font:800 30px var(--display);color:#fff;box-shadow:0 0 0 5px #0a0f1d,0 0 40px 6px rgba(245,217,122,.26)}
.ft-mm .ring{position:absolute;inset:0;width:122px;height:122px;transform:rotate(-90deg)}
.ft-mm .ring circle{fill:none;stroke:url(#ftRingG);stroke-width:2.5;stroke-linecap:round}
.ft-mm .faces.two .face-b{inset:auto;width:78px;height:78px;top:10px}
.ft-mm .faces.two .face-b:first-child{left:-6px}.ft-mm .faces.two .face-b:last-child{left:44px;top:40px}
.ft-mm .faces.two .ft-face{width:78px;height:78px;box-shadow:0 0 0 3px #f5d97a,0 0 0 6px #0a0f1d}
.ft-mm .ey2{font:700 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.ft-mm .nm{margin-top:6px;font:700 34px/.95 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.01em;color:#fff;overflow-wrap:anywhere}
.ft-mm .nm.joint{font-size:24px}
.ft-mm .nm .who{display:block}.ft-mm .nm .amp{display:block;font-size:.6em;color:#f5d97a}
.ft-mm .nm .w{display:block;overflow:hidden}.ft-mm .nm .w b{display:block;font:inherit}
.ft-mm .meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:9px;font:600 12px var(--sans);color:#cbd5e1}
.ft-mm .meta b{color:#f5d97a}
.ft-tp{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 7px;border-radius:999px;background:color-mix(in srgb,var(--tc) 15%,transparent);font:700 10.5px var(--font-oswald),sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#fff}
.ft-tp u{width:10px;height:3px;border-radius:2px;background:var(--tc)}
.ft-mm .bar{margin-top:9px;max-width:150px;height:3px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden}.ft-mm .bar i{display:block;height:100%;background:linear-gradient(90deg,#c9a24a,#f5d97a);transform-origin:left}
.ft-mm.open{padding-right:18px;min-height:0}
.ft-mm.open .q{margin-top:6px;font:700 24px/1.05 var(--font-oswald),sans-serif;text-transform:uppercase;color:#fff}
.ft-vote{margin-top:12px;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:14px;background:#e63946 !important;color:#fff !important;font:700 14px var(--sans) !important;box-shadow:0 14px 26px -14px rgba(230,57,70,.9)}
.ft-ft{display:flex;align-items:center;gap:10px;padding:12px 18px 14px;border-top:1px solid rgba(255,255,255,.06);font:600 12.5px var(--sans);color:#cbd5e1}
.ft-ft .pri{color:#fff;font-weight:700;margin-right:auto}
.ft-ft .sp{margin-right:auto}
.ft-ft .sh{display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.07);color:#e2e8f0;font-weight:600}
.ft.compact .ft-sc{font-size:56px}.ft.compact .ft-sc .m{height:56px}
.ft.compact .ft-mm{min-height:104px;padding-right:126px}
.ft.compact .ft-mm .faces{transform:scale(.82);transform-origin:right center}
.ft.compact .ft-mm .nm{font-size:26px}

/* The build-up, once */
.ft.play .ft-ph{animation:ftPh 1.4s ease both}
.ft.play .ft-ey i{animation:ftLine .9s .2s cubic-bezier(.2,.8,.2,1) both}
.ft.play .ft-tm{animation:ftUp .7s .35s cubic-bezier(.2,.8,.2,1) both}
.ft.play .ft-sc .m b{animation:ftRoll .9s .45s cubic-bezier(.2,.9,.25,1) both}
.ft.play .ft-sc .m.r b{animation-delay:.6s}
.ft.play .ft-sc .dash{animation:ftFade .5s .7s both}
.ft.play .ft-hl{animation:ftUp .7s .8s both}
.ft.play .ft-tb{animation:ftUp .6s 1s both}.ft.play .ft-tb.red{animation-delay:1.12s}
.ft.play .ft-rt{animation:ftFade .6s 1.4s both}
.ft.play .ft-mm::before{animation:ftLine 1s 1.5s cubic-bezier(.2,.8,.2,1) both}
.ft.play .ft-mm .ey2,.ft.play .ft-mm.open .q{animation:ftFade .6s 1.8s both}
.ft.play .ft-mm .face-b{animation:ftPic 1s 1.75s cubic-bezier(.2,.8,.2,1) both}
.ft.play .ft-mm .ring circle{stroke-dasharray:365;stroke-dashoffset:365;animation:ftRing 1.3s 1.9s cubic-bezier(.3,.7,.2,1) forwards}
.ft.play .ft-mm .nm .w b{animation:ftRoll .9s cubic-bezier(.2,.9,.25,1) both;animation-delay:var(--d)}
.ft.play .ft-mm .meta,.ft.play .ft-vote{animation:ftFade .6s 2.4s both}
.ft.play .ft-mm .bar i{animation:ftLine .9s 2.4s cubic-bezier(.2,.8,.2,1) both}
.ft.play .ft-ft{animation:ftFade .6s 2.6s both}
@keyframes ftPh{from{opacity:0;transform:scale(1.06)}}
@keyframes ftLine{from{transform:scaleX(0)}}
@keyframes ftUp{from{opacity:0;transform:translateY(10px)}}
@keyframes ftRoll{from{transform:translateY(100%)}}
@keyframes ftFade{from{opacity:0}}
@keyframes ftPic{from{opacity:0;transform:scale(.86);filter:blur(5px)}}
@keyframes ftRing{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion: reduce){.ft.play *,.ft.play *::before{animation:none !important}}
`;
