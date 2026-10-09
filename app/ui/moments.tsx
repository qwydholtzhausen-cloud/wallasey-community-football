import { useEffect, useRef, useState } from "react";

// Big, full-screen moments for things you just did (not the automatic
// once-per-open moments, which go through the app's moment queue).

const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

export type QueueOdds = { got: number; total: number; recent: { date: string; got: boolean }[] };

// ── Take a ticket ──
// Joining a waiting list: an LED "now serving" board, the ticket machine
// prints your place with the number rolling up, and - when there's enough
// history for that place - how often it's got in before, as a form guide
// of the last few. Tap anywhere to skip.
export function QueueTicket({
  pos,
  booked,
  max,
  when,
  odds,
  onDone,
}: {
  pos: number;
  booked: number;
  max: number;
  when: string;
  odds: QueueOdds | null;
  onDone: () => void;
}) {
  const [n, setN] = useState(1);
  const [showOdds, setShowOdds] = useState(false);
  const [shown, setShown] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const close = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    setTimeout(onDone, 650);
  };
  useEffect(() => {
    const t: ReturnType<typeof setTimeout>[] = [];
    for (let i = 2; i <= pos; i++) t.push(setTimeout(() => setN(i), 900 + (i - 2) * 170));
    const settled = 900 + Math.max(0, pos - 1) * 170;
    if (odds) {
      t.push(setTimeout(() => setShowOdds(true), settled + 400));
      odds.recent.forEach((_, i) => t.push(setTimeout(() => setShown(i + 1), settled + 650 + i * 220)));
    }
    t.push(setTimeout(close, settled + (odds ? 3600 : 2200)));
    return () => t.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={"wcf-qt" + (leaving ? " out" : "")} onClick={close} role="dialog" aria-label={`You're ${nth(pos)} on the waiting list`}>
      <div className="wcf-led-board">
        <div className="wcf-led-row">
          <span>NOW SERVING</span>
          <span className="red">FULL {booked}/{max}</span>
        </div>
        <div className="wcf-led-row">
          <span>{when.toUpperCase()}</span>
          <span>WAITING LIST</span>
        </div>
      </div>
      <div className="wcf-qt-machine" aria-hidden="true">
        <div className="dome" />
        <div className="body" />
        <div className="label">TAKE A NUMBER</div>
        <div className="mouth" />
      </div>
      <div className={"wcf-qt-ticket" + (leaving ? " fly" : "")}>
        <div className="k">WAITING LIST</div>
        <div key={n} className="n">{n}</div>
        <div className="s">{n === pos ? `${nth(pos)} in line` : "in line"}</div>
      </div>
      {showOdds && odds && (
        <div className="wcf-qt-odds">
          <div className="t">
            {nth(pos)} in line has got in <b>{odds.got} of {odds.total}</b> times
          </div>
          <div className="wcf-qt-form">
            {odds.recent.map((r, i) => (
              <span key={i} className="f">
                <i className={i < shown ? (r.got ? "y" : "n") : ""}>{i < shown ? (r.got ? "✓" : "✗") : ""}</i>
                {new Date(r.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
              </span>
            ))}
          </div>
        </div>
      )}
      {!odds && <div className="wcf-qt-sub">If a spot opens, we&apos;ll send you a notification.</div>}
    </div>
  );
}

// ── Hand over your shirt ──
// Giving up your spot: your shirt on a dressing-room peg. Hold it until
// the ring fills to give the spot up (let go to stop), so it can't happen
// by accident. It says who gets your place, then the substitution board
// shows them coming on.
export function ShirtHandover({
  day,
  nextName,
  shirtColor,
  initial,
  note,
  onConfirm,
  onClose,
}: {
  day: string;
  nextName: string | null;
  shirtColor: string;
  initial: string;
  // What happens to their money (game credits), shown before they hold.
  note?: { tone: "good" | "wait" | "none"; text: string } | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<"hold" | "flying" | "board">("hold");
  const [leaving, setLeaving] = useState(false);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const HOLD_MS = 1300;
  const finish = () => {
    setLeaving(true);
    setTimeout(onClose, 380);
  };
  const tick = () => {
    if (start.current == null) return;
    const k = Math.min(1, (performance.now() - start.current) / HOLD_MS);
    setProgress(k);
    if (k < 1) raf.current = requestAnimationFrame(tick);
    else {
      start.current = null;
      onConfirm();
      setStage("flying");
      setTimeout(() => setStage("board"), 650);
      setTimeout(finish, 3700);
    }
  };
  const down = () => {
    if (stage !== "hold" || start.current != null) return;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };
  const up = () => {
    if (start.current == null) return;
    start.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    setProgress(0);
  };
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  const light = shirtColor.toLowerCase() === "#f5f6f8" || shirtColor.toLowerCase() === "#ffffff";
  return (
    <div className={"wcf-sh" + (leaving ? " out" : "")} role="dialog" aria-label="Give up your spot">
      <div className="wcf-sh-t">Can&apos;t make {day}?</div>
      <div className="wcf-sh-s">{stage === "hold" ? "Hold your shirt to give up your spot." : "Spot handed over."}</div>
      {note && <div className={"wcf-credit-note " + note.tone}>{note.text}</div>}
      {stage !== "board" ? (
        <div className="wcf-sh-room">
          <span className="rail" />
          <span className="peg" />
          <svg className="ring" viewBox="0 0 170 170" aria-hidden="true">
            <circle cx="85" cy="85" r="78" className="bg" />
            <circle cx="85" cy="85" r="78" className="fg" style={{ strokeDashoffset: 490 * (1 - progress) }} transform="rotate(-90 85 85)" />
          </svg>
          <button
            type="button"
            className={"wcf-sh-shirt" + (stage === "flying" ? " gone" : "")}
            aria-label="Hold to give up your spot"
            onPointerDown={(e) => { e.preventDefault(); down(); }}
            onPointerUp={up}
            onPointerLeave={up}
            onPointerCancel={up}
            onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); down(); } }}
            onKeyUp={up}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 120 130">
              <path d="M30 18 L48 8 Q60 18 72 8 L90 18 L112 40 L96 56 L90 50 V124 H30 V50 L24 56 L8 40 Z" fill={shirtColor} stroke={light ? "#94a3b8" : "#fff"} strokeWidth="2.5" />
              <path d="M48 8 Q60 22 72 8" fill="none" stroke={light ? "#94a3b8" : "#fff"} strokeWidth="2.5" />
              <text x="60" y="92" textAnchor="middle" style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 40 }} fill={light ? "#0d0d1a" : "#fff"}>{initial}</text>
            </svg>
          </button>
        </div>
      ) : (
        <div className="wcf-sh-board">
          <div className="wcf-led-board"><div className="wcf-led-row"><span>SUBSTITUTION</span><span>{day.toUpperCase()}</span></div></div>
          {nextName ? (
            <div className="wcf-led-board"><div className="wcf-led-row green"><span>IN ▲</span><span>{nextName.toUpperCase()}</span></div></div>
          ) : (
            <div className="wcf-led-board"><div className="wcf-led-row green"><span>SPOT</span><span>OPEN</span></div></div>
          )}
          <div className="wcf-led-board"><div className="wcf-led-row red"><span>OUT ▼</span><span>YOU</span></div></div>
        </div>
      )}
      <div className="wcf-sh-who">
        {stage === "hold" ? (
          nextName ? <>Your spot goes to <b>{nextName}</b>, 1st in line. They&apos;ll get a notification.</> : <>Your spot opens up for anyone to grab.</>
        ) : (
          <>Thanks for giving notice. It keeps {day} a full game.</>
        )}
      </div>
      {stage === "hold" && (
        <button type="button" className="wcf-sh-keep" onClick={finish}>Keep my spot</button>
      )}
    </div>
  );
}
