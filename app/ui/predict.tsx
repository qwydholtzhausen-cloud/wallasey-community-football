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

// ── Predict face-lift: the "next call" ticket while teams aren't up yet,
// and the podium for the top 3 (the pot's prize places). ──
type PodiumRow = { playerId: string; playerName: string; points: number };
export function PredictPodium({
  rows,
  myId,
  faceOf,
}: {
  rows: PodiumRow[];
  myId: string;
  faceOf: (r: PodiumRow, className: string, style: React.CSSProperties) => React.ReactNode;
}) {
  const places = [
    { row: rows[1], place: 2, color: "#c9d1dd", face: 62, step: 104, delay: 200 },
    { row: rows[0], place: 1, color: "#f5d97a", face: 74, step: 128, delay: 0 },
    { row: rows[2], place: 3, color: "#d99062", face: 56, step: 86, delay: 380 },
  ];
  return (
    <div className="wcf-pod-stage">
      <div className="wcf-pod">
        {places.map(({ row, place, color, face, step, delay }) => (
          <div key={place} className="wcf-pod-col" style={{ ["--c" as string]: color }}>
            {faceOf(row, "wcf-pod-face", { width: face, height: face, fontSize: face * 0.36, animationDelay: `${delay + 500}ms` })}
            <div className="wcf-pod-name">{row.playerId === myId ? <em>You</em> : row.playerName.split(" ")[0]}</div>
            <div className="wcf-pod-step" style={{ height: step, animationDelay: `${delay}ms` }}>
              <b>{row.points}</b>
              <small>{row.points === 1 ? "PT" : "PTS"}</small>
              <span>
                {place}
                {["", "st", "nd", "rd"][place]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PredictTicket({
  dateLabel,
  kickoff,
  last,
}: {
  dateLabel: string;
  kickoff: string;
  last: { score: string; teams: string; pts: number } | null;
}) {
  return (
    <div className="wcf-pticket">
      <div className="wcf-pticket-l">
        <small>Next call · {dateLabel}</small>
        <b>Opens when teams go up</b>
        <p>Then you&apos;ve until {kickoff} kickoff to lock in a score.</p>
      </div>
      <div className="wcf-pticket-r">
        {last ? (
          <>
            <small>Your last call</small>
            <b>{last.score}</b>
            <span className="wcf-pticket-teams">{last.teams}</span>
            <em className={last.pts > 0 ? "" : "miss"}>{last.pts === 3 ? "+3 PTS · EXACT" : last.pts === 1 ? "+1 PT" : "0 PTS"}</em>
          </>
        ) : (
          <>
            <small>Exact score</small>
            <b>3 pts</b>
            <span className="wcf-pticket-teams">Right result 1 pt</span>
          </>
        )}
      </div>
    </div>
  );
}

export const predictFaceCss = `
.wcf-pticket{position:relative;display:grid;grid-template-columns:1fr auto;border-radius:18px;border:1px solid var(--line);overflow:hidden;background:#141b2b;margin-bottom:16px}
.wcf-pticket::before,.wcf-pticket::after{content:"";position:absolute;right:95px;width:16px;height:16px;border-radius:50%;background:var(--bg,#0b0f1a)}
.wcf-pticket::before{top:-8px}.wcf-pticket::after{bottom:-8px}
.wcf-pticket-l{padding:14px;min-width:0;background:linear-gradient(90deg,rgba(14,19,32,.94) 30%,rgba(14,19,32,.55)),url('/net-rain.jpg') center/cover}
.wcf-pticket-l small{font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#f5d97a}
.wcf-pticket-l b{display:block;font-family:var(--display);font-size:16px;color:#fff;margin-top:4px}
.wcf-pticket-l p{margin:4px 0 0;font-size:12px;color:#cbd5e1;line-height:1.4}
.wcf-pticket-r{width:104px;border-left:2px dashed rgba(255,255,255,.12);padding:12px 8px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.wcf-pticket-r small{font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-pticket-r b{font-family:var(--display);font-size:18px;color:#fff;margin:3px 0 1px;font-variant-numeric:tabular-nums}
.wcf-pticket-teams{font-size:9.5px;color:var(--dim)}
.wcf-pticket-r em{font-style:normal;font-size:10.5px;font-weight:800;color:#6fd59a;margin-top:4px}
.wcf-pticket-r em.miss{color:var(--dim)}
.wcf-pod-stage{border-radius:20px;overflow:hidden;border:1px solid rgba(245,217,122,.25);padding:18px 10px 0;margin-bottom:12px;background:linear-gradient(180deg,rgba(8,8,15,.55) 0%,rgba(8,8,15,.35) 40%,rgba(8,8,15,.9) 100%),url('/pitch-floodlit.jpg') 50% 60%/cover}
.wcf-pod{display:grid;grid-template-columns:1fr 1.15fr 1fr;align-items:end;gap:6px}
.wcf-pod-col{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0}
.wcf-pod-face{border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;color:#fff;border:3px solid var(--c);box-shadow:0 0 18px color-mix(in srgb,var(--c) 45%,transparent);animation:wcfPodDrop .6s cubic-bezier(.3,1.5,.5,1) backwards}
.wcf-pod-name{font-size:12px;font-weight:700;color:#fff;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 8px rgba(0,0,0,.9)}
.wcf-pod-name em{font-style:normal;color:#f5d97a}
.wcf-pod-step{width:100%;display:flex;flex-direction:column;align-items:center;padding-top:8px;border-radius:12px 12px 4px 4px;border:1px solid color-mix(in srgb,var(--c) 40%,transparent);border-bottom:0;background:linear-gradient(180deg,color-mix(in srgb,var(--c) 34%,rgba(20,27,43,.6)),rgba(14,19,31,.85));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transform-origin:bottom;animation:wcfPodGrow .7s cubic-bezier(.2,.9,.3,1) backwards}
.wcf-pod-step b{font-family:var(--display);font-size:24px;line-height:1;color:var(--c);font-variant-numeric:tabular-nums}
.wcf-pod-step small{font-size:9px;font-weight:700;letter-spacing:.14em;color:var(--dim);margin-top:2px}
.wcf-pod-step span{margin-top:auto;padding-bottom:6px;font-family:var(--display);font-weight:800;font-size:13px;color:var(--c);opacity:.85}
@keyframes wcfPodGrow{from{transform:scaleY(0)}}
@keyframes wcfPodDrop{from{opacity:0;transform:translateY(-20px) scale(.8)}}
.wcf-race{display:flex;align-items:center;gap:10px;margin-bottom:8px;padding:11px 12px;border-radius:14px;border:1px solid rgba(245,217,122,.3);background:rgba(245,217,122,.06);font-size:12.5px;line-height:1.4;color:#e2e8f0}
.wcf-race svg{flex:none;color:#f5d97a}
.wcf-race b{color:#f5d97a}
.wcf-pod-prize{text-align:center;font-size:11px;color:var(--dim);margin-bottom:14px;line-height:1.5}
.wcf-lb-more{display:block;width:100%;background:none;border:0;padding:12px 0 4px;font:inherit;font-size:13px;font-weight:700;color:#f5d97a;cursor:pointer}
.wcf-lb-skip::before{content:"···";display:block;text-align:center;color:var(--dim);letter-spacing:.3em;font-size:12px;padding:4px 0}
@media (prefers-reduced-motion: reduce){.wcf-pod-face,.wcf-pod-step{animation:none}}
`;
