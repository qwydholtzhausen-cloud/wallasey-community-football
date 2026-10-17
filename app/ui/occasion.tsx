"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { OccKind } from "../../lib/occasions";

// The occasion takeover (lib/occasions.ts): the matchday frame - header,
// nav, a strip on every other tab, a hero and a timeline on Fixtures - in
// each occasion's own colour, photo and artwork.

const THEMES: Record<OccKind, { acc: string; rgb: string; dark: string; ink: string; photo: string; name: string }> = {
  christmas: { acc: "#ff8f8f", rgb: "255,143,143", dark: "#0c2418", ink: "#2a0606", photo: "/pitch-night.jpg", name: "THE CHRISTMAS GAME" },
  milestone: { acc: "#7dd3fc", rgb: "125,211,252", dark: "#071a2b", ink: "#04121f", photo: "/pitch-floodlit.jpg", name: "A CLUB MILESTONE" },
  finale: { acc: "#c4b5fd", rgb: "196,181,253", dark: "#140b2b", ink: "#12052a", photo: "/floodlight-haze.jpg", name: "SEASON FINALE" },
  wrapped: { acc: "#fdba74", rgb: "253,186,116", dark: "#24120a", ink: "#2a1203", photo: "/wrapped/glance.jpg", name: "WRAPPED DAY" },
};
export const occVars = (k: OccKind) =>
  ({ ["--oc-acc" as string]: THEMES[k].acc, ["--oc-rgb" as string]: THEMES[k].rgb, ["--oc-dark" as string]: THEMES[k].dark, ["--oc-ink" as string]: THEMES[k].ink }) as CSSProperties;

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}
const ordinal = (n: number) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

export type OccInfo = {
  kind: OccKind;
  number: number;
  kickoffMs: number | null; // null for Wrapped day
  kickoff: string;
  venue: string;
  scored: boolean;
  seasonPlayed: number;
  year: string;
  month: string; // Wrapped day: "October"
};

export function OccasionRibbon({ o, onOpen }: { o: OccInfo; onOpen: () => void }) {
  const now = useNow();
  const left = o.kickoffMs ? Math.max(0, Math.floor((o.kickoffMs - now) / 1000)) : 0;
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60);
  const label =
    o.kind === "wrapped"
      ? `Your ${o.month} is out`
      : o.scored
        ? "Full time · vote for Man of the Match"
        : left > 0
          ? `Kick-off in ${h ? `${h}h ` : ""}${m}m`
          : `Under way at ${o.venue}`;
  return (
    <button className={"occ-ribbon " + o.kind} style={occVars(o.kind)} onClick={onOpen}>
      <i />
      <b>{o.kind === "milestone" ? `GAME Nº ${o.number}` : o.kind === "wrapped" ? `${o.month.toUpperCase()}, WRAPPED` : THEMES[o.kind].name}</b>
      <span>{label}</span>
      <em>{o.kind === "wrapped" ? "Watch ›" : "Fixtures ›"}</em>
    </button>
  );
}

export function OccasionHero({ o, onPrimary, onSecondary, secondaryLabel }: { o: OccInfo; onPrimary: () => void; onSecondary: () => void; secondaryLabel: string }) {
  const now = useNow();
  const left = o.kickoffMs ? Math.max(0, Math.floor((o.kickoffMs - now) / 1000)) : 0;
  const [envOpen, setEnvOpen] = useState(false);
  const [count, setCount] = useState(o.kind === "milestone" ? 1 : o.number);
  useEffect(() => {
    if (o.kind !== "milestone") return;
    let v = 1;
    const t = window.setInterval(() => {
      v += v < o.number - 10 ? Math.max(1, Math.round(o.number / 18)) : 1;
      if (v >= o.number) {
        v = o.number;
        window.clearInterval(t);
      }
      setCount(v);
    }, 45);
    return () => window.clearInterval(t);
  }, [o.kind, o.number]);
  const eyebrow =
    o.kind === "wrapped"
      ? `${o.month.toUpperCase()} · OUT NOW`
      : o.kind === "milestone"
        ? `THE CLUB'S ${ordinal(o.number).toUpperCase()} GAME · ${o.venue.toUpperCase()}`
        : o.kind === "finale"
          ? `SEASON ${o.year} · THE LAST GAME`
          : `CHRISTMAS · ${o.venue.toUpperCase()}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const primaryLabel = o.kind === "wrapped" ? "Watch yours" : o.scored ? "Vote Man of the Match" : "Who's playing";
  return (
    <div className={"occ-hero " + o.kind} style={occVars(o.kind)}>
      <div className="occ-photo" style={{ backgroundImage: `url(${THEMES[o.kind].photo})` }} />
      {o.kind === "christmas" && (
        <>
          <div className="occ-snow" aria-hidden="true">
            {Array.from({ length: 40 }, (_, k) => (
              <i key={k} style={{ left: `${(k * 29) % 100}%`, width: 2 + (k % 3), height: 2 + (k % 3), animationDuration: `${4 + (k % 5)}s`, animationDelay: `-${(k * 0.41) % 5}s` }} />
            ))}
          </div>
          <div className="occ-lights" aria-hidden="true">
            <svg viewBox="0 0 390 60" preserveAspectRatio="none">
              <path d="M-5 8 Q 48 40 97 14 T 195 14 T 292 14 T 395 10" fill="none" stroke="rgba(20,30,20,.9)" strokeWidth="2" />
            </svg>
            {Array.from({ length: 13 }, (_, k) => {
              const x = k / 12;
              return <i key={k} style={{ left: `calc(${x * 100}% - 5px)`, top: 12 + Math.abs(Math.sin(x * Math.PI * 4)) * 18, ["--c" as string]: ["#ff5a5a", "#22c55e", "#f5d97a", "#60a5fa"][k % 4], animationDelay: `-${(k * 0.37) % 1.6}s` }} />;
            })}
          </div>
        </>
      )}
      {o.kind === "milestone" && (
        <div className={"occ-num" + (count >= o.number ? " fill" : "")} aria-hidden="true">
          {count}
        </div>
      )}
      <div className="occ-hk">
        <small>{eyebrow}</small>
        <h3>
          {o.kind === "christmas" && (
            <>
              The <span>Christmas</span> Game
            </>
          )}
          {o.kind === "milestone" && (
            <>
              Game <span>Nº</span> {o.number}
            </>
          )}
          {o.kind === "finale" && (
            <>
              The <span>Season</span> Finale
            </>
          )}
          {o.kind === "wrapped" && (
            <>
              {o.month}, <span>Wrapped</span>
            </>
          )}
        </h3>
      </div>
      {o.kind === "finale" && (
        <div className="occ-ticks" aria-label={`${o.seasonPlayed} games played, this is the last`}>
          <div className="row">
            {Array.from({ length: o.seasonPlayed + 1 }, (_, i) => (
              <i key={i} className={i === o.seasonPlayed ? "last" : ""} style={{ animationDelay: `${i * 0.03}s` }} />
            ))}
          </div>
          <div className="lb">
            <span>
              <b>{o.seasonPlayed}</b> played
            </span>
            <span>Season {o.year}</span>
            <span>
              <b>1</b> to go
            </span>
          </div>
        </div>
      )}
      {o.kind === "wrapped" ? (
        <button
          className={"occ-env" + (envOpen ? " open" : "")}
          onClick={() => {
            if (envOpen) return onPrimary();
            setEnvOpen(true);
            window.setTimeout(onPrimary, 1100);
          }}
          aria-label={`Open your ${o.month} Wrapped`}
        >
          <span className="tip">{envOpen ? `Your ${o.month} is in` : "Tap to open"}</span>
          <span className="env">
            <span className="back" />
            <span className="card">
              <small>YOUR</small>
              <b>{o.month}</b>
              <small>WRAPPED</small>
            </span>
            <span className="front" />
            <span className="flap" />
            <span className="seal">
              <img src="/crest.png" alt="" />
            </span>
          </span>
        </button>
      ) : left > 0 ? (
        <>
          <div className="occ-clock">
            {[Math.floor(left / 3600), Math.floor((left % 3600) / 60), left % 60].map((v, i) => (
              <span key={i}>
                {i > 0 && <em>:</em>}
                <b>{pad(v)}</b>
              </span>
            ))}
          </div>
          <div className="occ-ko">to kick-off · {o.kickoff}</div>
        </>
      ) : (
        <div className="occ-ko live">
          <i />
          {o.scored ? "Full time" : `Under way at ${o.venue}`}
        </div>
      )}
      <div className="occ-acts">
        <button className="main" onClick={onPrimary}>
          {primaryLabel}
        </button>
        <button onClick={onSecondary}>{secondaryLabel}</button>
      </div>
    </div>
  );
}

export function OccasionTimeline({ o }: { o: OccInfo }) {
  const rows: [string, string][] =
    o.kind === "wrapped"
      ? [
          ["08:00", `Your ${o.month}, Wrapped is out`],
          ["Today", "Watch it, then share your card"],
        ]
      : o.kind === "christmas"
        ? [
            [o.kickoff, `Kick-off at ${o.venue}: the last game before Christmas`],
            ["FT", "Man of the Match vote opens"],
            ["Then", "Merry Christmas from the admins"],
          ]
        : o.kind === "milestone"
          ? [
              [o.kickoff, `Kick-off: the club's ${ordinal(o.number)} game`],
              ["FT", "Man of the Match vote opens"],
              ["Then", "Every game so far in Results › History"],
            ]
          : [
              [o.kickoff, `Kick-off: the last game of Season ${o.year}`],
              ["FT", "The last Man of the Match vote of the year"],
              ["Next", `Season ${o.year}, Wrapped is on its way`],
            ];
  return (
    <div className="occ-tl" style={occVars(o.kind)}>
      <h5>{o.kind === "wrapped" ? "TODAY" : "TONIGHT"}</h5>
      {rows.map(([t, s], i) => (
        <div key={i} className={i === 0 ? "next" : ""}>
          <b>{t}</b>
          <span>
            {s}
            {i === 0 && <em> · next</em>}
          </span>
        </div>
      ))}
    </div>
  );
}

export const occasionCss = `
.wcf-top.occ{position:sticky;background:var(--oc-dark);border-bottom:1px solid var(--oc-acc);box-shadow:0 6px 24px -10px rgba(var(--oc-rgb),.45)}
.wcf-top.occ::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,#fff,transparent);background-size:40% 100%;background-repeat:no-repeat;animation:occShine 3.2s linear infinite;opacity:.7}
@keyframes occShine{from{background-position:-60% 0}to{background-position:160% 0}}
.wcf-top.occ .wcf-logo img{filter:drop-shadow(0 0 10px rgba(var(--oc-rgb),.55))}
.wcf-top.occ .wcf-wordmark-sub{color:var(--oc-acc)}
.wcf-nav.occ{background:var(--oc-dark);border-top:1px solid var(--oc-acc)}
.wcf-nav.occ .wcf-navbtn.active{color:var(--oc-acc)}
.wcf-nav.occ .wcf-nav-pill{background:rgba(var(--oc-rgb),.14);border-color:rgba(var(--oc-rgb),.5);box-shadow:0 0 22px -6px rgba(var(--oc-rgb),.8)}
.occ-ribbon{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:8px;width:100%;padding:8px 14px;border:0;border-bottom:1px solid rgba(var(--oc-rgb),.35);background:var(--oc-dark);color:#f5f6f8;font:inherit;font-size:12px;cursor:pointer;text-align:left}
.occ-ribbon.christmas{border-top:3px solid transparent;border-image:repeating-linear-gradient(90deg,#ff5a5a 0 10px,#fff 10px 20px,#22c55e 20px 30px,#fff 30px 40px) 3}
.occ-ribbon i{width:7px;height:7px;border-radius:50%;background:var(--oc-acc);flex:none;animation:occPulse 1.2s infinite}
@keyframes occPulse{50%{opacity:.3}}
.occ-ribbon b{font:700 12px var(--font-oswald),sans-serif;letter-spacing:.14em;color:var(--oc-acc);white-space:nowrap}
.occ-ribbon span{color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.occ-ribbon em{margin-left:auto;font-style:normal;font-weight:800;color:var(--oc-acc);white-space:nowrap}
.occ-hero{position:relative;border-radius:22px;overflow:hidden;border:1.5px solid var(--oc-acc);box-shadow:0 0 50px -12px rgba(var(--oc-rgb),.7);padding-bottom:14px;margin-bottom:14px;background:#06070d;color:#fff}
.occ-photo{position:absolute;inset:0;background-size:cover;background-position:center 40%}
.occ-photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,8,14,.25),rgba(6,8,14,.55) 45%,rgba(6,8,14,.94))}
.occ-hero.christmas .occ-photo::before{content:"";position:absolute;inset:0;z-index:1;background:radial-gradient(120% 60% at 50% 0%,rgba(255,80,80,.22),transparent 60%)}
.occ-hk{position:relative;z-index:2;text-align:center;padding:30px 12px 0}
.occ-hk small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.26em;color:var(--oc-acc)}
.occ-hk h3{margin:6px 0 0;font:700 40px/.95 var(--font-oswald),sans-serif;text-transform:uppercase;text-shadow:0 4px 24px rgba(0,0,0,.6)}
.occ-hk h3 span{color:var(--oc-acc)}
.occ-hero.christmas .occ-hk{padding-top:58px}
.occ-snow{position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden}
.occ-snow i{position:absolute;top:-8px;border-radius:50%;background:#fff;opacity:.85;animation:occFall linear infinite}
@keyframes occFall{to{transform:translate(24px,560px)}}
.occ-lights{position:absolute;left:0;right:0;top:0;height:70px;pointer-events:none;z-index:1}
.occ-lights svg{position:absolute;left:0;top:0;width:100%;height:60px}
.occ-lights i{position:absolute;width:11px;height:15px;border-radius:50% 50% 50% 50%/60% 60% 40% 40%;background:var(--c);box-shadow:0 0 14px 4px var(--c);animation:occTw 1.6s ease-in-out infinite alternate}
@keyframes occTw{from{opacity:.35;box-shadow:0 0 4px 1px var(--c)}to{opacity:1}}
.occ-num{position:absolute;right:-10px;top:18px;z-index:1;font:700 220px/1 var(--font-oswald),sans-serif;color:transparent;-webkit-text-stroke:2px rgba(var(--oc-rgb),.55);letter-spacing:-.04em;pointer-events:none;font-variant-numeric:tabular-nums}
.occ-num.fill{color:rgba(var(--oc-rgb),.09)}
.occ-ticks{position:relative;z-index:2;margin:16px 14px 0}
.occ-ticks .row{display:flex;gap:3px}
.occ-ticks i{flex:1;height:26px;border-radius:3px;background:linear-gradient(180deg,#c4b5fd,#7c3aed);box-shadow:0 0 10px -2px rgba(196,181,253,.6);transform-origin:50% 100%;animation:occUp .5s cubic-bezier(.2,1.3,.4,1) backwards}
.occ-ticks i.last{background:#fff;box-shadow:0 0 16px 2px rgba(255,255,255,.7);animation:occUp .5s cubic-bezier(.2,1.3,.4,1) backwards,occPulse 1.2s ease-in-out infinite alternate}
@keyframes occUp{from{transform:scaleY(0)}}
.occ-ticks .lb{display:flex;justify-content:space-between;margin-top:7px;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:var(--oc-acc)}
.occ-ticks .lb b{color:#fff;font-weight:600}
.occ-clock{position:relative;z-index:2;display:flex;justify-content:center;gap:4px;margin-top:18px}
.occ-clock span{display:flex;align-items:center;gap:4px}
.occ-clock b{min-width:52px;height:50px;border-radius:8px;background:linear-gradient(180deg,#1c2233 50%,#151a28 50%);font:700 32px/50px var(--font-oswald),sans-serif;text-align:center;color:#fff;box-shadow:0 3px 8px rgba(0,0,0,.6);font-variant-numeric:tabular-nums}
.occ-clock em{font:700 26px var(--font-oswald),sans-serif;color:var(--oc-acc);font-style:normal}
.occ-ko{position:relative;z-index:2;text-align:center;font-size:11.5px;color:#cbd5e1;margin-top:8px}
.occ-ko.live{font-weight:800;color:#fff;display:flex;justify-content:center;gap:6px;align-items:center;margin-top:18px}
.occ-ko.live i{width:8px;height:8px;border-radius:50%;background:var(--oc-acc);animation:occPulse 1.2s infinite}
.occ-acts{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 12px 0}
.occ-acts button{height:44px;border-radius:12px;border:1px solid rgba(var(--oc-rgb),.45);background:rgba(var(--oc-rgb),.1);color:#fff;font:800 12.5px var(--sans);cursor:pointer}
.occ-acts button.main{background:var(--oc-acc);color:var(--oc-ink);border-color:var(--oc-acc)}
.occ-tl{border-radius:16px;border:1px solid rgba(var(--oc-rgb),.3);background:var(--oc-dark);padding:12px 14px;margin-bottom:14px}
.occ-tl h5{margin:0 0 8px;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;color:var(--oc-acc)}
.occ-tl div{display:grid;grid-template-columns:48px 1fr;gap:8px;padding:5px 0;font-size:12.5px;color:#e2e8f0;border-top:1px solid rgba(var(--oc-rgb),.12)}
.occ-tl div:first-of-type{border:0}
.occ-tl b{font:700 13px var(--font-oswald),sans-serif;color:var(--oc-acc)}
.occ-tl .next em{font-style:normal;color:var(--oc-acc);font-weight:800}
.occ-env{position:relative;z-index:2;display:block;margin:6px auto 0;padding:0;border:0;background:none;cursor:pointer;color:inherit}
.occ-env .tip{display:block;text-align:center;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:var(--oc-acc);margin:14px 0 44px}
.occ-env .env{position:relative;display:block;width:230px;height:150px;margin:0 auto}
.occ-env:not(.open) .env{animation:occBob 2.4s ease-in-out infinite}
@keyframes occBob{50%{transform:translateY(-6px) rotate(-1.5deg)}}
.occ-env .back{position:absolute;inset:0;border-radius:10px;background:linear-gradient(160deg,#c2410c,#7c2d12)}
.occ-env .card{position:absolute;z-index:1;left:14px;right:14px;top:14px;height:120px;border-radius:8px;background:linear-gradient(160deg,#fff7ed,#fed7aa);box-shadow:0 6px 16px rgba(0,0,0,.4);transition:transform .8s cubic-bezier(.2,1,.3,1) .35s;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#7c2d12;text-align:center}
.occ-env .card small{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em}
.occ-env .card b{font:700 26px/1 var(--font-oswald),sans-serif;text-transform:uppercase;margin:4px 0}
.occ-env .front{position:absolute;z-index:2;inset:0;border-radius:10px;background:linear-gradient(160deg,#fb923c,#c2410c);clip-path:polygon(0 30%,50% 62%,100% 30%,100% 100%,0 100%)}
.occ-env .flap{position:absolute;z-index:3;left:0;right:0;top:0;height:62%;background:linear-gradient(180deg,#fdba74,#ea580c);clip-path:polygon(0 0,100% 0,50% 100%);transform-origin:50% 0;transition:transform .55s cubic-bezier(.5,0,.3,1);border-radius:10px 10px 0 0}
.occ-env .seal{position:absolute;z-index:4;left:50%;top:52%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ff8a8a,#b91c1c 60%,#7f1d1d);box-shadow:0 3px 8px rgba(0,0,0,.5);display:grid;place-items:center;transition:transform .4s,opacity .4s}
.occ-env .seal img{width:26px;opacity:.85;filter:sepia(1) hue-rotate(-30deg) saturate(3) brightness(.7)}
.occ-env .tip{transition:opacity .2s}.occ-env.open .tip{opacity:0}
.occ-env.open .seal{transform:scale(1.4) rotate(20deg);opacity:0}
.occ-env.open .flap{transform:scaleY(-1);z-index:0}
.occ-env.open .card{transform:translateY(-24px)}
@media (prefers-reduced-motion: reduce){.occ-snow,.occ-lights i,.occ-env .env,.wcf-top.occ::after{animation:none!important}}
`;
