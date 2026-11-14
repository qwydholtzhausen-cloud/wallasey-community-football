"use client";

// The player page (14 Nov 2026): tap any face and a player's season opens
// out of it as a page - their name rolling in, the numbers, form and
// streaks, the record book, their honours under spotlights, milestones and
// signature moments. Replaces the player card for admins first
// (PLAYER_PAGE_OPEN_TO_ALL_FROM in lib/clubPolicy.ts). Every line comes
// from lib/playerStory.ts, which only writes what the data supports.
// Ratings and the emergency contact stay private (you and the admins).

import { useEffect, useRef, useState } from "react";
import type { Story } from "../../lib/playerStory";
import { TrophyIcon } from "./cabinet";

const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const POOL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function Decode({ text, delay }: { text: string; delay: number }) {
  const [out, setOut] = useState(() => (reduced() ? text : ""));
  useEffect(() => {
    if (reduced()) return setOut(text);
    const lock = [...text].map((_, i) => 6 + i * 3);
    const last = Math.max(0, ...lock);
    let f = 0;
    let iv: number | undefined;
    const t = window.setTimeout(() => {
      iv = window.setInterval(() => {
        f++;
        setOut([...text].map((c, i) => (c === " " || f >= lock[i] ? c : POOL[Math.floor(Math.random() * POOL.length)])).join(""));
        if (f >= last) window.clearInterval(iv);
      }, 40);
    }, delay);
    return () => {
      window.clearTimeout(t);
      if (iv) window.clearInterval(iv);
    };
  }, [text, delay]);
  return (
    <span aria-label={text} role="text">
      <span aria-hidden="true">{out || " "}</span>
    </span>
  );
}

// Digits roll up from 0 like a mileage counter once `go` is true.
function Roll({ v, go, delay = 0 }: { v: string; go: boolean; delay?: number }) {
  // Once the digits have landed, swap to plain text so the spacing is the font's own.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!go) return;
    const t = window.setTimeout(() => setDone(true), delay + v.length * 120 + 1500);
    return () => window.clearTimeout(t);
  }, [go, delay, v]);
  if (!/^\d+$/.test(v) || reduced() || done) return <>{v}</>;
  return (
    <span className="wpp-rn" aria-label={v} role="text">
      {[...v].map((d, i) => (
        <span key={i} className="wpp-rn-c" aria-hidden="true">
          <span className="wpp-rn-s" style={{ transform: `translateY(-${go ? Number(d) * 10 : 0}%)`, transitionDelay: `${delay + i * 120}ms` }}>
            {"0123456789".split("").map((x) => (
              <span key={x}>{x}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}

// Adds "in" to an element once it scrolls into the page.
function useSeen<T extends HTMLElement>(root: React.RefObject<HTMLElement | null>, threshold = 0.35) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(() => reduced());
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (setSeen(true), io.disconnect())), { root: root.current, threshold });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, root, threshold]);
  return [ref, seen] as const;
}

export interface PlayerPageProps {
  name: string;
  photo: string | null;
  story: Story;
  origin: { x: number; y: number } | null;
  honourLine: string | null; // "Golden Boot leader"
  team: { name: string; color: string } | null; // when opened from a game
  nextGame: string | null; // "Mon 16 Nov, 20:00 at Solar Campus"
  highlight?: string | null; // a trophy key to open and light first
  privateInfo: {
    label: string; // "Only you" / "Admin only"
    rating: { fitness: number; attack: number; defence: number; goalkeeping: number } | null;
    contact: { name: string; phone: string } | null;
    isOwn: boolean;
  } | null;
  onClose: () => void;
}

export function PlayerPage({ name, photo, story, origin, honourLine, team, nextGame, highlight, privateInfo, onClose }: PlayerPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tipAt, setTipAt] = useState<number | null>(null);
  const [openHonour, setOpenHonour] = useState<number | null>(() => {
    const i = highlight ? story.honours.findIndex((h) => h.keys.includes(highlight)) : -1;
    return i >= 0 ? i : null;
  });
  const [spin, setSpin] = useState<number | null>(null);
  const [lit, setLit] = useState<number>(reduced() ? 99 : -1);
  const [carRef, carSeen] = useSeen<HTMLDivElement>(pageRef, 0.4);
  const [hnRef, hnSeen] = useSeen<HTMLDivElement>(pageRef, 0.3);
  const [carShown, setCarShown] = useState<Set<number>>(() => new Set(reduced() ? story.records.map((_, i) => i) : []));
  const carEl = useRef<HTMLDivElement | null>(null);
  const words = name.split(/\s+/).filter(Boolean);
  const firstName = words[0] ?? name;
  const initials = words.map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  useEffect(() => {
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    pageRef.current?.focus();
    return () => {
      cancelAnimationFrame(r);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const on = () => el.style.setProperty("--sy", String(el.scrollTop));
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  // Spotlights come on one by one.
  useEffect(() => {
    if (!hnSeen || lit >= story.honours.length) return;
    const t = window.setTimeout(() => setLit((n) => n + 1), lit < 0 ? 250 : 650);
    return () => window.clearTimeout(t);
  }, [hnSeen, lit, story.honours.length]);
  // Record cards roll / decode as each is swiped into view.
  useEffect(() => {
    const c = carEl.current;
    if (!c || !carSeen) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setCarShown((s) => new Set(s).add(Number((e.target as HTMLElement).dataset.i)))),
      { root: c, threshold: 0.6 }
    );
    c.querySelectorAll<HTMLElement>("[data-i]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [carSeen]);

  const tapHonour = (i: number) => {
    setOpenHonour(openHonour === i ? null : i);
    setSpin(null);
    requestAnimationFrame(() => setSpin(i));
  };
  const cx = origin ? `${origin.x}px` : "50%";
  const cy = origin ? `${origin.y}px` : "40%";
  const ringsGold = (i: number) => !!story.streak && i >= story.last.length - story.streak.n;

  return (
    <div
      ref={pageRef}
      className={"wpp" + (open ? " on" : "")}
      style={{ ["--cx" as string]: cx, ["--cy" as string]: cy }}
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s season`}
      tabIndex={-1}
    >
      <style>{playerPageCss}</style>
      <button type="button" className="wpp-x" onClick={onClose} aria-label="Close">
        ×
      </button>

      <section className="wpp-hero">
        <div className="wpp-bg" />
        <div className="wpp-big" aria-hidden="true">
          {story.big}
        </div>
        <div className="wpp-ring" style={photo ? { backgroundImage: `url('${photo}')` } : undefined}>
          {!photo && <span>{initials}</span>}
          <svg viewBox="0 0 136 136" aria-hidden="true">
            <circle cx="68" cy="68" r="66" />
          </svg>
        </div>
        <div className="wpp-id">
          {story.kicker && <div className="wpp-k">{story.kicker}</div>}
          {words.map((w, i) => (
            <div key={i} className="wpp-nm">
              <b>
                <Decode text={w} delay={650 + i * 130} />
              </b>
            </div>
          ))}
          {(honourLine || team) && (
            <div className="wpp-tags">
              {honourLine && <span className="wpp-hon">{honourLine}</span>}
              {team && (
                <span className="wpp-team" style={{ ["--tc" as string]: team.color }}>
                  {team.name}
                </span>
              )}
            </div>
          )}
          <div className="wpp-line">{story.line}</div>
        </div>
      </section>

      <section className="wpp-sec first">
        <div className="wpp-h">
          <h3>{story.numsTitle}</h3>
          <span>Season</span>
        </div>
        <div className="wpp-rule" />
        <div className="wpp-nums">
          {story.nums.map((n, i) => (
            <div key={n.l} className="wpp-n">
              <b className={n.gold ? "g" : ""}>
                <Roll v={n.v} go={open} delay={1100 + i * 140} />
              </b>
              <span>{n.l}</span>
              <em>{n.s}</em>
            </div>
          ))}
        </div>

        {story.last.length > 0 && (
          <div className="wpp-fm">
            <div className="top">
              <span>Form · last {story.last.length}</span>
              <span>Oldest → latest</span>
            </div>
            <div className={"wpp-rings" + (open ? " in" : "")}>
              {story.last.map((x, i) => (
                <i key={i} className={x.r + (ringsGold(i) ? " live" : "") + (i === story.last.length - 1 ? " now" : "")} style={{ transitionDelay: `${1500 + i * 90}ms` }}>
                  <b>{x.r}</b>
                  <small>{x.d}</small>
                </i>
              ))}
            </div>
            {story.streak ? (
              <div className="wpp-live">
                <b>{story.streak.n}</b>
                <span>
                  {story.streak.kind === "win" ? "Wins on the bounce" : "Games unbeaten"}
                  <em>Live, and still going.</em>
                </span>
              </div>
            ) : (
              <div className="wpp-none">No run going at the moment. A win next time out starts one.</div>
            )}
            {(story.bestWin || story.bestUnbeaten) && (
              <div className="wpp-best">
                {story.bestWin && (
                  <div>
                    <b>{story.bestWin.n}</b>
                    <span>{story.bestWin.n === 1 ? "Win in a row" : "Wins in a row"}</span>
                    <em>{story.streak?.kind === "win" && story.streak.n === story.bestWin.n ? "right now" : story.bestWin.times > 1 ? `${story.bestWin.times} times, best of the season` : `${shortRange(story.bestWin.from, story.bestWin.to)}`}</em>
                  </div>
                )}
                {story.bestUnbeaten && (
                  <div>
                    <b>{story.bestUnbeaten.n}</b>
                    <span>Unbeaten</span>
                    <em>{story.streak && story.streak.n === story.bestUnbeaten.n ? "right now" : story.bestUnbeaten.times > 1 ? `${story.bestUnbeaten.times === 2 ? "twice" : story.bestUnbeaten.times + " times"}, best of the season` : shortRange(story.bestUnbeaten.from, story.bestUnbeaten.to)}</em>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {story.strip.length > 0 && (
          <>
            <div className={"wpp-strip" + (open ? " in" : "")}>
              {story.strip.map((g, i) => (
                <button key={i} type="button" className={g.r + (tipAt === i ? " sel" : "")} style={{ transitionDelay: `${1500 + i * 30}ms` }} onClick={() => setTipAt(i)} aria-label={g.tip}>
                  {g.goals > 0 && <b />}
                </button>
              ))}
            </div>
            <div className="wpp-key">
              <span><i className="kw" />Win</span>
              <span><i className="kd" />Draw</span>
              <span><i className="kl" />Loss</span>
              <span><i className="dot" />Scored</span>
            </div>
            <div className="wpp-tip">
              {tipAt == null ? (
                "Tap a bar to see the game."
              ) : (
                <>
                  <b>{story.strip[tipAt].tip}</b>
                  {story.strip[tipAt].goals > 0 && (
                    <span className="g">
                      {" "}· {story.strip[tipAt].goals} {story.strip[tipAt].goals === 1 ? "goal" : "goals"}
                    </span>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </section>

      {story.records.length >= 2 && (
        <section className="wpp-sec">
          <div className="wpp-h">
            <h3>The record book</h3>
            <span>Swipe</span>
          </div>
          <div className="wpp-rule" />
          <div className="wpp-car" ref={(el) => { carEl.current = el; carRef.current = el; }}>
            {story.records.map((r, i) => (
              <div key={r.k} className="wpp-rc" data-i={i} style={{ ["--ph" as string]: `url('${["/pitch-night.jpg", "/results-bg.jpg", "/net-rain.jpg", "/celebration.jpg"][i % 4]}')` }}>
                <div className="bg" />
                <div className="in">
                  <div className="k">{r.k}</div>
                  <b className={r.gold ? "g" : ""}>{carShown.has(i) ? (/^\d+$/.test(r.v) ? <Roll v={r.v} go delay={60} /> : <Decode text={r.v} delay={60} />) : " "}</b>
                  <p>{r.p}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(story.honours.length > 0 || story.milestones.length > 0) && (
        <section className="wpp-sec">
          <div className="wpp-h">
            <h3>{story.honours.length ? "Honours" : "Milestones"}</h3>
            <span>{story.honours.length ? "Tap one" : ""}</span>
          </div>
          <div className="wpp-rule" />
          {story.honours.length > 0 && (
            <div className="wpp-hn" ref={hnRef}>
              {story.honours.map((h, i) => (
                <button
                  key={h.kind + i}
                  type="button"
                  className={"wpp-st" + (i === 0 ? " lead" : "") + (lit >= i ? " lit" : "") + (openHonour === i ? " open" : "")}
                  onClick={() => tapHonour(i)}
                  aria-expanded={openHonour === i}
                >
                  <span className="cone" />
                  <span className={"med" + (spin === i ? " spin" : "")}>
                    {h.x > 1 && <span className="x">×{h.x}</span>}
                    <span className="face">
                      <TrophyIcon kind={h.kind} />
                    </span>
                  </span>
                  <span className="pl" />
                  <span className="plate">
                    <span className="k">{h.k}</span>
                    <b>{h.b}</b>
                    <span className="p">{h.p}</span>
                    <span className="more">
                      {h.more.map((m) => (
                        <span key={m}>{m}</span>
                      ))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {story.milestones.length > 0 && (
            <>
              {story.honours.length > 0 && (
                <div className="wpp-msh">
                  <span>Milestones</span>
                  <span>{story.milestones.length} so far</span>
                </div>
              )}
              <div className="wpp-ms">
                {story.milestones.map((m) => (
                  <div key={m.key}>
                    <i>
                      <TrophyIcon kind={m.kind} n={m.n} />
                    </i>
                    <span>
                      <b>{m.b}</b>
                      {m.d}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {story.nextMilestone && <div className="wpp-next-ms">{story.nextMilestone}</div>}
        </section>
      )}

      {story.moments.length > 0 && (
        <section className="wpp-sec">
          <div className="wpp-h">
            <h3>{story.momTitle}</h3>
            <span>Season</span>
          </div>
          <div className="wpp-rule" />
          <div className="wpp-tl">
            {story.moments.map((m) => (
              <div key={m.date + m.h} className={"wpp-m" + (m.gold ? " gold" : "")}>
                <div className="d">{m.d}</div>
                <h4>{m.h}</h4>
                <p>{m.p}</p>
                {m.sc && <span className="sc">{m.sc}</span>}
              </div>
            ))}
          </div>
          {nextGame && (
            <div className="wpp-nextgame">
              <div className="k">Next</div>
              <p>{nextGame}</p>
            </div>
          )}
        </section>
      )}

      {privateInfo && (
        <section className="wpp-sec">
          <div className="wpp-h">
            <h3>Private</h3>
            <span>{privateInfo.label}</span>
          </div>
          <div className="wpp-rule" />
          {privateInfo.rating ? (
            <div className="wpp-rt">
              {(["fitness", "attack", "defence", "goalkeeping"] as const).map((k) => (
                <div key={k}>
                  <span>{k === "goalkeeping" ? "Keeping" : k[0].toUpperCase() + k.slice(1)}</span>
                  <i style={{ ["--v" as string]: `${(privateInfo.rating![k] / 5) * 100}%` }} />
                  <em>{privateInfo.rating![k].toFixed(1)}</em>
                </div>
              ))}
            </div>
          ) : (
            <p className="wpp-muted">No ratings yet.</p>
          )}
          <div className="wpp-ec">
            <span>Emergency contact</span>
            {privateInfo.contact ? (
              <a href={`tel:${privateInfo.contact.phone.replace(/\s+/g, "")}`}>
                {privateInfo.contact.name} · {privateInfo.contact.phone}
              </a>
            ) : (
              <em>{privateInfo.isOwn ? "Not added yet. Add it in Account settings." : "Not added yet."}</em>
            )}
          </div>
          <p className="wpp-muted">Ratings and the emergency contact are private to {firstName} and the admins.</p>
        </section>
      )}

      <div className="wpp-end">
        <img src="/crest.png" alt="" />
        <p>{story.numsTitle === "So far" ? "The story so far" : "Season"} · {new Date().getFullYear()}</p>
      </div>
    </div>
  );
}

function shortRange(a: string, b: string) {
  const f = (d: string) => {
    const x = new Date(d + "T12:00:00Z");
    return `${x.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][x.getUTCMonth()]}`;
  };
  return a === b ? f(a) : `${f(a)} – ${f(b)}`;
}

export const playerPageCss = `
.wpp{position:fixed;inset:0;z-index:1200;background:#05070d;color:#eef1f7;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;clip-path:circle(0px at var(--cx) var(--cy));transition:clip-path .8s cubic-bezier(.65,0,.25,1);font-family:var(--font-sora),system-ui,sans-serif;outline:none;scrollbar-width:none;padding-bottom:env(safe-area-inset-bottom,0px)}
.wpp::-webkit-scrollbar{display:none}
.wpp.on{clip-path:circle(150vmax at var(--cx) var(--cy))}
.wpp-x{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:14px;z-index:5;width:38px;height:38px;border-radius:50%;border:0;background:rgba(10,14,26,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#fff;font:400 22px/1 var(--font-sora),sans-serif;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15);cursor:pointer}
.wpp-hero{position:relative;height:380px;overflow:hidden;padding-top:env(safe-area-inset-top,0px)}
.wpp-bg{position:absolute;inset:-40px 0 0;background:url('/floodlight-haze.jpg') center 40%/cover;filter:brightness(.5);transform:translateY(calc(var(--sy,0) * .35px)) scale(1.08)}
.wpp-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,7,13,.2),rgba(5,7,13,0) 35%,#05070d 92%);pointer-events:none}
.wpp-big{position:absolute;left:-10px;right:-10px;top:30px;z-index:1;text-align:center;font:800 250px/1 var(--font-sora),sans-serif;letter-spacing:-.06em;color:transparent;-webkit-text-stroke:1.5px rgba(245,217,122,.22);transform:translateY(calc(var(--sy,0) * .2px));opacity:0;transition:opacity 1.2s .6s;pointer-events:none}
.wpp.on .wpp-big{opacity:1}
.wpp-ring{position:absolute;left:50%;top:calc(58px + env(safe-area-inset-top,0px));width:118px;height:118px;margin-left:-59px;border-radius:50%;background:#1a2133 center/cover;z-index:2;display:grid;place-items:center;font:700 34px var(--font-oswald),sans-serif;color:#cbd5e1;box-shadow:0 0 0 4px #05070d,0 0 0 6px #f5d97a,0 0 60px rgba(245,217,122,.35);transform:scale(.4);opacity:0;transition:transform .9s cubic-bezier(.3,1.2,.5,1) .35s,opacity .5s .35s}
.wpp.on .wpp-ring{transform:none;opacity:1}
.wpp-ring svg{position:absolute;inset:-9px;width:136px;height:136px;transform:rotate(-90deg)}
.wpp-ring circle{fill:none;stroke:#f5d97a;stroke-width:1.2;stroke-dasharray:427;stroke-dashoffset:427;transition:stroke-dashoffset 1.6s cubic-bezier(.2,.8,.2,1) .9s}
.wpp.on .wpp-ring circle{stroke-dashoffset:0}
.wpp-id{position:absolute;left:0;right:0;bottom:16px;z-index:2;text-align:center;padding:0 20px}
.wpp-k{font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#f5d97a}
.wpp-nm{overflow:hidden;margin-top:6px}.wpp-nm b{display:block;font:700 44px/.95 var(--font-oswald),sans-serif;text-transform:uppercase;letter-spacing:.01em;transform:translateY(105%);transition:transform .9s cubic-bezier(.2,.8,.2,1) .7s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wpp.on .wpp-nm b{transform:none}
.wpp-tags{display:flex;justify-content:center;gap:6px;margin-top:8px}
.wpp-hon{padding:3px 11px;border-radius:999px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#0a0f1d;background:linear-gradient(180deg,#fff3c4,#f5d97a 45%,#c9a24a)}
.wpp-team{padding:3px 11px;border-radius:999px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#fff;box-shadow:inset 0 0 0 1px var(--tc)}
.wpp-line{margin-top:8px;font:700 italic 15px/1.35 var(--font-playfair),serif;color:#e2e8f0;opacity:0;transition:opacity .8s 1.2s}.wpp.on .wpp-line{opacity:1}
.wpp-sec{padding:26px 22px 8px}.wpp-sec.first{padding-top:6px}
.wpp-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.wpp-h h3{margin:0;font:700 26px/1 var(--font-oswald),sans-serif;text-transform:uppercase}
.wpp-h span{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#64748b;text-transform:uppercase}
.wpp-rule{height:1px;margin:12px 0 4px;background:linear-gradient(90deg,#f5d97a,rgba(245,217,122,.1) 70%,transparent)}
.wpp-nums{display:grid;grid-template-columns:1fr 1fr}
.wpp-n{padding:12px 0 10px;border-bottom:1px solid rgba(255,255,255,.07);min-width:0}
.wpp-n:nth-child(odd){padding-right:14px;border-right:1px solid rgba(255,255,255,.07)}.wpp-n:nth-child(even){padding-left:16px}
.wpp-n>b{display:block;font:800 44px/1 var(--font-sora),sans-serif;letter-spacing:-.04em;height:44px}
.wpp-n>b.g,.wpp-n>b.g .wpp-rn-s>span{background:linear-gradient(180deg,#fff3c4,#f5d97a 45%,#c9a24a);-webkit-background-clip:text;background-clip:text;color:transparent}
.wpp-n>b.g:has(.wpp-rn){background:none;-webkit-background-clip:border-box;background-clip:border-box}
.wpp-n>span{display:block;margin-top:6px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;text-transform:uppercase}
.wpp-n>em{display:block;margin-top:3px;font:700 italic 12.5px var(--font-playfair),serif;color:#cbd5e1}
.wpp-rn{display:inline-flex;line-height:1}.wpp-rn-c{display:inline-block;height:1em;overflow:hidden}.wpp-rn-s{display:flex;flex-direction:column;transition:transform 1.4s cubic-bezier(.2,.9,.25,1)}.wpp-rn-s>span{height:1em;line-height:1em}
.wpp-fm{margin-top:16px;padding:16px 16px 14px;border-radius:18px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.wpp-fm .top{display:flex;justify-content:space-between;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;text-transform:uppercase}
.wpp-rings{display:flex;justify-content:space-between;margin-top:14px}
.wpp-rings i{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;font-style:normal;opacity:0;transform:translateY(8px);transition:opacity .45s,transform .45s cubic-bezier(.2,.8,.2,1)}
.wpp-rings.in i{opacity:1;transform:none}
.wpp-rings i b{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font:600 15px var(--font-oswald),sans-serif;letter-spacing:.04em;position:relative;z-index:1}
.wpp-rings i.W b{background:radial-gradient(circle at 35% 30%,#fff,#d9dee8 70%);color:#0a0f1d;box-shadow:0 0 0 1.5px #05070d,0 0 0 2.5px rgba(255,255,255,.45)}
.wpp-rings i.D b{background:#151b2c;color:#cbd5e1;box-shadow:inset 0 0 0 1.5px rgba(203,213,225,.55)}
.wpp-rings i.L b{color:#64748b;box-shadow:inset 0 0 0 1.5px rgba(100,116,139,.55)}
.wpp-rings i.live b{box-shadow:0 0 0 1.5px #05070d,0 0 0 3px #f5d97a,0 0 18px rgba(245,217,122,.55)}
.wpp-rings i.live+i.live::before{content:"";position:absolute;right:50%;top:19px;width:100%;height:1.5px;background:linear-gradient(90deg,#c9a24a,#fff3c4,#c9a24a)}
.wpp-rings i small{font:600 8.5px var(--font-oswald),sans-serif;letter-spacing:.16em;color:#64748b;text-transform:uppercase;white-space:nowrap}
.wpp-rings i.now small{color:#f5d97a}
.wpp-live{margin-top:16px;display:flex;align-items:center;gap:10px;border-left:1.5px solid #f5d97a;padding:2px 0 2px 12px}
.wpp-live b{font:800 34px/1 var(--font-sora),sans-serif;color:#f5d97a}
.wpp-live span{font:700 14px var(--font-oswald),sans-serif;letter-spacing:.06em;text-transform:uppercase}
.wpp-live em{display:block;font:700 italic 12px var(--font-playfair),serif;color:#e2e8f0;text-transform:none;letter-spacing:0;margin-top:2px}
.wpp-none{margin-top:16px;padding-left:12px;border-left:1.5px solid rgba(255,255,255,.15);font:700 italic 13.5px var(--font-playfair),serif;color:#cbd5e1}
.wpp-best{display:grid;grid-template-columns:1fr 1fr;margin-top:12px;border-top:1px solid rgba(255,255,255,.07)}
.wpp-best div{padding-top:10px}.wpp-best div+div{padding-left:14px;border-left:1px solid rgba(255,255,255,.07)}
.wpp-best b{font:800 26px/1 var(--font-sora),sans-serif}.wpp-best span{display:block;margin-top:4px;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.18em;color:#94a3b8;text-transform:uppercase}.wpp-best em{display:block;font:700 italic 12px var(--font-playfair),serif;color:#cbd5e1;margin-top:2px}
.wpp-strip{display:flex;gap:3px;margin-top:20px;align-items:flex-end;height:58px}
.wpp-strip button{flex:1;min-width:0;padding:0;border:0;border-radius:2px;position:relative;cursor:pointer;transform:scaleY(0);transform-origin:bottom;transition:transform .5s cubic-bezier(.3,1.3,.5,1)}
.wpp-strip.in button{transform:none}
.wpp-strip .W{height:100%;background:linear-gradient(180deg,#f4f6fa,#9aa4b8)}.wpp-strip .D{height:55%;background:#64748b}.wpp-strip .L{height:28%;background:#3a4256}
.wpp-strip .sel{outline:1.5px solid #f5d97a;outline-offset:2px}
.wpp-strip b{position:absolute;left:50%;top:-9px;width:6px;height:6px;margin-left:-3px;border-radius:50%;background:#f5d97a;box-shadow:0 0 8px rgba(245,217,122,.8)}
.wpp-key{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.16em;color:#94a3b8;text-transform:uppercase}
.wpp-key i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}.wpp-key .kw{background:#cfd6e2}.wpp-key .kd{background:#64748b}.wpp-key .kl{background:#3a4256}.wpp-key .dot{border-radius:50%;background:#f5d97a}
.wpp-tip{margin-top:10px;min-height:38px;padding:9px 12px;border-radius:12px;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);font:500 12.5px var(--font-sora),sans-serif;color:#94a3b8}
.wpp-tip b{color:#fff;font-weight:600}.wpp-tip .g{color:#f5d97a}
.wpp-car{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding:18px 22px 8px;margin:0 -22px;scrollbar-width:none}.wpp-car::-webkit-scrollbar{display:none}
.wpp-rc{flex:0 0 78%;scroll-snap-align:center;height:280px;border-radius:22px;position:relative;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(245,217,122,.4),0 20px 40px -20px #000}
.wpp-rc .bg{position:absolute;inset:0;background:var(--ph) center/cover;filter:brightness(.42)}
.wpp-rc::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,7,13,.1),rgba(5,7,13,.92) 75%)}
.wpp-rc .in{position:absolute;inset:0;z-index:2;padding:18px;display:flex;flex-direction:column;justify-content:flex-end}
.wpp-rc .k{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#f5d97a;text-transform:uppercase}
.wpp-rc b{font:800 68px/1 var(--font-sora),sans-serif;letter-spacing:-.05em;margin-top:6px;min-height:68px}
.wpp-rc b.g{background:linear-gradient(180deg,#fff3c4,#f5d97a 45%,#c9a24a);-webkit-background-clip:text;background-clip:text;color:transparent}
.wpp-rc p{margin:6px 0 0;font:700 italic 14px/1.35 var(--font-playfair),serif;color:#e2e8f0}
.wpp-hn{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.wpp-st{position:relative;border:0;border-radius:20px;overflow:hidden;background:#070a13;box-shadow:inset 0 0 0 1px rgba(245,217,122,.16);padding:22px 12px 16px;text-align:center;cursor:pointer;color:inherit;display:flex;flex-direction:column;align-items:center;font:inherit}
.wpp-st.lead{grid-column:1/-1;padding:26px 16px 18px}
.wpp-st:last-child:nth-child(even){grid-column:auto}
.wpp-st .cone{position:absolute;left:50%;top:-30px;width:190px;height:250px;margin-left:-95px;background:linear-gradient(180deg,rgba(255,248,225,.34),rgba(255,248,225,0) 78%);clip-path:polygon(43% 0,57% 0,100% 100%,0 100%);filter:blur(5px);opacity:0;pointer-events:none}
.wpp-st.lit .cone{animation:wppOn 1s forwards}
@keyframes wppOn{0%{opacity:0}15%{opacity:1}25%{opacity:.15}40%{opacity:.9}55%{opacity:.3}100%{opacity:1}}
.wpp-st .med{position:relative;z-index:1;width:92px;height:92px;border-radius:50%;background:radial-gradient(circle at 35% 28%,#fff6d2,#f5d97a 38%,#b8892a 70%,#7a5510);box-shadow:0 0 0 3px #05070d,0 0 0 4.5px rgba(245,217,122,.65),0 18px 28px -10px #000;filter:grayscale(.85) brightness(.45);transform:translateY(10px);transition:filter .9s .25s,transform .9s .25s cubic-bezier(.2,.8,.2,1),box-shadow .9s}
.wpp-st.lead .med{width:120px;height:120px}
.wpp-st.lit .med{filter:none;transform:none;box-shadow:0 0 0 3px #05070d,0 0 0 4.5px rgba(245,217,122,.8),0 18px 28px -10px #000,0 0 46px rgba(245,217,122,.35)}
.wpp-st .med.spin{animation:wppSpin 1.6s cubic-bezier(.3,.1,.2,1)}
@keyframes wppSpin{from{transform:rotateY(0)}to{transform:rotateY(360deg)}}
.wpp-st .face{position:absolute;inset:9px;border-radius:50%;background:radial-gradient(circle at 50% 35%,#1d2640,#0a0e1b 75%);display:grid;place-items:center;box-shadow:inset 0 2px 6px rgba(0,0,0,.6)}
.wpp-st .face svg{width:56%;height:56%}
.wpp-st .x{position:absolute;right:-6px;top:-4px;z-index:2;padding:2px 8px;border-radius:999px;font:800 11px var(--font-sora),sans-serif;color:#0a0f1d;background:linear-gradient(180deg,#fff3c4,#f5d97a 50%,#c9a24a);box-shadow:0 0 0 2px #05070d}
.wpp-st .pl{position:relative;z-index:1;width:110px;height:12px;margin-top:-2px;border-radius:2px 2px 4px 4px;background:linear-gradient(#1d2539,#0b101d);box-shadow:inset 0 1px 0 rgba(245,217,122,.55)}
.wpp-st.lead .pl{width:140px}
.wpp-st .plate{position:relative;z-index:1;margin-top:14px;display:block}
.wpp-st .plate .k{display:block;font:600 9px var(--font-oswald),sans-serif;letter-spacing:.24em;color:#f5d97a;text-transform:uppercase}
.wpp-st .plate b{display:block;margin-top:4px;font:700 17px/1.1 var(--font-oswald),sans-serif;text-transform:uppercase;color:#fff}
.wpp-st.lead .plate b{font-size:22px}
.wpp-st .plate .p{display:block;margin-top:5px;font:700 italic 12.5px/1.35 var(--font-playfair),serif;color:#cbd5e1}
.wpp-st .more{display:block;max-height:0;overflow:hidden;transition:max-height .6s ease}
.wpp-st.open .more{max-height:160px}
.wpp-st .more span{display:block;margin-top:6px;padding-top:6px;border-top:1px solid rgba(245,217,122,.18);font:500 12px var(--font-sora),sans-serif;color:#cbd5e1}
.wpp-msh{display:flex;justify-content:space-between;margin-top:22px;font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;text-transform:uppercase}
.wpp-ms{display:flex;gap:14px 18px;margin-top:12px;flex-wrap:wrap}
.wpp-ms div{display:flex;align-items:center;gap:10px}
.wpp-ms i{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#0d1222;box-shadow:inset 0 0 0 1.5px rgba(245,217,122,.45);flex:none}
.wpp-ms i svg{width:26px;height:26px}
.wpp-ms span{font:500 11px var(--font-sora),sans-serif;color:#94a3b8}.wpp-ms b{display:block;font:600 12px var(--font-oswald),sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#fff}
.wpp-next-ms{margin-top:14px;padding-left:12px;border-left:1.5px solid rgba(245,217,122,.6);font:700 italic 13.5px var(--font-playfair),serif;color:#e2e8f0}
.wpp-tl{position:relative;margin-top:16px;padding-left:22px}
.wpp-tl::before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:1px;background:linear-gradient(#f5d97a,rgba(245,217,122,.15))}
.wpp-m{position:relative;padding:0 0 24px}
.wpp-m::before{content:"";position:absolute;left:-22px;top:6px;width:11px;height:11px;border-radius:50%;background:#05070d;box-shadow:inset 0 0 0 2px #f5d97a}
.wpp-m.gold::before{background:#f5d97a;box-shadow:0 0 12px rgba(245,217,122,.8)}
.wpp-m .d{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;text-transform:uppercase}
.wpp-m h4{margin:4px 0 0;font:700 20px/1.1 var(--font-oswald),sans-serif;text-transform:uppercase}
.wpp-m p{margin:4px 0 0;font-size:13.5px;line-height:1.5;color:#9aa4b8}
.wpp-m .sc{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;font:700 12px var(--font-sora),sans-serif;background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.wpp-nextgame{margin-top:6px;padding:14px 16px;border-radius:16px;background:linear-gradient(120deg,rgba(245,217,122,.08),transparent 60%),rgba(255,255,255,.02);box-shadow:inset 0 0 0 1px rgba(245,217,122,.3)}
.wpp-nextgame .k{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#f5d97a;text-transform:uppercase}.wpp-nextgame p{margin:4px 0 0;font-size:13.5px;color:#cbd5e1}
.wpp-rt{display:grid;gap:9px;margin-top:12px}
.wpp-rt div{display:grid;grid-template-columns:82px 1fr 30px;align-items:center;gap:8px;font:600 11px var(--font-oswald),sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#cbd5e1}
.wpp-rt i{height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}.wpp-rt i::after{content:"";display:block;height:100%;width:var(--v);background:linear-gradient(90deg,#c9a24a,#fff3c4);border-radius:3px}
.wpp-rt em{font:800 12px var(--font-sora),sans-serif;font-style:normal;color:#fff;text-align:right}
.wpp-ec{margin-top:16px;display:flex;flex-direction:column;gap:4px}.wpp-ec>span{font:600 10px var(--font-oswald),sans-serif;letter-spacing:.22em;color:#94a3b8;text-transform:uppercase}
.wpp-ec a{color:#fff;font:600 14px var(--font-sora),sans-serif;text-decoration:none}.wpp-ec em{font:700 italic 13px var(--font-playfair),serif;color:#cbd5e1}
.wpp-muted{margin:12px 0 0;font-size:12.5px;color:#64748b}
.wpp-end{padding:30px 22px 60px;text-align:center}
.wpp-end img{width:54px;opacity:.9}.wpp-end p{margin:10px 0 0;font:700 italic 15px var(--font-playfair),serif;color:#cbd5e1}
@media (prefers-reduced-motion: reduce){.wpp{clip-path:none!important;transition:opacity .2s;opacity:0}.wpp.on{opacity:1}.wpp *{animation:none!important;transition:none!important}.wpp-nm b,.wpp-ring,.wpp-line,.wpp-big,.wpp-rings i,.wpp-strip button{opacity:1!important;transform:none!important}.wpp-st .med{filter:none}.wpp-st .cone{opacity:1}}
`;
