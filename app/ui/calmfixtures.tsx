"use client";

import { useEffect, useState, type ReactNode } from "react";

// The calmer Fixtures list (2026-10-17). Every game is one line in a month
// card (the special game is a gold match ticket), with one status badge
// in a single premium style, and the actions behind a tap in a sheet. The
// old list printed a full card - and a Give up spot button - for every game.

export type CalmState = "paid" | "unpaid" | "pending" | "waiting" | "open" | "full";

const I = {
  tick: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  coin: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 8.5v7M9.5 10.5h4" />
    </>
  ),
  pound: <path d="M16 6.5A4 4 0 0 0 9 9v9M7 18h10M7 12.5h7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.5l3 2" />
    </>
  ),
  plus: <path d="M12 6v12M6 12h12" />,
};
function Md({ cls, icon, label, sub }: { cls: string; icon: ReactNode; label: string; sub?: string }) {
  return (
    <span className={"cf-md " + cls}>
      <i>{typeof icon === "string" ? icon : <svg viewBox="0 0 24 24">{icon}</svg>}</i>
      <span>
        <b>{label}</b>
        {sub && <small>{sub}</small>}
      </span>
    </span>
  );
}

export function CalmBadge({ state, soon, credit, due, pos, queueLen, left, side }: { state: CalmState; soon?: boolean; credit?: boolean; due?: number; pos?: number; queueLen?: number; left?: number; side?: string }) {
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  if (state === "paid") return <Md cls="gold" icon={credit ? I.coin : I.tick} label="In" sub={credit ? "credit" : side} />;
  if (state === "unpaid") return soon ? <Md cls="red" icon={I.pound} label={`Pay £${due}`} sub="this week" /> : <Md cls="ring-red" icon={I.pound} label={`£${due} due`} />;
  if (state === "pending") return <Md cls="amber" icon={I.clock} label="Checking" />;
  if (state === "waiting") return <Md cls="blue" icon={String(pos ?? "")} label="In line" sub={pos ? `${nth(pos)} of ${queueLen ?? pos}` : undefined} />;
  if (state === "open") return <Md cls="green" icon={I.plus} label="Book" sub={left != null ? `${left} left` : undefined} />;
  return <Md cls="grey" icon={I.plus} label="Join list" />;
}

export function CalmRow({ day, num, title, meta, badge, state, onOpen }: { day: string; num: string; title: string; meta: string; badge: ReactNode; state: CalmState; onOpen: () => void }) {
  return (
    <button className={"cf-r " + state} onClick={onOpen}>
      <span className="cf-d">
        <b>{num}</b>
        <small>{day}</small>
      </span>
      <span className="cf-i">
        <b>{title}</b>
        <span>{meta}</span>
      </span>
      <span className="cf-s">
        {badge}
        <span className="cf-chev">›</span>
      </span>
    </button>
  );
}

// The special game (the First XI) as a gold match ticket.
export function CalmTicket({ day, num, month, tag, title, meta, kickoffMs, badge, photo, onOpen }: { day: string; num: string; month: string; tag: string; title: string; meta: string; kickoffMs: number; badge: ReactNode; photo: string; onOpen: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(t);
  }, []);
  const days = Math.ceil((kickoffMs - now) / 86400000);
  const when = kickoffMs - now <= 0 ? "TODAY" : days <= 1 ? (new Date(kickoffMs).getDate() === new Date(now).getDate() ? "TODAY" : "TOMORROW") : `IN ${days} DAYS`;
  return (
    <button className="cf-tk" onClick={onOpen} style={{ ["--tkbg" as string]: `url(${photo})` }}>
      <span className="stub">
        <small>{day}</small>
        <b>{num}</b>
        <em>{month}</em>
      </span>
      <span className="body">
        <span className="tg">
          <img src="/crest.png" alt="" />
          {tag}
        </span>
        <span className="tt">{title}</span>
        <span className="mt">{meta}</span>
        <span className="cd">
          <i />
          {when}
        </span>
      </span>
      <span className="bd">{badge}</span>
    </button>
  );
}

export function CalmMonth({ label, summary, photo, children }: { label: string; summary: [string, string]; photo: string; children: ReactNode }) {
  return (
    <section className="cf-month">
      <div className="ph" style={{ backgroundImage: `url(${photo})` }} />
      <div className="cf-hd">
        <h4>{label}</h4>
        <span>
          {summary[0]}
          <br />
          {summary[1]}
        </span>
      </div>
      <div className="cf-rule" />
      <div className="cf-rows">{children}</div>
    </section>
  );
}

// The sheet a game opens: a photo header with its status, an optional
// note, then that game's actions (passed in by GameCard).
export function CalmSheet({ photo, badge, kicker, time, meta, note, grey, onClose, children }: { photo: string; badge: ReactNode; kicker: string; time: string; meta: string; note?: string | null; grey?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <div className="cf-ov" onClick={onClose}>
      <div className="cf-sh" onClick={(e) => e.stopPropagation()}>
        <div className={"hero" + (grey ? " grey" : "")} style={{ backgroundImage: `url(${photo})` }}>
          <span className="pill">{badge}</span>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
          <small>{kicker}</small>
          <b>{time}</b>
          <span>{meta}</span>
        </div>
        {note && <div className="cf-note">{note}</div>}
        <div className="cf-acts">{children}</div>
      </div>
    </div>
  );
}
export const CalmIcon = {
  who: (
    <svg viewBox="0 0 24 24">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.9.7 3.1 2.4 3.5 5.2" />
    </svg>
  ),
  cal: (
    <svg viewBox="0 0 24 24">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </svg>
  ),
  out: (
    <svg viewBox="0 0 24 24">
      <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  pay: (
    <svg viewBox="0 0 24 24">
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
      <path d="M2.5 10h19" />
    </svg>
  ),
  tick: (
    <svg viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  book: (
    <svg viewBox="0 0 24 24">
      <path d="M2 5.5C4 4.5 7 4.3 12 6c5-1.7 8-1.5 10-.5V19c-2-1-5-1.2-10 .5C7 17.8 4 18 2 19zM12 6v13.5" />
    </svg>
  ),
};

export function CalmCalledOff({ day, num, month, reason, credited, onDone }: { day: string; num: string; month: string; reason: string; credited: boolean; onDone: () => void }) {
  return (
    <div className="cf-co" role="alert">
      <div className="stub">
        <b>{num}</b>
        <small>
          {day} {month}
        </small>
      </div>
      <div className="tx">
        <em>CALLED OFF</em>
        <b>{reason}</b>
        {credited && <span>✓ You&apos;d paid · £5 credit added</span>}
      </div>
      <button onClick={onDone}>Got it</button>
    </div>
  );
}

export const calmFixturesCss = `
.cf-month{position:relative;border-radius:22px;overflow:hidden;margin:0 0 16px;background:#0f1424;border:1px solid rgba(245,217,122,.22);box-shadow:0 22px 44px -28px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05)}
.cf-month .ph{position:absolute;inset:0 0 auto 0;height:150px;background-size:cover;background-position:center 40%;opacity:.38}
.cf-month .ph::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,20,36,.2),#0f1424)}
.cf-hd{position:relative;display:flex;align-items:flex-end;gap:10px;padding:16px 16px 10px}
.cf-hd h4{margin:0;font:700 26px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff;border:0!important;padding:0!important}
.cf-hd span{margin-left:auto;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#f5d97a;text-align:right;line-height:1.4}
.cf-rule{position:relative;height:1px;margin:0 16px;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,.15) 70%,transparent)}
.cf-rows{position:relative;padding:4px 0 6px}
.cf-rows>article{margin:0!important}
.cf-r{--edge:transparent;display:flex;align-items:center;gap:14px;width:100%;padding:12px 16px;border:0;background:none;color:#fff;text-align:left;cursor:pointer;font:inherit;position:relative}
.cf-rows>article+article .cf-r::before{content:"";position:absolute;left:16px;right:16px;top:0;border-top:1px dashed rgba(148,163,184,.18)}
.cf-r::after{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--edge);opacity:.9}
.cf-r.paid{--edge:#f5d97a}.cf-r.unpaid{--edge:#ef4655}.cf-r.pending{--edge:#fcd34d}.cf-r.waiting{--edge:#93c5fd}.cf-r.open{--edge:#4ade80}
.cf-r:active{background:rgba(255,255,255,.04)}
.cf-d{flex:none;width:44px;text-align:center}
.cf-d b{display:block;font:700 28px/1 var(--font-oswald),sans-serif;color:#fff}
.cf-r.unpaid .cf-d b{color:#ff8a92}
.cf-d small{display:block;font:600 9px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;margin-top:2px}
.cf-i{min-width:0;flex:1}
.cf-i b{display:block;font:800 14.5px var(--display);color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cf-i span{display:block;font:500 11.5px var(--sans);color:#94a3b8;margin-top:2px}
.cf-s{flex:none;display:flex;align-items:center;gap:8px}
.cf-chev{color:#475569;font-size:18px}
.cf-md{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;text-align:left}
.cf-md i{position:relative;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;flex:none;font:800 9.5px var(--display);font-style:normal;box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 2px 6px rgba(0,0,0,.45)}
.cf-md i svg{width:12px;height:12px;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.cf-md b{display:block;font:600 11px/1 var(--font-oswald),sans-serif;letter-spacing:.14em;text-transform:uppercase}
.cf-md small{display:block;font:600 9px var(--font-oswald),sans-serif;letter-spacing:.14em;opacity:.75;margin-top:2px}
.cf-md.gold i{background:radial-gradient(circle at 35% 28%,#fff6d1,#f5d97a 50%,#b8902a);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 0 12px -2px rgba(245,217,122,.7)}
.cf-md.gold i svg{stroke:#2a1d05}.cf-md.gold b{color:#f5d97a}.cf-md.gold small{color:#f5d97a}
.cf-md.red i{background:radial-gradient(circle at 35% 28%,#ffb3b9,#ef4655 50%,#9b1c26);animation:cfPulse 2s ease-in-out infinite}
.cf-md.red i svg{stroke:#fff}.cf-md.red b,.cf-md.red small{color:#ff8a92}
@keyframes cfPulse{0%,100%{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 0 14px -2px rgba(230,57,70,.85)}50%{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 0 4px -2px rgba(230,57,70,.5)}}
.cf-md.ring-red i{background:transparent;border:1.5px solid rgba(255,138,146,.7);box-shadow:none}
.cf-md.ring-red i svg{stroke:#ff8a92}.cf-md.ring-red b{color:#ff8a92}
.cf-md.amber i{background:radial-gradient(circle at 35% 28%,#fff1b8,#fcd34d 50%,#b7791f)}
.cf-md.amber i svg{stroke:#3a2a05}.cf-md.amber b{color:#fcd34d}
.cf-md.amber i::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:1.5px solid transparent;border-top-color:#fcd34d;animation:cfSpin 1.6s linear infinite}
@keyframes cfSpin{to{transform:rotate(360deg)}}
.cf-md.blue i{background:radial-gradient(circle at 35% 28%,#dbeafe,#93c5fd 50%,#3b6fb8);color:#0b1e3a}
.cf-md.blue b,.cf-md.blue small{color:#93c5fd}
.cf-md.green i{background:radial-gradient(circle at 35% 28%,#dcfce7,#4ade80 50%,#15803d)}
.cf-md.green i svg{stroke:#052e14}.cf-md.green b,.cf-md.green small{color:#86efac}
.cf-md.grey i{background:transparent;border:1.5px solid rgba(203,213,225,.45);box-shadow:none}
.cf-md.grey i svg{stroke:#cbd5e1}.cf-md.grey b{color:#cbd5e1}
.cf-tk{position:relative;display:flex;align-items:stretch;width:calc(100% - 20px);margin:8px 10px 10px;padding:0;border:0;border-radius:16px;overflow:hidden;cursor:pointer;color:#fff;text-align:left;font:inherit;background:linear-gradient(90deg,rgba(14,11,5,.96) 38%,rgba(14,11,5,.6) 70%,rgba(14,11,5,.35)),var(--tkbg) 70% 40%/cover;box-shadow:0 0 0 1px rgba(245,217,122,.7),0 0 26px -8px rgba(245,217,122,.75),0 14px 26px -16px #000}
.cf-tk::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,243,196,.22) 45%,transparent 60%);background-size:250% 100%;animation:cfFoil 5s ease-in-out infinite;pointer-events:none}
@keyframes cfFoil{0%{background-position:120% 0}60%,100%{background-position:-60% 0}}
.cf-tk .stub{position:relative;flex:none;width:72px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:12px 0;background:linear-gradient(180deg,rgba(245,217,122,.18),rgba(245,217,122,.06));border-right:1.5px dashed rgba(245,217,122,.55)}
.cf-tk .stub::before,.cf-tk .stub::after{content:"";position:absolute;right:-9px;width:16px;height:16px;border-radius:50%;background:#0f1424;box-shadow:inset 0 0 0 1px rgba(245,217,122,.6)}
.cf-tk .stub::before{top:-9px}.cf-tk .stub::after{bottom:-9px}
.cf-tk .stub small{font:600 9px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#f5d97a}
.cf-tk .stub b{font:700 34px/1 var(--font-oswald),sans-serif;background:linear-gradient(180deg,#fff6d1,#f5d97a 55%,#b8902a);-webkit-background-clip:text;background-clip:text;color:transparent;margin:2px 0}
.cf-tk .stub em{font:600 9px var(--font-oswald),sans-serif;letter-spacing:.2em;color:#cbd5e1;font-style:normal}
.cf-tk .body{position:relative;flex:1;min-width:0;padding:11px 12px 11px 16px;display:flex;flex-direction:column;justify-content:center}
.cf-tk .tg{display:flex;align-items:center;gap:6px;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#f5d97a}
.cf-tk .tg img{width:14px;filter:drop-shadow(0 0 4px rgba(245,217,122,.6))}
.cf-tk .tt{font:800 15px/1.2 var(--display);color:#fff;margin-top:4px}
.cf-tk .mt{font:500 11.5px var(--sans);color:#cbd5e1;margin-top:2px}
.cf-tk .cd{display:inline-flex;align-items:center;gap:6px;margin-top:7px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;color:#fff3c4}
.cf-tk .cd i{width:6px;height:6px;border-radius:50%;background:#f5d97a;box-shadow:0 0 8px #f5d97a}
.cf-tk .bd{position:relative;flex:none;display:flex;align-items:center;padding-right:12px}
.cf-more{display:flex!important;align-items:center;justify-content:center;gap:8px;width:100%;height:48px;margin:0 0 10px!important;border-radius:14px!important;border:1px solid rgba(245,217,122,.3)!important;background:rgba(245,217,122,.05)!important;color:#f5d97a!important;font:800 13px var(--display)!important}
.cf-ov{position:fixed;inset:0;z-index:250;background:rgba(6,7,14,.62);display:flex;align-items:flex-end;animation:cfF .25s}
@keyframes cfF{from{background:rgba(6,7,14,0)}}
.cf-sh{width:100%;max-width:520px;margin:0 auto;border-radius:24px 24px 0 0;overflow:hidden;background:#131826;border-top:1px solid rgba(245,217,122,.35);animation:cfUp .38s cubic-bezier(.2,1.05,.35,1);padding-bottom:env(safe-area-inset-bottom,0px)}
@keyframes cfUp{from{transform:translateY(100%)}}
.cf-sh .hero{position:relative;height:150px;background-size:cover;background-position:center 60%;display:flex;flex-direction:column;justify-content:flex-end;padding:14px 18px}
.cf-sh .hero.grey{filter:grayscale(1) brightness(.7)}
.cf-sh .hero::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(13,13,26,.05),rgba(19,24,38,.6) 55%,#131826)}
.cf-sh .hero>*{position:relative}
.cf-sh .hero .pill{position:absolute;top:14px;left:18px;padding:5px 11px 5px 5px;border-radius:999px;background:rgba(10,12,20,.6);border:1px solid rgba(255,255,255,.14);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.cf-sh .hero .x{position:absolute;top:12px;right:14px;width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.45);color:#fff;font-size:18px;cursor:pointer}
.cf-sh .hero small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#cbd5e1}
.cf-sh .hero>b{font:800 40px/1 var(--display);color:#fff;margin-top:4px}
.cf-sh .hero>span:last-child{font:600 12px var(--sans);color:#cbd5e1;margin-top:4px}
.cf-note{margin:12px 16px 0;padding:10px 12px;border-radius:12px;font:500 12.5px/1.45 var(--sans);color:#e2e8f0;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}
.cf-acts{padding:12px 16px 22px;display:grid;gap:8px}
.cf-acts .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cf-acts button,.cf-acts a{display:flex;align-items:center;gap:12px;height:50px;padding:0 16px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font:800 14px var(--display);cursor:pointer;text-decoration:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.cf-acts svg{width:18px;height:18px;flex:none;stroke:#f5d97a;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.cf-acts .dn{color:#ff8a92;border-color:rgba(230,57,70,.4);background:rgba(230,57,70,.07)}
.cf-acts .dn svg{stroke:#ff8a92}
.cf-acts .pay{background:linear-gradient(180deg,#ef4655,#d62839);border-color:transparent;color:#fff}
.cf-acts .pay svg{stroke:#fff}
.cf-acts .go{background:linear-gradient(180deg,#86efac,#22c55e);border-color:transparent;color:#052e14}
.cf-acts .go svg{stroke:#052e14}
.cf-acts .gold{background:linear-gradient(180deg,#fff3c4,#f5d97a);border-color:transparent;color:#1a1405}
.cf-acts .gold svg{stroke:#1a1405}
.cf-acts button:disabled{opacity:.45}
.cf-acts p{margin:0;font:500 12.5px var(--sans);color:#fca5a5}
.cf-co{display:flex;align-items:center;gap:14px;margin:0 0 16px;padding:12px 14px 12px 12px;border-radius:18px;border:1px solid rgba(230,57,70,.45);background:linear-gradient(100deg,rgba(40,10,14,.95),rgba(16,18,30,.95));box-shadow:0 0 28px -14px rgba(230,57,70,.8),inset 0 1px 0 rgba(255,255,255,.05)}
.cf-co .stub{flex:none;width:52px;height:56px;border-radius:10px;border:1px dashed rgba(230,57,70,.55);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ff8a92}
.cf-co .stub b{font:700 24px/1 var(--font-oswald),sans-serif;text-decoration:line-through;text-decoration-thickness:2px}
.cf-co .stub small{font:600 8.5px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase}
.cf-co .tx{min-width:0;flex:1}
.cf-co .tx em{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#ff8a92;font-style:normal}
.cf-co .tx b{display:block;font:800 15px var(--display);color:#fff;margin-top:2px}
.cf-co .tx span{display:block;margin-top:5px;font:700 11px var(--sans);color:#f5d97a}
.cf-co button{flex:none;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;border-radius:11px;padding:8px 12px;font:800 12px var(--sans);cursor:pointer}
.wcf-cc{position:relative;display:flex;align-items:center;gap:13px;margin:0 0 14px;padding:12px 14px;border-radius:18px;overflow:hidden;background:linear-gradient(100deg,rgba(38,30,10,.96),rgba(16,18,30,.96) 70%);border:1px solid rgba(245,217,122,.45);box-shadow:0 0 26px -14px rgba(245,217,122,.85),inset 0 1px 0 rgba(255,255,255,.06)}
.wcf-cc::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 35%,rgba(255,243,196,.14) 48%,transparent 60%);background-size:250% 100%;animation:cfFoil 6s ease-in-out infinite;pointer-events:none}
.wcf-cc .coin{position:relative;flex:none;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 34% 28%,#fff8dc,#f5d97a 42%,#c9a24a 70%,#7a5a1a);box-shadow:inset 0 0 0 3px rgba(255,248,220,.35),inset 0 -4px 7px rgba(80,55,10,.45),0 0 18px -3px rgba(245,217,122,.85);animation:ccFlip .9s cubic-bezier(.3,1.4,.5,1) .2s backwards}
.wcf-cc .coin::before{content:"";position:absolute;inset:5px;border-radius:50%;border:1px dashed rgba(90,64,16,.45)}
.wcf-cc .coin b{position:relative;font:700 19px/1 var(--font-oswald),sans-serif;color:#3a2a08;text-shadow:0 1px 0 rgba(255,248,220,.6)}
@keyframes ccFlip{from{transform:rotateY(90deg) scale(.6);opacity:0}}
.wcf-cc .tx{position:relative;min-width:0;flex:1}
.wcf-cc .tx small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#f5d97a}
.wcf-cc .tx b{display:block;font:800 15px var(--display);color:#fff;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-cc .tx span{display:block;font:500 11.5px var(--sans);color:#cbd5e1;margin-top:2px}
.wcf-cc button{position:relative;flex:none;border:0;border-radius:12px;padding:8px 11px;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 11.5px var(--display);white-space:nowrap;cursor:pointer;box-shadow:0 8px 18px -10px rgba(245,217,122,.9)}
.wcf-cc button em{font-style:normal;opacity:.7}
@media (prefers-reduced-motion: reduce){.wcf-cc::after,.wcf-cc .coin{animation:none!important}}
@media (prefers-reduced-motion: reduce){.cf-md.red i,.cf-md.amber i::after,.cf-tk::after,.cf-sh,.cf-ov{animation:none!important}}
`;
