import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, avatarFor, motionAllowed } from "./shared";
import type { Chapter, HEvent, Scene } from "../../lib/history";

// Results › History ("Our story"). The story itself comes from
// lib/history.ts; this draws it: a title sequence (first visit each
// month), a chapter per month with a gold line that draws down as you go,
// a little animated scene for each big moment, an Auto-play that tours
// them one by one, and for admins, "Add a moment" for things the data
// can't know - back-dated to the day they happened.

type Person = { name: string; avatar: string | null };
type Data = { chapters: Chapter[]; upcoming: { title: string; text: string } | null; totals: { members: number; games: number; goals: number; players: number } };
type NewMoment = { happened_on: string; title: string; body: string | null; kind: "note" | "goal"; player_ids: string[] };

const firstName = (n: string) => n.split(" ")[0].replace(/[()]/g, "");
const dayLabel = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();
const monthLabel = (k: string) => new Date(k + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).toUpperCase();
const CH = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE"];

function Ball() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="#f5f6f8" stroke="#0d0d1a" strokeWidth="1" />
      <path d="M12 7.2l3.4 2.5-1.3 4h-4.2l-1.3-4z" fill="#0d0d1a" />
      <path d="M12 7.2V3.5M15.4 9.7l3.6-1.2M14.1 13.7l2.2 3M9.9 13.7l-2.2 3M8.6 9.7L5 8.5" stroke="#0d0d1a" strokeWidth="1" />
    </svg>
  );
}

export function HistoryPage({
  data,
  people,
  isAdmin,
  today,
  onAdd,
  onDelete,
}: {
  data: Data;
  people: Map<string, Person>;
  isAdmin: boolean;
  today: string;
  onAdd: (m: NewMoment) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const story = useRef<HTMLDivElement>(null);
  const motion = motionAllowed();
  const monthKey = today.slice(0, 7);
  const [intro] = useState(() => {
    if (!motion) return false;
    try {
      const k = `wcf-history-intro-${monthKey}`;
      if (localStorage.getItem(k)) return false;
      localStorage.setItem(k, "1");
      return true;
    } catch {
      return false;
    }
  });
  const [playing, setPlaying] = useState(false);
  const [adding, setAdding] = useState(false);
  const face = (id: string, cls = "") => {
    const p = people.get(id);
    const n = p?.name ?? "?";
    return <Avatar key={id} name={n} avatarUrl={p?.avatar} className={"wcf-hs-face " + cls} background={avatarFor(n).gradient} />;
  };

  // Reveal each moment as it comes into view, and draw the gold line down to it.
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const all = Array.from(host.querySelectorAll<HTMLElement>(".wcf-hs-ev"));
    const fill = host.querySelector<HTMLElement>(".wcf-hs-rail i");
    const reveal = (el: HTMLElement) => {
      if (el.classList.contains("in")) return;
      el.classList.add("in");
      if (fill && story.current) {
        const reached = all.filter((e) => e.classList.contains("in")).reduce((m, e) => Math.max(m, e.offsetTop + 14), 0);
        fill.style.height = reached + "px";
      }
      el.querySelectorAll<HTMLElement>("[data-to]").forEach((b) => {
        const to = Number(b.dataset.to);
        if (!motion) return void (b.textContent = String(to));
        const t0 = performance.now();
        const f = () => {
          const k = Math.min(1, (performance.now() - t0) / 1300);
          b.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(f);
        };
        setTimeout(f, 300);
      });
      el.querySelectorAll<HTMLElement>(".wcf-hs-step").forEach((s, i, list) =>
        setTimeout(() => {
          s.classList.add("on");
          const num = el.querySelector(".wcf-hs-chainnum");
          if (num) num.textContent = s.dataset.g ?? "";
          if (i === list.length - 1) s.classList.add("top");
        }, motion ? 350 + i * 420 : 0)
      );
      el.querySelectorAll<HTMLElement>(".wcf-hs-mosaic > *").forEach((f, i) => setTimeout(() => f.classList.add("on"), motion ? 200 + i * 28 : 0));
      const anim = el.querySelector<SVGAnimateMotionElement>("animateMotion");
      if (anim) {
        if (!motion) el.classList.add("go", "contact", "hit");
        else {
          setTimeout(() => {
            el.classList.add("go");
            try {
              anim.beginElement();
            } catch {}
          }, 450);
          setTimeout(() => el.classList.add("contact"), 1140);
          setTimeout(() => el.classList.add("hit"), 1500);
        }
      }
    };
    if (!motion) {
      all.forEach(reveal);
      return;
    }
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && reveal(e.target as HTMLElement)), { threshold: 0.35 });
    all.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [data, motion]);

  // Totals count up under the title.
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const els = Array.from(host.querySelectorAll<HTMLElement>(".wcf-hs-tot [data-n]"));
    if (!intro) return void els.forEach((b) => (b.textContent = b.dataset.n ?? ""));
    const timers = els.map((b, i) =>
      setTimeout(() => {
        const to = Number(b.dataset.n), t0 = performance.now();
        const f = () => {
          const k = Math.min(1, (performance.now() - t0) / 1100);
          b.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(f);
        };
        f();
      }, 1500 + i * 120)
    );
    return () => timers.forEach(clearTimeout);
  }, [intro]);

  // Auto-play: one moment at a time, waiting for its scene; touching the screen takes over.
  useEffect(() => {
    if (!playing) return;
    const host = root.current;
    if (!host) return;
    const list = Array.from(host.querySelectorAll<HTMLElement>(".wcf-hs-tot, .wcf-hs-ev"));
    const wait = (el: HTMLElement) =>
      el.querySelector(".wcf-hs-mb") ? 5200 : el.querySelector(".wcf-hs-chain") ? 3600 : el.querySelector(".wcf-hs-mosaic") ? 2600 : el.querySelector(".wcf-hs-goal, .wcf-hs-board, .wcf-hs-big, .wcf-hs-twin") ? 2400 : 1500;
    let k = Math.max(0, list.findIndex((el) => el.getBoundingClientRect().top > 120 && !el.classList.contains("wcf-hs-tot")));
    let timer = 0;
    const next = () => {
      if (k >= list.length) return setPlaying(false);
      const el = list[k++];
      el.scrollIntoView({ behavior: motion ? "smooth" : "auto", block: el.offsetHeight > window.innerHeight * 0.7 ? "start" : "center" });
      timer = window.setTimeout(next, 700 + wait(el));
    };
    next();
    const stop = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.(".wcf-hs-pill")) return;
      setPlaying(false);
    };
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("wheel", stop, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("wheel", stop);
    };
  }, [playing, motion]);

  const scene = (s: Scene | null, e: HEvent) => {
    if (!s) return null;
    switch (s.type) {
      case "people":
        return (
          <div className="wcf-hs-who">
            {s.ids.map((id) => face(id))}
            <span>{s.ids.length > 2 ? `${s.ids.length} players` : s.ids.map((id) => firstName(people.get(id)?.name ?? "")).join(" & ")}</span>
          </div>
        );
      case "score":
        return (
          <div className="wcf-hs-card">
            <div className="wcf-hs-board">
              <span className={"t" + (s.left.red ? " r" : "")}>{s.left.name}</span>
              <Flip to={s.left.goals} delay={0.5} />
              <span className="dash">–</span>
              <Flip to={s.right.goals} delay={0.7} />
              <span className={"t" + (s.right.red ? " r" : "")}>{s.right.name}</span>
            </div>
          </div>
        );
      case "goal":
        return <GoalScene date={s.date} title={e.title} line={e.text} who={s.id ? people.get(s.id) ?? null : null} face={s.id ? face(s.id) : null} leapFace={s.id ? face(s.id, "leap") : null} />;
      case "matchball":
        return (
          <>
            {s.balls && (
              <div className="wcf-hs-card wcf-hs-seven">
                {face(s.scorerId, "big")}
                <div className="balls">
                  {Array.from({ length: s.goals }, (_, i) => (
                    <span key={i} style={{ ["--i" as string]: i }}>
                      <Ball />
                    </span>
                  ))}
                </div>
              </div>
            )}
            <MatchBall signatures={s.signatures} scorer={firstName(people.get(s.scorerId)?.name ?? "")} plate={s.plate} id={e.key} />
          </>
        );
      case "mosaic":
        return <div className="wcf-hs-card"><div className="wcf-hs-mosaic">{s.ids.map((id) => face(id))}</div></div>;
      case "count":
        return (
          <div className="wcf-hs-card wcf-hs-big">
            <b data-to={s.n}>0</b>
            <span>{s.label}</span>
          </div>
        );
      case "chain":
        return (
          <div className="wcf-hs-card wcf-hs-chainbox">
            <span className="wcf-hs-chainnum">{s.steps[0]?.goals}</span>
            <div className="wcf-hs-chain">
              {s.steps.map((st) => (
                <div key={st.date + st.id} className="wcf-hs-step" data-g={st.goals}>
                  {face(st.id)}
                  <div className="bar" style={{ ["--h" as string]: `${Math.round((st.goals / Math.max(...s.steps.map((x) => x.goals))) * 72)}%` }}>{st.goals}</div>
                  <small>{new Date(st.date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}</small>
                </div>
              ))}
            </div>
          </div>
        );
      case "twin":
        return (
          <div className="wcf-hs-card wcf-hs-twin">
            {s.kickoffs.map((k, i) => (
              <Pitch key={k + i} k={i} time={k} soldOut={s.soldOut} />
            ))}
          </div>
        );
    }
  };

  let chapterNo = 0;
  return (
    <div ref={root} className={"wcf-hs" + (motion ? "" : " still")}>
      <style>{historyCss}</style>
      {playing && (
        <button type="button" className="wcf-hs-pill on" onClick={() => setPlaying(false)}>
          <i />
          Pause
        </button>
      )}
      <div className={"wcf-hs-intro" + (intro ? " play" : "")}>
        <div className="bg" />
        <div className="sc" />
        <div className="beam l" />
        <div className="beam r" />
        <img className="crest" src="/crest.png" alt="" />
        <div className="k">OUR STORY · EST. 2026</div>
        <h2>
          Wirral
          <br />
          <span>Community</span>
          <br />
          Football
        </h2>
        <p>From the first sign-up to now: every first, every record, every big night.</p>
        <div className="wcf-hs-tot">
          <div><b data-n={data.totals.members}>{intro ? 0 : data.totals.members}</b><span>members</span></div>
          <div><b data-n={data.totals.games}>{intro ? 0 : data.totals.games}</b><span>games</span></div>
          <div><b data-n={data.totals.goals}>{intro ? 0 : data.totals.goals}</b><span>goals</span></div>
          <div><b data-n={data.totals.players}>{intro ? 0 : data.totals.players}</b><span>players</span></div>
        </div>
        <button type="button" className="wcf-hs-play" onClick={() => setPlaying(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
          Auto-play the story
        </button>
      </div>
      <div ref={story} className="wcf-hs-story">
        <div className="wcf-hs-rail"><i /></div>
        {data.chapters.map((c) => {
          chapterNo++;
          return (
            <div key={c.monthKey}>
              <div className="wcf-hs-chap">
                <small>CHAPTER {CH[chapterNo - 1] ?? chapterNo} · {monthLabel(c.monthKey)}</small>
                <b>{c.title}</b>
              </div>
              {c.events.map((e) => (
                <div key={e.key} className="wcf-hs-ev">
                  <div className="d">{dayLabel(e.date)}</div>
                  <h4>{e.title}</h4>
                  {e.text && <p>{e.text}</p>}
                  {scene(e.scene, e)}
                  {e.added && (
                    <div className="wcf-hs-added">
                      <span>ADDED BY AN ADMIN</span>
                      {isAdmin && (
                        <button type="button" onClick={() => onDelete(e.added!.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        {data.upcoming && (
          <div className="wcf-hs-ev wcf-hs-end">
            <small>TO BE CONTINUED</small>
            <b>{data.upcoming.title.replace("11-a-side", "11‑a‑side")}</b>
            <p>{data.upcoming.text}</p>
          </div>
        )}
        {isAdmin && (
          <button type="button" className="wcf-hs-add" onClick={() => setAdding(true)}>
            + Add a moment
          </button>
        )}
      </div>
      {adding && <AddMoment people={people} today={today} onClose={() => setAdding(false)} onAdd={onAdd} />}
    </div>
  );
}

function Flip({ to, delay }: { to: number; delay: number }) {
  return (
    <span className="wcf-hs-flip" style={{ ["--fd" as string]: `${delay}s` }}>
      <span className="o">0</span>
      <span className="n">{to}</span>
    </span>
  );
}

// A goal moment as a little floodlit scene. Each moment uses its own words;
// "Nº1" only for the first ever goal; a header (title or line mentions
// one) comes in as a high cross and is nodded down into the net.
function GoalScene({ date, title, line, who, face, leapFace }: { date: string; title: string; line: string; who: Person | null; face: React.ReactNode; leapFace: React.ReactNode }) {
  const header = /head/i.test(title + " " + line);
  const firstEver = /first ever goal/i.test(title);
  // A header: the cross comes in high, the scorer leaps into it (their own
  // photo in a gold ring), a burst on contact, then it's nodded down in.
  const P = header ? "M10 46 Q 92 0 168 78 L 236 112" : "M40 226 C 90 160, 170 84, 264 78";
  const net = header ? { x: "74%", y: "45%" } : { x: "82%", y: "31%" };
  const conf = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * 6.283, r = 60 + (i % 4) * 18;
        return <i key={i} style={{ ["--cx" as string]: `${Math.round(Math.cos(a) * r)}px`, ["--cy" as string]: `${Math.round(Math.sin(a) * r * 0.8)}px`, ["--cr" as string]: `${(i * 67) % 360}deg`, background: i % 3 ? "#E42A36" : "#f5f6f8" }} />;
      }),
    []
  );
  const d = new Date(date + "T12:00:00Z");
  const short = `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toUpperCase()} ${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCFullYear()).slice(2)}`;
  return (
    <div className="wcf-hs-card wcf-hs-goal">
      <svg viewBox="0 0 320 250" aria-hidden="true">
        <defs>
          <linearGradient id="hsPg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b2416" /><stop offset="1" stopColor="#103d24" /></linearGradient>
          <radialGradient id="hsFl" cx="50%" cy="0%" r="80%"><stop offset="0" stopColor="rgba(255,244,214,.35)" /><stop offset="1" stopColor="rgba(255,244,214,0)" /></radialGradient>
          <linearGradient id="hsTr" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="rgba(245,217,122,0)" /><stop offset="1" stopColor="#f5d97a" /></linearGradient>
        </defs>
        <rect width="320" height="250" fill="url(#hsPg)" />
        <g opacity=".05" fill="#fff">{[0, 1, 2, 3, 4].map((i) => <rect key={i} x="0" y={70 + i * 36} width="320" height="18" />)}</g>
        <rect width="320" height="250" fill="url(#hsFl)" />
        <path d="M0 176 Q160 150 320 176" stroke="rgba(255,255,255,.18)" strokeWidth="1.5" fill="none" />
        <path d="M120 138 H300 M120 138 L104 176 M300 138 L316 176" stroke="rgba(255,255,255,.18)" strokeWidth="1.2" fill="none" />
        <g className="net">
          <path d="M140 62 L292 62 L292 138 L140 138 Z" fill="rgba(255,255,255,.035)" />
          <g stroke="rgba(226,232,240,.32)" strokeWidth=".8">
            {Array.from({ length: 17 }, (_, i) => <path key={"v" + i} d={`M${140 + i * 9.5} 62 V138`} />)}
            {Array.from({ length: 10 }, (_, i) => <path key={"h" + i} d={`M140 ${62 + i * 8.4} H292`} />)}
          </g>
          <path d="M140 138 V62 H292 V138" stroke="#f5f6f8" strokeWidth="4.5" fill="none" strokeLinecap="round" />
        </g>
        <path className="trail" d={P} stroke="url(#hsTr)" strokeWidth="5" fill="none" strokeLinecap="round" />
        <g>
          <g transform="translate(-11 -11)"><svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#f5f6f8" stroke="#0d0d1a" strokeWidth="1" /><path d="M12 7.2l3.4 2.5-1.3 4h-4.2l-1.3-4z" fill="#0d0d1a" /></svg></g>
          {header ? (
            <animateMotion dur="1.05s" begin="indefinite" fill="freeze" path={P} keyPoints="0;0.6;1" keyTimes="0;0.66;1" calcMode="linear" />
          ) : (
            <animateMotion dur="1.05s" begin="indefinite" fill="freeze" path={P} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".3 .6 .4 1" />
          )}
        </g>
      </svg>
      <span className="flash" style={{ ["--fx" as string]: net.x, ["--fy" as string]: net.y }} />
      <span className="conf" style={{ ["--fx" as string]: net.x, ["--fy" as string]: net.y }}>{conf}</span>
      {header && (
        <>
          <span className="leapwrap">{leapFace}</span>
          <span className="burst">
            <i />
            <i />
            <b>HEADER!</b>
          </span>
        </>
      )}
      <span className="sb">{header ? "HEADER" : "GOAL"}<small>{short}</small></span>
      {firstEver && <span className="no1">Nº1<small>GOAL</small></span>}
      {who && (
        <span className="hero">
          {face}
          <span>
            <b>{who.name}</b>
            <span>{firstEver ? "The club's first ever goal" : line || title}</span>
          </span>
        </span>
      )}
    </div>
  );
}

function MatchBall({ signatures, scorer, plate, id }: { signatures: string[]; scorer: string; plate: [string, string]; id: string }) {
  let skipped = false;
  const others = signatures.filter((n) => (n === scorer && !skipped ? ((skipped = true), false) : true)).slice(0, 21);
  const g = "hsGold" + id.replace(/[^a-z0-9]/gi, "");
  return (
    <div className="wcf-hs-card">
      <div className="wcf-hs-mb" style={{ ["--n" as string]: others.length }}>
        <span className="spot" />
        <svg className="gb" viewBox="0 0 190 190" aria-hidden="true">
          <defs>
            <radialGradient id={g} cx="35%" cy="30%"><stop offset="0" stopColor="#fff8dc" /><stop offset=".45" stopColor="#f5d97a" /><stop offset="1" stopColor="#9c7414" /></radialGradient>
          </defs>
          <circle cx="95" cy="95" r="88" fill={`url(#${g})`} />
          <path d="M95 60l24 17-9 28H80l-9-28z" fill="rgba(90,62,10,.5)" />
          <g stroke="rgba(90,62,10,.42)" strokeWidth="2.6" fill="none"><path d="M95 7v53M119 77l42-15M110 105l24 38M80 105l-24 38M71 77L29 62" /></g>
          {others.map((n, i) => {
            const a = (i / others.length) * Math.PI * 2 - 1.2, r = 52 + (i % 3) * 10;
            const x = 95 + Math.cos(a) * r, y = 95 + Math.sin(a) * r, rot = (a * 180) / Math.PI + 90 + (i % 2 ? -14 : 12);
            return (
              <text key={i} className="sig" style={{ ["--i" as string]: i }} x={x} y={y} transform={`rotate(${rot} ${x} ${y})`} textAnchor="middle" fontSize="14" fill="#3b2a07">
                {n}
              </text>
            );
          })}
          <text className="sig me" x="95" y="152" transform="rotate(-8 95 152)" textAnchor="middle" fontSize="32" fill="#8b1a1a">
            {scorer}
          </text>
          <ellipse cx="66" cy="50" rx="28" ry="15" fill="rgba(255,255,255,.34)" transform="rotate(-30 66 50)" />
        </svg>
        <span className="case" />
        <div className="plinth">
          <div className="top" />
          <div className="body">
            <span className="plate">{plate[0]}<br />{plate[1]}</span>
          </div>
        </div>
        <div className="signed">Signed by all {signatures.length} who played</div>
      </div>
    </div>
  );
}

function Pitch({ k, time, soldOut }: { k: number; time: string; soldOut: boolean }) {
  return (
    <div className={"wcf-hs-tp p" + (k + 1)}>
      <svg viewBox="0 0 160 150" aria-hidden="true">
        <defs>
          <linearGradient id={"hsTp" + k} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0c2a18" /><stop offset="1" stopColor="#14502e" /></linearGradient>
          <radialGradient id={"hsCone" + k} cx="50%" cy="0%" r="100%"><stop offset="0" stopColor="rgba(255,246,220,.75)" /><stop offset="1" stopColor="rgba(255,246,220,0)" /></radialGradient>
        </defs>
        <path className="turf" d="M34 52 L126 52 L152 138 L8 138 Z" fill={`url(#hsTp${k})`} />
        <g className="stripes" fill="rgba(255,255,255,.045)"><path d="M31 62 L129 62 L132 72 L28 72 Z" /><path d="M25 82 L135 82 L139 94 L21 94 Z" /><path d="M18 106 L142 106 L146 120 L14 120 Z" /></g>
        <g stroke="rgba(255,255,255,.5)" strokeWidth="1.2" fill="none"><path d="M34 52 L126 52 L152 138 L8 138 Z" /><path d="M21 95 H139" /><ellipse cx="80" cy="95" rx="18" ry="6" /><path d="M62 52 v6 h36 v-6" /><path d="M52 138 v-12 h56 v12" /></g>
        <g className="lights"><path d="M18 8 L4 140 L60 140 Z" fill={`url(#hsCone${k})`} opacity=".55" /><path d="M142 8 L100 140 L156 140 Z" fill={`url(#hsCone${k})`} opacity=".55" /></g>
        <g fill="#cbd5e1"><rect x="16" y="6" width="5" height="40" rx="1" /><rect x="139" y="6" width="5" height="40" rx="1" /><rect className="lamp" x="11" y="3" width="15" height="6" rx="1.5" /><rect className="lamp" x="134" y="3" width="15" height="6" rx="1.5" /></g>
      </svg>
      <span className="ko">{time}</span>
      {soldOut && <span className="sold">SOLD OUT</span>}
    </div>
  );
}

function AddMoment({ people, today, onClose, onAdd }: { people: Map<string, Person>; today: string; onClose: () => void; onAdd: (m: NewMoment) => Promise<boolean> }) {
  const [date, setDate] = useState(today.slice(0, 10));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"note" | "goal">("note");
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const list = [...people.entries()].filter(([, p]) => p.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a[1].name.localeCompare(b[1].name)).slice(0, 40);
  const ok = title.trim().length >= 2 && !!date && date <= today.slice(0, 10) && (kind === "note" || picked.length === 1);
  return (
    <div className="wcf-hs-sheetwrap" onClick={onClose}>
      <form
        className="wcf-hs-sheet"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok || busy) return;
          setBusy(true);
          const saved = await onAdd({ happened_on: date, title: title.trim(), body: body.trim() || null, kind, player_ids: picked });
          setBusy(false);
          if (saved) onClose();
        }}
      >
        <div className="grab" />
        <h3>Add a moment to our story</h3>
        <p className="sub">It slots into the story on the date it happened.</p>
        <label>
          <span>When did it happen?</span>
          <input type="date" value={date} max={today.slice(0, 10)} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <div className="kinds">
          <button type="button" className={kind === "note" ? "on" : ""} onClick={() => setKind("note")}>Moment</button>
          <button type="button" className={kind === "goal" ? "on" : ""} onClick={() => { setKind("goal"); setPicked((p) => p.slice(0, 1)); }}>A goal (with the goal scene)</button>
        </div>
        <label>
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={kind === "goal" ? "e.g. The first ever goal" : "e.g. New club kit arrives"} required />
        </label>
        <label>
          <span>A line about it (optional)</span>
          <input value={body} onChange={(e) => setBody(e.target.value)} maxLength={240} placeholder="e.g. Volleyed in off the bar" />
        </label>
        <label>
          <span>{kind === "goal" ? "Who scored?" : "Who's in it? (up to 3, optional)"}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players" />
        </label>
        {picked.length > 0 && (
          <div className="picked">
            {picked.map((id) => (
              <button key={id} type="button" onClick={() => setPicked((p) => p.filter((x) => x !== id))}>
                {people.get(id)?.name} ×
              </button>
            ))}
          </div>
        )}
        <div className="people">
          {list.map(([id, p]) => (
            <button
              key={id}
              type="button"
              className={picked.includes(id) ? "on" : ""}
              onClick={() =>
                setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : kind === "goal" ? [id] : cur.length >= 3 ? cur : [...cur, id]))
              }
            >
              {p.name}
            </button>
          ))}
        </div>
        <button type="submit" className="save" disabled={!ok || busy}>
          {busy ? "Adding…" : "Add to our story"}
        </button>
        <button type="button" className="cancel" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}

const historyCss = `
.wcf-hs{position:relative;max-width:100%;overflow-x:clip;touch-action:pan-y}
.wcf-hs-face{border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;color:#fff;flex:none;width:32px;height:32px;font-size:11px;border:2px solid #f5d97a}
.wcf-hs-pill{position:fixed;left:16px;bottom:calc(92px + env(safe-area-inset-bottom,0px));z-index:40;box-shadow:0 10px 24px -8px #000;display:flex;align-items:center;gap:7px;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid rgba(245,217,122,.55);background:rgba(10,12,20,.85);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#f5d97a;font-weight:800;font-size:12px;cursor:pointer;font-family:var(--sans)}
.wcf-hs-pill i{width:7px;height:7px;border-radius:50%;background:#f5d97a}
.wcf-hs-pill.on i{animation:wcfHsPulse 1.2s infinite}
@keyframes wcfHsPulse{50%{opacity:.25}}
.wcf-hs-intro{position:relative;min-height:520px;border-radius:22px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;padding:0 18px 22px;border:1px solid rgba(245,217,122,.3);margin-bottom:6px}
.wcf-hs-intro .bg{position:absolute;inset:0;background:url('/season-hero.jpg') center 35%/cover;opacity:.55}
.wcf-hs-intro .sc{position:absolute;inset:0;background:linear-gradient(180deg,rgba(6,7,13,.55),rgba(6,7,13,.1) 30%,rgba(6,7,13,.85) 65%,#0d0d1a)}
.wcf-hs-intro .beam{position:absolute;top:-40%;width:180px;height:140%;background:linear-gradient(180deg,rgba(255,244,214,.3),rgba(255,244,214,0) 70%);filter:blur(8px);transform-origin:50% 0;mix-blend-mode:screen;opacity:.5}
.wcf-hs-intro .beam.l{left:-30px;transform:rotate(24deg)}.wcf-hs-intro .beam.r{right:-30px;transform:rotate(-24deg)}
.wcf-hs-intro>*:not(.bg):not(.sc):not(.beam){position:relative}
.wcf-hs-intro .crest{width:80px;height:80px;border-radius:20px;margin-bottom:16px;box-shadow:0 0 0 1px rgba(245,217,122,.6),0 0 40px rgba(245,217,122,.45)}
.wcf-hs-intro .k{font-size:11px;font-weight:800;letter-spacing:.3em;color:#f5d97a}
.wcf-hs-intro h2{margin:8px 0 6px;font-family:var(--display);font-weight:800;font-size:38px;line-height:.95;color:#fff}
.wcf-hs-intro h2 span{background:linear-gradient(180deg,#fff6d1,#f5d97a 55%,#b8902a);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-hs-intro p{margin:0;font-size:13.5px;color:var(--soft,#cbd5e1);line-height:1.5}
.wcf-hs-intro.play .bg{transform:scale(1.15);animation:wcfHsDrift 14s ease-out forwards}
@keyframes wcfHsDrift{to{transform:scale(1)}}
.wcf-hs-intro.play .beam{opacity:0;animation:wcfHsBeam 2.6s .2s ease-out forwards}
.wcf-hs-intro.play .beam.l{--r:24deg}.wcf-hs-intro.play .beam.r{--r:-24deg}
@keyframes wcfHsBeam{0%{opacity:0;transform:rotate(calc(var(--r) * 2))}35%{opacity:1}100%{opacity:.5;transform:rotate(var(--r))}}
.wcf-hs-intro.play .crest{opacity:0;transform:translateY(-60px) scale(1.4);animation:wcfHsDrop .8s .5s cubic-bezier(.3,1.5,.5,1) forwards}
@keyframes wcfHsDrop{to{opacity:1;transform:none}}
.wcf-hs-intro.play .k{opacity:0;animation:wcfHsUp .6s 1s forwards}
.wcf-hs-intro.play h2{opacity:0;animation:wcfHsUp .6s 1.15s forwards}
.wcf-hs-intro.play p{opacity:0;animation:wcfHsUp .6s 1.3s forwards}
.wcf-hs-intro.play .wcf-hs-tot{opacity:0;animation:wcfHsUp .6s 1.5s forwards}
@keyframes wcfHsUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.wcf-hs-play{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:46px;margin-top:16px;border-radius:14px;border:0;background:#f5d97a;color:#1a1405;font-family:var(--sans);font-weight:800;font-size:14px;cursor:pointer}
.wcf-hs-play svg{width:18px;height:18px}
.wcf-hs-intro.play .wcf-hs-play{opacity:0;animation:wcfHsUp .6s 1.8s forwards}
.wcf-hs-tot{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:18px;padding-top:14px;border-top:1px solid rgba(245,217,122,.3)}
.wcf-hs-tot b{display:block;font-family:var(--display);font-size:24px;font-variant-numeric:tabular-nums;color:#fff}
.wcf-hs-tot span{font-size:9px;font-weight:800;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
.wcf-hs-story{position:relative;padding:0 4px 120px 32px}
.wcf-hs-rail{position:absolute;left:12px;top:0;bottom:30px;width:2px;background:rgba(245,217,122,.12)}
.wcf-hs-rail i{position:absolute;left:0;top:0;width:2px;height:0;background:linear-gradient(#f5d97a,#fff3c4);box-shadow:0 0 10px rgba(245,217,122,.8);transition:height .8s ease}
.wcf-hs-chap{position:relative;margin:26px 0 4px -32px;padding:0 4px 0 32px}
.wcf-hs-chap small{display:block;font-size:10px;font-weight:800;letter-spacing:.24em;color:#f5d97a}
.wcf-hs-chap b{display:block;font-family:var(--display);font-size:20px;margin-top:2px}
.wcf-hs-ev{position:relative;margin:14px 0 20px;opacity:0;transform:translateY(18px);transition:opacity .55s,transform .55s cubic-bezier(.3,1.2,.5,1)}
.wcf-hs-ev.in{opacity:1;transform:none}
.wcf-hs-ev::before{content:"";position:absolute;left:-26px;top:5px;width:12px;height:12px;border-radius:50%;background:var(--bg,#0d0d1a);border:2px solid rgba(245,217,122,.5);transition:all .4s .2s}
.wcf-hs-ev.in::before{background:#f5d97a;border-color:#fff3c4;box-shadow:0 0 0 4px rgba(245,217,122,.15),0 0 14px rgba(245,217,122,.7)}
.wcf-hs-ev .d{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dim);letter-spacing:.06em}
.wcf-hs-ev h4{margin:4px 0 5px;font-family:var(--display);font-size:18px;line-height:1.15}
.wcf-hs-ev p{margin:0;font-size:13px;color:var(--soft,#cbd5e1);line-height:1.5}
.wcf-hs-card{position:relative;margin-top:10px;border-radius:18px;border:1px solid rgba(245,217,122,.3);background:radial-gradient(120% 90% at 100% 0%,rgba(245,217,122,.10),transparent 60%),linear-gradient(170deg,#121a2b,#0a0e1a);padding:14px;overflow:hidden}
.wcf-hs-who{display:flex;align-items:center;gap:8px;margin-top:10px}
.wcf-hs-who span{font-size:12px;color:var(--soft,#cbd5e1);font-weight:600}
.wcf-hs-added{display:flex;align-items:center;gap:10px;margin-top:9px}
.wcf-hs-added span{font-size:9.5px;font-weight:800;letter-spacing:.12em;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.wcf-hs-added button{background:none;border:0;color:var(--dim);font-size:11.5px;font-weight:700;text-decoration:underline;cursor:pointer;padding:4px}
.wcf-hs-board{display:flex;align-items:center;justify-content:center;gap:10px;font-family:var(--display);font-weight:800}
.wcf-hs-board .t{font-size:11px;letter-spacing:.2em;color:var(--dim)}
.wcf-hs-board .t.r{color:#ff6b74}
.wcf-hs-board .dash{color:var(--dim);font-size:26px}
.wcf-hs-flip{position:relative;width:48px;height:62px;perspective:300px}
.wcf-hs-flip span{position:absolute;inset:0;display:grid;place-items:center;border-radius:10px;background:linear-gradient(180deg,#1d2438 50%,#151b2c 50%);font-size:40px;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06),0 8px 16px -8px #000;backface-visibility:hidden;transition:transform .55s cubic-bezier(.3,1.3,.5,1)}
.wcf-hs-flip span.n{transform:rotateX(-180deg)}
.wcf-hs-ev.in .wcf-hs-flip span.o{transform:rotateX(180deg);transition-delay:var(--fd,.4s)}
.wcf-hs-ev.in .wcf-hs-flip span.n{transform:none;transition-delay:var(--fd,.4s)}
.wcf-hs-goal{padding:0;background:#06100a}
.wcf-hs-goal svg{display:block;width:100%;height:auto}
.wcf-hs-goal .trail{stroke-dasharray:400;stroke-dashoffset:400}
.wcf-hs-goal .leapwrap{position:absolute;left:52.5%;top:35%;z-index:2;width:46px;height:46px;margin:-23px 0 0 -23px;opacity:0;transform:translateY(120px) scale(.7)}
.wcf-hs-goal .leapwrap .wcf-hs-face{width:46px;height:46px;border-width:3px;box-shadow:0 0 0 3px rgba(6,16,10,.8),0 10px 18px -6px #000;font-size:16px}
.wcf-hs-ev.go .wcf-hs-goal .leapwrap{animation:wcfHsLeap .62s cubic-bezier(.25,.8,.35,1.15) forwards}
@keyframes wcfHsLeap{0%{opacity:0;transform:translateY(120px) scale(.7)}30%{opacity:1}100%{opacity:1;transform:none}}
.wcf-hs-ev.hit .wcf-hs-goal .leapwrap{animation:wcfHsLeapOut .5s .5s forwards}
@keyframes wcfHsLeapOut{from{opacity:1;transform:none}to{opacity:0;transform:translateY(-10px) scale(1.1)}}
.wcf-hs-goal .burst{position:absolute;left:52.5%;top:31.2%;z-index:3;width:10px;height:10px;margin:-5px 0 0 -5px;pointer-events:none}
.wcf-hs-goal .burst i{position:absolute;left:0;top:0;width:10px;height:10px;border-radius:50%;border:2px solid #f5d97a;opacity:0}
.wcf-hs-ev.contact .wcf-hs-goal .burst i{animation:wcfHsRing .55s ease-out forwards}
.wcf-hs-ev.contact .wcf-hs-goal .burst i:nth-child(2){animation-delay:.08s}
@keyframes wcfHsRing{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(7)}}
.wcf-hs-goal .burst b{position:absolute;left:-30px;top:-34px;width:70px;text-align:center;font-family:var(--display);font-weight:800;font-size:11px;letter-spacing:.14em;color:#f5d97a;opacity:0;text-shadow:0 2px 8px #000}
.wcf-hs-ev.contact .wcf-hs-goal .burst b{animation:wcfHsPow .7s ease-out forwards}
@keyframes wcfHsPow{0%{opacity:0;transform:translateY(6px) scale(.6)}30%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-10px)}}
.wcf-hs-ev.go .wcf-hs-goal .trail{transition:stroke-dashoffset 1.05s cubic-bezier(.3,.6,.4,1);stroke-dashoffset:0}
.wcf-hs-goal .net{transform-box:fill-box;transform-origin:85% 20%}
.wcf-hs-ev.hit .wcf-hs-goal .net{animation:wcfHsRipple .7s ease-out}
@keyframes wcfHsRipple{25%{transform:scale(1.07,1.12) skewX(-3deg)}60%{transform:scale(.98,.97)}}
.wcf-hs-goal .flash{position:absolute;inset:0;background:radial-gradient(circle at var(--fx,82%) var(--fy,31%),#fff,rgba(255,255,255,0) 55%);opacity:0;pointer-events:none}
.wcf-hs-ev.hit .wcf-hs-goal .flash{animation:wcfHsFlash .6s ease-out}
@keyframes wcfHsFlash{15%{opacity:.85}100%{opacity:0}}
.wcf-hs-goal .conf{position:absolute;left:var(--fx,82%);top:var(--fy,31%)}
.wcf-hs-goal .conf i{position:absolute;left:0;top:0;width:7px;height:4px;border-radius:1px;opacity:0}
.wcf-hs-ev.hit .wcf-hs-goal .conf i{animation:wcfHsConf 1.2s cubic-bezier(.2,.7,.3,1) forwards}
@keyframes wcfHsConf{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--cx),var(--cy)) rotate(var(--cr))}}
.wcf-hs-goal .sb{position:absolute;left:12px;top:12px;z-index:2;display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:9px;background:rgba(6,8,14,.82);border:1px solid var(--line);font-family:var(--display);font-weight:800;font-size:12px;color:#f5d97a;letter-spacing:.1em;opacity:0;transform:translateY(-8px);transition:all .4s}
.wcf-hs-goal .sb small{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:9.5px;color:var(--dim);letter-spacing:0}
.wcf-hs-ev.hit .wcf-hs-goal .sb{opacity:1;transform:none;transition-delay:.35s}
.wcf-hs-goal .hero{position:absolute;left:0;right:0;bottom:12px;display:flex;align-items:center;justify-content:center;gap:11px;opacity:0;transform:translateY(16px);transition:all .5s cubic-bezier(.3,1.5,.5,1)}
.wcf-hs-ev.hit .wcf-hs-goal .hero{opacity:1;transform:none;transition-delay:.7s}
.wcf-hs-goal .hero .wcf-hs-face{width:56px;height:56px;border-width:3px;box-shadow:0 0 0 4px rgba(6,16,10,.85),0 0 22px rgba(245,217,122,.6);font-size:18px}
.wcf-hs-goal .hero b{display:block;font-family:var(--display);font-size:17px;color:#fff;text-shadow:0 2px 8px #000}
.wcf-hs-goal .hero span span{display:block;font-size:11.5px;color:var(--soft,#cbd5e1);text-shadow:0 1px 6px #000}
.wcf-hs-goal .no1{position:absolute;right:12px;top:10px;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#fff8dc,#f5d97a 45%,#9c7414);color:#3b2a07;font-family:var(--display);font-weight:800;font-size:15px;line-height:1;box-shadow:0 6px 16px rgba(0,0,0,.6);transform:scale(0) rotate(-120deg)}
.wcf-hs-goal .no1 small{display:block;font-size:8px;letter-spacing:.1em;text-align:center}
.wcf-hs-ev.hit .wcf-hs-goal .no1{transition:transform .55s cubic-bezier(.3,1.7,.5,1) 1s;transform:none}
.wcf-hs-seven{display:flex;align-items:center;gap:14px}
.wcf-hs-seven .wcf-hs-face.big{width:64px;height:64px;font-size:22px;border-width:3px;box-shadow:0 0 0 4px rgba(10,14,26,.8),0 0 22px rgba(245,217,122,.5)}
.wcf-hs-seven .balls{display:flex;flex-wrap:wrap;gap:4px;max-width:200px}
.wcf-hs-seven .balls span{width:22px;height:22px;opacity:0;transform:scale(0)}
.wcf-hs-seven .balls svg{width:100%;height:100%}
.wcf-hs-ev.in .wcf-hs-seven .balls span{animation:wcfHsPop .35s cubic-bezier(.3,1.8,.5,1) forwards;animation-delay:calc(.4s + var(--i) * .16s)}
@keyframes wcfHsPop{to{opacity:1;transform:none}}
.wcf-hs-mb{position:relative;display:grid;justify-items:center;padding:8px 0 2px}
.wcf-hs-mb .spot{position:absolute;top:-20px;left:50%;width:240px;height:220px;margin-left:-120px;background:radial-gradient(closest-side,rgba(255,240,200,.22),transparent);opacity:0;transition:opacity .8s .2s}
.wcf-hs-ev.in .wcf-hs-mb .spot{opacity:1}
.wcf-hs-mb .gb{position:relative;width:190px;height:190px;filter:drop-shadow(0 18px 24px rgba(0,0,0,.7)) drop-shadow(0 0 18px rgba(245,217,122,.35));transform:translateY(60px) scale(.6) rotate(-40deg);opacity:0;transition:transform 1s cubic-bezier(.3,1.3,.5,1) .2s,opacity .5s .2s}
.wcf-hs-ev.in .wcf-hs-mb .gb{transform:none;opacity:1}
.wcf-hs-mb .sig{opacity:0;font-family:var(--font-caveat),Caveat,"Segoe Script","Bradley Hand",cursive;font-weight:700}
.wcf-hs-ev.in .wcf-hs-mb .sig{animation:wcfHsSig .35s ease-out forwards;animation-delay:calc(1.1s + var(--i) * .1s)}
.wcf-hs-ev.in .wcf-hs-mb .sig.me{animation:wcfHsSigMe .5s cubic-bezier(.3,1.6,.5,1) forwards;animation-delay:calc(1.3s + var(--n) * .1s)}
@keyframes wcfHsSig{from{opacity:0}to{opacity:.92}}
@keyframes wcfHsSigMe{from{opacity:0;transform:scale(1.6)}to{opacity:1;transform:none}}
.wcf-hs-mb .sig.me{transform-box:fill-box;transform-origin:center}
.wcf-hs-mb .case{position:absolute;top:2px;left:50%;width:212px;height:206px;margin-left:-106px;border-radius:14px;border:1.5px solid rgba(255,255,255,.28);background:linear-gradient(115deg,rgba(255,255,255,.14),rgba(255,255,255,.02) 40%,rgba(255,255,255,.08));transform:translateY(-280px);opacity:0;transition:transform .7s cubic-bezier(.4,1.4,.5,1),opacity .2s}
.wcf-hs-ev.in .wcf-hs-mb .case{transform:none;opacity:1;transition-delay:calc(1.8s + var(--n) * .1s)}
.wcf-hs-mb .plinth{position:relative;width:224px;margin-top:-4px;opacity:0;transform:translateY(10px);transition:all .5s}
.wcf-hs-ev.in .wcf-hs-mb .plinth{opacity:1;transform:none;transition-delay:calc(2s + var(--n) * .1s)}
.wcf-hs-mb .plinth .top{height:10px;border-radius:4px 4px 0 0;background:linear-gradient(180deg,#5a3d17,#3b2710)}
.wcf-hs-mb .plinth .body{padding:10px 8px;border-radius:0 0 6px 6px;background:linear-gradient(180deg,#2b1c0b,#1a1007);text-align:center}
.wcf-hs-mb .plate{display:inline-block;padding:5px 12px;border-radius:4px;background:linear-gradient(180deg,#f5d97a,#c9a24a);color:#3b2a07;font-family:var(--display);font-weight:800;font-size:10px;letter-spacing:.1em;line-height:1.35}
.wcf-hs-mb .signed{margin-top:8px;font-size:11.5px;color:var(--dim);text-align:center}
.wcf-hs-mosaic{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px}
.wcf-hs-mosaic .wcf-hs-face{width:100%;height:auto;aspect-ratio:1;font-size:8px;border-width:1px;opacity:0;transform:scale(.3);transition:all .35s cubic-bezier(.3,1.6,.5,1)}
.wcf-hs-mosaic .wcf-hs-face.on{opacity:1;transform:none}
.wcf-hs-big{display:flex;align-items:baseline;gap:10px}
.wcf-hs-big b{font-family:var(--display);font-weight:800;font-size:60px;line-height:.9;background:linear-gradient(180deg,#fff6d1,#f5d97a 55%,#b8902a);-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.wcf-hs-big span{font-size:12px;font-weight:800;letter-spacing:.14em;color:var(--dim);text-transform:uppercase}
.wcf-hs-chainbox{padding-top:44px}
.wcf-hs-chainnum{position:absolute;left:14px;top:10px;font-family:var(--display);font-weight:800;font-size:40px;line-height:1;color:#f5d97a;font-variant-numeric:tabular-nums}
.wcf-hs-chain{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));align-items:end;gap:5px;height:160px}
.wcf-hs-step{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%}
.wcf-hs-step .wcf-hs-face{border-color:rgba(245,217,122,.5);opacity:.25;transform:scale(.7);transition:all .4s}
.wcf-hs-step .bar{width:100%;height:0;border-radius:8px 8px 3px 3px;background:linear-gradient(180deg,rgba(245,217,122,.55),rgba(245,217,122,.12));transition:height .55s cubic-bezier(.3,1.2,.5,1);display:flex;justify-content:center;padding-top:4px;font-family:var(--display);font-weight:800;font-size:15px;color:#1a1405;overflow:hidden}
.wcf-hs-step small{font-size:9.5px;font-weight:700;color:var(--dim);white-space:nowrap}
.wcf-hs-step.on .wcf-hs-face{opacity:1;transform:none}
.wcf-hs-step.on .bar{height:var(--h)}
.wcf-hs-step.top .wcf-hs-face{border-color:#f5d97a;box-shadow:0 0 14px rgba(245,217,122,.7)}
.wcf-hs-step.top .bar{background:linear-gradient(180deg,#fff3c4,#f5d97a 40%,#b8902a)}
.wcf-hs-twin{display:grid;grid-template-columns:1fr 1fr;gap:8px;background:radial-gradient(120% 80% at 50% 0%,#101a2c,#06080f)}
.wcf-hs-tp{position:relative}
.wcf-hs-tp svg{display:block;width:100%;height:auto}
.wcf-hs-tp .turf,.wcf-hs-tp .stripes{filter:brightness(.28);transition:filter .7s}
.wcf-hs-tp .lights{opacity:0;transition:opacity .7s}
.wcf-hs-tp .lamp{fill:#475569;transition:fill .3s}
.wcf-hs-ev.in .wcf-hs-tp .turf,.wcf-hs-ev.in .wcf-hs-tp .stripes{filter:none}
.wcf-hs-ev.in .wcf-hs-tp .lights{opacity:1}
.wcf-hs-ev.in .wcf-hs-tp .lamp{fill:#fff6dc}
.wcf-hs-ev.in .wcf-hs-tp.p1 *{transition-delay:.5s}
.wcf-hs-ev.in .wcf-hs-tp.p2 *{transition-delay:1.4s}
.wcf-hs-tp .ko{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);font-family:var(--display);font-weight:800;font-size:22px;color:#fff;text-shadow:0 2px 10px #000;opacity:.3;transition:opacity .5s}
.wcf-hs-ev.in .wcf-hs-tp.p1 .ko{opacity:1;transition-delay:.6s}.wcf-hs-ev.in .wcf-hs-tp.p2 .ko{opacity:1;transition-delay:1.5s}
.wcf-hs-tp .sold{position:absolute;left:50%;bottom:10%;padding:4px 9px;border:2px solid #f5d97a;border-radius:7px;background:rgba(10,8,2,.75);color:#f5d97a;font-family:var(--display);font-weight:800;font-size:11px;letter-spacing:.12em;white-space:nowrap;transform:translateX(-50%) rotate(-8deg) scale(2.2);opacity:0}
.wcf-hs-ev.in .wcf-hs-tp.p1 .sold{animation:wcfHsSold .45s 2.1s cubic-bezier(.3,1.6,.5,1) forwards}
.wcf-hs-ev.in .wcf-hs-tp.p2 .sold{animation:wcfHsSold .45s 2.4s cubic-bezier(.3,1.6,.5,1) forwards}
@keyframes wcfHsSold{to{opacity:1;transform:translateX(-50%) rotate(-8deg) scale(1)}}
.wcf-hs-end{margin:32px 0 0 -26px;border-radius:20px;padding:18px;border:1px dashed rgba(245,217,122,.55);background:rgba(245,217,122,.05);text-align:center}
.wcf-hs-end::before{display:none}
.wcf-hs-end small{display:block;font-size:10px;font-weight:800;letter-spacing:.24em;color:#f5d97a}
.wcf-hs-end b{display:block;font-family:var(--display);font-size:20px;line-height:1.2;margin:8px 0 6px}
.wcf-hs-add{width:calc(100% + 26px);margin:14px 0 0 -26px;min-height:44px;border-radius:12px;border:1px dashed var(--line);background:none;color:var(--dim);font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-hs-sheetwrap{position:fixed;inset:0;z-index:300;background:rgba(3,5,10,.6);display:flex;align-items:flex-end;justify-content:center}
.wcf-hs-sheet{width:100%;max-width:520px;max-height:88vh;overflow-y:auto;border-radius:24px 24px 0 0;background:#111827;border-top:1px solid rgba(245,217,122,.35);padding:10px 18px calc(18px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:10px;animation:wcfHsSheet .3s cubic-bezier(.3,1.2,.5,1)}
@keyframes wcfHsSheet{from{transform:translateY(100%)}}
.wcf-hs-sheet .grab{width:40px;height:5px;border-radius:5px;background:rgba(148,163,184,.4);margin:0 auto 4px}
.wcf-hs-sheet h3{margin:0;font-family:var(--display);font-size:19px}
.wcf-hs-sheet .sub{margin:0;font-size:12.5px;color:var(--dim)}
.wcf-hs-sheet label{display:grid;gap:5px}
.wcf-hs-sheet label span{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-hs-sheet input{width:100%;min-height:46px;border-radius:12px;border:1px solid var(--line);background:#0b1120;color:#F5F6F8;padding:0 12px;font-size:15px;font-family:var(--sans);color-scheme:dark}
.wcf-hs-sheet .kinds{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.wcf-hs-sheet .kinds button,.wcf-hs-sheet .people button,.wcf-hs-sheet .picked button{min-height:38px;border-radius:11px;border:1px solid var(--line);background:#0b1120;color:var(--soft,#cbd5e1);font-weight:700;font-size:12.5px;cursor:pointer;font-family:var(--sans);padding:0 10px}
.wcf-hs-sheet .kinds button.on,.wcf-hs-sheet .people button.on{border-color:#f5d97a;color:#f5d97a;background:rgba(245,217,122,.08)}
.wcf-hs-sheet .people{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow-y:auto}
.wcf-hs-sheet .picked{display:flex;flex-wrap:wrap;gap:6px}
.wcf-hs-sheet .picked button{border-color:#f5d97a;color:#f5d97a}
.wcf-hs-sheet .save{min-height:50px;border-radius:14px;border:0;background:#f5d97a;color:#1a1405;font-weight:800;font-size:15px;cursor:pointer;font-family:var(--sans)}
.wcf-hs-sheet .save:disabled{opacity:.4;cursor:default}
.wcf-hs-sheet .cancel{min-height:40px;border:0;background:none;color:var(--dim);font-weight:700;cursor:pointer;font-family:var(--sans)}
.wcf-hs.still .wcf-hs-ev{opacity:1;transform:none;transition:none}
.wcf-hs.still *{animation-duration:.01ms!important;animation-delay:0s!important;transition-duration:.01ms!important;transition-delay:0s!important}
`;
