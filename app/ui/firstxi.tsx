import { useEffect, useRef, useState } from "react";
import { Avatar, avatarFor } from "./shared";

// ── The First XI one-offs ──
// The Man of the Match reveal on a stadium big screen, with the one-of-one
// medal swinging down on its ribbon, and the pennant every player who
// played gets: hung in the dressing room, tap to turn it over for all 22
// signatures. Shown once each, through the moment queue.

type Person = { id: string; name: string; avatarUrl?: string | null };

export function FirstXiMedal() {
  return (
    <svg viewBox="0 0 150 300" aria-hidden="true">
      <path d="M60 0h12l3 190h-12z" fill="#e63946" />
      <path d="M78 0h12l-3 190h-12z" fill="#f5f6f8" />
      <defs>
        <radialGradient id="fxiMg" cx="35%" cy="30%">
          <stop offset="0" stopColor="#fff8dc" />
          <stop offset=".45" stopColor="#f5d97a" />
          <stop offset="1" stopColor="#9c7414" />
        </radialGradient>
      </defs>
      <circle cx="75" cy="236" r="56" fill="url(#fxiMg)" stroke="#7a5a1a" strokeWidth="3" />
      <circle cx="75" cy="236" r="45" fill="none" stroke="#9c7414" strokeWidth="1.4" opacity=".7" />
      <image href="/crest.png" x="58" y="196" width="34" height="34" />
      <text x="75" y="246" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="700" fontSize="15" fill="#3a2a08" letterSpacing="1">
        FIRST XI
      </text>
      <text x="75" y="262" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="600" fontSize="11" fill="#5a4210" letterSpacing="2">
        MOTM
      </text>
      <text x="75" y="277" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="600" fontSize="9.5" fill="#5a4210" letterSpacing="1.5">
        25·10·26
      </text>
    </svg>
  );
}

export function FirstXiPennantFront() {
  return (
    <svg viewBox="0 0 230 330" aria-hidden="true">
      <path d="M6 0h218L115 326z" fill="#b0101c" />
      <path d="M14 4h202L115 306z" fill="#e63946" />
      <path d="M14 10h202" stroke="#fff" strokeWidth="6" />
      <path d="M18 8L115 300M212 8L115 300" stroke="#fff" strokeWidth="3.5" opacity=".9" />
      <image href="/crest.png" x="82" y="24" width="66" height="66" />
      <text x="115" y="118" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="700" fontSize="30" fill="#fff" letterSpacing="1">
        THE FIRST XI
      </text>
      <text x="115" y="140" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="600" fontSize="12" fill="#ffd5d8" letterSpacing="3">
        REDS v WHITES
      </text>
      <text x="115" y="162" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="600" fontSize="13" fill="#fff" letterSpacing="2">
        25 · 10 · 2026
      </text>
      <text x="115" y="182" textAnchor="middle" fontFamily="var(--font-oswald),sans-serif" fontWeight="500" fontSize="10.5" fill="#ffd5d8" letterSpacing="2.5">
        THE OVAL LEISURE
      </text>
      <text x="115" y="214" textAnchor="middle" fontFamily="var(--font-caveat),cursive" fontWeight="700" fontSize="24" fill="#f5d97a">
        Nº 1
      </text>
    </svg>
  );
}

export function FirstXiMotmReveal({ winners, total, votes, onDone }: { winners: Person[]; total: number; votes: number; onDone: () => void }) {
  const [stage, setStage] = useState(0); // 1 title, 2 scramble, 3 winner, 4 medal
  const [tick, setTick] = useState("");
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);
  const close = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    setTimeout(onDone, 380);
  };
  const names = ["REDS", "WHITES", "FIRST XI", ...winners.map((w) => w.name.split(" ")[0].toUpperCase()), "THE OVAL", "25·10·26"];
  useEffect(() => {
    const t: ReturnType<typeof setTimeout>[] = [];
    let iv: ReturnType<typeof setInterval> | null = null;
    t.push(setTimeout(() => setStage(1), 500));
    t.push(
      setTimeout(() => {
        setStage(2);
        let i = 0;
        iv = setInterval(() => setTick(names[i++ % names.length]), 90);
      }, 2400)
    );
    t.push(
      setTimeout(() => {
        if (iv) clearInterval(iv);
        setStage(3);
      }, 4400)
    );
    t.push(setTimeout(() => setStage(4), 5200));
    return () => {
      t.forEach(clearTimeout);
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const w = winners[0];
  return (
    <div className={"fxi-st s" + stage + (leaving ? " out" : "")} role="dialog" aria-label="The First XI Man of the Match" onClick={() => (stage >= 4 ? close() : setStage(4))}>
      <style>{firstXiCss}</style>
      <div className="fxi-lights">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="fxi-screen">
        <div className={"fxi-scr" + (stage === 1 ? " on" : "")}>
          <div className="a">THE FIRST XI</div>
          <div className="b">
            Man of
            <br />
            the Match
          </div>
          <div className="c">Sunday 25 October · The Oval</div>
        </div>
        <div className={"fxi-scr" + (stage === 2 ? " on" : "")}>
          <div className="a">AND IT GOES TO</div>
          <div className="tk">{tick}</div>
        </div>
        <div className={"fxi-scr fxi-win" + (stage >= 3 ? " on" : "")}>
          <div className="faces">
            {winners.slice(0, 2).map((p) => (
              <Avatar key={p.id} name={p.name} avatarUrl={p.avatarUrl} className="ph" background={avatarFor(p.name).gradient} />
            ))}
          </div>
          <b>{winners.map((p) => p.name).join(" & ")}</b>
          <div className="c">
            {votes} of {total} votes
          </div>
        </div>
      </div>
      <div className="fxi-hang">
        <FirstXiMedal />
      </div>
      <div className="fxi-cap">
        <b>The First XI Medal</b>
        <span>{w ? `One of one. Into ${w.name.split(" ")[0]}'s cabinet.` : "One of one."}</span>
        <span className="sig">Wirral Community Football</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          Continue
        </button>
      </div>
      <div className="fxi-flash" />
    </div>
  );
}

export function FirstXiPennant({ signers, onProgramme, onDone }: { signers: string[]; onProgramme: () => void; onDone: () => void }) {
  const [flip, setFlip] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const close = (then?: () => void) => {
    setLeaving(true);
    setTimeout(() => {
      onDone();
      then?.();
    }, 360);
  };
  return (
    <div className={"fxi-dr" + (leaving ? " out" : "")} role="dialog" aria-label="Your First XI pennant">
      <style>{firstXiCss}</style>
      <div className="lab">FOR EVERYONE WHO PLAYED</div>
      <div className="hook" />
      <button className="pw" onClick={() => setFlip((f) => !f)} aria-label={flip ? "Turn the pennant back" : "Turn the pennant over"}>
        <span className={"pn" + (flip ? " flip" : "")}>
          <span className="side">
            <FirstXiPennantFront />
          </span>
          <span className="side back">
            <svg viewBox="0 0 230 330" aria-hidden="true">
              <path d="M6 0h218L115 326z" fill="#8e0d17" />
              <path d="M14 4h202L115 306z" fill="#b51b28" />
            </svg>
            <span className="sigs">
              {signers.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </span>
          </span>
        </span>
      </button>
      <div className="hint">{flip ? "All 22, signed" : "Tap the pennant to turn it over"}</div>
      <div className="own">
        <small>{signers.length} PENNANTS · {signers.length} PLAYERS · NEVER AGAIN</small>
        <p>The First XI pennant is in your trophy cabinet. Only the players from the club&apos;s first 11-a-side have one.</p>
        <div className="acts">
          <button className="main" onClick={() => close(onProgramme)}>
            Open the programme
          </button>
          <button onClick={() => close()}>Continue</button>
        </div>
      </div>
    </div>
  );
}

export const firstXiCss = `
.fxi-st{position:fixed;inset:0;z-index:148;overflow:hidden;color:#fff;background:linear-gradient(180deg,rgba(4,6,12,.4),rgba(4,6,12,.94) 80%),url(/season-hero.jpg) 50% 40%/cover;animation:fxiIn .35s both;cursor:pointer}
.fxi-st.out,.fxi-dr.out{animation:fxiOut .36s ease-in forwards}
@keyframes fxiIn{from{opacity:0}}
@keyframes fxiOut{to{opacity:0}}
.fxi-lights{position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);left:0;right:0;display:flex;justify-content:space-between;padding:0 30px}
.fxi-lights i{width:30px;height:10px;border-radius:3px;background:#2b3245;transition:background .4s,box-shadow .4s}
.fxi-st.s1 .fxi-lights i,.fxi-st.s2 .fxi-lights i,.fxi-st.s3 .fxi-lights i,.fxi-st.s4 .fxi-lights i{background:#fff6dc;box-shadow:0 0 22px 8px rgba(255,246,220,.6)}
.fxi-screen{position:absolute;left:16px;right:16px;top:calc(env(safe-area-inset-top,0px) + 46px);height:min(42vh,320px);max-width:520px;margin:0 auto;border-radius:10px;background:#03040a;border:6px solid #1c2233;box-shadow:0 0 0 2px #0a0d16,0 0 60px rgba(245,217,122,.15);overflow:hidden}
.fxi-screen::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(255,255,255,.04) 0 1px,transparent 1px 3px);pointer-events:none}
.fxi-scr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0;transition:opacity .4s}
.fxi-scr.on{opacity:1}
.fxi-scr .a{font:600 13px var(--font-oswald),sans-serif;letter-spacing:.3em;color:#f5d97a}
.fxi-scr .b{font:700 40px/1 var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:6px}
.fxi-scr .c{font-size:12px;color:#cbd5e1;margin-top:8px}
.fxi-scr .tk{font:700 50px var(--font-oswald),sans-serif;color:#f5d97a;margin-top:6px}
.fxi-win .faces{display:flex}
.fxi-win .ph{width:120px;height:120px;object-fit:cover;border-radius:50%;border:4px solid #f5d97a;box-shadow:0 0 40px rgba(245,217,122,.6);display:grid;place-items:center;font:700 44px var(--font-oswald),sans-serif;color:#fff}
.fxi-win .ph+.ph{margin-left:-24px}
.fxi-win b{font:700 30px var(--font-oswald),sans-serif;text-transform:uppercase;margin-top:8px;letter-spacing:.04em;padding:0 10px}
.fxi-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.fxi-st.s3 .fxi-flash{animation:fxiFl .5s ease-out}
@keyframes fxiFl{0%{opacity:.8}100%{opacity:0}}
.fxi-hang{position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + min(42vh,320px) + 30px);width:130px;margin-left:-65px;transform-origin:50% -320px;opacity:0;z-index:3}
.fxi-st.s4 .fxi-hang{opacity:1;animation:fxiMedal 1.3s cubic-bezier(.3,1.4,.5,1) both,fxiSway 3.2s ease-in-out 1.3s infinite}
@keyframes fxiMedal{from{transform:translateY(-420px) rotate(14deg)}}
@keyframes fxiSway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
.fxi-hang svg{width:100%;overflow:visible}
.fxi-cap{position:absolute;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);text-align:center;padding:0 20px;opacity:0;transition:opacity .6s .9s}
.fxi-st.s4 .fxi-cap{opacity:1}
.fxi-cap b{display:block;font:700 22px var(--font-oswald),sans-serif;letter-spacing:.06em;text-transform:uppercase}
.fxi-cap span{display:block;font-size:12.5px;color:#cbd5e1}
.fxi-cap .sig{font:700 26px var(--font-caveat),cursive;color:#f5d97a;margin-top:2px}
.fxi-cap button{margin-top:10px;height:44px;padding:0 28px;border-radius:14px;border:0;background:#f5d97a;color:#1a1405;font:800 14px var(--sans);cursor:pointer}
.fxi-dr{position:fixed;inset:0;z-index:148;display:flex;flex-direction:column;align-items:center;padding-top:calc(env(safe-area-inset-top,0px) + 26px);color:#fff;background:linear-gradient(180deg,rgba(8,10,16,.35),rgba(8,10,16,.88) 85%),url(/bench-kit.jpg) 50% 30%/cover;animation:fxiIn .35s both}
.fxi-dr .lab{font:600 11px var(--font-oswald),sans-serif;letter-spacing:.26em;color:#f5d97a}
.fxi-dr .hook{width:240px;height:14px;border-radius:7px;background:linear-gradient(180deg,#d9b56a,#8a6a28);margin-top:16px;box-shadow:0 4px 10px rgba(0,0,0,.6);position:relative;z-index:3}
.fxi-dr .pw{perspective:900px;margin-top:-4px;background:none;border:0;padding:0;cursor:pointer;animation:fxiDrop .9s cubic-bezier(.3,1.4,.5,1) both}
@keyframes fxiDrop{from{transform:translateY(-300px)}}
.fxi-dr .pn{position:relative;display:block;width:230px;height:330px;transform-style:preserve-3d;transition:transform 1s cubic-bezier(.4,.1,.2,1);transform-origin:50% 0}
.fxi-dr .pn.flip{transform:rotateY(180deg)}
.fxi-dr .side{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.fxi-dr .side.back{transform:rotateY(180deg)}
.fxi-dr .side svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 14px 20px rgba(0,0,0,.7))}
.fxi-dr .sigs{position:absolute;left:24px;right:24px;top:30px;height:210px;display:flex;flex-wrap:wrap;justify-content:center;align-content:flex-start;gap:0 8px;transform:rotate(-1deg)}
.fxi-dr .sigs span{font:700 16px/1.15 var(--font-caveat),cursive;color:#fff}
.fxi-dr .sigs span:nth-child(3n){color:#ffd5d8}
.fxi-dr .hint{margin-top:14px;font-size:12px;color:#cbd5e1}
.fxi-dr .own{margin-top:auto;width:100%;max-width:440px;padding:14px 18px calc(env(safe-area-inset-bottom,0px) + 18px)}
.fxi-dr .own small{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#f5d97a}
.fxi-dr .own p{margin:6px 0 12px;font-size:12.5px;color:#cbd5e1;line-height:1.5}
.fxi-dr .acts{display:flex;gap:8px}
.fxi-dr .acts button{flex:1;height:46px;border-radius:14px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#fff;font:800 13.5px var(--sans);cursor:pointer}
.fxi-dr .acts button.main{background:#f5d97a;color:#1a1405;border-color:#f5d97a}
@media (prefers-reduced-motion: reduce){.fxi-st,.fxi-st *,.fxi-dr,.fxi-dr *{animation:none!important;transition:none!important}.fxi-hang,.fxi-cap{opacity:1}}
`;
