import { useEffect, useState } from "react";
import type { ScorePrediction } from "../WirralCommunityFootball";

// Predictions: the matchday slip when you lock in, and the padlock the
// first time you open the app after kickoff on a game you predicted.
export function PredictionSlip({ value, sub, onDone }: { value: string; sub: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setLeaving(true), 1700);
    const b = setTimeout(onDone, 2150);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className={"wcf-moment dim" + (leaving ? " foldslip" : "")}
      onClick={() => {
        setLeaving(true);
        setTimeout(onDone, 400);
      }}
    >
      <div className="wcf-slip">
        <small>YOUR CALL · {sub}</small>
        <b>{value}</b>
        <div className="meta">Locks at kickoff</div>
        <span className="st2">LOCKED IN</span>
      </div>
    </div>
  );
}

export function PredictPanel({
  gameId,
  whiteLabel,
  redLabel,
  isBooked,
  myPrediction,
  onSave,
}: {
  gameId: string;
  whiteLabel: string;
  redLabel: string;
  isBooked: boolean;
  myPrediction: ScorePrediction | null;
  onSave: (gameId: string, white: number, red: number) => Promise<void>;
}) {
  const [white, setWhite] = useState(myPrediction?.predicted_white ?? 2);
  const [red, setRed] = useState(myPrediction?.predicted_red ?? 1);
  const [editing, setEditing] = useState(!myPrediction);
  const [saving, setSaving] = useState(false);
  const [slip, setSlip] = useState(false);
  const slipView = slip ? <PredictionSlip value={`${redLabel} ${red}–${white} ${whiteLabel}`} sub="NEXT GAME" onDone={() => setSlip(false)} /> : null;
  const [prevW, setPrevW] = useState(white);
  const [prevR, setPrevR] = useState(red);
  const reelCls = (v: number, p: number) => (v === p ? "wcf-reel" : v > p ? "wcf-reel up" : "wcf-reel down");

  if (!isBooked) {
    return (
      <div className="wcf-predict">
        <div className="wcf-predict-gate">
          <div className="wcf-predict-gate-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
          </div>
          <div className="wcf-predict-gate-text">
            <b>Book a spot on this game</b> to make your prediction — guessing&apos;s for the players in it.
          </div>
        </div>
      </div>
    );
  }

  if (myPrediction && !editing) {
    return (
      <div className="wcf-predict">
        {slipView}
        <div className="wcf-predict-locked">
          <span className="wcf-predict-locked-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="5" />
              <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div className="wcf-predict-locked-body">
            <div className="wcf-predict-locked-label">Your prediction</div>
            <div className="wcf-predict-locked-value">
              {redLabel} {myPrediction.predicted_red}–{myPrediction.predicted_white} {whiteLabel}
            </div>
          </div>
          <button className="wcf-predict-edit" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    await onSave(gameId, white, red);
    setSaving(false);
    setEditing(false);
    if (typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSlip(true);
  }

  return (
    <div className="wcf-predict">
      <div className="wcf-predict-label">
        <span className="wcf-predict-title">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
          </svg>
          Predict the score
        </span>
        <span className="wcf-predict-sub">Closes at kickoff</span>
      </div>
      <p className="wcf-predict-prize">
        Now you know the sides — guess the final score. Top 3 on the season leaderboard win prizes from the pot; each calendar month&apos;s winner gets a free
        game.
      </p>
      <div className="wcf-predict-score">
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{redLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setRed((n) => Math.max(0, n - 1))} aria-label={`Fewer ${redLabel} goals`}>
              −
            </button>
            <span className={reelCls(red, prevR)} key={"r" + red} onAnimationEnd={() => setPrevR(red)}>
              {red}
            </span>
            <button onClick={() => setRed((n) => n + 1)} aria-label={`More ${redLabel} goals`}>
              +
            </button>
          </div>
        </div>
        <div className="wcf-predict-vs">–</div>
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{whiteLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setWhite((n) => Math.max(0, n - 1))} aria-label={`Fewer ${whiteLabel} goals`}>
              −
            </button>
            <span className={reelCls(white, prevW)} key={"w" + white} onAnimationEnd={() => setPrevW(white)}>
              {white}
            </span>
            <button onClick={() => setWhite((n) => n + 1)} aria-label={`More ${whiteLabel} goals`}>
              +
            </button>
          </div>
        </div>
      </div>
      <button className="wcf-predict-lock" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Lock in prediction"}
      </button>
    </div>
  );
}
