import { useEffect, useMemo, useRef, useState } from "react";
import type { CabItem } from "../../lib/clubcabinet";
import { motionAllowed } from "./shared";
import type { Cabinet } from "./cabinet3d";

// The club's trophy cabinet at the top of History: real 3D trophies on a lit
// shelf (app/ui/cabinet3d.ts, loaded only when this mounts). Drag to spin,
// swipe to walk the shelf, tap to lift one and see how it was won. A newly
// won award is presented once per person, as gold pouring into its glass.

type Person = { name: string; avatar: string | null };
const PRESENT_DAYS = 7; // a new award still pours for people who open History within a week
const DAY = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();
const seenKey = (me: string | null, key: string) => `wcf-cab-${me ?? "anon"}-${key}`;
const seen = (me: string | null, key: string) => { try { return !!localStorage.getItem(seenKey(me, key)); } catch { return true; } };
const markSeen = (me: string | null, key: string) => { try { localStorage.setItem(seenKey(me, key), "1"); } catch {} };

export function ClubCabinet({ items, people, me, today }: { items: CabItem[]; people: Map<string, Person>; me: string | null; today: string }) {
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cab = useRef<Cabinet | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState({ center: -1, inspecting: -1 });
  const [poured, setPoured] = useState<number | null>(null);

  // Which award (if any) this person sees presented: the newest won one from
  // the last week that they haven't seen poured yet.
  const plan = useMemo(() => {
    const motion = motionAllowed();
    const fresh = (d: string | null) => !!d && d <= today && (Date.parse(today) - Date.parse(d)) / 864e5 <= PRESENT_DAYS;
    let pour = -1;
    if (motion) items.forEach((it, i) => { if (it.won && fresh(it.date) && !seen(me, it.key) && (pour < 0 || (it.date ?? "") > (items[pour].date ?? ""))) pour = i; });
    const lastWon = items.reduce((b, it, i) => (it.won && !it.season ? i : b), -1);
    return { motion, pour, start: pour >= 0 ? pour : Math.max(0, lastWon) };
  }, [items, me, today]);

  // Rebuild the shelf only when what's on it changes, not on every data refresh.
  const sig = useMemo(() => JSON.stringify(items), [items]);
  useEffect(() => {
    const el = root.current, cv = canvas.current;
    if (!el || !cv || !items.length) return;
    let gone = false, io: IntersectionObserver | null = null, lit = false;
    (async () => {
      try {
        const [{ mountCabinet }] = await Promise.all([import("./cabinet3d"), document.fonts.ready]);
        if (gone) return;
        const css = getComputedStyle(document.documentElement);
        const font = (v: string) => css.getPropertyValue(v).trim() || "sans-serif";
        const c = mountCabinet(
          el,
          cv,
          items.map((it, i) => ({ kind: it.kind, won: it.won, pour: i === plan.pour, season: it.season, plateTop: it.plateTop, plateName: it.plateName, ghostName: it.won ? (it.date ? DAY(it.date) : "") : it.plateName, engrave: it.engrave })),
          {
            fonts: { label: font("--font-oswald"), display: font("--font-sora") },
            still: !plan.motion,
            start: plan.start,
            onChange: (center, inspecting) => setView({ center, inspecting }),
            onPoured: (i) => { markSeen(me, items[i].key); setPoured(i); },
          }
        );
        cab.current = c;
        // Only draw while it's on screen; the lights come on (and a new award
        // is presented) once it's properly in view.
        io = new IntersectionObserver(
          (es) => {
            const e = es[0];
            c.setRunning(e.isIntersecting);
            if (e.intersectionRatio >= .6 && !lit) {
              lit = true;
              c.lightsOn();
              if (plan.pour >= 0) window.setTimeout(() => !gone && c.pour(plan.pour), 1500);
            }
          },
          { threshold: [0, .6] }
        );
        io.observe(cv);
      } catch {
        if (!gone) setFailed(true); // no WebGL: leave History as it was
      }
    })();
    return () => { gone = true; io?.disconnect(); cab.current?.destroy(); cab.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, plan.pour, plan.start, plan.motion, me]);

  if (failed || !items.length) return null;
  const c = view.center >= 0 ? view.center : plan.start;
  const it = items[c];
  const waiting = c === plan.pour && poured !== c;
  const won = items.filter((x, i) => x.won && (i !== plan.pour || poured === i)).length;
  const nm = (id: string) => people.get(id)?.name ?? "A player";
  const face = (id: string) => {
    const p = people.get(id);
    return p?.avatar ? <i style={{ backgroundImage: `url("${p.avatar}")` }} /> : <i>{(p?.name ?? "?")[0]}</i>;
  };
  const inspecting = view.inspecting >= 0 && view.inspecting === c && it.race;
  return (
    <section ref={root} className="wcf-cab" aria-label="The club's trophy cabinet">
      <style>{css}</style>
      <div className="hd">
        <span className="ey">The cabinet · Season {Number(today.slice(0, 4)) - 2025}</span>
        <span className="ct">{won} of {items.length} awarded</span>
      </div>
      <div className="hl" />
      <span className="hint">Drag to spin · tap to lift</span>
      <canvas ref={canvas} role="img" aria-label={items.map((x) => (x.won ? `${x.eyebrow}: ${x.title}` : `${x.title}, still to come`)).join(". ")} />
      <div className="cap" aria-live="polite">
        {inspecting && it.race ? (
          <div key={"r" + c}>
            <div className="e">{it.raceTitle}</div>
            <div className="race">
              {it.race.map((r, k) => (
                <div key={r.id} className={k ? "" : "w"}>
                  <span>{k + 1}</span>
                  <b>{nm(r.id)}</b>
                  <em>{r.a}</em>
                  <em>{r.b}</em>
                </div>
              ))}
            </div>
            {it.raceNote && <div className="l">{it.raceNote}</div>}
          </div>
        ) : waiting ? (
          <div key={"w" + c}>
            <div className="e">{it.eyebrow}</div>
            <div className="n g">Being presented</div>
            <div className="l">Watch the {it.kind === "potm" || it.kind === "pots" ? "cup" : "trophy"}.</div>
          </div>
        ) : (
          <div key={"n" + c} className={poured === c ? "rise" : ""}>
            <div className="e">{it.eyebrow}</div>
            <div className={"n" + (it.won ? "" : " g")}>
              {it.won && it.winnerIds.length === 1 && face(it.winnerIds[0])}
              {it.title}
            </div>
            <div className="l">
              {it.line}
              {it.race && <u>Tap the {it.kind === "gb" ? "boot" : "cup"} for the race</u>}
            </div>
          </div>
        )}
      </div>
      <div className="ticks" aria-hidden="true">
        {items.map((x, i) => (
          <span key={x.key} style={{ display: "contents" }}>
            {x.season && !items[i - 1]?.season && <s />}
            <b className={(x.won && (i !== plan.pour || poured === i) ? "won" : "") + (i === c ? " on" : "")} onClick={() => cab.current?.panTo(i)} />
          </span>
        ))}
      </div>
    </section>
  );
}

const css = `
.wcf-cab{position:relative;margin:18px 0 26px;padding:16px 0 14px;border-radius:20px;background:#07090f;border:1px solid rgba(245,217,122,.22);overflow:hidden}
.wcf-cab .hd{padding:0 16px;display:flex;justify-content:space-between;align-items:baseline}
.wcf-cab .ey{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#f5d97a}
.wcf-cab .ct{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#8b95a9}
.wcf-cab .hl{height:1px;margin:10px 16px 0;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,0));transform-origin:left;animation:wcfCabHl 1.2s cubic-bezier(.2,.8,.2,1) both}
@keyframes wcfCabHl{from{transform:scaleX(0)}}
.wcf-cab .hint{position:absolute;right:16px;top:58px;z-index:1;font:600 8.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(139,149,169,.8);pointer-events:none}
.wcf-cab canvas{display:block;width:100%;height:290px;touch-action:pan-y;cursor:grab;background:#06080d}
.wcf-cab .cap{padding:4px 16px 0;min-height:86px}
.wcf-cab .cap>div{animation:wcfCabIn .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes wcfCabIn{from{opacity:0;transform:translateY(8px)}}
.wcf-cab .cap .e{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#f5d97a}
.wcf-cab .cap .n{display:flex;align-items:center;gap:10px;margin-top:6px;font:800 21px var(--display);color:#fff}
.wcf-cab .cap .n i{width:30px;height:30px;border-radius:50%;flex:none;background:#1e293b center/cover;box-shadow:0 0 0 1.5px #f5d97a;display:grid;place-items:center;font:800 12px var(--display);font-style:normal;color:#fff}
.wcf-cab .cap .n.g{color:#8b95a9}
.wcf-cab .cap .l{margin-top:4px;font:400 12.5px var(--sans);color:#94a3b8}
.wcf-cab .cap u{display:block;margin-top:2px;text-decoration:none;color:#f5d97a}
.wcf-cab .cap .rise .n i{animation:wcfCabIris .7s cubic-bezier(.2,.8,.2,1) both}
@keyframes wcfCabIris{from{clip-path:circle(0 at 50% 50%)}to{clip-path:circle(60% at 50% 50%)}}
.wcf-cab .race{display:grid;gap:4px;margin-top:8px}
.wcf-cab .race div{display:grid;grid-template-columns:14px 1fr auto auto;gap:10px;align-items:baseline;font:400 12.5px var(--sans);color:#94a3b8;font-variant-numeric:tabular-nums}
.wcf-cab .race span{font:600 10px var(--font-oswald),sans-serif;color:#64748b}
.wcf-cab .race b{font:700 14px var(--display);color:#cbd5e1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-cab .race div.w b{color:#f5d97a}
.wcf-cab .race em{font-style:normal}
.wcf-cab .ticks{display:flex;gap:6px;padding:12px 16px 0;align-items:center}
.wcf-cab .ticks b{flex:1;height:2px;border-radius:2px;background:rgba(255,255,255,.12);transition:background .3s;cursor:pointer;position:relative}
.wcf-cab .ticks b::after{content:"";position:absolute;inset:-10px 0}
.wcf-cab .ticks b.won{background:rgba(245,217,122,.45)}
.wcf-cab .ticks b.on{background:#f5d97a}
.wcf-cab .ticks s{width:1px;height:10px;background:rgba(255,255,255,.2);margin:0 4px}
@media (prefers-reduced-motion:reduce){.wcf-cab .hl,.wcf-cab .cap>div,.wcf-cab .cap .rise .n i{animation:none}}
`;
