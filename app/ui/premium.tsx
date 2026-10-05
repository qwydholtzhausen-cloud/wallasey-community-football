import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Avatar, avatarFor, motionAllowed } from "./shared";
import { fireConfetti } from "./celebrate";

// The big once-only moments, all in one family: a framed card over a real
// photo with a gold edge, a light sweep in the team's colour and a sheen
// (the same look as the "Reds win" card). Each still goes through the
// app's moment queue; Reduce Motion gets the finished card with no motion.

const GOLD = ["#f5d97a", "#fff6c9", "#e2b84a", "#ffffff"];

function useLeave(onDone: () => void) {
  const [leaving, setLeaving] = useState(false);
  const close = (then?: () => void) => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      onDone();
      then?.();
    }, 360);
  };
  return [leaving, close] as const;
}

function MomentCard({
  photo,
  team = "#f5d97a",
  confetti,
  label,
  sheen = 1.1,
  cta = 1.8,
  leaving,
  onBackdrop,
  className = "",
  children,
}: {
  photo: string;
  team?: string;
  confetti?: { colors: string[]; at: number };
  label: string;
  sheen?: number;
  cta?: number;
  leaving: boolean;
  onBackdrop: () => void;
  className?: string;
  children: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => (confetti ? fireConfetti(canvas.current, confetti.colors, confetti.at) : undefined), []); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = { "--team": team, "--sheen": `${sheen}s`, "--cta": `${cta}s` } as CSSProperties;
  return (
    <div className={"wcf-mc-layer" + (leaving ? " out" : "")} style={vars}>
      <div className="wcf-mc-dim" onClick={onBackdrop} />
      <canvas ref={canvas} className="wcf-mc-cf" aria-hidden="true" />
      <div className={"wcf-mc " + className} role="dialog" aria-label={label} style={{ ["--photo" as string]: `url('${photo}')` }}>
        <div className="wcf-mc-sweep" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

function Ring({ name, avatarUrl, size = 96 }: { name: string; avatarUrl: string | null | undefined; size?: number }) {
  return (
    <div className="wcf-mc-ring" style={{ width: size, height: size }}>
      <Avatar name={name} avatarUrl={avatarUrl} className="wcf-mc-ring-av" background={avatarFor(name).gradient} />
    </div>
  );
}

export function Ball({ delay }: { delay: number }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={{ animationDelay: `${delay}s` }}>
      <circle cx="12" cy="12" r="10.3" fill="#f5f6f8" stroke="#0d0d1a" strokeWidth="1.4" />
      <path d="M12 8.2 15.6 10.8 14.2 15 9.8 15 8.4 10.8Z" fill="#0d0d1a" />
      <g stroke="#0d0d1a" strokeWidth="1.2">
        <line x1="12" y1="8.2" x2="12" y2="1.8" />
        <line x1="15.6" y1="10.8" x2="21.6" y2="8.8" />
        <line x1="14.2" y1="15" x2="17.9" y2="20.2" />
        <line x1="9.8" y1="15" x2="6.1" y2="20.2" />
        <line x1="8.4" y1="10.8" x2="2.4" y2="8.8" />
      </g>
    </svg>
  );
}

function Medal() {
  return (
    <svg viewBox="0 0 34 74" aria-hidden="true">
      <defs>
        <radialGradient id="wcfMcGold" cx=".35" cy=".3" r=".8">
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
        <circle cx="17" cy="57" r="15" fill="url(#wcfMcGold)" stroke="#7a5408" strokeWidth="1" />
        <circle cx="17" cy="57" r="11" fill="none" stroke="#a87a14" strokeWidth="1.2" opacity=".8" />
        <path d="M17 49.5 l2.3 4.7 5.2.7 -3.8 3.6 .9 5.1 -4.6-2.4 -4.6 2.4 .9-5.1 -3.8-3.6 5.2-.7z" fill="#7a5408" />
      </g>
    </svg>
  );
}

function Trophy({ plate, className }: { plate: string; className: string }) {
  return (
    <svg className={className} viewBox="0 0 120 136" aria-hidden="true">
      <defs>
        <linearGradient id="wcfTrG" x1="0" x2="1">
          <stop offset="0" stopColor="#7a5408" />
          <stop offset=".25" stopColor="#f5d97a" />
          <stop offset=".45" stopColor="#fff6c9" />
          <stop offset=".6" stopColor="#e2b84a" />
          <stop offset="1" stopColor="#6b4a06" />
        </linearGradient>
        <linearGradient id="wcfTrB" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2a2d4a" />
          <stop offset="1" stopColor="#0e1020" />
        </linearGradient>
        <clipPath id="wcfTrClip">
          <path d="M30 10h60v26c0 19-13 34-30 34S30 55 30 36z" />
        </clipPath>
      </defs>
      <path d="M30 18H14c0 17 9 28 21 30M90 18h16c0 17-9 28-21 30" fill="none" stroke="url(#wcfTrG)" strokeWidth="6" strokeLinecap="round" />
      <path d="M30 10h60v26c0 19-13 34-30 34S30 55 30 36z" fill="url(#wcfTrG)" />
      <ellipse cx="60" cy="10" rx="30" ry="4" fill="#fff6c9" opacity=".7" />
      <rect className="shine" x="0" y="0" width="22" height="80" fill="rgba(255,255,255,.55)" transform="skewX(-20)" clipPath="url(#wcfTrClip)" />
      <path d="M54 70h12v16H54z" fill="url(#wcfTrG)" />
      <path d="M42 86h36l5 12H37z" fill="url(#wcfTrG)" />
      <rect x="32" y="98" width="56" height="26" rx="3" fill="url(#wcfTrB)" stroke="#f5d97a" strokeWidth="1.2" />
      <text x="60" y="115" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="8.5" letterSpacing="1.5" fill="#f5d97a">
        {plate}
      </text>
    </svg>
  );
}

// ── "You're Man of the Match" ──
export function MotmWinCard({
  kicker,
  votes,
  total,
  goals,
  joint,
  name,
  avatarUrl,
  onSee,
  onClose,
}: {
  kicker: string;
  votes: number;
  total: number;
  goals: number;
  joint: boolean;
  name: string;
  avatarUrl: string | null | undefined;
  onSee: () => void;
  onClose: () => void;
}) {
  const [leaving, close] = useLeave(onClose);
  const pips = Math.min(Math.max(total, 1), 20);
  const target = Math.round((votes / Math.max(total, 1)) * pips);
  const [n, setN] = useState(motionAllowed() ? 0 : votes);
  useEffect(() => {
    if (!motionAllowed()) return;
    const timers = Array.from({ length: votes }, (_, i) => setTimeout(() => setN(i + 1), 1800 + i * Math.min(170, 900 / votes)));
    return () => timers.forEach(clearTimeout);
  }, [votes]);
  const lit = Math.round((n / Math.max(votes, 1)) * target);
  return (
    <MomentCard
      photo="/celebration.jpg"
      label={joint ? "You're joint Man of the Match" : "You're Man of the Match"}
      confetti={{ colors: GOLD, at: 1500 }}
      sheen={2.4}
      cta={3}
      leaving={leaving}
      onBackdrop={() => close()}
    >
      <div className="wcf-mc-k">{kicker}</div>
      <div className="wcf-mc-medal">
        <Medal />
      </div>
      <div className="wcf-mc-motm">
        <Ring name={name} avatarUrl={avatarUrl} />
        <div className="wcf-mc-h stamp">{joint ? "You're joint Man of the Match" : "You're Man of the Match"}</div>
      </div>
      <div className="wcf-mc-pips" aria-hidden="true">
        {Array.from({ length: pips }, (_, i) => (
          <i key={i} className={i < lit ? "on" : ""} />
        ))}
      </div>
      <div className="wcf-mc-votes">
        <b key={n}>{n}</b>of {total} votes from your teammates
      </div>
      {goals > 0 && (
        <div className="wcf-mc-goals">
          {Array.from({ length: Math.min(goals, 9) }, (_, i) => (
            <Ball key={i} delay={2.2 + i * 0.1} />
          ))}
          <span>
            {goals} {goals === 1 ? "goal" : "goals"} on the night
          </span>
        </div>
      )}
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close(onSee)}>
          See the votes
        </button>
        <button className="no" onClick={() => close()}>
          Close
        </button>
      </div>
    </MomentCard>
  );
}

// ── Player of the Month night (everyone) ──
// The calendar page tears, a gold trophy rises in front of slow light
// rays, then the winner's photo and name with their numbers. Tap to skip;
// it then lands on the Player of the Month card on Results.
export function PotmNight({
  prevMonth,
  month,
  plate,
  winners,
  onDone,
}: {
  prevMonth: string;
  month: string;
  plate: string;
  winners: { name: string; avatarUrl: string | null | undefined; wins: number; votes: number; goals: number }[];
  onDone: () => void;
}) {
  const [leaving, close] = useLeave(onDone);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const stop = fireConfetti(canvas.current, GOLD, 2500, 3000);
    const t = setTimeout(() => close(), 5600);
    return () => {
      stop();
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const one = winners.length === 1 ? winners[0] : null;
  return (
    <div className={"wcf-potm-night" + (leaving ? " out" : "")} onClick={() => close()} role="dialog" aria-label={`Player of the Month: ${winners.map((w) => w.name).join(" and ")}`}>
      <div className="rays" aria-hidden="true" />
      <div className="wcf-mc-k">PLAYER OF THE MONTH</div>
      <div className="tear" aria-hidden="true">
        <div className="new">{month.toUpperCase()}</div>
        <div className="old">{prevMonth.toUpperCase()}</div>
      </div>
      <Trophy className="trophy" plate={plate} />
      <div className="who">
        {winners.slice(0, 2).map((w) => (
          <Ring key={w.name} name={w.name} avatarUrl={w.avatarUrl} size={64} />
        ))}
        <div className="name">{winners.map((w) => w.name.split(" ")[0]).join(" & ")}</div>
      </div>
      {one ? (
        <div className="chips">
          <span style={{ animationDelay: "2.9s" }}>
            {one.wins} MOTM {one.wins === 1 ? "win" : "wins"}
          </span>
          <span style={{ animationDelay: "3.05s" }}>
            {one.votes} {one.votes === 1 ? "vote" : "votes"}
          </span>
          <span style={{ animationDelay: "3.2s" }}>
            {one.goals} {one.goals === 1 ? "goal" : "goals"}
          </span>
        </div>
      ) : (
        <div className="chips">
          <span style={{ animationDelay: "2.9s" }}>Joint winners</span>
        </div>
      )}
      <canvas ref={canvas} className="wcf-mc-cf" aria-hidden="true" />
    </div>
  );
}

// ── "You're Player of the Month" (the winner) ──
export function PotmMine({
  monthLabel,
  plate,
  joint,
  wins,
  votes,
  name,
  avatarUrl,
  onDone,
}: {
  monthLabel: string;
  plate: string;
  joint: boolean;
  wins: number;
  votes: number;
  name: string;
  avatarUrl: string | null | undefined;
  onDone: () => void;
}) {
  const [leaving, close] = useLeave(onDone);
  return (
    <MomentCard
      photo="/pitch-floodlit.jpg"
      label={joint ? "You're joint Player of the Month" : "You're Player of the Month"}
      confetti={{ colors: GOLD, at: 1300 }}
      sheen={2}
      cta={2.4}
      leaving={leaving}
      onBackdrop={() => close()}
      className="center"
    >
      <div className="wcf-mc-k">{monthLabel.toUpperCase()}</div>
      <div className="wcf-mc-potm">
        <Trophy className="trophy" plate={plate} />
        <Ring name={name} avatarUrl={avatarUrl} size={84} />
      </div>
      <div className="wcf-mc-h stamp">{joint ? "You're joint Player of the Month" : "You're Player of the Month"}</div>
      <div className="wcf-mc-s rise">
        <b>
          {wins} Man of the Match {wins === 1 ? "win" : "wins"}
        </b>{" "}
        and{" "}
        <b>
          {votes} {votes === 1 ? "vote" : "votes"}
        </b>{" "}
        from the squad.
      </div>
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close()}>
          See your card
        </button>
      </div>
    </MomentCard>
  );
}

// ── New club record ──
// The record book: the old record and its holder get struck out, the new
// number flips in beside your photo and a RECORD stamp lands.
function Flap({ from, to, delay }: { from: number; to: number; delay: number }) {
  return (
    <div className="wcf-pm-flap" style={{ ["--fd" as string]: `${delay}s` }} aria-hidden="true">
      <div className="h">
        <span>{to}</span>
      </div>
      <div className="h b">
        <span>{from}</span>
      </div>
      <div className="fl top">
        <span>{from}</span>
      </div>
      <div className="fl bot">
        <span>{to}</span>
      </div>
    </div>
  );
}
export function RecordCard({
  title,
  value,
  prevValue,
  name,
  avatarUrl,
  dateLabel,
  scoreLine,
  prevWho,
  prevAvatarUrl,
  prevDateLabel,
  balls,
  onDone,
}: {
  title: string;
  value: number;
  prevValue: number;
  name: string;
  avatarUrl: string | null | undefined;
  dateLabel: string;
  scoreLine: string;
  prevWho: string;
  prevAvatarUrl: string | null | undefined;
  prevDateLabel: string;
  balls: boolean;
  onDone: () => void;
}) {
  const [leaving, close] = useLeave(onDone);
  return (
    <MomentCard
      photo="/floodlight-haze.jpg"
      team="#e63946"
      label={`New club record: ${value} ${title}`}
      confetti={{ colors: ["#f5d97a", "#e63946", "#ffffff"], at: 3000 }}
      sheen={3}
      cta={3.2}
      leaving={leaving}
      onBackdrop={() => close()}
    >
      <div className="wcf-rec-stamp" aria-hidden="true">
        RECORD
      </div>
      <div className="wcf-mc-k">NEW CLUB RECORD</div>
      <div className="wcf-mc-h" style={{ fontSize: 25, paddingRight: 64 }}>
        {title}
      </div>
      <div className="wcf-rec-board">
        <div className="l">CLUB RECORD BOOK</div>
        <div className="row new">
          <Flap from={prevValue} to={value} delay={2.7} />
          <Avatar name={name} avatarUrl={avatarUrl} className="face" background={avatarFor(name).gradient} />
          <div className="who">
            You
            <small>
              {dateLabel}
              {scoreLine ? ` · ${scoreLine}` : ""}
            </small>
          </div>
        </div>
        <div className="row old">
          <div className="wcf-pm-flap still" aria-hidden="true">
            <div className="h">
              <span>{prevValue}</span>
            </div>
            <div className="h b">
              <span>{prevValue}</span>
            </div>
          </div>
          <Avatar name={prevWho} avatarUrl={prevAvatarUrl} className="face" background={avatarFor(prevWho).gradient} />
          <div className="who">
            {prevWho}
            {prevDateLabel && <small>{prevDateLabel}</small>}
          </div>
          <i className="strike" />
        </div>
      </div>
      {balls && (
        <div className="wcf-mc-goals">
          {Array.from({ length: Math.min(value, 9) }, (_, i) => (
            <Ball key={i} delay={0.9 + i * 0.12} />
          ))}
        </div>
      )}
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close()}>
          See the record book
        </button>
      </div>
    </MomentCard>
  );
}

// ── Milestones: your Nth game, your debut, the club's milestones ──
function Shirt({ side, back, n }: { side: "front" | "back"; back: string; n: number }) {
  const id = "wcfSh" + side;
  return (
    <div className={"face " + side}>
      <svg viewBox="0 0 170 180" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" x2="1">
            <stop offset="0" stopColor="#c9d2e0" />
            <stop offset=".22" stopColor="#f5f6f8" />
            <stop offset=".55" stopColor="#ffffff" />
            <stop offset=".8" stopColor="#e6ebf3" />
            <stop offset="1" stopColor="#b7c1d1" />
          </linearGradient>
          <linearGradient id={id + "f"} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(0,0,0,0)" />
            <stop offset="1" stopColor="rgba(0,0,0,.12)" />
          </linearGradient>
        </defs>
        <path d="M55 8 L85 18 L115 8 L162 38 L146 72 L130 64 L130 172 L40 172 L40 64 L24 72 L8 38 Z" fill={`url(#${id})`} stroke="#aab4c6" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M55 8 L85 18 L115 8 L162 38 L146 72 L130 64 L130 172 L40 172 L40 64 L24 72 L8 38 Z" fill={`url(#${id}f)`} />
        <path d="M8 38 L24 72 L40 64 M162 38 L146 72 L130 64" fill="none" stroke="#e63946" strokeWidth="5" strokeLinejoin="round" />
        <path d={side === "front" ? "M70 12 Q85 30 100 12" : "M70 12 Q85 22 100 12"} fill="none" stroke="#e63946" strokeWidth="4" />
        {side === "front" ? (
          <>
            <image href="/crest.png" x="96" y="44" width="22" height="22" />
            <text x="85" y="110" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="11" letterSpacing="3" fill="#0d0d1a" opacity=".55">
              WCF
            </text>
          </>
        ) : (
          <>
            <text x="85" y="62" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize={back.length > 9 ? 12 : 15} letterSpacing="2" fill="#0d0d1a">
              {back}
            </text>
            <text x="85" y="140" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize={n >= 100 ? 56 : 72} fill="#0d0d1a">
              {n}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
export function MilestoneShirt({ n, first, back, since, onCard, onDone }: { n: number; first: string; back: string; since: string; onCard: () => void; onDone: () => void }) {
  const [leaving, close] = useLeave(onDone);
  const turn = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"front" | "back">(motionAllowed() ? "front" : "back");
  useEffect(() => {
    const el = turn.current;
    if (!el || !motionAllowed()) return;
    let live = true;
    // Two half-turns with the face swapped edge-on: backface-visibility
    // isn't reliable on every phone, this is.
    (async () => {
      await el.animate([{ transform: "translateY(30px) rotateY(-25deg)", opacity: 0 }, { transform: "rotateY(-8deg)", opacity: 1 }], { duration: 650, delay: 600, easing: "ease-out", fill: "both" }).finished;
      await new Promise((r) => setTimeout(r, 450));
      if (!live) return;
      await el.animate([{ transform: "rotateY(-8deg)" }, { transform: "rotateY(90deg)" }], { duration: 480, easing: "cubic-bezier(.6,0,1,1)", fill: "both" }).finished;
      if (!live) return;
      setSide("back");
      await el.animate([{ transform: "rotateY(-90deg)" }, { transform: "none" }], { duration: 700, easing: "cubic-bezier(0,0,.3,1.15)", fill: "both" }).finished;
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <MomentCard photo="/bench-kit.jpg" team="#e63946" label={`Your ${n}th game`} sheen={3.3} cta={3.3} leaving={leaving} onBackdrop={() => close()}>
      <div className="wcf-mc-badge" aria-hidden="true">
        <div>
          <b>{n}</b>
          <small>APPS</small>
        </div>
      </div>
      <div className="wcf-mc-k">MILESTONE</div>
      <div className="wcf-mc-shirt">
        <div className="turn" ref={turn}>
          <Shirt side={side} back={back} n={n} />
        </div>
        <div className="shine" aria-hidden="true" />
      </div>
      <div className="wcf-mc-h rise" style={{ animationDelay: "2.6s" }}>
        Your {n}th game, {first}
      </div>
      <div className="wcf-mc-s rise" style={{ animationDelay: "2.8s" }}>
        <b>{n} games</b> for the club since {since}. Your badge is on your player card now.
      </div>
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close(onCard)}>
          See your card
        </button>
        <button className="no" onClick={() => close()}>
          Close
        </button>
      </div>
    </MomentCard>
  );
}

export function DebutCard({ first, dateLabel, result, onDone }: { first: string; dateLabel: string; result: string; onDone: () => void }) {
  const [leaving, close] = useLeave(onDone);
  return (
    <MomentCard photo="/lineup-teams.jpg" label={`Welcome to the squad, ${first}`} confetti={{ colors: GOLD, at: 1200 }} cta={2.2} leaving={leaving} onBackdrop={() => close()} className="center">
      <div className="wcf-mc-k">DEBUT · {dateLabel.toUpperCase()}</div>
      <svg className="wcf-mc-cap" viewBox="0 0 150 120" aria-hidden="true">
        <defs>
          <linearGradient id="wcfCapG" x1="0" x2="1">
            <stop offset="0" stopColor="#141c4d" />
            <stop offset=".45" stopColor="#2a3a8f" />
            <stop offset="1" stopColor="#111842" />
          </linearGradient>
        </defs>
        <path d="M20 78 Q20 22 75 20 Q130 22 130 78 Z" fill="url(#wcfCapG)" stroke="#f5d97a" strokeWidth="2" />
        <path d="M75 20 L75 78 M40 30 L55 78 M110 30 L95 78" stroke="#f5d97a" strokeWidth="1.5" opacity=".7" />
        <path d="M12 78 Q75 96 138 78 L138 86 Q75 104 12 86 Z" fill="#14205a" stroke="#f5d97a" strokeWidth="2" />
        <g className="tassel">
          <line x1="75" y1="22" x2="75" y2="8" stroke="#f5d97a" strokeWidth="2" />
          <path d="M70 0 L80 0 L84 12 L66 12 Z" fill="#f5d97a" />
        </g>
        <text x="75" y="64" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="13" fill="#f5d97a">
          {dateLabel.slice(-4)}
        </text>
      </svg>
      <div className="wcf-mc-h stamp">Welcome to the squad, {first}</div>
      <div className="wcf-mc-s rise">
        Your first game: <b>{result}</b>. Good to have you.
      </div>
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close()}>
          Let&apos;s go
        </button>
      </div>
    </MomentCard>
  );
}

export function ClubOdometer({ n, unit, detail, onSeason, onDone }: { n: number; unit: string; detail: string; onSeason: () => void; onDone: () => void }) {
  const [leaving, close] = useLeave(onDone);
  const end = String(n).split("").map(Number);
  const startN = Math.max(0, n - 14);
  const start = String(startN).padStart(end.length, "0").split("").map(Number);
  const [rolled, setRolled] = useState(!motionAllowed());
  useEffect(() => {
    const t = setTimeout(() => setRolled(true), 900);
    return () => clearTimeout(t);
  }, []);
  return (
    <MomentCard
      photo="/pitch-floodlit.jpg"
      label={`Club milestone: ${n} ${unit}`}
      confetti={{ colors: GOLD, at: 2100 }}
      sheen={2.8}
      cta={3}
      leaving={leaving}
      onBackdrop={() => close()}
      className="center"
    >
      <div className="wcf-mc-k">CLUB MILESTONE</div>
      <div className="wcf-odo" aria-hidden="true">
        {end.map((d, i) => {
          // Each reel holds 0-9 three times; the last digit always spins a
          // full turn, the others only move when their digit changes.
          const last = i === end.length - 1;
          const to = d + (d < start[i] || last ? 10 : 0);
          return (
            <div key={i} className="d">
              <div className="reel" style={{ transform: `translateY(-${(rolled ? to : start[i]) * 80}px)`, transition: rolled && motionAllowed() ? undefined : "none" }}>
                {Array.from({ length: 30 }, (_, k) => (
                  <span key={k}>{k % 10}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="wcf-mc-h" style={{ fontSize: 26, marginTop: 14 }}>
        club {unit}
      </div>
      <div className="wcf-mc-s rise" style={{ animationDelay: "2.6s" }}>
        {detail}
      </div>
      <div className="wcf-mc-cta">
        <button className="go" onClick={() => close(onSeason)}>
          See the season
        </button>
        <button className="no" onClick={() => close()}>
          Close
        </button>
      </div>
    </MomentCard>
  );
}
