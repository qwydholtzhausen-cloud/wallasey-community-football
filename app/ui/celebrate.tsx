import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motionAllowed } from "./shared";

// ── Your side won ──
// The first open after a win: a card in the Player of the Month family
// over the real screen. A light sweep in your team's colour, the result
// stamping down, the score counting in, confetti, then your night.
// Goes through the moment queue as a big moment; the rate-the-match
// sheet waits until it's closed.
export function WinMoment({
  teamName,
  teamColor,
  otherName,
  us,
  them,
  dateLabel,
  lines,
  onOpen,
  onDone,
}: {
  teamName: string;
  teamColor: string;
  otherName: string;
  us: number;
  them: number;
  dateLabel: string;
  lines: { label: string; value: string }[];
  onOpen: () => void;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const t0 = performance.now() + 750;
    let raf = 0;
    const tick = (n: number) => {
      const p = Math.max(0, Math.min(1, (n - t0) / 900));
      const e = 1 - Math.pow(1 - p, 3);
      setA(Math.round(us * e));
      setB(Math.round(them * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const stopConfetti = fireConfetti(canvas.current, [teamColor, "#f5d97a", "#ffffff", "#f5d97a"], 550);
    return () => {
      cancelAnimationFrame(raf);
      stopConfetti();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = (then?: () => void) => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      onDone();
      then?.();
    }, 380);
  };
  return (
    <div className={"wcf-win" + (leaving ? " out" : "")} style={{ ["--team" as string]: teamColor }}>
      <div className="wcf-win-dim" onClick={() => close()} />
      <canvas ref={canvas} className="wcf-win-cf" aria-hidden="true" />
      <div className="wcf-win-card" role="dialog" aria-label={`${teamName} win ${us}–${them}`}>
        <div className="wcf-win-sweep" aria-hidden="true" />
        <div className="wcf-win-k">{dateLabel} · FULL TIME</div>
        <div className="wcf-win-h">
          {teamName.toUpperCase()}
          <br />
          WIN
        </div>
        <div className="wcf-win-sc" aria-hidden="true">
          <span>
            <b>{a}</b>
            <small>{teamName.toUpperCase()}</small>
          </span>
          <span className="dash">–</span>
          <span>
            <b>{b}</b>
            <small>{otherName.toUpperCase()}</small>
          </span>
        </div>
        {lines.length > 0 && (
          <div className="wcf-win-night">
            {lines.map((l) => (
              <span key={l.label}>
                {l.label} <b>{l.value}</b>
              </span>
            ))}
          </div>
        )}
        <div className="wcf-win-cta">
          <button className="go" onClick={() => close(onOpen)}>
            See the result
          </button>
          <button className="no" onClick={() => close()}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

// Confetti burst from the middle of a full-screen canvas, fading out over
// ~3.4s. Returns a cancel function for the effect cleanup.
export function fireConfetti(c: HTMLCanvasElement | null, colors: string[], delay = 0, ms = 3400) {
  let raf = 0;
  const start = setTimeout(() => {
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !motionAllowed()) return;
    const W = (c.width = c.offsetWidth * 2);
    const H = (c.height = c.offsetHeight * 2);
    const ps = Array.from({ length: 150 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3,
      y: H * 0.42,
      vx: (Math.random() - 0.5) * 28,
      vy: -Math.random() * 32 - 8,
      r: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.4,
      w: 8 + Math.random() * 10,
      h: 5 + Math.random() * 6,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const s0 = performance.now();
    const f = (n: number) => {
      const age = n - s0;
      ctx.clearRect(0, 0, W, H);
      for (const p of ps) {
        p.vy += 0.9;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age / ms);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        ctx.restore();
      }
      if (age < ms) raf = requestAnimationFrame(f);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(f);
  }, delay);
  return () => {
    clearTimeout(start);
    cancelAnimationFrame(raf);
  };
}

// ── Your season, mowed into a pitch ──
// Under the record card on Account: one stripe per game you've played
// this season, coloured by the result (a Man of the Match game in gold).
// Mows in once each time it comes into view; your goals drop into the net.
export type SeasonGame = { id: string; r: "W" | "D" | "L"; goals: number; motm: boolean };
const STRIPE = { W: "#3fae5a", D: "#2f6e45", L: "#173826" };
export function SeasonPitch({ year, games }: { year: string; games: SeasonGame[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!motionAllowed()) {
      setShown(games.length);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const io = new IntersectionObserver(
      (es) => {
        if (!es[0].isIntersecting) return;
        io.disconnect();
        const step = Math.max(90, Math.min(330, 3600 / games.length));
        timer = setInterval(() => setShown((n) => (n >= games.length ? (clearInterval(timer), n) : n + 1)), step);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games.length]);
  const n = games.length;
  const W = 300;
  const H = 180;
  const sw = W / n;
  const goals = games.reduce((s, g) => s + g.goals, 0);
  const motms = games.filter((g) => g.motm).length;
  const won = games.filter((g) => g.r === "W").length;
  const drawn = games.filter((g) => g.r === "D").length;
  const lost = n - won - drawn;
  const done = shown >= n;
  const balls = Math.min(goals, 9);
  return (
    <div className="wcf-me wcf-season-pitch" ref={ref}>
      <div className="wcf-szn-k">
        SEASON {year} · {n} {n === 1 ? "GAME" : "GAMES"}
      </div>
      <div className="wcf-szn-t">Your season, mowed in</div>
      <div className="wcf-szn-pitch">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`A pitch striped by your ${n} results: ${won} won, ${drawn} drawn, ${lost} lost`}>
          <rect width={W} height={H} fill="#0f2418" />
          {games.map((g, i) => (
            <rect
              key={g.id}
              className={"wcf-szn-stripe" + (i < shown ? " on" : "")}
              x={(i * sw).toFixed(2)}
              y="0"
              width={(sw + 0.5).toFixed(2)}
              height={H}
              fill={g.motm ? "#d4a93c" : STRIPE[g.r]}
            />
          ))}
          <g fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.6">
            <rect x="6" y="6" width={W - 12} height={H - 12} />
            <line x1={W / 2} y1="6" x2={W / 2} y2={H - 6} />
            <circle cx={W / 2} cy={H / 2} r="24" />
            <rect x="6" y={H / 2 - 40} width="40" height="80" />
            <rect x={W - 46} y={H / 2 - 40} width="40" height="80" />
            <rect x="6" y={H / 2 - 18} width="14" height="36" />
            <rect x={W - 20} y={H / 2 - 18} width="14" height="36" />
          </g>
          <circle cx={W / 2} cy={H / 2} r="2.5" fill="#fff" />
          <g className="wcf-szn-net" stroke="rgba(255,255,255,.35)" strokeWidth=".6">
            {Array.from({ length: 6 }, (_, i) => (
              <line key={"h" + i} x1={W - 6} y1={H / 2 - 18 + i * 7.2} x2={W} y2={H / 2 - 18 + i * 7.2} />
            ))}
          </g>
          {done &&
            Array.from({ length: balls }, (_, i) => (
              <circle
                key={i}
                className="wcf-szn-ball"
                style={{ animationDelay: `${i * 0.12}s` }}
                cx={W - 13 + (i % 2) * 6 - 3}
                cy={H / 2 - 13 + Math.floor(i / 2) * 6}
                r="2.6"
                fill="#fff"
                stroke="#0d0d1a"
                strokeWidth=".8"
              />
            ))}
          {shown < n && (
            <g className="wcf-szn-mower" style={{ transform: `translateX(${(shown + 0.5) * sw}px)` }}>
              <rect x="-7" y={H - 22} width="14" height="16" rx="3" fill="#e63946" />
              <rect x="-4" y={H - 30} width="8" height="9" rx="2" fill="#f5d97a" />
            </g>
          )}
        </svg>
      </div>
      <div className="wcf-szn-legend">
        <span>
          <i style={{ background: STRIPE.W }} />
          {won} won
        </span>
        <span>
          <i style={{ background: STRIPE.D }} />
          {drawn} drawn
        </span>
        <span>
          <i style={{ background: STRIPE.L }} />
          {lost} lost
        </span>
        {motms > 0 && (
          <span>
            <i style={{ background: "#d4a93c" }} />
            {motms} MOTM
          </span>
        )}
        <span>
          {goals > 0 ? `${goals} ${goals === 1 ? "goal" : "goals"} in the net${goals > balls ? ` (${balls} shown)` : ""}` : "No goals yet this season"}
        </span>
      </div>
    </div>
  );
}

// ── Birthday bunting ──
// On the team sheet of a game that's someone's free birthday game:
// bunting across the header and a tag naming them.
export function BirthdayBunting() {
  const cols = ["#e63946", "#F5F6F8", "#2E74CC", "#f5d97a"];
  const N = 13;
  const Wd = 320;
  return (
    <>
      <div className="wcf-bunting" aria-hidden="true">
        <svg viewBox={`0 0 ${Wd} 64`} preserveAspectRatio="none">
          <path d={`M0 6 Q${Wd / 2} 34 ${Wd} 6`} fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.2" />
          {Array.from({ length: N }, (_, i) => {
            const x = 8 + (i * (Wd - 16)) / (N - 1);
            const y = 10 + 14 * Math.sin(Math.PI * (i / (N - 1))) * 0.9;
            return (
              <path
                key={i}
                className="wcf-flag"
                style={{ ["--d" as string]: `${i * 60}ms` }}
                d={`M${x - 9} ${y} L${x + 9} ${y} L${x} ${y + 22} Z`}
                fill={cols[i % 4]}
              />
            );
          })}
        </svg>
      </div>
    </>
  );
}

export function BirthdayTag({ names, avatarUrl }: { names: string[]; avatarUrl: string | null }) {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  return (
    <>
      <div className="wcf-bday-tag">
        {avatarUrl && names.length === 1 && <img src={avatarUrl} alt="" />}
        <span aria-hidden="true">🎂</span> {who === "You" ? "Your birthday game" : `${who}'s birthday game`}
      </div>
    </>
  );
}

export function PartyHat() {
  return (
    <svg className="wcf-bday-hat" viewBox="0 0 26 30" aria-hidden="true">
      <path d="M13 2 L24 28 L2 28 Z" fill="#e63946" />
      <path d="M8 15 L18 15 M5 22 L21 22" stroke="#f5d97a" strokeWidth="2.4" />
      <circle cx="13" cy="3" r="3.2" fill="#f5d97a" />
    </svg>
  );
}

// ── The MOTM medal on the ballot ──
// Hangs on your pick. Voting drops it in on its ribbon (the disc spins
// as it swings to rest) and sends a ballot slip up to the count;
// changing your vote lifts it off and swings it across to the new pick.
const medalAt = new Map<string, { x: number; y: number }>();
const medalPlayed = new Map<string, number>();
export function VoteMedal({ gameId, anim }: { gameId: string; anim: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.closest(".wcf-vote");
    if (!el || !box) return;
    const br = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pos = { x: r.left - br.left, y: r.top - br.top };
    const prev = medalAt.get(gameId);
    medalAt.set(gameId, pos);
    if (!anim || (medalPlayed.get(gameId) ?? 0) >= anim || !motionAllowed()) return;
    medalPlayed.set(gameId, anim);
    if (prev && (prev.x !== pos.x || prev.y !== pos.y)) {
      const dx = prev.x - pos.x;
      const dy = prev.y - pos.y;
      el.animate(
        [
          { transform: `translate(${dx}px,${dy}px)` },
          { transform: `translate(${dx / 2}px,${dy / 2 - 70}px) rotate(-18deg) scale(1.15)`, offset: 0.45 },
          { transform: "rotate(16deg)", offset: 0.75 },
          { transform: "rotate(-7deg)", offset: 0.88 },
          { transform: "none" },
        ],
        { duration: 1300, easing: "cubic-bezier(.5,0,.3,1)" },
      );
      return;
    }
    el.classList.add("drop");
    // The ballot slip flies from your pick up to the count.
    const meta = box.querySelector(".wcf-vote-count");
    const chip = el.closest(".wcf-vote-pick");
    if (!meta || !chip) return;
    const cr = chip.getBoundingClientRect();
    const mr = meta.getBoundingClientRect();
    const slip = document.createElement("i");
    slip.className = "wcf-vote-slip";
    slip.style.left = `${cr.left - br.left + 20}px`;
    slip.style.top = `${cr.top - br.top + 10}px`;
    box.appendChild(slip);
    const tx = mr.left - cr.left - 20;
    const ty = mr.top - cr.top - 10;
    slip
      .animate(
        [
          { transform: "none", opacity: 1 },
          { transform: `translate(${tx / 2}px,${ty / 2 - 50}px) rotate(-200deg)`, offset: 0.5 },
          { transform: `translate(${tx}px,${ty}px) rotate(-380deg) scale(.4)`, opacity: 0.2 },
        ],
        { duration: 900, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
      )
      .finished.then(() => slip.remove(), () => slip.remove());
  }, [anim, gameId]);
  return (
    <span ref={ref} className="wcf-vote-medal2" aria-hidden="true">
      <svg viewBox="0 0 34 74">
        <defs>
          <radialGradient id="wcfMedalGold" cx=".35" cy=".3" r=".8">
            <stop offset="0" stopColor="#fff6c9" />
            <stop offset=".45" stopColor="#f5d97a" />
            <stop offset="1" stopColor="#a87a14" />
          </radialGradient>
        </defs>
        <path d="M5 0 L15 0 L20 44 L12 44 Z" fill="#e63946" />
        <path d="M8 0 L11 0 L16 44 L14 44 Z" fill="#fff" opacity=".85" />
        <path d="M29 0 L19 0 L14 44 L22 44 Z" fill="#c62a37" />
        <path d="M26 0 L23 0 L18 44 L20 44 Z" fill="#fff" opacity=".7" />
        <g className="disc">
          <circle cx="17" cy="57" r="15" fill="url(#wcfMedalGold)" stroke="#7a5408" strokeWidth="1" />
          <circle cx="17" cy="57" r="11" fill="none" stroke="#a87a14" strokeWidth="1.2" opacity=".8" />
          <path d="M17 49.5 l2.3 4.7 5.2.7 -3.8 3.6 .9 5.1 -4.6-2.4 -4.6 2.4 .9-5.1 -3.8-3.6 5.2-.7z" fill="#7a5408" />
        </g>
      </svg>
    </span>
  );
}
