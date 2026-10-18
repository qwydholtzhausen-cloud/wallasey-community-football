"use client";

import { useEffect, useState } from "react";
import { BirthdayBunting } from "./celebrate";
import { fmtDate } from "./shared";
import { kickoffCutoff, nowInLondon } from "../../lib/time";

// Calm Line-up (admins first, 2026-10-18): one screen about the next game,
// no tabs. A slim header with a live countdown (and the birthday theme on
// a birthday game), the admin tools out in the open on a dashed ADMIN
// card, who's in or the pitch, your prediction once, and the way into the
// predictor league. The team generator opens as a sheet over it.

// "YYYY-MM-DDTHH:MM" wall-clock strings, compared as such (pretend-UTC).
const wallMs = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));

function useCountdown(date: string, kickoff: string) {
  const [now, setNow] = useState(() => nowInLondon());
  useEffect(() => {
    const t = setInterval(() => setNow(nowInLondon()), 30000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.round((wallMs(kickoffCutoff(date, kickoff, 0)) - wallMs(now)) / 60000);
  const time = kickoff.slice(0, 5);
  if (mins <= 0) return { live: true, text: `Kicked off · ${time}` };
  if (mins < 60) return { live: true, text: `Kick-off in ${mins} min · ${time}` };
  const today = now.slice(0, 10) === date;
  if (today) return { live: true, text: `Today · ${time}` };
  const days = Math.round((Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - Date.UTC(+now.slice(0, 4), +now.slice(5, 7) - 1, +now.slice(8, 10))) / 86400000);
  return { live: false, text: `${days === 1 ? "Tomorrow" : `In ${days} days`} · ${time}` };
}

// The birthday hat: a striped cone with a gold trim and a pompom that
// drops on, then wobbles; two sparkles twinkle.
let hatSeq = 0;
export function BirthdayHat({ className = "" }: { className?: string }) {
  const [id] = useState(() => `bh${++hatSeq}`);
  return (
    <svg className={"cl-hat " + className} viewBox="0 0 44 52" aria-hidden="true">
      <defs>
        <clipPath id={`${id}c`}>
          <path d="M22 6 L39 44 Q22 50 5 44 Z" />
        </clipPath>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff6b7a" />
          <stop offset=".55" stopColor="#e63946" />
          <stop offset="1" stopColor="#9d1c2b" />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff3c4" />
          <stop offset=".5" stopColor="#f5d97a" />
          <stop offset="1" stopColor="#b8902a" />
        </linearGradient>
        <radialGradient id={`${id}p`} cx=".35" cy=".3" r=".7">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".6" stopColor="#fff3c4" />
          <stop offset="1" stopColor="#e8c766" />
        </radialGradient>
      </defs>
      <path d="M22 6 L39 44 Q22 50 5 44 Z" fill={`url(#${id}g)`} />
      <g clipPath={`url(#${id}c)`} opacity=".95">
        <path d="M0 22 L44 6 L44 11 L0 27Z M0 33 L44 17 L44 22 L0 38Z M0 44 L44 28 L44 33 L0 49Z" fill={`url(#${id}s)`} />
        <circle cx="16" cy="19" r="1.2" fill="#fff" />
        <circle cx="27" cy="31" r="1.1" fill="#fff" />
        <circle cx="12" cy="38" r="1" fill="#fff" />
        <circle cx="31" cy="40" r="1.1" fill="#fff" />
        <path d="M22 6 L13 44 Q8 44 5 44Z" fill="rgba(255,255,255,.14)" />
      </g>
      <path d="M4.5 43.5 Q22 50.5 39.5 43.5" fill="none" stroke={`url(#${id}s)`} strokeWidth="3.6" strokeLinecap="round" />
      <g className="pom">
        <circle cx="22" cy="6" r="5.4" fill={`url(#${id}p)`} />
        <circle cx="18.6" cy="4.6" r="2.4" fill="#fff" />
        <circle cx="25.6" cy="4.2" r="2.2" fill="#fff8e1" />
        <circle cx="22.4" cy="9" r="2.3" fill="#f5d97a" opacity=".8" />
      </g>
      <path className="tw a" d="M37 8 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2z" fill="#fde68a" />
      <path className="tw b" d="M5 14 l.9 2.2 2.2 .9 -2.2 .9 -.9 2.2 -.9 -2.2 -2.2 -.9 2.2 -.9z" fill="#fde68a" />
    </svg>
  );
}

const CONFETTI = Array.from({ length: 16 }, (_, k) => ({
  left: (k * 37) % 100,
  color: ["#f5d97a", "#e63946", "#60a5fa", "#4ade80", "#fff"][k % 5],
  dur: 3 + ((k * 7) % 30) / 10,
  delay: -((k * 13) % 50) / 10,
}));

export function CalmLineupHead({ date, kickoff, venue, birthdayNames }: { date: string; kickoff: string; venue: string; birthdayNames: string[] }) {
  const cd = useCountdown(date, kickoff);
  const bday = birthdayNames.length > 0;
  const who = birthdayNames.length === 1 ? birthdayNames[0] : `${birthdayNames.slice(0, -1).join(", ")} & ${birthdayNames[birthdayNames.length - 1]}`;
  return (
    <div className={"cl-head" + (bday ? " bday" : "")}>
      <style>{calmLineupCss}</style>
      {bday && (
        <>
          <div className="cl-confetti" aria-hidden="true">
            {CONFETTI.map((c, i) => (
              <i key={i} style={{ left: `${c.left}%`, background: c.color, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }} />
            ))}
          </div>
          <BirthdayBunting />
        </>
      )}
      <div className="tx">
        <small>Line-up · {fmtDate(date)}</small>
        <b>{venue}</b>
        <i className={cd.live ? "live" : undefined}>{cd.text}</i>
        {bday && (
          <span className="bd">
            <BirthdayHat className="tag" />
            {who === "You" ? "Your birthday game" : `${who}'s birthday game`}
          </span>
        )}
      </div>
    </div>
  );
}

export function CalmAdminCard({ status, children }: { status: string; children: React.ReactNode }) {
  return (
    <div className="cl-admin">
      <div className="lbl">
        <small>Admin</small>
        <b>{status}</b>
      </div>
      <div className="btns">{children}</div>
    </div>
  );
}

export function CalmSheetBar({ eyebrow, title, onClose, back = false }: { eyebrow: string; title: string; onClose: () => void; back?: boolean }) {
  return (
    <div className="cl-sh">
      <style>{calmLineupCss}</style>
      {back && (
        <button className="back" onClick={onClose} aria-label="Back to the line-up">
          ‹
        </button>
      )}
      <span>
        <small>{eyebrow}</small>
        <b>{title}</b>
      </span>
      {!back && (
        <button onClick={onClose} aria-label="Close">
          ✕
        </button>
      )}
    </div>
  );
}

export function PredictorLeagueLink({ rank, onOpen }: { rank: number | null; onOpen: () => void }) {
  const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th"));
  return (
    <button className="cl-league" onClick={onOpen}>
      <style>{calmLineupCss}</style>
      <span>
        <small>Predictor league</small>
        <b>{rank ? `You're ${ord(rank)} this season` : "See the table"}</b>
      </span>
      <em>›</em>
    </button>
  );
}

export const calmLineupCss = `
.cl-head{position:relative;overflow:hidden;margin:2px 0 14px;padding:14px 16px;border-radius:20px;background:#0f1424;border:1px solid rgba(245,217,122,.25);box-shadow:0 22px 44px -28px rgba(0,0,0,.9)}
.cl-head::before{content:"";position:absolute;inset:0;background:url(/pitch-floodlit.jpg) center 35%/cover;opacity:.32}
.cl-head::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(15,20,36,.96) 35%,rgba(15,20,36,.55))}
.cl-head .tx{position:relative;z-index:3;min-width:0}
.cl-head small{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.cl-head b{display:block;margin-top:3px;font:800 22px/1.1 var(--display);color:#fff}
.cl-head i{display:flex;align-items:center;gap:6px;margin-top:4px;font:600 12px var(--sans);font-style:normal;color:#cbd5e1}
.cl-head i::before{content:"";width:7px;height:7px;border-radius:50%;background:#64748b}
.cl-head i.live::before{background:#4ade80;box-shadow:0 0 8px #4ade80;animation:clP 1.6s ease-in-out infinite}
@keyframes clP{50%{opacity:.35}}
.cl-head.bday{padding-top:50px;border-color:rgba(245,217,122,.5);box-shadow:0 0 34px -16px rgba(245,217,122,.8),0 22px 44px -28px rgba(0,0,0,.9)}
.cl-head.bday::after{background:linear-gradient(90deg,rgba(40,24,40,.94) 35%,rgba(30,20,36,.6)),radial-gradient(circle at 80% 20%,rgba(245,217,122,.25),transparent 50%)}
.cl-head .wcf-bunting{position:absolute;left:0;right:0;top:0;z-index:2}
.cl-head .bd{position:relative;display:inline-block;margin-top:8px;padding:4px 10px 4px 32px;border-radius:999px;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;font:800 12px var(--sans);box-shadow:0 8px 18px -10px rgba(245,217,122,.9)}
.cl-confetti{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:hidden;opacity:.55}
.cl-confetti i{position:absolute;top:-10px;width:6px;height:9px;border-radius:2px;animation:clFall linear infinite}
@keyframes clFall{to{transform:translateY(240px) rotate(540deg)}}
.cl-hat{position:absolute;width:34px;height:40px;z-index:4;pointer-events:none;filter:drop-shadow(0 4px 6px rgba(0,0,0,.45));transform-origin:50% 92%;animation:clHatIn .7s 1s cubic-bezier(.3,1.6,.5,1) both,clHatWob 3.2s 1.9s ease-in-out infinite}
.cl-hat .pom{transform-origin:22px 6px;animation:clPom 3.2s 1.9s ease-in-out infinite}
.cl-hat .tw{transform-box:fill-box;transform-origin:center;animation:clTw 1.8s ease-in-out infinite}
.cl-hat .tw.b{animation-delay:.9s}
@keyframes clHatIn{from{transform:translateY(-46px) rotate(-40deg);opacity:0}}
@keyframes clHatWob{0%,100%{transform:rotate(14deg)}50%{transform:rotate(22deg)}}
@keyframes clPom{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
@keyframes clTw{0%,100%{opacity:.2;transform:scale(.6)}50%{opacity:1;transform:scale(1.15)}}
.wcf-lineup-chip .cl-hat{top:-20px;left:50%;margin-left:-2px}
.wcf-lineup-token .cl-hat{top:-24px;left:50%;margin-left:-4px;width:30px;height:35px}
.wcf-lineup-token.bday{overflow:visible}
.cl-hat.tag{width:22px;height:26px;left:5px;top:-9px;animation:clHatWob 3.2s 1s ease-in-out infinite}
.cl-admin{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-4px 0 14px;padding:11px 12px 11px 14px;border-radius:16px;border:1px dashed rgba(245,217,122,.45);background:rgba(245,217,122,.05)}
.cl-admin .lbl{flex:1;min-width:150px}
.cl-admin small{display:block;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#f5d97a}
.cl-admin b{display:block;font:700 12.5px var(--sans);color:#e2e8f0}
.cl-admin .btns{display:flex;gap:6px;flex-wrap:wrap}
.cl-admin button{height:32px;padding:0 11px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#fff;font:700 12px var(--sans);cursor:pointer;white-space:nowrap}
.cl-admin button.split{border-color:rgba(245,217,122,.55);color:#f5d97a}
.cl-admin button.go{border:0;background:linear-gradient(180deg,#fff3c4,#f5d97a);color:#1a1405;box-shadow:0 8px 18px -10px rgba(245,217,122,.9)}
.cl-admin button.danger{color:#fca5a5;border-color:rgba(248,113,113,.35)}
.cl-card{position:relative;border-radius:22px;overflow:hidden;margin:0 0 14px;padding-bottom:12px;background:#0f1424;border:1px solid rgba(245,217,122,.22);box-shadow:0 22px 44px -28px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.05)}
.cl-ch{display:flex;align-items:center;gap:10px;padding:16px 16px 10px}
.cl-ch h4{margin:0;font:700 22px/1 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.04em;color:#fff}
.cl-ch span{margin-left:auto;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#94a3b8}
.cl-rule{height:1px;margin:0 16px 12px;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,.12) 70%,transparent)}
.cl-card .wcf-lineup-group{margin:0;padding:0 12px;background:none;border:0}
.cl-card .wcf-lineup-group-label,.cl-card .wcf-lineup-group-note{display:none}
.cl-note{margin:10px 16px 0;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);font:600 12px var(--sans);color:#cbd5e1}
.cl-note b{color:#f5d97a}
.cl-league{display:flex;align-items:center;gap:12px;width:100%;margin:4px 0 16px;padding:13px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);color:#fff;text-align:left;cursor:pointer}
.cl-league span{flex:1}
.cl-league small{display:block;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#94a3b8}
.cl-league b{display:block;margin-top:2px;font:700 13px var(--sans);color:#e2e8f0}
.cl-league em{font-style:normal;color:#f5d97a;font-weight:800}
.cl-sh{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:12px 14px;border-radius:16px;background:linear-gradient(90deg,rgba(245,217,122,.14),rgba(245,217,122,.03));border:1px solid rgba(245,217,122,.4);animation:clUp .35s ease both}
.cl-sh span{flex:1;min-width:0}
.cl-sh small{display:block;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#f5d97a}
.cl-sh b{display:block;font:800 15px var(--display);color:#fff}
.cl-sh button{width:34px;height:34px;flex:none;border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.3);color:#fff;font:800 14px var(--sans);cursor:pointer}
.cl-sheet{animation:clUp .45s cubic-bezier(.2,.9,.3,1) both}
@keyframes clUp{from{opacity:0;transform:translateY(40px)}}
@media (prefers-reduced-motion: reduce){.cl-hat,.cl-hat *,.cl-confetti,.cl-head i.live::before,.cl-sh,.cl-sheet{animation:none!important}}
`;
