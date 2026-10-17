"use client";

import { useEffect, useRef, useState } from "react";

// The season card (2026-10-17): the top of a player's profile as a
// collectible in the First XI card family. It levels up with games played
// - Bronze under 5, Silver 5 to 14, Gold 15+ - and two special editions
// sit above that: Golden Boot (the season's top scorer) and Squad's Pick
// (most Man of the Match wins). Underneath, a Bronze -> Silver -> Gold track
// with the player's face on it, and the cards they've earned fanned out.

export type CardTier = "bronze" | "silver" | "gold" | "boot" | "star";
export const tierFor = (apps: number): CardTier => (apps >= 15 ? "gold" : apps >= 5 ? "silver" : "bronze");
const TIER_NAME: Record<CardTier, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", boot: "Golden Boot", star: "Squad's Pick" };
const TIER_GLOW: Record<CardTier, string> = { bronze: "#e6ad7d", silver: "#e2e8f0", gold: "#f5d97a", boot: "#ff6b78", star: "#9ee6ff" };
const MINI: Record<CardTier, string> = {
  bronze: "linear-gradient(160deg,#f6d2b0,#c0814a 45%,#6d3d18)",
  silver: "linear-gradient(160deg,#fff,#c3cad4 45%,#6b7584)",
  gold: "linear-gradient(160deg,#fff6d1,#f5d97a 35%,#b8902a 70%)",
  boot: "linear-gradient(160deg,#ffd9de,#e63946 40%,#7a0f18)",
  star: "conic-gradient(#f5d97a,#9ee6ff,#d8a6ff,#f5d97a)",
};
const ladderPct = (a: number) => (a < 5 ? (a / 5) * 50 : a < 15 ? 50 + ((a - 5) / 10) * 50 : 100);

export function SeasonCard({
  name,
  avatarUrl,
  gradient,
  stats,
  special,
}: {
  name: string;
  avatarUrl: string | null;
  gradient: string;
  stats: { apps: number; goals: number; motm: number };
  special: "boot" | "star" | null;
}) {
  const tier = special ?? tierFor(stats.apps);
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.transform = `perspective(700px) rotateY(${(x - 0.5) * 18}deg) rotateX(${(0.5 - y) * 14}deg)`;
    el.style.setProperty("--sx", `${(x - 0.5) * 160}%`);
    el.style.setProperty("--fx", `${x * 100}%`);
    el.style.setProperty("--fy", `${y * 100}%`);
  };
  return (
    <div className="wcf-sc-stage">
      <div ref={ref} className={"wcf-sc " + tier} onPointerMove={move} onPointerLeave={() => ref.current && (ref.current.style.transform = "")}>
        <div className="wcf-sc-in">
          {avatarUrl ? (
            <div className="wcf-sc-photo" style={{ backgroundImage: `url(${avatarUrl})` }} />
          ) : (
            <div className="wcf-sc-ini" style={{ background: gradient }}>
              {name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="wcf-sc-foil" />
          <div className="wcf-sc-shine" />
          <div className="wcf-sc-tl">
            <b>{stats.apps}</b>
            <small>GAMES</small>
            <img src="/crest.png" alt="" />
          </div>
          <span className="wcf-sc-tier">{TIER_NAME[tier].toUpperCase()}</span>
          <div className="wcf-sc-low">
            <div className="wcf-sc-name">{name}</div>
            <div className="wcf-sc-st">
              <span>
                {stats.goals}
                <small>GOALS</small>
              </span>
              <span>
                {stats.motm}
                <small>MOTM</small>
              </span>
              <span>
                {(stats.goals / Math.max(1, stats.apps)).toFixed(1)}
                <small>PER GAME</small>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TierLadder({ apps, special, avatarUrl, initial, isOwn }: { apps: number; special: "boot" | "star" | null; avatarUrl: string | null; initial: string; isOwn: boolean }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setP(ladderPct(apps)), 350);
    return () => window.clearTimeout(t);
  }, [apps]);
  const nextAt = apps < 5 ? 5 : apps < 15 ? 15 : null;
  const left = nextAt ? nextAt - apps : 0;
  return (
    <div className="wcf-sc-lad">
      <div className="hd">
        <span>Card tier</span>
        <b>
          {nextAt
            ? `${left} ${left === 1 ? "game" : "games"} to ${nextAt === 5 ? "Silver" : "Gold"}`
            : special
              ? `${TIER_NAME[special]} edition`
              : "Gold · top tier"}
        </b>
      </div>
      <div className="tr">
        <div className="fl" style={{ width: `${p}%` }} />
        <div className="me" style={{ left: `${p}%` }} aria-label={isOwn ? "You" : undefined}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : initial}
        </div>
      </div>
      <div className="sp">
        {(
          [
            ["bronze", 0, 0],
            ["silver", 5, 50],
            ["gold", 15, 100],
          ] as const
        ).map(([t, n, pos]) => (
          <div key={t} className={"st" + (apps >= n ? " on" : "")} style={{ left: `${pos}%` }}>
            <i style={{ background: MINI[t] }} />
            {TIER_NAME[t]}
            <em>{n ? `${n} GAMES` : "START"}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

// The cards a player has earned, fanned out.
export function CardFan({ apps, special }: { apps: number; special: "boot" | "star" | null }) {
  const got: CardTier[] = ["bronze", ...(apps >= 5 ? (["silver"] as const) : []), ...(apps >= 15 ? (["gold"] as const) : []), ...(special ? [special] : [])];
  const n = got.length;
  return (
    <div className="wcf-sc-fanwrap">
      <div className="wcf-pcard-sec-head">
        <span>Cards collected</span>
        <span>
          {n} of {special ? 4 : 3}
        </span>
      </div>
      <div className="wcf-sc-fan">
        {got.map((g, i) => {
          const r = (i - (n - 1) / 2) * 9;
          return (
            <div key={g} title={TIER_NAME[g]} style={{ background: MINI[g], ["--r" as string]: `${r}deg`, ["--y" as string]: `${Math.abs(r) * 0.5}px`, zIndex: i }} />
          );
        })}
      </div>
      <div className="wcf-sc-fancap">{got.map((g) => TIER_NAME[g]).join(" · ")}</div>
    </div>
  );
}

// "SILVER · Card unlocked", shown once per phone when your own card moves
// up a tier (or the first time you see it above Bronze).
export function TierUnlock({ tier, onDone }: { tier: CardTier; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 2700);
    return () => window.clearTimeout(t);
  }, [onDone]);
  return (
    <div className="wcf-sc-up" style={{ ["--g" as string]: TIER_GLOW[tier] }} aria-live="polite">
      <div className="rays" />
      <div className="glow" />
      <div className="tx">
        <b>{TIER_NAME[tier]}</b>
        <small>Card unlocked</small>
      </div>
    </div>
  );
}

export const seasonCardCss = `
.wcf-sc-stage{display:flex;justify-content:center;padding-top:6px;position:relative;z-index:2}
.wcf-sc{position:relative;width:200px;max-width:62vw;aspect-ratio:5/7;border-radius:17px;padding:3px;background:var(--frame);box-shadow:0 28px 44px -18px #000,0 0 46px -14px var(--glow);transition:transform .15s;touch-action:pan-y}
.wcf-sc-in{position:relative;height:100%;border-radius:14px;overflow:hidden;background:var(--base)}
.wcf-sc-photo{position:absolute;left:0;right:0;top:0;height:68%;background-size:cover;background-position:center 30%}
.wcf-sc-photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,transparent 28%,transparent 55%,var(--base) 100%)}
.wcf-sc-ini{position:absolute;left:0;right:0;top:0;height:68%;display:grid;place-items:center;font:800 92px var(--display);color:rgba(255,255,255,.92)}
.wcf-sc-ini::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 50%,var(--base))}
.wcf-sc-low{position:absolute;left:0;right:0;bottom:0;height:36%;background:var(--panel);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 10px 11px}
.wcf-sc-low::before{content:"";position:absolute;left:12px;right:12px;top:0;height:1px;background:linear-gradient(90deg,transparent,var(--sub),transparent);opacity:.6}
.wcf-sc-name{position:relative;font:700 20px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.02em;color:var(--ink);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-sc-st{position:relative;display:flex;gap:12px;margin-top:8px;padding-top:7px;border-top:1px solid var(--rule)}
.wcf-sc-st span{font:800 15px/1 var(--display);color:var(--ink);text-align:center}
.wcf-sc-st small{display:block;font:700 6.5px/1 var(--sans);letter-spacing:.12em;color:var(--sub);margin-top:4px;white-space:nowrap}
.wcf-sc-tl{position:absolute;top:10px;left:11px;display:flex;flex-direction:column;align-items:center;z-index:2}
.wcf-sc-tl b{font:700 36px/1 var(--font-oswald),sans-serif;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.7)}
.wcf-sc-tl small{font:800 7px/1 var(--sans);letter-spacing:.18em;color:#fff;opacity:.9}
.wcf-sc-tl img{width:24px;margin-top:7px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}
.wcf-sc-tier{position:absolute;top:11px;right:10px;z-index:2;font:700 9px var(--font-oswald),sans-serif;letter-spacing:.18em;padding:3px 7px;border-radius:5px;background:var(--frame);color:var(--chipInk);box-shadow:0 2px 6px rgba(0,0,0,.5)}
.wcf-sc-foil{position:absolute;inset:0;pointer-events:none;mix-blend-mode:soft-light;opacity:var(--foil);background:repeating-linear-gradient(115deg,rgba(255,0,140,.3) 0 5%,rgba(255,215,0,.3) 5% 10%,rgba(0,255,190,.3) 10% 15%,rgba(80,120,255,.3) 15% 20%);background-size:400% 400%;background-position:var(--fx,30%) var(--fy,30%)}
.wcf-sc-shine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 35%,rgba(255,255,255,.4) 48%,transparent 60%);transform:translateX(var(--sx,-80%));mix-blend-mode:overlay}
.wcf-sc.bronze{--frame:linear-gradient(160deg,#f6d2b0,#c0814a 40%,#6d3d18);--panel:linear-gradient(180deg,#5a3216,#25120a);--base:#4a2a12;--ink:#ffe6cc;--sub:#e6ad7d;--rule:rgba(255,226,196,.28);--glow:#c0814a;--chipInk:#2a1406;--foil:.12}
.wcf-sc.silver{--frame:linear-gradient(160deg,#fff,#c3cad4 40%,#6b7584);--panel:linear-gradient(180deg,#465061,#1a212c);--base:#3a4351;--ink:#f8fafc;--sub:#cbd5e1;--rule:rgba(255,255,255,.22);--glow:#cbd5e1;--chipInk:#1b2230;--foil:.22}
.wcf-sc.gold{--frame:linear-gradient(160deg,#fff6d1,#f5d97a 35%,#b8902a 70%,#7a5a1a);--panel:linear-gradient(180deg,#6b5214,#251b05);--base:#584210;--ink:#fff3c4;--sub:#f5d97a;--rule:rgba(245,217,122,.3);--glow:#f5d97a;--chipInk:#2a1d05;--foil:.34}
.wcf-sc.boot{--frame:linear-gradient(160deg,#ffd9de,#e63946 40%,#7a0f18);--panel:linear-gradient(180deg,#7a0f18,#260409);--base:#640c14;--ink:#fff;--sub:#ffb3ba;--rule:rgba(255,255,255,.25);--glow:#e63946;--chipInk:#fff;--foil:.3}
.wcf-sc.star{--frame:conic-gradient(from 200deg,#f5d97a,#9ee6ff,#d8a6ff,#f5d97a,#a6ffcf,#f5d97a);--panel:linear-gradient(180deg,#2b1d5c,#0d0a22);--base:#241850;--ink:#fff;--sub:#c4b5fd;--rule:rgba(196,181,253,.3);--glow:#9ee6ff;--chipInk:#1a1405;--foil:.6}
.wcf-sc-lad{position:relative;margin:2px 4px 16px}
.wcf-sc-lad .hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
.wcf-sc-lad .hd span{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#f5d97a}
.wcf-sc-lad .hd b{font:700 12px var(--sans);color:#e2e8f0}
.wcf-sc-lad .tr{position:relative;height:6px;border-radius:3px;background:rgba(148,163,184,.18);margin:0 16px}
.wcf-sc-lad .fl{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:linear-gradient(90deg,#c0814a,#c3cad4 50%,#f5d97a);transition:width 1s cubic-bezier(.2,.9,.3,1)}
.wcf-sc-lad .me{position:absolute;top:50%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid #f5d97a;overflow:hidden;background:#1f2937;box-shadow:0 0 0 4px rgba(245,217,122,.18),0 4px 10px rgba(0,0,0,.6);transition:left 1s cubic-bezier(.2,.9,.3,1);display:grid;place-items:center;font:800 11px var(--display);color:#fff;z-index:2}
.wcf-sc-lad .me img{width:100%;height:100%;object-fit:cover}
.wcf-sc-lad .sp{position:relative;height:62px;margin:12px 16px 0}
.wcf-sc-lad .st{position:absolute;top:0;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:4px;font:700 10px var(--sans);color:#94a3b8;opacity:.5;white-space:nowrap}
.wcf-sc-lad .st.on{opacity:1;color:#f1f5f9}
.wcf-sc-lad .st i{width:20px;aspect-ratio:5/7;border-radius:3px;box-shadow:0 4px 8px -3px #000,inset 0 0 0 1px rgba(255,255,255,.4)}
.wcf-sc-lad .st em{font:600 9px var(--font-oswald),sans-serif;letter-spacing:.12em;color:#64748b;font-style:normal}
.wcf-sc-fanwrap{margin:14px 0 6px}
.wcf-sc-fan{display:flex;justify-content:center;align-items:flex-end;height:84px;padding:12px 0 6px}
.wcf-sc-fancap{text-align:center;font:700 10.5px var(--sans);color:#cbd5e1;letter-spacing:.02em;margin-bottom:6px}
.wcf-sc-fan div{width:46px;aspect-ratio:5/7;border-radius:6px;margin:0 -5px;box-shadow:0 10px 16px -6px #000,inset 0 0 0 1.5px rgba(255,255,255,.45);transform:rotate(var(--r)) translateY(var(--y));position:relative}
.wcf-sc-up{position:fixed;inset:0;z-index:400;pointer-events:none;display:grid;place-items:center;overflow:hidden}
.wcf-sc-up .rays{position:absolute;width:700px;height:700px;border-radius:50%;background:repeating-conic-gradient(from 0deg,rgba(255,255,255,.16) 0 5deg,transparent 5deg 18deg);-webkit-mask:radial-gradient(circle,#000 15%,transparent 62%);mask:radial-gradient(circle,#000 15%,transparent 62%);animation:wcfScSpin 8s linear infinite,wcfScFade 2.6s forwards}
.wcf-sc-up .glow{position:absolute;width:320px;height:320px;border-radius:50%;background:radial-gradient(circle,var(--g),transparent 65%);opacity:.55;animation:wcfScFade 2.6s forwards}
.wcf-sc-up .tx{position:relative;text-align:center;animation:wcfScStamp 2.6s forwards}
.wcf-sc-up b{display:block;font:700 54px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.06em;color:#fff;text-shadow:0 0 34px var(--g),0 2px 0 rgba(0,0,0,.4)}
.wcf-sc-up small{display:block;margin-top:6px;font:600 12px var(--font-oswald),sans-serif;letter-spacing:.3em;text-transform:uppercase;color:var(--g)}
@keyframes wcfScStamp{0%{transform:scale(2.6);opacity:0}14%{transform:scale(.94);opacity:1}22%{transform:scale(1)}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.05)}}
@keyframes wcfScSpin{to{transform:rotate(360deg)}}
@keyframes wcfScFade{0%{opacity:0}12%{opacity:1}75%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.wcf-sc-up{display:none}.wcf-sc-lad .fl,.wcf-sc-lad .me{transition:none}}
`;
