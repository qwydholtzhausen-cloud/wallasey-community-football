import { useEffect, useRef, useState } from "react";
import type { PayStatus, Role } from "../WirralCommunityFootball";

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
  return (
    <span key={value} className={"wcf-tick" + (changed ? " roll" : "")}>
      {value}
    </span>
  );
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
export function TeamCallout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "gold" | "red" | "green";
  icon: "glove" | "scale" | "split" | "check";
  title: string;
  children: React.ReactNode;
}) {
  const paths: Record<typeof icon, React.ReactNode> = {
    glove: (
      <path d="M7 21h9a3 3 0 0 0 3-3v-6.5a1.5 1.5 0 0 0-3 0V11V5.5a1.5 1.5 0 0 0-3 0V10V4.5a1.5 1.5 0 0 0-3 0V10V6.5a1.5 1.5 0 0 0-3 0V14l-1.6-1.6a1.6 1.6 0 0 0-2.3 2.2L7 19" />
    ),
    scale: <path d="M12 3v18M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z" />,
    split: <path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" />,
    check: <path d="M5 12l5 5L20 7" />,
  };
  return (
    <div className={"wcf-callout " + tone}>
      <span className="wcf-callout-ic">
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {paths[icon]}
        </svg>
      </span>
      <div>
        <div className="wcf-callout-t">{title}</div>
        <div className="wcf-callout-b">{children}</div>
      </div>
    </div>
  );
}

export function AccordionSection({
  icon,
  tone,
  title,
  meta,
  value,
  valueTone,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  tone?: "blue" | "amber" | "red";
  title: string;
  meta?: string;
  value?: string;
  valueTone?: "ok" | "add";
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={"wcf-acc-section" + (open ? " open" : "")}>
      <button className="wcf-acc-section-head" onClick={onToggle} aria-expanded={open}>
        <span className={"wcf-acc-section-tile" + (tone ? " " + tone : "")}>{icon}</span>
        <span className="wcf-acc-section-body">
          <span className="wcf-acc-section-title">{title}</span>
          {meta && <span className="wcf-acc-section-meta">{meta}</span>}
        </span>
        {value && <span className={"wcf-acc-section-value" + (valueTone ? " " + valueTone : "")}>{value}</span>}
        <span className="wcf-acc-section-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {open && (
        <div className="wcf-acc-section-panel">
          <div className="wcf-acc-section-panel-inner">{children}</div>
        </div>
      )}
    </div>
  );
}

// Line icons for the Account settings rows, in place of the old ◆ ★ ◎
// symbol tiles.
export function SetIcon({ name }: { name: "bell" | "user" | "phone" | "cake" | "star" | "mobile" | "mail" | "users" | "list" | "gear" | "trophy" | "shield" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    bell: (
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    phone: (
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    ),
    cake: (
      <>
        <rect x="3" y="10" width="18" height="11" rx="2" />
        <path d="M12 10V6M8 10V7M16 10V7M3 15c3 2 6-2 9 0s6 2 9 0" />
      </>
    ),
    star: <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z" />,
    mobile: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="2.5" />
        <path d="M11 18h2" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
      </>
    ),
    list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>
    ),
    trophy: (
      <>
        <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" />
        <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
      </>
    ),
    shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function StatusBadge({ status }: { status: PayStatus }) {
  return <span className={"wcf-status-badge " + status}>{STATUS_LABEL[status]}</span>;
}

// "Payment Pending" for someone who hasn't paid read backwards - like
// something was already in motion, not that nothing had happened yet.
export const STATUS_LABEL: Record<PayStatus, string> = {
  unpaid: "Awaiting Payment",
  pending: "Pending Approval",
  confirmed: "Confirmed",
};

export const ROLE_LABEL: Record<Role, string> = { player: "Player", admin: "Admin", "co-owner": "Co-Owner", owner: "Owner" };

export const MAX_SPOTS = 16;

// Free-tier Supabase storage is 1GB total / 50MB per file - images get
// compressed client-side so dozens of them barely register, video doesn't
// compress the same way so it gets a hard cap instead, well under the
// per-file limit and mindful of the total budget.
export const MAX_AWARD_VIDEO_MB = 25;

// Convenience hub, not new data - apps/goals/MOTM already exist scattered
// across Stats and the MOTM tallies, and rating already exists in Fairness
// and Account. This is just the first place all four sit together for one
// person. Ratings only render for an admin or the player's own card - same
// privacy rule as everywhere else - rather than showing a "private"
// placeholder that'd tease data that isn't there for anyone else.
export function ratingFillColor(v: number) {
  // amber below 2.5, green above 4, blue in between - reads at a glance without a legend
  return v >= 4 ? "#22c55e" : v < 2.5 ? "#eab308" : "#2E74CC";
}
