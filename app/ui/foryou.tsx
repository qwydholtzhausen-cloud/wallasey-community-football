"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// "For you": everything on Fixtures that wants the player (the MOTM vote,
// rating the game, money owed, the programme, Wrapped, rating yourself)
// in one carousel at the top instead of a stack of separate cards pushing
// the next game off the first screen. It stays put: swiping or tapping the
// bars browses, doing the thing clears it, and the × removes it after a
// few seconds to undo. With nothing left it keeps its size and says when
// the next game is.

export type ForYouItem = {
  id: string;
  accent: string;
  photo: string;
  lead: ReactNode; // icon in a ring, or a big amount
  eyebrow: string;
  title: string;
  sub?: string;
  chip: string; // short name for the "Also" row and the undo line
  // The action row: either one button, or custom content (faces, meter)
  // that calls done() to stamp the card before its action runs.
  primary?: { label: string; onClick: () => void; red?: boolean };
  body?: (done: (msg: string, then: () => void) => void) => ReactNode;
  onRemove: () => void;
};

export function ForYou({ items, caughtUp }: { items: ForYouItem[]; caughtUp: string }) {
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(0);
  const [hidden, setHidden] = useState<string[]>([]);
  const [undo, setUndo] = useState<ForYouItem | null>(null);
  const [stamp, setStamp] = useState<string | null>(null);
  const pending = useRef<{ item: ForYouItem; t: number } | null>(null);
  const drag = useRef<{ x: number; dx: number; moved: boolean } | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  // A removal only sticks once the undo window has passed (or the screen
  // changes), so Undo never has to put anything back.
  function commit() {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.t);
    pending.current = null;
    p.item.onRemove();
    setHidden((h) => h.filter((id) => id !== p.item.id));
    setUndo(null);
  }
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const live = items.filter((i) => !hidden.includes(i.id));
  const cur = Math.max(0, Math.min(idx, live.length - 1));
  const it = live[cur];

  function go(k: number) {
    if (k === cur || k < 0 || k >= live.length) return;
    setDir(k > cur ? 1 : -1);
    setIdx(k);
  }
  function remove(item: ForYouItem) {
    commit();
    setDir(0);
    setHidden((h) => [...h, item.id]);
    setUndo(item);
    pending.current = { item, t: window.setTimeout(commit, 3500) };
  }
  function restore() {
    const p = pending.current;
    if (!p) return;
    window.clearTimeout(p.t);
    pending.current = null;
    setHidden((h) => h.filter((id) => id !== p.item.id));
    setUndo(null);
    setDir(-1);
    setIdx(Math.max(0, items.filter((i) => i.id === p.item.id || !hidden.includes(i.id)).findIndex((i) => i.id === p.item.id)));
  }
  function done(msg: string, then: () => void) {
    setStamp(msg);
    window.setTimeout(() => {
      setStamp(null);
      setDir(0);
      then();
    }, 850);
  }

  function onDown(e: React.PointerEvent) {
    if (!it) return;
    drag.current = { x: e.clientX, dx: 0, moved: false };
  }
  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !itemRef.current) return;
    d.dx = e.clientX - d.x;
    if (Math.abs(d.dx) > 6) d.moved = true;
    const edge = (d.dx > 0 && cur === 0) || (d.dx < 0 && cur === live.length - 1);
    itemRef.current.style.transition = "none";
    itemRef.current.style.transform = `translateX(${edge ? d.dx * 0.25 : d.dx}px)`;
    itemRef.current.style.opacity = String(1 - Math.min(0.5, Math.abs(d.dx) / 360));
  }
  function onUp() {
    const d = drag.current;
    if (!d) return;
    if (itemRef.current) {
      itemRef.current.style.transition = "";
      itemRef.current.style.transform = "";
      itemRef.current.style.opacity = "";
    }
    if (d.dx < -60) go(cur + 1);
    else if (d.dx > 60) go(cur - 1);
    window.setTimeout(() => (drag.current = null), 30);
  }
  // A drag that ends over a button mustn't also press it.
  const swallow = (e: React.MouseEvent) => {
    if (drag.current?.moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const acc = it ? it.accent : "#4ade80";
  return (
    <section className={"wcf-fy" + (it ? "" : " empty")} style={{ ["--acc" as string]: acc }} aria-label="For you">
      <style>{forYouCss}</style>
      <div className="wcf-fy-bg" key={it ? it.id : "empty"} style={{ backgroundImage: `url(${it ? it.photo : "/pitch-goal-night.jpg"})` }} />
      <div className="wcf-fy-top">
        <span className="wcf-fy-k">For you</span>
        {it && <span className="wcf-fy-n">· {cur + 1} of {live.length}</span>}
        {live.length > 1 && (
          <div className="wcf-fy-segs">
            {live.map((x, i) => (
              <button key={x.id} className={i === cur ? "cur" : ""} onClick={() => go(i)} aria-label={x.chip} />
            ))}
          </div>
        )}
      </div>
      <div className="wcf-fy-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClickCapture={swallow}>
        {it ? (
          <div ref={itemRef} key={it.id} className={"wcf-fy-item" + (dir > 0 ? " in-r" : dir < 0 ? " in-l" : " in")}>
            <button className="wcf-fy-x" onClick={() => remove(it)} aria-label={`Remove ${it.chip}`}>
              ✕
            </button>
            <div className="wcf-fy-row">
              {it.lead}
              <div className="wcf-fy-tx">
                <small>{it.eyebrow}</small>
                <b>{it.title}</b>
                {it.sub && <span>{it.sub}</span>}
              </div>
            </div>
            <div className="wcf-fy-act">
              {it.body
                ? it.body(done)
                : it.primary && (
                    <button className={"wcf-fy-go" + (it.primary.red ? " red" : "")} onClick={it.primary.onClick}>
                      {it.primary.label}
                    </button>
                  )}
            </div>
            {stamp && <div className="wcf-fy-stamp">{stamp}</div>}
          </div>
        ) : (
          <div className="wcf-fy-item wcf-fy-done in">
            <svg viewBox="0 0 28 28" width="34" height="34" aria-hidden="true">
              <circle cx="14" cy="14" r="12" />
              <path d="M8.5 14.5l3.5 3.5 7.5-8" />
            </svg>
            <b>All caught up</b>
            <span>{caughtUp}</span>
          </div>
        )}
      </div>
      <div className="wcf-fy-next">
        {undo ? (
          <>
            <em>Removed</em>
            <span className="wcf-fy-undo-tx">{undo.chip}</span>
            <button className="wcf-fy-undo" onClick={restore}>
              Undo
            </button>
          </>
        ) : live.length > 1 ? (
          <>
            <em>Also</em>
            {live.map((x, i) =>
              i === cur ? null : (
                <button key={x.id} className="wcf-fy-chip" style={{ ["--c" as string]: x.accent }} onClick={() => go(i)}>
                  <i />
                  {x.chip}
                </button>
              )
            )}
          </>
        ) : (
          <em>{it ? "Last one" : "Nothing waiting"}</em>
        )}
      </div>
    </section>
  );
}

// Round icon used as an item's lead.
export function ForYouIcon({ children }: { children: ReactNode }) {
  return <div className="wcf-fy-ic">{children}</div>;
}

// The 1-5 rating blocks, same scale as the full rating sheet.
export function ForYouMeter({ onRate }: { onRate: (n: number) => void }) {
  return (
    <div className="wcf-fy-meter" role="radiogroup" aria-label="Rate the game">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={false} aria-label={`${n} of 5`} onClick={() => onRate(n)} />
      ))}
    </div>
  );
}

export const forYouCss = `
.wcf-fy{--acc:#f5d97a;position:relative;border-radius:22px;overflow:hidden;margin:0 0 18px;border:1px solid color-mix(in srgb,var(--acc) 45%,transparent);background:#0f1424;box-shadow:0 22px 44px -26px rgba(0,0,0,.9),0 0 34px -16px var(--acc);transition:box-shadow .5s,border-color .5s}
.wcf-fy.empty{border-color:rgba(34,197,94,.4);box-shadow:0 0 30px -18px #22c55e}
.wcf-fy-bg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.55;animation:wcfFyBg .5s ease both}
@keyframes wcfFyBg{from{opacity:0}}
.wcf-fy-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(12,15,28,.97) 28%,rgba(12,15,28,.62) 68%,rgba(12,15,28,.3)),linear-gradient(0deg,rgba(12,15,28,.92),transparent 55%)}
.wcf-fy-top{position:relative;display:flex;align-items:center;gap:8px;padding:13px 15px 0}
.wcf-fy-k{font:600 11px var(--font-oswald),sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#f5d97a}
.wcf-fy-n{font:700 11px var(--sans);color:#94a3b8}
.wcf-fy-segs{margin-left:auto;display:flex;gap:4px;width:40%}
.wcf-fy-segs button{flex:1;height:3px;padding:0;border:0;border-radius:2px;background:rgba(255,255,255,.16);cursor:pointer;position:relative}
.wcf-fy-segs button::before{content:"";position:absolute;left:0;right:0;top:-8px;bottom:-8px}
.wcf-fy-segs button.cur{background:var(--acc);box-shadow:0 0 8px var(--acc)}
.wcf-fy-stage{position:relative;height:150px;touch-action:pan-y}
.wcf-fy-item{position:absolute;inset:0;padding:12px 15px 14px;display:flex;flex-direction:column;justify-content:space-between;transition:transform .35s cubic-bezier(.2,.9,.3,1),opacity .3s}
.wcf-fy-item.in{animation:wcfFyIn .4s cubic-bezier(.2,.9,.3,1) both}
.wcf-fy-item.in-r{animation:wcfFyInR .4s cubic-bezier(.2,.9,.3,1) both}
.wcf-fy-item.in-l{animation:wcfFyInL .4s cubic-bezier(.2,.9,.3,1) both}
@keyframes wcfFyIn{from{opacity:0;transform:translateY(8px)}}
@keyframes wcfFyInR{from{opacity:0;transform:translateX(56px)}}
@keyframes wcfFyInL{from{opacity:0;transform:translateX(-56px)}}
.wcf-fy-x{position:absolute;top:8px;right:10px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;padding:0;font:700 12px var(--sans);color:#cbd5e1;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);cursor:pointer;z-index:3}
.wcf-fy-row{display:flex;align-items:center;gap:13px;min-width:0;padding-right:30px}
.wcf-fy-ic{width:48px;height:48px;border-radius:50%;flex:none;display:grid;place-items:center;border:2px solid var(--acc);box-shadow:0 0 20px -4px var(--acc),inset 0 0 12px rgba(0,0,0,.5);background:rgba(0,0,0,.4);color:var(--acc)}
.wcf-fy-amt{font:800 34px/1 var(--display);color:#fff;letter-spacing:-.03em;flex:none;text-shadow:0 0 24px rgba(255,90,102,.45)}
.wcf-fy-tx{min-width:0;flex:1}
.wcf-fy-tx small{display:block;font:600 10.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:var(--acc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-fy-tx b{display:block;font:800 18px/1.15 var(--display);color:#fff;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-fy-tx span{display:block;font:500 12px var(--sans);color:#cbd5e1;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-fy-act{display:flex;align-items:center;gap:10px;min-width:0}
.wcf-fy-go{height:38px;padding:0 20px;border:0;border-radius:12px;font:800 13px var(--display);background:var(--acc);color:#14100a;cursor:pointer;box-shadow:0 10px 22px -12px var(--acc),inset 0 1px 0 rgba(255,255,255,.35)}
.wcf-fy-go.red{background:linear-gradient(180deg,#ef4655,#d62839);color:#fff}
.wcf-fy-go:active{transform:scale(.96)}
.wcf-fy-faces{display:flex;gap:7px;min-width:0}
.wcf-fy-faces button{display:flex;flex-direction:column;align-items:center;gap:4px;width:46px;padding:0;border:0;background:none;font:700 9.5px var(--sans);color:#cbd5e1;cursor:pointer}
.wcf-fy-faces .wcf-fy-av{width:38px!important;height:38px!important;border-radius:50%;border:2px solid rgba(245,217,122,.45);font-size:14px;transition:transform .2s,border-color .2s,box-shadow .2s}
.wcf-fy-faces button.on .wcf-fy-av{border-color:#f5d97a;transform:scale(1.15);box-shadow:0 0 0 4px rgba(245,217,122,.25),0 0 20px rgba(245,217,122,.5)}
.wcf-fy-faces span{max-width:46px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-fy-all{margin-left:auto;padding:0;border:0;background:none;font:800 12px var(--sans);color:#f5d97a;text-align:right;line-height:1.3;cursor:pointer;flex:none}
.wcf-fy-all small{display:block;font:600 10px var(--sans);color:#94a3b8}
.wcf-fy-meter{display:flex;gap:6px}
.wcf-fy-meter button{width:40px;height:32px;padding:0;border-radius:9px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);cursor:pointer;transition:background .15s,border-color .15s}
.wcf-fy-meter:hover button{background:linear-gradient(180deg,#86efac,#22c55e);border-color:#4ade80}
.wcf-fy-meter button:hover~button{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14)}
.wcf-fy-next{position:relative;display:flex;align-items:center;gap:6px;padding:9px 15px 12px;border-top:1px solid rgba(255,255,255,.07);overflow-x:auto;overflow-y:hidden;scrollbar-width:none;min-height:44px;-webkit-mask:linear-gradient(90deg,#000 88%,transparent);mask:linear-gradient(90deg,#000 88%,transparent)}
.wcf-fy-next::-webkit-scrollbar{display:none}
.wcf-fy-next em{font:600 9.5px var(--font-oswald),sans-serif;letter-spacing:.22em;text-transform:uppercase;color:#94a3b8;font-style:normal;margin-right:2px;flex:none}
.wcf-fy-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px 5px 7px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);font:700 11px var(--sans);color:#e2e8f0;white-space:nowrap;flex:none;cursor:pointer}
.wcf-fy-chip i{width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.wcf-fy-undo-tx{font:700 11px var(--sans);color:#e2e8f0}
.wcf-fy-undo{margin-left:auto;padding:4px 2px;border:0;background:none;font:800 12px var(--sans);color:#f5d97a;cursor:pointer}
.wcf-fy-stamp{position:absolute;inset:0;display:grid;place-items:center;background:rgba(8,10,18,.85);font:700 21px/1.15 var(--font-oswald),sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#f5d97a;z-index:5;text-align:center;padding:0 24px;animation:wcfFyBg .2s both}
.wcf-fy-done{align-items:center;justify-content:center;text-align:center;gap:4px}
.wcf-fy-done svg circle,.wcf-fy-done svg path{fill:none;stroke:#4ade80;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.wcf-fy-done svg circle{stroke-dasharray:76;stroke-dashoffset:76;animation:wcfFyDraw .6s .15s forwards}
.wcf-fy-done svg path{stroke-dasharray:20;stroke-dashoffset:20;animation:wcfFyDraw .35s .65s forwards}
@keyframes wcfFyDraw{to{stroke-dashoffset:0}}
.wcf-fy-done b{display:block;font:800 17px var(--display);color:#fff;margin-top:4px}
.wcf-fy-done span{display:block;font:500 12px var(--sans);color:#94a3b8}
@media (prefers-reduced-motion: reduce){.wcf-fy-item,.wcf-fy-bg,.wcf-fy-stamp{animation:none!important}.wcf-fy-done svg *{animation:none!important;stroke-dashoffset:0!important}}
`;
