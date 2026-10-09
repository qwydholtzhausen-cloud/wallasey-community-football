import { useEffect, useState } from "react";
import type { Trophy, TrophyKind } from "../../lib/cabinet";

// The trophy cabinet on a player card: one slot per kind of award (a count
// when there's more than one), on glass shelves in a wooden cabinet. Tap a
// slot for every one of them, with dates and scores.

const ORDER: TrophyKind[] = ["matchball", "potm", "motm", "record", "apps", "debut"];
const LABEL: Record<TrophyKind, [string, string]> = {
  matchball: ["Match ball", "Match balls"],
  potm: ["Player of the Month", "Player of the Month"],
  motm: ["MOTM medal", "MOTM medals"],
  record: ["Club record", "Club records"],
  apps: ["Milestone shirt", "Milestone shirts"],
  debut: ["Debut cap", "Debut cap"],
};

export function TrophyIcon({ kind, n }: { kind: TrophyKind; n?: number }) {
  switch (kind) {
    case "matchball":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <defs>
            <radialGradient id="cabGold" cx="35%" cy="30%"><stop offset="0" stopColor="#fff8dc" /><stop offset=".45" stopColor="#f5d97a" /><stop offset="1" stopColor="#9c7414" /></radialGradient>
          </defs>
          <circle cx="24" cy="24" r="17" fill="url(#cabGold)" />
          <path d="M24 16l6.5 4.7-2.5 7.6h-8l-2.5-7.6z" fill="rgba(90,62,10,.55)" />
          <path d="M24 7v9M30.5 20.7l9.5-3.2M28 28.3l5.5 8.2M20 28.3l-5.5 8.2M17.5 20.7L8 17.5" stroke="rgba(90,62,10,.45)" strokeWidth="1.6" fill="none" />
          <path d="M16 34c2-1 4 .5 6-.5s3-1.5 5 0" stroke="#7f1d1d" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "potm":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M15 8h18v8a9 9 0 0 1-18 0z" fill="#f5d97a" stroke="#9c7414" strokeWidth="1.2" />
          <path d="M15 11H9a5 5 0 0 0 6 7M33 11h6a5 5 0 0 1-6 7" fill="none" stroke="#c9a24a" strokeWidth="2" />
          <path d="M22 25h4v6h-4z" fill="#c9a24a" />
          <rect x="16" y="31" width="16" height="4" rx="1" fill="#c9a24a" />
          <rect x="13" y="35" width="22" height="6" rx="1.5" fill="#4a3614" />
          <path d="M20 12l1.2 2.5 2.8.4-2 2 .5 2.8L20 18.4l-2.5 1.3.5-2.8-2-2 2.8-.4z" fill="#fff8dc" opacity=".8" />
        </svg>
      );
    case "motm":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M16 4l8 14 8-14" fill="none" stroke="#e63946" strokeWidth="5" />
          <path d="M20 4l4 7 4-7" fill="none" stroke="#f5f6f8" strokeWidth="2" />
          <circle cx="24" cy="30" r="12" fill="#f5d97a" stroke="#9c7414" strokeWidth="1.5" />
          <circle cx="24" cy="30" r="8.5" fill="none" stroke="#9c7414" strokeWidth="1" opacity=".6" />
          <path d="M24 24.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8-3.4-1.8-3.4 1.8.7-3.8-2.8-2.7 3.8-.5z" fill="#9c7414" />
        </svg>
      );
    case "record":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 5l15 5v12c0 10-7 17-15 21-8-4-15-11-15-21V10z" fill="#1f3a8a" stroke="#f5d97a" strokeWidth="1.8" />
          <path d="M24 13l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L24 27.4l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" fill="#f5d97a" />
        </svg>
      );
    case "apps":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M17 6l-10 6 4 8 4-2v24h18V18l4 2 4-8-10-6c-1 3-3.5 5-7 5s-6-2-7-5z" fill="#e63946" stroke="#7f1d1d" strokeWidth="1.2" />
          <text x="24" y="33" textAnchor="middle" fontFamily="var(--display),sans-serif" fontWeight="800" fontSize={n && n >= 100 ? 9.5 : 12} fill="#fff">{n}</text>
        </svg>
      );
    case "debut":
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M9 30c0-11 7-19 15-19s15 8 15 19z" fill="#1f3a8a" />
          <path d="M9 30h30v4H9z" fill="#f5d97a" />
          <path d="M24 11v19M14 16l8 14M34 16l-8 14" stroke="#f5d97a" strokeWidth="1" opacity=".7" />
          <path d="M24 11c4-3 8-2 9 1" fill="none" stroke="#f5d97a" strokeWidth="1.5" />
          <circle cx="33.5" cy="13" r="2.2" fill="#f5d97a" />
        </svg>
      );
  }
}

export function TrophyCabinet({ trophies, isOwn, firstName, highlight }: { trophies: Trophy[]; isOwn: boolean; firstName: string; highlight?: string | null }) {
  const kinds = ORDER.filter((k) => trophies.some((t) => t.kind === k));
  const [open, setOpen] = useState<TrophyKind | null>(() => (highlight ? trophies.find((t) => t.key === highlight)?.kind ?? null : null));
  if (trophies.length === 0) return null;
  const total = trophies.filter((t) => t.kind !== "debut").length;
  // Two to four slots a shelf, filled from the top.
  const shelves: TrophyKind[][] = [];
  for (let i = 0; i < kinds.length; i += 3) shelves.push(kinds.slice(i, i + 3));
  const shown = open ? trophies.filter((t) => t.kind === open).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")) : [];
  return (
    <div className="wcf-cab">
      <div className="wcf-cab-head">
        <span>Trophy cabinet</span>
        <b>{total === 0 ? "Just the cap so far" : `${total} ${total === 1 ? "award" : "awards"}`}</b>
      </div>
      <div className="wcf-cab-case">
        {shelves.map((row, i) => (
          <div key={i} className="wcf-cab-shelf">
            {row.map((k) => {
              const list = trophies.filter((t) => t.kind === k);
              const latest = [...list].sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0];
              const isNew = !!highlight && list.some((t) => t.key === highlight);
              return (
                <button key={k} type="button" className={"wcf-cab-slot" + (open === k ? " on" : "") + (isNew ? " new" : "")} onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}>
                  <span className="ico"><TrophyIcon kind={k} n={k === "apps" ? latest.n : undefined} /></span>
                  {list.length > 1 && k !== "apps" && <span className="cnt">×{list.length}</span>}
                  <small>{LABEL[k][list.length > 1 ? 1 : 0]}</small>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {open && (
        <div className="wcf-cab-list">
          {shown.map((t) => (
            <div key={t.key} className={t.key === highlight ? "new" : ""}>
              <b>{t.title}</b>
              <span>{t.detail}</span>
            </div>
          ))}
        </div>
      )}
      {total === 0 && isOwn && <p className="wcf-cab-hint">Hat-tricks, Man of the Match, Player of the Month and club records all land here, {firstName}.</p>}
    </div>
  );
}

export const cabinetCss = `
.wcf-cab{margin-top:16px}
.wcf-cab-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.wcf-cab-head span{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#d9b866}
.wcf-cab-head b{font-size:11.5px;color:var(--dim);font-weight:700}
.wcf-cab-case{position:relative;padding:10px 10px 4px;border-radius:14px;background:linear-gradient(180deg,#2a1d0c,#140e06);box-shadow:inset 0 0 0 1.5px rgba(201,162,74,.35),inset 0 0 24px rgba(0,0,0,.6)}
.wcf-cab-case::after{content:"";position:absolute;inset:6px;border-radius:9px;pointer-events:none;background:linear-gradient(105deg,rgba(255,255,255,.07) 0 8%,transparent 14% 70%,rgba(255,255,255,.04) 74% 78%,transparent 82%)}
.wcf-cab-shelf{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:2px 2px 8px;margin-bottom:8px;border-bottom:4px solid #4a3614;box-shadow:0 6px 8px -6px rgba(0,0,0,.7)}
.wcf-cab-slot{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 2px 2px;border:0;border-radius:10px;background:none;cursor:pointer;color:#e7d3a3;min-width:0}
.wcf-cab-slot .ico{width:44px;height:44px;display:grid;place-items:center;filter:drop-shadow(0 4px 6px rgba(0,0,0,.55))}
.wcf-cab-slot .ico svg{width:100%;height:100%}
.wcf-cab-slot small{font-size:9.5px;font-weight:700;line-height:1.2;text-align:center;color:#c9b07a;max-width:100%}
.wcf-cab-slot .cnt{position:absolute;top:2px;right:8px;font-family:var(--display);font-weight:800;font-size:11px;color:#1a1405;background:#f5d97a;border-radius:999px;padding:1px 6px}
.wcf-cab-slot.on{background:rgba(245,217,122,.1)}
.wcf-cab-slot.new .ico{animation:wcfCabLand .7s cubic-bezier(.3,1.6,.5,1) both}
@keyframes wcfCabLand{from{transform:translateY(-50px) scale(1.5);opacity:0}}
.wcf-cab-list{margin-top:8px;display:grid;gap:6px}
.wcf-cab-list div{padding:8px 10px;border-radius:10px;background:rgba(245,217,122,.06);border:1px solid rgba(245,217,122,.2)}
.wcf-cab-list div.new{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.12)}
.wcf-cab-list b{display:block;font-size:12px;color:#fde68a}
.wcf-cab-list span{font-size:11.5px;color:var(--dim)}
.wcf-cab-hint{margin:8px 2px 0;font-size:11.5px;color:var(--dim);line-height:1.45}
@media (prefers-reduced-motion:reduce){.wcf-cab-slot.new .ico{animation:none}}
`;

// A hat-trick (or better), for the scorer: the goals go in one by one, the
// whistle, the ball rises into a spotlight and is signed by everyone who
// played, then a glass case drops over it on an engraved plinth. About 8s,
// tap to skip straight to the cabinet. Reduce Motion never gets here.
export function MatchBallMoment({
  goals,
  plate,
  names,
  scorer,
  onCabinet,
  onDone,
}: {
  goals: number;
  plate: [string, string]; // two engraved lines
  names: string[]; // first names of everyone who played, scorer included
  scorer: string; // first name
  onCabinet: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0); // goals 1..n, then n+1 whistle, n+2 ball, n+3 signed, n+4 case, n+5 keep
  const [leaving, setLeaving] = useState(false);
  const others = names.filter((n) => n !== scorer).slice(0, 21);
  useEffect(() => {
    const t: ReturnType<typeof setTimeout>[] = [];
    for (let k = 1; k <= goals; k++) t.push(setTimeout(() => setStep(k), 500 + (k - 1) * 900));
    const after = 500 + goals * 900;
    t.push(setTimeout(() => setStep(goals + 1), after));
    t.push(setTimeout(() => setStep(goals + 2), after + 900));
    t.push(setTimeout(() => setStep(goals + 3), after + 1700));
    t.push(setTimeout(() => setStep(goals + 4), after + 1700 + others.length * 110 + 500));
    t.push(setTimeout(() => setStep(goals + 5), after + 1700 + others.length * 110 + 1200));
    return () => t.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (toCabinet: boolean) => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => (toCabinet ? onCabinet() : onDone()), 300);
  };
  const scoring = step >= 1 && step <= goals;
  const lit = step >= goals + 2;
  return (
    <div className={"wcf-mbm" + (leaving ? " out" : "")} onClick={() => finish(true)} role="dialog" aria-label={`${goals}-goal match ball`}>
      <style>{matchBallCss}</style>
      <div className={"sky" + (lit ? " dim" : "")} />
      <div className={"turf" + (lit ? " dim" : "")} />
      <div className={"spot" + (lit ? " on" : "")} />
      <div className={"goal" + (lit ? " gone" : "")}>
        <div key={"net" + step} className={"net" + (scoring ? " hit" : "")} />
        <div className="frame" />
      </div>
      {scoring && (
        <svg key={"shot" + step} className="shot" style={{ ["--x" as string]: `${[-90, 95, 0, -50, 60][(step - 1) % 5]}px` }} viewBox="0 0 46 46" aria-hidden="true">
          <circle cx="23" cy="23" r="21" fill="#e8edf4" /><path d="M23 13l7 5-3 8h-8l-3-8z" fill="#1e293b" />
        </svg>
      )}
      {scoring && (
        <div key={"gw" + step} className="gw">
          <b>{step}</b>
          <span>GOAL</span>
        </div>
      )}
      {step === goals + 1 && <div className="whistle"><b>FULL TIME</b><i /></div>}
      <svg className={"ball" + (step >= goals + 2 ? " up" : "")} viewBox="0 0 190 190" aria-hidden="true">
        <defs>
          <radialGradient id="mbmGold" cx="35%" cy="30%"><stop offset="0" stopColor="#fff8dc" /><stop offset=".45" stopColor="#f5d97a" /><stop offset="1" stopColor="#9c7414" /></radialGradient>
        </defs>
        <circle cx="95" cy="95" r="88" fill="url(#mbmGold)" />
        <path d="M95 60l24 17-9 28H80l-9-28z" fill="rgba(90,62,10,.5)" />
        <g stroke="rgba(90,62,10,.42)" strokeWidth="2.6" fill="none"><path d="M95 7v53M119 77l42-15M110 105l24 38M80 105l-24 38M71 77L29 62" /></g>
        <g className="rot">
          {others.map((n, i) => {
            const a = (i / others.length) * Math.PI * 2 - 1.2, r = 52 + (i % 3) * 10;
            const x = 95 + Math.cos(a) * r, y = 95 + Math.sin(a) * r, rot = (a * 180) / Math.PI + 90 + (i % 2 ? -14 : 12);
            return (
              <text key={i} className={"sig" + (step >= goals + 3 ? " w" : "")} style={{ animationDelay: `${i * 0.11}s` }} x={x} y={y} transform={`rotate(${rot} ${x} ${y})`} textAnchor="middle" fontFamily="Caveat, 'Segoe Script', cursive" fontWeight="700" fontSize="14" fill="#3b2a07">
                {n}
              </text>
            );
          })}
        </g>
        <text className={"sig me" + (step >= goals + 3 ? " w" : "")} style={{ animationDelay: `${others.length * 0.11}s` }} x="95" y="150" transform="rotate(-8 95 150)" textAnchor="middle" fontFamily="Caveat, 'Segoe Script', cursive" fontWeight="700" fontSize="32" fill="#8b1a1a">
          {scorer}
        </text>
        <ellipse cx="66" cy="50" rx="28" ry="15" fill="rgba(255,255,255,.34)" transform="rotate(-30 66 50)" />
      </svg>
      <div className={"case" + (step >= goals + 4 ? " drop" : "")} />
      <div className={"plinth" + (step >= goals + 4 ? " on" : "")}>
        <div className="top" />
        <div className="body"><span className="plate">{plate[0]}<br />{plate[1]}</span></div>
      </div>
      <div className={"keep" + (step >= goals + 5 ? " on" : "")}>
        <b>Yours to keep.</b>
        <span>Signed by all {names.length} who played.</span>
        <button type="button" onClick={(e) => { e.stopPropagation(); finish(true); }}>Put it in your cabinet</button>
      </div>
      <button type="button" className="later" onClick={(e) => { e.stopPropagation(); finish(false); }}>Later</button>
    </div>
  );
}

const matchBallCss = `
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@700&display=swap');
.wcf-mbm{position:fixed;inset:0;z-index:146;overflow:hidden;background:#05060c;color:#fff;cursor:pointer;animation:wcfMbmIn .3s both}
.wcf-mbm.out{animation:wcfMbmOut .3s ease-in both}
@keyframes wcfMbmIn{from{opacity:0}}@keyframes wcfMbmOut{to{opacity:0}}
.wcf-mbm .sky{position:absolute;inset:0;background:radial-gradient(60% 38% at 22% 6%,rgba(255,236,190,.45),transparent 60%),radial-gradient(60% 38% at 78% 6%,rgba(255,236,190,.45),transparent 60%),linear-gradient(#0a0f1f,#05060c 70%);transition:opacity .6s}
.wcf-mbm .turf{position:absolute;left:0;right:0;bottom:0;height:34%;background:repeating-linear-gradient(90deg,#14331f 0 36px,#173a24 36px 72px);transition:opacity .6s}
.wcf-mbm .turf::before{content:"";position:absolute;inset:0;background:linear-gradient(#05060c,transparent 30%)}
.wcf-mbm .dim{opacity:.18}
.wcf-mbm .spot{position:absolute;left:50%;top:-10%;width:560px;height:120%;margin-left:-280px;background:radial-gradient(40% 55% at 50% 52%,rgba(255,240,200,.22),transparent 70%),conic-gradient(from 180deg at 50% 0%,transparent 165deg,rgba(255,240,200,.12) 175deg,rgba(255,240,200,.12) 185deg,transparent 195deg);opacity:0;transition:opacity .8s;pointer-events:none}
.wcf-mbm .spot.on{opacity:1}
.wcf-mbm .goal{position:absolute;left:50%;top:22%;width:300px;height:170px;margin-left:-150px;transition:opacity .5s,transform .6s}
.wcf-mbm .goal.gone{opacity:0;transform:translateY(-30px)}
.wcf-mbm .goal .frame{position:absolute;inset:0;border:6px solid #f1f5f9;border-bottom:0;border-radius:4px 4px 0 0;box-shadow:0 0 18px rgba(255,255,255,.25)}
.wcf-mbm .goal .net{position:absolute;inset:6px 6px 0;background-image:linear-gradient(rgba(226,232,240,.28) 1px,transparent 1px),linear-gradient(90deg,rgba(226,232,240,.28) 1px,transparent 1px);background-size:14px 14px;transform-origin:50% 0}
.wcf-mbm .goal .net.hit{animation:wcfMbmBulge .55s .45s cubic-bezier(.3,1.6,.5,1)}
@keyframes wcfMbmBulge{30%{transform:scale(1.06,1.12) translateY(6px)}}
.wcf-mbm .shot{position:absolute;width:30px;height:30px;left:50%;bottom:6%;margin-left:-15px;pointer-events:none;animation:wcfMbmShot .5s cubic-bezier(.3,.1,.6,1) forwards}
@keyframes wcfMbmShot{0%{transform:translate(0,0) scale(1.4) rotate(0)}100%{transform:translate(var(--x),-58vh) scale(.55) rotate(-600deg)}}
.wcf-mbm .gw{position:absolute;left:0;right:0;top:56%;text-align:center;pointer-events:none;animation:wcfMbmGw .85s .45s ease-out both}
.wcf-mbm .gw b{display:block;font-family:var(--display);font-weight:800;font-size:96px;line-height:.9;color:#f5d97a;text-shadow:0 0 40px rgba(245,217,122,.6)}
.wcf-mbm .gw span{font-family:var(--display);font-weight:800;font-size:18px;letter-spacing:.4em}
@keyframes wcfMbmGw{0%{opacity:0;transform:scale(2)}20%{opacity:1;transform:scale(1)}80%{opacity:1}100%{opacity:0}}
.wcf-mbm .whistle{position:absolute;left:0;right:0;top:40%;text-align:center;animation:wcfMbmFade 1s ease both}
.wcf-mbm .whistle b{display:block;font-family:var(--display);font-weight:800;font-size:30px;letter-spacing:.3em}
.wcf-mbm .whistle i{display:block;margin:10px auto 0;width:60px;height:60px;border-radius:50%;border:3px solid rgba(255,255,255,.6);animation:wcfMbmWave 1s ease-out both}
@keyframes wcfMbmFade{0%{opacity:0}20%{opacity:1}75%{opacity:1}100%{opacity:0}}
@keyframes wcfMbmWave{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(3)}}
.wcf-mbm .ball{position:absolute;left:50%;top:40%;width:190px;height:190px;margin:-95px 0 0 -95px;opacity:0;transform:translateY(160px) scale(.4);transition:transform 1s cubic-bezier(.2,.9,.3,1),opacity .4s;pointer-events:none}
.wcf-mbm .ball.up{opacity:1;transform:none}
.wcf-mbm .ball .rot{transform-origin:95px 95px;animation:wcfMbmSpin 18s linear infinite}
@keyframes wcfMbmSpin{to{transform:rotate(360deg)}}
.wcf-mbm .sig{opacity:0}
.wcf-mbm .sig.w{animation:wcfMbmWrite .32s ease-out forwards}
@keyframes wcfMbmWrite{from{opacity:0;clip-path:inset(0 100% 0 0)}to{opacity:1;clip-path:inset(0 0 0 0)}}
.wcf-mbm .case{position:absolute;left:50%;top:40%;width:236px;height:250px;margin:-150px 0 0 -118px;border:2px solid rgba(220,235,255,.35);border-bottom:0;border-radius:10px 10px 0 0;background:linear-gradient(105deg,rgba(255,255,255,.14) 0 8%,transparent 12% 70%,rgba(255,255,255,.08) 74% 78%,transparent 82%);opacity:0;transform:translateY(-70vh);transition:transform .55s cubic-bezier(.5,0,.6,1.35),opacity .2s;pointer-events:none}
.wcf-mbm .case.drop{opacity:1;transform:none}
.wcf-mbm .plinth{position:absolute;left:50%;top:calc(40% + 100px);width:270px;margin-left:-135px;opacity:0;transform:translateY(30px);transition:all .45s .35s;pointer-events:none}
.wcf-mbm .plinth.on{opacity:1;transform:none}
.wcf-mbm .plinth .top{height:16px;border-radius:4px 4px 0 0;background:linear-gradient(#3a2a12,#22180a)}
.wcf-mbm .plinth .body{padding:12px 10px 14px;background:linear-gradient(#2a1d0c,#140e06);text-align:center}
.wcf-mbm .plate{display:inline-block;padding:8px 14px;border-radius:4px;background:linear-gradient(135deg,#f6e3a6,#c9a24a 45%,#8a6a22);color:#2a1c05;font-family:var(--display);font-weight:800;font-size:10.5px;letter-spacing:.14em;line-height:1.5;text-transform:uppercase;box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 2px 6px rgba(0,0,0,.5)}
.wcf-mbm .keep{position:absolute;z-index:2;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 40px);text-align:center;opacity:0;transition:opacity .4s;pointer-events:none}
.wcf-mbm .keep.on{opacity:1;pointer-events:auto}
.wcf-mbm .keep b{display:block;font-family:var(--display);font-weight:800;font-size:23px}
.wcf-mbm .keep span{display:block;margin-top:4px;font-size:12.5px;color:var(--dim)}
.wcf-mbm .keep button{margin-top:14px;min-height:46px;padding:0 20px;border-radius:14px;border:0;background:#f5d97a;color:#1a1405;font-weight:800;font-size:14px;cursor:pointer}
.wcf-mbm .later{position:absolute;z-index:3;top:calc(env(safe-area-inset-top,0px) + 14px);right:14px;min-height:36px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.3);color:rgba(255,255,255,.7);font-weight:700;font-size:12px;cursor:pointer}
`;
