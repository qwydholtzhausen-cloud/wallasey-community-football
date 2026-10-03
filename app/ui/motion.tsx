import { useEffect, useState } from "react";

export function CountUp({ to, delay, decimals = 0, run }: { to: number; delay: number; decimals?: number; run: boolean }) {
  const [v, setV] = useState(run ? 0 : to);
  useEffect(() => {
    if (!run) {
      setV(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + delay;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / 650));
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, delay, run]);
  return <>{v.toFixed(decimals)}</>;
}

// The Man of the Match medal (red and white ribbon, gold medal), used for
// the drop on your vote and the winner's own moment.
export function MotmMedal({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 56 120">
        <path d="M18 0 L28 70 L38 0" fill="none" stroke="#E42A36" strokeWidth="9" />
        <path d="M23 0 L28 40 M33 0 L28 40" stroke="#f5f6f8" strokeWidth="3" />
        <circle cx="28" cy="90" r="20" fill="#d4a93c" />
        <circle cx="28" cy="90" r="20" fill="none" stroke="#f5d97a" strokeWidth="2" />
        <circle cx="28" cy="90" r="14.5" fill="none" stroke="#a57f22" strokeWidth="1.2" />
        <path d="M28 80.5l2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-2.9-5.6 2.9 1-6.2-4.5-4.4 6.3-.9z" fill="#fff4cc" />
      </svg>
    </span>
  );
}

// "And Man of the Match is…": the first time you see a game's result
// (within a week of voting closing), the card holds on a drumroll, then
// flips the winner in. Once per game per phone; tap skips it; Reduce
// Motion goes straight to the result.
export type MotmRevealPhase = "drum" | "reveal" | "done";

export function MotmReveal({ storageKey, eligible, children }: { storageKey: string; eligible: boolean; children: (phase: MotmRevealPhase, skip: () => void, replay: (() => void) | null) => React.ReactNode }) {
  const [canPlay] = useState(() => eligible && typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [phase, setPhase] = useState<MotmRevealPhase>(() => {
    if (!canPlay) return "done";
    try {
      return localStorage.getItem(storageKey) ? "done" : "drum";
    } catch {
      return "done";
    }
  });
  useEffect(() => {
    if (phase !== "drum") return;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
    const t = setTimeout(() => setPhase("reveal"), 1300);
    return () => clearTimeout(t);
  }, [phase, storageKey]);
  // "Watch again": same reveal, on demand, while the result's still recent.
  return <>{children(phase, () => setPhase("done"), canPlay ? () => setPhase("drum") : null)}</>;
}

// The points on a result: the first time you see them (within a week), a
// big +N bursts over the screen and drops into the pill.
export function PointsPill({ pts, storageKey, recent }: { pts: number; storageKey: string; recent: boolean }) {
  const [phase, setPhase] = useState<"big" | "pill" | "done">(() => {
    if (!recent || typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "done";
    try {
      return localStorage.getItem(storageKey) ? "done" : "big";
    } catch {
      return "done";
    }
  });
  useEffect(() => {
    if (phase !== "big") return;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
    const a = setTimeout(() => setPhase("pill"), 1700);
    const b = setTimeout(() => setPhase("done"), 2600);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [phase, storageKey]);
  const cls = "wcf-predict-pts " + (pts === 3 ? "exact" : pts === 1 ? "partial" : "zero");
  return (
    <>
      {phase === "big" && (
        <div className="wcf-moment dim" onClick={() => setPhase("pill")}>
          {pts === 3 && <div className="wcf-pts-burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 26}deg` }} />)}</div>}
          <div className={"wcf-bigpts" + (pts ? "" : " zero")}>+{pts}</div>
          <div className="wcf-moment-h" style={{ marginTop: 4 }}>{pts === 3 ? "Exact score" : pts === 1 ? "Right result" : "Not this time"}</div>
        </div>
      )}
      <span className={cls + (phase === "pill" ? " wcf-pts-pop" : "")} style={phase === "big" ? { opacity: 0 } : undefined}>
        +{pts} pt{pts === 1 ? "" : "s"}
      </span>
    </>
  );
}

// The pot: the total with a jar beside it. After a game's payments land,
// the first look rolls the total up from where it was, drops a coin in per
// payer and raises the level. First look on a phone just records.
export function PotAmountJar({ total, money, last, storageKey }: { total: number; money: (n: number) => string; last: { id: string; amount: number; paid?: number } | undefined; storageKey: string }) {
  const cap = Math.max(500, Math.ceil(Math.max(total, 1) / 500) * 500);
  const level = (v: number) => Math.max(0.06, Math.min(1, v / cap));
  const [shown, setShown] = useState(total);
  const [fill, setFill] = useState(level(total));
  const [coins, setCoins] = useState<number[]>([]);
  useEffect(() => {
    if (!last) return;
    let prev: string | null = null;
    try {
      prev = localStorage.getItem(storageKey);
      localStorage.setItem(storageKey, last.id);
    } catch {
      return;
    }
    if (!prev || prev === last.id || last.amount <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = total - last.amount;
    setShown(from);
    setFill(level(from));
    const n = Math.min(16, Math.max(1, last.paid ?? 8));
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < n; i++) timers.push(setTimeout(() => setCoins((c) => [...c, i]), 400 + i * 120));
    timers.push(setTimeout(() => setFill(level(total)), 800));
    const steps = 24;
    for (let k = 1; k <= steps; k++) timers.push(setTimeout(() => setShown(Math.round(from + ((total - from) * k) / steps)), 500 + k * 55));
    timers.push(setTimeout(() => setCoins([]), 600 + n * 120 + 700));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);
  const y = 96 - fill * 82;
  return (
    <>
      <div className={"wcf-pot-hero-amt" + (total < 0 ? " negative" : "")}>{money(shown)}</div>
      <div className="wcf-pot-jar" aria-hidden="true">
        <svg viewBox="0 0 80 100">
          <defs><clipPath id="wcfJarClip"><path d="M14 22 Q14 14 22 14 L58 14 Q66 14 66 22 L66 88 Q66 96 58 96 L22 96 Q14 96 14 88 Z" /></clipPath></defs>
          <g clipPath="url(#wcfJarClip)">
            <g className="wcf-pot-jar-fill" style={{ transform: `translateY(${y}px)` }}>
              <rect x="0" y="0" width="80" height="110" fill="rgba(34,197,94,.55)" />
              <path d="M0 0 Q10 -4 20 0 T40 0 T60 0 T80 0 V6 H0Z" fill="rgba(74,222,128,.75)" />
            </g>
          </g>
          <path d="M14 22 Q14 14 22 14 L58 14 Q66 14 66 22 L66 88 Q66 96 58 96 L22 96 Q14 96 14 88 Z" fill="none" stroke="rgba(226,232,240,.55)" strokeWidth="2.5" />
          <rect x="20" y="6" width="40" height="9" rx="3" fill="#334155" stroke="rgba(226,232,240,.45)" strokeWidth="1.5" />
        </svg>
        {coins.map((i) => <i key={i} className="wcf-pot-coin" style={{ ["--dx" as string]: `${((i * 37) % 40) - 20}px` }} />)}
      </div>
    </>
  );
}
