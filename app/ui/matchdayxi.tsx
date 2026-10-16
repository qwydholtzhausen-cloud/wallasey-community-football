import { useEffect, useState } from "react";
import { Avatar, avatarFor } from "./shared";
import type { Programme, ProgPerson } from "../../lib/programme";

// ── The First XI matchday takeover ──
// On the day of the club's first 11-a-side the app dresses for it: gold
// header and nav, a countdown strip on every tab, a split-stadium hero on
// Fixtures, a curtain the first time you open the app that day, and the
// two teams as First XI cards on Line-up. Everything else works as normal.

type Stat = { apps: number; goals: number; motm: number };
const RED = "#e63946";
const WHITE = "#e2e8f0";

function useCountdown(targetMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((targetMs - now) / 1000));
}

export function MatchdayRibbon({ kickoffMs, onOpen }: { kickoffMs: number; onOpen: () => void }) {
  const left = useCountdown(kickoffMs);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return (
    <button className="mdx-ribbon" onClick={onOpen}>
      <i />
      <b>THE FIRST XI</b>
      <span>{left > 0 ? `Kick-off in ${h ? `${h}h ` : ""}${m}m` : "Kicked off · The Oval"}</span>
      <em>Programme ›</em>
    </button>
  );
}

export function MatchdayHero({
  prog,
  kickoffMs,
  avatarOf,
  onProgramme,
  onCards,
}: {
  prog: Programme;
  kickoffMs: number;
  avatarOf: (id: string) => string | null | undefined;
  onProgramme: () => void;
  onCards: () => void;
}) {
  const left = useCountdown(kickoffMs);
  const parts = [Math.floor(left / 3600), Math.floor((left % 3600) / 60), left % 60].map((n) => String(n).padStart(2, "0"));
  const capR = prog.reds.find((p) => prog.captains.includes(p.id)) ?? prog.reds[0];
  const capW = prog.whites.find((p) => prog.captains.includes(p.id)) ?? prog.whites[0];
  const face = (p: ProgPerson, cls: string, style?: React.CSSProperties) => (
    <Avatar key={p.id} name={p.name} avatarUrl={avatarOf(p.id)} className={cls} background={avatarFor(p.name).gradient} style={style} />
  );
  return (
    <div className="mdx-hero">
      <div className="mdx-halves">
        <i />
        <i />
      </div>
      <span className="mdx-seam" />
      <span className="mdx-beam l" />
      <span className="mdx-beam r" />
      <div className="mdx-hk">
        <small>MATCHDAY · THE OVAL LEISURE</small>
        <h3>
          The <span>First</span> XI
        </h3>
      </div>
      <div className="mdx-caps">
        {capR && (
          <div className="mdx-cap" style={{ ["--c" as string]: RED }}>
            {face(capR, "mdx-cph")}
            <small>REDS · CAPTAIN</small>
            {capR.name.split(" ")[0]}
          </div>
        )}
        <div className="mdx-v">V</div>
        {capW && (
          <div className="mdx-cap" style={{ ["--c" as string]: WHITE }}>
            {face(capW, "mdx-cph")}
            <small>WHITES · CAPTAIN</small>
            {capW.name.split(" ")[0]}
          </div>
        )}
      </div>
      <div className="mdx-sq">
        <div>{prog.reds.filter((p) => p.id !== capR?.id).map((p, i) => face(p, "mdx-sph", { ["--c" as string]: RED, ["--d" as string]: `${0.2 + i * 0.05}s` } as React.CSSProperties))}</div>
        <div>{prog.whites.filter((p) => p.id !== capW?.id).map((p, i) => face(p, "mdx-sph", { ["--c" as string]: WHITE, ["--d" as string]: `${0.2 + i * 0.05}s` } as React.CSSProperties))}</div>
      </div>
      {left > 0 ? (
        <>
          <div className="mdx-flip">
            {parts.map((p, gi) => (
              <span key={gi} className="mdx-fd">
                {gi > 0 && <span className="mdx-sep">:</span>}
                <span className="n">
                  {p.split("").map((d, k) => (
                    <i key={k + d}>{d}</i>
                  ))}
                </span>
              </span>
            ))}
          </div>
          <div className="mdx-ko">to kick-off · {prog.game.kickoff}</div>
        </>
      ) : (
        <div className="mdx-ko live">
          <i /> Under way at The Oval
        </div>
      )}
      <div className="mdx-acts">
        <button className="main" onClick={onProgramme}>
          Read the programme
        </button>
        <button onClick={onCards}>The team cards</button>
      </div>
    </div>
  );
}

export function MatchdayTimeline({ kickoff }: { kickoff: string }) {
  const [h, m] = kickoff.split(":").map(Number);
  const at = (mins: number) => {
    const t = h * 60 + m + mins;
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  return (
    <div className="mdx-tl">
      <h5>TODAY</h5>
      <div>
        <b>{at(-30)}</b>
        <span>The walk-out: watch them come out of the tunnel</span>
      </div>
      <div>
        <b>{at(-20)}</b>
        <span>Be at The Oval, boots on</span>
      </div>
      <div>
        <b>{kickoff}</b>
        <span>Kick-off: Reds v Whites</span>
      </div>
      <div>
        <b>FT</b>
        <span>Man of the Match vote opens · pennants for the 22</span>
      </div>
    </div>
  );
}

export function MatchdayIntro({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="mdx-intro" onClick={onDone} role="dialog" aria-label="It's matchday">
      <div className="cur l" />
      <div className="cur r" />
      <div className="badge">
        <img src="/crest.png" alt="" />
        <small>SUNDAY · THE FIRST XI</small>
        <b>
          It&apos;s
          <br />
          Matchday
        </b>
      </div>
    </div>
  );
}

// The two teams as First XI cards: today's team sheet on Line-up.
export function FirstXiCard({ p, n, side, captain, edition, stat, avatarUrl }: { p: ProgPerson; n: number; side: "red" | "white"; captain: boolean; edition: string; stat: Stat; avatarUrl?: string | null }) {
  const [flip, setFlip] = useState(false);
  const cls = captain ? "capt" : edition === "GOLDEN BOOT" ? "boot" : edition === "SQUAD'S PICK" ? "star" : "";
  return (
    <button className={"mdx-cw" + (flip ? " f" : "")} onClick={() => setFlip((f) => !f)} aria-label={`${p.name}'s First XI card`}>
      <span className="mdx-cd">
        <span className={"mdx-fc fr " + cls}>
          <span className="t2">
            <span>Nº{String(n).padStart(2, "0")}/22</span>
            <span className="side" style={{ background: side === "red" ? RED : "#64748b" }}>
              {side === "red" ? "REDS" : "WHITES"}
            </span>
          </span>
          <span className="ed">{captain ? "CAPTAIN EDITION" : edition}</span>
          <Avatar name={p.name} avatarUrl={avatarUrl} className="mdx-cph2" background={avatarFor(p.name).gradient} />
          <b>{p.name}</b>
          <span className="st">
            <span>
              {stat.apps}
              <small>GAMES</small>
            </span>
            <span>
              {stat.goals}
              <small>GOALS</small>
            </span>
            <span>
              {stat.motm}
              <small>MOTM</small>
            </span>
          </span>
        </span>
        <span className="mdx-fc bk">
          <img src="/crest.png" alt="" />
          <b>THE FIRST XI</b>
          <small>25 · 10 · 2026</small>
        </span>
      </span>
    </button>
  );
}

export function MatchdayTeamCards({ prog, statOf, avatarOf }: { prog: Programme; statOf: (id: string) => Stat; avatarOf: (id: string) => string | null | undefined }) {
  const all = [...prog.reds, ...prog.whites];
  const top = [...all].sort((a, b) => statOf(b.id).goals - statOf(a.id).goals)[0];
  const pick = all.filter((p) => p.id !== top?.id).sort((a, b) => statOf(b.id).motm - statOf(a.id).motm || statOf(b.id).goals - statOf(a.id).goals)[0];
  const ed = (p: ProgPerson) => (p.id === top?.id ? "GOLDEN BOOT" : p.id === pick?.id ? "SQUAD'S PICK" : "FIRST XI");
  const order = all.slice().sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const num = (p: ProgPerson) => order.indexOf(p) + 1;
  return (
    <div className="mdx-team">
      {(
        [
          ["Reds", prog.reds, "red"],
          ["Whites", prog.whites, "white"],
        ] as const
      ).map(([label, list, side]) => (
        <div key={label}>
          <h4 style={{ color: side === "red" ? RED : WHITE }}>
            {label} <small>{list.length}</small>
          </h4>
          <div className="mdx-cards">
            {[...list]
              .sort((a, b) => Number(prog.captains.includes(b.id)) - Number(prog.captains.includes(a.id)))
              .map((p) => (
                <FirstXiCard key={p.id} p={p} n={num(p)} side={side} captain={prog.captains.includes(p.id)} edition={ed(p)} stat={statOf(p.id)} avatarUrl={avatarOf(p.id)} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const matchdayCss = `
.wcf-top.mdx{background:linear-gradient(90deg,#2a1d05,#5a4210 50%,#2a1d05);border-bottom:1px solid #f5d97a}
.wcf-top.mdx .wcf-wordmark-sub{color:#f5d97a}
.wcf-nav.mdx{background:linear-gradient(180deg,#14100a,#0b0905);border-top:1px solid #f5d97a}
.wcf-nav.mdx .wcf-navbtn{color:#a08b5a}
.wcf-nav.mdx .wcf-navbtn.active{color:#f5d97a}
.mdx-ribbon{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:8px;width:100%;padding:8px 14px;border:0;border-bottom:1px solid rgba(245,217,122,.35);background:#14100a;color:#f5f6f8;font:inherit;font-size:12px;cursor:pointer;text-align:left}
.mdx-ribbon i{width:7px;height:7px;border-radius:50%;background:#e63946;flex:none;animation:mdxPulse 1.2s infinite}
@keyframes mdxPulse{50%{opacity:.3}}
.mdx-ribbon b{font:700 12px var(--font-oswald),sans-serif;letter-spacing:.14em;color:#f5d97a}
.mdx-ribbon span{color:#cbd5e1}
.mdx-ribbon em{margin-left:auto;font-style:normal;font-weight:800;color:#f5d97a}
.mdx-hero{position:relative;border-radius:22px;overflow:hidden;border:1.5px solid #f5d97a;box-shadow:0 0 50px -12px rgba(245,217,122,.7);padding-bottom:14px;margin-bottom:14px;background:#06070d;color:#fff}
.mdx-halves{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr}
.mdx-halves i{display:block;background:linear-gradient(180deg,rgba(6,8,14,.15),rgba(6,8,14,.92) 80%),url(/season-hero.jpg) 0 30%/200% auto}
.mdx-halves i:first-child{box-shadow:inset 0 0 0 999px rgba(230,57,70,.28)}
.mdx-halves i:last-child{background-position:100% 30%;box-shadow:inset 0 0 0 999px rgba(226,232,240,.12)}
.mdx-seam{position:absolute;left:50%;top:0;bottom:0;width:2px;margin-left:-1px;background:linear-gradient(180deg,transparent,#f5d97a,transparent);box-shadow:0 0 14px #f5d97a}
.mdx-beam{position:absolute;top:-60px;width:170px;height:420px;background:linear-gradient(180deg,rgba(255,246,220,.5),transparent 75%);filter:blur(10px);mix-blend-mode:screen;animation:mdxSweep 5s ease-in-out infinite}
.mdx-beam.l{left:-60px;rotate:22deg}.mdx-beam.r{right:-60px;rotate:-22deg;animation-delay:-2.5s}
@keyframes mdxSweep{50%{opacity:.3}}
.mdx-hk{position:relative;text-align:center;padding-top:16px}
.mdx-hk small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.3em;color:#f5d97a}
.mdx-hk h3{margin:4px 0 0;font:700 40px/.9 var(--font-oswald),sans-serif;text-transform:uppercase}
.mdx-hk h3 span{color:#f5d97a}
.mdx-caps{position:relative;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;margin-top:16px;padding:0 12px}
.mdx-cap{display:flex;flex-direction:column;align-items:center;gap:5px;font:700 13px var(--font-oswald),sans-serif;text-transform:uppercase}
.mdx-cph{width:74px;height:74px;border-radius:50%;object-fit:cover;border:3px solid var(--c);box-shadow:0 0 24px var(--c);display:grid;place-items:center;font:800 28px var(--display);color:#fff}
.mdx-cap small{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:var(--c)}
.mdx-v{font:700 24px var(--font-oswald),sans-serif;color:#f5d97a}
.mdx-sq{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;padding:0 10px}
.mdx-sq div{display:flex;flex-wrap:wrap;justify-content:center;gap:3px}
.mdx-sph{width:24px;height:24px;border-radius:50%;object-fit:cover;border:1.5px solid var(--c);display:grid;place-items:center;font:800 10px var(--display);color:#fff;animation:mdxPop .4s cubic-bezier(.3,1.6,.5,1) backwards;animation-delay:var(--d)}
@keyframes mdxPop{from{opacity:0;transform:scale(.3)}}
.mdx-flip{position:relative;display:flex;justify-content:center;align-items:flex-start;gap:4px;margin-top:16px}
.mdx-fd{display:flex;align-items:flex-start;gap:4px}
.mdx-fd .n{display:flex;gap:3px}
.mdx-fd .n i{position:relative;width:32px;height:48px;border-radius:6px;background:linear-gradient(180deg,#1c2233 50%,#151a28 50%);font:700 32px/48px var(--font-oswald),sans-serif;font-style:normal;text-align:center;color:#fff;box-shadow:0 3px 8px rgba(0,0,0,.6);animation:mdxFlp .35s ease-in}
.mdx-fd .n i::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(0,0,0,.6)}
@keyframes mdxFlp{50%{transform:rotateX(-90deg)}}
.mdx-sep{font:700 28px/48px var(--font-oswald),sans-serif;color:#f5d97a}
.mdx-ko{position:relative;text-align:center;font-size:11.5px;color:#cbd5e1;margin-top:8px}
.mdx-ko.live{font-weight:800;color:#fff;display:flex;justify-content:center;gap:6px;align-items:center;margin-top:16px}
.mdx-ko.live i{width:8px;height:8px;border-radius:50%;background:#e63946;animation:mdxPulse 1.2s infinite}
.mdx-acts{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 12px 0}
.mdx-acts button{height:44px;border-radius:12px;border:1px solid rgba(245,217,122,.4);background:rgba(245,217,122,.1);color:#fff;font:800 12.5px var(--sans);cursor:pointer}
.mdx-acts button.main{background:#f5d97a;color:#1a1405;border-color:#f5d97a}
.mdx-tl{border-radius:16px;border:1px solid rgba(245,217,122,.3);background:#14100a;padding:12px 14px;margin-bottom:14px}
.mdx-tl h5{margin:0 0 8px;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#f5d97a}
.mdx-tl div{display:grid;grid-template-columns:48px 1fr;gap:8px;padding:5px 0;font-size:12.5px;color:#e2e8f0;border-top:1px solid rgba(245,217,122,.12)}
.mdx-tl div:first-of-type{border:0}
.mdx-tl b{font:700 13px var(--font-oswald),sans-serif;color:#f5d97a}
.mdx-intro{position:fixed;inset:0;z-index:160;display:flex;align-items:center;justify-content:center;background:#05060b;overflow:hidden;animation:mdxOut .6s ease-in 3.6s forwards;color:#fff}
@keyframes mdxOut{to{opacity:0;visibility:hidden}}
.mdx-intro .cur{position:absolute;top:0;bottom:0;width:50%;animation:mdxOpen 1s cubic-bezier(.7,0,.2,1) 2.6s forwards}
.mdx-intro .cur.l{left:0;background:linear-gradient(90deg,#8d1520,#e63946);--o:-100%}
.mdx-intro .cur.r{right:0;background:linear-gradient(270deg,#cbd2dc,#f5f6f8);--o:100%}
@keyframes mdxOpen{to{transform:translateX(var(--o))}}
.mdx-intro .badge{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;text-align:center;animation:mdxPop .7s cubic-bezier(.3,1.5,.5,1) .3s backwards}
.mdx-intro .badge img{width:96px;filter:drop-shadow(0 0 30px rgba(245,217,122,.7))}
.mdx-intro .badge small{margin-top:14px;font:600 12px var(--font-oswald),sans-serif;letter-spacing:.3em;color:#1a1405;background:#f5d97a;padding:4px 10px}
.mdx-intro .badge b{font:700 56px/.9 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:10px;text-shadow:0 4px 30px rgba(0,0,0,.6)}
.mdx-team h4{display:flex;align-items:baseline;gap:8px;margin:6px 2px 10px;font:700 20px var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.06em}
.mdx-team h4 small{font:600 12px var(--sans);color:#94a3b8}
.mdx-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:18px}
.mdx-cw{perspective:700px;background:none;border:0;padding:0;cursor:pointer}
.mdx-cd{position:relative;display:block;aspect-ratio:5/7;transform-style:preserve-3d;transition:transform .7s cubic-bezier(.4,.1,.2,1);border-radius:10px}
.mdx-cw.f .mdx-cd{transform:rotateY(180deg)}
.mdx-fc{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:10px;overflow:hidden;padding:6px 6px 7px;display:flex;flex-direction:column;align-items:center;text-align:center}
.mdx-fc.fr{background:linear-gradient(160deg,#fff3c4,#f5d97a 35%,#b8902a 70%,#7a5a1a);color:#2a1d05;box-shadow:0 8px 16px -6px #000,inset 0 0 0 2px rgba(255,255,255,.4)}
.mdx-fc.fr.capt{background:linear-gradient(160deg,#2b2b33,#0d0d12 60%,#1a1a22);color:#f5d97a;box-shadow:0 8px 16px -6px #000,inset 0 0 0 2px #f5d97a}
.mdx-fc.fr.boot{background:linear-gradient(160deg,#ffd9de,#e63946 40%,#7a0f18);color:#fff}
.mdx-fc.fr.star{background:conic-gradient(from 0deg,#f5d97a,#9ee6ff,#d8a6ff,#f5d97a,#a6ffcf,#f5d97a);color:#2a1d05}
.mdx-fc .t2{display:flex;justify-content:space-between;width:100%;font:700 9px var(--font-oswald),sans-serif}
.mdx-fc .side{padding:0 4px;border-radius:3px;color:#fff}
.mdx-fc .ed{width:100%;margin-top:3px;font:700 7.5px var(--font-oswald),sans-serif;letter-spacing:.12em;padding:1px 0;border-top:1px solid currentColor;border-bottom:1px solid currentColor}
.mdx-cph2{width:54%;aspect-ratio:1;height:auto;margin-top:5px;border-radius:50%;object-fit:cover;border:2px solid #fff;display:grid;place-items:center;font:800 20px var(--display);color:#fff}
.mdx-fc.fr b{display:block;font:700 10px/1.1 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:4px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdx-fc .st{display:grid;grid-template-columns:repeat(3,1fr);width:100%;margin-top:auto;border-top:1px solid currentColor;padding-top:3px}
.mdx-fc .st span{font:700 11px var(--font-oswald),sans-serif}
.mdx-fc .st small{display:block;font:600 6.5px var(--font-oswald),sans-serif;letter-spacing:.08em;opacity:.8}
.mdx-fc.bk{transform:rotateY(180deg);background:#14100a;border:2px solid #f5d97a;color:#f5d97a;justify-content:center}
.mdx-fc.bk img{width:46%}
.mdx-fc.bk b{font:700 10px var(--font-oswald),sans-serif;letter-spacing:.1em;margin-top:6px}
.mdx-fc.bk small{font-size:8px;color:#cbd5e1}
@media (prefers-reduced-motion: reduce){.mdx-intro,.mdx-intro *,.mdx-beam,.mdx-sph,.mdx-fd .n i{animation:none!important}.mdx-intro{display:none}}
`;
