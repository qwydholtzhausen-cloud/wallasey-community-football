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
