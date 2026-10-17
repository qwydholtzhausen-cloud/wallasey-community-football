import { useEffect, useRef, useState } from "react";
import { Avatar, avatarFor } from "./shared";
import { TOTM_MIN_GAMES, TOTM_RATING, type TeamOfMonth, type TotmLine, type TotmPlayer } from "../../lib/teamOfMonth";

// ── Team of the Month ──
// The full-screen reveal (floodlights up on the night pitch, the back line
// lands first, the captain last in gold) and the card that lives on
// Results › Season. The team itself comes from lib/teamOfMonth.ts.

export type TotmMonth = { monthKey: string; monthLabel: string; team: TeamOfMonth };
type Who = (id: string) => { name: string; avatarUrl?: string | null };

const first = (n: string) => n.split(" ")[0];
const monthWord = (label: string) => label.split(" ")[0];

// Where each line stands, as % of the pitch: across, then down.
const SPOTS: Record<TotmLine, { xs: number[]; y: number; s: number }> = {
  front: { xs: [36, 64], y: 15, s: 0.8 },
  mid: { xs: [18, 50, 82], y: 42, s: 0.9 },
  back: { xs: [16, 50, 84], y: 70, s: 1 },
};

function placed(team: TeamOfMonth["team"]) {
  const out: { p: TeamOfMonth["team"][number]; x: number; y: number; s: number; line: TotmLine }[] = [];
  (["front", "mid", "back"] as TotmLine[]).forEach((line) => {
    const inLine = team.filter((p) => p.line === line);
    const spot = SPOTS[line];
    // A line can come up one short or long when the captain is added late.
    const xs = inLine.length === spot.xs.length ? spot.xs : inLine.map((_, i) => ((i + 1) * 100) / (inLine.length + 1));
    inLine.forEach((p, i) => out.push({ p, x: xs[i], y: spot.y, s: spot.s, line }));
  });
  return out;
}

const statLine = (p: TotmPlayer) => `T ${p.team.toFixed(1)} · S ${p.squad.toFixed(1)}`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function PointsTable({ month, myId, who }: { month: TotmMonth; myId: string; who: Who }) {
  const inTeam = new Set(month.team.team.map((p) => p.id));
  const rest = month.team.table.filter((p) => !inTeam.has(p.id));
  const row = (p: TotmPlayer, out: boolean) => {
    const w = who(p.id);
    return (
      <div key={p.id} className={"wcf-totm-lrow" + (out ? " out" : "")}>
        <Avatar name={w.name} avatarUrl={w.avatarUrl} className="wcf-totm-lface" background={avatarFor(w.name).gradient} />
        <span className="wcf-totm-lnm">
          <b>
            {w.name}
            {p.captain ? " · Captain" : ""}
            {p.id === myId ? " (you)" : ""}
          </b>
          <span>
            Team {p.team.toFixed(1)} · Squad {p.squad.toFixed(1)} · {p.apps} games · {p.wins} won · {p.votes} votes{p.motm ? ` · ${p.motm} MOTM` : ""} · {signed(p.margin)} goal diff
          </span>
        </span>
        <strong>{p.rating.toFixed(1)}</strong>
      </div>
    );
  };
  return (
    <>
      <h4>How the rating works</h4>
      <div className="wcf-totm-how">
        Every game gets a rating out of 10. <b>Team (out of 5):</b> {TOTM_RATING.win} a win, {TOTM_RATING.draw} a draw, ±1 for the margin (up to {TOTM_RATING.marginCap} goals), +1.{" "}
        <b>Squad (out of 5):</b> your share of that night&apos;s Man of the Match votes ({TOTM_RATING.fullShare * 100}% = {TOTM_RATING.shareMax}), +1 for Man of the Match. Your month is
        your average, with two average games added so a short hot streak can&apos;t win it. {TOTM_MIN_GAMES}+ games to qualify. {month.team.qualified} players qualified in{" "}
        {monthWord(month.monthLabel)}. The captain is Player of the Month.
      </div>
      {month.team.team.map((p) => row(p, false))}
      {rest.length > 0 && <div className="wcf-totm-cut">THE CUT</div>}
      {rest.map((p) => row(p, true))}
    </>
  );
}

export function TotmReveal({
  month,
  myId,
  who,
  instant = false,
  onDone,
}: {
  month: TotmMonth;
  myId: string;
  who: Who;
  instant?: boolean; // straight to the finished team with the table open
  onDone: () => void;
}) {
  const spots = placed(month.team.team);
  const [lit, setLit] = useState(instant);
  const [shown, setShown] = useState(instant ? spots.length : 0);
  const [capIn, setCapIn] = useState(instant);
  const [done, setDone] = useState(instant);
  const [table, setTable] = useState(instant);
  const [leaving, setLeaving] = useState(false);
  const closed = useRef(false);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    setLeaving(true);
    setTimeout(onDone, 380);
  };
  // Back line first, then midfield, then the front two; the captain waits.
  const order = spots
    .filter((s) => !s.p.captain)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .concat(spots.filter((s) => s.p.captain));
  const capCount = spots.filter((s) => s.p.captain).length;
  useEffect(() => {
    if (instant) return;
    const t: ReturnType<typeof setTimeout>[] = [];
    t.push(setTimeout(() => setLit(true), 400));
    const field = order.length - capCount;
    for (let i = 1; i <= field; i++) t.push(setTimeout(() => setShown(i), 1500 + (i - 1) * 240));
    const capT = 1500 + field * 240 + 450;
    t.push(setTimeout(() => setCapIn(true), capT));
    t.push(setTimeout(() => setShown(order.length), capT + 500));
    t.push(setTimeout(() => setDone(true), capT + 1300));
    return () => t.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const mine = month.team.team.find((p) => p.id === myId);
  const word = monthWord(month.monthLabel).toUpperCase();
  const cap = spots.find((s) => s.p.captain);
  return (
    <div className={"wcf-totm" + (lit ? " lit" : "") + (capIn ? " capin" : "") + (done ? " done" : "") + (leaving ? " out" : "")} role="dialog" aria-label={`${month.monthLabel} Team of the Month`}>
      <style>{totmCss}</style>
      <div className="wcf-totm-photo" />
      <div className="wcf-totm-flash l" />
      <div className="wcf-totm-flash r" />
      <div className="wcf-totm-h">
        <div className="k">TEAM OF THE MONTH</div>
        <h3>{month.monthLabel}</h3>
        <small>
          {month.team.games} games · the month&apos;s best eight
        </small>
      </div>
      <div className="wcf-totm-stage">
        {cap && <div className="wcf-totm-spot" style={{ left: `${cap.x}%`, top: `calc(${cap.y}% - 170px)` }} />}
        {order.map((s, i) => {
          const w = who(s.p.id);
          return (
            <div
              key={s.p.id}
              className={"wcf-totm-pc" + (s.p.captain ? " capt" : "") + (i < shown ? " in" : "")}
              style={{ left: `${s.x}%`, top: `${s.y}%`, ["--s" as string]: s.s }}
            >
              {s.p.id === myId && <span className="wcf-totm-you">YOU</span>}
              <div className="wcf-totm-card">
                <span className="wcf-totm-pts">
                  {s.p.rating.toFixed(1)}
                  <small>RATING</small>
                </span>
                {s.p.captain && <span className="wcf-totm-arm">C</span>}
                <Avatar name={w.name} avatarUrl={w.avatarUrl} className="wcf-totm-ph" background={avatarFor(w.name).gradient} />
                <b>{first(w.name)}</b>
                <span className="wcf-totm-sl">{statLine(s.p)}</span>
              </div>
              <span className="wcf-totm-shadow" />
            </div>
          );
        })}
      </div>
      <div className={"wcf-totm-ban" + (mine ? " me" : "")}>
        {mine ? (mine.captain ? `YOU CAPTAIN ${word}'S EIGHT` : `YOU MADE ${word}'S EIGHT`) : `${word}'S BEST EIGHT`}
      </div>
      <div className="wcf-totm-f">
        <button onClick={() => setTable(true)}>How the rating works</button>
        <button className="main" onClick={close}>
          Continue
        </button>
      </div>
      <div className={"wcf-totm-sheet" + (table ? " on" : "")} onClick={() => setTable(false)}>
        <PointsTable month={month} myId={myId} who={who} />
      </div>
    </div>
  );
}

// On Results › Season, under Player of the Month: the latest team on a
// small pitch, earlier months a tap away. Faces open player cards.
export function TotmCard({
  months,
  myId,
  who,
  onWatch,
  openPlayerCard,
}: {
  months: TotmMonth[];
  myId: string;
  who: Who;
  onWatch: (monthKey: string, instant: boolean) => void;
  openPlayerCard: (id: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  if (!months.length) return null;
  const month = months.find((m) => m.monthKey === sel) ?? months[months.length - 1];
  const ys: Record<TotmLine, number> = { front: 20, mid: 50, back: 80 };
  return (
    <div className="wcf-totm-cardbox">
      <style>{totmCss}</style>
      <div className="wcf-totm-ch">
        <div>
          <small>TEAM OF THE MONTH</small>
          <b>{month.monthLabel}</b>
        </div>
        <span>Tap a face for their card</span>
      </div>
      <div className="wcf-totm-mini">
        {placed(month.team.team).map((s) => {
          const w = who(s.p.id);
          return (
            <button
              key={s.p.id}
              className={"wcf-totm-mf" + (s.p.captain ? " c" : "") + (s.p.id === myId ? " me" : "")}
              style={{ left: `${s.x}%`, top: `${ys[s.line]}%` }}
              onClick={() => openPlayerCard(s.p.id)}
            >
              {s.p.captain && <span className="wcf-totm-mc">C</span>}
              <Avatar name={w.name} avatarUrl={w.avatarUrl} className="wcf-totm-mph" background={avatarFor(w.name).gradient} />
              {s.p.id === myId ? "You" : first(w.name)}
            </button>
          );
        })}
      </div>
      <div className="wcf-totm-cf">
        <button className="main" onClick={() => onWatch(month.monthKey, false)}>
          Watch the reveal
        </button>
        <button onClick={() => onWatch(month.monthKey, true)}>The ratings</button>
      </div>
      {months.length > 1 && (
        <div className="wcf-totm-months">
          {[...months].reverse().map((m) => (
            <button key={m.monthKey} className={m.monthKey === month.monthKey ? "on" : ""} onClick={() => setSel(m.monthKey)}>
              {m.monthLabel.split(" ")[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const totmCss = `
.wcf-totm{position:fixed;inset:0;z-index:146;display:flex;flex-direction:column;background:#04060b;color:#fff;overflow:hidden;animation:wcfTotmIn .35s both;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}
.wcf-totm.out{animation:wcfTotmOut .36s ease-in forwards}
@keyframes wcfTotmIn{from{opacity:0}}
@keyframes wcfTotmOut{to{opacity:0}}
.wcf-totm-photo{position:absolute;inset:0 -40px;background:url('/pitch-night.jpg') 50% 62%/cover;filter:brightness(.18) saturate(.6);transition:filter 1.2s ease}
.wcf-totm.lit .wcf-totm-photo{filter:brightness(.75) saturate(1)}
.wcf-totm-photo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,#04060b 0%,rgba(4,6,11,.6) 16%,transparent 34%,transparent 62%,#04060b 86%)}
.wcf-totm-flash{position:absolute;top:-40px;width:200px;height:320px;background:radial-gradient(50% 40% at 50% 10%,rgba(255,246,220,.55),transparent 70%);opacity:0;transition:opacity .4s;mix-blend-mode:screen;pointer-events:none}
.wcf-totm-flash.l{left:-60px}.wcf-totm-flash.r{right:-60px}
.wcf-totm.lit .wcf-totm-flash.l{opacity:1}.wcf-totm.lit .wcf-totm-flash.r{opacity:1;transition-delay:.3s}
.wcf-totm-h{position:relative;text-align:center;padding:26px 16px 0}
.wcf-totm-h .k{font-size:10.5px;font-weight:800;letter-spacing:.3em;color:#f5d97a}
.wcf-totm-h h3{margin:6px 0 0;font-family:var(--display);font-weight:800;font-size:26px;line-height:1;background:linear-gradient(180deg,#fff6d1,#f5d97a 55%,#b8902a);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-totm-h small{display:block;margin-top:6px;font-size:11px;color:#94a3b8}
.wcf-totm-stage{position:relative;flex:1;min-height:380px;max-height:520px;margin:4px auto 0;width:100%;max-width:420px}
.wcf-totm-pc{position:absolute;width:80px;margin-left:-40px;transform-origin:50% 100%;opacity:0;transform:translateY(-50px) scale(var(--s)) rotateY(90deg);transition:opacity .25s,transform .6s cubic-bezier(.3,1.4,.5,1);z-index:2}
.wcf-totm-pc.in{opacity:1;transform:translateY(0) scale(var(--s)) rotateY(0)}
.wcf-totm-card{position:relative;border-radius:12px;padding:6px 5px 7px;text-align:center;background:linear-gradient(170deg,#1f2a44,#0d1220 70%);border:1.5px solid rgba(245,217,122,.7);box-shadow:0 14px 22px -10px #000;overflow:hidden}
.wcf-totm-card::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.22) 45%,transparent 60%);transform:translateX(-120%)}
.wcf-totm-pc.in .wcf-totm-card::after{animation:wcfTotmShine 1.1s .4s ease-out}
@keyframes wcfTotmShine{to{transform:translateX(120%)}}
.wcf-totm-pts{position:absolute;left:6px;top:5px;font-family:var(--display);font-weight:800;font-size:14px;line-height:1;color:#f5d97a;text-align:left}
.wcf-totm-pts small{display:block;font-size:7px;letter-spacing:.1em;color:#94a3b8}
.wcf-totm-ph{width:42px;height:42px;margin:12px auto 4px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:17px;color:#fff;border:2px solid rgba(245,217,122,.8)}
.wcf-totm-card b{display:block;font-family:var(--display);font-size:11px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-totm-sl{display:block;margin-top:3px;font-size:8.5px;font-weight:700;color:#cbd5e1;white-space:nowrap}
.wcf-totm-shadow{position:absolute;left:12%;right:12%;bottom:-8px;height:10px;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.8),transparent)}
.wcf-totm-pc.capt .wcf-totm-card{background:linear-gradient(170deg,#fff3c4,#f5d97a 40%,#b8902a);border-color:#fff6dc;box-shadow:0 14px 26px -10px #000,0 0 26px rgba(245,217,122,.7)}
.wcf-totm-pc.capt .wcf-totm-card b,.wcf-totm-pc.capt .wcf-totm-sl,.wcf-totm-pc.capt .wcf-totm-pts{color:#2a1d05}
.wcf-totm-pc.capt .wcf-totm-pts small{color:#5a4210}
.wcf-totm-pc.capt .wcf-totm-ph{border-color:#fff}
.wcf-totm-arm{position:absolute;right:5px;top:5px;width:17px;height:17px;border-radius:50%;background:#0d1220;color:#f5d97a;font-family:var(--display);font-weight:800;font-size:10px;display:grid;place-items:center}
.wcf-totm-you{position:absolute;left:50%;top:-9px;transform:translateX(-50%);font-size:8.5px;font-weight:800;letter-spacing:.12em;background:#e63946;color:#fff;border-radius:5px;padding:2px 6px;z-index:3;white-space:nowrap}
.wcf-totm-spot{position:absolute;width:150px;height:260px;margin-left:-75px;background:radial-gradient(60% 50% at 50% 100%,rgba(255,246,220,.5),transparent 70%),linear-gradient(180deg,rgba(255,246,220,0),rgba(255,246,220,.12));filter:blur(6px);opacity:0;transition:opacity .5s;pointer-events:none;z-index:1}
.wcf-totm.capin .wcf-totm-spot{opacity:1}
.wcf-totm-ban{position:relative;margin:0 16px;padding:10px 12px;border-radius:12px;text-align:center;font-family:var(--display);font-weight:800;font-size:13px;letter-spacing:.06em;color:#2a1d05;background:linear-gradient(90deg,#b8902a,#f5d97a 50%,#b8902a);transform:scaleX(0);transition:transform .5s cubic-bezier(.2,.9,.3,1)}
.wcf-totm.done .wcf-totm-ban{transform:none}
.wcf-totm-ban.me{background:linear-gradient(90deg,#9f1d26,#e63946 50%,#9f1d26);color:#fff}
.wcf-totm-f{position:relative;display:flex;gap:8px;padding:14px 16px 20px;opacity:0;transition:opacity .4s .3s}
.wcf-totm.done .wcf-totm-f{opacity:1}
.wcf-totm-f button{flex:1;border-radius:12px;padding:12px 0;font:800 13px var(--sans);border:1px solid rgba(148,163,184,.2);background:rgba(255,255,255,.05);color:#fff;cursor:pointer}
.wcf-totm-f button.main{background:#f5d97a;color:#1a1405;border-color:#f5d97a}
.wcf-totm-sheet{position:absolute;left:0;right:0;bottom:0;z-index:6;border-radius:22px 22px 0 0;background:#111827;border-top:1px solid rgba(245,217,122,.35);padding:16px 16px calc(20px + env(safe-area-inset-bottom,0px));transform:translateY(100%);transition:transform .4s cubic-bezier(.2,.9,.3,1);max-height:78%;overflow-y:auto}
.wcf-totm-sheet.on{transform:none}
.wcf-totm-sheet h4{margin:0 0 4px;font-family:var(--display);font-size:15px}
.wcf-totm-how{font-size:11.5px;color:#94a3b8;margin-bottom:8px;line-height:1.5}
.wcf-totm-how b{color:#e2e8f0}
.wcf-totm-lrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid rgba(148,163,184,.15)}
.wcf-totm-lface{width:28px;height:28px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:11px;color:#fff;flex:none}
.wcf-totm-lnm{flex:1;min-width:0}
.wcf-totm-lnm b{display:block;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-totm-lnm span{display:block;font-size:10.5px;color:#94a3b8}
.wcf-totm-lrow strong{font-family:var(--display);color:#f5d97a}
.wcf-totm-lrow.out{opacity:.55}
.wcf-totm-cut{font-size:10px;letter-spacing:.16em;color:#94a3b8;text-align:center;padding:6px 0;border-top:1px dashed rgba(245,217,122,.35)}
.wcf-totm-cardbox{margin-top:14px;margin-bottom:16px;border-radius:20px;overflow:hidden;border:1px solid rgba(245,217,122,.45);background:#070a12;box-shadow:0 24px 40px -26px rgba(245,217,122,.45)}
.wcf-totm-ch{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;padding:14px 14px 8px}
.wcf-totm-ch small{font-size:10px;letter-spacing:.2em;color:#f5d97a;font-weight:800}
.wcf-totm-ch b{display:block;font-family:var(--display);font-size:18px;margin-top:3px;color:#fff}
.wcf-totm-ch span{font-size:11px;color:#94a3b8}
.wcf-totm-mini{position:relative;height:250px;margin:0 12px;border-radius:12px;overflow:hidden;background:url('/pitch-night.jpg') 50% 75%/cover}
.wcf-totm-mini::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,6,11,.55),rgba(4,6,11,.15) 40%,rgba(4,6,11,.5))}
.wcf-totm-mf{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:2px;font:700 10px var(--sans);color:#fff;text-shadow:0 1px 6px #000;white-space:nowrap;background:none;border:0;padding:0;cursor:pointer}
.wcf-totm-mph{width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid #f5d97a;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:14px;color:#fff;box-shadow:0 4px 10px rgba(0,0,0,.6)}
.wcf-totm-mf.c .wcf-totm-mph{width:44px;height:44px;border-color:#fff6dc;box-shadow:0 0 16px rgba(245,217,122,.8)}
.wcf-totm-mf.me .wcf-totm-mph{border-color:#e63946}
.wcf-totm-mc{position:absolute;top:-4px;right:-6px;z-index:1;width:16px;height:16px;border-radius:50%;background:#f5d97a;color:#2a1d05;font-family:var(--display);font-weight:800;font-size:9px;display:grid;place-items:center;text-shadow:none}
.wcf-totm-cf{display:flex;gap:8px;padding:12px 14px 14px}
.wcf-totm-cf button{flex:1;border-radius:12px;padding:10px 0;font:800 12.5px var(--sans);border:1px solid rgba(148,163,184,.2);background:rgba(255,255,255,.04);color:#fff;cursor:pointer}
.wcf-totm-cf button.main{background:#f5d97a;color:#1a1405;border-color:#f5d97a}
.wcf-totm-months{display:flex;gap:6px;padding:0 14px 14px;flex-wrap:wrap}
.wcf-totm-months button{font:700 11px var(--sans);padding:5px 10px;border-radius:999px;border:1px solid rgba(148,163,184,.2);background:none;color:#94a3b8;cursor:pointer}
.wcf-totm-months button.on{border-color:#f5d97a;color:#f5d97a}
@media (prefers-reduced-motion:reduce){.wcf-totm,.wcf-totm *{transition-duration:.01ms!important;animation-duration:.01ms!important}}
`;
