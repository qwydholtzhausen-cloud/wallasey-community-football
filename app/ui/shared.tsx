import { useEffect, useRef, useState } from "react";

// True unless the phone's Reduce Motion setting is on.
export function motionAllowed() {
  return typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// "A, B, C and 4 more" - enough names to recognise people without a
// card that runs to ten lines.
export function listNames(names: string[], max = 4) {
  if (names.length <= max) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

// Avatar chips have no profile-photo feature to draw on, so we derive a
// stable initial + gradient per player from their name (same person always
// gets the same colour, no lookup table to maintain).
export const AVATAR_GRADIENTS = [
  "linear-gradient(140deg,#5B6CFF,#8A5CFF)",
  "linear-gradient(140deg,#e63946,#f0ac3c)",
  "linear-gradient(140deg,#22c55e,#1b8f52)",
  "linear-gradient(140deg,#f0ac3c,#e63946)",
  "linear-gradient(140deg,#2E74CC,#5B6CFF)",
  "linear-gradient(140deg,#8A5CFF,#e63946)",
];
export function avatarFor(name: string) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { initial, gradient: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] };
}

// A real uploaded photo, when set, always wins over the generated
// initial+gradient chip - same className either way so every existing
// avatar-chip CSS rule (size/shape/centering) just works for both.
export function Avatar({
  name,
  avatarUrl,
  className,
  background,
  style,
}: {
  name: string;
  avatarUrl?: string | null;
  className: string;
  background?: string;
  style?: React.CSSProperties;
}) {
  if (avatarUrl) {
    return <img className={className} src={avatarUrl} alt={name} style={style} />;
  }
  const initial = (name.trim()[0] || "?").toUpperCase();
  return (
    <span className={className} style={background ? { background, ...style } : style}>
      {initial}
    </span>
  );
}

// Subtle touches: a number that rolls in when it changes (never on first
// render), and a match-day countdown that ticks every second in the last
// hour before kickoff.
// True for a moment after `value` changes (by `test`, default any change),
// so the animation class survives the re-renders that follow.
export function useChanged<T>(value: T, test: (prev: T, next: T) => boolean = (a, b) => a !== b, holdMs = 900) {
  const prev = useRef(value);
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    const hit = test(prev.current, value);
    prev.current = value;
    if (!hit) return;
    setFlag(true);
    const t = setTimeout(() => setFlag(false), holdMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return flag;
}
export function TickNum({ value }: { value: number }) {
  const changed = useChanged(value);
  return <span key={value} className={"wcf-tick" + (changed ? " roll" : "")}>{value}</span>;
}

export function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export type PotCategory = "pitch" | "socials" | "equipment" | "sponsorship" | "other";

export const POT_CATEGORY_LABEL: Record<PotCategory, string> = {
  pitch: "Pitch hire",
  socials: "Socials",
  equipment: "Equipment",
  sponsorship: "Sponsorship",
  other: "Other",
};

// Picks black or white text so admin-chosen team colours stay readable
// regardless of how light/dark the colour they picked is.
export function readableTextColor(hex: string) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0d0d1a" : "#ffffff";
}

// Derives a light/dark gradient pair from a club's configured team colour so
// jersey chips stay correct even if an admin picks a colour other than
// literal red/white - same "respect the real setting" pattern as the rest
// of the Line-up screen already uses team_*_color for.
export function teamGradient(hex: string) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const mix = (v: number, target: number, amt: number) => Math.round(v + (target - v) * amt);
  const light = `rgb(${mix(r, 255, 0.35)},${mix(g, 255, 0.35)},${mix(b, 255, 0.35)})`;
  const dark = `rgb(${mix(r, 0, 0.35)},${mix(g, 0, 0.35)},${mix(b, 0, 0.35)})`;
  return `linear-gradient(160deg,${light},${dark})`;
}

export type PlayerPosition = "keeper" | "defence" | "midfield" | "attack";

export const POSITION_LABEL: Record<PlayerPosition, string> = { keeper: "Keeper", defence: "Defence", midfield: "Midfield", attack: "Attack" };

export const POSITIONS: PlayerPosition[] = ["keeper", "defence", "midfield", "attack"];

// Same collapse pattern as "View players"/Tabs elsewhere - reused here as
// a small generic wrapper since Account groups several of these back to
// back (settings, rating, guides, and - for admins - roles/log/settings/
// awards) rather than each hand-rolling its own toggle button.
// A note on the Teams tab: line icon, short title, one specific line.
// Gold = a tip, red = a real imbalance, green = all good.
export function TeamCallout({ tone, icon, title, children }: { tone: "gold" | "red" | "green"; icon: "glove" | "scale" | "split" | "check"; title: string; children: React.ReactNode }) {
  const paths: Record<typeof icon, React.ReactNode> = {
    glove: <path d="M7 21h9a3 3 0 0 0 3-3v-6.5a1.5 1.5 0 0 0-3 0V11V5.5a1.5 1.5 0 0 0-3 0V10V4.5a1.5 1.5 0 0 0-3 0V10V6.5a1.5 1.5 0 0 0-3 0V14l-1.6-1.6a1.6 1.6 0 0 0-2.3 2.2L7 19" />,
    scale: <path d="M12 3v18M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z" />,
    split: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
    check: <path d="M5 12l5 5L20 7" />,
  };
  return (
    <div className={"wcf-callout " + tone}>
      <span className="wcf-callout-ic">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[icon]}</svg>
      </span>
      <div>
        <div className="wcf-callout-t">{title}</div>
        <div className="wcf-callout-b">{children}</div>
      </div>
    </div>
  );
}
