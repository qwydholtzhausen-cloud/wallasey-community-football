import { useEffect, useState } from "react";

// The night before a release: from the kick-off of a month's last game until
// 8am the next morning (lib/time.ts monthReleaseAt), a sealed card on
// Fixtures dressed in that month's Wrapped theme, counting down to what's
// coming out - your Wrapped, Player of the Month, Team of the Month. It goes
// at 8am, when the real reveals take over.

export type EveItem = { label: string; kicker: string };

const lock = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

// One digit that rolls in from above whenever it changes.
const Digit = ({ v }: { v: string }) => (
  <span className="wcf-eve-dg">
    <i key={v}>{v}</i>
  </span>
);

export function ReleaseEve({ title, edition, accent, photo, fog, releaseMs, items }: { title: string; edition: string | null; accent: string; photo: string; fog: boolean; releaseMs: number; items: EveItem[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((releaseMs - now) / 1000));
  // More than a day out (an admin preview): days, hours, minutes.
  const days = left >= 86400;
  const hms = (days ? [Math.min(99, Math.floor(left / 86400)), Math.floor(left / 3600) % 24, Math.floor(left / 60) % 60] : [Math.floor(left / 3600), Math.floor(left / 60) % 60, left % 60]).map((n) => String(n).padStart(2, "0"));
  const out = new Date(releaseMs);
  const when = left < 86400 && out.getDate() !== new Date(now).getDate() ? "Out tomorrow · 8am" : left < 86400 ? "Out today · 8am" : `Out ${out.toLocaleDateString("en-GB", { weekday: "short" })} · 8am`;
  return (
    <section className="wcf-eve" style={{ ["--eve" as string]: accent }} aria-label={`${title}: ${when.replace(" · ", " at ").toLowerCase()}`}>
      <style>{eveCss}</style>
      <div className="ph" style={{ backgroundImage: `url(${photo})` }} />
      <div className="sh" />
      {fog && (
        <>
          <div className="fog" />
          <div className="fog b" />
        </>
      )}
      <div className="in">
        <div className="ey">
          <span>{when}</span>
          {edition && <span className="ed">{edition}</span>}
        </div>
        <span className="m">
          <span>{title}</span>
        </span>
        <div className="cd" aria-label={days ? `${hms[0]} days ${hms[1]} hours left` : `${hms[0]} hours ${hms[1]} minutes left`}>
          <Digit v={hms[0][0]} />
          <Digit v={hms[0][1]} />
          <span className="col">:</span>
          <Digit v={hms[1][0]} />
          <Digit v={hms[1][1]} />
          <span className="col">:</span>
          <Digit v={hms[2][0]} />
          <Digit v={hms[2][1]} />
          <span className="lbl">{days ? "Days · hrs · mins" : "Until it's out"}</span>
        </div>
        <div className="tiles" style={{ gridTemplateColumns: `repeat(${items.length},1fr)` }}>
          {items.map((it, i) => (
            <div key={it.label} className="tl" style={{ ["--i" as string]: i }}>
              {lock}
              <small>{it.kicker}</small>
              <b>{it.label}</b>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const E = "cubic-bezier(.2,.75,.2,1)";
const eveCss = `
@property --wcf-eve-a{syntax:"<angle>";inherits:false;initial-value:0deg}
.wcf-eve{--eve:#f5d97a;position:relative;border-radius:22px;overflow:hidden;margin:0 0 18px;height:270px;background:#07090f;isolation:isolate}
.wcf-eve::before{content:"";position:absolute;inset:0;border-radius:22px;padding:1.2px;background:conic-gradient(from var(--wcf-eve-a),transparent 0 62%,var(--eve) 78%,#f5d97a 88%,transparent 100%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;z-index:6;animation:wcfEveSpin 5s linear infinite}
@keyframes wcfEveSpin{to{--wcf-eve-a:360deg}}
.wcf-eve .ph{position:absolute;inset:0;background-size:cover;background-position:center 30%;opacity:.5;transform:scale(1.14);animation:wcfEveKb 10s ${E} forwards}
@keyframes wcfEveKb{to{transform:scale(1.02)}}
.wcf-eve .sh{position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,9,15,.35),rgba(7,9,15,.55) 40%,#07090f 92%)}
.wcf-eve .fog{position:absolute;left:-40%;right:-40%;height:120px;bottom:20px;background:radial-gradient(40% 60% at 30% 50%,rgba(220,220,235,.14),transparent 70%),radial-gradient(35% 50% at 75% 60%,rgba(220,220,235,.12),transparent 70%);filter:blur(8px);animation:wcfEveFog 9s linear infinite alternate}
.wcf-eve .fog.b{bottom:70px;opacity:.7;animation-duration:13s;animation-direction:alternate-reverse}
@keyframes wcfEveFog{from{transform:translateX(-12%)}to{transform:translateX(12%)}}
.wcf-eve .in{position:absolute;inset:0;z-index:5;padding:16px 18px;display:flex;flex-direction:column}
.wcf-eve .ey{display:flex;justify-content:space-between;gap:10px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.3em;text-transform:uppercase;color:var(--eve);animation:wcfEveIn .9s ${E} .2s both}
.wcf-eve .ey .ed{color:#cbd5e1;letter-spacing:.2em}
.wcf-eve .m{display:block;overflow:hidden;margin-top:4px}
.wcf-eve .m span{display:block;font:800 34px/1.05 var(--display);letter-spacing:-.02em;color:#fff;text-shadow:0 0 30px color-mix(in srgb,var(--eve) 35%,transparent);animation:wcfEveRise 1.1s ${E} .4s both}
.wcf-eve .cd{display:flex;align-items:flex-end;gap:2px;margin-top:10px;animation:wcfEveIn .9s ${E} .8s both}
.wcf-eve-dg{position:relative;width:24px;height:38px;overflow:hidden}
.wcf-eve-dg i{position:absolute;inset:0;font:800 34px/38px var(--display);font-style:normal;text-align:center;font-variant-numeric:tabular-nums;background:linear-gradient(100deg,#c9a24a,#fff3c4 45%,#f5d97a 60%,#c9a24a);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wcfEveRoll .45s ${E} both}
@keyframes wcfEveRoll{from{transform:translateY(-100%)}}
.wcf-eve .col{font:800 28px/38px var(--display);color:rgba(245,217,122,.6);margin:0 3px}
.wcf-eve .lbl{margin-left:10px;padding-bottom:6px;font:600 8.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#8b95a9}
.wcf-eve .tiles{display:grid;gap:8px;margin-top:auto}
.wcf-eve .tl{position:relative;height:64px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.06);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);display:flex;flex-direction:column;justify-content:flex-end;padding:8px;animation:wcfEveIn .8s ${E} calc(1.2s + var(--i) * .15s) both,wcfEveLit .8s ${E} calc(2.2s + var(--i) * .7s) both}
.wcf-eve .tl svg{position:absolute;right:8px;top:8px;width:12px;height:12px;stroke:#cbd5e1;fill:none;stroke-width:2}
.wcf-eve .tl b{font:700 11px/1.2 var(--sans);color:#fff}
.wcf-eve .tl small{font:600 8px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;color:var(--eve)}
.wcf-eve .tl::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,transparent,var(--eve),transparent);animation:wcfEveLine .8s ${E} calc(2.2s + var(--i) * .7s) both}
@keyframes wcfEveLit{from{box-shadow:none;filter:brightness(.55)}to{box-shadow:0 0 24px -8px color-mix(in srgb,var(--eve) 60%,transparent)}}
@keyframes wcfEveLine{from{transform:scaleX(0)}}
@keyframes wcfEveIn{from{opacity:0;transform:translateY(8px)}}
@keyframes wcfEveRise{from{transform:translateY(110%)}}
@media (prefers-reduced-motion:reduce){.wcf-eve *,.wcf-eve::before{animation:none!important}}
`;
