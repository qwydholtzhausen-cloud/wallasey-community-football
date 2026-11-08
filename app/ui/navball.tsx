import { useLayoutEffect, useRef } from "react";

// A football on the nav bar. Changing tab rolls it to the new tab (or lobs it
// over two or more), the tab's icon traps it and a little turf kicks up. The
// red pill travels at the ball's pace. Only rendered with Movement on, which
// is never under Reduce Motion.

const ROLL_MS = 460;
const LOB_MS = 620;

export function NavBall({ index }: { index: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const at = useRef<{ x: number; spin: number } | null>(null);

  useLayoutEffect(() => {
    const ball = ref.current;
    const nav = ball?.parentElement;
    const btn = nav?.querySelectorAll<HTMLElement>(".wcf-navbtn")[index];
    if (!ball || !nav || !btn) return;
    const n = nav.getBoundingClientRect(), r = btn.getBoundingClientRect();
    const x = r.left - n.left + r.width / 2 - 9;
    const from = at.current;
    if (!from || Math.abs(from.x - x) < 2) {
      ball.style.transform = `translateX(${x}px)`;
      at.current = { x, spin: from?.spin ?? 0 };
      return;
    }
    const dist = x - from.x;
    const hops = Math.round(Math.abs(dist) / r.width);
    const lob = hops >= 2;
    const ms = lob ? LOB_MS : ROLL_MS;
    const spin = from.spin + dist * (lob ? 1.2 : 2.6);
    at.current = { x, spin };
    const pill = nav.querySelector<HTMLElement>(".wcf-nav-pill");
    if (pill) pill.style.transitionDuration = `${ms}ms`;
    ball.style.transform = `translateX(${x}px)`;
    ball.animate([{ transform: `translateX(${from.x}px)` }, { transform: `translateX(${x}px)` }], { duration: ms, easing: lob ? "cubic-bezier(.4,.1,.4,1)" : "cubic-bezier(.3,.2,.2,1)" });
    const svg = ball.querySelector("svg")!;
    svg.style.transform = `rotate(${spin}deg)`;
    svg.animate([{ transform: `rotate(${from.spin}deg)` }, { transform: `rotate(${spin}deg)` }], { duration: ms, easing: "ease-out" });
    if (lob) {
      const h = 26 + hops * 6;
      ball.querySelector(".air")!.animate(
        [{ transform: "translateY(0)" }, { transform: `translateY(-${h}px)`, offset: 0.45 }, { transform: "translateY(0)", offset: 0.86 }, { transform: "translateY(-5px)", offset: 0.93 }, { transform: "translateY(0)" }],
        { duration: ms, easing: "ease-in-out" }
      );
      ball.querySelector(".sh")!.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(.45)", opacity: 0.35, offset: 0.45 }, { transform: "scale(1)", opacity: 1, offset: 0.86 }, { transform: "scale(1)", opacity: 1 }], { duration: ms });
    }
    const t = setTimeout(() => {
      btn.classList.remove("trap");
      void btn.offsetWidth;
      btn.classList.add("trap");
      ball.querySelectorAll<HTMLElement>(".scuff").forEach((s, i) => {
        const a = (i / 4) * Math.PI - Math.PI;
        s.animate([{ transform: "translate(0,0)", opacity: 0.9 }, { transform: `translate(${Math.cos(a) * 9}px,${Math.sin(a) * 7}px)`, opacity: 0 }], { duration: 380, easing: "ease-out" });
      });
    }, ms * (lob ? 0.86 : 0.8));
    return () => clearTimeout(t);
  }, [index]);

  return (
    <span className="wcf-navball" ref={ref} aria-hidden="true">
      <span className="sh" />
      <span className="air">
        <svg viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="9" fill="#fff" stroke="#111" strokeWidth="1" />
          <path d="M10 5l3 2.2-1.1 3.6H8.1L7 7.2z" fill="#111" />
          <path d="M10 1v4M13 7.2l4.5-1.5M11.9 10.8l2.8 3.7M8.1 10.8l-2.8 3.7M7 7.2L2.5 5.7" stroke="#111" strokeWidth=".9" />
        </svg>
      </span>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className="scuff" />
      ))}
    </span>
  );
}

export const navBallCss = `
.wcf-navball{position:absolute;top:-8px;left:0;width:18px;height:18px;z-index:5;pointer-events:none}
.wcf-navball .sh{position:absolute;left:2px;right:2px;bottom:-3px;height:4px;border-radius:50%;background:rgba(0,0,0,.55);filter:blur(1px)}
.wcf-navball .air{position:absolute;inset:0}
.wcf-navball svg{width:18px;height:18px;display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))}
.wcf-navball .scuff{position:absolute;left:8px;bottom:-2px;width:3px;height:3px;border-radius:50%;background:#4ade80;opacity:0}
.wcf-navbtn.trap svg{animation:wcfNavTrap .32s cubic-bezier(.3,1.6,.5,1)}
@keyframes wcfNavTrap{35%{transform:translateY(3px) scale(.9)}}
`;
