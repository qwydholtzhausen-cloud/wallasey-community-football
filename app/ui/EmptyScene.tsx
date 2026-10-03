import { useEffect, useState } from "react";
import { motionAllowed } from "./shared";

// ── Empty screens ──
// A small football scene in place of a grey "nothing here" line. Reduce
// Motion gets the finished picture.
export type EmptyKind = "feed" | "fixtures" | "results" | "sheet" | "inbox" | "paid";
export function EmptyScene({ kind, title, text, small, children }: { kind: EmptyKind; title: string; text: string; small?: boolean; children?: React.ReactNode }) {
  const [lit, setLit] = useState(false);
  const [sb, setSb] = useState<[string, string]>(["–", "–"]);
  useEffect(() => {
    const r = requestAnimationFrame(() => setLit(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    if (kind !== "results" || !motionAllowed()) return;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      if (i < 16) setSb([String(Math.floor(Math.random() * 10)), String(Math.floor(Math.random() * 10))]);
      else { setSb(["–", "–"]); clearInterval(iv); }
    }, 85);
    return () => clearInterval(iv);
  }, [kind]);
  const v = (o: Record<string, string>) => o as React.CSSProperties;
  const light = (x: number, d: number, flip: boolean) => (
    <g key={x} style={v({ "--d": d + "s" })}>
      <polygon className="wcf-es-cone" points={`${x - 6},22 ${x + 6},22 ${flip ? x - 70 : x + 70},150 ${flip ? x - 10 : x + 10},150`} fill="url(#wcfEsCone)" />
      <rect x={x - 1.5} y="22" width="3" height="128" fill="#475569" />
      <rect className="wcf-es-lamp" x={x - 10} y="12" width="20" height="10" rx="2" />
    </g>
  );
  const shirt = (x: number) => `M${x - 13} 40 L${x - 5} 34 L${x} 37 L${x + 5} 34 L${x + 13} 40 L${x + 9} 47 L${x + 7} 45 V70 H${x - 7} V45 L${x - 9} 47 Z`;
  let art: React.ReactNode = null;
  if (kind === "feed")
    art = (
      <svg viewBox="0 0 280 170">
        <defs>
          <linearGradient id="wcfEsCone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff8db" stopOpacity=".55" /><stop offset="1" stopColor="#fff8db" stopOpacity="0" /></linearGradient>
          <linearGradient id="wcfEsTurf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#14532d" /><stop offset="1" stopColor="#0b2e1a" /></linearGradient>
        </defs>
        <path d="M30 150 L70 92 H210 L250 150 Z" fill="url(#wcfEsTurf)" />
        {light(24, 0.2, false)}{light(256, 0.6, true)}{light(70, 1, false)}{light(210, 1.3, true)}
        <g className="wcf-es-lines" fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.4">
          <path pathLength={1} d="M36 146 L72 95 H208 L244 146 Z" style={v({ "--d": "1.6s", "--t": "1.1s" })} />
          <path pathLength={1} d="M140 95 V146" style={v({ "--d": "2s", "--t": ".5s" })} />
          <ellipse pathLength={1} cx="140" cy="119" rx="22" ry="8" style={v({ "--d": "2.2s", "--t": ".6s" })} />
        </g>
        <g className="wcf-es-ball"><circle cx="140" cy="117" r="5" fill="#fff" /><path d="M138 115l2-1 2 1-1 2h-2z" fill="#0d0d1a" /></g>
      </svg>
    );
  if (kind === "fixtures")
    art = (
      <svg viewBox="0 0 280 150">
        <rect x="20" y="10" width="240" height="130" rx="8" fill="#0f3d24" />
        <g className="wcf-es-lines" fill="none" stroke="rgba(255,255,255,.8)" strokeWidth="2">
          <rect pathLength={1} x="32" y="20" width="216" height="110" style={v({ "--d": ".1s", "--t": "1.6s" })} />
          <path pathLength={1} d="M140 20 V130" style={v({ "--d": ".2s", "--t": "2.2s" })} />
          <circle pathLength={1} cx="140" cy="75" r="20" style={v({ "--d": "1.4s", "--t": ".9s" })} />
          <path pathLength={1} d="M32 50 H62 V100 H32" style={v({ "--d": "1.9s", "--t": ".7s" })} />
          <path pathLength={1} d="M248 50 H218 V100 H248" style={v({ "--d": "2.2s", "--t": ".7s" })} />
        </g>
        <g className="wcf-es-marker">
          <g transform="translate(140 75)">
            <rect x="-9" y="-7" width="18" height="12" rx="2" fill="#e63946" />
            <circle cx="-6" cy="7" r="3" fill="#1e293b" /><circle cx="6" cy="7" r="3" fill="#1e293b" />
            <path d="M9 -5 L18 -16" stroke="#cbd5e1" strokeWidth="2" />
          </g>
        </g>
      </svg>
    );
  if (kind === "results")
    art = (
      <svg viewBox="0 0 280 140">
        <rect x="20" y="14" width="240" height="112" rx="12" fill="#0b1220" stroke="rgba(148,163,184,.25)" />
        <text x="80" y="42" textAnchor="middle" className="wcf-es-sblabel">WHITES</text>
        <text x="200" y="42" textAnchor="middle" className="wcf-es-sblabel">REDS</text>
        <rect x="52" y="54" width="56" height="54" rx="7" fill="#111a2e" />
        <rect x="172" y="54" width="56" height="54" rx="7" fill="#111a2e" />
        <line x1="52" y1="81" x2="108" y2="81" stroke="#000" strokeOpacity=".6" />
        <line x1="172" y1="81" x2="228" y2="81" stroke="#000" strokeOpacity=".6" />
        <text x="80" y="94" textAnchor="middle" className="wcf-es-sb" fill="#f5d97a">{sb[0]}</text>
        <text x="200" y="94" textAnchor="middle" className="wcf-es-sb" fill="#e63946">{sb[1]}</text>
        <circle cx="140" cy="72" r="3" fill="#475569" /><circle cx="140" cy="90" r="3" fill="#475569" />
      </svg>
    );
  if (kind === "sheet")
    art = (
      <svg viewBox="0 0 280 100">
        <rect x="14" y="22" width="252" height="6" rx="3" fill="#7c5a32" />
        {Array.from({ length: 8 }, (_, i) => {
          const x = 30 + i * 31;
          return (
            <g key={i}>
              <circle cx={x} cy="30" r="3.5" fill="#94a3b8" />
              {i === 0 ? (
                <g className="wcf-es-swing">
                  <path d={shirt(x)} fill="#e63946" />
                  <text x={x} y="61" textAnchor="middle" className="wcf-es-num">1</text>
                </g>
              ) : (
                <path d={shirt(x)} fill="none" stroke="rgba(148,163,184,.3)" strokeDasharray="3 3" />
              )}
            </g>
          );
        })}
        <rect x="14" y="84" width="252" height="10" rx="3" fill="#334155" />
      </svg>
    );
  if (kind === "inbox")
    art = (
      <svg viewBox="0 0 280 120">
        <rect x="70" y="14" width="140" height="92" rx="10" fill="#e63946" />
        <rect x="92" y="40" width="96" height="22" rx="4" fill="#7f1d1d" />
        <rect className="wcf-es-flapdoor" x="90" y="38" width="100" height="14" rx="3" fill="#cbd5e1" />
        <text x="140" y="90" textAnchor="middle" className="wcf-es-sblabel" fill="#fff" opacity=".8">LETTERS</text>
      </svg>
    );
  if (kind === "paid")
    art = (
      <svg viewBox="0 0 280 130">
        <path d="M102 22 H178 V30 Q192 36 192 54 V104 Q192 116 178 116 H102 Q88 116 88 104 V54 Q88 36 102 30 Z" fill="rgba(148,163,184,.08)" stroke="rgba(203,213,225,.5)" strokeWidth="2" />
        {[[120, 92, 0.3], [140, 96, 0.5], [160, 92, 0.7], [130, 82, 0.9], [150, 84, 1.1], [140, 72, 1.3]].map(([x, y, d]) => (
          <ellipse key={`${x}-${y}`} className="wcf-es-coin" style={v({ animationDelay: d + "s" })} cx={x} cy={y} rx="12" ry="5" fill="#f5d97a" stroke="#b8892a" />
        ))}
        <rect x="98" y="14" width="84" height="10" rx="3" fill="#475569" />
        <g className="wcf-es-stamp">
          <g transform="rotate(-12 140 64)">
            <rect x="76" y="48" width="128" height="32" rx="6" fill="none" stroke="#22c55e" strokeWidth="3" />
            <text x="140" y="70" textAnchor="middle" className="wcf-es-stamptext">ALL SQUARE</text>
          </g>
        </g>
      </svg>
    );
  return (
    <div className={"wcf-es " + kind + (small ? " small" : "") + (lit ? " lit" : "")}>
      {art}
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}
