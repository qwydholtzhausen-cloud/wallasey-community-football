"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";
import { MOTM_VOTE_WINDOW_MINUTES, kickoffCutoff, nowInLondon, previousMonthKey } from "../lib/time";
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
  onSave: (fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  saveLabel: string;
}) {
  const [fitness, setFitness] = useState(initial?.fitness ?? 3);
  const [attack, setAttack] = useState(initial?.attack ?? 3);
  const [defence, setDefence] = useState(initial?.defence ?? 3);
  const [position, setPosition] = useState<PlayerPosition>(initial?.position ?? "midfield");

  return (
    <div className="wcf-rating-form">
      <div className="wcf-rating-row"><span>Fitness</span><StarPicker value={fitness} onChange={setFitness} /></div>
      <div className="wcf-rating-row"><span>Attack</span><StarPicker value={attack} onChange={setAttack} /></div>
      <div className="wcf-rating-row"><span>Defence</span><StarPicker value={defence} onChange={setDefence} /></div>
      <div className="wcf-rating-row">
        <span>Position</span>
        <select value={position} onChange={(e) => setPosition(e.target.value as PlayerPosition)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>{POSITION_LABEL[p]}</option>
          ))}
        </select>
      </div>
      <button className="wcf-save" onClick={() => onSave(fitness, attack, defence, position)}>{saveLabel}</button>
    </div>
  );
}

interface Profile {
  id: string;
  display_name: string;
  role: Role;
  created_at?: string;
  push_opt_in?: boolean;
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
  | { key: string; ts: number; kind: "derived"; icon: string; tone: "amber" | "green" | "blue"; text: React.ReactNode };

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
  } else if (outfield <= 6) {
    rows = [
      { count: Math.ceil(outfield / 2), role: "Defence" },
      { count: Math.floor(outfield / 2), role: "Attack" },
    ];
  } else {
    const back = Math.ceil(outfield / 3);
    const remaining = outfield - back;
    const mid = Math.ceil(remaining / 2);
    const att = remaining - mid;
    rows = att > 0
      ? [{ count: back, role: "Defence" }, { count: mid, role: "Midfield" }, { count: att, role: "Attack" }]
      : [{ count: back, role: "Defence" }, { count: mid, role: "Midfield" }];
  }
  const rowYs = rows.length === 1 ? [24] : rows.length === 2 ? [20, 34] : [18, 30, 42];
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

// Draws the shareable post-match result card. Sizing verified against
// several scorer-count and no-scorer/no-MOTM cases in a standalone test
// (scratchpad, not part of the app) before wiring in, since canvas text
// layout bugs are easy to get wrong and don't show up until rendered.
async function drawResultCard(opts: {
  venue: string;
  dateLabel: string;
  whiteName: string;
  redName: string;
  whiteColor: string;
  redColor: string;
  whiteScore: number;
  redScore: number;
  whiteScorers: { name: string; goals: number }[];
  redScorers: { name: string; goals: number }[];
  motmWinner: string | null;
}): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas isn't supported on this device");

  ctx.fillStyle = "#0A1A34";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.75);
  grad.addColorStop(0, "rgba(228,42,54,0.20)");
  grad.addColorStop(1, "rgba(228,42,54,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H * 0.55);

  const pad = 64;

  try {
    const crest = await loadImage("/logo.png");
    const crestSize = 78;
    ctx.save();
    roundRectPath(ctx, pad, pad, crestSize, crestSize, 20);
    ctx.clip();
    ctx.drawImage(crest, pad, pad, crestSize, crestSize);
    ctx.restore();
  } catch {
    // Crest failed to load (offline etc.) - card still works without it.
  }

  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = "#EEF4FC";
  ctx.font = "800 32px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("WIRRAL", pad + 96, pad + 8);
  ctx.fillStyle = "#E42A36";
  ctx.font = "800 16px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("C O M M U N I T Y   F O O T B A L L", pad + 96, pad + 48);

  ctx.textAlign = "center";
  ctx.fillStyle = "#8FA6C8";
  ctx.font = "800 24px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("F U L L   T I M E", W / 2, 300);

  const scoreY = 350;
  const colW = 260;
  ctx.textBaseline = "top";
  ctx.font = "800 30px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#D9E4F5";
  ctx.fillText(opts.whiteName.toUpperCase(), W / 2 - colW, scoreY);
  ctx.fillStyle = "#F0616A";
  ctx.fillText(opts.redName.toUpperCase(), W / 2 + colW, scoreY);

  ctx.textBaseline = "alphabetic";
  ctx.font = "800 150px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = opts.whiteColor;
  ctx.fillText(String(opts.whiteScore), W / 2 - colW, scoreY + 175);
  ctx.fillStyle = opts.redColor;
  ctx.fillText(String(opts.redScore), W / 2 + colW, scoreY + 175);
  ctx.strokeStyle = "#8FA6C8";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(W / 2 - 22, scoreY + 130);
  ctx.lineTo(W / 2 + 22, scoreY + 130);
  ctx.stroke();

  ctx.textBaseline = "top";
  ctx.font = "500 24px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#8FA6C8";
  ctx.fillText(`${opts.venue} · ${opts.dateLabel}`, W / 2, scoreY + 200);

  ctx.strokeStyle = "rgba(200,218,245,0.13)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, scoreY + 260);
  ctx.lineTo(W - pad, scoreY + 260);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.font = "800 20px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#8FA6C8";
  ctx.fillText("⚽  GOALS", pad, scoreY + 300);

  const rowsY = scoreY + 350;
  const rowH = 42;
  const maxRows = Math.max(opts.whiteScorers.length, opts.redScorers.length, 1);
  opts.whiteScorers.forEach((s, i) => {
    ctx.font = "600 24px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#EEF4FC";
    ctx.textAlign = "left";
    ctx.fillText(s.name, pad, rowsY + i * rowH);
    ctx.font = "700 24px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#8FA6C8";
    ctx.textAlign = "right";
    ctx.fillText(String(s.goals), pad + 400, rowsY + i * rowH);
  });
  opts.redScorers.forEach((s, i) => {
    ctx.font = "600 24px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#EEF4FC";
    ctx.textAlign = "left";
    ctx.fillText(s.name, W / 2 + 30, rowsY + i * rowH);
    ctx.font = "700 24px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#8FA6C8";
    ctx.textAlign = "right";
    ctx.fillText(String(s.goals), W - pad, rowsY + i * rowH);
  });

  if (opts.motmWinner) {
    let motmY = rowsY + maxRows * rowH + 70;
    motmY = Math.max(motmY, scoreY + 500);
    motmY = Math.min(motmY, H - 210);

    roundRectPath(ctx, pad, motmY, W - pad * 2, 110, 18);
    ctx.fillStyle = "rgba(224,167,51,0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(224,167,51,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "40px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#E0A733";
    ctx.fillText("🏆", pad + 24, motmY + 30);

    ctx.font = "800 15px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#E0A733";
    ctx.fillText("M A N   O F   T H E   M A T C H", pad + 100, motmY + 26);

    ctx.font = "800 28px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillStyle = "#EEF4FC";
    ctx.fillText(opts.motmWinner, pad + 100, motmY + 54);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "800 15px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#8FA6C8";
  ctx.fillText("W I R R A L C O M M U N I T Y F O O T B A L L", W / 2, H - 44);

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

function defaultNewGameDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
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
        <div className="wcf-splash">
          <span className="wcf-logo big">
            <img src="/logo.png" alt="Wirral Community Football crest" />
          </span>
        </div>
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
      <span className="wcf-logo big">
        <img src="/logo.png" alt="Wirral Community Football crest" />
      </span>
      <div className="wcf-wordmark">WIRRAL</div>
      <div className="wcf-wordmark-sub">COMMUNITY FOOTBALL</div>

      {sent ? (
        <form className="wcf-signin-form" onSubmit={verifyCode}>
          <p className="wcf-signin-sent">
            Enter the code emailed to <strong>{email}</strong>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            required
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" disabled={verifying || !code.trim()}>
            {verifying ? "Checking…" : "Verify code"}
          </button>
          {error && <p className="wcf-signin-error">{error}</p>}
          <button type="button" className="wcf-signin-back" onClick={() => { setSent(false); setCode(""); setError(null); }}>
            Use a different email
          </button>
        </form>
      ) : (
        <form className="wcf-signin-form" onSubmit={sendCode}>
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
          {error && <p className="wcf-signin-error">{error}</p>}
          <button type="button" className="wcf-signin-back" disabled={!email.trim()} onClick={() => setSent(true)}>
            I already have a code
          </button>
        </form>
      )}

      <p className="wcf-privacy-note">
        We only store your name, email, and booking history to run the club — nothing else.
      </p>
    </div>
  );
}

function App({ session }: { session: Session }) {
  const myId = session.user.id;
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
  const [resultsView, setResultsView] = useState<"season" | "table" | "fixtures" | "pot" | "finances">("season");
  const [potAmount, setPotAmount] = useState("");
  const [potDescription, setPotDescription] = useState("");
  const [potEntryKind, setPotEntryKind] = useState<"add" | "deduct">("add");
  const [potCategory, setPotCategory] = useState<PotCategory>("other");
  const [addingPotEntry, setAddingPotEntry] = useState(false);
  const [resultsMonth, setResultsMonth] = useState<string>("all");
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [playerCardId, setPlayerCardId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [editingLineup, setEditingLineup] = useState(false);
  const [lineupDisplayView, setLineupDisplayView] = useState<"pitch" | "list">("pitch");
  const [selectedLineupPlayerId, setSelectedLineupPlayerId] = useState<string | null>(null);
  const [teamDraft, setTeamDraft] = useState<Record<string, Team | null>>({});
  const [clipTitle, setClipTitle] = useState("");
  const [clipUrl, setClipUrl] = useState("");
  const [feedView, setFeedView] = useState<"feed" | "clips">("feed");

  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "co-owner" || myProfile?.role === "owner";
  const isOwner = myProfile?.role === "owner";
  const cs: ClubSettings = clubSettings ?? {
    team_white_name: "Whites",
    team_white_color: "#EEF4FC",
    team_red_name: "Reds",
    team_red_color: "#E42A36",
    default_venue: "New venue",
    default_kickoff: "19:00",
    default_price: 5,
    default_pitch: "8-a-side",
    default_max_players: MAX_SPOTS,
    last_fixture_update_at: null,
  };

  const loadProfile = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, push_opt_in").eq("id", myId).single();
    if (data) setMyProfile(data as Profile);
  }, [myId]);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, created_at").order("display_name");
    if (data) setProfiles(data as Profile[]);
  }, []);

  const loadGames = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select(
        "id, date, kickoff, venue, pitch, price, max_players, pitch_cost, team_white_score, team_red_score, published, team_method, team_balance_score, bookings(id, player_id, status, waiting, team, created_at, pot_exempt_reason, player:profiles!bookings_player_id_fkey(id, display_name, role), confirmer:profiles!bookings_confirmed_by_fkey(display_name))"
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
    const { data } = await supabase.from("player_self_ratings").select("player_id, fitness, attack, defence, position");
    if (data) setSelfRatings(data as PlayerRating[]);
  }, []);
  const loadAdminRatings = useCallback(async () => {
    const { data } = await supabase.from("player_admin_ratings").select("player_id, fitness, attack, defence, position");
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
      .select("id, game_id, player_id, goals, player:profiles(id, display_name, role)")
      .order("goals", { ascending: false });
    if (data) setGoalRows(data as unknown as GoalRow[]);
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

  async function saveSelfRating(fitness: number, attack: number, defence: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_self_ratings")
      .upsert({ player_id: myId, fitness, attack, defence, position, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Saved your self-rating");
    await loadSelfRatings();
  }

  async function saveAdminRating(playerId: string, fitness: number, attack: number, defence: number, position: PlayerPosition) {
    const { error } = await supabase
      .from("player_admin_ratings")
      .upsert({ player_id: playerId, fitness, attack, defence, position, updated_by: myId, updated_at: new Date().toISOString() });
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
          { user_id: myId, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_key: json.keys?.auth },
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
  async function addBooking(gameId: string, playerId: string) {
    const { data, error } = await supabase.from("bookings").insert({ game_id: gameId, player_id: playerId }).select("waiting").single();
    if (error) return notifyError(error.message);
    if (data && !data.waiting) pushNotify("notify-last-spot", { gameId });
  }
  async function cancel(bookingId: string) {
    const { error } = await supabase.from("bookings").delete().eq("id", bookingId);
    if (error) notifyError(error.message);
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

  async function addGame() {
    // Created unpublished - only visible to admins until the first Save,
    // which is when it actually becomes real (see saveGame). Avoids both
    // players glimpsing a "New venue" placeholder and the new-fixture push
    // firing with today's default date before anyone's actually set the
    // real details.
    const { data, error } = await supabase
      .from("games")
      .insert({
        date: defaultNewGameDate(),
        kickoff: cs.default_kickoff,
        venue: cs.default_venue,
        pitch: cs.default_pitch,
        price: cs.default_price,
        max_players: cs.default_max_players,
        published: false,
      })
      .select()
      .single();
    if (error) return notifyError(error.message);
    await loadGames();
    if (data) setEditingId(data.id);
  }
  async function saveGame(id: string, patch: Partial<GameRow>) {
    const { bookings: _bookings, published: _published, ...rest } = patch as GameRow;
    const wasPublished = games.find((g) => g.id === id)?.published;
    const { error } = await supabase.from("games").update({ ...rest, published: true }).eq("id", id);
    if (error) return notifyError(error.message);
    await loadGames();
    setEditingId(null);
    // First confirm of a draft fixture is what actually announces it -
    // later edits to an already-published fixture don't re-announce.
    if (!wasPublished) {
      pushNotify("notify-new-fixture", { gameId: id });
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
  async function saveResult(gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) {
    const { error: scoreErr } = await supabase
      .from("games")
      .update({ team_white_score: whiteScore, team_red_score: redScore })
      .eq("id", gameId);
    if (scoreErr) return notifyError(scoreErr.message);

    const rows = Object.entries(goals).map(([player_id, goals]) => ({ game_id: gameId, player_id, goals }));
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

  async function castMotmVote(gameId: string, candidateId: string) {
    const { error } = await supabase
      .from("motm_votes")
      .upsert({ game_id: gameId, voter_id: myId, candidate_id: candidateId }, { onConflict: "game_id,voter_id" });
    if (error) return notifyError(error.message);
    await loadMotmVotes();
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
        dateLabel: fmtDate(game.date),
        whiteName: cs.team_white_name,
        redName: cs.team_red_name,
        whiteColor: cs.team_white_color,
        redColor: cs.team_red_color,
        whiteScore: game.team_white_score ?? 0,
        redScore: game.team_red_score ?? 0,
        whiteScorers,
        redScorers,
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

  async function renameSelf(name: string) {
    if (!name.trim()) return;
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", myId);
    if (error) return notifyError(error.message);
    await Promise.all([loadProfile(), loadProfiles()]);
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
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, 90) > nowUk).sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)),
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
    () => games.filter((g) => kickoffCutoff(g.date, g.kickoff, 90) <= nowUk).sort((a, b) => b.date.localeCompare(a.date) || b.kickoff.localeCompare(a.kickoff)),
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
        ts: toMs(kickoffCutoff(g.date, g.kickoff, 90)),
        kind: "derived",
        icon: "⚽",
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
            icon: "🏆",
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
          icon: "💰",
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
        icon: "🎉",
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
            ts: toMs(kickoffCutoff(g.date, g.kickoff, 90)),
            kind: "derived",
            icon: "🎖️",
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
  const [statsSort, setStatsSort] = useState<"apps" | "goals">("apps");
  const [statsOpenId, setStatsOpenId] = useState<string | null>(null);
  const activeStatsYear = statsSeasonYear ?? currentSeasonYear;
  const seasonYears = useMemo(() => {
    const set = new Set(pastGames.map((g) => Number(g.date.slice(0, 4))));
    set.add(currentSeasonYear);
    return Array.from(set).sort((a, b) => b - a);
  }, [pastGames, currentSeasonYear]);

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
    return (
      <div className="wcf-splash">
        <span className="wcf-logo big">
          <img src="/logo.png" alt="Wirral Community Football crest" />
        </span>
      </div>
    );
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
          {myProfile.display_name}
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
              <button className="wcf-addbtn ghost" onClick={copyFixtureUpdate} title="Copy a WhatsApp fixture update">📋 Update</button>
              <button
                className="wcf-addbtn"
                onClick={async () => { if (await askConfirm("Add a new fixture?", "You can fill in the details and post it once it's ready.", "Add", false)) addGame(); }}
              >
                + Fixture
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
                  onOpenPlayerCard={setPlayerCardId}
                  weather={weatherFor(nextFixtureForCountdown.date, nextFixtureForCountdown.kickoff)}
                  askConfirm={askConfirm}
                />
                {upcomingGames.length > 1 && <div className="wcf-eyebrow" style={{ marginTop: 4 }}>Upcoming fixtures</div>}
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
                      onOpenPlayerCard={setPlayerCardId}
                      weather={weatherFor(g.date, g.kickoff)}
                      askConfirm={askConfirm}
                    />
                  ))}
                </div>
              );
            })}
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

        {tab === "feed" && (
          <>
            <div className="wcf-subtabs">
              <button className={feedView === "feed" ? "active" : ""} onClick={() => setFeedView("feed")}>Feed</button>
              <button className={feedView === "clips" ? "active" : ""} onClick={() => setFeedView("clips")}>Clips</button>
            </div>

            {feedView === "clips" && (
              <form className="wcf-clip-form" onSubmit={addClip}>
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
            {visibleFeedItems.map((item) => {
              const tally = feedReactionTally[item.key] ?? {};
              const reactionRow = (
                <div className="wcf-feed-reactions">
                  {FEED_REACTION_EMOJI.map((emoji) => {
                    const count = tally[emoji] ?? 0;
                    const mine = feedReactions.some((r) => r.item_key === item.key && r.emoji === emoji && r.user_id === myId);
                    return (
                      <button
                        key={emoji}
                        className={"wcf-feed-reaction" + (mine ? " mine" : "")}
                        onClick={() => toggleReaction(item.key, emoji)}
                      >
                        {emoji} {count > 0 ? count : ""}
                      </button>
                    );
                  })}
                </div>
              );

              if (item.kind === "clip") {
                const c = item.clip;
                const videoId = c.video_url ? youtubeVideoId(c.video_url) : null;
                return (
                  <article key={item.key} className="wcf-clip">
                    {c.video_url ? (
                      <a className="wcf-clip-thumb" href={c.video_url} target="_blank" rel="noreferrer">
                        {videoId ? (
                          <>
                            <img src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" />
                            <span className="wcf-clip-play">▶</span>
                          </>
                        ) : (
                          <span>▶</span>
                        )}
                      </a>
                    ) : (
                      <div className="wcf-clip-thumb">
                        <span>▶</span>
                      </div>
                    )}
                    <div className="wcf-clip-body">
                      <div className="wcf-clip-title">{c.title}</div>
                      <div className="wcf-clip-sub">shared by {c.submitter?.display_name ?? "someone"} · {fmtFeedDate(item.ts)}</div>
                      {reactionRow}
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
              }

              const isHidden = hiddenFeedKeys.includes(item.key);
              return (
                <article key={item.key} className="wcf-feed-item">
                  <div className={"wcf-feed-icon " + item.tone}>{item.icon}</div>
                  <div className="wcf-feed-body">
                    <div className="wcf-feed-text">{item.text}</div>
                    <div className="wcf-feed-date">{fmtFeedDate(item.ts)}</div>
                    {reactionRow}
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
                </article>
              );
            })}
          </>
        )}

        {tab === "lineup" && (
          <>
            <div className="wcf-subtabs">
              <button className={lineupView === "sheet" ? "active" : ""} onClick={() => setLineupView("sheet")}>Team Sheet</button>
              {isAdmin && (
                <button className={lineupView === "fairness" ? "active" : ""} onClick={() => setLineupView("fairness")}>Fairness</button>
              )}
              <button className={lineupView === "predict" ? "active" : ""} onClick={() => setLineupView("predict")}>🔮 Predict</button>
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
                        <button className="wcf-lineup-pill" onClick={copyLineup}>📋 Copy for WhatsApp</button>
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
                  const redSlots = formationSlots(nextGrouped.red.length);
                  const whiteSlots = formationSlots(nextGrouped.white.length);
                  const redTokens = nextGrouped.red.map((b, i) => ({ booking: b, isRed: true, x: redSlots[i].x, y: redSlots[i].y, role: redSlots[i].role }));
                  const whiteTokens = nextGrouped.white.map((b, i) => ({ booking: b, isRed: false, x: whiteSlots[i].x, y: 100 - whiteSlots[i].y, role: whiteSlots[i].role }));
                  const allTokens = [...redTokens, ...whiteTokens];
                  const selected = allTokens.find((t) => t.booking.player_id === selectedLineupPlayerId);
                  const selectedStats = selected ? playerStats.find((p) => p.id === selected.booking.player_id) : null;
                  const selectColor = (isRed: boolean) => (isRed ? cs.team_red_color : cs.team_white_color);

                  const renderToken = (t: (typeof allTokens)[number]) => {
                    const me = t.booking.player_id === myId;
                    const color = selectColor(t.isRed);
                    return (
                      <button
                        key={t.booking.id}
                        className="wcf-lineup-token"
                        style={{ left: `${t.x}%`, top: `${t.y}%` }}
                        onClick={() => setSelectedLineupPlayerId((v) => (v === t.booking.player_id ? null : t.booking.player_id))}
                      >
                        <span
                          className="wcf-lineup-token-chip"
                          style={{ background: teamGradient(color), color: readableTextColor(color), boxShadow: me ? "0 0 0 2px var(--blue), 0 6px 14px -6px rgba(0,0,0,.85)" : undefined }}
                        >
                          {t.booking.player.display_name[0]?.toUpperCase()}
                        </span>
                        <span className="wcf-lineup-token-label">{t.booking.player.display_name.split(" ")[0]}</span>
                      </button>
                    );
                  };

                  return (
                    <>
                      {lineupDisplayView === "pitch" && (
                        <div className="wcf-lineup-pitch-card">
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
                      {lineupDisplayView === "pitch" && (
                        <p className="wcf-lineup-pitch-note">
                          {cs.team_red_name} attack down, {cs.team_white_name} attack up. Tap a shirt for that player&apos;s season stats.
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
                                  <span className="wcf-lineup-list-chip" style={{ background: teamGradient(color), color: readableTextColor(color) }}>
                                    {b.player.display_name[0]?.toUpperCase()}
                                  </span>
                                  <span className="wcf-lineup-list-name">{b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      {selected && (
                        <div className="wcf-lineup-selected">
                          <span
                            className="wcf-lineup-selected-chip"
                            style={{ background: teamGradient(selectColor(selected.isRed)), color: readableTextColor(selectColor(selected.isRed)) }}
                          >
                            {selected.booking.player.display_name[0]?.toUpperCase()}
                          </span>
                          <div className="wcf-lineup-selected-body">
                            <div className="wcf-lineup-selected-name">
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
                        <span className="wcf-lineup-avatar">{b.player.display_name[0]?.toUpperCase()}</span>
                        <button className="wcf-lineup-name wcf-name-link" onClick={() => setPlayerCardId(b.player_id)}>
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
                      <div className="wcf-predict-gate-icon">🔮</div>
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
                        <span className="wcf-pl-leader-avatar" style={{ background: avatarFor(leader.playerName).gradient }}>
                          {avatarFor(leader.playerName).initial}
                        </span>
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
                              <span className="wcf-pl-avatar" style={{ background: a.gradient }}>{a.initial}</span>
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
              {isAdmin && (
                <button className={resultsView === "finances" ? "active" : ""} onClick={() => setResultsView("finances")}>Finances</button>
              )}
            </div>

            {resultsView === "season" && (
              <>
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
            )}

            {resultsView === "table" && (() => {
              const sorted = [...playerStats].sort((a, b) =>
                statsSort === "goals" ? b.goals - a.goals || b.apps - a.apps : b.apps - a.apps || b.goals - a.goals
              );
              const byGoals = [...playerStats].sort((a, b) => b.goals - a.goals || b.apps - a.apps).slice(0, 3);
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
                                <span style={{ fontSize: lead ? 26 : 20 }}>{a.initial}</span>
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
                          <div className="wcf-lb-me-label">Your<br />rank</div>
                          <div className="wcf-lb-me-name">{me.name}</div>
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
                            <span className="wcf-lb-row-avatar" style={{ background: a.gradient }}>{a.initial}</span>
                            <button
                              className="wcf-board-name wcf-name-link"
                              onClick={(e) => { e.stopPropagation(); setPlayerCardId(row.id); }}
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
                {filteredResults.map((g) => {
                  const scorers = goalRows.filter((r) => r.game_id === g.id && r.goals > 0).sort((a, b) => b.goals - a.goals);
                  const teamOf = (playerId: string) => g.bookings.find((b) => b.player_id === playerId)?.team;
                  const whiteScorers = scorers.filter((s) => teamOf(s.player_id) === "white");
                  const redScorers = scorers.filter((s) => teamOf(s.player_id) === "red");
                  // Who actually played, not who's been payment-confirmed -
                  // those often lag behind by days, and voting closes hours
                  // after kickoff.
                  const candidates = g.bookings.filter((b) => !b.waiting);
                  const votingOpen = motmVotingOpen(g);
                  const tally = motmTallyByGame[g.id] ?? {};
                  const totalVotes = Object.values(tally).reduce((sum, n) => sum + n, 0);
                  const myVote = myMotmVoteByGame[g.id];
                  const ranked = candidates
                    .map((c) => ({ candidate: c, votes: tally[c.player_id] ?? 0 }))
                    .sort((a, b) => b.votes - a.votes);
                  const topVotes = ranked[0]?.votes ?? 0;
                  const expanded = expandedResultId === g.id;
                  return (
                    <article key={g.id} className="wcf-result">
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
                                      <button className="wcf-name-link" onClick={() => setPlayerCardId(s.player_id)}>{s.player.display_name}</button>
                                      <b>{s.goals}</b>
                                    </div>
                                  ))}
                                </div>
                                <div className="wcf-result-goals-col">
                                  {redScorers.map((s) => (
                                    <div key={s.id} className="wcf-result-goal-row">
                                      <button className="wcf-name-link" onClick={() => setPlayerCardId(s.player_id)}>{s.player.display_name}</button>
                                      <b>{s.goals}</b>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </>
                          )}

                          {candidates.length > 0 && votingOpen && (
                            <div className="wcf-motm">
                              <div className="wcf-motm-label">Vote Man of the Match · results hidden until voting closes</div>
                              <div className="wcf-motm-candidates">
                                {candidates.map((c) => (
                                  <button
                                    key={c.id}
                                    className={"wcf-motm-vote" + (myVote === c.player_id ? " voted" : "")}
                                    onClick={() => castMotmVote(g.id, c.player_id)}
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
                              {ranked.filter((r) => r.votes > 0).map((r) => (
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
                                </div>
                              ))}
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
                                  <span className="wcf-predict-reveal-title">🔮 Predictions</span>
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
                                          Your guess: <b>{cs.team_white_name} {myGamePrediction.predictedWhite}–{myGamePrediction.predictedRed} {cs.team_red_name}</b>
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

            {resultsView === "pot" && (
              <>
                <div className="wcf-pot-total">
                  <div className="wcf-pot-total-label">Community pot</div>
                  <div className={"wcf-pot-total-amount" + (potTotal < 0 ? " negative" : "")}>
                    {potTotal < 0 ? "−" : ""}£{Math.abs(potTotal).toFixed(2)}
                  </div>
                  <p className="wcf-pot-total-note">
                    Built up from game surpluses (match fees vs pitch hire) plus socials, sponsorship and other contributions.
                    Goes towards equipment, socials and running the club.
                  </p>
                </div>

                {isAdmin && (
                  <>
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

                    {potLedger.length === 0 && <p className="wcf-empty">Nothing in the ledger yet.</p>}
                    {potLedger.map((entry) => (
                      <div key={entry.id} className="wcf-pot-row">
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
                  </>
                )}
              </>
            )}

            {resultsView === "finances" && isAdmin && (
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

                {financeSummary.balancePoints.length > 0 && (
                  <div className="wcf-fin-card">
                    <div className="wcf-fin-card-head">Balance over time</div>
                    <div className="wcf-fin-chart">
                      {financeSummary.balancePoints.slice(-8).map((p, i) => {
                        const maxAbs = Math.max(1, ...financeSummary.balancePoints.slice(-8).map((q) => Math.abs(q.balance)));
                        const height = (Math.abs(p.balance) / maxAbs) * 100;
                        return (
                          <div key={i} className="wcf-fin-bar-col">
                            <div className={"wcf-fin-bar" + (p.balance < 0 ? " neg" : "")} style={{ height: `${height}%` }} />
                            <div className="wcf-fin-bar-label">{fmtDate(p.date).slice(0, 6)}</div>
                          </div>
                        );
                      })}
                    </div>
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

                <button className="wcf-ghost wcf-fin-export" onClick={exportFinanceCsv}>⬇ Export season as CSV</button>
              </>
            )}
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
            onSetRole={setRole}
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
        return <PlayerCardModal profile={cardProfile} stats={stats} rating={rating} onClose={() => setPlayerCardId(null)} />;
      })()}

      {confirmState && (
        <div className="wcf-modal-overlay" onClick={() => resolveConfirm(false)}>
          <div className="wcf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wcf-modal-icon">{confirmState.danger ? "⚠️" : "❓"}</div>
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
function PlayerCardModal({
  profile,
  stats,
  rating,
  onClose,
}: {
  profile: Profile;
  stats: { apps: number; goals: number; motm: number };
  rating: PlayerRating | null;
  onClose: () => void;
}) {
  return (
    <div className="wcf-lightbox" onClick={onClose}>
      <button className="wcf-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div className="wcf-pcard" onClick={(e) => e.stopPropagation()}>
        <span className="wcf-avatar big">{profile.display_name[0]?.toUpperCase()}</span>
        <div className="wcf-pcard-name">{profile.display_name}</div>
        <span className={"wcf-role-badge " + profile.role}>{ROLE_LABEL[profile.role]}</span>
        <div className="wcf-pcard-stats">
          <div className="wcf-pcard-stat"><b>{stats.apps}</b><span>Apps</span></div>
          <div className="wcf-pcard-stat"><b>{stats.goals}</b><span>Goals</span></div>
          <div className="wcf-pcard-stat"><b>{stats.motm}</b><span>MOTM</span></div>
        </div>
        {rating && (
          <div className="wcf-pcard-ratings">
            <div className="wcf-pcard-ratings-label">Rating</div>
            {(["fitness", "attack", "defence"] as const).map((k) => (
              <div key={k} className="wcf-pcard-metric">
                <div className="wcf-pcard-metric-top">
                  <span>{k[0].toUpperCase()}{k.slice(1)}</span>
                  <b>{rating[k].toFixed(1)}</b>
                </div>
                <div className="wcf-pcard-track">
                  <div className="wcf-pcard-fill" style={{ width: `${(rating[k] / 5) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
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
  title,
  open,
  onToggle,
  children,
}: {
  icon: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="wcf-accordion">
      <button className="wcf-accordion-head" onClick={onToggle}>
        <span>{icon} {title}</span>
        <span className="wcf-accordion-chevron">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="wcf-accordion-body">{children}</div>}
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
  onSetRole,
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
  onSaveSelfRating: (fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  adminRatings: PlayerRating[];
  onSaveAdminRating: (playerId: string, fitness: number, attack: number, defence: number, position: PlayerPosition) => void;
  ratingPlayerId: string | null;
  onToggleRatingPlayer: (id: string) => void;
  clubSettings: ClubSettings;
  pushStats: { total: number; subscribed: number } | null;
  awards: AwardRow[];
  onRename: (name: string) => void;
  onSetRole: (id: string, role: Role) => void;
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
  const [showRoles, setShowRoles] = useState(false);
  const [roleSearch, setRoleSearch] = useState("");
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
        <span className="wcf-avatar big">{profile.display_name[0]?.toUpperCase()}</span>
        <div>
          <div className="wcf-account-name">{profile.display_name}</div>
          <div className="wcf-account-email">{email}</div>
        </div>
        <span className={"wcf-role-badge " + profile.role}>{ROLE_LABEL[profile.role]}</span>
      </div>

      {myMessages.length > 0 && (
        <div className="wcf-inbox">
          <div className="wcf-inbox-head">
            <h4>✉️ Messages</h4>
            {unreadMessages.length > 0 && <span className="wcf-inbox-unread-pill">{unreadMessages.length}</span>}
          </div>
          {myMessages.map((m) => (
            <div key={m.id} className={"wcf-msg-card " + (m.read_at ? "" : "unread")}>
              <div className="wcf-msg-from">From an admin · {fmtDateTime(m.created_at)}</div>
              <div className="wcf-msg-text">{m.message}</div>
              {m.read_at ? (
                <p className="wcf-msg-read-note">Marked as read</p>
              ) : (
                <button className="wcf-msg-ack" onClick={() => onMarkMessageRead(m.id)}>Got it 👍 Mark as read</button>
              )}
            </div>
          ))}
        </div>
      )}

      {(myTabOwed.length > 0 || myTabPending.length > 0) && (
        <div className="wcf-upcoming">
          <h4>💷 Your tab</h4>
          {myTabOwed.map(({ game, booking }) => (
            <div key={booking.id} className="wcf-upcoming-row">
              <div className="wcf-upcoming-body">
                <div className="wcf-upcoming-venue">{game.venue}</div>
                <div className="wcf-upcoming-date">{fmtDate(game.date)} · £{game.price} owed</div>
              </div>
              <button className="wcf-tab-self-pay" onClick={() => onMarkPaid(booking.id)}>I&apos;ve paid</button>
            </div>
          ))}
          {myTabPending.map(({ game, booking }) => (
            <div key={booking.id} className="wcf-upcoming-row">
              <div className="wcf-upcoming-body">
                <div className="wcf-upcoming-venue">{game.venue}</div>
                <div className="wcf-upcoming-date">{fmtDate(game.date)} · £{game.price}</div>
              </div>
              <span className="wcf-tab-self-pending">⏳ Awaiting confirmation</span>
            </div>
          ))}
        </div>
      )}

      {myUpcomingBookings.length > 0 && (
        <div className="wcf-upcoming">
          <h4>📅 Your upcoming bookings</h4>
          {myUpcomingBookings.map(({ game, booking }) => (
            <div key={game.id} className="wcf-upcoming-row">
              <div className="wcf-upcoming-body">
                <div className="wcf-upcoming-venue">{game.venue}</div>
                <div className="wcf-upcoming-date">{fmtDate(game.date)} · {game.kickoff}</div>
              </div>
              {booking.waiting ? <span className="wcf-upcoming-waiting">Waiting list</span> : <StatusBadge status={booking.status} />}
            </div>
          ))}
        </div>
      )}

      <div className="wcf-account-always">Settings &amp; reference</div>

      <AccordionSection icon="⚙️" title="Account settings" open={openAccountSettings} onToggle={() => setOpenAccountSettings((v) => !v)}>
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
              onClick={async () => {
                setPushBusy(true);
                if (pushOn) await onDisablePush();
                else await onEnablePush();
                setPushBusy(false);
              }}
            >
              {pushBusy ? "…" : pushOn ? "On" : "Off"}
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

      <AccordionSection icon="⭐" title="Your rating &amp; record" open={openRating} onToggle={() => setOpenRating((v) => !v)}>
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

      <AccordionSection icon="📖" title="Getting set up" open={openGuides} onToggle={() => setOpenGuides((v) => !v)}>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("install")}>
          <span>📱 Add to your home screen</span>
          <span className="wcf-guide-arrow">›</span>
        </button>
        <button className="wcf-guide-row" onClick={() => setOpenGuide("notifications")}>
          <span>🔔 Enable notifications</span>
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

      {isAdmin && <div className="wcf-account-always">Admin</div>}

      {isAdmin && (
        <AccordionSection icon="👥" title={`Manage roles · ${profiles.length}`} open={showRoles} onToggle={() => setShowRoles((v) => !v)}>
          {pushStats && (
            <div className="wcf-push-stat">
              🔔 {pushStats.subscribed} of {pushStats.total} players have notifications on
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
                <span>{p.display_name}{isSelf ? " (you)" : ""} <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span></span>
                <div className="wcf-roles-actions">
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
                    onSave={(fitness, attack, defence, position) => {
                      onSaveAdminRating(p.id, fitness, attack, defence, position);
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
        <AccordionSection icon="📋" title="Activity log" open={showAuditLog} onToggle={onToggleAuditLog}>
          {auditLog.length === 0 && <p className="wcf-empty">No activity logged yet.</p>}
          <div className="wcf-audit-list">
            {auditLog.map((entry) => (
              <div key={entry.id} className="wcf-audit-row">
                <div className="wcf-audit-line">
                  <strong>{entry.actor?.display_name ?? "Someone"}</strong> {entry.action.toLowerCase()}
                  {entry.details ? ` — ${entry.details}` : ""}
                </div>
                <div className="wcf-audit-time">
                  {new Date(entry.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            ))}
          </div>
        </AccordionSection>
      )}

      {isAdmin && (
        <AccordionSection icon="⚙️" title="Club settings" open={openClubSettings} onToggle={() => setOpenClubSettings((v) => !v)}>
          <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />
        </AccordionSection>
      )}

      {isAdmin && (
        <AccordionSection icon="🏆" title="Awards" open={openAwards} onToggle={() => setOpenAwards((v) => !v)}>
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
        <label className="wcf-team-field">
          Team A name
          <input value={form.team_white_name} onChange={(e) => setForm({ ...form, team_white_name: e.target.value })} />
        </label>
        <label className="wcf-team-field color">
          Colour
          <input type="color" value={form.team_white_color} onChange={(e) => setForm({ ...form, team_white_color: e.target.value })} />
        </label>
        <label className="wcf-team-field">
          Team B name
          <input value={form.team_red_name} onChange={(e) => setForm({ ...form, team_red_name: e.target.value })} />
        </label>
        <label className="wcf-team-field color">
          Colour
          <input type="color" value={form.team_red_color} onChange={(e) => setForm({ ...form, team_red_color: e.target.value })} />
        </label>
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
          <span>
            {a.title} — <strong>{a.value}</strong>{a.note ? ` · ${a.note}` : ""}
            {a.image_url && <span className="wcf-award-media-tag">📷</span>}
            {a.video_url && <span className="wcf-award-media-tag">🎥</span>}
          </span>
          <button
            className="wcf-admin-remove"
            onClick={async () => {
              if (await askConfirm(`Remove "${a.title}"?`, "This also deletes any photo/video attached to it.", "Remove")) onDelete(a.id);
            }}
            aria-label="Remove award"
          >
            ×
          </button>
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
          <label className="wcf-team-field wide">
            Photo (optional)
            <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="wcf-team-field wide">
            Video (optional, under {MAX_AWARD_VIDEO_MB}MB)
            <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <button className="wcf-save" type="submit" disabled={adding || !title.trim() || !value.trim()}>
          {adding ? "Adding…" : "Add award"}
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
          <div className="wcf-predict-gate-icon">🔒</div>
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
          <span className="wcf-predict-locked-icon">🔮</span>
          <div className="wcf-predict-locked-body">
            <div className="wcf-predict-locked-label">Your prediction</div>
            <div className="wcf-predict-locked-value">
              {whiteLabel} {myPrediction.predicted_white}–{myPrediction.predicted_red} {redLabel}
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
        <span className="wcf-predict-title">🔮 Predict the score</span>
        <span className="wcf-predict-sub">Closes at kickoff</span>
      </div>
      <p className="wcf-predict-prize">
        Now you know the sides — guess the final score. Top 3 on the season leaderboard win prizes from the pot; each calendar month&apos;s winner gets a free game.
      </p>
      <div className="wcf-predict-score">
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{whiteLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setWhite((n) => Math.max(0, n - 1))} aria-label={`Fewer ${whiteLabel} goals`}>−</button>
            <span>{white}</span>
            <button onClick={() => setWhite((n) => n + 1)} aria-label={`More ${whiteLabel} goals`}>+</button>
          </div>
        </div>
        <div className="wcf-predict-vs">–</div>
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{redLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setRed((n) => Math.max(0, n - 1))} aria-label={`Fewer ${redLabel} goals`}>−</button>
            <span>{red}</span>
            <button onClick={() => setRed((n) => n + 1)} aria-label={`More ${redLabel} goals`}>+</button>
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
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) => Promise<void>;
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
  const nextGame = upcoming[0];
  const nextConfirmed = nextGame ? nextGame.bookings.filter((b) => !b.waiting) : [];
  const nextUnassigned = nextConfirmed.filter((b) => !b.team).length;
  const teamsSet = !nextGame || nextConfirmed.length === 0 || nextUnassigned === 0;

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

  async function sendMessage() {
    if (!composeTo || !composeText.trim()) return;
    setSendingMessage(true);
    await onSendMessage(composeTo, composeText.trim());
    setSendingMessage(false);
    setComposeTo("");
    setComposeText("");
  }

  return (
    <>
      <h3 className="wcf-admin-section-head">📋 At a glance</h3>
      <div className="wcf-dash-grid">
        <div className={"wcf-dash-card " + (unscored.length === 0 ? "clear" : "amber")}>
          <div className="wcf-dash-icon">⚠️</div>
          <div className="wcf-dash-num">{unscored.length === 0 ? "✅" : unscored.length}</div>
          <div className="wcf-dash-label">{unscored.length === 0 ? "Scores up to date" : "Need a score"}</div>
          {unscored.length > 0 && <div className="wcf-dash-sub">{namesList(unscored.map((g) => fmtDate(g.date)))}</div>}
        </div>
        <div className={"wcf-dash-card " + (overdue.length === 0 ? "clear" : "red")}>
          <div className="wcf-dash-icon">💷</div>
          <div className="wcf-dash-num">{overdue.length === 0 ? "✅" : overdue.length}</div>
          <div className="wcf-dash-label">{overdue.length === 0 ? "Nothing overdue" : "Overdue"}</div>
          {overdue.length > 0 && <div className="wcf-dash-sub">{namesList(overdue.map((o) => o.booking.player.display_name))}</div>}
        </div>
        <button
          className={"wcf-dash-card " + (pendingApproval.length === 0 ? "clear" : "blue") + (pendingApproval.length > 0 ? " expandable" : "")}
          onClick={() => pendingApproval.length > 0 && setShowPendingDetail((v) => !v)}
        >
          <div className="wcf-dash-icon">⏳</div>
          <div className="wcf-dash-num">{pendingApproval.length === 0 ? "✅" : pendingApproval.length}</div>
          <div className="wcf-dash-label">{pendingApproval.length === 0 ? "All approved" : "Awaiting approval"}</div>
          {pendingApproval.length > 0 && (
            <>
              <div className="wcf-dash-sub">{namesList(pendingApproval.map((p) => p.booking.player.display_name))}</div>
              <div className="wcf-dash-expand-bar">{showPendingDetail ? "▲ Hide detail" : "▼ Tap for detail"}</div>
            </>
          )}
        </button>
        <div className={"wcf-dash-card " + (drafts.length === 0 ? "clear" : "dim")}>
          <div className="wcf-dash-icon">📝</div>
          <div className="wcf-dash-num">{drafts.length === 0 ? "✅" : drafts.length}</div>
          <div className="wcf-dash-label">{drafts.length === 0 ? "No drafts" : drafts.length === 1 ? "Draft fixture" : "Draft fixtures"}</div>
          {drafts.length > 0 && <div className="wcf-dash-sub">{namesList(drafts.map((g) => g.venue))}</div>}
        </div>
        <button className={"wcf-dash-card wide " + (teamsSet ? "clear" : "amber")} onClick={onGoToLineup}>
          <div className="wcf-dash-icon">⚖️</div>
          <div className="wcf-dash-body">
            <div className="wcf-dash-num small">{teamsSet ? "Teams are set" : "Teams not set"}</div>
            {nextGame && <div className="wcf-dash-sub">{nextGame.venue}, {fmtDate(nextGame.date)}{!teamsSet ? ` — ${nextUnassigned} unassigned` : ""}</div>}
          </div>
        </button>
      </div>

      {showPendingDetail && pendingByGame.length > 0 && (
        <div className="wcf-pending-detail">
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
                <div className="wcf-pending-game-head">{game.venue} · {fmtDate(game.date)}</div>
                {claimedPaid.length > 0 && (
                  <>
                    <div className="wcf-pending-sublabel">⏳ Says they&apos;ve paid</div>
                    {claimedPaid.map(({ booking: b }) => (
                      <div key={b.id} className="wcf-pending-row">
                        <span className="wcf-avatar">{b.player.display_name[0]?.toUpperCase()}</span>
                        <span className="wcf-pending-name">{b.player.display_name}</span>
                        <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Confirm</button>
                      </div>
                    ))}
                  </>
                )}
                {notPaid.length > 0 && (
                  <>
                    <div className="wcf-pending-sublabel unpaid">❌ Not yet paid</div>
                    {notPaid.map(({ booking: b }) => (
                      <div key={b.id} className="wcf-pending-row">
                        <span className="wcf-avatar">{b.player.display_name[0]?.toUpperCase()}</span>
                        <span className="wcf-pending-name">{b.player.display_name}</span>
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
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h3 className="wcf-admin-section-head">✉️ Messages</h3>
      <div className="wcf-msg-compose">
        <select value={composeTo} onChange={(e) => setComposeTo(e.target.value)}>
          <option value="">Choose a player…</option>
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
          {sendingMessage ? "Sending…" : "Send & notify"}
        </button>
      </div>
      {messages.length > 0 && (
        <div className="wcf-msg-log">
          <button className="wcf-msg-log-toggle" onClick={() => setShowMessageLog((v) => !v)}>
            <h4>
              Sent messages · {messages.length}
              {unreadSentCount > 0 ? ` (${unreadSentCount} unread)` : ""}
            </h4>
            <span>{showMessageLog ? "▲" : "▼"}</span>
          </button>
          {showMessageLog && (
            <>
              {visibleMessages.map((m) => (
                <div key={m.id} className="wcf-msg-log-row">
                  <span className="wcf-avatar">{(m.recipient?.display_name ?? "?")[0]?.toUpperCase()}</span>
                  <div className="wcf-msg-log-body">
                    <div className="wcf-msg-log-name">{m.recipient?.display_name ?? "Unknown"}</div>
                    <div className="wcf-msg-log-text">{m.message}</div>
                  </div>
                  <span className={"wcf-msg-log-status " + (m.read_at ? "read" : "unread")}>
                    {m.read_at ? `Read · ${fmtDateTime(m.read_at)}` : "Unread"}
                  </span>
                </div>
              ))}
              {!showOlderMessages && olderMessageCount > 0 && (
                <button className="wcf-msg-log-more" onClick={() => setShowOlderMessages(true)}>
                  Show {olderMessageCount} older
                </button>
              )}
            </>
          )}
        </div>
      )}

      <h3 className="wcf-admin-section-head">💷 Tabs</h3>
      {playerTabs.length === 0 && <p className="wcf-empty small">Nothing outstanding — everyone's settled up.</p>}
      {playerTabs.map((row) => {
        const owedTotal = row.owed.reduce((sum, o) => sum + o.game.price, 0);
        const expanded = expandedTabId === row.playerId;
        return (
          <div key={row.playerId} className="wcf-tab">
            <button className="wcf-tab-summary" onClick={() => setExpandedTabId(expanded ? null : row.playerId)}>
              <span className="wcf-avatar">{row.playerName[0]?.toUpperCase()}</span>
              <span className="wcf-tab-summary-body">
                <span className="wcf-tab-summary-name">{row.playerName}</span>
                <span className="wcf-tab-summary-sub">
                  {owedTotal > 0 && `Owes across ${row.owed.length} game${row.owed.length === 1 ? "" : "s"}`}
                  {owedTotal > 0 && row.pending.length > 0 && " · "}
                  {row.pending.length > 0 && `${row.pending.length} pending confirmation`}
                </span>
              </span>
              {owedTotal > 0 && <span className="wcf-tab-amount">−£{owedTotal}</span>}
              <span className="wcf-tab-chevron">{expanded ? "▲" : "▼"}</span>
            </button>
            {expanded && (
              <div className="wcf-tab-detail">
                {row.owed.map(({ booking: b, game: g }) => (
                  <div key={b.id} className="wcf-tab-line">
                    <span className="wcf-tab-line-desc">{g.venue} · {fmtDate(g.date)} · £{g.price}</span>
                    <button
                      className="wcf-admin-remove"
                      onClick={async () => {
                        if (await askConfirm(`Remove ${row.playerName} from this game?`, `${g.venue} · ${fmtDate(g.date)}. Their spot opens up to the waiting list.`, "Remove")) {
                          onRemoveBooking(b.id);
                        }
                      }}
                      aria-label="Remove from game"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {row.pending.map(({ booking: b, game: g }) => (
                  <div key={b.id} className="wcf-tab-line pending">
                    <span className="wcf-tab-line-desc">⏳ {g.venue} · {fmtDate(g.date)} · £{g.price}</span>
                    <button className="wcf-admin-approve" onClick={() => onSetStatus(b.id, "confirmed")}>Confirm</button>
                  </div>
                ))}
                {owedTotal > 0 && (
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
                    ✉️ Send nudge
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <h3 className="wcf-admin-section-head">📅 Upcoming</h3>
      {upcoming.length === 0 && <p className="wcf-empty small">No upcoming fixtures.</p>}
      {upcoming.map((g) => (
        <AdminGameRow key={g.id} game={g} past={false} {...shared} />
      ))}
      <h3 className="wcf-admin-section-head">🏁 Previous</h3>
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
  onSaveResult: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>) => Promise<void>;
  onAddBooking: (gameId: string, playerId: string) => void;
  onSetPotExempt: (bookingId: string, reason: PotExemptReason | null) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const expanded = expandedId === game.id;
  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const goalsByPlayer: Record<string, number> = {};
  goalRows.filter((r) => r.game_id === game.id).forEach((r) => (goalsByPlayer[r.player_id] = r.goals));
  const [whiteScore, setWhiteScore] = useState(game.team_white_score?.toString() ?? "");
  const [redScore, setRedScore] = useState(game.team_red_score?.toString() ?? "");
  const [goalDraft, setGoalDraft] = useState<Record<string, number>>(goalsByPlayer);
  const [addPlayerId, setAddPlayerId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setWhiteScore(game.team_white_score?.toString() ?? "");
    setRedScore(game.team_red_score?.toString() ?? "");
    setGoalDraft(goalsByPlayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.team_white_score, game.team_red_score, goalRows, expanded]);

  const bookedIds = new Set(game.bookings.map((b) => b.player_id));
  const eligiblePlayers = profiles.filter((p) => !bookedIds.has(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));

  const dirty =
    whiteScore !== (game.team_white_score?.toString() ?? "") ||
    redScore !== (game.team_red_score?.toString() ?? "") ||
    confirmed.some((b) => (goalDraft[b.player_id] ?? 0) !== (goalsByPlayer[b.player_id] ?? 0));

  async function submitResult() {
    setSaving(true);
    await onSaveResult(
      game.id,
      whiteScore === "" ? null : Number(whiteScore),
      redScore === "" ? null : Number(redScore),
      goalDraft
    );
    setSaving(false);
  }

  return (
    <div className="wcf-admin-game">
      <button className="wcf-admin-game-head" onClick={() => onToggleExpand(game.id)}>
        <span className="wcf-admin-game-info">
          <span className="wcf-admin-game-venue">{game.venue}</span>
          <span className="wcf-admin-game-date">{fmtDate(game.date)} · {game.kickoff}</span>
        </span>
        <span className="wcf-admin-game-count">
          {confirmed.length >= game.max_players && <span className="wcf-admin-full-dot" />}
          {confirmed.length}/{game.max_players}
        </span>
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
            </div>
          )}
          {confirmed.length === 0 && <p className="wcf-empty small">No one booked in.</p>}
          {confirmed.map((b) => (
            <div key={b.id} className="wcf-admin-player-row">
              <span className="wcf-avatar">{b.player.display_name[0]?.toUpperCase()}</span>
              <span className="wcf-admin-player-name">
                {b.player.display_name}
                {b.status === "confirmed" && b.confirmer && <span className="wcf-confirmed-by">by {b.confirmer.display_name}</span>}
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
                <option value="">💷 Pays</option>
                <option value="prize">🎁 Free — prize</option>
                <option value="carried_over">🔄 Free — carried over</option>
                <option value="other">🎁 Free — other</option>
              </select>
              {past && (
                <div className="wcf-admin-goals">
                  <button
                    onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: Math.max(0, (g[b.player_id] ?? 0) - 1) }))}
                    disabled={(goalDraft[b.player_id] ?? 0) <= 0}
                  >
                    −
                  </button>
                  <span>{goalDraft[b.player_id] ?? 0}</span>
                  <button onClick={() => setGoalDraft((g) => ({ ...g, [b.player_id]: (g[b.player_id] ?? 0) + 1 }))}>+</button>
                </div>
              )}
              <button
                className="wcf-admin-remove"
                onClick={async () => {
                  if (await askConfirm(`Remove ${b.player.display_name} from this game?`, "Their spot opens up to the waiting list.", "Remove")) {
                    onRemoveBooking(b.id);
                  }
                }}
                aria-label="Remove from game"
              >
                ×
              </button>
            </div>
          ))}

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
                  <span className="wcf-admin-player-name">{i + 1}. {b.player.display_name}</span>
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
              if (
                await askConfirm(
                  `Delete this ${when} fixture?`,
                  `${game.venue} on ${fmtDate(game.date)} — this removes it completely, along with everyone's bookings.`,
                  "Delete"
                )
              ) {
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
  weather: { code: number; temp: number } | null;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  featured?: boolean;
  countdownText?: string | null;
}) {
  const [form, setForm] = useState<GameRow>(game);
  const [showWaiting, setShowWaiting] = useState(false);
  const [showRoster, setShowRoster] = useState(false);

  useEffect(() => setForm(game), [game, editing]);

  const confirmed = game.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waitingList = game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const myBooking = game.bookings.find((b) => b.player_id === myId);
  const myWaitingPosition = waitingList.findIndex((b) => b.player_id === myId) + 1;
  const full = confirmed.length >= game.max_players;
  const spotsLeft = Math.max(0, game.max_players - confirmed.length);

  return (
    <article className={"wcf-card " + (featured ? "featured " : "") + (myBooking ? "in" : "")}>
      {featured ? (
        <>
          <div className="wcf-hero-top">
            <span className="wcf-hero-date">{fmtDate(game.date)}</span>
            <span className={"wcf-status-pill " + (full ? "full" : "open")}>{full ? "Full" : "Open"}</span>
          </div>
          <div className="wcf-hero-time">{game.kickoff}</div>
          <div className="wcf-hero-venue">
            📍 {game.venue}
            {!game.published && <span className="wcf-draft-badge">Draft</span>}
          </div>
          <div className="wcf-hero-meta">
            <span>{game.pitch}</span><span className="wcf-hero-dot" /><span>£{game.price}</span>
            {weather && <><span className="wcf-hero-dot" /><span>{weatherIcon(weather.code)} {weather.temp}°C</span></>}
          </div>
          {countdownText && <div className="wcf-hero-countdown">⏱ Kicks off in {countdownText}</div>}
          <div className="wcf-hero-divider" />
          <div className="wcf-hero-roster">
            <div className="wcf-hero-roster-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div className="wcf-hero-roster-text">
              <span className="wcf-hero-roster-n">{confirmed.length} / {game.max_players}</span>
              <span className={"wcf-hero-roster-l " + (full ? "full" : "open")}>{full ? "Squad full" : `${spotsLeft} spots left`}</span>
            </div>
            <div className="wcf-avatars">
              {confirmed.slice(0, 5).map((b) => {
                const a = avatarFor(b.player.display_name);
                return (
                  <span key={b.id} className="wcf-avatar-chip lg" style={{ background: a.gradient }}>
                    {a.initial}
                  </span>
                );
              })}
              {confirmed.length > 5 && <span className="wcf-avatar-chip lg more">+{confirmed.length - 5}</span>}
            </div>
          </div>
        </>
      ) : (
        <div className="wcf-card-top">
          <div className="wcf-kick">
            <span className="wcf-kick-time">{game.kickoff}</span>
            <span className="wcf-kick-date">{fmtDate(game.date)}</span>
          </div>
          <div className="wcf-card-info">
            <div className="wcf-venue">{game.venue}{!game.published && <span className="wcf-draft-badge">Draft</span>}</div>
            <div className="wcf-pitch-row">
              <span className="wcf-pitch">{game.pitch} · £{game.price}</span>
              {weather && <span className="wcf-wx-chip">{weatherIcon(weather.code)} {weather.temp}°C</span>}
            </div>
          </div>
          <div className="wcf-count-col">
            <span className={"wcf-status-pill " + (full ? "full" : "open")}>{full ? "Full" : "Open"}</span>
            <div className="wcf-avatars-row">
              <div className="wcf-avatars">
                {confirmed.slice(0, 4).map((b) => {
                  const a = avatarFor(b.player.display_name);
                  return (
                    <span key={b.id} className="wcf-avatar-chip" style={{ background: a.gradient }}>
                      {a.initial}
                    </span>
                  );
                })}
                {confirmed.length > 4 && <span className="wcf-avatar-chip more">+{confirmed.length - 4}</span>}
              </div>
              <span className="wcf-count-n">{confirmed.length}/{game.max_players}</span>
            </div>
            {!full && <span className="wcf-spots-note">{spotsLeft} left</span>}
          </div>
        </div>
      )}

      <button className="wcf-roster-toggle" onClick={() => setShowRoster((v) => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        View players ({confirmed.length}/{game.max_players})
        <span className="wcf-roster-chev">{showRoster ? "▲" : "▼"}</span>
      </button>
      {showRoster && (
        <div className="wcf-sheet">
          {Array.from({ length: game.max_players }).map((_, i) => {
            const b = confirmed[i];
            return (
              <div key={i} className={"wcf-slot " + (b ? "taken" : "")}>
                <span className="wcf-slot-num">{i + 1}</span>
                {b ? (
                  <button className="wcf-slot-name wcf-name-link" onClick={() => onOpenPlayerCard(b.player_id)}>{b.player.display_name}</button>
                ) : (
                  <span className="wcf-slot-name">—</span>
                )}
                {b && <span className={"wcf-pay-dot " + b.status} title={b.status} />}
              </div>
            );
          })}
        </div>
      )}

      {waitingList.length > 0 && (
        <div className="wcf-waiting">
          <button className="wcf-waiting-banner" onClick={() => setShowWaiting((v) => !v)}>
            <span className="wcf-waiting-banner-left">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>
                <span className="wcf-waiting-label">Waiting list</span>
                <span className="wcf-waiting-sub">
                  {waitingList.length} player{waitingList.length === 1 ? "" : "s"} waiting
                  {myWaitingPosition > 0 ? ` · you're #${myWaitingPosition}` : ""}
                </span>
              </span>
            </span>
            <span className="wcf-waiting-chev">{showWaiting ? "▲" : "›"}</span>
          </button>
          {showWaiting && (
            <div className="wcf-waiting-list">
              {waitingList.map((b, i) => (
                <div key={b.id} className="wcf-waiting-row">
                  <span>{i + 1}. {b.player.display_name}{b.player_id === myId ? " (you)" : ""}</span>
                  {isAdmin && editing && (
                    <button
                      className="wcf-waiting-remove"
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
              ))}
            </div>
          )}
        </div>
      )}

      {myBooking && !myBooking.waiting && (
        <div className={"wcf-payment " + myBooking.status}>
          <div className="wcf-payment-head">
            <span>
              {myBooking.status === "unpaid" && "You're in! Your spot has been reserved."}
              {myBooking.status === "pending" && "Thanks! Your payment has been submitted for verification."}
              {myBooking.status === "confirmed" && "Payment confirmed."}
            </span>
            <StatusBadge status={myBooking.status} />
          </div>
          <p className="wcf-payment-fee">Match fee: £{game.price}</p>
          {myBooking.status === "unpaid" && (
            <>
              <p className="wcf-payment-note">
                {PAYMENT_LINK
                  ? "Tap Pay Now to secure your spot, then press I've paid."
                  : `Pay your organiser £${game.price} to secure your spot, then press I've paid.`}
              </p>
              <div className="wcf-payment-actions">
                {PAYMENT_LINK && (
                  <a className="wcf-pay-now" href={PAYMENT_LINK} target="_blank" rel="noreferrer">
                    Pay Now
                  </a>
                )}
                <button onClick={() => onMarkPaid(myBooking.id)}>I&apos;ve paid</button>
              </div>
            </>
          )}
          {myBooking.status === "pending" && <p className="wcf-payment-note">An organiser will confirm it shortly.</p>}
        </div>
      )}

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
        {isAdmin && (
          <div className="wcf-admin-actions">
            <button className="wcf-ghost" onClick={onEdit}>{editing ? "Close" : "Edit"}</button>
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
        )}
      </div>

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

.wcf-splash{flex:1;display:flex;align-items:center;justify-content:center}
.wcf-splash .wcf-logo.big{width:96px;height:96px;border-radius:24px}

.wcf-signin{flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:24px;text-align:center}
.wcf-logo.big{width:96px;height:96px;border-radius:24px;margin-bottom:6px}
.wcf-signin .wcf-wordmark{font-size:30px;margin-top:6px}
.wcf-signin-form{display:flex;flex-direction:column;gap:10px;width:100%;max-width:280px;margin-top:24px}
.wcf-signin-form input{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:12px;border-radius:10px;font-size:14px;font-family:var(--sans)}
.wcf-signin-form button{background:var(--red);color:#fff;border:none;padding:12px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-signin-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signin-error{color:var(--red-hi);font-size:12px;margin:0}
.wcf-signin-sent{color:var(--dim);font-size:14px;max-width:280px;margin:0 0 4px;line-height:1.5}
.wcf-signin-form input[inputmode="numeric"]{letter-spacing:4px;text-align:center;font-family:var(--mono);font-size:18px}
.wcf-signin-back{background:none!important;border:none!important;color:var(--dim)!important;font-weight:600!important;font-size:12px!important;padding:4px!important;cursor:pointer;text-decoration:underline}
.wcf-signin-back:disabled{opacity:.4;cursor:not-allowed;text-decoration:none}
.wcf-privacy-note{color:var(--dim);font-size:11px;max-width:260px;margin-top:32px;line-height:1.5;opacity:.8}

.wcf-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;background:rgba(10,26,52,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.wcf-brand{display:flex;align-items:center;gap:11px;background:none;border:none;padding:0;margin:0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.wcf-logo{display:block;width:42px;height:42px;flex:0 0 auto;border-radius:11px;overflow:hidden;
  border:1px solid rgba(228,42,54,.4);box-shadow:0 2px 10px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.05)}
.wcf-logo img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 43%}
.wcf-wordmark{font-weight:900;font-size:22px;letter-spacing:1px;line-height:.9;
  color:var(--white);text-shadow:0 1px 0 rgba(0,0,0,.4)}
.wcf-wordmark-sub{font-weight:800;font-size:10px;letter-spacing:2.5px;color:var(--red-hi);margin-top:3px}
.wcf-role{display:flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);
  color:var(--dim);padding:8px 13px;border-radius:999px;font-size:12px;font-weight:800;cursor:pointer;
  font-family:var(--mono);letter-spacing:.5px;transition:.15s;max-width:140px}
.wcf-role span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-role .dot{width:8px;height:8px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.wcf-role.admin .dot{background:var(--green)}
.wcf-role.on{color:#fff;border-color:var(--red)}

.wcf-main{flex:1;padding:14px 14px 92px;overflow-y:auto}
.wcf-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin:4px 2px 14px}
.wcf-heading h2{margin:0;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim)}
.wcf-heading-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.wcf-addbtn{background:var(--red);color:#fff;border:none;padding:7px 13px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.wcf-addbtn.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}
.wcf-empty{color:var(--dim);text-align:center;padding:40px 0;font-size:14px}
.wcf-empty.small{padding:8px 0;font-size:12px}

.wcf-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;margin-bottom:18px;position:relative;overflow:hidden}
.wcf-card.in{border-color:rgba(34,197,94,.5)}
.wcf-card.in:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--green)}
.wcf-card.featured{
  background-image:linear-gradient(180deg,rgba(8,10,14,.15) 0%,rgba(8,10,14,.5) 55%,rgba(6,8,11,.88) 100%),url('/pitch-night.jpg');
  background-size:cover;background-position:center 30%;border-radius:24px;padding:24px;margin-bottom:22px;
}
.wcf-card.featured.in:before{display:none}
.wcf-hero-top{display:flex;justify-content:space-between;align-items:flex-start}
.wcf-hero-date{font-size:11.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#B7BDD0}
.wcf-hero-time{font-family:var(--display);font-size:52px;font-weight:900;letter-spacing:-.03em;line-height:1;margin-top:6px}
.wcf-hero-venue{display:flex;align-items:center;gap:7px;font-size:16px;font-weight:800;margin-top:16px}
.wcf-hero-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:#A6ACC0;margin-top:6px}
.wcf-hero-dot{width:3px;height:3px;border-radius:50%;background:#4A5170}
.wcf-hero-countdown{font-size:11.5px;font-weight:700;color:var(--white);opacity:.85;margin-top:10px}
.wcf-hero-divider{height:1px;background:rgba(255,255,255,.1);margin:16px 0}
.wcf-hero-roster{display:flex;align-items:center;gap:12px}
.wcf-hero-roster-icon{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid var(--line);display:grid;place-items:center;flex:0 0 auto}
.wcf-hero-roster-text{display:flex;flex-direction:column;flex:0 0 auto}
.wcf-hero-roster-n{font-family:var(--display);font-weight:900;font-size:16px}
.wcf-hero-roster-l{font-size:11px;font-weight:700;margin-top:2px}
.wcf-hero-roster-l.full{color:var(--red)}
.wcf-hero-roster-l.open{color:var(--green)}
.wcf-avatar-chip.lg{width:36px;height:36px;font-size:12px;margin-left:-10px}
.wcf-card.featured .wcf-waiting{margin:8px -24px 0}
.wcf-card.featured .wcf-waiting-banner,.wcf-card.featured .wcf-waiting-list{padding-left:24px;padding-right:24px}
.wcf-card.featured .wcf-book{padding:16px 19px;font-size:14px;border-radius:14px}
.wcf-card-top{display:flex;align-items:flex-start;gap:11px}
.wcf-kick{display:flex;flex-direction:column;min-width:50px;flex:0 0 auto}
.wcf-kick-time{font-family:var(--display);font-size:20px;font-weight:900;letter-spacing:-.02em;line-height:1;color:var(--white)}
.wcf-kick-date{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px;margin-top:6px;font-weight:800}
.wcf-card-info{flex:1;min-width:0}
.wcf-venue{font-weight:700;font-size:13.5px}
.wcf-draft-badge{display:inline-block;margin-left:8px;background:rgba(234,179,8,.18);color:var(--amber);border:1px solid rgba(234,179,8,.4);font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:20px;vertical-align:middle}
.wcf-pitch{font-size:11px;color:var(--dim);font-family:var(--sans)}
.wcf-pitch-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:5px}
.wcf-wx-chip{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:20px;background:var(--panel2);color:var(--dim)}
.wcf-count-col{text-align:right;flex:0 0 auto}
.wcf-status-pill{display:inline-block;font-family:var(--display);font-size:10px;font-weight:800;letter-spacing:.06em;padding:5px 12px;border-radius:20px;border:1.5px solid;white-space:nowrap}
.wcf-status-pill.full{color:#fff;border-color:var(--red);background:var(--red)}
.wcf-status-pill.open{color:var(--green);border-color:var(--green);background:transparent}
.wcf-avatars-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}
.wcf-avatars{display:flex}
.wcf-avatar-chip{width:24px;height:24px;border-radius:50%;border:2px solid var(--panel);margin-left:-8px;display:grid;place-items:center;font-size:9px;font-weight:800;color:#fff;background:var(--panel2)}
.wcf-avatar-chip:first-child{margin-left:0}
.wcf-avatar-chip.more{color:var(--dim);background:var(--panel2)}
.wcf-count-n{font-family:var(--display);font-weight:900;font-size:13px;color:var(--white)}
.wcf-spots-note{display:block;font-size:10.5px;font-weight:800;margin-top:9px;color:var(--green)}

.wcf-roster-toggle{display:flex;align-items:center;gap:7px;width:100%;background:none;border:none;color:var(--dim);font-family:var(--sans);padding:6px 0;font-weight:700;font-size:11.5px;cursor:pointer;margin-top:16px}
.wcf-roster-toggle svg{flex:0 0 auto}
.wcf-roster-chev{margin-left:auto;font-size:10px}
.wcf-sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:5px 10px;margin:10px 0 14px;padding:12px;
  background:var(--bg);border-radius:10px;border:1px solid var(--line)}
.wcf-slot{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px}
.wcf-slot-num{font-family:var(--mono);color:var(--dim);width:20px;text-align:center;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:1px 0}
.wcf-slot-name{color:var(--dim);flex:1}
.wcf-slot.taken .wcf-slot-name{color:var(--white)}
.wcf-slot.taken .wcf-slot-num{color:var(--green);border-color:rgba(34,197,94,.5)}
.wcf-pay-dot{width:7px;height:7px;border-radius:50%;background:var(--dim);flex:0 0 auto}
.wcf-pay-dot.pending{background:var(--amber)}
.wcf-pay-dot.confirmed{background:var(--green)}

.wcf-waiting{margin:8px -20px 0}
.wcf-waiting-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;background:rgba(234,179,8,.08);border:none;border-top:1px solid rgba(234,179,8,.22);border-bottom:1px solid rgba(234,179,8,.22);padding:14px 20px;cursor:pointer;text-align:left}
.wcf-waiting-banner-left{display:flex;align-items:center;gap:10px;color:var(--amber)}
.wcf-waiting-label{display:block;font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--amber)}
.wcf-waiting-sub{display:block;font-size:11.5px;color:var(--dim);margin-top:1px;font-weight:400}
.wcf-waiting-chev{color:var(--amber);font-size:14px;flex:0 0 auto}
.wcf-waiting-list{padding:10px 20px 0}
.wcf-waiting-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--dim);padding:3px 0}
.wcf-waiting-row span:first-child{flex:1}
.wcf-waiting-remove{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;flex:0 0 auto}
.wcf-waiting-remove:hover{color:var(--red-hi)}

.wcf-payment{margin:0 0 14px;padding:12px;border-radius:10px;font-size:12px;line-height:1.5;background:var(--panel2);border:1px solid var(--line)}
.wcf-payment-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:700;color:var(--white)}
.wcf-payment-fee{margin:6px 0 10px;color:var(--dim);font-family:var(--mono)}
.wcf-payment.confirmed{border-color:rgba(51,169,87,.5)}
.wcf-payment.pending .wcf-payment-note{margin:0;color:var(--amber)}
.wcf-payment-actions{display:flex;gap:8px;flex-wrap:wrap}
.wcf-payment-actions button,.wcf-pay-now{background:var(--red);color:#fff;border:none;padding:9px 14px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.wcf-pay-now{background:var(--panel2);border:1px solid var(--line)}

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
.wcf-admin-actions{display:flex;gap:6px}
.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px 12px;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer}
.wcf-ghost.danger:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}

.wcf-edit{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wcf-edit label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-edit input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:13px;font-family:var(--sans)}
.wcf-save{grid-column:1/-1;background:var(--green);color:#04140a;border:none;padding:11px;border-radius:9px;font-weight:800;cursor:pointer;font-size:13px}
.wcf-admin-section-head{margin:18px 2px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-admin-section-head:first-child{margin-top:4px}
.wcf-month-head{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:16px 2px 9px;display:flex;align-items:center;gap:9px}
.wcf-month-head:first-child{margin-top:2px}
.wcf-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 2px 12px}
.wcf-month-head:after{content:"";flex:1;height:1px;background:var(--line)}
.wcf-dash-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:6px}
.wcf-dash-card{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:12px;padding:12px 13px;text-align:left;width:100%;font:inherit;color:inherit}
button.wcf-dash-card{cursor:pointer}
button.wcf-dash-card:disabled{cursor:default}
.wcf-dash-card.wide{grid-column:1/-1;display:flex;align-items:center;gap:12px;width:100%;font:inherit;color:inherit;cursor:pointer}
.wcf-dash-card.amber{border-left-color:var(--amber)}
.wcf-dash-card.red{border-left-color:var(--red-hi)}
.wcf-dash-card.blue{border-left-color:var(--blue)}
.wcf-dash-card.dim{border-left-color:var(--dim)}
.wcf-dash-card.clear{border-left-color:var(--green)}
.wcf-dash-card.expandable{padding-bottom:0}
.wcf-dash-expand-bar{margin:10px -13px 0;padding:7px 13px;background:var(--blue);color:#fff;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;text-align:center;border-radius:0 0 10px 10px}
.wcf-dash-icon{font-size:16px}
.wcf-dash-num{font-family:var(--mono);font-size:24px;font-weight:800;line-height:1;margin-top:6px}
.wcf-dash-num.small{font-size:15px;margin-top:0}
.wcf-dash-card.clear .wcf-dash-num{color:var(--green);font-size:16px}
.wcf-dash-card.amber .wcf-dash-num{color:var(--amber)}
.wcf-dash-card.red .wcf-dash-num{color:var(--red-hi)}
.wcf-dash-card.blue .wcf-dash-num{color:#7CAEF0}
.wcf-dash-card.dim .wcf-dash-num{color:var(--dim)}
.wcf-dash-label{font-size:10.5px;color:var(--dim);font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-top:3px}
.wcf-dash-sub{font-size:11px;color:var(--dim);margin-top:5px;line-height:1.4}
.wcf-dash-card.wide .wcf-dash-body{flex:1;min-width:0}
.wcf-dash-card.wide .wcf-dash-sub{margin-top:2px}
.wcf-overdue-row{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid rgba(228,42,54,.35);border-radius:12px;padding:11px 13px;margin-bottom:9px;flex-wrap:wrap}
.wcf-overdue-banner{background:linear-gradient(135deg,rgba(228,42,54,.18),rgba(228,42,54,.06));border:1px solid rgba(228,42,54,.4);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5;color:var(--white)}
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
.wcf-overdue-row>div:first-child{flex:1;min-width:120px}
.wcf-tab{background:var(--panel);border:1px solid rgba(228,42,54,.35);border-radius:14px;margin-bottom:9px;overflow:hidden}
.wcf-tab-summary{width:100%;display:flex;align-items:center;gap:11px;background:none;border:none;color:var(--white);padding:12px 14px;cursor:pointer;text-align:left}
.wcf-tab-summary-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.wcf-tab-summary-name{font-weight:700;font-size:13px}
.wcf-tab-summary-sub{font-size:10.5px;color:var(--dim)}
.wcf-tab-amount{font-family:var(--mono);font-weight:800;font-size:14px;color:var(--red-hi);flex:0 0 auto}
.wcf-tab-chevron{font-size:10px;color:var(--dim);flex:0 0 auto}
.wcf-tab-detail{padding:0 14px 12px;border-top:1px solid var(--line)}
.wcf-tab-line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}
.wcf-tab-line:last-of-type{border-bottom:none}
.wcf-tab-line-desc{color:var(--dim)}
.wcf-tab-line.pending .wcf-tab-line-desc{color:#7CAEF0}
.wcf-tab-nudge{width:100%;background:var(--blue);color:#fff;border:none;padding:9px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer;margin-top:10px}
.wcf-pending-detail{background:var(--panel);border:1px solid rgba(46,116,204,.35);border-radius:14px;padding:4px 14px 6px;margin-bottom:14px}
.wcf-pending-game{padding:10px 0;border-bottom:1px solid var(--line)}
.wcf-pending-game:last-child{border-bottom:none}
.wcf-pending-game-head{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin-bottom:8px}
.wcf-pending-row{display:flex;align-items:center;gap:9px;padding:6px 0}
.wcf-pending-name{flex:1;min-width:0;font-weight:700;font-size:12.5px}
.wcf-pending-sublabel{font-size:10px;font-weight:800;color:#7CAEF0;margin:6px 0 2px}
.wcf-pending-sublabel.unpaid{color:var(--red-hi)}
.wcf-admin-approve-override{background:transparent;border:1px solid rgba(228,42,54,.5);color:var(--red-hi);padding:6px 11px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}
.wcf-admin-game{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden}
.wcf-admin-game-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:none;border:none;color:var(--white);padding:13px 14px;cursor:pointer;text-align:left}
.wcf-admin-game-info{display:flex;flex-direction:column;gap:2px}
.wcf-admin-game-venue{font-weight:800;font-size:14px}
.wcf-admin-game-date{font-size:11px;color:var(--dim);font-family:var(--mono)}
.wcf-admin-game-count{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-weight:700;color:var(--blue);flex:0 0 auto}
.wcf-admin-full-dot{width:6px;height:6px;border-radius:50%;background:var(--green)}
.wcf-admin-game-body{padding:0 12px 12px;border-top:1px solid var(--line)}
.wcf-admin-score-card{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center;margin:12px 0}
.wcf-admin-score-eyebrow{font-size:9.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
.wcf-admin-score{display:flex;align-items:center;justify-content:center;gap:10px;font-size:11.5px;font-weight:800}
.wcf-admin-score input{width:50px;text-align:center;background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:8px 4px;border-radius:8px;font-family:var(--mono);font-size:18px;font-weight:800}
.wcf-admin-score-dash{color:var(--dim);font-family:var(--mono)}
.wcf-edit-subhead{margin:14px 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--amber)}
.wcf-admin-player-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.wcf-admin-player-row:last-child{border-bottom:none}
.wcf-admin-player-name{flex:1;min-width:90px;font-weight:700;font-size:13px}
.wcf-confirmed-by{display:block;font-size:10px;font-weight:600;color:var(--dim);margin-top:1px}
.wcf-admin-status{display:flex;align-items:center;gap:8px}
.wcf-admin-approve{background:var(--green);color:#04140a;border:none;padding:7px 12px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}
.wcf-admin-undo{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer}
.wcf-admin-pot-select{background:var(--panel2);border:1px solid var(--line);color:var(--dim);padding:6px 8px;border-radius:8px;font-size:10.5px;font-weight:700;font-family:var(--sans);cursor:pointer;flex:0 0 auto}
.wcf-admin-pot-select.exempt{border-color:rgba(224,167,51,.5);color:var(--amber)}
.wcf-admin-undo:hover{color:var(--red-hi)}
.wcf-admin-goals{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-weight:700}
.wcf-admin-goals button{width:24px;height:24px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--white);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center}
.wcf-admin-goals button:disabled{opacity:.4;cursor:not-allowed}
.wcf-admin-goals span{width:16px;text-align:center}
.wcf-admin-remove{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;line-height:1;padding:0 2px}
.wcf-admin-remove:hover{color:var(--red-hi)}
.wcf-msg-compose{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 13px;margin-bottom:12px;display:flex;flex-direction:column;gap:9px}
.wcf-msg-compose select{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:12.5px;font-family:var(--sans)}
.wcf-msg-compose-box{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--white);font-size:13px;font-family:var(--sans);min-height:64px;resize:vertical}
.wcf-msg-compose-send{background:var(--red);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer}
.wcf-msg-compose-send:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-msg-log{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:4px 13px 2px;margin-bottom:14px}
.wcf-msg-log h4{margin:10px 0 4px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
.wcf-msg-log-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;background:none;border:none;padding:0;cursor:pointer;color:inherit;font:inherit;text-align:left}
.wcf-msg-log-toggle span{font-size:11px;color:var(--dim)}
.wcf-msg-log-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
.wcf-msg-log-row:last-child{border-bottom:none}
.wcf-msg-log-body{flex:1;min-width:0}
.wcf-msg-log-name{font-size:12.5px;font-weight:700}
.wcf-msg-log-text{font-size:11.5px;color:var(--dim);margin-top:1px;line-height:1.4}
.wcf-msg-log-status{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:3px 8px;border-radius:20px;flex:0 0 auto;white-space:nowrap}
.wcf-msg-log-status.read{background:rgba(51,169,87,.16);color:var(--green)}
.wcf-msg-log-status.unread{background:rgba(224,167,51,.16);color:var(--amber)}
.wcf-msg-log-more{width:100%;background:none;border:none;color:var(--dim);font-size:11.5px;font-weight:700;padding:10px 0;cursor:pointer;text-align:center}
.wcf-msg-log-more:hover{color:var(--white)}
.wcf-admin-delete-game{width:100%;background:transparent;border:1px dashed rgba(228,42,54,.4);color:var(--red-hi);padding:10px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer;margin-top:10px}
.wcf-admin-game-body > .wcf-save{width:100%;margin:12px 0}
.wcf-admin-game-body > .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-admin-add-player{display:flex;gap:8px;margin-top:14px}
.wcf-admin-add-player select{flex:1;background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:12px;font-family:var(--sans)}
.wcf-admin-add-player .wcf-ghost:disabled{opacity:.4;cursor:not-allowed}

.wcf-clip-form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.wcf-clip-form input{background:var(--panel);border:1px solid var(--line);color:var(--white);padding:11px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-clip-form button{background:var(--red);color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;cursor:pointer}
.wcf-clip-form button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-clip{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;margin-bottom:12px;align-items:flex-start}
.wcf-clip-thumb{width:74px;height:52px;border-radius:9px;flex:0 0 auto;background:linear-gradient(135deg,var(--panel2),var(--bg));display:grid;place-items:center;color:var(--red-hi);font-size:16px;border:1px solid var(--line);position:relative;overflow:hidden}
.wcf-clip-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wcf-clip-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(4,9,20,.28);color:#fff;font-size:14px;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.wcf-clip-body{flex:1;min-width:0}
.wcf-clip-title{font-weight:800;font-size:14px}
.wcf-clip-sub{font-size:11px;color:var(--dim);margin-top:3px;font-family:var(--mono)}
.wcf-clip-del{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;flex:0 0 auto;line-height:1}
.wcf-clip-del:hover{color:var(--red-hi)}
.wcf-feed-item{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:11px 12px;margin-bottom:10px;align-items:flex-start}
.wcf-feed-icon{width:32px;height:32px;border-radius:9px;flex:0 0 auto;display:grid;place-items:center;font-size:15px}
.wcf-feed-icon.amber{background:rgba(224,167,51,.16)}
.wcf-feed-icon.green{background:rgba(51,169,87,.16)}
.wcf-feed-icon.blue{background:rgba(46,116,204,.16)}
.wcf-feed-body{flex:1;min-width:0}
.wcf-feed-text{font-size:13px;color:var(--white);line-height:1.4}
.wcf-feed-date{font-size:10.5px;color:var(--dim);font-family:var(--mono);margin-top:3px}
.wcf-feed-score-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-weight:800;font-size:13px;padding:3px 9px;border-radius:20px;background:var(--panel2);margin-top:4px}
.wcf-feed-score-dash{color:var(--dim);font-weight:400}
.wcf-feed-archive-btn{margin-top:8px;font-size:11px;font-weight:800;padding:5px 11px;border-radius:20px;background:transparent;border:1px solid var(--line);color:var(--dim);cursor:pointer}
.wcf-feed-archive-btn:hover{border-color:var(--red-hi);color:var(--red-hi)}
.wcf-archive-toggle{font-size:11.5px;padding:7px 12px;margin-bottom:12px}
.wcf-feed-reactions{display:flex;gap:6px;margin-top:8px}
.wcf-feed-reaction{font-size:11px;font-family:var(--mono);color:var(--dim);background:var(--panel2);border:1px solid transparent;border-radius:20px;padding:3px 9px;cursor:pointer}
.wcf-feed-reaction.mine{border-color:var(--green);color:var(--green)}

.wcf-subtabs{display:flex;gap:8px;margin:0 2px 12px}
.wcf-subtabs button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:9px;border-radius:9px;font-weight:800;font-size:12px;cursor:pointer}
.wcf-subtabs button.active{background:var(--red);border-color:var(--red);color:#fff}

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
.wcf-lb-me-label{flex:1;min-width:0;font-family:var(--sans);font-size:10px;font-weight:800;letter-spacing:.16em;color:var(--blue)}
.wcf-lb-me-name{margin-top:4px;font-family:var(--display);font-weight:800;font-size:15px;color:var(--white)}
.wcf-lb-me-stat{text-align:center;flex:0 0 auto}
.wcf-lb-me-stat div{font-family:var(--display);font-weight:700;font-size:20px;color:var(--white)}
.wcf-lb-me-stat span{display:block;margin-top:4px;font-size:11px;color:var(--dim)}

.wcf-lb-list-card{position:relative}
.wcf-lb-sorts{display:flex;gap:6px;padding:0 2px 10px}
.wcf-lb-sort-btn{border-radius:20px;padding:7px 13px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:10.5px;
  letter-spacing:.08em;text-transform:uppercase;background:rgba(148,163,184,.07);border:1px solid var(--line);color:var(--dim)}
.wcf-lb-sort-btn.on{background:rgba(230,57,70,.16);border-color:rgba(230,57,70,.42);color:#f8b3b8}
.wcf-lb-row-avatar{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
  font-family:var(--display);font-weight:700;font-size:9.5px;color:#fff}
.wcf-lb-you-badge{flex:none;font-size:10px;font-weight:700;color:var(--blue);background:rgba(46,116,204,.18);
  border:1px solid rgba(46,116,204,.4);padding:1px 6px;border-radius:20px;margin-left:6px}
.wcf-lb-row-detail{display:flex;gap:16px;padding:2px 8px 12px 46px;font-family:var(--mono);font-size:11px;color:var(--dim)}
.wcf-lb-row-detail b{color:var(--white);font-weight:600}
.wcf-lb-footer{display:flex;align-items:center;justify-content:space-between;padding:13px 8px 2px}
.wcf-lb-footer span{font-size:11px;color:var(--dim)}
.wcf-lb-footer button{background:none;border:none;padding:0;cursor:pointer;font-size:11px;font-weight:600;color:var(--blue)}

.wcf-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--blue)}
.wcf-avatar.big{width:44px;height:44px;font-size:18px}

.wcf-lineup-head{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:14px}
.wcf-lineup-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-lineup-title{margin-top:9px;font-family:var(--display);font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--white)}
.wcf-lineup-sub{margin-top:6px;font-size:12px;color:var(--dim)}
.wcf-lineup-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.wcf-lineup-pill{flex:1;min-height:44px;padding:11px 12px;border-radius:12px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.2);color:var(--white);font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-lineup-pill.primary{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.32);color:#86efac}
.wcf-lineup-row{display:flex;align-items:center;gap:11px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 13px;margin-bottom:9px;transition:box-shadow .2s}
.wcf-lineup-row.me{border-color:transparent}
.wcf-lineup-row.me-edit{background:rgba(46,116,204,.14);border-color:var(--blue)}
.wcf-lineup-avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;flex:0 0 auto;background:var(--panel2);color:var(--dim)}
.wcf-lineup-name{font-weight:700;font-size:14px;flex:1;min-width:0}
.wcf-name-link{background:none;border:none;padding:0;margin:0;font:inherit;color:inherit;text-align:left;cursor:pointer}
.wcf-lineup-picks{display:flex;gap:6px}
.wcf-lineup-pick{background:transparent;border:1px solid var(--line);color:var(--dim);padding:7px 11px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer}

.wcf-lineup-strip-row{display:flex;gap:8px;margin-bottom:12px}
.wcf-lineup-strip{flex:1;display:flex;align-items:center;gap:9px;padding:11px 13px;border-radius:14px;border:1px solid}
.wcf-lineup-strip-dot{width:12px;height:12px;border-radius:4px;flex:0 0 auto}
.wcf-lineup-strip-name{flex:1;font-family:var(--sans);font-weight:800;font-size:11px;letter-spacing:.1em;color:var(--white)}
.wcf-lineup-strip-count{font-family:var(--display);font-weight:700;font-size:14px;color:var(--white)}

.wcf-lineup-views{display:flex;gap:6px;margin-bottom:12px}
.wcf-lineup-view-btn{border-radius:20px;padding:8px 15px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;background:rgba(148,163,184,.07);border:1px solid var(--line);color:var(--dim)}
.wcf-lineup-view-btn.on{background:rgba(230,57,70,.16);border-color:rgba(230,57,70,.42);color:#f8b3b8}

.wcf-lineup-pitch-card{position:relative;border-radius:22px;border:1px solid var(--line);box-shadow:0 22px 44px -28px rgba(0,0,0,.95);overflow:hidden;background:linear-gradient(180deg,rgba(6,12,10,.72),rgba(6,12,10,.48) 50%,rgba(6,12,10,.76)),url('/turf-texture.jpg');background-size:cover;background-position:center}
.wcf-lineup-pitch-lines{position:relative;width:100%;aspect-ratio:0.56;opacity:.3;stroke:#e2e8f0;stroke-width:0.9;fill:none;display:block}
.wcf-lineup-pitch-tokens{position:absolute;inset:0}
.wcf-lineup-token{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:none;padding:2px;cursor:pointer;min-width:44px}
.wcf-lineup-token-chip{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:13px;box-shadow:0 6px 14px -6px rgba(0,0,0,.85)}
.wcf-lineup-token-label{font-size:9.5px;font-weight:700;letter-spacing:.02em;color:var(--white);text-shadow:0 1px 3px rgba(0,0,0,.9);white-space:nowrap}
.wcf-lineup-pitch-note{margin:12px 2px 0;font-size:11.5px;line-height:1.5;color:var(--dim)}

.wcf-lineup-list-wrap{position:relative;display:flex;gap:10px;border-radius:18px;overflow:hidden;padding:10px;background-image:linear-gradient(180deg,rgba(13,13,26,.5),rgba(13,13,26,.85)),url('/floodlight-haze.jpg');background-size:cover;background-position:50% 30%}
.wcf-lineup-list-card{flex:1;min-width:0;border-radius:14px;padding:6px 8px 10px;backdrop-filter:blur(14px);background:linear-gradient(180deg,rgba(30,41,59,.7),rgba(19,22,38,.82));border:1px solid var(--line)}
.wcf-lineup-list-head{padding:9px 4px;font-family:var(--sans);font-weight:800;font-size:10px;letter-spacing:.16em}
.wcf-lineup-list-row{width:100%;display:flex;align-items:center;gap:8px;padding:8px 4px;background:none;border:none;border-top:1px solid var(--line);cursor:pointer;min-height:40px}
.wcf-lineup-list-chip{flex:0 0 auto;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:10.5px}
.wcf-lineup-list-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:12.5px;color:var(--white);text-align:left}

.wcf-lineup-selected{margin-top:14px;padding:14px 16px;border-radius:18px;background:rgba(46,116,204,.13);border:1px solid rgba(46,116,204,.32);display:flex;align-items:center;gap:13px}
.wcf-lineup-selected-chip{flex:0 0 auto;width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:15px}
.wcf-lineup-selected-body{flex:1;min-width:0}
.wcf-lineup-selected-name{font-family:var(--display);font-weight:800;font-size:14px;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.wcf-balance-badge.low{background:rgba(228,42,54,.16);color:var(--red-hi)}
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
.wcf-predict-title{font-size:11.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:#8B6BE8}
.wcf-predict-sub{font-size:10px;color:var(--dim)}
.wcf-predict-prize{font-size:11px;color:var(--dim);margin:0 0 12px;line-height:1.5}
.wcf-predict-score{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:13px}
.wcf-predict-team{text-align:center;flex:1}
.wcf-predict-team-name{font-size:11px;font-weight:700;margin-bottom:7px}
.wcf-predict-stepper{display:flex;align-items:center;justify-content:center;gap:8px}
.wcf-predict-stepper button{width:28px;height:28px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:15px;cursor:pointer;display:grid;place-items:center;line-height:1}
.wcf-predict-stepper span{font-family:var(--mono);font-size:22px;font-weight:800;width:22px;text-align:center}
.wcf-predict-vs{color:var(--dim);font-size:11px;font-weight:700;padding-top:16px}
.wcf-predict-lock{width:100%;background:#8B6BE8;color:#fff;border:none;padding:11px;border-radius:10px;font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-predict-lock:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-predict-locked{display:flex;align-items:center;gap:10px}
.wcf-predict-locked-icon{font-size:16px}
.wcf-predict-locked-body{flex:1;min-width:0}
.wcf-predict-locked-label{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#8B6BE8}
.wcf-predict-locked-value{font-size:12.5px;font-weight:700;margin-top:2px}
.wcf-predict-edit{background:none;border:none;color:var(--dim);font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;flex:0 0 auto}
.wcf-predict-gate{text-align:center;padding:6px 4px 2px}
.wcf-predict-gate-icon{font-size:20px;margin-bottom:6px}
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
.wcf-pl-leader-avatar{flex:0 0 auto;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:20px;color:#fff}
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
.wcf-pl-avatar{flex:0 0 auto;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:12px;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
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
.wcf-predict-reveal-title{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:#8B6BE8}
.wcf-predict-reveal-count{font-size:10.5px;color:var(--dim)}
.wcf-predict-reveal-row{display:flex;align-items:center;gap:10px;padding:7px 0}
.wcf-predict-reveal-row-label{flex:1;font-size:12.5px}
.wcf-predict-reveal-row-label b{font-family:var(--mono)}
.wcf-predict-pts{font-family:var(--mono);font-weight:800;font-size:12px;padding:3px 9px;border-radius:20px;flex:0 0 auto}
.wcf-predict-pts.exact{background:rgba(51,169,87,.18);color:var(--green)}
.wcf-predict-pts.partial{background:rgba(46,116,204,.18);color:#7CAEF0}
.wcf-predict-pts.zero{background:var(--panel2);color:var(--dim)}
.wcf-predict-fact{font-size:11.5px;color:var(--dim);margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}

.wcf-shoutout{background:linear-gradient(135deg,rgba(228,42,54,.16),rgba(51,169,87,.1));border:1px solid rgba(228,42,54,.35);border-radius:14px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.5}
.wcf-award-media{display:block;width:100%;max-height:240px;object-fit:cover;border-radius:10px;margin-top:10px}
.wcf-award-media-tag{margin-left:6px;font-size:12px;vertical-align:middle}
.wcf-potm{background:linear-gradient(135deg,rgba(224,167,51,.2),rgba(224,167,51,.06));border-color:rgba(224,167,51,.4)}

.wcf-pot-total{background:linear-gradient(135deg,rgba(51,169,87,.16),rgba(46,116,204,.1));border:1px solid rgba(51,169,87,.35);border-radius:16px;padding:18px;margin-bottom:16px;text-align:center}
.wcf-pot-total-label{font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--dim)}
.wcf-pot-total-amount{font-family:var(--mono);font-weight:800;font-size:36px;color:var(--green);margin:4px 0 8px}
.wcf-pot-total-amount.negative{color:var(--red-hi)}
.wcf-pot-total-note{font-size:12px;color:var(--dim);line-height:1.5;margin:0;max-width:340px;margin-left:auto;margin-right:auto}
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
.wcf-fin-chart{display:flex;align-items:flex-end;gap:6px;height:80px}
.wcf-fin-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.wcf-fin-bar{width:100%;border-radius:4px 4px 0 0;background:var(--blue);min-height:2px}
.wcf-fin-bar.neg{background:var(--red-hi)}
.wcf-fin-bar-label{font-size:8px;color:var(--dim);margin-top:5px;font-family:var(--mono)}
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
.wcf-h2h{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:14px}
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
.wcf-result-share{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.wcf-result-share-btn{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-weight:800;font-size:12.5px;padding:10px;border-radius:10px;cursor:pointer}
.wcf-result-admin-tag{font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:4px 8px;border-radius:20px;background:rgba(228,42,54,.16);color:var(--red-hi);white-space:nowrap}
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

.wcf-account{display:flex;flex-direction:column;gap:16px}
.wcf-account-always{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:-6px 2px -8px}
.wcf-accordion{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.wcf-accordion-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:none;border:none;color:var(--white);padding:13px 14px;font-weight:800;font-size:13px;cursor:pointer;text-align:left}
.wcf-accordion-chevron{font-size:10px;color:var(--dim);flex:0 0 auto}
.wcf-accordion-body{padding:0 14px 14px;display:flex;flex-direction:column;gap:16px}
.wcf-account-card{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
.wcf-account-name{font-weight:800;font-size:15px}
.wcf-account-email{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-role-badge{margin-left:auto;font-family:var(--mono);font-size:10px;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--panel2);color:var(--dim)}
.wcf-role-badge.admin{color:var(--green);border:1px solid rgba(51,169,87,.4)}
.wcf-role-badge.co-owner{color:var(--blue);border:1px solid rgba(46,116,204,.4)}
.wcf-role-badge.owner{color:var(--red-hi);border:1px solid rgba(228,42,54,.4)}
.wcf-role-badge.small{margin-left:4px;padding:2px 7px;font-size:9px}
.wcf-inbox{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 13px}
.wcf-inbox-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.wcf-inbox-head h4{margin:0;font-size:13px;font-weight:800}
.wcf-inbox-unread-pill{background:var(--red);color:#fff;font-family:var(--mono);font-weight:800;font-size:11px;padding:2px 9px;border-radius:20px}
.wcf-msg-card{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px 13px}
.wcf-msg-card + .wcf-msg-card{margin-top:9px}
.wcf-msg-card.unread{border-color:rgba(228,42,54,.4);background:linear-gradient(135deg,rgba(228,42,54,.1),var(--bg))}
.wcf-msg-from{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
.wcf-msg-text{font-size:13.5px;line-height:1.5;margin:6px 0 10px;color:var(--white)}
.wcf-msg-ack{width:100%;background:var(--green);color:#04140a;border:none;padding:10px;border-radius:9px;font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-msg-read-note{font-size:11px;color:var(--dim);text-align:center;margin:0}
.wcf-role-unread{background:var(--red);color:#fff;font-family:var(--mono);font-weight:800;font-size:10px;padding:1px 6px;border-radius:20px;flex:0 0 auto}
.wcf-upcoming{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 13px}
.wcf-upcoming h4{margin:0 0 4px;font-size:13px;font-weight:800}
.wcf-upcoming-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.wcf-upcoming-row:last-child{border-bottom:none}
.wcf-upcoming-venue{font-weight:700;font-size:13px}
.wcf-upcoming-date{font-size:11px;color:var(--dim);margin-top:1px}
.wcf-upcoming-waiting{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;padding:3px 8px;border-radius:999px;background:rgba(224,167,51,.16);color:var(--amber);white-space:nowrap;flex:0 0 auto}
.wcf-tab-self-pay{background:var(--red);color:#fff;border:none;padding:8px 12px;border-radius:8px;font-weight:800;font-size:11px;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.wcf-tab-self-pending{font-size:10px;font-weight:800;color:#7CAEF0;white-space:nowrap;flex:0 0 auto}
.wcf-account-field{display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-account-rename{display:flex;gap:8px}
.wcf-account-rename input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--white);padding:10px;border-radius:9px;font-size:13px;font-family:var(--sans);text-transform:none}
.wcf-account-rename button{background:var(--red);color:#fff;border:none;padding:0 14px;border-radius:9px;font-weight:800;cursor:pointer}
.wcf-account-rename button:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-signout{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:10px;font-weight:700;cursor:pointer}
.wcf-signout:hover{color:var(--red-hi);border-color:rgba(228,42,54,.5)}
.wcf-push-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:9px}
.wcf-rating-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:16px}
.wcf-rating-section h3{font-size:13px;font-weight:800;color:var(--white);margin:0 0 4px}
.wcf-rating-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0 0 12px}
.wcf-record-section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px;margin-bottom:16px}
.wcf-record-section h3{font-size:13px;font-weight:800;color:var(--white);margin:0 0 4px}
.wcf-record-empty{font-size:11px;color:var(--dim);margin:0}
.wcf-record-pct{font-size:32px;font-weight:800;color:var(--white);text-align:center;margin:6px 0 12px}
.wcf-record-pct span{display:block;font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.wcf-record-row{display:flex;justify-content:space-around;text-align:center;border-top:1px solid var(--line);padding-top:10px}
.wcf-record-row>div{display:flex;flex-direction:column;gap:2px}
.wcf-record-row strong{font-size:16px;color:var(--white)}
.wcf-record-row span{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.03em}
.wcf-rating-form{display:flex;flex-direction:column;gap:10px}
.wcf-rating-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-rating-row>span:first-child{font-size:12.5px;font-weight:700;color:var(--white);flex-shrink:0}
.wcf-rating-row select{background:var(--panel2);border:1px solid var(--line);color:var(--white);padding:7px 10px;border-radius:8px;font-size:12.5px;font-family:var(--sans)}
.wcf-star-picker{display:flex;gap:3px}
.wcf-star{background:none;border:none;font-size:20px;color:var(--line);cursor:pointer;padding:0;line-height:1}
.wcf-star.on{color:var(--amber)}
.wcf-push-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-push-label{font-size:13px;font-weight:700;color:var(--white)}
.wcf-push-sub{font-size:11px;color:var(--dim);margin-top:2px}
.wcf-push-toggle{flex:0 0 auto;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-weight:800;font-size:12px;padding:7px 16px;border-radius:20px;cursor:pointer}
.wcf-push-toggle.on{background:var(--green);border-color:var(--green);color:var(--bg)}
.wcf-push-toggle:disabled{opacity:.6;cursor:not-allowed}
.wcf-push-test{align-self:flex-start;font-size:11.5px;padding:7px 12px}
.wcf-push-note{font-size:11px;color:var(--dim);line-height:1.5;margin:0}
.wcf-guides{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;display:flex;flex-direction:column}
.wcf-guides h3{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--dim);margin:8px 10px 4px}
.wcf-guide-row{display:flex;align-items:center;justify-content:space-between;background:transparent;border:none;color:var(--white);font-size:13.5px;font-weight:600;font-family:var(--sans);padding:11px 10px;border-radius:9px;cursor:pointer;text-align:left}
.wcf-guide-row:hover{background:var(--panel2)}
.wcf-guide-arrow{color:var(--dim);font-size:18px}
.wcf-lightbox{position:fixed;inset:0;background:rgba(4,9,20,.92);z-index:100;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px 12px 40px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.wcf-lightbox-img{max-width:min(480px,100%);width:100%;border-radius:14px;box-shadow:0 20px 60px -20px rgba(0,0,0,.6)}
.wcf-modal-overlay{position:fixed;inset:0;background:rgba(3,7,15,.7);z-index:110;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.wcf-modal{width:100%;max-width:300px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 20px 60px -15px rgba(0,0,0,.6)}
.wcf-modal-icon{font-size:22px;margin-bottom:10px}
.wcf-modal-title{font-size:15px;font-weight:800;margin-bottom:6px}
.wcf-modal-msg{font-size:12.5px;color:var(--dim);line-height:1.5;margin-bottom:18px}
.wcf-modal-actions{display:flex;gap:8px}
.wcf-modal-cancel{flex:1;background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px;border-radius:9px;font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-modal-confirm{flex:1;background:var(--red);color:#fff;border:none;padding:11px;border-radius:9px;font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-modal-confirm.safe{background:var(--blue)}
.wcf-pcard{width:100%;max-width:300px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:24px 20px;text-align:center;margin:auto}
.wcf-pcard .wcf-avatar.big{margin:0 auto 12px}
.wcf-pcard-name{font-size:17px;font-weight:800}
.wcf-pcard-stats{display:flex;margin:18px 0 0;border-top:1px solid var(--line);padding-top:16px}
.wcf-pcard-stat{flex:1}
.wcf-pcard-stat b{display:block;font-family:var(--mono);font-size:19px;font-weight:800}
.wcf-pcard-stat span{font-size:9.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-top:2px;display:block}
.wcf-pcard-ratings{margin-top:18px;padding-top:16px;border-top:1px solid var(--line);text-align:left}
.wcf-pcard-ratings-label{font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-bottom:10px;text-align:center}
.wcf-pcard-metric{margin-bottom:8px}
.wcf-pcard-metric:last-child{margin-bottom:0}
.wcf-pcard-metric-top{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:3px}
.wcf-pcard-metric-top b{color:var(--white);font-family:var(--mono)}
.wcf-pcard-track{height:5px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-pcard-fill{height:100%;border-radius:5px;background:var(--blue)}
.wcf-lightbox-close{position:fixed;top:16px;right:16px;width:38px;height:38px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:22px;line-height:1;cursor:pointer;z-index:101}
.wcf-push-stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px 13px;font-size:12.5px;color:var(--dim);font-weight:600}
.wcf-audit-row{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:8px}
.wcf-audit-line{font-size:12.5px;color:var(--white);line-height:1.4}
.wcf-audit-line strong{font-weight:800}
.wcf-audit-time{font-size:10.5px;color:var(--dim);font-family:var(--mono);margin-top:3px}
.wcf-roles-search{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px 11px;border-radius:9px;font-size:12.5px;font-family:var(--sans);margin:8px 0 2px}
.wcf-roles-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line);flex-wrap:wrap;min-width:0}
.wcf-roles-row:last-child{border-bottom:none}
.wcf-roles-row>span{min-width:0;overflow-wrap:break-word}
.wcf-roles-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0}

.wcf-club-settings,.wcf-add-player{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-top:16px}
.wcf-club-settings h3,.wcf-add-player h3{margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.wcf-award-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--line)}
.wcf-award-row:last-of-type{border-bottom:none;margin-bottom:10px}
.wcf-team-settings{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:6px}
.wcf-team-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700;min-width:0}
.wcf-team-field.wide{grid-column:1/-1}
.wcf-team-field input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:8px;font-size:13px;font-family:var(--sans);text-transform:none;width:100%;max-width:100%;min-width:0;box-sizing:border-box;display:block}
.wcf-team-field.color input{width:52px;padding:2px;height:38px;cursor:pointer}
.wcf-team-field.narrow input{width:70px}
.wcf-field-error{text-transform:none;letter-spacing:normal;font-weight:600;font-size:11px;color:var(--red-hi);margin-top:2px}
.wcf-club-settings .wcf-save,.wcf-add-player .wcf-save{margin-top:10px}
.wcf-club-settings .wcf-save:disabled,.wcf-add-player .wcf-save:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-login-code{margin-top:12px;background:var(--panel2);border:1px solid rgba(51,169,87,.4);border-radius:10px;padding:14px;text-align:center}
.wcf-login-code-value{display:block;font-family:var(--mono);font-weight:800;font-size:28px;letter-spacing:4px;color:var(--green)}
.wcf-login-code-note{display:block;font-size:11px;color:var(--dim);margin-top:6px;line-height:1.4}

.wcf-nav{position:sticky;bottom:0;z-index:5;display:flex;background:rgba(10,26,52,.95);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px))}
.wcf-navbtn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;
  color:var(--dim);padding:6px 0;cursor:pointer;font-weight:700;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;transition:.15s}
.wcf-navbtn.active{color:var(--red-hi)}
.wcf-navbtn svg{opacity:.9}

@media (max-width:400px){ .wcf-sheet{grid-template-columns:1fr} .wcf-edit{grid-template-columns:1fr} }
`;
