"use client";

import type { ReactNode } from "react";
import { Avatar, listNames } from "./shared";

// Calm Feed (admins first, 2026-10-17): the Feed is "what's happening",
// not the record. The last two weeks as moments on a timeline - one per
// game (who won, Man of the Match, the first highlight), new players,
// appearance milestones - each with reactions. Scores, scoresheets,
// records, stats and the pot live in Results, and every moment links
// there instead of repeating it. Ends with the way into Results.

export type CalmMoment =
  | {
      kind: "game";
      key: string; // the full-time post's key: reactions, "new" and archive
      archiveKeys: string[]; // the full-time, MOTM and records posts it folds
      ts: number;
      gameId: string;
      dateLabel: string; // "THU 15 OCT"
      white: number;
      red: number;
      whiteName: string;
      redName: string;
      redColor: string;
      motm: string[]; // winners, empty while voting is open or none
      voteOpen: null | { voted: boolean; closes: string };
      highlights: ReactNode[];
    }
  | { kind: "join"; key: string; archiveKeys: string[]; ts: number; dateLabel: string; people: { name: string; avatarUrl?: string | null }[] }
  | { kind: "apps"; key: string; archiveKeys: string[]; ts: number; dateLabel: string; labels: string[] };

export type CalmFeedProps = {
  moments: CalmMoment[];
  openGame: (gameId: string) => void;
  openStats: () => void;
  openResults: () => void;
};

const WEEK = 7 * 86400000;

export function CalmFeedTabs({ view, setView }: { view: "feed" | "bootroom"; setView: (v: "feed" | "bootroom") => void }) {
  return (
    <div className="cfe-tabs" role="tablist">
      <style>{calmFeedCss}</style>
      <button role="tab" aria-selected={view === "feed"} className={view === "feed" ? "on" : ""} onClick={() => setView("feed")}>
        Feed
      </button>
      <button role="tab" aria-selected={view === "bootroom"} className={view === "bootroom" ? "on" : ""} onClick={() => setView("bootroom")}>
        Boot Room
      </button>
    </div>
  );
}

function Medal() {
  return (
    <span className="cfe-md" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="11" height="11">
        <path d="M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm-3.5 2.2L7 22l5-2.2 5 2.2-1.5-4.8" fill="none" stroke="#3a2a08" strokeWidth="2.6" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function CalmFeed({
  moments,
  openGame,
  openStats,
  openResults,
  freshKeys,
  reactions,
  isAdmin,
  onArchive,
  onShowArchived,
  archivedCount,
}: CalmFeedProps & {
  freshKeys: Set<string>;
  reactions: (key: string) => ReactNode;
  isAdmin: boolean;
  onArchive: (keys: string[]) => void;
  onShowArchived: () => void;
  archivedCount: number;
}) {
  const now = Date.now();
  let lastLabel = "";
  const more = (m: CalmMoment) =>
    isAdmin && (
      <button className="cfe-more" aria-label="Archive" onClick={() => onArchive(m.archiveKeys)}>
        •••
      </button>
    );
  return (
    <div className="cfe">
      <style>{calmFeedCss}</style>
      {moments.length === 0 ? (
        <div className="cfe-quiet">
          <b>A quiet fortnight</b>
          <span>Nothing new in the last two weeks.</span>
        </div>
      ) : (
        <div className="cfe-tl">
          {moments.map((m, i) => {
            const label = now - m.ts <= WEEK ? "This week" : "Last week";
            const head = label !== lastLabel ? <div className="cfe-lab">{label}</div> : null;
            lastLabel = label;
            const fresh = freshKeys.has(m.key);
            if (m.kind === "game") {
              const redWon = m.red > m.white;
              const draw = m.red === m.white;
              const hi = m.highlights;
              return (
                <div key={m.key}>
                  {head}
                  <article className={"cfe-m game" + (i === 0 ? " first" : "") + (fresh ? " fresh" : "")}>
                    <div className="cfe-eb">
                      <span>FULL TIME · {m.dateLabel}</span>
                      {fresh && <em>New</em>}
                    </div>
                    <h3 onClick={() => openGame(m.gameId)}>
                      {draw ? (
                        <>
                          Honours even, {m.white}–{m.red}
                        </>
                      ) : redWon ? (
                        <>
                          <span style={{ color: m.redColor === "#e63946" ? "#ff5a66" : m.redColor }}>{m.redName}</span> won {m.red}–{m.white}
                        </>
                      ) : (
                        <>
                          <span className="w">{m.whiteName}</span> won {m.white}–{m.red}
                        </>
                      )}
                    </h3>
                    {m.motm.length > 0 ? (
                      <p className="mo">
                        <Medal />
                        <b>{m.motm.join(" & ")}</b> Man of the Match
                      </p>
                    ) : m.voteOpen ? (
                      <button className="cfe-vote" onClick={() => openGame(m.gameId)}>
                        <Medal />
                        {m.voteOpen.voted ? "Change your Man of the Match vote" : "Vote for Man of the Match"}
                        <span>closes {m.voteOpen.closes}</span>
                      </button>
                    ) : null}
                    {hi.length > 0 && (
                      <p className="hl">
                        {hi[0]}
                        {hi.length > 1 && <span> +{hi.length - 1} more</span>}
                      </p>
                    )}
                    <div className="cfe-ft">
                      {reactions(m.key)}
                      {more(m)}
                      <button className="cfe-go" onClick={() => openGame(m.gameId)}>
                        Scoresheet <em>›</em>
                      </button>
                    </div>
                  </article>
                </div>
              );
            }
            if (m.kind === "join") {
              const names = m.people.map((p) => p.name);
              return (
                <div key={m.key}>
                  {head}
                  <article className={"cfe-m club" + (fresh ? " fresh" : "")}>
                    <div className="cfe-eb">
                      <span>NEW TO THE CLUB · {m.dateLabel}</span>
                      {fresh && <em>New</em>}
                    </div>
                    <div className="cfe-faces">
                      {m.people.slice(0, 6).map((p, k) => (
                        <Avatar key={k} name={p.name} avatarUrl={p.avatarUrl} className="cfe-face" />
                      ))}
                    </div>
                    <h4>{names.length === 1 ? `${names[0]} joined` : `${names.length} new players joined`}</h4>
                    {names.length > 1 && <p className="sub">{listNames(names, 6)}</p>}
                    <div className="cfe-ft">
                      {reactions(m.key)}
                      {more(m)}
                    </div>
                  </article>
                </div>
              );
            }
            return (
              <div key={m.key}>
                {head}
                <article className={"cfe-m club" + (fresh ? " fresh" : "")}>
                  <div className="cfe-eb">
                    <span>MILESTONES · {m.dateLabel}</span>
                    {fresh && <em>New</em>}
                  </div>
                  <h4>
                    {m.labels.length === 1 ? `${m.labels[0].replace(/ \((\d+)\)$/, "")} hit ${m.labels[0].match(/\((\d+)\)$/)?.[1] ?? ""} appearances` : `${m.labels.length} players hit an appearance milestone`}
                  </h4>
                  {m.labels.length > 1 && <p className="sub">{listNames(m.labels, 6)}</p>}
                  <div className="cfe-ft">
                    {reactions(m.key)}
                    {more(m)}
                    <button className="cfe-go" onClick={openStats}>
                      Stats <em>›</em>
                    </button>
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      )}
      <button className="cfe-end" onClick={openResults}>
        <span>
          <small>THAT&apos;S THE LAST TWO WEEKS</small>
          <b>Every score, scoresheet and record is in Results</b>
        </span>
        <em>›</em>
      </button>
      {isAdmin && (
        <button className="cfe-arch" onClick={onShowArchived}>
          Show archived{archivedCount ? ` (${archivedCount})` : ""}
        </button>
      )}
    </div>
  );
}

export const calmFeedCss = `
.cfe-tabs{display:flex;gap:22px;margin:4px 2px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
.cfe-tabs button{position:relative;padding:0 0 10px;border:0;background:none;color:#64748b;font:600 12px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;cursor:pointer}
.cfe-tabs button.on{color:#fff}
.cfe-tabs button.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#f5d97a;border-radius:2px}
.cfe-tl{position:relative;padding-left:18px}
.cfe-tl::before{content:"";position:absolute;left:4px;top:8px;bottom:8px;width:1px;background:linear-gradient(180deg,rgba(245,217,122,.55),rgba(245,217,122,.08))}
.cfe-lab{position:relative;margin:2px 0 10px;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#94a3b8}
.cfe-lab::before{content:"";position:absolute;left:-18px;top:3px;width:9px;height:9px;border-radius:50%;background:#0b0f1c;border:1px solid rgba(245,217,122,.6)}
.cfe-m{position:relative;margin:0 0 12px;padding:13px 15px 6px;border-radius:18px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.08)}
.cfe-m::before{content:"";position:absolute;left:-17px;top:18px;width:7px;height:7px;border-radius:50%;background:#475569}
.cfe-m.game::before{background:#f5d97a;box-shadow:0 0 8px rgba(245,217,122,.7)}
.cfe-m.game.first{background:linear-gradient(180deg,rgba(245,217,122,.07),rgba(255,255,255,.02));border-color:rgba(245,217,122,.25)}
.cfe-m.fresh{animation:cfeIn .6s cubic-bezier(.2,.9,.3,1) both}
@keyframes cfeIn{from{opacity:0;transform:translateY(10px)}}
.cfe-eb{display:flex;align-items:center;gap:8px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#f5d97a}
.cfe-m.club .cfe-eb{color:#94a3b8}
.cfe-eb em{margin-left:auto;font-style:normal;padding:2px 7px;border-radius:999px;background:#f5d97a;color:#1a1405;letter-spacing:.16em;font-size:9px}
.cfe-m h3{margin:6px 0 8px;font:800 22px/1.1 var(--display);color:#fff;letter-spacing:-.01em;cursor:pointer}
.cfe-m h3 .w{text-decoration:underline;text-decoration-color:rgba(255,255,255,.4);text-underline-offset:4px}
.cfe-m h4{margin:6px 0 4px;font:800 15px/1.25 var(--display);color:#fff}
.cfe-m p{margin:0 0 6px;font:500 12.5px/1.45 var(--sans);color:#cbd5e1}
.cfe-m p.mo b{color:#fff;font-weight:700}
.cfe-m p.hl{color:#e2c46b;font-weight:600}
.cfe-m p.hl strong{font-weight:700}
.cfe-m p.hl span{color:#94a3b8;font-weight:500}
.cfe-m p.sub{color:#94a3b8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cfe-md{width:18px;height:18px;border-radius:50%;display:inline-grid;place-items:center;vertical-align:-4px;margin-right:7px;flex:none;background:radial-gradient(circle at 35% 28%,#fff6d1,#f5d97a 50%,#b8902a)}
.cfe-vote{display:flex;align-items:center;flex-wrap:wrap;gap:0 4px;width:100%;margin:0 0 6px;padding:9px 11px;border-radius:12px;border:1px solid rgba(245,217,122,.35);background:rgba(245,217,122,.08);color:#fff;font:700 12.5px var(--sans);text-align:left;cursor:pointer}
.cfe-vote span{margin-left:auto;font:500 11px var(--sans);color:#94a3b8}
.cfe-faces{display:flex;margin:8px 0 2px}
.cfe-face{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;margin-right:-6px;object-fit:cover;font:800 12px var(--display);color:#fff;background:linear-gradient(135deg,#334155,#1e293b);border:2px solid #121729}
.cfe-ft{display:flex;align-items:center;gap:4px;margin-top:6px;padding-top:4px;border-top:1px solid rgba(255,255,255,.05)}
.cfe-ft .wcf-feed-reactions{margin:0;gap:4px}
.cfe-ft .wcf-feed-pill{height:30px;min-height:0;padding:0 10px;font-size:12px;color:#cbd5e1;gap:6px;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}
.cfe-ft .wcf-feed-pill.mine{color:#f5d97a;background:rgba(245,217,122,.1);border-color:rgba(245,217,122,.45)}
.cfe-go{margin-left:auto;padding:8px 2px;border:0;background:none;font:700 12px var(--sans);color:#94a3b8;cursor:pointer}
.cfe-go em{font-style:normal;color:#f5d97a;margin-left:2px}
.cfe-more{padding:8px 6px;border:0;background:none;color:#64748b;font:700 10px var(--sans);letter-spacing:.1em;cursor:pointer}
.cfe-ft .cfe-more:last-child{margin-left:auto}
.cfe-quiet{padding:22px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);text-align:center}
.cfe-quiet b{display:block;font:800 16px var(--display);color:#fff}
.cfe-quiet span{font:500 12.5px var(--sans);color:#94a3b8}
.cfe-end{display:flex;align-items:center;gap:12px;width:100%;margin:8px 0 0;padding:14px 16px;border-radius:18px;border:1px dashed rgba(245,217,122,.3);background:none;color:#fff;text-align:left;cursor:pointer}
.cfe-end span{flex:1}
.cfe-end small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#94a3b8}
.cfe-end b{display:block;margin-top:3px;font:700 13.5px var(--sans);color:#f5d97a}
.cfe-end em{font-style:normal;color:#f5d97a;font-weight:800}
.cfe-arch{display:block;margin:14px auto 0;padding:6px 10px;border:0;background:none;font:600 12px var(--sans);color:#64748b;cursor:pointer}
@media (prefers-reduced-motion: reduce){.cfe-m.fresh{animation:none}}
`;
