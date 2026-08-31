"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";
import { MOTM_VOTE_WINDOW_MINUTES, MATCH_DURATION_MINUTES, kickoffCutoff, nowInLondon, previousMonthKey } from "../lib/time";
import { predictionPoints, buildLeaderboard, buildMonthlyLeaderboards, topScorers, type ScoredPrediction } from "../lib/predictions";

// The payment link is just config, not baked into booking logic (statuses
// below), so swapping providers later only touches this one env var.
const PAYMENT_LINK = process.env.NEXT_PUBLIC_PAYMENT_LINK || "";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const MAX_SPOTS = 16;
// Free-tier Supabase storage is 1GB total / 50MB per file - images get
// compressed client-side so dozens of them barely register, video doesn't
// compress the same way so it gets a hard cap instead, well under the
// per-file limit and mindful of the total budget.
const MAX_AWARD_VIDEO_MB = 25;

type Role = "player" | "admin" | "co-owner" | "owner";
type PayStatus = "unpaid" | "pending" | "confirmed";

// "Payment Pending" for someone who hasn't paid read backwards - like
// something was already in motion, not that nothing had happened yet.
const STATUS_LABEL: Record<PayStatus, string> = {
  unpaid: "Awaiting Payment",
  pending: "Pending Approval",
  confirmed: "Confirmed",
};

function StatusBadge({ status }: { status: PayStatus }) {
  return <span className={"wcf-status-badge " + status}>{STATUS_LABEL[status]}</span>;
}

function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="wcf-star-picker">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={"wcf-star" + (n <= value ? " on" : "")} onClick={() => onChange(n)} aria-label={`${n} of 5`}>
          ★
        </button>
      ))}
    </div>
  );
}

function RatingForm({
  initial,
  onSave,
  saveLabel,
}: {
  initial: PlayerRating | null;
  onSave: (fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  saveLabel: string;
}) {
  const [fitness, setFitness] = useState(initial?.fitness ?? 3);
  const [attack, setAttack] = useState(initial?.attack ?? 3);
  const [defence, setDefence] = useState(initial?.defence ?? 3);
  const [goalkeeping, setGoalkeeping] = useState(initial?.goalkeeping ?? 3);
  const [position, setPosition] = useState<PlayerPosition>(initial?.position ?? "midfield");
  const metrics: { label: string; value: number; onChange: (n: number) => void }[] = [
    { label: "Fitness", value: fitness, onChange: setFitness },
    { label: "Attack", value: attack, onChange: setAttack },
    { label: "Defence", value: defence, onChange: setDefence },
    { label: "Goalkeeping", value: goalkeeping, onChange: setGoalkeeping },
  ];

  return (
    <div className="wcf-rating-form">
      {metrics.map((m) => (
        <div key={m.label} className="wcf-rating-row">
          <div className="wcf-rating-row-top">
            <span>{m.label}</span>
            <b>{m.value.toFixed(1)}</b>
          </div>
          <div className="wcf-rating-track">
            <div
              className="wcf-rating-fill"
              style={{
                width: `${(m.value / 5) * 100}%`,
                background: `linear-gradient(90deg,${ratingFillColor(m.value)}99,${ratingFillColor(m.value)})`,
              }}
            />
          </div>
          <StarPicker value={m.value} onChange={m.onChange} />
        </div>
      ))}
      <div className="wcf-rating-row">
        <div className="wcf-rating-row-top"><span>Position</span></div>
        <select value={position} onChange={(e) => setPosition(e.target.value as PlayerPosition)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>{POSITION_LABEL[p]}</option>
          ))}
        </select>
      </div>
      <button className="wcf-save-red" onClick={() => onSave(fitness, attack, defence, goalkeeping, position)}>{saveLabel}</button>
    </div>
  );
}

interface Profile {
  id: string;
  display_name: string;
  role: Role;
  created_at?: string;
  push_opt_in?: boolean;
  avatar_url?: string | null;
  payment_code?: string;
}

type Team = "white" | "red";

type PotExemptReason = "prize" | "carried_over" | "other";
const POT_EXEMPT_LABEL: Record<PotExemptReason, string> = { prize: "🎁 Free — prize", carried_over: "🔄 Free — carried over", other: "🎁 Free — other" };

interface BookingRow {
  id: string;
  player_id: string;
  status: PayStatus;
  waiting: boolean;
  team: Team | null;
  created_at: string;
  player: Profile;
  confirmer: { display_name: string } | null;
  pot_exempt_reason: PotExemptReason | null;
  auto_confirmed: boolean;
}

interface MonzoUnmatchedRow {
  id: string;
  amount_pence: number;
  code: string | null;
  reason: string;
  created_at: string;
  player: { display_name: string } | null;
}

interface GameRow {
  id: string;
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  max_players: number;
  pitch_cost: number;
  team_white_score: number | null;
  team_red_score: number | null;
  published: boolean;
  team_method: "generated" | "manual" | null;
  team_balance_score: number | null;
  lineup_positions: Record<string, { x: number; y: number }> | null;
  bookings: BookingRow[];
}

type PotCategory = "pitch" | "socials" | "equipment" | "sponsorship" | "other";

type PlayerPosition = "keeper" | "defence" | "midfield" | "attack";
const POSITION_LABEL: Record<PlayerPosition, string> = { keeper: "Keeper", defence: "Defence", midfield: "Midfield", attack: "Attack" };
const POSITIONS: PlayerPosition[] = ["keeper", "defence", "midfield", "attack"];

interface PlayerRating {
  player_id: string;
  fitness: number;
  attack: number;
  defence: number;
  goalkeeping: number;
  position: PlayerPosition;
}
const POT_CATEGORY_LABEL: Record<PotCategory, string> = {
  pitch: "Pitch hire",
  socials: "Socials",
  equipment: "Equipment",
  sponsorship: "Sponsorship",
  other: "Other",
};

interface PotEntry {
  id: string;
  amount: number;
  description: string;
  category: PotCategory;
  created_at: string;
}

interface MotmVote {
  id: string;
  game_id: string;
  voter_id: string;
  candidate_id: string;
}

interface FeedReaction {
  id: string;
  item_key: string;
  emoji: string;
  user_id: string;
}

interface ScorePrediction {
  id: string;
  game_id: string;
  player_id: string;
  predicted_white: number;
  predicted_red: number;
  player: { display_name: string } | null;
}

interface AuditLogEntry {
  id: string;
  action: string;
  details: string | null;
  created_at: string;
  actor: { display_name: string } | null;
}

const FEED_REACTION_EMOJI = ["👍", "🔥"] as const;

type FeedItem =
  | { key: string; ts: number; kind: "clip"; clip: ClipRow }
  | { key: string; ts: number; kind: "derived"; icon: React.ReactNode; tone: "amber" | "green" | "blue"; text: React.ReactNode };

interface ClubSettings {
  team_white_name: string;
  team_white_color: string;
  team_red_name: string;
  team_red_color: string;
  default_venue: string;
  default_kickoff: string;
  default_price: number;
  default_pitch: string;
  default_max_players: number;
  last_fixture_update_at: string | null;
}

interface AwardRow {
  id: string;
  title: string;
  value: string;
  note: string | null;
  image_url: string | null;
  video_url: string | null;
}

// Picks black or white text so admin-chosen team colours stay readable
// regardless of how light/dark the colour they picked is.
function readableTextColor(hex: string) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0d0d1a" : "#ffffff";
}

// Avatar chips have no profile-photo feature to draw on, so we derive a
// stable initial + gradient per player from their name (same person always
// gets the same colour, no lookup table to maintain).
const AVATAR_GRADIENTS = [
  "linear-gradient(140deg,#5B6CFF,#8A5CFF)",
  "linear-gradient(140deg,#e63946,#f0ac3c)",
  "linear-gradient(140deg,#22c55e,#1b8f52)",
  "linear-gradient(140deg,#f0ac3c,#e63946)",
  "linear-gradient(140deg,#2E74CC,#5B6CFF)",
  "linear-gradient(140deg,#8A5CFF,#e63946)",
];
function avatarFor(name: string) {
  const initial = (name.trim()[0] || "?").toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { initial, gradient: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] };
}

// A real uploaded photo, when set, always wins over the generated
// initial+gradient chip - same className either way so every existing
// avatar-chip CSS rule (size/shape/centering) just works for both.
function Avatar({
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

// Derives a light/dark gradient pair from a club's configured team colour so
// jersey chips stay correct even if an admin picks a colour other than
// literal red/white - same "respect the real setting" pattern as the rest
// of the Line-up screen already uses team_*_color for.
function teamGradient(hex: string) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 0;
  const g = parseInt(c.substring(2, 4), 16) || 0;
  const b = parseInt(c.substring(4, 6), 16) || 0;
  const mix = (v: number, target: number, amt: number) => Math.round(v + (target - v) * amt);
  const light = `rgb(${mix(r, 255, 0.35)},${mix(g, 255, 0.35)},${mix(b, 255, 0.35)})`;
  const dark = `rgb(${mix(r, 0, 0.35)},${mix(g, 0, 0.35)},${mix(b, 0, 0.35)})`;
  return `linear-gradient(160deg,${light},${dark})`;
}

// Positions aren't real data anywhere in the app - nothing tracks who plays
// where. This is a purely cosmetic arrangement (booking order -> slot),
// generalised to whatever squad size a fixture actually has rather than
// assuming exactly 8-a-side.
function formationSlots(n: number): { x: number; y: number; role: string }[] {
  if (n <= 0) return [];
  const slots: { x: number; y: number; role: string }[] = [{ x: 50, y: 6, role: "Goalkeeper" }];
  const outfield = n - 1;
  if (outfield <= 0) return slots;
  let rows: { count: number; role: string }[];
  if (outfield <= 3) {
    rows = [{ count: outfield, role: "Outfield" }];
  } else {
    // A single lone striker up front (like a real 1-3-3-1), with the rest
    // split between defence and midfield - defence gets the extra player
    // when the split is uneven.
    const front = 1;
    const remaining = outfield - front;
    const back = Math.ceil(remaining / 2);
    const mid = remaining - back;
    rows = mid > 0
      ? [{ count: back, role: "Defence" }, { count: mid, role: "Midfield" }, { count: front, role: "Attack" }]
      : [{ count: back, role: "Defence" }, { count: front, role: "Attack" }];
  }
  // Each team spreads across nearly its whole half, back row close to the
  // keeper (20) through front row right up against the halfway line (46.5).
  const backY = 20;
  const frontY = 46.5;
  const rowYs = rows.length === 1 ? [frontY] : rows.map((_, i) => backY + (i * (frontY - backY)) / (rows.length - 1));
  rows.forEach((row, ri) => {
    const y = rowYs[ri];
    for (let i = 0; i < row.count; i++) {
      const x = row.count === 1 ? 50 : 16 + i * (68 / (row.count - 1));
      slots.push({ x, y, role: row.role });
    }
  });
  return slots;
}

interface ClipRow {
  id: string;
  title: string;
  video_url: string | null;
  created_at: string;
  submitted_by: string | null;
  submitter: Profile | null;
}

interface AdminMessage {
  id: string;
  recipient_id: string;
  sender_id: string | null;
  message: string;
  created_at: string;
  read_at: string | null;
  recipient: { display_name: string } | null;
}

interface GoalRow {
  id: string;
  game_id: string;
  player_id: string;
  goals: number;
  own_goals: number;
  player: Profile;
}

// Same "pretend UTC" trick the cron routes use (see lib/time.ts) - needed
// here for actual millisecond arithmetic, where the rest of the client only
// ever needed string comparison against nowInLondon()'s output.
function toMs(pseudoUtc: string) {
  return new Date(pseudoUtc + ":00Z").getTime();
}

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Open-Meteo's WMO weather codes, collapsed to one emoji each. Deliberately
// not colour-coded by severity (no alarming red for rain) - this sits on
// the public browsing list before anyone's booked, and shouldn't read as a
// warning talking someone out of a spot.
function weatherIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code <= 57) return "🌦️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌦️";
  if (code <= 86) return "❄️";
  return "⛈️";
}

// Feed items are dated historical facts, not live status - without a
// visible date, something like "Pot passed £50" reads as a claim about
// right now rather than a moment that happened and may since have moved.
function fmtFeedDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Real thumbnail instead of a bare link/placeholder - YouTube serves these
// straight off img.youtube.com by video ID, no API call or key needed.
// hqdefault is used (not maxresdefault) since it's reliably generated for
// every video, where the higher-res ones sometimes aren't.
function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const match = u.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
      if (match) return match[1];
    }
  } catch {
    return null;
  }
  return null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Resizes+re-encodes a photo (typically a phone camera shot, often several
// MB) down to something that barely registers against a 1GB storage
// budget - a few thousand of these would still fit comfortably.
function compressImage(file: File, maxDim = 1600, quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("Canvas isn't supported on this device"));
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't process the image"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image"));
    };
    img.src = url;
  });
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the shareable post-match result card. Layout constants below were
// measured (not eyeballed) from a real rendered HTML/CSS version of this
// design at the same 1080x1350 size - getBoundingClientRect() on every
// element gave exact pixel offsets, since canvas has no flexbox to fall
// back on and hand-guessing this many nested paddings/gaps is exactly how
// subtle misalignments creep in. Sizing verified against several
// scorer-count and no-scorer/no-MOTM cases in that same standalone test
// (scratchpad, not part of the app) before porting the numbers in here.
async function drawResultCard(opts: {
  venue: string;
  pitch: string;
  dateLabel: string;
  whiteName: string;
  redName: string;
  whiteColor: string;
  redColor: string;
  whiteScore: number;
  redScore: number;
  whiteScorers: { name: string; goals: number }[];
  redScorers: { name: string; goals: number }[];
  ownGoals: { name: string; goals: number }[];
  motmWinner: string | null;
}): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Canvas isn't supported on this device");
  // Bound to a non-nullable type (not just narrowed) so the nested
  // drawScorerColumn closure below can use it - TS drops null-narrowing
  // across closure boundaries, but a genuinely non-nullable const is fine.
  const ctx: CanvasRenderingContext2D = ctx2d;

  // Real brand fonts (already loaded app-wide via next/font) rather than
  // system-font fallbacks - canvas text needs the resolved family name
  // since ctx.font can't consume a CSS var(), and needs document.fonts
  // ready so the first card generated in a session isn't drawn before the
  // font's actually available.
  await document.fonts.ready;
  const rootStyle = getComputedStyle(document.documentElement);
  const sora = rootStyle.getPropertyValue("--font-sora").trim() || "sans-serif";
  const inter = rootStyle.getPropertyValue("--font-inter").trim() || "sans-serif";
  const soraFont = (weight: number, size: number) => `${weight} ${size}px ${sora}`;
  const interFont = (weight: number, size: number) => `${weight} ${size}px ${inter}`;
  function letterSpaced(px: number) {
    // Canvas2D letterSpacing (Chrome/Edge/Safari 17+) - unsupported
    // browsers just ignore the assignment and draw with no spacing,
    // which still reads fine, so no fallback branch needed.
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
  }
  function resetLetterSpacing() {
    letterSpaced(0);
  }
  // Free-text fields (team names especially, since admins can rename
  // them to anything) have no natural length limit - shrinks the font
  // until it fits maxWidth rather than letting a long one run off the
  // card, capped at minSize so it never gets illegibly small. Leaves
  // ctx.font set to the returned size. letterSpacingEm matters here:
  // ctx.measureText() ignores the canvas letterSpacing property entirely,
  // so a label drawn with positive letter-spacing (the SCORERS labels use
  // +0.16em) measures shorter than it actually renders - without adding
  // that overhead back in here, "fits" text still overflows once drawn.
  function fitFontSize(text: string, maxWidth: number, fontFn: (weight: number, size: number) => string, weight: number, maxSize: number, minSize: number, letterSpacingEm = 0) {
    let size = maxSize;
    ctx.font = fontFn(weight, size);
    const w = ctx.measureText(text).width + letterSpacingEm * size * Math.max(text.length - 1, 0);
    if (w > maxWidth) size = Math.max(minSize, Math.floor(maxSize * (maxWidth / w)));
    ctx.font = fontFn(weight, size);
    return size;
  }

  ctx.fillStyle = "#0d0d1a";
  ctx.fillRect(0, 0, W, H);

  const pad = 64;
  const white = "#F5F6F8";
  const dim = "#94a3b8";
  const red = "#e63946";
  const redHi = "#f0525e";
  const amber = "#eab308";
  const green = "#22c55e";

  // ── Header: crest, wordmark, "FULL TIME" pill ──────────────────────
  const crestBox = { x: pad, y: 52, w: 78, h: 86 };
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(crestBox.x, crestBox.y, crestBox.w, crestBox.h, [6, 6, 34, 34]);
  ctx.fillStyle = "#1e293b";
  ctx.fill();
  ctx.strokeStyle = "rgba(230,57,70,0.85)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.clip();
  try {
    const crest = await loadImage("/logo.png");
    ctx.drawImage(crest, crestBox.x, crestBox.y, crestBox.w, crestBox.h);
  } catch {
    // Crest failed to load (offline etc.) - shield shape still shows.
  }
  const glow = ctx.createLinearGradient(0, crestBox.y + crestBox.h - 34, 0, crestBox.y + crestBox.h);
  glow.addColorStop(0, "rgba(230,57,70,0)");
  glow.addColorStop(1, "rgba(230,57,70,0.28)");
  ctx.fillStyle = glow;
  ctx.fillRect(crestBox.x, crestBox.y + crestBox.h - 34, crestBox.w, 34);
  ctx.restore();

  const textX = crestBox.x + crestBox.w + 22;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = white;
  ctx.font = soraFont(800, 31);
  letterSpaced(31 * 0.03);
  ctx.fillText("WIRRAL COMMUNITY FOOTBALL", textX, 66);
  ctx.fillStyle = dim;
  ctx.font = interFont(600, 17);
  letterSpaced(17 * 0.32);
  ctx.fillText(opts.pitch.toUpperCase() + " LEAGUE", textX, 104);
  resetLetterSpacing();

  const pillH = 53;
  const pillY = crestBox.y + crestBox.h / 2 - pillH / 2;
  const pillTextSize = 20;
  ctx.font = soraFont(800, pillTextSize);
  letterSpaced(pillTextSize * 0.2);
  const pillTextW = ctx.measureText("FULL TIME").width;
  resetLetterSpacing();
  const dotSize = 11;
  const pillPadL = 16;
  const pillGap = 12;
  const pillPadR = 20;
  const pillW = pillPadL + dotSize + pillGap + pillTextW + pillPadR;
  const pillX = W - pad - pillW;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 4);
  ctx.fillStyle = "rgba(230,57,70,0.14)";
  ctx.fill();
  ctx.strokeStyle = "rgba(240,82,94,0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = redHi;
  ctx.shadowColor = "rgba(240,82,94,0.6)";
  ctx.shadowBlur = 10;
  ctx.arc(pillX + pillPadL + dotSize / 2, pillY + pillH / 2, dotSize / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textBaseline = "middle";
  ctx.fillStyle = redHi;
  ctx.font = soraFont(800, pillTextSize);
  letterSpaced(pillTextSize * 0.2);
  ctx.fillText("FULL TIME", pillX + pillPadL + dotSize + pillGap, pillY + pillH / 2 + 1);
  resetLetterSpacing();

  // ── Bottom-up layout: the score/background section is the only
  // flexible-height piece (mirrors the source design's flex:1), so its
  // height is whatever's left after every fixed-or-content-driven block
  // below it is subtracted from the card height - same reflow the CSS
  // version gets for free, computed by hand here.
  const scoreSectionTop = crestBox.y + crestBox.h + 18;
  const venueLineH = 53;
  const footerH = 99;

  const colPadX = 34;
  const colPadTop = 30;
  const colPadBottom = 32;
  const scorerRowH = 30;
  const scorerRowGap = 13;
  const labelRowH = 24;
  const labelToRowsGap = 18;
  function colHeight(rows: number) {
    const rowsH = rows > 0 ? rows * scorerRowH + (rows - 1) * scorerRowGap : 0;
    return colPadTop + labelRowH + labelToRowsGap + rowsH + colPadBottom;
  }
  const panelH = Math.max(colHeight(opts.whiteScorers.length), colHeight(opts.redScorers.length));

  const ownGoalsH = opts.ownGoals.length > 0 ? 58 : 0;
  const motmH = opts.motmWinner ? 130 : 0;
  const motmMarginTop = opts.motmWinner ? 26 : 0;

  const footerTop = H - footerH;
  const motmTop = footerTop - motmH - motmMarginTop;
  const ownGoalsTop = motmTop - ownGoalsH;
  const panelTop = ownGoalsTop - panelH;
  const venueLineTop = panelTop - venueLineH;
  const scoreSectionBottom = venueLineTop;

  // ── Score section: photo (if one's been dropped in), dark vignette,
  // team names, big score ──────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, scoreSectionTop, W, scoreSectionBottom - scoreSectionTop);
  ctx.clip();
  try {
    // Optional: drop a background photo at public/results-bg.jpg (e.g.
    // a generated pitch/floodlight texture) and it appears automatically
    // - nothing else here needs to change. Falls back to the radial glow
    // below when it's missing, so the card still looks intentional either way.
    const bg = await loadImage("/results-bg.jpg");
    const sectionH = scoreSectionBottom - scoreSectionTop;
    const scale = Math.max(W / bg.width, sectionH / bg.height);
    const bw = bg.width * scale;
    const bh = bg.height * scale;
    ctx.drawImage(bg, W / 2 - bw / 2, scoreSectionTop + sectionH * 0.3 - bh / 2, bw, bh);
  } catch {
    const radial = ctx.createRadialGradient(W / 2, scoreSectionTop, 0, W / 2, scoreSectionTop, W * 0.75);
    radial.addColorStop(0, "rgba(230,57,70,0.20)");
    radial.addColorStop(1, "rgba(230,57,70,0)");
    ctx.fillStyle = radial;
    ctx.fillRect(0, scoreSectionTop, W, scoreSectionBottom - scoreSectionTop);
  }
  const vignetteH = (scoreSectionBottom - scoreSectionTop) * 0.66;
  const vignette = ctx.createLinearGradient(0, scoreSectionBottom, 0, scoreSectionBottom - vignetteH);
  vignette.addColorStop(0, "#0d0d1a");
  vignette.addColorStop(0.28, "rgba(13,13,26,0.86)");
  vignette.addColorStop(0.62, "rgba(13,13,26,0.35)");
  vignette.addColorStop(1, "rgba(13,13,26,0)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, scoreSectionBottom - vignetteH, W, vignetteH);
  ctx.restore();

  const contentBottom = scoreSectionBottom - 44;
  const nameTop = contentBottom - 107;
  const dashTop = contentBottom - 124;
  const barTop = contentBottom - 51;
  const scoreDigitsBaseline = contentBottom - 10;

  // The score block's width depends on the actual digits (a 2-digit
  // scoreline is wider than a 1-digit one), so its edges - and therefore
  // where the name columns and underline bars stop - are measured, not
  // assumed to sit a fixed distance from the card's centreline.
  const whiteScoreStr = String(opts.whiteScore);
  const redScoreStr = String(opts.redScore);
  const scoreDigitFont = soraFont(800, 184);
  const scoreGap = 26;
  ctx.font = scoreDigitFont;
  const whiteScoreW = ctx.measureText(whiteScoreStr).width;
  const redScoreW = ctx.measureText(redScoreStr).width;
  ctx.font = soraFont(800, 84);
  const dashW = ctx.measureText("–").width;
  const scoreBlockW = whiteScoreW + scoreGap + dashW + scoreGap + redScoreW;
  const scoreBlockLeft = W / 2 - scoreBlockW / 2;
  const scoreBlockRight = W / 2 + scoreBlockW / 2;
  const colGap = 24;

  const fitNameFont = (name: string, maxWidth: number) => fitFontSize(name, maxWidth, soraFont, 800, 38, 20, -0.01);
  const whiteNameStr = opts.whiteName.toUpperCase();
  const redNameStr = opts.redName.toUpperCase();
  const whiteNameSize = fitNameFont(whiteNameStr, scoreBlockLeft - colGap - pad);
  const redNameSize = fitNameFont(redNameStr, W - pad - (scoreBlockRight + colGap));

  ctx.textBaseline = "top";
  ctx.font = soraFont(800, whiteNameSize);
  letterSpaced(whiteNameSize * -0.01);
  ctx.textAlign = "right";
  ctx.fillStyle = white;
  ctx.fillText(whiteNameStr, scoreBlockLeft - colGap, nameTop);
  resetLetterSpacing();
  ctx.font = soraFont(800, redNameSize);
  letterSpaced(redNameSize * -0.01);
  ctx.textAlign = "left";
  ctx.fillStyle = redHi;
  ctx.fillText(redNameStr, scoreBlockRight + colGap, nameTop);
  resetLetterSpacing();

  ctx.fillStyle = white;
  ctx.shadowColor = "rgba(248,250,252,0.35)";
  ctx.shadowBlur = 12;
  ctx.fillRect(scoreBlockLeft - colGap - 118, barTop, 118, 7);
  ctx.fillStyle = red;
  ctx.shadowColor = "rgba(230,57,70,0.45)";
  ctx.fillRect(scoreBlockRight + colGap, barTop, 118, 7);
  ctx.shadowBlur = 0;

  ctx.textBaseline = "alphabetic";
  ctx.font = scoreDigitFont;
  letterSpaced(184 * -0.05);
  ctx.textAlign = "left";
  ctx.fillStyle = opts.whiteColor;
  ctx.fillText(whiteScoreStr, scoreBlockLeft, scoreDigitsBaseline);
  ctx.fillStyle = opts.redColor;
  ctx.fillText(redScoreStr, scoreBlockRight - redScoreW, scoreDigitsBaseline);
  resetLetterSpacing();

  ctx.textAlign = "center";
  ctx.font = soraFont(800, 84);
  ctx.fillStyle = "#475569";
  ctx.textBaseline = "top";
  ctx.fillText("–", scoreBlockLeft + whiteScoreW + scoreGap + dashW / 2, dashTop);

  // ── Venue + date ────────────────────────────────────────────────
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = interFont(600, 19);
  letterSpaced(19 * 0.1);
  ctx.fillStyle = dim;
  ctx.fillText(`${opts.venue.toUpperCase()} · ${opts.dateLabel.toUpperCase()}`, W / 2, venueLineTop + venueLineH / 2 + 3);
  resetLetterSpacing();

  // ── Scorers panel ───────────────────────────────────────────────
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(pad, panelTop, W - pad * 2, panelH);
  ctx.strokeStyle = "rgba(148,163,184,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, panelTop);
  ctx.lineTo(W - pad, panelTop);
  ctx.stroke();
  const colW = (W - pad * 2) / 2;
  ctx.strokeStyle = "rgba(148,163,184,0.2)";
  ctx.beginPath();
  ctx.moveTo(pad + colW, panelTop);
  ctx.lineTo(pad + colW, panelTop + panelH);
  ctx.stroke();

  function drawScorerColumn(colX: number, label: string, color: string, scorers: { name: string; goals: number }[]) {
    const innerX = colX + colPadX;
    const innerRight = colX + colW - colPadX;
    const labelY = panelTop + colPadTop;
    ctx.fillStyle = color;
    ctx.fillRect(innerX, labelY + (labelRowH - 20) / 2, 4, 20);
    const labelSize = fitFontSize(label, innerRight - (innerX + 16), soraFont, 700, 19, 12, 0.16);
    letterSpaced(labelSize * 0.16);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = color;
    ctx.fillText(label, innerX + 16, labelY);
    resetLetterSpacing();

    const rowsTop = labelY + labelRowH + labelToRowsGap;
    scorers.forEach((s, i) => {
      const rowY = rowsTop + i * (scorerRowH + scorerRowGap);
      ctx.font = soraFont(700, 22);
      const countStr = `×${s.goals}`;
      const countW = ctx.measureText(countStr).width;
      // Goal count always stays full-size (it's never more than 2-3
      // chars) - only the player name shrinks, and only if it would
      // otherwise run into the count. fitFontSize leaves ctx.font set to
      // the fitted size, so draw the name immediately while it's active.
      fitFontSize(s.name, innerRight - innerX - countW - 12, interFont, 600, 25, 14);
      ctx.fillStyle = white;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(s.name, innerX, rowY + 20);
      ctx.font = soraFont(700, 22);
      ctx.fillStyle = green;
      ctx.textAlign = "right";
      ctx.fillText(countStr, innerRight, rowY + 20);
    });
  }
  drawScorerColumn(pad, opts.whiteName.toUpperCase() + " SCORERS", white, opts.whiteScorers);
  drawScorerColumn(pad + colW, opts.redName.toUpperCase() + " SCORERS", redHi, opts.redScorers);

  // ── Own goals ───────────────────────────────────────────────────
  if (opts.ownGoals.length > 0) {
    ctx.fillStyle = "rgba(234,179,8,0.09)";
    ctx.fillRect(pad, ownGoalsTop, W - pad * 2, ownGoalsH);
    ctx.strokeStyle = "rgba(234,179,8,0.3)";
    ctx.beginPath();
    ctx.moveTo(pad, ownGoalsTop);
    ctx.lineTo(W - pad, ownGoalsTop);
    ctx.stroke();

    const diamondCx = pad + colPadX + 4.5;
    const diamondCy = ownGoalsTop + ownGoalsH / 2;
    ctx.save();
    ctx.translate(diamondCx, diamondCy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = amber;
    ctx.fillRect(-4.5, -4.5, 9, 9);
    ctx.restore();

    const label = opts.ownGoals.length > 1 || opts.ownGoals[0].goals > 1 ? "Own goals — " : "Own goal — ";
    const names = opts.ownGoals.map((s) => (s.goals > 1 ? `${s.name} (${s.goals})` : s.name)).join(", ");
    ctx.font = interFont(600, 19);
    letterSpaced(19 * 0.04);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = amber;
    ctx.fillText(label + names, pad + colPadX + 9 + 14, diamondCy + 1);
    resetLetterSpacing();
  }

  // ── Man of the match ────────────────────────────────────────────
  if (opts.motmWinner) {
    ctx.beginPath();
    ctx.roundRect(pad, motmTop, W - pad * 2, motmH, 2);
    const motmGrad = ctx.createLinearGradient(0, motmTop, 0, motmTop + motmH);
    motmGrad.addColorStop(0, "rgba(234,179,8,0.14)");
    motmGrad.addColorStop(1, "rgba(234,179,8,0.04)");
    ctx.fillStyle = motmGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(234,179,8,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const accentGrad = ctx.createLinearGradient(pad, 0, W - pad, 0);
    accentGrad.addColorStop(0, amber);
    accentGrad.addColorStop(0.5, "#fde68a");
    accentGrad.addColorStop(1, amber);
    ctx.fillStyle = accentGrad;
    ctx.fillRect(pad, motmTop, W - pad * 2, 3);

    const badgeCx = pad + 32 + 37;
    const badgeCy = motmTop + 26 + 37;
    ctx.beginPath();
    ctx.arc(badgeCx, badgeCy, 37, 0, Math.PI * 2);
    ctx.fillStyle = "#0d0d1a";
    ctx.fill();
    ctx.strokeStyle = "rgba(234,179,8,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = "34px " + inter;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🏆", badgeCx, badgeCy + 2);

    const motmTextX = pad + 32 + 74 + 26;
    ctx.font = soraFont(700, 18);
    letterSpaced(18 * 0.22);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = amber;
    ctx.fillText("MAN OF THE MATCH", motmTextX, motmTop + 27);
    resetLetterSpacing();
    ctx.font = soraFont(800, 42);
    letterSpaced(42 * -0.015);
    ctx.fillStyle = white;
    ctx.fillText(opts.motmWinner, motmTextX, motmTop + 27 + 22 + 9);
    resetLetterSpacing();
  }

  // ── Footer ──────────────────────────────────────────────────────
  ctx.font = soraFont(800, 17);
  letterSpaced(17 * 0.3);
  const footerText = "WIRRAL COMMUNITY FOOTBALL";
  const footerTextW = ctx.measureText(footerText).width;
  resetLetterSpacing();
  const footerY = footerTop + 34 + 10;
  const ruleGap = 18;
  const ruleY = footerY;
  ctx.strokeStyle = "rgba(148,163,184,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, ruleY);
  ctx.lineTo(W / 2 - footerTextW / 2 - ruleGap, ruleY);
  ctx.moveTo(W / 2 + footerTextW / 2 + ruleGap, ruleY);
  ctx.lineTo(W - pad, ruleY);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = soraFont(800, 17);
  letterSpaced(17 * 0.3);
  ctx.fillStyle = dim;
  ctx.fillText(footerText, W / 2, footerY + 1);
  resetLetterSpacing();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't generate the image"));
    }, "image/png");
  });
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Pitch cost dropped from £55 to £45 starting 7 Sep 2026 - fixtures
// before that date keep the old rate (both as historical record for
// already-played games and for any new one-off added for an earlier
// date), anything on or after gets the new one automatically.
function defaultPitchCost(date: string) {
  return date >= "2026-09-07" ? 45 : 55;
}

const Icon = {
  cal: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M8 2.5v4M16 2.5v4" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  pulse: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M7 12h2.5l1.5-4 3 8 1.5-4H17" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7z" strokeLinejoin="round" />
    </svg>
  ),
  shirt: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 3.5L12 5l4-1.5 4 4-3 3V20H7V10.5l-3-3z" strokeLinejoin="round" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4.5h4.5" />
      <path d="M12 8v4.5l3 2" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" strokeLinejoin="round" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M12 14v3M9 20h6M9.5 17h5l.5 3H9z" strokeLinejoin="round" />
    </svg>
  ),
};

function SplashScreen() {
  return (
    <div className="wcf-splash">
      <img className="wcf-splash-photo" src="/tunnel.jpg" alt="" />
      <div className="wcf-splash-scrim" />
      <div className="wcf-splash-body">
        <div className="wcf-splash-est">EST. 2026</div>
        <div className="wcf-splash-wordmark">
          WIRRAL
          <br />
          <span className="dim">COMMUNITY FOOTBALL</span>
        </div>
        <div className="wcf-splash-loader">
          <span className="wcf-splash-dot" />
          <span className="wcf-splash-dot" />
          <span className="wcf-splash-dot" />
        </div>
      </div>
    </div>
  );
}

export default function WirralCommunityFootball() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <div className="wcf-root">
      <style>{css}</style>
      {session === undefined ? (
        <SplashScreen />
      ) : session ? (
        <App session={session} />
      ) : (
        <SignIn />
      )}
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setSending(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setVerifying(false);
    if (error) setError(error.message);
  }

  return (
    <div className="wcf-signin">
      <img className="wcf-signin-photo" src="/floodlit-signin.jpg" alt="" />
      <div className="wcf-signin-scrim" />

      <div className="wcf-signin-head">
        <div className="wcf-signin-brand-row">
          <span className="wcf-signin-crest">
            <img src="/logo.png" alt="Wirral Community Football crest" />
          </span>
          <span className="wcf-signin-est">EST. 2026 · WIRRAL</span>
        </div>
        <div className="wcf-signin-wordmark">
          WIRRAL
          <div className="wcf-signin-wordmark-dim1">COMM.</div>
          <div className="wcf-signin-wordmark-dim2">FOOTBALL</div>
        </div>
      </div>

      <div className="wcf-signin-bottom">
        <div className="wcf-signin-steps">
          <div className="wcf-signin-step-bar on" />
          <div className={"wcf-signin-step-bar" + (sent ? " on" : "")} />
          <div className="wcf-signin-step-label">{sent ? "STEP 2 / 2" : "STEP 1 / 2"}</div>
        </div>

        {sent ? (
          <form className="wcf-signin-form2" onSubmit={verifyCode}>
            <p className="wcf-signin-sub">
              We sent a six-digit code to <strong>{email}</strong>.
            </p>
            <div className="wcf-signin-cells-wrap">
              <div className="wcf-signin-cells">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={"wcf-signin-cell" + (code.length === i ? " active" : "")}>
                    {code[i] || ""}
                  </div>
                ))}
              </div>
              <input
                type="text"
                inputMode="numeric"
                autoFocus
                required
                aria-label="Six-digit code"
                className="wcf-signin-hidden-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            <button type="submit" className="wcf-signin-cta" disabled={verifying || !code.trim()}>
              {verifying ? "Checking…" : "Verify code"}
            </button>
            {error && <p className="wcf-signin-error">{error}</p>}
            <button type="button" className="wcf-signin-alt" onClick={() => { setSent(false); setCode(""); setError(null); }}>
              Use a different email
            </button>
          </form>
        ) : (
          <form className="wcf-signin-form2" onSubmit={sendCode}>
            <p className="wcf-signin-sub">No password needed. We&apos;ll email you a six-digit code.</p>
            <div className="wcf-signin-email-pill">
              <input
                type="email"
                required
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" disabled={sending || !email.trim()}>
                {sending ? "Sending…" : "Send sign-in code"}
              </button>
            </div>
            {error && <p className="wcf-signin-error">{error}</p>}
            <button type="button" className="wcf-signin-alt" disabled={!email.trim()} onClick={() => setSent(true)}>
              I already have a code
            </button>
          </form>
        )}

        <p className="wcf-privacy-note">
          We only store your name, email, and booking history to run the club — nothing else.
        </p>
      </div>
    </div>
  );
}

function App({ session }: { session: Session }) {
  const myId = session.user.id;
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [monzoUnmatched, setMonzoUnmatched] = useState<MonzoUnmatchedRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [goalRows, setGoalRows] = useState<GoalRow[]>([]);
  const [clubSettings, setClubSettings] = useState<ClubSettings | null>(null);
  const [awards, setAwards] = useState<AwardRow[]>([]);
  const [adminMessages, setAdminMessages] = useState<AdminMessage[]>([]);
  const [potEntries, setPotEntries] = useState<PotEntry[]>([]);
  const [motmVotes, setMotmVotes] = useState<MotmVote[]>([]);
  const [scorePredictions, setScorePredictions] = useState<ScorePrediction[]>([]);
  const [feedReactions, setFeedReactions] = useState<FeedReaction[]>([]);
  const [hiddenFeedKeys, setHiddenFeedKeys] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [pushStats, setPushStats] = useState<{ total: number; subscribed: number } | null>(null);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [selfRatings, setSelfRatings] = useState<PlayerRating[]>([]);
  const [adminRatings, setAdminRatings] = useState<PlayerRating[]>([]);
  const [lineupView, setLineupView] = useState<"sheet" | "fairness" | "predict">("sheet");
  const [predictView, setPredictView] = useState<string>("season");
  const [predictOpenId, setPredictOpenId] = useState<string | null>(null);
  const [suggestedTeams, setSuggestedTeams] = useState<{ white: string[]; red: string[] } | null>(null);
  const [ratingPlayerId, setRatingPlayerId] = useState<string | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // In-app replacement for window.confirm() - same "confirm before acting"
  // behaviour everywhere it's used, just styled to match the app instead
  // of breaking out to the browser's plain native dialog. Promise-based so
  // call sites read almost identically to the confirm() they replace:
  // `if (await askConfirm(...)) doThing()` instead of `if (confirm(...))`.
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
    resolve: (v: boolean) => void;
  } | null>(null);
  function askConfirm(title: string, message: string, confirmLabel = "Confirm", danger = true): Promise<boolean> {
    return new Promise((resolve) => setConfirmState({ title, message, confirmLabel, danger, resolve }));
  }
  function resolveConfirm(value: boolean) {
    confirmState?.resolve(value);
    setConfirmState(null);
  }
  // Keyed by profile id, not just a bare device-level flag - a deleted
  // and re-added account gets a brand new id (see deleteProfile/addPlayer,
  // full auth.users delete+recreate), so a stale dismiss from the old
  // account can't suppress the nudge for the new one.
  const [pushNudgeDismissed, setPushNudgeDismissed] = useState(true);
  useEffect(() => {
    setPushNudgeDismissed(localStorage.getItem(`wcf-push-nudge-dismissed-${myId}`) === "true");
  }, [myId]);
  function dismissPushNudge() {
    localStorage.setItem(`wcf-push-nudge-dismissed-${myId}`, "true");
    setPushNudgeDismissed(true);
  }
  const [ratingNudgeDismissed, setRatingNudgeDismissed] = useState(true);
  useEffect(() => {
    setRatingNudgeDismissed(localStorage.getItem(`wcf-rating-nudge-dismissed-${myId}`) === "true");
  }, [myId]);
  function dismissRatingNudge() {
    localStorage.setItem(`wcf-rating-nudge-dismissed-${myId}`, "true");
    setRatingNudgeDismissed(true);
  }
  const prevStatusRef = useRef<Record<string, PayStatus>>({});
  const prevWaitingRef = useRef<Record<string, boolean>>({});

  // PWAs on a home screen commonly stay resident across many opens without
  // ever doing a real network reload, so a device can keep running today's
  // JS for weeks after several deploys - this compares the build this tab
  // is actually running against whatever's live right now and prompts a
  // manual refresh rather than leaving people silently stuck on old code.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    const myBuild = process.env.NEXT_PUBLIC_BUILD_SHA;
    if (!myBuild) return; // local dev - nothing deployed to compare against
    async function check() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        const data = await res.json();
        if (data.sha && data.sha !== myBuild) setUpdateAvailable(true);
      } catch {
        // offline or a blip - just try again next interval
      }
    }
    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Pitches are exactly where signal drops out mid-session - names what's
  // happening instead of leaving a silently stale screen with no
  // explanation of why nothing's updating.
  const [isOffline, setIsOffline] = useState(false);
  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  function notifyError(message: string) {
    setToast({ kind: "error", text: message });
  }
  function notifySuccess(text: string) {
    setToast({ kind: "success", text });
  }

  const [tab, setTab] = useState<"fixtures" | "feed" | "lineup" | "results" | "account" | "admin">("fixtures");
  const [resultsView, setResultsView] = useState<"season" | "table" | "fixtures" | "pot">("season");
  const [potAmount, setPotAmount] = useState("");
  const [potDescription, setPotDescription] = useState("");
  const [potEntryKind, setPotEntryKind] = useState<"add" | "deduct">("add");
  const [potCategory, setPotCategory] = useState<PotCategory>("other");
  const [addingPotEntry, setAddingPotEntry] = useState(false);
  const [resultsMonth, setResultsMonth] = useState<string>("all");
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [motmVotersFor, setMotmVotersFor] = useState<{ gameId: string; candidateId: string; candidateName: string } | null>(null);
  const [playerCardId, setPlayerCardId] = useState<string | null>(null);
  const [playerCardTeam, setPlayerCardTeam] = useState<{ name: string; color: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showBatchGen, setShowBatchGen] = useState(false);
  const [multiBookMode, setMultiBookMode] = useState(false);
  const [multiBookSelected, setMultiBookSelected] = useState<Set<string>>(new Set());
  const [multiBooking, setMultiBooking] = useState(false);
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [editingLineup, setEditingLineup] = useState(false);
  const [lineupDisplayView, setLineupDisplayView] = useState<"pitch" | "list">("pitch");
  const [selectedLineupPlayerId, setSelectedLineupPlayerId] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<string, Team | null>>({});
  const [editingPositions, setEditingPositions] = useState(false);
  const [positionDraft, setPositionDraft] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingPlayerId, setDraggingPlayerId] = useState<string | null>(null);
  const pitchCardRef = useRef<HTMLDivElement | null>(null);
  const [clipTitle, setClipTitle] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [feedView, setFeedView] = useState<"feed" | "clips">("feed");

  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "co-owner" || myProfile?.role === "owner";
  const isOwner = myProfile?.role === "owner";
  const cs: ClubSettings = clubSettings ?? {
    team_white_name: "Whites",
    team_white_color: "#F5F6F8",
    team_red_name: "Reds",
    team_red_color: "#e63946",
    default_venue: "New venue",
    default_kickoff: "19:00",
    default_price: 5,
    default_pitch: "8-a-side",
    default_max_players: MAX_SPOTS,
    last_fixture_update_at: null,
  };

  const loadProfile = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, push_opt_in, avatar_url").eq("id", myId).single();
    if (data) setMyProfile(data as Profile);
  }, [myId]);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, created_at, avatar_url").order("display_name");
    if (data) setProfiles(data as Profile[]);
  }, []);

  const loadGames = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select(
        "id, date, kickoff, venue, pitch, price, max_players, pitch_cost, team_white_score, team_red_score, published, team_method, team_balance_score, lineup_positions, bookings(id, player_id, status, waiting, team, created_at, pot_exempt_reason, player:profiles!bookings_player_id_fkey(id, display_name, role, avatar_url), confirmer:profiles!bookings_confirmed_by_fkey(display_name))"
      )
      .order("date", { ascending: true });
    if (data) setGames(data as unknown as GameRow[]);
  }, []);

  const loadClubSettings = useCallback(async () => {
    const { data } = await supabase
      .from("club_settings")
      .select(
        "team_white_name, team_white_color, team_red_name, team_red_color, default_venue, default_kickoff, default_price, default_pitch, default_max_players, last_fixture_update_at"
      )
      .single();
    if (data) setClubSettings(data as ClubSettings);
  }, []);

  const loadAwards = useCallback(async () => {
    const { data } = await supabase.from("awards").select("id, title, value, note, image_url, video_url").order("created_at", { ascending: true });
    if (data) setAwards(data as AwardRow[]);
  }, []);

  // RLS scopes the result: a player only ever gets their own messages,
  // an admin gets everything - so this one query serves both the
  // player inbox view and the admin sent-log view.
  const loadAdminMessages = useCallback(async () => {
    const { data } = await supabase
      .from("admin_messages")
      .select("id, recipient_id, sender_id, message, created_at, read_at, recipient:profiles!admin_messages_recipient_id_fkey(display_name)")
      .order("created_at", { ascending: false });
    if (data) setAdminMessages(data as unknown as AdminMessage[]);
  }, []);

  const loadPotEntries = useCallback(async () => {
    const { data } = await supabase.from("pot_entries").select("id, amount, description, category, created_at").order("created_at", { ascending: false });
    if (data) setPotEntries(data as PotEntry[]);
  }, []);

  const loadMotmVotes = useCallback(async () => {
    const { data } = await supabase.from("motm_votes").select("id, game_id, voter_id, candidate_id");
    if (data) setMotmVotes(data as MotmVote[]);
  }, []);

  const loadScorePredictions = useCallback(async () => {
    const { data } = await supabase
      .from("score_predictions")
      .select("id, game_id, player_id, predicted_white, predicted_red, player:profiles!score_predictions_player_id_fkey(display_name)");
    if (data) setScorePredictions(data as unknown as ScorePrediction[]);
  }, []);

  const loadFeedReactions = useCallback(async () => {
    const { data } = await supabase.from("feed_reactions").select("id, item_key, emoji, user_id");
    if (data) setFeedReactions(data as FeedReaction[]);
  }, []);

  const loadHiddenFeedItems = useCallback(async () => {
    const { data } = await supabase.from("feed_hidden_items").select("item_key");
    if (data) setHiddenFeedKeys(data.map((r) => r.item_key));
  }, []);

  // RLS scopes what actually comes back: a non-admin only ever gets their
  // own row from either table (self-ratings) or nothing at all
  // (admin-ratings, never visible to players) - no client-side filtering
  // needed on top of that.
  const loadSelfRatings = useCallback(async () => {
    const { data } = await supabase.from("player_self_ratings").select("player_id, fitness, attack, defence, goalkeeping, position");
    if (data) setSelfRatings(data as PlayerRating[]);
  }, []);
  const loadAdminRatings = useCallback(async () => {
    const { data } = await supabase.from("player_admin_ratings").select("player_id, fitness, attack, defence, goalkeeping, position");
    if (data) setAdminRatings(data as PlayerRating[]);
  }, []);

  const loadClips = useCallback(async () => {
    const { data } = await supabase
      .from("clips")
      .select("id, title, video_url, created_at, submitted_by, submitter:profiles(id, display_name, role)")
      .order("created_at", { ascending: false });
    if (data) setClips(data as unknown as ClipRow[]);
  }, []);

  const loadGoals = useCallback(async () => {
    const { data } = await supabase
      .from("game_stats")
      .select("id, game_id, player_id, goals, own_goals, player:profiles(id, display_name, role)")
      .order("goals", { ascending: false });
    if (data) setGoalRows(data as unknown as GoalRow[]);
  }, []);

  // RLS scopes this to admins only - a player's query just comes back
  // empty, no error, so it's safe to always include in loadAll rather
  // than branching on isAdmin here.
  const loadMonzoUnmatched = useCallback(async () => {
    const { data } = await supabase
      .from("monzo_transactions")
      .select("id, amount_pence, code, reason, created_at, player:profiles(display_name)")
      .eq("outcome", "unmatched")
      .order("created_at", { ascending: false });
    if (data) setMonzoUnmatched(data as unknown as MonzoUnmatchedRow[]);
  }, []);

  const loadAll = useCallback(
    () =>
      Promise.all([
        loadProfile(),
        loadProfiles(),
        loadGames(),
        loadClips(),
        loadGoals(),
        loadClubSettings(),
        loadAwards(),
        loadPotEntries(),
        loadMotmVotes(),
        loadScorePredictions(),
        loadFeedReactions(),
        loadHiddenFeedItems(),
        loadSelfRatings(),
        loadAdminRatings(),
        loadAdminMessages(),
        loadMonzoUnmatched(),
      ]),
    [
      loadProfile,
      loadProfiles,
      loadGames,
      loadClips,
      loadGoals,
      loadClubSettings,
      loadAwards,
      loadPotEntries,
      loadMotmVotes,
      loadScorePredictions,
      loadFeedReactions,
      loadHiddenFeedItems,
      loadSelfRatings,
      loadAdminRatings,
      loadAdminMessages,
      loadMonzoUnmatched,
    ]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadAll();
      setLoading(false);
    })();
  }, [loadAll]);

  // PWAs/mobile browsers often suspend the page in the background and just
  // resume the same in-memory state when reopened, rather than reloading -
  // so refetch whenever the app actually comes back into view.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") loadAll();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadAll]);

  useEffect(() => {
    const channel = supabase
      .channel("bookings-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, () => {
        loadGames();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadGames]);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const prevWaiting = prevWaitingRef.current;
    const nextStatus: Record<string, PayStatus> = {};
    const nextWaiting: Record<string, boolean> = {};
    games.forEach((g) => {
      const mine = g.bookings.find((b) => b.player_id === myId);
      if (!mine) return;
      nextStatus[g.id] = mine.status;
      nextWaiting[g.id] = mine.waiting;
      if (prevStatus[g.id] && prevStatus[g.id] !== "confirmed" && mine.status === "confirmed") {
        notifySuccess(`✓ Payment confirmed for ${g.venue} · ${fmtDate(g.date)}`);
      }
      if (prevWaiting[g.id] === true && mine.waiting === false) {
        notifySuccess(`🎉 A spot opened up — you're in for ${g.venue} · ${fmtDate(g.date)}!`);
      }
    });
    prevStatusRef.current = nextStatus;
    prevWaitingRef.current = nextWaiting;
  }, [games, myId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Pulls a guaranteed-current session token directly from Supabase
  // (transparently refreshing if needed) rather than trusting the
  // `session` prop, which is only as fresh as the last onAuthStateChange
  // event - on a backgrounded mobile PWA that listener's refresh timer can
  // stall, leaving the prop holding a token that's actually gone stale (or
  // fully invalid) without the UI showing anything's wrong. Confirmed as a
  // real, reproducible failure mode, not just a theory - every admin fetch
  // to a Route Handler goes through this now instead of reading the prop
  // directly.
  async function getFreshAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  useEffect(() => {
    if (!isAdmin || tab !== "account") return;
    (async () => {
      const token = await getFreshAccessToken();
      if (!token) return;
      const res = await fetch("/api/push/stats", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setPushStats(await res.json());
    })();
  }, [isAdmin, tab]);

  // Best-effort - push delivery shouldn't block or fail the booking/fixture
  // action itself, so failures here just log rather than surface a toast.
  async function pushNotify(path: string, body: Record<string, string>) {
    try {
      const token = await getFreshAccessToken();
      if (!token) return console.error("Push notify skipped - no session", path);
      await fetch(`/api/push/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("Push notify failed", path, err);
    }
  }

  // Best-effort, same reasoning as pushNotify - a logging failure shouldn't
  // block or fail the actual admin action it's recording.
  async function logAction(action: string, details: string) {
    try {
      await supabase.from("audit_log").insert({ actor_id: myId, action, details });
    } catch (err) {
      console.error("Audit log failed", action, err);
    }
  }
  async function loadAuditLog() {
    const { data } = await supabase
      .from("audit_log")
      .select("id, action, details, created_at, actor:profiles(display_name)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (data) setAuditLog(data as unknown as AuditLogEntry[]);
  }
  async function toggleAuditLog() {
    if (!showAuditLog) await loadAuditLog();
    setShowAuditLog((v) => !v);
  }

  async function saveSelfRating(fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_self_ratings")
      .upsert({ player_id: myId, fitness, attack, defence, goalkeeping, position, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Saved your self-rating");
    await loadSelfRatings();
  }

  async function saveAdminRating(playerId: string, fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_admin_ratings")
      .upsert({ player_id: playerId, fitness, attack, defence, goalkeeping, position, updated_by: myId, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Rating saved");
    logAction("Rated player", profiles.find((p) => p.id === playerId)?.display_name ?? "someone");
    await loadAdminRatings();
  }

  async function sendAdminMessage(recipientId: string, message: string) {
    const { data, error } = await supabase
      .from("admin_messages")
      .insert({ recipient_id: recipientId, sender_id: myId, message })
      .select("id")
      .single();
    if (error) return notifyError(error.message);
    await loadAdminMessages();
    logAction("Sent message", profiles.find((p) => p.id === recipientId)?.display_name ?? "someone");
    if (data) await pushNotify("notify-admin-message", { messageId: data.id });
    notifySuccess("Message sent");
  }

  async function markMessageRead(id: string) {
    const { error } = await supabase.from("admin_messages").update({ read_at: new Date().toISOString() }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadAdminMessages();
  }

  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      notifyError("Push isn't supported in this browser");
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        notifyError("Notifications were blocked — check your browser/phone settings to allow them");
        return false;
      }
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
      const json = sub.toJSON();
      const { error } = await supabase
        .from("push_subscriptions")
        .upsert(
          { user_id: myId, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_key: json.keys?.auth, origin: window.location.origin },
          { onConflict: "endpoint" }
        );
      if (error) return notifyError(error.message), false;
      const { error: profErr } = await supabase.from("profiles").update({ push_opt_in: true }).eq("id", myId);
      if (profErr) return notifyError(profErr.message), false;
      await loadProfile();
      return true;
    } catch (err) {
      notifyError(err instanceof Error ? err.message : "Couldn't enable notifications");
      return false;
    }
  }

  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error("Push unsubscribe failed", err);
    }
    const { error } = await supabase.from("profiles").update({ push_opt_in: false }).eq("id", myId);
    if (error) return notifyError(error.message);
    await loadProfile();
  }

  // Backfills push_subscriptions.origin for anyone who already had push
  // enabled before dual-domain existed - enablePush() only ever runs on an
  // explicit tap, so without this, existing subscribers would stay
  // unrecorded indefinitely rather than getting picked up the next time
  // they open the app. Not surfaced anywhere in the app itself - this is
  // purely a backend record for looking someone up directly if needed,
  // same as the app's existing stance of never showing per-player push
  // detail to admins through the UI. Silent by design: no permission
  // prompt (already granted), no toast on failure, just a best-effort
  // top-up using whatever's already subscribed.
  useEffect(() => {
    if (!myId || !myProfile?.push_opt_in) return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const json = sub.toJSON();
        await supabase
          .from("push_subscriptions")
          .upsert(
            { user_id: myId, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_key: json.keys?.auth, origin: window.location.origin },
            { onConflict: "endpoint" }
          );
      } catch {
        // Best-effort only - a normal load shouldn't ever surface this.
      }
    })();
  }, [myId, myProfile?.push_opt_in]);

  async function sendTestPush() {
    const token = await getFreshAccessToken();
    if (!token) return notifyError("Your session's expired — refresh the page and sign in again, then retry.");
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Couldn't send a test push" }));
      notifyError(error || "Couldn't send a test push");
      return;
    }
    notifySuccess("Test push sent — should land in a few seconds");
  }

  async function book(gameId: string) {
    // Payment-needed push isn't instant - it's picked up by the frequent
    // cron job 30 min later, only if still unpaid by then (see
    // api/cron/frequent). Firing it here would just nag someone who's
    // already looking at the Pay Now button.
    const { data, error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: myId }).select("waiting").single();
    if (error) {
      if (error.code === "42501") return notifyError("You have an overdue payment — speak to an admin to confirm it before booking again.");
      return notifyError(error.message);
    }
    // "Last spot" is about the physical roster filling up, not payment
    // status - checking here (right when a spot's actually taken) rather
    // than on payment confirmation, which could happen long after the
    // game's already full.
    if (data && !data.waiting) pushNotify("notify-last-spot", { gameId });
  }
  // Same insert as book(), just every selected game in one round trip
  // instead of N. RLS's overdue check runs per row regardless of batch
  // size, and the waiting-list trigger already handles each row on its
  // own merits - so a mixed batch (some games open, some already full)
  // resolves exactly as if each had been booked one at a time.
  async function bookMany(gameIds: string[]) {
    if (gameIds.length === 0) return;
    setMultiBooking(true);
    const { data, error } = await supabase
      .from("bookings")
      .insert(gameIds.map((gameId) => ({ game_id: gameId, player_id: myId })))
      .select("game_id, waiting");
    setMultiBooking(false);
    if (error) {
      if (error.code === "42501") return notifyError("You have an overdue payment — speak to an admin to confirm it before booking again.");
      return notifyError(error.message);
    }
    (data ?? []).filter((d) => !d.waiting).forEach((d) => pushNotify("notify-last-spot", { gameId: d.game_id }));
    setMultiBookMode(false);
    setMultiBookSelected(new Set());
    notifySuccess(`Booked into ${gameIds.length} game${gameIds.length === 1 ? "" : "s"}`);
  }
  async function addBooking(gameId: string, playerId: string) {
    const { data, error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: playerId }).select("waiting").single();
    if (error) return notifyError(error.message);
    if (data && !data.waiting) pushNotify("notify-last-spot", { gameId });
  }
  async function cancel(bookingId: string) {
    // Capture what's about to be lost before the delete - once the row's
    // gone, so is the answer to "did they even book, and when". Only
    // logged when an admin removes someone ELSE's booking, not a player
    // cancelling their own - that's routine and self-driven, logging it
    // too would bury the rare, actually disputed case under noise (same
    // reasoning as why payment-status changes aren't logged either).
    let logDetails: string | null = null;
    if (isAdmin) {
      for (const g of games) {
        const b = g.bookings.find((bk) => bk.id === bookingId);
        if (b && b.player_id !== myId) {
          const listLabel = b.waiting ? "the waiting list" : "the match";
          logDetails = `${b.player.display_name} — ${g.venue} ${fmtDate(g.date)} (they originally booked onto ${listLabel} ${fmtDateTime(b.created_at)})`;
          break;
        }
      }
    }
    const { error } = await supabase.from("bookings").delete().eq("id", bookingId);
    if (error) return notifyError(error.message);
    if (logDetails) logAction("Removed player from game", logDetails);
  }
  async function markPaid(bookingId: string) {
    const { error } = await supabase.from("bookings").update({ status: "pending" }).eq("id", bookingId);
    if (error) notifyError(error.message);
  }
  async function setBookingStatus(bookingId: string, status: PayStatus) {
    // Not logged to the audit log - happens up to ~16 times a week per
    // fixture, and it's already visible live via the payment status dot on
    // each booking and the Overdue section, so logging it too would just
    // bury the genuinely rare, otherwise-invisible actions (role changes,
    // fixture posts/deletes) under routine noise. Who confirmed it is still
    // tracked on the booking itself (confirmed_by/confirmed_at) so it's
    // there if ever needed, without it being a noisy feed of its own.
    const patch: { status: PayStatus; confirmed_by?: string; confirmed_at?: string } = { status };
    if (status === "confirmed") {
      patch.confirmed_by = myId;
      patch.confirmed_at = new Date().toISOString();
    }
    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    if (error) return notifyError(error.message);
  }

  // Keeps the booking's own status untouched (still a real spot, never
  // wrongly flagged overdue) - only affects whether the pot/finance totals
  // count it. The bookings-realtime subscription refetches games on any
  // change, so no explicit reload needed here.
  async function setPotExempt(bookingId: string, reason: PotExemptReason | null) {
    const { error } = await supabase.from("bookings").update({ pot_exempt_reason: reason }).eq("id", bookingId);
    if (error) return notifyError(error.message);
  }

  // The one way to add fixtures now, whether that's a single one-off
  // (pick the same date for From/To in the modal) or a whole month's
  // Mon/Thu batch - bulk is the actual common case, so there's no
  // separate "just one" button to keep in sync with this. Still lands
  // as unpublished drafts; each one still needs its own "Confirm & post"
  // before it's real. When it's exactly one fixture, jump straight into
  // editing it - the same convenience the old single-add button had.
  async function batchAddGames(dates: string[]) {
    if (dates.length === 0) return;
    const rows = dates.map((date) => ({
      date,
      kickoff: cs.default_kickoff,
      venue: cs.default_venue,
      pitch: cs.default_pitch,
      price: cs.default_price,
      max_players: cs.default_max_players,
      pitch_cost: defaultPitchCost(date),
      published: false,
    }));
    const { data, error } = await supabase.from("games").insert(rows).select("id");
    if (error) return notifyError(error.message);
    await loadGames();
    setShowBatchGen(false);
    notifySuccess(`${dates.length} fixture${dates.length === 1 ? "" : "s"} added as drafts`);
    if (data && data.length === 1) setEditingId(data[0].id);
  }
  async function saveGame(id: string, patch: Partial<GameRow>) {
    const { bookings: _bookings, published: _published, ...rest } = patch as GameRow;
    const wasPublished = games.find((g) => g.id === id)?.published;
    // published_at (not published itself) is what the frequent cron uses
    // to decide when to actually announce this - confirming a whole batch
    // of drafts in one sitting sends one digest push ~30 min later
    // instead of one push per confirm. See frequent/route.ts.
    const publishPatch = wasPublished ? {} : { published_at: new Date().toISOString() };
    const { error } = await supabase.from("games").update({ ...rest, ...publishPatch, published: true }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    setEditingId(null);
    if (!wasPublished) {
      logAction("Posted fixture", `${rest.venue} — ${fmtDate(rest.date)}`);
    }
  }
  async function deleteGame(id: string) {
    const game = games.find((g) => g.id === id);
    const { error } = await supabase.from("games").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    if (game) logAction("Deleted fixture", `${game.venue} — ${fmtDate(game.date)}`);
  }
  async function saveResult(
    gameId: string,
    whiteScore: number | null,
    redScore: number | null,
    goals: Record<string, number>,
    ownGoals: Record<string, number>
  ) {
    const { error: scoreErr } = await supabase
      .from("games")
      .update({ team_white_score: whiteScore, team_red_score: redScore })
      .eq("id", gameId);
    if (scoreErr) return notifyError(scoreErr.message);

    const playerIds = new Set([...Object.keys(goals), ...Object.keys(ownGoals)]);
    const rows = Array.from(playerIds).map((player_id) => ({
      game_id: gameId,
      player_id,
      goals: goals[player_id] ?? 0,
      own_goals: ownGoals[player_id] ?? 0,
    }));
    if (rows.length) {
      const { error: goalsErr } = await supabase.from("game_stats").upsert(rows, { onConflict: "game_id,player_id" });
      if (goalsErr) return notifyError(goalsErr.message);
    }

    await Promise.all([loadGames(), loadGoals()]);
    notifySuccess("Result saved");
  }

  async function saveClubSettings(patch: Partial<ClubSettings>) {
    const { error } = await supabase.from("club_settings").update(patch).eq("id", true);
    if (error) return notifyError(error.message);
    await loadClubSettings();
    notifySuccess("Club settings saved");
  }

  async function addAward(title: string, value: string, note: string, imageFile: File | null, videoFile: File | null) {
    let image_url: string | null = null;
    let video_url: string | null = null;

    if (imageFile) {
      try {
        const compressed = await compressImage(imageFile);
        const path = `${crypto.randomUUID()}.jpg`;
        const { error: upErr } = await supabase.storage.from("award-media").upload(path, compressed, { contentType: "image/jpeg" });
        if (upErr) return notifyError(upErr.message);
        image_url = supabase.storage.from("award-media").getPublicUrl(path).data.publicUrl;
      } catch (err) {
        return notifyError(err instanceof Error ? err.message : "Couldn't process the image");
      }
    }

    if (videoFile) {
      if (videoFile.size > MAX_AWARD_VIDEO_MB * 1024 * 1024) {
        return notifyError(`Video must be under ${MAX_AWARD_VIDEO_MB}MB to keep storage usage reasonable`);
      }
      const ext = videoFile.name.split(".").pop() || "mp4";
      const path = `${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("award-media").upload(path, videoFile, { contentType: videoFile.type || "video/mp4" });
      if (upErr) return notifyError(upErr.message);
      video_url = supabase.storage.from("award-media").getPublicUrl(path).data.publicUrl;
    }

    const { error } = await supabase.from("awards").insert({ title, value, note: note || null, image_url, video_url });
    if (error) return notifyError(error.message);
    await loadAwards();
  }
  // Storage path is just whatever comes after the bucket name in the
  // public URL - the same string upload() was originally given.
  function storagePathFromUrl(url: string, bucket: string) {
    return url.split(`/${bucket}/`)[1] ?? null;
  }
  async function deleteAward(id: string) {
    const award = awards.find((a) => a.id === id);
    const { error } = await supabase.from("awards").delete().eq("id", id);
    if (error) return notifyError(error.message);
    const paths = [award?.image_url, award?.video_url]
      .filter((u): u is string => !!u)
      .map((u) => storagePathFromUrl(u, "award-media"))
      .filter((p): p is string => !!p);
    if (paths.length > 0) await supabase.storage.from("award-media").remove(paths);
    await loadAwards();
  }

  async function addPotEntry(amount: number, description: string, category: PotCategory) {
    const { error } = await supabase.from("pot_entries").insert({ amount, description, category, created_by: myId });
    if (error) return notifyError(error.message);
    await loadPotEntries();
  }
  async function deletePotEntry(id: string) {
    const { error } = await supabase.from("pot_entries").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadPotEntries();
  }

  async function castMotmVote(gameId: string, candidateId: string, candidateName: string) {
    const { error } = await supabase
      .from("motm_votes")
      .upsert({ game_id: gameId, voter_id: myId, candidate_id: candidateId }, { onConflict: "game_id,voter_id" });
    if (error) return notifyError(error.message);
    await loadMotmVotes();
    notifySuccess(`Voted for ${candidateName} — tap another name to change your pick`);
  }

  // RLS enforces the real rules (booked on this game, before kickoff) -
  // this just surfaces whatever it rejects rather than re-deriving them
  // client-side and risking the two definitions drifting apart.
  async function savePrediction(gameId: string, predictedWhite: number, predictedRed: number) {
    const { error } = await supabase
      .from("score_predictions")
      .upsert(
        { game_id: gameId, player_id: myId, predicted_white: predictedWhite, predicted_red: predictedRed, updated_at: new Date().toISOString() },
        { onConflict: "game_id,player_id" }
      );
    if (error) return notifyError(error.message);
    notifySuccess("Prediction locked in");
    await loadScorePredictions();
  }

  async function toggleReaction(itemKey: string, emoji: string) {
    const existing = feedReactions.find((r) => r.item_key === itemKey && r.emoji === emoji && r.user_id === myId);
    const { error } = existing
      ? await supabase.from("feed_reactions").delete().eq("id", existing.id)
      : await supabase.from("feed_reactions").insert({ item_key: itemKey, emoji, user_id: myId });
    if (error) return notifyError(error.message);
    await loadFeedReactions();
  }

  async function hideFeedItem(itemKey: string) {
    const { error } = await supabase.from("feed_hidden_items").insert({ item_key: itemKey, hidden_by: myId });
    if (error) return notifyError(error.message);
    notifySuccess("Archived — find it again under \"Show archived\"");
    await loadHiddenFeedItems();
  }
  async function unhideFeedItem(itemKey: string) {
    const { error } = await supabase.from("feed_hidden_items").delete().eq("item_key", itemKey);
    if (error) return notifyError(error.message);
    notifySuccess("Restored to the feed");
    await loadHiddenFeedItems();
  }

  async function addClip(e: React.FormEvent) {
    e.preventDefault();
    if (!clipTitle.trim()) return;
    const { error } = await supabase.from("clips").insert({ title: clipTitle.trim(), video_url: clipUrl.trim() || null, submitted_by: myId });
    if (error) return notifyError(error.message);
    setClipTitle("");
    setClipUrl("");
    await loadClips();
  }
  async function deleteClip(id: string) {
    const { error } = await supabase.from("clips").delete().eq("id", id);
    if (error) return notifyError(error.message);
    await loadClips();
  }

  async function setTeam(bookingId: string, team: Team | null) {
    const { error } = await supabase.from("bookings").update({ team }).eq("id", bookingId);
    if (error) notifyError(error.message);
  }

  // Editing used to write straight to the DB on every tap, which meant
  // players watching the same fixture saw someone flicker between White,
  // Red and Unassigned mid-edit rather than the finished split. Now every
  // tap only touches local draft state - nothing reaches other players
  // until Save actually writes the (real) changes.
  function startEditingLineup() {
    const draft: Record<string, Team | null> = {};
    nextConfirmed.forEach((b) => { draft[b.id] = b.team; });
    setTeamDraft(draft);
    setEditingLineup(true);
  }
  function cancelEditingLineup() {
    setEditingLineup(false);
  }
  async function saveLineup() {
    const changed = nextConfirmed.filter((b) => (teamDraft[b.id] ?? null) !== b.team);
    await Promise.all(changed.map((b) => setTeam(b.id, teamDraft[b.id] ?? null)));
    if (nextGame) {
      const whiteIds = nextConfirmed.filter((b) => teamDraft[b.id] === "white").map((b) => b.player_id);
      const redIds = nextConfirmed.filter((b) => teamDraft[b.id] === "red").map((b) => b.player_id);
      const score = balanceScore(teamStats(whiteIds), teamStats(redIds));
      await supabase.from("games").update({ team_method: "manual", team_balance_score: score }).eq("id", nextGame.id);
    }
    setEditingLineup(false);
    await loadGames();
  }

  // Drag-and-drop pitch positions: dragging only ever touches local
  // positionDraft state (same "nothing reaches other players until Save"
  // rule as the team-assignment editor above) until an admin explicitly
  // locks it in, which writes the whole current layout as one snapshot.
  function startEditingPositions() {
    const draft: Record<string, { x: number; y: number }> = {};
    pitchTokens.forEach((t) => { draft[t.booking.player_id] = { x: t.x, y: t.y }; });
    setPositionDraft(draft);
    setEditingPositions(true);
  }
  function cancelEditingPositions() {
    setEditingPositions(false);
    setDraggingPlayerId(null);
  }
  async function savePositions() {
    if (!nextGame) return;
    const { error } = await supabase.from("games").update({ lineup_positions: positionDraft }).eq("id", nextGame.id);
    if (error) { notifyError(error.message); return; }
    setEditingPositions(false);
    setDraggingPlayerId(null);
    await loadGames();
  }
  async function resetPositions() {
    if (!nextGame) return;
    if (!(await askConfirm("Reset to auto layout?", "This clears everyone's manually placed positions for this game and goes back to the automatic formation.", "Reset", true))) return;
    const { error } = await supabase.from("games").update({ lineup_positions: null }).eq("id", nextGame.id);
    if (error) { notifyError(error.message); return; }
    await loadGames();
  }
  function movePlayerTo(playerId: string, clientX: number, clientY: number) {
    const card = pitchCardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = Math.min(96, Math.max(4, ((clientX - rect.left) / rect.width) * 100));
    const y = Math.min(96, Math.max(4, ((clientY - rect.top) / rect.height) * 100));
    setPositionDraft((prev) => ({ ...prev, [playerId]: { x, y } }));
  }

  async function copyLineup() {
    if (!nextGame) return;
    const names = (group: BookingRow[]) => group.map((b) => b.player.display_name);
    const section = (teamName: string, group: BookingRow[]) =>
      `${teamName}\n` + (names(group).map((n, i) => `${i + 1}. ${n}`).join("\n") || "—");
    const text =
      `⚽ ${nextGame.venue} — ${fmtDate(nextGame.date)}, ${nextGame.kickoff}\n\n` +
      `${section(`🔴 ${cs.team_red_name}`, nextGrouped.red)}\n\n` +
      `${section(`⚪ ${cs.team_white_name}`, nextGrouped.white)}`;
    try {
      await navigator.clipboard.writeText(text);
      notifySuccess("Lineup copied — paste it into WhatsApp");
    } catch {
      notifyError("Couldn't copy — your browser may be blocking clipboard access");
    }
  }

  // Formats the same "Fixture Updates" digest admins were already typing
  // out by hand for WhatsApp - grouped by month, fullness per fixture, plus
  // a "N bookings since the last update" line worked out from real
  // booking created_at timestamps against club_settings.last_fixture_
  // update_at (not a diff of counts, which cancellations could throw off).
  // Real emoji, not :shortcode: text - those don't render in WhatsApp.
  function ordinal(n: number) {
    const v = n % 100;
    if (v >= 11 && v <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }
  async function copyFixtureUpdate() {
    const published = upcomingGames.filter((g) => g.published);
    if (published.length === 0) return notifyError("No published upcoming fixtures to report on");

    const lastUpdateMs = cs.last_fixture_update_at ? new Date(cs.last_fixture_update_at).getTime() : null;
    let newBookingsCount = 0;
    const movementByGame: Record<string, number> = {};
    if (lastUpdateMs) {
      published.forEach((g) => {
        const newOnes = g.bookings.filter((b) => !b.waiting && new Date(b.created_at).getTime() > lastUpdateMs).length;
        if (newOnes > 0) {
          movementByGame[g.id] = newOnes;
          newBookingsCount += newOnes;
        }
      });
    }

    // WhatsApp actually renders *bold* - leaning on that for real visual
    // hierarchy (month headers, FULL) instead of doubled-up emoji brackets,
    // and short weekday/day/month reads faster on a phone than spelling
    // every date out in full.
    const fmtLine = (g: GameRow) => {
      const d = new Date(g.date + "T00:00:00");
      const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
      const month = d.toLocaleDateString("en-GB", { month: "short" });
      const spotsLeft = g.max_players - g.bookings.filter((b) => !b.waiting).length;
      const status = spotsLeft <= 0 ? "*FULL*" : `✅ ${spotsLeft} spots left`;
      return `${weekday} ${d.getDate()} ${month} — ${status}`;
    };

    const byMonth: Record<string, GameRow[]> = {};
    published.forEach((g) => {
      const key = g.date.slice(0, 7);
      (byMonth[key] ??= []).push(g);
    });
    const sections = Object.keys(byMonth)
      .sort()
      .map((key) => {
        const label = new Date(key + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        return `*${label}*\n${byMonth[key].map((g) => fmtLine(g)).join("\n")}`;
      });

    let movementLine = "";
    if (newBookingsCount > 0) {
      const dateLabels = Object.entries(movementByGame)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([gameId]) => published.find((g) => g.id === gameId)!)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((g) => {
          const d = new Date(g.date + "T00:00:00");
          return `${ordinal(d.getDate())} ${d.toLocaleDateString("en-GB", { month: "short" })}`;
        });
      const joined = dateLabels.length > 1 ? `${dateLabels.slice(0, -1).join(", ")} & ${dateLabels[dateLabels.length - 1]}` : dateLabels[0];
      movementLine = `📢 ${newBookingsCount} booking${newBookingsCount === 1 ? "" : "s"} since the last update — biggest movement on ${joined} 📢\n\n`;
    }

    const text = `*⭐ Wirral Community Football ⭐*\n*Fixture Updates*\n\n${movementLine}Get booked on lads 👇\n\n${sections.join("\n\n")}`;

    if (!(await askConfirm("Copy the fixture update?", "This resets the \"since last update\" count for next time.", "Copy", false))) return;
    try {
      await navigator.clipboard.writeText(text);
      const { error } = await supabase.from("club_settings").update({ last_fixture_update_at: new Date().toISOString() }).eq("id", true);
      if (error) return notifyError(error.message);
      await loadClubSettings();
      notifySuccess("Fixture update copied — paste it into WhatsApp");
    } catch {
      notifyError("Couldn't copy — your browser may be blocking clipboard access");
    }
  }

  // Admin-only, by design - keeps this as an official/curated post like the
  // WhatsApp lineup button, rather than something every player can trigger.
  async function shareResult(game: GameRow) {
    const scorers = goalRows.filter((r) => r.game_id === game.id && r.goals > 0);
    const teamOf = (playerId: string) => game.bookings.find((b) => b.player_id === playerId)?.team;
    const whiteScorers = scorers.filter((r) => teamOf(r.player_id) === "white").map((r) => ({ name: r.player.display_name, goals: r.goals }));
    const redScorers = scorers.filter((r) => teamOf(r.player_id) === "red").map((r) => ({ name: r.player.display_name, goals: r.goals }));
    const ownGoals = goalRows
      .filter((r) => r.game_id === game.id && r.own_goals > 0)
      .map((r) => ({ name: r.player.display_name, goals: r.own_goals }));

    // Same reveal rule as the in-app MOTM display - never share a winner
    // before voting's actually closed.
    const candidates = game.bookings.filter((b) => !b.waiting);
    const tally = motmTallyByGame[game.id] ?? {};
    const ranked = candidates
      .map((c) => ({ name: c.player.display_name, votes: tally[c.player_id] ?? 0 }))
      .sort((a, b) => b.votes - a.votes);
    const motmWinner = !motmVotingOpen(game) && ranked[0]?.votes > 0 ? ranked[0].name : null;

    try {
      const blob = await drawResultCard({
        venue: game.venue,
        pitch: game.pitch,
        dateLabel: fmtDate(game.date),
        whiteName: cs.team_white_name,
        redName: cs.team_red_name,
        whiteColor: cs.team_white_color,
        redColor: cs.team_red_color,
        whiteScore: game.team_white_score ?? 0,
        redScore: game.team_red_score ?? 0,
        whiteScorers,
        redScorers,
        ownGoals,
        motmWinner,
      });
      const file = new File([blob], `${game.venue.replace(/\s+/g, "-")}-${game.date}.png`, { type: "image/png" });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
        notifySuccess("Image downloaded");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // user backed out of the share sheet
      notifyError(err instanceof Error ? err.message : "Couldn't generate the image");
    }
  }

  async function applySuggestedTeams() {
    if (!suggestedTeams || !nextGame) return;
    const bookingIdByPlayer = new Map(nextConfirmed.map((b) => [b.player_id, b.id]));
    await Promise.all(
      [...suggestedTeams.white.map((id) => [id, "white"] as const), ...suggestedTeams.red.map((id) => [id, "red"] as const)].map(
        ([playerId, team]) => {
          const bookingId = bookingIdByPlayer.get(playerId);
          return bookingId ? setTeam(bookingId, team) : Promise.resolve();
        }
      )
    );
    const score = balanceScore(teamStats(suggestedTeams.white), teamStats(suggestedTeams.red));
    await supabase.from("games").update({ team_method: "generated", team_balance_score: score }).eq("id", nextGame.id);
    setSuggestedTeams(null);
    await loadGames();
    notifySuccess("Applied the suggested split — tweak any individual player in Team Sheet if needed");
  }

  // Team is per-fixture, not a fixed player attribute, so the card can only
  // show one when the tap happened somewhere that actually knows it (the
  // Line-up screen). Every other call site goes through here too, passing
  // no team, so a stale team from a previous card can never leak into one
  // that doesn't have that context.
  function openPlayerCard(id: string, team?: { name: string; color: string } | null) {
    setPlayerCardId(id);
    setPlayerCardTeam(team ?? null);
  }
  async function renameSelf(name: string) {
    if (!name.trim()) return;
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", myId);
    if (error) return notifyError(error.message);
    await Promise.all([loadProfile(), loadProfiles()]);
  }
  async function adminRenamePlayer(id: string, name: string) {
    if (!name.trim()) return;
    const oldName = profiles.find((p) => p.id === id)?.display_name ?? "someone";
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadProfiles();
    if (id === myId) await loadProfile();
    logAction("Renamed player", `${oldName} → ${name.trim()}`);
  }
  // One canonical file per player (path is just their id), overwritten on
  // every re-upload via upsert - no orphaned old photos to clean up. The
  // path itself never changes on re-upload, so a cache-busting query param
  // is needed or the browser (and other players' already-loaded pages)
  // would keep showing the old cached image at that URL.
  async function uploadMyAvatar(file: File) {
    try {
      const compressed = await compressImage(file, 480, 0.85);
      const path = `${myId}.jpg`;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, compressed, { contentType: "image/jpeg", upsert: true });
      if (upErr) return notifyError(upErr.message);
      const url = `${supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
      const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", myId);
      if (error) return notifyError(error.message);
      await Promise.all([loadProfile(), loadProfiles()]);
      notifySuccess("Photo updated");
    } catch (err) {
      notifyError(err instanceof Error ? err.message : "Couldn't process that photo");
    }
  }
  async function removeMyAvatar() {
    await supabase.storage.from("avatars").remove([`${myId}.jpg`]);
    const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", myId);
    if (error) return notifyError(error.message);
    await Promise.all([loadProfile(), loadProfiles()]);
  }
  // Admin moderation override - remove someone else's photo without
  // needing to reach them first, same trust level already extended to
  // rename/role changes on other players.
  async function adminRemovePlayerAvatar(id: string) {
    const targetName = profiles.find((p) => p.id === id)?.display_name ?? "someone";
    await supabase.storage.from("avatars").remove([`${id}.jpg`]);
    const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadProfiles();
    logAction("Removed profile photo", targetName);
  }
  async function setRole(id: string, role: Role) {
    const targetName = profiles.find((p) => p.id === id)?.display_name ?? "someone";
    const { error } = await supabase.from("profiles").update({ role }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadProfiles();
    logAction("Changed role", `${targetName} → ${ROLE_LABEL[role]}`);
  }
  async function deleteProfile(id: string, name: string) {
    if (!(await askConfirm(`Permanently delete ${name}'s account?`, "This removes their login and all their bookings. This can't be undone.", "Delete forever"))) {
      return;
    }
    const token = await getFreshAccessToken();
    if (!token) return notifyError("Your session's expired — refresh the page and sign in again, then retry.");
    const res = await fetch("/api/admin/delete-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetId: id }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Something went wrong" }));
      notifyError(error || "Couldn't delete that account");
      return;
    }
    await Promise.all([loadProfiles(), loadGames()]);
    logAction("Deleted account", name);
  }
  async function addPlayer(email: string, displayName: string) {
    const token = await getFreshAccessToken();
    if (!token) {
      notifyError("Your session's expired — refresh the page and sign in again, then retry.");
      return false;
    }
    const res = await fetch("/api/admin/add-player", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, displayName }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Something went wrong" }));
      notifyError(error || "Couldn't add that player");
      return false;
    }
    notifySuccess(`${displayName || email} can now sign in with that email`);
    await loadProfiles();
    logAction("Added player", displayName || email);
    return true;
  }
  async function generateLoginCode(email: string): Promise<string | null> {
    const token = await getFreshAccessToken();
    if (!token) {
      notifyError("Your session's expired — refresh the page and sign in again, then retry.");
      return null;
    }
    const res = await fetch("/api/admin/generate-login-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notifyError(data.error || "Couldn't generate a code");
      return null;
    }
    logAction("Generated login code", email);
    return data.code as string;
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  // Forces a re-render every 30s purely so the countdown line below stays
  // live - nowUk itself is just nowInLondon() called fresh each render, so
  // it naturally reflects the current time once something triggers a
  // render; this is that trigger.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // One fixed coordinate for the whole club rather than geocoding each
  // venue - they're all a few miles apart in Wirral, which doesn't move
  // a forecast meaningfully. Open-Meteo needs no key and allows direct
  // browser calls. Fetched once per session (forecasts don't shift
  // minute to minute) - a failure just means no chips show, not an error
  // worth surfacing for a nice-to-have.
  const [hourlyWeather, setHourlyWeather] = useState<{ time: string[]; temp: number[]; code: number[] } | null>(null);
  useEffect(() => {
    fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=53.43&longitude=-3.06&hourly=temperature_2m,weathercode&forecast_days=8&timezone=Europe%2FLondon"
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.hourly?.time) {
          setHourlyWeather({ time: data.hourly.time, temp: data.hourly.temperature_2m, code: data.hourly.weathercode });
        }
      })
      .catch(() => {});
  }, []);
  function weatherFor(date: string, kickoff: string) {
    if (!hourlyWeather) return null;
    const targetMs = new Date(`${date}T${kickoff}`).getTime();
    let bestIdx = -1;
    let bestDiff = Infinity;
    hourlyWeather.time.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    // More than 90 min off whatever the API actually covers isn't a
    // trustworthy match for that kickoff - better to show nothing.
    if (bestIdx === -1 || bestDiff > 90 * 60 * 1000) return null;
    return { code: hourlyWeather.code[bestIdx], temp: Math.round(hourlyWeather.temp[bestIdx]) };
  }

  const nowUk = nowInLondon();
  const upcomingGames = useMemo(
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) > nowUk).sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)),
    [games, nowUk]
  );
  // Same YYYY-MM grouping key already used by copyFixtureUpdate() for the
  // WhatsApp digest, just applied to the live list instead of a copied
  // message. Headers only render when there's more than one month in view
  // - with just a few fixtures up, a single "August 2026" header is noise,
  // not signal.
  const upcomingByMonth = useMemo(() => {
    const byMonth: Record<string, GameRow[]> = {};
    upcomingGames.forEach((g) => {
      const key = g.date.slice(0, 7);
      (byMonth[key] ??= []).push(g);
    });
    return Object.keys(byMonth)
      .sort()
      .map((key) => ({
        key,
        label: new Date(key + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
        games: byMonth[key],
      }));
  }, [upcomingGames]);
  // Deliberately quiet - small text under the heading, not a banner. Only
  // the soonest published fixture (drafts don't count, even for admins
  // previewing one), and only down to the minute - the existing "kickoff
  // in 1 hour" push already owns second-by-second urgency.
  const nextFixtureForCountdown = upcomingGames.find((g) => g.published);
  const fixtureCountdown = useMemo(() => {
    if (!nextFixtureForCountdown) return null;
    const diffMs = toMs(kickoffCutoff(nextFixtureForCountdown.date, nextFixtureForCountdown.kickoff, 0)) - toMs(nowUk);
    if (diffMs <= 0) return { text: "Kicking off now ⚽", soon: true };
    const totalMin = Math.floor(diffMs / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    return { text: d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`, soon: totalMin < 60 };
  }, [nextFixtureForCountdown, nowUk]);
  const pastGames = useMemo(
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= nowUk).sort((a, b) => b.date.localeCompare(a.date) || b.kickoff.localeCompare(a.kickoff)),
    [games, nowUk]
  );

  // Same definition as the admin console's "Overdue" section - an
  // unconfirmed, non-waiting booking on a game that's already happened.
  // Mirrors the RLS check in has_overdue_payment() so the UI matches what
  // the database will actually enforce, not just a client-side guess.
  const myOverdueBookings = useMemo(
    () =>
      pastGames.flatMap((g) =>
        g.bookings
          .filter((b) => b.player_id === myId && !b.waiting && b.status !== "confirmed" && !b.pot_exempt_reason)
          .map((b) => ({ game: g, booking: b }))
      ),
    [pastGames, myId]
  );
  const iAmOverdue = myOverdueBookings.length > 0;
  // Split for the "Your tab" card display only - owed (unpaid, real
  // debt) vs pending (already tapped I've paid, awaiting admin
  // confirmation). Doesn't change what counts as "overdue" for the
  // booking-block banner above, which deliberately still requires full
  // admin confirmation (not just a player's self-reported "I've paid")
  // before the block lifts - same as the server-side RLS check.
  const myTabOwed = useMemo(() => myOverdueBookings.filter((o) => o.booking.status === "unpaid"), [myOverdueBookings]);
  const myTabPending = useMemo(() => myOverdueBookings.filter((o) => o.booking.status === "pending"), [myOverdueBookings]);

  const myUnreadMessages = useMemo(
    () => adminMessages.filter((m) => m.recipient_id === myId && !m.read_at),
    [adminMessages, myId]
  );

  // Same "is push actually working on this device" derivation used in
  // AccountPanel - the DB flag alone isn't enough proof (see the toggle
  // fix), and permission is per-device anyway.
  // Browser permission is per-origin, not per-account - it survives a
  // delete+recreate of the profile even though there's no live
  // push_subscriptions row for the new profile id yet. push_opt_in is
  // kept in sync with a real subscription by enablePush/disablePush (and
  // matches what the Account toggle itself shows, see AccountPanel's
  // pushOn), so both conditions are needed here, not permission alone.
  const myPushGranted =
    typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted" && !!myProfile?.push_opt_in;
  const showPushNudge = !myPushGranted && !pushNudgeDismissed;
  const myRating = selfRatings.find((r) => r.player_id === myId) ?? null;
  const showRatingNudge = !myRating && !ratingNudgeDismissed;

  function motmVotingOpen(g: GameRow) {
    return kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk;
  }
  const myMotmVoteByGame = useMemo(() => {
    const map: Record<string, string> = {};
    for (const v of motmVotes) if (v.voter_id === myId) map[v.game_id] = v.candidate_id;
    return map;
  }, [motmVotes, myId]);
  const motmTallyByGame = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const v of motmVotes) {
      map[v.game_id] ??= {};
      map[v.game_id][v.candidate_id] = (map[v.game_id][v.candidate_id] ?? 0) + 1;
    }
    return map;
  }, [motmVotes]);

  const potLedger = useMemo(() => {
    // Counts as soon as a game has any confirmed payment - people pay in
    // advance to secure a spot, so that money is real before kickoff, not
    // after. Games with zero confirmed payments are excluded entirely
    // (rather than showing an immediate -pitch_cost the moment a fixture
    // is created, before anyone's even had a chance to book).
    const autoEntries = games
      .filter((g) => g.bookings.some((b) => !b.waiting && b.status === "confirmed"))
      .map((g) => {
        // Pot-exempt bookings (prize/carried-over) are still real confirmed
        // spots - they just don't generate fresh pot income - so they count
        // toward the game being included here, but not toward confirmedPaid.
        const confirmedPaid = g.bookings.filter((b) => !b.waiting && b.status === "confirmed" && !b.pot_exempt_reason).length;
        const amount = confirmedPaid * g.price - g.pitch_cost;
        return {
          id: `game-${g.id}`,
          date: g.date,
          amount,
          description: `${g.venue} · ${fmtDate(g.date)} — ${confirmedPaid} paid × £${g.price} − £${g.pitch_cost} pitch`,
          category: "pitch" as PotCategory,
          kind: "auto" as const,
        };
      });
    const manualEntries = potEntries.map((e) => ({
      id: e.id,
      category: e.category,
      date: e.created_at.slice(0, 10),
      amount: e.amount,
      description: e.description,
      kind: "manual" as const,
    }));
    return [...autoEntries, ...manualEntries].sort((a, b) => b.date.localeCompare(a.date));
  }, [games, potEntries]);
  const potTotal = useMemo(() => potLedger.reduce((sum, e) => sum + e.amount, 0), [potLedger]);

  // Income/expenses computed from source data (games, manual entries)
  // rather than potLedger's already-netted auto entries - a game's net
  // +£30 hides that it was actually £110 in vs £80 pitch cost, and this
  // view is specifically about showing those two sides separately.
  const financeSummary = useMemo(() => {
    let grossIncome = 0;
    let pitchExpense = 0;
    for (const g of games) {
      const confirmedTotal = g.bookings.filter((b) => !b.waiting && b.status === "confirmed").length;
      if (confirmedTotal === 0) continue; // matches potLedger's own inclusion rule
      const confirmedPaid = g.bookings.filter((b) => !b.waiting && b.status === "confirmed" && !b.pot_exempt_reason).length;
      grossIncome += confirmedPaid * g.price;
      pitchExpense += g.pitch_cost;
    }
    const manualIncome = potEntries.filter((e) => e.amount > 0).reduce((sum, e) => sum + e.amount, 0);
    const manualExpense = potEntries.filter((e) => e.amount < 0).reduce((sum, e) => sum + Math.abs(e.amount), 0);

    const byCategory = { pitch: pitchExpense, socials: 0, equipment: 0, sponsorship: 0, other: 0 } as Record<PotCategory, number>;
    for (const e of potEntries) {
      if (e.amount < 0) byCategory[e.category] += Math.abs(e.amount);
    }

    const chron = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    const balancePoints = chron.map((e) => {
      running += e.amount;
      return { date: e.date, balance: running };
    });

    const byFixture = potLedger.filter((e) => e.kind === "auto").slice(0, 8);

    return { income: grossIncome + manualIncome, expenses: pitchExpense + manualExpense, byCategory, balancePoints, byFixture };
  }, [games, potEntries, potLedger]);

  function exportFinanceCsv() {
    const rows = [
      ["Date", "Description", "Category", "Amount"],
      ...potLedger.map((e) => [e.date, e.description, POT_CATEGORY_LABEL[e.category], e.amount.toFixed(2)]),
    ];
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wirral-community-football-finances-${nowInLondon().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // The club feed is mostly a view over data that already exists elsewhere
  // (results, joiners, the pot) rather than its own write path - only clips
  // and MOTM votes are genuinely new here, so most of this list is derived,
  // not stored.
  const feedItems = useMemo(() => {
    const items: FeedItem[] = [];

    for (const c of clips) {
      items.push({ key: `clip-${c.id}`, ts: new Date(c.created_at).getTime(), kind: "clip", clip: c });
    }

    for (const g of games) {
      if (g.team_white_score == null || g.team_red_score == null) continue;
      items.push({
        key: `game-${g.id}-fulltime`,
        ts: toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)),
        kind: "derived",
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5l3 2.2-1.1 3.6h-3.8L9 9.7z" />
            <path d="M12 3v4.5M5 8.5l4 1.7M19 8.5l-4 1.7M7.3 19l1.7-4.9M16.7 19l-1.7-4.9" />
          </svg>
        ),
        tone: "blue",
        text: (
          <>
            Full time
            <div className="wcf-feed-score-chip">
              <span style={{ color: cs.team_white_color }}>{g.team_white_score}</span>
              <span className="wcf-feed-score-dash">–</span>
              <span style={{ color: cs.team_red_color }}>{g.team_red_score}</span>
            </div>
          </>
        ),
      });

      if (!motmVotingOpen(g)) {
        const tally = motmTallyByGame[g.id] ?? {};
        const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        const winnerId = ranked[0]?.[0];
        const winner = winnerId ? g.bookings.find((b) => b.player_id === winnerId)?.player : undefined;
        if (winner) {
          items.push({
            key: `motm-${g.id}`,
            ts: toMs(kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES)),
            kind: "derived",
            icon: (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M7 4h10v5a5 5 0 0 1-10 0z" strokeLinejoin="round" />
                <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
                <path d="M12 14v3M9 20h6M9.5 17h5l.5 3H9z" strokeLinejoin="round" />
              </svg>
            ),
            tone: "amber",
            text: (
              <>
                <strong>{winner.display_name}</strong> voted Man of the Match
              </>
            ),
          });
        }
      }
    }

    // Every £50 the pot's running total crosses, oldest to newest.
    const chron = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const e of chron) {
      const before = running;
      running += e.amount;
      for (let t = Math.floor(before / 50 + 1) * 50; t > before && t <= running; t += 50) {
        items.push({
          key: `pot-${t}`,
          ts: toMs(e.date + "T12:00"),
          kind: "derived",
          icon: (
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <ellipse cx="12" cy="6" rx="7" ry="3" />
              <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
              <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
            </svg>
          ),
          tone: "green",
          text: (
            <>
              Community pot passed <strong>£{t}</strong>
            </>
          ),
        });
      }
    }

    for (const p of profiles) {
      if (!p.created_at) continue;
      items.push({
        key: `join-${p.id}`,
        ts: new Date(p.created_at).getTime(),
        kind: "derived",
        icon: (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="7" cy="7" r="4" />
            <path d="M19 8v6M22 11h-6" />
          </svg>
        ),
        tone: "blue",
        text: (
          <>
            <strong>{p.display_name}</strong> joined the club
          </>
        ),
      });
    }

    // Every 5th appearance (5, 10, 15, 20...) - walked oldest to newest so
    // the running count per player is accurate.
    const chronPast = [...pastGames].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
    const appCounts: Record<string, number> = {};
    for (const g of chronPast) {
      for (const b of g.bookings.filter((bk) => !bk.waiting)) {
        appCounts[b.player_id] = (appCounts[b.player_id] ?? 0) + 1;
        const count = appCounts[b.player_id];
        if (count % 5 === 0) {
          items.push({
            key: `apps-${b.player_id}-${count}`,
            ts: toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)),
            kind: "derived",
            icon: (
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7z" strokeLinejoin="round" />
              </svg>
            ),
            tone: "amber",
            text: (
              <>
                <strong>{b.player.display_name}</strong> hit {count} appearances!
              </>
            ),
          });
        }
      }
    }

    return items.sort((a, b) => b.ts - a.ts);
  }, [clips, games, pastGames, motmTallyByGame, potLedger, profiles, cs.team_white_name, cs.team_red_name, nowUk]);

  const visibleFeedItems = useMemo(() => {
    const kindMatch = feedItems.filter((item) => (feedView === "clips" ? item.kind === "clip" : item.kind === "derived"));
    if (feedView === "clips") return kindMatch;
    // In the normal feed view, archived items are hidden. The "Show
    // archived" toggle (admin-only) flips to showing *only* the archived
    // ones, so they can be reviewed and restored rather than lost.
    return kindMatch.filter((item) => showArchived === hiddenFeedKeys.includes(item.key));
  }, [feedItems, feedView, hiddenFeedKeys, showArchived]);

  const feedReactionTally = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const r of feedReactions) {
      map[r.item_key] ??= {};
      map[r.item_key][r.emoji] = (map[r.item_key][r.emoji] ?? 0) + 1;
    }
    return map;
  }, [feedReactions]);

  // Player of the Month: computed, not stored - whoever won MOTM the most
  // times in the last fully-completed calendar month, tie-broken by total
  // votes received that month. Needs at least 2 voted games that month to
  // mean anything, and only reveals once the month's over (not a mid-month
  // leaderboard that flips around), staying up for the whole next month.
  const playerOfMonth = useMemo(() => {
    const monthKey = previousMonthKey(nowUk);
    const monthGames = pastGames.filter(
      (g) => g.date.startsWith(monthKey) && g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g)
    );
    if (monthGames.length < 2) return null;

    const wins: Record<string, number> = {};
    const votes: Record<string, number> = {};
    const names: Record<string, string> = {};

    for (const g of monthGames) {
      const tally = motmTallyByGame[g.id] ?? {};
      const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      const topCount = ranked[0]?.[1] ?? 0;
      for (const [playerId, count] of ranked) {
        votes[playerId] = (votes[playerId] ?? 0) + count;
        names[playerId] ??= g.bookings.find((b) => b.player_id === playerId)?.player.display_name ?? "";
        if (topCount > 0 && count === topCount) wins[playerId] = (wins[playerId] ?? 0) + 1;
      }
    }

    const contenders = Object.keys(wins);
    if (contenders.length === 0) return null;
    const maxWins = Math.max(...contenders.map((id) => wins[id]));
    let leaders = contenders.filter((id) => wins[id] === maxWins);
    if (leaders.length > 1) {
      const maxVotes = Math.max(...leaders.map((id) => votes[id] ?? 0));
      leaders = leaders.filter((id) => (votes[id] ?? 0) === maxVotes);
    }

    return {
      monthLabel: new Date(monthKey + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      names: leaders.map((id) => names[id]).filter(Boolean),
    };
  }, [pastGames, motmTallyByGame, nowUk]);

  // Seasons run calendar-year, not the traditional Aug-May football season -
  // Season 1 is 2026 (the club's founding year), Season 2 starts 1 Jan
  // 2027. Stats default to the current season ("archived" in the sense of
  // not being the default view) but every past season stays picklable via
  // the selector below, rather than actually deleting old data.
  const SEASON_EPOCH_YEAR = 2026;
  const currentSeasonYear = Number(nowUk.slice(0, 4));
  const [statsSeasonYear, setStatsSeasonYear] = useState<number | null>(null);
  const [statsSort, setStatsSort] = useState<"apps" | "goals">("goals");
  const [statsOpenId, setStatsOpenId] = useState<string | null>(null);
  const activeStatsYear = statsSeasonYear ?? currentSeasonYear;
  const seasonYears = useMemo(() => {
    const set = new Set(pastGames.map((g) => Number(g.date.slice(0, 4))));
    set.add(currentSeasonYear);
    return Array.from(set).sort((a, b) => b - a);
  }, [pastGames, currentSeasonYear]);

  // Stats/Predictions render off computed rollups keyed by player id+name,
  // not full Profile rows, so avatar photos need a side lookup rather than
  // being threaded through those computations.
  const avatarByPlayerId = useMemo(() => new Map(profiles.map((p) => [p.id, p.avatar_url])), [profiles]);

  const playerStats = useMemo(() => {
    const tally: Record<string, { name: string; apps: number; goals: number; lastPlayed: string }> = {};
    const seasonGames = pastGames.filter((g) => g.date.slice(0, 4) === String(activeStatsYear));
    const pastGameIds = new Set(seasonGames.map((g) => g.id));
    seasonGames.forEach((g) =>
      g.bookings
        .filter((b) => !b.waiting)
        .forEach((b) => {
          const cur = tally[b.player_id] ?? { name: b.player.display_name, apps: 0, goals: 0, lastPlayed: "" };
          cur.apps += 1;
          if (g.date > cur.lastPlayed) cur.lastPlayed = g.date;
          tally[b.player_id] = cur;
        })
    );
    goalRows
      .filter((r) => pastGameIds.has(r.game_id))
      .forEach((r) => {
        const cur = tally[r.player_id] ?? { name: r.player.display_name, apps: 0, goals: 0, lastPlayed: "" };
        cur.goals += r.goals;
        tally[r.player_id] = cur;
      });
    return Object.entries(tally)
      .map(([id, row]) => ({ id, ...row }))
      .sort((a, b) => b.apps - a.apps);
  }, [pastGames, goalRows, activeStatsYear]);

  const nextGame = upcomingGames[0];
  const nextConfirmed = useMemo(
    () => (nextGame ? nextGame.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [nextGame]
  );
  useEffect(() => { setEditingLineup(false); setSelectedLineupPlayerId(null); }, [nextGame?.id]);
  useEffect(() => setSuggestedTeams(null), [nextGame?.id]);
  const nextGrouped = useMemo(
    () => ({
      white: nextConfirmed.filter((b) => b.team === "white"),
      red: nextConfirmed.filter((b) => b.team === "red"),
      unassigned: nextConfirmed.filter((b) => !b.team),
    }),
    [nextConfirmed]
  );
  // Pitch-view token positions: a locked-in admin position (nextGame.lineup_positions)
  // wins if one exists for that player, otherwise falls back to the auto
  // formationSlots() layout - so a player added to the roster after the
  // last "lock in" still shows up somewhere sensible instead of vanishing.
  // While actively dragging (editingPositions), the local positionDraft
  // takes priority over the saved value so the drag feels live.
  const pitchTokens = useMemo(() => {
    const redSlots = formationSlots(nextGrouped.red.length);
    const whiteSlots = formationSlots(nextGrouped.white.length);
    const saved = nextGame?.lineup_positions ?? null;
    const posFor = (playerId: string, auto: { x: number; y: number }) =>
      editingPositions ? positionDraft[playerId] ?? saved?.[playerId] ?? auto : saved?.[playerId] ?? auto;
    const redTokens = nextGrouped.red.map((b, i) => {
      const pos = posFor(b.player_id, { x: redSlots[i].x, y: redSlots[i].y });
      return { booking: b, isRed: true, x: pos.x, y: pos.y, role: redSlots[i].role };
    });
    const whiteTokens = nextGrouped.white.map((b, i) => {
      const pos = posFor(b.player_id, { x: whiteSlots[i].x, y: 100 - whiteSlots[i].y });
      return { booking: b, isRed: false, x: pos.x, y: pos.y, role: whiteSlots[i].role };
    });
    return [...redTokens, ...whiteTokens];
  }, [nextGrouped, nextGame?.lineup_positions, editingPositions, positionDraft]);
  // Same grouping as above but reading the local edit draft instead of the
  // saved team - lets the Team Sheet stay grouped-by-team (matching what
  // players see) even while an admin's mid-edit.
  const editGrouped = useMemo(
    () => ({
      white: nextConfirmed.filter((b) => teamDraft[b.id] === "white"),
      red: nextConfirmed.filter((b) => teamDraft[b.id] === "red"),
      unassigned: nextConfirmed.filter((b) => !teamDraft[b.id]),
    }),
    [nextConfirmed, teamDraft]
  );

  // Admin rating wins if one exists; otherwise fall back to the player's
  // own self-rating; otherwise they're simply unrated.
  const ratingByPlayer = useMemo(() => {
    const map: Record<string, PlayerRating> = {};
    for (const r of selfRatings) map[r.player_id] = r;
    for (const r of adminRatings) map[r.player_id] = r;
    return map;
  }, [selfRatings, adminRatings]);

  // Backing data for the Player Card popup - apps/goals/MOTM pinned to the
  // current season regardless of whatever year Stats happens to be
  // filtered to elsewhere, since this is a standalone summary, not tied to
  // that view's own filter state.
  const playerCardStats = useMemo(() => {
    const stats: Record<string, { apps: number; goals: number; motm: number }> = {};
    const bump = (id: string, key: "apps" | "goals" | "motm", by: number) => {
      const cur = stats[id] ?? { apps: 0, goals: 0, motm: 0 };
      cur[key] += by;
      stats[id] = cur;
    };
    const seasonGames = pastGames.filter((g) => g.date.slice(0, 4) === String(currentSeasonYear));
    const seasonGameIds = new Set(seasonGames.map((g) => g.id));
    seasonGames.forEach((g) => g.bookings.filter((b) => !b.waiting).forEach((b) => bump(b.player_id, "apps", 1)));
    goalRows.filter((r) => seasonGameIds.has(r.game_id)).forEach((r) => bump(r.player_id, "goals", r.goals));
    seasonGames.forEach((g) => {
      if (motmVotingOpen(g)) return;
      const tally = motmTallyByGame[g.id] ?? {};
      const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (ranked.length > 0 && ranked[0][1] > 0) bump(ranked[0][0], "motm", 1);
    });
    return stats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, goalRows, motmTallyByGame, currentSeasonYear]);

  // Standalone (not memoized) so the same math can score both the live
  // saved split and a not-yet-applied suggestion before committing to it.
  function teamStats(playerIds: string[]) {
    const ratings = playerIds.map((id) => ratingByPlayer[id]).filter((r): r is PlayerRating => !!r);
    const avg = (key: "fitness" | "attack" | "defence") =>
      ratings.length ? ratings.reduce((sum, r) => sum + r[key], 0) / ratings.length : 0;
    const positions: Record<PlayerPosition, number> = { keeper: 0, defence: 0, midfield: 0, attack: 0 };
    for (const r of ratings) positions[r.position]++;
    return { fitness: avg("fitness"), attack: avg("attack"), defence: avg("defence"), positions, rated: ratings.length, total: playerIds.length };
  }
  // Same fitness/attack/defence gaps the flags already warn about, turned
  // into one 0-100% number so two splits can be compared at a glance, and
  // so it's simple enough to store alongside a game and track over time.
  // Null when there's not enough rating data on either side to mean
  // anything - matches fairnessFlags' own guard for the same reason.
  function balanceScore(white: ReturnType<typeof teamStats>, red: ReturnType<typeof teamStats>): number | null {
    if (white.rated === 0 || red.rated === 0) return null;
    const gap = Math.abs(white.fitness - red.fitness) + Math.abs(white.attack - red.attack) + Math.abs(white.defence - red.defence);
    return Math.max(0, Math.round(100 * (1 - gap / 15)));
  }
  function fairnessFlags(white: ReturnType<typeof teamStats>, red: ReturnType<typeof teamStats>) {
    const flags: string[] = [];
    if (white.rated > 0 && red.rated > 0) {
      if (Math.abs(white.fitness - red.fitness) >= 1) flags.push("Noticeable fitness gap between the two teams");
      if (Math.abs(white.attack - red.attack) >= 1) flags.push("One team has significantly stronger attack");
      if (Math.abs(white.defence - red.defence) >= 1) flags.push("One team has significantly stronger defence");
    }
    if (Math.abs(white.positions.keeper - red.positions.keeper) >= 1) flags.push("Keepers aren't evenly split");
    for (const pos of ["defence", "midfield", "attack"] as PlayerPosition[]) {
      if (Math.abs(white.positions[pos] - red.positions[pos]) >= 2) {
        flags.push(`Uneven ${POSITION_LABEL[pos].toLowerCase()} split (${white.positions[pos]} vs ${red.positions[pos]})`);
      }
    }
    return flags;
  }

  const teamFairness = useMemo(() => {
    const white = teamStats(nextGrouped.white.map((b) => b.player_id));
    const red = teamStats(nextGrouped.red.map((b) => b.player_id));
    return { white, red, flags: fairnessFlags(white, red) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextGrouped, ratingByPlayer]);

  // Pre-game balance score is just a prediction - this is the actual test,
  // tracking whichever method produced a game's saved teams against how
  // close the real result turned out. Only games saved since this shipped
  // have a method logged, so older ones are silently skipped rather than
  // showing an "unknown" row.
  const balanceHistory = useMemo(() => {
    const logged = pastGames.filter((g) => g.team_method && g.team_white_score != null && g.team_red_score != null);
    const rows = logged.slice(0, 10).map((g) => ({
      id: g.id,
      venue: g.venue,
      date: g.date,
      method: g.team_method as "generated" | "manual",
      whiteScore: g.team_white_score as number,
      redScore: g.team_red_score as number,
      margin: Math.abs((g.team_white_score as number) - (g.team_red_score as number)),
    }));
    const avgMargin = (method: "generated" | "manual") => {
      const subset = logged.filter((g) => g.team_method === method);
      if (subset.length === 0) return null;
      const total = subset.reduce((sum, g) => sum + Math.abs((g.team_white_score as number) - (g.team_red_score as number)), 0);
      return total / subset.length;
    };
    return { rows, avgGenerated: avgMargin("generated"), avgManual: avgMargin("manual") };
  }, [pastGames]);

  // At-a-glance ratings for whoever's actually confirmed for the next game
  // - previously the only way to see a rating was opening it one player at
  // a time from Manage roles, which made manual team-picking impractical.
  const nextConfirmedRatings = useMemo(() => {
    return nextConfirmed
      .map((b) => {
        const admin = adminRatings.find((r) => r.player_id === b.player_id);
        const self = selfRatings.find((r) => r.player_id === b.player_id);
        const effective = admin ?? self ?? null;
        return {
          id: b.player_id,
          name: b.player.display_name,
          source: admin ? ("admin" as const) : self ? ("self" as const) : ("unrated" as const),
          position: effective?.position ?? null,
          fitness: effective?.fitness ?? null,
          attack: effective?.attack ?? null,
          defence: effective?.defence ?? null,
          goalkeeping: effective?.goalkeeping ?? null,
          overall: effective ? (effective.fitness + effective.attack + effective.defence) / 3 : null,
        };
      })
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  }, [nextConfirmed, adminRatings, selfRatings]);

  // Unrated players default to a neutral 3 rather than 0, so a handful of
  // unrated players don't get treated as "worst on the pitch" and all
  // dumped on one team - they just don't move the needle either way.
  // Keepers are alternated first since you basically always want exactly
  // one specialist per team; everyone else is sorted by ability and
  // greedily assigned to whichever team's running total is currently
  // lower (a simple, explainable balance heuristic, not a black-box
  // optimizer) with a size guard so squads don't end up lopsided.
  function generateBalancedTeams(): { white: string[]; red: string[] } {
    const players = nextConfirmed.map((b) => {
      const r = ratingByPlayer[b.player_id];
      return { id: b.player_id, overall: r ? (r.fitness + r.attack + r.defence) / 3 : 3, position: r?.position ?? null };
    });

    // A small random jitter (sort-only, never affects the real balance
    // totals below) plus a shuffled starting order means re-generating
    // gives a genuinely different, still roughly-balanced split each time
    // instead of the same one on repeat - so an admin who doesn't like the
    // first suggestion can just tap it again for another option.
    const shuffled = [...players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const ranked = shuffled
      .map((p) => ({ ...p, sortKey: p.overall + (Math.random() - 0.5) * 0.6 }))
      .sort((a, b) => b.sortKey - a.sortKey);

    const keepers = ranked.filter((p) => p.position === "keeper");
    const others = ranked.filter((p) => p.position !== "keeper");

    const white: string[] = [];
    const red: string[] = [];
    let whiteTotal = 0;
    let redTotal = 0;

    const keeperStartsWhite = Math.random() < 0.5;
    keepers.forEach((k, i) => {
      const onWhite = keeperStartsWhite ? i % 2 === 0 : i % 2 === 1;
      if (onWhite) { white.push(k.id); whiteTotal += k.overall; }
      else { red.push(k.id); redTotal += k.overall; }
    });

    others.forEach((p) => {
      const sizeDiff = white.length - red.length;
      if (sizeDiff >= 2) { red.push(p.id); redTotal += p.overall; }
      else if (sizeDiff <= -2) { white.push(p.id); whiteTotal += p.overall; }
      else if (whiteTotal === redTotal ? Math.random() < 0.5 : whiteTotal < redTotal) {
        white.push(p.id); whiteTotal += p.overall;
      } else {
        red.push(p.id); redTotal += p.overall;
      }
    });

    return { white, red };
  }

  const overdueBookings = useMemo(() => {
    const rows: { booking: BookingRow; game: GameRow }[] = [];
    pastGames.forEach((g) => {
      g.bookings
        .filter((b) => !b.waiting && b.status !== "confirmed" && !b.pot_exempt_reason)
        .forEach((b) => rows.push({ booking: b, game: g }));
    });
    return rows.sort((a, b) => b.game.date.localeCompare(a.game.date));
  }, [pastGames]);

  // Scores only shows games the admin's actually entered a result for -
  // a finished-but-unscored game sitting there blank would just confuse
  // players ("why is this here with nothing in it?"). Admins still see
  // every finished game needing a score via the Admin tab's own list.
  const scoredPastGames = useMemo(
    () => pastGames.filter((g) => g.team_white_score != null && g.team_red_score != null),
    [pastGames]
  );

  // Flattens every prediction on a scored game into the shape lib/predictions.ts
  // expects - the actual scoring/aggregation logic lives there, kept pure and
  // unit-tested, not reimplemented inline here.
  const scoredPredictionInputs: ScoredPrediction[] = useMemo(() => {
    const byGame = new Map(scoredPastGames.map((g) => [g.id, g]));
    return scorePredictions.flatMap((p) => {
      const game = byGame.get(p.game_id);
      if (!game || game.team_white_score == null || game.team_red_score == null) return [];
      return [
        {
          playerId: p.player_id,
          playerName: p.player?.display_name ?? "Unknown",
          gameId: p.game_id,
          gameDate: game.date,
          predictedWhite: p.predicted_white,
          predictedRed: p.predicted_red,
          actualWhite: game.team_white_score,
          actualRed: game.team_red_score,
        },
      ];
    });
  }, [scorePredictions, scoredPastGames]);

  const predictionSeasonLeaderboard = useMemo(
    () => buildLeaderboard(scoredPredictionInputs.filter((p) => p.gameDate.slice(0, 4) === String(currentSeasonYear))),
    [scoredPredictionInputs, currentSeasonYear]
  );

  // Every month that's ever had a scored prediction, not just the most
  // recently completed one - lets an admin browse back rather than only
  // ever seeing whoever won last month.
  const predictionMonthlyLeaderboards = useMemo(() => buildMonthlyLeaderboards(scoredPredictionInputs), [scoredPredictionInputs]);
  const predictionMonths = useMemo(
    () => Object.keys(predictionMonthlyLeaderboards).sort((a, b) => b.localeCompare(a)),
    [predictionMonthlyLeaderboards]
  );
  const currentMonthKey = nowUk.slice(0, 7);

  const resultsMonths = useMemo(() => {
    const set = new Set<string>();
    scoredPastGames.forEach((g) => set.add(g.date.slice(0, 7)));
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [scoredPastGames]);

  const filteredResults = useMemo(
    () => (resultsMonth === "all" ? scoredPastGames : scoredPastGames.filter((g) => g.date.slice(0, 7) === resultsMonth)),
    [scoredPastGames, resultsMonth]
  );

  const headToHead = useMemo(() => {
    const white = { played: 0, won: 0, drawn: 0, lost: 0, points: 0 };
    const red = { played: 0, won: 0, drawn: 0, lost: 0, points: 0 };
    pastGames.forEach((g) => {
      if (g.team_white_score == null || g.team_red_score == null) return;
      white.played++;
      red.played++;
      if (g.team_white_score > g.team_red_score) {
        white.won++; white.points += 3; red.lost++;
      } else if (g.team_white_score < g.team_red_score) {
        red.won++; red.points += 3; white.lost++;
      } else {
        white.drawn++; red.drawn++; white.points += 1; red.points += 1;
      }
    });
    return { white, red };
  }, [pastGames]);

  // Last 5 scored games, oldest to newest for display - pastGames is
  // already sorted most-recent-first, so take 5 then reverse. Same W/D/L
  // math as headToHead above, just not accumulated.
  const formGuide = useMemo(() => {
    const recent = pastGames.filter((g) => g.team_white_score != null && g.team_red_score != null).slice(0, 5).reverse();
    const resultFor = (g: GameRow, side: Team) => {
      const own = side === "white" ? g.team_white_score! : g.team_red_score!;
      const other = side === "white" ? g.team_red_score! : g.team_white_score!;
      return own > other ? "w" : own < other ? "l" : "d";
    };
    return {
      white: recent.map((g) => resultFor(g, "white")),
      red: recent.map((g) => resultFor(g, "red")),
    };
  }, [pastGames]);

  // For banter - a running win streak, purely derived from the same
  // scored games as headToHead. pastGames is already sorted most-recent
  // first, so this is just "how many games in a row does the same side
  // keep winning, counting from the most recent." A draw (or fewer than 2
  // in a row) means nothing to brag about, so it shows nothing.
  const rivalryStreak = useMemo(() => {
    const scored = pastGames.filter((g) => g.team_white_score != null && g.team_red_score != null);
    if (scored.length === 0) return null;
    const winnerOf = (g: GameRow): Team | null =>
      g.team_white_score! > g.team_red_score! ? "white" : g.team_red_score! > g.team_white_score! ? "red" : null;
    const streakWinner = winnerOf(scored[0]);
    if (!streakWinner) return null;
    let count = 0;
    for (const g of scored) {
      if (winnerOf(g) === streakWinner) count++;
      else break;
    }
    return count >= 2 ? { winner: streakWinner, count } : null;
  }, [pastGames]);

  // Private per-player record - computed from the same past-games data as
  // headToHead above rather than stored anywhere, so it's always in sync
  // and (per the user's request) never has to be back-filled or migrated.
  // Only ever shown to the player themselves in Account.
  const myRecord = useMemo(() => {
    let played = 0, won = 0, drawn = 0, lost = 0;
    pastGames.forEach((g) => {
      if (g.team_white_score == null || g.team_red_score == null) return;
      const myBooking = g.bookings.find((b) => b.player_id === myId && !b.waiting);
      if (!myBooking || !myBooking.team) return;
      played++;
      const diff =
        myBooking.team === "white"
          ? g.team_white_score - g.team_red_score
          : g.team_red_score - g.team_white_score;
      if (diff > 0) won++;
      else if (diff < 0) lost++;
      else drawn++;
    });
    return { played, won, drawn, lost, winPct: played > 0 ? Math.round((won / played) * 100) : null };
  }, [pastGames, myId]);

  // Same "computed, not stored" pattern as myRecord above - upcomingGames
  // is already sorted soonest-first, so this just needs to keep that order
  // while filtering to games this player's actually signed up for.
  const myUpcomingBookings = useMemo(
    () =>
      upcomingGames
        .filter((g) => g.published)
        .flatMap((g) => {
          const booking = g.bookings.find((b) => b.player_id === myId);
          return booking ? [{ game: g, booking }] : [];
        }),
    [upcomingGames, myId]
  );

  const TABS = [
    { k: "fixtures", label: "Fixtures", icon: Icon.cal },
    { k: "feed", label: "Feed", icon: Icon.pulse },
    { k: "lineup", label: "Line-up", icon: Icon.shirt },
    { k: "results", label: "Results", icon: Icon.trophy },
    ...(isAdmin ? [{ k: "admin", label: "Admin", icon: Icon.history } as const] : []),
  ] as const;

  const heading = {
    fixtures: "Upcoming fixtures",
    feed: "Club feed",
    lineup: "Next game line-up",
    results: "Results",
    account: "Your account",
    admin: "Payments & goals",
  }[tab];

  if (loading || !myProfile) {
    return <SplashScreen />;
  }

  return (
    <>
      {toast && <div className={"wcf-toast " + toast.kind}>{toast.text}</div>}
      <header className="wcf-top">
        <button className="wcf-brand" onClick={() => setTab("fixtures")} aria-label="Go to fixtures">
          <span className="wcf-logo">
            <img src="/logo.png" alt="Wirral Community Football crest" />
          </span>
          <div>
            <div className="wcf-wordmark">WIRRAL</div>
            <div className="wcf-wordmark-sub">COMMUNITY FOOTBALL</div>
          </div>
        </button>
        <button
          className={"wcf-role " + (isAdmin ? "admin" : "") + (tab === "account" ? " on" : "")}
          onClick={() => setTab(tab === "account" ? "fixtures" : "account")}
        >
          <span className="dot" />
          <span className="wcf-role-name">{myProfile.display_name}</span>
          {myUnreadMessages.length > 0 && <span className="wcf-role-unread">{myUnreadMessages.length}</span>}
        </button>
      </header>

      {isOffline && <div className="wcf-offline-banner">📡 You&apos;re offline — showing what was last loaded</div>}

      {updateAvailable && (
        <button className="wcf-update-banner" onClick={() => window.location.reload()}>
          🔄 New version available — tap to refresh
        </button>
      )}

      <main className="wcf-main">
        <div className="wcf-heading">
          <div>
            <h2>{heading}</h2>
          </div>
          {tab === "fixtures" && isAdmin && (
            <div className="wcf-heading-actions">
              <button className="wcf-addbtn ghost" onClick={copyFixtureUpdate} title="Copy a WhatsApp fixture update">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>
                Update
              </button>
              <button className="wcf-addbtn" onClick={() => setShowBatchGen(true)} title="Add one or more fixtures">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                Fixtures
              </button>
            </div>
          )}
        </div>

        {tab === "fixtures" && (
          <>
            {showPushNudge && (
              <div className="wcf-nudge-banner">
                <div>
                  <strong>🔔 Turn on notifications</strong>
                  <p>Get kickoff reminders, payment nudges and spot alerts — never miss a game.</p>
                </div>
                <div className="wcf-nudge-actions">
                  <button onClick={async () => { if (await enablePush()) dismissPushNudge(); }}>Enable</button>
                  <button className="wcf-ghost" onClick={dismissPushNudge}>Not now</button>
                </div>
              </div>
            )}
            {showRatingNudge && (
              <div className="wcf-nudge-banner">
                <div>
                  <strong>⭐ Rate yourself</strong>
                  <p>Helps admins put together fairer teams — takes 30 seconds.</p>
                </div>
                <div className="wcf-nudge-actions">
                  <button onClick={() => setTab("account")}>Rate now</button>
                  <button className="wcf-ghost" onClick={dismissRatingNudge}>Not now</button>
                </div>
              </div>
            )}
            {iAmOverdue && (
              <div className="wcf-overdue-banner">
                <strong>Overdue payment</strong> — you still owe for{" "}
                {myOverdueBookings.map((o, i) => (
                  <span key={o.booking.id}>
                    {i > 0 ? ", " : ""}
                    {o.game.venue} ({fmtDate(o.game.date)})
                  </span>
                ))}
                . Speak to an admin to confirm you&apos;ve paid before booking your next game.
              </div>
            )}
            {upcomingGames.length === 0 && <p className="wcf-empty">No games on. {isAdmin ? "Add one above." : "Check back soon."}</p>}

            {(() => {
              const publishedUpcoming = upcomingGames.filter((g) => g.published);
              const selectableCount = publishedUpcoming.filter((g) => !g.bookings.some((b) => b.player_id === myId)).length;
              if (!iAmOverdue && !multiBookMode && selectableCount > 1) {
                return (
                  <button className="wcf-multibook-entry" onClick={() => setMultiBookMode(true)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                    Book multiple games
                  </button>
                );
              }
              return null;
            })()}

            {multiBookMode ? (
              <MultiBookPanel
                games={upcomingGames.filter((g) => g.published)}
                myId={myId}
                selected={multiBookSelected}
                onToggle={(gameId) =>
                  setMultiBookSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(gameId)) next.delete(gameId);
                    else next.add(gameId);
                    return next;
                  })
                }
                onBookAll={() => bookMany([...multiBookSelected])}
                onCancel={() => { setMultiBookMode(false); setMultiBookSelected(new Set()); }}
                booking={multiBooking}
              />
            ) : (
              <>
                {nextFixtureForCountdown && (
                  <>
                    <div className="wcf-eyebrow">Next match</div>
                    <GameCard
                      featured
                      countdownText={fixtureCountdown?.text}
                      game={nextFixtureForCountdown}
                      myId={myId}
                      isAdmin={isAdmin}
                      overdue={iAmOverdue}
                      editing={editingId === nextFixtureForCountdown.id}
                      onBook={() => book(nextFixtureForCountdown.id)}
                      onCancel={(bookingId) => cancel(bookingId)}
                      onMarkPaid={(bookingId) => markPaid(bookingId)}
                      onEdit={() => setEditingId(editingId === nextFixtureForCountdown.id ? null : nextFixtureForCountdown.id)}
                      onSave={(patch) => saveGame(nextFixtureForCountdown.id, patch)}
                      onDelete={() => deleteGame(nextFixtureForCountdown.id)}
                      onOpenPlayerCard={openPlayerCard}
                      onSetStatus={setBookingStatus}
                      weather={weatherFor(nextFixtureForCountdown.date, nextFixtureForCountdown.kickoff)}
                      askConfirm={askConfirm}
                    />
                  </>
                )}

                {upcomingByMonth.map((group) => {
                  const games = group.games.filter((g) => g.id !== nextFixtureForCountdown?.id);
                  if (games.length === 0) return null;
                  return (
                    <div key={group.key}>
                      {upcomingByMonth.length > 1 && <h4 className="wcf-month-head">{group.label}</h4>}
                      {games.map((g) => (
                        <GameCard
                          key={g.id}
                          game={g}
                          myId={myId}
                          isAdmin={isAdmin}
                          overdue={iAmOverdue}
                          editing={editingId === g.id}
                          onBook={() => book(g.id)}
                          onCancel={(bookingId) => cancel(bookingId)}
                          onMarkPaid={(bookingId) => markPaid(bookingId)}
                          onEdit={() => setEditingId(editingId === g.id ? null : g.id)}
                          onSave={(patch) => saveGame(g.id, patch)}
                          onDelete={() => deleteGame(g.id)}
                          onOpenPlayerCard={openPlayerCard}
                          onSetStatus={setBookingStatus}
                          weather={weatherFor(g.date, g.kickoff)}
                          askConfirm={askConfirm}
                        />
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {tab === "admin" && isAdmin && (
          <AdminConsole
            upcoming={upcomingGames}
            previous={pastGames}
            overdue={overdueBookings}
            goalRows={goalRows}
            cs={cs}
            profiles={profiles}
            expandedId={expandedGameId}
            onToggleExpand={(id) => setExpandedGameId(expandedGameId === id ? null : id)}
            onSetStatus={setBookingStatus}
            onRemoveBooking={cancel}
            onDeleteGame={deleteGame}
            onSaveResult={saveResult}
            onAddBooking={addBooking}
            onSetPotExempt={setPotExempt}
            onGoToLineup={() => { setTab("lineup"); setLineupView("fairness"); }}
            messages={adminMessages}
            onSendMessage={sendAdminMessage}
            askConfirm={askConfirm}
          />
        )}

        {tab === "feed" && (() => {
              const reactionRow = (item: FeedItem) => {
                const tally = feedReactionTally[item.key] ?? {};
                return (
                  <div className="wcf-feed-reactions">
                    {FEED_REACTION_EMOJI.map((emoji) => {
                      const count = tally[emoji] ?? 0;
                      const mine = feedReactions.some((r) => r.item_key === item.key && r.emoji === emoji && r.user_id === myId);
                      return (
                        <button
                          key={emoji}
                          className={"wcf-feed-pill" + (mine ? " mine" : "")}
                          onClick={() => toggleReaction(item.key, emoji)}
                        >
                          {emoji}{count > 0 ? ` ${count}` : ""}
                        </button>
                      );
                    })}
                  </div>
                );
              };

              const clipCard = (item: Extract<FeedItem, { kind: "clip" }>, hero: boolean) => {
                const c = item.clip;
                const videoId = c.video_url ? youtubeVideoId(c.video_url) : null;
                const thumb = (
                  <a className={hero ? "wcf-clip-hero-thumb" : "wcf-clip-thumb"} href={c.video_url ?? undefined} target="_blank" rel="noreferrer">
                    {videoId && <img src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" />}
                    <span className={hero ? "wcf-clip-hero-play" : "wcf-clip-play"}>▶</span>
                  </a>
                );
                if (hero) {
                  return (
                    <article key={item.key} className="wcf-clip-hero">
                      {thumb}
                      <div className="wcf-clip-hero-body">
                        <div className="wcf-clip-hero-title">{c.title}</div>
                        <div className="wcf-clip-sub">shared by {c.submitter?.display_name ?? "someone"} · {fmtFeedDate(item.ts)}</div>
                        <div className="wcf-clip-hero-actions">
                          {reactionRow(item)}
                          {(c.submitted_by === myId || isAdmin) && (
                            <button
                              className="wcf-clip-del"
                              onClick={async () => { if (await askConfirm(`Delete "${c.title}"?`, "This removes it from the feed for everyone.", "Delete")) deleteClip(c.id); }}
                              aria-label="Delete clip"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                }
                return (
                  <article key={item.key} className="wcf-clip">
                    {thumb}
                    <div className="wcf-clip-body">
                      <div className="wcf-clip-title">{c.title}</div>
                      <div className="wcf-clip-sub">shared by {c.submitter?.display_name ?? "someone"} · {fmtFeedDate(item.ts)}</div>
                      {reactionRow(item)}
                    </div>
                    {(c.submitted_by === myId || isAdmin) && (
                      <button
                        className="wcf-clip-del"
                        onClick={async () => { if (await askConfirm(`Delete "${c.title}"?`, "This removes it from the feed for everyone.", "Delete")) deleteClip(c.id); }}
                        aria-label="Delete clip"
                      >
                        ×
                      </button>
                    )}
                  </article>
                );
              };

              return (
          <>
            {!showArchived ? (
              <div className="wcf-feed-hero">
                <div className="wcf-feed-hero-eyebrow">Community Feed</div>
                <div className="wcf-feed-hero-title">Goals, clips &amp; shoutouts</div>
                <div className="wcf-feed-hero-tabs">
                  <button className={feedView === "feed" ? "active" : ""} onClick={() => setFeedView("feed")}>Feed</button>
                  <button className={feedView === "clips" ? "active" : ""} onClick={() => setFeedView("clips")}>Clips</button>
                </div>
              </div>
            ) : (
              <div className="wcf-subtabs pill">
                <button className={feedView === "feed" ? "active" : ""} onClick={() => setFeedView("feed")}>Feed</button>
                <button className={feedView === "clips" ? "active" : ""} onClick={() => setFeedView("clips")}>Clips</button>
              </div>
            )}

            {feedView === "clips" && (
              <form className="wcf-clip-form" onSubmit={addClip}>
                <div className="wcf-clip-form-head"><span>Share a clip</span></div>
                <input placeholder="Clip title" value={clipTitle} onChange={(e) => setClipTitle(e.target.value)} />
                <input placeholder="YouTube link (optional)" value={clipUrl} onChange={(e) => setClipUrl(e.target.value)} />
                <button type="submit" disabled={!clipTitle.trim()}>Share clip</button>
              </form>
            )}

            {feedView === "feed" && isAdmin && (
              <button className="wcf-ghost wcf-archive-toggle" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Back to feed" : `Show archived${hiddenFeedKeys.length ? ` (${hiddenFeedKeys.length})` : ""}`}
              </button>
            )}

            {visibleFeedItems.length === 0 && (
              <p className="wcf-empty">
                {feedView === "clips"
                  ? "No clips yet — share the first one!"
                  : showArchived
                  ? "Nothing archived."
                  : "Nothing yet — check back after the first game."}
              </p>
            )}

            {feedView === "clips" && visibleFeedItems.length > 0 && (
              <>
                {clipCard(visibleFeedItems[0] as Extract<FeedItem, { kind: "clip" }>, true)}
                {visibleFeedItems.length > 1 && <div className="wcf-feed-section-label">Earlier</div>}
                {visibleFeedItems.slice(1).map((item) => clipCard(item as Extract<FeedItem, { kind: "clip" }>, false))}
              </>
            )}

            {feedView === "feed" && visibleFeedItems.length > 0 && (() => {
              const groups: { label: string; items: typeof visibleFeedItems }[] = [];
              visibleFeedItems.forEach((item) => {
                const days = Math.floor((Date.now() - item.ts) / 86400000);
                const label = days <= 7 ? "This week" : days <= 14 ? "Last week" : "Earlier";
                let g = groups.find((x) => x.label === label);
                if (!g) { g = { label, items: [] }; groups.push(g); }
                g.items.push(item);
              });
              return groups.map((g) => (
                <div key={g.label}>
                  <div className="wcf-feed-section-label">{g.label}</div>
                  {g.items.map((item) => {
                    const isHidden = hiddenFeedKeys.includes(item.key);
                    if (item.kind !== "derived") return null;
                    return (
                      <article key={item.key} className="wcf-feed-item">
                        <div className={"wcf-feed-icon " + item.tone}>{item.icon}</div>
                        <div className="wcf-feed-body">
                          <div className="wcf-feed-text">{item.text}</div>
                          <div className="wcf-feed-date">{fmtFeedDate(item.ts)}</div>
                          <div className="wcf-feed-item-actions">
                            {reactionRow(item)}
                            {isAdmin && (
                              <button
                                className="wcf-feed-archive-btn"
                                onClick={async () => {
                                  if (isHidden) return unhideFeedItem(item.key);
                                  if (await askConfirm("Archive this from the feed?", "You can restore it later from \"Show archived\".", "Archive", false)) {
                                    hideFeedItem(item.key);
                                  }
                                }}
                              >
                                {isHidden ? "↺ Restore" : "Archive"}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ));
            })()}
          </>
              );
            })()}

        {tab === "lineup" && (
          <>
            <div className="wcf-subtabs">
              <button className={lineupView === "sheet" ? "active" : ""} onClick={() => setLineupView("sheet")}>Team Sheet</button>
              {isAdmin && (
                <button className={lineupView === "fairness" ? "active" : ""} onClick={() => setLineupView("fairness")}>Fairness</button>
              )}
              <button className={lineupView === "predict" ? "active" : ""} onClick={() => setLineupView("predict")}>Predict</button>
            </div>

            {lineupView === "fairness" && isAdmin && (
              <>
                {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}

                {nextGame && nextConfirmedRatings.length > 0 && (
                  <div className="wcf-ratings-table">
                    <h4>Player ratings</h4>
                    <div className="wcf-ratings-rows">
                      {nextConfirmedRatings.map((r) => (
                        <div key={r.id} className="wcf-ratings-row">
                          <div className="wcf-ratings-name">
                            {r.name}
                            {r.position && <span className="wcf-ratings-pos">{POSITION_LABEL[r.position]}</span>}
                          </div>
                          {r.source === "unrated" ? (
                            <span className="wcf-ratings-unrated">Unrated</span>
                          ) : (
                            <div className="wcf-ratings-stats">
                              <span>F {r.fitness}</span>
                              <span>A {r.attack}</span>
                              <span>D {r.defence}</span>
                              <span>GK {r.goalkeeping}</span>
                              <span className={"wcf-ratings-source " + r.source}>{r.source === "admin" ? "Admin" : "Self"}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {nextGame && nextConfirmed.length > 0 && (
                  <>
                    {!suggestedTeams ? (
                      <button className="wcf-generate-teams" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                        🔀 Generate recommended teams
                      </button>
                    ) : (
                      <div className="wcf-suggestion-actions">
                        <button className="wcf-generate-teams" onClick={() => setSuggestedTeams(generateBalancedTeams())}>↻ Regenerate</button>
                        <button className="wcf-ghost" onClick={() => setSuggestedTeams(null)}>Discard</button>
                        <button className="wcf-apply-teams" onClick={applySuggestedTeams}>Apply this split</button>
                      </div>
                    )}
                    {suggestedTeams && (
                      <p className="wcf-suggestion-note">
                        Preview only — nothing's saved until you tap "Apply this split", and you can still hand-tweak anyone in Team Sheet afterward.
                      </p>
                    )}
                  </>
                )}

                {nextGame && !suggestedTeams && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && nextConfirmed.length === 0 && (
                  <p className="wcf-empty">No one&apos;s booked in yet.</p>
                )}
                {nextGame && !suggestedTeams && nextConfirmed.length > 0 && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && (
                  <p className="wcf-empty">No one&apos;s assigned to Whites/Reds yet — generate a suggestion above, or assign manually in Team Sheet.</p>
                )}

                {nextGame && suggestedTeams && (() => {
                  const currentScore = balanceScore(teamFairness.white, teamFairness.red);
                  const suggestedScore = balanceScore(teamStats(suggestedTeams.white), teamStats(suggestedTeams.red));
                  if (currentScore === null && suggestedScore === null) return null;
                  const diff = currentScore !== null && suggestedScore !== null ? suggestedScore - currentScore : null;
                  const badgeClass = (s: number) => (s >= 85 ? "high" : s >= 60 ? "mid" : "low");
                  return (
                    <div className="wcf-balance-compare">
                      <div className="wcf-balance-row">
                        <span>Current Team Sheet</span>
                        {currentScore !== null ? (
                          <span className={"wcf-balance-badge " + badgeClass(currentScore)}>⚖️ {currentScore}%</span>
                        ) : (
                          <span className="wcf-balance-badge none">Not enough ratings</span>
                        )}
                      </div>
                      <div className="wcf-balance-row">
                        <span>Suggested Split</span>
                        {suggestedScore !== null ? (
                          <span className={"wcf-balance-badge " + badgeClass(suggestedScore)}>⚖️ {suggestedScore}%</span>
                        ) : (
                          <span className="wcf-balance-badge none">Not enough ratings</span>
                        )}
                      </div>
                      {diff !== null && Math.abs(diff) >= 3 && (
                        <p className="wcf-balance-verdict">
                          {diff > 0
                            ? `The suggested split is ${diff}% more balanced than the current Team Sheet.`
                            : `Your current Team Sheet is already ${-diff}% more balanced than this suggestion.`}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {nextGame && (() => {
                  const previewWhiteIds = suggestedTeams?.white ?? nextGrouped.white.map((b) => b.player_id);
                  const previewRedIds = suggestedTeams?.red ?? nextGrouped.red.map((b) => b.player_id);
                  if (previewWhiteIds.length === 0 && previewRedIds.length === 0) return null;
                  const white = teamStats(previewWhiteIds);
                  const red = teamStats(previewRedIds);
                  const flags = fairnessFlags(white, red);
                  const namesFor = (ids: string[]) => ids.map((id) => nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?");
                  return (
                    <>
                      <div className="wcf-fairness-teams">
                        {([["white", white, previewWhiteIds, cs.team_white_name, cs.team_white_color], ["red", red, previewRedIds, cs.team_red_name, cs.team_red_color]] as const).map(
                          ([key, stats, ids, name, color]) => (
                            <div key={key} className="wcf-fairness-card">
                              <div className="wcf-fairness-card-head" style={{ color }}>{name}</div>
                              {suggestedTeams && (
                                <div className="wcf-fairness-preview-names">{namesFor(ids).join(", ")}</div>
                              )}
                              {(["fitness", "attack", "defence"] as const).map((metric) => (
                                <div key={metric} className="wcf-fairness-metric">
                                  <div className="wcf-fairness-metric-top">
                                    <span>{metric[0].toUpperCase()}{metric.slice(1)}</span>
                                    <span>{stats.rated ? stats[metric].toFixed(1) : "—"}</span>
                                  </div>
                                  <div className="wcf-fairness-track">
                                    <div className="wcf-fairness-fill" style={{ width: `${(stats[metric] / 5) * 100}%`, background: color ?? undefined }} />
                                  </div>
                                </div>
                              ))}
                              <div className="wcf-fairness-positions">
                                {POSITIONS.map((p) => (
                                  <span key={p} className="wcf-fairness-pos-tag">{POSITION_LABEL[p]} · {stats.positions[p]}</span>
                                ))}
                              </div>
                              <div className="wcf-fairness-rated-note">{stats.rated} of {stats.total} rated</div>
                            </div>
                          )
                        )}
                      </div>

                      {flags.length === 0 ? (
                        <p className="wcf-fairness-ok">✅ No notable imbalances found.</p>
                      ) : (
                        <div className="wcf-fairness-flags">
                          {flags.map((f) => (
                            <div key={f} className="wcf-fairness-flag">⚠️ {f}</div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}

                {balanceHistory.rows.length > 0 && (
                  <div className="wcf-balance-log">
                    <h4>Balance history</h4>
                    <div className="wcf-balance-log-row wcf-balance-log-header">
                      <span>Fixture</span><span>Method</span><span>Result</span><span>Margin</span>
                    </div>
                    {balanceHistory.rows.map((r) => (
                      <div key={r.id} className="wcf-balance-log-row">
                        <div className="wcf-balance-log-venue">{r.venue}<span>{fmtDate(r.date)}</span></div>
                        <span className={"wcf-balance-log-method " + r.method}>{r.method}</span>
                        <span className="wcf-balance-log-result">{r.whiteScore}–{r.redScore}</span>
                        <span className="wcf-balance-log-margin" style={{ color: r.margin <= 2 ? "var(--green)" : r.margin >= 5 ? "var(--red-hi)" : "var(--white)" }}>
                          {r.margin}
                        </span>
                      </div>
                    ))}
                    {(balanceHistory.avgGenerated !== null || balanceHistory.avgManual !== null) && (
                      <div className="wcf-balance-avg-row">
                        <div className="wcf-balance-avg-card">
                          <b style={{ color: "#7CAEF0" }}>{balanceHistory.avgGenerated !== null ? balanceHistory.avgGenerated.toFixed(1) : "—"}</b>
                          <span>Avg margin · Generated</span>
                        </div>
                        <div className="wcf-balance-avg-card">
                          <b style={{ color: "var(--dim)" }}>{balanceHistory.avgManual !== null ? balanceHistory.avgManual.toFixed(1) : "—"}</b>
                          <span>Avg margin · Manual</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {lineupView === "sheet" && (
              <>
            {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}
            {nextGame && (
              <>
                <div className="wcf-lineup-head">
                  <div className="wcf-lineup-eyebrow">Line-up</div>
                  <div className="wcf-lineup-title">{nextGame.venue}</div>
                  <div className="wcf-lineup-sub">{fmtDate(nextGame.date)} · {nextGame.kickoff}</div>
                  {isAdmin && (
                    <div className="wcf-lineup-head-actions">
                      {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                        <button className="wcf-lineup-pill" onClick={copyLineup}>Copy for WhatsApp</button>
                      )}
                      {editingLineup ? (
                        <>
                          <button className="wcf-lineup-pill" onClick={cancelEditingLineup}>Cancel</button>
                          <button className="wcf-lineup-pill primary" onClick={saveLineup}>Save</button>
                        </>
                      ) : (
                        <button className="wcf-lineup-pill" onClick={startEditingLineup}>Edit line-up</button>
                      )}
                    </div>
                  )}
                </div>
                {nextConfirmed.length === 0 && <p className="wcf-empty">No one&apos;s booked in yet.</p>}

                {isAdmin && editingLineup && (() => {
                  return ([["white", editGrouped.white, cs.team_white_name, cs.team_white_color], ["red", editGrouped.red, cs.team_red_name, cs.team_red_color], ["unassigned", editGrouped.unassigned, "Unassigned", null]] as const).map(
                    ([key, group, name, color]) =>
                      group.length > 0 && (
                        <div key={key} className="wcf-lineup-group">
                          <div className="wcf-lineup-group-label">
                            {color && <span className="wcf-lineup-group-dot" style={{ background: color }} />}
                            {name} · {group.length}
                          </div>
                          {group.map((b) => (
                            <div key={b.id} className={"wcf-lineup-row" + (b.player_id === myId ? " me-edit" : "")}>
                              <span className="wcf-lineup-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                              <div className="wcf-lineup-picks">
                                <button
                                  style={teamDraft[b.id] === "white" ? { background: cs.team_white_color, color: readableTextColor(cs.team_white_color), borderColor: cs.team_white_color } : undefined}
                                  className="wcf-lineup-pick"
                                  onClick={() => setTeamDraft((d) => ({ ...d, [b.id]: d[b.id] === "white" ? null : "white" }))}
                                >
                                  {cs.team_white_name}
                                </button>
                                <button
                                  style={teamDraft[b.id] === "red" ? { background: cs.team_red_color, color: readableTextColor(cs.team_red_color), borderColor: cs.team_red_color } : undefined}
                                  className="wcf-lineup-pick"
                                  onClick={() => setTeamDraft((d) => ({ ...d, [b.id]: d[b.id] === "red" ? null : "red" }))}
                                >
                                  {cs.team_red_name}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                  );
                })()}

                {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                  <div className="wcf-lineup-strip-row">
                    {([["red", cs.team_red_name, cs.team_red_color, nextGrouped.red.length], ["white", cs.team_white_name, cs.team_white_color, nextGrouped.white.length]] as const).map(([key, name, color, count]) => (
                      <div key={key} className="wcf-lineup-strip" style={{ background: `linear-gradient(135deg, ${color}2e, rgba(13,13,26,.6))`, borderColor: `${color}57` }}>
                        <span className="wcf-lineup-strip-dot" style={{ background: color }} />
                        <span className="wcf-lineup-strip-name">{name}</span>
                        <span className="wcf-lineup-strip-count">{count}</span>
                      </div>
                    ))}
                  </div>
                )}

                {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                  <div className="wcf-lineup-views">
                    <button className={"wcf-lineup-view-btn " + (lineupDisplayView === "pitch" ? "on" : "")} onClick={() => setLineupDisplayView("pitch")}>Pitch</button>
                    <button className={"wcf-lineup-view-btn " + (lineupDisplayView === "list" ? "on" : "")} onClick={() => setLineupDisplayView("list")}>List</button>
                  </div>
                )}

                {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (() => {
                  const allTokens = pitchTokens;
                  const selected = allTokens.find((t) => t.booking.player_id === selectedLineupPlayerId);
                  const selectedStats = selected ? playerStats.find((p) => p.id === selected.booking.player_id) : null;
                  const selectColor = (isRed: boolean) => (isRed ? cs.team_red_color : cs.team_white_color);

                  const renderToken = (t: (typeof allTokens)[number]) => {
                    const me = t.booking.player_id === myId;
                    const color = selectColor(t.isRed);
                    const draggable = isAdmin && editingPositions;
                    return (
                      <button
                        key={t.booking.id}
                        className={"wcf-lineup-token" + (draggable ? " draggable" : "") + (draggingPlayerId === t.booking.player_id ? " dragging" : "")}
                        style={{ left: `${t.x}%`, top: `${t.y}%` }}
                        onClick={() => { if (!draggable) setSelectedLineupPlayerId((v) => (v === t.booking.player_id ? null : t.booking.player_id)); }}
                        onPointerDown={
                          draggable
                            ? (e) => {
                                e.preventDefault();
                                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                                setDraggingPlayerId(t.booking.player_id);
                                movePlayerTo(t.booking.player_id, e.clientX, e.clientY);
                              }
                            : undefined
                        }
                        onPointerMove={
                          draggable
                            ? (e) => { if (draggingPlayerId === t.booking.player_id) movePlayerTo(t.booking.player_id, e.clientX, e.clientY); }
                            : undefined
                        }
                        onPointerUp={draggable ? () => setDraggingPlayerId(null) : undefined}
                      >
                        <Avatar
                          name={t.booking.player.display_name}
                          avatarUrl={t.booking.player.avatar_url}
                          className="wcf-lineup-token-chip"
                          background={teamGradient(color)}
                          style={{ color: readableTextColor(color), boxShadow: me ? "0 0 0 2px var(--blue), 0 6px 14px -6px rgba(0,0,0,.85)" : undefined }}
                        />
                        <span className="wcf-lineup-token-label">{t.booking.player.display_name.split(" ")[0]}</span>
                      </button>
                    );
                  };

                  return (
                    <>
                      {lineupDisplayView === "pitch" && isAdmin && (
                        <div className="wcf-lineup-position-controls">
                          {editingPositions ? (
                            <>
                              <button className="wcf-ghost" onClick={cancelEditingPositions}>Cancel</button>
                              <button className="wcf-save-red" style={{ flex: 1 }} onClick={savePositions}>Lock in positions</button>
                            </>
                          ) : (
                            <>
                              <button className="wcf-ghost" onClick={startEditingPositions}>✋ Drag to arrange</button>
                              {nextGame?.lineup_positions && (
                                <button className="wcf-ghost danger" onClick={resetPositions}>Reset to auto</button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {lineupDisplayView === "pitch" && (
                        <div className="wcf-lineup-pitch-card" ref={pitchCardRef}>
                          <svg viewBox="0 0 200 300" preserveAspectRatio="none" className="wcf-lineup-pitch-lines">
                            <rect x="10" y="8" width="180" height="284" rx="2" />
                            <line x1="10" y1="150" x2="190" y2="150" />
                            <circle cx="100" cy="150" r="30" />
                            <circle cx="100" cy="150" r="1.6" fill="#e2e8f0" stroke="none" />
                            <rect x="55" y="8" width="90" height="34" rx="1" />
                            <rect x="78" y="8" width="44" height="14" rx="1" />
                            <rect x="55" y="258" width="90" height="34" rx="1" />
                            <rect x="78" y="278" width="44" height="14" rx="1" />
                          </svg>
                          <div className="wcf-lineup-pitch-tokens">
                            {allTokens.map(renderToken)}
                          </div>
                        </div>
                      )}
                      {lineupDisplayView === "pitch" && !editingPositions && (
                        <p className="wcf-lineup-pitch-note">
                          {cs.team_red_name} attack down, {cs.team_white_name} attack up. Tap a shirt for that player&apos;s season stats.
                        </p>
                      )}
                      {lineupDisplayView === "pitch" && editingPositions && (
                        <p className="wcf-lineup-pitch-note">
                          Drag any player to reposition them, then Lock in positions to save it for everyone.
                        </p>
                      )}

                      {lineupDisplayView === "list" && (
                        <div className="wcf-lineup-list-wrap">
                          {([["red", nextGrouped.red, cs.team_red_name, cs.team_red_color] as const, ["white", nextGrouped.white, cs.team_white_name, cs.team_white_color] as const]).map(([key, group, name, color]) => (
                            <div key={key} className="wcf-lineup-list-card">
                              <div className="wcf-lineup-list-head" style={{ color }}>{name}</div>
                              {group.map((b) => (
                                <button
                                  key={b.id}
                                  className="wcf-lineup-list-row"
                                  onClick={() => setSelectedLineupPlayerId((v) => (v === b.player_id ? null : b.player_id))}
                                >
                                  <Avatar
                                    name={b.player.display_name}
                                    avatarUrl={b.player.avatar_url}
                                    className="wcf-lineup-list-chip"
                                    background={teamGradient(color)}
                                    style={{ color: readableTextColor(color) }}
                                  />
                                  <span className="wcf-lineup-list-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      {selected && (
                        <div className="wcf-lineup-selected">
                          <Avatar
                            name={selected.booking.player.display_name}
                            avatarUrl={selected.booking.player.avatar_url}
                            className="wcf-lineup-selected-chip"
                            background={teamGradient(selectColor(selected.isRed))}
                            style={{ color: readableTextColor(selectColor(selected.isRed)) }}
                          />
                          <div className="wcf-lineup-selected-body">
                            <div
                              className="wcf-lineup-selected-name clickable"
                              onClick={() =>
                                openPlayerCard(selected.booking.player_id, {
                                  name: selected.isRed ? cs.team_red_name : cs.team_white_name,
                                  color: selected.isRed ? cs.team_red_color : cs.team_white_color,
                                })
                              }
                            >
                              {selected.booking.player.display_name}{selected.booking.player_id === myId ? " (you)" : ""}
                            </div>
                            <div className="wcf-lineup-selected-role">
                              {selected.role} · {selected.isRed ? cs.team_red_name : cs.team_white_name}
                            </div>
                          </div>
                          <div className="wcf-lineup-selected-stat">
                            <div>{selectedStats?.apps ?? 0}</div>
                            <span>apps</span>
                          </div>
                          <div className="wcf-lineup-selected-stat">
                            <div>{selectedStats?.goals ?? 0}</div>
                            <span>goals</span>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

                {!editingLineup && nextGrouped.unassigned.length > 0 && (
                  <div className="wcf-lineup-group">
                    <div className="wcf-lineup-group-label">Unassigned · {nextGrouped.unassigned.length}</div>
                    {nextGrouped.unassigned.map((b) => (
                      <div key={b.id} className={"wcf-lineup-row" + (b.player_id === myId ? " me" : "")}>
                        <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-lineup-avatar" />
                        <button className="wcf-lineup-name wcf-name-link" onClick={() => openPlayerCard(b.player_id)}>
                          {b.player.display_name}{b.player_id === myId ? " (you)" : ""}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!editingLineup && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                  <PredictPanel
                    key={nextGame.id}
                    gameId={nextGame.id}
                    whiteLabel={cs.team_white_name}
                    redLabel={cs.team_red_name}
                    isBooked={nextConfirmed.some((b) => b.player_id === myId)}
                    myPrediction={scorePredictions.find((p) => p.game_id === nextGame.id && p.player_id === myId) ?? null}
                    onSave={savePrediction}
                  />
                )}
                {!editingLineup && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && nextConfirmed.length > 0 && (
                  <div className="wcf-predict">
                    <div className="wcf-predict-gate">
                      <div className="wcf-predict-gate-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
                      </div>
                      <div className="wcf-predict-gate-text">
                        <b>Predictions open once teams are posted</b> for this game — check back here nearer kickoff.
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
              </>
            )}

            {lineupView === "predict" && (() => {
              const isSeason = predictView === "season";
              const board = isSeason ? predictionSeasonLeaderboard : predictionMonthlyLeaderboards[predictView] ?? [];
              const isCurrentMonth = !isSeason && predictView === currentMonthKey;
              // The free-game prize is for a *completed* month, not a
              // running mid-month lead that could still change - same
              // "reveal once it's over" cadence as Player of the Month.
              const leaders = !isSeason && !isCurrentMonth ? topScorers(board) : [];
              const monthLabel = !isSeason
                ? new Date(predictView + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })
                : "";
              const scopeInputs = isSeason
                ? scoredPredictionInputs.filter((p) => p.gameDate.slice(0, 4) === String(currentSeasonYear))
                : scoredPredictionInputs.filter((p) => p.gameDate.slice(0, 7) === predictView);
              const leader = board[0];

              return (
                <>
                  <select className="wcf-month-filter" value={predictView} onChange={(e) => { setPredictView(e.target.value); setPredictOpenId(null); }}>
                    <option value="season">Overall (this season)</option>
                    {predictionMonths.map((m) => (
                      <option key={m} value={m}>
                        {new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
                      </option>
                    ))}
                  </select>

                  {leader && (
                    <div className="wcf-pl-leader-card">
                      <div className="wcf-pl-leader-eyebrow">Leader · {isSeason ? "This season" : monthLabel}</div>
                      <div className="wcf-pl-leader-row">
                        <Avatar
                          name={leader.playerName}
                          avatarUrl={avatarByPlayerId.get(leader.playerId)}
                          className="wcf-pl-leader-avatar"
                          background={avatarFor(leader.playerName).gradient}
                        />
                        <div className="wcf-pl-leader-body">
                          <div className="wcf-pl-leader-name">{leader.playerName}</div>
                          <div className="wcf-pl-leader-sub">
                            {leader.exactCount} exact · {leader.points - leader.exactCount * 3} results · {leader.gamesGuessed} played
                          </div>
                        </div>
                        <div className="wcf-pl-leader-pts">
                          <div>{leader.points}</div>
                          <span>points</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {isSeason && <div className="wcf-lb-prize">🏆 Top 3 at the end of the season win prizes from the pot.</div>}
                  {!isSeason && isCurrentMonth && (
                    <div className="wcf-lb-prize">🏃 {monthLabel} is still in progress — standings so far, not final.</div>
                  )}
                  {!isSeason && !isCurrentMonth && leaders.length > 0 && (
                    <div className="wcf-shoutout wcf-potm">
                      🏆 {monthLabel} winner — <strong>{leaders.map((l) => l.playerName).join(" & ")}</strong>: free game this month!
                    </div>
                  )}
                  <div className="wcf-lb-key">3 pts exact score · 1 pt correct result · booked players only</div>

                  {board.length > 0 && (
                    <div className="wcf-pl-legend">
                      <span><span className="wcf-pl-dot" style={{ background: "var(--green)" }} />exact</span>
                      <span><span className="wcf-pl-dot" style={{ background: "var(--blue)" }} />result</span>
                      <span><span className="wcf-pl-dot" style={{ background: "rgba(148,163,184,.28)" }} />miss</span>
                      <span className="wcf-pl-legend-last">last 5</span>
                    </div>
                  )}

                  {board.length === 0 && <p className="wcf-empty">No predictions scored yet {isSeason ? "this season" : "this month"}.</p>}
                  {board.length > 0 && (
                    <div className="wcf-lb">
                      {board.map((row, i) => {
                        const inPrizes = isSeason && i < 3 && row.points > 0;
                        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
                        const results = row.points - row.exactCount * 3;
                        const a = avatarFor(row.playerName);
                        const form = scopeInputs
                          .filter((p) => p.playerId === row.playerId)
                          .sort((x, y) => x.gameDate.localeCompare(y.gameDate))
                          .slice(-5)
                          .map((p) => predictionPoints(p.predictedWhite, p.predictedRed, p.actualWhite, p.actualRed));
                        const open = predictOpenId === row.playerId;
                        return (
                          <div key={row.playerId}>
                            <div
                              className={"wcf-pl-row" + (i === 0 ? " lead" : "") + (row.playerId === myId ? " me" : "")}
                              onClick={() => setPredictOpenId((v) => (v === row.playerId ? null : row.playerId))}
                            >
                              <span className={"wcf-lb-rank" + (inPrizes ? " top" : "")}>{inPrizes ? medal : i + 1}</span>
                              <Avatar name={row.playerName} avatarUrl={avatarByPlayerId.get(row.playerId)} className="wcf-pl-avatar" background={a.gradient} />
                              <div className="wcf-pl-body">
                                <div className="wcf-pl-name">{row.playerName}{row.playerId === myId ? " (you)" : ""}</div>
                                <div className="wcf-pl-sub-row">
                                  <span>{row.exactCount} exact score{row.exactCount === 1 ? "" : "s"}</span>
                                  {form.length > 0 && (
                                    <span className="wcf-pl-form">
                                      {form.map((pts, fi) => (
                                        <span
                                          key={fi}
                                          className="wcf-pl-dot"
                                          style={{ background: pts === 3 ? "var(--green)" : pts === 1 ? "var(--blue)" : "rgba(148,163,184,.28)" }}
                                        />
                                      ))}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className="wcf-lb-pts">{row.points}</span>
                            </div>
                            {open && (
                              <div className="wcf-pl-detail">
                                <span>Exact <b style={{ color: "var(--green)" }}>{row.exactCount}</b></span>
                                <span>Results <b style={{ color: "var(--blue)" }}>{results}</b></span>
                                <span>Played <b>{row.gamesGuessed}</b></span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {board.length > 0 && (
                    <div className="wcf-pl-footer">
                      <span>Predictions lock at kick-off.</span>
                      <button onClick={() => setLineupView("sheet")}>Predict next match</button>
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}

        {tab === "results" && (
          <>
            <div className="wcf-subtabs">
              <button className={resultsView === "season" ? "active" : ""} onClick={() => setResultsView("season")}>Season</button>
              <button className={resultsView === "table" ? "active" : ""} onClick={() => setResultsView("table")}>Stats</button>
              <button className={resultsView === "fixtures" ? "active" : ""} onClick={() => setResultsView("fixtures")}>Scores</button>
              <button className={resultsView === "pot" ? "active" : ""} onClick={() => setResultsView("pot")}>Pot</button>
            </div>

            {resultsView === "season" && (() => {
              const gamesThisSeason = pastGames.filter((g) => g.date.slice(0, 4) === String(currentSeasonYear)).length;
              return (
              <>
                <div className="wcf-season-hero">
                  <div className="wcf-season-hero-eyebrow">Season {currentSeasonYear - SEASON_EPOCH_YEAR + 1}</div>
                  <div className="wcf-season-hero-title">{currentSeasonYear}</div>
                  <div className="wcf-season-hero-sub">{gamesThisSeason} game{gamesThisSeason === 1 ? "" : "s"} played so far</div>
                </div>
                {playerOfMonth && (
                  <div className="wcf-shoutout wcf-potm">
                    🏅 Player of the Month — {playerOfMonth.monthLabel}: <strong>{playerOfMonth.names.join(" & ")}</strong>
                  </div>
                )}
                {awards.map((a) => (
                  <div key={a.id} className="wcf-shoutout">
                    {a.title} — <strong>{a.value}</strong>
                    {a.note ? ` · ${a.note}` : ""}
                    {a.image_url && <img className="wcf-award-media" src={a.image_url} alt={a.title} loading="lazy" />}
                    {a.video_url && <video className="wcf-award-media" src={a.video_url} controls preload="metadata" />}
                  </div>
                ))}

                {rivalryStreak && (
                  <div
                    className="wcf-streak"
                    style={{ borderColor: rivalryStreak.winner === "white" ? cs.team_white_color : cs.team_red_color }}
                  >
                    🔥 <strong>{rivalryStreak.winner === "white" ? cs.team_white_name : cs.team_red_name}</strong> have won{" "}
                    {rivalryStreak.count} in a row
                  </div>
                )}

                {(headToHead.white.played > 0 || headToHead.red.played > 0) && (
                  <div className="wcf-h2h">
                    <div className="wcf-h2h-title">{cs.team_white_name} v {cs.team_red_name}</div>
                    <div className="wcf-h2h-row wcf-h2h-header">
                      <span>Team</span><span>P</span><span>W</span><span>D</span><span>L</span><span>Pts</span>
                    </div>
                    {([["white", headToHead.white, cs.team_white_name, cs.team_white_color], ["red", headToHead.red, cs.team_red_name, cs.team_red_color]] as const)
                      .slice()
                      .sort((a, b) => b[1].points - a[1].points)
                      .map(([key, row, name, color]) => (
                        <div key={key} className="wcf-h2h-row">
                          <span className="wcf-h2h-team"><span className="wcf-h2h-dot" style={{ background: color }} />{name}</span>
                          <span>{row.played}</span><span>{row.won}</span><span>{row.drawn}</span><span>{row.lost}</span>
                          <span className="wcf-h2h-pts">{row.points}</span>
                        </div>
                      )
                    )}

                    {formGuide.white.length > 0 && (
                      <div className="wcf-form-block">
                        <div className="wcf-form-label">Form — last {formGuide.white.length}</div>
                        {([["white", formGuide.white, cs.team_white_name, cs.team_white_color], ["red", formGuide.red, cs.team_red_name, cs.team_red_color]] as const).map(
                          ([key, results, name, color]) => (
                            <div key={key} className="wcf-form-row">
                              <span className="wcf-form-team"><span className="wcf-h2h-dot" style={{ background: color }} />{name}</span>
                              <div className="wcf-form-dots">
                                {results.map((r, i) => (
                                  <span
                                    key={i}
                                    className={"wcf-form-dot " + r + (i === results.length - 1 ? " latest" : "")}
                                    style={i === results.length - 1 ? { color: r === "w" ? "var(--green)" : r === "l" ? "var(--red-hi)" : "var(--dim)" } : undefined}
                                  >
                                    {r.toUpperCase()}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
              );
            })()}

            {resultsView === "table" && (() => {
              // Tied on goals favours fewer games, not more - the better
              // goals-per-game rate should rank above someone who just
              // played more often to reach the same total.
              const sorted = [...playerStats].sort((a, b) =>
                statsSort === "goals" ? b.goals - a.goals || a.apps - b.apps : b.apps - a.apps || b.goals - a.goals
              );
              const byGoals = [...playerStats].sort((a, b) => b.goals - a.goals || a.apps - b.apps).slice(0, 3);
              const podiumOrder = [byGoals[1], byGoals[0], byGoals[2]];
              const podiumRing = ["#eab308", "#cbd5e1", "#e63946"];
              const myIdx = sorted.findIndex((r) => r.id === myId);
              const me = sorted[myIdx];

              return (
                <div className="wcf-board">
                  <div className="wcf-lb-eyebrow">Leaderboard</div>
                  <h3 className="wcf-lb-title">Player stats</h3>

                  {byGoals.length > 0 && (
                    <div className="wcf-lb-podium-card">
                      <div className="wcf-lb-podium-glow" />
                      <div className="wcf-lb-podium-label">
                        <span className="wcf-lb-podium-rule" /> TOP SCORERS <span className="wcf-lb-podium-rule" />
                      </div>
                      <div className="wcf-lb-podium-row">
                        {podiumOrder.map((p, i) => {
                          if (!p) return <div key={i} />;
                          const rank = byGoals.indexOf(p) + 1;
                          const lead = rank === 1;
                          const ring = podiumRing[rank - 1];
                          const a = avatarFor(p.name);
                          return (
                            <div key={p.id} className="wcf-lb-podium-slot">
                              {lead && <div className="wcf-lb-crown">♔</div>}
                              <div
                                className={"wcf-lb-podium-avatar " + (lead ? "lead" : "")}
                                style={{ borderColor: ring, width: lead ? 96 : 74, height: lead ? 96 : 74 }}
                              >
                                {avatarByPlayerId.get(p.id) ? (
                                  <img className="wcf-lb-podium-photo" src={avatarByPlayerId.get(p.id) ?? undefined} alt={p.name} />
                                ) : (
                                  <span style={{ fontSize: lead ? 26 : 20 }}>{a.initial}</span>
                                )}
                                <span className="wcf-lb-podium-badge" style={{ background: ring }}>{rank}</span>
                              </div>
                              <div className="wcf-lb-podium-name">{p.name.split(" ")[0]}</div>
                              <div className="wcf-lb-podium-goals" style={{ fontSize: lead ? 26 : 22 }}>
                                {p.goals} <span>G</span>
                              </div>
                              <div className="wcf-lb-podium-apps">{p.apps} apps</div>
                              <div
                                className="wcf-lb-podium-plinth"
                                style={{ height: lead ? 34 : rank === 2 ? 22 : 15, borderColor: ring, background: `linear-gradient(0deg,${ring}3d,${ring}0f)` }}
                              />
                            </div>
                          );
                        })}
                      </div>

                      {me && (
                        <div className="wcf-lb-me-card">
                          <div className="wcf-lb-me-rank">{myIdx + 1}</div>
                          <div className="wcf-lb-me-body">
                            <div className="wcf-lb-me-label">Your rank</div>
                            <div className="wcf-lb-me-name">{me.name}</div>
                          </div>
                          <div className="wcf-lb-me-stat"><div>{me.apps}</div><span>apps</span></div>
                          <div className="wcf-lb-me-stat"><div>{me.goals}</div><span>goals</span></div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="wcf-lb-list-card">
                    <select
                      className="wcf-month-filter"
                      value={activeStatsYear}
                      onChange={(e) => { setStatsSeasonYear(Number(e.target.value)); setStatsOpenId(null); }}
                    >
                      {seasonYears.map((y) => (
                        <option key={y} value={y}>
                          Season {y - SEASON_EPOCH_YEAR + 1} ({y}){y === currentSeasonYear ? " — current" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="wcf-board-note">
                      Confirmed spots across upcoming fixtures, plus goals logged by admins. Sorted by {statsSort === "goals" ? "goals" : "appearances"}.
                    </p>

                    <div className="wcf-lb-sorts">
                      {(["apps", "goals"] as const).map((s) => (
                        <button
                          key={s}
                          className={"wcf-lb-sort-btn " + (statsSort === s ? "on" : "")}
                          onClick={() => { setStatsSort(s); setStatsOpenId(null); }}
                        >
                          {s === "apps" ? "Appearances" : "Goals"}
                        </button>
                      ))}
                    </div>

                    <div className="wcf-board-row wcf-board-header">
                      <span className="wcf-rank" />
                      <span style={{ width: 24 }} />
                      <span className="wcf-board-name">Player</span>
                      <span className="wcf-board-count">Apps</span>
                      <span className="wcf-board-count">Goals</span>
                    </div>
                    {sorted.map((row, i) => {
                      const isLead = i === 0;
                      const isMe = row.id === myId;
                      const a = avatarFor(row.name);
                      const open = statsOpenId === row.id;
                      return (
                        <div key={row.id}>
                          <div
                            className={"wcf-board-row " + (isLead ? "lead " : "") + (isMe ? "me" : "")}
                            onClick={() => setStatsOpenId((v) => (v === row.id ? null : row.id))}
                          >
                            <span className="wcf-rank">{isLead ? <span className="wcf-rank-star">{Icon.star}</span> : i + 1}</span>
                            <Avatar name={row.name} avatarUrl={avatarByPlayerId.get(row.id)} className="wcf-lb-row-avatar" background={a.gradient} />
                            <button
                              className="wcf-board-name wcf-name-link"
                              onClick={(e) => { e.stopPropagation(); openPlayerCard(row.id); }}
                            >
                              {row.name}
                            </button>
                            {isMe && <span className="wcf-lb-you-badge">you</span>}
                            {row.apps >= 5 && <span className="wcf-apps-badge">🎖️ {Math.floor(row.apps / 5) * 5}</span>}
                            <span className="wcf-board-count">{row.apps}</span>
                            <span className="wcf-board-count">{row.goals || "—"}</span>
                          </div>
                          {open && (
                            <div className="wcf-lb-row-detail">
                              <span>Goals / app <b>{(row.goals / row.apps).toFixed(2)}</b></span>
                              <span>Last played <b>{row.lastPlayed ? fmtDate(row.lastPlayed) : "—"}</b></span>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div className="wcf-lb-footer">
                      <span>Milestone badges are awarded every 5 appearances.</span>
                      <button onClick={() => setTab("fixtures")}>View fixtures</button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {resultsView === "fixtures" && (
              <>
                <select className="wcf-month-filter" value={resultsMonth} onChange={(e) => setResultsMonth(e.target.value)}>
                  <option value="all">All results</option>
                  {resultsMonths.map((m) => (
                    <option key={m} value={m}>
                      {new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
                    </option>
                  ))}
                </select>

                {filteredResults.length === 0 && <p className="wcf-empty">No results yet.</p>}
                {filteredResults.map((g, resultIndex) => {
                  const scorers = goalRows.filter((r) => r.game_id === g.id && r.goals > 0).sort((a, b) => b.goals - a.goals);
                  const teamOf = (playerId: string) => g.bookings.find((b) => b.player_id === playerId)?.team;
                  const whiteScorers = scorers.filter((s) => teamOf(s.player_id) === "white");
                  const redScorers = scorers.filter((s) => teamOf(s.player_id) === "red");
                  // Not split by team - which side an own goal benefited isn't
                  // reliably knowable if the scorer switched teams mid-match.
                  const ownGoalScorers = goalRows.filter((r) => r.game_id === g.id && r.own_goals > 0);
                  // Who actually played, not who's been payment-confirmed -
                  // those often lag behind by days, and voting closes hours
                  // after kickoff.
                  const candidates = g.bookings.filter((b) => !b.waiting);
                  // Can't vote for yourself, but you can still win it - so
                  // this only trims the vote-button list, never `candidates`
                  // itself (that still feeds the tally/winner below).
                  const voteCandidates = candidates.filter((c) => c.player_id !== myId);
                  const votingOpen = motmVotingOpen(g);
                  const tally = motmTallyByGame[g.id] ?? {};
                  const totalVotes = Object.values(tally).reduce((sum, n) => sum + n, 0);
                  const myVote = myMotmVoteByGame[g.id];
                  const ranked = candidates
                    .map((c) => ({ candidate: c, votes: tally[c.player_id] ?? 0 }))
                    .sort((a, b) => b.votes - a.votes);
                  const topVotes = ranked[0]?.votes ?? 0;
                  const expanded = expandedResultId === g.id;
                  // Only ever read once voting's closed (the vote buttons
                  // above never surface this) - keeps voting itself
                  // anonymous while letting the community see who backed
                  // who once the result's out, per direct feedback.
                  const votersFor = (candidateId: string) =>
                    motmVotes
                      .filter((v) => v.game_id === g.id && v.candidate_id === candidateId)
                      .map((v) => profiles.find((p) => p.id === v.voter_id))
                      .filter((p): p is Profile => !!p);
                  return (
                    <article key={g.id} className={"wcf-result" + (resultIndex === 0 ? " featured" : "")}>
                      <button className="wcf-result-toggle" onClick={() => setExpandedResultId(expanded ? null : g.id)}>
                        <div className="wcf-result-head">
                          <div>
                            <div className="wcf-venue">{g.venue}</div>
                            <div className="wcf-pitch">{fmtDate(g.date)}</div>
                          </div>
                          <div className="wcf-result-score">
                            <span style={{ color: cs.team_white_color }}>{g.team_white_score}</span>
                            <span className="wcf-result-dash">–</span>
                            <span style={{ color: cs.team_red_color }}>{g.team_red_score}</span>
                          </div>
                        </div>
                        <div className="wcf-result-chevron">{expanded ? "▲ Hide details" : "▼ Tap for scorers & MOTM"}</div>
                      </button>

                      {expanded && (
                        <div className="wcf-result-detail">
                          {scorers.length > 0 && (
                            <>
                              <div className="wcf-result-section-label">⚽ Goals</div>
                              <div className="wcf-result-goals">
                                <div className="wcf-result-goals-col">
                                  {whiteScorers.map((s) => (
                                    <div key={s.id} className="wcf-result-goal-row">
                                      <button className="wcf-name-link" onClick={() => openPlayerCard(s.player_id)}>{s.player.display_name}</button>
                                      <b>{s.goals}</b>
                                    </div>
                                  ))}
                                </div>
                                <div className="wcf-result-goals-col">
                                  {redScorers.map((s) => (
                                    <div key={s.id} className="wcf-result-goal-row">
                                      <button className="wcf-name-link" onClick={() => openPlayerCard(s.player_id)}>{s.player.display_name}</button>
                                      <b>{s.goals}</b>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </>
                          )}

                          {ownGoalScorers.length > 0 && (
                            <div className="wcf-result-og">
                              Own goal{ownGoalScorers.length > 1 || ownGoalScorers[0].own_goals > 1 ? "s" : ""}:{" "}
                              {ownGoalScorers.map((s, i) => (
                                <span key={s.id}>
                                  {i > 0 && ", "}
                                  <button className="wcf-name-link" onClick={() => openPlayerCard(s.player_id)}>{s.player.display_name}</button>
                                  {s.own_goals > 1 && ` (${s.own_goals})`}
                                </span>
                              ))}
                            </div>
                          )}

                          {voteCandidates.length > 0 && votingOpen && (
                            <div className="wcf-motm">
                              <div className="wcf-motm-label">Vote Man of the Match · results hidden until voting closes</div>
                              <div className="wcf-motm-candidates">
                                {voteCandidates.map((c) => (
                                  <button
                                    key={c.id}
                                    className={"wcf-motm-vote" + (myVote === c.player_id ? " voted" : "")}
                                    onClick={() => castMotmVote(g.id, c.player_id, c.player.display_name)}
                                  >
                                    {c.player.display_name}{myVote === c.player_id ? " ✓" : ""}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {!votingOpen && totalVotes > 0 && (
                            <div className="wcf-motm wcf-motm-closed">
                              <div className="wcf-motm-winner">
                                🏆 Man of the Match — <strong>{ranked[0].candidate.player.display_name}</strong>
                              </div>
                              {ranked.filter((r) => r.votes > 0).map((r) => {
                                const voters = votersFor(r.candidate.player_id);
                                return (
                                  <div key={r.candidate.id} className="wcf-motm-bar-row">
                                    <div className="wcf-motm-bar-top">
                                      <span className={r.votes === topVotes ? "winner" : ""}>{r.candidate.player.display_name}</span>
                                      <span className="wcf-motm-count">{r.votes}</span>
                                    </div>
                                    <div className="wcf-motm-bar-track">
                                      <div
                                        className={"wcf-motm-bar-fill" + (r.votes === topVotes ? " winner" : "")}
                                        style={{ width: `${Math.max(6, (r.votes / topVotes) * 100)}%` }}
                                      />
                                    </div>
                                    <button
                                      className="wcf-motm-voters-trigger"
                                      onClick={() =>
                                        setMotmVotersFor({ gameId: g.id, candidateId: r.candidate.player_id, candidateName: r.candidate.player.display_name })
                                      }
                                    >
                                      <span className="wcf-avatars">
                                        {voters.slice(0, 4).map((v) => (
                                          <Avatar key={v.id} name={v.display_name} avatarUrl={v.avatar_url} className="wcf-avatar-chip" background={avatarFor(v.display_name).gradient} />
                                        ))}
                                        {voters.length > 4 && <span className="wcf-avatar-chip more">+{voters.length - 4}</span>}
                                      </span>
                                      <span className="wcf-motm-voters-label">See who voted</span>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {(() => {
                            const gamePredictions = scoredPredictionInputs.filter((p) => p.gameId === g.id);
                            if (gamePredictions.length === 0) return null;
                            const myGamePrediction = gamePredictions.find((p) => p.playerId === myId);
                            const exactCount = gamePredictions.filter(
                              (p) => predictionPoints(p.predictedWhite, p.predictedRed, p.actualWhite, p.actualRed) === 3
                            ).length;
                            return (
                              <div className="wcf-predict-reveal">
                                <div className="wcf-predict-reveal-label">
                                  <span className="wcf-predict-reveal-title">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
                              Predictions
                            </span>
                                  <span className="wcf-predict-reveal-count">
                                    {gamePredictions.length} guess{gamePredictions.length === 1 ? "" : "es"}
                                  </span>
                                </div>
                                {myGamePrediction &&
                                  (() => {
                                    const pts = predictionPoints(
                                      myGamePrediction.predictedWhite,
                                      myGamePrediction.predictedRed,
                                      myGamePrediction.actualWhite,
                                      myGamePrediction.actualRed
                                    );
                                    return (
                                      <div className="wcf-predict-reveal-row">
                                        <span className="wcf-predict-reveal-row-label">
                                          Your guess: <b>{cs.team_red_name} {myGamePrediction.predictedRed}–{myGamePrediction.predictedWhite} {cs.team_white_name}</b>
                                        </span>
                                        <span className={"wcf-predict-pts " + (pts === 3 ? "exact" : pts === 1 ? "partial" : "zero")}>
                                          +{pts} pt{pts === 1 ? "" : "s"}
                                        </span>
                                      </div>
                                    );
                                  })()}
                                {exactCount > 0 && (
                                  <div className="wcf-predict-fact">
                                    🎯 {exactCount} player{exactCount === 1 ? "" : "s"} called the exact score.
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {isAdmin && (
                            <div className="wcf-result-share">
                              <button className="wcf-result-share-btn" onClick={() => shareResult(g)}>📤 Share result</button>
                              <span className="wcf-result-admin-tag">Admin only</span>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </>
            )}

            {resultsView === "pot" && (() => {
              const chronological = [...potLedger].sort((a, b) => a.date.localeCompare(b.date));
              const series = chronological.reduce<number[]>((acc, e) => {
                acc.push((acc[acc.length - 1] ?? 0) + e.amount);
                return acc;
              }, []);
              const hi = Math.max(...series, 1);
              const lo = Math.min(...series, 0);
              const pt = (v: number, i: number) => {
                const x = (i / Math.max(series.length - 1, 1)) * 320;
                const y = 66 - ((v - lo) / Math.max(hi - lo, 1)) * 58;
                return `${Math.round(x)},${Math.round(y)}`;
              };
              const sparkLine = series.map(pt).join(" ");
              const sparkFill = `0,70 ${sparkLine} 320,70`;

              return (
                <>
                  <div className="wcf-pot-total">
                    <div className="wcf-pot-total-label">Community pot</div>
                    <div className={"wcf-pot-total-amount" + (isAdmin ? " admin" : "") + (potTotal < 0 ? " negative" : "")}>
                      {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                    </div>
                    <p className="wcf-pot-total-note">
                      Built up from game surpluses (match fees vs pitch hire) plus socials, sponsorship and other contributions.
                      Goes towards equipment, socials and running the club.
                    </p>

                    {!isAdmin && (
                      <div className="wcf-pot-tags">
                        <span className="wcf-pot-tag">Equipment</span>
                        <span className="wcf-pot-tag">Socials</span>
                        <span className="wcf-pot-tag">Running the club</span>
                      </div>
                    )}
                  </div>

                {isAdmin && (
                  <>
                    <div className="wcf-fin-stats">
                      <div className="wcf-fin-tile">
                        <div className="wcf-fin-tile-label">Income</div>
                        <div className="wcf-fin-tile-value green">£{financeSummary.income.toFixed(2)}</div>
                      </div>
                      <div className="wcf-fin-tile">
                        <div className="wcf-fin-tile-label">Expenses</div>
                        <div className="wcf-fin-tile-value red">£{financeSummary.expenses.toFixed(2)}</div>
                      </div>
                      <div className="wcf-fin-tile">
                        <div className="wcf-fin-tile-label">Net</div>
                        <div className={"wcf-fin-tile-value " + (potTotal < 0 ? "red" : "green")}>
                          {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {monzoUnmatched.length > 0 && (
                      <div className="wcf-fin-card">
                        <div className="wcf-fin-card-head">Unmatched Monzo payments</div>
                        <p className="wcf-empty small" style={{ marginBottom: 10 }}>Came in but couldn&apos;t be confirmed automatically — check and mark manually.</p>
                        {monzoUnmatched.map((m) => (
                          <div key={m.id} className="wcf-fin-fx-row">
                            <div>
                              <div className="wcf-fin-fx-desc">{m.player?.display_name ?? (m.code ? `Code ${m.code}` : "No reference")}</div>
                              <div className="wcf-pitch">{fmtDateTime(m.created_at)} · {m.reason}</div>
                            </div>
                            <span className="wcf-fin-fx-net red">£{(m.amount_pence / 100).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {potLedger.length > 0 && (
                      <div className="wcf-fin-card">
                        <div className="wcf-fin-card-head">Balance over time</div>
                        <svg viewBox="0 0 320 70" preserveAspectRatio="none" className="wcf-pot-spark">
                          <polyline points={sparkFill} fill="rgba(34,197,94,.18)" stroke="none" />
                          <polyline points={sparkLine} stroke="var(--green)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" fill="none" />
                        </svg>
                      </div>
                    )}

                    <div className="wcf-fin-card">
                      <div className="wcf-fin-card-head">By fixture</div>
                      {financeSummary.byFixture.length === 0 && <p className="wcf-empty small">No fixtures with confirmed payments yet.</p>}
                      {financeSummary.byFixture.map((e) => (
                        <div key={e.id} className="wcf-fin-fx-row">
                          <div>
                            <div className="wcf-fin-fx-desc">{e.description.split(" — ")[0]}</div>
                            <div className="wcf-pitch">{fmtDate(e.date)}</div>
                          </div>
                          <span className={"wcf-fin-fx-net " + (e.amount < 0 ? "red" : "green")}>
                            {e.amount < 0 ? "−" : "+"}£{Math.abs(e.amount).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="wcf-fin-card">
                      <div className="wcf-fin-card-head">Where it's gone</div>
                      {(() => {
                        const totalSpend = Object.values(financeSummary.byCategory).reduce((s, v) => s + v, 0);
                        const cats = (Object.keys(financeSummary.byCategory) as PotCategory[]).filter((c) => financeSummary.byCategory[c] > 0);
                        if (cats.length === 0) return <p className="wcf-empty small">Nothing spent yet.</p>;
                        return cats
                          .sort((a, b) => financeSummary.byCategory[b] - financeSummary.byCategory[a])
                          .map((c) => {
                            const amt = financeSummary.byCategory[c];
                            const pct = totalSpend > 0 ? (amt / totalSpend) * 100 : 0;
                            return (
                              <div key={c} className="wcf-fin-cat-row">
                                <div className="wcf-fin-cat-top">
                                  <span>{POT_CATEGORY_LABEL[c]}</span>
                                  <span>£{amt.toFixed(2)} · {pct.toFixed(0)}%</span>
                                </div>
                                <div className="wcf-fin-cat-track">
                                  <div className="wcf-fin-cat-fill" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            );
                          });
                      })()}
                    </div>

                    <form
                      className="wcf-pot-add"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const magnitude = Math.abs(Number(potAmount));
                        if (!magnitude || !potDescription.trim()) return;
                        const amount = potEntryKind === "deduct" ? -magnitude : magnitude;
                        setAddingPotEntry(true);
                        await addPotEntry(amount, potDescription.trim(), potCategory);
                        setAddingPotEntry(false);
                        setPotAmount("");
                        setPotDescription("");
                        setPotEntryKind("add");
                        setPotCategory("other");
                      }}
                    >
                      <div className="wcf-pot-kind-toggle">
                        <button
                          type="button"
                          className={potEntryKind === "add" ? "active" : ""}
                          onClick={() => setPotEntryKind("add")}
                        >
                          + Add money
                        </button>
                        <button
                          type="button"
                          className={potEntryKind === "deduct" ? "active deduct" : ""}
                          onClick={() => setPotEntryKind("deduct")}
                        >
                          − Deduct money
                        </button>
                      </div>
                      <select value={potCategory} onChange={(e) => setPotCategory(e.target.value as PotCategory)}>
                        {(Object.keys(POT_CATEGORY_LABEL) as PotCategory[]).map((c) => (
                          <option key={c} value={c}>{POT_CATEGORY_LABEL[c]}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Amount, e.g. 20"
                        value={potAmount}
                        onChange={(e) => setPotAmount(e.target.value)}
                      />
                      <input
                        placeholder="e.g. Summer BBQ, new bibs, sponsorship"
                        value={potDescription}
                        onChange={(e) => setPotDescription(e.target.value)}
                      />
                      <button
                        type="submit"
                        className={potEntryKind === "deduct" ? "wcf-pot-submit deduct" : "wcf-pot-submit"}
                        disabled={addingPotEntry || !potAmount || !potDescription.trim()}
                      >
                        {addingPotEntry
                          ? "Saving…"
                          : potEntryKind === "deduct"
                          ? "Deduct from pot"
                          : "Add to pot"}
                      </button>
                    </form>

                    <div className="wcf-pot-ledger-head">
                      <span>Ledger</span>
                      <span>{potLedger.length} entries</span>
                    </div>
                    {potLedger.length === 0 && <p className="wcf-empty">Nothing in the ledger yet.</p>}
                    {potLedger.map((entry) => (
                      <div key={entry.id} className="wcf-pot-row">
                        <span className={"wcf-pot-row-icon " + (entry.amount < 0 ? "neg" : "pos")}>{entry.amount < 0 ? "−" : "+"}</span>
                        <div>
                          <div className="wcf-pot-row-desc">{entry.description}</div>
                          <div className="wcf-pitch">
                            {fmtDate(entry.date)}{entry.kind === "auto" ? " · auto" : ""}
                            <span className="wcf-pot-cat-tag">{POT_CATEGORY_LABEL[entry.category]}</span>
                          </div>
                        </div>
                        <span className={"wcf-pot-row-amount " + (entry.amount < 0 ? "neg" : "pos")}>
                          {entry.amount < 0 ? "−" : "+"}£{Math.abs(entry.amount).toFixed(2)}
                        </span>
                        {entry.kind === "manual" && (
                          <button
                            className="wcf-admin-remove"
                            onClick={async () => { if (await askConfirm("Remove this pot entry?", "This deletes it from the ledger for good.", "Remove")) deletePotEntry(entry.id); }}
                            aria-label="Remove entry"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    {potLedger.length > 0 && <p className="wcf-pot-auto-note">Match surpluses are added automatically the morning after each fixture.</p>}

                    <button className="wcf-ghost wcf-fin-export" onClick={exportFinanceCsv}>⬇ Export season as CSV</button>
                  </>
                )}
                </>
              );
            })()}
          </>
        )}

        {tab === "account" && (
          <AccountPanel
            profile={myProfile}
            email={session.user.email ?? ""}
            isAdmin={isAdmin}
            isOwner={isOwner}
            profiles={profiles}
            clubSettings={cs}
            awards={awards}
            onRename={renameSelf}
            onUploadAvatar={uploadMyAvatar}
            onRemoveAvatar={removeMyAvatar}
            onAdminRemoveAvatar={adminRemovePlayerAvatar}
            onSetRole={setRole}
            onAdminRename={adminRenamePlayer}
            onDeleteProfile={deleteProfile}
            onAddPlayer={addPlayer}
            onGenerateLoginCode={generateLoginCode}
            onSaveClubSettings={saveClubSettings}
            onAddAward={addAward}
            onDeleteAward={deleteAward}
            onSignOut={signOut}
            onEnablePush={enablePush}
            onDisablePush={disablePush}
            onSendTestPush={sendTestPush}
            pushStats={pushStats}
            auditLog={auditLog}
            showAuditLog={showAuditLog}
            onToggleAuditLog={toggleAuditLog}
            myRating={myRating}
            onSaveSelfRating={saveSelfRating}
            adminRatings={adminRatings}
            onSaveAdminRating={saveAdminRating}
            ratingPlayerId={ratingPlayerId}
            onToggleRatingPlayer={(id) => setRatingPlayerId((cur) => (cur === id ? null : id))}
            myRecord={myRecord}
            myUpcomingBookings={myUpcomingBookings}
            myTabOwed={myTabOwed}
            myTabPending={myTabPending}
            onMarkPaid={markPaid}
            askConfirm={askConfirm}
            messages={adminMessages}
            onMarkMessageRead={markMessageRead}
          />
        )}
      </main>

      <nav className="wcf-nav">
        {TABS.map((t) => (
          <button key={t.k} className={"wcf-navbtn " + (tab === t.k ? "active" : "")} onClick={() => setTab(t.k)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {playerCardId && (() => {
        const cardProfile = profiles.find((p) => p.id === playerCardId);
        if (!cardProfile) return null;
        const stats = playerCardStats[playerCardId] ?? { apps: 0, goals: 0, motm: 0 };
        const canSeeRating = isAdmin || playerCardId === myId;
        const rating = canSeeRating ? ratingByPlayer[playerCardId] ?? null : null;
        const appsRank = playerStats.findIndex((p) => p.id === playerCardId) + 1;
        return (
          <PlayerCardModal
            profile={cardProfile}
            stats={stats}
            rating={rating}
            canSeeRating={canSeeRating}
            isOwnCard={playerCardId === myId}
            rank={appsRank > 0 ? appsRank : null}
            team={playerCardTeam}
            onClose={() => { setPlayerCardId(null); setPlayerCardTeam(null); }}
          />
        );
      })()}

      {showBatchGen && (
        <BatchGenerateModal
          existingDates={new Set(games.map((g) => g.date))}
          onGenerate={batchAddGames}
          onClose={() => setShowBatchGen(false)}
        />
      )}

      {motmVotersFor && (
        <MotmVotersModal
          candidateName={motmVotersFor.candidateName}
          voters={motmVotes
            .filter((v) => v.game_id === motmVotersFor.gameId && v.candidate_id === motmVotersFor.candidateId)
            .map((v) => profiles.find((p) => p.id === v.voter_id))
            .filter((p): p is Profile => !!p)}
          onOpenPlayerCard={openPlayerCard}
          onClose={() => setMotmVotersFor(null)}
        />
      )}

      {confirmState && (
        <div className="wcf-modal-overlay" onClick={() => resolveConfirm(false)}>
          <div className="wcf-modal" onClick={(e) => e.stopPropagation()}>
            <div className={"wcf-modal-icon " + (confirmState.danger ? "danger" : "safe")}>
              {confirmState.danger ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5L22 20.5H2z" /><path d="M12 9.5v5M12 18v.01" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.3" /><path d="M12 17v.01" /></svg>
              )}
            </div>
            <div className="wcf-modal-title">{confirmState.title}</div>
            <div className="wcf-modal-msg">{confirmState.message}</div>
            <div className="wcf-modal-actions">
              <button className="wcf-modal-cancel" onClick={() => resolveConfirm(false)}>Cancel</button>
              <button className={"wcf-modal-confirm" + (confirmState.danger ? "" : " safe")} onClick={() => resolveConfirm(true)}>
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const ROLE_LABEL: Record<Role, string> = { player: "Player", admin: "Admin", "co-owner": "Co-Owner", owner: "Owner" };

// Convenience hub, not new data - apps/goals/MOTM already exist scattered
// across Stats and the MOTM tallies, and rating already exists in Fairness
// and Account. This is just the first place all four sit together for one
// person. Ratings only render for an admin or the player's own card - same
// privacy rule as everywhere else - rather than showing a "private"
// placeholder that'd tease data that isn't there for anyone else.
function ratingFillColor(v: number) {
  // amber below 2.5, green above 4, blue in between - reads at a glance without a legend
  return v >= 4 ? "#22c55e" : v < 2.5 ? "#eab308" : "#2E74CC";
}

const BATCH_WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

// YYYY-MM-DD read back in local time, never via toISOString() - that
// always returns UTC, which lands on the wrong calendar day the moment
// local time and UTC disagree on what day it is (true for the UK for
// roughly an hour around midnight, and for the entire day whenever local
// midnight itself is being represented while BST is in effect, e.g. every
// date this batch generator produces for as long as the clocks haven't
// gone back). Confirmed this is exactly what broke the Oct batch-add:
// Monday, constructed as 00:00 local BST, serialised via toISOString()
// landed on Sunday.
function localDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function oneMonthAfter(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + 1);
  return localDateStr(d);
}

// Turns "every Monday and Thursday for the next month" into a batch of
// draft fixtures in one go, instead of an admin adding each one by hand -
// club plays a fixed weekly pattern and books about a month out, so this
// is a recurring batch job, not a one-off.
function BatchGenerateModal({
  existingDates,
  onGenerate,
  onClose,
}: {
  existingDates: Set<string>;
  onGenerate: (dates: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const todayStr = localDateStr(new Date());
  const [start, setStart] = useState(todayStr);
  const [end, setEnd] = useState(oneMonthAfter(todayStr));
  const [days, setDays] = useState<Set<number>>(new Set([1, 4]));
  const [generating, setGenerating] = useState(false);

  // "To" tracks a rolling month from "From" rather than staying pinned
  // to today - picking a later start date should move the whole window
  // with it, not leave you with two weeks (or a backwards range).
  function onStartChange(value: string) {
    setStart(value);
    if (value) setEnd(oneMonthAfter(value));
  }

  const allDates = useMemo(() => {
    if (!start || !end || start > end) return [];
    // A single-day range (From = To) is a one-off add, not a weekly
    // pattern - always include it regardless of which weekday boxes
    // happen to be ticked, rather than making someone figure out which
    // checkbox matches an arbitrary date just to add one fixture.
    if (start === end) return [start];
    const result: string[] = [];
    const d = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (d <= endD) {
      if (days.has(d.getDay())) result.push(localDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    return result;
  }, [start, end, days]);

  const newDates = allDates.filter((d) => !existingDates.has(d));
  const skippedCount = allDates.length - newDates.length;

  function toggleDay(v: number) {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  return (
    <div className="wcf-lightbox" onClick={onClose}>
      <button className="wcf-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div className="wcf-batchgen-card" onClick={(e) => e.stopPropagation()}>
        <div className="wcf-motm-voters-title">Generate fixtures</div>
        <p className="wcf-batchgen-note">
          Adds a draft fixture for every day picked below, using your current defaults. Nothing&apos;s visible to
          players until you confirm and post each one.
        </p>

        <div className="wcf-batchgen-dates">
          <label>
            From
            <input type="date" value={start} onChange={(e) => onStartChange(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <div className="wcf-batchgen-days">
          {BATCH_WEEKDAYS.map((d) => (
            <button key={d.value} type="button" className={days.has(d.value) ? "active" : ""} onClick={() => toggleDay(d.value)}>
              {d.label}
            </button>
          ))}
        </div>

        <div className="wcf-batchgen-preview">
          {newDates.length === 0
            ? "No fixtures to add for this range."
            : `${newDates.length} fixture${newDates.length === 1 ? "" : "s"} will be added${
                skippedCount > 0 ? ` (${skippedCount} already exist${skippedCount === 1 ? "" : "s"} and will be skipped)` : ""
              }.`}
        </div>

        <div className="wcf-batchgen-actions">
          <button className="wcf-ghost" onClick={onClose}>Cancel</button>
          <button
            className="wcf-batchgen-save"
            disabled={newDates.length === 0 || generating}
            onClick={async () => {
              setGenerating(true);
              await onGenerate(newDates);
              setGenerating(false);
            }}
          >
            {generating ? "Adding…" : `Add ${newDates.length || ""} fixture${newDates.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Only ever rendered from the post-close results view - voting itself
// stays anonymous, this is purely "see who backed who" once it's over.
function MotmVotersModal({
  candidateName,
  voters,
  onOpenPlayerCard,
  onClose,
}: {
  candidateName: string;
  voters: Profile[];
  onOpenPlayerCard: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="wcf-lightbox" onClick={onClose}>
      <button className="wcf-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div className="wcf-motm-voters-card" onClick={(e) => e.stopPropagation()}>
        <div className="wcf-motm-voters-title">Voted for {candidateName}</div>
        <div className="wcf-motm-voters-list">
          {voters.map((v) => (
            <button key={v.id} className="wcf-motm-voters-row" onClick={() => { onOpenPlayerCard(v.id); onClose(); }}>
              <Avatar name={v.display_name} avatarUrl={v.avatar_url} className="wcf-avatar-chip lg" background={avatarFor(v.display_name).gradient} />
              <span>{v.display_name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayerCardModal({
  profile,
  stats,
  rating,
  canSeeRating,
  isOwnCard,
  rank,
  team,
  onClose,
}: {
  profile: Profile;
  stats: { apps: number; goals: number; motm: number };
  rating: PlayerRating | null;
  canSeeRating: boolean;
  isOwnCard: boolean;
  rank: number | null;
  team: { name: string; color: string } | null;
  onClose: () => void;
}) {
  const a = avatarFor(profile.display_name);
  const firstName = profile.display_name.split(" ")[0];
  const overall = rating ? ((rating.fitness + rating.attack + rating.defence) / 3).toFixed(1) : null;
  return (
    <div className="wcf-lightbox" onClick={onClose}>
      <button className="wcf-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div className="wcf-pcard" onClick={(e) => e.stopPropagation()}>
        <div className="wcf-pcard-head">
          <div className="wcf-pcard-glow" />
          <div className="wcf-pcard-topline" />
          {canSeeRating && (
            <span className="wcf-pcard-privacy">
              <span className="wcf-pcard-privacy-dot" />
              {isOwnCard ? "YOUR CARD" : "ADMIN VIEW"}
            </span>
          )}
          <div className="wcf-pcard-avatar-wrap">
            <Avatar name={profile.display_name} avatarUrl={profile.avatar_url} className="wcf-pcard-avatar" background={a.gradient} />
            {rank != null && <span className="wcf-pcard-rank">#{rank}</span>}
          </div>
          <div className="wcf-pcard-name">{profile.display_name}</div>
          <div className="wcf-pcard-badges">
            <span className="wcf-pcard-role-badge">{ROLE_LABEL[profile.role]}</span>
            {team && (
              <span
                className="wcf-pcard-team-badge"
                style={{
                  background: `${team.color}29`,
                  borderColor: `${team.color}66`,
                  color: readableTextColor(team.color) === "#0d0d1a" ? team.color : "#f8fafc",
                }}
              >
                {team.name}
              </span>
            )}
          </div>
        </div>

        <div className="wcf-pcard-body">
          <div className="wcf-pcard-stats">
            <div className="wcf-pcard-stat"><b>{stats.apps}</b><span>Apps</span></div>
            <div className="wcf-pcard-stat"><b>{stats.goals}</b><span>Goals</span></div>
            <div className="wcf-pcard-stat"><b>{stats.motm}</b><span>MOTM</span></div>
          </div>

          {canSeeRating && rating ? (
            <div className="wcf-pcard-ratings">
              <div className="wcf-pcard-ratings-top">
                <span className="wcf-pcard-ratings-label">Rating</span>
                <span className="wcf-pcard-ratings-divider" />
                <span className="wcf-pcard-ratings-visibility">
                  {isOwnCard ? "ONLY YOU" : "ADMIN ONLY"}
                </span>
              </div>
              {(["fitness", "attack", "defence", "goalkeeping"] as const).map((k) => (
                <div key={k} className="wcf-pcard-metric">
                  <div className="wcf-pcard-metric-top">
                    <span>{k[0].toUpperCase()}{k.slice(1)}</span>
                    <b>{rating[k].toFixed(1)}</b>
                  </div>
                  <div className="wcf-pcard-track">
                    <div
                      className="wcf-pcard-fill"
                      style={{
                        width: `${(rating[k] / 5) * 100}%`,
                        background: `linear-gradient(90deg,${ratingFillColor(rating[k])}99,${ratingFillColor(rating[k])})`,
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="wcf-pcard-overall">
                <span>Outfield overall</span>
                <b>{overall}</b>
              </div>
            </div>
          ) : (
            <div className="wcf-pcard-private">
              <span>Ratings are private to {firstName} and the admins.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Same collapse pattern as "View players"/Tabs elsewhere - reused here as
// a small generic wrapper since Account groups several of these back to
// back (settings, rating, guides, and - for admins - roles/log/settings/
// awards) rather than each hand-rolling its own toggle button.
function AccordionSection({
  icon,
  tone,
  title,
  meta,
  value,
  open,
  onToggle,
  children,
}: {
  icon: string;
  tone?: "blue" | "amber" | "red";
  title: string;
  meta?: string;
  value?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="wcf-acc-section">
      <button className="wcf-acc-section-head" onClick={onToggle}>
        <span className={"wcf-acc-section-tile" + (tone ? " " + tone : "")}>{icon}</span>
        <span className="wcf-acc-section-body">
          <span className="wcf-acc-section-title">{title}</span>
          {meta && <span className="wcf-acc-section-meta">{meta}</span>}
        </span>
        {value && <span className="wcf-acc-section-value">{value}</span>}
        <span className="wcf-acc-section-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="wcf-acc-section-panel">
          <div className="wcf-acc-section-panel-inner">{children}</div>
        </div>
      )}
    </div>
  );
}

function AccountPanel({
  profile,
  email,
  isAdmin,
  isOwner,
  profiles,
  clubSettings,
  awards,
  onRename,
  onUploadAvatar,
  onRemoveAvatar,
  onAdminRemoveAvatar,
  onSetRole,
  onAdminRename,
  onDeleteProfile,
  onAddPlayer,
  onGenerateLoginCode,
  onSaveClubSettings,
  onAddAward,
  onDeleteAward,
  onSignOut,
  onEnablePush,
  onDisablePush,
  onSendTestPush,
  pushStats,
  auditLog,
  showAuditLog,
  onToggleAuditLog,
  myRating,
  onSaveSelfRating,
  adminRatings,
  onSaveAdminRating,
  ratingPlayerId,
  onToggleRatingPlayer,
  myRecord,
  myUpcomingBookings,
  myTabOwed,
  myTabPending,
  onMarkPaid,
  messages,
  onMarkMessageRead,
  askConfirm,
}: {
  profile: Profile;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  profiles: Profile[];
  myRecord: { played: number; won: number; drawn: number; lost: number; winPct: number | null };
  myUpcomingBookings: { game: GameRow; booking: BookingRow }[];
  myTabOwed: { game: GameRow; booking: BookingRow }[];
  myTabPending: { game: GameRow; booking: BookingRow }[];
  onMarkPaid: (bookingId: string) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  auditLog: AuditLogEntry[];
  showAuditLog: boolean;
  onToggleAuditLog: () => void;
  myRating: PlayerRating | null;
  onSaveSelfRating: (fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  adminRatings: PlayerRating[];
  onSaveAdminRating: (playerId: string, fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  ratingPlayerId: string | null;
  onToggleRatingPlayer: (id: string) => void;
  clubSettings: ClubSettings;
  pushStats: { total: number; subscribed: number } | null;
  awards: AwardRow[];
  onRename: (name: string) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onAdminRemoveAvatar: (id: string) => Promise<void>;
  onSetRole: (id: string, role: Role) => void;
  onAdminRename: (id: string, name: string) => void;
  onDeleteProfile: (id: string, name: string) => void;
  onAddPlayer: (email: string, displayName: string) => Promise<boolean>;
  onGenerateLoginCode: (email: string) => Promise<string | null>;
  onSaveClubSettings: (patch: Partial<ClubSettings>) => void;
  onAddAward: (title: string, value: string, note: string, imageFile: File | null, videoFile: File | null) => Promise<void>;
  onDeleteAward: (id: string) => void;
  onSignOut: () => void;
  onEnablePush: () => Promise<boolean>;
  onDisablePush: () => Promise<void>;
  onSendTestPush: () => Promise<void>;
  messages: AdminMessage[];
  onMarkMessageRead: (id: string) => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const myMessages = messages.filter((m) => m.recipient_id === profile.id);
  const unreadMessages = myMessages.filter((m) => !m.read_at);
  const readMessages = myMessages.filter((m) => m.read_at);
  const [openReadMessages, setOpenReadMessages] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [roleSearch, setRoleSearch] = useState("");
  const [renamingPlayerId, setRenamingPlayerId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const filteredRoleProfiles = profiles.filter((p) => p.display_name.toLowerCase().includes(roleSearch.trim().toLowerCase()));
  const [pushBusy, setPushBusy] = useState(false);
  // Collapsed by default - only the time-sensitive cards above (messages,
  // your tab, upcoming bookings) stay always open. Everything here is
  // either "set once, rarely touched again" or admin reference tooling.
  const [openAccountSettings, setOpenAccountSettings] = useState(false);
  const [openRating, setOpenRating] = useState(false);
  const [openGuides, setOpenGuides] = useState(false);
  const [openClubSettings, setOpenClubSettings] = useState(false);
  const [openAwards, setOpenAwards] = useState(false);
  const [openGuide, setOpenGuide] = useState<"install" | "notifications" | null>(null);
  // push_opt_in is a shared per-user DB flag, but permission is granted
  // per-device/per-browser - deriving "on" from both means a fresh device
  // (or one where permission was never actually granted) correctly shows
  // "Off" instead of a stale "On" that doesn't reflect reality here.
  const pushGranted = typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted";
  const pushOn = !!profile.push_opt_in && pushGranted;

  useEffect(() => setName(profile.display_name), [profile.display_name]);

  return (
    <div className="wcf-account">
      <div className="wcf-account-card">
        <div className="wcf-account-avatar-wrap">
          <Avatar name={profile.display_name} avatarUrl={profile.avatar_url} className="wcf-avatar big" />
          <label className="wcf-account-avatar-edit" aria-label="Change profile photo">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) await onUploadAvatar(file);
              }}
            />
          </label>
          {profile.avatar_url && (
            <button className="wcf-account-avatar-remove" onClick={() => onRemoveAvatar()} aria-label="Remove photo">×</button>
          )}
        </div>
        <div>
          <div className="wcf-account-name">{profile.display_name}</div>
          <div className="wcf-account-email">{email}</div>
        </div>
        <span className={"wcf-role-badge " + profile.role}>{ROLE_LABEL[profile.role]}</span>
      </div>

      {myMessages.length > 0 && (
        <>
          <div className="wcf-console-section">
            <span className="wcf-console-section-label">Inbox</span>
            <span className="wcf-console-section-rule" />
            {unreadMessages.length > 0 && (
              <span className="wcf-inbox-unread-pill">
                <span className="wcf-inbox-unread-dot" />
                {unreadMessages.length} UNREAD
              </span>
            )}
          </div>
          {unreadMessages.map((m) => (
            <div key={m.id} className="wcf-inbox-msg unread">
              <div className="wcf-inbox-msg-top">
                <span className="wcf-inbox-msg-tile">✎</span>
                <div className="wcf-acc-section-body">
                  <div className="wcf-inbox-msg-from">From an admin</div>
                  <div className="wcf-inbox-msg-when">{fmtDateTime(m.created_at)}</div>
                </div>
                <span className="wcf-inbox-new">NEW</span>
              </div>
              <div className="wcf-inbox-msg-body">{m.message}</div>
              <button className="wcf-inbox-mark-read" onClick={() => onMarkMessageRead(m.id)}>Mark as read</button>
            </div>
          ))}
          {unreadMessages.length === 0 && (
            <p className="wcf-empty small">No new messages.</p>
          )}
          {readMessages.length > 0 && (
            <AccordionSection
              icon="✓"
              title="Read messages"
              meta={`${readMessages.length} message${readMessages.length === 1 ? "" : "s"}`}
              open={openReadMessages}
              onToggle={() => setOpenReadMessages((v) => !v)}
            >
              {readMessages.map((m) => (
                <div key={m.id} className="wcf-inbox-msg">
                  <div className="wcf-inbox-msg-top">
                    <span className="wcf-inbox-msg-tile">✎</span>
                    <div className="wcf-acc-section-body">
                      <div className="wcf-inbox-msg-from">From an admin</div>
                      <div className="wcf-inbox-msg-when">{fmtDateTime(m.created_at)}</div>
                    </div>
                  </div>
                  <div className="wcf-inbox-msg-body">{m.message}</div>
                </div>
              ))}
            </AccordionSection>
          )}
        </>
      )}

      {(myTabOwed.length > 0 || myTabPending.length > 0) && (() => {
        const owedTotal = myTabOwed.reduce((sum, { game }) => sum + game.price, 0);
        return (
          <>
            <div className="wcf-console-section">
              <span className="wcf-console-section-label">Your tab</span>
              <span className="wcf-console-section-rule" />
              {owedTotal > 0 && <span className="wcf-console-section-meta warn">£{owedTotal} OWED</span>}
            </div>
            <div className="wcf-tab-hero">
              <div className="wcf-tab-hero-top">
                <div>
                  <span className="wcf-tab-hero-amount">£{owedTotal}</span>
                  <span className="wcf-tab-hero-summary">
                    {myTabOwed.length > 0 && `${myTabOwed.length} game${myTabOwed.length === 1 ? "" : "s"} owed`}
                    {myTabOwed.length > 0 && myTabPending.length > 0 && " · "}
                    {myTabPending.length > 0 && `${myTabPending.length} awaiting confirmation`}
                  </span>
                </div>
                <span className="wcf-tab-hero-icon">£</span>
              </div>
              <div className="wcf-tab-hero-items">
                {myTabOwed.map(({ game, booking }) => (
                  <div key={booking.id} className="wcf-tab-hero-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="wcf-tab-hero-item-venue">{game.venue}</div>
                      <div className="wcf-tab-hero-item-date">{fmtDate(game.date)}</div>
                    </div>
                    <span className="wcf-tab-hero-item-price">£{game.price}</span>
                    <button className="wcf-tab-hero-pay" onClick={() => onMarkPaid(booking.id)}>I&apos;ve paid</button>
                  </div>
                ))}
                {myTabPending.map(({ game, booking }) => (
                  <div key={booking.id} className="wcf-tab-hero-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="wcf-tab-hero-item-venue">{game.venue}</div>
                      <div className="wcf-tab-hero-item-date">{fmtDate(game.date)}</div>
                    </div>
                    <span className="wcf-tab-hero-item-price">£{game.price}</span>
                    <span className="wcf-tab-hero-claimed">AWAITING</span>
                  </div>
                ))}
              </div>
              <p className="wcf-tab-hero-note">
                {profile.payment_code ? (
                  <>
                    Bank transfer to the club account, reference <span className="wcf-tab-ref-code">{profile.payment_code}</span>. Payments with that
                    reference confirm automatically — no need to tell an admin.
                  </>
                ) : (
                  "Bank transfer to the club account. An admin confirms it here once it lands."
                )}
              </p>
            </div>
          </>
        );
      })()}

      {myUpcomingBookings.length > 0 && (
        <>
          <div className="wcf-console-section">
            <span className="wcf-console-section-label">Your bookings</span>
            <span className="wcf-console-section-rule" />
            <span className="wcf-console-section-meta">{myUpcomingBookings.length}</span>
          </div>
          {myUpcomingBookings.map(({ game, booking }) => {
            const d = new Date(game.date + "T00:00:00");
            return (
              <div key={game.id} className="wcf-booking-row">
                <div className="wcf-booking-date-tile">
                  <span className="wcf-booking-day">{d.getDate()}</span>
                  <span className="wcf-booking-month">{d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase()}</span>
                </div>
                <div className="wcf-booking-info">
                  <div className="wcf-booking-venue">{game.venue}</div>
                  <div className="wcf-booking-meta">{fmtDate(game.date)} · {game.kickoff}</div>
                </div>
                {booking.waiting ? (
                  <span className="wcf-booking-badge amber">WAITING LIST</span>
                ) : (
                  <StatusBadge status={booking.status} />
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Settings &amp; reference</span>
        <span className="wcf-console-section-rule" />
      </div>

      <AccordionSection icon="◆" tone="blue" title="Account settings" meta={pushOn ? "Notifications on" : "Notifications off"} open={openAccountSettings} onToggle={() => setOpenAccountSettings((v) => !v)}>
        <label className="wcf-account-field">
          Display name
          <div className="wcf-account-rename">
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <button
              onClick={async () => {
                if (await askConfirm(`Change your display name?`, `Change it to "${name.trim()}"?`, "Save", false)) onRename(name);
              }}
              disabled={!name.trim() || name.trim() === profile.display_name}
            >
              Save
            </button>
          </div>
        </label>

        <div className="wcf-push-section">
          <div className="wcf-push-row">
            <div>
              <div className="wcf-push-label">Game-day notifications</div>
              <div className="wcf-push-sub">Kickoff reminders, payment nudges, spots opening up</div>
            </div>
            <button
              className={"wcf-push-toggle " + (pushOn ? "on" : "")}
              disabled={pushBusy}
              aria-label={pushOn ? "Turn off notifications" : "Turn on notifications"}
              aria-pressed={pushOn}
              onClick={async () => {
                setPushBusy(true);
                if (pushOn) await onDisablePush();
                else await onEnablePush();
                setPushBusy(false);
              }}
            >
              <span className="wcf-push-toggle-knob" />
            </button>
          </div>
          {pushOn && (
            <button className="wcf-ghost wcf-push-test" onClick={onSendTestPush}>
              Send me a test push
            </button>
          )}
          {!pushOn && (
            <p className="wcf-push-note">
              Note: the app must be added to your Home Screen for notifications to work — see &quot;Getting set up&quot; below if you haven&apos;t yet.
            </p>
          )}
        </div>

        <button className="wcf-signout" onClick={onSignOut}>Sign out</button>
      </AccordionSection>

      <AccordionSection
        icon="★"
        tone="amber"
        title="Your rating &amp; record"
        meta={myRecord.played > 0 ? `${myRecord.played} played · ${myRecord.winPct}% win rate` : "No games yet"}
        value={myRating ? ((myRating.fitness + myRating.attack + myRating.defence) / 3).toFixed(1) : undefined}
        open={openRating}
        onToggle={() => setOpenRating((v) => !v)}
      >
        <div className="wcf-rating-section">
          <h3>Rate yourself</h3>
          <p className="wcf-rating-note">
            Helps admins put together fair teams. Only visible to you and admins — once an admin rates you, theirs takes over.
          </p>
          <RatingForm initial={myRating} onSave={onSaveSelfRating} saveLabel={myRating ? "Update my rating" : "Save my rating"} />
        </div>

        <div className="wcf-record-section">
          <h3>My record</h3>
          <p className="wcf-rating-note">Only visible to you — worked out from every past game you had a spot in.</p>
          {myRecord.played === 0 ? (
            <p className="wcf-record-empty">No results yet — this fills in once you've played a game.</p>
          ) : (
            <>
              <div className="wcf-record-pct">{myRecord.winPct}%<span>win rate</span></div>
              <div className="wcf-record-row">
                <div><strong>{myRecord.played}</strong><span>Played</span></div>
                <div><strong>{myRecord.won}</strong><span>Won</span></div>
                <div><strong>{myRecord.drawn}</strong><span>Drawn</span></div>
                <div><strong>{myRecord.lost}</strong><span>Lost</span></div>
              </div>
            </>
          )}
        </div>
      </AccordionSection>

      <AccordionSection icon="◎" tone="blue" title="Getting set up" meta="Home screen &amp; notifications" open={openGuides} onToggle={() => setOpenGuides((v) => !v)}>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("install")}>
          <span className="wcf-guide-tile">📱</span>
          <span className="wcf-guide-title">Add to your home screen</span>
          <span className="wcf-guide-arrow">›</span>
        </button>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("notifications")}>
          <span className="wcf-guide-tile">🔔</span>
          <span className="wcf-guide-title">Enable notifications</span>
          <span className="wcf-guide-arrow">›</span>
        </button>
      </AccordionSection>

      {openGuide && (
        <div className="wcf-lightbox" onClick={() => setOpenGuide(null)}>
          <button className="wcf-lightbox-close" onClick={() => setOpenGuide(null)} aria-label="Close">×</button>
          <img
            className="wcf-lightbox-img"
            src={openGuide === "install" ? "/Install_Guide.png" : "/Notifications_Guide.png"}
            alt={openGuide === "install" ? "How to add the app to your home screen" : "How to enable push notifications"}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {isAdmin && (
        <div className="wcf-console-section">
          <span className="wcf-console-section-label">Admin</span>
          <span className="wcf-console-section-rule" />
        </div>
      )}

      {isAdmin && (
        <AccordionSection icon="◈" tone="blue" title="Manage roles" meta={`${profiles.length} players`} open={showRoles} onToggle={() => setShowRoles((v) => !v)}>
          {pushStats && (
            <div className="wcf-roles-stats">
              <div className="wcf-roles-stat blue">
                <span className="wcf-roles-stat-num">{pushStats.subscribed}</span>
                <span className="wcf-roles-stat-label">of {pushStats.total} subscribed</span>
              </div>
              <div className="wcf-roles-stat dim">
                <span className="wcf-roles-stat-num">{profiles.length}</span>
                <span className="wcf-roles-stat-label">total players</span>
              </div>
            </div>
          )}
          <AddPlayerForm onAdd={onAddPlayer} />
          <LoginCodeForm onGenerate={onGenerateLoginCode} />

          {profiles.length > 8 && (
            <input
              className="wcf-roles-search"
              placeholder="🔍 Search players…"
              value={roleSearch}
              onChange={(e) => setRoleSearch(e.target.value)}
            />
          )}
          {roleSearch.trim() && filteredRoleProfiles.length === 0 && (
            <p className="wcf-empty small">No players match &quot;{roleSearch.trim()}&quot;.</p>
          )}
          <div className="wcf-roles-list">
          {filteredRoleProfiles.map((p) => {
            const isSelf = p.id === profile.id;
            // Owner rows are fully protected in the UI (SQL Editor only).
            // Co-owner rows can only be touched by the owner. Admins/
            // co-owners can promote a player, but only the owner can
            // touch an existing admin or co-owner's role.
            const canDelete =
              p.role === "player" ? !isSelf : (p.role === "admin" || p.role === "co-owner") ? isOwner && !isSelf : false;
            return (
              <div key={p.id} className="wcf-roles-row">
                {renamingPlayerId === p.id ? (
                  <div className="wcf-account-rename">
                    <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} autoFocus />
                    <button
                      disabled={!renameDraft.trim() || renameDraft.trim() === p.display_name}
                      onClick={async () => {
                        if (await askConfirm("Change this player's name?", `Change "${p.display_name}" to "${renameDraft.trim()}"? This is what shows on team sheets everywhere.`, "Save", false)) {
                          onAdminRename(p.id, renameDraft);
                          setRenamingPlayerId(null);
                        }
                      }}
                    >
                      Save
                    </button>
                    <button className="wcf-ghost" onClick={() => setRenamingPlayerId(null)}>Cancel</button>
                  </div>
                ) : (
                  <div className="wcf-roles-row-top">
                    <Avatar name={p.display_name} avatarUrl={p.avatar_url} className="wcf-roles-avatar" />
                    <span>{p.display_name}{isSelf ? " (you)" : ""} <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span></span>
                  </div>
                )}
                <div className="wcf-roles-actions">
                  {renamingPlayerId !== p.id && (
                    <button
                      className="wcf-ghost"
                      onClick={() => { setRenamingPlayerId(p.id); setRenameDraft(p.display_name); }}
                    >
                      Rename
                    </button>
                  )}
                  {p.avatar_url && (
                    <button className="wcf-ghost" onClick={() => onAdminRemoveAvatar(p.id)}>
                      Remove photo
                    </button>
                  )}
                  {p.role === "player" && (
                    <button
                      className="wcf-ghost"
                      onClick={async () => {
                        if (
                          await askConfirm(
                            "Make admin?",
                            `${p.display_name} will be able to manage fixtures, payments, and other players.`,
                            "Make admin",
                            false
                          )
                        ) {
                          onSetRole(p.id, "admin");
                        }
                      }}
                    >
                      Make admin
                    </button>
                  )}
                  {p.role === "admin" && isOwner && (
                    <>
                      <button
                        className="wcf-ghost"
                        onClick={async () => {
                          const title = isSelf ? "Remove your own admin access?" : `Remove admin access from ${p.display_name}?`;
                          const msg = isSelf ? "You'll need the owner (or the SQL Editor) to get it back." : "They'll go back to being a regular player.";
                          if (await askConfirm(title, msg, "Remove admin")) onSetRole(p.id, "player");
                        }}
                      >
                        Remove admin
                      </button>
                      <button
                        className="wcf-ghost"
                        onClick={async () => {
                          if (
                            await askConfirm(
                              "Make co-owner?",
                              `Only you'll be able to change or remove ${p.display_name}'s access afterwards.`,
                              "Make co-owner",
                              false
                            )
                          ) {
                            onSetRole(p.id, "co-owner");
                          }
                        }}
                      >
                        Make co-owner
                      </button>
                    </>
                  )}
                  {p.role === "co-owner" && isOwner && (
                    <button
                      className="wcf-ghost"
                      onClick={async () => {
                        const title = isSelf ? "Remove your own co-owner access?" : `Remove co-owner access from ${p.display_name}?`;
                        const msg = isSelf ? "You'll need the owner to get it back." : "They'll become an admin.";
                        if (await askConfirm(title, msg, "Remove co-owner")) onSetRole(p.id, "admin");
                      }}
                    >
                      Remove co-owner
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="wcf-ghost danger"
                      onClick={() => onDeleteProfile(p.id, p.display_name)}
                    >
                      Delete
                    </button>
                  )}
                  <button className="wcf-ghost" onClick={() => onToggleRatingPlayer(p.id)}>
                    {adminRatings.some((r) => r.player_id === p.id) ? "Rated ✓" : "Rate"}
                  </button>
                </div>
                {ratingPlayerId === p.id && (
                  <RatingForm
                    initial={adminRatings.find((r) => r.player_id === p.id) ?? null}
                    onSave={(fitness, attack, defence, goalkeeping, position) => {
                      onSaveAdminRating(p.id, fitness, attack, defence, goalkeeping, position);
                      onToggleRatingPlayer(p.id);
                    }}
                    saveLabel={`Save ${p.display_name}'s rating`}
                  />
                )}
              </div>
            );
          })}
          </div>
        </AccordionSection>
      )}

      {isAdmin && (
        <AccordionSection icon="≡" tone="blue" title="Activity log" meta={`${auditLog.length} entries`} open={showAuditLog} onToggle={onToggleAuditLog}>
          {auditLog.length === 0 && <p className="wcf-empty">No activity logged yet.</p>}
          <div className="wcf-audit-list">
            {auditLog.map((entry) => (
              <div key={entry.id} className="wcf-audit-row">
                <span className="wcf-audit-dot" style={{ background: "var(--blue)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="wcf-audit-line">
                    <strong>{entry.actor?.display_name ?? "Someone"}</strong> {entry.action.toLowerCase()}
                    {entry.details ? ` — ${entry.details}` : ""}
                  </div>
                  <div className="wcf-audit-time">
                    {new Date(entry.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </AccordionSection>
      )}

      {isAdmin && (
        <AccordionSection icon="⚙" tone="blue" title="Club settings" meta={`${clubSettings.team_white_name} vs ${clubSettings.team_red_name}`} open={openClubSettings} onToggle={() => setOpenClubSettings((v) => !v)}>
          <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />
        </AccordionSection>
      )}

      {isAdmin && (
        <AccordionSection icon="🏆" tone="amber" title="Awards" meta={`${awards.length} published`} open={openAwards} onToggle={() => setOpenAwards((v) => !v)}>
          <AwardsForm awards={awards} onAdd={onAddAward} onDelete={onDeleteAward} askConfirm={askConfirm} />
        </AccordionSection>
      )}
    </div>
  );
}

function AddPlayerForm({ onAdd }: { onAdd: (email: string, displayName: string) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    const ok = await onAdd(email.trim(), displayName.trim());
    setAdding(false);
    if (ok) {
      setEmail("");
      setDisplayName("");
    }
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Add a player</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For anyone who can&apos;t self sign up — they can then sign in with this email straight away.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
        <label className="wcf-team-field wide">
          Display name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Defaults to their email" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={adding || !email.trim()}>
        {adding ? "Adding…" : "Add player"}
      </button>
    </form>
  );
}

function LoginCodeForm({ onGenerate }: { onGenerate: (email: string) => Promise<string | null> }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCode(null);
    const result = await onGenerate(email.trim());
    setBusy(false);
    if (result) setCode(result);
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Generate a login code</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For when someone isn&apos;t getting the sign-in email — creates a real code without sending it, so you can read it out to them directly.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Their email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={busy || !email.trim()}>
        {busy ? "Generating…" : "Generate code"}
      </button>
      {code && (
        <div className="wcf-login-code">
          <span className="wcf-login-code-value">{code}</span>
          <span className="wcf-login-code-note">Expires soon — share it with them now, they enter it on the normal sign-in screen</span>
        </div>
      )}
    </form>
  );
}

function ClubSettingsForm({ settings, onSave }: { settings: ClubSettings; onSave: (patch: Partial<ClubSettings>) => void }) {
  const [form, setForm] = useState(settings);

  useEffect(() => setForm(settings), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const kickoffValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.default_kickoff);

  return (
    <div className="wcf-club-settings">
      <h3>Club settings</h3>

      <div className="wcf-team-settings">
        <div className="wcf-team-row">
          <label className="wcf-team-field">
            Team A name
            <input value={form.team_white_name} onChange={(e) => setForm({ ...form, team_white_name: e.target.value })} />
          </label>
          <label className="wcf-team-field color">
            Colour
            <input type="color" value={form.team_white_color} onChange={(e) => setForm({ ...form, team_white_color: e.target.value })} />
          </label>
        </div>
        <div className="wcf-team-row">
          <label className="wcf-team-field">
            Team B name
            <input value={form.team_red_name} onChange={(e) => setForm({ ...form, team_red_name: e.target.value })} />
          </label>
          <label className="wcf-team-field color">
            Colour
            <input type="color" value={form.team_red_color} onChange={(e) => setForm({ ...form, team_red_color: e.target.value })} />
          </label>
        </div>
        <label className="wcf-team-field wide">
          Default venue for new fixtures
          <input value={form.default_venue} onChange={(e) => setForm({ ...form, default_venue: e.target.value })} placeholder="e.g. Guinea Gap" />
        </label>
        <label className="wcf-team-field wide">
          Default kickoff (24hr, e.g. 19:00)
          <input
            value={form.default_kickoff}
            onChange={(e) => setForm({ ...form, default_kickoff: e.target.value })}
            placeholder="19:00"
            inputMode="numeric"
          />
          {!kickoffValid && <span className="wcf-field-error">Use 24hr HH:MM, e.g. 19:00</span>}
        </label>
        <label className="wcf-team-field wide">
          Default pitch format
          <input
            value={form.default_pitch}
            onChange={(e) => setForm({ ...form, default_pitch: e.target.value })}
            placeholder="e.g. 8-a-side"
          />
        </label>
        <label className="wcf-team-field wide">
          Default match fee (£)
          <input
            type="number"
            min={0}
            step="0.5"
            value={form.default_price}
            onChange={(e) => setForm({ ...form, default_price: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="wcf-team-field wide">
          Default squad size
          <input
            type="number"
            min={1}
            max={MAX_SPOTS}
            value={form.default_max_players}
            onChange={(e) => setForm({ ...form, default_max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
          />
        </label>
      </div>

      <button className="wcf-save" onClick={() => onSave(form)} disabled={!dirty || !kickoffValid}>Save settings</button>
    </div>
  );
}

function AwardsForm({
  awards,
  onAdd,
  onDelete,
  askConfirm,
}: {
  awards: AwardRow[];
  onAdd: (title: string, value: string, note: string, imageFile: File | null, videoFile: File | null) => Promise<void>;
  onDelete: (id: string) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    await onAdd(title.trim(), value.trim(), note.trim(), imageFile, videoFile);
    setAdding(false);
    setTitle("");
    setValue("");
    setNote("");
    setImageFile(null);
    setVideoFile(null);
  }

  return (
    <div className="wcf-club-settings">
      <h3>Awards & shoutouts</h3>

      {awards.map((a) => (
        <div key={a.id} className="wcf-award-row">
          <div className="wcf-award-top">
            <span className="wcf-award-title">{a.title}</span>
            <span className="wcf-award-value">{a.value}</span>
          </div>
          {a.note && <div className="wcf-award-note">{a.note}</div>}
          <div className="wcf-award-bottom">
            {a.image_url && <span className="wcf-award-tag">📷 Photo</span>}
            {a.video_url && <span className="wcf-award-tag">🎥 Video</span>}
            <button
              className="wcf-admin-remove"
              style={{ marginLeft: "auto" }}
              onClick={async () => {
                if (await askConfirm(`Remove "${a.title}"?`, "This also deletes any photo/video attached to it.", "Remove")) onDelete(a.id);
              }}
              aria-label="Remove award"
            >
              ×
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={submit}>
        <div className="wcf-team-settings">
          <label className="wcf-team-field wide">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 🏆 Player of the Season" required />
          </label>
          <label className="wcf-team-field wide">
            Value
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Marcus, or 30 goals, or anything" required />
          </label>
          <label className="wcf-team-field wide">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. voted by the squad" />
          </label>
        </div>
        <div className="wcf-upload-row">
          <label className="wcf-upload-box">
            <span className="wcf-upload-glyph">📷</span>
            <span className="wcf-upload-label">Photo</span>
            <span className="wcf-upload-state">{imageFile ? imageFile.name : "Optional"}</span>
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="wcf-upload-box">
            <span className="wcf-upload-glyph">🎥</span>
            <span className="wcf-upload-label">Video</span>
            <span className="wcf-upload-state">{videoFile ? videoFile.name : `Under ${MAX_AWARD_VIDEO_MB}MB`}</span>
            <input type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <button className="wcf-save-amber" style={{ marginTop: 10 }} type="submit" disabled={adding || !title.trim() || !value.trim()}>
          {adding ? "Publishing…" : "Publish award"}
        </button>
      </form>
    </div>
  );
}

function PredictPanel({
  gameId,
  whiteLabel,
  redLabel,
  isBooked,
  myPrediction,
  onSave,
}: {
  gameId: string;
  whiteLabel: string;
  redLabel: string;
  isBooked: boolean;
  myPrediction: ScorePrediction | null;
  onSave: (gameId: string, white: number, red: number) => Promise<void>;
}) {
  const [white, setWhite] = useState(myPrediction?.predicted_white ?? 2);
  const [red, setRed] = useState(myPrediction?.predicted_red ?? 1);
  const [editing, setEditing] = useState(!myPrediction);
  const [saving, setSaving] = useState(false);

  if (!isBooked) {
    return (
      <div className="wcf-predict">
        <div className="wcf-predict-gate">
          <div className="wcf-predict-gate-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </div>
          <div className="wcf-predict-gate-text">
            <b>Book a spot on this game</b> to make your prediction — guessing&apos;s for the players in it.
          </div>
        </div>
      </div>
    );
  }

  if (myPrediction && !editing) {
    return (
      <div className="wcf-predict">
        <div className="wcf-predict-locked">
          <span className="wcf-predict-locked-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
          </span>
          <div className="wcf-predict-locked-body">
            <div className="wcf-predict-locked-label">Your prediction</div>
            <div className="wcf-predict-locked-value">
              {redLabel} {myPrediction.predicted_red}–{myPrediction.predicted_white} {whiteLabel}
            </div>
          </div>
          <button className="wcf-predict-edit" onClick={() => setEditing(true)}>Edit</button>
        </div>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    await onSave(gameId, white, red);
    setSaving(false);
    setEditing(false);
  }

  return (
    <div className="wcf-predict">
      <div className="wcf-predict-label">
        <span className="wcf-predict-title">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
          Predict the score
        </span>
        <span className="wcf-predict-sub">Closes at kickoff</span>
      </div>
      <p className="wcf-predict-prize">
        Now you know the sides — guess the final score. Top 3 on the season leaderboard win prizes from the pot; each calendar month&apos;s winner gets a free game.
      </p>
      <div className="wcf-predict-score">
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{redLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setRed((n) => Math.max(0, n - 1))} aria-label={`Fewer ${redLabel} goals`}>−</button>
            <span>{red}</span>
            <button onClick={() => setRed((n) => n + 1)} aria-label={`More ${redLabel} goals`}>+</button>
          </div>
        </div>
        <div className="wcf-predict-vs">–</div>
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{whiteLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setWhite((n) => Math.max(0, n - 1))} aria-label={`Fewer ${whiteLabel} goals`}>−</button>
            <span>{white}</span>
            <button onClick={() => setWhite((n) => n + 1)} aria-label={`More ${whiteLabel} goals`}>+</button>
          </div>
        </div>
      </div>
      <button className="wcf-predict-lock" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Lock in prediction"}
      </button>
    </div>
  );
}

function AdminConsole({
  upcoming,
  previous,
  overdue,
  goalRows,
  cs,
  profiles,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onRemoveBooking,
  onDeleteGame,
  onSaveResult,
  onAddBooking,
  onSetPotExempt,
  onGoToLineup,
  messages,
  onSendMessage,
  askConfirm,
}: {
  upcoming: GameRow[];
  previous: GameRow[];
  overdue: { booking: BookingRow; game: GameRow }[];
  goalRows: GoalRow[];
  cs: ClubSettings;
  profiles: Profile[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>, ownGoals: Record<string, number>) => Promise<void>;
  onAddBooking: (gameId: string, playerId: string) => void;
  onSetPotExempt: (bookingId: string, reason: PotExemptReason | null) => void;
  onGoToLineup: () => void;
  messages: AdminMessage[];
  onSendMessage: (recipientId: string, message: string) => Promise<void>;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const shared = {
    goalRows,
    cs,
    profiles,
    expandedId,
    onToggleExpand,
    onSetStatus,
    onRemoveBooking,
    onDeleteGame,
    onSaveResult,
    onAddBooking,
    onSetPotExempt,
    askConfirm,
  };

  // Every number here is already sitting in props passed down from
  // elsewhere - this doesn't compute anything new, just gathers what's
  // scattered across Admin/Line-up/Results into one glance at the top.
  const unscored = previous.filter((g) => g.team_white_score == null || g.team_red_score == null);
  const drafts = [...upcoming, ...previous].filter((g) => !g.published);
  const pendingApproval = upcoming.flatMap((g) =>
    g.bookings.filter((b) => !b.waiting && b.status !== "confirmed").map((b) => ({ booking: b, game: g }))
  );
  // Grouped by game for the expanded "Awaiting approval" breakdown - the
  // dashboard card's namesList() alone gives no game context, meaning an
  // admin had to go hunting through Upcoming to find each one.
  const pendingByGame = Object.values(
    pendingApproval.reduce<Record<string, { game: GameRow; items: typeof pendingApproval }>>((byGame, p) => {
      (byGame[p.game.id] ??= { game: p.game, items: [] }).items.push(p);
      return byGame;
    }, {})
  ).sort((a, b) => a.game.date.localeCompare(b.game.date));
  // Same breakdown, same reasoning, for the Overdue card - it only ever
  // showed a flat names list with no way to actually act on it, so finding
  // and confirming a specific overdue booking meant going hunting through
  // Previous Fixtures by hand instead of using the dashboard shortcut.
  const overdueByGame = Object.values(
    overdue.reduce<Record<string, { game: GameRow; items: typeof overdue }>>((byGame, p) => {
      (byGame[p.game.id] ??= { game: p.game, items: [] }).items.push(p);
      return byGame;
    }, {})
  ).sort((a, b) => b.game.date.localeCompare(a.game.date));
  const nextGame = upcoming[0];
  const nextConfirmed = nextGame ? nextGame.bookings.filter((b) => !b.waiting) : [];
  const nextUnassigned = nextConfirmed.filter((b) => !b.team).length;
  // Zero bookings is not the same as "teams set" - there's trivially
  // nothing unassigned on an empty fixture, but showing a green checkmark
  // for a game nobody's even booked into yet reads as done when there's
  // nothing to be done.
  const noBookingsYet = !!nextGame && nextConfirmed.length === 0;
  const teamsSet = !nextGame || (!noBookingsYet && nextUnassigned === 0);

  const namesList = (items: string[], max = 3) =>
    items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;

  const [composeTo, setComposeTo] = useState("");
  const [composeText, setComposeText] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);

  // Regroups the flat overdue list by player - "owed" (unpaid, real
  // debt) sorted to the top by amount, "pending" (already marked paid,
  // just awaiting confirmation) kept separate and never counted toward
  // the amount shown, same distinction the day-5 warning already makes.
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const [showPendingDetail, setShowPendingDetail] = useState(false);
  const [showOverdueDetail, setShowOverdueDetail] = useState(false);
  const playerTabs = useMemo(() => {
    const byPlayer: Record<string, { playerId: string; playerName: string; owed: typeof overdue; pending: typeof overdue }> = {};
    for (const row of overdue) {
      const entry = (byPlayer[row.booking.player_id] ??= {
        playerId: row.booking.player_id,
        playerName: row.booking.player.display_name,
        owed: [],
        pending: [],
      });
      if (row.booking.status === "unpaid") entry.owed.push(row);
      else if (row.booking.status === "pending") entry.pending.push(row);
    }
    return Object.values(byPlayer).sort((a, b) => {
      const aOwed = a.owed.reduce((sum, o) => sum + o.game.price, 0);
      const bOwed = b.owed.reduce((sum, o) => sum + o.game.price, 0);
      return bOwed - aOwed || b.pending.length - a.pending.length;
    });
  }, [overdue]);
  // Tabs are about money owed - a claim already awaiting confirmation
  // (pending, zero owed) belongs to Pending Approvals above, not here,
  // so it isn't actionable from two different places in the console.
  const owingTabs = playerTabs.filter((t) => t.owed.length > 0);
  const owingTotal = owingTabs.reduce((sum, t) => sum + t.owed.reduce((s, o) => s + o.game.price, 0), 0);

  // Unread ones always show regardless of age - they're the ones that
  // actually need attention. Read ones older than this fall behind
  // "Show older" so the log doesn't just grow forever as more reminders
  // go out week over week.
  const RECENT_MESSAGE_DAYS = 30;
  const [showOlderMessages, setShowOlderMessages] = useState(false);
  const messageCutoff = Date.now() - RECENT_MESSAGE_DAYS * 24 * 60 * 60 * 1000;
  const visibleMessages = showOlderMessages
    ? messages
    : messages.filter((m) => !m.read_at || new Date(m.created_at).getTime() >= messageCutoff);
  const olderMessageCount = messages.length - visibleMessages.length;
  const unreadSentCount = messages.filter((m) => !m.read_at).length;
  // Collapsed by default - a bulk send (e.g. the automated welcome
  // message going out to every existing player at once) can otherwise
  // dump dozens of rows straight onto the page with no way to collapse
  // them back down.
  const [showMessageLog, setShowMessageLog] = useState(false);

  function startMessage(playerId: string, template: string) {
    setComposeTo(playerId);
    setComposeText(template);
  }

  // Group presets resolve to a real list of profile ids at send time and
  // just fan out to the same single-recipient send used everywhere else -
  // no new backend concept, just fewer taps for a broadcast.
  function recipientIds(key: string): string[] {
    if (key === "__all__") return profiles.map((p) => p.id);
    if (key === "__owing__") return owingTabs.map((t) => t.playerId);
    if (key === "__next__") return nextConfirmed.map((b) => b.player_id);
    return [key];
  }

  async function sendMessage() {
    if (!composeTo || !composeText.trim()) return;
    setSendingMessage(true);
    await Promise.all(recipientIds(composeTo).map((id) => onSendMessage(id, composeText.trim())));
    setSendingMessage(false);
    setComposeTo("");
    setComposeText("");
  }

  return (
    <>
      <div className="wcf-console-section">
        <span className="wcf-console-section-label">At a glance</span>
        <span className="wcf-console-section-rule" />
      </div>
      <div className="wcf-glance-grid">
        <div className={"wcf-glance-card" + (unscored.length === 0 ? " clear" : " amber")}>
          <div className="wcf-glance-top">
            <span className="wcf-glance-num">{unscored.length === 0 ? "" : unscored.length}</span>
            <span className="wcf-glance-tile">{unscored.length === 0 ? "✓" : "◷"}</span>
          </div>
          <div className="wcf-glance-label">{unscored.length === 0 ? "Scores up to date" : "Scores to enter"}</div>
          <div className="wcf-glance-names">{unscored.length === 0 ? "All games scored" : namesList(unscored.map((g) => fmtDate(g.date)))}</div>
        </div>
        <button
          className={"wcf-glance-card" + (overdue.length === 0 ? " clear" : " red") + (overdue.length > 0 ? " expandable" : "")}
          onClick={() => overdue.length > 0 && setShowOverdueDetail((v) => !v)}
        >
          <div className="wcf-glance-top">
            <span className="wcf-glance-num">{overdue.length === 0 ? "" : overdue.length}</span>
            <span className="wcf-glance-tile">{overdue.length === 0 ? "✓" : "£"}</span>
          </div>
          <div className="wcf-glance-label">{overdue.length === 0 ? "Nothing overdue" : "Overdue payments"}</div>
          <div className="wcf-glance-names">{overdue.length === 0 ? "All settled up" : namesList(overdue.map((o) => o.booking.player.display_name.split(" ")[0]))}</div>
          {overdue.length > 0 && <div className="wcf-glance-expand">{showOverdueDetail ? "Hide detail" : "Tap for detail"}</div>}
        </button>
        <button
          className={"wcf-glance-card" + (pendingApproval.length === 0 ? " clear" : " amber") + (pendingApproval.length > 0 ? " expandable" : "")}
          onClick={() => pendingApproval.length > 0 && setShowPendingDetail((v) => !v)}
        >
          <div className="wcf-glance-top">
            <span className="wcf-glance-num">{pendingApproval.length === 0 ? "" : pendingApproval.length}</span>
            <span className="wcf-glance-tile">{pendingApproval.length === 0 ? "✓" : "?"}</span>
          </div>
          <div className="wcf-glance-label">{pendingApproval.length === 0 ? "No claims waiting" : "Pending approvals"}</div>
          <div className="wcf-glance-names">{pendingApproval.length === 0 ? "Nothing to review" : namesList(pendingApproval.map((p) => p.booking.player.display_name.split(" ")[0]))}</div>
          {pendingApproval.length > 0 && <div className="wcf-glance-expand">{showPendingDetail ? "Hide detail" : "Tap for detail"}</div>}
        </button>
        <div className={"wcf-glance-card" + (drafts.length === 0 ? " clear" : " blue")}>
          <div className="wcf-glance-top">
            <span className="wcf-glance-num">{drafts.length === 0 ? "" : drafts.length}</span>
            <span className="wcf-glance-tile">{drafts.length === 0 ? "✓" : "✎"}</span>
          </div>
          <div className="wcf-glance-label">{drafts.length === 0 ? "No drafts" : drafts.length === 1 ? "Draft fixture" : "Draft fixtures"}</div>
          <div className="wcf-glance-names">{drafts.length === 0 ? "Nothing waiting" : namesList(drafts.map((g) => g.venue))}</div>
        </div>
        <button className={"wcf-glance-card wide" + (teamsSet || noBookingsYet ? " clear" : " crimson")} onClick={onGoToLineup}>
          <div className="wcf-glance-top">
            <span className="wcf-glance-num small">{noBookingsYet ? "No one booked yet" : teamsSet ? "Teams set" : "Teams not set"}</span>
            <span className="wcf-glance-tile">{noBookingsYet ? "…" : teamsSet ? "✓" : "⇄"}</span>
          </div>
          {nextGame && <div className="wcf-glance-names">{nextGame.venue} · {fmtDate(nextGame.date)}{!teamsSet && !noBookingsYet ? ` — ${nextUnassigned} unassigned` : ""}</div>}
        </button>
      </div>

      {showOverdueDetail && overdueByGame.length > 0 && (
        <div className="wcf-pending-detail">
          <div className="wcf-pending-head">
            <span>OVERDUE PAYMENTS</span>
            <span className="wcf-pending-head-rule" />
          </div>
          {overdueByGame.map(({ game, items }) => {
            const claimedPaid = items.filter((i) => i.booking.status === "pending");
            const notPaid = items.filter((i) => i.booking.status === "unpaid");
            return (
              <div key={game.id} className="wcf-pending-game">
                <div className="wcf-pending-game-head">
                  <span className="wcf-pending-game-venue">{game.venue}</span>
                  <span className="wcf-pending-game-date">{fmtDate(game.date)}</span>
                </div>
                {claimedPaid.map(({ booking: b }) => (
                  <div key={b.id} className="wcf-pending-row">
                    <span className="wcf-pending-dot paid" />
                    <span className="wcf-pending-name">{b.player.display_name}</span>
                    <span className="wcf-pending-status paid">Says paid</span>
                    <button className="wcf-pending-confirm" onClick={() => onSetStatus(b.id, "confirmed")}>Confirm</button>
                  </div>
                ))}
                {notPaid.map(({ booking: b }) => (
                  <div key={b.id} className="wcf-pending-row">
                    <span className="wcf-pending-dot unpaid" />
                    <span className="wcf-pending-name">{b.player.display_name}</span>
                    <span className="wcf-pending-status unpaid">Not yet paid</span>
                    <button
                      className="wcf-admin-approve-override"
                      onClick={async () => {
                        if (await askConfirm(`Confirm ${b.player.display_name} as paid?`, "They haven't marked this as paid themselves.", "Confirm anyway")) {
                          onSetStatus(b.id, "confirmed");
                        }
                      }}
                    >
                      Approve anyway
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {showPendingDetail && pendingByGame.length > 0 && (
        <div className="wcf-pending-detail">
          <div className="wcf-pending-head">
            <span>PENDING APPROVALS</span>
            <span className="wcf-pending-head-rule" />
          </div>
          {pendingByGame.map(({ game, items }) => {
            // "Payment Pending" (unpaid) and "Awaiting Approval" (pending -
            // they've already tapped I've paid) are genuinely different
            // situations - mixing them in one flat list with an identical
            // Approve button made it easy to confirm someone as paid who
            // hasn't actually claimed to have paid at all.
            const claimedPaid = items.filter((i) => i.booking.status === "pending");
            const notPaid = items.filter((i) => i.booking.status === "unpaid");
            return (
              <div key={game.id} className="wcf-pending-game">
                <div className="wcf-pending-game-head">
                  <span className="wcf-pending-game-venue">{game.venue}</span>
                  <span className="wcf-pending-game-date">{fmtDate(game.date)}</span>
                </div>
                {claimedPaid.map(({ booking: b }) => (
                  <div key={b.id} className="wcf-pending-row">
                    <span className="wcf-pending-dot paid" />
                    <span className="wcf-pending-name">{b.player.display_name}</span>
                    <span className="wcf-pending-status paid">Says paid</span>
                    <button className="wcf-pending-confirm" onClick={() => onSetStatus(b.id, "confirmed")}>Confirm</button>
                  </div>
                ))}
                {notPaid.map(({ booking: b }) => (
                  <div key={b.id} className="wcf-pending-row">
                    <span className="wcf-pending-dot unpaid" />
                    <span className="wcf-pending-name">{b.player.display_name}</span>
                    <span className="wcf-pending-status unpaid">Not yet paid</span>
                    <button
                      className="wcf-admin-approve-override"
                      onClick={async () => {
                        if (await askConfirm(`Confirm ${b.player.display_name} as paid?`, "They haven't marked this as paid themselves.", "Confirm anyway")) {
                          onSetStatus(b.id, "confirmed");
                        }
                      }}
                    >
                      Approve anyway
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Messages</span>
        <span className="wcf-console-section-rule" />
        {unreadSentCount > 0 && <span className="wcf-console-section-meta">{unreadSentCount} unread</span>}
      </div>
      <div className="wcf-msg-compose">
        <select value={composeTo} onChange={(e) => setComposeTo(e.target.value)}>
          <option value="">Choose a recipient…</option>
          <option value="__all__">Everyone ({profiles.length})</option>
          {owingTabs.length > 0 && <option value="__owing__">Players who owe ({owingTabs.length})</option>}
          {nextGame && nextConfirmed.length > 0 && <option value="__next__">Next game roster ({nextConfirmed.length})</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.display_name}</option>
          ))}
        </select>
        <textarea
          className="wcf-msg-compose-box"
          placeholder="Write a message…"
          value={composeText}
          onChange={(e) => setComposeText(e.target.value)}
        />
        <button className="wcf-msg-compose-send" disabled={!composeTo || !composeText.trim() || sendingMessage} onClick={sendMessage}>
          {sendingMessage ? "Sending…" : "Send message"}
        </button>
      </div>
      {messages.length > 0 && (
        <>
          <button className="wcf-msg-log-toggle" onClick={() => setShowMessageLog((v) => !v)}>
            <span className="wcf-msg-log-toggle-label">Sent log</span>
            <span className="wcf-msg-log-toggle-count">{messages.length}</span>
          </button>
          {showMessageLog && (
            <div className="wcf-msg-log">
              {visibleMessages.map((m) => (
                <div key={m.id} className="wcf-msg-log-row">
                  <div className="wcf-msg-log-top">
                    <span className="wcf-msg-log-name">{m.recipient?.display_name ?? "Unknown"}</span>
                    <span className={"wcf-msg-log-status " + (m.read_at ? "read" : "unread")}>{m.read_at ? "Read" : "Unread"}</span>
                  </div>
                  <div className="wcf-msg-log-text">{m.message}</div>
                  <div className="wcf-msg-log-when">{fmtDateTime(m.created_at)}{m.read_at ? ` · read ${fmtDateTime(m.read_at)}` : ""}</div>
                </div>
              ))}
              {!showOlderMessages && olderMessageCount > 0 && (
                <button className="wcf-show-more-toggle" onClick={() => setShowOlderMessages(true)}>
                  Show {olderMessageCount} older
                </button>
              )}
            </div>
          )}
        </>
      )}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Tabs</span>
        <span className="wcf-console-section-rule" />
        {owingTotal > 0 && <span className="wcf-console-section-meta warn">£{owingTotal} out</span>}
      </div>
      {owingTabs.length === 0 && <p className="wcf-empty small">Nothing outstanding — everyone's settled up.</p>}
      {owingTabs.map((row) => {
        const owedTotal = row.owed.reduce((sum, o) => sum + o.game.price, 0);
        const expanded = expandedTabId === row.playerId;
        return (
          <div key={row.playerId} className={"wcf-tab" + (row.pending.length > 0 ? " claiming" : "")}>
            <button className="wcf-tab-summary" onClick={() => setExpandedTabId(expanded ? null : row.playerId)}>
              <Avatar name={row.playerName} avatarUrl={profiles.find((p) => p.id === row.playerId)?.avatar_url} className="wcf-tab-avatar" />
              <span className="wcf-tab-summary-body">
                <span className="wcf-tab-summary-name">{row.playerName}</span>
                <span className="wcf-tab-summary-sub">{row.owed.length} game{row.owed.length === 1 ? "" : "s"} outstanding</span>
              </span>
              {row.pending.length > 0 && <span className="wcf-tab-claimed">CLAIMED</span>}
              <span className="wcf-tab-amount">£{owedTotal}</span>
            </button>
            {expanded && (
              <div className="wcf-tab-detail">
                {row.owed.map(({ booking: b, game: g }) => (
                  <div key={b.id} className="wcf-tab-line">
                    <div className="wcf-tab-line-desc">
                      <div className="wcf-tab-line-venue">{g.venue}</div>
                      <div className="wcf-tab-line-date">{fmtDate(g.date)}</div>
                    </div>
                    <span className="wcf-tab-line-price">£{g.price}</span>
                    <button
                      className="wcf-tab-line-remove"
                      onClick={async () => {
                        const msg = `${g.venue} · ${fmtDate(g.date)}. This deletes their booking entirely - no appearance, no pot charge, nothing left behind.`;
                        if (await askConfirm(`Remove ${row.playerName} from this game?`, msg, "Remove")) {
                          onRemoveBooking(b.id);
                        }
                      }}
                      aria-label="Remove from game"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="wcf-tab-nudge"
                  onClick={() => {
                    const gamesList = row.owed.map((o) => `${o.game.venue} (${fmtDate(o.game.date)})`).join(", ");
                    startMessage(
                      row.playerId,
                      `Hey ${row.playerName.split(" ")[0]} — you're currently down as owing £${owedTotal} across ${row.owed.length} game${
                        row.owed.length === 1 ? "" : "s"
                      }: ${gamesList}. Can you sort it when you get a sec?`
                    );
                  }}
                >
                  Send nudge to {row.playerName.split(" ")[0]}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Upcoming</span>
        <span className="wcf-console-section-rule" />
        <span className="wcf-console-section-meta">{upcoming.length} game{upcoming.length === 1 ? "" : "s"}</span>
      </div>
      {upcoming.length === 0 && <p className="wcf-empty small">No upcoming fixtures.</p>}
      {upcoming.map((g) => (
        <AdminGameRow key={g.id} game={g} past={false} {...shared} />
      ))}
      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Previous</span>
        <span className="wcf-console-section-rule" />
        <span className="wcf-console-section-meta">{previous.length} game{previous.length === 1 ? "" : "s"}</span>
      </div>
      {previous.length === 0 && <p className="wcf-empty small">No past fixtures yet.</p>}
      {previous.map((g) => (
        <AdminGameRow key={g.id} game={g} past {...shared} />
      ))}
    </>
  );
}

function AdminGameRow({
  game,
  past,
  goalRows,
  cs,
  profiles,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onRemoveBooking,
  onDeleteGame,
  onSaveResult,
  onAddBooking,
  onSetPotExempt,
  askConfirm,
}: {
  game: GameRow;
  past: boolean;
  goalRows: GoalRow[];
  cs: ClubSettings;
  profiles: Profile[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  onRemoveBooking: (bookingId: string) => void;
  onDeleteGame: (gameId: string) => void;
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>, ownGoals: Record<string, number>) => Promise<void>;
  onAddBooking: (gameId: string, playerId: string) => void;
  onSetPotExempt: (bookingId: string, reason: PotExemptReason | null) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const expanded = expandedId === game.id;
  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const goalsByPlayer: Record<string, number> = {};
  const ownGoalsByPlayer: Record<string, number> = {};
  goalRows
    .filter((r) => r.game_id === game.id)
    .forEach((r) => {
      goalsByPlayer[r.player_id] = r.goals;
      ownGoalsByPlayer[r.player_id] = r.own_goals;
    });
  const [whiteScore, setWhiteScore] = useState(game.team_white_score?.toString() ?? "");
  const [redScore, setRedScore] = useState(game.team_red_score?.toString() ?? "");
  const [goalDraft, setGoalDraft] = useState<Record<string, number>>(goalsByPlayer);
  const [ownGoalDraft, setOwnGoalDraft] = useState<Record<string, number>>(ownGoalsByPlayer);
  const [addPlayerId, setAddPlayerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  useEffect(() => {
    setWhiteScore(game.team_white_score?.toString() ?? "");
    setRedScore(game.team_red_score?.toString() ?? "");
    setGoalDraft(goalsByPlayer);
    setOwnGoalDraft(ownGoalsByPlayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.team_white_score, game.team_red_score, goalRows, expanded]);

  const bookedIds = new Set(game.bookings.map((b) => b.player_id));
  const eligiblePlayers = profiles.filter((p) => !bookedIds.has(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));

  const dirty =
    whiteScore !== (game.team_white_score?.toString() ?? "") ||
    redScore !== (game.team_red_score?.toString() ?? "") ||
    confirmed.some(
      (b) =>
        (goalDraft[b.player_id] ?? 0) !== (goalsByPlayer[b.player_id] ?? 0) ||
        (ownGoalDraft[b.player_id] ?? 0) !== (ownGoalsByPlayer[b.player_id] ?? 0)
    );

  // Own goals are tracked purely for who-to-blame banter and never touch a
  // player's real Goals stat - deliberately NOT auto-credited to "the other
  // team", since a player who switches sides mid-match makes that guess
  // unreliable. The reconciliation check below is a single combined total
  // rather than a per-team split for the same reason.
  const attributedTotal =
    Object.values(goalDraft).reduce((sum, n) => sum + n, 0) + Object.values(ownGoalDraft).reduce((sum, n) => sum + n, 0);
  const enteredTotal = (whiteScore === "" ? 0 : Number(whiteScore)) + (redScore === "" ? 0 : Number(redScore));
  const scoreEntered = whiteScore !== "" && redScore !== "";

  async function submitResult() {
    setSaving(true);
    await onSaveResult(
      game.id,
      whiteScore === "" ? null : Number(whiteScore),
      redScore === "" ? null : Number(redScore),
      goalDraft,
      ownGoalDraft
    );
    setSaving(false);
  }

  const dateObj = new Date(game.date + "T00:00:00");
  const dayNum = dateObj.getDate();
  const monthAbbr = dateObj.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const gameUnassigned = confirmed.filter((b) => !b.team).length;
  const gameTeamsSet = confirmed.length === 0 || gameUnassigned === 0;
  const scored = game.team_white_score != null && game.team_red_score != null;
  const badge = !past ? (gameTeamsSet ? "TEAMS SET" : "NO TEAMS") : scored ? `${game.team_white_score}–${game.team_red_score}` : "SCORE";
  const badgeTone = !past ? (gameTeamsSet ? "green" : "amber") : scored ? "blue" : "amber";

  return (
    <div className={"wcf-admin-game" + (past ? "" : " upcoming") + (expanded ? " open" : "")}>
      <button className="wcf-admin-game-head" onClick={() => onToggleExpand(game.id)}>
        <span className="wcf-admin-game-date-tile">
          <span className="wcf-admin-game-day">{dayNum}</span>
          <span className="wcf-admin-game-month">{monthAbbr}</span>
        </span>
        <span className="wcf-admin-game-info">
          <span className="wcf-admin-game-venue">{game.venue}</span>
          <span className="wcf-admin-game-date">{fmtDate(game.date)} · {game.kickoff} · {confirmed.length}/{game.max_players} booked</span>
        </span>
        <span className={"wcf-admin-game-badge " + badgeTone}>{badge}</span>
      </button>
      {expanded && (
        <div className="wcf-admin-game-body">
          {past && (
            <div className="wcf-admin-score-card">
              <div className="wcf-admin-score-eyebrow">Enter result</div>
              <div className="wcf-admin-score">
                <span style={{ color: cs.team_white_color }}>{cs.team_white_name.toUpperCase()}</span>
                <input type="number" min={0} value={whiteScore} onChange={(e) => setWhiteScore(e.target.value)} />
                <span className="wcf-admin-score-dash">–</span>
                <input type="number" min={0} value={redScore} onChange={(e) => setRedScore(e.target.value)} />
                <span style={{ color: cs.team_red_color }}>{cs.team_red_name.toUpperCase()}</span>
              </div>
              {scoreEntered && (
                <div className={"wcf-recon " + (attributedTotal === enteredTotal ? "ok" : "pending")}>
                  <span className="wcf-recon-dot" />
                  {attributedTotal} of {enteredTotal} attributed to scorers
                </div>
              )}
            </div>
          )}

          {past && confirmed.length > 0 && (
            <div className="wcf-scorers-card">
              {([
                ["white", confirmed.filter((b) => b.team === "white"), cs.team_white_name, cs.team_white_color],
                ["red", confirmed.filter((b) => b.team === "red"), cs.team_red_name, cs.team_red_color],
                ["unassigned", confirmed.filter((b) => !b.team), "Unassigned", "#94a3b8"],
              ] as const)
                .filter(([, group]) => group.length > 0)
                .map(([key, group, name, color]) => (
                  <div key={key} className="wcf-scorers-team">
                    <div className="wcf-scorers-team-head">
                      <span className="wcf-scorers-team-swatch" style={{ background: color }} />
                      <span className="wcf-scorers-team-name" style={{ color }}>{name}</span>
                    </div>
                    <div className="wcf-scorers-col-head">
                      <span />
                      <small>Goals</small>
                      <small>OG</small>
                    </div>
                    {group.map((b) => (
                      <div key={b.id} className="wcf-scorers-row">
                        <span className="wcf-scorers-name">
                          {b.player.display_name}
                          {(ownGoalDraft[b.player_id] ?? 0) > 0 && <span className="wcf-scorers-og-flag">Own goal</span>}
                        </span>
                        <div className="wcf-scorers-stepper">
                          <button
                            onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: Math.max(0, (g[b.player_id] ?? 0) - 1) }))}
                            disabled={(goalDraft[b.player_id] ?? 0) <= 0}
                          >
                            −
                          </button>
                          <span>{goalDraft[b.player_id] ?? 0}</span>
                          <button onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: (g[b.player_id] ?? 0) + 1 }))}>+</button>
                        </div>
                        <div className="wcf-scorers-stepper og">
                          <button
                            onClick={() => setOwnGoalDraft((g) => ({ ...g, [b.player_id]: Math.max(0, (g[b.player_id] ?? 0) - 1) }))}
                            disabled={(ownGoalDraft[b.player_id] ?? 0) <= 0}
                          >
                            −
                          </button>
                          <span>{ownGoalDraft[b.player_id] ?? 0}</span>
                          <button onClick={() => setOwnGoalDraft((g) => ({ ...g, [b.player_id]: (g[b.player_id] ?? 0) + 1 }))}>+</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )}

          {confirmed.length === 0 && <p className="wcf-empty small">No one booked in.</p>}
          {(() => {
            const renderRow = (b: BookingRow) => (
              <div key={b.id} className="wcf-admin-player-row">
                <span className={"wcf-admin-player-dot " + (b.status === "confirmed" ? "confirmed" : "pending")} />
                <span className="wcf-admin-player-name">
                  {b.player.display_name}
                  <span className="wcf-confirmed-by">Booked {fmtDateTime(b.created_at)}</span>
                  {b.status === "confirmed" && b.confirmer && <span className="wcf-confirmed-by">Payment approved by {b.confirmer.display_name}</span>}
                  {b.status === "confirmed" && b.auto_confirmed && <span className="wcf-confirmed-by">Payment approved via Monzo</span>}
                </span>
                <div className="wcf-admin-status">
                  <StatusBadge status={b.status} />
                  {b.status !== "confirmed" ? (
                    <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Approve</button>
                  ) : (
                    <button className="wcf-admin-undo" onClick={() => onSetStatus(b.id, "unpaid")}>Undo</button>
                  )}
                </div>
                <select
                  className={"wcf-admin-pot-select" + (b.pot_exempt_reason ? " exempt" : "")}
                  value={b.pot_exempt_reason ?? ""}
                  onChange={(e) => onSetPotExempt(b.id, (e.target.value || null) as PotExemptReason | null)}
                  title="Whether this booking counts toward pot income"
                >
                  <option value="">Pays</option>
                  <option value="prize">Free — prize</option>
                  <option value="carried_over">Free — carried over</option>
                  <option value="other">Free — other</option>
                </select>
                <button
                  className="wcf-admin-remove"
                  onClick={async () => {
                    const msg = past
                      ? "This deletes their booking for this game entirely - no appearance, no pot charge, nothing left behind."
                      : "Their spot opens up to the waiting list.";
                    if (await askConfirm(`Remove ${b.player.display_name} from this game?`, msg, "Remove")) {
                      onRemoveBooking(b.id);
                    }
                  }}
                  aria-label="Remove from game"
                >
                  ×
                </button>
              </div>
            );

            // Past games only - once most players are paid up, their rows
            // are just clutter on top of the new scorer-entry card above.
            // Still fully reachable (remove/pot-exempt etc. all still
            // work), just collapsed by default - same pattern as archived
            // feed items / older messages elsewhere in the app.
            if (!past) return confirmed.map(renderRow);
            const outstanding = confirmed.filter((b) => b.status !== "confirmed");
            const settled = confirmed.filter((b) => b.status === "confirmed");
            return (
              <>
                {outstanding.map(renderRow)}
                {settled.length > 0 && (
                  <>
                    <button className="wcf-show-more-toggle" onClick={() => setShowSettled((v) => !v)}>
                      {showSettled ? "Hide" : "Show"} {settled.length} settled {settled.length === 1 ? "player" : "players"}
                    </button>
                    {showSettled && settled.map(renderRow)}
                  </>
                )}
              </>
            );
          })()}

          {past && confirmed.length > 0 && (
            <button className="wcf-save" onClick={submitResult} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save result"}
            </button>
          )}

          {waitingList.length > 0 && (
            <>
              <h4 className="wcf-edit-subhead">Waiting list · {waitingList.length}</h4>
              {waitingList.map((b, i) => (
                <div key={b.id} className="wcf-admin-player-row">
                  <span className="wcf-admin-player-name">
                    {i + 1}. {b.player.display_name}
                    <span className="wcf-confirmed-by">Joined {fmtDateTime(b.created_at)}</span>
                  </span>
                  <button
                    className="wcf-admin-remove"
                    onClick={async () => {
                      if (await askConfirm(`Remove ${b.player.display_name} from the waiting list?`, "They'll need to rejoin if they want a spot again.", "Remove")) {
                        onRemoveBooking(b.id);
                      }
                    }}
                    aria-label="Remove from waiting list"
                  >
                    ×
                  </button>
                </div>
              ))}
            </>
          )}

          {eligiblePlayers.length > 0 && (
            <div className="wcf-admin-add-player">
              <select value={addPlayerId} onChange={(e) => setAddPlayerId(e.target.value)}>
                <option value="">Add a player who didn&apos;t book…</option>
                {eligiblePlayers.map((p) => (
                  <option key={p.id} value={p.id}>{p.display_name}</option>
                ))}
              </select>
              <button
                className="wcf-ghost"
                disabled={!addPlayerId}
                onClick={() => {
                  onAddBooking(game.id, addPlayerId);
                  setAddPlayerId("");
                }}
              >
                Add
              </button>
            </div>
          )}

          <button
            className="wcf-admin-delete-game"
            onClick={async () => {
              const when = past ? "past" : "upcoming";
              const hasBookings = confirmed.length > 0 || waitingList.length > 0;
              const title = scored ? "Delete this scored fixture?" : `Delete this ${when} fixture?`;
              const message = scored
                ? `${game.venue} on ${fmtDate(game.date)} — this permanently deletes the ${game.team_white_score}–${game.team_red_score} result, every goal and own goal logged against it, and any pot income it earned. This can't be undone.`
                : hasBookings
                ? `${game.venue} on ${fmtDate(game.date)} — this removes it completely, along with everyone's bookings and payment records.`
                : `${game.venue} on ${fmtDate(game.date)} — this removes it completely.`;
              if (await askConfirm(title, message, "Delete")) {
                onDeleteGame(game.id);
              }
            }}
          >
            Delete this fixture
          </button>
        </div>
      )}
    </div>
  );
}

// Reuses the compact fixture-row visual language (.wcf-fx-*) from GameCard
// rather than a new layout, so select mode reads as a variant of the
// normal list, not a bolted-on foreign screen. Deliberately its own
// component instead of a GameCard prop, since threading select-mode state
// through GameCard's already-large prop surface (admin editing, weather,
// the squad sheet, etc.) would tangle two unrelated concerns together.
function MultiBookRow({ game, myId, selected, onToggle }: { game: GameRow; myId: string; selected: boolean; onToggle: () => void }) {
  const confirmed = game.bookings.filter((b) => !b.waiting);
  const waitingList = game.bookings.filter((b) => b.waiting);
  const alreadyBooked = game.bookings.some((b) => b.player_id === myId);
  const full = confirmed.length >= game.max_players;
  const spotsLeft = Math.max(0, game.max_players - confirmed.length);
  const fillPct = Math.min(100, (confirmed.length / game.max_players) * 100);

  return (
    <button
      type="button"
      className={"wcf-fx-row wcf-multibook-row" + (alreadyBooked ? " booked" : selected ? " selected" : "")}
      disabled={alreadyBooked}
      onClick={onToggle}
    >
      <div className="wcf-fx-row-top">
        <div className="wcf-fx-date">
          <div className="wcf-fx-day">{fmtDate(game.date).split(",")[0]?.toUpperCase()}</div>
          <div className="wcf-fx-num">{new Date(game.date + "T00:00:00").getDate()}</div>
        </div>
        <div className="wcf-fx-divider" />
        <div className="wcf-fx-info">
          <div className="wcf-fx-title">{game.kickoff} · {game.venue}</div>
          <div className="wcf-fx-meta">{game.pitch} · £{game.price} · {confirmed.length}/{game.max_players}</div>
          <div className="wcf-fx-bar-track">
            <div className="wcf-fx-bar-fill" style={{ width: `${fillPct}%` }} />
          </div>
        </div>
        <div className="wcf-fx-status">
          {waitingList.length > 0 && <span className="wcf-hero-waiting-chip">+{waitingList.length} WAITING</span>}
          <span className={"wcf-fx-pill " + (full ? "full" : "open")}>{full ? "FULL" : `${spotsLeft} LEFT`}</span>
        </div>
        <span className={"wcf-multibook-check" + (alreadyBooked ? " booked" : selected ? " on" : "")}>
          {alreadyBooked || selected ? "✓" : ""}
        </span>
      </div>
      {alreadyBooked && <div className="wcf-multibook-booked-note">Already booked</div>}
    </button>
  );
}

function MultiBookPanel({
  games,
  myId,
  selected,
  onToggle,
  onBookAll,
  onCancel,
  booking,
}: {
  games: GameRow[];
  myId: string;
  selected: Set<string>;
  onToggle: (gameId: string) => void;
  onBookAll: () => void;
  onCancel: () => void;
  booking: boolean;
}) {
  return (
    <div className="wcf-multibook">
      <p className="wcf-multibook-note">Tap the games you want in on, then confirm them all in one go.</p>
      {games.map((g) => (
        <MultiBookRow key={g.id} game={g} myId={myId} selected={selected.has(g.id)} onToggle={() => onToggle(g.id)} />
      ))}
      <div className="wcf-multibook-bar">
        <span className="wcf-multibook-count">{selected.size} selected</span>
        <div className="wcf-multibook-bar-actions">
          <button className="wcf-ghost" onClick={onCancel}>Cancel</button>
          <button className="wcf-batchgen-save" disabled={selected.size === 0 || booking} onClick={onBookAll}>
            {booking ? "Booking…" : `Book ${selected.size || ""} game${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function GameCard({
  game,
  myId,
  isAdmin,
  overdue,
  editing,
  onBook,
  onCancel,
  onMarkPaid,
  onEdit,
  onSave,
  onDelete,
  onOpenPlayerCard,
  onSetStatus,
  weather,
  askConfirm,
  featured,
  countdownText,
}: {
  game: GameRow;
  myId: string;
  isAdmin: boolean;
  overdue: boolean;
  editing: boolean;
  onBook: () => void;
  onCancel: (bookingId: string) => void;
  onMarkPaid: (bookingId: string) => void;
  onEdit: () => void;
  onSave: (patch: Partial<GameRow>) => void;
  onDelete: () => void;
  onOpenPlayerCard: (playerId: string) => void;
  onSetStatus: (bookingId: string, status: PayStatus) => void;
  weather: { code: number; temp: number } | null;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  featured?: boolean;
  countdownText?: string | null;
}) {
  const [form, setForm] = useState<GameRow>(game);
  const [showSheet, setShowSheet] = useState(false);
  const [sheetTab, setSheetTab] = useState<"playing" | "waiting">("playing");

  useEffect(() => setForm(game), [game, editing]);

  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const myBooking = game.bookings.find((b) => b.player_id === myId);
  const full = confirmed.length >= game.max_players;
  const spotsLeft = Math.max(0, game.max_players - confirmed.length);
  const fillPct = Math.min(100, (confirmed.length / game.max_players) * 100);
  const openSheet = () => { setSheetTab("playing"); setShowSheet(true); };
  // Red/amber/green glow (via the .in.<status> CSS below) replaces what used
  // to be a separate "Payment confirmed" card - it tells the viewer their
  // own payment state at a glance without needing to read anything, only
  // when it's their own waiting-list-free booking (not admin viewing
  // someone else's status, and not a waiting-list spot which has no
  // payment state yet).
  const bookedClass = myBooking && !myBooking.waiting ? "in " + myBooking.status : "";

  const editIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
  );

  // Rendered inside whichever card is showing (hero or compact row) so the
  // whole fixture - photo/info, payment nudge, and the book/cancel action -
  // reads as one block instead of a card with a loose button floating
  // beneath it.
  const payStrip = myBooking && !myBooking.waiting && myBooking.status === "unpaid" && (
    <div className="wcf-pay-strip">
      <span className="wcf-pay-strip-text">£{game.price} due</span>
      {PAYMENT_LINK && (
        <a className="wcf-pay-now" href={PAYMENT_LINK} target="_blank" rel="noreferrer">
          Pay Now
        </a>
      )}
      <button className="wcf-pay-paid" onClick={() => onMarkPaid(myBooking.id)}>I&apos;ve paid</button>
    </div>
  );

  const cta = (
    <div className="wcf-card-actions">
      {!myBooking && overdue ? (
        <p className="wcf-overdue-note">Overdue payment — speak to an admin before booking your next game.</p>
      ) : (
        <button
          className={"wcf-book " + (myBooking ? "cancel" : "")}
          disabled={!myBooking && full && waitingList.length >= 10}
          onClick={async () => {
            if (!myBooking) return onBook();
            const ok = myBooking.waiting
              ? await askConfirm("Leave the waiting list?", "You'll lose your place in the queue.", "Leave")
              : await askConfirm("Give up your spot?", `${game.venue} · ${fmtDate(game.date)}. Someone from the waiting list will be offered it.`, "Give up spot");
            if (ok) onCancel(myBooking.id);
          }}
        >
          {myBooking
            ? myBooking.waiting ? "Leave waiting list" : "Give up spot"
            : full ? (waitingList.length >= 10 ? "Waiting list full" : "Join waiting list") : "Grab a spot"}
        </button>
      )}
    </div>
  );

  return (
    <article className={featured ? "wcf-card featured " + bookedClass : ""} style={featured ? undefined : { marginBottom: 18 }}>
      {featured ? (
        <>
          <div className="wcf-hero-top">
            <span className="wcf-hero-date mono">{fmtDate(game.date).replace(",", "").toUpperCase()}</span>
            <span className="wcf-hero-top-right">
              {isAdmin && (
                <button className="wcf-hero-edit-btn" onClick={onEdit} aria-label="Edit fixture">
                  {editIcon}
                </button>
              )}
              <span className={"wcf-status-pill " + (full ? "full" : "open")}>{full ? "Full" : "Open"}</span>
            </span>
          </div>
          <div className="wcf-hero-time">{game.kickoff}</div>
          <div className="wcf-hero-venue-row">
            <span className="wcf-hero-venue combo">
              <span className="wcf-hero-pin">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>
              </span>
              {game.venue}
              {!game.published && <span className="wcf-draft-badge">Draft</span>}
            </span>
            {countdownText && <span className="wcf-hero-countdown combo">⏱ {countdownText}</span>}
          </div>
          <div className="wcf-hero-meta">
            <span>{game.pitch}</span><span className="wcf-hero-dot" /><span>£{game.price}</span>
            {weather && <><span className="wcf-hero-dot" /><span>{weatherIcon(weather.code)} {weather.temp}°C</span></>}
          </div>
          <div className="wcf-hero-divider" />
          <button className="wcf-hero-roster combo tappable" onClick={openSheet} aria-label="View squad">
            <div className="wcf-hero-roster-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div className="wcf-hero-roster-text" style={{ flex: 1 }}>
              <div className="wcf-hero-roster-row">
                <span className="wcf-hero-roster-n2">{confirmed.length}/{game.max_players}</span>
                {waitingList.length > 0 && <span className="wcf-hero-waiting-chip">+{waitingList.length} WAITING</span>}
              </div>
              <div className="wcf-hero-bar-track">
                <div className="wcf-hero-bar-fill" style={{ width: `${fillPct}%` }} />
              </div>
            </div>
            <span className="wcf-avatars" style={{ pointerEvents: "none" }}>
              {confirmed.slice(0, 4).map((b) => {
                const a = avatarFor(b.player.display_name);
                return (
                  <Avatar
                    key={b.id}
                    name={b.player.display_name}
                    avatarUrl={b.player.avatar_url}
                    className="wcf-avatar-chip lg"
                    background={a.gradient}
                  />
                );
              })}
              {confirmed.length > 4 && <span className="wcf-avatar-chip lg more">+{confirmed.length - 4}</span>}
            </span>
            <span className="wcf-hero-roster-chev">›</span>
          </button>
        </>
      ) : (
        <div className={"wcf-fx-row " + bookedClass}>
          <div className="wcf-fx-row-top" onClick={openSheet}>
            <div className="wcf-fx-date">
              <div className="wcf-fx-day">{fmtDate(game.date).split(",")[0]?.toUpperCase()}</div>
              <div className="wcf-fx-num">{new Date(game.date + "T00:00:00").getDate()}</div>
            </div>
            <div className="wcf-fx-divider" />
            <div className="wcf-fx-info">
              <div className="wcf-fx-title">
                {game.kickoff} · {game.venue}
                {!game.published && <span className="wcf-draft-badge">Draft</span>}
              </div>
              <div className="wcf-fx-meta">
                {game.pitch} · £{game.price} · {confirmed.length}/{game.max_players}
                {weather && <> · {weatherIcon(weather.code)} {weather.temp}°C</>}
              </div>
              <div className="wcf-fx-bar-track">
                <div className="wcf-fx-bar-fill" style={{ width: `${fillPct}%` }} />
              </div>
            </div>
            {isAdmin && (
              <button
                className="wcf-hero-edit-btn"
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                aria-label="Edit fixture"
              >
                {editIcon}
              </button>
            )}
            <div className="wcf-fx-status">
              {waitingList.length > 0 && <span className="wcf-hero-waiting-chip">+{waitingList.length} WAITING</span>}
              <span className={"wcf-fx-pill " + (full ? "full" : "open")}>{full ? "FULL" : `${spotsLeft} LEFT`}</span>
            </div>
          </div>
          {payStrip}
          {cta}
        </div>
      )}

      {showSheet && (
        <div className="wcf-sheet-overlay" onClick={() => setShowSheet(false)}>
          <div className="wcf-squad-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wcf-sheet-handle-wrap"><div className="wcf-sheet-handle" /></div>
            <button className="wcf-sheet-close" onClick={() => setShowSheet(false)} aria-label="Close">×</button>
            <div className="wcf-sheet-head">
              <div className="wcf-sheet-kicker">{fmtDate(game.date).replace(",", "").toUpperCase()} · {game.venue.toUpperCase()}</div>
              <div className="wcf-sheet-title">Squad &amp; waiting list</div>
              <div className="wcf-sheet-tabs">
                <button className={"wcf-sheet-tab" + (sheetTab === "playing" ? " on" : "")} onClick={() => setSheetTab("playing")}>
                  Playing · {confirmed.length}
                </button>
                <button className={"wcf-sheet-tab" + (sheetTab === "waiting" ? " on" : "")} onClick={() => setSheetTab("waiting")}>
                  Waiting · {waitingList.length}
                </button>
              </div>
            </div>
            <div className="wcf-sheet-scroll">
              {(sheetTab === "playing" ? confirmed : waitingList).length === 0 && (
                <p className="wcf-empty small">{sheetTab === "playing" ? "No one booked in yet." : "No one on the waiting list."}</p>
              )}
              {(sheetTab === "playing" ? confirmed : waitingList).map((b, i) => {
                const a = avatarFor(b.player.display_name);
                return (
                  <div key={b.id} className="wcf-sheet-row">
                    <button className="wcf-sheet-row-main" onClick={() => onOpenPlayerCard(b.player_id)}>
                      <span className="wcf-sheet-row-n">{String(i + 1).padStart(2, "0")}</span>
                      <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-sheet-row-avatar" background={a.gradient} />
                      <span className="wcf-sheet-row-body">
                        <span className="wcf-sheet-row-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                        <span className="wcf-sheet-row-sub">
                          {sheetTab === "waiting" ? `Joined ${fmtDateTime(b.created_at)}` : `Booked ${fmtDateTime(b.created_at)}`}
                        </span>
                      </span>
                    </button>
                    {isAdmin && sheetTab === "playing" && b.status !== "confirmed" && (
                      <button
                        className="wcf-sheet-confirm"
                        onClick={() => onSetStatus(b.id, "confirmed")}
                      >
                        Confirm
                      </button>
                    )}
                    {isAdmin && sheetTab === "playing" && b.status === "confirmed" && <StatusBadge status={b.status} />}
                    {isAdmin && sheetTab === "waiting" && (
                      <button
                        className="wcf-sheet-remove"
                        onClick={async () => {
                          if (await askConfirm(`Remove ${b.player.display_name} from the waiting list?`, "They'll need to rejoin if they want a spot again.", "Remove")) {
                            onCancel(b.id);
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Confirmed/pending need no card at all now - the red/amber/green
          glow on the card itself (via the .in.<status> classes below)
          already says "you owe money" / "awaiting confirmation" / "you're
          sorted" at a glance. Unpaid still gets a compact action strip
          since there's a real action to take, just not a full card.
          For the compact row, payStrip/cta render inside .wcf-fx-row
          above instead so the whole fixture reads as one card; the hero
          already is one card, so they render here. */}
      {featured && payStrip}
      {featured && cta}

      {isAdmin && editing && (
        <div className="wcf-edit">
          <label>
            Kickoff
            <input type="time" value={form.kickoff} onChange={(e) => setForm({ ...form, kickoff: e.target.value })} />
          </label>
          <label>
            Date
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </label>
          <label>
            Venue
            <input value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </label>
          <label>
            Format
            <input value={form.pitch} onChange={(e) => setForm({ ...form, pitch: e.target.value })} />
          </label>
          <label>
            Price £
            <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Pitch cost £
            <input type="number" value={form.pitch_cost} onChange={(e) => setForm({ ...form, pitch_cost: Number(e.target.value) || 0 })} />
          </label>
          <label>
            Max players
            <input
              type="number"
              max={MAX_SPOTS}
              value={form.max_players}
              onChange={(e) => setForm({ ...form, max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
            />
          </label>
          <div className="wcf-edit-actions">
            <button className="wcf-ghost" onClick={onEdit}>Close</button>
            <button
              className="wcf-ghost danger"
              onClick={async () => {
                if (await askConfirm(`Delete this fixture?`, `${game.venue} on ${fmtDate(game.date)} — this removes it and everyone's bookings.`, "Delete")) {
                  onDelete();
                }
              }}
            >
              Delete
            </button>
          </div>
          <button className="wcf-save" onClick={() => onSave(form)}>
            {game.published ? "Save changes" : "Confirm & post fixture"}
          </button>
        </div>
      )}
    </article>
  );
}

const css = `
.wcf-root{
  --bg:#0d0d1a; --panel:#1e293b; --panel2:#334155;
  --line:rgba(148,163,184,.14); --white:#F5F6F8; --dim:#94a3b8;
  --red:#e63946; --red-hi:#f0525e; --blue:#2E74CC; --green:#22c55e; --amber:#eab308;
  --mono:ui-monospace,"SF Mono","Roboto Mono",Menlo,monospace;
  --display:var(--font-sora),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --sans:var(--font-inter),-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  max-width:520px;margin:0 auto;height:100vh;height:100dvh;overflow:hidden;background:var(--bg);
  color:var(--white);font-family:var(--sans);display:flex;flex-direction:column;
  border-left:1px solid var(--line);border-right:1px solid var(--line);
}
.wcf-root *{box-sizing:border-box}
.wcf-root path{stroke-linecap:round}

.wcf-splash{position:relative;flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.wcf-splash-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 38%;
  animation:wcfSplashZoom 9s ease-in-out infinite alternate}
.wcf-splash-scrim{position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(5,5,10,.55) 0%,rgba(5,5,10,.15) 30%,rgba(5,5,10,.35) 55%,rgba(5,5,10,.92) 82%,var(--bg) 100%),
    radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%)}
.wcf-splash-body{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
  padding:0 24px 15%;text-align:center}
.wcf-splash-est{font-family:var(--mono);font-weight:600;font-size:10px;letter-spacing:3px;color:var(--red-hi);margin-bottom:10px;opacity:.9}
.wcf-splash-wordmark{font-family:var(--display);font-weight:800;font-size:34px;letter-spacing:-.5px;line-height:1.15;
  color:var(--white);text-shadow:0 4px 20px rgba(0,0,0,.6)}
.wcf-splash-wordmark .dim{color:rgba(245,246,248,.4)}
.wcf-splash-loader{margin-top:26px;display:flex;align-items:center;justify-content:center;gap:7px}
.wcf-splash-dot{width:6px;height:6px;border-radius:50%;background:rgba(245,246,248,.35);animation:wcfSplashDot 1.2s ease-in-out infinite}
.wcf-splash-dot:nth-child(2){animation-delay:.15s}
.wcf-splash-dot:nth-child(3){animation-delay:.3s}
@keyframes wcfSplashZoom{from{transform:scale(1.05)}to{transform:scale(1.16)}}
@keyframes wcfSplashDot{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion: reduce){
  .wcf-splash-photo{animation:none;transform:scale(1.08)}
  .wcf-splash-dot{animation:none;opacity:.7}
}

.wcf-signin{position:relative;flex:1;overflow-y:auto;display:flex;flex-direction:column;background:var(--bg)}
.wcf-signin-photo{position:absolute;left:0;right:0;top:0;width:100%;height:72%;object-fit:cover;object-position:50% 55%}
.wcf-signin-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(13,13,26,.6) 0%,rgba(13,13,26,.34) 20%,rgba(13,13,26,.6) 52%,rgba(13,13,26,.86) 66%,var(--bg) 80%)}
.wcf-signin-head{position:relative;padding:36px 22px 0;flex:0 0 auto}
.wcf-signin-brand-row{display:flex;align-items:center;gap:10px}
.wcf-signin-crest{display:block;width:34px;height:34px;border-radius:10px;overflow:hidden;border:1px solid rgba(230,57,70,.4);flex:0 0 auto;box-shadow:0 2px 10px rgba(0,0,0,.5)}
.wcf-signin-crest img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 43%}
.wcf-signin-est{font-weight:800;font-size:9.5px;letter-spacing:2.6px;color:var(--red-hi)}
.wcf-signin-wordmark{font-family:var(--display);font-weight:800;font-size:52px;line-height:.86;letter-spacing:-1px;color:var(--white);margin-top:22px;text-shadow:0 6px 30px rgba(0,0,0,.6)}
.wcf-signin-wordmark-dim1{font-family:var(--display);color:rgba(245,246,248,.34)}
.wcf-signin-wordmark-dim2{font-family:var(--display);color:rgba(245,246,248,.16)}
.wcf-signin-bottom{position:relative;flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:0 22px 40px;box-sizing:border-box;gap:15px}
.wcf-signin-steps{display:flex;gap:8px;align-items:center}
.wcf-signin-step-bar{flex:1;height:3px;border-radius:2px;background:rgba(148,163,184,.2)}
.wcf-signin-step-bar.on{background:linear-gradient(90deg,var(--red),rgba(230,57,70,.4))}
.wcf-signin-step-label{font:600 9.5px ui-monospace,Menlo,monospace;letter-spacing:1.4px;color:var(--dim);white-space:nowrap}
.wcf-signin-form2{display:flex;flex-direction:column;gap:11px;margin:0}
.wcf-signin-sub{color:var(--dim);font-size:12.5px;line-height:1.55;margin:0}
.wcf-signin-email-pill{display:flex;gap:10px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line);border-radius:14px;padding:6px 6px 6px 14px;align-items:center;box-shadow:0 18px 38px -30px rgba(0,0,0,.9)}
.wcf-signin-email-pill input{flex:1;min-width:0;background:transparent;border:none;color:var(--white);padding:11px 0;font-size:15px;font-family:var(--sans)}
.wcf-signin-email-pill button{background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5));color:#fff;border:none;padding:12px 16px;border-radius:11px;font-weight:800;font-size:12.5px;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.wcf-signin-email-pill button:disabled{opacity:.5;cursor:not-allowed}
.wcf-signin-cells-wrap{position:relative}
.wcf-signin-cells{display:flex;gap:7px;justify-content:space-between}
.wcf-signin-cell{flex:1;height:56px;border-radius:13px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:21px;color:var(--white);box-shadow:0 14px 30px -24px rgba(0,0,0,.9)}
.wcf-signin-cell.active{border-color:rgba(240,82,94,.6)}
.wcf-signin-hidden-input{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:none;background:transparent;font-size:16px;caret-color:transparent;padding:0;box-sizing:border-box;cursor:text}
.wcf-signin-cta{background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5));color:#fff;border:none;padding:15px;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 12px 28px -14px rgba(230,57,70,.9)}
.wcf-signin-cta:disabled{opacity:.5;cursor:not-allowed;box-shadow:none}
.wcf-signin-error{background:rgba(230,57,70,.1);border:1px solid rgba(230,57,70,.3);border-radius:10px;padding:10px 12px;color:var(--red-hi);font-size:12px;line-height:1.45;margin:0}
.wcf-signin-alt{background:none;border:none;color:var(--dim);font-weight:600;font-size:12px;padding:5px;cursor:pointer;text-decoration:underline;font-family:var(--sans);align-self:flex-start}
.wcf-signin-alt:disabled{opacity:.4;cursor:not-allowed;text-decoration:none}
.wcf-privacy-note{color:var(--dim);font-size:11px;max-width:280px;margin:0;line-height:1.5;opacity:.8}

.wcf-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;background:rgba(10,26,52,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.wcf-brand{display:flex;align-items:center;gap:11px;background:none;border:none;padding:0;margin:0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.wcf-logo{display:block;width:42px;height:42px;flex:0 0 auto;border-radius:11px;overflow:hidden;
  border:1px solid rgba(230,57,70,.4);box-shadow:0 2px 10px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.05)}
.wcf-logo img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 43%}
.wcf-wordmark{font-weight:900;font-size:22px;letter-spacing:1px;line-height:.9;
  color:var(--white);text-shadow:0 1px 0 rgba(0,0,0,.4)}
.wcf-wordmark-sub{font-weight:800;font-size:10px;letter-spacing:2.5px;color:var(--red-hi);margin-top:3px}
.wcf-role{display:flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);
  color:var(--dim);padding:8px 13px;border-radius:999px;font-size:12px;font-weight:800;cursor:pointer;
  font-family:var(--mono);letter-spacing:.5px;transition:.15s;max-width:140px;overflow:hidden}
.wcf-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wcf-role .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.wcf-role.admin .dot{background:var(--green)}
.wcf-role.on{color:#fff;border-color:var(--red)}

.wcf-main{flex:1;padding:14px 14px 92px;overflow-y:auto}
.wcf-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:4px 2px 14px}
.wcf-heading h2{margin:0;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim)}
.wcf-heading-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.wcf-addbtn{display:inline-flex;align-items:center;gap:6px;background:var(--red);color:#fff;border:none;padding:8px 14px;border-radius:999px;font-family:var(--display);font-weight:800;font-size:12px;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.wcf-addbtn svg{flex:0 0 auto}
.wcf-addbtn.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}
.wcf-empty{color:var(--dim);text-align:center;padding:40px 0;font-size:14px}
.wcf-empty.small{padding:8px 0;font-size:12px}

.wcf-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;margin-bottom:18px;position:relative;overflow:hidden}
.wcf-card.featured{
  background-image:linear-gradient(180deg,rgba(8,10,14,.15) 0%,rgba(8,10,14,.5) 55%,rgba(6,8,11,.88) 100%),url('/pitch-night.jpg');
  background-size:cover;background-position:center 30%;border-radius:24px;padding:24px;margin-bottom:22px;
}
/* Payment-status glow (own booking only): red=unpaid, amber=pending,
   green=confirmed. Box-shadow, not an inner gradient div, since the
   card's own overflow:hidden (for the photo's rounded corners) would
   clip an inner div to a tint instead of a halo. */
.wcf-card.featured.in.unpaid{border-color:rgba(230,57,70,.45);box-shadow:0 0 0 1px rgba(230,57,70,.15),0 0 60px 6px rgba(230,57,70,.28)}
.wcf-card.featured.in.pending{border-color:rgba(234,179,8,.45);box-shadow:0 0 0 1px rgba(234,179,8,.15),0 0 60px 6px rgba(234,179,8,.28)}
.wcf-card.featured.in.confirmed{border-color:rgba(34,197,94,.45);box-shadow:0 0 0 1px rgba(34,197,94,.15),0 0 60px 6px rgba(34,197,94,.28)}
.wcf-hero-top{display:flex;justify-content:space-between;align-items:flex-start}
.wcf-hero-top-right{display:flex;align-items:center;gap:8px}
.wcf-hero-date{font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#B7BDD0}
.wcf-hero-date.mono{font-family:var(--mono);letter-spacing:1.6px}
.wcf-hero-time{font-family:var(--display);font-size:52px;font-weight:900;letter-spacing:-.03em;line-height:1;margin-top:6px}
.wcf-hero-venue{display:flex;align-items:center;gap:7px;font-size:16px;font-weight:800;margin-top:16px}
.wcf-hero-venue.combo{margin-top:0}
.wcf-hero-venue-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:16px}
.wcf-hero-pin{width:22px;height:22px;border-radius:7px;background:rgba(46,116,204,.22);border:1px solid rgba(46,116,204,.4);display:grid;place-items:center;color:#7fb0ec;flex:0 0 auto}
.wcf-hero-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:#A6ACC0;margin-top:6px}
.wcf-hero-dot{width:3px;height:3px;border-radius:50%;background:#4A5170}
.wcf-hero-countdown{font-size:11.5px;font-weight:700;color:var(--white);opacity:.85;margin-top:10px}
.wcf-hero-countdown.combo{margin-top:0;font-family:var(--mono);font-size:11px;letter-spacing:.4px;white-space:nowrap;color:var(--red-hi);opacity:1;font-weight:800}
.wcf-hero-divider{height:1px;background:rgba(255,255,255,.1);margin:16px 0}
.wcf-hero-roster{display:flex;align-items:center;gap:12px}
.wcf-hero-roster.tappable{width:100%;background:none;border:none;padding:0;cursor:pointer;text-align:left;font:inherit;color:inherit}
.wcf-hero-roster-icon{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid var(--line);display:grid;place-items:center;flex:0 0 auto}
.wcf-hero-roster-text{display:flex;flex-direction:column;flex:0 0 auto}
.wcf-hero-roster-row{display:flex;align-items:center;gap:8px}
.wcf-hero-roster-n2{font-family:var(--display);font-weight:800;font-size:15px;color:var(--white)}
.wcf-hero-waiting-chip{font-family:var(--sans);font-weight:800;font-size:8.5px;letter-spacing:.6px;color:#f5d97a;background:rgba(234,179,8,.16);border:1px solid rgba(234,179,8,.4);padding:3px 7px;border-radius:999px;white-space:nowrap}
.wcf-hero-bar-track{height:4px;border-radius:3px;background:rgba(255,255,255,.12);margin-top:7px;overflow:hidden;width:100%}
.wcf-hero-bar-fill{height:100%;background:linear-gradient(90deg,var(--red),rgba(230,57,70,.5))}
.wcf-hero-roster-chev{color:var(--dim);font-size:18px;flex:0 0 auto}
.wcf-hero-edit-btn{width:26px;height:26px;border-radius:9px;background:rgba(13,13,26,.55);border:1px solid rgba(148,163,184,.25);color:var(--white);display:grid;place-items:center;cursor:pointer;backdrop-filter:blur(6px);flex:0 0 auto}
.wcf-avatar-chip.lg{width:36px;height:36px;font-size:12px;margin-left:-10px}
.wcf-card.featured .wcf-book{padding:16px 19px;font-size:14px;border-radius:14px}
.wcf-venue{font-weight:700;font-size:13.5px}
.wcf-draft-badge{display:inline-block;margin-left:8px;background:rgba(234,179,8,.18);color:var(--amber);border:1px solid rgba(234,179,8,.4);font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:20px;vertical-align:middle}
.wcf-pitch{font-size:11px;color:var(--dim);font-family:var(--sans)}
.wcf-status-pill{display:inline-block;font-family:var(--display);font-size:10px;font-weight:800;letter-spacing:.06em;padding:5px 12px;border-radius:20px;border:1.5px solid;white-space:nowrap}
.wcf-status-pill.full{color:#fff;border-color:var(--red);background:var(--red)}
.wcf-status-pill.open{color:var(--green);border-color:var(--green);background:transparent}
.wcf-avatars{display:flex;background:none;border:none;padding:0;cursor:pointer}
.wcf-avatar-chip{width:24px;height:24px;border-radius:50%;border:2px solid var(--panel);margin-left:-8px;display:grid;place-items:center;font-size:9px;font-weight:800;color:#fff;background:var(--panel2);object-fit:cover}
.wcf-avatar-chip:first-child{margin-left:0}
.wcf-avatar-chip.more{color:var(--dim);background:var(--panel2)}

.wcf-fx-row{position:relative;display:flex;flex-direction:column;gap:12px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line);border-radius:16px;padding:13px 14px;margin-bottom:9px;box-shadow:0 18px 38px -34px rgba(0,0,0,.9)}
.wcf-fx-row.in.unpaid{border-color:rgba(230,57,70,.4);box-shadow:0 18px 38px -34px rgba(0,0,0,.9),0 0 34px 2px rgba(230,57,70,.22)}
.wcf-fx-row.in.pending{border-color:rgba(234,179,8,.4);box-shadow:0 18px 38px -34px rgba(0,0,0,.9),0 0 34px 2px rgba(234,179,8,.22)}
.wcf-fx-row.in.confirmed{border-color:rgba(34,197,94,.4);box-shadow:0 18px 38px -34px rgba(0,0,0,.9),0 0 34px 2px rgba(34,197,94,.22)}
.wcf-fx-row-top{display:flex;align-items:center;gap:13px;cursor:pointer}
.wcf-fx-row .wcf-pay-strip,.wcf-fx-row .wcf-card-actions{margin:0}
.wcf-fx-status{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto}
.wcf-fx-date{width:44px;flex:0 0 auto;text-align:center}
.wcf-fx-day{font-family:var(--mono);font-weight:600;font-size:9px;letter-spacing:1.2px;color:var(--dim)}
.wcf-fx-num{font-family:var(--display);font-weight:800;font-size:22px;line-height:1.15;color:var(--white)}
.wcf-fx-divider{width:1px;height:34px;background:var(--line);flex:0 0 auto}
.wcf-fx-info{flex:1;min-width:0}
.wcf-fx-title{font-weight:700;font-size:13.5px;color:var(--white)}
.wcf-fx-meta{font-size:11px;color:var(--dim);margin-top:3px}
.wcf-fx-bar-track{height:3px;border-radius:2px;background:rgba(148,163,184,.16);margin-top:8px;overflow:hidden}
.wcf-fx-bar-fill{height:100%;background:linear-gradient(90deg,var(--red),rgba(230,57,70,.45))}
.wcf-fx-pill{flex:0 0 auto;font-family:var(--sans);font-weight:800;font-size:9.5px;letter-spacing:.5px;padding:5px 9px;border-radius:999px;white-space:nowrap}
.wcf-fx-pill.full{background:rgba(230,57,70,.16);border:1px solid rgba(230,57,70,.4);color:var(--red-hi)}
.wcf-fx-pill.open{background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.35);color:var(--green)}

.wcf-multibook-entry{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;background:none;
  border:1px dashed var(--line);color:var(--dim);padding:12px;border-radius:14px;font-weight:700;font-size:12.5px;
  font-family:var(--sans);cursor:pointer;margin-bottom:12px}
.wcf-multibook-note{font-size:12px;color:var(--dim);line-height:1.5;margin:0 0 12px;padding:0 2px}
.wcf-multibook-row{display:flex;flex-direction:column;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}
.wcf-multibook-row:disabled{cursor:default;opacity:.55}
.wcf-multibook-row.selected{border-color:rgba(230,57,70,.5);box-shadow:0 18px 38px -34px rgba(0,0,0,.9),0 0 34px 2px rgba(230,57,70,.22)}
.wcf-multibook-row .wcf-fx-row-top{cursor:inherit}
.wcf-multibook-check{flex:0 0 auto;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line);
  display:grid;place-items:center;font-size:13px;font-weight:800;color:transparent;margin-left:6px}
.wcf-multibook-check.on{background:var(--red);border-color:var(--red);color:#fff}
.wcf-multibook-check.booked{background:var(--green);border-color:var(--green);color:#fff}
.wcf-multibook-booked-note{font-size:11px;font-weight:700;color:var(--green)}
.wcf-multibook-bar{position:sticky;bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-top:6px;padding:12px 14px;border-radius:16px;background:linear-gradient(180deg,rgba(30,41,59,.98),rgba(19,22,38,1));
  border:1px solid var(--line);box-shadow:0 20px 40px -20px rgba(0,0,0,.9)}
.wcf-multibook-count{font-size:12.5px;font-weight:700;color:var(--dim);white-space:nowrap}
.wcf-multibook-bar-actions{display:flex;gap:8px}
.wcf-multibook-bar-actions .wcf-batchgen-save{padding:10px 16px}

.wcf-sheet-overlay{position:fixed;inset:0;background:rgba(6,7,14,.6);z-index:60;display:flex;align-items:flex-end;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.wcf-squad-sheet{position:relative;width:100%;max-width:520px;margin:0 auto;max-height:82vh;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(30,41,59,.99),rgba(19,22,38,1));border-top:1px solid rgba(148,163,184,.2);border-radius:24px 24px 0 0;box-shadow:0 -18px 48px -20px rgba(0,0,0,.95)}
.wcf-sheet-handle-wrap{padding:10px 0 0;display:flex;justify-content:center;flex:0 0 auto}
.wcf-sheet-handle{width:40px;height:4px;border-radius:3px;background:rgba(148,163,184,.3)}
.wcf-sheet-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;background:rgba(148,163,184,.1);border:1px solid var(--line);color:var(--dim);font-size:18px;line-height:1;cursor:pointer;display:grid;place-items:center;z-index:1}
.wcf-sheet-head{padding:14px 20px 0;flex:0 0 auto}
.wcf-sheet-kicker{font-family:var(--mono);font-weight:600;font-size:10px;letter-spacing:1.8px;color:var(--dim)}
.wcf-sheet-title{font-family:var(--display);font-weight:700;font-size:19px;color:var(--white);margin-top:7px}
.wcf-sheet-tabs{display:flex;gap:8px;margin-top:14px}
.wcf-sheet-tab{flex:1;background:rgba(148,163,184,.08);border:1px solid var(--line);color:var(--dim);font-family:var(--sans);font-weight:800;font-size:10px;letter-spacing:1.2px;padding:10px;border-radius:11px;cursor:pointer}
.wcf-sheet-tab.on{background:rgba(230,57,70,.16);border-color:rgba(230,57,70,.4);color:#f8b3b8}
.wcf-sheet-scroll{flex:1;overflow-y:auto;padding:14px 20px 30px;display:flex;flex-direction:column;gap:7px}
.wcf-sheet-row{display:flex;align-items:center;gap:8px;background:rgba(13,13,26,.45);border:1px solid var(--line);border-radius:14px;padding:6px}
.wcf-sheet-row-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;background:none;border:none;padding:5px 6px;cursor:pointer;text-align:left;font:inherit;color:inherit}
.wcf-sheet-row-n{font-family:var(--mono);font-weight:600;font-size:10px;color:var(--dim);width:16px;flex:0 0 auto}
.wcf-sheet-row-avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-family:var(--mono);font-weight:700;font-size:11px;color:#fff;flex:0 0 auto;object-fit:cover}
.wcf-sheet-row-body{flex:1;min-width:0;display:flex;flex-direction:column}
.wcf-sheet-row-name{font-weight:700;font-size:13.5px;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-sheet-row-sub{font-size:10.5px;color:var(--dim);margin-top:3px}
.wcf-sheet-confirm{flex:0 0 auto;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.34);color:#86efac;font-weight:800;font-size:10.5px;padding:8px 11px;border-radius:10px;cursor:pointer;margin-right:6px}
.wcf-sheet-remove{flex:0 0 auto;background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;margin-right:6px}
.wcf-sheet-remove:hover{color:var(--red-hi)}

.wcf-pay-strip{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:10px 10px 10px 14px;border-radius:12px;background:rgba(230,57,70,.1);border:1px solid rgba(230,57,70,.3)}
.wcf-pay-strip-text{flex:1;min-width:0;font-weight:700;font-size:12px;color:var(--red-hi)}
.wcf-pay-now,.wcf-pay-paid{background:var(--red);color:#fff;border:none;padding:9px 14px;border-radius:10px;font-weight:800;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}
.wcf-pay-now{background:var(--panel2);border:1px solid var(--line);color:var(--white)}

.wcf-status-badge{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.3px;padding:3px 8px;border-radius:999px;background:var(--panel2);color:var(--dim);white-space:nowrap;flex:0 0 auto}
.wcf-status-badge.unpaid{color:var(--dim);border:1px solid var(--line)}
.wcf-status-badge.pending{color:var(--amber);border:1px solid rgba(224,167,51,.4)}
.wcf-status-badge.confirmed{color:var(--green);border:1px solid rgba(51,169,87,.4)}

.wcf-toast{position:sticky;top:0;z-index:6;background:var(--green);color:#04140a;font-weight:800;font-size:13px;text-align:center;padding:10px 14px}
.wcf-toast.error{background:var(--red);color:#fff}

.wcf-card-actions{display:flex;align-items:center;gap:10px;margin-top:16px}
.wcf-book{flex:1;background:var(--red);color:#fff;border:none;padding:13px 16px;border-radius:12px;font-family:var(--display);font-weight:800;font-size:13.5px;letter-spacing:.01em;cursor:pointer;transition:.15s}
.wcf-book:hover{background:var(--red-hi)}
.wcf-book.cancel{background:transparent;color:var(--white);border:1px solid var(--line)}
.wcf-book:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px 12px;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer}
.wcf-ghost.danger:hover{color:var(--red-hi);border-color:rgba(230,57,70,.5)}

.wcf-edit{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wcf-edit label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-edit input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-edit-actions{grid-column:1/-1;display:flex;gap:8px}
.wcf-save{grid-column:1/-1;background:var(--green);color:#04140a;border:none;padding:11px;border-radius:9px;font-weight:800;cursor:pointer;font-size:13px}
.wcf-save-red{width:100%;min-height:46px;padding:13px;border-radius:12px;cursor:pointer;font-weight:800;font-size:12px;color:#fff;border:1px solid rgba(230,57,70,.5);background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5))}
.wcf-save-amber{width:100%;min-height:48px;padding:14px;border-radius:14px;cursor:pointer;font-weight:800;font-size:13px;color:#fff;border:1px solid rgba(234,179,8,.5);background:linear-gradient(135deg,var(--amber),rgba(234,179,8,.45))}
.wcf-console-section{display:flex;align-items:center;gap:10px;padding:26px 2px 12px}
.wcf-console-section:first-child{padding-top:4px}
.wcf-console-section-label{font-family:var(--sans);font-weight:700;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}
.wcf-console-section-rule{flex:1;height:1px;background:rgba(148,163,184,.14)}
.wcf-console-section-meta{font-family:var(--sans);font-weight:700;font-size:10px;letter-spacing:.08em;color:#64748b;white-space:nowrap}
.wcf-console-section-meta.warn{color:var(--red-hi)}
.wcf-month-head{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:16px 2px 9px;display:flex;align-items:center;gap:9px}
.wcf-month-head:first-child{margin-top:2px}
.wcf-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 2px 12px}
.wcf-month-head:after{content:"";flex:1;height:1px;background:var(--line)}
.wcf-glance-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:6px}
.wcf-glance-card{display:block;text-align:left;padding:14px;border-radius:18px;width:100%;font:inherit;color:inherit;cursor:default;background:linear-gradient(180deg,rgba(30,41,59,.72),rgba(19,22,38,.9));border:1px solid var(--line);transition:filter .12s ease}
button.wcf-glance-card{cursor:pointer}
button.wcf-glance-card:disabled{cursor:default}
.wcf-glance-card.wide{grid-column:1/-1}
.wcf-glance-card.amber{background:linear-gradient(155deg,rgba(234,179,8,.15),rgba(19,22,38,.96) 62%);border-color:rgba(234,179,8,.35);box-shadow:0 16px 34px -26px rgba(234,179,8,.4)}
.wcf-glance-card.red{background:linear-gradient(155deg,rgba(240,82,94,.15),rgba(19,22,38,.96) 62%);border-color:rgba(240,82,94,.35);box-shadow:0 16px 34px -26px rgba(240,82,94,.4)}
.wcf-glance-card.blue{background:linear-gradient(155deg,rgba(46,116,204,.15),rgba(19,22,38,.96) 62%);border-color:rgba(46,116,204,.35);box-shadow:0 16px 34px -26px rgba(46,116,204,.4)}
.wcf-glance-card.crimson{background:linear-gradient(155deg,rgba(230,57,70,.15),rgba(19,22,38,.96) 62%);border-color:rgba(230,57,70,.35);box-shadow:0 16px 34px -26px rgba(230,57,70,.4)}
.wcf-glance-card.expandable{padding-bottom:0}
.wcf-glance-expand{margin:10px -14px 0;padding:7px 14px 9px;background:var(--blue);color:#fff;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;text-align:center;border-radius:0 0 17px 17px}
.wcf-glance-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.wcf-glance-tile{flex:none;width:26px;height:26px;border-radius:9px;display:grid;place-items:center;font-size:12px;font-weight:800;background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.2);color:var(--dim)}
.wcf-glance-card.amber .wcf-glance-tile{background:rgba(234,179,8,.15);border-color:rgba(234,179,8,.3);color:var(--amber)}
.wcf-glance-card.red .wcf-glance-tile{background:rgba(240,82,94,.15);border-color:rgba(240,82,94,.3);color:var(--red-hi)}
.wcf-glance-card.blue .wcf-glance-tile{background:rgba(46,116,204,.15);border-color:rgba(46,116,204,.3);color:var(--blue)}
.wcf-glance-card.crimson .wcf-glance-tile{background:rgba(230,57,70,.15);border-color:rgba(230,57,70,.3);color:var(--red)}
.wcf-glance-card.clear .wcf-glance-tile{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.3);color:var(--green)}
.wcf-glance-num{display:block;font-family:var(--display);font-size:27px;font-weight:800;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums;color:#f8fafc}
.wcf-glance-num.small{font-size:15px}
.wcf-glance-card.clear .wcf-glance-num{color:var(--dim);font-size:15px}
.wcf-glance-label{margin-top:10px;font-family:var(--sans);font-weight:700;font-size:11.5px;line-height:1.3;color:#f1f5f9}
.wcf-glance-card.clear .wcf-glance-label{color:var(--dim)}
.wcf-glance-names{margin-top:6px;font-size:10.5px;line-height:1.4;color:#64748b}
.wcf-overdue-banner{background:linear-gradient(135deg,rgba(230,57,70,.18),rgba(230,57,70,.06));border:1px solid rgba(230,57,70,.4);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5;color:var(--white)}
.wcf-overdue-banner strong{color:var(--red-hi)}
.wcf-overdue-note{font-size:12px;color:var(--red-hi);font-weight:700;text-align:center;margin:0;flex:1}
.wcf-update-banner{display:block;width:100%;background:var(--amber);color:#241a02;border:none;padding:10px 14px;font-size:12.5px;font-weight:800;text-align:center;cursor:pointer;font-family:var(--sans)}
.wcf-offline-banner{display:block;width:100%;background:var(--panel2);color:var(--dim);border-bottom:1px solid var(--line);padding:10px 14px;font-size:12.5px;font-weight:700;text-align:center}
.wcf-nudge-banner{background:linear-gradient(135deg,rgba(46,116,204,.18),rgba(46,116,204,.06));border:1px solid rgba(46,116,204,.4);border-radius:14px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wcf-nudge-banner strong{font-size:13px;color:var(--white)}
.wcf-nudge-banner p{font-size:12px;color:var(--dim);margin:3px 0 0;line-height:1.4}
.wcf-nudge-actions{display:flex;gap:8px;flex-shrink:0}
.wcf-nudge-actions button{font-size:12px;font-weight:800;padding:8px 14px;border-radius:20px;border:none;background:var(--blue);color:#fff;cursor:pointer}
.wcf-nudge-actions button.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}
.wcf-tab{border-radius:16px;overflow:hidden;margin-bottom:9px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line)}
.wcf-tab.claiming{border-color:rgba(234,179,8,.28)}
.wcf-tab-summary{width:100%;min-height:52px;display:flex;align-items:center;gap:10px;background:none;border:none;color:var(--white);padding:12px 13px;cursor:pointer;text-align:left}
.wcf-tab-avatar{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;color:#f8fafc;background:linear-gradient(150deg,var(--red),#7f1d1d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);object-fit:cover}
.wcf-tab-summary-body{flex:1;min-width:0;text-align:left}
.wcf-tab-summary-name{font-weight:800;font-size:13px;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-tab-summary-sub{margin-top:4px;font-size:10.5px;color:var(--dim)}
.wcf-tab-claimed{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;color:#f5d97a;background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.36);padding:5px 8px;border-radius:20px}
.wcf-tab-amount{font-family:var(--display);font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;color:var(--red-hi);flex:none}
.wcf-tab-detail{padding:0 13px 13px}
.wcf-tab-line{display:flex;align-items:center;gap:9px;padding-top:9px;border-top:1px solid rgba(148,163,184,.12)}
.wcf-tab-line-desc{flex:1;min-width:0}
.wcf-tab-line-venue{font-weight:600;font-size:12px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-tab-line-date{margin-top:4px;font-size:10.5px;color:#64748b}
.wcf-tab-line-price{flex:none;font-family:var(--mono);font-weight:600;font-size:12px;color:#cbd5e1}
.wcf-tab-line-remove{flex:none;width:36px;height:36px;border-radius:10px;background:rgba(240,82,94,.1);border:1px solid rgba(240,82,94,.3);color:var(--red-hi);font-size:16px;cursor:pointer;line-height:1;display:grid;place-items:center}
.wcf-tab-nudge{width:100%;margin-top:12px;min-height:44px;padding:12px;border-radius:12px;background:rgba(46,116,204,.14);border:1px solid rgba(46,116,204,.36);color:#7fb0ec;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-pending-detail{margin:10px 0 14px;padding:14px;border-radius:18px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid rgba(234,179,8,.3)}
.wcf-pending-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.wcf-pending-head span{font-family:var(--sans);font-weight:800;font-size:10px;letter-spacing:.16em;color:#f5d97a}
.wcf-pending-head-rule{flex:1;height:1px;background:rgba(234,179,8,.2)}
.wcf-pending-game{margin-bottom:14px}
.wcf-pending-game:last-child{margin-bottom:0}
.wcf-pending-game-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:9px}
.wcf-pending-game-venue{font-family:var(--display);font-weight:700;font-size:12px;color:#f1f5f9}
.wcf-pending-game-date{font-size:10.5px;color:#64748b;white-space:nowrap}
.wcf-pending-row{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:11px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12);margin-bottom:7px}
.wcf-pending-row:last-child{margin-bottom:0}
.wcf-pending-dot{flex:none;width:7px;height:7px;border-radius:50%}
.wcf-pending-dot.paid{background:var(--amber)}
.wcf-pending-dot.unpaid{background:var(--red-hi)}
.wcf-pending-dot.confirmed{background:var(--green)}
.wcf-pending-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:12px;color:#f1f5f9}
.wcf-pending-status{flex:none;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 8px;border-radius:20px}
.wcf-pending-status.paid{color:#f5d97a;background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.34)}
.wcf-pending-status.unpaid{color:var(--dim);background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.2)}
.wcf-pending-status.confirmed{color:#86efac;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.34)}
.wcf-pending-confirm{flex:none;min-height:40px;padding:0 12px;border-radius:11px;cursor:pointer;font-weight:700;font-size:10.5px;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.34);color:#86efac}
.wcf-admin-approve-override{flex:none;min-height:36px;padding:0 11px;border-radius:11px;background:transparent;border:1px solid rgba(230,57,70,.5);color:var(--red-hi);font-weight:800;font-size:10.5px;cursor:pointer}
.wcf-admin-game{border-radius:18px;overflow:hidden;margin-bottom:10px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line);box-shadow:0 18px 38px -30px rgba(0,0,0,.9)}
.wcf-admin-game.open{border-color:rgba(148,163,184,.3)}
.wcf-admin-game-head{width:100%;min-height:56px;display:flex;align-items:center;gap:11px;background:none;border:none;color:var(--white);padding:14px;cursor:pointer;text-align:left}
.wcf-admin-game-date-tile{flex:none;width:46px;height:46px;border-radius:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(13,13,26,.7);border:1px solid rgba(148,163,184,.16)}
.wcf-admin-game.upcoming .wcf-admin-game-date-tile{border-color:rgba(230,57,70,.32)}
.wcf-admin-game-day{font-family:var(--display);font-weight:800;font-size:15px;color:#f8fafc}
.wcf-admin-game-month{margin-top:3px;font-weight:700;font-size:8.5px;letter-spacing:.12em;color:var(--dim)}
.wcf-admin-game-info{flex:1;min-width:0;text-align:left}
.wcf-admin-game-venue{font-family:var(--display);font-weight:800;font-size:13.5px;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-admin-game-date{margin-top:12px;font-size:11px;color:var(--dim)}
.wcf-admin-game-badge{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;padding:6px 9px;border-radius:20px;white-space:nowrap}
.wcf-admin-game-badge.green{color:var(--green);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35)}
.wcf-admin-game-badge.amber{color:var(--amber);background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.35)}
.wcf-admin-game-badge.blue{color:var(--blue);background:rgba(46,116,204,.12);border:1px solid rgba(46,116,204,.35)}
.wcf-admin-game-body{padding:0 14px 14px;border-top:1px solid rgba(148,163,184,.12)}
.wcf-admin-score-card{margin:14px 0;padding:14px;border-radius:14px;background:rgba(13,13,26,.55);border:1px solid rgba(148,163,184,.14);text-align:center}
.wcf-admin-score-eyebrow{font-size:9.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
.wcf-admin-score{display:flex;align-items:center;justify-content:center;gap:10px;font-size:11.5px;font-weight:800}
.wcf-admin-score input{width:52px;min-height:44px;text-align:center;background:rgba(13,13,26,.7);border:1px solid rgba(148,163,184,.2);color:var(--white);border-radius:12px;font-family:var(--display);font-size:18px;font-weight:800}
.wcf-admin-score-dash{color:var(--dim)}
.wcf-edit-subhead{margin:14px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--amber)}
.wcf-admin-player-row{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:12px;background:rgba(13,13,26,.55);border:1px solid rgba(148,163,184,.1);margin-top:6px;flex-wrap:wrap}
.wcf-admin-player-row:first-child{margin-top:0}
.wcf-admin-player-dot{flex:none;width:7px;height:7px;border-radius:50%}
.wcf-admin-player-dot.confirmed{background:var(--green)}
.wcf-admin-player-dot.pending{background:var(--red-hi)}
.wcf-admin-player-name{flex:1;min-width:90px;font-weight:700;font-size:12.5px;color:#f1f5f9}
.wcf-confirmed-by{display:block;font-size:10px;font-weight:600;color:var(--dim);margin-top:1px}
.wcf-admin-status{display:flex;align-items:center;gap:8px}
.wcf-admin-approve{min-height:38px;padding:0 12px;border-radius:11px;cursor:pointer;font-weight:700;font-size:10.5px;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.34);color:#86efac}
.wcf-admin-undo{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer}
.wcf-admin-pot-select{background:rgba(13,13,26,.7);border:1px solid rgba(148,163,184,.2);color:var(--dim);padding:6px 8px;border-radius:10px;font-size:10.5px;font-weight:700;font-family:var(--sans);cursor:pointer;flex:0 0 auto}
.wcf-admin-pot-select.exempt{border-color:rgba(234,179,8,.4);color:var(--amber)}
.wcf-admin-undo:hover{color:var(--red-hi)}
.wcf-admin-remove{flex:none;width:32px;height:32px;border-radius:10px;background:rgba(240,82,94,.1);border:1px solid rgba(240,82,94,.3);color:var(--red-hi);font-size:16px;cursor:pointer;line-height:1;display:grid;place-items:center}

.wcf-recon{margin-top:11px;display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;padding:5px 11px;border-radius:20px}
.wcf-recon.ok{background:rgba(34,197,94,.14);color:#86efac;border:1px solid rgba(34,197,94,.32)}
.wcf-recon.pending{background:rgba(234,179,8,.14);color:#fde68a;border:1px solid rgba(234,179,8,.32)}
.wcf-recon-dot{width:6px;height:6px;border-radius:50%;background:currentColor}

.wcf-scorers-card{border-radius:14px;overflow:hidden;margin-bottom:14px;background:rgba(13,13,26,.55);border:1px solid rgba(148,163,184,.14)}
.wcf-scorers-team{padding:11px 13px}
.wcf-scorers-team + .wcf-scorers-team{border-top:1px solid var(--line)}
.wcf-scorers-team-head{display:flex;align-items:center;gap:7px;margin-bottom:2px}
.wcf-scorers-team-swatch{width:8px;height:8px;border-radius:3px;flex:0 0 auto}
.wcf-scorers-team-name{font-family:var(--display);font-weight:700;font-size:11.5px}
.wcf-scorers-col-head{display:flex;align-items:center;gap:8px;padding:4px 0 2px}
.wcf-scorers-col-head span{flex:1}
.wcf-scorers-col-head small{width:60px;text-align:center;font-family:var(--mono);font-size:8px;letter-spacing:.08em;color:var(--dim);text-transform:uppercase}
.wcf-scorers-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.wcf-scorers-row + .wcf-scorers-row{border-top:1px solid rgba(148,163,184,.08)}
.wcf-scorers-name{flex:1;min-width:0;font-weight:700;font-size:12px;color:#f1f5f9;line-height:1.25}
.wcf-scorers-og-flag{display:block;margin-top:1px;font-size:9px;font-weight:700;color:var(--amber)}
.wcf-scorers-stepper{width:60px;display:flex;align-items:center;justify-content:center;gap:4px}
.wcf-scorers-stepper button{width:22px;height:22px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;display:grid;place-items:center;flex:0 0 auto;
  background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.18);color:#cbd5e1}
.wcf-scorers-stepper button:disabled{opacity:.4;cursor:not-allowed}
.wcf-scorers-stepper span{width:14px;text-align:center;font-family:var(--display);font-weight:800;font-size:12px;font-variant-numeric:tabular-nums;color:#f8fafc;flex:0 0 auto}
.wcf-scorers-stepper.og button{background:rgba(234,179,8,.1);border-color:rgba(234,179,8,.3);color:#fde68a}
.wcf-scorers-stepper.og span{color:#fde68a}
.wcf-msg-compose{margin:0 0 12px;padding:14px;border-radius:20px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid rgba(148,163,184,.16);box-shadow:0 22px 44px -30px rgba(0,0,0,.95);display:flex;flex-direction:column;gap:10px}
.wcf-msg-compose select{width:100%;appearance:none;background:var(--bg);color:#f1f5f9;border:1px solid rgba(148,163,184,.2);border-radius:12px;padding:13px;font-size:13px;font-weight:600;font-family:var(--sans);cursor:pointer;min-height:46px;box-sizing:border-box}
.wcf-msg-compose-box{width:100%;background:var(--bg);border:1px solid rgba(148,163,184,.2);border-radius:12px;padding:13px;color:#f1f5f9;font-size:13px;font-family:var(--sans);min-height:64px;resize:vertical;box-sizing:border-box}
.wcf-msg-compose-send{min-height:48px;padding:15px;border-radius:14px;cursor:pointer;font-weight:800;font-size:13px;color:#fff;border:1px solid rgba(230,57,70,.5);background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5))}
.wcf-msg-compose-send:disabled{background:var(--panel2);color:var(--dim);border-color:var(--line);cursor:not-allowed}
.wcf-msg-log-toggle{display:flex;align-items:center;gap:9px;width:100%;margin-top:10px;padding:13px 14px;border-radius:14px;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.16);cursor:pointer;min-height:46px}
.wcf-msg-log-toggle-label{flex:1;text-align:left;font-weight:700;font-size:11.5px;letter-spacing:.06em;color:#cbd5e1}
.wcf-msg-log-toggle-count{font-weight:600;font-size:11px;color:#64748b}
.wcf-msg-log{display:flex;flex-direction:column;gap:9px;padding-top:10px;margin-bottom:14px}
.wcf-msg-log-row{padding:12px 13px;border-radius:14px;background:var(--panel2);border:1px solid rgba(148,163,184,.14)}
.wcf-msg-log-top{display:flex;align-items:center;gap:8px}
.wcf-msg-log-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:11px;letter-spacing:.06em;color:var(--dim)}
.wcf-msg-log-status{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:5px 8px;border-radius:20px;flex:none;white-space:nowrap}
.wcf-msg-log-status.read{color:#86efac;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.32)}
.wcf-msg-log-status.unread{color:var(--dim);background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.2)}
.wcf-msg-log-text{margin-top:8px;font-size:12.5px;line-height:1.45;color:#F5F6F8}
.wcf-msg-log-when{margin-top:7px;font-size:10.5px;color:#64748b}
.wcf-show-more-toggle{width:100%;background:none;border:none;color:var(--dim);font-size:11.5px;font-weight:700;padding:10px 0;cursor:pointer;text-align:center}
.wcf-show-more-toggle:hover{color:var(--white)}
.wcf-admin-delete-game{width:100%;min-height:44px;background:rgba(240,82,94,.1);border:1px dashed rgba(240,82,94,.3);color:var(--red-hi);padding:10px;border-radius:12px;font-weight:700;font-size:11.5px;cursor:pointer;margin-top:12px}
.wcf-admin-game-body > .wcf-save{width:100%;margin:12px 0}
.wcf-admin-game-body > .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-admin-add-player{display:flex;gap:8px;margin-top:12px}
.wcf-admin-add-player select{flex:1;min-height:44px;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:9px 12px;border-radius:12px;font-size:12px;font-family:var(--sans);box-sizing:border-box}
.wcf-admin-add-player .wcf-ghost{min-height:44px;padding:0 16px;border-radius:12px;background:rgba(46,116,204,.14);border:1px solid rgba(46,116,204,.36);color:#7fb0ec;font-weight:700;font-size:11.5px}
.wcf-admin-add-player .wcf-ghost:disabled{opacity:.4;cursor:not-allowed;background:rgba(148,163,184,.06);border-color:rgba(148,163,184,.16);color:var(--dim)}

.wcf-clip-form{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;padding:12px;display:flex;flex-direction:column;gap:9px;margin-bottom:16px}
.wcf-clip-form-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.wcf-clip-form-head span{font-family:var(--display);font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.wcf-clip-form input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:13px;border-radius:12px;font-size:13px;font-family:var(--sans);min-height:44px;box-sizing:border-box}
.wcf-clip-form button{background:linear-gradient(135deg,var(--red),rgba(230,57,70,.55));color:#fff;border:1px solid rgba(230,57,70,.5);padding:14px;border-radius:14px;font-weight:800;font-size:13px;cursor:pointer;min-height:48px}
.wcf-clip-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed;border-color:var(--line)}

.wcf-feed-section-label{display:flex;align-items:center;gap:10px;padding:6px 2px 10px;font-family:var(--sans);font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#64748b}
.wcf-feed-section-label:after{content:"";flex:1;height:1px;background:rgba(148,163,184,.1)}

.wcf-feed-hero{
  position:relative;min-height:270px;border-radius:22px;overflow:hidden;margin:2px 2px 18px;
  display:flex;flex-direction:column;justify-content:flex-end;padding:18px 18px 20px;
  background-image:linear-gradient(180deg,rgba(6,8,14,.05) 0%,rgba(6,8,14,.2) 50%,rgba(4,6,10,.94) 100%),url('/celebration.jpg');
  background-size:cover;background-position:center 38%;
  border:1px solid var(--line);box-shadow:0 18px 40px -24px rgba(0,0,0,.9);
}
.wcf-feed-hero-eyebrow{font-family:var(--sans);font-size:10.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#f8b3b8}
.wcf-feed-hero-title{margin-top:6px;font-family:var(--display);font-size:19px;font-weight:800;letter-spacing:-.01em;color:#fff}
.wcf-feed-hero-tabs{display:flex;gap:8px;margin-top:16px}
.wcf-feed-hero-tabs button{flex:1;min-height:42px;padding:9px 14px;border-radius:20px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:12.5px;letter-spacing:.01em;background:rgba(148,163,184,.14);border:1px solid rgba(255,255,255,.2);color:#e2e8f0;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.wcf-feed-hero-tabs button.active{background:rgba(230,57,70,.88);border-color:rgba(230,57,70,.9);color:#fff}

.wcf-clip-hero{position:relative;border-radius:20px;overflow:hidden;border:1px solid var(--line);background:var(--panel2);margin-bottom:20px}
.wcf-clip-hero-thumb{position:relative;display:block;aspect-ratio:16/9;background:linear-gradient(135deg,var(--panel2),var(--bg))}
.wcf-clip-hero-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.wcf-clip-hero-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wcf-clip-hero-play:before{content:"";position:absolute;inset:0;background:rgba(4,9,20,.28)}
.wcf-clip-hero-play:after{content:"▶";position:relative;width:54px;height:54px;border-radius:50%;background:rgba(230,57,70,.9);color:#fff;font-size:19px;padding-left:3px;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px -10px rgba(230,57,70,.9)}
.wcf-clip-hero-body{padding:14px}
.wcf-clip-hero-title{font-family:var(--display);font-weight:800;font-size:16px;line-height:1.25;color:var(--white)}
.wcf-clip-hero-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}

.wcf-clip{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px;align-items:flex-start}
.wcf-clip-thumb{width:74px;height:52px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,var(--panel2),var(--bg));position:relative;overflow:hidden}
.wcf-clip-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wcf-clip-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(4,9,20,.28);color:#fff;font-size:14px;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.wcf-clip-body{flex:1;min-width:0}
.wcf-clip-title{font-weight:800;font-size:14px}
.wcf-clip-sub{font-size:11px;color:var(--dim);margin-top:3px}
.wcf-clip-del{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;flex:0 0 auto;line-height:1}
.wcf-clip-del:hover{color:var(--red-hi)}

.wcf-feed-item{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 12px;margin-bottom:10px;align-items:flex-start}
.wcf-feed-icon{width:32px;height:32px;border-radius:9px;flex:0 0 auto;display:grid;place-items:center;font-size:15px}
.wcf-feed-icon.amber{background:rgba(234,179,8,.16)}
.wcf-feed-icon.green{background:rgba(34,197,94,.16)}
.wcf-feed-icon.blue{background:rgba(46,116,204,.16)}
.wcf-feed-body{flex:1;min-width:0}
.wcf-feed-text{font-size:13px;color:var(--white);line-height:1.4}
.wcf-feed-date{font-size:10.5px;color:#64748b;margin-top:3px}
.wcf-feed-score-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-weight:800;font-size:13px;padding:3px 9px;border-radius:20px;background:var(--panel2);margin-top:4px}
.wcf-feed-score-dash{color:var(--dim);font-weight:400}
.wcf-feed-item-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
.wcf-feed-archive-btn{font-size:11px;font-weight:800;padding:5px 11px;border-radius:20px;background:transparent;border:1px solid var(--line);color:var(--dim);cursor:pointer}
.wcf-feed-archive-btn:hover{border-color:var(--red-hi);color:var(--red-hi)}
.wcf-archive-toggle{font-size:11.5px;padding:7px 12px;margin-bottom:12px}
.wcf-feed-reactions{display:flex;gap:6px}
.wcf-feed-pill{display:inline-flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;font-size:12px;border-radius:22px;padding:0 14px;min-height:36px;cursor:pointer;background:var(--panel2);color:var(--dim);border:1px solid transparent}
.wcf-feed-pill.mine{border-color:var(--green);color:var(--green)}

.wcf-subtabs{display:flex;gap:8px;margin:0 2px 16px}
.wcf-subtabs button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:9px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-subtabs button.active{background:var(--red);border-color:var(--red);color:#fff}
.wcf-subtabs.pill button{border-radius:22px;min-height:44px;font-size:12.5px}

.wcf-board{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:8px 14px 14px;overflow:hidden}
.wcf-board-note{font-size:12px;color:var(--dim);margin:10px 2px 12px;line-height:1.4}
.wcf-board-row{display:flex;align-items:center;gap:10px;padding:11px 8px;border-radius:9px;border-bottom:1px solid var(--line);cursor:pointer}
.wcf-board-row:last-child{border-bottom:none}
.wcf-board-row.lead{background:rgba(51,169,87,.12);border-bottom:none;margin-bottom:2px}
.wcf-board-row.me{background:rgba(46,116,204,.14)}
.wcf-board-row.me .wcf-board-name{color:var(--blue)}
.wcf-board-header{padding:0 8px 8px;border-bottom:1px solid var(--line)}
.wcf-board-header .wcf-board-name,.wcf-board-header .wcf-board-count{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);font-weight:700;font-family:var(--sans)}
.wcf-rank{font-family:var(--mono);font-weight:700;color:var(--dim);width:26px;text-align:center;display:grid;place-items:center}
.wcf-rank-star{color:var(--green);display:grid;place-items:center}
.wcf-rank-star svg{width:20px;height:20px;fill:var(--green);stroke:var(--green)}
.wcf-board-name{flex:1;font-weight:800;font-size:14px}
.wcf-apps-badge{display:inline-block;margin-left:7px;font-size:10px;font-weight:800;font-family:var(--mono);color:var(--amber);background:rgba(224,167,51,.14);border:1px solid rgba(224,167,51,.35);padding:1px 7px;border-radius:20px;vertical-align:middle}
.wcf-board-count{font-family:var(--mono);font-weight:700;color:var(--blue);width:44px;text-align:right}

.wcf-lb-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 2px}
.wcf-lb-title{margin:8px 2px 16px;font-family:var(--display);font-size:24px;font-weight:800;letter-spacing:-.02em;color:var(--white)}

.wcf-lb-podium-card{position:relative;border-radius:22px;padding:20px 16px 16px;margin-bottom:16px;
  background-image:linear-gradient(180deg,rgba(8,8,15,.72),rgba(8,8,15,.5) 42%,rgba(8,8,15,.93)),url('/pitch-floodlit.jpg');
  background-size:cover;background-position:center;
  border:1px solid var(--line);box-shadow:0 18px 40px -24px rgba(0,0,0,.9);overflow:hidden}
.wcf-lb-podium-glow{position:absolute;top:-90px;left:50%;transform:translateX(-50%);width:260px;height:200px;
  background:radial-gradient(closest-side,rgba(234,179,8,.2),transparent);filter:blur(6px);pointer-events:none}
.wcf-lb-podium-label{position:relative;display:flex;align-items:center;justify-content:center;gap:9px;
  font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.22em;color:#e2e8f0}
.wcf-lb-podium-rule{width:26px;height:1px;background:rgba(226,232,240,.5)}
.wcf-lb-podium-row{position:relative;display:grid;grid-template-columns:1fr 1.15fr 1fr;align-items:end;gap:8px;
  margin-top:20px;border-bottom:1px solid rgba(226,232,240,.18)}
.wcf-lb-podium-slot{display:flex;flex-direction:column;align-items:center;gap:8px}
.wcf-lb-crown{font-size:20px;line-height:1;color:var(--amber);margin-bottom:8px}
.wcf-lb-podium-avatar{position:relative;border-radius:50%;border-width:2px;border-style:solid;
  background:linear-gradient(160deg,var(--panel2),var(--bg));display:grid;place-items:center;
  box-shadow:0 0 0 6px rgba(13,13,26,.6);font-family:var(--display);font-weight:700;color:var(--dim)}
.wcf-lb-podium-avatar.lead{box-shadow:0 0 0 6px rgba(13,13,26,.6),0 0 26px -4px rgba(234,179,8,.55)}
.wcf-lb-podium-photo{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover}
.wcf-lb-podium-badge{position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);width:26px;height:26px;
  border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;
  color:var(--bg);border:2px solid var(--bg)}
.wcf-lb-podium-name{margin-top:4px;font-family:var(--display);font-weight:800;font-size:14px;color:var(--white)}
.wcf-lb-podium-goals{font-family:var(--display);font-weight:800;color:var(--white);font-variant-numeric:tabular-nums;
  display:flex;align-items:baseline;gap:3px;justify-content:center}
.wcf-lb-podium-goals span{font-size:11px;font-weight:600;color:var(--dim)}
.wcf-lb-podium-apps{font-size:11px;color:var(--dim)}
.wcf-lb-podium-plinth{margin-top:8px;width:100%;border-radius:8px 8px 0 0;border-top-width:2px;border-top-style:solid}

.wcf-lb-me-card{position:relative;display:flex;align-items:center;gap:14px;margin-top:14px;padding:14px 16px;
  border-radius:18px;background:rgba(46,116,204,.13);border:1px solid rgba(46,116,204,.32)}
.wcf-lb-me-rank{width:40px;height:40px;border-radius:50%;background:rgba(46,116,204,.22);display:grid;place-items:center;
  font-family:var(--display);font-weight:700;font-size:15px;color:#7fb0ec;flex:0 0 auto}
.wcf-lb-me-body{flex:1;min-width:0}
.wcf-lb-me-label{font-family:var(--sans);font-size:10px;font-weight:800;letter-spacing:.16em;color:var(--blue);white-space:nowrap}
.wcf-lb-me-name{margin-top:4px;font-family:var(--display);font-weight:800;font-size:15px;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-lb-me-stat{text-align:center;flex:0 0 auto}
.wcf-lb-me-stat div{font-family:var(--display);font-weight:700;font-size:20px;color:var(--white)}
.wcf-lb-me-stat span{display:block;margin-top:4px;font-size:11px;color:var(--dim)}

.wcf-lb-list-card{position:relative}
.wcf-lb-sorts{display:flex;gap:6px;padding:0 2px 10px}
.wcf-lb-sort-btn{border-radius:20px;padding:7px 13px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:10.5px;
  letter-spacing:.08em;text-transform:uppercase;background:rgba(148,163,184,.07);border:1px solid var(--line);color:var(--dim)}
.wcf-lb-sort-btn.on{background:rgba(230,57,70,.16);border-color:rgba(230,57,70,.42);color:#f8b3b8}
.wcf-lb-row-avatar{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
  font-family:var(--display);font-weight:700;font-size:9.5px;color:#fff;object-fit:cover}
.wcf-lb-you-badge{flex:none;font-size:10px;font-weight:700;color:var(--blue);background:rgba(46,116,204,.18);
  border:1px solid rgba(46,116,204,.4);padding:1px 6px;border-radius:20px;margin-left:6px}
.wcf-lb-row-detail{display:flex;gap:16px;padding:2px 8px 12px 46px;font-family:var(--mono);font-size:11px;color:var(--dim)}
.wcf-lb-row-detail b{color:var(--white);font-weight:600}
.wcf-lb-footer{display:flex;align-items:center;justify-content:space-between;padding:13px 8px 2px}
.wcf-lb-footer span{font-size:11px;color:var(--dim)}
.wcf-lb-footer button{background:none;border:none;padding:0;cursor:pointer;font-size:11px;font-weight:600;color:var(--blue)}

.wcf-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--blue);object-fit:cover}
.wcf-avatar.big{width:44px;height:44px;font-size:18px}
.wcf-account-avatar-wrap{position:relative;flex:0 0 auto}
.wcf-account-avatar-edit{position:absolute;bottom:-3px;right:-3px;width:20px;height:20px;border-radius:50%;background:var(--red);color:#fff;
  display:grid;place-items:center;border:2px solid var(--bg);cursor:pointer}
.wcf-account-avatar-remove{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:var(--panel2);color:var(--dim);
  border:2px solid var(--bg);font-size:12px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}

.wcf-lineup-head{
  position:relative;overflow:hidden;min-height:264px;border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:14px;
  background-image:linear-gradient(180deg,rgba(6,10,18,.15) 0%,rgba(6,10,18,.3) 45%,rgba(6,10,18,.8) 100%),url('/lineup-teams.jpg');
  background-size:cover;background-position:center 60%;
  box-shadow:0 18px 40px -24px rgba(0,0,0,.9);
}
.wcf-lineup-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f8b3b8}
.wcf-lineup-title{margin-top:9px;font-family:var(--display);font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--white)}
.wcf-lineup-sub{margin-top:10px;font-size:12px;color:#B7BDD0}
.wcf-lineup-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:118px}
.wcf-lineup-pill{flex:1;min-height:44px;padding:11px 12px;border-radius:22px;background:rgba(148,163,184,.14);border:1px solid rgba(255,255,255,.2);color:var(--white);font-weight:700;font-size:11.5px;cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.wcf-lineup-pill.primary{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.32);color:#86efac}
.wcf-lineup-row{display:flex;align-items:center;gap:11px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin-bottom:9px;transition:box-shadow .2s}
.wcf-lineup-row.me{border-color:transparent}
.wcf-lineup-row.me-edit{background:rgba(46,116,204,.14);border-color:var(--blue)}
.wcf-lineup-avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;flex:0 0 auto;background:var(--panel2);color:var(--dim);object-fit:cover}
.wcf-lineup-name{font-weight:700;font-size:14px;flex:1;min-width:0}
.wcf-name-link{background:none;border:none;padding:0;margin:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.wcf-lineup-picks{display:flex;gap:6px}
.wcf-lineup-pick{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 11px;border-radius:10px;font-weight:800;font-size:11px;cursor:pointer}

.wcf-lineup-strip-row{display:flex;gap:8px;margin-bottom:12px}
.wcf-lineup-strip{flex:1;display:flex;align-items:center;gap:9px;padding:11px 13px;border-radius:14px;border:1px solid}
.wcf-lineup-strip-dot{width:12px;height:12px;border-radius:4px;flex:0 0 auto}
.wcf-lineup-strip-name{flex:1;font-family:var(--sans);font-weight:800;font-size:11px;letter-spacing:.1em;color:var(--white)}
.wcf-lineup-strip-count{font-family:var(--display);font-weight:700;font-size:14px;color:var(--white)}

.wcf-lineup-views{display:flex;gap:6px;margin-bottom:12px}
.wcf-lineup-view-btn{border-radius:20px;padding:8px 15px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;background:rgba(148,163,184,.07);border:1px solid var(--line);color:var(--dim)}
.wcf-lineup-view-btn.on{background:rgba(230,57,70,.16);border-color:rgba(230,57,70,.42);color:#f8b3b8}

.wcf-lineup-pitch-card{position:relative;aspect-ratio:0.56;border-radius:22px;border:1px solid var(--line);box-shadow:0 22px 44px -28px rgba(0,0,0,.95);overflow:hidden;background:linear-gradient(180deg,rgba(6,12,10,.72),rgba(6,12,10,.48) 50%,rgba(6,12,10,.76)),url('/turf-texture.jpg');background-size:cover;background-position:center}
.wcf-lineup-pitch-lines{position:absolute;inset:0;width:100%;height:100%;opacity:.3;stroke:#e2e8f0;stroke-width:0.9;fill:none;display:block}
.wcf-lineup-pitch-tokens{position:absolute;inset:0}
.wcf-lineup-token{position:absolute;transform:translate(-50%,-50%);width:44px;height:44px;display:grid;place-items:center;background:none;border:none;padding:0;cursor:pointer}
.wcf-lineup-token-chip{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:13px;box-shadow:0 6px 14px -6px rgba(0,0,0,.85);object-fit:cover}
.wcf-lineup-token-label{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:5px;font-size:9.5px;font-weight:700;letter-spacing:.02em;color:var(--white);text-shadow:0 1px 3px rgba(0,0,0,.9);white-space:nowrap;pointer-events:none}
.wcf-lineup-token.draggable{cursor:grab;touch-action:none}
.wcf-lineup-token.draggable .wcf-lineup-token-chip{box-shadow:0 0 0 2px rgba(46,116,204,.5),0 6px 14px -6px rgba(0,0,0,.85)}
.wcf-lineup-token.dragging{cursor:grabbing;z-index:5}
.wcf-lineup-token.dragging .wcf-lineup-token-chip{transform:scale(1.12);box-shadow:0 0 0 2px var(--blue),0 10px 22px -8px rgba(0,0,0,.9)}
.wcf-lineup-position-controls{display:flex;gap:8px;margin-bottom:10px}
.wcf-lineup-position-controls .wcf-ghost.danger{color:var(--red-hi);border-color:rgba(230,57,70,.35)}
.wcf-lineup-pitch-note{margin:12px 2px 0;font-size:11.5px;line-height:1.5;color:var(--dim)}

.wcf-lineup-list-wrap{position:relative;display:flex;gap:10px;border-radius:18px;overflow:hidden;padding:10px;background-image:linear-gradient(180deg,rgba(13,13,26,.5),rgba(13,13,26,.85)),url('/floodlight-haze.jpg');background-size:cover;background-position:50% 30%}
.wcf-lineup-list-card{flex:1;min-width:0;border-radius:14px;padding:6px 8px 10px;backdrop-filter:blur(14px);background:linear-gradient(180deg,rgba(30,41,59,.7),rgba(19,22,38,.82));border:1px solid var(--line)}
.wcf-lineup-list-head{padding:9px 4px;font-family:var(--sans);font-weight:800;font-size:10px;letter-spacing:.16em}
.wcf-lineup-list-row{width:100%;display:flex;align-items:center;gap:8px;padding:8px 4px;background:none;border:none;border-top:1px solid var(--line);cursor:pointer;min-height:40px}
.wcf-lineup-list-chip{flex:0 0 auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:10.5px;object-fit:cover}
.wcf-lineup-list-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:12.5px;color:var(--white);text-align:left}

.wcf-lineup-selected{margin-top:14px;padding:14px 16px;border-radius:18px;background:rgba(46,116,204,.13);border:1px solid rgba(46,116,204,.32);display:flex;align-items:center;gap:13px}
.wcf-lineup-selected-chip{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:15px;object-fit:cover}
.wcf-lineup-selected-body{flex:1;min-width:0}
.wcf-lineup-selected-name{font-family:var(--display);font-weight:800;font-size:14px;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-lineup-selected-name.clickable{cursor:pointer}
.wcf-lineup-selected-name.clickable:hover{text-decoration:underline}
.wcf-lineup-selected-role{margin-top:4px;font-size:11px;color:var(--dim)}
.wcf-lineup-selected-stat{text-align:center;flex:0 0 auto}
.wcf-lineup-selected-stat div{font-family:var(--display);font-weight:700;font-size:17px;color:var(--blue)}
.wcf-lineup-selected-stat span{display:block;margin-top:4px;font-size:10px;color:var(--dim)}
.wcf-ratings-table{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-ratings-table h4{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-ratings-rows{display:flex;flex-direction:column;gap:2px}
.wcf-ratings-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wcf-ratings-row:last-child{border-bottom:none}
.wcf-ratings-name{font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;min-width:0}
.wcf-ratings-pos{font-size:9.5px;font-weight:700;color:var(--dim);background:var(--panel2);padding:2px 7px;border-radius:20px;text-transform:uppercase}
.wcf-ratings-unrated{font-size:11px;color:var(--dim);font-style:italic}
.wcf-ratings-stats{display:flex;align-items:center;gap:8px;font-size:11px;font-family:var(--mono);color:var(--dim);flex-shrink:0}
.wcf-ratings-source{font-family:var(--sans);font-weight:800;font-size:9.5px;text-transform:uppercase;padding:2px 7px;border-radius:20px}
.wcf-ratings-source.admin{background:rgba(224,167,51,.18);color:var(--amber)}
.wcf-ratings-source.self{background:var(--panel2);color:var(--dim)}
.wcf-fairness-teams{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.wcf-fairness-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px}
.wcf-fairness-card-head{font-weight:800;font-size:13px;margin-bottom:10px}
.wcf-fairness-metric{margin-bottom:8px}
.wcf-fairness-metric-top{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:3px}
.wcf-fairness-metric-top span:last-child{font-family:var(--mono);color:var(--white)}
.wcf-fairness-track{height:6px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-fairness-fill{height:100%;border-radius:5px;background:var(--blue)}
.wcf-fairness-positions{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
.wcf-fairness-pos-tag{font-size:9.5px;font-weight:700;color:var(--dim);background:var(--panel2);padding:2px 7px;border-radius:20px}
.wcf-fairness-rated-note{font-size:10px;color:var(--dim);margin-top:8px;font-family:var(--mono)}
.wcf-fairness-ok{font-size:13px;color:var(--green);font-weight:700;text-align:center;padding:10px}
.wcf-balance-compare{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-balance-row{display:flex;align-items:center;justify-content:space-between;padding:6px 0;font-size:13px;font-weight:700}
.wcf-balance-badge{font-family:var(--mono);font-weight:800;font-size:11.5px;padding:3px 10px;border-radius:20px}
.wcf-balance-badge.high{background:rgba(51,169,87,.16);color:var(--green)}
.wcf-balance-badge.mid{background:rgba(224,167,51,.16);color:var(--amber)}
.wcf-balance-badge.low{background:rgba(230,57,70,.16);color:var(--red-hi)}
.wcf-balance-badge.none{font-family:var(--sans);font-weight:600;font-size:10.5px;color:var(--dim);background:var(--panel2)}
.wcf-balance-verdict{margin:8px 0 0;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--dim);text-align:center}
.wcf-balance-log{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:8px 14px 12px;margin-bottom:14px}
.wcf-balance-log h4{margin:8px 2px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
.wcf-balance-log-row{display:grid;grid-template-columns:1fr 74px 46px 42px;align-items:center;gap:6px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}
.wcf-balance-log-row:last-child{border-bottom:none}
.wcf-balance-log-header{color:var(--dim);font-size:9px;text-transform:uppercase;letter-spacing:.04em;font-weight:800;padding-bottom:6px}
.wcf-balance-log-header span:not(:first-child){text-align:right}
.wcf-balance-log-venue{font-weight:700}
.wcf-balance-log-venue span{display:block;font-size:10px;color:var(--dim);font-weight:600;margin-top:1px}
.wcf-balance-log-method{font-size:9px;font-weight:800;text-transform:uppercase;padding:3px 6px;border-radius:20px;text-align:center}
.wcf-balance-log-method.generated{background:rgba(46,116,204,.16);color:#7CAEF0}
.wcf-balance-log-method.manual{background:var(--panel2);color:var(--dim)}
.wcf-balance-log-result{font-family:var(--mono);font-weight:700;text-align:right;color:var(--dim);font-size:11px}
.wcf-balance-log-margin{font-family:var(--mono);font-weight:800;text-align:right}
.wcf-balance-avg-row{display:flex;gap:10px;margin-top:10px}
.wcf-balance-avg-card{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}
.wcf-balance-avg-card b{display:block;font-family:var(--mono);font-size:19px;font-weight:800}
.wcf-balance-avg-card span{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;margin-top:2px;display:block}
.wcf-fairness-flags{display:flex;flex-direction:column;gap:8px}
.wcf-fairness-flag{background:rgba(224,167,51,.14);border:1px solid rgba(224,167,51,.35);border-radius:10px;padding:10px 12px;font-size:12.5px;color:var(--white)}
.wcf-generate-teams{width:100%;background:var(--blue);color:#fff;border:none;padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;margin-bottom:8px}
.wcf-suggestion-actions{display:flex;gap:8px;margin-bottom:8px}
.wcf-suggestion-actions .wcf-generate-teams{flex:1;margin-bottom:0;background:var(--panel2);color:var(--white)}
.wcf-suggestion-actions .wcf-ghost{flex:1}
.wcf-apply-teams{flex:1.4;background:var(--green);color:var(--bg);border:none;padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer}
.wcf-suggestion-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0 0 14px;text-align:center}
.wcf-fairness-preview-names{font-size:11px;color:var(--dim);line-height:1.4;margin-bottom:10px}
.wcf-lineup-group{margin-bottom:6px}
.wcf-lineup-group-label{display:flex;align-items:center;gap:7px;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--dim);margin:0 2px 8px}
.wcf-lineup-group-dot{width:7px;height:7px;border-radius:50%}

.wcf-predict{background:var(--panel);border:1px solid rgba(139,107,232,.3);border-radius:14px;padding:13px 14px;margin-top:4px}
.wcf-predict-label{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:3px}
.wcf-predict-title{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:#8B6BE8}
.wcf-predict-sub{font-size:10px;color:var(--dim)}
.wcf-predict-prize{font-size:11px;color:var(--dim);margin:0 0 12px;line-height:1.5}
.wcf-predict-score{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:13px}
.wcf-predict-team{text-align:center;flex:1}
.wcf-predict-team-name{font-size:11px;font-weight:700;margin-bottom:7px}
.wcf-predict-stepper{display:flex;align-items:center;justify-content:center;gap:8px}
.wcf-predict-stepper button{width:28px;height:28px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:15px;cursor:pointer;display:grid;place-items:center;line-height:1}
.wcf-predict-stepper span{font-family:var(--mono);font-size:22px;font-weight:800;width:22px;text-align:center}
.wcf-predict-vs{color:var(--dim);font-size:11px;font-weight:700;padding-top:16px}
.wcf-predict-lock{width:100%;background:#8B6BE8;color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-predict-lock:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-predict-locked{display:flex;align-items:center;gap:10px}
.wcf-predict-locked-icon{color:#8B6BE8;flex:0 0 auto;display:flex}
.wcf-predict-locked-body{flex:1;min-width:0}
.wcf-predict-locked-label{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#8B6BE8}
.wcf-predict-locked-value{font-size:12.5px;font-weight:700;margin-top:2px}
.wcf-predict-edit{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;flex:0 0 auto}
.wcf-predict-gate{text-align:center;padding:6px 4px 2px}
.wcf-predict-gate-icon{display:flex;justify-content:center;color:var(--dim);margin-bottom:6px}
.wcf-predict-gate-text{font-size:12px;color:var(--dim);line-height:1.5}
.wcf-predict-gate-text b{color:var(--white)}

.wcf-lb-prize{display:flex;align-items:center;gap:8px;background:rgba(224,167,51,.1);border:1px solid rgba(224,167,51,.35);border-radius:10px;padding:9px 12px;margin-bottom:12px;font-size:11.5px;color:var(--white);line-height:1.4}
.wcf-lb-key{font-size:10.5px;color:var(--dim);text-align:center;margin-bottom:12px;line-height:1.6}
.wcf-lb{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 14px 4px}
.wcf-lb-rank{font-family:var(--mono);font-weight:800;font-size:12px;color:var(--dim);width:16px;flex:0 0 auto}
.wcf-lb-rank.top{color:var(--amber)}
.wcf-lb-pts{font-family:var(--display);font-weight:800;font-size:15px;flex:0 0 auto;color:var(--blue)}

.wcf-pl-leader-card{position:relative;border-radius:22px;border:1px solid var(--line);box-shadow:0 22px 44px -28px rgba(0,0,0,.95);overflow:hidden;padding:20px 18px 18px;margin-bottom:14px;
  background-image:linear-gradient(180deg,rgba(11,16,32,.42),rgba(11,16,32,.82) 72%,rgba(11,16,32,.96)),url('/floodlight-haze.jpg');background-size:cover;background-position:50% 26%}
.wcf-pl-leader-eyebrow{font-family:var(--sans);font-size:10px;font-weight:700;letter-spacing:.22em;color:#cbd5e1}
.wcf-pl-leader-row{display:flex;align-items:center;gap:14px;margin-top:16px}
.wcf-pl-leader-avatar{flex:0 0 auto;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:20px;color:#fff;object-fit:cover}
.wcf-pl-leader-body{flex:1;min-width:0}
.wcf-pl-leader-name{font-family:var(--display);font-weight:800;font-size:20px;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-pl-leader-sub{margin-top:6px;font-size:12px;color:#cbd5e1}
.wcf-pl-leader-pts{text-align:right;flex:0 0 auto}
.wcf-pl-leader-pts div{font-family:var(--display);font-weight:800;font-size:30px;color:var(--amber);font-variant-numeric:tabular-nums}
.wcf-pl-leader-pts span{display:block;margin-top:5px;font-size:10px;font-weight:600;letter-spacing:.14em;color:var(--dim)}

.wcf-pl-legend{display:flex;align-items:center;gap:14px;padding:0 2px 8px;font-size:10px;color:var(--dim)}
.wcf-pl-legend span{display:flex;align-items:center;gap:5px}
.wcf-pl-legend-last{margin-left:auto}
.wcf-pl-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}

.wcf-pl-row{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line);cursor:pointer}
.wcf-pl-row:last-child{border-bottom:none}
.wcf-pl-row.lead{background:rgba(234,179,8,.08);margin:0 -14px;padding:11px 14px;border-radius:10px;border-bottom:none}
.wcf-pl-row.me{background:rgba(46,116,204,.1);margin:0 -14px;padding:11px 14px;border-radius:10px;border-bottom:1px solid rgba(46,116,204,.25)}
.wcf-pl-avatar{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);object-fit:cover}
.wcf-pl-body{flex:1;min-width:0}
.wcf-pl-name{font-size:13.5px;font-weight:800;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--white)}
.wcf-pl-sub-row{display:flex;align-items:center;gap:8px;margin-top:5px}
.wcf-pl-sub-row>span:first-child{font-size:11px;color:var(--dim);white-space:nowrap}
.wcf-pl-form{display:flex;gap:3px}
.wcf-pl-detail{display:flex;gap:16px;padding:0 8px 12px 42px;font-family:var(--mono);font-size:11px;color:var(--dim)}
.wcf-pl-detail b{font-weight:600}

.wcf-pl-footer{display:flex;align-items:center;justify-content:space-between;padding:13px 8px 2px}
.wcf-pl-footer span{font-size:11px;color:var(--dim)}
.wcf-pl-footer button{background:none;border:none;padding:0;cursor:pointer;font-size:11px;font-weight:600;color:var(--blue)}

.wcf-predict-reveal{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.wcf-predict-reveal-label{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px}
.wcf-predict-reveal-title{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:#8B6BE8}
.wcf-predict-reveal-count{font-size:10.5px;color:var(--dim)}
.wcf-predict-reveal-row{display:flex;align-items:center;gap:10px;padding:7px 0}
.wcf-predict-reveal-row-label{flex:1;font-size:12.5px}
.wcf-predict-reveal-row-label b{font-family:var(--mono)}
.wcf-predict-pts{font-family:var(--mono);font-weight:800;font-size:12px;padding:3px 9px;border-radius:20px;flex:0 0 auto}
.wcf-predict-pts.exact{background:rgba(51,169,87,.18);color:var(--green)}
.wcf-predict-pts.partial{background:rgba(46,116,204,.18);color:#7CAEF0}
.wcf-predict-pts.zero{background:var(--panel2);color:var(--dim)}
.wcf-predict-fact{font-size:11.5px;color:var(--dim);margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}

.wcf-season-hero{
  position:relative;min-height:220px;border-radius:22px;overflow:hidden;margin:2px 2px 18px;
  display:flex;flex-direction:column;justify-content:flex-end;padding:18px 20px;
  background-image:linear-gradient(180deg,rgba(6,8,14,.1) 0%,rgba(6,8,14,.3) 55%,rgba(4,6,10,.92) 100%),url('/season-hero.jpg');
  background-size:cover;background-position:center 42%;
  border:1px solid var(--line);box-shadow:0 18px 40px -24px rgba(0,0,0,.9);
}
.wcf-season-hero-eyebrow{font-family:var(--sans);font-size:10.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#f8b3b8}
.wcf-season-hero-title{margin-top:6px;font-family:var(--display);font-size:32px;font-weight:800;letter-spacing:-.02em;color:#fff}
.wcf-season-hero-sub{margin-top:6px;font-size:12px;color:#B7BDD0}

.wcf-shoutout{background:linear-gradient(135deg,rgba(230,57,70,.16),rgba(51,169,87,.1));border:1px solid rgba(230,57,70,.35);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5}
.wcf-award-media{display:block;width:100%;max-height:240px;object-fit:cover;border-radius:10px;margin-top:10px}
.wcf-potm{background:linear-gradient(135deg,rgba(224,167,51,.2),rgba(224,167,51,.06));border-color:rgba(224,167,51,.4)}

.wcf-pot-total{background:linear-gradient(135deg,rgba(51,169,87,.16),rgba(46,116,204,.1));border:1px solid rgba(51,169,87,.35);border-radius:16px;padding:18px;margin-bottom:16px;text-align:center}
.wcf-pot-total-label{font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--dim)}
.wcf-pot-total-amount{font-family:var(--display);font-weight:800;font-size:54px;line-height:1;letter-spacing:-.02em;color:var(--green);margin:12px 0 14px;text-shadow:0 0 44px rgba(34,197,94,.45)}
.wcf-pot-total-amount.admin{font-size:36px;margin:4px 0 8px;text-shadow:none}
.wcf-pot-total-amount.negative{color:var(--red-hi)}
.wcf-pot-total-note{font-size:12px;color:var(--dim);line-height:1.5;margin:0;max-width:340px;margin-left:auto;margin-right:auto}
.wcf-pot-spark{display:block;width:100%;height:70px}
.wcf-pot-tags{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin:18px 0 4px}
.wcf-pot-tag{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#86efac;background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);padding:8px 12px;border-radius:20px}
.wcf-pot-ledger-head{display:flex;align-items:baseline;justify-content:space-between;margin:22px 2px 10px}
.wcf-pot-ledger-head span:first-child{font-family:var(--display);font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-pot-ledger-head span:last-child{font-size:11px;color:#64748b}
.wcf-pot-row-icon{flex:none;width:26px;height:26px;border-radius:9px;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:14px}
.wcf-pot-row-icon.pos{background:rgba(34,197,94,.13);border:1px solid rgba(34,197,94,.3);color:var(--green)}
.wcf-pot-row-icon.neg{background:rgba(240,82,94,.14);border:1px solid rgba(240,82,94,.3);color:var(--red-hi)}
.wcf-pot-auto-note{margin:12px 2px 0;font-size:11px;line-height:1.5;color:#64748b}
.wcf-pot-add{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wcf-pot-add input,.wcf-pot-add select{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-pot-kind-toggle{display:flex;gap:8px}
.wcf-pot-kind-toggle button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer}
.wcf-pot-kind-toggle button.active{background:rgba(51,169,87,.18);border-color:var(--green);color:var(--green)}
.wcf-pot-kind-toggle button.active.deduct{background:rgba(230,60,60,.16);border-color:var(--red-hi);color:var(--red-hi)}
.wcf-pot-submit{background:var(--green);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-pot-submit.deduct{background:var(--red-hi)}
.wcf-pot-submit:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-pot-row{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:9px}
.wcf-pot-row>div:first-child{flex:1;min-width:0}
.wcf-pot-row-desc{font-weight:700;font-size:13px}
.wcf-pot-cat-tag{display:inline-block;margin-left:7px;font-size:9.5px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;color:var(--dim);background:var(--panel2);padding:1px 7px;border-radius:20px}
.wcf-fin-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.wcf-fin-tile{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 8px;text-align:center}
.wcf-fin-tile-label{font-size:9px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.wcf-fin-tile-value{font-family:var(--mono);font-weight:800;font-size:18px;margin-top:5px;color:var(--white)}
.wcf-fin-tile-value.green{color:var(--green)}
.wcf-fin-tile-value.red{color:var(--red-hi)}
.wcf-fin-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:14px}
.wcf-fin-card-head{font-size:11.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--dim);margin-bottom:12px}
.wcf-fin-fx-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);gap:10px}
.wcf-fin-fx-row:last-child{border-bottom:none;padding-bottom:0}
.wcf-fin-fx-desc{font-size:12.5px;font-weight:700;color:var(--white)}
.wcf-fin-fx-net{font-family:var(--mono);font-weight:800;font-size:13px;flex-shrink:0}
.wcf-fin-fx-net.green{color:var(--green)}
.wcf-fin-fx-net.red{color:var(--red-hi)}
.wcf-fin-cat-row{margin-bottom:10px}
.wcf-fin-cat-row:last-child{margin-bottom:0}
.wcf-fin-cat-top{display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px}
.wcf-fin-cat-top span:first-child{color:var(--white);font-weight:600}
.wcf-fin-cat-top span:last-child{color:var(--dim);font-family:var(--mono)}
.wcf-fin-cat-track{height:7px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-fin-cat-fill{height:100%;border-radius:5px;background:var(--amber)}
.wcf-fin-export{width:100%;display:flex;align-items:center;justify-content:center}
.wcf-pot-row-amount{font-family:var(--mono);font-weight:800;font-size:14px;flex:0 0 auto}
.wcf-pot-row-amount.pos{color:var(--green)}
.wcf-pot-row-amount.neg{color:var(--red-hi)}
.wcf-streak{background:var(--panel);border:1px solid var(--line);border-left:3px solid;border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5}
.wcf-streak strong{color:var(--white)}
.wcf-h2h{
  background-image:linear-gradient(180deg,rgba(13,13,26,.55) 0%,rgba(13,13,26,.86) 38%,rgba(13,13,26,.98) 70%),url('/net-rain.jpg');
  background-size:cover;background-position:center 65%;
  border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
.wcf-h2h-title{font-weight:800;font-size:13px;margin-bottom:10px}
.wcf-h2h-row{display:grid;grid-template-columns:1fr repeat(5,28px);align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid var(--line)}
.wcf-h2h-row:last-child{border-bottom:none}
.wcf-h2h-header{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.4px}
.wcf-h2h-row span{text-align:center}
.wcf-h2h-team{display:flex;align-items:center;gap:7px;text-align:left!important;font-weight:700}
.wcf-h2h-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.wcf-h2h-pts{font-weight:800;color:var(--white)}
.wcf-form-block{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.wcf-form-label{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.wcf-form-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.wcf-form-row:last-child{margin-bottom:0}
.wcf-form-team{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700}
.wcf-form-dots{display:flex;gap:5px}
.wcf-form-dot{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;font-family:var(--mono);color:#fff}
.wcf-form-dot.w{background:var(--green)}
.wcf-form-dot.d{background:var(--panel2);color:var(--dim)}
.wcf-form-dot.l{background:var(--red-hi)}
.wcf-form-dot.latest{box-shadow:0 0 0 2px var(--bg),0 0 0 3px currentColor}

.wcf-month-filter{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans);margin-bottom:14px}
.wcf-result{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:13px;margin-bottom:11px}
.wcf-result.featured{
  background-image:linear-gradient(180deg,rgba(6,10,16,.5) 0%,rgba(6,10,16,.84) 45%,rgba(6,10,16,.97) 80%),url('/pitch-ball-wet.jpg');
  background-size:cover;background-position:center 62%;
}
.wcf-result-toggle{display:block;width:100%;background:none;border:none;padding:0;margin:0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.wcf-result-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-result-score{font-family:var(--mono);font-weight:800;font-size:18px;display:flex;align-items:center;gap:6px}
.wcf-result-dash{color:var(--dim);font-weight:400}
.wcf-result-chevron{font-size:11px;font-weight:700;color:var(--dim);margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.wcf-result-detail{margin-top:2px}
.wcf-result-section-label{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--dim);margin:12px 0 8px}
.wcf-result-goals{display:flex;gap:16px}
.wcf-result-goals-col{flex:1;min-width:0}
.wcf-result-goal-row{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:3px 0}
.wcf-result-goal-row b{font-family:var(--mono);color:var(--dim);font-weight:700}
.wcf-result-og{margin-top:10px;font-size:11.5px;color:var(--amber);line-height:1.5}
.wcf-result-share{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.wcf-result-share-btn{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-weight:800;font-size:12.5px;padding:10px;border-radius:10px;cursor:pointer}
.wcf-result-admin-tag{font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:4px 8px;border-radius:20px;background:rgba(230,57,70,.16);color:var(--red-hi);white-space:nowrap}
.wcf-motm{margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.wcf-motm-label{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.wcf-motm-candidates{display:flex;flex-wrap:wrap;gap:6px}
.wcf-motm-vote{font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:20px;border:1px solid var(--line);background:transparent;color:var(--white);cursor:pointer}
.wcf-motm-vote.voted{background:var(--green);border-color:var(--green);color:var(--bg)}
.wcf-motm-winner{font-size:13px;font-weight:700;color:var(--white);margin-bottom:9px}
.wcf-motm-winner strong{color:var(--amber)}
.wcf-motm-bar-row{margin-bottom:7px}
.wcf-motm-bar-row:last-child{margin-bottom:0}
.wcf-motm-bar-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;font-size:12px}
.wcf-motm-bar-top span:first-child{color:var(--dim);font-weight:600}
.wcf-motm-bar-top span.winner{color:var(--amber)}
.wcf-motm-count{font-family:var(--mono);color:var(--dim);font-size:11px}
.wcf-motm-bar-track{height:6px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-motm-bar-fill{height:100%;border-radius:5px;background:var(--dim)}
.wcf-motm-bar-fill.winner{background:var(--amber)}
.wcf-motm-voters-trigger{display:flex;align-items:center;gap:8px;background:none;border:none;padding:0;margin-top:6px;cursor:pointer}
.wcf-motm-voters-label{font-size:10.5px;font-weight:700;color:var(--dim);text-decoration:underline}
.wcf-motm-voters-card{width:100%;max-width:300px;margin:auto;border-radius:20px;padding:20px;border:1px solid var(--line);
  background:linear-gradient(180deg,rgba(30,41,59,.98),rgba(19,22,38,1));box-shadow:0 26px 50px -30px rgba(0,0,0,.95);animation:wcfPcardIn .22s ease-out}
.wcf-motm-voters-title{font-family:var(--display);font-weight:800;font-size:15px;color:var(--white);margin-bottom:14px;text-align:center}
.wcf-motm-voters-list{display:flex;flex-direction:column;gap:4px}
.wcf-motm-voters-row{display:flex;align-items:center;gap:10px;background:none;border:none;padding:8px 6px;border-radius:12px;cursor:pointer;text-align:left;font:inherit;color:var(--white)}
.wcf-motm-voters-row:hover{background:rgba(148,163,184,.08)}

.wcf-batchgen-card{width:100%;max-width:360px;margin:auto;border-radius:20px;padding:22px;border:1px solid var(--line);
  background:linear-gradient(180deg,rgba(30,41,59,.98),rgba(19,22,38,1));box-shadow:0 26px 50px -30px rgba(0,0,0,.95);animation:wcfPcardIn .22s ease-out}
.wcf-batchgen-note{font-size:12.5px;color:var(--dim);line-height:1.5;margin:0 0 18px;text-align:center}
.wcf-batchgen-dates{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.wcf-batchgen-dates label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-batchgen-dates input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-batchgen-days{display:flex;gap:6px;margin-bottom:16px}
.wcf-batchgen-days button{flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);color:var(--dim);padding:9px 0;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;font-family:var(--sans)}
.wcf-batchgen-days button.active{background:rgba(230,57,70,.18);border-color:rgba(230,57,70,.5);color:#fff}
.wcf-batchgen-preview{font-size:12px;color:var(--dim);line-height:1.5;margin-bottom:16px;padding:10px 12px;background:rgba(148,163,184,.08);border-radius:10px}
.wcf-batchgen-actions{display:flex;gap:8px}
.wcf-batchgen-actions .wcf-ghost{flex:1}
.wcf-batchgen-save{flex:1;background:var(--green);color:#04140a;border:none;padding:11px;border-radius:9px;font-weight:800;cursor:pointer;font-size:13px}
.wcf-batchgen-save:disabled{opacity:.5;cursor:not-allowed}

.wcf-account{display:flex;flex-direction:column;gap:0}
.wcf-acc-section{border-radius:18px;overflow:hidden;margin-bottom:9px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line)}
.wcf-acc-section-head{display:flex;align-items:center;gap:11px;width:100%;padding:13px;background:none;border:none;cursor:pointer;min-height:56px;text-align:left}
.wcf-acc-section-tile{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-size:14px;background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.2);color:var(--dim)}
.wcf-acc-section-tile.blue{background:rgba(46,116,204,.15);border-color:rgba(46,116,204,.3);color:var(--blue)}
.wcf-acc-section-tile.amber{background:rgba(234,179,8,.15);border-color:rgba(234,179,8,.3);color:var(--amber)}
.wcf-acc-section-tile.red{background:rgba(230,57,70,.15);border-color:rgba(230,57,70,.3);color:var(--red)}
.wcf-acc-section-body{flex:1;min-width:0;text-align:left}
.wcf-acc-section-title{display:block;font-family:var(--sans);font-weight:800;font-size:13px;line-height:1.3;color:#f1f5f9}
.wcf-acc-section-meta{display:block;margin-top:6px;font-size:10.5px;line-height:1.3;color:var(--dim)}
.wcf-acc-section-value{flex:none;font-family:var(--display);font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;color:var(--blue)}
.wcf-acc-section-chevron{flex:none;font-size:11px;color:var(--dim);margin-left:4px}
.wcf-acc-section-panel{padding:0 13px 13px;animation:wcfAccIn .18s ease-out}
.wcf-acc-section-panel-inner{padding-top:13px;border-top:1px solid var(--line)}
@keyframes wcfAccIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.wcf-account-card{
  display:flex;align-items:center;gap:12px;
  background-image:linear-gradient(135deg,rgba(13,13,26,.55) 0%,rgba(13,13,26,.88) 55%,rgba(13,13,26,.97) 100%),url('/bench-kit.jpg');
  background-size:cover;background-position:center 68%;
  border:1px solid var(--line);border-radius:14px;padding:14px}
.wcf-account-name{font-weight:800;font-size:15px}
.wcf-account-email{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-role-badge{margin-left:auto;font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-role-badge.admin{color:var(--green);border:1px solid rgba(51,169,87,.4)}
.wcf-role-badge.co-owner{color:var(--blue);border:1px solid rgba(46,116,204,.4)}
.wcf-role-badge.owner{color:var(--red-hi);border:1px solid rgba(230,57,70,.4)}
.wcf-role-badge.small{margin-left:4px;padding:2px 7px;font-size:9px}
.wcf-inbox-msg{border-radius:16px;padding:13px;margin-bottom:9px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line)}
.wcf-inbox-msg.unread{border-color:rgba(230,57,70,.32)}
.wcf-inbox-msg-top{display:flex;align-items:center;gap:9px}
.wcf-inbox-msg-tile{flex:none;width:26px;height:26px;border-radius:9px;display:grid;place-items:center;font-size:12px;background:rgba(46,116,204,.15);border:1px solid rgba(46,116,204,.3);color:var(--blue)}
.wcf-inbox-msg-from{flex:1;min-width:0;font-family:var(--sans);font-weight:800;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-inbox-msg-when{margin-top:5px;font-size:10.5px;color:#64748b}
.wcf-inbox-new{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;color:#f8b3b8;background:rgba(230,57,70,.14);border:1px solid rgba(230,57,70,.36);padding:5px 8px;border-radius:20px}
.wcf-inbox-msg-body{margin-top:10px;font-size:12.5px;line-height:1.5;color:var(--white)}
.wcf-inbox-mark-read{width:100%;margin-top:11px;min-height:44px;padding:12px;border-radius:12px;background:rgba(46,116,204,.14);border:1px solid rgba(46,116,204,.36);color:#7fb0ec;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-inbox-unread-pill{display:flex;align-items:center;gap:5px;padding:5px 9px;border-radius:20px;background:rgba(230,57,70,.16);border:1px solid rgba(230,57,70,.42);font-weight:800;font-size:9px;letter-spacing:.1em;color:#f8b3b8;white-space:nowrap}
.wcf-inbox-unread-dot{width:5px;height:5px;border-radius:50%;background:var(--red)}
.wcf-role-unread{background:var(--red);color:#fff;font-family:var(--mono);font-weight:800;font-size:10px;padding:1px 6px;border-radius:20px;flex:0 0 auto}
.wcf-tab-hero{margin:0 2px 9px;padding:14px;border-radius:20px;background:linear-gradient(155deg,rgba(240,82,94,.14),rgba(19,22,38,.98) 62%);border:1px solid rgba(240,82,94,.34);box-shadow:0 20px 40px -30px rgba(240,82,94,.6)}
.wcf-tab-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.wcf-tab-hero-amount{display:block;font-family:var(--display);font-size:30px;font-weight:800;letter-spacing:-.025em;font-variant-numeric:tabular-nums;color:#f8fafc}
.wcf-tab-hero-summary{display:block;margin-top:9px;font-weight:700;font-size:11.5px;color:#f1f5f9}
.wcf-tab-hero-icon{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:14px;background:rgba(240,82,94,.18);border:1px solid rgba(240,82,94,.42);color:var(--red-hi)}
.wcf-tab-hero-items{display:flex;flex-direction:column;gap:7px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.wcf-tab-hero-item{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:12px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12)}
.wcf-tab-hero-item-venue{font-weight:700;font-size:12px;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-tab-hero-item-date{margin-top:4px;font-size:10.5px;color:#64748b}
.wcf-tab-hero-item-price{flex:none;font-family:var(--mono);font-weight:600;font-size:12px;color:#cbd5e1}
.wcf-tab-hero-claimed{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;color:#f5d97a;background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.36);padding:6px 8px;border-radius:20px}
.wcf-tab-hero-pay{flex:none;min-height:44px;padding:0 12px;border-radius:12px;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.34);color:#86efac;font-weight:800;font-size:10.5px;cursor:pointer}
.wcf-tab-hero-note{margin:12px 2px 0;font-size:10.5px;line-height:1.5;color:var(--dim)}
.wcf-tab-ref-code{font-family:var(--mono);font-weight:700;color:var(--white);background:var(--panel2);padding:1px 7px;border-radius:6px;letter-spacing:.5px}
.wcf-booking-row{display:flex;align-items:center;gap:11px;padding:14px;border-radius:18px;margin-bottom:10px;background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));border:1px solid var(--line);box-shadow:0 18px 38px -30px rgba(0,0,0,.9)}
.wcf-booking-date-tile{flex:none;width:46px;height:46px;border-radius:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(13,13,26,.7);border:1px solid rgba(148,163,184,.16)}
.wcf-booking-day{font-family:var(--display);font-weight:800;font-size:15px;color:#f8fafc}
.wcf-booking-month{margin-top:3px;font-weight:700;font-size:8.5px;letter-spacing:.12em;color:var(--dim)}
.wcf-booking-info{flex:1;min-width:0}
.wcf-booking-venue{font-family:var(--display);font-weight:800;font-size:13.5px;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-booking-meta{margin-top:5px;font-size:11px;color:var(--dim)}
.wcf-booking-badge{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;padding:6px 9px;border-radius:20px;white-space:nowrap}
.wcf-booking-badge.green{color:var(--green);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35)}
.wcf-booking-badge.amber{color:var(--amber);background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.35)}
.wcf-account-field{display:flex;flex-direction:column;gap:8px;font-family:var(--sans);font-weight:800;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-account-rename{display:flex;gap:8px}
.wcf-account-rename input{flex:1;min-width:0;min-height:46px;box-sizing:border-box;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:13px;border-radius:12px;font-size:13px;font-weight:600;font-family:var(--sans);text-transform:none;letter-spacing:normal}
.wcf-account-rename button{flex:none;min-height:46px;padding:0 15px;border-radius:12px;background:rgba(46,116,204,.14);border:1px solid rgba(46,116,204,.36);color:#7fb0ec;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-account-rename button:disabled{opacity:.5;cursor:not-allowed}
.wcf-signout{width:100%;margin-top:14px;min-height:46px;padding:13px;border-radius:12px;background:rgba(240,82,94,.1);border:1px solid rgba(240,82,94,.3);color:var(--red-hi);font-weight:700;font-size:12px;cursor:pointer}
.wcf-signout:hover{background:rgba(240,82,94,.16)}
.wcf-push-section{display:flex;flex-direction:column;gap:11px;margin-top:14px;padding:12px 13px;border-radius:14px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12)}
.wcf-rating-section{margin-bottom:0}
.wcf-rating-section h3,.wcf-record-section h3{display:none}
.wcf-rating-note{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 14px}
.wcf-record-section{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
.wcf-record-empty{font-size:11px;color:var(--dim);margin:0}
.wcf-record-pct{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;padding-top:11px;border-top:1px solid rgba(148,163,184,.12)}
.wcf-record-pct b{font-family:var(--display);font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--green)}
.wcf-record-pct span{font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-record-row{display:flex;padding:13px 0;border-radius:14px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12)}
.wcf-record-row>div{flex:1;text-align:center}
.wcf-record-row strong{display:block;font-family:var(--display);font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;color:#f8fafc}
.wcf-record-row span{display:block;margin-top:6px;font-family:var(--sans);font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-rating-form{display:flex;flex-direction:column;gap:14px}
.wcf-rating-row{display:flex;flex-direction:column}
.wcf-rating-row-top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:7px}
.wcf-rating-row-top>span{font-family:var(--sans);font-weight:600;font-size:11px;letter-spacing:.02em;color:var(--dim)}
.wcf-rating-row-top>b{font-family:var(--mono);font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;color:#cbd5e1}
.wcf-rating-track{height:5px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-rating-fill{height:100%;border-radius:5px}
.wcf-rating-row select{margin-top:10px;width:100%;box-sizing:border-box;appearance:none;background:var(--bg);color:var(--white);border:1px solid rgba(148,163,184,.2);padding:13px;border-radius:12px;font-size:13px;font-weight:600;font-family:var(--sans);outline:none;cursor:pointer;min-height:46px}
.wcf-star-picker{display:flex;gap:4px;margin-top:8px}
.wcf-star{background:none;border:none;font-size:18px;color:var(--line);cursor:pointer;padding:0;line-height:1}
.wcf-star.on{color:var(--amber)}
.wcf-push-row{flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-push-label{font-weight:700;font-size:12px;color:#f1f5f9}
.wcf-push-sub{margin-top:5px;font-size:10.5px;line-height:1.35;color:var(--dim)}
.wcf-push-toggle{flex:none;width:44px;height:26px;border-radius:20px;background:var(--panel2);border:1px solid var(--line);cursor:pointer;position:relative;padding:0}
.wcf-push-toggle.on{background:rgba(34,197,94,.3);border-color:rgba(34,197,94,.5)}
.wcf-push-toggle:disabled{opacity:.6;cursor:not-allowed}
.wcf-push-toggle-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--dim);transition:transform .15s ease,background .15s ease}
.wcf-push-toggle.on .wcf-push-toggle-knob{transform:translateX(18px);background:var(--green)}
.wcf-push-test{width:100%;margin-top:9px;min-height:44px;padding:12px;border-radius:12px;background:rgba(148,163,184,.07);border:1px solid rgba(148,163,184,.18);color:#cbd5e1;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-push-note{margin-top:9px;font-size:11px;color:var(--dim);line-height:1.5}
.wcf-guide-row{display:flex;align-items:center;gap:11px;padding:12px 13px;border-radius:14px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12);text-decoration:none;min-height:52px;box-sizing:border-box;cursor:pointer;text-align:left;width:100%;color:inherit;font:inherit}
.wcf-guide-row + .wcf-guide-row{margin-top:7px}
.wcf-guide-tile{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:13px;background:rgba(46,116,204,.16);border:1px solid rgba(46,116,204,.36);color:#7fb0ec}
.wcf-guide-title{flex:1;min-width:0;font-weight:700;font-size:12px;color:#f1f5f9}
.wcf-guide-arrow{flex:none;font-size:14px;color:#64748b}
.wcf-lightbox{position:fixed;inset:0;background:rgba(4,9,20,.92);z-index:100;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 12px 40px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.wcf-lightbox-img{max-width:min(480px,100%);width:100%;border-radius:14px;box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
.wcf-modal-overlay{position:fixed;inset:0;background:rgba(3,7,15,.7);z-index:110;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.wcf-modal{width:100%;max-width:300px;background:linear-gradient(180deg,rgba(30,41,59,.97),rgba(19,22,38,.99));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 30px 70px -20px rgba(0,0,0,.75);animation:wcfPcardIn .2s ease-out}
.wcf-modal-icon{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;font-size:19px;margin-bottom:14px}
.wcf-modal-icon.danger{background:rgba(230,57,70,.15);border:1px solid rgba(230,57,70,.35)}
.wcf-modal-icon.safe{background:rgba(46,116,204,.15);border:1px solid rgba(46,116,204,.35)}
.wcf-modal-title{font-family:var(--display);font-size:16px;font-weight:800;margin-bottom:7px;color:var(--white)}
.wcf-modal-msg{font-size:12.5px;color:var(--dim);line-height:1.55;margin-bottom:20px}
.wcf-modal-actions{display:flex;gap:9px}
.wcf-modal-cancel{flex:1;background:rgba(148,163,184,.08);border:1px solid var(--line);color:var(--dim);padding:12px;border-radius:11px;font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-modal-confirm{flex:1;background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5));color:#fff;border:1px solid rgba(230,57,70,.5);padding:12px;border-radius:11px;font-weight:800;font-size:12.5px;cursor:pointer;box-shadow:0 10px 24px -14px rgba(230,57,70,.8)}
.wcf-modal-confirm.safe{background:linear-gradient(135deg,var(--blue),rgba(46,116,204,.5));border-color:rgba(46,116,204,.5);box-shadow:0 10px 24px -14px rgba(46,116,204,.8)}
@keyframes wcfPcardIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.wcf-pcard{width:100%;max-width:300px;margin:auto;border-radius:20px;overflow:hidden;border:1px solid var(--line);box-shadow:0 26px 50px -30px rgba(0,0,0,.95);animation:wcfPcardIn .22s ease-out}
.wcf-pcard-head{position:relative;padding:26px 20px 20px;text-align:center;background:radial-gradient(120% 90% at 50% 0%,rgba(230,57,70,.22),rgba(30,41,59,.9) 58%,rgba(21,25,42,.98));overflow:hidden}
.wcf-pcard-glow{position:absolute;top:-70px;left:50%;transform:translateX(-50%);width:220px;height:170px;background:radial-gradient(closest-side,rgba(230,57,70,.3),transparent);filter:blur(4px);pointer-events:none}
.wcf-pcard-topline{position:absolute;top:0;left:16px;right:16px;height:1px;background:linear-gradient(to right,transparent,rgba(255,255,255,.24),transparent)}
.wcf-pcard-privacy{position:absolute;top:14px;left:14px;display:flex;align-items:center;gap:5px;padding:5px 9px;border-radius:20px;background:rgba(46,116,204,.18);border:1px solid rgba(46,116,204,.42);font-size:8.5px;font-weight:800;letter-spacing:.14em;color:#7fb0ec}
.wcf-pcard-privacy-dot{width:5px;height:5px;border-radius:50%;background:var(--blue)}
.wcf-pcard-avatar-wrap{position:relative;width:88px;height:88px;margin:8px auto 0}
.wcf-pcard-avatar{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:32px;color:#f8fafc;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),0 0 0 5px rgba(13,13,26,.55),0 0 34px -8px rgba(0,0,0,.7);object-fit:cover}
.wcf-pcard-rank{position:absolute;bottom:-4px;right:-4px;width:30px;height:30px;border-radius:50%;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:11px;color:var(--amber)}
.wcf-pcard-name{margin-top:14px;font-family:var(--display);font-weight:800;font-size:19px;letter-spacing:-.02em;color:#f8fafc}
.wcf-pcard-badges{display:flex;justify-content:center;gap:6px;margin-top:9px}
.wcf-pcard-role-badge{font-weight:800;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 10px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-pcard-team-badge{font-weight:800;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 10px;border-radius:999px;border:1px solid}
.wcf-pcard-body{background:linear-gradient(180deg,rgba(30,41,59,.96),rgba(19,22,38,.99));padding:16px 20px 22px}
.wcf-pcard-stats{display:flex;border-top:1px solid var(--line);padding-top:16px}
.wcf-pcard-stat{flex:1;text-align:center}
.wcf-pcard-stat b{display:block;font-family:var(--display);font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;color:#f8fafc}
.wcf-pcard-stat span{display:block;font-size:9.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-top:6px;font-weight:600}
.wcf-pcard-ratings{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);text-align:left}
.wcf-pcard-ratings-top{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.wcf-pcard-ratings-label{font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.wcf-pcard-ratings-divider{flex:1;height:1px;background:var(--line)}
.wcf-pcard-ratings-visibility{font-size:9px;font-weight:700;letter-spacing:.1em;color:#64748b}
.wcf-pcard-metric{margin-bottom:13px}
.wcf-pcard-metric:last-child{margin-bottom:0}
.wcf-pcard-metric-top{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:var(--dim);margin-bottom:6px}
.wcf-pcard-metric-top span{font-weight:600;letter-spacing:.02em}
.wcf-pcard-metric-top b{font-family:var(--mono);font-weight:700;font-size:12px;font-variant-numeric:tabular-nums;color:#cbd5e1}
.wcf-pcard-track{height:5px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-pcard-fill{height:100%;border-radius:5px}
.wcf-pcard-overall{margin-top:14px;padding-top:13px;border-top:1px solid var(--line);display:flex;align-items:baseline;justify-content:space-between}
.wcf-pcard-overall span{font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-pcard-overall b{font-family:var(--display);font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--blue)}
.wcf-pcard-private{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);text-align:center}
.wcf-pcard-private span{font-size:10.5px;line-height:1.5;color:#64748b}
.wcf-lightbox-close{position:fixed;top:16px;right:16px;width:38px;height:38px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:22px;line-height:1;cursor:pointer;z-index:101}
.wcf-roles-stats{display:flex;gap:9px}
.wcf-roles-stat{flex:1;padding:12px 13px;border-radius:14px}
.wcf-roles-stat.blue{background:linear-gradient(155deg,rgba(46,116,204,.16),rgba(19,22,38,.96) 64%);border:1px solid rgba(46,116,204,.36)}
.wcf-roles-stat.dim{background:linear-gradient(180deg,rgba(30,41,59,.72),rgba(19,22,38,.9));border:1px solid var(--line)}
.wcf-roles-stat-num{display:block;font-family:var(--display);font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;color:#f8fafc}
.wcf-roles-stat-label{display:block;margin-top:7px;font-weight:700;font-size:10px;line-height:1.3;color:var(--dim)}
.wcf-audit-row{display:flex;gap:10px;padding:10px 11px;border-radius:12px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.1);margin-top:8px}
.wcf-audit-row:first-child{margin-top:0}
.wcf-audit-dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:5px}
.wcf-audit-line{flex:1;min-width:0;font-weight:700;font-size:11.5px;line-height:1.35;color:#f1f5f9}
.wcf-audit-line strong{font-weight:800}
.wcf-audit-time{margin-top:5px;font-size:10px;color:#64748b}
.wcf-roles-search{width:100%;box-sizing:border-box;min-height:44px;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:12px;border-radius:12px;font-size:12.5px;font-family:var(--sans);margin:14px 0 2px}
.wcf-roles-row{border-radius:14px;background:rgba(13,13,26,.6);border:1px solid rgba(148,163,184,.12);padding:10px 11px;margin-top:8px}
.wcf-roles-row:first-of-type{margin-top:8px}
.wcf-roles-row-top{display:flex;align-items:center;gap:9px}
.wcf-roles-avatar{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;color:#f8fafc;background:linear-gradient(150deg,var(--blue),#1e3a8a);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);object-fit:cover}
.wcf-roles-row>span{min-width:0;overflow-wrap:break-word;flex:1}
.wcf-roles-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0;margin-top:9px}
.wcf-roles-actions .wcf-ghost{min-height:38px;padding:0 12px;border-radius:11px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.18);color:#cbd5e1;font-weight:700;font-size:10.5px}
.wcf-roles-actions .wcf-ghost.danger{background:rgba(240,82,94,.1);border-color:rgba(240,82,94,.3);color:var(--red-hi)}

.wcf-club-settings,.wcf-add-player{margin-top:18px}
.wcf-club-settings:first-child,.wcf-add-player:first-child{margin-top:0}
.wcf-club-settings h3,.wcf-add-player h3{margin:0 0 9px;font-family:var(--sans);font-weight:800;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-award-row{padding:12px 13px;border-radius:14px;background:linear-gradient(155deg,rgba(234,179,8,.13),rgba(19,22,38,.96) 66%);border:1px solid rgba(234,179,8,.3);margin-top:8px}
.wcf-award-row:first-of-type{margin-top:0}
.wcf-award-top{display:flex;align-items:baseline;gap:9px}
.wcf-award-title{flex:1;min-width:0;font-family:var(--display);font-weight:800;font-size:13px;color:#f8fafc}
.wcf-award-value{flex:none;font-family:var(--display);font-weight:800;font-size:14px;font-variant-numeric:tabular-nums;color:#f5d97a}
.wcf-award-note{margin-top:7px;font-size:11px;line-height:1.45;color:#cbd5e1}
.wcf-award-bottom{display:flex;align-items:center;gap:6px;margin-top:10px}
.wcf-award-tag{font-weight:800;font-size:9px;letter-spacing:.08em;color:#7fb0ec;background:rgba(46,116,204,.14);border:1px solid rgba(46,116,204,.32);padding:5px 8px;border-radius:20px}
.wcf-team-settings{display:flex;flex-direction:column;gap:8px;margin-bottom:6px}
.wcf-team-field{display:flex;flex-direction:column;gap:6px;font-family:var(--sans);font-weight:800;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);min-width:0}
.wcf-team-field.wide{grid-column:1/-1}
.wcf-team-field input{background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:12px;border-radius:12px;font-size:13px;font-weight:600;font-family:var(--sans);text-transform:none;letter-spacing:normal;width:100%;max-width:100%;min-width:0;box-sizing:border-box;display:block;min-height:46px}
.wcf-team-field.color input{width:44px;padding:2px;height:44px;min-height:0;border-radius:50%;cursor:pointer}
.wcf-team-field.narrow input{width:70px}
.wcf-team-row{display:flex;align-items:center;gap:9px}
.wcf-team-row .wcf-team-field{flex:1}
.wcf-field-error{text-transform:none;letter-spacing:normal;font-weight:600;font-size:11px;color:var(--red-hi);margin-top:2px}
.wcf-club-settings .wcf-save,.wcf-add-player .wcf-save{width:100%;margin-top:10px;min-height:48px;padding:14px;border-radius:14px;cursor:pointer;font-weight:800;font-size:12.5px;color:#fff;border:1px solid rgba(230,57,70,.5);background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5))}
.wcf-club-settings .wcf-save:disabled,.wcf-add-player .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed;border-color:var(--line)}
.wcf-upload-row{display:flex;gap:8px;margin-top:8px}
.wcf-upload-box{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:70px;border-radius:14px;background:rgba(13,13,26,.6);border:1px dashed rgba(148,163,184,.3);cursor:pointer;padding:10px;text-align:center}
.wcf-upload-glyph{font-family:var(--display);font-weight:700;font-size:15px;color:#7fb0ec}
.wcf-upload-label{font-weight:700;font-size:9.5px;letter-spacing:.06em;color:var(--dim)}
.wcf-upload-state{font-size:9px;color:#64748b}
.wcf-login-code{margin-top:12px;background:var(--panel2);border:1px solid rgba(51,169,87,.4);border-radius:10px;padding:14px;text-align:center}
.wcf-login-code-value{display:block;font-family:var(--mono);font-weight:800;font-size:28px;letter-spacing:4px;color:var(--green)}
.wcf-login-code-note{display:block;font-size:11px;color:var(--dim);margin-top:6px;line-height:1.4}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-edit{grid-template-columns:1fr} }

/* Three pill buttons (Update/Month/Fixture) in the fixtures header don't
   fit their natural width on the narrowest phones (iPhone SE and similar,
   ~375px) - .wcf-root clips overflow rather than scrolling, so the last
   button silently loses its label instead of erroring. Tightens padding
   and gap rather than shortening labels, so it still reads the same. */
@media (max-width:400px){
  .wcf-heading-actions{gap:5px}
  .wcf-addbtn{padding:8px 10px;font-size:11px;gap:4px}
}
`;
