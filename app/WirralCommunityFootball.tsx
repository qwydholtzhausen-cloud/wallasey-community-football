"use client";

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";
import { motmWinners, goalsLookup } from "../lib/motm";
import { MOTM_VOTE_WINDOW_MINUTES, MATCH_DURATION_MINUTES, kickoffCutoff, nowInLondon, previousMonthKey, monthReleaseAt, nextMonthStart } from "../lib/time";
import { predictionPoints, buildLeaderboard, buildMonthlyLeaderboards, topScorers, type ScoredPrediction } from "../lib/predictions";
import { assignToTeams, computePerformanceStats, performanceBonus, type RatedPlayer } from "../lib/teamBalance";
import { defaultPitchCost } from "../lib/pitchCost";
import {
  BOOT_ROOM_OPEN_TO_ALL,
  CALENDAR_BUTTON_OPEN_TO_ALL,
  WRAPPED_OPEN_TO_ALL_FROM,
  WRAPPED_ADMIN_PREVIEW_MONTH_SO_FAR,
  WRAPPED_FIRST_MONTH_FOR_ALL,
  MONZO_MATCHING_LIVE,
} from "../lib/clubPolicy";
import { computeWrapped } from "../lib/wrapped";
import { computeRecords, computePersonalBests, type Holder, type ClubRecords } from "../lib/records";
import WrappedStory, { drawWrappedCard, wrappedBannerCss, type WrappedExtras } from "./WrappedStory";
import { Avatar, TickNum, avatarFor, useChanged } from "./ui/shared";
import { EmptyScene } from "./ui/EmptyScene";
import { FeedTab, FlapNum, PotCount, type FeedItem } from "./ui/feed";
import { wrappedThemeFor } from "../lib/wrappedThemes";
import { MOTM_TAGS } from "./motmTags";
import { googleCalendarUrl } from "../lib/calendar";
import { BOOT_CATEGORIES, BOOT_CATEGORY, normaliseUkPhone, displayUkPhone, type BootCategory } from "../lib/bootRoom";

// The payment link is just config, not baked into booking logic (statuses
// below), so swapping providers later only touches this one env var.
const PAYMENT_LINK = process.env.NEXT_PUBLIC_PAYMENT_LINK || "";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const MAX_SPOTS = 16;
// Special fixtures (e.g. a Sunday 11-a-side) can take a full squad.
const SPECIAL_MAX_SPOTS = 30;
const SPECIAL_DEFAULTS = { venue: "Solar Campus", pitch: "11-a-side", kickoff: "12:00", max_players: 22 };
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

function StarPicker({ value, onChange, max = 5 }: { value: number; onChange: (n: number) => void; max?: number }) {
  return (
    <div className="wcf-star-picker">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" className={"wcf-star" + (n <= value ? " on" : "")} onClick={() => onChange(n)} aria-label={`${n} of ${max}`}>
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
  max = 5,
}: {
  initial: PlayerRating | null;
  onSave: (fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  saveLabel: string;
  // Admin ratings go out of 10 (self stays out of 5) for finer balancing
  // precision - see the ratingByPlayer normalization where the two scales
  // get reconciled back to one for actual use.
  max?: number;
}) {
  const mid = Math.round(max / 2);
  const [fitness, setFitness] = useState(initial?.fitness ?? mid);
  const [attack, setAttack] = useState(initial?.attack ?? mid);
  const [defence, setDefence] = useState(initial?.defence ?? mid);
  const [goalkeeping, setGoalkeeping] = useState(initial?.goalkeeping ?? mid);
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
            <b>{m.value.toFixed(1)} / {max}</b>
          </div>
          <div className="wcf-rating-track">
            <div
              className="wcf-rating-fill"
              style={{
                width: `${(m.value / max) * 100}%`,
                background: `linear-gradient(90deg,${ratingFillColor((m.value / max) * 5)}99,${ratingFillColor((m.value / max) * 5)})`,
              }}
            />
          </div>
          <StarPicker value={m.value} onChange={m.onChange} max={max} />
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

type PotExemptReason = "birthday" | "prize" | "carried_over" | "other";
const POT_EXEMPT_LABEL: Record<PotExemptReason, string> = { birthday: "Free · birthday", prize: "Free · prize", carried_over: "Free · carried over", other: "Free · other" };

interface BookingRow {
  id: string;
  player_id: string;
  status: PayStatus;
  waiting: boolean;
  team: Team | null;
  created_at: string;
  promoted_at: string | null;
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
  // A one-off special (e.g. Sunday 11-a-side): shown in gold, without the
  // usual red/green booking colours. Undefined until the column exists.
  special?: boolean;
  published_at?: string | null;
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
interface EmergencyContact {
  player_id: string;
  contact_name: string;
  contact_phone: string;
}
interface PlayerBirthday {
  player_id: string;
  date_of_birth: string;
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
  // Optional "Why?" tag on the vote (MOTM_TAGS); feeds the season Wrapped.
  tag?: string | null;
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
  require_approval?: boolean; // member approval switch (undefined before its SQL is run)
}

// Someone who signed up while member approval was on, with what they told
// the admins (join_requests is admins-only).
interface PendingMember {
  id: string;
  display_name: string;
  created_at: string;
  status: "pending" | "declined";
  referral_note: string | null;
  mobile: string | null;
  requested_at: string | null;
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
  // The transparent cut-out crest, drawn as it is at its own proportions
  // within the same header slot - no box or frame needed around it.
  const crestBox = { x: pad, y: 52, w: 78, h: 86 };
  try {
    const crest = await loadImage("/crest.png");
    const scale = Math.min(crestBox.w / crest.width, crestBox.h / crest.height);
    const cw = crest.width * scale;
    const ch = crest.height * scale;
    ctx.drawImage(crest, crestBox.x + (crestBox.w - cw) / 2, crestBox.y + (crestBox.h - ch) / 2, cw, ch);
  } catch {
    // Crest failed to load (offline etc.) - the wordmark still carries it.
  }

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
    const motmSize = fitFontSize(opts.motmWinner, W - pad - motmTextX, soraFont, 800, 42, 24, -0.015);
    letterSpaced(motmSize * -0.015);
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

// Draws the shareable "Player of the Month" card. Adapted from the design
// import in two ways the source design didn't cover: real player names
// don't reliably split into "first name / surname" (several profiles are
// single-word nicknames, e.g. "Fletch"), so the name is drawn as one unit
// and shrunk to fit rather than styled as two different-sized lines; and
// the design's own iteration notes say joint-winner variants were
// deliberately dropped, but the app's actual tiebreak logic can and does
// produce joint winners for real (see playerOfMonth), so that case is
// designed here rather than assumed away. Layout constants measured the
// same way as the result card: a real rendered HTML version at 1080x1350,
// getBoundingClientRect() on every element, for both the one-winner and
// two-winner cases.
async function drawPlayerOfMonthCard(opts: { monthLabel: string; names: string[] }): Promise<Blob> {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Canvas isn't supported on this device");
  const ctx: CanvasRenderingContext2D = ctx2d;

  await document.fonts.ready;
  const rootStyle = getComputedStyle(document.documentElement);
  const sora = rootStyle.getPropertyValue("--font-sora").trim() || "sans-serif";
  const inter = rootStyle.getPropertyValue("--font-inter").trim() || "sans-serif";
  const soraFont = (weight: number, size: number) => `${weight} ${size}px ${sora}`;
  const interFont = (weight: number, size: number) => `${weight} ${size}px ${inter}`;
  function letterSpaced(px: number) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${px}px`;
  }
  function resetLetterSpacing() {
    letterSpaced(0);
  }
  // Same fit-to-width technique as the result card, including accounting
  // for letterSpacing (which measureText() silently ignores).
  function fitFontSize(text: string, maxWidth: number, fontFn: (weight: number, size: number) => string, weight: number, maxSize: number, minSize: number, letterSpacingEm = 0) {
    let size = maxSize;
    ctx.font = fontFn(weight, size);
    const w = ctx.measureText(text).width + letterSpacingEm * size * Math.max(text.length - 1, 0);
    if (w > maxWidth) size = Math.max(minSize, Math.floor(maxSize * (maxWidth / w)));
    ctx.font = fontFn(weight, size);
    return size;
  }

  const pad = 70;
  const white = "#F5F6F8";
  const amber = "#eab308";
  const navy = "#0d0d1a";

  ctx.fillStyle = navy;
  ctx.fillRect(0, 0, W, H);

  // Background photo (a generated floodlit-pitch shot) at 62% vertical
  // anchor, brightened - matches the design's object-position/filter.
  // Falls back to a plain gold-tinted glow if the asset's missing, so the
  // card still looks intentional rather than broken.
  ctx.save();
  try {
    const bg = await loadImage("/potm-bg.jpg");
    const scale = Math.max(W / bg.width, H / bg.height);
    const bw = bg.width * scale;
    const bh = bg.height * scale;
    ctx.filter = "brightness(1.5) contrast(1.05) saturate(1.15)";
    ctx.drawImage(bg, W / 2 - bw / 2, H * 0.62 - bh * 0.62, bw, bh);
    ctx.filter = "none";
  } catch {
    const radial = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, W * 0.9);
    radial.addColorStop(0, "rgba(234,179,8,0.16)");
    radial.addColorStop(1, "rgba(234,179,8,0)");
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, W, H);
  }
  const scrim = ctx.createLinearGradient(0, 0, 0, H);
  scrim.addColorStop(0, "rgba(13,13,26,0.78)");
  scrim.addColorStop(0.24, "rgba(13,13,26,0.34)");
  scrim.addColorStop(0.46, "rgba(13,13,26,0.66)");
  scrim.addColorStop(0.62, "rgba(13,13,26,0.6)");
  scrim.addColorStop(0.8, "rgba(13,13,26,0.14)");
  scrim.addColorStop(1, "rgba(13,13,26,0.6)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  ctx.fillStyle = amber;
  ctx.fillRect(0, H - 6, W, 6);

  // ── Header: crest, wordmark, month tab ─────────────────────────────
  const crestSize = 74;
  try {
    // The transparent cut-out crest at its own proportions, in the slot the
    // gold-ringed round badge used to fill.
    const crest = await loadImage("/crest.png");
    const scale = Math.min(crestSize / crest.width, (crestSize + 6) / crest.height);
    const cw = crest.width * scale;
    const ch = crest.height * scale;
    ctx.drawImage(crest, pad + (crestSize - cw) / 2, pad + (crestSize - ch) / 2, cw, ch);
  } catch {
    // Crest failed to load (offline etc.) - the wordmark still carries it.
  }

  const wordmarkX = pad + crestSize + 20;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = white;
  ctx.font = interFont(700, 24);
  letterSpaced(24 * 0.14);
  ctx.shadowColor = "rgba(13,13,26,0.9)";
  ctx.shadowBlur = 12;
  ctx.fillText("WIRRAL COMMUNITY", wordmarkX, pad + 4);
  ctx.fillText("FOOTBALL", wordmarkX, pad + 4 + 29);
  resetLetterSpacing();
  ctx.shadowBlur = 0;

  const tabText = opts.monthLabel.toUpperCase();
  const tabFontSize = 24;
  ctx.font = interFont(700, tabFontSize);
  letterSpaced(tabFontSize * 0.2);
  const tabTextW = ctx.measureText(tabText).width;
  resetLetterSpacing();
  const tabPadX = 22;
  const tabH = 61;
  const tabW = tabTextW + tabPadX * 2;
  const tabX = W - pad - tabW;
  const tabY = pad + crestSize / 2 - tabH / 2;
  ctx.fillStyle = amber;
  ctx.fillRect(tabX, tabY, tabW, tabH);
  ctx.fillStyle = navy;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = interFont(700, tabFontSize);
  letterSpaced(tabFontSize * 0.2);
  ctx.fillText(tabText, tabX + tabPadX, tabY + tabH / 2 + 1);
  resetLetterSpacing();

  // ── Label + name(s), vertically centred in the space between header
  // and footer - same reflow principle as the result card's score
  // section, just centred instead of bottom-anchored. ──────────────
  const headerBottom = pad + crestSize;
  const footerY = 1267;
  const labelRowH = 29;
  const labelToNameGap = 30;
  const nameMaxW = W - pad * 2;
  const names = opts.names.length > 0 ? opts.names : ["Nobody yet"];

  ctx.font = interFont(700, 24);
  letterSpaced(24 * 0.34);
  const labelText = (names.length > 1 ? "PLAYERS OF THE MONTH" : "PLAYER OF THE MONTH");
  resetLetterSpacing();

  let contentH: number;
  let nameSizes: number[] = [];
  if (names.length <= 1) {
    const size = fitFontSize(names[0].toUpperCase(), nameMaxW, soraFont, 800, 148, 40, -0.03);
    nameSizes = [size];
    contentH = labelRowH + labelToNameGap + size * 0.98;
  } else {
    const size1 = fitFontSize(names[0].toUpperCase(), nameMaxW, soraFont, 800, 108, 32, -0.02);
    const size2 = fitFontSize(names[1].toUpperCase(), nameMaxW, soraFont, 800, 108, 32, -0.02);
    nameSizes = [size1, size2];
    const andRowH = 54; // measured: 14px margin + ~26px text + 14px margin
    contentH = labelRowH + labelToNameGap + size1 * 1.05 + andRowH + size2 * 1.05;
  }

  const contentTop = headerBottom + (footerY - headerBottom - contentH) / 2;

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = amber;
  ctx.fillRect(pad, contentTop + (labelRowH - 2) / 2, 56, 2);
  ctx.font = interFont(700, 24);
  letterSpaced(24 * 0.34);
  ctx.shadowColor = "rgba(13,13,26,0.9)";
  ctx.shadowBlur = 12;
  ctx.fillText(labelText, pad + 56 + 18, contentTop);
  resetLetterSpacing();
  ctx.shadowBlur = 0;

  let y = contentTop + labelRowH + labelToNameGap;
  ctx.fillStyle = white;
  ctx.shadowColor = "rgba(13,13,26,0.85)";
  ctx.shadowBlur = 40;
  if (names.length <= 1) {
    ctx.font = soraFont(800, nameSizes[0]);
    letterSpaced(nameSizes[0] * -0.03);
    ctx.fillText(names[0].toUpperCase(), pad, y);
    resetLetterSpacing();
  } else {
    ctx.font = soraFont(800, nameSizes[0]);
    letterSpaced(nameSizes[0] * -0.02);
    ctx.fillText(names[0].toUpperCase(), pad, y);
    resetLetterSpacing();
    y += nameSizes[0] * 1.05 + 14;
    ctx.fillStyle = amber;
    ctx.fillRect(pad, y + 11, 32, 2);
    ctx.font = interFont(700, 22);
    letterSpaced(22 * 0.2);
    ctx.fillText("AND", pad + 32 + 16, y);
    resetLetterSpacing();
    y += 26 + 14;
    ctx.fillStyle = white;
    ctx.font = soraFont(800, nameSizes[1]);
    letterSpaced(nameSizes[1] * -0.02);
    ctx.fillText(names[1].toUpperCase(), pad, y);
    resetLetterSpacing();
  }
  ctx.shadowBlur = 0;

  // ── Footer ──────────────────────────────────────────────────────
  const footerText = "WIRRAL COMMUNITY FOOTBALL";
  ctx.font = interFont(600, 21);
  letterSpaced(21 * 0.3);
  const footerTextW = ctx.measureText(footerText).width;
  resetLetterSpacing();
  const footerTextX = W - pad - footerTextW;
  ctx.strokeStyle = "rgba(248,250,252,0.2)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, footerY);
  ctx.lineTo(footerTextX - 24, footerY);
  ctx.stroke();
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(248,250,252,0.62)";
  ctx.font = interFont(600, 21);
  letterSpaced(21 * 0.3);
  ctx.shadowColor = "rgba(13,13,26,0.9)";
  ctx.shadowBlur = 12;
  ctx.fillText(footerText, footerTextX, footerY + 1);
  resetLetterSpacing();
  ctx.shadowBlur = 0;

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

// ── Loading screen ──
// One tunnel walkout covers the whole start-up. Each step that's still
// loading (session, member check, club data) renders <SplashScreen />,
// which draws nothing itself - it just holds the walkout up. When nothing
// is holding it any more, the walkout plays its exit (down the tunnel and
// out into the light). Because the walkout lives at the root it never
// restarts between steps.
const SplashHoldCtx = createContext<() => () => void>(() => () => {});
function SplashScreen() {
  const hold = useContext(SplashHoldCtx);
  useEffect(() => hold(), [hold]);
  return null;
}
const SPLASH_LINES = ["Switching on the floodlights", "Chalking the lines", "Pumping up the balls", "Hanging the nets", "Finding the bibs", "Warming up"];
function TunnelSplash({ leaving }: { leaving: boolean }) {
  const [line, setLine] = useState(-1);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (leaving) return;
    let iv: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      setLine(0);
      iv = setInterval(() => setLine((n) => n + 1), 1600);
    }, 1500);
    // A failed first load would otherwise leave this up for good.
    const s = setTimeout(() => setStuck(true), 12000);
    return () => { clearTimeout(t); clearTimeout(s); if (iv) clearInterval(iv); };
  }, [leaving]);
  return (
    <div className={"wcf-sp" + (leaving ? " out" : "")} aria-busy={!leaving} aria-label="Loading Wirral Community Football">
      <div className="wcf-sp-photo"><img src="/splash-tunnel.jpg" alt="" fetchPriority="high" /></div>
      <div className="wcf-sp-glow" />
      <div className="wcf-sp-scrim" />
      <div className="wcf-sp-body">
        <img className="wcf-sp-crest" src="/crest.png" alt="" />
        <div className="wcf-sp-est">EST. 2026</div>
        <div className="wcf-sp-word">
          {"WIRRAL".split("").map((c, i) => <i key={i} style={{ "--i": i } as React.CSSProperties}>{c}</i>)}
          <span className="wcf-sp-sub">COMMUNITY FOOTBALL</span>
        </div>
        <div className="wcf-sp-pitch" aria-hidden>
          <span className="wcf-sp-line" />
          <span className="wcf-sp-shadow" />
          <span className="wcf-sp-ball">
            <svg viewBox="0 0 24 24" fill="#fff" stroke="#0d0d1a" strokeWidth="1.2"><circle cx="12" cy="12" r="10.5" /><path d="M12 7.5l3 2.2-1.1 3.6h-3.8L9 9.7z" fill="#0d0d1a" /><path d="M12 3v4.5M5 8.5l4 1.7M19 8.5l-4 1.7M7.3 19l1.7-4.9M16.7 19l-1.7-4.9" fill="none" /></svg>
          </span>
        </div>
        {stuck ? (
          <div className="wcf-sp-stuck">
            This is taking longer than usual.
            <button onClick={() => window.location.reload()}>Try again</button>
          </div>
        ) : (
          <div className="wcf-sp-status">{line >= 0 && <span key={line}>{SPLASH_LINES[line % SPLASH_LINES.length]}…</span>}</div>
        )}
      </div>
      <div className="wcf-sp-flash" />
    </div>
  );
}

export default function WirralCommunityFootball() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // The walkout is up from the first paint (it's in the server HTML too)
  // until no step is holding it; then it plays its exit and goes.
  const [splash, setSplash] = useState<"on" | "leaving" | "gone">("on");
  const holds = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useCallback(() => {
    holds.current++;
    clearTimeout(settle.current);
    setSplash((p) => (p === "gone" ? "on" : p));
    return () => {
      holds.current--;
      clearTimeout(settle.current);
      // Wait a beat (one step's hold often ends just as the next begins),
      // and let the walkout play for at least 1.7s so the crest and name land.
      const shown = typeof performance !== "undefined" ? performance.now() : 0;
      settle.current = setTimeout(() => {
        if (holds.current === 0) setSplash((p) => (p === "on" ? "leaving" : p));
      }, Math.max(120, 1700 - shown));
    };
  }, []);
  useEffect(() => {
    if (splash !== "leaving") return;
    const t = setTimeout(() => setSplash("gone"), 950);
    return () => clearTimeout(t);
  }, [splash]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <div className="wcf-root">
      <style>{css}</style>
      <SplashHoldCtx.Provider value={hold}>
      {session === undefined ? (
        <SplashScreen />
      ) : session ? (
        <MemberGate session={session} />
      ) : (
        <SignIn />
      )}
      </SplashHoldCtx.Provider>
      {splash !== "gone" && <TunnelSplash leaving={splash === "leaving"} />}
    </div>
  );
}

// Member approval: everyone active goes straight to the app (remembered
// on the phone, so there's no extra wait on open). Anyone waiting for an
// admin sees only the join step or the waiting room; declined, a polite
// screen. Any error reading the status - including before its database
// column exists - counts as active, so this can never lock members out;
// the database's own rules still keep a waiting member away from club data.
function MemberGate({ session }: { session: Session }) {
  const uid = session.user.id;
  const cacheKey = `wcf-member-active-${uid}`;
  const [status, setStatus] = useState<string | null>(() => {
    try {
      return localStorage.getItem(cacheKey) === "1" ? "active" : null;
    } catch {
      return null;
    }
  });
  const [info, setInfo] = useState<{ name: string; requested: boolean } | null>(null);

  const check = useCallback(async () => {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (error || !data) {
      setStatus((cur) => cur ?? "active");
      return;
    }
    const st: string = data.status ?? "active";
    if (st !== "active") {
      const { data: req } = await supabase.from("join_requests").select("player_id").eq("player_id", uid).maybeSingle();
      setInfo({ name: data.display_name ?? "", requested: !!req });
    }
    setStatus(st);
    try {
      if (st === "active") localStorage.setItem(cacheKey, "1");
      else localStorage.removeItem(cacheKey);
    } catch {}
  }, [uid, cacheKey]);

  useEffect(() => {
    void check();
    const onVis = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [check]);
  // While waiting, look again every 20 seconds so "You're in" appears on its own.
  useEffect(() => {
    if (status === "active" || status === null) return;
    const t = window.setInterval(() => void check(), 20000);
    return () => window.clearInterval(t);
  }, [status, check]);

  if (status === null) return <SplashScreen />;
  if (status === "active") return <App session={session} />;
  return <WaitingRoom session={session} status={status} info={info} onChanged={check} />;
}

function WaitingRoom({
  session,
  status,
  info,
  onChanged,
}: {
  session: Session;
  status: string;
  info: { name: string; requested: boolean } | null;
  onChanged: () => Promise<void>;
}) {
  const emailPrefix = (session.user.email ?? "").split("@")[0];
  const [name, setName] = useState(info && info.name !== emailPrefix ? info.name : "");
  const [referral, setReferral] = useState("");
  const [mobile, setMobile] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"idle" | "on" | "blocked" | "unsupported">("idle");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) setPushState("unsupported");
    else if (Notification.permission === "granted") setPushState("on");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { data } = await supabase.auth.getSession();
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
      body: JSON.stringify({ displayName: name, referral, mobile }),
    });
    const body = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) return setError(body.error ?? "Something went wrong, try again");
    await onChanged();
  }

  // Same subscription as Account > Notifications, for someone not in the app yet.
  async function turnOnPush() {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setPushState("blocked");
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
      const json = sub.toJSON();
      await supabase
        .from("push_subscriptions")
        .upsert(
          { user_id: session.user.id, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_key: json.keys?.auth, origin: window.location.origin },
          { onConflict: "endpoint" }
        );
      await supabase.from("profiles").update({ push_opt_in: true }).eq("id", session.user.id);
      setPushState("on");
    } catch {
      setPushState("blocked");
    }
  }

  const first = (info?.name ?? "").split(" ")[0];

  if (status === "declined") {
    return (
      <div className="wcf-gate">
        <div className="wcf-gate-mid">
          <div className="wcf-gate-ring dim">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>
          </div>
          <h1>Not this time</h1>
          <p>This club is invite-only for now. If you think that&apos;s a mistake, have a word with someone who plays.</p>
        </div>
        <button className="wcf-gate-link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    );
  }

  if (!info?.requested) {
    return (
      <form className="wcf-gate" onSubmit={submit}>
        <img className="wcf-gate-photo" src="/floodlit-signin.jpg" alt="" />
        <div className="wcf-gate-scrim" />
        <div className="wcf-gate-form">
          <h1>Welcome to Wirral Community Football</h1>
          <p className="wcf-gate-sub">Before you&apos;re in, tell us who you are. An admin will let you in shortly.</p>
          <label className="wcf-gate-field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last name" autoComplete="name" required minLength={2} maxLength={40} />
            <small>So the squad knows who you are.</small>
          </label>
          <label className="wcf-gate-field">
            <span>Who do you know at the club?</span>
            <input value={referral} onChange={(e) => setReferral(e.target.value)} placeholder="e.g. Dan from work" maxLength={200} />
            <small>Optional. Helps the admins know you&apos;re genuine.</small>
          </label>
          <label className="wcf-gate-field">
            <span>Mobile</span>
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="07…" inputMode="tel" autoComplete="tel" maxLength={20} />
            <small>Optional. So an admin can WhatsApp you when you&apos;re in. Only admins see it.</small>
          </label>
          {error && <div className="wcf-gate-error">{error}</div>}
          <button className="wcf-gate-btn" type="submit" disabled={sending || name.trim().length < 2}>
            {sending ? "Sending…" : "Request to join"}
          </button>
          <button type="button" className="wcf-gate-link" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </form>
    );
  }

  return (
    <div className="wcf-gate">
      <div className="wcf-gate-mid">
        <div className="wcf-gate-ring">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </div>
        <h1>You&apos;re on the list{first ? `, ${first}` : ""}</h1>
        <p>An admin will check your request soon. This screen changes the moment you&apos;re in.</p>
        <div className="wcf-gate-steps">
          <div className="done"><i>✓</i>Account created</div>
          <div className="now"><i>2</i>Waiting for an admin</div>
          <div className="next"><i>3</i>Book your first game</div>
        </div>
      </div>
      {pushState === "idle" && (
        <button className="wcf-gate-btn" onClick={turnOnPush}>Turn on notifications</button>
      )}
      {pushState === "on" && <div className="wcf-gate-note">Notifications are on. We&apos;ll tell you when you&apos;re in.</div>}
      {pushState === "blocked" && <div className="wcf-gate-note">Notifications are blocked on this phone. Just open the app again later to check.</div>}
      {pushState === "unsupported" && <div className="wcf-gate-note">On iPhone, add the app to your Home Screen to get notifications. Or just open it again later.</div>}
      <button className="wcf-gate-link" onClick={() => supabase.auth.signOut()}>Sign out</button>
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
            <img src="/crest.png" alt="Wirral Community Football crest" />
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
          We use your details to run the club. <a href="/privacy">How we look after them</a>
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
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([]);
  const [birthdays, setBirthdays] = useState<PlayerBirthday[]>([]);
  const [lineupView, setLineupView] = useState<"sheet" | "fairness" | "predict">("sheet");
  const [showTeamRatings, setShowTeamRatings] = useState(false);
  const [predictView, setPredictView] = useState<string>("season");
  const [predictOpenId, setPredictOpenId] = useState<string | null>(null);
  const [suggestedTeams, setSuggestedTeams] = useState<{ white: string[]; red: string[] } | null>(null);
  const [ratingPlayerId, setRatingPlayerId] = useState<string | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string; undo?: () => void } | null>(null);
  // Bookings this admin has just confirmed themselves (see the payment watcher).
  const selfConfirmedRef = useRef<Set<string>>(new Set());

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
  const [showAllHatTricks, setShowAllHatTricks] = useState(false);
  const [resultsView, setResultsView] = useState<"season" | "table" | "records" | "fixtures" | "pot">("season");
  const [potAmount, setPotAmount] = useState("");
  const [potDescription, setPotDescription] = useState("");
  const [potEntryKind, setPotEntryKind] = useState<"add" | "deduct">("add");
  const [potCategory, setPotCategory] = useState<PotCategory>("other");
  const [addingPotEntry, setAddingPotEntry] = useState(false);
  const [resultsMonth, setResultsMonth] = useState<string>("all");
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [motmVotersFor, setMotmVotersFor] = useState<{ gameId: string; candidateId: string; candidateName: string } | null>(null);
  // The vote you just cast gets the medal drop (replaces the old toast).
  const [justVoted, setJustVoted] = useState<{ gameId: string; candidateId: string; n: number } | null>(null);
  const [motmMomentClosed, setMotmMomentClosed] = useState<string | null>(null);
  const [ticketShow, setTicketShow] = useState<{ mode: "booked" | "paid" | "birthday"; gameIds: string[] } | null>(null);
  const [specialShow, setSpecialShow] = useState<string | null>(null);
  const [fxCalendar, setFxCalendar] = useState<{ month: string; dates: string[]; ids: string[] } | null>(null);
  const [fxCascade, setFxCascade] = useState<string[]>([]);
  const [fxChip, setFxChip] = useState(0);
  const [fxNewStore, setFxNewStore] = useState<Record<string, number>>({});
  const [envelope, setEnvelope] = useState<{ ids: string[]; items: { from: string; text: string; when: string }[] } | null>(null);
  const [predLockShown, setPredLockShown] = useState<string | null>(null);
  const [potmShow, setPotmShow] = useState<"everyone" | "winner" | null>(null);
  const [potmLand, setPotmLand] = useState(false);
  const [recordFalls, setRecordFalls] = useState<Record<string, { v: number; who: string }>>({});
  const [recordMomentDone, setRecordMomentDone] = useState(false);
  const [promoShow, setPromoShow] = useState<string | null>(null);
  const [momentsDone, setMomentsDone] = useState<string[]>([]);
  const [playerCardId, setPlayerCardId] = useState<string | null>(null);
  const [playerCardTeam, setPlayerCardTeam] = useState<{ name: string; color: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showBatchGen, setShowBatchGen] = useState(false);
  // The Add/Edit fixture sheet (admins).
  const [fixtureSheet, setFixtureSheet] = useState<{ mode: "add" } | { mode: "edit"; id: string } | null>(null);
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
  const [feedView, setFeedView] = useState<"feed" | "bootroom">("feed");
  const [showLaterFixtures, setShowLaterFixtures] = useState(false);

  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "co-owner" || myProfile?.role === "owner";
  // Soft launch: admins see the Boot Room first so they can seed it before
  // everyone else does (lib/clubPolicy.ts).
  const bootRoomVisible = BOOT_ROOM_OPEN_TO_ALL || isAdmin;
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

  const [pendingMembers, setPendingMembers] = useState<PendingMember[]>([]);
  const [justLetIn, setJustLetIn] = useState<{ id: string; name: string; mobile: string | null }[]>([]);
  const loadProfiles = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, display_name, role, created_at, avatar_url").order("display_name");
    // Anyone waiting for approval (or declined) stays out of every player
    // list; only admins can see them at all (RLS), in New members. Errors
    // (e.g. before the status column exists) just mean nobody's hidden.
    const { data: notIn } = await supabase.from("profiles").select("id, display_name, created_at, status").neq("status", "active");
    const hide = new Set((notIn ?? []).map((p: { id: string }) => p.id));
    // Test accounts (used by the smoke tests) are hidden from everyone too.
    const { data: tests } = await supabase.from("profiles").select("id").eq("is_test", true);
    (tests ?? []).forEach((p: { id: string }) => hide.add(p.id));
    if (data) setProfiles((data as Profile[]).filter((p) => !hide.has(p.id)));
    if (notIn && notIn.length) {
      const { data: reqs } = await supabase.from("join_requests").select("*");
      const byId = new Map((reqs ?? []).map((r: { player_id: string; referral_note: string | null; mobile: string | null; requested_at: string }) => [r.player_id, r]));
      setPendingMembers(
        (notIn as { id: string; display_name: string; created_at: string; status: "pending" | "declined" }[])
          .map((p) => ({ ...p, referral_note: byId.get(p.id)?.referral_note ?? null, mobile: byId.get(p.id)?.mobile ?? null, requested_at: byId.get(p.id)?.requested_at ?? null }))
          .sort((a, b) => (b.requested_at ?? b.created_at).localeCompare(a.requested_at ?? a.created_at))
      );
    } else setPendingMembers([]);
  }, []);

  const loadGames = useCallback(async () => {
    const { data } = await supabase
      .from("games")
      .select(
        "*, bookings(id, player_id, status, waiting, team, created_at, promoted_at, pot_exempt_reason, player:profiles!bookings_player_id_fkey(id, display_name, role, avatar_url), confirmer:profiles!bookings_confirmed_by_fkey(display_name))"
      )
      .order("date", { ascending: true });
    if (data) setGames(data as unknown as GameRow[]);
  }, []);

  const loadClubSettings = useCallback(async () => {
    const { data } = await supabase
      .from("club_settings")
      .select("*")
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

  // While a game's vote is open the database only returns your own vote
  // (other people's appear once voting closes), so "8 of 16 voted" comes
  // from a counter that gives the number and nothing else.
  const [motmBallotCounts, setMotmBallotCounts] = useState<Record<string, number>>({});
  const loadMotmVotes = useCallback(async () => {
    const { data } = await supabase.from("motm_votes").select("*");
    if (data) setMotmVotes(data as MotmVote[]);
  }, []);
  const loadBallotCount = useCallback(async (gameId: string) => {
    const { data, error } = await supabase.rpc("motm_ballot_count", { p_game_id: gameId });
    if (!error && typeof data === "number") setMotmBallotCounts((cur) => ({ ...cur, [gameId]: data }));
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

  // RLS scopes this the same way as self-ratings: a player's query only
  // ever returns their own row, an admin's returns everyone's.
  const loadEmergencyContacts = useCallback(async () => {
    const { data } = await supabase.from("emergency_contacts").select("player_id, contact_name, contact_phone");
    if (data) setEmergencyContacts(data as EmergencyContact[]);
  }, []);

  // Same RLS scoping as emergency contacts and self-ratings - a player's
  // query only ever returns their own row, an admin's returns everyone's.
  const loadBirthdays = useCallback(async () => {
    const { data } = await supabase.from("player_birthdays").select("player_id, date_of_birth");
    if (data) setBirthdays(data as PlayerBirthday[]);
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
    if (!MONZO_MATCHING_LIVE) return;
    const { data } = await supabase
      .from("monzo_transactions")
      .select("id, amount_pence, code, reason, created_at, player:profiles(display_name)")
      .eq("outcome", "unmatched")
      .order("created_at", { ascending: false });
    if (data) setMonzoUnmatched(data as unknown as MonzoUnmatchedRow[]);
  }, []);

  // Check for a newer notification service worker each time the app opens,
  // so changes to it (like counting taps) reach phones promptly.
  useEffect(() => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {});
    }
  }, []);

  // When this person last opened the app, for GaffAI's "who's gone quiet?".
  // Written on open and whenever the app comes back to the foreground, at
  // most every 30 minutes. Never shown in the app.
  const lastActiveWrite = useRef(0);
  useEffect(() => {
    const touch = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActiveWrite.current < 30 * 60000) return;
      lastActiveWrite.current = Date.now();
      supabase
        .from("profiles")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", myId)
        .then(() => {});
      // One row per person per day the app's opened, for the end-of-season
      // Wrapped (days opened, streaks, when you check it). Admins only via
      // GaffAI; cleared after 12 months.
      supabase.rpc("log_app_open").then(() => {});
    };
    touch();
    document.addEventListener("visibilitychange", touch);
    return () => document.removeEventListener("visibilitychange", touch);
  }, [myId]);

  const loadAll = useCallback(
    () =>
      Promise.all([
        loadProfile(),
        loadProfiles(),
        loadGames(),
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
        loadEmergencyContacts(),
        loadBirthdays(),
        loadAdminMessages(),
        loadMonzoUnmatched(),
      ]),
    [
      loadProfile,
      loadProfiles,
      loadGames,
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
      loadEmergencyContacts,
      loadBirthdays,
      loadAdminMessages,
      loadMonzoUnmatched,
    ]
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadAll();
      } finally {
        setLoading(false);
      }
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
      // Skipped when you confirmed it yourself (an admin's own booking),
      // so it doesn't replace the "marked paid · Undo" bar.
      if (prevStatus[g.id] && prevStatus[g.id] !== "confirmed" && mine.status === "confirmed" && !selfConfirmedRef.current.has(mine.id)) {
        notifySuccess(`✓ Payment confirmed for ${g.venue} · ${fmtDate(g.date)}`);
      }
      // With motion on, the substitution board (promoShow) says this instead.
      if (prevWaiting[g.id] === true && mine.waiting === false && !motionOk()) {
        notifySuccess(`✓ You're in for ${g.venue} · ${fmtDate(g.date)}: a spot opened up`);
      }
    });
    prevStatusRef.current = nextStatus;
    prevWaitingRef.current = nextWaiting;
  }, [games, myId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 8000 : 6000);
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

  async function saveEmergencyContact(contactName: string, contactPhone: string) {
    const { error } = await supabase
      .from("emergency_contacts")
      .upsert({ player_id: myId, contact_name: contactName, contact_phone: contactPhone, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Emergency contact saved");
    await loadEmergencyContacts();
  }

  async function saveBirthday(dateOfBirth: string) {
    const { error } = await supabase.from("player_birthdays").upsert({ player_id: myId, date_of_birth: dateOfBirth, updated_at: new Date().toISOString() });
    if (error) return notifyError(error.message);
    notifySuccess("Date of birth saved");
    await loadBirthdays();
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

  async function markAllMessagesRead() {
    const { error } = await supabase
      .from("admin_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", myId)
      .is("read_at", null);
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
    if (data && !data.waiting) {
      pushNotify("notify-last-spot", { gameId });
      if (motionOk()) setTicketShow({ mode: "booked", gameIds: [gameId] });
    }
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
    const gotSpots = (data ?? []).filter((d) => !d.waiting).map((d) => d.game_id);
    if (gotSpots.length > 0 && motionOk()) setTicketShow({ mode: "booked", gameIds: gotSpots });
    else notifySuccess(`Booked into ${gameIds.length} game${gameIds.length === 1 ? "" : "s"}`);
  }
  function motionOk() {
    return typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    const before = games.flatMap((g) => g.bookings).find((b) => b.id === bookingId);
    if (status === "confirmed") selfConfirmedRef.current.add(bookingId);
    const { error } = await supabase.from("bookings").update(patch).eq("id", bookingId);
    if (error) return notifyError(error.message);
    // No "are you sure?" on confirming - one tap, with Undo for a slip.
    if (status === "confirmed" && before && before.status !== "confirmed") {
      const prev = before.status;
      setToast({
        kind: "success",
        text: `${before.player.display_name} marked paid`,
        undo: async () => {
          setToast(null);
          const { error: undoErr } = await supabase.from("bookings").update({ status: prev, confirmed_by: null, confirmed_at: null }).eq("id", bookingId);
          if (undoErr) notifyError(undoErr.message);
        },
      });
    }
  }

  // Everyone who says they've paid, confirmed in one go (with one Undo).
  async function confirmPayments(bookingIds: string[]) {
    const befores = games.flatMap((g) => g.bookings).filter((b) => bookingIds.includes(b.id) && b.status !== "confirmed");
    if (befores.length === 0) return;
    befores.forEach((b) => selfConfirmedRef.current.add(b.id));
    const { error } = await supabase
      .from("bookings")
      .update({ status: "confirmed", confirmed_by: myId, confirmed_at: new Date().toISOString() })
      .in("id", befores.map((b) => b.id));
    if (error) return notifyError(error.message);
    setToast({
      kind: "success",
      text: `${befores.length} payment${befores.length === 1 ? "" : "s"} confirmed`,
      undo: async () => {
        setToast(null);
        const results = await Promise.all(
          befores.map((b) => supabase.from("bookings").update({ status: b.status, confirmed_by: null, confirmed_at: null }).eq("id", b.id))
        );
        const failed = results.find((r) => r.error);
        if (failed?.error) notifyError(failed.error.message);
      },
    });
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
  // From the fixture sheet: one or more new fixtures, as drafts or posted.
  // Posting sets published_at, which the frequent cron uses to announce
  // them (one digest push for a batch), same as confirming a draft.
  async function createFixtures(rows: { date: string; kickoff: string; venue: string; pitch: string; price: number; max_players: number; pitch_cost: number; special?: boolean }[], post: boolean) {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("games").insert(
      rows.map((r) => ({ ...r, venue: r.venue.trim(), special: !!r.special, published: post, ...(post ? { published_at: now } : {}) }))
    );
    if (error) return notifyError(error.message);
    await loadGames();
    setFixtureSheet(null);
    if (post) for (const r of rows) logAction("Posted fixture", `${r.venue} — ${fmtDate(r.date)}`);
    notifySuccess(`${rows.length} fixture${rows.length === 1 ? "" : "s"} ${post ? "posted" : "saved as draft" + (rows.length === 1 ? "" : "s")}`);
  }
  async function saveFixture(id: string, patch: { date: string; kickoff: string; venue: string; pitch: string; price: number; max_players: number; pitch_cost: number; special?: boolean }, post: boolean) {
    const clean = { ...patch, venue: patch.venue.trim(), special: !!patch.special };
    if (post) {
      await saveGame(id, clean as Partial<GameRow>);
    } else {
      const { error } = await supabase.from("games").update(clean).eq("id", id);
      if (error) return notifyError(error.message);
      await loadGames();
      notifySuccess("Draft saved");
    }
    setFixtureSheet(null);
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
      // A new pick clears the "Why?" tag, which was about the old one.
      .upsert({ game_id: gameId, voter_id: myId, candidate_id: candidateId, tag: null }, { onConflict: "game_id,voter_id" });
    if (error) return notifyError(error.message);
    await Promise.all([loadMotmVotes(), loadBallotCount(gameId)]);
    void candidateName;
    setJustVoted((cur) => ({ gameId, candidateId, n: (cur?.n ?? 0) + 1 }));
  }
  async function setMotmVoteTag(gameId: string, tag: string | null) {
    setMotmVotes((cur) => cur.map((v) => (v.game_id === gameId && v.voter_id === myId ? { ...v, tag } : v)));
    const { error } = await supabase.from("motm_votes").update({ tag }).eq("game_id", gameId).eq("voter_id", myId);
    if (error) notifyError(error.message);
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
  // One confirm and one write for a folded group of feed items, rather
  // than looping the single-item version and toasting once per item.
  async function hideFeedItems(itemKeys: string[]) {
    const { error } = await supabase.from("feed_hidden_items").insert(itemKeys.map((item_key) => ({ item_key, hidden_by: myId })));
    if (error) return notifyError(error.message);
    notifySuccess(`Archived ${itemKeys.length} — find them again under "Show archived"`);
    await loadHiddenFeedItems();
  }
  async function unhideFeedItem(itemKey: string) {
    const { error } = await supabase.from("feed_hidden_items").delete().eq("item_key", itemKey);
    if (error) return notifyError(error.message);
    notifySuccess("Restored to the feed");
    await loadHiddenFeedItems();
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
    const winnerIds = motmWinnerIdsByGame[game.id] ?? [];
    const motmWinner =
      !motmVotingOpen(game) && winnerIds.length > 0
        ? winnerIds.map((id) => game.bookings.find((b) => b.player_id === id)?.player.display_name ?? "").filter(Boolean).join(" & ")
        : null;

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

  async function sharePlayerOfMonth() {
    if (!playerOfMonth) return;
    try {
      const blob = await drawPlayerOfMonthCard({ monthLabel: playerOfMonth.monthLabel, names: playerOfMonth.names });
      const file = new File([blob], `player-of-the-month-${playerOfMonth.monthLabel.replace(/\s+/g, "-")}.png`, { type: "image/png" });

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
  // Member approval: the switch, and letting a waiting member in or not.
  async function setRequireApproval(on: boolean) {
    if (on && !(await askConfirm("Approve new members?", "New sign-ups will wait in a waiting room until an admin lets them in. Everyone already in isn't affected.", "Turn on"))) return;
    await saveClubSettings({ require_approval: on });
    await logAction(on ? "Turned on member approval" : "Turned off member approval", "");
  }

  async function decideMember(m: PendingMember, action: "approve" | "decline") {
    if (action === "decline" && !(await askConfirm(`Decline ${m.display_name}?`, "They'll see a \"Not this time\" screen. You can still let them in later from here.", "Decline", true))) return;
    const token = await getFreshAccessToken();
    const res = await fetch("/api/admin/member-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ playerId: m.id, action }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return notifyError(body.error ?? "Couldn't update them");
    if (action === "approve") {
      setJustLetIn((cur) => [{ id: m.id, name: m.display_name, mobile: body.mobile ?? null }, ...cur.filter((j) => j.id !== m.id)]);
      setToast({ kind: "success", text: `${m.display_name.split(" ")[0]} is in` });
    } else setToast({ kind: "success", text: `${m.display_name.split(" ")[0]} declined` });
    await loadProfiles();
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
  // "1:00am" and "3h 15m" for a game's MOTM deadline, both from the same
  // pretend-UTC frame as nowUk.
  function motmClosesLabel(g: GameRow) {
    const [h, m] = kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES).slice(11).split(":").map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  }
  function motmTimeLeft(g: GameRow) {
    const min = Math.max(0, Math.floor((toMs(kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES)) - toMs(nowUk)) / 60000));
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
  }
  // Only the people who played can vote (the database enforces the same).
  function playedIn(g: GameRow, playerId: string) {
    return g.bookings.some((b) => b.player_id === playerId && !b.waiting);
  }
  // Straight to a game's card in Scores, opened.
  function goToResult(gameId: string) {
    setTab("results");
    setResultsMonth("all");
    setExpandedResultId(gameId);
    setResultsView("fixtures");
    setTimeout(() => document.getElementById("result-" + gameId)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
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
  // Each game's Man of the Match under the club's rule (lib/motm.ts): most
  // votes, a tie goes to more goals that game, still level is joint.
  // Only read once voting's closed, same as the tally.
  const motmWinnerIdsByGame = useMemo(() => {
    const goalsIn = goalsLookup(goalRows);
    const map: Record<string, string[]> = {};
    for (const [gameId, tally] of Object.entries(motmTallyByGame)) map[gameId] = motmWinners(tally, goalsIn(gameId));
    return map;
  }, [motmTallyByGame, goalRows]);
  // Your own Man of the Match moment: a game whose vote closed in the last
  // 3 days that you won, not yet shown on this phone. Marked shown as soon
  // as it's picked, so it only ever appears once.
  const [motmMomentShown] = useState<Set<string>>(() => new Set());
  const myMotmMoment = useMemo(() => {
    for (const g of pastGames) {
      if (g.team_white_score == null || g.team_red_score == null) continue;
      if (kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk) continue;
      if (kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES + 3 * 24 * 60) <= nowUk) continue;
      const ids = motmWinnerIdsByGame[g.id] ?? [];
      if (!ids.includes(myId)) continue;
      const key = `wcf-motm-moment-${myId}-${g.id}`;
      if (!motmMomentShown.has(g.id)) {
        try {
          if (localStorage.getItem(key)) continue;
          localStorage.setItem(key, "1");
        } catch {
          continue;
        }
        motmMomentShown.add(g.id);
      }
      const tally = motmTallyByGame[g.id] ?? {};
      return {
        game: g,
        votes: tally[myId] ?? 0,
        total: Object.values(tally).reduce((a, b) => a + b, 0),
        goals: goalRows.filter((r) => r.game_id === g.id && r.player_id === myId).reduce((a, r) => a + r.goals, 0),
        joint: ids.length > 1,
      };
    }
    return null;
  }, [pastGames, motmWinnerIdsByGame, motmTallyByGame, goalRows, myId, nowUk, motmMomentShown]);

  const potLedger = useMemo(() => {
    // Only games that have been played. Counting a future game as soon as
    // anyone paid early booked its whole pitch hire against the pot straight
    // away (five early payers = +£25 against −£55), so the total dipped
    // every time people paid ahead. Games with no confirmed payments are
    // still left out.
    const autoEntries = pastGames
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
          paid: confirmedPaid,
        };
      });
    const manualEntries = potEntries.map((e) => ({
      id: e.id,
      category: e.category,
      date: e.created_at.slice(0, 10),
      amount: e.amount,
      description: e.description,
      kind: "manual" as const,
      paid: 0,
    }));
    return [...autoEntries, ...manualEntries].sort((a, b) => b.date.localeCompare(a.date));
  }, [pastGames, potEntries]);
  const potTotal = useMemo(() => potLedger.reduce((sum, e) => sum + e.amount, 0), [potLedger]);

  // Income/expenses computed from source data (games, manual entries)
  // rather than potLedger's already-netted auto entries - a game's net
  // +£30 hides that it was actually £110 in vs £80 pitch cost, and this
  // view is specifically about showing those two sides separately.
  const financeSummary = useMemo(() => {
    let grossIncome = 0;
    let pitchExpense = 0;
    for (const g of pastGames) {
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
  }, [pastGames, potEntries, potLedger]);

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
  // (results, joiners, the pot) rather than its own write path - only MOTM
  // votes are genuinely new here, so most of this list is derived, not
  // stored. (Clips used to live here too; the Boot Room replaced them.)
  const feedItems = useMemo(() => {
    const items: FeedItem[] = [];

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
        text: (() => {
          // A proper result card, in the same style as the Scores rows: who
          // won, the score in team colours, and who scored.
          const w = g.team_white_score;
          const r = g.team_red_score;
          const outcome = w > r ? "white" : r > w ? "red" : "draw";
          const scorers = goalRows
            .filter((row) => row.game_id === g.id && row.goals > 0)
            .sort((a, b) => b.goals - a.goals || a.player.display_name.localeCompare(b.player.display_name));
          return (
            <div className="wcf-ft">
              <div className="wcf-ft-head">
                <span className="wcf-ft-label">Full time</span>
                <span
                  className={"wcf-res-pill " + outcome}
                  style={outcome === "white" ? { background: cs.team_white_color } : outcome === "red" ? { background: cs.team_red_color } : undefined}
                >
                  {outcome === "draw" ? "Draw" : `${outcome === "white" ? cs.team_white_name : cs.team_red_name} win`}
                </span>
              </div>
              <div className="wcf-ft-score">
                <span className="wcf-ft-team">{cs.team_white_name}</span>
                <FlapNum itemKey={`game-${g.id}-fulltime`} value={w} color={cs.team_white_color} />
                <span className="wcf-ft-dash">–</span>
                <FlapNum itemKey={`game-${g.id}-fulltime`} value={r} color={cs.team_red_color} />
                <span className="wcf-ft-team">{cs.team_red_name}</span>
              </div>
              {scorers.length > 0 && (
                <div className="wcf-ft-scorers">
                  {scorers.slice(0, 4).map((row) => `${row.player.display_name} ${row.goals}`).join(" · ")}
                  {scorers.length > 4 ? ` +${scorers.length - 4} more` : ""}
                </div>
              )}
              {motmVotingOpen(g) && playedIn(g, myId) && (
                <button className="wcf-ft-vote" onClick={() => goToResult(g.id)}>
                  {myMotmVoteByGame[g.id] ? "Change your Man of the Match vote" : "Vote for Man of the Match"}
                  <span>closes {motmClosesLabel(g)}</span>
                </button>
              )}
            </div>
          );
        })(),
      });

      if (!motmVotingOpen(g)) {
        const tally = motmTallyByGame[g.id] ?? {};
        const winnerIds = motmWinnerIdsByGame[g.id] ?? [];
        const topVotes = winnerIds.length ? tally[winnerIds[0]] ?? 0 : 0;
        const winners = winnerIds
          .map((id) => g.bookings.find((b) => b.player_id === id)?.player)
          .filter((p): p is Profile => !!p);
        if (winners.length > 0) {
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
            // "was voted", not "voted" - the old wording read as if the
            // winner had cast a vote. Vote count and the game for context.
            text: (
              <>
                <strong>{winners.map((w) => w.display_name).join(" & ")}</strong> {winners.length > 1 ? "were" : "was"} voted Man of the Match
                <div className="wcf-motm-post-meta">
                  <b>{topVotes} {topVotes === 1 ? "vote" : "votes"}</b> · {cs.team_white_name} {g.team_white_score}–{g.team_red_score} {cs.team_red_name}
                </div>
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
              Community pot passed <strong>£<PotCount itemKey={`pot-${t}`} value={t} /></strong>
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
        group: "join",
        groupLabel: p.display_name,
      });
    }

    // Hat-tricks and club records, walked game by game through each season
    // (records reset each calendar-year season, like the Records tab). A
    // record only counts as "broken" once there was one to beat - the first
    // game of a season sets the marks without a post. A hat-trick that also
    // sets the goals record is one post, not two. Sits just after that
    // game's Full time post. Feed only - never a notification.
    {
      const trophy = (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" />
          <path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" />
        </svg>
      );
      const chron = [...pastGames]
        .filter((g) => g.team_white_score != null && g.team_red_score != null)
        .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
      let season = "";
      let best = { goals: 0, margin: 0, total: 0, seen: false };
      for (const g of chron) {
        if (g.date.slice(0, 4) !== season) {
          season = g.date.slice(0, 4);
          best = { goals: 0, margin: 0, total: 0, seen: false };
        }
        const ts = toMs(kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES)) + 1;
        const w = g.team_white_score!;
        const r = g.team_red_score!;
        const rows = goalRows.filter((row) => row.game_id === g.id && row.goals > 0).sort((a, b) => b.goals - a.goals);
        const topGoals = rows[0]?.goals ?? 0;
        const margin = Math.abs(w - r);
        // Minimum bars, so an early-season "record" that only beat one
        // quiet game doesn't count: a goals record needs a hat-trick, a
        // biggest win a 5-goal margin, a goal-fest 10+ goals.
        const goalsRecord = best.seen && topGoals > best.goals && topGoals >= 3;
        const lines: React.ReactNode[] = [];
        let isRecord = false;
        for (const row of rows) {
          const name = row.player.display_name;
          if (goalsRecord && row.goals === topGoals) {
            isRecord = true;
            lines.push(<><strong>{name}</strong> scored {row.goals}, the most in a game this season.</>);
          } else if (row.goals >= 3) {
            lines.push(<>Hat-trick for <strong>{name}</strong> ({row.goals}).</>);
          }
        }
        if (best.seen && margin > best.margin && margin >= 5) {
          isRecord = true;
          lines.push(<>Biggest win of the season: <strong>{w > r ? cs.team_white_name : cs.team_red_name} by {margin}</strong>.</>);
        }
        if (best.seen && w + r > best.total && w + r >= 10) {
          isRecord = true;
          lines.push(<>Most goals in a game this season: <strong>{w + r}</strong>.</>);
        }
        if (lines.length > 0) {
          items.push({
            key: `records-${g.id}`,
            ts,
            kind: "derived",
            icon: trophy,
            tone: "amber",
            text: (
              <div className="wcf-rec-post">
                <span className="wcf-rec-post-tag">{isRecord ? "New club record" : lines.length > 1 ? "Hat-tricks" : "Hat-trick"}</span>
                <span className="wcf-rec-post-score">{cs.team_white_name} {w}–{r} {cs.team_red_name}</span>
                {lines.map((l, i) => <div key={i} className="wcf-rec-post-line">{l}</div>)}
              </div>
            ),
          });
        }
        best = { goals: Math.max(best.goals, topGoals), margin: Math.max(best.margin, margin), total: Math.max(best.total, w + r), seen: true };
      }
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
            group: "apps",
            groupLabel: `${b.player.display_name} (${count})`,
          });
        }
      }
    }

    return items.sort((a, b) => b.ts - a.ts);
  }, [games, pastGames, motmTallyByGame, motmWinnerIdsByGame, myMotmVoteByGame, myId, potLedger, profiles, goalRows, cs.team_white_name, cs.team_red_name, cs.team_white_color, cs.team_red_color, nowUk]);

  const visibleFeedItems = useMemo(() => {
    // In the normal feed view, archived items are hidden. The "Show
    // archived" toggle (admin-only) flips to showing *only* the archived
    // ones, so they can be reviewed and restored rather than lost.
    return feedItems.filter((item) => showArchived === hiddenFeedKeys.includes(item.key));
  }, [feedItems, hiddenFeedKeys, showArchived]);

  const feedReactionTally = useMemo(() => {
    const map: Record<string, Record<string, number>> = {};
    for (const r of feedReactions) {
      map[r.item_key] ??= {};
      map[r.item_key][r.emoji] = (map[r.item_key][r.emoji] ?? 0) + 1;
    }
    return map;
  }, [feedReactions]);

  // Player of the Month: computed, not stored - whoever won MOTM the most
  // times in the last fully-completed calendar month, tie-broken first by
  // total votes received that month, then by goals scored that month if
  // still tied after that. Needs at least 2 voted games that month to
  // mean anything, and only reveals once the month's over (not a
  // mid-month leaderboard that flips around), staying up for the whole
  // next month.
  const playerOfMonth = useMemo(() => {
    // Announced as soon as the month's last published game is played and its
    // vote has closed (same rule as Wrapped), not on the 1st - otherwise
    // last month's.
    const thisKey = nowUk.slice(0, 7);
    const thisMonthGames = games.filter((g) => g.published && g.date.startsWith(thisKey));
    const lastOfMonth = [...thisMonthGames].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)).at(-1);
    const thisMonthFinished =
      thisMonthGames.length > 0 &&
      thisMonthGames.every((g) => g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g)) &&
      nowUk >= monthReleaseAt(lastOfMonth!.date, lastOfMonth!.kickoff);
    const monthKey = thisMonthFinished ? thisKey : previousMonthKey(nowUk);
    const monthGames = pastGames.filter(
      (g) => g.date.startsWith(monthKey) && g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g)
    );
    if (monthGames.length < 2) return null;

    const wins: Record<string, number> = {};
    const votes: Record<string, number> = {};
    const goals: Record<string, number> = {};
    const names: Record<string, string> = {};

    const monthGameIds = new Set(monthGames.map((g) => g.id));
    for (const r of goalRows) {
      if (!monthGameIds.has(r.game_id)) continue;
      goals[r.player_id] = (goals[r.player_id] ?? 0) + r.goals;
    }

    for (const g of monthGames) {
      const tally = motmTallyByGame[g.id] ?? {};
      const gameWinners = motmWinnerIdsByGame[g.id] ?? [];
      for (const [playerId, count] of Object.entries(tally)) {
        votes[playerId] = (votes[playerId] ?? 0) + count;
        names[playerId] ??= g.bookings.find((b) => b.player_id === playerId)?.player.display_name ?? "";
        if (gameWinners.includes(playerId)) wins[playerId] = (wins[playerId] ?? 0) + 1;
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
    if (leaders.length > 1) {
      const maxGoals = Math.max(...leaders.map((id) => goals[id] ?? 0));
      leaders = leaders.filter((id) => (goals[id] ?? 0) === maxGoals);
    }

    return {
      monthKey,
      monthLabel: new Date(monthKey + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      names: leaders.map((id) => names[id]).filter(Boolean),
      // For the card: why they won.
      winners: leaders.map((id) => ({ id, name: names[id], wins: wins[id] ?? 0, votes: votes[id] ?? 0, goals: goals[id] ?? 0 })),
    };
  }, [games, pastGames, motmTallyByGame, motmWinnerIdsByGame, goalRows, nowUk]);

  // PAID tickets: bookings of yours on upcoming games that have become
  // confirmed since this phone last looked. The first run on a phone just
  // records what's already confirmed, so nobody gets a stack of old ones.
  useEffect(() => {
    if (loading || !myId || games.length === 0 || ticketShow) return;
    const key = `wcf-paid-seen-${myId}`;
    const mine = games
      .filter((g) => kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) > nowUk)
      .flatMap((g) => g.bookings.filter((b) => b.player_id === myId && !b.waiting && b.status === "confirmed").map((b) => ({ id: b.id, gameId: g.id })));
    let seen: string[] | null = null;
    try {
      const raw = localStorage.getItem(key);
      seen = raw ? JSON.parse(raw) : null;
    } catch {
      return;
    }
    const save = (ids: string[]) => {
      try {
        localStorage.setItem(key, JSON.stringify(ids));
      } catch {}
    };
    if (!seen) return save(mine.map((m) => m.id));
    const fresh = mine.filter((m) => !seen!.includes(m.id));
    save(mine.map((m) => m.id));
    if (fresh.length > 0 && motionOk()) setTicketShow({ mode: "paid", gameIds: fresh.map((m) => m.gameId) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, loading, myId]);
  // Birthday games (made free by an admin) and newly published special
  // fixtures: same "since this phone last looked" rule, first run records.
  useEffect(() => {
    if (loading || !myId || games.length === 0 || ticketShow || specialShow) return;
    const upcoming = games.filter((g) => g.published && kickoffCutoff(g.date, g.kickoff, 0) > nowUk);
    const seenList = (key: string, ids: string[]) => {
      try {
        const raw = localStorage.getItem(key);
        localStorage.setItem(key, JSON.stringify(ids));
        return raw ? (JSON.parse(raw) as string[]) : null;
      } catch {
        return [] as string[] | null;
      }
    };
    const bdays = upcoming.flatMap((g) => g.bookings.filter((b) => b.player_id === myId && !b.waiting && (b.pot_exempt_reason as string) === "birthday").map((b) => ({ id: b.id, gameId: g.id })));
    const bSeen = seenList(`wcf-bday-seen-${myId}`, bdays.map((b) => b.id));
    const specials = upcoming.filter((g) => g.special).map((g) => g.id);
    const sSeen = seenList(`wcf-special-seen-${myId}`, specials);
    if (!motionOk()) return;
    const freshB = bSeen ? bdays.find((b) => !bSeen.includes(b.id)) : undefined;
    if (freshB) return setTicketShow({ mode: "birthday", gameIds: [freshB.gameId] });
    const freshS = sSeen ? specials.find((id) => !sSeen.includes(id)) : undefined;
    if (freshS) setSpecialShow(freshS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, loading, myId]);
  const specialGame = specialShow ? games.find((g) => g.id === specialShow) ?? null : null;
  function specialDone(id: string) {
    setSpecialShow(null);
    setTab("fixtures");
    setTimeout(() => {
      const el = document.getElementById("fx-" + id);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("wcf-row-flash");
      void el.offsetWidth;
      el.classList.add("wcf-row-flash");
    }, 120);
  }

  // New fixtures since this phone last opened Fixtures (first run records).
  // A run of 2+ (not specials, which get the poster) brings up the calendar.
  // The NEW pill stays until you book it or for 3 days.
  useEffect(() => {
    if (tab !== "fixtures") {
      if (fxChip) setFxChip(0);
      return;
    }
    if (loading || !myId || games.length === 0) return;
    const upcoming = games.filter((g) => g.published && kickoffCutoff(g.date, g.kickoff, 0) > nowUk);
    const seenKey = `wcf-fx-seen-${myId}`;
    const newKey = `wcf-fx-newlist-${myId}`;
    let seen: string[] | null = null;
    let store: Record<string, number> = {};
    try {
      const raw = localStorage.getItem(seenKey);
      seen = raw ? JSON.parse(raw) : null;
      store = JSON.parse(localStorage.getItem(newKey) || "{}");
      localStorage.setItem(seenKey, JSON.stringify(upcoming.map((g) => g.id)));
    } catch {
      return;
    }
    const fresh = seen ? upcoming.filter((g) => !seen!.includes(g.id) && !g.special) : [];
    const now = Date.now();
    for (const g of fresh) store[g.id] = now;
    for (const id of Object.keys(store)) if (now - store[id] > 3 * 86400000 || !upcoming.some((g) => g.id === id)) delete store[id];
    try {
      localStorage.setItem(newKey, JSON.stringify(store));
    } catch {}
    setFxNewStore(store);
    if (fresh.length >= 2 && motionOk()) {
      const byMonth: Record<string, string[]> = {};
      for (const g of fresh) (byMonth[g.date.slice(0, 7)] ??= []).push(g.date);
      const month = Object.keys(byMonth).sort((a, b) => byMonth[b].length - byMonth[a].length || a.localeCompare(b))[0];
      setFxCalendar({ month, dates: [...new Set(byMonth[month])].sort(), ids: fresh.map((g) => g.id) });
    } else if (fresh.length) {
      setFxChip(fresh.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, games, loading, myId]);
  const fxNewIds = useMemo(
    () => new Set(Object.keys(fxNewStore).filter((id) => !games.find((g) => g.id === id)?.bookings.some((b) => b.player_id === myId))),
    [fxNewStore, games, myId]
  );
  function fxCalendarDone() {
    if (!fxCalendar) return;
    const ids = fxCalendar.ids;
    setFxCalendar(null);
    setFxChip(ids.length);
    setFxCascade(ids);
    const firstId = [...ids].sort((a, b) => (games.find((g) => g.id === a)?.date ?? "").localeCompare(games.find((g) => g.id === b)?.date ?? ""))[0];
    if (firstId && games.find((g) => g.id === firstId) && !upcomingGames.slice(0, 1).some((g) => g.id === firstId)) {
      const g = games.find((x) => x.id === firstId)!;
      const cut = new Date(nowUk.slice(0, 10) + "T00:00:00Z");
      cut.setUTCDate(cut.getUTCDate() + 28);
      if (g.date > cut.toISOString().slice(0, 10)) setShowLaterFixtures(true);
    }
    setTimeout(() => document.getElementById("fx-" + firstId)?.scrollIntoView({ block: "center", behavior: "smooth" }), 150);
    setTimeout(() => setFxCascade([]), 3500);
  }

  // Your prediction, padlocked: the first open after kickoff (within 3
  // hours) on a game you predicted. Only ever your own guess.
  const predLock = useMemo(() => {
    if (!myId) return null;
    for (const p of scorePredictions) {
      if (p.player_id !== myId) continue;
      const g = games.find((x) => x.id === p.game_id);
      if (!g || g.team_white_score != null) continue;
      if (kickoffCutoff(g.date, g.kickoff, 0) > nowUk || kickoffCutoff(g.date, g.kickoff, 180) <= nowUk) continue;
      const key = `wcf-predlock-${myId}-${g.id}`;
      try {
        if (localStorage.getItem(key)) continue;
      } catch {
        continue;
      }
      return { key, gameId: g.id, value: `${cs.team_red_name} ${p.predicted_red}–${p.predicted_white} ${cs.team_white_name}` };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scorePredictions, games, myId, nowUk, predLockShown]);

  // A message from an admin (a real sender, never the automated ones),
  // unread and not yet shown as an envelope on this phone.
  useEffect(() => {
    if (loading || !myId || envelope) return;
    const key = `wcf-env-seen-${myId}`;
    const manual = myUnreadMessages.filter((m) => m.sender_id);
    let seen: string[] | null = null;
    try {
      const raw = localStorage.getItem(key);
      seen = raw ? JSON.parse(raw) : null;
      if (!seen) localStorage.setItem(key, JSON.stringify(manual.map((m) => m.id)));
    } catch {
      return;
    }
    if (!seen || !motionOk()) return;
    const fresh = manual.filter((m) => !seen!.includes(m.id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!fresh.length) return;
    try {
      localStorage.setItem(key, JSON.stringify([...seen, ...fresh.map((m) => m.id)].slice(-200)));
    } catch {}
    setEnvelope({
      ids: fresh.map((m) => m.id),
      items: fresh.map((m) => ({
        from: profiles.find((p) => p.id === m.sender_id)?.display_name ?? "The admins",
        text: m.message,
        when: new Date(m.created_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUnreadMessages, loading, myId]);

  const ticketGames = useMemo<TicketGame[]>(() => {
    if (!ticketShow) return [];
    return ticketShow.gameIds.flatMap((id) => {
      const g = games.find((x) => x.id === id);
      if (!g) return [];
      const playing = g.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const mine = playing.find((b) => b.player_id === myId);
      const at = mine ? playing.indexOf(mine) + 1 : playing.length;
      const side = mine?.team === "white" ? cs.team_white_name : mine?.team === "red" ? cs.team_red_name : "Picked on the day";
      return [{ id: g.id, date: g.date, kickoff: g.kickoff, venue: g.venue, spot: `${at} of ${g.max_players}`, side }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketShow]);

  // Player of the Month night: once per month per phone, within a week of
  // the 1st, the first time the winner's out. Under Reduce Motion it's
  // skipped and the card just shows, as before.
  useEffect(() => {
    if (loading || !playerOfMonth || potmShow || !myId) return;
    if (kickoffCutoff(nextMonthStart(playerOfMonth.monthKey), "08:00", 7 * 24 * 60) <= nowUk) return;
    const key = `wcf-potm-intro-${myId}-${playerOfMonth.monthKey}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    if (!motionOk()) return;
    setPotmShow(playerOfMonth.winners.some((w) => w.id === myId) ? "winner" : "everyone");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerOfMonth?.monthKey, loading, myId]);
  function potmDone() {
    setPotmShow(null);
    setTab("results");
    setResultsView("season");
    setPotmLand(true);
    setTimeout(() => setPotmLand(false), 2500);
  }

  // Monthly Wrapped: your own story of last month, same "last completed
  // month" window as Player of the Month above, and computed the same way
  // - from rows already loaded, nothing stored. Admins-only while testing
  // until WRAPPED_OPEN_TO_ALL_FROM. The month before feeds the "vs July"
  // comparisons; everything earlier only decides who's new to your circle.
  // Admins testing it (WRAPPED_ADMIN_PREVIEW_MONTH_SO_FAR) get the month in
  // progress instead, so there's something real to check before it ends.
  const wrappedOpenToAll = nowUk.slice(0, 10) >= WRAPPED_OPEN_TO_ALL_FROM;
  const wrappedSoFar = isAdmin && WRAPPED_ADMIN_PREVIEW_MONTH_SO_FAR && !wrappedOpenToAll;
  // A month's Wrapped appears the moment its last game is played, scored
  // and its MOTM vote has closed - not on the 1st - so September's goes
  // live once Monday 28th's result is in. Until then it's last month's.
  const thisMonthKey = nowUk.slice(0, 7);
  const thisMonthDone = useMemo(() => {
    const month = games.filter((g) => g.published && g.date.startsWith(thisMonthKey));
    const last = [...month].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)).at(-1);
    // Released at 8am the morning after the last vote closes (lib/time.ts).
    return (
      month.length > 0 &&
      month.every(
        (g) => kickoffCutoff(g.date, g.kickoff, MATCH_DURATION_MINUTES) <= nowUk && g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g)
      ) &&
      nowUk >= monthReleaseAt(last!.date, last!.kickoff)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, thisMonthKey, nowUk]);
  const wrappedMonthKey = wrappedSoFar || thisMonthDone ? thisMonthKey : previousMonthKey(nowUk);
  const wrapped = useMemo(() => {
    const scored = pastGames.filter((g) => g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g));
    const before = previousMonthKey(wrappedMonthKey + "-15");
    const base = { playerId: myId, goals: goalRows, motmTallyByGame, predictions: scorePredictions };
    const monthGames = scored.filter((g) => g.date.startsWith(wrappedMonthKey));
    const data = computeWrapped({
      ...base,
      games: monthGames,
      earlierGames: scored.filter((g) => g.date < wrappedMonthKey),
    });
    if (!data) return null;
    const prevData = computeWrapped({ ...base, games: scored.filter((g) => g.date.startsWith(before)) });
    const label = (key: string, opts: Intl.DateTimeFormatOptions) => new Date(key + "-01T12:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
    const nameById = new Map(profiles.map((p) => [p.id, p.display_name]));
    const records = computeRecords({ games: monthGames, goals: goalRows, motmTallyByGame, names: (id) => nameById.get(id) ?? "Former player" });
    return {
      data,
      records,
      prev: prevData ? { apps: prevData.apps, goals: prevData.goals, myRate: prevData.myRate } : null,
      periodKey: wrappedMonthKey,
      soFar: wrappedSoFar,
      periodLabel: label(wrappedMonthKey, { month: "long", year: "numeric" }),
      periodShort: label(wrappedMonthKey, { month: "long" }),
      prevShort: label(before, { month: "long" }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, goalRows, motmTallyByGame, motmWinnerIdsByGame, scorePredictions, profiles, myId, wrappedMonthKey, wrappedSoFar]);
  // The Wrapped cards that need more than the rows already loaded: the
  // "Why?" tags on your MOTM votes (from motmVotes), and the squad's ratings
  // and kickoff weather for your games (fetched once the month is known).
  const wrappedMyGames = useMemo(() => {
    if (!wrapped) return [];
    return pastGames
      .filter((g) => g.date.startsWith(wrapped.periodKey) && g.team_white_score != null && g.team_red_score != null && !motmVotingOpen(g))
      .flatMap((g) => {
        const b = g.bookings.find((x) => x.player_id === myId && !x.waiting && x.team);
        if (!b) return [];
        const team = b.team as "white" | "red";
        const us = (team === "white" ? g.team_white_score : g.team_red_score) ?? 0;
        const them = (team === "white" ? g.team_red_score : g.team_white_score) ?? 0;
        return [{ id: g.id, date: g.date, team, us, them, result: (us === them ? "D" : us > them ? "W" : "L") as "W" | "D" | "L" }];
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapped?.periodKey, pastGames, myId]);
  const wrappedTags = useMemo(() => {
    const ids = new Set(wrappedMyGames.map((g) => g.id));
    const count: Record<string, number> = {};
    for (const v of motmVotes) if (v.candidate_id === myId && v.tag && ids.has(v.game_id)) count[v.tag] = (count[v.tag] ?? 0) + 1;
    return Object.entries(count).map(([tag, n]) => ({ tag, count: n })).sort((a, b) => b.count - a.count);
  }, [wrappedMyGames, motmVotes, myId]);
  const [wrappedFetched, setWrappedFetched] = useState<{ key: string; rated: WrappedExtras["rated"]; weather: WrappedExtras["weather"] } | null>(null);
  const wrappedGamesKey = wrappedMyGames.map((g) => g.id).join(",");
  useEffect(() => {
    if (!wrapped || !wrappedMyGames.length) return;
    let cancelled = false;
    (async () => {
      const ids = wrappedMyGames.map((g) => g.id);
      const [{ data: wx }, sums] = await Promise.all([
        supabase.from("game_weather").select("game_id, temp_c, weather_code").in("game_id", ids),
        Promise.all(ids.map((id) => supabase.rpc("game_rating_summary", { p_game_id: id }).then((r) => ({ id, row: (r.data as { ratings: number; average: number | null }[] | null)?.[0] })))),
      ]);
      if (cancelled) return;
      // Best-rated: at least 3 ratings, highest average, more ratings breaks a tie.
      let rated: WrappedExtras["rated"] = null;
      let bestN = 0;
      for (const s of sums) {
        const n = s.row?.ratings ?? 0;
        const avg = Number(s.row?.average ?? 0);
        if (n < 3) continue;
        if (!rated || avg > rated.average || (avg === rated.average && n > bestN)) {
          const g = wrappedMyGames.find((x) => x.id === s.id)!;
          rated = { date: g.date, team: g.team, us: g.us, them: g.them, average: avg, ratings: n };
          bestN = n;
        }
      }
      const byId = new Map((wx ?? []).map((w: { game_id: string; temp_c: number; weather_code: number }) => [w.game_id, w]));
      const weather = wrappedMyGames.flatMap((g) => {
        const w = byId.get(g.id);
        return w ? [{ date: g.date, tempC: Number(w.temp_c), code: w.weather_code, result: g.result }] : [];
      });
      setWrappedFetched({ key: wrappedGamesKey, rated, weather });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrappedGamesKey]);
  const wrappedExtras: WrappedExtras = {
    tags: wrappedTags,
    rated: wrappedFetched?.key === wrappedGamesKey ? wrappedFetched.rated : null,
    weather: wrappedFetched?.key === wrappedGamesKey ? wrappedFetched.weather : [],
  };
  const [wrappedOpen, setWrappedOpen] = useState(false);
  // The unwrap clip plays the first time each month's Wrapped is opened on
  // this phone; worked out when the story opens, so reopening skips it.
  const [wrappedIntroDue, setWrappedIntroDue] = useState(false);
  // Engagement: one row per person per month per event (opened / finished /
  // shared). A repeat insert just hits the unique key and is ignored, so
  // these are counts of people. Never blocks or errors the story itself.
  function trackWrapped(event: "opened" | "finished" | "shared") {
    void supabase
      .from("wrapped_events")
      .insert({ player_id: myId, month_key: wrappedMonthKey, event })
      .then(() => undefined, () => undefined);
  }
  function openWrapped() {
    trackWrapped("opened");
    let seen = false;
    try {
      seen = localStorage.getItem(`wcf-wrapped-intro-${myId}-${wrappedMonthKey}`) === "true";
    } catch {}
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    setWrappedIntroDue(!seen && !reduce);
    setWrappedOpen(true);
  }
  // The admin "so far" preview has its own key, so hiding the preview
  // doesn't also hide the finished month when it's released.
  // Named differently from the admin "so far" preview's key, so hiding the
  // preview (stored under the old name) never hides the released month.
  const wrappedDismissKey = wrappedSoFar
    ? `wcf-wrapped-dismissed-${myId}-${wrappedMonthKey}`
    : `wcf-wrapped-hidden-${myId}-${wrappedMonthKey}`;
  const [wrappedDismissed, setWrappedDismissed] = useState(true);
  useEffect(() => {
    try {
      setWrappedDismissed(localStorage.getItem(wrappedDismissKey) === "true");
    } catch {
      setWrappedDismissed(false);
    }
  }, [wrappedDismissKey]);
  function dismissWrapped() {
    try {
      localStorage.setItem(wrappedDismissKey, "true");
    } catch {}
    setWrappedDismissed(true);
  }
  // Admins only differ from players while previewing the month in progress
  // before the open date; after that everyone sees the same thing (so no
  // August story once the preview ends, just nothing until September's
  // 8am release).
  const showWrappedBanner =
    !!wrapped && !wrappedDismissed && (wrappedSoFar || (wrappedOpenToAll && wrappedMonthKey >= WRAPPED_FIRST_MONTH_FOR_ALL));

  async function shareWrapped() {
    if (!wrapped) return;
    trackWrapped("shared");
    try {
      const blob = await drawWrappedCard({ data: wrapped.data, periodLabel: wrapped.periodLabel, whiteName: cs.team_white_name, redName: cs.team_red_name });
      const file = new File([blob], `wrapped-${wrapped.periodKey}.png`, { type: "image/png" });
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

  // Club records for the selected season - single-game bests, runs, MOTM,
  // the waiting list and how early games sell out. Computed like Wrapped
  // from rows already loaded (lib/records.ts). A game counts as soon as its
  // score is in (same as the Feed's record posts); only its MOTM votes wait
  // until voting closes, so MOTM records can't flicker mid-vote.
  const closedMotmTallies = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const g of pastGames) if (motmTallyByGame[g.id] && !motmVotingOpen(g)) out[g.id] = motmTallyByGame[g.id];
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, motmTallyByGame, nowUk]);
  // The same season's bests for the signed-in player, for "Your bests".
  const myBests = useMemo(
    () =>
      computePersonalBests(
        {
          games: pastGames.filter((g) => g.date.slice(0, 4) === String(activeStatsYear) && g.team_white_score != null && g.team_red_score != null),
          goals: goalRows,
          motmTallyByGame: closedMotmTallies,
          names: () => "",
        },
        myId
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pastGames, goalRows, closedMotmTallies, activeStatsYear, myId]
  );
  const clubRecords = useMemo(() => {
    const nameById = new Map(profiles.map((p) => [p.id, p.display_name]));
    return computeRecords({
      games: pastGames.filter((g) => g.date.slice(0, 4) === String(activeStatsYear) && g.team_white_score != null && g.team_red_score != null),
      goals: goalRows,
      motmTallyByGame: closedMotmTallies,
      names: (id) => nameById.get(id) ?? "Former player",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, goalRows, closedMotmTallies, profiles, activeStatsYear]);

  // A record falls: opening Records (this season) after one's been beaten
  // since this phone last looked plays the old holder being struck off.
  // The first look on a phone just records where things stand.
  const recordTeam = (w: number, rd: number) => `${cs.team_white_name} ${w}–${rd} ${cs.team_red_name}`;
  useEffect(() => {
    if (resultsView !== "records" || tab !== "results") {
      if (Object.keys(recordFalls).length) setRecordFalls({});
      return;
    }
    if (loading || !myId || activeStatsYear !== currentSeasonYear || !clubRecords.highestScoring) return;
    const key = `wcf-records-seen-${myId}-${activeStatsYear}`;
    const now = recordSnapshot(clubRecords, recordTeam);
    let before: RecordSnap | null = null;
    try {
      const raw = localStorage.getItem(key);
      before = raw ? JSON.parse(raw) : null;
      localStorage.setItem(key, JSON.stringify(now));
    } catch {
      return;
    }
    if (!before || !motionOk()) return;
    const fell: Record<string, { v: number; who: string }> = {};
    for (const [k, x] of Object.entries(now)) if (before[k] && x.v > before[k].v) fell[k] = before[k];
    if (Object.keys(fell).length) setRecordFalls(fell);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultsView, tab, loading, myId, activeStatsYear, clubRecords]);

  // Your own record: a single-game record you set in the last 3 days that
  // beat the one before it (not just equalled it), once per phone.
  const myRecordMoment = useMemo(() => {
    if (recordMomentDone || !myId) return null;
    const seasonGames = pastGames.filter((g) => g.date.slice(0, 4) === String(currentSeasonYear) && g.team_white_score != null && g.team_red_score != null);
    const nameById = new Map(profiles.map((p) => [p.id, p.display_name]));
    const rec = (games: typeof seasonGames) => computeRecords({ games, goals: goalRows, motmTallyByGame: closedMotmTallies, names: (id) => nameById.get(id) ?? "Former player" });
    const nowRec = rec(seasonGames);
    const kinds = [
      { key: "goals", cur: nowRec.mostGoalsInGame, val: (r: ClubRecords) => r.mostGoalsInGame?.goals ?? 0, who: (r: ClubRecords) => r.mostGoalsInGame?.holders ?? [], label: "goals in one game", balls: true },
      { key: "votes1", cur: nowRec.mostMotmVotesInGame, val: (r: ClubRecords) => r.mostMotmVotesInGame?.votes ?? 0, who: (r: ClubRecords) => r.mostMotmVotesInGame?.holders ?? [], label: "Man of the Match votes in one game", balls: false },
    ];
    for (const k of kinds) {
      if (!k.cur) continue;
      const mine = k.who(nowRec).find((h) => h.playerId === myId && h.date);
      if (!mine?.date || kickoffCutoff(mine.date, "00:00", 4 * 24 * 60) <= nowUk) continue;
      const prevRec = rec(seasonGames.filter((g) => g.date < mine.date!));
      const prevV = k.val(prevRec);
      if (!prevV || prevV >= k.val(nowRec)) continue;
      const seenKey = `wcf-record-moment-${myId}-${k.key}-${mine.date}`;
      try {
        if (localStorage.getItem(seenKey)) continue;
      } catch {
        continue;
      }
      const g = seasonGames.find((x) => x.date === mine.date);
      const prevWho = k.who(prevRec).map((h) => h.name).slice(0, 2).join(" & ");
      return {
        seenKey,
        value: k.val(nowRec),
        label: k.label,
        balls: k.balls,
        prev: `${prevWho}'s ${prevV}`,
        dateLabel: fmtDate(mine.date),
        scoreLine: g ? recordTeam(g.team_white_score!, g.team_red_score!) : "",
      };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, goalRows, closedMotmTallies, profiles, myId, recordMomentDone, currentSeasonYear]);
  // Off the waiting list: your bookings on upcoming games that were
  // promoted since this phone last looked. First run just records them.
  useEffect(() => {
    if (loading || !myId || games.length === 0 || promoShow) return;
    const key = `wcf-promo-seen-${myId}`;
    const mine = games
      .filter((g) => kickoffCutoff(g.date, g.kickoff, 0) > nowUk)
      .flatMap((g) => g.bookings.filter((b) => b.player_id === myId && !b.waiting && b.promoted_at).map((b) => ({ id: b.id, gameId: g.id })));
    let seen: string[] | null = null;
    try {
      const raw = localStorage.getItem(key);
      seen = raw ? JSON.parse(raw) : null;
      localStorage.setItem(key, JSON.stringify(mine.map((m) => m.id)));
    } catch {
      return;
    }
    if (!seen || !motionOk()) return;
    const fresh = mine.find((m) => !seen!.includes(m.id));
    if (fresh) setPromoShow(fresh.gameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, loading, myId]);
  const promoGame = promoShow ? games.find((g) => g.id === promoShow) ?? null : null;

  // Debut, milestone shirts and club milestones: each once per phone,
  // within 3 days of the game that made it, one at a time.
  const bigMoments = useMemo<BigMoment[]>(() => {
    if (!myId || loading) return [];
    const played = pastGames
      .filter((g) => g.team_white_score != null && g.team_red_score != null)
      .sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff));
    const recent = (g: GameRow) => kickoffCutoff(g.date, g.kickoff, 3 * 24 * 60) > nowUk;
    const seen = (k: string) => {
      try {
        return !!localStorage.getItem(k);
      } catch {
        return true;
      }
    };
    const me = profiles.find((p) => p.id === myId);
    const first = (me?.display_name ?? "").split(" ")[0] || "you";
    const back = (me?.display_name ?? "").trim().split(/\s+/).pop()?.toUpperCase() ?? "";
    const scoreLine = (g: GameRow) => `${cs.team_white_name} ${g.team_white_score}–${g.team_red_score} ${cs.team_red_name}`;
    const out: BigMoment[] = [];
    const mine = played.filter((g) => g.bookings.some((b) => b.player_id === myId && !b.waiting));
    if (mine.length >= 1 && recent(mine[0])) {
      const key = `wcf-moment-debut-${myId}`;
      if (!seen(key)) out.push({ kind: "debut", key, first, dateLabel: new Date(mine[0].date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), result: scoreLine(mine[0]) });
    }
    for (const n of [10, 25, 50, 100, 150, 200]) {
      const g = mine[n - 1];
      if (!g || !recent(g)) continue;
      const key = `wcf-moment-apps-${myId}-${n}`;
      if (!seen(key)) out.push({ kind: "apps", key, n, first, back, since: new Date(mine[0].date + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) });
    }
    let goals = 0;
    const goalMarks = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
    const gameMarks = [10, 20, 25, 50, 75, 100, 150, 200, 250, 300];
    played.forEach((g, i) => {
      const before = goals;
      goals += g.team_white_score! + g.team_red_score!;
      if (!recent(g)) return;
      for (const m of goalMarks) {
        if (before < m && goals >= m) {
          const key = `wcf-moment-club-goals-${m}`;
          if (!seen(key)) out.push({ kind: "club", key, n: m, unit: "goals", detail: `Reached in ${fmtDate(g.date)}'s game: ${scoreLine(g)}` });
        }
      }
      if (gameMarks.includes(i + 1)) {
        const key = `wcf-moment-club-games-${i + 1}`;
        if (!seen(key)) out.push({ kind: "club", key, n: i + 1, unit: "games", detail: `Game ${i + 1} was ${fmtDate(g.date)}: ${scoreLine(g)}` });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, myId, loading, profiles]);
  const nextBigMoment = motionOk() ? bigMoments.find((m) => !momentsDone.includes(m.key)) ?? null : null;
  function bigMomentDone(m: BigMoment) {
    try {
      localStorage.setItem(m.key, "1");
    } catch {}
    setMomentsDone((d) => [...d, m.key]);
  }
  // Highest appearance milestone (all time) for the player card badge.
  const appsMilestoneFor = (playerId: string) => {
    const n = pastGames.filter((g) => g.team_white_score != null && g.bookings.some((b) => b.player_id === playerId && !b.waiting)).length;
    return [200, 150, 100, 50, 25, 10].find((m) => n >= m) ?? null;
  };

  function recordMomentClose() {
    if (myRecordMoment) {
      try {
        localStorage.setItem(myRecordMoment.seenKey, "1");
      } catch {}
    }
    setRecordMomentDone(true);
    setTab("results");
    setResultsView("records");
  }

  // Birthday games: for each player with a birthday on record, the game
  // they're booked on closest to it (3 days before to 7 days after), unless
  // one in that window is already free for their birthday. Admins get a
  // one-tap "make it free" on that game, and it tops the ⋯ menu.
  const birthdaySuggest = useMemo(() => {
    const out: Record<string, string> = {};
    if (!isAdmin) return out;
    const shift = (d: string, n: number) => {
      const x = new Date(d + "T12:00:00Z");
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    const year = Number(nowUk.slice(0, 4));
    const upcomingPublished = upcomingGames.filter((g) => g.published);
    for (const b of birthdays) {
      const md = b.date_of_birth.slice(5, 10);
      for (const y of [year, year + 1]) {
        const day = md === "02-29" && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? `${y}-02-28` : `${y}-${md}`;
        const lo = shift(day, -3);
        const hi = shift(day, 7);
        const inWindow = upcomingPublished.flatMap((g) =>
          g.date >= lo && g.date <= hi ? g.bookings.filter((x) => x.player_id === b.player_id && !x.waiting).map((x) => ({ g, x })) : []
        );
        if (!inWindow.length || inWindow.some(({ x }) => (x.pot_exempt_reason as string) === "birthday")) continue;
        const dist = (d: string) => Math.abs(new Date(d + "T12:00:00Z").getTime() - new Date(day + "T12:00:00Z").getTime());
        const best = inWindow.sort((a, c) => dist(a.g.date) - dist(c.g.date))[0];
        if (best.x.pot_exempt_reason) continue;
        out[best.x.id] = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      }
    }
    return out;
  }, [isAdmin, birthdays, upcomingGames, nowUk]);

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

  // "Teams are out" walkout: the first time this phone sees the published
  // teams on the pitch (once per game, again only if the teams change), the
  // players come out of the tunnel in Red/White pairs and jog to their
  // spots, colouring in as they arrive; you come out last. Starts when the
  // pitch is properly on screen; a tap on the pitch skips it.
  const walkoutSig = useMemo(
    () => (nextGame ? `${nextGame.id}-${[...nextGrouped.red.map((b) => b.player_id)].sort().join(".")}-${[...nextGrouped.white.map((b) => b.player_id)].sort().join(".")}` : ""),
    [nextGame, nextGrouped]
  );
  useEffect(() => {
    if (tab !== "lineup" || lineupView !== "sheet" || lineupDisplayView !== "pitch" || editingLineup || editingPositions) return;
    if (!nextGame || !myId || (nextGrouped.red.length === 0 && nextGrouped.white.length === 0) || !motionOk()) return;
    const key = `wcf-walkout-${myId}-${walkoutSig.slice(0, 180)}`;
    try {
      if (localStorage.getItem(key)) return;
    } catch {
      return;
    }
    const card = pitchCardRef.current;
    if (!card) return;
    const tokens = Array.from(card.querySelectorAll<HTMLElement>(".wcf-lineup-token"));
    tokens.forEach((el) => el.classList.add("wcf-walk-pending"));
    let started = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      if (started) return;
      started = true;
      try {
        localStorage.setItem(key, "1");
      } catch {}
      card.closest(".wcf-main")?.querySelector(".wcf-lineup-head")?.classList.add("wcf-walk-stamp");
      const reds = tokens.filter((el) => el.dataset.red === "1" && el.dataset.me !== "1");
      const whites = tokens.filter((el) => el.dataset.red !== "1" && el.dataset.me !== "1");
      const me = tokens.find((el) => el.dataset.me === "1");
      const order: HTMLElement[] = [];
      for (let i = 0; i < Math.max(reds.length, whites.length); i++) {
        if (reds[i]) order.push(reds[i]);
        if (whites[i]) order.push(whites[i]);
      }
      if (me) order.push(me);
      order.forEach((el, i) => {
        const red = el.dataset.red === "1";
        const side = red ? -1 : 1;
        const a = el.animate(
          [
            { left: `${50 + side * 3}%`, top: "104%", opacity: 0 },
            { opacity: 1, offset: 0.08 },
            { left: `${50 + side * 6}%`, top: "86%", offset: 0.25 },
            { left: el.style.left, top: el.style.top, opacity: 1 },
          ],
          { duration: red ? 1250 : 950, delay: 400 + Math.floor(i / 2) * 230 + (i % 2) * 70 + (el === me ? 250 : 0), easing: "cubic-bezier(.35,.1,.25,1)", fill: "backwards" }
        );
        const land = () => {
          el.classList.remove("wcf-walk-pending");
          if (el === me) el.classList.add("wcf-walk-me");
        };
        a.onfinish = land;
        a.oncancel = land;
      });
      timers.push(setTimeout(() => card.classList.add("wcf-walk-chalk"), 400 + Math.ceil(order.length / 2) * 230 + 1300));
    };
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.intersectionRatio >= 0.45)) {
        io.disconnect();
        run();
      }
    }, { threshold: [0.45] });
    io.observe(card);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
      if (!started) tokens.forEach((el) => el.classList.remove("wcf-walk-pending"));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lineupView, lineupDisplayView, editingLineup, editingPositions, walkoutSig, myId]);
  function finishWalkout() {
    const card = pitchCardRef.current;
    if (!card) return;
    card.getAnimations({ subtree: true }).forEach((a) => {
      try {
        a.finish();
      } catch {}
    });
  }
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
    // Admin ratings are entered out of 10 (self stays out of 5) for finer
    // balancing precision - normalized back to the same /5 scale here so
    // every consumer downstream (fairness view, the team generator,
    // player cards) keeps comparing like-for-like regardless of source.
    for (const r of adminRatings) {
      map[r.player_id] = { ...r, fitness: r.fitness / 2, attack: r.attack / 2, defence: r.defence / 2, goalkeeping: r.goalkeeping / 2 };
    }
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
      for (const playerId of motmWinnerIdsByGame[g.id] ?? []) bump(playerId, "motm", 1);
    });
    return stats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastGames, goalRows, motmTallyByGame, motmWinnerIdsByGame, currentSeasonYear]);

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
        // Sort key only, normalized to the same /5 scale as self-ratings -
        // otherwise an admin-rated player (out of 10) would always outrank
        // an equally-good self-rated one (out of 5) purely because the raw
        // numbers sit on different scales. The per-metric numbers below
        // stay raw; the Admin/Self badge on each row already gives the
        // scale context.
        const overall = effective ? (effective.fitness + effective.attack + effective.defence) / 3 / (admin ? 2 : 1) : null;
        return {
          id: b.player_id,
          name: b.player.display_name,
          source: admin ? ("admin" as const) : self ? ("self" as const) : ("unrated" as const),
          position: effective?.position ?? null,
          fitness: effective?.fitness ?? null,
          attack: effective?.attack ?? null,
          defence: effective?.defence ?? null,
          goalkeeping: effective?.goalkeeping ?? null,
          overall,
        };
      })
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
  }, [nextConfirmed, adminRatings, selfRatings]);

  // Unrated players default to a neutral 3 rather than 0, so a handful of
  // unrated players don't get treated as "worst on the pitch" and all
  // dumped on one team - they just don't move the needle either way. On
  // top of the rated /5 score, a bounded performance bonus (goals/MOTM/
  // clean-sheets per game, win% once someone's played 3+) nudges the
  // ranking so one side doesn't end up with all the in-form players -
  // shared with GaffAI's suggest_balanced_teams tool via lib/teamBalance,
  // one calculation for both surfaces. Keepers are alternated first since
  // you basically always want exactly one specialist per team; everyone
  // else is sorted by ability and greedily assigned to whichever team's
  // running total is currently lower (a simple, explainable balance
  // heuristic, not a black-box optimizer) with a size guard so squads
  // don't end up lopsided.
  function generateBalancedTeams(): { white: string[]; red: string[] } {
    const playerIds = nextConfirmed.map((b) => b.player_id);
    const performance = computePerformanceStats(pastGames, goalRows, motmVotes, playerIds);

    const players: RatedPlayer[] = nextConfirmed.map((b) => {
      const r = ratingByPlayer[b.player_id];
      const base = r ? (r.fitness + r.attack + r.defence) / 3 : 3;
      const overall = Math.max(0, Math.min(5, base + performanceBonus(performance[b.player_id])));
      return { id: b.player_id, overall, position: r?.position ?? null };
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

    const keeperStartsWhite = Math.random() < 0.5;
    const { white, red } = assignToTeams(ranked, keeperStartsWhite);

    return { white: white.map((p) => p.id), red: red.map((p) => p.id) };
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
  // The game this player can vote Man of the Match on right now, if any:
  // scored, still inside the voting window, and they played in it.
  useEffect(() => {
    for (const g of scoredPastGames) if (kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk) loadBallotCount(g.id);
  }, [scoredPastGames, nowUk, loadBallotCount]);
  // Game ratings: your own, the game to ask about (scored, you played, until
  // the end of the day after), and whether you've closed the pop-up for it.
  const [myRatings, setMyRatings] = useState<Record<string, number>>({});
  const [ratingsLoaded, setRatingsLoaded] = useState(false);
  const [rateSummary, setRateSummary] = useState<{ ratings: number; average: number | null } | null>(null);
  const [rateDismissed, setRateDismissed] = useState<Record<string, boolean>>({});
  const [rateSheetFor, setRateSheetFor] = useState<string | null>(null);
  useEffect(() => {
    supabase
      .from("game_ratings")
      .select("game_id, rating")
      .eq("player_id", myId)
      .then(({ data }) => {
        if (data) {
          setMyRatings(Object.fromEntries(data.map((r) => [r.game_id, r.rating])));
          setRatingsLoaded(true);
        }
      });
  }, [myId]);
  const rateGame = useMemo(() => {
    const endOfNextDay = (d: string) => kickoffCutoff(d, "00:00", 2 * 24 * 60);
    return (
      scoredPastGames.find((g) => g.bookings.some((b) => b.player_id === myId && !b.waiting) && nowUk < endOfNextDay(g.date)) ?? null
    );
  }, [scoredPastGames, myId, nowUk]);
  const rateDismissKey = rateGame ? `wcf-rate-dismissed-${myId}-${rateGame.id}` : "";
  useEffect(() => {
    if (!rateGame || !ratingsLoaded) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(rateDismissKey) === "true";
    } catch {}
    setRateDismissed((cur) => ({ ...cur, [rateGame.id]: dismissed }));
    // Pops up once, the first time you're in the app with it to rate.
    if (!dismissed && !myRatings[rateGame.id]) setRateSheetFor(rateGame.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rateGame?.id, ratingsLoaded]);
  function closeRateSheet() {
    if (rateGame) {
      try {
        localStorage.setItem(rateDismissKey, "true");
      } catch {}
      setRateDismissed((cur) => ({ ...cur, [rateGame.id]: true }));
    }
    setRateSheetFor(null);
  }
  async function submitRating(gameId: string, n: number) {
    setMyRatings((cur) => ({ ...cur, [gameId]: n }));
    const { error } = await supabase.from("game_ratings").upsert({ game_id: gameId, player_id: myId, rating: n }, { onConflict: "game_id,player_id" });
    if (error) return notifyError(error.message);
    const { data } = await supabase.rpc("game_rating_summary", { p_game_id: gameId });
    const row = Array.isArray(data) ? data[0] : data;
    if (row) setRateSummary({ ratings: row.ratings, average: row.average == null ? null : Number(row.average) });
  }
  const motmVoteGame = useMemo(
    () =>
      scoredPastGames.find(
        (g) => kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES) > nowUk && g.bookings.some((b) => b.player_id === myId && !b.waiting)
      ) ?? null,
    [scoredPastGames, nowUk, myId]
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
  // The usual venue isn't worth repeating on every Scores row; only a game
  // somewhere else says where it was.
  const mainResultsVenue = useMemo(() => {
    const count: Record<string, number> = {};
    scoredPastGames.forEach((g) => (count[g.venue] = (count[g.venue] ?? 0) + 1));
    return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }, [scoredPastGames]);

  const headToHead = useMemo(() => {
    const white = { played: 0, won: 0, drawn: 0, lost: 0, points: 0, goals: 0 };
    const red = { played: 0, won: 0, drawn: 0, lost: 0, points: 0, goals: 0 };
    pastGames.forEach((g) => {
      if (g.team_white_score == null || g.team_red_score == null) return;
      white.played++;
      red.played++;
      white.goals += g.team_white_score;
      red.goals += g.team_red_score;
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
  // already sorted most-recent-first, so take 5 then reverse.
  const formGuide = useMemo(
    () => pastGames.filter((g) => g.team_white_score != null && g.team_red_score != null).slice(0, 5).reverse(),
    [pastGames]
  );

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
    if (count < 2) return null;
    // For the banter line: when the other side last won, if ever.
    const otherLastWin = scored.find((g) => winnerOf(g) && winnerOf(g) !== streakWinner);
    return { winner: streakWinner, count, otherLastWon: otherLastWin?.date ?? null };
  }, [pastGames]);

  // Per-player record - computed from the same past-games data as
  // headToHead above rather than stored anywhere, so it's always in sync
  // and never has to be back-filled or migrated. Shown in the Account
  // header; the same numbers are public on the player card.
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

  const myGoalsAllTime = useMemo(
    () => goalRows.reduce((sum, r) => (r.player_id === myId ? sum + r.goals : sum), 0),
    [goalRows, myId]
  );

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

  // ── One big moment at a time ──
  // Every automatic full-screen moment goes through this queue: the most
  // important one waiting shows, it stays until it finishes, and at most
  // MOMENTS_PER_OPEN play per app open (the rest are dropped, never
  // stacked). The rating sheet, Wrapped, a player card or your own booking
  // ticket pause the queue. Time-critical moments come first.
  const MOMENTS_PER_OPEN = 2;
  const momentCandidates: string[] = [];
  if (promoGame) momentCandidates.push("promo:" + promoGame.id);
  if (envelope) momentCandidates.push("envelope:" + envelope.ids.join(","));
  if (predLock) momentCandidates.push("predlock:" + predLock.key);
  if (myMotmMoment && motmMomentClosed !== myMotmMoment.game.id) momentCandidates.push("motm:" + myMotmMoment.game.id);
  if (potmShow) momentCandidates.push("potm:" + potmShow);
  if (myRecordMoment && !recordMomentDone) momentCandidates.push("record:" + myRecordMoment.seenKey);
  if (nextBigMoment) momentCandidates.push("big:" + nextBigMoment.key);
  if (ticketShow && ticketShow.mode !== "booked" && ticketGames.length > 0) momentCandidates.push("ticket:" + ticketShow.mode + ticketShow.gameIds.join(","));
  if (specialGame) momentCandidates.push("special:" + specialGame.id);
  if (fxCalendar && tab === "fixtures") momentCandidates.push("fx:" + fxCalendar.ids.join(","));
  const momentsPaused = !!rateSheetFor || wrappedOpen || !!playerCardId || ticketShow?.mode === "booked";
  const [momentNow, setMomentNow] = useState<string | null>(null);
  const [momentsPlayed, setMomentsPlayed] = useState(0);
  const momentKey = momentCandidates.join("|");
  useEffect(() => {
    if (momentNow && !momentCandidates.includes(momentNow)) {
      setMomentNow(null);
      setMomentsPlayed((n) => n + 1);
      return;
    }
    if (!momentNow && !momentsPaused && momentsPlayed < MOMENTS_PER_OPEN && momentCandidates.length) setMomentNow(momentCandidates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [momentKey, momentNow, momentsPaused, momentsPlayed]);
  const showMoment = (prefix: string) => !!momentNow && momentNow.startsWith(prefix + ":") && momentCandidates.includes(momentNow);

  // ── What's new on the Feed ──
  // Each open of Feed compares the posts against the ones you'd already
  // seen (kept on this device). Anything new deals in under a "New since"
  // line, once. The first ever open only records what's there.
  const [feedFresh, setFeedFresh] = useState<{ keys: Set<string>; since: number; band: boolean } | null>(null);
  const [ftBand, setFtBand] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "feed") {
      if (feedFresh) setFeedFresh(null);
      return;
    }
    if (feedFresh || !myId || feedItems.length === 0) return;
    const kSeen = `wcf-feed-seen-${myId}`;
    const kVisit = `wcf-feed-visit-${myId}`;
    let seen: string[] | null = null;
    let since = 0;
    try {
      const raw = localStorage.getItem(kSeen);
      seen = raw ? JSON.parse(raw) : null;
      since = Number(localStorage.getItem(kVisit)) || 0;
      localStorage.setItem(kSeen, JSON.stringify(feedItems.map((i) => i.key)));
      localStorage.setItem(kVisit, String(Date.now()));
    } catch {
      setFeedFresh({ keys: new Set(), since: 0, band: false });
      return;
    }
    const seenSet = new Set(seen ?? feedItems.map((i) => i.key));
    const keys = new Set(visibleFeedItems.filter((i) => !seenSet.has(i.key)).slice(0, 8).map((i) => i.key));
    const ft = visibleFeedItems.find((i) => keys.has(i.key) && i.key.endsWith("-fulltime"));
    const band = !!ft && motionOk() && !momentNow && !rateSheetFor;
    setFeedFresh({ keys, since, band });
    if (band && ft) setFtBand(ft.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, myId, feedItems]);
  useEffect(() => {
    if (!ftBand) return;
    const t = setTimeout(() => setFtBand(null), 2000);
    return () => clearTimeout(t);
  }, [ftBand]);
  const feedFreshLabel = (() => {
    if (!feedFresh?.since) return "New since your last visit";
    const then = new Date(feedFresh.since);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(feedFresh.since).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return "New since earlier today";
    if (days < 7) return `New since ${then.toLocaleDateString("en-GB", { weekday: "long" })}`;
    return "New since your last visit";
  })();

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
    admin: "Admin",
  }[tab];

  if (loading || !myProfile) {
    return <SplashScreen />;
  }

  return (
    <>
      {toast && (
        <div className={"wcf-toast " + toast.kind + (toast.undo ? " has-undo" : "")}>
          <span>{toast.text}</span>
          {toast.undo && (
            <button className="wcf-toast-undo" onClick={toast.undo}>
              Undo
            </button>
          )}
        </div>
      )}
      <header className="wcf-top">
        <button className="wcf-brand" onClick={() => setTab("fixtures")} aria-label="Go to fixtures">
          <span className="wcf-logo">
            <img src="/crest.png" alt="Wirral Community Football crest" />
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

      {isOffline && <div className="wcf-offline-banner">Offline · showing what was last loaded</div>}

      {updateAvailable && (
        <button className="wcf-update-banner" onClick={() => window.location.reload()}>
          ↻ New version available · tap to refresh
        </button>
      )}

      <main className="wcf-main" key={tab}>
        <div className="wcf-heading">
          <div>
            <h2>{heading}{tab === "fixtures" && fxChip > 0 && <span className="wcf-new-chip">{fxChip} NEW</span>}{tab === "feed" && feedView === "feed" && !showArchived && (feedFresh?.keys.size ?? 0) > 0 && <span className="wcf-new-chip">{feedFresh!.keys.size} NEW</span>}</h2>
          </div>
          {tab === "fixtures" && isAdmin && (
            <div className="wcf-heading-actions">
              <button className="wcf-addbtn ghost" onClick={copyFixtureUpdate} title="Copy a WhatsApp fixture update">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>
                Update
              </button>
              <button className="wcf-addbtn" onClick={() => setFixtureSheet({ mode: "add" })} title="Add one or more fixtures">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                Fixtures
              </button>
            </div>
          )}
        </div>

        {tab === "fixtures" && (
          <>
            {rateGame && !myRatings[rateGame.id] && rateDismissed[rateGame.id] && (
              <div className="wcf-rate-card">
                <div>
                  <div className="wcf-rate-card-t">Rate {new Date(rateGame.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}&apos;s game</div>
                  <div className="wcf-rate-card-s">{cs.team_white_name} {rateGame.team_white_score}–{rateGame.team_red_score} {cs.team_red_name}</div>
                </div>
                <RateGameMeter small value={0} onRate={(n) => { submitRating(rateGame.id, n); setRateSheetFor(rateGame.id); }} />
              </div>
            )}
            {motmVoteGame && (() => {
              const g = motmVoteGame;
              const myPick = myMotmVoteByGame[g.id];
              const pickName = myPick ? profiles.find((p) => p.id === myPick)?.display_name : null;
              return myPick ? (
                <button className="wcf-vote-prompt done" onClick={() => goToResult(g.id)}>
                  <span className="wcf-vote-prompt-text">
                    You voted for <b>{pickName ?? "a teammate"}</b> · change it until {motmClosesLabel(g)}
                  </span>
                  <span className="wcf-vote-prompt-chev" aria-hidden="true">›</span>
                </button>
              ) : (
                <button className="wcf-vote-prompt" onClick={() => goToResult(g.id)}>
                  <span className="wcf-vote-prompt-ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></svg>
                  </span>
                  <span className="wcf-vote-prompt-text">
                    <span className="wcf-vote-prompt-k">Man of the Match</span>
                    <span className="wcf-vote-prompt-t">Who was best tonight?</span>
                    <span className="wcf-vote-prompt-s">
                      {cs.team_white_name} {g.team_white_score}–{g.team_red_score} {cs.team_red_name} · closes {motmClosesLabel(g)}
                    </span>
                  </span>
                  <span className="wcf-vote-prompt-btn">Vote</span>
                </button>
              );
            })()}
            {showWrappedBanner && wrapped && (
              <div className="wr-banner-wrap">
                <style>{wrappedBannerCss}</style>
                <button
                  className={"wr-banner" + (wrappedThemeFor(wrapped.periodKey) && !wrapped.soFar ? " themed" : "")}
                  onClick={openWrapped}
                  aria-label={`Open your ${wrapped.periodLabel} Wrapped`}
                  style={(() => {
                    const t = wrappedThemeFor(wrapped.periodKey);
                    return (t ? { "--acc": t.accent, "--bimg": `url(${t.introPhoto})` } : {}) as React.CSSProperties;
                  })()}
                >
                  <span className="row">
                    <span className="play" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5z" /></svg>
                    </span>
                    <span className="copy">
                      <span className="k">
                        {wrappedThemeFor(wrapped.periodKey) && !wrapped.soFar ? `${wrapped.periodShort} · ${wrappedThemeFor(wrapped.periodKey)!.edition}` : "Wrapped"}
                        {!wrappedOpenToAll && <span className="tag">ADMINS</span>}
                      </span>
                      <span className="h">
                        {wrappedThemeFor(wrapped.periodKey) && !wrapped.soFar
                          ? wrappedThemeFor(wrapped.periodKey)!.word
                          : `Your ${wrapped.periodShort}${wrapped.soFar ? " so far" : ""}`}
                      </span>
                      <span className="s">
                        {wrapped.data.apps} games · {wrapped.data.goals} {wrapped.data.goals === 1 ? "goal" : "goals"}
                        {" · tap to watch"}
                      </span>
                    </span>
                  </span>
                </button>
                <button className="wr-banner-x" onClick={dismissWrapped} aria-label="Hide this month's Wrapped">×</button>
              </div>
            )}
            {showPushNudge && (
              <div className="wcf-nudge-banner">
                <span className="wcf-nudge-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
                </span>
                <div className="wcf-nudge-body">
                  <strong>Never miss a game</strong>
                  <p>Kickoff reminders, payment nudges and a heads-up when a spot opens.</p>
                  <div className="wcf-nudge-actions">
                    <button onClick={async () => { if (await enablePush()) dismissPushNudge(); }}>Turn on</button>
                    <button className="wcf-ghost" onClick={dismissPushNudge}>Not now</button>
                  </div>
                </div>
              </div>
            )}
            {showRatingNudge && (
              <div className="wcf-nudge-banner">
                <span className="wcf-nudge-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7z" /></svg>
                </span>
                <div className="wcf-nudge-body">
                  <strong>Rate yourself</strong>
                  <p>Helps admins pick fairer teams. It takes 30 seconds.</p>
                  <div className="wcf-nudge-actions">
                    <button onClick={() => setTab("account")}>Rate now</button>
                    <button className="wcf-ghost" onClick={dismissRatingNudge}>Not now</button>
                  </div>
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
            {upcomingGames.length === 0 && <EmptyScene kind="fixtures" title="No games on yet" text={isAdmin ? "Add one above." : "New games show up here as soon as they're posted."} />}

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
                      editing={false}
                      onBook={() => book(nextFixtureForCountdown.id)}
                      onCancel={(bookingId) => cancel(bookingId)}
                      onMarkPaid={(bookingId) => markPaid(bookingId)}
                      onEdit={() => setFixtureSheet({ mode: "edit", id: nextFixtureForCountdown.id })}
                      onSave={(patch) => saveGame(nextFixtureForCountdown.id, patch)}
                      onDelete={() => deleteGame(nextFixtureForCountdown.id)}
                      onOpenPlayerCard={openPlayerCard}
                      onSetStatus={setBookingStatus}
                      weather={weatherFor(nextFixtureForCountdown.date, nextFixtureForCountdown.kickoff)}
                      askConfirm={askConfirm}
                    />
                  </>
                )}

                {(() => {
                  // Only the next four weeks until asked - the list ran to
                  // around 20 games, most of them weeks away. Both sides are
                  // UK calendar dates as plain strings, so there's no
                  // timezone comparison to get wrong here.
                  const cut = new Date(nowUk.slice(0, 10) + "T00:00:00Z");
                  cut.setUTCDate(cut.getUTCDate() + 28);
                  const laterFrom = cut.toISOString().slice(0, 10);
                  const shown = (g: GameRow) => showLaterFixtures || g.date <= laterFrom;
                  const laterCount = upcomingGames.filter((g) => g.id !== nextFixtureForCountdown?.id && !shown(g)).length;
                  const visibleMonths = upcomingByMonth.filter((grp) => grp.games.some((g) => g.id !== nextFixtureForCountdown?.id && shown(g)));
                  return (
                    <>
                {visibleMonths.map((group) => {
                  const games = group.games.filter((g) => g.id !== nextFixtureForCountdown?.id && shown(g));
                  if (games.length === 0) return null;
                  return (
                    <div key={group.key}>
                      {visibleMonths.length > 1 && <h4 className="wcf-month-head">{group.label}</h4>}
                      {games.map((g) => (
                        <GameCard
                          key={g.id}
                          isNew={fxNewIds.has(g.id)}
                          cascadeIndex={fxCascade.includes(g.id) ? fxCascade.indexOf(g.id) : undefined}
                          game={g}
                          myId={myId}
                          isAdmin={isAdmin}
                          overdue={iAmOverdue}
                          editing={false}
                          onBook={() => book(g.id)}
                          onCancel={(bookingId) => cancel(bookingId)}
                          onMarkPaid={(bookingId) => markPaid(bookingId)}
                          onEdit={() => setFixtureSheet({ mode: "edit", id: g.id })}
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
                {laterCount > 0 && (
                  <button className="wcf-ghost wcf-later-fixtures" onClick={() => setShowLaterFixtures(true)}>
                    Show {laterCount} later fixture{laterCount === 1 ? "" : "s"}
                  </button>
                )}
                {showLaterFixtures && (
                  <button className="wcf-ghost wcf-later-fixtures" onClick={() => setShowLaterFixtures(false)}>
                    Show just the next four weeks
                  </button>
                )}
                    </>
                  );
                })()}
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
            onShareResult={(id) => {
              const g = games.find((x) => x.id === id);
              if (g) shareResult(g);
            }}
            emergencyContacts={emergencyContacts}
            onConfirmPayments={confirmPayments}
            birthdaySuggest={birthdaySuggest}
            askConfirm={askConfirm}
          />
        )}

        {tab === "feed" && (
          <FeedTab
            isAdmin={isAdmin}
            myId={myId}
            profiles={profiles}
            askConfirm={askConfirm}
            onRefresh={loadAll}
            feedView={feedView}
            setFeedView={setFeedView}
            showArchived={showArchived}
            setShowArchived={setShowArchived}
            bootRoomVisible={bootRoomVisible}
            bootRoom={
              <BootRoom
                myId={myId}
                isAdmin={isAdmin}
                profiles={profiles}
                askConfirm={askConfirm}
                logAction={logAction}
                notifyError={notifyError}
                notifySuccess={notifySuccess}
              />
            }
            visibleFeedItems={visibleFeedItems}
            hiddenFeedKeys={hiddenFeedKeys}
            hideFeedItem={hideFeedItem}
            hideFeedItems={hideFeedItems}
            unhideFeedItem={unhideFeedItem}
            feedReactions={feedReactions}
            feedReactionTally={feedReactionTally}
            toggleReaction={toggleReaction}
            feedFresh={feedFresh}
            feedFreshLabel={feedFreshLabel}
          />
        )}

        {tab === "lineup" && (
          <>
            <div className="wcf-subtabs">
              <button className={lineupView === "sheet" ? "active" : ""} onClick={() => setLineupView("sheet")}>Team Sheet</button>
              {isAdmin && (
                <button className={lineupView === "fairness" ? "active" : ""} onClick={() => setLineupView("fairness")}>Teams</button>
              )}
              <button className={lineupView === "predict" ? "active" : ""} onClick={() => setLineupView("predict")}>Predict</button>
            </div>

            {lineupView === "fairness" && isAdmin && (
              <>
                {!nextGame && <p className="wcf-empty">No upcoming fixture yet.</p>}

                {nextGame && (() => {
                  // Picking teams first; the ratings behind them fold away
                  // below. Shows the suggested split if one's been generated,
                  // otherwise the saved teams, otherwise the Generate button.
                  const savedWhite = nextGrouped.white.map((b) => b.player_id);
                  const savedRed = nextGrouped.red.map((b) => b.player_id);
                  const hasSaved = savedWhite.length > 0 || savedRed.length > 0;
                  const whiteIds = suggestedTeams?.white ?? savedWhite;
                  const redIds = suggestedTeams?.red ?? savedRed;
                  const showing = suggestedTeams || hasSaved;
                  const white = teamStats(whiteIds);
                  const red = teamStats(redIds);
                  const score = showing ? balanceScore(white, red) : null;
                  const savedScore = suggestedTeams && hasSaved ? balanceScore(teamFairness.white, teamFairness.red) : null;
                  const verdict = score === null ? "Not enough ratings to judge" : score >= 85 ? "Well balanced" : score >= 60 ? "Fairly even" : "Uneven";
                  const rating = (id: string) => nextConfirmedRatings.find((r) => r.id === id);
                  const POS_ORDER: Record<string, number> = { keeper: 0, defence: 1, midfield: 2, attack: 3 };
                  const POS_SHORT: Record<string, string> = { keeper: "GK", defence: "DEF", midfield: "MID", attack: "ATT" };
                  const lineup = (ids: string[]) =>
                    ids
                      .map((id) => ({ id, name: nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?", pos: rating(id)?.position ?? null }))
                      .sort((a, b) => (POS_ORDER[a.pos ?? ""] ?? 4) - (POS_ORDER[b.pos ?? ""] ?? 4) || a.name.localeCompare(b.name));

                  // A keeper note that says what to do, not just "keepers
                  // aren't evenly split" when only one is booked at all.
                  const keeperScore = (id: string) => {
                    const r = rating(id);
                    return r && r.goalkeeping != null ? r.goalkeeping / (r.source === "admin" ? 10 : 5) : -1;
                  };
                  const keeperLabel = (id: string) => {
                    const r = rating(id)!;
                    return `${r.goalkeeping}/${r.source === "admin" ? 10 : 5}`;
                  };
                  const bestKeeper = (ids: string[]) => ids.filter((id) => rating(id)?.position !== "keeper").sort((a, b) => keeperScore(b) - keeperScore(a))[0];
                  const keepersW = whiteIds.filter((id) => rating(id)?.position === "keeper");
                  const keepersR = redIds.filter((id) => rating(id)?.position === "keeper");
                  const nameOf = (id: string) => nextConfirmed.find((b) => b.player_id === id)?.player.display_name ?? "?";
                  let keeperNote: React.ReactNode = null;
                  if (showing && keepersW.length + keepersR.length === 1) {
                    const onWhite = keepersW.length === 1;
                    const k = (onWhite ? keepersW : keepersR)[0];
                    const other = bestKeeper(onWhite ? redIds : whiteIds);
                    keeperNote = (
                      <>
                        Only <b>{nameOf(k)}</b> is booked in goal ({onWhite ? cs.team_white_name : cs.team_red_name}).
                        {other && keeperScore(other) >= 0 && (
                          <> <b>{rating(other)!.name}</b> is {onWhite ? cs.team_red_name : cs.team_white_name}&apos; best option ({keeperLabel(other)}).</>
                        )}
                      </>
                    );
                  } else if (showing && keepersW.length + keepersR.length === 0) {
                    const bw = bestKeeper(whiteIds);
                    const br = bestKeeper(redIds);
                    if (bw && br && keeperScore(bw) >= 0 && keeperScore(br) >= 0) {
                      keeperNote = (
                        <>
                          No keeper booked. Best in goal: <b>{rating(bw)!.name}</b> ({cs.team_white_name}, {keeperLabel(bw)}) and <b>{rating(br)!.name}</b> ({cs.team_red_name}, {keeperLabel(br)}).
                        </>
                      );
                    }
                  } else if (showing && Math.abs(keepersW.length - keepersR.length) >= 2) {
                    const heavy = keepersW.length > keepersR.length;
                    keeperNote = (
                      <>
                        {heavy ? cs.team_white_name : cs.team_red_name} have <b>{Math.max(keepersW.length, keepersR.length)}</b> keepers and {heavy ? cs.team_red_name : cs.team_white_name} have <b>{Math.min(keepersW.length, keepersR.length)}</b>. Move one across.
                      </>
                    );
                  }
                  // Real imbalances only, each saying which way and by how much.
                  const gaps: { key: string; icon: "scale" | "split"; title: string; body: React.ReactNode }[] = [];
                  if (showing && white.rated > 0 && red.rated > 0) {
                    for (const m of ["fitness", "attack", "defence"] as const) {
                      if (Math.abs(white[m] - red[m]) >= 1) {
                        gaps.push({
                          key: m,
                          icon: "scale",
                          title: `${m[0].toUpperCase() + m.slice(1)} gap`,
                          body: (
                            <>
                              {cs.team_white_name} <b>{white[m].toFixed(1)}</b> v {cs.team_red_name} <b>{red[m].toFixed(1)}</b>.
                              {suggestedTeams ? " Tap Shuffle again for a closer split." : ""}
                            </>
                          ),
                        });
                      }
                    }
                  }
                  if (showing) {
                    for (const p of ["defence", "midfield", "attack"] as PlayerPosition[]) {
                      if (Math.abs(white.positions[p] - red.positions[p]) >= 2) {
                        const word = p === "defence" ? "defender" : p === "midfield" ? "midfielder" : "attacker";
                        const label = (n: number) => (n === 1 ? word : `${word}s`);
                        gaps.push({
                          key: p,
                          icon: "split",
                          title: `${POSITION_LABEL[p]} split`,
                          body: (
                            <>
                              {cs.team_white_name} have <b>{white.positions[p]}</b> {label(white.positions[p])}, {cs.team_red_name} <b>{red.positions[p]}</b>.
                            </>
                          ),
                        });
                      }
                    }
                  }

                  return (
                    <>
                      <div className="wcf-teams-hero">
                        <div className="wcf-teams-k">
                          {fmtDate(nextGame.date)} · {nextConfirmed.length} booked
                        </div>
                        {!showing ? (
                          <>
                            <div className="wcf-teams-t">Teams not picked yet</div>
                            <div className="wcf-teams-s">
                              {nextConfirmed.length > 0
                                ? "Generate a balanced split from everyone's ratings, or pick them by hand on the Team Sheet."
                                : "No one's booked in yet."}
                            </div>
                            {nextConfirmed.length > 0 && (
                              <button className="wcf-teams-go" onClick={() => setSuggestedTeams(generateBalancedTeams())}>
                                Generate teams
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="wcf-teams-top">
                              {score !== null && (
                                <div className="wcf-teams-ring" style={{ "--pct": `${score}%` } as React.CSSProperties}>
                                  <div>{score}%</div>
                                </div>
                              )}
                              <div>
                                <div className="wcf-teams-t">{verdict}</div>
                                <div className="wcf-teams-s">
                                  {suggestedTeams
                                    ? "Suggested split. Nothing changes until you use it, and you can still move anyone on the Team Sheet."
                                    : "These are the saved teams."}
                                  {savedScore !== null && score !== null && Math.abs(score - savedScore) >= 3 &&
                                    (score > savedScore ? ` That's ${score - savedScore}% more balanced than the saved teams.` : ` The saved teams are ${savedScore - score}% more balanced.`)}
                                </div>
                              </div>
                            </div>
                            <div className="wcf-teams-acts">
                              {suggestedTeams ? (
                                <>
                                  <button className="wcf-teams-ghost" onClick={() => setSuggestedTeams(generateBalancedTeams())}>↻ Shuffle again</button>
                                  <button className="wcf-teams-ghost" onClick={() => setSuggestedTeams(null)} aria-label="Discard the suggestion">✕</button>
                                  <button className="wcf-teams-go" onClick={applySuggestedTeams}>Use these teams</button>
                                </>
                              ) : (
                                <button className="wcf-teams-ghost wide" onClick={() => setSuggestedTeams(generateBalancedTeams())}>Generate a new split</button>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      {showing && (
                        <>
                          <div className="wcf-teams-cols">
                            {([["white", whiteIds, cs.team_white_name, cs.team_white_color], ["red", redIds, cs.team_red_name, cs.team_red_color]] as const).map(([key, ids, name, color]) => (
                              <div key={key} className="wcf-teams-col" style={{ "--team": color } as React.CSSProperties}>
                                <div className="wcf-teams-col-h"><span>{name}</span><span>{ids.length}</span></div>
                                {lineup(ids).map((p) => (
                                  <div key={p.id} className="wcf-teams-pl">
                                    <Avatar name={p.name} avatarUrl={avatarByPlayerId.get(p.id)} className="wcf-teams-av" background={avatarFor(p.name).gradient} />
                                    <span className="wcf-teams-nm">{p.name}</span>
                                    {p.pos && <span className={"wcf-teams-pos" + (p.pos === "keeper" ? " gk" : "")}>{POS_SHORT[p.pos]}</span>}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>

                          {white.rated > 0 && red.rated > 0 && (
                            <div className="wcf-teams-card" style={{ "--wc": cs.team_white_color, "--rc": cs.team_red_color } as React.CSSProperties}>
                              <div className="wcf-teams-card-h">How they compare</div>
                              {(["fitness", "attack", "defence"] as const).map((m) => (
                                <div key={m} className="wcf-teams-cmp">
                                  <div className="wcf-teams-cmp-l">
                                    <span>{white[m].toFixed(1)}</span>
                                    <span>{m[0].toUpperCase() + m.slice(1)}</span>
                                    <span>{red[m].toFixed(1)}</span>
                                  </div>
                                  <div className="wcf-teams-bar">
                                    <i className="w" style={{ flex: Math.max(white[m], 0.1) }} />
                                    <i className="r" style={{ flex: Math.max(red[m], 0.1) }} />
                                  </div>
                                </div>
                              ))}
                              {(white.rated < white.total || red.rated < red.total) && (
                                <div className="wcf-teams-rated">{white.rated + red.rated} of {white.total + red.total} rated</div>
                              )}
                            </div>
                          )}

                          {keeperNote && (
                            <TeamCallout tone="gold" icon="glove" title="Keeper cover">
                              {keeperNote}
                            </TeamCallout>
                          )}
                          {gaps.map((g) => (
                            <TeamCallout key={g.key} tone="red" icon={g.icon} title={g.title}>
                              {g.body}
                            </TeamCallout>
                          ))}
                          {gaps.length === 0 && white.rated > 0 && red.rated > 0 && (
                            <TeamCallout tone="green" icon="check" title="No big gaps">
                              Ratings and positions are evenly spread.
                            </TeamCallout>
                          )}
                        </>
                      )}
                    </>
                  );
                })()}

                {nextGame && nextConfirmedRatings.length > 0 && (
                  <>
                    <button className="wcf-teams-row" onClick={() => setShowTeamRatings((v) => !v)} aria-expanded={showTeamRatings}>
                      Player ratings
                      <span>
                        {nextConfirmedRatings.filter((r) => r.source !== "unrated").length} rated{" "}
                        <b className={showTeamRatings ? "open" : ""}>›</b>
                      </span>
                    </button>
                    {showTeamRatings && (
                      <div className="wcf-ratings-table">
                        <div className="wcf-ratings-rows">
                          {nextConfirmedRatings.map((r) => (
                            <div key={r.id} className="wcf-ratings-row">
                              <div className="wcf-ratings-name">
                                <span className="wcf-ratings-who">{r.name}</span>
                                {r.position && <span className="wcf-ratings-pos">{POSITION_LABEL[r.position]}</span>}
                                {r.source !== "unrated" && (
                                  <span className={"wcf-ratings-source " + r.source}>{r.source === "admin" ? "Admin /10" : "Self /5"}</span>
                                )}
                              </div>
                              {r.source === "unrated" ? (
                                <span className="wcf-ratings-unrated">Not rated yet</span>
                              ) : (
                                // Bars fill against each rating's own scale (admin /10,
                                // self /5), so an 8 from an admin and a 4 from a
                                // self-rating look the same - which they are.
                                <div className="wcf-ratings-bars">
                                  {([["Fitness", r.fitness], ["Attack", r.attack], ["Defence", r.defence], ["Keeper", r.goalkeeping]] as const).map(([label, v]) => (
                                    <div key={label} className="wcf-ratings-bar">
                                      <span className="wcf-ratings-bar-top"><span>{label}</span><b>{v}</b></span>
                                      <span className="wcf-ratings-track">
                                        <i style={{ width: `${Math.max(0, Math.min(100, ((v ?? 0) / (r.source === "admin" ? 10 : 5)) * 100))}%` }} />
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {balanceHistory.rows.length > 0 && (() => {
                  const margins = balanceHistory.rows.map((r) => r.margin);
                  const avg = margins.reduce((s, m) => s + m, 0) / margins.length;
                  const generated = balanceHistory.rows.filter((r) => r.method === "generated").length;
                  return (
                    <div className="wcf-teams-card">
                      <div className="wcf-teams-card-h">
                        Recent games <span>avg margin {avg.toFixed(1)}</span>
                      </div>
                      <div className="wcf-teams-hist-s">
                        Winning margin, newest first.{" "}
                        {generated === 0
                          ? "All picked by hand so far."
                          : `Generated teams: avg ${balanceHistory.avgGenerated?.toFixed(1) ?? "—"}. By hand: avg ${balanceHistory.avgManual?.toFixed(1) ?? "—"}.`}
                      </div>
                      <div className="wcf-teams-hist">
                        {balanceHistory.rows.map((r) => (
                          <i
                            key={r.id}
                            className={(r.margin <= 1 ? "ok" : r.margin >= 6 ? "big" : "") + (r.method === "generated" ? " gen" : "")}
                            title={`${fmtDate(r.date)}: ${r.whiteScore}–${r.redScore}${r.method === "generated" ? " (generated)" : ""}`}
                          >
                            {r.margin}
                          </i>
                        ))}
                      </div>
                    </div>
                  );
                })()}
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
                {nextConfirmed.length === 0 && (
                  <EmptyScene kind="sheet" title="No one's booked in yet" text="Be first on the team sheet.">
                    <button className="wcf-book" onClick={() => setTab("fixtures")}>Grab a spot</button>
                  </EmptyScene>
                )}

                {isAdmin && editingLineup && (
                  // A live count, then anyone still to place first.
                  <>
                    <div className="wcf-lineup-count">
                      <span>
                        <b>{editGrouped.white.length}</b> {cs.team_white_name} · <b>{editGrouped.red.length}</b> {cs.team_red_name}
                      </span>
                      {editGrouped.unassigned.length > 0 ? (
                        <span className="todo">{editGrouped.unassigned.length} to place</span>
                      ) : (
                        <span className="done">All placed ✓</span>
                      )}
                    </div>
                    <button
                      className="wcf-lineup-gen"
                      onClick={() => {
                        cancelEditingLineup();
                        setLineupView("fairness");
                      }}
                    >
                      Generate teams instead ›
                    </button>
                  </>
                )}
                {isAdmin && editingLineup && (() => {
                  return ([["unassigned", editGrouped.unassigned, "To place", null], ["white", editGrouped.white, cs.team_white_name, cs.team_white_color], ["red", editGrouped.red, cs.team_red_name, cs.team_red_color]] as const).map(
                    ([key, group, name, color]) =>
                      group.length > 0 && (
                        <div key={key} className={"wcf-lineup-group" + (key === "unassigned" ? " todo" : "")}>
                          <div className="wcf-lineup-group-label">
                            {color && <span className="wcf-lineup-group-dot" style={{ background: color }} />}
                            {name} · {group.length}
                          </div>
                          {group.map((b) => (
                            <div key={b.id} className={"wcf-lineup-row" + (b.player_id === myId ? " me-edit" : "")}>
                              <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-lineup-av" background={avatarFor(b.player.display_name).gradient} />
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
                        data-red={t.isRed ? "1" : "0"}
                        data-me={me ? "1" : "0"}
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
                              <button className="wcf-ghost" onClick={startEditingPositions}>Drag to arrange</button>
                              {nextGame?.lineup_positions && (
                                <button className="wcf-ghost danger" onClick={resetPositions}>Reset to auto</button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {lineupDisplayView === "pitch" && (
                        <div className="wcf-lineup-pitch-card" ref={pitchCardRef} onClick={finishWalkout}>
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
                    {/* "Unassigned" is admin language. Before any teams are
                        picked this is simply who's playing. */}
                    <div className="wcf-lineup-group-label">
                      {nextGrouped.white.length === 0 && nextGrouped.red.length === 0 ? "Who's in" : "Still to be picked"} · {nextGrouped.unassigned.length}
                    </div>
                    {nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && (
                      <p className="wcf-lineup-group-note">Teams get picked nearer kick-off.</p>
                    )}
                    {/* A grid of faces rather than one full-width row each:
                        sixteen rows was a long scroll to see who's playing,
                        and faces are what people recognise at a glance. */}
                    <div className="wcf-lineup-grid">
                      {nextGrouped.unassigned.map((b) => (
                        <button
                          key={b.id}
                          className={"wcf-lineup-chip" + (b.player_id === myId ? " me" : "")}
                          onClick={() => openPlayerCard(b.player_id)}
                        >
                          <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-lineup-chip-avatar" />
                          <span className="wcf-lineup-chip-name">{b.player_id === myId ? "You" : b.player.display_name}</span>
                        </button>
                      ))}
                    </div>
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
                  {/* The thing you came to do, first: the same prediction box
                      as the Team Sheet (or "opens when teams are posted"),
                      rather than a button below all 28 leaderboard rows. */}
                  {nextGame && (nextGrouped.white.length > 0 || nextGrouped.red.length > 0) && (
                    <div className="wcf-predict-top">
                    <PredictPanel
                      key={"top-" + nextGame.id}
                      gameId={nextGame.id}
                      whiteLabel={cs.team_white_name}
                      redLabel={cs.team_red_name}
                      isBooked={nextConfirmed.some((b) => b.player_id === myId)}
                      myPrediction={scorePredictions.find((p) => p.game_id === nextGame.id && p.player_id === myId) ?? null}
                      onSave={savePrediction}
                    />
                    </div>
                  )}
                  {nextGame && nextGrouped.white.length === 0 && nextGrouped.red.length === 0 && (
                    <div className="wcf-predict wcf-predict-top">
                      <div className="wcf-predict-gate">
                        <div className="wcf-predict-gate-icon">
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
                        </div>
                        <div className="wcf-predict-gate-text">
                          <b>{fmtDate(nextGame.date)}: predictions open once teams are posted.</b> Check back here nearer kickoff. They lock at kickoff.
                        </div>
                      </div>
                    </div>
                  )}

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

                  {isSeason && (
                    <div className="wcf-lb-prize">
                      <span className="wcf-lb-medals" aria-hidden="true"><i className="g">1</i><i className="s">2</i><i className="b">3</i></span>
                      <span className="wcf-lb-prize-text">
                        Top 3 at season&apos;s end win from the pot
                        <small>3 pts exact score · 1 pt right result · booked players only</small>
                      </span>
                    </div>
                  )}
                  {!isSeason && isCurrentMonth && (
                    <div className="wcf-lb-prize">
                      <span className="wcf-lb-prize-ic" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                      </span>
                      <span className="wcf-lb-prize-text">
                        {monthLabel} is still in progress
                        <small>Standings so far, not final.</small>
                      </span>
                    </div>
                  )}
                  {!isSeason && !isCurrentMonth && leaders.length > 0 && (
                    <div className="wcf-lb-prize">
                      <span className="wcf-lb-medals" aria-hidden="true"><i className="g">1</i></span>
                      <span className="wcf-lb-prize-text">
                        {monthLabel} winner: <b>{leaders.map((l) => l.playerName).join(" & ")}</b>
                        <small>A free game this month.</small>
                      </span>
                    </div>
                  )}
                  {!isSeason && <div className="wcf-lb-key">3 pts exact score · 1 pt correct result · booked players only</div>}

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
                                  {row.exactCount > 0 && <span className="wcf-pl-exact">{row.exactCount} exact score{row.exactCount === 1 ? "" : "s"}</span>}
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
              <button className={resultsView === "records" ? "active" : ""} onClick={() => setResultsView("records")}>Records</button>
              <button className={resultsView === "fixtures" ? "active" : ""} onClick={() => setResultsView("fixtures")}>Scores</button>
              <button className={resultsView === "pot" ? "active" : ""} onClick={() => setResultsView("pot")}>Pot</button>
            </div>

            {resultsView === "season" && (() => {
              const seasonGames = pastGames.filter((g) => g.date.slice(0, 4) === String(currentSeasonYear));
              const gamesThisSeason = seasonGames.length;
              // The season's headline numbers, from the scored games only.
              const scoredSeason = seasonGames.filter((g) => g.team_white_score != null && g.team_red_score != null);
              const seasonGoals = scoredSeason.reduce((sum, g) => sum + g.team_white_score! + g.team_red_score!, 0);
              const seasonPlayers = new Set(scoredSeason.flatMap((g) => g.bookings.filter((b) => !b.waiting && b.team).map((b) => b.player_id))).size;
              return (
              <>
                <div className="wcf-season-hero">
                  <div className="wcf-season-hero-eyebrow">Season {currentSeasonYear - SEASON_EPOCH_YEAR + 1}</div>
                  <div className="wcf-season-hero-title">{currentSeasonYear}</div>
                  {scoredSeason.length > 0 ? (
                    <div className="wcf-season-hero-stats">
                      <span><b>{gamesThisSeason}</b>{gamesThisSeason === 1 ? "Game" : "Games"}</span>
                      <span><b>{seasonGoals}</b>Goals</span>
                      <span><b>{seasonPlayers}</b>Players</span>
                      <span><b>{(seasonGoals / scoredSeason.length).toFixed(1)}</b>Per game</span>
                    </div>
                  ) : (
                    <div className="wcf-season-hero-sub">{gamesThisSeason} game{gamesThisSeason === 1 ? "" : "s"} played so far</div>
                  )}
                </div>
                {playerOfMonth && (() => {
                  const ws = playerOfMonth.winners;
                  const joint = ws.length > 1;
                  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
                  return (
                    // A photo card like the season hero above it, not a
                    // text shout-out: the winner's face, name and why.
                    <div className={"wcf-potm-card" + (potmLand ? " wcf-potm-land" : "")}>
                      <div className="wcf-potm-bg" />
                      <div className="wcf-potm-top">
                        <span className="wcf-potm-eyebrow">{joint ? "Players of the month" : "Player of the month"} · {playerOfMonth.monthLabel}</span>
                        <button className="wcf-potm-share" onClick={sharePlayerOfMonth} aria-label="Share Player of the Month">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>
                          Share
                        </button>
                      </div>
                      <div className="wcf-potm-main">
                        <div className="wcf-potm-faces">
                          {ws.slice(0, 2).map((w) => (
                            <Avatar key={w.id} name={w.name} avatarUrl={avatarByPlayerId.get(w.id)} className="wcf-potm-face" background={avatarFor(w.name).gradient} />
                          ))}
                        </div>
                        <div className="wcf-potm-who">
                          {ws.map((w, i) => (
                            <button key={w.id} className="wcf-potm-name" onClick={() => openPlayerCard(w.id)}>
                              {w.name}
                              {i < ws.length - 1 ? <span className="wcf-potm-amp"> &amp;</span> : null}
                            </button>
                          ))}
                        </div>
                      </div>
                      {!joint && ws[0] && (
                        <div className="wcf-potm-stats">
                          <span><b><CountUp to={ws[0].wins} delay={600} run={potmLand} /></b>{ws[0].wins === 1 ? "MOTM win" : "MOTM wins"}</span>
                          <span><b><CountUp to={ws[0].votes} delay={700} run={potmLand} /></b>{ws[0].votes === 1 ? "vote" : "votes"}</span>
                          <span><b><CountUp to={ws[0].goals} delay={800} run={potmLand} /></b>{ws[0].goals === 1 ? "goal" : "goals"}</span>
                        </div>
                      )}
                      {joint && <div className="wcf-potm-note">Level on {plural(ws[0].wins, "MOTM win", "MOTM wins")} and votes. Shared honours.</div>}
                    </div>
                  );
                })()}
                {awards.map((a) => (
                  <div key={a.id} className="wcf-shoutout">
                    {a.title} — <strong>{a.value}</strong>
                    {a.note ? ` · ${a.note}` : ""}
                    {a.image_url && <img className="wcf-award-media" src={a.image_url} alt={a.title} loading="lazy" />}
                    {a.video_url && <video className="wcf-award-media" src={a.video_url} controls preload="metadata" />}
                  </div>
                ))}

                {rivalryStreak && (() => {
                  const lead = rivalryStreak.winner === "white" ? cs.team_white_name : cs.team_red_name;
                  const other = rivalryStreak.winner === "white" ? cs.team_red_name : cs.team_white_name;
                  const color = rivalryStreak.winner === "white" ? cs.team_white_color : cs.team_red_color;
                  return (
                    // Same family as the Player of the Month card: a glow in
                    // the leading team's own colour, the number up front.
                    <div className="wcf-streak-card" style={{ "--team": color } as React.CSSProperties}>
                      <div className="wcf-streak-n">{rivalryStreak.count}</div>
                      <div className="wcf-streak-body">
                        <div className="wcf-streak-eyebrow">
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M13.5 2.5c.4 3-1.2 4.6-2.7 6.1C9.4 10 8 11.4 8 14a4 4 0 0 0 8 0c0-1.2-.4-2.2-1-3 2.3.8 4 3.2 4 6a7 7 0 0 1-14 0c0-4.3 2.6-6.6 4.6-8.5 1.9-1.8 3.5-3.4 3.9-6z" /></svg>
                          Winning run
                        </div>
                        <div className="wcf-streak-title">{lead} have won {rivalryStreak.count} in a row</div>
                        <div className="wcf-streak-sub">
                          {rivalryStreak.otherLastWon ? `${other} haven't won since ${fmtDate(rivalryStreak.otherLastWon)}` : `${other} are still waiting for a win`}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {headToHead.white.played > 0 && (() => {
                  // One rivalry, not two mirrored table rows: results and
                  // goals as bars, then the last five actual scores.
                  const h = headToHead;
                  const wName = cs.team_white_name;
                  const rName = cs.team_red_name;
                  const summary =
                    h.white.won === h.red.won
                      ? h.white.goals === h.red.goals
                        ? `Dead level after ${h.white.played} games.`
                        : `Level on wins after ${h.white.played} games. ${h.white.goals > h.red.goals ? wName : rName} ahead on goals.`
                      : `${h.white.won > h.red.won ? wName : rName} lead by ${Math.abs(h.white.won - h.red.won)} ${Math.abs(h.white.won - h.red.won) === 1 ? "win" : "wins"} after ${h.white.played} games.`;
                  const openScore = (id: string) => {
                    setResultsMonth("all");
                    setExpandedResultId(id);
                    setResultsView("fixtures");
                    setTimeout(() => document.getElementById("result-" + id)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
                  };
                  return (
                    <div className="wcf-rivalry" style={{ "--wc": cs.team_white_color, "--rc": cs.team_red_color } as React.CSSProperties}>
                      <div className="wcf-rivalry-title">{wName} v {rName}</div>
                      <div className="wcf-rivalry-sub">{summary}</div>
                      <div className="wcf-h2h-table">
                        <div className="wcf-h2h-row wcf-h2h-header">
                          <span>Team</span><span>P</span><span>W</span><span>D</span><span>L</span><span>GF</span><span>GA</span><span>Pts</span>
                        </div>
                        {([["white", h.white, h.red.goals, wName, cs.team_white_color], ["red", h.red, h.white.goals, rName, cs.team_red_color]] as const)
                          .slice()
                          // Level on points goes to goal difference.
                          .sort((a, b) => b[1].points - a[1].points || (b[1].goals - b[2]) - (a[1].goals - a[2]))
                          .map(([key, row, against, name, color]) => (
                            <div key={key} className="wcf-h2h-row">
                              <span className="wcf-h2h-team"><span className="wcf-h2h-dot" style={{ background: color }} />{name}</span>
                              <span>{row.played}</span><span>{row.won}</span><span>{row.drawn}</span><span>{row.lost}</span>
                              <span>{row.goals}</span><span>{against}</span>
                              <span className="wcf-h2h-pts">{row.points}</span>
                            </div>
                          ))}
                      </div>
                      <div className="wcf-rivalry-row">
                        {/* The numbers are in the table above; the bars are the picture of them. */}
                        <div className="wcf-rivalry-cap">Wins{h.white.drawn > 0 ? ` · ${h.white.drawn} ${h.white.drawn === 1 ? "draw" : "draws"}` : ""}</div>
                        <div className="wcf-rivalry-bar">
                          {h.white.won > 0 && <i className="w" style={{ flex: h.white.won }} />}
                          {h.white.drawn > 0 && <i className="d" style={{ flex: h.white.drawn }} />}
                          {h.red.won > 0 && <i className="r" style={{ flex: h.red.won }} />}
                        </div>
                      </div>
                      {h.white.goals + h.red.goals > 0 && (
                        <div className="wcf-rivalry-row">
                          <div className="wcf-rivalry-cap">Goals</div>
                          <div className="wcf-rivalry-bar">
                            {h.white.goals > 0 && <i className="w" style={{ flex: h.white.goals }} />}
                            {h.red.goals > 0 && <i className="r" style={{ flex: h.red.goals }} />}
                          </div>
                        </div>
                      )}
                      {formGuide.length > 0 && (
                        <div className="wcf-rivalry-row">
                          <div className="wcf-rivalry-k">Last {formGuide.length} · {wName} first</div>
                          <div className="wcf-rivalry-scores">
                            {formGuide.map((g, i) => {
                              const res = g.team_white_score! > g.team_red_score! ? "w" : g.team_white_score! < g.team_red_score! ? "r" : "d";
                              return (
                                <button key={g.id} className={"wcf-rivalry-score " + res + (i === formGuide.length - 1 ? " latest" : "")} onClick={() => openScore(g.id)}>
                                  <b>{g.team_white_score}–{g.team_red_score}</b>
                                  <span>{new Date(g.date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="wcf-rivalry-key">
                            <span><i className="w" />{wName} won</span>
                            <span><i className="r" />{rName} won</span>
                            <span><i className="d" />Draw</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                      <span className={"wcf-board-count" + (statsSort === "apps" ? " on" : "")}>Apps</span>
                      <span className={"wcf-board-count" + (statsSort === "goals" ? " on" : "")}>Goals</span>
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
                            {/* Badges sit under the name rather than beside it:
                                side by side they squeezed names down to
                                "Jacob…" and "Chris H…". */}
                            <span className="wcf-board-who">
                              <button
                                className="wcf-board-name wcf-name-link"
                                onClick={(e) => { e.stopPropagation(); openPlayerCard(row.id); }}
                              >
                                {row.name}
                              </button>
                              {isMe && (
                                <span className="wcf-board-badges">
                                  <span className="wcf-lb-you-badge">you</span>
                                </span>
                              )}
                            </span>
                            <span className={"wcf-board-count" + (statsSort === "apps" ? " on" : "")}>{row.apps}</span>
                            <span className={"wcf-board-count" + (statsSort === "goals" ? " on" : "")}>{row.goals || "—"}</span>
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
                      <span>Tap a row for goals per game and when they last played.</span>
                      <button onClick={() => setTab("fixtures")}>View fixtures</button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {resultsView === "records" && (() => {
              const r = clubRecords;
              // Up to three names, each tappable to their player card,
              // then "+N more" rather than a wall of names on a tie.
              const who = (holders: Holder[], withDate = false) => (
                <>
                  {holders.slice(0, 3).map((h, i) => (
                    <span key={h.playerId + (h.date ?? "") + i}>
                      {i > 0 ? ", " : ""}
                      <button className="wcf-name-link" onClick={() => openPlayerCard(h.playerId)}>{h.name}</button>
                      {withDate && h.date ? <span className="wcf-rec-date"> · {fmtDate(h.date)}</span> : null}
                    </span>
                  ))}
                  {holders.length > 3 && <span className="wcf-rec-date"> +{holders.length - 3} more</span>}
                </>
              );
              // Holders' faces on the right, and a gold glow on anything you hold.
              const row = (key: string, value: React.ReactNode, label: string, detail: React.ReactNode, holders: Holder[] = []) => {
                const faces = holders.filter((h, i, all) => all.findIndex((x) => x.playerId === h.playerId) === i).slice(0, 3);
                const mine = holders.some((h) => h.playerId === myId);
                const fell = recordFalls[key];
                const was = fell && (key === "win" ? `+${fell.v}` : fell.v);
                return (
                  <div key={key} className={"wcf-rec-row" + (faces.length ? " has-faces" : "") + (mine ? " mine" : "") + (fell ? " wcf-rb-play" : "")}>
                    <div className="wcf-rec-val">{fell ? <><span className="wcf-rb-old">{was}</span><span className="wcf-rb-new">{value}</span></> : value}</div>
                    <div className="wcf-rec-body">
                      {label && <div className="wcf-rec-label">{label}{mine && <span className="wcf-rec-you">You</span>}{fell && <span className="wcf-rb-chip">NEW</span>}</div>}
                      <div className="wcf-rec-who">{fell ? <><span className="wcf-rb-was">{fell.who}</span><span className="wcf-rb-now">{detail}</span></> : detail}</div>
                    </div>
                    {fell && <div className="wcf-rb-shine" />}
                    {faces.length > 0 && (
                      <div className="wcf-rec-faces">
                        {faces.map((h) => (
                          <Avatar key={h.playerId} name={h.name} avatarUrl={avatarByPlayerId.get(h.playerId)} className="wcf-rec-face" background={avatarFor(h.name).gradient} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              };
              const scoreLine = (x: { date: string; white: number; red: number }) => (
                <>
                  {cs.team_white_name} {x.white}–{x.red} {cs.team_red_name}
                  <span className="wcf-rec-date"> · {fmtDate(x.date)}</span>
                </>
              );
              const days = (d: number) => (d < 1 ? "less than a day" : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`);
              const empty = !r.highestScoring;
              return (
                <div className="wcf-board">
                  <div className={"wcf-rec-hero" + (recordFalls.goals ? " wcf-rb-play" : "")}>
                    <div className="wcf-rec-hero-bg" />
                    {recordFalls.goals && <div className="wcf-rb-tag">NEW RECORD</div>}
                    <div className="wcf-rec-hero-in">
                      <div className="wcf-lb-eyebrow" style={{ color: "#f5d97a" }}>Record book</div>
                      <h3 className="wcf-lb-title">Club records</h3>
                      {r.mostGoalsInGame && (
                        <div className="wcf-rec-hero-stat">
                          <b>{recordFalls.goals ? <><span className="wcf-rb-old">{recordFalls.goals.v}</span><span className="wcf-rb-new">{r.mostGoalsInGame.goals}</span></> : r.mostGoalsInGame.goals}</b>
                          <span>goals in one game<br />{recordFalls.goals && <span className="wcf-rb-was">{recordFalls.goals.who}</span>}<span className={recordFalls.goals ? "wcf-rb-now" : undefined}>{r.mostGoalsInGame.holders[0].name}{r.mostGoalsInGame.holders.length > 1 ? ` +${r.mostGoalsInGame.holders.length - 1}` : ""}</span></span>
                        </div>
                      )}
                    </div>
                  </div>
                  <select
                      className="wcf-month-filter wcf-rec-season"
                      value={activeStatsYear}
                      onChange={(e) => setStatsSeasonYear(Number(e.target.value))}
                    >
                      {seasonYears.map((y) => (
                        <option key={y} value={y}>
                          Season {y - SEASON_EPOCH_YEAR + 1} ({y}){y === currentSeasonYear ? " — current" : ""}
                        </option>
                      ))}
                    </select>
                  {myBests.games > 0 && (() => {
                    const b = myBests;
                    // A tile is "the club record" when your best equals it.
                    const tiles: { k: string; v: number | string; label: string; sub?: string; record: boolean }[] = [
                      { k: "g", v: b.mostGoals?.goals ?? 0, label: "Goals in a game", sub: b.mostGoals ? fmtDate(b.mostGoals.date) : undefined, record: !!b.mostGoals && b.mostGoals.goals === r.mostGoalsInGame?.goals },
                      { k: "w", v: b.winStreak, label: "Win streak", record: b.winStreak > 0 && b.winStreak === r.winStreak?.n },
                      { k: "u", v: b.unbeaten, label: "Unbeaten run", record: b.unbeaten > 0 && b.unbeaten === r.unbeaten?.n },
                      { k: "r", v: b.gamesInARow, label: "Games in a row", record: b.gamesInARow > 0 && b.gamesInARow === r.gamesInARow?.n },
                    ];
                    if (b.hatTricks > 0) tiles.push({ k: "h", v: b.hatTricks, label: b.hatTricks === 1 ? "Hat-trick" : "Hat-tricks", record: false });
                    if (b.motmWins > 0) tiles.push({ k: "m", v: b.motmWins, label: b.motmWins === 1 ? "MOTM win" : "MOTM wins", record: b.motmWins === r.motmWins?.n });
                    else if (b.motmVotes > 0) tiles.push({ k: "v", v: b.motmVotes, label: b.motmVotes === 1 ? "MOTM vote" : "MOTM votes", record: b.motmVotes === r.motmVotes?.n });
                    const meName = myProfile?.display_name ?? "You";
                    return (
                      // Same family as the Player of the Month card: a photo
                      // glow, your face in a gold ring, and a clean row of
                      // numbers rather than boxed tiles.
                      <div className="wcf-bests">
                        <div className="wcf-bests-bg" />
                        <div className="wcf-bests-head">
                          <Avatar name={meName} avatarUrl={avatarByPlayerId.get(myId)} className="wcf-bests-face" background={avatarFor(meName).gradient} />
                          <div className="wcf-bests-who">
                            <span className="wcf-bests-eyebrow">Your season</span>
                            <span className="wcf-bests-name">{meName}</span>
                            <span className="wcf-bests-meta">{b.games} {b.games === 1 ? "game" : "games"} played</span>
                          </div>
                        </div>
                        <div className="wcf-bests-grid">
                          {tiles.map((t) => (
                            <div key={t.k} className={"wcf-bests-stat" + (t.record ? " record" : "")}>
                              <b>{t.v}</b>
                              <span>{t.label}</span>
                              {t.record ? (
                                <em>
                                  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M3 18h18l-1.6-9.2-4.9 3.9L12 5l-2.5 7.7-4.9-3.9z" /></svg>
                                  Club record
                                </em>
                              ) : (
                                t.sub && <small>{t.sub}</small>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="wcf-lb-list-card">
                    {empty ? (
                      <p className="wcf-board-note">No results yet this season. Records start with the first game.</p>
                    ) : (
                      <>
                        <div className="wcf-rec-group">In a single game</div>
                        {r.mostGoalsInGame && row("goals", r.mostGoalsInGame.goals, "Most goals by one player", who(r.mostGoalsInGame.holders, true), r.mostGoalsInGame.holders)}
                        {r.biggestWin && row("win", `+${r.biggestWin.margin}`, "Biggest win", scoreLine(r.biggestWin))}
                        {r.highestScoring && row("high", r.highestScoring.total, "Most goals in a game", scoreLine(r.highestScoring))}
                        {r.mostMotmVotesInGame && row("votes1", r.mostMotmVotesInGame.votes, "Most MOTM votes in a game", who(r.mostMotmVotesInGame.holders, true), r.mostMotmVotesInGame.holders)}

                        <div className="wcf-rec-group">Over the season</div>
                        {r.winStreak && row("ws", r.winStreak.n, "Longest winning run", who(r.winStreak.holders), r.winStreak.holders)}
                        {r.unbeaten && row("ub", r.unbeaten.n, "Longest unbeaten run", who(r.unbeaten.holders), r.unbeaten.holders)}
                        {r.gamesInARow && row("row", r.gamesInARow.n, "Most games in a row", who(r.gamesInARow.holders), r.gamesInARow.holders)}
                        {r.motmWins && row("mw", r.motmWins.n, "Most Man of the Match wins", who(r.motmWins.holders), r.motmWins.holders)}
                        {r.motmVotes && row("mv", r.motmVotes.n, "Most MOTM votes", who(r.motmVotes.holders), r.motmVotes.holders)}
                        {r.promotions && row("wl", r.promotions.n, "Most times in off the waiting list", who(r.promotions.holders), r.promotions.holders)}

                        {r.hatTricks.length > 0 && (
                          <>
                            <div className="wcf-rec-group">Hat-tricks · {r.hatTricks.length}</div>
                            {/* Same rows as every other record, so the numbers and
                                names line up; the top 5 until asked for the rest,
                                since this list only grows through a season. */}
                            {(showAllHatTricks ? r.hatTricks : r.hatTricks.slice(0, 5)).map((h, i) =>
                              row(
                                h.playerId + h.date + i,
                                h.goals,
                                "",
                                <>
                                  <button className="wcf-name-link wcf-rec-name" onClick={() => openPlayerCard(h.playerId)}>{h.name}</button>
                                  <span className="wcf-rec-date">{h.goals} goals · {fmtDate(h.date)}</span>
                                </>,
                                [{ playerId: h.playerId, name: h.name }]
                              )
                            )}
                            {r.hatTricks.length > 5 && (
                              <button className="wcf-rec-more" onClick={() => setShowAllHatTricks((v) => !v)}>
                                {showAllHatTricks ? "Show fewer" : `Show all ${r.hatTricks.length}`}
                              </button>
                            )}
                          </>
                        )}

                        {r.sellOut.soldOut > 0 && (
                          <>
                            <div className="wcf-rec-group">Booking</div>
                            {r.sellOut.averageDays !== null &&
                              row("avg", `${Math.round(r.sellOut.averageDays)}d`, "Games usually sell out", <>about {days(r.sellOut.averageDays)} before kickoff ({r.sellOut.soldOut} of {r.sellOut.of} sold out)</>)}
                            {r.sellOut.earliest &&
                              row("early", `${Math.round(r.sellOut.earliest.days)}d`, "Earliest sell-out", <>{days(r.sellOut.earliest.days)} before kickoff<span className="wcf-rec-date"> · {fmtDate(r.sellOut.earliest.date)}</span></>)}
                          </>
                        )}
                      </>
                    )}
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

                {filteredResults.length === 0 && (scoredPastGames.length === 0 ? <EmptyScene kind="results" title="No results yet" text="The first score lands here at full time." /> : <p className="wcf-empty">No results yet.</p>)}
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
                  const votingOpen = motmVotingOpen(g);
                  const tally = motmTallyByGame[g.id] ?? {};
                  const totalVotes = Object.values(tally).reduce((sum, n) => sum + n, 0);
                  const myVote = myMotmVoteByGame[g.id];
                  const ranked = candidates
                    .map((c) => ({ candidate: c, votes: tally[c.player_id] ?? 0 }))
                    .sort((a, b) => b.votes - a.votes);
                  const topVotes = ranked[0]?.votes ?? 0;
                  // Winners under the club's rule (a tie on votes goes to more goals).
                  const winnerIds = motmWinnerIdsByGame[g.id] ?? [];
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
                    <article key={g.id} id={"result-" + g.id} className={"wcf-result" + (resultIndex === 0 ? " featured" : "")}>
                      <button className="wcf-result-toggle" onClick={() => setExpandedResultId(expanded ? null : g.id)} aria-expanded={expanded}>
                        {(() => {
                          const w = g.team_white_score ?? 0;
                          const r = g.team_red_score ?? 0;
                          const outcome = w > r ? "white" : r > w ? "red" : "draw";
                          const d = new Date(g.date + "T12:00:00Z");
                          const motmNames = !votingOpen ? ranked.filter((x) => winnerIds.includes(x.candidate.player_id)).map((x) => x.candidate.player.display_name) : [];
                          const top = scorers[0] && scorers[0].goals >= 2 ? scorers[0] : null;
                          const away = g.venue !== mainResultsVenue;
                          return (
                            <div className="wcf-res-row">
                              <div className="wcf-res-date">
                                <b>{d.getUTCDate()}</b>
                                <span>{d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase()}</span>
                              </div>
                              <div className="wcf-res-mid">
                                <div className="wcf-res-score">
                                  <span style={{ color: cs.team_white_color }}>{w}</span>
                                  <span className="wcf-result-dash">–</span>
                                  <span style={{ color: cs.team_red_color }}>{r}</span>
                                  <span
                                    className={"wcf-res-pill " + outcome}
                                    style={outcome === "white" ? { background: cs.team_white_color } : outcome === "red" ? { background: cs.team_red_color } : undefined}
                                  >
                                    {outcome === "draw" ? "Draw" : `${outcome === "white" ? cs.team_white_name : cs.team_red_name} win`}
                                  </span>
                                </div>
                                <div className="wcf-res-meta">
                                  {votingOpen ? (
                                    <span className="wcf-res-open">MOTM voting open</span>
                                  ) : motmNames.length > 0 ? (
                                    <>MOTM <b>{motmNames.join(" & ")}</b></>
                                  ) : null}
                                  {top && <>{(votingOpen || motmNames.length > 0) && " · "}{top.player.display_name} {top.goals}</>}
                                  {away && <>{(votingOpen || motmNames.length > 0 || top) && " · "}{g.venue}</>}
                                  {!votingOpen && motmNames.length === 0 && !top && !away && fmtDate(g.date)}
                                </div>
                              </div>
                              <svg className={"wcf-res-chev" + (expanded ? " open" : "")} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                            </div>
                          );
                        })()}
                      </button>

                      {expanded && (
                        <div className="wcf-result-detail">
                          {scorers.length > 0 && (
                            <div className="wcf-result-goals">
                              {([
                                ["white", whiteScorers, cs.team_white_name, cs.team_white_color, g.team_white_score],
                                ["red", redScorers, cs.team_red_name, cs.team_red_color, g.team_red_score],
                              ] as const).map(([side, list, teamName, color, score]) => (
                                <div key={side} className="wcf-result-goals-col">
                                  <div className="wcf-result-goals-head">
                                    <span className="wcf-h2h-dot" style={{ background: color }} />
                                    {teamName}
                                    <b>{score}</b>
                                  </div>
                                  {list.map((s) => (
                                    <div key={s.id} className="wcf-result-goal-row">
                                      <button className="wcf-name-link" onClick={() => openPlayerCard(s.player_id)}>{s.player.display_name}</button>
                                      <b>{s.goals}</b>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
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

                          {votingOpen && candidates.length > 0 && (() => {
                            const closes = motmClosesLabel(g);
                            if (!playedIn(g, myId)) {
                              return (
                                <div className="wcf-vote-note">
                                  Voting&apos;s for the {candidates.length} who played · result at <b>{closes}</b>
                                </div>
                              );
                            }
                            const goalsOf = (id: string) => scorers.find((s) => s.player_id === id)?.goals ?? 0;
                            // Scorers first, then A-Z; you go last in your own team.
                            const byGoals = (a: BookingRow, b: BookingRow) =>
                              Number(a.player_id === myId) - Number(b.player_id === myId) ||
                              goalsOf(b.player_id) - goalsOf(a.player_id) ||
                              a.player.display_name.localeCompare(b.player.display_name);
                            const groups = [
                              { key: "white", name: cs.team_white_name, color: cs.team_white_color, list: candidates.filter((c) => c.team === "white").sort(byGoals) },
                              { key: "red", name: cs.team_red_name, color: cs.team_red_color, list: candidates.filter((c) => c.team === "red").sort(byGoals) },
                              { key: "none", name: "Also played", color: "var(--dim)", list: candidates.filter((c) => c.team !== "white" && c.team !== "red").sort(byGoals) },
                            ].filter((grp) => grp.list.length > 0);
                            const pickName = myVote ? candidates.find((c) => c.player_id === myVote)?.player.display_name : null;
                            return (
                              <div className="wcf-vote">
                                <div className="wcf-vote-head">
                                  <div className="wcf-vote-k">Vote Man of the Match</div>
                                  <div className="wcf-vote-meta">
                                    Closes <b>{closes}</b> · {motmTimeLeft(g)} left · <b>{motmBallotCounts[g.id] ?? totalVotes}</b> of {candidates.length} voted
                                  </div>
                                </div>
                                <div className="wcf-vote-teams">
                                  {groups.map((grp) => (
                                    <div key={grp.key} className={"wcf-vote-col" + (grp.key === "none" ? " wide" : "")}>
                                      <div className="wcf-vote-col-h">
                                        <span className="wcf-h2h-dot" style={{ background: grp.color }} />
                                        {grp.name}
                                      </div>
                                      {grp.list.map((c) => {
                                        const isMe = c.player_id === myId;
                                        const picked = myVote === c.player_id;
                                        const goals = goalsOf(c.player_id);
                                        return (
                                          <button
                                            key={c.id}
                                            className={"wcf-vote-pick" + (picked ? " picked" : "") + (isMe ? " me" : "")}
                                            disabled={isMe}
                                            onClick={() => castMotmVote(g.id, c.player_id, c.player.display_name)}
                                          >
                                            <Avatar name={c.player.display_name} avatarUrl={avatarByPlayerId.get(c.player_id)} className="wcf-vote-av" background={avatarFor(c.player.display_name).gradient} />
                                            <span className="wcf-vote-who">
                                              <span className="wcf-vote-name">{isMe ? "You" : c.player.display_name}</span>
                                              {goals > 0 && <span className="wcf-vote-goals">{goals} {goals === 1 ? "goal" : "goals"}</span>}
                                            </span>
                                            {picked && justVoted?.gameId === g.id && justVoted.candidateId === c.player_id && <MotmMedal key={justVoted.n} className="wcf-vote-medal" />}
                                            {picked && <span className="wcf-vote-tick" aria-label="Your vote">✓</span>}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  ))}
                                </div>
                                {pickName && (() => {
                                  const myTag = motmVotes.find((v) => v.game_id === g.id && v.voter_id === myId)?.tag ?? null;
                                  return (
                                    <div className="wcf-why">
                                      <div className="wcf-why-q">Why {pickName.split(" ")[0]}?</div>
                                      <div className="wcf-why-s">Optional · anonymous · pick one</div>
                                      <div className="wcf-why-tags">
                                        {MOTM_TAGS.map((t) => (
                                          <button key={t.key} className={"wcf-why-tag" + (myTag === t.key ? " on" : "")} onClick={() => setMotmVoteTag(g.id, myTag === t.key ? null : t.key)} aria-pressed={myTag === t.key}>
                                            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{t.icon}</svg>
                                            <b>{t.label}</b>
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })()}
                                <div className="wcf-vote-foot">
                                  {pickName ? (
                                    <>
                                      You voted for <b>{pickName}</b>
                                      {(() => {
                                        const t = MOTM_TAGS.find((x) => x.key === motmVotes.find((v) => v.game_id === g.id && v.voter_id === myId)?.tag);
                                        return t ? <> · {t.label}</> : null;
                                      })()}
                                      . Tap someone else to change it. The result&apos;s out at {closes}.
                                    </>
                                  ) : (
                                    <>Tap a player to vote. You can&apos;t vote for yourself. The result&apos;s out at {closes}.</>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {!votingOpen && totalVotes > 0 && (() => {
                            const winners = ranked.filter((x) => winnerIds.includes(x.candidate.player_id));
                            const winVotes = winners[0]?.votes ?? topVotes;
                            const teamLabel = (t: string | null) => (t === "white" ? cs.team_white_name : t === "red" ? cs.team_red_name : null);
                            const winnerTeams = [...new Set(winners.map((w) => teamLabel(w.candidate.team)).filter(Boolean))];
                            // Same gold family as Player of the Month: the winner's
                            // face up top, then every player who got a vote.
                            const recent = kickoffCutoff(g.date, g.kickoff, MOTM_VOTE_WINDOW_MINUTES + 7 * 24 * 60) > nowUk;
                            return (
                              <MotmReveal storageKey={`wcf-motm-reveal-${myId}-${g.id}`} eligible={recent}>
                              {(phase, skip, replay) => phase === "drum" ? (
                              <div className="wcf-motm-card wcf-mr-drumming" onPointerDown={skip}>
                                <div className="wcf-motm-card-k">{winners.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</div>
                                <div className="wcf-motm-card-main">
                                  <div className="wcf-motm-card-faces"><span className="wcf-motm-card-face wcf-mr-mystery">?</span></div>
                                  <div className="wcf-mr-wait">And it goes to<span className="wcf-mr-drum"><i /><i /><i /></span></div>
                                </div>
                              </div>
                              ) : (
                              <div className={"wcf-motm-card" + (phase === "reveal" ? " wcf-mr-reveal" : "")}>
                                <div className="wcf-motm-card-k">{winners.length > 1 ? "Joint Man of the Match" : "Man of the Match"}</div>
                                <div className="wcf-motm-card-main">
                                  <div className="wcf-motm-card-faces">
                                    {phase === "reveal" && (
                                      <span className="wcf-mr-rays" aria-hidden="true">
                                        {Array.from({ length: 10 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 36}deg` }} />)}
                                      </span>
                                    )}
                                    {winners.slice(0, 2).map((w) => (
                                      <Avatar key={w.candidate.id} name={w.candidate.player.display_name} avatarUrl={avatarByPlayerId.get(w.candidate.player_id)} className="wcf-motm-card-face" background={avatarFor(w.candidate.player.display_name).gradient} />
                                    ))}
                                  </div>
                                  <div className="wcf-motm-card-who">
                                    <div className="wcf-motm-card-names">
                                      {winners.map((w, i) => (
                                        <button key={w.candidate.id} className="wcf-motm-card-name" onClick={() => openPlayerCard(w.candidate.player_id)}>
                                          {w.candidate.player.display_name}
                                          {i < winners.length - 1 ? <span className="wcf-motm-card-amp"> &amp;</span> : null}
                                        </button>
                                      ))}
                                    </div>
                                    <div className="wcf-motm-card-sub">
                                      <b>{winVotes} of {totalVotes} votes</b>
                                      {winnerTeams.length > 0 && ` · ${winnerTeams.join(" & ")}`}
                                    </div>
                                  </div>
                                </div>
                                <div className="wcf-motm-rank">
                                  {ranked.filter((x) => x.votes > 0).map((x, rkIndex) => {
                                    const voters = votersFor(x.candidate.player_id);
                                    const top = winnerIds.includes(x.candidate.player_id);
                                    return (
                                      <button
                                        key={x.candidate.id}
                                        style={{ ["--i" as string]: rkIndex }}
                                        className={"wcf-motm-rk" + (top ? " top" : "")}
                                        onClick={() => setMotmVotersFor({ gameId: g.id, candidateId: x.candidate.player_id, candidateName: x.candidate.player.display_name })}
                                        aria-label={`See who voted for ${x.candidate.player.display_name}`}
                                      >
                                        <Avatar name={x.candidate.player.display_name} avatarUrl={avatarByPlayerId.get(x.candidate.player_id)} className="wcf-motm-rk-av" background={avatarFor(x.candidate.player.display_name).gradient} />
                                        <span className="wcf-motm-rk-mid">
                                          <span className="wcf-motm-rk-name">{x.candidate.player.display_name}</span>
                                          <span className="wcf-motm-rk-bar"><i style={{ width: `${Math.max(8, (x.votes / topVotes) * 100)}%` }} /></span>
                                        </span>
                                        <span className="wcf-avatars wcf-motm-rk-voters">
                                          {voters.slice(0, 3).map((v) => (
                                            <Avatar key={v.id} name={v.display_name} avatarUrl={v.avatar_url} className="wcf-avatar-chip" background={avatarFor(v.display_name).gradient} />
                                          ))}
                                          {voters.length > 3 && <span className="wcf-avatar-chip more">+{voters.length - 3}</span>}
                                        </span>
                                        <span className="wcf-motm-rk-n">{x.votes}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                                <div className="wcf-motm-card-tip">
                                  Tap a name to see who voted for them
                                  {replay && <> · <button className="wcf-mr-again" onClick={replay}>Watch the reveal again</button></>}
                                </div>
                              </div>
                              )}
                              </MotmReveal>
                            );
                          })()}

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
                                          Your guess: <b>{cs.team_white_name} {myGamePrediction.predictedWhite}–{myGamePrediction.predictedRed} {cs.team_red_name}</b>
                                        </span>
                                        <PointsPill pts={pts} storageKey={`wcf-pts-${myId}-${g.id}`} recent={kickoffCutoff(g.date, g.kickoff, 7 * 24 * 60) > nowUk} />
                                      </div>
                                    );
                                  })()}
                                {exactCount > 0 && (
                                  <div className="wcf-predict-fact">
                                    {exactCount} player{exactCount === 1 ? "" : "s"} called the exact score.
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {isAdmin && (
                            <div className="wcf-result-share">
                              <button className="wcf-result-share-btn" onClick={() => shareResult(g)}><svg className="wcf-share-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>Share result</button>
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
                const x = (i / Math.max(series.length - 1, 1)) * 300;
                const y = 74 - ((v - lo) / Math.max(hi - lo, 1)) * 66;
                return `${Math.round(x)},${Math.round(y)}`;
              };
              const sparkLine = series.map(pt).join(" ");
              const sparkFill = `0,80 ${sparkLine} 300,80`;
              const gameEntries = potLedger.filter((e) => e.kind === "auto");
              const lastGame = gameEntries[0];
              const firstDate = chronological[0]?.date;
              const shortDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
              const spent = (Object.keys(financeSummary.byCategory) as PotCategory[]).filter((c) => c !== "pitch" && financeSummary.byCategory[c] > 0);
              const money = (n: number) => `${n < 0 ? "−" : ""}£${Math.abs(n) % 1 === 0 ? Math.abs(n).toFixed(0) : Math.abs(n).toFixed(2)}`;

              return (
                <>
                  {/* Everyone sees the pot grow game by game; the amounts are
                      the club's (fees in minus pitch hire), never anyone's
                      own payment. */}
                  <div className="wcf-pot-hero">
                    <div className="wcf-pot-hero-k">Community pot</div>
                    <PotAmountJar total={potTotal} money={money} last={lastGame ? { id: lastGame.id, amount: lastGame.amount, paid: (lastGame as { paid?: number }).paid } : undefined} storageKey={`wcf-pot-seen-${myId}`} />
                    {lastGame && (
                      <div className="wcf-pot-hero-sub">
                        <b>{lastGame.amount >= 0 ? "+" : ""}{money(lastGame.amount)}</b> from {fmtDate(lastGame.date)} · <b>{gameEntries.length}</b> {gameEntries.length === 1 ? "game" : "games"}
                        {firstDate ? ` since ${shortDate(firstDate)}` : ""}
                      </div>
                    )}
                    {series.length > 1 && (
                      <>
                        <svg viewBox="0 0 300 80" preserveAspectRatio="none" className="wcf-pot-hero-spark" aria-hidden="true">
                          <polygon points={sparkFill} fill="rgba(34,197,94,.16)" />
                          <polyline points={sparkLine} fill="none" stroke="#22c55e" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                        </svg>
                        <div className="wcf-pot-hero-axis"><span>{shortDate(chronological[0].date)}</span><span>{shortDate(chronological[chronological.length - 1].date)}</span></div>
                      </>
                    )}
                  </div>

                  {!isAdmin && (
                    <>
                      <div className="wcf-pot-card">
                        <div className="wcf-pot-card-h">So far</div>
                        <div className="wcf-pot-split">
                          <span><b>{money(financeSummary.income)}</b>{potEntries.some((e) => e.amount > 0) ? "Money in" : "Match fees"}</span>
                          <span><b className="out">{money(-financeSummary.expenses)}</b>{spent.length > 0 ? "Money out" : "Pitch hire"}</span>
                          <span><b className="in">{money(potTotal)}</b>In the pot</span>
                        </div>
                      </div>
                      {gameEntries.length > 0 && (
                        <div className="wcf-pot-card">
                          <div className="wcf-pot-card-h">
                            Latest games
                            <span>avg {money(gameEntries.reduce((sum, e) => sum + e.amount, 0) / gameEntries.length)}</span>
                          </div>
                          {gameEntries.slice(0, 3).map((e) => (
                            <div key={e.id} className="wcf-pot-led">
                              <div>
                                {fmtDate(e.date)}
                                <div className="wcf-pot-led-sub">{e.paid} paid</div>
                              </div>
                              <span className={e.amount < 0 ? "out" : ""}>{e.amount >= 0 ? "+" : ""}{money(e.amount)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="wcf-pot-card">
                        <div className="wcf-pot-card-h">Where it&apos;s gone</div>
                        {spent.length === 0 ? (
                          <p className="wcf-pot-empty">Nothing spent yet. The pot goes towards equipment, socials and running the club, and anything spent will show here.</p>
                        ) : (
                          potEntries
                            .filter((e) => e.amount < 0)
                            .slice(0, 5)
                            .map((e) => (
                              <div key={e.id} className="wcf-pot-led">
                                <div>
                                  {e.description}
                                  <div className="wcf-pot-led-sub">{POT_CATEGORY_LABEL[e.category]} · {fmtDate(e.created_at.slice(0, 10))}</div>
                                </div>
                                <span className="out">{money(e.amount)}</span>
                              </div>
                            ))
                        )}
                      </div>
                    </>
                  )}

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
                    {potLedger.length > 0 && <p className="wcf-pot-auto-note">Match surpluses are added automatically once each fixture has been played.</p>}

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
            newMembers={
              isAdmin ? (
                <NewMembersSection
                  requireApproval={!!cs.require_approval}
                  available={cs.require_approval !== undefined}
                  onSetRequireApproval={setRequireApproval}
                  members={pendingMembers}
                  justLetIn={justLetIn}
                  onDismissLetIn={(id) => setJustLetIn((cur) => cur.filter((j) => j.id !== id))}
                  onDecide={decideMember}
                />
              ) : null
            }
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
            myEmergencyContact={emergencyContacts.find((c) => c.player_id === myId) ?? null}
            onSaveEmergencyContact={saveEmergencyContact}
            myBirthday={birthdays.find((b) => b.player_id === myId) ?? null}
            onSaveBirthday={saveBirthday}
            ratingPlayerId={ratingPlayerId}
            onToggleRatingPlayer={(id) => setRatingPlayerId((cur) => (cur === id ? null : id))}
            myRecord={myRecord}
            myGoals={myGoalsAllTime}
            onOpenMyCard={() => openPlayerCard(myId)}
            myUpcomingBookings={myUpcomingBookings}
            myTabOwed={myTabOwed}
            myTabPending={myTabPending}
            onMarkPaid={markPaid}
            askConfirm={askConfirm}
            messages={adminMessages}
            onMarkMessageRead={markMessageRead}
            onMarkAllRead={markAllMessagesRead}
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

      {wrappedOpen && wrapped && (
        <WrappedStory
          {...wrapped}
          extras={wrappedExtras}
          whiteName={cs.team_white_name}
          redName={cs.team_red_name}
          whiteColor={cs.team_white_color}
          redColor={cs.team_red_color}
          avatarFor={(id) => avatarByPlayerId.get(id) ?? null}
          nameFor={(id) => profiles.find((p) => p.id === id)?.display_name ?? ""}
          myId={myId}
          onClose={() => setWrappedOpen(false)}
          onShare={shareWrapped}
          onFinished={() => trackWrapped("finished")}
          playIntro={wrappedIntroDue}
          onIntroSeen={() => {
            try {
              localStorage.setItem(`wcf-wrapped-intro-${myId}-${wrappedMonthKey}`, "true");
            } catch {}
          }}
          onBook={() => {
            setWrappedOpen(false);
            setTab("fixtures");
            window.scrollTo({ top: 0 });
          }}
          onBootRoom={() => {
            setWrappedOpen(false);
            setFeedView("bootroom");
            setTab("feed");
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      {isAdmin && myId && <GaffAIChat getFreshAccessToken={getFreshAccessToken} onFixtureCreated={loadGames} myId={myId} myName={myProfile?.display_name ?? ""} askConfirm={askConfirm} />}

      {playerCardId && (() => {
        const cardProfile = profiles.find((p) => p.id === playerCardId);
        if (!cardProfile) return null;
        const stats = playerCardStats[playerCardId] ?? { apps: 0, goals: 0, motm: 0 };
        const canSeeRating = isAdmin || playerCardId === myId;
        const rating = canSeeRating ? ratingByPlayer[playerCardId] ?? null : null;
        const emergencyContact = canSeeRating ? emergencyContacts.find((c) => c.player_id === playerCardId) ?? null : null;
        const appsRank = playerStats.findIndex((p) => p.id === playerCardId) + 1;
        // This season, for the card's record / form / bests sections.
        const seasonGames = [...pastGames]
          .filter((g) => g.date.slice(0, 4) === String(currentSeasonYear) && g.team_white_score != null && g.team_red_score != null)
          .sort((x, y) => x.date.localeCompare(y.date) || x.kickoff.localeCompare(y.kickoff));
        const results: ("W" | "D" | "L")[] = [];
        for (const g of seasonGames) {
          const bk = g.bookings.find((b) => b.player_id === playerCardId && !b.waiting && b.team);
          if (!bk) continue;
          const w = g.team_white_score!;
          const rr = g.team_red_score!;
          results.push(w === rr ? "D" : (bk.team === "white") === w > rr ? "W" : "L");
        }
        const pb = computePersonalBests(
          { games: seasonGames.filter((g) => g.team_white_score != null && g.team_red_score != null), goals: goalRows, motmTallyByGame: closedMotmTallies, names: () => "" },
          playerCardId
        );
        const topGoals = Math.max(0, ...playerStats.map((p) => p.goals));
        const cardSeason = {
          W: results.filter((x) => x === "W").length,
          D: results.filter((x) => x === "D").length,
          L: results.filter((x) => x === "L").length,
          form: results.slice(-5),
          bestGoals: pb.mostGoals,
          hatTricks: pb.hatTricks,
          topScorer: topGoals > 0 && stats.goals === topGoals,
        };
        return (
          <PlayerCardModal
            key={playerCardId}
            profile={cardProfile}
            stats={stats}
            rating={rating}
            emergencyContact={emergencyContact}
            canSeeRating={canSeeRating}
            isOwnCard={playerCardId === myId}
            rank={appsRank > 0 ? appsRank : null}
            team={playerCardTeam}
            season={cardSeason}
            appsMilestone={appsMilestoneFor(playerCardId)}
            onClose={() => { setPlayerCardId(null); setPlayerCardTeam(null); }}
          />
        );
      })()}

      {ftBand && (() => {
        const g = games.find((x) => `game-${x.id}-fulltime` === ftBand);
        return (
          <div className="wcf-ft-band" aria-hidden>
            <b>
              <svg viewBox="0 0 40 40" fill="#fff"><path d="M6 18a10 10 0 1 0 19.6 3H36v-7H16.5A10 10 0 0 0 6 18z" /><circle cx="16" cy="21" r="3.2" fill="#b8202c" /><rect x="24" y="9" width="4" height="6" rx="1" /></svg>
              FULL TIME
            </b>
            <small>{cs.team_white_name} v {cs.team_red_name}{g ? ` · ${fmtDate(g.date)}` : ""}</small>
          </div>
        );
      })()}
      {promoGame && showMoment("promo") && (
        <SubBoard
          number={promoGame.bookings.filter((b) => !b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)).findIndex((b) => b.player_id === myId) + 1 || promoGame.max_players}
          label={`${new Date(promoGame.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase()} · ${promoGame.kickoff} · ${promoGame.venue.toUpperCase()}`}
          onDone={() => { const id = promoGame.id; setPromoShow(null); setTicketShow({ mode: "booked", gameIds: [id] }); }}
        />
      )}
      {nextBigMoment && showMoment("big") && (
        <BigMomentView key={nextBigMoment.key} m={nextBigMoment} onDone={() => bigMomentDone(nextBigMoment)} />
      )}
      {myRecordMoment && showMoment("record") && (
        <RecordMoment
          value={myRecordMoment.value}
          label={myRecordMoment.label}
          balls={myRecordMoment.balls}
          prev={myRecordMoment.prev}
          dateLabel={myRecordMoment.dateLabel}
          scoreLine={myRecordMoment.scoreLine}
          onDone={recordMomentClose}
        />
      )}
      {fxCalendar && showMoment("fx") && (
        <FixturesCalendar month={fxCalendar.month} dates={fxCalendar.dates} total={fxCalendar.ids.length} onDone={fxCalendarDone} />
      )}
      {predLock && showMoment("predlock") && (
        <PredictionLock
          key={predLock.key}
          value={predLock.value}
          onDone={() => {
            try {
              localStorage.setItem(predLock.key, "1");
            } catch {}
            setPredLockShown(predLock.key);
          }}
        />
      )}
      {envelope && showMoment("envelope") && (
        <AdminEnvelope
          items={envelope.items}
          onDone={() => {
            setEnvelope(null);
            setTab("account");
          }}
        />
      )}
      {specialGame && showMoment("special") && (
        <SpecialPoster
          date={new Date(specialGame.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })}
          kickoff={specialGame.kickoff}
          pitch={specialGame.pitch}
          venue={specialGame.venue}
          price={specialGame.price}
          players={specialGame.max_players}
          onDone={() => specialDone(specialGame.id)}
        />
      )}
      {ticketShow && ticketGames.length > 0 && (ticketShow.mode === "booked" || showMoment("ticket")) && <MatchTickets key={ticketShow.mode + ticketShow.gameIds.join(",")} mode={ticketShow.mode} games={ticketGames} onDone={() => setTicketShow(null)} />}
      {potmShow === "everyone" && playerOfMonth && showMoment("potm") && (
        <PotmIntro
          month={playerOfMonth.monthLabel.split(" ")[0]}
          prevMonth={new Date(previousMonthKey(playerOfMonth.monthKey + "-15") + "-01T12:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })}
          names={playerOfMonth.winners.map((w) => w.name.split(" ")[0]).join(" & ")}
          onDone={potmDone}
        />
      )}
      {potmShow === "winner" && playerOfMonth && showMoment("potm") && (() => {
        const me = playerOfMonth.winners.find((w) => w.id === myId);
        return me ? <PotmWinner monthLabel={playerOfMonth.monthLabel} joint={playerOfMonth.winners.length > 1} wins={me.wins} votes={me.votes} onDone={potmDone} /> : null;
      })()}

      {myMotmMoment && motmMomentClosed !== myMotmMoment.game.id && showMoment("motm") && (
        <MotmWinnerMoment
          dateLabel={new Date(myMotmMoment.game.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase()}
          scoreLabel={`${myMotmMoment.game.team_white_score}–${myMotmMoment.game.team_red_score}`}
          votes={myMotmMoment.votes}
          total={myMotmMoment.total}
          goals={myMotmMoment.goals}
          joint={myMotmMoment.joint}
          onSee={() => { setMotmMomentClosed(myMotmMoment.game.id); goToResult(myMotmMoment.game.id); }}
          onClose={() => setMotmMomentClosed(myMotmMoment.game.id)}
        />
      )}

      {rateSheetFor && rateGame && rateSheetFor === rateGame.id && (
        <RateGameSheet
          game={rateGame}
          cs={cs}
          rating={myRatings[rateGame.id] ?? 0}
          votingOpen={motmVotingOpen(rateGame)}
          summary={rateSummary}
          onRate={(n) => submitRating(rateGame.id, n)}
          onVote={() => { closeRateSheet(); goToResult(rateGame.id); }}
          onClose={closeRateSheet}
        />
      )}

      {fixtureSheet && (fixtureSheet.mode === "add" || games.some((g) => g.id === fixtureSheet.id)) && (
        <FixtureSheet
          mode={fixtureSheet.mode}
          game={fixtureSheet.mode === "edit" ? games.find((g) => g.id === fixtureSheet.id) : undefined}
          cs={cs}
          games={games}
          onCreate={createFixtures}
          onSave={saveFixture}
          onDelete={deleteGame}
          onClose={() => setFixtureSheet(null)}
          askConfirm={askConfirm}
        />
      )}

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
// The one sheet for adding and editing fixtures (admins): one game or a
// weekly run, with tap-to-pick kickoff/venue/format, +/- for price and
// places, the Special switch, and a live preview. Replaced the old
// "Generate fixtures" dialog plus the inline edit form.
type FixtureDraft = {
  date: string;
  kickoff: string;
  venue: string;
  pitch: string;
  price: number;
  max_players: number;
  pitch_cost: number;
  special?: boolean;
};
const FORMAT_PLACES: Record<string, number> = { "5-a-side": 10, "6-a-side": 12, "7-a-side": 14, "8-a-side": 16, "11-a-side": 22 };
const FIXTURE_MAX_PLACES = 30;

function FixtureSheet({
  mode,
  game,
  cs,
  games,
  onCreate,
  onSave,
  onDelete,
  onClose,
  askConfirm,
}: {
  mode: "add" | "edit";
  game?: GameRow;
  cs: ClubSettings;
  games: GameRow[];
  onCreate: (rows: FixtureDraft[], post: boolean) => Promise<void>;
  onSave: (id: string, patch: FixtureDraft, post: boolean) => Promise<void>;
  onDelete: (id: string) => void;
  onClose: () => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const todayStr = nowInLondon().slice(0, 10);
  const addDays = (d: string, n: number) => {
    const x = new Date(d + "T12:00:00Z");
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const isSunday = (d: string) => new Date(d + "T12:00:00Z").getUTCDay() === 0;
  const [tab, setTab] = useState<"one" | "weekly">("one");
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<FixtureDraft>(() =>
    game
      ? { date: game.date, kickoff: game.kickoff, venue: game.venue, pitch: game.pitch, price: game.price, max_players: game.max_players, pitch_cost: game.pitch_cost, special: !!game.special }
      : {
          date: addDays(todayStr, 1),
          kickoff: cs.default_kickoff,
          venue: cs.default_venue,
          pitch: cs.default_pitch,
          price: cs.default_price,
          max_players: cs.default_max_players,
          pitch_cost: defaultPitchCost(addDays(todayStr, 1)),
          special: false,
        }
  );
  const [pitchCostTouched, setPitchCostTouched] = useState(!!game);
  const [showPitchCost, setShowPitchCost] = useState(false);
  const [otherTime, setOtherTime] = useState(false);
  const [otherVenue, setOtherVenue] = useState(false);
  const [pickDate, setPickDate] = useState(false);
  // Weekly
  const [weekDays, setWeekDays] = useState<Set<number>>(new Set([1, 4]));
  // "Every week": a From–To range (quick picks or custom) and individual
  // dates you can tap to skip, e.g. Bonfire Night or Christmas Eve.
  const monthEnd = (d: string) => {
    const x = new Date(d.slice(0, 7) + "-01T12:00:00Z");
    x.setUTCMonth(x.getUTCMonth() + 1);
    x.setUTCDate(0);
    return x.toISOString().slice(0, 10);
  };
  const monthStartAfter = (d: string, n: number) => {
    const x = new Date(d.slice(0, 7) + "-01T12:00:00Z");
    x.setUTCMonth(x.getUTCMonth() + n);
    return x.toISOString().slice(0, 10);
  };
  const monthName = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const rangePresets: { key: string; label: string; from: string; to: string }[] = [
    { key: "n4", label: "Next 4 weeks", from: addDays(todayStr, 1), to: addDays(todayStr, 28) },
    { key: "rest", label: `Rest of ${monthName(todayStr).slice(0, 3)}`, from: addDays(todayStr, 1), to: monthEnd(todayStr) },
    { key: "m1", label: monthName(monthStartAfter(todayStr, 1)), from: monthStartAfter(todayStr, 1), to: monthEnd(monthStartAfter(todayStr, 1)) },
    { key: "m2", label: monthName(monthStartAfter(todayStr, 2)), from: monthStartAfter(todayStr, 2), to: monthEnd(monthStartAfter(todayStr, 2)) },
  ];
  const [rangeKey, setRangeKey] = useState("n4");
  const [rangeFrom, setRangeFrom] = useState(addDays(todayStr, 1));
  const [rangeTo, setRangeTo] = useState(addDays(todayStr, 28));
  const [skipDates, setSkipDates] = useState<Set<string>>(new Set());
  const pickRange = (key: string) => {
    setRangeKey(key);
    setSkipDates(new Set());
    const p = rangePresets.find((x) => x.key === key);
    if (p) {
      setRangeFrom(p.from);
      setRangeTo(p.to);
    }
  };

  const gameDates = new Set(games.filter((g) => g.id !== game?.id).map((g) => g.date));
  const kickoffs = [...new Set([cs.default_kickoff, "12:00", "19:00", "20:00", "21:00", ...games.map((g) => g.kickoff)])].filter(Boolean).sort().slice(0, 6);
  // Your most-used venues (spacing/case duplicates merged), default first.
  const venues = (() => {
    const count = new Map<string, { name: string; n: number }>();
    for (const v of [cs.default_venue, ...games.map((g) => g.venue)]) {
      const name = (v ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = count.get(key);
      count.set(key, { name: cur?.name ?? name, n: (cur?.n ?? 0) + 1 });
    }
    const def = (cs.default_venue ?? "").trim().toLowerCase();
    return [...count.entries()].sort((x, y) => Number(y[0] === def) - Number(x[0] === def) || y[1].n - x[1].n).slice(0, 3).map(([, v]) => v.name);
  })();
  const formats = ["5-a-side", "7-a-side", "8-a-side", "11-a-side"];
  const set = (patch: Partial<FixtureDraft>) => setF((cur) => ({ ...cur, ...patch }));

  function pickOneDate(date: string) {
    const patch: Partial<FixtureDraft> = { date };
    if (!pitchCostTouched) patch.pitch_cost = defaultPitchCost(date);
    // Sundays are specials by default, with the 11-a-side defaults.
    if (isSunday(date) && !f.special && mode === "add") Object.assign(patch, SPECIAL_DEFAULTS, { special: true });
    set(patch);
  }

  const strip = Array.from({ length: 21 }, (_, i) => addDays(todayStr, i));
  const weeklyDates = (() => {
    if (tab !== "weekly") return [] as string[];
    const start = rangeFrom > todayStr ? rangeFrom : addDays(todayStr, 1);
    const out: string[] = [];
    for (let d = start; d <= rangeTo && out.length < 120; d = addDays(d, 1)) if (weekDays.has(new Date(d + "T12:00:00Z").getUTCDay())) out.push(d);
    return out;
  })();
  const weeklyNew = weeklyDates.filter((d) => !gameDates.has(d) && !skipDates.has(d));
  const weeklySkipped = weeklyDates.filter((d) => gameDates.has(d)).length;
  const weeklyUserSkipped = weeklyDates.filter((d) => !gameDates.has(d) && skipDates.has(d)).length;
  const shortDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

  async function submit(post: boolean) {
    setBusy(true);
    if (mode === "edit" && game) await onSave(game.id, f, post);
    else if (tab === "one") await onCreate([f], post);
    else await onCreate(weeklyNew.map((date) => ({ ...f, date, pitch_cost: pitchCostTouched ? f.pitch_cost : defaultPitchCost(date) })), post);
    setBusy(false);
  }

  const d = new Date(f.date + "T12:00:00Z");
  const canSubmit = !busy && f.venue.trim() && f.pitch.trim() && /^\d{2}:\d{2}$/.test(f.kickoff) && (tab === "one" || mode === "edit" ? !!f.date : weeklyNew.length > 0);
  const title = mode === "edit" ? "Edit fixture" : tab === "one" ? "Add fixture" : "Add fixtures";
  const sub = mode === "edit" ? `${fmtDate(game!.date)} · ${game!.venue}` : tab === "one" ? "Set it all up once, then post when you're ready" : "A run of games in one go";

  return (
    <div className="wcf-fxs-overlay" onClick={() => !busy && onClose()}>
      <div className="wcf-fxs" onClick={(e) => e.stopPropagation()}>
        <div className={"wcf-fxs-photo" + (f.special ? " gold" : "")}>
          <div className="wcf-fxs-handle" />
          <button className="wcf-fxs-x" onClick={onClose} aria-label="Close">✕</button>
          <div className="wcf-fxs-title">
            <b>{title}</b>
            <span>{sub}</span>
          </div>
        </div>
        <div className="wcf-fxs-body">
          {mode === "add" && (
            <div className="wcf-fxs-seg">
              <button className={tab === "one" ? "on" : ""} onClick={() => setTab("one")}>One game</button>
              <button className={tab === "weekly" ? "on" : ""} onClick={() => setTab("weekly")}>Every week</button>
            </div>
          )}

          {(tab === "one" || mode === "edit") && (
            <div>
              <div className="wcf-fxs-lab">
                <span>Date</span>
                <button onClick={() => setPickDate((v) => !v)}>{pickDate ? "Hide" : "Pick another date ›"}</button>
              </div>
              {pickDate ? (
                <input className="wcf-fxs-input" type="date" value={f.date} min={todayStr} onChange={(e) => e.target.value && pickOneDate(e.target.value)} />
              ) : (
                <div className="wcf-fxs-days">
                  {strip.map((day) => {
                    const dd = new Date(day + "T12:00:00Z");
                    return (
                      <button key={day} className={"wcf-fxs-day" + (day === f.date ? " on" : "") + (gameDates.has(day) ? " has" : "")} onClick={() => pickOneDate(day)}>
                        <small>{dd.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toUpperCase()}</small>
                        <b>{dd.getUTCDate()}</b>
                        <i />
                      </button>
                    );
                  })}
                </div>
              )}
              {gameDates.has(f.date) && <div className="wcf-fxs-hint">There&apos;s already a game on {fmtDate(f.date)}; this adds another.</div>}
            </div>
          )}

          {tab === "weekly" && mode === "add" && (
            <>
              <div>
                <div className="wcf-fxs-lab"><span>On</span></div>
                <div className="wcf-fxs-wd">
                  {BATCH_WEEKDAYS.map((w) => (
                    <button
                      key={w.value}
                      className={weekDays.has(w.value) ? "on" : ""}
                      onClick={() =>
                        setWeekDays((cur) => {
                          const next = new Set(cur);
                          if (next.has(w.value)) next.delete(w.value);
                          else next.add(w.value);
                          return next;
                        })
                      }
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="wcf-fxs-lab"><span>When</span></div>
                <div className="wcf-fxs-chips">
                  {rangePresets.map((p) => (
                    <button key={p.key} className={rangeKey === p.key ? "on" : ""} onClick={() => pickRange(p.key)}>{p.label}</button>
                  ))}
                  <button className={rangeKey === "custom" ? "on" : "add"} onClick={() => setRangeKey("custom")}>Custom</button>
                </div>
                {rangeKey === "custom" && (
                  <div className="wcf-fxs-range">
                    <label>From<input className="wcf-fxs-input" type="date" value={rangeFrom} min={addDays(todayStr, 1)} onChange={(e) => e.target.value && setRangeFrom(e.target.value)} /></label>
                    <label>To<input className="wcf-fxs-input" type="date" value={rangeTo} min={rangeFrom} onChange={(e) => e.target.value && setRangeTo(e.target.value)} /></label>
                  </div>
                )}
              </div>
              {weeklyDates.length > 0 && (
                <div>
                  <div className="wcf-fxs-lab"><span>Dates</span><small className="wcf-fxs-tapnote">Tap a date to skip it</small></div>
                  <div className="wcf-fxs-dates">
                    {weeklyDates.map((dt) => {
                      const on = gameDates.has(dt);
                      const skip = skipDates.has(dt);
                      const x = new Date(dt + "T12:00:00Z");
                      return (
                        <button
                          key={dt}
                          className={"wcf-fxs-dt" + (on ? " on" : skip ? " skip" : " new")}
                          disabled={on}
                          onClick={() =>
                            setSkipDates((cur) => {
                              const next = new Set(cur);
                              if (next.has(dt)) next.delete(dt);
                              else next.add(dt);
                              return next;
                            })
                          }
                        >
                          <small>{x.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toUpperCase()}</small>
                          <b>{x.getUTCDate()} {x.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</b>
                          {on && <i>on</i>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div>
            <div className="wcf-fxs-lab"><span>Kickoff</span></div>
            <div className="wcf-fxs-chips">
              {kickoffs.map((k) => (
                <button key={k} className={!otherTime && f.kickoff === k ? "on" : ""} onClick={() => { setOtherTime(false); set({ kickoff: k }); }}>{k}</button>
              ))}
              <button className={otherTime || !kickoffs.includes(f.kickoff) ? "on" : "add"} onClick={() => setOtherTime(true)}>Other</button>
            </div>
            {(otherTime || !kickoffs.includes(f.kickoff)) && <input className="wcf-fxs-input" type="time" value={f.kickoff} onChange={(e) => set({ kickoff: e.target.value })} />}
          </div>

          <div>
            <div className="wcf-fxs-lab"><span>Venue</span></div>
            <div className="wcf-fxs-chips">
              {venues.map((v) => (
                <button key={v} className={!otherVenue && f.venue === v ? "on" : ""} onClick={() => { setOtherVenue(false); set({ venue: v }); }}>{v}</button>
              ))}
              <button className={otherVenue || !venues.includes(f.venue) ? "on" : "add"} onClick={() => { setOtherVenue(true); if (venues.includes(f.venue)) set({ venue: "" }); }}>+ New venue</button>
            </div>
            {(otherVenue || !venues.includes(f.venue)) && (
              <input className="wcf-fxs-input" placeholder="Venue name" value={f.venue} onChange={(e) => set({ venue: e.target.value })} />
            )}
          </div>

          <div>
            <div className="wcf-fxs-lab"><span>Format</span></div>
            <div className="wcf-fxs-chips">
              {formats.map((p) => (
                <button key={p} className={f.pitch === p ? "on" : ""} onClick={() => set({ pitch: p, max_players: FORMAT_PLACES[p] ?? f.max_players })}>{p}</button>
              ))}
            </div>
          </div>

          <div className="wcf-fxs-two">
            <div>
              <div className="wcf-fxs-lab"><span>Price</span></div>
              <div className="wcf-fxs-step">
                <button onClick={() => set({ price: Math.max(0, f.price - 1) })} aria-label="Less">−</button>
                <b>£{f.price}</b>
                <button onClick={() => set({ price: f.price + 1 })} aria-label="More">+</button>
              </div>
            </div>
            <div>
              <div className="wcf-fxs-lab"><span>Places</span></div>
              <div className="wcf-fxs-step">
                <button onClick={() => set({ max_players: Math.max(2, f.max_players - 1) })} aria-label="Fewer">−</button>
                <b>{f.max_players}</b>
                <button onClick={() => set({ max_players: Math.min(FIXTURE_MAX_PLACES, f.max_players + 1) })} aria-label="More">+</button>
              </div>
            </div>
          </div>

          <button className={"wcf-fxs-special" + (f.special ? " on" : "")} onClick={() => set(f.special ? { special: false } : { ...SPECIAL_DEFAULTS, special: true })}>
            <span>
              <b>★ Special fixture</b>
              <small>Shows in gold. On automatically for Sundays.</small>
            </span>
            <i />
          </button>

          <button className="wcf-fxs-more" onClick={() => setShowPitchCost((v) => !v)}>
            <span>Pitch cost £{f.pitch_cost} · per game</span>
            <span>{showPitchCost ? "▾" : "›"}</span>
          </button>
          {showPitchCost && (
            <div className="wcf-fxs-step">
              <button onClick={() => { setPitchCostTouched(true); set({ pitch_cost: Math.max(0, f.pitch_cost - 5) }); }} aria-label="Less">−</button>
              <b>£{f.pitch_cost}</b>
              <button onClick={() => { setPitchCostTouched(true); set({ pitch_cost: f.pitch_cost + 5 }); }} aria-label="More">+</button>
            </div>
          )}

          {tab === "weekly" && mode === "add" ? (
            <div className={"wcf-fxs-sum" + (weeklyNew.length === 0 ? " none" : "")}>
              {weeklyNew.length === 0 ? (
                weeklyDates.length > 0
                  ? `All ${weeklyDates.length} of those days already have a game. Pick other days or a longer range.`
                  : "Pick at least one day."
              ) : (
                <>
                  <b>{weeklyNew.length} game{weeklyNew.length === 1 ? "" : "s"}</b>, {shortDate(weeklyNew[0])} to {shortDate(weeklyNew[weeklyNew.length - 1])}, {f.kickoff} at {f.venue || "…"}, £{f.price}, {f.max_players} places.
                  {weeklySkipped > 0 && ` ${weeklySkipped} day${weeklySkipped === 1 ? " already has" : "s already have"} a game and ${weeklySkipped === 1 ? "is" : "are"} left alone.`}
                  {weeklyUserSkipped > 0 && ` ${weeklyUserSkipped} skipped.`}
                </>
              )}
            </div>
          ) : (
            <div>
              <div className="wcf-fxs-lab"><span>How it&apos;ll look</span></div>
              <div className={"wcf-fxs-preview" + (f.special ? " special" : "")}>
                <div className="wcf-fxs-pdate">
                  <small>{d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toUpperCase()}</small>
                  <b>{d.getUTCDate()}</b>
                </div>
                <div className="wcf-fxs-pdiv" />
                <div className="wcf-fxs-pinfo">
                  <div>{f.kickoff} · {f.venue || "Venue"}</div>
                  <small>{f.pitch} · £{f.price} · 0/{f.max_players}</small>
                </div>
                {!(mode === "edit" && game?.published) && <span className="wcf-fxs-draft">DRAFT</span>}
              </div>
            </div>
          )}
        </div>

        <div className="wcf-fxs-foot">
          {mode === "edit" && game?.published ? (
            <button className="wcf-fxs-btn p" disabled={!canSubmit} onClick={() => submit(true)}>Save changes</button>
          ) : (
            <>
              <button className="wcf-fxs-btn g" disabled={!canSubmit} onClick={() => submit(false)}>{tab === "weekly" && mode === "add" ? "Save as drafts" : "Save as draft"}</button>
              <button className="wcf-fxs-btn p" disabled={!canSubmit} onClick={() => submit(true)}>
                {tab === "weekly" && mode === "add" ? `Post all ${weeklyNew.length || ""}`.trim() : "Post now"}
              </button>
            </>
          )}
        </div>
        {mode === "edit" && game && (
          <button
            className="wcf-fxs-del"
            onClick={async () => {
              const hasBookings = game.bookings.length > 0;
              if (
                await askConfirm(
                  "Delete this fixture?",
                  `${game.venue} on ${fmtDate(game.date)}${hasBookings ? ` - this removes it and all ${game.bookings.length} bookings.` : "."}`,
                  "Delete"
                )
              ) {
                onDelete(game.id);
                onClose();
              }
            }}
          >
            Delete fixture
          </button>
        )}
      </div>
    </div>
  );
}

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

  // A range skips days that already have a fixture; a single day (From and
  // To the same) is a deliberate one-off, so it's added even if that day
  // already has a game (e.g. a Sunday special alongside the usual one).
  const singleDay = start === end;
  const newDates = singleDay ? allDates : allDates.filter((d) => !existingDates.has(d));
  const skippedCount = allDates.length - newDates.length;
  const addsSecond = singleDay && allDates.length === 1 && existingDates.has(allDates[0]);

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
            : addsSecond
              ? "1 fixture will be added. There's already a game that day, so this adds a second one."
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

// New fixtures: when a run of games has been posted since this phone last
// opened Fixtures, that month's calendar unfolds and each new game drops
// onto its date as a gold pin, then it folds down into the list.
function FixturesCalendar({ month, dates, total, onDone }: { month: string; dates: string[]; total: number; onDone: () => void }) {
  const [pinned, setPinned] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const finish = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 480); };
  useEffect(() => {
    const timers = dates.map((_, i) => setTimeout(() => setPinned(i + 1), 750 + i * 300));
    timers.push(setTimeout(finish, 750 + dates.length * 300 + 800));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const first = new Date(month + "-01T12:00:00Z");
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const pinnedDays = new Set(dates.slice(0, pinned).map((d) => Number(d.slice(8, 10))));
  const counted = Math.round((pinned / Math.max(1, dates.length)) * total);
  return (
    <div className={"wcf-moment dim" + (leaving ? " fold" : "")} onClick={finish}>
      <div className="wcf-cal">
        <div className="wcf-cal-k">New fixtures</div>
        <div className="wcf-cal-h"><b>{first.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })}</b><span>{counted} game{counted === 1 ? "" : "s"} added</span></div>
        <div className="wcf-cal-g">
          {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => <div key={d} className="dn">{d}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={"x" + i} className="c x" />)}
          {Array.from({ length: days }, (_, i) => <div key={i} className={"c" + (pinnedDays.has(i + 1) ? " pin" : "")}>{i + 1}</div>)}
        </div>
      </div>
    </div>
  );
}

// Predictions: the matchday slip when you lock in, and the padlock the
// first time you open the app after kickoff on a game you predicted.
function PredictionSlip({ value, sub, onDone }: { value: string; sub: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setLeaving(true), 1700);
    const b = setTimeout(onDone, 2150);
    return () => { clearTimeout(a); clearTimeout(b); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={"wcf-moment dim" + (leaving ? " foldslip" : "")} onClick={() => { setLeaving(true); setTimeout(onDone, 400); }}>
      <div className="wcf-slip">
        <small>YOUR CALL · {sub}</small>
        <b>{value}</b>
        <div className="meta">Locks at kickoff</div>
        <span className="st2">LOCKED IN</span>
      </div>
    </div>
  );
}
function PredictionLock({ value, onDone }: { value: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setLeaving(true), 1900);
    const b = setTimeout(onDone, 2400);
    return () => { clearTimeout(a); clearTimeout(b); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={"wcf-moment dim" + (leaving ? " out" : "")} onClick={() => { setLeaving(true); setTimeout(onDone, 380); }}>
      <svg className="wcf-biglock" viewBox="0 0 60 70" aria-hidden="true">
        <path className="sh" d="M16 32 V20 a14 14 0 0 1 28 0 V32" fill="none" stroke="#f5d97a" strokeWidth="6" strokeLinecap="round" />
        <rect x="8" y="30" width="44" height="34" rx="7" fill="#f5d97a" />
        <circle cx="30" cy="45" r="4.5" fill="#1a1405" />
        <rect x="28.5" y="46" width="3" height="9" rx="1.5" fill="#1a1405" />
      </svg>
      <div className="wcf-moment-k" style={{ marginTop: 14 }}>LOCKED AT KICKOFF</div>
      <div className="wcf-moment-h">{value}</div>
      <div className="wcf-moment-s">Your prediction. Points land when the score&apos;s in.</div>
    </div>
  );
}
// The points on a result: the first time you see them (within a week), a
// big +N bursts over the screen and drops into the pill.
function PointsPill({ pts, storageKey, recent }: { pts: number; storageKey: string; recent: boolean }) {
  const [phase, setPhase] = useState<"big" | "pill" | "done">(() => {
    if (!recent || typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "done";
    try {
      return localStorage.getItem(storageKey) ? "done" : "big";
    } catch {
      return "done";
    }
  });
  useEffect(() => {
    if (phase !== "big") return;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
    const a = setTimeout(() => setPhase("pill"), 1700);
    const b = setTimeout(() => setPhase("done"), 2600);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [phase, storageKey]);
  const cls = "wcf-predict-pts " + (pts === 3 ? "exact" : pts === 1 ? "partial" : "zero");
  return (
    <>
      {phase === "big" && (
        <div className="wcf-moment dim" onClick={() => setPhase("pill")}>
          {pts === 3 && <div className="wcf-pts-burst" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 26}deg` }} />)}</div>}
          <div className={"wcf-bigpts" + (pts ? "" : " zero")}>+{pts}</div>
          <div className="wcf-moment-h" style={{ marginTop: 4 }}>{pts === 3 ? "Exact score" : pts === 1 ? "Right result" : "Not this time"}</div>
        </div>
      )}
      <span className={cls + (phase === "pill" ? " wcf-pts-pop" : "")} style={phase === "big" ? { opacity: 0 } : undefined}>
        +{pts} pt{pts === 1 ? "" : "s"}
      </span>
    </>
  );
}

// A message from an admin (never the automated ones): an envelope, the
// seal breaks, the letter unfolds. More than one waiting is one envelope.
function AdminEnvelope({ items, onDone }: { items: { from: string; text: string; when: string }[]; onDone: () => void }) {
  const [typed, setTyped] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const first = items[0];
  const text = first.text.length > 180 ? first.text.slice(0, 177) + "…" : first.text;
  useEffect(() => {
    if (typed >= text.length) return;
    const t = setTimeout(() => setTyped((n) => Math.min(text.length, n + 2)), typed === 0 ? 2200 : 16);
    return () => clearTimeout(t);
  }, [typed, text.length]);
  const shards = [["0% 0%, 100% 0%", "-30px", "-40px", "-60deg"], ["100% 0%, 100% 100%", "40px", "-20px", "50deg"], ["100% 100%, 0% 100%", "20px", "50px", "80deg"], ["0% 100%, 0% 0%", "-40px", "30px", "-70deg"]];
  return (
    <div className={"wcf-moment dim" + (leaving ? " flyaway" : "")}>
      <div className="wcf-env">
        <div className="envl" />
        <div className="seal">
          {shards.map(([p, dx, dy, r], i) => <i key={i} style={{ ["--p" as string]: p, ["--dx" as string]: dx, ["--dy" as string]: dy, ["--r" as string]: r }} />)}
          <span>WCF</span>
        </div>
        <div className="paper">
          <div className="pp"><small>{items.length > 1 ? `${items.length} MESSAGES FROM THE ADMINS` : `FROM ${first.from.toUpperCase()} · ${first.when.toUpperCase()}`}</small></div>
          <div className="pp"><span className="line">{text.slice(0, typed)}</span></div>
          <div className="pp">
            <span className="sig">{first.from.split(" ")[0]}</span>
            {items.length > 1 && <span className="more">+{items.length - 1} more in your inbox</span>}
            <button className="gotit" onClick={() => { setLeaving(true); setTimeout(onDone, 600); }}>{items.length > 1 ? "Open inbox" : "Got it"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// A special one-off fixture arrives as a gold matchday poster.
function SpecialPoster({ date, kickoff, pitch, venue, price, players, onDone }: { date: string; kickoff: string; pitch: string; venue: string; price: number; players: number; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const go = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 480); };
  const [day, ...rest] = date.split(" ");
  return (
    <div className={"wcf-moment dim" + (leaving ? " fold" : "")} onClick={go}>
      <div className="wcf-poster">
        <span className="wcf-poster-rib">★ SPECIAL FIXTURE</span>
        <div className="wcf-poster-big">{day.toUpperCase()}<br />{rest.join(" ").toUpperCase()}</div>
        <div className="wcf-poster-sub">{kickoff} · {pitch.toUpperCase()}</div>
        <div className="wcf-poster-meta"><b>{venue}</b><br />£{price} · {players} players · one-off</div>
        <button className="wcf-poster-cta" onClick={(e) => { e.stopPropagation(); go(); }}>See it in Fixtures</button>
        <div className="wcf-poster-sheen" />
      </div>
    </div>
  );
}

// The pot: the total with a jar beside it. After a game's payments land,
// the first look rolls the total up from where it was, drops a coin in per
// payer and raises the level. First look on a phone just records.
function PotAmountJar({ total, money, last, storageKey }: { total: number; money: (n: number) => string; last: { id: string; amount: number; paid?: number } | undefined; storageKey: string }) {
  const cap = Math.max(500, Math.ceil(Math.max(total, 1) / 500) * 500);
  const level = (v: number) => Math.max(0.06, Math.min(1, v / cap));
  const [shown, setShown] = useState(total);
  const [fill, setFill] = useState(level(total));
  const [coins, setCoins] = useState<number[]>([]);
  useEffect(() => {
    if (!last) return;
    let prev: string | null = null;
    try {
      prev = localStorage.getItem(storageKey);
      localStorage.setItem(storageKey, last.id);
    } catch {
      return;
    }
    if (!prev || prev === last.id || last.amount <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = total - last.amount;
    setShown(from);
    setFill(level(from));
    const n = Math.min(16, Math.max(1, last.paid ?? 8));
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < n; i++) timers.push(setTimeout(() => setCoins((c) => [...c, i]), 400 + i * 120));
    timers.push(setTimeout(() => setFill(level(total)), 800));
    const steps = 24;
    for (let k = 1; k <= steps; k++) timers.push(setTimeout(() => setShown(Math.round(from + ((total - from) * k) / steps)), 500 + k * 55));
    timers.push(setTimeout(() => setCoins([]), 600 + n * 120 + 700));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);
  const y = 96 - fill * 82;
  return (
    <>
      <div className={"wcf-pot-hero-amt" + (total < 0 ? " negative" : "")}>{money(shown)}</div>
      <div className="wcf-pot-jar" aria-hidden="true">
        <svg viewBox="0 0 80 100">
          <defs><clipPath id="wcfJarClip"><path d="M14 22 Q14 14 22 14 L58 14 Q66 14 66 22 L66 88 Q66 96 58 96 L22 96 Q14 96 14 88 Z" /></clipPath></defs>
          <g clipPath="url(#wcfJarClip)">
            <g className="wcf-pot-jar-fill" style={{ transform: `translateY(${y}px)` }}>
              <rect x="0" y="0" width="80" height="110" fill="rgba(34,197,94,.55)" />
              <path d="M0 0 Q10 -4 20 0 T40 0 T60 0 T80 0 V6 H0Z" fill="rgba(74,222,128,.75)" />
            </g>
          </g>
          <path d="M14 22 Q14 14 22 14 L58 14 Q66 14 66 22 L66 88 Q66 96 58 96 L22 96 Q14 96 14 88 Z" fill="none" stroke="rgba(226,232,240,.55)" strokeWidth="2.5" />
          <rect x="20" y="6" width="40" height="9" rx="3" fill="#334155" stroke="rgba(226,232,240,.45)" strokeWidth="1.5" />
        </svg>
        {coins.map((i) => <i key={i} className="wcf-pot-coin" style={{ ["--dx" as string]: `${((i * 37) % 40) - 20}px` }} />)}
      </div>
    </>
  );
}

// GaffAI thinking: a little tactics board with the ball passing around.
function TikiTaka() {
  const pts = [[30, 64], [72, 30], [72, 98], [118, 50], [118, 82], [170, 64]];
  const route = [0, 1, 2, 3, 1, 3, 4, 2, 4, 5, 3, 0];
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => s + 1), 650);
    return () => clearInterval(t);
  }, []);
  const at = (i: number) => pts[route[i % route.length]];
  const lines = [step - 2, step - 1].filter((i) => i >= 0);
  const [bx, by] = at(step);
  return (
    <div className="gaffai-tiki" aria-label="GaffAI is working">
      <svg viewBox="0 0 210 128">
        {lines.map((i) => {
          const [x1, y1] = at(i);
          const [x2, y2] = at(i + 1);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </svg>
      {pts.map(([x, y], i) => <span key={i} className="p us" style={{ left: `${(x / 210) * 100}%`, top: `${(y / 128) * 100}%` }} />)}
      {[[150, 30], [150, 100], [96, 66]].map(([x, y], i) => <span key={"t" + i} className="p them" style={{ left: `${(x / 210) * 100}%`, top: `${(y / 128) * 100}%` }} />)}
      <span className="ball" style={{ left: `${(bx / 210) * 100}%`, top: `${(by / 128) * 100}%` }} />
    </div>
  );
}

// "You're in": the fourth official's LED board when you come off the
// waiting list, then your BOOKED ticket.
function SubBoard({ number, label, onDone }: { number: number; label: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const finish = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 350); };
  useEffect(() => {
    const t = setTimeout(finish, 2700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={"wcf-moment dim" + (leaving ? " out" : "")} onClick={finish}>
      <div className="wcf-led">
        <div className="l1">SUBSTITUTION</div>
        <div className="row">
          <svg className="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M6 11l6-6 6 6" /></svg>
          <span className="num">{number}</span>
        </div>
        <div className="l3">ON: YOU</div>
        <div className="l4">{label}</div>
        <div className="dots" />
      </div>
      <div className="wcf-moment-s" style={{ marginTop: 18 }}>A spot opened up. You&apos;re off the waiting list.</div>
    </div>
  );
}

// Once-only personal and club moments, one at a time (the queue lives in
// the main component): a debut cap, a milestone shirt, a club milestone.
type BigMoment =
  | { kind: "debut"; key: string; first: string; dateLabel: string; result: string }
  | { kind: "apps"; key: string; n: number; first: string; back: string; since: string }
  | { kind: "club"; key: string; n: number; unit: "goals" | "games"; detail: string };
function BigMomentView({ m, onDone }: { m: BigMoment; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [count, setCount] = useState(m.kind === "club" ? Math.max(0, m.n - 14) : 0);
  useEffect(() => {
    if (m.kind !== "club" || count >= m.n) return;
    const t = setTimeout(() => setCount((c) => c + 1), count === m.n - 14 ? 500 : 60 + (14 - (m.n - count)) * 9);
    return () => clearTimeout(t);
  }, [count, m]);
  const close = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 380); };
  return (
    <div className={"wcf-moment " + (m.kind === "club" ? "club" : "dim") + (leaving ? " out" : "")} onClick={close}>
      {m.kind === "debut" && (
        <>
          <svg className="wcf-cap" viewBox="0 0 150 120" aria-hidden="true">
            <path d="M20 78 Q20 22 75 20 Q130 22 130 78 Z" fill="#1d2a6b" stroke="#f5d97a" strokeWidth="2" />
            <path d="M75 20 L75 78 M40 30 L55 78 M110 30 L95 78" stroke="#f5d97a" strokeWidth="1.5" opacity=".7" />
            <path d="M12 78 Q75 96 138 78 L138 86 Q75 104 12 86 Z" fill="#14205a" stroke="#f5d97a" strokeWidth="2" />
            <g className="tassel"><line x1="75" y1="22" x2="75" y2="8" stroke="#f5d97a" strokeWidth="2" /><path d="M70 0 L80 0 L84 12 L66 12 Z" fill="#f5d97a" /></g>
            <text x="75" y="64" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize="13" fill="#f5d97a">{m.dateLabel.slice(-4)}</text>
          </svg>
          <div className="wcf-moment-after">
            <div className="wcf-moment-k">DEBUT · {m.dateLabel.toUpperCase()}</div>
            <div className="wcf-moment-h">Welcome to the squad, {m.first}</div>
            <div className="wcf-moment-s">Your first game: <b>{m.result}</b><br />Good to have you.</div>
          </div>
        </>
      )}
      {m.kind === "apps" && (
        <>
          <svg className="wcf-shirt" viewBox="0 0 170 180" aria-hidden="true">
            <path d="M55 8 L85 18 L115 8 L162 38 L146 72 L130 64 L130 172 L40 172 L40 64 L24 72 L8 38 Z" fill="#EEF4FC" stroke="#cfd8e6" strokeWidth="2" strokeLinejoin="round" />
            <path d="M70 12 Q85 26 100 12" fill="none" stroke="#cfd8e6" strokeWidth="3" />
            <text x="85" y="66" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize={m.back.length > 9 ? 12 : 15} letterSpacing="2" fill="#0d0d1a">{m.back}</text>
            <text x="85" y="142" textAnchor="middle" fontFamily="Sora, sans-serif" fontWeight="800" fontSize={m.n >= 100 ? 56 : 72} fill="#0d0d1a">{m.n}</text>
          </svg>
          <div className="wcf-ms-badge"><div><b>{m.n}</b>APPS</div></div>
          <div className="wcf-moment-after">
            <div className="wcf-moment-k" style={{ marginTop: 14 }}>MILESTONE</div>
            <div className="wcf-moment-h">Your {m.n}th game, {m.first}</div>
            <div className="wcf-moment-s">{m.n} games for the club since {m.since}.<br />Your badge is on your player card now.</div>
          </div>
        </>
      )}
      {m.kind === "club" && (
        <>
          <div className={"wcf-club-rays" + (count >= m.n ? " go" : "")} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${i * 30}deg` }} />)}
          </div>
          <div className="wcf-moment-k">CLUB MILESTONE</div>
          <div className={"wcf-club-count" + (count >= m.n ? " hit" : "")}>{count}</div>
          <div className="wcf-moment-h" style={{ marginTop: 4 }}>club {m.unit}</div>
          <div className="wcf-moment-s">{count >= m.n ? m.detail : "\u00a0"}</div>
        </>
      )}
    </div>
  );
}

// Matchday tickets: BOOKED when you take a spot, PAID the first time you
// open the app after an admin (or Monzo) confirms your payment. One game
// is one big ticket; several (Book multiple games, or a batch of
// approvals) are one fanned stack, so it never becomes a queue of pop-ups.
// About 2s whatever the count, tap to dismiss. Not shown under Reduce Motion.
interface TicketGame { id: string; date: string; kickoff: string; venue: string; spot: string; side: string }
function MatchTickets({ mode, games, onDone }: { mode: "booked" | "paid" | "birthday"; games: TicketGame[]; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const [count, setCount] = useState(0);
  const sorted = useMemo(() => [...games].sort((a, b) => a.date.localeCompare(b.date) || a.kickoff.localeCompare(b.kickoff)), [games]);
  const multi = sorted.length > 1 && mode !== "birthday";
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (multi) for (let k = 1; k <= sorted.length; k++) timers.push(setTimeout(() => setCount(k), 600 + k * Math.min(170, 900 / sorted.length)));
    const stay = multi ? 2600 : mode === "birthday" ? 3400 : 1900;
    timers.push(setTimeout(() => setLeaving(true), stay));
    timers.push(setTimeout(onDone, stay + 450));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const day = (g: TicketGame, opts: Intl.DateTimeFormatOptions) => new Date(g.date + "T12:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  const time = (k: string) => {
    const [h, m] = k.split(":").map(Number);
    return `${h % 12 === 0 ? 12 : h % 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
  };
  const last = sorted[sorted.length - 1];
  const shown = sorted.slice(0, 3).reverse(); // soonest at the front
  const stamp = (cls: string) =>
    mode === "booked" || cls === "booked" ? (
      <div className="wcf-tk-st booked"><div>BOOKED<small>WCF · {sorted[0]?.date.slice(0, 4)}</small></div></div>
    ) : (
      <div className="wcf-tk-st paid"><div>PAID<small>CONFIRMED</small></div></div>
    );
  return (
    <div className={"wcf-tk-layer " + mode + (leaving ? " out" : "")} onClick={() => { setLeaving(true); setTimeout(onDone, 300); }}>
      {!multi && last ? (
        <div className="wcf-tk-wrap">
          <div className="wcf-ticket">
            <div className="wcf-ticket-main">
              <div className="wcf-ticket-club">WCF · MATCHDAY</div>
              <div className="wcf-ticket-fx">{last.venue}</div>
              <div className="wcf-ticket-when">{day(last, { weekday: "long", day: "numeric", month: "long" })} · {time(last.kickoff)}</div>
              <div className="wcf-ticket-row"><div>SIDE<b>{last.side}</b></div>{mode === "birthday" ? <div>PRICE<b>£0</b></div> : <div>SPOT<b>{last.spot}</b></div>}</div>
            </div>
            <div className="wcf-ticket-stub"><span>ADMIT ONE</span></div>
          </div>
          {mode === "birthday" ? (
            <>
              <div className="wcf-ribbon" aria-hidden="true">
                <div className="v" />
                <div className="h" />
                <svg className="bow" viewBox="0 0 54 34">
                  <path d="M27 17 C14 2 2 6 4 15 C6 24 18 22 27 17 Z" fill="#f5d97a" stroke="#b8860b" strokeWidth="1.5" />
                  <path d="M27 17 C40 2 52 6 50 15 C48 24 36 22 27 17 Z" fill="#f5d97a" stroke="#b8860b" strokeWidth="1.5" />
                  <path d="M27 17 L20 33 M27 17 L34 33" stroke="#b8860b" strokeWidth="4" strokeLinecap="round" />
                  <circle cx="27" cy="17" r="5" fill="#eab308" stroke="#b8860b" strokeWidth="1.5" />
                </svg>
              </div>
              <div className="wcf-tk-st onus"><div>ON US<small>HAPPY BIRTHDAY</small></div></div>
            </>
          ) : (
            stamp("booked")
          )}
          {mode === "paid" && stamp("paid")}
        </div>
      ) : (
        <div className="wcf-tk-stack" style={{ height: 120 + (shown.length - 1) * 50 }}>
          {shown.map((g, i) => (
            <div key={g.id} className="wcf-mt" style={{ ["--i" as string]: i, ["--n" as string]: shown.length }}>
              <div className="wcf-mt-main">
                <div className="wcf-mt-date">{day(g, { weekday: "short", day: "numeric", month: "short" }).toUpperCase()} · {time(g.kickoff).toUpperCase()}</div>
                <div className="wcf-mt-fx">{g.venue}</div>
                <div className="wcf-mt-club">WCF · MATCHDAY</div>
              </div>
              <div className="wcf-mt-stub"><span>ADMIT ONE</span></div>
              <div className={"wcf-tk-st sm " + mode} style={{ ["--d" as string]: shown.length - 1 - i }}><div>{mode === "paid" ? "PAID" : "BOOKED"}</div></div>
            </div>
          ))}
          {sorted.length > 3 && <span className="wcf-tk-more">+{sorted.length - 3} more</span>}
        </div>
      )}
      <div className="wcf-tk-cap">
        {multi ? (
          <>
            <b>{count} games {mode === "paid" ? "paid" : "booked"}</b>
            <span>{mode === "paid" ? "You're sorted until" : "Through to"} {day(last, { weekday: "short", day: "numeric", month: "short" })}</span>
          </>
        ) : mode === "birthday" ? (
          <>
            <b>Happy birthday.</b>
            <span>This one&apos;s on the club.</span>
          </>
        ) : (
          <b>{mode === "paid" ? "Paid. You're all set." : "You're in."}</b>
        )}
      </div>
    </div>
  );
}

// Player of the Month night: the first open after the month's winner is
// out (within a week), once per month per phone. Everyone sees the
// calendar page tear and the trophy draw; the winner gets their own.
function PotmIntro({ prevMonth, month, names, onDone }: { prevMonth: string; month: string; names: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const finish = () => { if (leaving) return; setLeaving(true); setTimeout(onDone, 380); };
  useEffect(() => {
    const t = setTimeout(finish, 3800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={"wcf-potm-intro" + (leaving ? " out" : "")} onClick={finish}>
      <div className="wcf-pi-k">PLAYER OF THE MONTH</div>
      <div className="wcf-pi-page"><div className="new">{month.toUpperCase()}</div><div className="old">{prevMonth.toUpperCase()}</div></div>
      <PotmTrophy className="wcf-pi-trophy" />
      <div className="wcf-pi-name">{names}</div>
      <div className="wcf-pi-tap">Tap to continue</div>
    </div>
  );
}
function PotmWinner({ monthLabel, joint, wins, votes, onDone }: { monthLabel: string; joint: boolean; wins: number; votes: number; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  return (
    <div className={"wcf-potm-intro winner" + (leaving ? " out" : "")}>
      <PotmTrophy className="wcf-pi-trophy big" filled />
      <div className="wcf-pw-k">{monthLabel.toUpperCase()}</div>
      <div className="wcf-pw-h">{joint ? "You're joint Player of the Month" : "You're Player of the Month"}</div>
      <div className="wcf-pw-s"><b>{wins} Man of the Match {wins === 1 ? "win" : "wins"}</b> and <b>{votes} {votes === 1 ? "vote" : "votes"}</b> from the squad.</div>
      <button className="wcf-pw-btn" onClick={() => { setLeaving(true); setTimeout(onDone, 380); }}>See your card</button>
    </div>
  );
}
function PotmTrophy({ className, filled }: { className: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 84 96" aria-hidden="true">
      <path className={"cup" + (filled ? " filled" : "")} d="M22 8h40v18c0 13-9 24-20 24S22 39 22 26z" />
      <path d="M22 14H10c0 12 6 20 15 21M62 14h12c0 12-6 20-15 21" />
      <line x1="42" y1="50" x2="42" y2="66" />
      <path d="M30 66h24l4 10H26z" />
      <line x1="22" y1="86" x2="62" y2="86" />
      <path d="M26 76h32v10H26z" />
    </svg>
  );
}

// Club records as comparable numbers, so a phone can tell when one's been
// beaten since it last looked (stored per season in localStorage).
type RecordSnap = Record<string, { v: number; who: string }>;
function recordSnapshot(r: ClubRecords, team: (w: number, rd: number) => string): RecordSnap {
  const names = (h: Holder[]) => h.slice(0, 2).map((x) => x.name).join(", ") + (h.length > 2 ? ` +${h.length - 2}` : "");
  const out: RecordSnap = {};
  if (r.mostGoalsInGame) out.goals = { v: r.mostGoalsInGame.goals, who: names(r.mostGoalsInGame.holders) };
  if (r.biggestWin) out.win = { v: r.biggestWin.margin, who: team(r.biggestWin.white, r.biggestWin.red) };
  if (r.highestScoring) out.high = { v: r.highestScoring.total, who: team(r.highestScoring.white, r.highestScoring.red) };
  if (r.mostMotmVotesInGame) out.votes1 = { v: r.mostMotmVotesInGame.votes, who: names(r.mostMotmVotesInGame.holders) };
  const season = [["ws", r.winStreak], ["ub", r.unbeaten], ["row", r.gamesInARow], ["mw", r.motmWins], ["mv", r.motmVotes], ["wl", r.promotions]] as const;
  for (const [k, x] of season) if (x) out[k] = { v: x.n, who: names(x.holders) };
  return out;
}

// The record breaker's own moment: the next open after they set a
// single-game record (within 3 days), once per record per phone.
function RecordMoment({ value, label, prev, scoreLine, dateLabel, balls, onDone }: { value: number; label: string; prev: string; scoreLine: string; dateLabel: string; balls: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  return (
    <div className={"wcf-potm-intro winner" + (leaving ? " out" : "")}>
      <div className="wcf-rbm-k">NEW CLUB RECORD</div>
      {balls ? (
        <div className="wcf-rbm-balls">
          {Array.from({ length: Math.min(value, 9) }, (_, i) => (
            <svg key={i} viewBox="0 0 24 24" style={{ animationDelay: `${0.2 + i * 0.18}s` }} aria-hidden="true">
              <circle cx="12" cy="12" r="10.3" fill="#f5f6f8" stroke="#0d0d1a" strokeWidth="1.4" />
              <path d="M12 8.2 15.6 10.8 14.2 15 9.8 15 8.4 10.8Z" fill="#0d0d1a" />
              <g stroke="#0d0d1a" strokeWidth="1.2"><line x1="12" y1="8.2" x2="12" y2="1.8" /><line x1="15.6" y1="10.8" x2="21.6" y2="8.8" /><line x1="14.2" y1="15" x2="17.9" y2="20.2" /><line x1="9.8" y1="15" x2="6.1" y2="20.2" /><line x1="8.4" y1="10.8" x2="2.4" y2="8.8" /></g>
            </svg>
          ))}
        </div>
      ) : (
        <div className="wcf-rbm-big">{value}</div>
      )}
      <div className="wcf-rbm-h">{value} {label}</div>
      <div className="wcf-rbm-s">You beat <b>{prev}</b>.<br />{dateLabel} · {scoreLine}</div>
      <button className="wcf-pw-btn" onClick={() => { setLeaving(true); setTimeout(onDone, 380); }}>See the record book</button>
    </div>
  );
}

// The Man of the Match medal (red and white ribbon, gold medal), used for
// the drop on your vote and the winner's own moment.
function MotmMedal({ className }: { className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 56 120">
        <path d="M18 0 L28 70 L38 0" fill="none" stroke="#E42A36" strokeWidth="9" />
        <path d="M23 0 L28 40 M33 0 L28 40" stroke="#f5f6f8" strokeWidth="3" />
        <circle cx="28" cy="90" r="20" fill="#d4a93c" />
        <circle cx="28" cy="90" r="20" fill="none" stroke="#f5d97a" strokeWidth="2" />
        <circle cx="28" cy="90" r="14.5" fill="none" stroke="#a57f22" strokeWidth="1.2" />
        <path d="M28 80.5l2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-2.9-5.6 2.9 1-6.2-4.5-4.4 6.3-.9z" fill="#fff4cc" />
      </svg>
    </span>
  );
}

// "And Man of the Match is…": the first time you see a game's result
// (within a week of voting closing), the card holds on a drumroll, then
// flips the winner in. Once per game per phone; tap skips it; Reduce
// Motion goes straight to the result.
type MotmRevealPhase = "drum" | "reveal" | "done";
function MotmReveal({ storageKey, eligible, children }: { storageKey: string; eligible: boolean; children: (phase: MotmRevealPhase, skip: () => void, replay: (() => void) | null) => React.ReactNode }) {
  const [canPlay] = useState(() => eligible && typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [phase, setPhase] = useState<MotmRevealPhase>(() => {
    if (!canPlay) return "done";
    try {
      return localStorage.getItem(storageKey) ? "done" : "drum";
    } catch {
      return "done";
    }
  });
  useEffect(() => {
    if (phase !== "drum") return;
    try {
      localStorage.setItem(storageKey, "1");
    } catch {}
    const t = setTimeout(() => setPhase("reveal"), 1300);
    return () => clearTimeout(t);
  }, [phase, storageKey]);
  // "Watch again": same reveal, on demand, while the result's still recent.
  return <>{children(phase, () => setPhase("done"), canPlay ? () => setPhase("drum") : null)}</>;
}

// The winner's own moment: full screen, once per game, the first time they
// open the app after the result (the 8am push). "See the votes" goes to it.
function MotmWinnerMoment({ dateLabel, scoreLabel, votes, total, goals, joint, onSee, onClose }: { dateLabel: string; scoreLabel: string; votes: number; total: number; goals: number; joint: boolean; onSee: () => void; onClose: () => void }) {
  return (
    <div className="wcf-won" onClick={onClose}>
      <MotmMedal className="wcf-won-medal" />
      <div className="wcf-won-k">{dateLabel} · {scoreLabel}</div>
      <div className="wcf-won-h">{joint ? "You're joint Man of the Match" : "You're Man of the Match"}</div>
      <p className="wcf-won-p">
        <b>{votes} of {total} votes</b> from your teammates.
        {goals > 0 && <><br />{goals} {goals === 1 ? "goal" : "goals"} on the night.</>}
      </p>
      <button className="wcf-won-btn" onClick={(e) => { e.stopPropagation(); onSee(); }}>See the votes</button>
      <button className="wcf-won-close" onClick={onClose}>Close</button>
    </div>
  );
}

// Player card "walkout": floodlights, the card rises, a gold line laps its
// edge and each section arrives in turn (~1.9s). Plays on every open; a
// tap skips straight to the finished card, and Reduce Motion gets the old
// quick fade. Numbers count up from 0 on the same clock as the CSS delays.
const WALKOUT_T0 = 950; // ms, when the card's content starts arriving
function CountUp({ to, delay, decimals = 0, run }: { to: number; delay: number; decimals?: number; run: boolean }) {
  const [v, setV] = useState(run ? 0 : to);
  useEffect(() => {
    if (!run) {
      setV(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + delay;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / 650));
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, delay, run]);
  return <>{v.toFixed(decimals)}</>;
}

function PlayerCardModal({
  profile,
  stats,
  rating,
  emergencyContact,
  canSeeRating,
  isOwnCard,
  rank,
  team,
  season,
  appsMilestone,
  onClose,
}: {
  appsMilestone?: number | null;
  profile: Profile;
  stats: { apps: number; goals: number; motm: number };
  rating: PlayerRating | null;
  emergencyContact: EmergencyContact | null;
  canSeeRating: boolean;
  isOwnCard: boolean;
  rank: number | null;
  team: { name: string; color: string } | null;
  season: {
    W: number;
    D: number;
    L: number;
    form: ("W" | "D" | "L")[];
    bestGoals: { goals: number; date: string } | null;
    hatTricks: number;
    topScorer: boolean;
  } | null;
  onClose: () => void;
}) {
  const a = avatarFor(profile.display_name);
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const firstName = profile.display_name.split(" ")[0];
  const overall = rating ? ((rating.fitness + rating.attack + rating.defence) / 3).toFixed(1) : null;
  const [walkout] = useState(() => typeof window === "undefined" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [skipped, setSkipped] = useState(false);
  const animate = walkout && !skipped;
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!walkout || !cardRef.current) return;
    const el = cardRef.current;
    setCardSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [walkout]);
  const at = (s: number) => WALKOUT_T0 + s * 1000; // content clock, matches --d in the CSS
  return (
    <div className={"wcf-lightbox" + (walkout ? " wcf-walkout" : "") + (skipped ? " skipped" : "")} onClick={onClose}>
      {walkout && <div className="wcf-beam l" />}
      {walkout && <div className="wcf-beam r" />}
      <button className="wcf-lightbox-close" onClick={onClose} aria-label="Close">×</button>
      <div
        className="wcf-pcard"
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={() => walkout && !skipped && setSkipped(true)}
      >
        {walkout && cardSize && (
          <svg className="wcf-pcard-trace" width={cardSize.w + 2} height={cardSize.h + 2} viewBox={`0 0 ${cardSize.w + 2} ${cardSize.h + 2}`} aria-hidden="true">
            <rect x="1" y="1" width={cardSize.w} height={cardSize.h} rx="20" style={{ strokeDasharray: 2 * (cardSize.w + cardSize.h), ["--per" as string]: 2 * (cardSize.w + cardSize.h) }} />
          </svg>
        )}
        <div className="wcf-pcard-head">
          <div className="wcf-pcard-glow" />
          <div className="wcf-pcard-topline" />
          {canSeeRating && (
            <span className="wcf-pcard-privacy wcf-rv">
              <span className="wcf-pcard-privacy-dot" />
              {isOwnCard ? "YOUR CARD" : "ADMIN VIEW"}
            </span>
          )}
          <div className="wcf-pcard-avatar-wrap wcf-rv" style={{ ["--d" as string]: "-.15s" }}>
            <Avatar name={profile.display_name} avatarUrl={profile.avatar_url} className="wcf-pcard-avatar" background={a.gradient} />
          </div>
          <div className="wcf-pcard-name wcf-rv">{profile.display_name}</div>
          <div className="wcf-pcard-badges wcf-rv" style={{ ["--d" as string]: ".05s" }}>
            {season?.topScorer && <span className="wcf-pcard-honour">Top scorer</span>}
            {appsMilestone && <span className="wcf-pcard-ms">{appsMilestone} apps</span>}
            {rank != null && rank <= 10 && <span className="wcf-pcard-role-badge">{nth(rank)} for games</span>}
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
          <div className="wcf-pcard-stats wcf-rv" style={{ ["--d" as string]: ".1s" }}>
            <div className="wcf-pcard-stat"><b><CountUp to={stats.apps} delay={at(0.15)} run={animate} /></b><span>Apps</span></div>
            <div className="wcf-pcard-stat"><b><CountUp to={stats.goals} delay={at(0.15)} run={animate} /></b><span>Goals</span></div>
            <div className="wcf-pcard-stat"><b><CountUp to={stats.motm} delay={at(0.15)} run={animate} /></b><span>MOTM</span></div>
          </div>

          {/* Their season at a glance - all of it already public elsewhere
              in the app (Scores, Records), just gathered on one card. */}
          {season && season.W + season.D + season.L > 0 && (
            <div className="wcf-pcard-season">
              <div className="wcf-pcard-sec-head wcf-rv" style={{ ["--d" as string]: ".35s" }}><span>Season record</span><b>{season.W}W · {season.D}D · {season.L}L</b></div>
              <div className="wcf-pcard-wdl">
                {season.W > 0 && <div style={{ flex: season.W }} className="w">{season.W}</div>}
                {season.D > 0 && <div style={{ flex: season.D }} className="d">{season.D}</div>}
                {season.L > 0 && <div style={{ flex: season.L }} className="l">{season.L}</div>}
              </div>
              <div className="wcf-pcard-sec-head wcf-rv" style={{ marginTop: 12, ["--d" as string]: ".6s" }}><span>Last {season.form.length}</span><span>oldest → latest</span></div>
              <div className="wcf-pcard-form">
                {season.form.map((r, i) => <i key={i} className={"f" + r} style={{ ["--i" as string]: i }}>{r}</i>)}
              </div>
              <div className="wcf-pcard-sec-head wcf-rv" style={{ marginTop: 12, ["--d" as string]: "1.05s" }}><span>Bests</span></div>
              <div className="wcf-pcard-bests wcf-rv" style={{ ["--d" as string]: "1.1s" }}>
                <div><b><CountUp to={season.bestGoals?.goals ?? 0} delay={at(1.1)} run={animate} /></b><span>{season.bestGoals ? `goals in a game · ${fmtDate(season.bestGoals.date)}` : "goals in a game"}</span></div>
                <div><b><CountUp to={season.hatTricks} delay={at(1.1)} run={animate} /></b><span>{season.hatTricks === 1 ? "hat-trick" : "hat-tricks"}</span></div>
                <div><b><CountUp to={stats.apps ? Math.round((stats.goals / stats.apps) * 10) / 10 : 0} decimals={1} delay={at(1.1)} run={animate} /></b><span>goals per game</span></div>
              </div>
            </div>
          )}

          {canSeeRating && rating ? (
            <div className="wcf-pcard-ratings wcf-rv" style={{ ["--d" as string]: "1.2s" }}>
              <div className="wcf-pcard-ratings-top">
                <span className="wcf-pcard-ratings-label">Rating</span>
                <span className="wcf-pcard-ratings-divider" />
                <span className="wcf-pcard-ratings-visibility">
                  {isOwnCard ? "ONLY YOU" : "ADMIN ONLY"}
                </span>
              </div>
              {(["fitness", "attack", "defence", "goalkeeping"] as const).map((k, i) => (
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
                        ["--i" as string]: i,
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
            <div className="wcf-pcard-private wcf-rv" style={{ ["--d" as string]: "1.25s" }}>
              <span>Ratings are private to {firstName} and the admins.</span>
            </div>
          )}

          {canSeeRating && (
            <div className="wcf-pcard-ratings wcf-rv" style={{ ["--d" as string]: "1.35s" }}>
              <div className="wcf-pcard-ratings-top">
                <span className="wcf-pcard-ratings-label">Emergency contact</span>
                <span className="wcf-pcard-ratings-divider" />
                <span className="wcf-pcard-ratings-visibility">{isOwnCard ? "ONLY YOU" : "ADMIN ONLY"}</span>
              </div>
              {emergencyContact ? (
                <a className="wcf-pcard-emergency" href={`tel:${emergencyContact.contact_phone.replace(/\s+/g, "")}`}>
                  <span className="wcf-pcard-emergency-name">{emergencyContact.contact_name}</span>
                  <span className="wcf-pcard-emergency-phone">{emergencyContact.contact_phone}</span>
                </a>
              ) : (
                <div className="wcf-pcard-private" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                  <span>{isOwnCard ? "Not added yet — add it in Account settings." : "Not added yet."}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type GaffAIAction =
  | { kind: "mark_paid"; bookingId: string; playerName: string; gameLabel: string; amount: number }
  | { kind: "create_fixture"; date: string; kickoff: string; venue: string; pitch: string; price: number; maxPlayers: number }
  | { kind: "send_reminder"; playerId: string; playerName: string; message: string }
  | { kind: "publish_fixture"; gameId: string; venue: string; date: string }
  | { kind: "matchday_push"; gameId: string; venue: string; date: string; spotsLeft: number; targetCount: number }
  | { kind: "set_pot_exempt"; bookingId: string; playerName: string; gameLabel: string; reason: string }
  | { kind: "remove_duplicate"; removeId: string; removeName: string; keepId: string; keepName: string }
  | { kind: "booking_invite"; gameId: string; gameLabel: string; spacesLeft: number; players: { id: string; name: string }[]; message: string };

interface GaffAIMessage {
  role: "user" | "assistant";
  text: string;
  action?: GaffAIAction;
  actionState?: "pending" | "confirmed" | "cancelled" | "failed";
}

interface GaffAINudge {
  key: string;
  text: string;
}

// A wider pool than what's shown at once - GaffAI covers 20+ tools now
// (pot balance, team balancing, predictions, duplicate profiles...) and
// a fixed 5 would never hint at most of them. A random 5 each time the
// chat resets means repeat use gradually surfaces the full range instead
// of anchoring on the same five forever.
// Grouped so they read as Players / Money / Games, two each, wrapping
// inside the panel so nothing runs off the edge of the screen.
const GAFFAI_SUGGESTION_POOL: Record<string, string[]> = {
  Players: [
    "Who hasn't been rated yet?",
    "Any duplicate player profiles?",
    "Who's got the highest win percentage?",
    "Who hasn't added an emergency contact?",
    "Anyone with broken push notifications?",
    "Who's lost the most games?",
  ],
  Money: [
    "Who's unpaid for the next game?",
    "Is anyone currently blocked from booking?",
    "How much is in the pot?",
    "What's our default match price?",
  ],
  Games: [
    "How's the next game looking?",
    "Who's on the waiting list?",
    "Who won MOTM last month?",
    "Suggest balanced teams for the next game",
    "Who's winning the prediction league?",
  ],
};

function pickGaffAISuggestions(): { group: string; items: string[] }[] {
  return Object.entries(GAFFAI_SUGGESTION_POOL).map(([group, pool]) => {
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { group, items: shuffled.slice(0, 2) };
  });
}

// GaffAI writes light markdown (**bold**, "- " bullets, numbered lists,
// "### " headings). Shown as real formatting rather than raw symbols.
function GaffAIText({ text }: { text: string }) {
  const inline = (line: string, key: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
        <b key={key + i}>{part.slice(2, -2)}</b>
      ) : (
        <Fragment key={key + i}>{part}</Fragment>
      )
    );
  const blocks: React.ReactNode[] = [];
  const st: { list: { ordered: boolean; items: string[] } | null; para: string[] } = { list: null, para: [] };
  const flushPara = () => {
    if (st.para.length === 0) return;
    const lines = st.para;
    blocks.push(
      <p key={"p" + blocks.length}>
        {lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(l, "l" + i)}
          </Fragment>
        ))}
      </p>
    );
    st.para = [];
  };
  const flushList = () => {
    if (!st.list) return;
    const { ordered, items } = st.list;
    const children = items.map((it, i) => <li key={i}>{inline(it, "i" + i)}</li>);
    blocks.push(ordered ? <ol key={"o" + blocks.length}>{children}</ol> : <ul key={"u" + blocks.length}>{children}</ul>);
    st.list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const ordered = !bullet;
      if (!st.list || st.list.ordered !== ordered) {
        flushList();
        st.list = { ordered, items: [] };
      }
      st.list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flushList();
    if (heading) {
      flushPara();
      blocks.push(<div key={"h" + blocks.length} className="gaffai-h">{heading[1].replace(/\*\*/g, "")}</div>);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    st.para.push(line);
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}

// GaffAI's mark - a tactical "G" arc breaking into an arrow, with a
// target-X and a connected node cluster standing in for the AI side.
// currentColor throughout so it inherits whatever tint its container
// sets (white on the blue FAB, light blue in the header tile) - the
// viewBox is recentered on the artwork's real bounding box (not 0 0 512
// 512) since the drawn shapes aren't symmetric within a plain square.
// ─── The Boot Room ───────────────────────────────────────────────
// Members' own trades and businesses, in the Feed tab where Clips used to
// be. Four category boots on a lit stage -> a category -> a listing.
// Contact is WhatsApp or a word at the next game (no in-app messaging),
// and "rating" is a one-tap endorsement rather than stars: these are
// teammates, so a low score is socially impossible to give and an average
// would only ever read 5.0. Schema and the reasoning behind each policy
// live in supabase/schema.sql; shared categories/phone handling in
// lib/bootRoom.ts.

interface BootListing {
  id: string;
  player_id: string;
  company: string;
  category: BootCategory;
  description: string | null;
  tags: string[];
  phone: string | null;
  logo_url: string | null;
  logo_on_dark: boolean;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

interface BootEndorsement {
  listing_id: string;
  player_id: string;
  created_at: string;
}

const BOOT_NEW_DAYS = 14;

// Re-encodes a chosen logo to at most 512px while KEEPING transparency.
// The avatar path (compressImage) is deliberately not reused: it writes
// JPEG, which is right for photos but flattens a logo's transparent
// background into a solid block and fuzzes the lettering. WebP where the
// browser can encode it; iOS Safari can only encode PNG, so that's the
// fallback, and the storage path carries whichever extension came out.
function processBootLogo(file: File): Promise<{ blob: Blob; ext: "webp" | "png" }> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("That isn't an image file"));
    if (file.size > 15 * 1024 * 1024) return reject(new Error("That file's too big — try a smaller export"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // An SVG with no intrinsic size reports 0 - give it a sensible one.
      const w0 = img.naturalWidth || 512;
      const h0 = img.naturalHeight || 512;
      const scale = Math.min(1, 512 / Math.max(w0, h0));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w0 * scale));
      canvas.height = Math.max(1, Math.round(h0 * scale));
      const ctx = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error("Canvas isn't supported on this device"));
      // No background fill - that's what keeps the transparency.
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (webp) => {
          if (webp && webp.type === "image/webp") return resolve({ blob: webp, ext: "webp" });
          canvas.toBlob((png) => (png ? resolve({ blob: png, ext: "png" }) : reject(new Error("Couldn't process that image"))), "image/png");
        },
        "image/webp",
        0.9
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image"));
    };
    img.src = url;
  });
}

function BootRoom({
  myId,
  isAdmin,
  profiles,
  askConfirm,
  logAction,
  notifyError,
  notifySuccess,
}: {
  myId: string;
  isAdmin: boolean;
  profiles: Profile[];
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  logAction: (action: string, details: string) => Promise<void>;
  notifyError: (message: string) => void;
  notifySuccess: (text: string) => void;
}) {
  const [listings, setListings] = useState<BootListing[]>([]);
  const [endorsements, setEndorsements] = useState<BootEndorsement[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [openCat, setOpenCat] = useState<BootCategory | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editorId, setEditorId] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Editor fields
  const [fCompany, setFCompany] = useState("");
  const [fCat, setFCat] = useState<BootCategory>("trade");
  const [fTags, setFTags] = useState<string[]>([]);
  const [fOther, setFOther] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [phoneErr, setPhoneErr] = useState(false);
  const [fLogo, setFLogo] = useState<{ blob: Blob; ext: "webp" | "png"; preview: string } | null>(null);
  const [fLogoUrl, setFLogoUrl] = useState<string | null>(null);
  const [fLogoDark, setFLogoDark] = useState(false);
  const [logoMsg, setLogoMsg] = useState<string | null>(null);
  // Problems saving are shown inside the sheet, next to the button. The
  // app-wide toast renders underneath the sheet overlay, so a failed save
  // reported there looked exactly like a button that did nothing.
  const [formErr, setFormErr] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const companyRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    const [l, e] = await Promise.all([
      supabase
        .from("boot_room_listings")
        .select("id, player_id, company, category, description, tags, phone, logo_url, logo_on_dark, hidden, created_at, updated_at")
        .order("created_at", { ascending: false }),
      supabase.from("boot_room_endorsements").select("listing_id, player_id, created_at").order("created_at", { ascending: true }),
    ]);
    if (l.error) {
      // PGRST205 = table not found: the migration hasn't been run yet.
      setLoadState(l.error.code === "PGRST205" || l.error.code === "42P01" ? "missing" : "error");
      return;
    }
    setListings((l.data ?? []) as BootListing[]);
    setEndorsements((e.data ?? []) as BootEndorsement[]);
    setLoadState("ready");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const endorsersByListing = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of endorsements) {
      const arr = m.get(e.listing_id) ?? [];
      arr.push(e.player_id);
      m.set(e.listing_id, arr);
    }
    return m;
  }, [endorsements]);

  const endorsers = (l: BootListing) => endorsersByListing.get(l.id) ?? [];
  const endorsedByMe = (l: BootListing) => endorsers(l).includes(myId);
  const ownerName = (l: BootListing) => profileById.get(l.player_id)?.display_name ?? "A member";
  const isNew = (l: BootListing) => Date.now() - new Date(l.created_at).getTime() < BOOT_NEW_DAYS * 86400000;
  const byEndorsement = (a: BootListing, b: BootListing) =>
    endorsers(b).length - endorsers(a).length || a.company.localeCompare(b.company);

  // Community Picks are the most-recommended few, so the section means
  // something. Until anyone has recommended anything, it honestly says
  // "New in the Boot Room" instead of crowning listings with zero votes.
  const endorsedSorted = useMemo(
    () => listings.filter((l) => (endorsersByListing.get(l.id) ?? []).length > 0).sort(byEndorsement),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listings, endorsersByListing]
  );
  const picks = endorsedSorted.length ? endorsedSorted.slice(0, 3) : listings.slice(0, 3);
  const pickIds = new Set(endorsedSorted.slice(0, 3).map((l) => l.id));
  const countIn = (cat: BootCategory) => listings.filter((l) => l.category === cat).length;

  // Names first, count second: in a club this size "Steve and Amir"
  // persuades far more than a number, because you know Steve.
  function endorseLine(l: BootListing) {
    const ids = endorsers(l);
    const names = [...(ids.includes(myId) ? ["You"] : []), ...ids.filter((id) => id !== myId).map((id) => (profileById.get(id)?.display_name ?? "A member").split(" ")[0])];
    if (!names.length) return "No recommendations yet";
    if (names.length === 1) return `Recommended by ${names[0]}`;
    if (names.length === 2) return `Recommended by ${names[0]} & ${names[1]}`;
    return `Recommended by ${names[0]}, ${names[1]} + ${names.length - 2} more`;
  }

  function faces(l: BootListing) {
    const ids = endorsers(l);
    const ordered = [...(ids.includes(myId) ? [myId] : []), ...ids.filter((id) => id !== myId)].slice(0, 3);
    return (
      <span className="wcf-br-faces">
        {ordered.map((id) => {
          const p = profileById.get(id);
          const name = p?.display_name ?? "?";
          return <Avatar key={id} name={name} avatarUrl={p?.avatar_url} className={"wcf-br-face" + (id === myId ? " me" : "")} background={avatarFor(name).gradient} />;
        })}
      </span>
    );
  }

  function badge(l: BootListing, big: boolean) {
    const c = BOOT_CATEGORY[l.category];
    if (l.logo_url) {
      return (
        <div className={(big ? "wcf-br-logo big" : "wcf-br-logo") + (l.logo_on_dark ? " on-dark" : "")}>
          <img src={l.logo_url} alt={`${l.company} logo`} />
        </div>
      );
    }
    const initials = l.company.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w[0] ?? "")).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
    return (
      <div className={big ? "wcf-br-mono big" : "wcf-br-mono"} style={{ background: `linear-gradient(155deg, ${c.colour}, ${c.colour}aa)` }}>
        {initials}
      </div>
    );
  }

  function card(l: BootListing, i: number) {
    const c = BOOT_CATEGORY[l.category];
    return (
      <button key={l.id} className="wcf-br-card" style={{ animationDelay: `${i * 30}ms` }} onClick={() => setDetailId(l.id)}>
        {badge(l, false)}
        <span className="wcf-br-card-body">
          <span className="wcf-br-card-top">
            <span className="wcf-br-card-name">{l.company}</span>
            {pickIds.has(l.id) && <span className="wcf-br-pick">PICK</span>}
            {isNew(l) && <span className="wcf-br-new">NEW</span>}
          </span>
          <span className="wcf-br-card-desc">
            {ownerName(l)}
            {l.description ? ` · ${l.description}` : ""}
          </span>
          <span className="wcf-br-card-meta">
            {faces(l)}
            <span className="wcf-br-recs">{endorseLine(l)}</span>
          </span>
        </span>
        <span className="wcf-br-flag" style={{ color: c.colour }}>{c.label}</span>
      </button>
    );
  }

  function bootArt(cat: BootCategory, cls: string) {
    const c = BOOT_CATEGORY[cat];
    return (
      <span className={cls} style={{ ["--c" as string]: c.colour } as React.CSSProperties}>
        <img className="main" src={c.img} alt={`${c.full} boot`} />
        <span className="reflect" aria-hidden="true">
          <img src={c.img} alt="" />
        </span>
      </span>
    );
  }

  function goTo(cat: BootCategory | null) {
    setOpenCat(cat);
    setSearchOpen(false);
    setQuery("");
    setShowAll(false);
    rootRef.current?.scrollIntoView({ block: "start" });
  }

  // ---------- endorse ----------
  async function toggleEndorse(l: BootListing) {
    if (l.player_id === myId || busy) return;
    const was = endorsedByMe(l);
    // Optimistic: on a phone the button should answer the tap immediately.
    setEndorsements((prev) =>
      was
        ? prev.filter((e) => !(e.listing_id === l.id && e.player_id === myId))
        : [...prev, { listing_id: l.id, player_id: myId, created_at: new Date().toISOString() }]
    );
    const { error } = was
      ? await supabase.from("boot_room_endorsements").delete().eq("listing_id", l.id).eq("player_id", myId)
      : await supabase.from("boot_room_endorsements").insert({ listing_id: l.id, player_id: myId });
    if (error) {
      notifyError(error.message);
      await load();
    }
  }

  // ---------- remove ----------
  async function removeListing(l: BootListing) {
    const own = l.player_id === myId;
    const ok = await askConfirm(
      own ? "Remove your listing?" : `Delete ${l.company}?`,
      own
        ? "It comes off the Boot Room for everyone, along with its recommendations."
        : `This removes ${ownerName(l)}'s listing for everyone, recommendations included. They can add it again.`,
      own ? "Remove" : "Delete"
    );
    if (!ok) return;
    setBusy(true);
    await supabase.storage.from("boot-room-logos").remove([`${l.id}.webp`, `${l.id}.png`]);
    const { error } = await supabase.from("boot_room_listings").delete().eq("id", l.id);
    setBusy(false);
    // Close first: the toast renders underneath the sheet overlay.
    if (error) {
      setDetailId(null);
      return notifyError(`Couldn't remove it — ${error.message}`);
    }
    // Admin removals are logged - the owner didn't do it, so "where did my
    // listing go?" needs an answer. Owners removing their own aren't.
    if (!own) await logAction("Deleted Boot Room listing", `${l.company} — ${ownerName(l)}`);
    setDetailId(null);
    await load();
    notifySuccess(own ? "Your listing's been removed" : "Listing deleted");
  }

  // ---------- editor ----------
  function openEditor(l: BootListing | null) {
    setDetailId(null);
    setPhoneErr(false);
    setFormErr(null);
    setNameErr(false);
    setLogoMsg(null);
    setFLogo(null);
    if (l) {
      const presets = BOOT_CATEGORY[l.category].tags;
      setFCompany(l.company);
      setFCat(l.category);
      setFTags(l.tags.filter((t) => presets.includes(t)));
      setFOther(l.tags.filter((t) => !presets.includes(t)).join(", "));
      setFDesc(l.description ?? "");
      setFPhone(l.phone ? displayUkPhone(l.phone) : "");
      setFLogoUrl(l.logo_url);
      setFLogoDark(l.logo_on_dark);
      setEditorId(l.id);
    } else {
      setFCompany("");
      setFCat(openCat ?? "trade");
      setFTags([]);
      setFOther("");
      setFDesc("");
      setFPhone("");
      setFLogoUrl(null);
      setFLogoDark(false);
      setEditorId("new");
    }
  }

  function pickCategory(cat: BootCategory) {
    setFCat(cat);
    // Keep only tags that exist in the new category's list, so nothing
    // invisible gets saved against the listing.
    setFTags((prev) => prev.filter((t) => BOOT_CATEGORY[cat].tags.includes(t)));
  }

  async function onLogoChosen(file: File | undefined) {
    if (!file) return;
    try {
      const out = await processBootLogo(file);
      if (fLogo) URL.revokeObjectURL(fLogo.preview);
      setFLogo({ ...out, preview: URL.createObjectURL(out.blob) });
      setLogoMsg("Looks good. Flip to a dark tile if your logo is white or very light.");
    } catch (err) {
      setLogoMsg(err instanceof Error ? err.message : "Couldn't use that image");
    }
  }

  function clearLogo() {
    if (fLogo) URL.revokeObjectURL(fLogo.preview);
    setFLogo(null);
    setFLogoUrl(null);
    setFLogoDark(false);
    setLogoMsg(null);
  }

  async function saveListing() {
    if (busy || !editorId) return;
    setFormErr(null);
    const company = fCompany.trim();
    // Never a silently greyed-out button: the example text in this box
    // can read as already filled in on a phone, so say what's missing.
    if (!company) {
      // Said on the box itself too: jumping up to it takes the message by
      // the button off-screen.
      setNameErr(true);
      setFormErr("Add your company or trade name at the top first.");
      companyRef.current?.focus();
      companyRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const rawPhone = fPhone.trim();
    const phone = rawPhone ? normaliseUkPhone(rawPhone) : null;
    if (rawPhone && !phone) {
      setPhoneErr(true);
      return;
    }
    const other = fOther.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5);
    const tags = Array.from(new Set([...fTags, ...other]));
    const row = { company, category: fCat, description: fDesc.trim() || null, tags, phone, logo_on_dark: fLogoDark };
    const existing = editorId === "new" ? null : listings.find((l) => l.id === editorId) ?? null;

    setBusy(true);
    // try/finally so no failure - a dropped connection, an expired
    // session - can leave the button stuck on "Saving…".
    try {
      let id = existing?.id ?? null;
      if (existing) {
        const { error } = await supabase.from("boot_room_listings").update({ ...row, updated_at: new Date().toISOString() }).eq("id", existing.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("boot_room_listings").insert({ ...row, player_id: myId }).select("id").single();
        if (error || !data) throw error ?? new Error("Couldn't save your listing");
        id = (data as { id: string }).id;
      }

      // The logo is keyed on the listing id (one member can hold several
      // listings), so it can only upload once the row exists.
      let logoFailed = false;
      if (id && fLogo) {
        // Clear any previous logo first, then a plain upload. Not upsert:
        // Supabase routes upsert through a separate permission path that the
        // ownership policy rejects, and it isn't needed - the old file (under
        // either extension, since iPhones produce PNG and others WebP) is
        // gone by the time the new one is written.
        await supabase.storage.from("boot-room-logos").remove([`${id}.webp`, `${id}.png`]);
        const path = `${id}.${fLogo.ext}`;
        const { error: upErr } = await supabase.storage
          .from("boot-room-logos")
          .upload(path, fLogo.blob, { contentType: fLogo.ext === "webp" ? "image/webp" : "image/png" });
        if (upErr) logoFailed = true;
        else {
          // Same cache-busting as avatars: re-uploads can reuse the path.
          const url = `${supabase.storage.from("boot-room-logos").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
          await supabase.from("boot_room_listings").update({ logo_url: url }).eq("id", id);
        }
      } else if (id && existing?.logo_url && !fLogoUrl) {
        await supabase.storage.from("boot-room-logos").remove([`${id}.webp`, `${id}.png`]);
        await supabase.from("boot_room_listings").update({ logo_url: null }).eq("id", id);
      }

      setEditorId(null);
      await load();
      if (logoFailed) notifyError("Saved — but the logo didn't upload. Try it again from Edit.");
      else notifySuccess(existing ? "Listing updated" : "You're in the Boot Room");
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string } | null)?.message ?? "";
      const expired = /jwt|token|expired|401|not authenticated/i.test(msg);
      setFormErr(
        expired
          ? "Your sign-in has timed out. Close the app fully, reopen it, and try again - nothing you typed has been saved yet."
          : `Couldn't save that${msg ? ` (${msg})` : ""}. Check your signal and try again.`
      );
    } finally {
      setBusy(false);
    }
  }

  // ---------- derived views ----------
  const q = query.trim().toLowerCase();
  const listing = !!q || showAll;
  const results = q
    ? listings
        .filter((l) =>
          [l.company, l.description ?? "", l.tags.join(" "), ownerName(l), BOOT_CATEGORY[l.category].full].join(" ").toLowerCase().includes(q)
        )
        .sort(byEndorsement)
    : showAll
      ? [...listings].sort(byEndorsement)
      : [];
  const catList = openCat ? listings.filter((l) => l.category === openCat).sort(byEndorsement) : [];
  const detail = detailId ? listings.find((l) => l.id === detailId) ?? null : null;
  const logoPreview = fLogo?.preview ?? fLogoUrl;

  if (loadState === "missing" || loadState === "error") {
    return (
      <div className="wcf-br">
        <p className="wcf-empty">
          {loadState === "missing" ? "The Boot Room isn't set up yet — the database migration still needs running." : "Couldn't load the Boot Room — pull down to try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="wcf-br" ref={rootRef}>
      {!openCat ? (
        <>
          <div className="wcf-br-head">
            <div>
              <div className="wcf-br-kicker">THE</div>
              <div className="wcf-br-title">BOOT ROOM</div>
              <div className="wcf-br-sub">The squad&apos;s own trades and services. Someone here can probably sort it.</div>
            </div>
            <button
              className={"wcf-br-iconbtn" + (searchOpen ? " on" : "")}
              aria-label="Search the Boot Room"
              onClick={() => {
                setSearchOpen((v) => !v);
                setQuery("");
                setShowAll(false);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            </button>
          </div>

          {searchOpen && (
            <div className="wcf-br-search">
              <input autoFocus type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder='Try "boiler", "logo", "MOT"…' />
            </div>
          )}

          {listing ? (
            <>
              <div className="wcf-br-sec">
                <div className="wcf-br-sec-title">
                  {!q ? `Everyone · ${results.length}` : results.length ? `${results.length} match${results.length === 1 ? "" : "es"}` : "No matches"}
                </div>
                <button className="wcf-br-link" onClick={() => { setQuery(""); setShowAll(false); setSearchOpen(false); }}>Close</button>
              </div>
              {results.length ? (
                <div className="wcf-br-cards">{results.map(card)}</div>
              ) : (
                <p className="wcf-br-note">No one matches that yet. Try another word — or claim your peg and be the first.</p>
              )}
            </>
          ) : (
            <>
              <div className="wcf-br-stage">
                <div className="wcf-br-stage-glow" />
                <div className="wcf-br-stage-row">
                  {BOOT_CATEGORIES.map((c, i) => (
                    <button key={c.key} className="wcf-br-slot" style={{ ["--d" as string]: `${-i * 0.7}s` } as React.CSSProperties} onClick={() => goTo(c.key)} aria-label={`${c.full}, ${countIn(c.key)} listed`}>
                      {bootArt(c.key, "wcf-br-boot")}
                    </button>
                  ))}
                </div>
              </div>
              <div className="wcf-br-tiles">
                {BOOT_CATEGORIES.map((c) => (
                  <button key={c.key} className="wcf-br-tile" style={{ ["--c" as string]: c.colour } as React.CSSProperties} onClick={() => goTo(c.key)}>
                    <img src={c.img} alt="" />
                    <b>{c.label}</b>
                    <span>{countIn(c.key)}</span>
                  </button>
                ))}
              </div>

              {loadState === "ready" && listings.length === 0 ? (
                <div className="wcf-br-empty">
                  <b>Nobody&apos;s in yet</b>
                  <span>Pick a boot and add what you do — plumber, PT, barber, whatever it is. First few in get found the most.</span>
                  <button className="wcf-br-fab inline" onClick={() => openEditor(null)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    Claim your peg
                  </button>
                </div>
              ) : loadState === "ready" ? (
                <>
                  <div className="wcf-br-sec">
                    <div className="wcf-br-sec-title">{endorsedSorted.length ? "Community Picks" : "New in the Boot Room"}</div>
                    <button className="wcf-br-link" onClick={() => { setSearchOpen(true); setShowAll(true); }}>See all</button>
                  </div>
                  <div className="wcf-br-cards">{picks.map(card)}</div>
                </>
              ) : null}
            </>
          )}
        </>
      ) : (
        (() => {
          const c = BOOT_CATEGORY[openCat];
          return (
            <>
              <div className="wcf-br-catbar">
                <button className="wcf-br-iconbtn" onClick={() => goTo(null)} aria-label="Back to the Boot Room">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
                </button>
                <span className="wcf-br-catname" style={{ color: c.colour }}>{c.full.toUpperCase()}</span>
              </div>
              <div className="wcf-br-cathero" style={{ ["--c" as string]: c.colour } as React.CSSProperties}>
                <div className="wcf-br-herostage">{bootArt(openCat, "wcf-br-heroboot")}</div>
                <div className="wcf-br-line">{c.line}</div>
                <div className="wcf-br-blurb">{c.blurb}</div>
                <div className="wcf-br-count" style={{ color: c.colour }}>{catList.length} IN THE CLUB</div>
              </div>
              <div className="wcf-br-sec"><div className="wcf-br-sec-title">{catList.length ? "Who's in" : "Nobody yet"}</div></div>
              {catList.length ? (
                <div className="wcf-br-cards">{catList.map(card)}</div>
              ) : (
                <p className="wcf-br-note">Nobody&apos;s claimed a peg here yet. If this is what you do, you&apos;re first in.</p>
              )}
              <div className="wcf-br-switch">
                {BOOT_CATEGORIES.filter((o) => o.key !== openCat).map((o) => (
                  <button key={o.key} style={{ ["--c" as string]: o.colour } as React.CSSProperties} onClick={() => goTo(o.key)}>
                    <img src={o.img} alt="" />
                    <b>{o.label}</b>
                  </button>
                ))}
              </div>
            </>
          );
        })()
      )}

      <div className="wcf-br-spacer" />

      {/* Centred rather than bottom-right: GaffAI's button already lives
          there for admins, and admins are exactly who sees this first. */}
      {/* While the room is empty the button sits inside the "Nobody's in
          yet" message instead - floating, it covered that exact text. */}
      {loadState === "ready" && (listings.length > 0 || openCat || listing) && (
        <button className="wcf-br-fab" onClick={() => openEditor(null)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Claim your peg
        </button>
      )}

      {detail && (
        <div className="wcf-sheet-overlay" onClick={() => setDetailId(null)}>
          <div className="wcf-squad-sheet wcf-br-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wcf-sheet-handle-wrap"><div className="wcf-sheet-handle" /></div>
            <button className="wcf-sheet-close" onClick={() => setDetailId(null)} aria-label="Close">×</button>
            <div className="wcf-br-sheet-body">
              <div className="wcf-br-dtop">
                {badge(detail, true)}
                <div>
                  <div className="wcf-br-dname">{detail.company}</div>
                  <div className="wcf-br-dwho">
                    {ownerName(detail)} · <span style={{ color: BOOT_CATEGORY[detail.category].colour }}>{BOOT_CATEGORY[detail.category].label}</span>
                  </div>
                </div>
              </div>
              {detail.description && <div className="wcf-br-ddesc">{detail.description}</div>}
              {detail.tags.length > 0 && (
                <div className="wcf-br-dtags">{detail.tags.map((t) => <span key={t}>{t}</span>)}</div>
              )}
              <div className="wcf-br-proof">{faces(detail)}<span>{endorseLine(detail)}</span></div>

              {detail.phone ? (
                <>
                  <a className="wcf-br-wa" href={`https://wa.me/${detail.phone}`} target="_blank" rel="noreferrer">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.2 1.2-1.7 1.2-.5 0-1.1 0-2-.3a11 11 0 0 1-5.5-4.8c-.5-.9-.8-1.8-.8-2.5 0-.8.4-1.4.8-1.7a1 1 0 0 1 .7-.3h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.4.5c-.1.2-.2.3 0 .5.5.9 1.6 1.9 2.6 2.3.2.1.4.1.5 0l.6-.7c.2-.2.3-.2.5-.1l1.6.8c.3.1.3.3.3.4v.5Z" /></svg>
                    WhatsApp {ownerName(detail).split(" ")[0]}
                  </a>
                  <div className="wcf-br-dnote">Or just have a word at the next game.</div>
                </>
              ) : (
                <div className="wcf-br-dnote spaced">{ownerName(detail).split(" ")[0]} hasn&apos;t added a number — have a word at the next game.</div>
              )}

              {detail.player_id === myId ? (
                <button className="wcf-br-endorse" disabled>It&apos;s your listing — teammates recommend it</button>
              ) : (
                <button className={"wcf-br-endorse" + (endorsedByMe(detail) ? " on" : "")} aria-pressed={endorsedByMe(detail)} onClick={() => toggleEndorse(detail)}>
                  {endorsedByMe(detail) ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7" /></svg>
                  )}
                  {endorsedByMe(detail) ? "You recommend them" : "I'd recommend them"}
                </button>
              )}

              {detail.player_id === myId && (
                <div className="wcf-br-owner">
                  <button className="wcf-br-secondary" onClick={() => openEditor(detail)}>Edit listing</button>
                  <button className="wcf-br-danger" disabled={busy} onClick={() => removeListing(detail)}>Remove</button>
                </div>
              )}
              {detail.player_id !== myId && isAdmin && (
                <button className="wcf-br-danger wide" disabled={busy} onClick={() => removeListing(detail)}>Delete listing (admin)</button>
              )}
            </div>
          </div>
        </div>
      )}

      {editorId && (
        <div className="wcf-sheet-overlay" onClick={() => !busy && setEditorId(null)}>
          <div className="wcf-squad-sheet wcf-br-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wcf-sheet-handle-wrap"><div className="wcf-sheet-handle" /></div>
            <button className="wcf-sheet-close" onClick={() => !busy && setEditorId(null)} aria-label="Close">×</button>
            <div className="wcf-br-sheet-body">
              <div className="wcf-br-ftitle">{editorId === "new" ? "Add your trade" : "Edit your listing"}</div>
              <div className="wcf-br-fsub">Shows up in the Boot Room for the whole club to search.</div>

              <label className="wcf-br-field">
                <span>Company or trade name</span>
                <input
                  ref={companyRef}
                  type="text"
                  className={nameErr ? "bad" : ""}
                  value={fCompany}
                  maxLength={80}
                  onChange={(e) => {
                    setFCompany(e.target.value);
                    setFormErr(null);
                    setNameErr(false);
                  }}
                  placeholder="e.g. Corrigan Plumbing & Heating"
                />
                {nameErr && <span className="wcf-br-hint err">Type your company or trade name here — the grey text is just an example.</span>}
              </label>

              <div className="wcf-br-field">
                <span>Logo (optional)</span>
                <div className="wcf-br-logorow">
                  <button type="button" className="wcf-br-logodrop" onClick={() => fileRef.current?.click()} aria-label={logoPreview ? "Change logo" : "Add a logo"}>
                    {logoPreview ? (
                      <span className={"shot" + (fLogoDark ? " on-dark" : "")}><img src={logoPreview} alt="Logo preview" /></span>
                    ) : (
                      <span className="add">Tap to add</span>
                    )}
                  </button>
                  <div className="wcf-br-logoside">
                    <span className="wcf-br-hint">{logoMsg ?? "PNG or JPG. Transparent backgrounds work best — we keep the transparency."}</span>
                    {logoPreview && (
                      <div className="wcf-br-logoacts">
                        <button type="button" className={!fLogoDark ? "on" : ""} onClick={() => setFLogoDark(false)}>Light tile</button>
                        <button type="button" className={fLogoDark ? "on" : ""} onClick={() => setFLogoDark(true)}>Dark tile</button>
                        <button type="button" onClick={clearLogo}>Remove</button>
                      </div>
                    )}
                  </div>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    onLogoChosen(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>

              <div className="wcf-br-field">
                <span>Which boot are you on?</span>
                <div className="wcf-br-pickgrid">
                  {BOOT_CATEGORIES.map((c) => (
                    <button key={c.key} type="button" className={fCat === c.key ? "on" : ""} style={{ ["--c" as string]: c.colour } as React.CSSProperties} onClick={() => pickCategory(c.key)}>
                      <img src={c.img} alt="" />
                      <b>{c.label}</b>
                    </button>
                  ))}
                </div>
              </div>

              <div className="wcf-br-field">
                <span>What can you help with?</span>
                <div className="wcf-br-tagpick">
                  {BOOT_CATEGORY[fCat].tags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={fTags.includes(t) ? "on" : ""}
                      onClick={() => setFTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <input type="text" value={fOther} maxLength={80} onChange={(e) => setFOther(e.target.value)} placeholder="Something else? Type it, commas between" />
                <span className="wcf-br-hint">Pick what applies — it&apos;s what search matches on.</span>
              </div>

              <label className="wcf-br-field">
                <span>Anything else worth knowing?</span>
                <textarea value={fDesc} maxLength={280} onChange={(e) => setFDesc(e.target.value)} placeholder="Boiler servicing, leaks, radiator swaps. Wirral-wide, evenings usually fine." />
              </label>

              <label className="wcf-br-field">
                <span>WhatsApp number (optional)</span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  className={phoneErr ? "bad" : ""}
                  value={fPhone}
                  onChange={(e) => {
                    setFPhone(e.target.value);
                    setPhoneErr(false);
                  }}
                  placeholder="07700 900123"
                />
                <span className={"wcf-br-hint" + (phoneErr ? " err" : "")}>
                  {phoneErr
                    ? "That doesn't look like a phone number — try something like 07700 900123, or leave it blank."
                    : "Adds a WhatsApp button to your listing. Everyone in the club can see it — leave it blank and people will catch you at the next game."}
                </span>
              </label>

              {formErr && <div className="wcf-br-formerr" role="alert">{formErr}</div>}
              <button className="wcf-br-save" disabled={busy} onClick={saveListing}>
                {busy ? "Saving…" : editorId === "new" ? "Add to the Boot Room" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GaffAILogo({ size }: { size: number }) {
  return (
    <svg viewBox="17 5 511 511" width={size} height={size} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M 310 95 C 170 95 95 180 95 285 C 95 390 170 455 315 455 C 410 455 450 395 450 320 L 290 320" strokeWidth="32" />
      <path d="M 180 185 C 200 135 250 100 320 100 L 375 100" strokeWidth="32" />
      <path d="M 340 65 L 385 100 L 340 135" strokeWidth="32" />
      <path d="M 395 220 L 445 270 M 445 220 L 395 270" strokeWidth="28" />
      <path d="M 265 240 L 225 310 L 285 385 L 355 345" strokeWidth="20" />
      <circle cx="265" cy="240" r="22" fill="currentColor" stroke="none" />
      <circle cx="225" cy="310" r="22" fill="currentColor" stroke="none" />
      <circle cx="285" cy="385" r="22" fill="currentColor" stroke="none" />
      <circle cx="355" cy="345" r="22" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Admin-only floating assistant. Reads anything, but can only ever change
// two things (mark a booking paid, create a draft fixture) and always via
// an explicit in-chat confirm/cancel card - never straight from a typed
// sentence. See app/api/admin/gaffai/route.ts for why that split is
// actually enforced structurally, not just by prompt.
function GaffAIChat({
  getFreshAccessToken,
  onFixtureCreated,
  myId,
  myName,
  askConfirm,
}: {
  getFreshAccessToken: () => Promise<string | null>;
  onFixtureCreated: () => void;
  myId: string;
  myName: string;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<GaffAIMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [nudges, setNudges] = useState<GaffAINudge[]>([]);
  const [flaggedIndexes, setFlaggedIndexes] = useState<Set<number>>(new Set());
  // Long alerts (a list of 14 names) show three lines until tapped.
  const [openNudges, setOpenNudges] = useState<Set<string>>(new Set());
  // Suggested questions stay tucked away until asked for.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState(pickGaffAISuggestions);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function callGaffAI(body: object) {
    const token = await getFreshAccessToken();
    if (!token) {
      setMessages((cur) => [...cur, { role: "assistant", text: "Your session's expired — refresh the page and sign in again." }]);
      return null;
    }
    try {
      const res = await fetch("/api/admin/gaffai", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch {
      setMessages((cur) => [...cur, { role: "assistant", text: "Couldn't reach GaffAI just now — try again in a bit." }]);
      return null;
    }
  }

  // Fresh live facts every call, never a stored "since you last looked"
  // checkpoint - this app already tried that shape (a nav-tab "new"
  // dot, removed 2026-08-12) and it broke on a timezone/axis mismatch,
  // then stayed removed even after the fix because an ambient signal
  // with no content and no per-item dismissal was judged more confusing
  // than helpful. These carry real content and dismiss individually.
  async function loadNudges() {
    const data = await callGaffAI({ type: "nudges" });
    if (data?.type === "nudges" && Array.isArray(data.nudges)) setNudges(data.nudges);
  }

  useEffect(() => {
    loadNudges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) loadNudges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Persisted conversation memory - loads the most recent turns so the
  // chat survives a refresh/reopen/different device instead of starting
  // blank every time. 40 is deliberately generous but bounded: the route
  // only ever sends the last 20 turns on to the model regardless
  // (historyIn.slice(-20) in app/api/admin/gaffai/route.ts), so holding
  // meaningfully more than that here would just bloat the initial render
  // without the model ever using the extra context. Deliberately only
  // role+text - a loaded row for what was once an action_proposal has no
  // `action` set, so it just renders as an inert bot bubble with no
  // Confirm/Cancel button (see the render below) rather than resurrecting
  // a days-old proposal that might now be acting on stale data.
  async function loadHistory() {
    const { data } = await supabase
      .from("gaffai_conversations")
      .select("role, text")
      .eq("admin_id", myId)
      .order("created_at", { ascending: false })
      .limit(40);
    if (data) setMessages([...data].reverse().map((r) => ({ role: r.role as "user" | "assistant", text: r.text })));
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Direct client write (RLS-scoped, admin-only), same pattern as the
  // existing feed_hidden_items hide/unhide - a row present just means
  // "dismissed," no route needed.
  async function dismissNudge(key: string) {
    setNudges((cur) => cur.filter((n) => n.key !== key));
    await supabase.from("gaffai_dismissed_nudges").insert({ nudge_key: key, dismissed_by: myId });
  }

  // Pure data capture, reviewed manually later - not something GaffAI
  // acts on live. Same review loop as every fix this session so far,
  // just structured instead of relying on the admin happening to
  // mention a wrong answer in conversation.
  async function flagAnswer(index: number) {
    const msg = messages[index];
    const question = [...messages.slice(0, index)].reverse().find((m) => m.role === "user")?.text ?? "(no preceding question)";
    setFlaggedIndexes((cur) => new Set(cur).add(index));
    await supabase.from("gaffai_feedback").insert({ flagged_by: myId, question, answer: msg.text });
  }

  async function send(text: string) {
    if (!text.trim() || loading) return;
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((cur) => [...cur, { role: "user", text }]);
    setInput("");
    setLoading(true);
    const data = await callGaffAI({ type: "message", text, history });
    setLoading(false);
    if (!data) return;

    if (data.type === "action_proposal") {
      setMessages((cur) => [...cur, { role: "assistant", text: data.text, action: data.action, actionState: "pending" }]);
    } else if (data.type === "answer") {
      setMessages((cur) => [...cur, { role: "assistant", text: data.text }]);
    } else {
      setMessages((cur) => [...cur, { role: "assistant", text: data.error || "Something went wrong." }]);
    }
  }

  async function confirmAction(index: number) {
    const msg = messages[index];
    if (!msg.action) return;
    const data = await callGaffAI({ type: "confirm_action", action: msg.action });
    if (!data) return;
    setMessages((cur) => cur.map((m, i) => (i === index ? { ...m, actionState: data.ok ? "confirmed" : "failed", text: data.text ?? m.text } : m)));
    if (data.ok && (msg.action.kind === "create_fixture" || msg.action.kind === "publish_fixture")) onFixtureCreated();
  }

  function cancelAction(index: number) {
    setMessages((cur) => cur.map((m, i) => (i === index ? { ...m, actionState: "cancelled" } : m)));
  }

  async function resetChat() {
    if (messages.length > 0) {
      const ok = await askConfirm(
        "Clear this conversation?",
        "This also forgets everything GaffAI remembers from past chats - next time starts fresh.",
        "Clear",
        true
      );
      if (!ok) return;
    }
    setMessages([]);
    setInput("");
    setSuggestions(pickGaffAISuggestions());
    await supabase.from("gaffai_conversations").delete().eq("admin_id", myId);
  }

  // The button floats over whatever list is underneath, so on admin
  // screens it sat on top of each row's badge in turn. It fades and shrinks
  // while anything scrolls, and comes back once scrolling stops. A
  // capture-phase listener on document catches the inner scroll containers
  // too, since scroll events don't bubble.
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setScrolling(true);
      clearTimeout(t);
      t = setTimeout(() => setScrolling(false), 650);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(t);
    };
  }, []);

  return (
    <>
      <div className={"gaffai-fab-wrap" + (scrolling ? " scrolling" : "")}>
        <div className="gaffai-fab-ring" />
        <button className="gaffai-fab" onClick={() => setOpen(true)} aria-label="Open GaffAI">
          <GaffAILogo size={44} />
        </button>
        {nudges.length > 0 && <span className="gaffai-fab-badge">{nudges.length}</span>}
      </div>

      {open && (
        <div className="gaffai-backdrop" onClick={() => setOpen(false)}>
          <div className="gaffai-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="gaffai-sheet-handle" />
            <div className="gaffai-sheet-head">
              <div className="gaffai-sheet-ico">
                <GaffAILogo size={27} />
              </div>
              <div className="gaffai-sheet-titles">
                <div className="gaffai-sheet-title">GaffAI</div>
                <div className="gaffai-sheet-sub">Admins only · asks before acting</div>
              </div>
              <button className="gaffai-sheet-reset" onClick={resetChat} aria-label="Reset conversation" title="Reset">
                ↺
              </button>
              <button className="gaffai-sheet-close" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="gaffai-messages" ref={scrollRef}>
              {nudges.map((n) => {
                const money = /^(unpaid|overdue)-/.test(n.key);
                const reachOut = /^journey-(never-booked|one-and-done|lapsed)-/.test(n.key);
                const label = money ? "Draft a reminder" : reachOut ? "Draft messages" : "What should I do?";
                const ask = money
                  ? `Draft a short payment reminder for this: ${n.text}`
                  : reachOut
                    ? `Draft a short, friendly personal message for each of these players, one at a time, that I can send: ${n.text}`
                    : `What should I do about this? ${n.text}`;
                return (
                  <div key={n.key} className="gaffai-needs">
                    <div className="gaffai-needs-k">Needs you</div>
                    <div
                      role="button"
                      tabIndex={0}
                      className={"gaffai-needs-t" + (openNudges.has(n.key) ? " open" : "")}
                      onClick={() =>
                        setOpenNudges((cur) => {
                          const next = new Set(cur);
                          if (next.has(n.key)) next.delete(n.key);
                          else next.add(n.key);
                          return next;
                        })
                      }
                    >
                      {n.text}
                    </div>
                    {n.text.length > 150 && !openNudges.has(n.key) && <div className="gaffai-needs-more">Show all</div>}
                    <div className="gaffai-needs-acts">
                      <button
                        className="gaffai-needs-go"
                        disabled={loading}
                        onClick={() => send(ask)}
                      >
                        {label}
                      </button>
                      <button className="gaffai-needs-x" onClick={() => dismissNudge(n.key)}>Dismiss</button>
                    </div>
                  </div>
                );
              })}
              {messages.length === 0 && (() => {
                const h = Number(nowInLondon().slice(11, 13));
                const first = myName.trim().split(/\s+/)[0];
                return (
                  <div className="gaffai-hello">
                    <div className="gaffai-hello-t">{h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening"}{first ? `, ${first}` : ""}.</div>
                    <div className="gaffai-hello-s">Ask about players, payments, games or stats.</div>
                    <button className={"gaffai-sugg-toggle" + (showSuggestions ? " open" : "")} onClick={() => setShowSuggestions((v) => !v)} aria-expanded={showSuggestions}>
                      Suggested questions
                      <span aria-hidden="true">›</span>
                    </button>
                    {showSuggestions && (
                    <div className="gaffai-chip-groups">
                      {suggestions.map((grp) => (
                        <div key={grp.group}>
                          <div className="gaffai-chip-label">{grp.group}</div>
                          <div className="gaffai-chips">
                            {grp.items.map((q) => (
                              <button key={q} className="gaffai-chip" onClick={() => send(q)}>
                                {q}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    )}
                  </div>
                );
              })()}
              {messages.map((m, i) => (
                <div key={i} className={"gaffai-msg " + (m.role === "user" ? "user" : "bot") + (m.action ? " action-card" : "")}>
                  {m.role === "assistant" ? <GaffAIText text={m.text} /> : m.text}
                  {m.role === "assistant" && !m.action && (
                    <button
                      className={"gaffai-flag" + (flaggedIndexes.has(i) ? " flagged" : "")}
                      onClick={() => flagAnswer(i)}
                      disabled={flaggedIndexes.has(i)}
                      aria-label="Flag this answer as wrong"
                      title={flaggedIndexes.has(i) ? "Flagged for review" : "Flag as wrong"}
                    >
                      ⚑
                    </button>
                  )}
                  {m.action && m.actionState === "pending" && (
                    <div className="gaffai-action-buttons">
                      <button className="gaffai-action-confirm" onClick={() => confirmAction(i)}>
                        ✓ Confirm
                      </button>
                      <button className="gaffai-action-cancel" onClick={() => cancelAction(i)}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {m.action && m.actionState === "cancelled" && <div className="gaffai-action-result cancel">Cancelled — no changes made.</div>}
                  {m.action && m.actionState === "confirmed" && (
                    <div className="gaffai-action-result success">
                      <span className="gaffai-done">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                        Done
                      </span>
                    </div>
                  )}
                  {m.action && m.actionState === "failed" && <div className="gaffai-action-result cancel">Couldn't complete that.</div>}
                </div>
              ))}
              {loading &&
                (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? (
                  <div className="gaffai-typing">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  <TikiTaka />
                ))}
            </div>


            <div className="gaffai-composer">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send(input)}
                placeholder="Ask something…"
              />
              <button className="gaffai-send" onClick={() => send(input)} aria-label="Send">
                ➤
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Same collapse pattern as "View players"/Tabs elsewhere - reused here as
// a small generic wrapper since Account groups several of these back to
// back (settings, rating, guides, and - for admins - roles/log/settings/
// awards) rather than each hand-rolling its own toggle button.
// A note on the Teams tab: line icon, short title, one specific line.
// Gold = a tip, red = a real imbalance, green = all good.
function TeamCallout({ tone, icon, title, children }: { tone: "gold" | "red" | "green"; icon: "glove" | "scale" | "split" | "check"; title: string; children: React.ReactNode }) {
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

// "How was tonight?" - the one-tap heat meter, 1 (Scrappy) to 5 (Classic).
// Slides up the first time a player who played opens the app after the
// score's in; then straight on to the MOTM vote if it's open, or the
// squad's verdict if not. Anonymous; feeds the end-of-season Wrapped.
const RATING_WORDS = ["Scrappy", "Average", "Decent", "Great game", "Classic"];
function RateGameMeter({ value, onRate, small }: { value: number; onRate: (n: number) => void; small?: boolean }) {
  return (
    <div className={"wcf-rate-meter" + (small ? " small" : "")} role="radiogroup" aria-label="Rate the game">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={value === n} aria-label={`${n} of 5, ${RATING_WORDS[n - 1]}`} className={n <= value ? "on" : ""} style={{ ["--i" as string]: n - 1 }} onClick={() => onRate(n)} />
      ))}
    </div>
  );
}
function RateGameSheet({
  game,
  cs,
  rating,
  votingOpen,
  summary,
  onRate,
  onVote,
  onClose,
}: {
  game: GameRow;
  cs: ClubSettings;
  rating: number;
  votingOpen: boolean;
  summary: { ratings: number; average: number | null } | null;
  onRate: (n: number) => void;
  onVote: () => void;
  onClose: () => void;
}) {
  const day = new Date(game.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();
  // Final whistle: three blasts, then each score clicks up to the result.
  const [motion] = useState(() => typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const fullW = game.team_white_score ?? 0;
  const fullR = game.team_red_score ?? 0;
  const [shownW, setShownW] = useState(motion ? 0 : fullW);
  const [shownR, setShownR] = useState(motion ? 0 : fullR);
  useEffect(() => {
    if (!motion) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = (to: number, set: (n: number) => void, start: number) => {
      let t = start;
      for (let n = 1; n <= to; n++) {
        t += 70 + n * 9;
        timers.push(setTimeout(() => set(n), t));
      }
    };
    run(fullW, setShownW, 1400);
    run(fullR, setShownR, 1650);
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="wcf-rate-overlay" onClick={onClose}>
      <div className="wcf-rate" onClick={(e) => e.stopPropagation()}>
        <div className="wcf-rate-photo">
          <span className="wcf-rate-k">{day} · FULL TIME</span>
          <button className="wcf-rate-x" onClick={onClose} aria-label="Close">✕</button>
          {motion && (
            <svg className="wcf-rate-whistle" viewBox="0 0 44 44" aria-hidden="true">
              <path className="body" d="M6 20h18l10-6v6a10 10 0 1 1-20 6" />
              <circle cx="16" cy="27" r="3" fill="none" stroke="#f5d97a" strokeWidth="2" />
              <path className="wave" d="M37 10q3 3 0 6" />
              <path className="wave" d="M40 7q5 6 0 12" />
              <path className="wave" d="M43 4q7 9 0 18" />
            </svg>
          )}
          <div className="wcf-rate-score">
            <span key={"w" + shownW} className={motion && shownW > 0 ? "wcf-flap" : undefined}>{shownW}</span>
            <small>{cs.team_white_name.toUpperCase()} · {cs.team_red_name.toUpperCase()}</small>
            <span key={"r" + shownR} className={motion && shownR > 0 ? "wcf-flap" : undefined}>{shownR}</span>
          </div>
        </div>
        <div className="wcf-rate-body">
          <div className="wcf-rate-q">{rating ? "Thanks, noted." : "How was tonight?"}</div>
          <RateGameMeter value={rating} onRate={onRate} />
          <div className="wcf-rate-ends"><span>Scrappy</span><span>Classic</span></div>
          <div key={rating} className={"wcf-rate-verdict" + (rating ? " pop" : "")}>{rating ? RATING_WORDS[rating - 1] : " "}</div>
          {rating > 0 && votingOpen && (
            <button className="wcf-rate-next" onClick={onVote}>Vote Man of the Match →</button>
          )}
          {rating > 0 && !votingOpen && summary && summary.ratings > 0 && (
            <div className="wcf-rate-squad">
              The squad rates it <b>{summary.average?.toFixed(1)}</b> out of 5, from {summary.ratings} {summary.ratings === 1 ? "rating" : "ratings"}.
            </div>
          )}
          {!rating && <div className="wcf-rate-foot">One tap · anonymous · feeds the end-of-season awards</div>}
          {rating > 0 && <button className="wcf-rate-done" onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// Line icons for the Account settings rows, in place of the old ◆ ★ ◎
// symbol tiles.
function SetIcon({ name }: { name: "bell" | "user" | "phone" | "cake" | "star" | "mobile" | "mail" | "users" | "list" | "gear" | "trophy" | "shield" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />,
    cake: <><rect x="3" y="10" width="18" height="11" rx="2" /><path d="M12 10V6M8 10V7M16 10V7M3 15c3 2 6-2 9 0s6 2 9 0" /></>,
    star: <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z" />,
    mobile: <><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M11 18h2" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
    users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
    list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
    trophy: <><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>,
    shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  };
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function AccordionSection({
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
        <span className="wcf-acc-section-chevron" aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="wcf-acc-section-panel">
          <div className="wcf-acc-section-panel-inner">{children}</div>
        </div>
      )}
    </div>
  );
}

// "07700 900123" -> "447700900123" for a wa.me link.
function whatsAppNumber(mobile: string) {
  const d = mobile.replace(/[^\d]/g, "");
  return d.startsWith("0") ? "44" + d.slice(1) : d;
}

function agoLabel(iso: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} ${hrs === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

// Admin > New members: the approval switch and everyone waiting to join.
function NewMembersSection({
  requireApproval,
  available,
  onSetRequireApproval,
  members,
  justLetIn,
  onDismissLetIn,
  onDecide,
}: {
  requireApproval: boolean;
  available: boolean;
  onSetRequireApproval: (on: boolean) => void;
  members: PendingMember[];
  justLetIn: { id: string; name: string; mobile: string | null }[];
  onDismissLetIn: (id: string) => void;
  onDecide: (m: PendingMember, action: "approve" | "decline") => void;
}) {
  const waiting = members.filter((m) => m.status === "pending");
  const declined = members.filter((m) => m.status === "declined");
  const [open, setOpen] = useState(waiting.length > 0);
  const [showDeclined, setShowDeclined] = useState(false);
  useEffect(() => {
    if (waiting.length > 0) setOpen(true);
  }, [waiting.length]);
  const card = (m: PendingMember) => (
    <div key={m.id} className={"wcf-join-req" + (m.status === "declined" ? " declined" : "")}>
      <div className="wcf-join-req-top">
        <span className="wcf-join-req-av">{m.display_name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
        <div>
          <b>{m.display_name}</b>
          <span>{m.requested_at ? `Asked ${agoLabel(m.requested_at)}` : `Signed up ${agoLabel(m.created_at)}, hasn't filled in the form yet`}</span>
        </div>
      </div>
      {m.requested_at && (
        <div className="wcf-join-req-knows">{m.referral_note ? <>Knows: <em>&ldquo;{m.referral_note}&rdquo;</em></> : "Didn't say who they know."}</div>
      )}
      <div className="wcf-join-req-acts">
        {m.status === "pending" && <button className="ghost" onClick={() => onDecide(m, "decline")}>Decline</button>}
        <button className="gold" onClick={() => onDecide(m, "approve")}>Let in</button>
      </div>
    </div>
  );
  return (
    <AccordionSection
      icon={<SetIcon name="shield" />}
      tone={waiting.length ? "amber" : undefined}
      title="New members"
      meta={!available ? "Needs its database update" : waiting.length ? `${waiting.length} waiting to join` : requireApproval ? "Approval on" : "Approval off"}
      value={waiting.length ? String(waiting.length) : undefined}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="wcf-approve-row">
        <div>
          <b>Approve new members</b>
          <span>{requireApproval ? "New sign-ups wait until an admin lets them in." : "Off: new sign-ups go straight in, like before."}</span>
        </div>
        <button
          role="switch"
          aria-checked={requireApproval}
          aria-label="Approve new members"
          disabled={!available}
          className={"wcf-switch" + (requireApproval ? " on" : "")}
          onClick={() => onSetRequireApproval(!requireApproval)}
        />
      </div>
      <p className="wcf-admin-hint">Everyone already in isn&apos;t affected, and players you add yourself are always let in.</p>
      {justLetIn.map((j) => (
        <div key={j.id} className="wcf-join-done">
          <span>
            <b>{j.name}</b> is in.
            {j.mobile && (
              <>
                {" "}
                <a
                  href={`https://wa.me/${whatsAppNumber(j.mobile)}?text=${encodeURIComponent(`You're in! Welcome to Wirral Community Football, ${j.name.split(" ")[0]}. Open the app to book your first game.`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Message on WhatsApp
                </a>
              </>
            )}
          </span>
          <button aria-label="Dismiss" onClick={() => onDismissLetIn(j.id)}>×</button>
        </div>
      ))}
      {waiting.length === 0 && justLetIn.length === 0 && <p className="wcf-admin-hint">Nobody waiting to join.</p>}
      {waiting.map(card)}
      {declined.length > 0 && (
        <>
          <button className="wcf-join-declined-toggle" onClick={() => setShowDeclined((v) => !v)}>
            {showDeclined ? "Hide" : "Show"} declined ({declined.length})
          </button>
          {showDeclined && declined.map(card)}
        </>
      )}
    </AccordionSection>
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
  myEmergencyContact,
  onSaveEmergencyContact,
  myBirthday,
  onSaveBirthday,
  ratingPlayerId,
  onToggleRatingPlayer,
  myRecord,
  myGoals,
  onOpenMyCard,
  myUpcomingBookings,
  myTabOwed,
  myTabPending,
  onMarkPaid,
  messages,
  onMarkMessageRead,
  onMarkAllRead,
  askConfirm,
  newMembers,
}: {
  newMembers?: React.ReactNode;
  profile: Profile;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  profiles: Profile[];
  myRecord: { played: number; won: number; drawn: number; lost: number; winPct: number | null };
  myGoals: number;
  onOpenMyCard: () => void;
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
  myEmergencyContact: EmergencyContact | null;
  onSaveEmergencyContact: (contactName: string, contactPhone: string) => void;
  myBirthday: PlayerBirthday | null;
  onSaveBirthday: (dateOfBirth: string) => void;
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
  onMarkAllRead: () => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const [contactName, setContactName] = useState(myEmergencyContact?.contact_name ?? "");
  const [contactPhone, setContactPhone] = useState(myEmergencyContact?.contact_phone ?? "");
  const [dobDraft, setDobDraft] = useState(myBirthday?.date_of_birth ?? "");
  const myMessages = messages.filter((m) => m.recipient_id === profile.id);
  const unreadMessages = myMessages.filter((m) => !m.read_at);
  const readMessages = myMessages.filter((m) => m.read_at);
  const [openReadMessages, setOpenReadMessages] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [roleSearch, setRoleSearch] = useState("");
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  const [openRoleTool, setOpenRoleTool] = useState<"add" | "code" | null>(null);
  const [renamingPlayerId, setRenamingPlayerId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const filteredRoleProfiles = profiles.filter((p) => p.display_name.toLowerCase().includes(roleSearch.trim().toLowerCase()));
  const [pushBusy, setPushBusy] = useState(false);
  // Settings rows are collapsed by default and only one is open at a time -
  // everything there is "set once, rarely touched again".
  const [openSetting, setOpenSetting] = useState<"name" | "contact" | "birthday" | "rating" | null>(null);
  const toggleSetting = (k: "name" | "contact" | "birthday" | "rating") => setOpenSetting((cur) => (cur === k ? null : k));
  // A player can have a dozen unread reminders; the newest two are what
  // matter, and each one shows two lines until tapped.
  const [showAllUnread, setShowAllUnread] = useState(false);
  const [openMessageIds, setOpenMessageIds] = useState<Set<string>>(() => new Set());
  // Regulars book weeks ahead, so the full list can run to 20; the next few
  // are what matter day to day.
  const [showAllBookings, setShowAllBookings] = useState(false);
  const BOOKINGS_SHOWN = 3;
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
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
  useEffect(() => {
    setContactName(myEmergencyContact?.contact_name ?? "");
    setContactPhone(myEmergencyContact?.contact_phone ?? "");
  }, [myEmergencyContact]);
  useEffect(() => setDobDraft(myBirthday?.date_of_birth ?? ""), [myBirthday]);

  // Automatic reminders are sent with no sender; anything an admin typed
  // carries their id, so it can say who it's from.
  const senderLabel = (m: AdminMessage) =>
    m.sender_id ? `From ${profiles.find((p) => p.id === m.sender_id)?.display_name ?? "an admin"}` : "From the club";
  const INBOX_SHOWN = 2;
  const inboxRow = (m: AdminMessage) => {
    const open = openMessageIds.has(m.id);
    return (
      <div key={m.id} className={"wcf-inbox-row" + (m.read_at ? "" : " unread") + (open ? " open" : "")}>
        <button
          className="wcf-inbox-row-head"
          aria-expanded={open}
          onClick={() =>
            setOpenMessageIds((cur) => {
              const next = new Set(cur);
              if (next.has(m.id)) next.delete(m.id);
              else next.add(m.id);
              return next;
            })
          }
        >
          <span className="wcf-inbox-row-dot" aria-hidden="true" />
          <span className="wcf-inbox-row-main">
            <span className="wcf-inbox-row-top">
              <span className="wcf-inbox-row-from">{senderLabel(m)}</span>
              <span className="wcf-inbox-row-when">{fmtDateTime(m.created_at)}</span>
            </span>
            <span className="wcf-inbox-row-body">{m.message}</span>
          </span>
        </button>
        {open && !m.read_at && (
          <button className="wcf-inbox-row-read" onClick={() => onMarkMessageRead(m.id)}>Mark as read</button>
        )}
      </div>
    );
  };

  // iPhones only allow notifications once the app is on the home screen, so
  // there "Turn on" shows the install guide first instead of failing.
  async function turnOnNotifications() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (ios && !standalone) {
      setOpenGuide("install");
      return;
    }
    setPushBusy(true);
    await onEnablePush();
    setPushBusy(false);
  }

  const setValue = (done: boolean) => (done ? "Set ✓" : "Add");

  return (
    <div className="wcf-account">
      {/* Same family as the Player of the Month and "Your season" cards:
          your face and your record, tapping through to your player card. */}
      <div className="wcf-me">
        <div className="wcf-me-top">
          <div className="wcf-account-avatar-wrap">
            <Avatar name={profile.display_name} avatarUrl={profile.avatar_url} className="wcf-avatar wcf-me-avatar" />
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
          <button className="wcf-me-who" onClick={onOpenMyCard}>
            <span className="wcf-me-name">{profile.display_name}</span>
            <span className={"wcf-role-badge small " + profile.role}>{ROLE_LABEL[profile.role]}</span>
          </button>
        </div>
        {myRecord.played > 0 ? (
          <button className="wcf-me-record" onClick={onOpenMyCard}>
            <span className="wcf-me-stats">
              <span><b>{myRecord.played}</b>Played</span>
              <span><b>{myRecord.won}</b>Won</span>
              <span><b>{myGoals}</b>{myGoals === 1 ? "Goal" : "Goals"}</span>
              <span><b>{myRecord.winPct}%</b>Win rate</span>
            </span>
            <span className="wcf-me-bar" aria-hidden="true">
              {myRecord.won > 0 && <i className="w" style={{ flex: myRecord.won }} />}
              {myRecord.drawn > 0 && <i className="d" style={{ flex: myRecord.drawn }} />}
              {myRecord.lost > 0 && <i className="l" style={{ flex: myRecord.lost }} />}
            </span>
            <span className="wcf-me-foot">
              <span>{myRecord.won}W · {myRecord.drawn}D · {myRecord.lost}L</span>
              <span className="wcf-me-link">View your player card ›</span>
            </span>
          </button>
        ) : (
          <p className="wcf-me-empty">Your record starts after your first game.</p>
        )}
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
            {unreadMessages.length > 1 && (
              <button className="wcf-inbox-allread" onClick={onMarkAllRead}>Mark all read</button>
            )}
          </div>
          {(showAllUnread ? unreadMessages : unreadMessages.slice(0, INBOX_SHOWN)).map(inboxRow)}
          {unreadMessages.length > INBOX_SHOWN && (
            <button className="wcf-rec-more" onClick={() => setShowAllUnread((v) => !v)}>
              {showAllUnread ? "Show fewer" : `${unreadMessages.length - INBOX_SHOWN} more unread`}
            </button>
          )}
          {unreadMessages.length === 0 && <EmptyScene kind="inbox" small title="All caught up" text="No new messages." />}
          {readMessages.length > 0 && (
            <button className="wcf-rec-more quiet" onClick={() => setOpenReadMessages((v) => !v)}>
              {openReadMessages ? "Hide read messages" : `Read messages (${readMessages.length})`}
            </button>
          )}
          {openReadMessages && readMessages.map(inboxRow)}
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
          {(showAllBookings ? myUpcomingBookings : myUpcomingBookings.slice(0, BOOKINGS_SHOWN)).map(({ game, booking }) => {
            const d = new Date(game.date + "T00:00:00");
            // Same queue order as the fixture card's "2nd in line".
            const queuePos = booking.waiting
              ? game.bookings.filter((b) => b.waiting).sort((a, b) => a.created_at.localeCompare(b.created_at)).findIndex((b) => b.id === booking.id) + 1
              : 0;
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
                  <span className="wcf-booking-badge amber">{queuePos === 1 ? "NEXT IN LINE" : queuePos > 1 ? `${nth(queuePos).toUpperCase()} IN LINE` : "WAITING LIST"}</span>
                ) : (
                  <StatusBadge status={booking.status} />
                )}
              </div>
            );
          })}
          {myUpcomingBookings.length > BOOKINGS_SHOWN && (
            <button className="wcf-rec-more" onClick={() => setShowAllBookings((v) => !v)}>
              {showAllBookings ? "Show fewer" : `Show all ${myUpcomingBookings.length} bookings`}
            </button>
          )}
        </>
      )}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Settings</span>
        <span className="wcf-console-section-rule" />
      </div>

      {/* Out of the settings list on purpose: kickoff reminders, spot
          alerts and Wrapped all depend on it. */}
      <div className={"wcf-notif-card" + (pushOn ? " on" : "")}>
        <span className="wcf-notif-ic"><SetIcon name="bell" /></span>
        <div className="wcf-notif-text">
          <div className="wcf-notif-title">{pushOn ? "Notifications on" : "Notifications are off"}</div>
          <div className="wcf-notif-sub">
            {pushOn ? "Kickoff reminders, payment nudges, spots opening up" : "You'll miss kickoff reminders and spots opening up"}
          </div>
        </div>
        {pushOn ? (
          <button
            className="wcf-push-toggle on"
            disabled={pushBusy}
            aria-label="Turn off notifications"
            aria-pressed
            onClick={async () => {
              setPushBusy(true);
              await onDisablePush();
              setPushBusy(false);
            }}
          >
            <span className="wcf-push-toggle-knob" />
          </button>
        ) : (
          <button className="wcf-notif-on" disabled={pushBusy} onClick={turnOnNotifications}>Turn on</button>
        )}
      </div>
      {pushOn && (
        <button className="wcf-notif-test" onClick={onSendTestPush}>Send me a test notification</button>
      )}

      <div className="wcf-set-label">Your details</div>
      <div className="wcf-set-group">
        <AccordionSection icon={<SetIcon name="user" />} title="Display name" value={profile.display_name} open={openSetting === "name"} onToggle={() => toggleSetting("name")}>
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
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="phone" />}
          title="Emergency contact"
          value={setValue(!!myEmergencyContact)}
          valueTone={myEmergencyContact ? "ok" : "add"}
          open={openSetting === "contact"}
          onToggle={() => toggleSetting("contact")}
        >
          <label className="wcf-account-field">
            Emergency contact
            <div className="wcf-account-emergency">
              <input placeholder="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
              <input placeholder="Phone number" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              <button
                onClick={() => onSaveEmergencyContact(contactName.trim(), contactPhone.trim())}
                disabled={
                  !contactName.trim() ||
                  !contactPhone.trim() ||
                  (contactName.trim() === (myEmergencyContact?.contact_name ?? "") &&
                    contactPhone.trim() === (myEmergencyContact?.contact_phone ?? ""))
                }
              >
                Save
              </button>
            </div>
            <span className="wcf-push-sub">Who to call if something happens during a game. Only you and admins can see this.</span>
          </label>
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="cake" />}
          title="Birthday"
          value={setValue(!!myBirthday)}
          valueTone={myBirthday ? "ok" : "add"}
          open={openSetting === "birthday"}
          onToggle={() => toggleSetting("birthday")}
        >
          <label className="wcf-account-field">
            Date of birth
            <div className="wcf-account-emergency">
              <input
                type="date"
                value={dobDraft}
                max={nowInLondon().slice(0, 10)}
                min="1920-01-01"
                onChange={(e) => setDobDraft(e.target.value)}
              />
              <button onClick={() => onSaveBirthday(dobDraft)} disabled={!dobDraft || dobDraft === (myBirthday?.date_of_birth ?? "")}>
                Save
              </button>
            </div>
            <span className="wcf-push-sub">Optional - only you and admins can see this. Lets GaffAI flag your birthday to the admins, and helps with squad planning.</span>
          </label>
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="star" />}
          title="Rate yourself"
          meta="Helps admins pick fair teams"
          value={setValue(!!myRating)}
          valueTone={myRating ? "ok" : "add"}
          open={openSetting === "rating"}
          onToggle={() => toggleSetting("rating")}
        >
          <div className="wcf-rating-section">
            <p className="wcf-rating-note">
              Only visible to you and admins — once an admin rates you, theirs takes over.
            </p>
            <RatingForm initial={myRating} onSave={onSaveSelfRating} saveLabel={myRating ? "Update my rating" : "Save my rating"} />
          </div>
        </AccordionSection>
      </div>

      <div className="wcf-set-label">Help</div>
      <div className="wcf-set-group">
        <button className="wcf-set-link" onClick={() => setOpenGuide("install")}>
          <span className="wcf-acc-section-tile"><SetIcon name="mobile" /></span>
          <span className="wcf-set-link-title">Add to your home screen</span>
          <span className="wcf-set-chev" aria-hidden="true">›</span>
        </button>
        <button className="wcf-set-link" onClick={() => setOpenGuide("notifications")}>
          <span className="wcf-acc-section-tile"><SetIcon name="bell" /></span>
          <span className="wcf-set-link-title">How to turn on notifications</span>
          <span className="wcf-set-chev" aria-hidden="true">›</span>
        </button>
        <a className="wcf-set-link" href="/privacy">
          <span className="wcf-acc-section-tile"><SetIcon name="shield" /></span>
          <span className="wcf-set-link-title">Privacy</span>
          <span className="wcf-set-chev" aria-hidden="true">›</span>
        </a>
        <div className="wcf-set-link static">
          <span className="wcf-acc-section-tile"><SetIcon name="mail" /></span>
          <span className="wcf-set-link-title">Signed in as</span>
          <span className="wcf-set-email">{email}</span>
        </div>
      </div>

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
        <div className="wcf-set-group">
        {newMembers}
        <AccordionSection icon={<SetIcon name="users" />} title="Manage roles" meta={`${profiles.length} players`} open={showRoles} onToggle={() => setShowRoles((v) => !v)}>
          {pushStats && (
            <div className="wcf-roles-stats">
              <div className="wcf-roles-stat">
                <span className="wcf-roles-stat-num">{pushStats.subscribed}</span>
                <span className="wcf-roles-stat-label">of {pushStats.total} get notifications</span>
              </div>
              <div className="wcf-roles-stat">
                <span className="wcf-roles-stat-num">{profiles.length}</span>
                <span className="wcf-roles-stat-label">members</span>
              </div>
            </div>
          )}
          {/* The two forms open on demand instead of always taking up the top. */}
          <div className="wcf-roles-tools">
            <button className={"wcf-roles-tool" + (openRoleTool === "add" ? " on" : "")} onClick={() => setOpenRoleTool((t) => (t === "add" ? null : "add"))}>
              + Add a player
            </button>
            <button className={"wcf-roles-tool" + (openRoleTool === "code" ? " on" : "")} onClick={() => setOpenRoleTool((t) => (t === "code" ? null : "code"))}>
              Send a login code
            </button>
          </div>
          {openRoleTool === "add" && <AddPlayerForm onAdd={onAddPlayer} />}
          {openRoleTool === "code" && <LoginCodeForm onGenerate={onGenerateLoginCode} />}

          <label className="wcf-roles-search-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input className="wcf-roles-search" placeholder={`Search ${profiles.length} members…`} value={roleSearch} onChange={(e) => setRoleSearch(e.target.value)} />
          </label>
          {roleSearch.trim() && filteredRoleProfiles.length === 0 && (
            <p className="wcf-empty small">No one matches &quot;{roleSearch.trim()}&quot;.</p>
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
            const rated = adminRatings.some((r) => r.player_id === p.id);
            const menuOpen = roleMenuFor === p.id;
            const act = (fn: () => void) => {
              setRoleMenuFor(null);
              fn();
            };
            return (
              <div key={p.id} className={"wcf-roles-row" + (menuOpen || renamingPlayerId === p.id || ratingPlayerId === p.id ? " open" : "")}>
                <div className="wcf-roles-row-top">
                  <Avatar name={p.display_name} avatarUrl={p.avatar_url} className="wcf-roles-avatar" background={avatarFor(p.display_name).gradient} />
                  <div className="wcf-roles-who">
                    <div className="wcf-roles-name">
                      {p.display_name}
                      {isSelf ? " (you)" : ""}
                      {p.role !== "player" && <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span>}
                    </div>
                    <div className="wcf-roles-sub">{rated ? "Rated" : "Not rated"}</div>
                  </div>
                  <button className="wcf-roles-more" onClick={() => setRoleMenuFor(menuOpen ? null : p.id)} aria-label={`Actions for ${p.display_name}`} aria-expanded={menuOpen}>
                    ⋯
                  </button>
                </div>

                {menuOpen && (
                  <div className="wcf-roles-menu">
                    <button onClick={() => act(() => onToggleRatingPlayer(p.id))}>{rated ? "Edit rating" : "Rate player"}</button>
                    <button onClick={() => act(() => { setRenamingPlayerId(p.id); setRenameDraft(p.display_name); })}>Rename</button>
                    {p.role === "player" && (
                      <button
                        onClick={() =>
                          act(async () => {
                            if (await askConfirm("Make admin?", `${p.display_name} will be able to manage fixtures, payments, and other players.`, "Make admin", false)) onSetRole(p.id, "admin");
                          })
                        }
                      >
                        Make admin<small>Can manage fixtures, payments and players</small>
                      </button>
                    )}
                    {p.role === "admin" && isOwner && (
                      <>
                        <button
                          onClick={() =>
                            act(async () => {
                              if (await askConfirm("Make co-owner?", `Only you'll be able to change or remove ${p.display_name}'s access afterwards.`, "Make co-owner", false)) onSetRole(p.id, "co-owner");
                            })
                          }
                        >
                          Make co-owner
                        </button>
                        <button
                          onClick={() =>
                            act(async () => {
                              const title = isSelf ? "Remove your own admin access?" : `Remove admin access from ${p.display_name}?`;
                              const msg = isSelf ? "You'll need the owner (or the SQL Editor) to get it back." : "They'll go back to being a regular player.";
                              if (await askConfirm(title, msg, "Remove admin")) onSetRole(p.id, "player");
                            })
                          }
                        >
                          Remove admin
                        </button>
                      </>
                    )}
                    {p.role === "co-owner" && isOwner && (
                      <button
                        onClick={() =>
                          act(async () => {
                            const title = isSelf ? "Remove your own co-owner access?" : `Remove co-owner access from ${p.display_name}?`;
                            const msg = isSelf ? "You'll need the owner to get it back." : "They'll become an admin.";
                            if (await askConfirm(title, msg, "Remove co-owner")) onSetRole(p.id, "admin");
                          })
                        }
                      >
                        Remove co-owner
                      </button>
                    )}
                    {p.avatar_url && (
                      <button
                        onClick={() =>
                          act(async () => {
                            if (await askConfirm("Remove this photo?", `${p.display_name}'s profile photo will be deleted. They can add a new one any time.`, "Remove", true)) onAdminRemoveAvatar(p.id);
                          })
                        }
                      >
                        Remove photo
                      </button>
                    )}
                    {canDelete && (
                      <button className="danger" onClick={() => act(() => onDeleteProfile(p.id, p.display_name))}>
                        Delete account<small>Asks you to confirm first</small>
                      </button>
                    )}
                  </div>
                )}

                {renamingPlayerId === p.id && (
                  <div className="wcf-account-rename" style={{ marginTop: 10 }}>
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
                )}
                {ratingPlayerId === p.id && (
                  <div style={{ marginTop: 14 }}>
                    <RatingForm
                      initial={adminRatings.find((r) => r.player_id === p.id) ?? null}
                      onSave={(fitness, attack, defence, goalkeeping, position) => {
                        onSaveAdminRating(p.id, fitness, attack, defence, goalkeeping, position);
                        onToggleRatingPlayer(p.id);
                      }}
                      saveLabel={`Save ${p.display_name}'s rating`}
                      max={10}
                    />
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </AccordionSection>

        <AccordionSection icon={<SetIcon name="list" />} title="Activity log" meta={`${auditLog.length} entries`} open={showAuditLog} onToggle={onToggleAuditLog}>
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

        <AccordionSection icon={<SetIcon name="gear" />} title="Club settings" meta={`${clubSettings.team_white_name} vs ${clubSettings.team_red_name}`} open={openClubSettings} onToggle={() => setOpenClubSettings((v) => !v)}>
          <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />
        </AccordionSection>

        <AccordionSection icon={<SetIcon name="trophy" />} title="Awards" meta={`${awards.length} published`} open={openAwards} onToggle={() => setOpenAwards((v) => !v)}>
          <AwardsForm awards={awards} onAdd={onAddAward} onDelete={onDeleteAward} askConfirm={askConfirm} />
        </AccordionSection>
        </div>
      )}

      <button className="wcf-signout" onClick={onSignOut}>Sign out</button>
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
            {a.image_url && <span className="wcf-award-tag">Photo</span>}
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
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Player of the Season" required />
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
            <span className="wcf-upload-glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg></span>
            <span className="wcf-upload-label">Photo</span>
            <span className="wcf-upload-state">{imageFile ? imageFile.name : "Optional"}</span>
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="wcf-upload-box">
            <span className="wcf-upload-glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3" /></svg></span>
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
  const [slip, setSlip] = useState(false);
  const slipView = slip ? <PredictionSlip value={`${redLabel} ${red}–${white} ${whiteLabel}`} sub="NEXT GAME" onDone={() => setSlip(false)} /> : null;
  const [prevW, setPrevW] = useState(white);
  const [prevR, setPrevR] = useState(red);
  const reelCls = (v: number, p: number) => (v === p ? "wcf-reel" : v > p ? "wcf-reel up" : "wcf-reel down");

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
        {slipView}
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
    if (typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSlip(true);
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
            <span className={reelCls(red, prevR)} key={"r" + red} onAnimationEnd={() => setPrevR(red)}>{red}</span>
            <button onClick={() => setRed((n) => n + 1)} aria-label={`More ${redLabel} goals`}>+</button>
          </div>
        </div>
        <div className="wcf-predict-vs">–</div>
        <div className="wcf-predict-team">
          <div className="wcf-predict-team-name">{whiteLabel}</div>
          <div className="wcf-predict-stepper">
            <button onClick={() => setWhite((n) => Math.max(0, n - 1))} aria-label={`Fewer ${whiteLabel} goals`}>−</button>
            <span className={reelCls(white, prevW)} key={"w" + white} onAnimationEnd={() => setPrevW(white)}>{white}</span>
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
  onShareResult,
  emergencyContacts,
  onConfirmPayments,
  birthdaySuggest,
  askConfirm,
}: {
  birthdaySuggest: Record<string, string>;
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
  onShareResult: (gameId: string) => void;
  emergencyContacts: EmergencyContact[];
  onConfirmPayments: (bookingIds: string[]) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const shared = {
    emergencyContacts,
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
    birthdaySuggest,
    askConfirm,
  };

  // Every number here is already sitting in props passed down from
  // elsewhere - this doesn't compute anything new, just gathers what's
  // scattered across Admin/Line-up/Results into one glance at the top.
  const unscored = previous.filter((g) => g.team_white_score == null || g.team_red_score == null);
  const drafts = [...upcoming, ...previous].filter((g) => !g.published);
  // Two different things that used to share one "Pending approvals" tile
  // (which read 96-100 when only 1 player had actually claimed to pay):
  // payments a player says they've made, which an admin needs to check -
  // on any game, past or upcoming - and upcoming bookings not paid yet,
  // which is normal and needs nothing.
  const paymentClaims = [...upcoming, ...previous].flatMap((g) =>
    g.bookings.filter((b) => !b.waiting && b.status === "pending").map((b) => ({ booking: b, game: g }))
  );
  const notPaidYet = upcoming.flatMap((g) =>
    g.bookings.filter((b) => !b.waiting && b.status === "unpaid").map((b) => ({ booking: b, game: g }))
  );
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
  // the amount shown, same distinction the pre-removal warning already
  // makes (see the frequent cron job).
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
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

  function startMessage(playerId: string, template: string) {
    setComposeTo(playerId);
    setComposeText(template);
    setComposeOpen(true);
    setAdminView("messages");
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

  // ── The page is four tabs now, not one long scroll (it had grown to ~5
  // phone screens). "Today" leads with only what needs an admin.
  const [adminView, setAdminView] = useState<"today" | "fixtures" | "payments" | "messages">("today");
  const [composeOpen, setComposeOpen] = useState(false);
  const [showLaterFixtures, setShowLaterFixtures] = useState(false);
  const [showAllResults, setShowAllResults] = useState(false);
  const [openUnpaidGame, setOpenUnpaidGame] = useState<string | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const venueCount: Record<string, number> = {};
  [...upcoming, ...previous].forEach((g) => (venueCount[g.venue] = (venueCount[g.venue] ?? 0) + 1));
  const mainVenue = Object.entries(venueCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const nowDay = nowInLondon().slice(0, 10);
  const in28 = new Date(Date.UTC(+nowDay.slice(0, 4), +nowDay.slice(5, 7) - 1, +nowDay.slice(8, 10) + 28)).toISOString().slice(0, 10);
  const soonUpcoming = upcoming.filter((g) => g.date <= in28);
  const laterUpcoming = upcoming.filter((g) => g.date > in28);
  const teamsDueSoon = !!nextGame && !teamsSet && !noBookingsYet && toMs(kickoffCutoff(nextGame.date, nextGame.kickoff, 0)) - toMs(nowInLondon()) <= 48 * 3600000;

  // Needs-you items, each with the one button that deals with it.
  type Todo = { key: string; tone: "gold" | "red" | "blue"; icon: string; title: string; sub: string; label: string; act: () => void };
  const todos: Todo[] = [];
  paymentClaims.slice(0, 3).forEach(({ booking: b, game: g }) =>
    todos.push({
      key: "claim-" + b.id,
      tone: "gold",
      icon: "£",
      title: `${b.player.display_name} says they've paid`,
      sub: `${fmtDate(g.date)} · £${g.price}`,
      label: "Confirm",
      act: () => onSetStatus(b.id, "confirmed"),
    })
  );
  if (paymentClaims.length > 3) todos.push({ key: "claims-more", tone: "gold", icon: "£", title: `${paymentClaims.length - 3} more payments to check`, sub: "On the Payments tab", label: "View", act: () => setAdminView("payments") });
  unscored.forEach((g) =>
    todos.push({ key: "score-" + g.id, tone: "blue", icon: "⚽", title: `Enter the score for ${fmtDate(g.date)}`, sub: `${g.bookings.filter((b) => !b.waiting).length} played`, label: "Enter", act: () => setResultFor(g.id) })
  );
  if (teamsDueSoon && nextGame)
    todos.push({ key: "teams", tone: "blue", icon: "⇄", title: `Pick teams for ${fmtDate(nextGame.date)}`, sub: `${nextConfirmed.length} booked, ${nextUnassigned} not on a team`, label: "Pick", act: onGoToLineup });
  if (owingTabs.length > 0)
    todos.push({
      key: "owing",
      tone: "red",
      icon: "!",
      title: `${owingTabs.length} ${owingTabs.length === 1 ? "player owes" : "players owe"} £${owingTotal}`,
      sub: namesList(owingTabs.map((t) => t.playerName.split(" ")[0])) + " · past games",
      label: "Chase",
      act: () => setAdminView("payments"),
    });
  if (drafts.length > 0)
    todos.push({ key: "drafts", tone: "blue", icon: "✎", title: `${drafts.length} draft ${drafts.length === 1 ? "fixture" : "fixtures"} not published`, sub: namesList(drafts.map((g) => fmtDate(g.date))), label: "View", act: () => setAdminView("fixtures") });
  const paymentsBadge = paymentClaims.length + owingTabs.length;

  const shownResults = showAllResults ? previous : previous.slice(0, 4);
  const openFixture = (id: string) => {
    setAdminView("fixtures");
    if (expandedId !== id) onToggleExpand(id);
  };

  return (
    <>
      <div className="wcf-subtabs wcf-admin-tabs">
        {([
          ["today", "Today", todos.length],
          ["fixtures", "Fixtures", 0],
          ["payments", "Payments", paymentsBadge],
          ["messages", "Messages", 0],
        ] as const).map(([k, label, n]) => (
          <button key={k} className={adminView === k ? "active" : ""} onClick={() => setAdminView(k)}>
            {label}
            {n > 0 && <i className="wcf-admin-tab-badge">{n}</i>}
          </button>
        ))}
      </div>

      {adminView === "today" && (
        <>
          <div className={"wcf-needs" + (todos.length === 0 ? " clear" : "")}>
            <div className="wcf-needs-head">
              <b>{todos.length === 0 ? "All clear" : "Needs you"}</b>
              <span>{todos.length === 0 ? "Nothing waiting on an admin ✓" : `${todos.length} ${todos.length === 1 ? "thing" : "things"}`}</span>
            </div>
            {todos.map((t) => (
              <div key={t.key} className="wcf-todo">
                <span className={"wcf-todo-ic " + t.tone}>{t.icon}</span>
                <span className="wcf-todo-tx"><b>{t.title}</b><span>{t.sub}</span></span>
                <button className={"wcf-todo-btn " + t.tone} onClick={t.act}>{t.label}</button>
              </div>
            ))}
          </div>

          {nextGame && (
            <div className="wcf-admin-next">
              <div className="wcf-admin-next-k">Next game</div>
              <div className="wcf-admin-next-t">{fmtDate(nextGame.date)} · {nextGame.kickoff}{nextGame.venue !== mainVenue ? ` · ${nextGame.venue}` : ""}</div>
              <div className="wcf-admin-next-chips">
                <span className="wcf-chip g">{nextConfirmed.length}/{nextGame.max_players} booked</span>
                {nextGame.bookings.some((b) => b.waiting) && <span className="wcf-chip w">{nextGame.bookings.filter((b) => b.waiting).length} waiting</span>}
                <span className={"wcf-chip" + (teamsSet ? " g" : teamsDueSoon ? " r" : "")}>{noBookingsYet ? "No one booked" : teamsSet ? "Teams set" : "Teams not set"}</span>
                {nextConfirmed.filter((b) => b.status !== "confirmed" && !b.pot_exempt_reason).length > 0 && (
                  <span className="wcf-chip">{nextConfirmed.filter((b) => b.status !== "confirmed" && !b.pot_exempt_reason).length} not paid</span>
                )}
              </div>
              <div className="wcf-admin-next-acts">
                <button className="wcf-pill-btn ghost" onClick={() => openFixture(nextGame.id)}>Open fixture</button>
                {!teamsSet && !noBookingsYet && <button className="wcf-pill-btn ghost" onClick={onGoToLineup}>Pick teams</button>}
              </div>
            </div>
          )}

          <div className="wcf-admin-calm">
            <div><b>{unscored.length === 0 ? "✓" : unscored.length}</b><span>{unscored.length === 0 ? "All scores entered" : "Scores to enter"}</span></div>
            <div><b>{notPaidYet.length}</b><span>Upcoming not paid yet</span></div>
            <div><b>{drafts.length}</b><span>{drafts.length === 1 ? "Draft" : "Drafts"}</span></div>
          </div>
        </>
      )}

      {adminView === "fixtures" && (
        <>
          <div className="wcf-admin-group"><span>Upcoming · next 4 weeks</span><span>{upcoming.length} in total</span></div>
          {upcoming.length === 0 && <p className="wcf-empty small">No upcoming fixtures.</p>}
          {soonUpcoming.map((g) => (
            <AdminGameRow key={g.id} game={g} past={false} mainVenue={mainVenue} onEnterResult={setResultFor} {...shared} />
          ))}
          {laterUpcoming.length > 0 && !showLaterFixtures && (
            <button className="wcf-rec-more" onClick={() => setShowLaterFixtures(true)}>Show {laterUpcoming.length} later {laterUpcoming.length === 1 ? "fixture" : "fixtures"}</button>
          )}
          {showLaterFixtures && laterUpcoming.map((g) => (
            <AdminGameRow key={g.id} game={g} past={false} mainVenue={mainVenue} onEnterResult={setResultFor} {...shared} />
          ))}
          <div className="wcf-admin-group"><span>Results</span><span>{previous.length} {previous.length === 1 ? "game" : "games"}</span></div>
          {previous.length === 0 && <p className="wcf-empty small">No past fixtures yet.</p>}
          {shownResults.map((g) => (
            <AdminGameRow key={g.id} game={g} past mainVenue={mainVenue} onEnterResult={setResultFor} {...shared} />
          ))}
          {previous.length > 4 && (
            <button className="wcf-rec-more" onClick={() => setShowAllResults((v) => !v)}>{showAllResults ? "Show fewer" : `Show all ${previous.length} results`}</button>
          )}
        </>
      )}

      {adminView === "payments" && (
        <>
          <div className="wcf-admin-group">
            <span>To check</span>
            <b className="gold">{paymentClaims.length || ""}</b>
            {paymentClaims.length >= 2 && (
              <button
                className="wcf-confirm-all"
                onClick={async () => {
                  const total = paymentClaims.reduce((sum, c) => sum + c.game.price, 0);
                  const names = paymentClaims.map((c) => c.booking.player.display_name.split(" ")[0]).join(", ");
                  if (await askConfirm(`Confirm all ${paymentClaims.length} payments?`, `£${total} from ${names}. Check they're in the bank first.`, "Confirm all", false)) {
                    onConfirmPayments(paymentClaims.map((c) => c.booking.id));
                  }
                }}
              >
                Confirm all
              </button>
            )}
          </div>
          {paymentClaims.length === 0 && <p className="wcf-empty small">Nobody&apos;s waiting on a payment check.</p>}
          {paymentClaims.length > 0 && (
            <div className="wcf-admin-card">
              {paymentClaims.map(({ booking: b, game: g }) => (
                <div key={b.id} className="wcf-todo">
                  <span className="wcf-todo-ic gold">£</span>
                  <span className="wcf-todo-tx"><b>{b.player.display_name}</b><span>Says paid · {fmtDate(g.date)} · £{g.price} · booked {fmtDateTime(b.created_at)}</span></span>
                  <button className="wcf-todo-btn gold" onClick={() => onSetStatus(b.id, "confirmed")}>Confirm</button>
                </div>
              ))}
            </div>
          )}

          <div className="wcf-admin-group"><span>Owed from past games</span>{owingTotal > 0 && <b className="red">£{owingTotal}</b>}</div>
      {owingTabs.length === 0 && <EmptyScene kind="paid" small title="Everyone's settled up" text="Nothing outstanding." />}
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


          <div className="wcf-admin-group"><span>Not paid yet · upcoming</span><span>{notPaidYet.length}</span></div>
          <p className="wcf-admin-hint">Normal: people pay nearer the game, and reminders go out automatically.</p>
          {(() => {
            const byGame = Object.values(
              notPaidYet.reduce<Record<string, { game: GameRow; items: typeof notPaidYet }>>((acc, p) => {
                (acc[p.game.id] ??= { game: p.game, items: [] }).items.push(p);
                return acc;
              }, {})
            ).sort((a, b) => a.game.date.localeCompare(b.game.date));
            if (byGame.length === 0) return null;
            return (
              <div className="wcf-admin-card">
                {byGame.map(({ game: g, items }) => {
                  const open = openUnpaidGame === g.id;
                  return (
                    <div key={g.id}>
                      <button className="wcf-admin-fold" onClick={() => setOpenUnpaidGame(open ? null : g.id)}>
                        <b>{fmtDate(g.date)}</b>
                        <span>{items.length <= 2 ? items.map((i) => i.booking.player.display_name.split(" ")[0]).join(", ") : `${items.length} players`} {open ? "▾" : "›"}</span>
                      </button>
                      {open && items.map(({ booking: b }) => (
                        <div key={b.id} className="wcf-pending-row">
                          <span className="wcf-pending-dot unpaid" />
                          <span className="wcf-pending-name-wrap">
                            <span className="wcf-pending-name">{b.player.display_name}</span>
                            <span className="wcf-pending-booked">Booked {fmtDateTime(b.created_at)}</span>
                          </span>
                          <button
                            className="wcf-admin-approve-override"
                            onClick={async () => {
                              if (await askConfirm(`Confirm ${b.player.display_name} as paid?`, "They haven't marked this as paid themselves.", "Confirm anyway")) {
                                onSetStatus(b.id, "confirmed");
                              }
                            }}
                          >
                            Mark paid
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </>
      )}

      {adminView === "messages" && (
        <>
          {!composeOpen ? (
            <div className="wcf-admin-compose-card">
              <span className="wcf-todo-ic red">✉</span>
              <span className="wcf-todo-tx"><b>New message</b><span>To a player, everyone who owes, or the next game&apos;s players</span></span>
              <button className="wcf-todo-btn red" onClick={() => setComposeOpen(true)}>Write</button>
            </div>
          ) : (
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
              <textarea className="wcf-msg-compose-box" placeholder="Write a message…" value={composeText} onChange={(e) => setComposeText(e.target.value)} />
              <div className="wcf-admin-compose-acts">
                <button className="wcf-pill-btn ghost" onClick={() => { setComposeOpen(false); setComposeTo(""); setComposeText(""); }}>Cancel</button>
                <button className="wcf-pill-btn red" disabled={!composeTo || !composeText.trim() || sendingMessage} onClick={async () => { await sendMessage(); setComposeOpen(false); }}>
                  {sendingMessage ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          )}
          <div className="wcf-admin-group"><span>Sent</span><span>{messages.length}{unreadSentCount > 0 ? ` · ${unreadSentCount} unread` : ""}</span></div>
          {messages.length === 0 && <p className="wcf-empty small">No messages sent yet.</p>}
          {messages.length > 0 && (
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

      {resultFor && (() => {
        const g = [...previous, ...upcoming].find((x) => x.id === resultFor);
        if (!g) return null;
        return (
          <ResultSheet
            game={g}
            goalRows={goalRows}
            cs={cs}
            onSave={onSaveResult}
            onShare={onShareResult}
            onClose={() => setResultFor(null)}
          />
        );
      })()}
    </>
  );
}

function AdminGameRow({
  game,
  past,
  mainVenue,
  onEnterResult,
  cs,
  profiles,
  expandedId,
  onToggleExpand,
  onSetStatus,
  onRemoveBooking,
  onDeleteGame,
  onAddBooking,
  onSetPotExempt,
  emergencyContacts,
  birthdaySuggest,
  askConfirm,
}: {
  birthdaySuggest?: Record<string, string>;
  game: GameRow;
  past: boolean;
  emergencyContacts: EmergencyContact[];
  mainVenue: string;
  onEnterResult: (gameId: string) => void;
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
  const [addPlayerSearch, setAddPlayerSearch] = useState("");
  const [showContacts, setShowContacts] = useState(false);
  // The booking whose actions sheet is open (tap ⋯ on a row).
  const [actionFor, setActionFor] = useState<BookingRow | null>(null);
  const [bdayDismissed, setBdayDismissed] = useState<string[]>([]);
  const bdaySuggestions = past
    ? []
    : game.bookings.filter((b) => {
        if (b.waiting || b.pot_exempt_reason || !birthdaySuggest?.[b.id] || bdayDismissed.includes(b.id)) return false;
        try {
          return !localStorage.getItem(`wcf-bday-dismiss-${b.id}`);
        } catch {
          return true;
        }
      });

  const bookedIds = new Set(game.bookings.map((b) => b.player_id));
  const eligiblePlayers = profiles.filter((p) => !bookedIds.has(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name));

  const dateObj = new Date(game.date + "T00:00:00");
  const dayNum = dateObj.getDate();
  const monthAbbr = dateObj.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
  const weekday = dateObj.toLocaleDateString("en-GB", { weekday: "short" });
  const gameUnassigned = confirmed.filter((b) => !b.team).length;
  const gameTeamsSet = confirmed.length === 0 || gameUnassigned === 0;
  const scored = game.team_white_score != null && game.team_red_score != null;
  // Teams aren't picked weeks ahead, so an amber "NO TEAMS" on every
  // upcoming game was a warning that meant nothing. It only warns inside
  // 48 hours of kick-off. Both sides go through toMs(): kickoffCutoff() and
  // nowInLondon() are UK wall-clock-as-UTC and must never meet Date.now().
  const teamsDueSoon = !past && toMs(kickoffCutoff(game.date, game.kickoff, 0)) - toMs(nowInLondon()) <= 48 * 3600000;
  const isOwing = (b: BookingRow) => b.status !== "confirmed" && !b.pot_exempt_reason;
  const owingCount = confirmed.filter(isOwing).length;
  const badge = !game.published
    ? "DRAFT"
    : !past
      ? gameTeamsSet ? "TEAMS SET" : teamsDueSoon ? "NO TEAMS" : null
      : scored ? `${game.team_white_score}–${game.team_red_score}` : "ENTER SCORE";
  const badgeTone = !game.published ? "blue" : !past ? (gameTeamsSet ? "green" : "amber") : scored ? "score" : "amber";

  // Everyone in booking order (first come, first served), numbered, with
  // the booking time on every row. Who still owes is called out above.
  const owing = confirmed.filter(isOwing);

  const chip = (b: BookingRow) =>
    b.pot_exempt_reason ? (
      <span className="wcf-st free">Free</span>
    ) : b.status === "confirmed" ? (
      <span className="wcf-st paid">Paid</span>
    ) : b.status === "pending" ? (
      <span className="wcf-st says">Says paid</span>
    ) : (
      <span className="wcf-st owe">Not paid</span>
    );

  const row = (b: BookingRow, i: number) => (
    <div key={b.id} className="wcf-arow">
      <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-arow-av" background={avatarFor(b.player.display_name).gradient} />
      <span className="wcf-arow-name">
        {i + 1}. {b.player.display_name}
        {/* When they booked stays on every row - admins use it to settle
            who was first, on upcoming and past games alike. */}
        <small>
          Booked {fmtDateTime(b.created_at)}
          {b.status === "confirmed" && b.auto_confirmed ? " · paid via Monzo" : b.status === "confirmed" && b.confirmer ? ` · approved by ${b.confirmer.display_name.split(" ")[0]}` : ""}
          {b.pot_exempt_reason ? ` · ${b.pot_exempt_reason === "birthday" ? "free · birthday" : b.pot_exempt_reason === "prize" ? "prize" : b.pot_exempt_reason === "carried_over" ? "carried over" : "free"}` : ""}
        </small>
      </span>
      {chip(b)}
      <button className="wcf-arow-more" onClick={() => setActionFor(b)} aria-label={`Actions for ${b.player.display_name}`}>⋯</button>
    </div>
  );

  async function act(fn: () => Promise<void> | void) {
    setActionFor(null);
    await fn();
  }

  return (
    <div className={"wcf-admin-game" + (past ? "" : " upcoming") + (expanded ? " open" : "")}>
      <button className="wcf-admin-game-head" onClick={() => onToggleExpand(game.id)}>
        <span className="wcf-admin-game-date-tile">
          <span className="wcf-admin-game-day">{dayNum}</span>
          <span className="wcf-admin-game-month">{monthAbbr}</span>
        </span>
        <span className="wcf-admin-game-info">
          <span className="wcf-admin-game-venue">{weekday} · {game.kickoff}{game.venue !== mainVenue ? ` · ${game.venue}` : ""}</span>
          <span className="wcf-admin-game-date">
            {confirmed.length}/{game.max_players} {past ? "played" : "booked"}
            {waitingList.length > 0 && !past ? ` · ${waitingList.length} waiting` : ""}
            {owingCount > 0 ? ` · ${owingCount} not paid` : ""}
          </span>
        </span>
        {badge && <span className={"wcf-admin-game-badge " + badgeTone}>{badge}</span>}
      </button>
      {expanded && (
        <div className="wcf-admin-game-body">
          {past && (
            <div className="wcf-admin-result-bar">
              {scored ? (
                <>
                  <span className="wcf-admin-result-score">
                    <span style={{ color: cs.team_white_color }}>{cs.team_white_name}</span> {game.team_white_score}–{game.team_red_score}{" "}
                    <span style={{ color: cs.team_red_color }}>{cs.team_red_name}</span>
                  </span>
                  <button className="wcf-pill-btn ghost" onClick={() => onEnterResult(game.id)}>Edit result</button>
                </>
              ) : (
                <button className="wcf-pill-btn red wide" onClick={() => onEnterResult(game.id)}>Enter result</button>
              )}
            </div>
          )}

          {bdaySuggestions.map((b) => (
            <div key={b.id} className="wcf-bday-suggest">
              <div className="ico">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="10" width="18" height="11" rx="2" /><path d="M12 10V6M8 10V7M16 10V7M3 15c3 2 6-2 9 0s6 2 9 0" /></svg>
              </div>
              <div className="txt">
                <b>{b.player.display_name.split(" ")[0]}&apos;s birthday is {birthdaySuggest?.[b.id]}</b>
                <small>They&apos;re booked on this game. Make it their free birthday game?</small>
              </div>
              <div className="btns">
                <button className="yes" onClick={() => onSetPotExempt(b.id, "birthday")}>Make it free</button>
                <button
                  className="no"
                  onClick={() => {
                    try {
                      localStorage.setItem(`wcf-bday-dismiss-${b.id}`, "1");
                    } catch {}
                    setBdayDismissed((d) => [...d, b.id]);
                  }}
                >
                  Not this time
                </button>
              </div>
            </div>
          ))}
          {confirmed.length === 0 && <p className="wcf-empty small">No one booked in.</p>}
          {confirmed.length > 0 && (
            <div className={"wcf-admin-owing" + (owing.length === 0 ? " clear" : "")}>
              {owing.length === 0
                ? "✓ Everyone's paid or on a free game"
                : `${owing.length} not paid: ${owing.map((b) => b.player.display_name.split(" ")[0] + (b.status === "pending" ? " (says paid)" : "")).join(", ")}`}
            </div>
          )}
          {confirmed.map(row)}

          {waitingList.length > 0 && (
            <>
              <div className="wcf-admin-wl">Waiting list · {waitingList.length}</div>
              {waitingList.map((b, i) => (
                <div key={b.id} className="wcf-arow">
                  <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-arow-av" background={avatarFor(b.player.display_name).gradient} />
                  <span className="wcf-arow-name">
                    {i + 1}. {b.player.display_name}
                    <small>Joined {fmtDateTime(b.created_at)}</small>
                  </span>
                  <span />
                  <button className="wcf-arow-more" onClick={() => setActionFor(b)} aria-label={`Actions for ${b.player.display_name}`}>⋯</button>
                </div>
              ))}
            </>
          )}

          {!past && confirmed.length > 0 && (() => {
            // Everyone playing, with a tap-to-call number where they've set
            // one - in one place for the pitch, instead of card by card.
            const withContact = confirmed.map((b) => ({ b, c: emergencyContacts.find((x) => x.player_id === b.player_id) }));
            const have = withContact.filter((x) => x.c).length;
            return (
              <div className="wcf-ec">
                <button className="wcf-ec-head" onClick={() => setShowContacts((v) => !v)} aria-expanded={showContacts}>
                  <span>Emergency contacts</span>
                  <span className="wcf-ec-count">
                    {have} of {confirmed.length} set <b className={showContacts ? "open" : ""}>›</b>
                  </span>
                </button>
                {showContacts && (
                  <div className="wcf-ec-list">
                    {withContact
                      .sort((x, y) => Number(!!y.c) - Number(!!x.c) || x.b.player.display_name.localeCompare(y.b.player.display_name))
                      .map(({ b, c }) => (
                        <div key={b.id} className="wcf-ec-row">
                          <div className="wcf-ec-who">
                            <div className="wcf-ec-name">{b.player.display_name}</div>
                            <div className="wcf-ec-sub">{c ? c.contact_name : "No emergency contact set"}</div>
                          </div>
                          {c ? (
                            <a className="wcf-ec-call" href={`tel:${c.contact_phone.replace(/[^+\d]/g, "")}`}>
                              {c.contact_phone}
                            </a>
                          ) : (
                            <span className="wcf-ec-none">None</span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })()}

          {eligiblePlayers.length > 0 && (() => {
            // Type to find someone instead of scrolling a 60-name dropdown.
            const q = addPlayerSearch.trim().toLowerCase();
            const matches = q ? eligiblePlayers.filter((p) => p.display_name.toLowerCase().includes(q)).slice(0, 6) : [];
            return (
              <div className="wcf-admin-add-player">
                <input
                  type="search"
                  value={addPlayerSearch}
                  onChange={(e) => setAddPlayerSearch(e.target.value)}
                  placeholder="Add a player who didn't book…"
                  aria-label="Search for a player to add"
                />
                {q && (
                  <div className="wcf-admin-add-results">
                    {matches.length === 0 && <div className="wcf-admin-add-none">No one called &quot;{addPlayerSearch.trim()}&quot;</div>}
                    {matches.map((p) => (
                      <button
                        key={p.id}
                        className="wcf-admin-add-result"
                        onClick={() => {
                          onAddBooking(game.id, p.id);
                          setAddPlayerSearch("");
                        }}
                      >
                        <span>{p.display_name}</span>
                        <b>Add</b>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          <button
            className="wcf-admin-delete-link"
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

      {actionFor && (
        <div className="wcf-sheet-overlay" onClick={() => setActionFor(null)}>
          <div className="wcf-squad-sheet wcf-action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wcf-sheet-handle-wrap"><div className="wcf-sheet-handle" /></div>
            <div className="wcf-action-head">
              <b>{actionFor.player.display_name}</b>
              <small>
                {fmtDate(game.date)} · {actionFor.waiting ? "joined the waiting list" : "booked"} {fmtDateTime(actionFor.created_at)}
              </small>
            </div>
            {actionFor.waiting ? (
              <button
                className="wcf-action-opt danger"
                onClick={() =>
                  act(async () => {
                    if (await askConfirm(`Remove ${actionFor.player.display_name} from the waiting list?`, "They'll need to rejoin if they want a spot again.", "Remove")) {
                      onRemoveBooking(actionFor.id);
                    }
                  })
                }
              >
                Remove from waiting list
              </button>
            ) : (
              <>
                {actionFor.status === "pending" && (
                  <button className="wcf-action-opt" onClick={() => act(() => onSetStatus(actionFor.id, "confirmed"))}>✓ Confirm payment</button>
                )}
                {actionFor.status === "unpaid" && (
                  <button
                    className="wcf-action-opt"
                    onClick={() =>
                      act(async () => {
                        if (await askConfirm(`Confirm ${actionFor.player.display_name} as paid?`, "They haven't marked this as paid themselves.", "Confirm anyway")) {
                          onSetStatus(actionFor.id, "confirmed");
                        }
                      })
                    }
                  >
                    ✓ Mark as paid
                  </button>
                )}
                {actionFor.status === "confirmed" && (
                  <button className="wcf-action-opt" onClick={() => act(() => onSetStatus(actionFor.id, "unpaid"))}>↩ Undo payment</button>
                )}
                {actionFor.pot_exempt_reason ? (
                  <button className="wcf-action-opt" onClick={() => act(() => onSetPotExempt(actionFor.id, null))}>£ Make it a paying game again</button>
                ) : (
                  <>
                    <button
                      className={"wcf-action-opt" + (birthdaySuggest?.[actionFor.id] ? " bday" : "")}
                      onClick={() => act(() => onSetPotExempt(actionFor.id, "birthday"))}
                    >
                      Free game: birthday
                      {birthdaySuggest?.[actionFor.id] && <small>Birthday {birthdaySuggest[actionFor.id]}</small>}
                    </button>
                    <button className="wcf-action-opt" onClick={() => act(() => onSetPotExempt(actionFor.id, "prize"))}>Free game: prize</button>
                    <button className="wcf-action-opt" onClick={() => act(() => onSetPotExempt(actionFor.id, "carried_over"))}>Free game: carried over</button>
                    <button className="wcf-action-opt" onClick={() => act(() => onSetPotExempt(actionFor.id, "other"))}>Free game: other</button>
                  </>
                )}
                <button
                  className="wcf-action-opt danger"
                  onClick={() =>
                    act(async () => {
                      const msg = past
                        ? "Removes their booking for this game - no appearance, no pot charge. It's kept as a no-show for the stats (GaffAI can report no-shows)."
                        : "Their spot opens up to the waiting list.";
                      if (await askConfirm(past ? `${actionFor.player.display_name} didn't show?` : `Remove ${actionFor.player.display_name} from this game?`, msg, "Remove")) {
                        onRemoveBooking(actionFor.id);
                      }
                    })
                  }
                >
                  {past ? "✕ Didn't show: remove" : "✕ Remove from game"}
                </button>
              </>
            )}
            <button className="wcf-action-opt cancel" onClick={() => setActionFor(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Entering a result in three steps - the score on a big scoreboard, then
// who scored (tap a face once per goal), then a check before it goes out.
// Replaces two small number boxes and four tiny steppers per player.
function ResultSheet({
  game,
  goalRows,
  cs,
  onSave,
  onShare,
  onClose,
}: {
  game: GameRow;
  goalRows: GoalRow[];
  cs: ClubSettings;
  onSave: (gameId: string, whiteScore: number | null, redScore: number | null, goals: Record<string, number>, ownGoals: Record<string, number>) => Promise<void>;
  onShare: (gameId: string) => void;
  onClose: () => void;
}) {
  const players = game.bookings.filter((b) => !b.waiting);
  const initialGoals: Record<string, number> = {};
  const initialOwn: Record<string, number> = {};
  goalRows
    .filter((r) => r.game_id === game.id)
    .forEach((r) => {
      initialGoals[r.player_id] = r.goals;
      initialOwn[r.player_id] = r.own_goals;
    });
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [white, setWhite] = useState(game.team_white_score ?? 0);
  const [red, setRed] = useState(game.team_red_score ?? 0);
  const [goals, setGoals] = useState<Record<string, number>>(initialGoals);
  const [own, setOwn] = useState<Record<string, number>>(initialOwn);
  const [ogMode, setOgMode] = useState(false);
  const [saving, setSaving] = useState(false);

  const groups = ([
    ["white", players.filter((b) => b.team === "white"), cs.team_white_name, cs.team_white_color, white],
    ["red", players.filter((b) => b.team === "red"), cs.team_red_name, cs.team_red_color, red],
    ["none", players.filter((b) => !b.team), "Not on a team", "#94a3b8", null],
  ] as const).filter(([, g]) => g.length > 0);
  const sum = (ids: BookingRow[], m: Record<string, number>) => ids.reduce((n, b) => n + (m[b.player_id] ?? 0), 0);
  const totalAssigned = sum(players, goals) + sum(players, own);
  const totalScore = white + red;
  const ownTotal = sum(players, own);

  const bump = (id: string, by: number) => {
    const set = ogMode ? setOwn : setGoals;
    set((m) => ({ ...m, [id]: Math.max(0, (m[id] ?? 0) + by) }));
  };
  const scorerLine = (group: BookingRow[]) =>
    group
      .filter((b) => (goals[b.player_id] ?? 0) > 0)
      .sort((a, b) => (goals[b.player_id] ?? 0) - (goals[a.player_id] ?? 0))
      .map((b) => `${b.player.display_name} ${goals[b.player_id]}`)
      .join(", ") || "No scorers entered";

  async function save() {
    setSaving(true);
    await onSave(game.id, white, red, goals, own);
    setSaving(false);
    setStep(4);
  }

  const stepper = (label: string, color: string, v: number, set: (n: number) => void) => (
    <div className="wcf-rs-board-row">
      <span className="wcf-rs-team" style={{ color }}>{label.toUpperCase()}</span>
      <span className="wcf-rs-stepper">
        <button onClick={() => set(Math.max(0, v - 1))} aria-label={`${label} minus one`}>−</button>
        <b style={{ color }}>{v}</b>
        <button className="plus" onClick={() => set(v + 1)} aria-label={`${label} plus one`}>+</button>
      </span>
    </div>
  );

  return (
    <div className="wcf-rs" role="dialog" aria-modal="true" aria-label={`Result for ${fmtDate(game.date)}`}>
      <div className="wcf-rs-inner">
        <div className="wcf-rs-top">
          <b>{step === 1 ? `${fmtDate(game.date)} · result` : step === 2 ? "Who scored?" : step === 3 ? "All good?" : "Saved"}</b>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        {step < 4 && (
          <div className="wcf-rs-steps">
            <i className="on" /><i className={step >= 2 ? "on" : ""} /><i className={step >= 3 ? "on" : ""} />
          </div>
        )}

        {step === 1 && (
          <>
            <div className="wcf-rs-board">
              {stepper(cs.team_white_name, cs.team_white_color, white, setWhite)}
              {stepper(cs.team_red_name, cs.team_red_color, red, setRed)}
            </div>
            <button className="wcf-rs-cta" onClick={() => setStep(2)}>Next: who scored</button>
          </>
        )}

        {step === 2 && (
          <>
            {ogMode && <div className="wcf-rs-og">Own-goal mode: tap whoever put it in their own net. <button onClick={() => setOgMode(false)}>Done</button></div>}
            {groups.map(([key, group, name, color, target]) => {
              const assigned = sum([...group], goals);
              return (
                <div key={key}>
                  <div className="wcf-rs-teamhead">
                    <b style={{ color }}>{name.toUpperCase()}</b>
                    {target != null && (
                      <span className={assigned === target ? "ok" : "todo"}>{assigned} of {target}{assigned === target ? " ✓" : ""}</span>
                    )}
                  </div>
                  <div className="wcf-rs-chips">
                    {group.map((b) => {
                      const n = (ogMode ? own : goals)[b.player_id] ?? 0;
                      const og = own[b.player_id] ?? 0;
                      return (
                        <span key={b.id} className={"wcf-rs-chip" + (n > 0 ? " has" : "") + (ogMode ? " og" : "")}>
                          <button className="wcf-rs-chip-main" onClick={() => bump(b.player_id, 1)}>
                            <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-rs-chip-av" background={avatarFor(b.player.display_name).gradient} />
                            {b.player.display_name.split(" ")[0]}
                            {!ogMode && og > 0 && <em>OG</em>}
                          </button>
                          {n > 0 && (
                            <>
                              <span className="wcf-rs-count">{n}</span>
                              <button className="wcf-rs-minus" onClick={() => bump(b.player_id, -1)} aria-label={`Take one off ${b.player.display_name}`}>−</button>
                            </>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            <p className="wcf-rs-hint">
              Tap a player once per goal; − takes one off.{" "}
              {totalAssigned === totalScore
                ? "Every goal is accounted for."
                : totalAssigned < totalScore
                  ? `${totalScore - totalAssigned} ${totalScore - totalAssigned === 1 ? "goal isn't" : "goals aren't"} assigned yet. Fine to leave if you're not sure.`
                  : `That's ${totalAssigned - totalScore} more than the score. Check the numbers.`}
              {ownTotal > 0 ? ` Own goals: ${ownTotal}.` : ""}
            </p>
            {!ogMode && <button className="wcf-rs-oglink" onClick={() => setOgMode(true)}>Was one an own goal?</button>}
            <div className="wcf-rs-row">
              <button className="wcf-rs-ghost" onClick={() => { setOgMode(false); setStep(1); }}>Back</button>
              <button className="wcf-rs-cta" onClick={() => { setOgMode(false); setStep(3); }}>Next: check</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="wcf-rs-summary">
              <div className="k">Full time · {fmtDate(game.date)}</div>
              <div className="sc">
                <span>{cs.team_white_name.toUpperCase()}</span>
                <b style={{ color: cs.team_white_color }}>{white}</b>
                <b className="dash">–</b>
                <b style={{ color: cs.team_red_color }}>{red}</b>
                <span>{cs.team_red_name.toUpperCase()}</span>
              </div>
              <div className="who">
                <div><b>{cs.team_white_name}:</b> {scorerLine(players.filter((b) => b.team === "white"))}</div>
                <div><b>{cs.team_red_name}:</b> {scorerLine(players.filter((b) => b.team === "red"))}</div>
                {ownTotal > 0 && <div><b>Own goals:</b> {players.filter((b) => (own[b.player_id] ?? 0) > 0).map((b) => `${b.player.display_name} ${own[b.player_id]}`).join(", ")}</div>}
              </div>
              <div className="ticks">
                <div><i>✓</i>Posts &quot;Full time&quot; to the feed, plus any hat-tricks or records</div>
                <div><i>✓</i>Updates Scores, Stats, Records and Wrapped</div>
              </div>
            </div>
            <div className="wcf-rs-row">
              <button className="wcf-rs-ghost" onClick={() => setStep(2)}>Back</button>
              <button className="wcf-rs-cta" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save result"}</button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="wcf-rs-summary">
              <div className="k">Saved ✓</div>
              <div className="sc">
                <span>{cs.team_white_name.toUpperCase()}</span>
                <b style={{ color: cs.team_white_color }}>{white}</b>
                <b className="dash">–</b>
                <b style={{ color: cs.team_red_color }}>{red}</b>
                <span>{cs.team_red_name.toUpperCase()}</span>
              </div>
            </div>
            <button className="wcf-rs-cta" onClick={() => onShare(game.id)}>Share result image</button>
            <button className="wcf-rs-ghost wide" onClick={onClose}>Done</button>
          </>
        )}
      </div>
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

function LiveCountdown({ date, kickoff, fallback }: { date: string; kickoff: string; fallback: string }) {
  const [, setTick] = useState(0);
  const left = () => {
    const kick = new Date(kickoffCutoff(date, kickoff, 0) + ":00Z").getTime();
    const now = new Date(nowInLondon() + ":00Z").getTime() + new Date().getSeconds() * 1000;
    return Math.floor((kick - now) / 1000);
  };
  const s = left();
  const live = s > 0 && s <= 3600;
  useEffect(() => {
    if (!live) {
      const t = setInterval(() => setTick((n) => n + 1), 30000);
      return () => clearInterval(t);
    }
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!live) return <span className="wcf-hero-countdown combo">⏱ {fallback}</span>;
  return (
    <span className="wcf-hero-countdown combo wcf-cd-live">
      <span className="wcf-cd-dot" />
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} to kickoff
    </span>
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
  isNew,
  cascadeIndex,
}: {
  isNew?: boolean;
  cascadeIndex?: number;
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
  const countChanged = useChanged(confirmed.length);
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

  // Where you are in the queue, if you're on the waiting list: "2nd in
  // line", with the queue drawn out. Updates live as people drop out (the
  // bookings realtime channel already refreshes this card), and getting a
  // place sends the "You're in" push from the booking-promoted webhook.
  const queuePos = myBooking?.waiting ? waitingList.findIndex((b) => b.player_id === myId) + 1 : 0;
  const movedUp = useChanged(queuePos, (a, b) => b > 0 && a > b);
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const queueStrip = queuePos > 0 && (
    <div key={queuePos} className={"wcf-queue" + (movedUp ? " moved" : "")}>
      <div className="wcf-queue-k">You&apos;re on the waiting list</div>
      <div className="wcf-queue-t">{queuePos === 1 ? "Next in line" : `${nth(queuePos)} in line`}</div>
      <div className="wcf-queue-line">
        <span className="wcf-queue-spot">OPEN</span>
        <span className="wcf-queue-arrow" aria-hidden="true">←</span>
        {waitingList.slice(0, Math.max(queuePos + 1, 4)).map((b) => {
          const me = b.player_id === myId;
          return (
            <span key={b.id} className={"wcf-queue-slot" + (me ? " me" : "")}>
              <Avatar name={b.player.display_name} avatarUrl={b.player.avatar_url} className="wcf-queue-av" background={avatarFor(b.player.display_name).gradient} />
              <span>{me ? "You" : b.player.display_name.split(" ")[0]}</span>
            </span>
          );
        })}
      </div>
      <div className="wcf-queue-s">
        {queuePos === 1
          ? "If anyone drops out, the spot's yours."
          : `If ${queuePos} people drop out, you're in.`}{" "}
        We&apos;ll send you a notification.
      </div>
    </div>
  );

  const cta = (
    <div className="wcf-card-actions">
      {!myBooking && overdue ? (
        <p className="wcf-overdue-note">Overdue payment — speak to an admin before booking your next game.</p>
      ) : (
        <button
          className={"wcf-book " + (myBooking ? "cancel" : full ? "waitlist" : "")}
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
      {/* Once you've got a spot. People book about a month ahead, so a
          calendar entry is what stops the "forgot I was playing" no-shows.
          Android gets Google Calendar (where Android calendars live);
          everything else gets the .ics file, which iPhones open straight
          into their own "Add to Calendar" sheet. */}
      {myBooking && !myBooking.waiting && (CALENDAR_BUTTON_OPEN_TO_ALL || isAdmin) && (
        <a
          className="wcf-cal-btn"
          href={
            typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)
              ? googleCalendarUrl(game)
              : `/api/calendar/${game.id}`
          }
          target={typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) ? "_blank" : undefined}
          rel="noreferrer"
          aria-label="Add to calendar"
          title="Add to calendar"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4M12 13v5M9.5 15.5h5" />
          </svg>
        </a>
      )}
    </div>
  );

  return (
    <article
      id={"fx-" + game.id}
      className={featured ? "wcf-card featured " + (game.special ? "special" : bookedClass) : cascadeIndex !== undefined ? "wcf-fx-cascade" : ""}
      style={featured ? undefined : { marginBottom: 18, ...(cascadeIndex !== undefined ? { animationDelay: `${cascadeIndex * 200}ms` } : {}) }}
    >
      {featured ? (
        <>
          {game.special && <span className="wcf-special-ribbon">★ {fmtDate(game.date).split(",")[0]} {game.pitch}</span>}
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
            {countdownText && <LiveCountdown date={game.date} kickoff={game.kickoff} fallback={countdownText} />}
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
                <span className="wcf-hero-roster-n2"><TickNum value={confirmed.length} />/{game.max_players}</span>
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
              {confirmed.length > 4 && <span key={confirmed.length} className={"wcf-avatar-chip lg more" + (countChanged ? " roll" : "")}>+{confirmed.length - 4}</span>}
            </span>
            <span className="wcf-hero-roster-chev">›</span>
          </button>
        </>
      ) : (
        <div className={"wcf-fx-row " + (game.special ? "special" : bookedClass)}>
          {game.special && <span className="wcf-special-ribbon">★ {fmtDate(game.date).split(",")[0]} {game.pitch}</span>}
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
            {/* The admin pencil sits in the status column, beside the pill,
                rather than in a column of its own that squeezed the title
                onto two lines. */}
            <div className="wcf-fx-status">
              {waitingList.length > 0 && <span className="wcf-hero-waiting-chip">+{waitingList.length} WAITING</span>}
              <span className="wcf-fx-status-row">
                {isAdmin && (
                  <button
                    className="wcf-hero-edit-btn"
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    aria-label="Edit fixture"
                  >
                    {editIcon}
                  </button>
                )}
                <span className={"wcf-fx-pill " + (game.special ? "gold" : full ? "full" : isNew && !myBooking ? "gold" : spotsLeft <= 2 ? "open low" : "open")}>
                  {game.special && myBooking && !myBooking.waiting ? "YOU'RE IN" : full ? "FULL" : isNew && !myBooking ? "NEW" : `${spotsLeft} LEFT`}
                </span>
              </span>
            </div>
          </div>
          {queueStrip}
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
                  <div key={b.id} className="wcf-sheet-row" style={{ ["--i" as string]: Math.min(i, 12) }}>
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
      {featured && queueStrip}
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
            <input
              type="date"
              value={form.date}
              onChange={(e) => {
                const date = e.target.value;
                // A Sunday game is switched to special (with the 11-a-side
                // defaults) automatically; it can still be switched off.
                const sunday = !!date && new Date(date + "T12:00:00Z").getUTCDay() === 0;
                setForm(sunday && !form.special ? { ...form, date, ...SPECIAL_DEFAULTS, special: true } : { ...form, date });
              }}
            />
          </label>
          <label className="wcf-special-switch">
            <input
              type="checkbox"
              checked={!!form.special}
              onChange={(e) => setForm(e.target.checked ? { ...form, ...SPECIAL_DEFAULTS, special: true } : { ...form, special: false })}
            />
            <span>★ Special fixture (gold). Fills in Solar Campus, 11-a-side, 12:00, 22 players.</span>
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
              max={form.special ? SPECIAL_MAX_SPOTS : MAX_SPOTS}
              value={form.max_players}
              onChange={(e) => setForm({ ...form, max_players: Math.min(form.special ? SPECIAL_MAX_SPOTS : MAX_SPOTS, Number(e.target.value) || 0) })}
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

/* Loading screen: walking out of the tunnel. One overlay for the whole
   start-up, so it never restarts; it plays its exit when the app is ready. */
.wcf-sp{position:fixed;top:0;bottom:0;left:50%;width:min(100%,520px);transform:translateX(-50%);z-index:3000;overflow:hidden;background:#05060c;color:#F5F6F8;font-family:var(--sans)}
.wcf-sp{--door:46%;--soft:0px}
.wcf-sp-photo{position:absolute;inset:-2%;transform-origin:50% var(--door);animation:wcfSpDolly 7s cubic-bezier(.25,.1,.25,1) both}
.wcf-sp-photo img{width:100%;height:100%;object-fit:cover;object-position:50% var(--door);filter:blur(var(--soft)) saturate(1.08) brightness(.95)}
.wcf-sp-glow{position:absolute;left:50%;top:var(--door);width:min(90vmin,470px);height:min(90vmin,470px);margin:calc(min(90vmin,470px) / -2) 0 0 calc(min(90vmin,470px) / -2);border-radius:50%;
  background:radial-gradient(circle,rgba(255,248,219,.55) 0%,rgba(190,220,255,.22) 18%,rgba(120,170,255,.08) 38%,transparent 62%);
  mix-blend-mode:screen;opacity:0;animation:wcfSpFlick .9s .25s steps(1) forwards,wcfSpBreathe 3.2s 1.2s ease-in-out infinite alternate}
.wcf-sp-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,6,12,.5) 0%,rgba(5,6,12,.05) 28%,rgba(5,6,12,.2) 50%,rgba(5,6,12,.88) 74%,#05060c 100%),radial-gradient(ellipse at 50% var(--door),transparent 40%,rgba(0,0,0,.6) 100%)}
.wcf-sp-body{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 24px calc(env(safe-area-inset-bottom,0px) + 9vh)}
.wcf-sp-crest{width:58px;height:58px;object-fit:contain;filter:drop-shadow(0 6px 18px rgba(0,0,0,.6));animation:wcfSpCrest .7s .5s cubic-bezier(.3,1.5,.5,1) both}
.wcf-sp-est{margin-top:14px;font-family:var(--mono);font-weight:600;font-size:10px;letter-spacing:3px;color:#f0525e;animation:wcfSpUp .5s .8s both}
.wcf-sp-word{margin-top:8px;font-family:var(--display);font-weight:800;font-size:38px;letter-spacing:-.5px;line-height:1.05;text-shadow:0 4px 24px rgba(0,0,0,.7)}
.wcf-sp-word i{display:inline-block;font-style:normal;animation:wcfSpLetter .55s calc(.9s + var(--i) * .06s) cubic-bezier(.3,1.4,.5,1) both}
.wcf-sp-sub{display:block;margin-top:6px;font-family:var(--sans);font-weight:800;font-size:11px;letter-spacing:.32em;color:rgba(245,246,248,.5);animation:wcfSpUp .5s 1.4s both}
.wcf-sp-pitch{position:relative;width:150px;height:46px;margin-top:26px;animation:wcfSpUp .5s 1.5s both}
.wcf-sp-ball{position:absolute;left:50%;bottom:10px;width:20px;height:20px;margin-left:-10px;animation:wcfSpBounce .62s cubic-bezier(.5,0,.5,1) infinite alternate}
.wcf-sp-ball svg{width:100%;height:100%;animation:wcfSpSpin 1.24s linear infinite}
.wcf-sp-shadow{position:absolute;left:50%;bottom:6px;width:20px;height:5px;margin-left:-10px;border-radius:50%;background:rgba(0,0,0,.55);animation:wcfSpShadow .62s cubic-bezier(.5,0,.5,1) infinite alternate}
.wcf-sp-line{position:absolute;left:0;right:0;bottom:8px;height:1.5px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent)}
.wcf-sp-status{height:18px;margin-top:6px;font-size:12px;font-weight:600;color:rgba(245,246,248,.62);letter-spacing:.02em}
.wcf-sp-status span{display:inline-block;animation:wcfSpStatus 1.6s ease-in-out both}
.wcf-sp-stuck{margin-top:6px;display:flex;flex-direction:column;align-items:center;gap:10px;font-size:13px;color:rgba(245,246,248,.75);animation:wcfSpUp .4s both}
.wcf-sp-stuck button{border:0;border-radius:12px;padding:11px 20px;background:var(--red,#e63946);color:#fff;font-family:var(--display);font-weight:800;font-size:13.5px;cursor:pointer}
.wcf-sp-flash{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(circle at 50% var(--door),#fffdf2 0%,rgba(255,248,219,.9) 25%,rgba(255,248,219,.35) 55%,transparent 80%)}
/* The exit: straight down the tunnel and out into the light */
.wcf-sp.out{animation:wcfSpGone .32s .58s ease-in forwards;pointer-events:none}
.wcf-sp.out .wcf-sp-photo{animation:wcfSpRush .75s cubic-bezier(.6,0,.85,.4) forwards}
.wcf-sp.out .wcf-sp-body{animation:wcfSpDrop .35s ease-in forwards}
.wcf-sp.out .wcf-sp-flash{animation:wcfSpFlash .75s ease-in forwards}
@keyframes wcfSpDolly{from{transform:scale(1.02)}to{transform:scale(1.22)}}
@keyframes wcfSpFlick{0%{opacity:.6}12%{opacity:0}26%{opacity:.85}38%{opacity:.15}52%{opacity:1}100%{opacity:1}}
@keyframes wcfSpBreathe{from{transform:scale(1)}to{transform:scale(1.08)}}
@keyframes wcfSpCrest{from{opacity:0;transform:translateY(-24px) scale(.6) rotate(-10deg)}to{opacity:1;transform:none}}
@keyframes wcfSpUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes wcfSpLetter{from{opacity:0;transform:translateY(22px) scale(.85)}to{opacity:1;transform:none}}
@keyframes wcfSpBounce{from{transform:translateY(-26px)}to{transform:translateY(0) scale(1.08,.92)}}
@keyframes wcfSpShadow{from{transform:scale(.45);opacity:.35}to{transform:scale(1);opacity:1}}
@keyframes wcfSpSpin{to{transform:rotate(360deg)}}
@keyframes wcfSpStatus{0%{opacity:0;transform:translateY(6px)}18%,82%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-6px)}}
@keyframes wcfSpRush{from{transform:scale(1.2)}to{transform:scale(4.2)}}
@keyframes wcfSpDrop{to{opacity:0;transform:translateY(30px)}}
@keyframes wcfSpFlash{0%,30%{opacity:0}75%{opacity:1}100%{opacity:1}}
@keyframes wcfSpGone{to{opacity:0}}
@media (prefers-reduced-motion:reduce){
  .wcf-sp *,.wcf-sp-word i{animation:none!important}
  .wcf-sp-glow{opacity:1}
  .wcf-sp.out{animation:wcfSpGone .3s ease-in forwards}
}

.wcf-gate{position:relative;flex:1;min-height:100dvh;display:flex;flex-direction:column;gap:12px;padding:calc(env(safe-area-inset-top,0px) + 28px) 22px calc(env(safe-area-inset-bottom,0px) + 24px);background:var(--bg);color:#fff;overflow-y:auto}
.wcf-gate-photo{position:absolute;left:0;right:0;top:0;width:100%;height:46%;object-fit:cover;object-position:50% 55%}
.wcf-gate-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(13,13,26,.55) 0%,rgba(13,13,26,.5) 22%,rgba(13,13,26,.9) 40%,var(--bg) 52%)}
.wcf-gate-form{position:relative;margin-top:auto;display:flex;flex-direction:column;gap:14px;max-width:440px;width:100%;margin-inline:auto}
.wcf-gate h1{font-family:var(--display);font-weight:800;font-size:26px;line-height:1.12;margin:0;text-wrap:balance}
.wcf-gate-sub{font-size:14px;color:#cbd5e1;line-height:1.5;margin:-4px 0 4px}
.wcf-gate-field{display:flex;flex-direction:column;gap:6px}
.wcf-gate-field>span{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8}
.wcf-gate-field input{height:48px;border-radius:14px;border:1px solid rgba(148,163,184,.25);background:#161a2b;color:#fff;font:inherit;font-size:16px;padding:0 14px}
.wcf-gate-field input:focus{outline:none;border-color:#f5d97a}
.wcf-gate-field small{font-size:12px;color:#64748b}
.wcf-gate-error{font-size:13px;color:#fca5a5}
.wcf-gate-btn{height:52px;border-radius:14px;border:0;font:inherit;font-weight:800;font-size:16px;color:#1a1405;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);cursor:pointer;width:100%;max-width:440px;margin-inline:auto}
.wcf-gate-btn:disabled{opacity:.5}
.wcf-gate-link{border:0;background:none;color:#94a3b8;font:inherit;font-size:13px;text-decoration:underline;cursor:pointer;padding:8px;align-self:center}
.wcf-gate-mid{margin:auto 0;text-align:center;max-width:380px;margin-inline:auto;width:100%}
.wcf-gate-mid p{font-size:14.5px;color:#94a3b8;line-height:1.55;margin:10px auto 0;max-width:32ch}
.wcf-gate-ring{width:100px;height:100px;border-radius:50%;margin:0 auto 20px;display:grid;place-items:center;color:#f5d97a;background:radial-gradient(circle,rgba(245,217,122,.16),transparent 70%);box-shadow:inset 0 0 0 2px rgba(245,217,122,.55),0 0 40px -8px rgba(245,217,122,.6)}
.wcf-gate-ring.dim{color:#94a3b8;box-shadow:inset 0 0 0 2px rgba(148,163,184,.4);background:none}
.wcf-gate-steps{margin-top:22px;text-align:left;display:flex;flex-direction:column;gap:8px}
.wcf-gate-steps div{display:flex;gap:10px;align-items:center;font-size:14px;padding:11px 13px;border-radius:13px;background:#161a2b;border:1px solid rgba(148,163,184,.16)}
.wcf-gate-steps i{width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;font-style:normal;font-size:11.5px;font-weight:800}
.wcf-gate-steps .done i{background:#86efac;color:#0d1a14}
.wcf-gate-steps .now i{box-shadow:inset 0 0 0 2px #f5d97a;color:#f5d97a}
.wcf-gate-steps .next{color:#64748b}
.wcf-gate-steps .next i{box-shadow:inset 0 0 0 1.5px #64748b}
.wcf-gate-note{font-size:13px;color:#94a3b8;text-align:center;line-height:1.5;max-width:340px;margin-inline:auto}
.wcf-approve-row{display:flex;align-items:center;gap:12px;padding:4px 0 2px}
.wcf-approve-row>div{flex:1;min-width:0}
.wcf-approve-row b{display:block;font-size:14.5px}
.wcf-approve-row span{display:block;font-size:12.5px;color:var(--muted,#94a3b8);margin-top:3px;line-height:1.4}
.wcf-switch{width:50px;height:30px;border-radius:15px;border:0;background:rgba(148,163,184,.35);position:relative;flex:none;cursor:pointer;padding:0;transition:background .15s}
.wcf-switch::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;transition:left .15s}
.wcf-switch.on{background:#eab308}
.wcf-switch.on::after{left:23px}
.wcf-switch:disabled{opacity:.4;cursor:not-allowed}
.wcf-join-req{margin-top:10px;border-radius:15px;padding:13px;border:1px solid rgba(245,217,122,.4);background:rgba(245,217,122,.05)}
.wcf-join-req.declined{border-color:rgba(148,163,184,.2);background:none;opacity:.85}
.wcf-join-req-top{display:flex;gap:11px;align-items:center}
.wcf-join-req-av{width:40px;height:40px;border-radius:50%;flex:none;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:13.5px;color:#fff;background:linear-gradient(135deg,#2a2f4a,#3b3470);box-shadow:0 0 0 1.5px rgba(245,217,122,.5)}
.wcf-join-req-top b{display:block;font-size:15px}
.wcf-join-req-top div>span{display:block;font-size:12px;color:var(--muted,#94a3b8);margin-top:2px}
.wcf-join-req-knows{margin-top:10px;font-size:13px;line-height:1.45;padding:9px 11px;border-radius:10px;background:rgba(148,163,184,.08)}
.wcf-join-req-knows em{font-style:normal;color:#b8860b;font-weight:700}
.wcf-join-req-acts{display:flex;gap:8px;margin-top:11px}
.wcf-join-req-acts button{flex:1;height:40px;border-radius:11px;border:0;font:inherit;font-weight:800;font-size:13.5px;cursor:pointer}
.wcf-join-req-acts .gold{flex:1.4;color:#1a1405;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308)}
.wcf-join-req-acts .ghost{background:none;box-shadow:inset 0 0 0 1px rgba(148,163,184,.4);color:inherit}
.wcf-join-done{display:flex;align-items:center;gap:10px;margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(134,239,172,.12);border:1px solid rgba(134,239,172,.4);font-size:13.5px}
.wcf-join-done span{flex:1}
.wcf-join-done a{font-weight:800;color:#16a34a;white-space:nowrap}
.wcf-join-done button{border:0;background:none;font-size:18px;color:inherit;cursor:pointer;padding:0 4px}
.wcf-join-declined-toggle{margin-top:10px;border:0;background:none;font:inherit;font-size:12.5px;font-weight:700;color:var(--muted,#94a3b8);cursor:pointer;padding:4px 0}
.wcf-signin{position:relative;flex:1;overflow-y:auto;display:flex;flex-direction:column;background:var(--bg)}
.wcf-signin-photo{position:absolute;left:0;right:0;top:0;width:100%;height:72%;object-fit:cover;object-position:50% 55%}
.wcf-signin-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(13,13,26,.6) 0%,rgba(13,13,26,.34) 20%,rgba(13,13,26,.6) 52%,rgba(13,13,26,.86) 66%,var(--bg) 80%)}
.wcf-signin-head{position:relative;padding:36px 22px 0;flex:0 0 auto}
.wcf-signin-brand-row{display:flex;align-items:center;gap:10px}
.wcf-signin-crest{display:block;width:36px;height:40px;flex:0 0 auto}
.wcf-signin-crest img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,.55))}
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
/* The crest is a transparent cut-out (public/crest.png), so it sits on the
   header as it is - no box around it. */
.wcf-logo{display:block;width:42px;height:46px;flex:0 0 auto}
.wcf-logo img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}
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
.wcf-hero-roster-n2{font-family:var(--display);font-weight:800;font-size:15px;color:var(--white);white-space:nowrap;flex:none}
.wcf-hero-waiting-chip{white-space:nowrap;font-family:var(--sans);font-weight:800;font-size:8.5px;letter-spacing:.6px;color:#f5d97a;background:rgba(234,179,8,.16);border:1px solid rgba(234,179,8,.4);padding:3px 7px;border-radius:999px;white-space:nowrap}
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
.wcf-fx-status-row{display:flex;align-items:center;gap:6px}
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
/* Deliberately quiet: icon only, in the same outline as "Give up spot"
   beside it, so the booking card keeps one obvious action. A labelled
   blue button here crowded the card. Still a full 44px to tap. */
.wcf-cal-btn{flex:none;display:inline-grid;place-items:center;width:46px;height:46px;border-radius:12px;text-decoration:none;
  background:transparent;border:1px solid var(--line);color:var(--dim)}
.wcf-cal-btn:hover{color:var(--white);border-color:rgba(148,163,184,.35)}
.wcf-book{flex:1;background:var(--red);color:#fff;border:none;padding:13px 16px;border-radius:12px;font-family:var(--display);font-weight:800;font-size:13.5px;letter-spacing:.01em;cursor:pointer;transition:.15s}
.wcf-book:hover{background:var(--red-hi)}
.wcf-book.cancel{background:transparent;color:var(--white);border:1px solid var(--line)}
/* Most games are full, so this was a solid red button on nearly every
   card - the loudest colour in the app on the secondary action. Solid red
   is kept for "Grab a spot", the one people should actually notice. */
.wcf-book.waitlist{background:rgba(230,57,70,.08);color:#ff9aa1;border:1px solid rgba(230,57,70,.45)}
.wcf-book.waitlist:hover{background:rgba(230,57,70,.16)}
.wcf-book:disabled{background:var(--panel2);color:var(--dim);cursor:not-allowed}
.wcf-ghost{background:transparent;border:1px solid var(--line);color:var(--dim);padding:11px 12px;border-radius:10px;font-weight:700;font-size:12px;cursor:pointer}
.wcf-ghost.danger:hover{color:var(--red-hi);border-color:rgba(230,57,70,.5)}

.wcf-edit{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line);display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wcf-edit label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;font-weight:700}
.wcf-edit input{background:var(--bg);border:1px solid var(--line);color:var(--white);padding:9px;border-radius:10px;font-size:13px;font-family:var(--sans)}
.wcf-edit-actions{grid-column:1/-1;display:flex;gap:8px}
.wcf-save{grid-column:1/-1;background:var(--red);color:#fff;border:none;padding:11px;min-height:44px;border-radius:12px;font-weight:800;cursor:pointer;font-size:13px}
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
.wcf-later-fixtures{display:block;width:100%;margin:4px 0 18px;padding:12px;text-align:center}
.wcf-eyebrow{font-family:var(--display);font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 2px 12px}
.wcf-month-head:after{content:"";flex:1;height:1px;background:var(--line)}
.wcf-glance-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:6px}
.wcf-glance-card{display:block;text-align:left;padding:14px;border-radius:18px;width:100%;font:inherit;color:inherit;cursor:default;background:linear-gradient(180deg,rgba(30,41,59,.72),rgba(19,22,38,.9));border:1px solid var(--line);transition:filter .12s ease}
button.wcf-glance-card{cursor:pointer}
button.wcf-glance-card:disabled{cursor:default}
.wcf-glance-card.wide{grid-column:1/-1}
.wcf-glance-card.amber{background:linear-gradient(155deg,rgba(234,179,8,.15),rgba(19,22,38,.96) 62%);border-color:rgba(234,179,8,.35);box-shadow:0 16px 34px -26px rgba(234,179,8,.4)}
.wcf-glance-card.red{background:linear-gradient(155deg,rgba(240,82,94,.15),rgba(19,22,38,.96) 62%);border-color:rgba(240,82,94,.35);box-shadow:0 16px 34px -26px rgba(240,82,94,.4)}
.wcf-glance-card.calm .wcf-glance-num{color:var(--dim)}
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
.wcf-nudge-banner{display:grid;grid-template-columns:40px minmax(0,1fr);gap:12px;align-items:start;margin-bottom:14px;padding:14px;border-radius:18px;
  background:radial-gradient(120% 140% at 0% 0%,rgba(230,57,70,.18),transparent 60%),var(--panel);border:1px solid rgba(230,57,70,.35)}
.wcf-nudge-icon{width:40px;height:40px;border-radius:12px;background:rgba(230,57,70,.15);color:var(--red-hi);display:grid;place-items:center}
.wcf-nudge-body{min-width:0}
.wcf-nudge-banner strong{display:block;font-family:var(--display);font-weight:800;font-size:15px;color:var(--white)}
.wcf-nudge-banner p{font-size:12.5px;color:var(--dim);margin:3px 0 0;line-height:1.45}
.wcf-nudge-actions{display:flex;gap:8px;margin-top:10px}
.wcf-nudge-actions button{min-height:36px;font-size:13px;font-weight:700;padding:0 16px;border-radius:999px;border:none;background:var(--red);color:#fff;cursor:pointer}
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
.wcf-tab-nudge{width:100%;margin-top:12px;min-height:44px;padding:12px;border-radius:12px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.45);color:#f5d97a;font-weight:700;font-size:11.5px;cursor:pointer}
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
.wcf-pending-name-wrap{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.wcf-pending-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700;font-size:12px;color:#f1f5f9}
.wcf-pending-booked{font-size:9px;font-weight:600;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
/* Both lines are spans, so without display:block the margin did nothing
   and the venue and date ran together ("Solar CampusMon 28 Sep"). */
.wcf-admin-game-venue,.wcf-admin-game-date{display:block}
.wcf-admin-game-date{margin-top:3px;font-size:11px;color:var(--dim)}
.wcf-admin-game-badge{flex:none;font-weight:800;font-size:9px;letter-spacing:.1em;padding:6px 9px;border-radius:20px;white-space:nowrap}
.wcf-admin-game-badge.green{color:var(--green);background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35)}
.wcf-admin-game-badge.amber{color:var(--amber);background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.35)}
.wcf-admin-game-badge.muted{color:var(--dim);background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.22)}
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
.wcf-admin-add-player{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.wcf-admin-add-player input{width:100%;min-height:44px;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:9px 12px;border-radius:12px;font-size:13px;font-family:var(--sans);box-sizing:border-box}
.wcf-admin-add-results{display:flex;flex-direction:column;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:var(--panel)}
.wcf-admin-add-result{display:flex;justify-content:space-between;align-items:center;min-height:42px;padding:8px 12px;background:none;border:0;color:#f1f5f9;font-size:13px;cursor:pointer;text-align:left}
.wcf-admin-add-result+.wcf-admin-add-result{border-top:1px solid var(--line)}
.wcf-admin-add-result b{font-size:12px;color:#f5d97a}
.wcf-admin-add-none{padding:10px 12px;font-size:12.5px;color:var(--dim)}
.wcf-admin-add-player select{flex:1;min-height:44px;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:9px 12px;border-radius:12px;font-size:12px;font-family:var(--sans);box-sizing:border-box}
.wcf-admin-add-player .wcf-ghost{min-height:44px;padding:0 16px;border-radius:12px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.45);color:#f5d97a;font-weight:700;font-size:11.5px}
.wcf-admin-add-player .wcf-ghost:disabled{opacity:.4;cursor:not-allowed;background:rgba(148,163,184,.06);border-color:rgba(148,163,184,.16);color:var(--dim)}


.wcf-feed-section-label{display:flex;align-items:center;gap:10px;padding:6px 2px 10px;font-family:var(--sans);font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#64748b}
.wcf-feed-section-label:after{content:"";flex:1;height:1px;background:rgba(148,163,184,.1)}

.wcf-feed-hero{
  position:relative;min-height:270px;border-radius:22px;overflow:hidden;margin:2px 2px 18px;
  display:flex;flex-direction:column;justify-content:flex-end;padding:18px 18px 20px;
  background-image:linear-gradient(180deg,rgba(6,8,14,.05) 0%,rgba(6,8,14,.2) 50%,rgba(4,6,10,.94) 100%),url('/celebration.jpg');
  background-size:cover;background-position:center 38%;
  border:1px solid var(--line);box-shadow:0 18px 40px -24px rgba(0,0,0,.9);
}
/* In the Boot Room the photo card collapses to a band behind the pills:
   at full height it pushed the boots below the fold on a phone, and the
   Boot Room carries its own title anyway. */
.wcf-feed-hero.compact{min-height:0;padding:12px 12px 12px;margin-bottom:4px;background-position:center 30%}
.wcf-feed-hero.compact .wcf-feed-hero-eyebrow,.wcf-feed-hero.compact .wcf-feed-hero-title{display:none}
.wcf-feed-hero.compact .wcf-feed-hero-tabs{margin-top:0}
.wcf-feed-hero-eyebrow{font-family:var(--sans);font-size:10.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#f8b3b8}
.wcf-feed-hero-title{margin-top:6px;font-family:var(--display);font-size:19px;font-weight:800;letter-spacing:-.01em;color:#fff}
.wcf-feed-hero-tabs{display:flex;gap:8px;margin-top:16px}
.wcf-feed-hero-tabs button{flex:1;min-height:42px;padding:9px 14px;border-radius:20px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:12.5px;letter-spacing:.01em;background:rgba(148,163,184,.14);border:1px solid rgba(255,255,255,.2);color:#e2e8f0;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.wcf-feed-hero-tabs button.active{background:rgba(230,57,70,.88);border-color:rgba(230,57,70,.9);color:#fff}



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
.wcf-board-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800;font-size:14px}
.wcf-board-who{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.wcf-board-who .wcf-board-name{flex:none;max-width:100%;text-align:left}
.wcf-board-badges{display:flex;gap:5px;align-items:center}
.wcf-board-badges .wcf-apps-badge{margin-left:0}
.wcf-apps-badge{display:inline-block;flex:none;white-space:nowrap;margin-left:7px;font-size:10px;font-weight:800;font-family:var(--mono);color:var(--amber);background:rgba(224,167,51,.14);border:1px solid rgba(224,167,51,.35);padding:1px 7px;border-radius:20px;vertical-align:middle}
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
/* Matches the Season/Stats/Scores/Pot tabs above it - this was the one
   toggle in the app with its own 10.5px, 29px-tall style. */
.wcf-lb-sort-btn{flex:1;min-height:40px;border-radius:22px;padding:0 13px;cursor:pointer;font-family:var(--sans);font-weight:800;font-size:12.5px;
  background:var(--panel);border:1px solid var(--line);color:var(--dim)}
.wcf-lb-sort-btn.on{background:var(--red);border-color:var(--red);color:#fff}
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
.wcf-lineup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px;margin-bottom:14px}
.wcf-lineup-chip{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 4px 9px;border-radius:14px;cursor:pointer;
  background:var(--panel);border:1px solid var(--line);color:var(--white);font-family:var(--sans);min-width:0}
.wcf-lineup-chip.me{background:rgba(46,116,204,.14);border-color:rgba(46,116,204,.55)}
.wcf-lineup-chip-avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:15px;background:var(--panel2);color:var(--dim);object-fit:cover;flex:none}
/* Two lines at most, so "Qwyd Holtzhausen" wraps rather than truncating.
   Scoped by class: the photo-less avatar is a span too, and a bare
   ".wcf-lineup-chip span" knocked its initial off-centre. */
.wcf-lineup-chip-name{font-size:11px;font-weight:700;line-height:1.25;text-align:center;max-width:100%;overflow:hidden;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.wcf-lineup-row.me-edit{background:rgba(245,217,122,.07);border-color:rgba(245,217,122,.45)}
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
.wcf-lineup-group-note{font-size:11.5px;color:var(--dim);margin:-4px 2px 10px}
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

.wcf-lb-prize{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:12px 14px;border-radius:16px;
  background:radial-gradient(120% 160% at 100% 50%,rgba(245,217,122,.16),transparent 60%),var(--panel);border:1px solid rgba(245,217,122,.4)}
.wcf-lb-medals{display:flex;flex:none}
.wcf-lb-medals i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-family:var(--display);font-weight:800;font-size:12px;color:#0d0d1a;box-shadow:0 0 0 2px var(--panel)}
.wcf-lb-medals i + i{margin-left:-6px}
.wcf-lb-medals .g{background:#eab308}.wcf-lb-medals .s{background:#cbd5e1}.wcf-lb-medals .b{background:#e0915b}
.wcf-lb-prize-ic{flex:none;width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:rgba(245,217,122,.14);color:#f5d97a}
.wcf-lb-prize-text{min-width:0;font-size:13px;font-weight:700;color:var(--white);line-height:1.35}
.wcf-lb-prize-text b{color:#f5d97a}
.wcf-lb-prize-text small{display:block;font-size:11.5px;font-weight:500;color:var(--dim);margin-top:2px}
.wcf-lb-key{font-size:10.5px;color:var(--dim);text-align:center;margin-bottom:12px;line-height:1.6}
.wcf-lb{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 14px 4px}
.wcf-lb-rank{font-family:var(--mono);font-weight:800;font-size:12px;color:var(--dim);width:16px;flex:0 0 auto;text-align:center;display:grid;place-items:center}
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
/* Was an 11px blue text link that didn't read as tappable; now a proper
   pill in the same style as the app's other secondary buttons. */
.wcf-pl-footer button{flex:none;background:rgba(46,116,204,.16);border:1px solid rgba(46,116,204,.45);border-radius:20px;padding:0 15px;min-height:38px;cursor:pointer;font-size:12.5px;font-weight:800;color:#cfe0ff}

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
.wcf-streak-card{position:relative;overflow:hidden;display:flex;align-items:center;gap:16px;border-radius:20px;padding:16px 18px;margin-bottom:14px;
  background:var(--panel);border:1px solid var(--line);
  background:radial-gradient(120% 160% at 0% 50%,color-mix(in srgb,var(--team) 30%,transparent),transparent 60%),var(--panel);
  border:1px solid color-mix(in srgb,var(--team) 45%,transparent);box-shadow:0 18px 40px -26px var(--team)}
.wcf-streak-n{flex:none;min-width:48px;text-align:center;font-family:var(--display);font-weight:800;font-size:54px;line-height:.9;letter-spacing:-.04em;color:var(--team);text-shadow:0 0 24px color-mix(in srgb,var(--team) 60%,transparent)}
.wcf-streak-body{min-width:0}
.wcf-streak-eyebrow{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#fb923c}
.wcf-streak-title{font-family:var(--display);font-weight:800;font-size:18px;line-height:1.2;margin-top:4px;color:var(--white)}
.wcf-streak-sub{font-size:12.5px;color:var(--dim);margin-top:4px}
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
  background-image:linear-gradient(180deg,rgba(6,10,16,.45) 0%,rgba(6,10,16,.72) 35%,rgba(6,10,16,.86) 70%,rgba(6,10,16,.93) 100%),url('/pitch-ball-wet.jpg');
  background-size:cover;background-position:center 40%;
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
.wcf-result-share-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-weight:800;font-size:12.5px;padding:10px;border-radius:10px;cursor:pointer}
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
.wcf-role-badge.co-owner{color:#f5d97a;border:1px solid rgba(245,217,122,.45)}
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
.wcf-account-rename button{flex:none;min-height:46px;padding:0 15px;border-radius:12px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.45);color:#f5d97a;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-account-rename button:disabled{opacity:.5;cursor:not-allowed}
.wcf-account-emergency{display:flex;flex-direction:column;gap:8px}
.wcf-account-emergency input{min-width:0;min-height:46px;box-sizing:border-box;background:var(--bg);border:1px solid rgba(148,163,184,.2);color:var(--white);padding:13px;border-radius:12px;font-size:13px;font-weight:600;font-family:var(--sans);text-transform:none;letter-spacing:normal}
.wcf-account-emergency button{min-height:46px;padding:0 15px;border-radius:12px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.45);color:#f5d97a;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-account-emergency button:disabled{opacity:.5;cursor:not-allowed}
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
.wcf-star-picker{display:flex;gap:0;margin-top:4px;margin-left:-8px}
/* 40px square per star: the old 18px glyph with no padding was about half
   Apple's minimum tap size, so it was easy to land on the wrong rating. */
.wcf-star{background:none;border:none;font-size:24px;color:var(--line);cursor:pointer;padding:0;line-height:1;width:40px;height:40px;display:grid;place-items:center}
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
.wcf-modal-icon.danger{background:rgba(230,57,70,.15);border:1px solid rgba(230,57,70,.35);color:var(--red-hi)}
.wcf-modal-icon.safe{background:rgba(245,217,122,.14);border:1px solid rgba(245,217,122,.35);color:#f5d97a}
.wcf-modal-title{font-family:var(--display);font-size:16px;font-weight:800;margin-bottom:7px;color:var(--white)}
.wcf-modal-msg{font-size:12.5px;color:var(--dim);line-height:1.55;margin-bottom:20px}
.wcf-modal-actions{display:flex;gap:9px}
.wcf-modal-cancel{flex:1;background:rgba(148,163,184,.08);border:1px solid var(--line);color:var(--dim);padding:12px;border-radius:11px;font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-modal-confirm{flex:1;background:linear-gradient(135deg,var(--red),rgba(230,57,70,.5));color:#fff;border:1px solid rgba(230,57,70,.5);padding:12px;border-radius:11px;font-weight:800;font-size:12.5px;cursor:pointer;box-shadow:0 10px 24px -14px rgba(230,57,70,.8)}
.wcf-modal-confirm.safe{background:var(--red);border-color:var(--red);box-shadow:0 10px 24px -14px rgba(230,57,70,.8)}
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
.wcf-pcard-emergency{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.28);text-decoration:none}
.wcf-pcard-emergency-name{font-weight:700;font-size:12.5px;color:#f1f5f9}
.wcf-pcard-emergency-phone{font-family:var(--mono);font-weight:700;font-size:12.5px;font-variant-numeric:tabular-nums;color:#fca5a5}
.wcf-lightbox-close{position:fixed;top:16px;right:16px;width:38px;height:38px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--white);font-size:22px;line-height:1;cursor:pointer;z-index:101}
/* Player card walkout (PlayerCardModal). The resting styles are the
   finished card, so .skipped (animation:none) lands on it instantly. */
.wcf-beam{position:fixed;top:-40px;width:170px;height:110vh;background:linear-gradient(180deg,rgba(255,247,220,.42),rgba(255,247,220,0) 75%);filter:blur(8px);opacity:0;transform-origin:50% 0;pointer-events:none;animation:wcfBeam 1.8s ease-out forwards}
.wcf-beam.l{left:calc(50% - 250px);transform:rotate(-22deg)}
.wcf-beam.r{right:calc(50% - 250px);transform:rotate(22deg);animation-delay:.12s}
@keyframes wcfBeam{0%{opacity:0}25%{opacity:1}100%{opacity:.25}}
.wcf-walkout .wcf-pcard{position:relative;overflow:visible;animation:wcfWalkout .8s .2s cubic-bezier(.2,.8,.2,1) both}
.wcf-walkout .wcf-pcard-head{border-radius:20px 20px 0 0}
.wcf-walkout .wcf-pcard-body{border-radius:0 0 20px 20px}
.wcf-pcard-trace{position:absolute;left:-2px;top:-2px;pointer-events:none;overflow:visible;z-index:2}
.wcf-pcard-trace rect{fill:none;stroke:#f5d97a;stroke-width:2;opacity:0;animation:wcfTrace 1.1s .8s ease-in-out both}
@keyframes wcfWalkout{from{transform:translateY(110px) scale(.88);filter:blur(6px) brightness(.4);opacity:0}to{transform:none;filter:none;opacity:1}}
@keyframes wcfTrace{0%{stroke-dashoffset:var(--per);opacity:1}85%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}
.wcf-walkout .wcf-rv{animation:wcfRvIn .4s both;animation-delay:calc(.95s + var(--d,0s))}
.wcf-walkout .wcf-pcard-wdl{transform-origin:left;animation:wcfBarGrow .6s cubic-bezier(.3,.8,.3,1) both;animation-delay:1.4s}
.wcf-walkout .wcf-pcard-form i{animation:wcfPop .3s cubic-bezier(.3,1.6,.5,1) both;animation-delay:calc(1.65s + var(--i,0) * .09s)}
.wcf-walkout .wcf-pcard-fill{transform-origin:left;animation:wcfBarGrow .7s cubic-bezier(.3,.8,.3,1) both;animation-delay:calc(2.05s + var(--i,0) * .08s)}
.wcf-walkout .wcf-pcard-honour{animation:wcfPop .35s cubic-bezier(.3,1.6,.5,1) both;animation-delay:1s}
@keyframes wcfRvIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes wcfBarGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes wcfPop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}
.wcf-walkout.skipped .wcf-pcard,.wcf-walkout.skipped .wcf-pcard *,.wcf-walkout.skipped .wcf-beam{animation:none!important}
.wcf-walkout.skipped .wcf-beam{display:none}
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
.wcf-award-tag{font-weight:800;font-size:9px;letter-spacing:.08em;color:#cbd5e1;background:rgba(148,163,184,.1);border:1px solid var(--line);padding:5px 8px;border-radius:20px}
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
.wcf-upload-glyph{display:grid;place-items:center;color:#f5d97a}
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

/* GaffAI - admin-only assistant. Fixed above the bottom nav (z-index 5)
   so it's reachable from every tab; sheet/backdrop sit above everything
   else in the app (z-index 120, above .wcf-modal-overlay's 110) since
   it's meant to be usable mid-task regardless of what else is open. */
.gaffai-fab-wrap{position:fixed; right:18px; bottom:78px; z-index:25; transition:opacity .2s ease, transform .2s ease}
.gaffai-fab-wrap.scrolling{opacity:.15; transform:scale(.8); pointer-events:none}
.gaffai-fab-ring{position:absolute; inset:-6px; border-radius:50%; border:2px solid rgba(234,179,8,.55); animation:gaffaiPulse 2.2s ease-out infinite}
@keyframes gaffaiPulse{0%{transform:scale(.85); opacity:.9}70%{transform:scale(1.35); opacity:0}100%{opacity:0}}
.gaffai-fab{position:relative; width:52px; height:52px; border-radius:50%; border:1px solid rgba(245,217,122,.55); cursor:pointer;
  background:linear-gradient(145deg,#1d2438,#0d0d1a); color:#f5d97a; font-size:21px;
  display:flex; align-items:center; justify-content:center; box-shadow:0 10px 24px -8px rgba(234,179,8,.45)}
.gaffai-fab-badge{position:absolute; top:-4px; right:-4px; min-width:19px; height:19px; padding:0 5px; border-radius:10px;
  background:var(--red); color:#fff; font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center;
  border:2px solid var(--bg); font-variant-numeric:tabular-nums}

.gaffai-backdrop{position:fixed; inset:0; z-index:120; background:rgba(3,4,8,.6); display:flex; align-items:flex-end; justify-content:center;
  -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px)}
.gaffai-sheet{width:100%; max-width:520px; height:min(82vh,720px); background:#131624; border-radius:22px 22px 0 0;
  box-shadow:0 -20px 50px -20px rgba(0,0,0,.6); display:flex; flex-direction:column; border:1px solid var(--line); border-bottom:none}
.gaffai-sheet-handle{width:36px; height:4px; border-radius:4px; background:rgba(148,163,184,.3); margin:10px auto 2px}
.gaffai-sheet-head{display:flex; align-items:center; gap:10px; padding:10px 16px 12px; border-bottom:1px solid var(--line); background:radial-gradient(100% 140% at 0% 0%,rgba(245,217,122,.12),transparent 60%)}
.gaffai-sheet-titles{min-width:0}
.gaffai-sheet-sub{font-size:11px; color:var(--dim); margin-top:1px}
.gaffai-sheet-ico{width:36px; height:36px; border-radius:12px; background:linear-gradient(135deg,#1d2438,#0d0d1a); border:1px solid rgba(245,217,122,.4); color:#f5d97a;
  display:flex; align-items:center; justify-content:center; font-size:15px}
.gaffai-sheet-title{font-family:var(--display); font-weight:800; font-size:16px}
.gaffai-sheet-tag{font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--amber);
  background:rgba(234,179,8,.12); border:1px solid rgba(234,179,8,.3); padding:2px 7px; border-radius:20px; margin-left:2px}
.gaffai-sheet-reset,.gaffai-sheet-close{width:36px; height:36px; border-radius:50%; background:rgba(148,163,184,.1); border:none; color:#cbd5e1; font-size:15px; cursor:pointer}
.gaffai-sheet-reset{margin-left:auto}
.gaffai-sheet-caption{padding:10px 16px 2px; font-size:11.5px; color:var(--dim); line-height:1.5}

.gaffai-messages{flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:12px}
.gaffai-msg{max-width:88%; min-width:0; font-size:13px; line-height:1.5; padding:10px 13px; border-radius:14px; white-space:pre-wrap; overflow-wrap:anywhere}
.gaffai-msg.bot{white-space:normal}
.gaffai-msg.bot p{margin:0}
.gaffai-msg.bot p+p,.gaffai-msg.bot p+ul,.gaffai-msg.bot p+ol,.gaffai-msg.bot ul+p,.gaffai-msg.bot ol+p{margin-top:8px}
.gaffai-msg.bot ul,.gaffai-msg.bot ol{margin:4px 0 0; padding-left:18px}
.gaffai-msg.bot li+li{margin-top:2px}
.gaffai-msg.bot b{font-weight:800; color:#fff}
.gaffai-h{margin:10px 0 2px; font-size:10.5px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:#f5d97a}
.gaffai-h:first-child{margin-top:0}
.gaffai-msg.user{align-self:flex-end; background:var(--red); color:#fff; border-bottom-right-radius:4px}
.gaffai-msg.bot{align-self:flex-start; background:var(--panel2); color:var(--white); border:1px solid var(--line); border-bottom-left-radius:4px}
.gaffai-msg.bot.action-card{border:1px solid rgba(234,179,8,.35); background:rgba(234,179,8,.06)}
.gaffai-msg.bot.nudge{border:1px solid rgba(59,130,246,.3); background:rgba(59,130,246,.08); display:flex; align-items:flex-start; justify-content:space-between; gap:10px}
.gaffai-nudge-dismiss{flex:none; background:none; border:none; color:#94a3b8; font-size:13px; cursor:pointer; padding:0; line-height:1.4}
.gaffai-nudge-dismiss:hover{color:#fff}
.gaffai-flag{margin-left:6px; background:none; border:none; color:#5b6472; font-size:11px; cursor:pointer; vertical-align:middle; padding:0}
.gaffai-flag:hover{color:#94a3b8}
.gaffai-flag.flagged{color:#eab308; cursor:default}
.gaffai-action-buttons{display:flex; gap:8px; margin-top:10px}
.gaffai-action-confirm{flex:1; border:none; border-radius:10px; padding:8px 0; background:var(--green); color:#06210f; font-weight:800; font-size:12px; cursor:pointer}
.gaffai-action-cancel{flex:none; border:1px solid rgba(148,163,184,.3); border-radius:10px; padding:8px 14px; background:transparent; color:#cbd5e1; font-weight:700; font-size:12px; cursor:pointer}
.gaffai-action-result{margin-top:10px; font-size:12.5px; font-weight:600}
.gaffai-action-result.success{color:#86efac}
.gaffai-action-result.cancel{color:#8892a4}
.gaffai-typing{align-self:flex-start; display:flex; gap:4px; padding:12px 14px; background:var(--panel2); border:1px solid var(--line); border-radius:14px; border-bottom-left-radius:4px}
.gaffai-typing span{width:6px; height:6px; border-radius:50%; background:#7c8699; animation:gaffaiBounce 1.1s infinite ease-in-out}
.gaffai-typing span:nth-child(2){animation-delay:.15s}
.gaffai-typing span:nth-child(3){animation-delay:.3s}
@keyframes gaffaiBounce{0%,80%,100%{transform:translateY(0); opacity:.5}40%{transform:translateY(-4px); opacity:1}}

.gaffai-chip-groups{display:flex; flex-direction:column; gap:10px; margin-top:14px}
.gaffai-chip-label{padding:0 0 5px; font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:#64748b}
.gaffai-chips{display:flex; flex-wrap:wrap; gap:7px}
.gaffai-hello{margin-top:2px}
.gaffai-hello-t{font-family:var(--display); font-weight:800; font-size:19px; color:#fff}
.gaffai-hello-s{margin-top:2px; font-size:12px; color:var(--dim)}
.gaffai-needs{border-radius:16px; padding:12px; background:rgba(245,217,122,.07); border:1px solid rgba(245,217,122,.4)}
.gaffai-needs-k{font-size:10px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; color:#f5d97a}
.gaffai-needs-t{display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; width:100%; margin-top:4px; padding:0; background:none; border:0; text-align:left; cursor:pointer; font:inherit; font-size:13px; line-height:1.45; color:#f1f5f9; overflow-wrap:anywhere}
.gaffai-needs-t.open{display:block; -webkit-line-clamp:unset}
.gaffai-needs-more{margin-top:2px; font-size:11.5px; font-weight:700; color:#f5d97a}
.gaffai-needs-acts{display:flex; gap:6px; margin-top:9px}
.gaffai-needs-go{border:none; border-radius:9px; padding:7px 11px; background:#f5d97a; color:#0d0d1a; font-weight:800; font-size:12px; cursor:pointer}
.gaffai-needs-x{border:1px solid var(--line); border-radius:9px; padding:7px 11px; background:none; color:var(--dim); font-weight:700; font-size:12px; cursor:pointer}
.gaffai-chip{max-width:100%; white-space:normal; font-size:12px; font-weight:600; padding:8px 11px; border-radius:12px; background:var(--panel); border:1px solid var(--line); color:#e2e8f0; cursor:pointer; text-align:left}
.gaffai-chip:hover{background:rgba(148,163,184,.15)}

.gaffai-composer{display:flex; gap:8px; padding:10px 14px calc(14px + env(safe-area-inset-bottom,0px)); border-top:1px solid var(--line)}
.gaffai-composer input{flex:1; min-width:0; background:var(--bg); border:1px solid rgba(148,163,184,.2); color:var(--white); padding:11px 14px; border-radius:14px; font-size:13px; font-family:var(--sans); outline:none}
.gaffai-composer input::placeholder{color:#5b6472}
.gaffai-send{flex:none; width:40px; height:40px; border-radius:12px; border:none; background:var(--red); color:#fff; font-size:15px; cursor:pointer; display:flex; align-items:center; justify-content:center}

/* Three pill buttons (Update/Month/Fixture) in the fixtures header don't
   fit their natural width on the narrowest phones (iPhone SE and similar,
   ~375px) - .wcf-root clips overflow rather than scrolling, so the last
   button silently loses its label instead of erroring. Tightens padding
   and gap rather than shortening labels, so it still reads the same. */
@media (max-width:400px){
  .wcf-heading-actions{gap:5px}
  .wcf-addbtn{padding:8px 10px;font-size:11px;gap:4px}
}
/* ─── The Boot Room ─────────────────────────────────────────── */
.wcf-br{padding:0 0 4px}
.wcf-br-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 2px 0}
.wcf-br-kicker{font-family:var(--mono);font-weight:600;font-size:10px;letter-spacing:.22em;color:var(--dim)}
.wcf-br-title{font-family:var(--display);font-weight:800;font-size:30px;line-height:.95;letter-spacing:-.01em;margin-top:3px}
.wcf-br-sub{color:var(--dim);font-size:12.5px;line-height:1.5;margin-top:8px;max-width:28ch}
.wcf-br-iconbtn{flex:none;width:38px;height:38px;border-radius:12px;cursor:pointer;background:rgba(148,163,184,.1);border:1px solid var(--line);color:var(--white);display:grid;place-items:center}
.wcf-br-iconbtn.on{border-color:rgba(148,163,184,.45)}
.wcf-br-iconbtn svg{width:17px;height:17px}
.wcf-br-search{padding:12px 0 0}
.wcf-br-search input{width:100%;background:var(--panel);border:1px solid rgba(148,163,184,.28);border-radius:13px;padding:11px 13px;color:var(--white);font-family:var(--sans);font-size:15px;outline:none}
.wcf-br-search input:focus{border-color:var(--blue)}

/* The stage. The halo is CSS, not baked into the artwork: the renders'
   outer glow couldn't be recovered from their fake transparent
   background, and doing it here lets it take the category colour. */
.wcf-br-stage{position:relative;margin-top:8px}
.wcf-br-stage-glow{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);width:94%;height:110px;pointer-events:none;
  background:radial-gradient(ellipse at center,rgba(120,140,200,.16),transparent 70%)}
.wcf-br-stage-row{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;align-items:end}
.wcf-br-slot{background:none;border:none;padding:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;-webkit-tap-highlight-color:transparent}
.wcf-br-boot,.wcf-br-heroboot{display:block;width:100%;animation:wcfBrFloat 5.4s ease-in-out var(--d,0s) infinite}
.wcf-br-boot img,.wcf-br-heroboot img{width:100%;height:auto;display:block}
.wcf-br-boot .main{filter:drop-shadow(0 6px 10px rgba(0,0,0,.6)) drop-shadow(0 0 9px var(--c))}
.wcf-br-slot:active .wcf-br-boot .main{filter:drop-shadow(0 6px 10px rgba(0,0,0,.6)) drop-shadow(0 0 16px var(--c))}
/* Reflection lives in a short clipped box: a flipped full-size image
   still takes full layout height otherwise. The fade is on the box, not
   the image - a mask on the image would flip along with it. */
.wcf-br-boot .reflect,.wcf-br-heroboot .reflect{display:block;height:20px;overflow:hidden;margin-top:-3px;
  -webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.9),transparent);mask-image:linear-gradient(to bottom,rgba(0,0,0,.9),transparent)}
.wcf-br-boot .reflect img,.wcf-br-heroboot .reflect img{transform:scaleY(-1);opacity:.3;filter:blur(1.1px)}
@keyframes wcfBrFloat{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-6px) rotate(-1.2deg)}}

.wcf-br-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px}
.wcf-br-tile{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:9px 4px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px;font-family:var(--sans)}
.wcf-br-tile:active{border-color:var(--c)}
.wcf-br-tile img{width:28px;height:auto;filter:drop-shadow(0 0 5px var(--c))}
.wcf-br-tile b{font-family:var(--mono);font-weight:600;font-size:8.5px;letter-spacing:.08em;color:var(--c)}
.wcf-br-tile span{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}

.wcf-br-sec{display:flex;align-items:baseline;justify-content:space-between;padding:22px 2px 10px}
.wcf-br-sec-title{font-family:var(--display);font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.wcf-br-link{background:none;border:none;color:var(--dim);font-family:var(--sans);font-size:12px;cursor:pointer;padding:4px 0}
.wcf-br-note{color:var(--dim);font-size:12.5px;line-height:1.6;text-align:center;padding:10px 18px}
.wcf-br-empty{text-align:center;padding:20px 22px 0}
.wcf-br-empty b{display:block;font-family:var(--display);font-weight:700;font-size:18px}
.wcf-br-empty span{display:block;color:var(--dim);font-size:12.5px;line-height:1.6;margin-top:7px}

.wcf-br-cards{display:flex;flex-direction:column;gap:9px}
.wcf-br-card{display:flex;gap:11px;align-items:center;text-align:left;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:11px;cursor:pointer;
  font-family:var(--sans);color:var(--white);animation:wcfBrRise .32s ease both}
.wcf-br-card:active{border-color:rgba(148,163,184,.35)}
@keyframes wcfBrRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.wcf-br-card-body{min-width:0;flex:1;display:flex;flex-direction:column}
.wcf-br-card-top{display:flex;align-items:center;gap:6px;min-width:0}
.wcf-br-card-name{font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-br-card-desc{font-size:11.5px;color:var(--dim);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-br-card-meta{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0}
.wcf-br-recs{font-size:10.5px;color:var(--dim);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-br-flag{font-family:var(--mono);font-weight:600;font-size:8px;letter-spacing:.1em;flex:none}
.wcf-br-pick{font-family:var(--mono);font-weight:600;font-size:7.5px;letter-spacing:.08em;background:rgba(34,197,94,.14);color:#6ee79a;border:1px solid rgba(34,197,94,.3);padding:2px 5px;border-radius:5px;flex:none}
.wcf-br-new{font-weight:800;font-size:7.5px;letter-spacing:.04em;background:var(--red);color:#fff;padding:2px 5px;border-radius:999px;flex:none}

/* Logos sit on a near-white chip and are contained, never cropped: dark
   artwork on transparency (the most common) would vanish against this UI
   otherwise. A white logo can flip its own tile dark. */
.wcf-br-logo,.wcf-br-mono{flex:none;width:44px;height:44px;border-radius:13px;display:grid;place-items:center;overflow:hidden}
.wcf-br-logo{padding:5px;background:#eef1f6;box-shadow:inset 0 0 0 1px rgba(13,13,22,.08)}
.wcf-br-logo.on-dark{background:#14141f;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.wcf-br-logo img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.wcf-br-mono{font-family:var(--display);font-weight:800;font-size:15px;color:#0d0d16}
.wcf-br-logo.big,.wcf-br-mono.big{width:58px;height:58px;border-radius:17px}
.wcf-br-logo.big{padding:7px}
.wcf-br-mono.big{font-size:20px}

.wcf-br-faces{display:flex;flex:none}
.wcf-br-face{width:18px;height:18px;border-radius:50%;margin-left:-5px;border:1.5px solid var(--panel);display:grid;place-items:center;object-fit:cover;
  font-size:8px;font-weight:800;color:#fff;background:#334155;flex:none}
.wcf-br-faces .wcf-br-face:first-child{margin-left:0}
.wcf-br-face.me{box-shadow:0 0 0 1.5px #22c55e}

.wcf-br-catbar{display:flex;align-items:center;gap:10px;padding:16px 2px 0}
.wcf-br-catname{font-family:var(--mono);font-weight:600;font-size:10.5px;letter-spacing:.18em}
.wcf-br-cathero{text-align:center;padding:0 16px}
.wcf-br-herostage{position:relative;width:176px;margin:0 auto}
.wcf-br-herostage:after{content:"";position:absolute;left:50%;bottom:14px;transform:translateX(-50%);width:210px;height:48px;border-radius:50%;pointer-events:none;opacity:.18;
  background:radial-gradient(ellipse at center,var(--c),transparent 72%)}
.wcf-br-heroboot{position:relative;z-index:1}
.wcf-br-heroboot .main{filter:drop-shadow(0 10px 16px rgba(0,0,0,.6)) drop-shadow(0 0 22px var(--c))}
.wcf-br-heroboot .reflect{height:34px}
.wcf-br-line{font-family:var(--display);font-weight:800;font-size:25px;line-height:1.05;margin-top:8px;text-wrap:balance}
.wcf-br-blurb{color:var(--dim);font-size:12.5px;line-height:1.55;margin-top:8px}
.wcf-br-count{font-family:var(--mono);font-size:10px;letter-spacing:.1em;margin-top:10px}
.wcf-br-switch{display:flex;justify-content:center;gap:18px;margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.wcf-br-switch button{background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:5px;opacity:.6;padding:0}
.wcf-br-switch img{width:46px;height:auto;filter:drop-shadow(0 0 7px var(--c))}
.wcf-br-switch b{font-family:var(--mono);font-weight:600;font-size:8px;letter-spacing:.1em;color:var(--c)}

/* Room at the end so the last card can scroll clear of the peg button. */
.wcf-br-spacer{height:84px}
/* Centred, not bottom-right: GaffAI's button lives there for admins, and
   admins are exactly who sees the Boot Room first. */
.wcf-br-fab{position:fixed;left:50%;transform:translateX(-50%);bottom:84px;z-index:24;display:flex;align-items:center;gap:7px;
  padding:12px 17px 12px 14px;border-radius:999px;border:none;cursor:pointer;background:linear-gradient(145deg,#f4b455,#f0ab3d);color:#17130a;
  font-family:var(--sans);font-weight:800;font-size:13px;box-shadow:0 12px 26px -8px rgba(240,171,61,.55)}
.wcf-br-fab svg{width:16px;height:16px}
.wcf-br-fab.inline{position:static;transform:none;margin:16px auto 0}

/* Sheets reuse .wcf-sheet-overlay/.wcf-squad-sheet; this is their body. */
.wcf-br-sheet-body{overflow-y:auto;padding:12px 18px calc(22px + env(safe-area-inset-bottom,0px));-webkit-overflow-scrolling:touch}
.wcf-br-dtop{display:flex;gap:13px;align-items:center;padding-right:34px}
.wcf-br-dname{font-family:var(--display);font-weight:700;font-size:19px;line-height:1.15}
.wcf-br-dwho{font-size:12px;color:var(--dim);margin-top:3px}
.wcf-br-ddesc{font-size:13.5px;line-height:1.6;color:#cfd4e0;margin-top:14px}
.wcf-br-dtags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.wcf-br-dtags span{font-size:11px;color:var(--dim);background:rgba(148,163,184,.08);border:1px solid var(--line);padding:4px 9px;border-radius:999px}
.wcf-br-proof{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;color:var(--dim)}
.wcf-br-wa{margin-top:14px;display:flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;padding:14px;border-radius:14px;
  background:#25d366;color:#06301a;font-weight:800;font-size:14px}
.wcf-br-wa svg{width:19px;height:19px}
.wcf-br-dnote{margin-top:9px;font-size:11.5px;color:var(--dim);text-align:center;line-height:1.5}
.wcf-br-dnote.spaced{margin-top:16px}
.wcf-br-endorse{margin-top:12px;width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:13px;cursor:pointer;
  font-family:var(--sans);font-weight:800;font-size:13.5px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.28);color:var(--white)}
.wcf-br-endorse svg{width:17px;height:17px}
.wcf-br-endorse.on{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.5);color:#6ee79a}
.wcf-br-endorse:disabled{opacity:.55;cursor:default}
.wcf-br-owner{display:flex;gap:8px;margin-top:12px}
.wcf-br-secondary,.wcf-br-danger{flex:1;padding:12px;border-radius:12px;cursor:pointer;font-family:var(--sans);font-weight:700;font-size:13px}
.wcf-br-secondary{background:rgba(148,163,184,.1);border:1px solid rgba(148,163,184,.28);color:var(--white)}
.wcf-br-danger{background:none;border:1px solid rgba(230,57,70,.45);color:#ff8e95}
.wcf-br-danger.wide{width:100%;margin-top:12px}
.wcf-br-danger:disabled,.wcf-br-secondary:disabled{opacity:.5}

.wcf-br-ftitle{font-family:var(--display);font-weight:700;font-size:19px;padding-right:34px}
.wcf-br-fsub{font-size:12px;color:var(--dim);margin-top:3px;margin-bottom:16px;line-height:1.5}
.wcf-br-field{display:block;margin-bottom:16px}
.wcf-br-field>span:first-child{display:block;font-size:11.5px;font-weight:700;color:var(--dim);margin-bottom:7px}
/* 16px text: anything smaller makes iOS Safari zoom the page on focus. */
.wcf-br-field input[type=text],.wcf-br-field input[type=tel],.wcf-br-field textarea{width:100%;background:rgba(148,163,184,.08);border:1px solid var(--line);border-radius:11px;
  padding:11px 12px;color:var(--white);font-family:var(--sans);font-size:16px;outline:none}
.wcf-br-field textarea{min-height:72px;resize:vertical;line-height:1.45}
.wcf-br-field input:focus,.wcf-br-field textarea:focus{border-color:var(--blue)}
/* Clearly faded: at the default brightness the example text read as
   something already typed, so the form looked filled in when it wasn't. */
.wcf-br-field input::placeholder,.wcf-br-field textarea::placeholder{color:rgba(148,163,184,.5);opacity:1}
.wcf-br-field input.bad,.wcf-br-field input.bad:focus{border-color:rgba(230,57,70,.75)}
.wcf-br-hint{display:block;font-size:11px;color:var(--dim);margin-top:6px;line-height:1.45}
.wcf-br-hint.err{color:#ff8e95}
.wcf-br-logorow{display:flex;align-items:center;gap:12px}
.wcf-br-logodrop{width:64px;height:64px;flex:none;border-radius:16px;cursor:pointer;padding:0;overflow:hidden;background:rgba(148,163,184,.08);border:1px dashed rgba(148,163,184,.35);display:grid;place-items:center}
.wcf-br-logodrop .add{font-size:9.5px;color:var(--dim);font-family:var(--sans);line-height:1.3;padding:0 4px}
.wcf-br-logodrop .shot{width:100%;height:100%;padding:7px;background:#eef1f6;display:grid;place-items:center}
.wcf-br-logodrop .shot.on-dark{background:#14141f}
.wcf-br-logodrop .shot img{max-width:100%;max-height:100%;object-fit:contain}
.wcf-br-logoside{min-width:0;flex:1}
.wcf-br-logoacts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.wcf-br-logoacts button{background:rgba(148,163,184,.08);border:1px solid var(--line);color:var(--dim);font-family:var(--sans);font-size:11px;font-weight:700;padding:6px 10px;border-radius:9px;cursor:pointer}
.wcf-br-logoacts button.on{color:var(--white);border-color:#f0ab3d;background:rgba(240,171,61,.12)}
.wcf-br-pickgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
.wcf-br-pickgrid button{background:rgba(148,163,184,.06);border:1px solid var(--line);border-radius:12px;cursor:pointer;padding:9px 3px 7px;display:flex;flex-direction:column;align-items:center;gap:4px}
.wcf-br-pickgrid img{width:26px;height:auto;filter:drop-shadow(0 0 4px var(--c))}
.wcf-br-pickgrid b{font-family:var(--mono);font-weight:600;font-size:7.5px;letter-spacing:.06em;color:var(--dim)}
.wcf-br-pickgrid button.on{border-color:var(--c);background:rgba(255,255,255,.05)}
.wcf-br-pickgrid button.on b{color:var(--c)}
.wcf-br-tagpick{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.wcf-br-tagpick button{font-family:var(--sans);font-size:12px;color:var(--dim);background:rgba(148,163,184,.08);border:1px solid var(--line);padding:7px 11px;border-radius:999px;cursor:pointer}
.wcf-br-tagpick button.on{background:rgba(46,116,204,.18);border-color:rgba(46,116,204,.55);color:#cfe0ff}
.wcf-br-save{width:100%;margin-top:4px;padding:15px;border-radius:14px;border:none;cursor:pointer;background:linear-gradient(145deg,#f4b455,#f0ab3d);color:#17130a;font-family:var(--sans);font-weight:800;font-size:14px}
.wcf-br-save:disabled{opacity:.5}
.wcf-br-formerr{margin:0 0 10px;padding:11px 13px;border-radius:12px;background:rgba(230,57,70,.12);border:1px solid rgba(230,57,70,.45);color:#ffb4b9;font-size:12.5px;line-height:1.5}

/* On a small phone the category flag costs ~55px of a card that's already
   truncating the business name, and it's redundant there. */
@media (max-width:400px){.wcf-br-flag{display:none}}
@media (prefers-reduced-motion: reduce){.wcf-br-boot,.wcf-br-heroboot,.wcf-br-card{animation:none}}

/* ─── App-wide form and button standards ────────────────────────
   Buttons and form fields don't inherit the page font by default, so any
   without their own font rule fell back to the phone's system font rather
   than Inter - the nav labels, account section headers and a scatter of
   buttons. Zero specificity (:where), so every rule that sets its own
   font still wins. */
.wcf-subtabs button{padding:9px 4px}
.wcf-rec-group{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:20px 2px 8px}
.wcf-rec-row.has-faces{grid-template-columns:58px minmax(0,1fr) auto}
.wcf-rec-row.mine{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.08);box-shadow:0 0 22px -10px rgba(245,217,122,.7)}
.wcf-rec-you{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:5px;background:#f5d97a;color:#0d0d1a;font-size:10px;font-weight:800;letter-spacing:.08em;vertical-align:2px;text-transform:uppercase}
.wcf-rec-faces{display:flex;align-items:center}
.wcf-rec-face{width:32px;height:32px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-weight:800;font-size:12px;color:#fff;box-shadow:0 0 0 2px var(--panel,#161a2b)}
.wcf-rec-face + .wcf-rec-face{margin-left:-10px}
.wcf-rec-hero{position:relative;overflow:hidden;border-radius:20px;border:1px solid rgba(245,217,122,.35);margin-bottom:14px;min-height:170px;background:#0d0d1a}
.wcf-rec-hero-bg{position:absolute;inset:0;background:url(/wrapped/records.jpg) 50% 66%/cover}
.wcf-rec-hero-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(13,13,26,.95) 0%,rgba(13,13,26,.72) 50%,rgba(13,13,26,.1) 100%)}
.wcf-rec-hero-in{position:relative;z-index:1;padding:16px 16px 18px}
.wcf-rec-hero-stat{display:flex;align-items:center;gap:12px;margin-top:12px}
.wcf-rec-hero-stat b{font-family:var(--display);font-weight:800;font-size:44px;line-height:1;background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-rec-hero-stat span{font-size:12.5px;line-height:1.4;color:#e2e8f0;font-weight:600}
.wcf-rec-row{display:grid;grid-template-columns:58px minmax(0,1fr);min-height:64px;gap:12px;align-items:center;padding:11px 12px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.02);margin-bottom:8px}
.wcf-rec-val{font-family:var(--display);font-weight:800;font-size:24px;line-height:1.1;text-align:center;font-variant-numeric:tabular-nums;background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-rec-label{font-size:13px;font-weight:700;color:var(--white,#f5f6f8)}
.wcf-rec-who{font-size:13px;color:var(--dim);margin-top:3px;line-height:1.45}
.wcf-rec-who .wcf-name-link,.wcf-rec-hat .wcf-name-link{font-size:13px;padding:0}
.wcf-rec-date{color:var(--dim);font-size:12px}
.wcf-rec-green{color:var(--green)}
.wcf-rec-who .wcf-rec-name{display:block;font-size:13px;font-weight:700;color:var(--white,#f5f6f8);text-align:left}
.wcf-rec-who .wcf-rec-name + .wcf-rec-date{display:block;margin-top:2px}
.wcf-rec-more{display:block;width:100%;min-height:40px;margin-top:2px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--dim);font-weight:700;font-size:13px;cursor:pointer}
/* Player of the Month: a photo card in the same family as the season hero. */
.wcf-potm-card{position:relative;overflow:hidden;border-radius:20px;border:1px solid rgba(234,179,8,.45);padding:16px 16px 18px;margin-bottom:14px;background:#0d0d1a;box-shadow:0 18px 40px -22px rgba(234,179,8,.55)}
.wcf-potm-bg{position:absolute;inset:0;background:url(/wrapped/motm.jpg) 70% 22%/cover;opacity:.9}
.wcf-potm-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(13,13,26,.94) 0%,rgba(13,13,26,.7) 45%,rgba(13,13,26,.1) 100%),linear-gradient(0deg,rgba(13,13,26,.8),transparent 55%)}
.wcf-potm-top,.wcf-potm-main,.wcf-potm-stats,.wcf-potm-note{position:relative;z-index:1}
.wcf-potm-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcf-potm-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#f5d97a}
.wcf-potm-share{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border-radius:999px;border:1px solid rgba(245,217,122,.55);background:rgba(13,13,26,.55);color:#f5d97a;font-weight:700;font-size:12.5px;cursor:pointer;flex:none}
.wcf-potm-main{display:flex;align-items:center;gap:14px;margin-top:14px}
.wcf-potm-faces{display:flex;flex:none}
.wcf-potm-face{width:64px;height:64px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:22px;color:#fff;box-shadow:0 0 0 3px #eab308,0 0 22px rgba(234,179,8,.5)}
.wcf-potm-face + .wcf-potm-face{margin-left:-14px}
.wcf-potm-who{min-width:0;display:flex;flex-direction:column;align-items:flex-start}
.wcf-potm-name{background:none;border:0;padding:0;color:#fff;font-family:var(--display);font-weight:800;font-size:24px;line-height:1.1;text-align:left;cursor:pointer;letter-spacing:-.01em}
.wcf-potm-amp{color:#f5d97a}
.wcf-potm-stats{display:flex;gap:18px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(245,217,122,.22)}
.wcf-potm-stats span{display:flex;flex-direction:column;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.wcf-potm-stats b{font-family:var(--display);font-size:22px;color:#f5d97a;letter-spacing:0;line-height:1.1}
.wcf-potm-note{margin-top:12px;font-size:12.5px;color:var(--dim)}
/* Scores rows: the date leads, the result says who won, and the MOTM and
   top scorer are on the row so most people never need to open it. */
.wcf-res-row{display:grid;grid-template-columns:48px minmax(0,1fr) 18px;gap:12px;align-items:center}
.wcf-res-date{text-align:center;line-height:1;padding:6px 0;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.wcf-res-date b{display:block;font-family:var(--display);font-weight:800;font-size:19px;color:var(--white)}
.wcf-res-date span{display:block;font-size:9.5px;font-weight:800;letter-spacing:.12em;color:var(--dim);margin-top:3px}
.wcf-res-mid{min-width:0}
.wcf-res-score{display:flex;align-items:center;gap:7px;font-family:var(--display);font-weight:800;font-size:21px;line-height:1.1}
.wcf-res-pill{margin-left:4px;font-family:var(--sans);font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:5px;color:#fff;white-space:nowrap}
.wcf-res-pill.white{color:#111}
.wcf-res-pill.draw{background:#475569}
.wcf-res-meta{font-size:12px;color:var(--dim);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcf-res-meta b{color:#f5d97a;font-weight:700}
.wcf-res-open{color:var(--green);font-weight:700}
.wcf-res-chev{color:var(--dim);transition:transform .2s}
.wcf-res-chev.open{transform:rotate(90deg)}
/* Stats list, matching the Records rows: boxed rows, the sorted-by column
   in gold, and your own row glowing gold. Later rules, so they win. */
.wcf-board-row:not(.wcf-board-header){border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.02);margin-bottom:8px;padding:10px 12px}
.wcf-board-row:not(.wcf-board-header):last-child{border-bottom:1px solid var(--line)}
.wcf-board-header{padding:0 12px 8px;border-bottom:0}
.wcf-board-row.lead{background:rgba(245,217,122,.07);border-color:rgba(245,217,122,.4);margin-bottom:8px}
.wcf-board-row.me{background:rgba(245,217,122,.1);border-color:rgba(245,217,122,.6);box-shadow:0 0 22px -10px rgba(245,217,122,.7)}
.wcf-board-row.me .wcf-board-name{color:var(--white)}
.wcf-rank{font-family:var(--display);font-weight:800;font-size:13px}
.wcf-rank-star,.wcf-rank-star svg{color:#eab308;fill:#eab308;stroke:#eab308}
.wcf-board-count{font-family:var(--display);font-weight:800;font-size:15px;color:#cbd5e1;font-variant-numeric:tabular-nums;width:32px}
.wcf-board-row:not(.wcf-board-header){gap:8px;padding:10px 10px}
.wcf-board-count.on{background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-board-header .wcf-board-count.on{background:none;color:#f5d97a;-webkit-text-fill-color:#f5d97a}
.wcf-apps-badge{font-family:var(--sans);text-transform:uppercase;letter-spacing:.08em;font-size:9.5px;color:#f5d97a;background:transparent;border:1px solid rgba(245,217,122,.45);border-radius:4px;padding:1px 5px}
.wcf-lb-you-badge{background:#f5d97a;color:#0d0d1a}
.wcf-ft{display:flex;flex-direction:column;gap:6px}
.wcf-ft-head{display:flex;align-items:center;gap:8px}
.wcf-ft-label{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.wcf-ft-head .wcf-res-pill{margin-left:0}
.wcf-ft-score{display:flex;align-items:baseline;gap:8px}
.wcf-ft-score b{font-family:var(--display);font-weight:800;font-size:26px;line-height:1}
.wcf-ft-dash{color:var(--dim);font-family:var(--display);font-weight:700;font-size:18px}
.wcf-ft-team{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-ft-scorers{font-size:12px;color:var(--dim);line-height:1.45}
/* Fairness: ratings as labelled bars, and buttons in the app's red. */
.wcf-ratings-row{flex-direction:column;align-items:stretch;gap:8px;padding:11px 0}
.wcf-ratings-name{flex-wrap:wrap;gap:6px}
.wcf-ratings-who{font-size:13.5px;font-weight:700;color:var(--white)}
.wcf-ratings-source{margin-left:auto}
.wcf-ratings-bars{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.wcf-ratings-bar{min-width:0}
.wcf-ratings-bar-top{display:flex;justify-content:space-between;align-items:baseline;font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--dim);margin-bottom:4px}
.wcf-ratings-bar-top b{font-family:var(--display);font-size:12px;color:var(--white)}
.wcf-ratings-track{display:block;height:5px;border-radius:5px;background:var(--panel2);overflow:hidden}
.wcf-ratings-track i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#e63946,#f0525e)}
.wcf-generate-teams{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--red);border-radius:999px;min-height:46px;font-weight:700;font-size:14px}
.wcf-suggestion-actions .wcf-generate-teams{background:transparent;border:1px solid var(--line);color:var(--white)}
.wcf-apply-teams{background:var(--red);color:#fff;border-radius:999px;min-height:46px;font-weight:700}
.wcf-suggestion-actions .wcf-ghost{border-radius:999px;min-height:46px}
.wcf-motm-post-meta{font-size:12px;color:var(--dim);margin-top:3px}
.wcf-motm-post-meta b{color:#f5d97a;font-weight:700}
.wcf-rec-post{line-height:1.45}
.wcf-rec-post-score{font-size:11.5px;font-weight:700;color:var(--dim)}
.wcf-rec-post-line{margin-top:3px}
.wcf-rec-post-tag{display:inline-block;margin-right:6px;padding:1px 6px;border-radius:5px;background:#f5d97a;color:#0d0d1a;font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;vertical-align:1px}
.wcf-rec-season{margin-bottom:14px}
.wcf-bests{position:relative;overflow:hidden;margin-bottom:14px;padding:16px 16px 18px;border-radius:20px;background:#0d0d1a;border:1px solid rgba(245,217,122,.3);box-shadow:0 18px 40px -26px rgba(245,217,122,.5)}
.wcf-bests-bg{position:absolute;inset:0;background:url(/wrapped/glance.jpg) 80% 30%/cover;opacity:.55}
.wcf-bests-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(13,13,26,.96) 0%,rgba(13,13,26,.78) 50%,rgba(13,13,26,.35) 100%),linear-gradient(0deg,rgba(13,13,26,.92),transparent 70%)}
.wcf-bests-head,.wcf-bests-grid{position:relative;z-index:1}
.wcf-bests-head{display:flex;align-items:center;gap:14px}
.wcf-bests-face{width:56px;height:56px;border-radius:50%;flex:none;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:20px;color:#fff;box-shadow:0 0 0 3px #eab308,0 0 20px rgba(234,179,8,.45)}
.wcf-bests-who{display:flex;flex-direction:column;min-width:0}
.wcf-bests-eyebrow{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#f5d97a}
.wcf-bests-name{font-family:var(--display);font-weight:800;font-size:20px;line-height:1.15;color:var(--white);letter-spacing:-.01em;margin-top:2px}
.wcf-bests-meta{font-size:12px;color:var(--dim);margin-top:2px}
.wcf-bests-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px 10px;margin-top:16px;padding-top:14px;border-top:1px solid rgba(245,217,122,.22)}
.wcf-bests-stat{display:flex;flex-direction:column;min-width:0}
.wcf-bests-stat b{font-family:var(--display);font-weight:800;font-size:28px;line-height:1;color:var(--white);font-variant-numeric:tabular-nums}
.wcf-bests-stat span{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-top:6px;line-height:1.3}
.wcf-bests-stat small{font-size:11px;color:var(--faint,#64748b);margin-top:2px}
.wcf-bests-stat em{display:inline-flex;align-items:center;gap:4px;font-style:normal;font-size:10.5px;font-weight:800;color:#f5d97a;margin-top:3px}
.wcf-bests-stat.record b{background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-queue{margin:12px 0 10px;padding:12px;border-radius:16px;background:rgba(245,217,122,.07);border:1px solid rgba(245,217,122,.4)}
.wcf-queue-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a}
.wcf-queue-t{font-family:var(--display);font-weight:800;font-size:21px;margin-top:3px;color:var(--white)}
.wcf-queue-line{display:flex;align-items:flex-start;gap:8px;margin-top:10px;overflow-x:auto}
.wcf-queue-spot{flex:none;width:36px;height:36px;border-radius:50%;border:2px dashed rgba(134,239,172,.6);display:grid;place-items:center;color:var(--green,#86efac);font-weight:800;font-size:9px;letter-spacing:.04em}
.wcf-queue-arrow{color:var(--dim);font-size:15px;line-height:36px}
.wcf-queue-slot{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:var(--dim);max-width:52px;text-align:center}
.wcf-queue-slot>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52px}
.wcf-queue-av{width:36px;height:36px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:12px;color:#fff}
.wcf-queue-slot.me{color:#f5d97a;font-weight:800}
.wcf-queue-slot.me .wcf-queue-av{box-shadow:0 0 0 3px #eab308,0 0 14px rgba(234,179,8,.5)}
.wcf-queue-s{font-size:12px;color:var(--dim);margin-top:10px;line-height:1.45}
.wcf-pcard-badges{flex-wrap:wrap;justify-content:center}
.wcf-pcard-badges>span{white-space:nowrap}
.wcf-pcard-honour{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:#f5d97a;color:#0d0d1a}
.wcf-pcard-season{margin-top:14px}
.wcf-pcard-sec-head{display:flex;justify-content:space-between;align-items:baseline;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-pcard-sec-head b{font-family:var(--display);font-size:12px;letter-spacing:.02em;color:var(--white)}
.wcf-pcard-wdl{display:flex;height:24px;border-radius:7px;overflow:hidden;margin-top:6px;font-family:var(--display);font-weight:800;font-size:11px}
.wcf-pcard-wdl div{display:grid;place-items:center;color:#0d0d1a;min-width:18px}
.wcf-pcard-wdl .w{background:#86efac}.wcf-pcard-wdl .d{background:#cbd5e1}.wcf-pcard-wdl .l{background:#f8b3b8}
.wcf-pcard-form{display:flex;gap:6px;margin-top:6px}
.wcf-pcard-form i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-family:var(--display);font-weight:800;font-size:10.5px;color:#0d0d1a}
.wcf-pcard-form .fW{background:#86efac}.wcf-pcard-form .fD{background:#cbd5e1}.wcf-pcard-form .fL{background:#f8b3b8}
.wcf-pcard-bests{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:6px}
.wcf-pcard-bests b{display:block;font-family:var(--display);font-weight:800;font-size:19px;color:var(--white)}
.wcf-pcard-bests span{display:block;font-size:10.5px;color:var(--dim);font-weight:600;line-height:1.3;margin-top:2px}
/* Predict leaderboard in the Stats/Records style: gold points, your row in gold. */
.wcf-lb-pts{background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:17px}
.wcf-pl-row.me{background:rgba(245,217,122,.1);border-bottom:1px solid rgba(245,217,122,.35);box-shadow:inset 0 0 0 1px rgba(245,217,122,.35)}
.wcf-pl-row.lead{background:rgba(245,217,122,.07)}
.wcf-predict-top{margin-bottom:16px}
.wcf-pl-exact{font-size:11px;font-weight:700;color:#f5d97a;white-space:nowrap}
/* ── Admin, redesigned: four tabs, "Needs you" first, compact fixtures. */
.wcf-admin-tabs button{position:relative}
.wcf-admin-tab-badge{position:absolute;top:-7px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#eab308;color:#0d0d1a;font-style:normal;font-size:10.5px;font-weight:800;display:grid;place-items:center}
.wcf-needs{border-radius:20px;padding:14px;margin-bottom:12px;border:1px solid rgba(245,217,122,.4);background:radial-gradient(120% 140% at 0% 0%,rgba(245,217,122,.12),transparent 60%),var(--panel)}
.wcf-needs.clear{border-color:rgba(34,197,94,.35);background:radial-gradient(120% 140% at 0% 0%,rgba(34,197,94,.12),transparent 60%),var(--panel)}
.wcf-needs-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:2px}
.wcf-needs-head b{font-family:var(--display);font-weight:800;font-size:18px;color:var(--white)}
.wcf-needs-head span{font-size:12px;font-weight:700;color:#f5d97a}
.wcf-needs.clear .wcf-needs-head span{color:var(--green,#86efac)}
.wcf-todo{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:10px;align-items:center;padding:11px 0;border-top:1px solid var(--line)}
.wcf-needs .wcf-todo:first-of-type{border-top:0}
.wcf-todo-ic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-weight:800;font-size:14px}
.wcf-todo-ic.gold{background:rgba(245,217,122,.16);color:#f5d97a}.wcf-todo-ic.red{background:rgba(230,57,70,.16);color:var(--red-hi)}.wcf-todo-ic.blue{background:rgba(127,176,236,.16);color:#7fb0ec}
.wcf-todo-tx{min-width:0}
.wcf-todo-tx b{display:block;font-size:13.5px;color:var(--white);line-height:1.3}
.wcf-todo-tx span{display:block;font-size:11.5px;color:var(--dim);margin-top:2px;line-height:1.35}
.wcf-todo-btn{min-height:34px;padding:0 14px;border-radius:999px;border:0;font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap}
.wcf-todo-btn.gold{background:#f5d97a;color:#0d0d1a}.wcf-todo-btn.red{background:var(--red);color:#fff}.wcf-todo-btn.blue{background:rgba(127,176,236,.18);color:#cfe0ff;border:1px solid rgba(127,176,236,.45)}
.wcf-admin-next{border-radius:18px;padding:13px 14px;margin-bottom:12px;border:1px solid rgba(34,197,94,.35);background:radial-gradient(120% 90% at 50% 0%,rgba(34,197,94,.12),transparent 60%),#10131f}
.wcf-admin-next-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--green,#86efac)}
.wcf-admin-next-t{font-family:var(--display);font-weight:800;font-size:18px;margin-top:3px;color:var(--white)}
.wcf-admin-next-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.wcf-chip{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid var(--line);color:#cbd5e1}
.wcf-chip.g{color:var(--green,#86efac);border-color:rgba(134,239,172,.4)}.wcf-chip.w{color:#f5d97a;border-color:rgba(245,217,122,.45)}.wcf-chip.r{color:var(--red-hi);border-color:rgba(230,57,70,.45)}
.wcf-admin-next-acts{display:flex;gap:8px;margin-top:11px;flex-wrap:wrap}
.wcf-pill-btn{min-height:38px;padding:0 16px;border-radius:999px;font-weight:700;font-size:13px;cursor:pointer;border:1px solid transparent}
.wcf-pill-btn.ghost{background:transparent;border-color:var(--line);color:var(--white)}
.wcf-pill-btn.red{background:var(--red);color:#fff}
.wcf-pill-btn.wide{width:100%}
.wcf-pill-btn:disabled{opacity:.45;cursor:default}
.wcf-admin-calm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.wcf-admin-calm div{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px 11px}
.wcf-admin-calm b{display:block;font-family:var(--display);font-weight:800;font-size:19px;color:var(--white)}
.wcf-admin-calm span{display:block;font-size:10.5px;font-weight:600;color:var(--dim);line-height:1.3;margin-top:2px}
.wcf-admin-group{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:18px 2px 8px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-admin-group:first-child{margin-top:4px}
.wcf-admin-group b{font-family:var(--display);font-size:13px;letter-spacing:.02em}
.wcf-admin-group b.gold{color:#f5d97a}.wcf-admin-group b.red{color:var(--red-hi)}
.wcf-admin-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:2px 12px}
.wcf-admin-card .wcf-todo:first-child{border-top:0}
.wcf-admin-fold{display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 2px;background:none;border:0;border-bottom:1px solid var(--line);color:var(--white);font-size:13px;cursor:pointer}
.wcf-admin-fold span{color:var(--dim);font-size:12px;font-weight:600}
.wcf-admin-hint{font-size:12px;color:var(--dim);margin:-2px 2px 8px;line-height:1.45}
.wcf-admin-compose-card{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px 14px;border-radius:16px;background:var(--panel);border:1px solid var(--line)}
.wcf-admin-compose-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
/* compact fixture rows */
.wcf-admin-game-badge.score{background:rgba(255,255,255,.06);border-color:var(--line);color:var(--white);font-family:var(--display)}
.wcf-arow{display:grid;grid-template-columns:32px minmax(0,1fr) auto 32px;gap:10px;align-items:center;padding:9px 2px;border-bottom:1px solid var(--line)}
.wcf-arow-av{width:32px;height:32px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-weight:800;font-size:12px;color:#fff}
.wcf-arow-name{min-width:0;font-size:13.5px;font-weight:700;color:var(--white);line-height:1.3}
.wcf-arow-name small{display:block;font-size:11px;font-weight:500;color:var(--dim);margin-top:1px}
.wcf-arow-more{width:32px;height:32px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--dim);font-size:17px;line-height:1;cursor:pointer}
.wcf-st{font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:999px;white-space:nowrap}
.wcf-st.paid{color:var(--green,#86efac);background:rgba(34,197,94,.12)}.wcf-st.owe{color:var(--red-hi);background:rgba(230,57,70,.12)}
.wcf-st.says{color:#f5d97a;background:rgba(245,217,122,.14)}.wcf-st.free{color:#cbd5e1;background:rgba(255,255,255,.08)}
.wcf-admin-result-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0 10px;border-bottom:1px solid var(--line);margin-bottom:4px}
.wcf-admin-result-score{font-family:var(--display);font-weight:800;font-size:16px;color:var(--white)}
.wcf-admin-owing{margin:4px 0 4px;padding:9px 12px;border-radius:12px;font-size:12.5px;font-weight:700;color:var(--red-hi);background:rgba(230,57,70,.1);border:1px solid rgba(230,57,70,.35)}
.wcf-admin-owing.clear{color:var(--green,#86efac);background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.3)}
.wcf-admin-wl{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a;margin:14px 2px 2px}
.wcf-admin-delete-link{display:block;margin:14px auto 2px;background:none;border:0;color:var(--red-hi);font-size:12.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
/* per-player actions sheet */
.wcf-action-sheet{padding:0 16px calc(env(safe-area-inset-bottom,0px) + 14px)}
.wcf-action-head{padding:8px 2px 10px;border-bottom:1px solid var(--line)}
.wcf-action-head b{display:block;font-family:var(--display);font-size:17px;color:var(--white)}
.wcf-action-head small{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.wcf-action-opt{display:block;width:100%;text-align:left;padding:14px 4px;background:none;border:0;border-bottom:1px solid var(--line);color:var(--white);font-size:14.5px;font-weight:600;cursor:pointer}
.wcf-action-opt.danger{color:var(--red-hi)}
.wcf-action-opt.cancel{border-bottom:0;text-align:center;color:var(--dim)}
/* result entry */
.wcf-rs{position:fixed;inset:0;z-index:120;background:rgba(6,7,14,.97);overflow-y:auto;-webkit-overflow-scrolling:touch}
.wcf-rs-inner{max-width:480px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 16px) 16px calc(env(safe-area-inset-bottom,0px) + 28px)}
.wcf-rs-top{display:flex;justify-content:space-between;align-items:center;gap:10px}
.wcf-rs-top b{font-family:var(--display);font-weight:800;font-size:18px;color:var(--white)}
.wcf-rs-top button{width:40px;height:40px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--dim);font-size:16px;cursor:pointer}
.wcf-rs-steps{display:flex;gap:5px;margin:12px 0 16px}
.wcf-rs-steps i{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.15)}
.wcf-rs-steps i.on{background:#f5d97a}
.wcf-rs-board{border-radius:20px;padding:10px 14px;border:1px solid var(--line);background:radial-gradient(120% 90% at 50% 0%,rgba(34,197,94,.12),transparent 60%),#10131f}
.wcf-rs-board-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 0}
.wcf-rs-board-row+.wcf-rs-board-row{border-top:1px solid var(--line)}
.wcf-rs-team{font-family:var(--display);font-weight:800;font-size:17px;letter-spacing:.06em}
.wcf-rs-stepper{display:flex;align-items:center;gap:14px}
.wcf-rs-stepper button{width:52px;height:52px;border-radius:16px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;font-size:26px;font-weight:700;cursor:pointer}
.wcf-rs-stepper button.plus{background:rgba(255,255,255,.12)}
.wcf-rs-stepper b{min-width:48px;text-align:center;font-family:var(--display);font-weight:800;font-size:44px;font-variant-numeric:tabular-nums}
.wcf-rs-cta{display:block;width:100%;min-height:52px;margin-top:16px;border-radius:999px;border:0;background:var(--red);color:#fff;font-weight:800;font-size:15px;cursor:pointer}
.wcf-rs-cta:disabled{opacity:.6}
.wcf-rs-ghost{min-height:52px;padding:0 20px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--white);font-weight:700;font-size:14px;cursor:pointer}
.wcf-rs-ghost.wide{display:block;width:100%;margin-top:10px}
.wcf-rs-row{display:flex;gap:10px;margin-top:16px}
.wcf-rs-row .wcf-rs-cta{margin-top:0;flex:1}
.wcf-rs-teamhead{display:flex;justify-content:space-between;align-items:baseline;margin:14px 2px 8px}
.wcf-rs-teamhead b{font-family:var(--display);font-size:14px;letter-spacing:.06em}
.wcf-rs-teamhead span{font-size:12px;font-weight:800}
.wcf-rs-teamhead .ok{color:var(--green,#86efac)}.wcf-rs-teamhead .todo{color:#f5d97a}
.wcf-rs-chips{display:flex;flex-wrap:wrap;gap:8px}
.wcf-rs-chip{position:relative;display:inline-flex;align-items:center;border-radius:999px;background:var(--panel);border:1px solid var(--line)}
.wcf-rs-chip.has{border-color:rgba(134,239,172,.55);background:rgba(34,197,94,.12)}
.wcf-rs-chip.og.has{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.12)}
.wcf-rs-chip-main{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:0 13px 0 6px;background:none;border:0;color:var(--white);font-size:13px;font-weight:700;cursor:pointer}
.wcf-rs-chip-main em{font-style:normal;font-size:9.5px;font-weight:800;color:#f5d97a;border:1px solid rgba(245,217,122,.5);border-radius:4px;padding:0 4px}
.wcf-rs-chip-av{width:32px;height:32px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-weight:800;font-size:11px;color:#fff}
.wcf-rs-count{position:absolute;top:-7px;left:26px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--green2,#22c55e);color:#06200f;font-family:var(--display);font-weight:800;font-size:11px;display:grid;place-items:center}
.wcf-rs-chip.og .wcf-rs-count{background:#f5d97a}
.wcf-rs-minus{width:30px;height:30px;margin-right:6px;border-radius:50%;border:1px solid var(--line);background:rgba(0,0,0,.25);color:var(--white);font-size:16px;line-height:1;cursor:pointer}
.wcf-rs-hint{font-size:12.5px;color:var(--dim);line-height:1.5;margin:14px 2px 0}
.wcf-rs-oglink{margin-top:8px;background:none;border:0;padding:0;color:var(--dim);font-size:12.5px;font-weight:700;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.wcf-rs-og{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.45);font-size:12.5px;color:#f5d97a;font-weight:600}
.wcf-rs-og button{min-height:32px;padding:0 12px;border-radius:999px;border:0;background:#f5d97a;color:#0d0d1a;font-weight:800;font-size:12px;cursor:pointer}
.wcf-rs-summary{border-radius:20px;padding:16px 14px;text-align:center;border:1px solid rgba(245,217,122,.4);background:radial-gradient(120% 120% at 50% 0%,rgba(245,217,122,.12),transparent 60%),var(--panel)}
.wcf-rs-summary .k{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#f5d97a}
.wcf-rs-summary .sc{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:8px;font-family:var(--display);font-weight:800}
.wcf-rs-summary .sc b{font-size:44px}.wcf-rs-summary .sc b.dash{font-size:26px;color:var(--dim)}
.wcf-rs-summary .sc span{font-size:12px;letter-spacing:.08em;color:var(--dim)}
.wcf-rs-summary .who{font-size:13px;color:#cbd5e1;margin-top:10px;line-height:1.55;text-align:left}
.wcf-rs-summary .who b{color:var(--white)}
.wcf-rs-summary .ticks{display:flex;flex-direction:column;gap:6px;margin-top:12px;text-align:left}
.wcf-rs-summary .ticks div{font-size:12.5px;color:#cbd5e1;display:flex;gap:8px}
.wcf-rs-summary .ticks i{font-style:normal;color:var(--green,#86efac);font-weight:800}
/* Account: header card in the Player of the Month family */
.wcf-me{position:relative;overflow:hidden;border-radius:20px;border:1px solid rgba(245,217,122,.35);padding:16px;margin-bottom:6px;background:radial-gradient(120% 90% at 100% 0%,rgba(245,217,122,.13),transparent 55%),radial-gradient(90% 80% at 0% 100%,rgba(230,57,70,.12),transparent 60%),#111427;box-shadow:0 18px 40px -24px rgba(234,179,8,.45)}
.wcf-me-top{display:flex;align-items:center;gap:14px}
.wcf-avatar.wcf-me-avatar{width:64px;height:64px;font-size:22px;box-shadow:0 0 0 3px rgba(245,217,122,.55)}
.wcf-me-who{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:none;border:0;padding:0;text-align:left;cursor:pointer;color:inherit}
.wcf-me-name{font-family:var(--display);font-weight:800;font-size:21px;line-height:1.15;color:#fff;overflow-wrap:anywhere}
.wcf-me-who .wcf-role-badge.small{margin-left:0}
.wcf-me-record{display:block;width:100%;margin-top:14px;padding:12px 0 0;border:0;border-top:1px solid var(--line);background:none;text-align:left;cursor:pointer;color:inherit}
.wcf-me-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.wcf-me-stats span{display:flex;flex-direction:column;gap:4px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-me-stats b{font-family:var(--display);font-weight:800;font-size:22px;line-height:1;letter-spacing:0;color:var(--gold,#f5d97a);font-variant-numeric:tabular-nums}
.wcf-me-bar{display:flex;gap:2px;height:6px;border-radius:4px;overflow:hidden;margin-top:12px}
.wcf-me-bar i{display:block}
.wcf-me-bar .w{background:var(--green)}
.wcf-me-bar .d{background:#475569}
.wcf-me-bar .l{background:var(--red)}
.wcf-me-foot{display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:12px;font-weight:700;color:var(--dim);font-variant-numeric:tabular-nums}
.wcf-me-link{color:var(--gold,#f5d97a)}
.wcf-me-empty{margin:12px 0 0;padding-top:12px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
/* Account: compact inbox */
.wcf-inbox-allread{flex:none;background:none;border:0;padding:4px 0 4px 4px;color:var(--gold,#f5d97a);font-weight:700;font-size:12px;cursor:pointer}
.wcf-inbox-row{border-radius:14px;margin-bottom:8px;background:var(--panel);border:1px solid var(--line)}
.wcf-inbox-row-head{display:flex;gap:10px;width:100%;padding:11px 13px;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.wcf-inbox-row-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:4px;background:transparent}
.wcf-inbox-row.unread .wcf-inbox-row-dot{background:var(--red-hi)}
.wcf-inbox-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.wcf-inbox-row-top{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.wcf-inbox-row-from{font-weight:800;color:#f1f5f9;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-inbox-row:not(.unread) .wcf-inbox-row-from{color:var(--dim)}
.wcf-inbox-row-when{flex:none;color:#64748b;font-size:11px}
.wcf-inbox-row-body{font-size:13px;line-height:1.45;color:#cbd5e1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
.wcf-inbox-row.open .wcf-inbox-row-body{display:block;-webkit-line-clamp:unset}
.wcf-inbox-row-read{display:block;margin:0 13px 12px 31px;padding:8px 12px;border-radius:10px;background:rgba(245,217,122,.1);border:1px solid rgba(245,217,122,.4);color:var(--gold,#f5d97a);font-weight:700;font-size:12px;cursor:pointer}
.wcf-rec-more.quiet{border-style:dashed;margin-bottom:8px}
/* Account: notifications card and settings list */
.wcf-notif-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:16px;background:linear-gradient(160deg,rgba(245,217,122,.1),transparent 60%),var(--panel);border:1px solid rgba(245,217,122,.45)}
.wcf-notif-card.on{background:var(--panel);border-color:rgba(34,197,94,.3)}
.wcf-notif-ic{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(245,217,122,.14);color:var(--gold,#f5d97a)}
.wcf-notif-card.on .wcf-notif-ic{background:rgba(34,197,94,.12);color:var(--green)}
.wcf-notif-text{flex:1;min-width:0}
.wcf-notif-title{font-weight:800;font-size:13.5px;color:#f1f5f9}
.wcf-notif-sub{margin-top:3px;font-size:11.5px;line-height:1.35;color:var(--dim)}
.wcf-notif-on{flex:none;padding:9px 12px;border-radius:10px;border:0;background:var(--gold,#f5d97a);color:#0d0d1a;font-weight:800;font-size:12px;cursor:pointer}
.wcf-notif-test{display:block;margin:8px auto 0;background:none;border:0;color:var(--dim);font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.wcf-set-label{margin:18px 2px 8px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#64748b}
.wcf-set-group{border-radius:16px;overflow:hidden;margin-bottom:10px;background:var(--panel);border:1px solid var(--line)}
.wcf-set-group .wcf-acc-section{margin:0;border:0;border-radius:0;background:none}
.wcf-set-group>*+*{border-top:1px solid var(--line)!important}
.wcf-set-group .wcf-acc-section-head{min-height:52px;padding:11px 13px}
.wcf-set-group .wcf-acc-section-tile,.wcf-set-link .wcf-acc-section-tile{background:rgba(148,163,184,.1);border-color:transparent;color:#e2e8f0}
.wcf-set-group .wcf-acc-section-title{font-weight:600;font-size:13.5px}
.wcf-set-group .wcf-acc-section-meta{margin-top:3px}
.wcf-set-group .wcf-acc-section-value{font-family:var(--sans);font-weight:600;font-size:12px;color:var(--dim);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-acc-section-value.ok{color:var(--green)}
.wcf-acc-section-value.add{color:var(--gold,#f5d97a);font-weight:800}
.wcf-set-group .wcf-acc-section-chevron{font-size:18px;line-height:1;color:#64748b;transition:transform .15s}
.wcf-set-group .wcf-acc-section.open .wcf-acc-section-chevron{transform:rotate(90deg)}
.wcf-set-link{display:flex;align-items:center;gap:11px;width:100%;min-height:52px;padding:11px 13px;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.wcf-set-link.static{cursor:default}
.wcf-set-link-title{flex:1;min-width:0;font-weight:600;font-size:13.5px;color:#f1f5f9}
.wcf-set-chev{font-size:18px;color:#64748b}
.wcf-set-email{flex:none;max-width:55%;font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-season-hero-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:12px}
.wcf-season-hero-stats span{display:flex;flex-direction:column;gap:4px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#B7BDD0}
.wcf-season-hero-stats b{font-family:var(--display);font-weight:800;font-size:20px;line-height:1;letter-spacing:0;color:#fff;font-variant-numeric:tabular-nums}
/* Season: Whites v Reds rivalry */
.wcf-rivalry{border-radius:20px;padding:14px 16px 16px;margin-bottom:14px;border:1px solid var(--line);background-color:var(--panel);background-image:linear-gradient(180deg,rgba(13,13,26,.5) 0%,rgba(13,13,26,.82) 30%,rgba(13,13,26,.95) 60%,rgba(13,13,26,.98) 100%),url('/net-rain.jpg');background-size:cover;background-position:center 40%}
.wcf-rivalry-title{font-family:var(--display);font-weight:800;font-size:15px;color:#fff}
.wcf-rivalry-sub{margin-top:3px;font-size:12px;color:var(--dim)}
.wcf-rivalry-row{margin-top:14px}
.wcf-rivalry-bar{display:flex;gap:3px;height:12px;border-radius:6px;overflow:hidden;margin-top:6px}
.wcf-rivalry-bar i{display:block}
.wcf-rivalry .w{background:var(--wc)}
.wcf-rivalry .r{background:var(--rc)}
.wcf-rivalry .d{background:#475569}
.wcf-rivalry-k{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-rivalry-scores{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:8px}
.wcf-rivalry-score{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 2px 7px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.03);box-shadow:inset 0 3px 0 #475569;cursor:pointer;color:inherit}
.wcf-rivalry-score b{font-family:var(--display);font-size:14px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap}
.wcf-rivalry-score span{font-size:9.5px;font-weight:600;color:var(--dim);white-space:nowrap}
.wcf-rivalry-score.w{background:rgba(255,255,255,.03);box-shadow:inset 0 3px 0 var(--wc);border-color:color-mix(in srgb,var(--wc) 50%,transparent)}
.wcf-rivalry-score.r{background:rgba(255,255,255,.03);box-shadow:inset 0 3px 0 var(--rc);border-color:color-mix(in srgb,var(--rc) 50%,transparent)}
.wcf-rivalry-score.d{background:rgba(255,255,255,.03)}
.wcf-rivalry-score.latest{background:rgba(245,217,122,.08)}
.wcf-rivalry-key{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px;font-size:11px;color:var(--dim)}
.wcf-rivalry-key i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.wcf-h2h-table{margin-top:12px}
.wcf-h2h-table .wcf-h2h-row{grid-template-columns:minmax(0,1fr) repeat(7,26px)}
.wcf-h2h-table .wcf-h2h-header span:first-child{text-align:left}
.wcf-rivalry-cap{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
/* MOTM: vote prompt on Fixtures */
.wcf-vote-prompt{display:flex;align-items:center;gap:12px;width:100%;margin-bottom:14px;padding:14px;border-radius:18px;border:1px solid rgba(245,217,122,.5);background:radial-gradient(100% 90% at 100% 0%,rgba(245,217,122,.16),transparent 60%),#111427;text-align:left;cursor:pointer;color:inherit;box-shadow:0 16px 36px -24px rgba(234,179,8,.6)}
.wcf-vote-prompt-ic{flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(245,217,122,.15);color:#f5d97a}
.wcf-vote-prompt-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.wcf-vote-prompt-k{font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a}
.wcf-vote-prompt-t{font-family:var(--display);font-weight:800;font-size:16px;color:#fff}
.wcf-vote-prompt-s{font-size:11.5px;color:var(--dim)}
.wcf-vote-prompt-btn{flex:none;padding:9px 14px;border-radius:10px;background:#f5d97a;color:#0d0d1a;font-weight:800;font-size:12.5px}
.wcf-vote-prompt.done{padding:11px 14px;box-shadow:none;border-color:rgba(245,217,122,.35);background:rgba(245,217,122,.06)}
.wcf-vote-prompt.done .wcf-vote-prompt-text{display:block;font-size:12.5px;color:var(--dim)}
.wcf-vote-prompt.done b{color:#f5d97a}
.wcf-vote-prompt-chev{flex:none;font-size:18px;color:var(--dim)}
.wcf-ft-vote{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;margin-top:10px;padding:10px 12px;border-radius:12px;border:1px solid rgba(245,217,122,.5);background:rgba(245,217,122,.1);color:#f5d97a;font-weight:800;font-size:12.5px;cursor:pointer;text-align:left}
.wcf-ft-vote span{font-weight:600;font-size:11px;color:var(--dim)}
/* MOTM: voting in the Scores card */
.wcf-result-goals-head{display:flex;align-items:center;gap:6px;margin:12px 0 6px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-result-goals-head b{margin-left:auto;font-family:var(--display);font-size:17px;letter-spacing:0;color:#fff}
.wcf-vote-note{margin-top:12px;padding:11px 13px;border-radius:12px;background:rgba(13,13,26,.55);border:1px solid var(--line);font-size:12.5px;color:var(--dim)}
.wcf-vote-note b{color:#fff}
.wcf-vote{margin-top:14px;border-radius:18px;overflow:hidden;border:1px solid rgba(245,217,122,.35);background:rgba(13,15,30,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.wcf-vote-head{padding:12px 14px 10px;text-align:center;border-bottom:1px solid var(--line);background:radial-gradient(90% 120% at 50% 0%,rgba(245,217,122,.14),transparent 70%)}
.wcf-vote-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a}
.wcf-vote-meta{margin-top:4px;font-size:11.5px;color:var(--dim)}
.wcf-vote-meta b{color:#fff}
.wcf-vote-teams{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;padding:10px}
.wcf-vote-col.wide{grid-column:1/-1}
.wcf-vote-col-h{display:flex;align-items:center;gap:6px;margin:0 4px 6px;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-vote-pick{display:flex;align-items:center;gap:8px;width:100%;margin-bottom:4px;padding:6px;border-radius:12px;border:1px solid transparent;background:none;text-align:left;cursor:pointer;color:inherit}
.wcf-vote-pick:not(:disabled):hover{background:rgba(255,255,255,.05)}
.wcf-vote-av{width:32px;height:32px;font-size:12px;flex:none;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;color:#fff;}
.wcf-vote-who{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.wcf-vote-name{font-size:12.5px;font-weight:600;color:#f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-vote-goals{font-size:10.5px;color:var(--dim)}
.wcf-vote-tick{flex:none;color:#f5d97a;font-weight:800}
.wcf-vote-pick.picked{border-color:rgba(245,217,122,.6);background:rgba(245,217,122,.1)}
.wcf-vote-pick.picked .wcf-vote-av{box-shadow:0 0 0 2px #eab308}
.wcf-vote-pick.picked .wcf-vote-name{color:#f5d97a;font-weight:800}
.wcf-vote-pick.me{opacity:.45;cursor:default}
.wcf-vote-foot{padding:10px 14px 12px;border-top:1px solid var(--line);font-size:12px;line-height:1.45;color:var(--dim);text-align:center}
.wcf-vote-foot b{color:#f5d97a}
/* MOTM: the result */
.wcf-motm-card{margin-top:14px;border-radius:18px;padding:14px;border:1px solid rgba(234,179,8,.5);background:radial-gradient(100% 80% at 30% 100%,rgba(234,179,8,.18),transparent 60%),rgba(13,13,26,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.wcf-motm-card-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a}
.wcf-motm-card-main{display:flex;align-items:center;gap:12px;margin-top:10px}
.wcf-motm-card-faces{display:flex;flex:none}
.wcf-motm-card-face{width:54px;height:54px;font-size:20px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;color:#fff;box-shadow:0 0 0 3px #eab308,0 0 18px rgba(234,179,8,.45)}
.wcf-motm-card-face+.wcf-motm-card-face{margin-left:-12px}
.wcf-motm-card-who{min-width:0}
.wcf-motm-card-names{display:flex;flex-wrap:wrap;gap:0 6px}
.wcf-motm-card-name{background:none;border:0;padding:0;font-family:var(--display);font-weight:800;font-size:20px;line-height:1.2;color:#fff;cursor:pointer;text-align:left}
.wcf-motm-card-amp{color:var(--dim)}
.wcf-motm-card-sub{margin-top:3px;font-size:12px;color:var(--dim)}
.wcf-motm-card-sub b{color:#f5d97a}
.wcf-motm-rank{display:flex;flex-direction:column;margin-top:12px;padding-top:8px;border-top:1px solid rgba(234,179,8,.22)}
.wcf-motm-rk{display:flex;align-items:center;gap:10px;width:100%;padding:7px 0;background:none;border:0;text-align:left;cursor:pointer;color:inherit}
.wcf-motm-rk-av{width:28px;height:28px;font-size:11px;flex:none;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-family:var(--display);font-weight:800;color:#fff;}
.wcf-motm-rk-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.wcf-motm-rk-name{font-size:12.5px;font-weight:700;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-motm-rk.top .wcf-motm-rk-name{color:#f5d97a}
.wcf-motm-rk-bar{display:block;height:5px;border-radius:3px;background:rgba(148,163,184,.15);overflow:hidden}
.wcf-motm-rk-bar i{display:block;height:100%;border-radius:3px;background:#64748b}
.wcf-motm-rk.top .wcf-motm-rk-bar i{background:#eab308}
.wcf-motm-rk-voters{flex:none}
.wcf-motm-rk-n{flex:none;min-width:16px;text-align:right;font-family:var(--display);font-weight:800;font-size:15px;color:#fff;font-variant-numeric:tabular-nums}
.wcf-motm-rk.top .wcf-motm-rk-n{color:#f5d97a}
.wcf-motm-card-tip{margin-top:4px;font-size:11px;color:#64748b;text-align:center}
.wcf-pot-hero{border-radius:20px;padding:16px;margin-bottom:12px;border:1px solid rgba(34,197,94,.35);background:radial-gradient(100% 80% at 50% 0%,rgba(34,197,94,.14),transparent 60%),#0f1a1a}
.wcf-pot-hero-k{font-size:10.5px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.wcf-pot-hero-amt{font-family:var(--display);font-weight:800;font-size:44px;line-height:1.05;margin-top:4px;color:#22c55e;font-variant-numeric:tabular-nums}
.wcf-pot-hero-amt.negative{color:var(--red-hi)}
.wcf-pot-hero-sub{margin-top:4px;font-size:12.5px;color:var(--dim)}
.wcf-pot-hero-sub b{color:#fff}
.wcf-pot-hero-spark{display:block;width:100%;height:70px;margin-top:10px}
.wcf-pot-hero-axis{display:flex;justify-content:space-between;font-size:10px;color:#64748b}
.wcf-pot-card{border-radius:16px;padding:12px 14px;margin-bottom:10px;background:var(--panel);border:1px solid var(--line)}
.wcf-pot-card-h{display:flex;justify-content:space-between;margin-bottom:8px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-pot-card-h span{color:var(--green);letter-spacing:.04em}
.wcf-pot-split{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.wcf-pot-split span{display:flex;flex-direction:column;gap:3px;font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-pot-split b{font-family:var(--display);font-size:18px;letter-spacing:0;color:#fff;font-variant-numeric:tabular-nums}
.wcf-pot-split b.in{color:#22c55e}
.wcf-pot-split b.out{color:var(--red-hi)}
.wcf-pot-led{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;font-size:12.5px;color:#e2e8f0}
.wcf-pot-led+.wcf-pot-led{border-top:1px solid var(--line)}
.wcf-pot-led-sub{margin-top:1px;font-size:11px;color:var(--dim)}
.wcf-pot-led>span{flex:none;font-family:var(--display);font-weight:800;color:#22c55e;font-variant-numeric:tabular-nums}
.wcf-pot-led>span.out{color:var(--red-hi)}
.wcf-pot-empty{margin:0;font-size:12.5px;line-height:1.5;color:var(--dim)}
.gaffai-sugg-toggle{display:inline-flex; align-items:center; gap:8px; margin-top:12px; padding:8px 12px; border-radius:12px; border:1px solid var(--line); background:var(--panel); color:#e2e8f0; font-weight:700; font-size:12.5px; cursor:pointer}
.gaffai-sugg-toggle span{font-size:16px; line-height:1; color:#f5d97a; transition:transform .15s}
.gaffai-sugg-toggle.open span{transform:rotate(90deg)}
.wcf-teams-hero{border-radius:20px;padding:14px 16px;margin-bottom:12px;border:1px solid rgba(245,217,122,.4);background:radial-gradient(100% 90% at 100% 0%,rgba(245,217,122,.14),transparent 60%),#111427}
.wcf-teams-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#f5d97a}
.wcf-teams-t{margin-top:6px;font-family:var(--display);font-weight:800;font-size:17px;color:#fff}
.wcf-teams-s{margin-top:3px;font-size:12px;line-height:1.45;color:var(--dim)}
.wcf-teams-top{display:flex;align-items:center;gap:14px;margin-top:8px}
.wcf-teams-top .wcf-teams-t{margin-top:0}
.wcf-teams-ring{flex:none;width:70px;height:70px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(#eab308 0 var(--pct),rgba(148,163,184,.18) var(--pct) 100%)}
.wcf-teams-ring div{width:56px;height:56px;border-radius:50%;background:#111427;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:17px;color:#fff;font-variant-numeric:tabular-nums}
.wcf-teams-acts{display:flex;gap:8px;margin-top:12px}
.wcf-teams-go{flex:1;margin-top:12px;min-height:44px;padding:10px 14px;border:0;border-radius:12px;background:var(--red);color:#fff;font-weight:800;font-size:13.5px;cursor:pointer}
.wcf-teams-acts .wcf-teams-go{margin-top:0}
.wcf-teams-ghost{flex:none;min-height:44px;padding:10px 13px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:#e2e8f0;font-weight:700;font-size:13px;cursor:pointer}
.wcf-teams-ghost.wide{flex:1}
.wcf-teams-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:10px}
.wcf-teams-col{border-radius:16px;padding:10px;background:var(--panel);border:1px solid var(--line);box-shadow:inset 0 3px 0 var(--team)}
.wcf-teams-col-h{display:flex;justify-content:space-between;margin:2px 2px 8px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.wcf-teams-pl{display:flex;align-items:center;gap:7px;padding:4px 2px;font-size:12px;font-weight:600;color:#f1f5f9;min-width:0}
.wcf-teams-av{flex:none;width:24px;height:24px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-size:9.5px;font-weight:800;color:#fff}
.wcf-teams-nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-teams-pos{margin-left:auto;flex:none;font-size:9px;font-weight:800;letter-spacing:.06em;color:#64748b}
.wcf-teams-pos.gk{color:#f5d97a}
.wcf-teams-card{border-radius:16px;padding:12px 14px;margin-bottom:10px;background:var(--panel);border:1px solid var(--line)}
.wcf-teams-card-h{display:flex;justify-content:space-between;margin-bottom:10px;font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.wcf-teams-card-h span{letter-spacing:.04em}
.wcf-teams-cmp{margin-bottom:10px}
.wcf-teams-cmp-l{display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#f1f5f9;font-variant-numeric:tabular-nums}
.wcf-teams-cmp-l span:nth-child(2){font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-teams-bar{display:flex;gap:3px;height:8px;border-radius:5px;overflow:hidden;margin-top:5px}
.wcf-teams-bar i{display:block}
.wcf-teams-bar .w{background:var(--wc)}
.wcf-teams-bar .r{background:var(--rc)}
.wcf-teams-rated{font-size:11px;color:var(--dim)}
.wcf-teams-row{display:flex;justify-content:space-between;align-items:center;width:100%;margin:4px 0 10px;min-height:46px;padding:10px 14px;border-radius:14px;background:var(--panel);border:1px solid var(--line);color:#f1f5f9;font-weight:700;font-size:13px;cursor:pointer;text-align:left}
.wcf-teams-row span{font-weight:600;font-size:12px;color:var(--dim)}
.wcf-teams-row b{display:inline-block;margin-left:4px;color:#64748b;font-size:16px;transition:transform .15s}
.wcf-teams-row b.open{transform:rotate(90deg)}
.wcf-teams-hist-s{font-size:12px;color:var(--dim);line-height:1.4}
.wcf-teams-hist{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.wcf-teams-hist i{font-style:normal;font-size:11px;font-weight:800;padding:4px 7px;border-radius:7px;background:rgba(148,163,184,.1);color:#e2e8f0;font-variant-numeric:tabular-nums}
.wcf-teams-hist i.ok{background:rgba(134,239,172,.12);color:var(--green)}
.wcf-teams-hist i.big{background:rgba(230,57,70,.16);color:var(--red-hi)}
.wcf-teams-hist i.gen{box-shadow:inset 0 0 0 1px rgba(245,217,122,.6)}
.wcf-callout{position:relative;overflow:hidden;display:grid;grid-template-columns:34px minmax(0,1fr);gap:11px;align-items:start;margin-bottom:8px;padding:11px 12px;border-radius:14px;background:var(--panel);border:1px solid var(--line)}
.wcf-callout::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--tone)}
.wcf-callout.gold{--tone:#f5d97a}
.wcf-callout.red{--tone:#f0525e}
.wcf-callout.green{--tone:#86efac}
.wcf-callout-ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:var(--tone);background:color-mix(in srgb,var(--tone) 15%,transparent)}
.wcf-callout-t{font-weight:800;font-size:13px;color:#fff}
.wcf-callout-b{margin-top:2px;font-size:12.5px;line-height:1.45;color:#cbd5e1;font-variant-numeric:tabular-nums}
.wcf-callout-b b{color:#fff}
.gaffai-done{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:800;color:#86efac;background:rgba(134,239,172,.1);border:1px solid rgba(134,239,172,.35)}
.wcf-roles-stats .wcf-roles-stat{background:var(--panel);border:1px solid var(--line)}
.wcf-roles-tools{display:flex;gap:8px;margin-top:10px}
.wcf-roles-tool{flex:1;min-height:42px;padding:9px 10px;border-radius:12px;background:var(--panel);border:1px solid var(--line);color:#e2e8f0;font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-roles-tool.on{border-color:rgba(245,217,122,.55);color:#f5d97a}
.wcf-roles-search-wrap{display:flex;align-items:center;gap:8px;margin:12px 0 0;padding:0 12px;border-radius:12px;background:#0b0d1a;border:1px solid var(--line);color:#64748b}
.wcf-roles-search-wrap .wcf-roles-search{margin:0;border:0;background:none;padding:12px 0;min-height:44px;font-size:13px}
.wcf-roles-search-wrap .wcf-roles-search:focus{outline:none}
.wcf-roles-list{margin-top:10px;border-radius:16px;overflow:hidden;background:var(--panel);border:1px solid var(--line)}
.wcf-roles-list .wcf-roles-row{margin:0;border:0;border-radius:0;background:none;padding:9px 12px}
.wcf-roles-list .wcf-roles-row+.wcf-roles-row{border-top:1px solid var(--line)}
.wcf-roles-list .wcf-roles-row.open{background:rgba(245,217,122,.04)}
.wcf-roles-list .wcf-roles-avatar{background:linear-gradient(135deg,#7fb0ec,#8b6be8);width:32px;height:32px}
.wcf-roles-who{flex:1;min-width:0}
.wcf-roles-name{font-size:13px;font-weight:700;color:#f1f5f9;overflow-wrap:anywhere}
.wcf-roles-name .wcf-role-badge.small{margin-left:6px;vertical-align:1px}
.wcf-roles-sub{margin-top:1px;font-size:11px;color:var(--dim)}
.wcf-roles-more{flex:none;width:34px;height:34px;border-radius:10px;border:0;background:rgba(148,163,184,.08);color:var(--dim);font-weight:800;font-size:15px;letter-spacing:1px;cursor:pointer}
.wcf-roles-menu{display:flex;flex-direction:column;margin-top:8px;border-radius:12px;background:#131624;border:1px solid var(--line);overflow:hidden}
.wcf-roles-menu button{display:block;width:100%;padding:11px 12px;background:none;border:0;text-align:left;color:#e2e8f0;font-weight:600;font-size:13px;cursor:pointer}
.wcf-roles-menu button+button{border-top:1px solid var(--line)}
.wcf-roles-menu button small{display:block;margin-top:2px;font-weight:500;font-size:11.5px;color:var(--dim)}
.wcf-roles-menu button.danger{color:var(--red-hi)}
.wcf-lineup-count{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:12px 0 8px;padding:12px 14px;border-radius:16px;background:var(--panel);border:1px solid var(--line);font-size:12.5px;color:var(--dim)}
.wcf-lineup-count b{font-family:var(--display);font-size:18px;color:#fff;font-variant-numeric:tabular-nums}
.wcf-lineup-count .todo{color:#f5d97a;font-weight:800}
.wcf-lineup-count .done{color:var(--green);font-weight:800}
.wcf-lineup-gen{display:block;width:100%;margin-bottom:12px;min-height:42px;padding:10px;border-radius:12px;background:var(--panel);border:1px solid var(--line);color:#e2e8f0;font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-lineup-group.todo .wcf-lineup-row{background:rgba(245,217,122,.06);border-color:rgba(245,217,122,.3)}
.wcf-lineup-av{flex:none;width:28px;height:28px;border-radius:50%;object-fit:cover;display:grid;place-items:center;font-size:10.5px;font-weight:800;color:#fff}
.wcf-ec{margin-top:12px;border-radius:14px;background:var(--panel);border:1px solid var(--line);overflow:hidden}
.wcf-ec-head{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:46px;padding:10px 13px;background:none;border:0;color:#f1f5f9;font-weight:700;font-size:13px;cursor:pointer;text-align:left}
.wcf-ec-count{font-weight:600;font-size:12px;color:var(--dim)}
.wcf-ec-count b{display:inline-block;margin-left:4px;color:#64748b;font-size:16px;transition:transform .15s}
.wcf-ec-count b.open{transform:rotate(90deg)}
.wcf-ec-list{border-top:1px solid var(--line)}
.wcf-ec-row{display:flex;align-items:center;gap:10px;padding:9px 13px}
.wcf-ec-row+.wcf-ec-row{border-top:1px solid var(--line)}
.wcf-ec-who{flex:1;min-width:0}
.wcf-ec-name{font-size:13px;font-weight:700;color:#f1f5f9}
.wcf-ec-sub{margin-top:1px;font-size:11.5px;color:var(--dim)}
.wcf-ec-call{flex:none;padding:7px 10px;border-radius:10px;background:rgba(134,239,172,.1);border:1px solid rgba(134,239,172,.35);color:var(--green);font-weight:800;font-size:12px;text-decoration:none;font-variant-numeric:tabular-nums}
.wcf-ec-none{flex:none;font-size:11.5px;font-weight:700;color:#64748b}
.wcf-privacy-note a{color:#f5d97a;font-weight:700;text-decoration:none}
a.wcf-set-link{text-decoration:none}
.wcf-toast.has-undo{display:flex;align-items:center;gap:12px}
.wcf-toast-undo{flex:none;margin-left:auto;padding:6px 14px;border-radius:9px;border:0;background:#04140a;color:#86efac;font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-confirm-all{margin-left:auto;padding:6px 11px;border-radius:9px;border:0;background:#f5d97a;color:#0d0d1a;font-weight:800;font-size:12px;cursor:pointer}
@keyframes wcfSpecialGlow{0%,100%{box-shadow:0 0 0 1px rgba(245,217,122,.55),0 0 22px 2px rgba(234,179,8,.35),0 0 60px 6px rgba(234,179,8,.18)}50%{box-shadow:0 0 0 1px rgba(245,217,122,.9),0 0 30px 5px rgba(234,179,8,.55),0 0 80px 12px rgba(234,179,8,.25)}}
@keyframes wcfSpecialSheen{0%{transform:translateX(-120%) skewX(-18deg)}60%,100%{transform:translateX(260%) skewX(-18deg)}}
.wcf-fx-row.special,.wcf-card.featured.special{position:relative;overflow:hidden;border-color:transparent!important;background:radial-gradient(120% 90% at 100% 0%,rgba(245,217,122,.22),transparent 55%),radial-gradient(90% 90% at 0% 100%,rgba(184,134,11,.25),transparent 60%),linear-gradient(160deg,#221b08,#120f07 60%,#0e0c08)!important;animation:wcfSpecialGlow 3.2s ease-in-out infinite}
.wcf-fx-row.special{margin-top:6px;margin-bottom:14px}
.wcf-fx-row.special::after,.wcf-card.featured.special::after{content:"";position:absolute;top:0;bottom:0;left:0;width:38%;background:linear-gradient(90deg,transparent,rgba(255,240,190,.16),transparent);animation:wcfSpecialSheen 4.5s ease-in-out infinite;pointer-events:none}
.wcf-special-ribbon{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px;margin:0 0 8px;padding:4px 9px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#1a1405;background:linear-gradient(90deg,#f5d97a,#eab308)}
.wcf-card.featured.special .wcf-special-ribbon{margin:0 0 10px}
.special .wcf-fx-title,.special .wcf-hero-time{color:#fff3c4}
.special .wcf-fx-meta,.special .wcf-fx-day{color:#d6c38a}
.special .wcf-fx-num{color:#fff3c4}
.special .wcf-fx-bar-track{background:rgba(245,217,122,.15)}
.special .wcf-fx-bar-fill{background:linear-gradient(90deg,#eab308,#f5d97a)!important}
.wcf-fx-pill.gold{color:#1a1405;background:#f5d97a;border:0}
.special .wcf-status-pill{color:#1a1405!important;background:#f5d97a!important;border-color:#f5d97a!important}
.special .wcf-card-actions button:not(.wcf-ghost),.special .wcf-book-btn{background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308)!important;color:#1a1405!important;border-color:transparent!important}
.wcf-special-switch{display:flex!important;flex-direction:row!important;align-items:center;gap:9px;padding:10px 12px;border-radius:12px;background:rgba(245,217,122,.08);border:1px solid rgba(245,217,122,.35);color:#f5d97a;font-weight:700;font-size:12px;line-height:1.4}
.wcf-special-switch input{width:18px;height:18px;accent-color:#eab308;flex:none}
@media (prefers-reduced-motion:reduce){.wcf-fx-row.special,.wcf-card.featured.special,.wcf-fx-row.special::after,.wcf-card.featured.special::after{animation:none}}
.wcf-fxs-overlay{position:fixed;inset:0;z-index:120;background:rgba(3,4,8,.62);display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.wcf-fxs{width:100%;max-width:520px;max-height:94vh;overflow-y:auto;background:#131624;border-radius:24px 24px 0 0;border:1px solid var(--line);border-bottom:0;padding-bottom:env(safe-area-inset-bottom,0px);animation:wcfPcardIn .2s ease-out}
.wcf-fxs-photo{position:relative;height:150px;margin-bottom:-42px;background:linear-gradient(180deg,rgba(19,22,36,.1) 0%,rgba(19,22,36,.55) 55%,#131624 100%),url('/pitch-floodlit.jpg') center 60%/cover}
.wcf-fxs-photo.gold{background:linear-gradient(180deg,rgba(60,45,5,.25) 0%,rgba(40,30,5,.6) 55%,#131624 100%),url('/pitch-floodlit.jpg') center 60%/cover}
.wcf-fxs-handle{position:absolute;top:10px;left:50%;width:38px;height:4px;margin-left:-19px;border-radius:4px;background:rgba(255,255,255,.45)}
.wcf-fxs-x{position:absolute;top:16px;right:14px;width:34px;height:34px;border-radius:50%;border:0;background:rgba(13,13,26,.55);color:#fff;font-size:14px;cursor:pointer}
.wcf-fxs-title{position:absolute;left:16px;right:60px;bottom:52px}
.wcf-fxs-title b{display:block;font-family:var(--display);font-size:22px;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.6)}
.wcf-fxs-photo.gold .wcf-fxs-title b{color:#fff3c4}
.wcf-fxs-title span{display:block;margin-top:2px;font-size:12px;color:#d7dde8;text-shadow:0 1px 6px rgba(0,0,0,.7)}
.wcf-fxs-body{position:relative;display:flex;flex-direction:column;gap:14px;padding:0 16px 14px}
.wcf-fxs-seg{display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:12px;background:#0b0d1a;border:1px solid var(--line)}
.wcf-fxs-seg button{padding:9px;border:0;border-radius:9px;background:none;color:var(--dim);font-weight:700;font-size:13px;cursor:pointer}
.wcf-fxs-seg button.on{background:#1b2136;color:#fff}
.wcf-fxs-lab{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:11px;font-weight:700;color:var(--dim)}
.wcf-fxs-lab button{background:none;border:0;padding:0;color:#f5d97a;font-weight:700;font-size:11.5px;cursor:pointer}
.wcf-fxs-days{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.wcf-fxs-days::-webkit-scrollbar{display:none}
.wcf-fxs-day{flex:none;width:50px;padding:7px 0 8px;border-radius:12px;background:var(--panel);border:1px solid var(--line);color:#f1f5f9;text-align:center;cursor:pointer}
.wcf-fxs-day small{display:block;font-size:10px;font-weight:700;letter-spacing:.04em;color:var(--dim)}
.wcf-fxs-day b{display:block;margin-top:2px;font-family:var(--display);font-size:18px}
.wcf-fxs-day i{display:block;width:5px;height:5px;margin:4px auto 0;border-radius:50%}
.wcf-fxs-day.has i{background:var(--dim)}
.wcf-fxs-day.on{border-color:#f5d97a;background:rgba(245,217,122,.1)}
.wcf-fxs-day.on b{color:#f5d97a}
.wcf-fxs-hint{margin-top:7px;font-size:11.5px;color:var(--dim)}
.wcf-fxs-chips{display:flex;flex-wrap:wrap;gap:7px}
.wcf-fxs-chips button,.wcf-fxs-wd button{padding:8px 12px;border-radius:11px;background:var(--panel);border:1px solid var(--line);color:#e2e8f0;font-weight:700;font-size:13px;cursor:pointer}
.wcf-fxs-chips button.on,.wcf-fxs-wd button.on{background:rgba(245,217,122,.12);border-color:rgba(245,217,122,.6);color:#f5d97a}
.wcf-fxs-chips button.add{color:var(--dim);border-style:dashed}
.wcf-fxs-wd{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.wcf-fxs-wd button{padding:8px 0;font-size:12px}
.wcf-fxs-input{width:100%;box-sizing:border-box;margin-top:8px;min-height:44px;padding:10px 12px;border-radius:12px;background:#0b0d1a;border:1px solid rgba(148,163,184,.2);color:#fff;font-size:14px}
.wcf-fxs-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wcf-fxs-step{display:flex;align-items:center;justify-content:space-between;padding:5px;border-radius:12px;background:var(--panel);border:1px solid var(--line)}
.wcf-fxs-step button{width:36px;height:36px;border:0;border-radius:9px;background:rgba(148,163,184,.1);color:#e2e8f0;font-weight:800;font-size:17px;cursor:pointer}
.wcf-fxs-step b{font-family:var(--display);font-size:17px;color:#fff;font-variant-numeric:tabular-nums}
.wcf-fxs-special{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;border-radius:14px;background:linear-gradient(90deg,rgba(245,217,122,.1),rgba(245,217,122,.02));border:1px solid rgba(245,217,122,.35);text-align:left;cursor:pointer}
.wcf-fxs-special b{display:block;font-size:13.5px;color:#f5d97a}
.wcf-fxs-special small{display:block;margin-top:2px;font-size:11.5px;color:var(--dim)}
.wcf-fxs-special i{margin-left:auto;flex:none;position:relative;width:46px;height:28px;border-radius:999px;background:rgba(148,163,184,.25);transition:background .15s}
.wcf-fxs-special i::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:transform .15s}
.wcf-fxs-special.on i{background:#eab308}
.wcf-fxs-special.on i::after{transform:translateX(18px)}
.wcf-fxs-more{display:flex;justify-content:space-between;width:100%;padding:10px 12px;border-radius:12px;border:1px dashed var(--line);background:none;color:var(--dim);font-weight:700;font-size:12.5px;cursor:pointer}
.wcf-fxs-preview{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:15px;background:linear-gradient(180deg,rgba(30,41,59,.9),rgba(19,22,38,.98));border:1px solid var(--line)}
.wcf-fxs-preview.special{background:linear-gradient(160deg,#221b08,#120f07);border-color:rgba(245,217,122,.6);box-shadow:0 0 20px rgba(234,179,8,.3)}
.wcf-fxs-pdate{width:38px;flex:none;text-align:center;line-height:1}
.wcf-fxs-pdate small{display:block;font-family:var(--mono);font-size:9.5px;color:var(--dim)}
.wcf-fxs-pdate b{display:block;margin-top:3px;font-family:var(--display);font-size:20px;color:#fff}
.wcf-fxs-pdiv{width:1px;align-self:stretch;background:var(--line)}
.wcf-fxs-pinfo{min-width:0}
.wcf-fxs-pinfo div{font-weight:700;font-size:13.5px;color:#f1f5f9}
.wcf-fxs-preview.special .wcf-fxs-pinfo div{color:#fff3c4}
.wcf-fxs-pinfo small{display:block;margin-top:2px;font-size:11.5px;color:var(--dim)}
.wcf-fxs-draft{margin-left:auto;flex:none;padding:3px 7px;border-radius:6px;border:1px solid var(--line);font-size:9.5px;font-weight:800;letter-spacing:.1em;color:var(--dim)}
.wcf-fxs-sum{padding:10px 12px;border-radius:12px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);font-size:12.5px;line-height:1.45;color:#e2e8f0}
.wcf-fxs-sum.none{background:var(--panel);border-color:var(--line);color:var(--dim)}
.wcf-fxs-sum b{color:#fff}
.wcf-fxs-foot{position:sticky;bottom:0;display:flex;gap:8px;padding:12px 16px 14px;background:#131624;border-top:1px solid var(--line)}
.wcf-fxs-btn{flex:1;min-height:46px;padding:12px;border-radius:12px;font-weight:800;font-size:13.5px;cursor:pointer}
.wcf-fxs-btn.g{background:var(--panel);border:1px solid var(--line);color:#e2e8f0}
.wcf-fxs-btn.p{background:var(--red);border:0;color:#fff}
.wcf-fxs-btn:disabled{opacity:.45;cursor:not-allowed}
.wcf-fxs-del{display:block;width:100%;padding:4px 0 16px;background:#131624;border:0;color:var(--red-hi);font-weight:700;font-size:12.5px;cursor:pointer}
@keyframes wcfRateUp{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}
/* Man of the Match: medal drop on your vote, the result reveal, the winner's moment */
.wcf-vote-pick{position:relative}
.wcf-vote-medal{position:absolute;right:26px;top:-8px;width:20px;height:43px;transform-origin:10px 0;pointer-events:none;animation:wcfMedalSwing 1.5s cubic-bezier(.3,0,.3,1) both}
.wcf-vote-medal svg,.wcf-won-medal svg{display:block;width:100%;height:100%;overflow:visible}
@keyframes wcfMedalSwing{0%{transform:translateY(-70px);opacity:0}12%{opacity:1}25%{transform:translateY(0) rotate(16deg)}45%{transform:rotate(-10deg)}62%{transform:rotate(5deg)}80%{transform:rotate(-2deg)}100%{transform:none}}
.wcf-motm-card-faces{position:relative}
.wcf-mr-mystery{background:radial-gradient(circle at 50% 35%,#3a3550,#1a1830);color:#f5d97a;font-size:22px}
.wcf-mr-drumming{cursor:pointer}
.wcf-mr-again{background:none;border:0;padding:0;font:inherit;font-weight:700;color:#f5d97a;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.wcf-mr-wait{display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:800;font-size:15px;color:var(--dim)}
.wcf-mr-drum{display:inline-flex;gap:4px}
.wcf-mr-drum i{width:5px;height:5px;border-radius:50%;background:#f5d97a;animation:wcfMrDrum .5s ease-in-out infinite}
.wcf-mr-drum i:nth-child(2){animation-delay:.12s}.wcf-mr-drum i:nth-child(3){animation-delay:.24s}
@keyframes wcfMrDrum{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
.wcf-mr-reveal .wcf-motm-card-face{animation:wcfMrFlip .6s cubic-bezier(.5,0,.2,1) both}
@keyframes wcfMrFlip{from{transform:perspective(300px) rotateY(90deg)}to{transform:none}}
.wcf-mr-rays{position:absolute;left:27px;top:27px;width:0;height:0;pointer-events:none;z-index:1}
.wcf-mr-rays i{position:absolute;left:-1px;top:-6px;width:2px;height:12px;border-radius:2px;background:#f5d97a;opacity:0;animation:wcfMrRay .7s .3s ease-out both}
@keyframes wcfMrRay{0%{opacity:0;transform:rotate(var(--a)) translateY(-24px)}30%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateY(-44px)}}
.wcf-mr-reveal .wcf-motm-card-names{animation:wcfRvIn .4s .35s both}
.wcf-mr-reveal .wcf-motm-card-sub{animation:wcfRvIn .4s .5s both}
.wcf-mr-reveal .wcf-motm-rk{animation:wcfRvIn .3s both;animation-delay:calc(.7s + var(--i,0) * .1s)}
.wcf-mr-reveal .wcf-motm-rk-bar i{transform-origin:left;animation:wcfBarGrow .6s cubic-bezier(.3,.8,.3,1) both;animation-delay:calc(.8s + var(--i,0) * .1s)}
.wcf-mr-reveal .wcf-motm-card-tip{animation:wcfRvIn .3s 1.2s both}
.wcf-won{position:fixed;inset:0;z-index:140;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;background:radial-gradient(90% 60% at 50% 30%,rgba(234,179,8,.25),rgba(8,8,16,.96) 70%);animation:wcfWonIn .3s both}
@keyframes wcfWonIn{from{opacity:0}to{opacity:1}}
.wcf-won-medal{display:block;width:92px;height:197px;transform-origin:46px 0;animation:wcfMedalSwing 1.6s cubic-bezier(.3,0,.3,1) both}
.wcf-won-k{margin-top:14px;font-size:11px;font-weight:800;letter-spacing:.2em;color:#f5d97a;animation:wcfRvIn .4s 1s both}
.wcf-won-h{margin-top:8px;font-family:var(--display);font-weight:800;font-size:30px;line-height:1.05;color:#fff;max-width:300px;text-wrap:balance;animation:wcfRvIn .4s 1.15s both}
.wcf-won-p{margin:10px 0 0;font-size:14px;line-height:1.5;color:var(--dim);animation:wcfRvIn .4s 1.3s both}
.wcf-won-p b{color:#fff}
.wcf-won-btn{margin-top:22px;border:0;border-radius:14px;padding:13px 22px;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);color:#1a1405;font-weight:800;font-size:14px;cursor:pointer;animation:wcfRvIn .4s 1.5s both}
.wcf-won-close{margin-top:10px;background:none;border:0;color:var(--dim);font-weight:700;font-size:13px;cursor:pointer;animation:wcfRvIn .4s 1.6s both}
@media (prefers-reduced-motion:reduce){.wcf-vote-medal,.wcf-won,.wcf-won *,.wcf-mr-reveal *{animation:none!important}}
/* Subtle touches */
.wcf-book:active:not(:disabled){transform:scale(.96)}
.wcf-hero-bar-fill,.wcf-fx-bar-fill{transition:width .7s cubic-bezier(.3,.8,.3,1)}
.wcf-tick{display:inline-block}
.wcf-tick.roll{animation:wcfTickRoll .45s cubic-bezier(.3,1.4,.5,1)}
/* Feed: what's new since you last looked */
.wcf-feed-section-label.fresh{color:#f5d97a}
.wcf-feed-section-label.fresh:after{background:linear-gradient(90deg,#f5d97a,transparent);transform-origin:left;animation:wcfLineDraw .8s .1s ease-out both}
@keyframes wcfLineDraw{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.wcf-feed-item.fresh{animation:wcfDealIn .6s var(--d,0s) cubic-bezier(.3,1.3,.5,1) both,wcfFreshGlow 3.4s var(--d,0s) ease-out both}
@keyframes wcfDealIn{from{opacity:0;transform:translateY(-26px) rotate(-3deg) scale(.96)}to{opacity:1;transform:none}}
@keyframes wcfFreshGlow{0%{box-shadow:0 0 0 1.5px rgba(245,217,122,.95),0 0 26px -6px rgba(245,217,122,.6)}70%{box-shadow:0 0 0 1.5px rgba(245,217,122,.6),0 0 0 0 transparent}100%{box-shadow:0 0 0 1px transparent}}
.wcf-feed-item{position:relative}
/* Full time: band, split-flap score, pill stamp, scorers, vote pulse */
.wcf-ft-band{position:fixed;left:0;right:0;top:38%;z-index:900;height:92px;display:grid;place-items:center;pointer-events:none;background:linear-gradient(90deg,#b8202c,var(--red) 40%,#b8202c);box-shadow:0 20px 50px -10px rgba(0,0,0,.8);animation:wcfBandIn .5s cubic-bezier(.6,0,.2,1) both,wcfBandOut .5s 1.5s cubic-bezier(.6,0,.2,1) forwards}
.wcf-ft-band b{font-family:var(--display);font-weight:800;font-size:40px;letter-spacing:-.02em;color:#fff;display:flex;align-items:center;gap:12px}
.wcf-ft-band small{position:absolute;bottom:10px;font-size:10px;font-weight:800;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.75)}
.wcf-ft-band svg{width:34px;height:34px;animation:wcfBlow .18s .4s 4 alternate}
@keyframes wcfBandIn{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes wcfBandOut{from{clip-path:inset(0 0 0 0)}to{clip-path:inset(0 0 0 100%)}}
@keyframes wcfBlow{to{transform:rotate(-14deg) scale(1.12)}}
.wcf-flap{position:relative;display:inline-grid;place-items:center;min-width:30px;height:34px;border-radius:6px;background:#0b1220;box-shadow:inset 0 0 0 1px rgba(148,163,184,.18);overflow:hidden;align-self:center}
.wcf-flap:after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(0,0,0,.6)}
.wcf-flap b{animation:wcfFlip .1s linear}
@keyframes wcfFlip{from{transform:rotateX(80deg);opacity:.4}to{transform:none;opacity:1}}
.wcf-feed-item.fresh .wcf-ft-head .wcf-res-pill{animation:wcfStamp .45s calc(var(--ftd,.7s) + 1.3s) cubic-bezier(.3,1.6,.5,1) both;display:inline-block}
.wcf-feed-item.fresh .wcf-ft-scorers{animation:wcfRise .4s calc(var(--ftd,.7s) + 1.6s) both}
.wcf-feed-item.fresh .wcf-ft-vote{animation:wcfVotePulse 1.4s calc(var(--ftd,.7s) + 2s) ease-out 2}
@keyframes wcfStamp{from{opacity:0;transform:scale(2.4) rotate(-12deg)}to{opacity:1;transform:none}}
@keyframes wcfRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes wcfVotePulse{0%{box-shadow:0 0 0 0 rgba(245,217,122,.6)}100%{box-shadow:0 0 0 14px rgba(245,217,122,0)}}
/* Reactions */
.wcf-feed-pill{position:relative}
.wcf-feed-pill.punch{animation:wcfPunch .4s cubic-bezier(.3,1.8,.5,1)}
@keyframes wcfPunch{30%{transform:scale(1.28)}100%{transform:none}}
.wcf-react-ring{position:absolute;inset:-2px;border-radius:22px;border:2px solid var(--green);pointer-events:none;animation:wcfRing .5s ease-out forwards}
@keyframes wcfRing{to{transform:scale(1.6);opacity:0}}
.wcf-ember{position:absolute;left:50%;top:40%;pointer-events:none;color:#fdba74;animation:wcfEmber var(--d,.9s) ease-out forwards}
@keyframes wcfEmber{from{opacity:1;transform:translate(-50%,0) scale(.6)}to{opacity:0;transform:translate(calc(-50% + var(--x)),var(--y)) scale(1.1) rotate(var(--r))}}
.wcf-feed-item.onfire{animation:wcfFire 1.2s ease-in-out 3 alternate}
@keyframes wcfFire{from{box-shadow:0 0 0 1px rgba(251,146,60,.4),0 0 16px -6px rgba(251,146,60,.5)}to{box-shadow:0 0 0 1.5px rgba(251,146,60,.9),0 0 30px -4px rgba(239,68,68,.55)}}
.wcf-fire-tag{position:absolute;top:-9px;right:12px;z-index:1;padding:2px 8px;border-radius:999px;background:linear-gradient(90deg,#f97316,#ef4444);color:#fff;font-size:9.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.wcf-spark{position:absolute;width:4px;height:4px;border-radius:50%;background:#fdba74;pointer-events:none;animation:wcfSpark 1.6s ease-out forwards}
@keyframes wcfSpark{from{opacity:1;transform:none}to{opacity:0;transform:translate(var(--x),-60px)}}
/* Pot coins and new faces */
.wcf-coins{position:absolute;inset:0;pointer-events:none;overflow:visible}
.wcf-coins i{position:absolute;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3c4,#f5d97a 45%,#b8892a);color:#6b4e0f;font:normal 900 11px var(--sans);display:grid;place-items:center;box-shadow:0 2px 4px rgba(0,0,0,.4);animation:wcfCoinDrop .7s var(--d) cubic-bezier(.5,0,.6,1.4) both,wcfCoinFade .5s calc(var(--d) + 1.4s) forwards}
@keyframes wcfCoinDrop{from{opacity:0;transform:translateY(-120px) rotate(-90deg)}60%{opacity:1}to{opacity:1;transform:none}}
@keyframes wcfCoinFade{to{opacity:0}}
.wcf-faces{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.wcf-face{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:10.5px;color:var(--dim);max-width:52px}
.wcf-face span{max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wcf-face .wcf-avatar-chip{width:30px;height:30px;font-size:12px;margin:0}
.wcf-faces.walk .wcf-face{animation:wcfWalkIn .7s var(--d) cubic-bezier(.3,1.3,.5,1) both}
@keyframes wcfWalkIn{0%{opacity:0;transform:translateX(-60px)}60%{opacity:1;transform:translate(4px,-4px)}80%{transform:none}100%{transform:none}}
/* Pull to refresh: the net */
.wcf-net{height:0;overflow:hidden;position:relative;margin:0 -14px}
.wcf-net svg:first-child{position:absolute;left:0;right:0;bottom:0;width:100%;height:130px}
.wcf-net-ball{position:absolute;left:50%;bottom:8px;width:26px;height:26px;margin-left:-13px;opacity:0}
.wcf-net-label{position:absolute;left:0;right:0;bottom:6px;text-align:center;font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.wcf-net-label.ok{color:var(--green)}
/* Empty screens */
.wcf-es{display:flex;flex-direction:column;align-items:center;text-align:center;padding:18px 8px 24px;gap:12px}
.wcf-es.small{padding:6px 8px 12px;gap:8px}
.wcf-es svg{width:100%;max-width:270px;height:auto;display:block}
.wcf-es.small svg{max-width:180px}
.wcf-es h3{margin:0;font-family:var(--display);font-weight:800;font-size:17px;color:var(--white);letter-spacing:-.01em}
.wcf-es.small h3{font-size:15px}
.wcf-es p{margin:0;color:var(--dim);font-size:13px;line-height:1.5;max-width:30ch}
.wcf-es .wcf-book{flex:none;padding:12px 22px}
.wcf-es>*{animation:wcfRise .45s both}
.wcf-es>*:nth-child(2){animation-delay:.5s}.wcf-es>*:nth-child(3){animation-delay:.65s}.wcf-es>*:nth-child(4){animation-delay:.8s}
.wcf-es-cone{opacity:0}
.wcf-es.lit .wcf-es-cone{animation:wcfFlick .7s var(--d) steps(1) forwards,wcfCone .5s calc(var(--d) + .7s) forwards}
@keyframes wcfFlick{0%{opacity:.5}20%{opacity:0}40%{opacity:.7}55%{opacity:.1}100%{opacity:.9}}
@keyframes wcfCone{to{opacity:.9}}
.wcf-es-lamp{fill:#334155}
.wcf-es.lit .wcf-es-lamp{animation:wcfLampOn .1s var(--d) forwards}
@keyframes wcfLampOn{to{fill:#fff8db}}
.wcf-es-lines>*{stroke-dasharray:1;stroke-dashoffset:1}
.wcf-es.lit .wcf-es-lines>*{animation:wcfPaint var(--t,1s) var(--d,0s) ease-in-out forwards}
@keyframes wcfPaint{to{stroke-dashoffset:0}}
.wcf-es-ball{transform-box:fill-box;transform-origin:center;animation:wcfRollIn 1.4s 2.1s cubic-bezier(.2,.8,.3,1) both}
@keyframes wcfRollIn{from{transform:translateX(-150px) rotate(-540deg)}to{transform:none}}
.wcf-es-marker{animation:wcfMarker 2.2s .2s ease-in-out both}
@keyframes wcfMarker{from{transform:translateX(-110px)}to{transform:translateX(110px)}}
.wcf-es-sblabel{font-family:var(--sans);font-weight:800;font-size:11px;letter-spacing:2px;fill:#94a3b8}
.wcf-es-sb{font-family:var(--display);font-weight:800;font-size:34px}
.wcf-es-num{font-family:var(--display);font-weight:800;font-size:10px;fill:#fff}
.wcf-es-swing{transform-box:fill-box;transform-origin:50% 0;animation:wcfSwing 2.4s ease-in-out infinite alternate}
@keyframes wcfSwing{from{transform:rotate(-6deg)}to{transform:rotate(6deg)}}
.wcf-es-flapdoor{transform-box:fill-box;transform-origin:50% 0;animation:wcfDoor 2.6s ease-in-out infinite}
@keyframes wcfDoor{0%,60%,100%{transform:none}70%{transform:rotateX(55deg)}80%{transform:rotateX(-15deg)}90%{transform:rotateX(8deg)}}
.wcf-es-coin{animation:wcfJarDrop .6s cubic-bezier(.5,0,.6,1.3) both}
@keyframes wcfJarDrop{from{transform:translateY(-90px);opacity:0}50%{opacity:1}to{transform:none;opacity:1}}
.wcf-es-stamp{transform-box:fill-box;transform-origin:center;animation:wcfStamp .5s 2.1s cubic-bezier(.3,1.6,.5,1) both}
.wcf-es-stamptext{font-family:var(--display);font-weight:800;font-size:16px;letter-spacing:2px;fill:#22c55e}
@media (prefers-reduced-motion:reduce){
  .wcf-es *,.wcf-es>*,.wcf-feed-item.fresh,.wcf-feed-item.fresh *,.wcf-faces.walk .wcf-face,.wcf-ft-band{animation:none!important}
  .wcf-es-cone{opacity:.9}.wcf-es-lamp{fill:#fff8db}.wcf-es-lines>*{stroke-dashoffset:0}.wcf-ft-band{display:none}
}
.wcf-avatar-chip.more.roll{animation:wcfChipBump .45s cubic-bezier(.3,1.6,.5,1)}
@keyframes wcfTickRoll{from{transform:translateY(-70%);opacity:0}to{transform:none;opacity:1}}
@keyframes wcfChipBump{40%{transform:scale(1.22)}100%{transform:none}}
.wcf-card.featured,.wcf-fx-row{transition:border-color .7s ease,box-shadow .7s ease}
.wcf-pay-strip{animation:wcfStripIn .4s cubic-bezier(.3,1.2,.5,1) both}
@keyframes wcfStripIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.wcf-fx-pill.low{background:rgba(234,179,8,.14);border:1px solid rgba(234,179,8,.45);color:#f5d97a;animation:wcfBreathe 2.6s ease-in-out infinite}
@keyframes wcfBreathe{0%,100%{box-shadow:0 0 0 0 rgba(234,179,8,0)}50%{box-shadow:0 0 0 4px rgba(234,179,8,.18),0 0 14px 2px rgba(234,179,8,.45)}}
.wcf-cd-live{color:#f5d97a!important;display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.wcf-cd-dot{width:6px;height:6px;border-radius:50%;background:#f5d97a;animation:wcfCdDot 1s ease-in-out infinite}
@keyframes wcfCdDot{50%{opacity:.25;transform:scale(.7)}}
.wcf-queue.moved{animation:wcfQFlash .9s ease-out}
.wcf-queue.moved .wcf-queue-t{animation:wcfTickRoll .45s cubic-bezier(.3,1.4,.5,1)}
.wcf-queue.moved .wcf-queue-slot{animation:wcfSlotLeft .45s cubic-bezier(.3,1.2,.5,1) both}
@keyframes wcfQFlash{0%{box-shadow:0 0 0 0 rgba(245,217,122,0)}30%{box-shadow:0 0 0 2px rgba(245,217,122,.7),0 0 24px 4px rgba(234,179,8,.35)}100%{box-shadow:0 0 0 0 rgba(245,217,122,0)}}
@keyframes wcfSlotLeft{from{transform:translateX(44px)}to{transform:none}}
.wcf-navbtn.active svg{animation:wcfNavBounce .45s cubic-bezier(.3,1.8,.5,1)}
@keyframes wcfNavBounce{30%{transform:translateY(-4px) scale(1.15)}100%{transform:none}}
.wcf-main{animation:wcfViewIn .28s ease-out}
@keyframes wcfViewIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.wcf-sheet-overlay .wcf-squad-sheet{animation:wcfSpringUp .55s cubic-bezier(.2,1.25,.35,1) both}
@keyframes wcfSpringUp{from{transform:translateY(100%)}to{transform:none}}
.wcf-squad-sheet .wcf-sheet-row{animation:wcfViewIn .3s both;animation-delay:calc(.2s + var(--i,0) * 35ms)}
@media (prefers-reduced-motion:reduce){.wcf-tick,.wcf-avatar-chip.more,.wcf-pay-strip,.wcf-fx-pill.low,.wcf-cd-dot,.wcf-queue,.wcf-queue *,.wcf-navbtn svg,.wcf-main,.wcf-squad-sheet,.wcf-sheet-row,.wcf-tk-layer,.wcf-tk-layer *,.wcf-potm-intro,.wcf-potm-intro *{animation:none!important}.wcf-card.featured,.wcf-fx-row,.wcf-hero-bar-fill,.wcf-fx-bar-fill,.wcf-book{transition:none!important}}
/* Big moments: substitution board, debut cap, milestone shirt, club milestone */
.wcf-moment{position:fixed;inset:0;z-index:146;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:#fff;cursor:pointer;animation:wcfWonIn .3s both}
.wcf-moment.dim{background:rgba(4,6,12,.88);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.wcf-moment.club{background:radial-gradient(80% 55% at 50% 40%,rgba(234,179,8,.22),rgba(8,8,16,.97) 70%),rgba(8,8,16,.9)}
.wcf-moment.out{animation:wcfLayerOut .38s ease-in both}
.wcf-moment-k{font-size:10.5px;font-weight:800;letter-spacing:.24em;color:#f5d97a}
.wcf-moment-h{font-family:var(--display);font-weight:800;font-size:27px;line-height:1.1;margin-top:8px;max-width:300px;text-wrap:balance}
.wcf-moment-s{font-size:13.5px;color:var(--dim);margin-top:8px;line-height:1.5}
.wcf-moment-s b{color:#fff}
.wcf-moment-after{animation:wcfRvIn .4s 1.5s both}
.wcf-led{width:min(280px,82vw);border-radius:10px;background:#050508;box-shadow:0 0 0 4px #22222c,0 18px 40px -18px #000;position:relative;overflow:hidden;padding:16px 0 18px;font-family:var(--display)}
.wcf-led .l1{font-size:14px;font-weight:800;letter-spacing:.18em;color:#fbbf24;text-shadow:0 0 12px rgba(251,191,36,.8);animation:wcfLedBlink .45s steps(2) 3 both}
.wcf-led .row{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:12px}
.wcf-led .arrow{width:26px;height:26px;fill:none;stroke:#4ade80;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 6px rgba(74,222,128,.8))}
.wcf-led .num{font-size:40px;font-weight:800;color:#4ade80;text-shadow:0 0 14px rgba(74,222,128,.85);animation:wcfLedWipe .5s .9s steps(6) both}
.wcf-led .l3{font-size:26px;font-weight:800;color:#4ade80;text-shadow:0 0 14px rgba(74,222,128,.85);margin-top:6px;animation:wcfLedWipe .6s 1.3s steps(8) both}
.wcf-led .l4{font-size:11px;font-weight:700;color:#e5e7eb;letter-spacing:.12em;margin-top:10px;padding:0 10px;animation:wcfLedWipe .6s 1.8s steps(10) both}
.wcf-led .dots{position:absolute;inset:0;pointer-events:none;background:radial-gradient(circle,transparent 1.35px,rgba(5,5,8,.8) 1.75px) 0 0/3.5px 3.5px}
@keyframes wcfLedBlink{0%{opacity:0}50%{opacity:1}}
@keyframes wcfLedWipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.wcf-cap{width:150px;height:120px;overflow:visible;animation:wcfCapIn 1.2s cubic-bezier(.3,1.2,.4,1) both}
.wcf-cap .tassel{transform-origin:75px 22px;animation:wcfTassel 2s 1s ease-in-out both}
@keyframes wcfCapIn{0%{transform:translateY(-200px) rotate(-30deg);opacity:0}60%{transform:translateY(8px) rotate(4deg);opacity:1}100%{transform:none}}
@keyframes wcfTassel{0%{transform:rotate(18deg)}30%{transform:rotate(-12deg)}60%{transform:rotate(6deg)}100%{transform:none}}
.wcf-shirt{width:170px;height:180px;overflow:visible;transform-origin:50% 0;animation:wcfShirtDrop 1.4s cubic-bezier(.3,0,.3,1) both}
@keyframes wcfShirtDrop{0%{transform:translateY(-260px)}30%{transform:translateY(0) rotate(5deg)}50%{transform:rotate(-3deg)}70%{transform:rotate(1.5deg)}100%{transform:none}}
.wcf-ms-badge{width:74px;height:74px;margin-top:-20px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#ffe9a6,#eab308 60%,#a57f22);color:#1a1405;font-family:var(--display);font-weight:800;font-size:12px;line-height:1;letter-spacing:.06em;box-shadow:0 0 0 3px #0d0d1a,0 0 0 5px rgba(245,217,122,.6),0 10px 30px rgba(234,179,8,.4);animation:wcfPop .45s 1.3s cubic-bezier(.3,1.6,.5,1) both;position:relative;z-index:2}
.wcf-ms-badge b{display:block;font-size:24px}
.wcf-club-count{font-family:var(--display);font-weight:800;font-size:96px;line-height:1;margin-top:10px;font-variant-numeric:tabular-nums;background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent}
.wcf-club-count.hit{animation:wcfClubHit .5s cubic-bezier(.3,1.6,.5,1)}
@keyframes wcfClubHit{40%{transform:scale(1.25)}100%{transform:none}}
.wcf-club-rays{position:absolute;left:50%;top:44%;width:0;height:0}
.wcf-club-rays i{position:absolute;width:3px;height:26px;margin:-13px 0 0 -1.5px;background:#f5d97a;border-radius:2px;opacity:0}
.wcf-club-rays.go i{animation:wcfClubRay .8s ease-out both}
@keyframes wcfClubRay{0%{opacity:0;transform:rotate(var(--a)) translateY(-40px)}30%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateY(-130px)}}
.wcf-pcard-ms{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:radial-gradient(circle at 35% 30%,#ffe9a6,#eab308 70%);color:#1a1405;display:inline-flex;align-items:center}
@media (prefers-reduced-motion:reduce){.wcf-moment,.wcf-moment *{animation:none!important}}
/* Line-up walkout (pitch tokens) */
.wcf-lineup-token-chip{transition:background .45s ease,color .45s ease,box-shadow .45s ease}
.wcf-lineup-token.wcf-walk-pending .wcf-lineup-token-chip{background:#475569!important;color:#cbd5e1!important;box-shadow:0 6px 14px -6px rgba(0,0,0,.85)!important}
.wcf-lineup-token .wcf-lineup-token-label{transition:opacity .3s}
.wcf-lineup-token.wcf-walk-pending .wcf-lineup-token-label{opacity:0}
.wcf-lineup-token.wcf-walk-me .wcf-lineup-token-chip{box-shadow:0 0 0 2.5px #f5d97a,0 0 18px 3px rgba(234,179,8,.55)!important;animation:wcfWalkGlow 1.6s ease-in-out 2}
.wcf-lineup-token.wcf-walk-me::before{content:"YOU";position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:1px;font-size:8.5px;font-weight:800;letter-spacing:.1em;color:#0d0d1a;background:#f5d97a;padding:2px 6px;border-radius:999px;white-space:nowrap;animation:wcfWalkTag .4s cubic-bezier(.3,1.6,.5,1) both}
@keyframes wcfWalkGlow{50%{box-shadow:0 0 0 4px #f5d97a,0 0 26px 6px rgba(234,179,8,.7)}}
@keyframes wcfWalkTag{from{opacity:0;transform:translate(-50%,6px) scale(.5)}to{opacity:1;transform:translateX(-50%)}}
.wcf-walk-chalk .wcf-lineup-pitch-lines circle[r="30"]{stroke-dasharray:190;animation:wcfWalkChalk .8s ease-out both}
@keyframes wcfWalkChalk{from{stroke-dashoffset:190}to{stroke-dashoffset:0}}
.wcf-lineup-head.wcf-walk-stamp::after{content:"TEAMS ARE OUT";position:absolute;right:14px;bottom:16px;padding:8px 12px;border-radius:8px;background:#f5d97a;color:#0d0d1a;font-family:var(--display);font-weight:800;font-size:13px;letter-spacing:.12em;transform:rotate(-6deg);animation:wcfWalkStamp .4s .1s cubic-bezier(.3,1.6,.5,1) both}
@keyframes wcfWalkStamp{from{opacity:0;transform:rotate(-6deg) scale(2.4)}to{opacity:1;transform:rotate(-6deg) scale(1)}}
/* New-fixtures calendar, prediction slip/padlock/points, admin envelope */
.wcf-new-chip{margin-left:8px;padding:3px 8px;border-radius:999px;background:#f5d97a;color:#1a1405;font-family:var(--sans);font-size:10px;font-weight:800;letter-spacing:.06em;vertical-align:3px;animation:wcfPinIn .4s cubic-bezier(.3,1.7,.5,1) both}
.wcf-cal{width:min(290px,86vw);border-radius:20px;background:radial-gradient(100% 70% at 50% 0%,rgba(245,217,122,.12),transparent 60%),#111427;border:1px solid rgba(245,217,122,.45);box-shadow:0 24px 60px -24px #000;padding:16px 14px 14px;transform-origin:50% 0;animation:wcfUnfoldCal .6s cubic-bezier(.2,.9,.3,1.1) both;text-align:left}
@keyframes wcfUnfoldCal{from{transform:perspective(700px) rotateX(-85deg);opacity:0}to{transform:none;opacity:1}}
.wcf-cal-k{font-size:10.5px;font-weight:800;letter-spacing:.14em;color:#f5d97a;text-transform:uppercase}
.wcf-cal-h{display:flex;justify-content:space-between;align-items:baseline;margin-top:4px}
.wcf-cal-h b{font-family:var(--display);font-weight:800;font-size:22px}.wcf-cal-h span{font-size:12px;font-weight:800;color:#f5d97a;font-variant-numeric:tabular-nums}
.wcf-cal-g{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:12px}
.wcf-cal-g .dn{font-size:8.5px;font-weight:800;color:var(--dim);text-align:center;letter-spacing:.08em;padding-bottom:2px}
.wcf-cal-g .c{position:relative;height:31px;border-radius:8px;background:rgba(255,255,255,.04);display:grid;place-items:center;font-size:11px;font-weight:700;color:#cbd5e1}
.wcf-cal-g .c.x{background:none}
.wcf-cal-g .c.pin{background:rgba(245,217,122,.16);color:#fff;box-shadow:inset 0 0 0 1.5px #f5d97a;animation:wcfPinIn .45s cubic-bezier(.3,1.7,.5,1) both}
.wcf-cal-g .c.pin::after{content:"";position:absolute;top:-5px;right:-3px;width:9px;height:9px;border-radius:50%;background:#f5d97a;box-shadow:0 0 8px rgba(245,217,122,.85)}
@keyframes wcfPinIn{0%{transform:translateY(-30px) scale(.6);opacity:0}100%{transform:none;opacity:1}}
.wcf-moment.fold .wcf-cal{animation:wcfCalFold .5s cubic-bezier(.5,0,.8,.4) both}
@keyframes wcfCalFold{to{transform:translateY(240px) scale(.3);opacity:0}}
.wcf-fx-cascade{animation:wcfDropIn .45s cubic-bezier(.3,1.3,.5,1) both}
.wcf-fx-cascade .wcf-fx-row{position:relative;overflow:hidden}
.wcf-fx-cascade .wcf-fx-row::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,240,200,.16) 50%,transparent 65%);transform:translateX(-130%);animation:wcfRbShine .9s .35s ease-out both;pointer-events:none}
@keyframes wcfDropIn{from{opacity:0;transform:translateY(-30px)}to{opacity:1;transform:none}}
.wcf-reel{display:inline-block}
.wcf-reel.up{animation:wcfReelUp .28s cubic-bezier(.3,1.4,.5,1)}.wcf-reel.down{animation:wcfReelDown .28s cubic-bezier(.3,1.4,.5,1)}
@keyframes wcfReelUp{from{transform:translateY(80%);opacity:.2}to{transform:none;opacity:1}}
@keyframes wcfReelDown{from{transform:translateY(-80%);opacity:.2}to{transform:none;opacity:1}}
.wcf-slip{width:min(270px,82vw);border-radius:12px;background:#f3ead2;color:#1d1a14;padding:16px 18px;text-align:left;box-shadow:0 18px 40px -16px #000;position:relative;animation:wcfPrint .8s steps(8) both}
@keyframes wcfPrint{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}
.wcf-slip small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.18em;color:#8a7a55}
.wcf-slip b{display:block;font-family:var(--display);font-weight:800;font-size:23px;margin-top:4px}
.wcf-slip .meta{font-size:11.5px;color:#4b4330;margin-top:6px}
.wcf-slip .st2{position:absolute;right:12px;bottom:12px;padding:5px 9px;border-radius:7px;box-shadow:inset 0 0 0 2.5px #b8860b;color:#b8860b;font-family:var(--display);font-weight:800;font-size:11px;letter-spacing:.1em;transform:rotate(8deg);animation:wcfThump2 .35s .8s cubic-bezier(.3,1.6,.5,1) both}
@keyframes wcfThump2{from{opacity:0;transform:rotate(8deg) scale(2.4)}to{opacity:1;transform:rotate(8deg) scale(1)}}
.wcf-moment.foldslip .wcf-slip{animation:wcfSlipFold .45s cubic-bezier(.5,0,.8,.4) both}
.wcf-moment.foldslip{animation:wcfLayerOut .45s ease-in both}
@keyframes wcfSlipFold{to{transform:translateY(-150px) scaleY(.2);opacity:0}}
.wcf-biglock{width:110px;height:128px;animation:wcfLockDrop .6s cubic-bezier(.3,1.4,.5,1) both}
.wcf-biglock .sh{transform:translateY(-14px);animation:wcfClamp .25s .55s ease-in both}
@keyframes wcfLockDrop{from{transform:translateY(-260px)}to{transform:none}}
@keyframes wcfClamp{to{transform:none}}
.wcf-bigpts{font-family:var(--display);font-weight:800;font-size:110px;line-height:1;background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wcfPtsIn .5s cubic-bezier(.3,1.7,.5,1) both}
.wcf-bigpts.zero{background:none;-webkit-text-fill-color:#94a3b8;color:#94a3b8}
@keyframes wcfPtsIn{from{transform:scale(2.2);opacity:0}to{transform:none;opacity:1}}
.wcf-pts-burst{position:absolute;left:50%;top:44%;width:0;height:0}
.wcf-pts-burst i{position:absolute;width:4px;height:16px;margin:-8px 0 0 -2px;border-radius:3px;background:#f5d97a;opacity:0;animation:wcfPtsRay .8s .1s ease-out both}
@keyframes wcfPtsRay{0%{opacity:0;transform:rotate(var(--a)) translateY(-40px)}30%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateY(-130px)}}
.wcf-pts-pop{display:inline-block;animation:wcfPop .45s cubic-bezier(.3,1.7,.5,1) both}
.wcf-env{position:relative;width:min(280px,84vw);height:340px}
.wcf-env .envl{position:absolute;left:5px;right:5px;top:96px;height:150px;border-radius:10px;background:linear-gradient(160deg,#efe3c8,#dcc9a0);box-shadow:0 18px 40px -16px #000;animation:wcfEnvIn .55s cubic-bezier(.3,1.2,.5,1) both,wcfEnvAway .45s 1.3s ease-in both}
.wcf-env .envl::before{content:"";position:absolute;left:0;right:0;top:0;height:80px;background:linear-gradient(180deg,#e2d2ae,#cdb88c);clip-path:polygon(0 0,100% 0,50% 100%);border-radius:10px 10px 0 0}
@keyframes wcfEnvIn{from{transform:translateX(340px) rotate(8deg)}to{transform:none}}
@keyframes wcfEnvAway{to{transform:translateY(220px);opacity:0}}
.wcf-env .seal{position:absolute;left:50%;top:150px;width:48px;height:48px;margin-left:-24px;z-index:3;animation:wcfEnvIn .55s cubic-bezier(.3,1.2,.5,1) both}
.wcf-env .seal i{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe08a,#c8961c 60%,#8a6414);clip-path:polygon(50% 50%,var(--p));animation:wcfShard .6s .8s ease-in both}
@keyframes wcfShard{to{transform:translate(var(--dx),var(--dy)) rotate(var(--r));opacity:0}}
.wcf-env .seal span{position:absolute;inset:0;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:11px;color:#3b2a06;animation:wcfFadeOut .2s .8s both}
@keyframes wcfFadeOut{to{opacity:0}}
.wcf-env .paper{position:absolute;left:0;right:0;top:4px;z-index:2;perspective:800px;text-align:left}
.wcf-env .pp{background:#fbf7ee;color:#1d1a14;padding:12px 16px;transform-origin:top}
.wcf-env .pp:first-child{border-radius:8px 8px 0 0;animation:wcfUnf .45s 1.4s ease-out both}
.wcf-env .pp:nth-child(2){animation:wcfUnf .45s 1.7s ease-out both;border-top:1px dashed rgba(29,26,20,.15)}
.wcf-env .pp:nth-child(3){border-radius:0 0 8px 8px;animation:wcfUnf .45s 2s ease-out both;border-top:1px dashed rgba(29,26,20,.15)}
@keyframes wcfUnf{from{transform:rotateX(-90deg);opacity:0}to{transform:none;opacity:1}}
.wcf-env .pp small{display:block;font-size:9.5px;font-weight:800;letter-spacing:.16em;color:#8a7a55}
.wcf-env .line{display:block;font-size:13.5px;line-height:1.55;min-height:42px;white-space:pre-wrap}
.wcf-env .sig{font:italic 700 16px Georgia,serif;position:relative;display:inline-block}
.wcf-env .sig::after{content:"";position:absolute;left:0;right:0;bottom:-3px;height:2px;background:#b8860b;transform-origin:left;transform:scaleX(0);animation:wcfPen .5s 2.8s ease-out both}
@keyframes wcfPen{to{transform:scaleX(1)}}
.wcf-env .more{display:block;margin-top:8px;font-size:11.5px;color:#8a7a55;font-weight:700}
.wcf-env .gotit{margin-top:10px;width:100%;border:0;border-radius:10px;padding:11px;background:#1d1a14;color:#f5d97a;font-family:var(--display);font-weight:800;font-size:13px;cursor:pointer;animation:wcfRvIn .35s 2.9s both}
.wcf-moment.flyaway .wcf-env{animation:wcfFlyInbox .6s cubic-bezier(.5,0,.3,1) both}
@keyframes wcfFlyInbox{to{transform:translate(0,-260px) scale(.2);opacity:0}}
/* Special poster, pot jar, birthday ribbon, rate-sheet whistle, GaffAI tiki-taka */
.wcf-poster{width:min(270px,82vw);border-radius:16px;overflow:hidden;position:relative;text-align:left;padding:18px 18px 16px;background:radial-gradient(120% 90% at 100% 0%,rgba(245,217,122,.35),transparent 55%),linear-gradient(160deg,#2a2312,#120f08 70%);box-shadow:0 0 0 1.5px rgba(245,217,122,.7),0 0 40px 6px rgba(234,179,8,.35);transform-origin:50% 0;animation:wcfUnfold .7s cubic-bezier(.2,.9,.3,1.1) both}
@keyframes wcfUnfold{from{transform:perspective(600px) rotateX(-95deg);opacity:0}to{transform:none;opacity:1}}
.wcf-poster-rib{display:inline-block;padding:4px 9px;border-radius:6px;background:#f5d97a;color:#1a1405;font-size:10px;font-weight:800;letter-spacing:.14em}
.wcf-poster-big{font-family:var(--display);font-weight:800;font-size:40px;line-height:1;margin-top:12px;color:#fff;letter-spacing:-.02em}
.wcf-poster-sub{font-family:var(--display);font-weight:800;font-size:13px;color:#f5d97a;margin-top:6px;letter-spacing:.06em}
.wcf-poster-meta{font-size:12.5px;color:#d6cfb8;margin-top:12px;line-height:1.5}
.wcf-poster-meta b{color:#fff}
.wcf-poster-cta{margin-top:14px;width:100%;border:0;border-radius:12px;padding:11px;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);color:#1a1405;font-family:var(--display);font-weight:800;font-size:13px;cursor:pointer}
.wcf-poster-sheen{position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,240,200,.35) 50%,transparent 65%);transform:translateX(-130%);animation:wcfRbShine .9s .7s ease-out both;pointer-events:none}
.wcf-moment.fold .wcf-poster{animation:wcfFoldDown .45s cubic-bezier(.5,0,.8,.4) both}
.wcf-moment.fold{animation:wcfLayerOut .45s ease-in both}
@keyframes wcfFoldDown{to{transform:translateY(120px) scale(.4);opacity:0}}
.wcf-row-flash{animation:wcfRowFlash 1.2s ease-out}
.wcf-row-flash .wcf-fx-row{animation:wcfRowFlash 1.2s ease-out}
@keyframes wcfRowFlash{0%{box-shadow:0 0 0 0 rgba(245,217,122,0)}30%{box-shadow:0 0 0 2px rgba(245,217,122,.9),0 0 30px 6px rgba(234,179,8,.5)}100%{box-shadow:0 0 0 0 rgba(245,217,122,0)}}
.wcf-pot-hero{position:relative}
.wcf-pot-jar{position:absolute;right:14px;top:12px;width:60px;height:76px}
.wcf-pot-jar svg{width:100%;height:100%;display:block}
.wcf-pot-jar-fill{transition:transform 1.2s cubic-bezier(.3,.8,.3,1)}
.wcf-pot-coin{position:absolute;left:50%;top:-56px;width:13px;height:13px;margin-left:-6.5px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3b0,#eab308 60%,#a57f22);box-shadow:0 0 0 1px #a57f22;animation:wcfCoin .55s cubic-bezier(.5,0,.8,.6) both}
@keyframes wcfCoin{0%{opacity:0;transform:translate(var(--dx),0) rotateY(0)}15%{opacity:1}85%{opacity:1;transform:translate(0,96px) rotateY(540deg)}100%{opacity:0;transform:translate(0,104px)}}
.wcf-ribbon{position:absolute;inset:0;pointer-events:none}
.wcf-ribbon .v{position:absolute;top:-6px;bottom:-6px;left:62%;width:14px;background:linear-gradient(90deg,#b8860b,#f5d97a 50%,#b8860b);animation:wcfSlipV .6s 1.5s cubic-bezier(.5,0,.8,.4) both}
.wcf-ribbon .h{position:absolute;left:-6px;right:-6px;top:46%;height:14px;background:linear-gradient(180deg,#b8860b,#f5d97a 50%,#b8860b);animation:wcfSlipH .6s 1.5s cubic-bezier(.5,0,.8,.4) both}
.wcf-ribbon .bow{position:absolute;left:62%;top:46%;width:54px;height:34px;margin:-10px 0 0 -20px;transform-origin:27px 17px;animation:wcfUntie .8s .7s ease-in-out both}
@keyframes wcfUntie{0%{transform:none}40%{transform:rotate(-14deg) scale(1.05)}70%{transform:rotate(10deg) scale(.9);opacity:1}100%{transform:rotate(40deg) translate(30px,60px) scale(.4);opacity:0}}
@keyframes wcfSlipV{to{transform:translateY(160%);opacity:0}}
@keyframes wcfSlipH{to{transform:translateX(160%);opacity:0}}
.wcf-tk-st.onus{right:44px;bottom:-30px;--r:-10deg;transform:rotate(-10deg);color:#b8860b;box-shadow:inset 0 0 0 3px #b8860b,inset 0 0 0 6px #f3ead2,inset 0 0 0 7.5px #b8860b;animation:wcfThump .38s 2.2s cubic-bezier(.3,1.6,.5,1) both}
.wcf-tk-layer.birthday .wcf-tk-cap{animation-delay:2.4s}
.wcf-rate-whistle{position:absolute;left:50%;top:34px;width:40px;height:40px;margin-left:-20px;overflow:visible;animation:wcfWhIn 1.7s both}
.wcf-rate-whistle .body{fill:none;stroke:#f5d97a;stroke-width:2;stroke-linejoin:round}
.wcf-rate-whistle .wave{fill:none;stroke:#f5d97a;stroke-width:2;stroke-linecap:round;opacity:0;animation:wcfToot .42s both}
.wcf-rate-whistle .wave:nth-of-type(2){animation-delay:.45s}.wcf-rate-whistle .wave:nth-of-type(3){animation-delay:.9s}
@keyframes wcfWhIn{0%{opacity:0;transform:scale(.6)}12%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
@keyframes wcfToot{0%{opacity:0;transform:translateX(-3px)}40%{opacity:1}100%{opacity:0;transform:translateX(3px)}}
.wcf-flap{display:inline-block;animation:wcfFlap .07s linear}
@keyframes wcfFlap{50%{transform:scaleY(.78)}}
.wcf-rate-meter button.on{animation:wcfHeat .35s cubic-bezier(.3,1.6,.5,1) both;animation-delay:calc(var(--i,0) * 60ms)}
@keyframes wcfHeat{0%{transform:scaleY(.6);filter:brightness(1.6)}100%{transform:none;filter:none}}
.wcf-rate-verdict.pop{animation:wcfStampIn .4s cubic-bezier(.3,1.6,.5,1) both}
@keyframes wcfStampIn{from{transform:scale(1.8);opacity:0}to{transform:none;opacity:1}}
.gaffai-tiki{position:relative;width:210px;max-width:100%;aspect-ratio:210/128;border-radius:10px;background:#1d4d32;box-shadow:inset 0 0 0 2px rgba(255,255,255,.55);overflow:hidden;margin:4px 0}
.gaffai-tiki::before{content:"";position:absolute;left:50%;top:0;bottom:0;border-left:2px solid rgba(255,255,255,.5)}
.gaffai-tiki::after{content:"";position:absolute;left:50%;top:50%;width:19%;aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;border:2px solid rgba(255,255,255,.5)}
.gaffai-tiki svg{position:absolute;inset:0;width:100%;height:100%;z-index:1}
.gaffai-tiki line{stroke:rgba(245,246,248,.85);stroke-width:2;stroke-dasharray:4 5;stroke-linecap:round;animation:wcfLineFade 1.4s ease-out forwards}
@keyframes wcfLineFade{to{opacity:0}}
.gaffai-tiki .p{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;z-index:2;box-shadow:0 2px 0 rgba(0,0,0,.3)}
.gaffai-tiki .p.us{background:#f5f6f8}.gaffai-tiki .p.them{background:#E42A36}
.gaffai-tiki .ball{position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:#fff;box-shadow:0 0 0 1.5px #0d0d1a;z-index:3;transition:left .55s cubic-bezier(.4,0,.2,1),top .55s cubic-bezier(.4,0,.2,1)}
/* Add fixtures: date range and tap-to-skip dates */
.wcf-fxs-range{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.wcf-fxs-range label{font-size:10.5px;font-weight:800;letter-spacing:.1em;color:var(--dim);text-transform:uppercase;display:flex;flex-direction:column;gap:4px}
.wcf-fxs-range .wcf-fxs-input{margin:0}
.wcf-fxs-tapnote{font-size:10.5px;color:var(--dim);font-weight:600;letter-spacing:0;text-transform:none}
.wcf-fxs-dates{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.wcf-fxs-dt{border:1px solid rgba(148,163,184,.25);border-radius:10px;padding:6px 4px;background:rgba(255,255,255,.04);color:var(--white);text-align:center;cursor:pointer;font:inherit;transition:background .2s,opacity .2s,transform .15s}
.wcf-fxs-dt:active:not(:disabled){transform:scale(.95)}
.wcf-fxs-dt small{display:block;font-size:9px;font-weight:800;letter-spacing:.08em;color:var(--dim)}
.wcf-fxs-dt b{display:block;font-family:var(--display);font-weight:800;font-size:14px}
.wcf-fxs-dt i{display:block;font-style:normal;font-size:8.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.wcf-fxs-dt.new{border-color:rgba(34,197,94,.5);background:rgba(34,197,94,.1)}
.wcf-fxs-dt.skip{opacity:.45;text-decoration:line-through;border-style:dashed;background:none}
.wcf-fxs-dt.on{border-color:rgba(148,163,184,.15);background:none;color:var(--dim);cursor:default}
/* Admin: birthday game suggestion and menu option */
.wcf-bday-suggest{display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:center;padding:12px;margin-bottom:10px;border-radius:14px;background:radial-gradient(100% 90% at 100% 0%,rgba(245,217,122,.18),transparent 60%),rgba(245,217,122,.06);border:1px solid rgba(245,217,122,.5)}
.wcf-bday-suggest .ico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(245,217,122,.16);color:#f5d97a}
.wcf-bday-suggest .ico svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.wcf-bday-suggest .txt b{display:block;font-size:13px;color:#fff}
.wcf-bday-suggest .txt small{display:block;font-size:11.5px;color:var(--dim);margin-top:2px;line-height:1.4}
.wcf-bday-suggest .btns{grid-column:1/-1;display:flex;gap:8px}
.wcf-bday-suggest .yes{flex:1;border:0;border-radius:10px;padding:9px;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);color:#1a1405;font-family:var(--display);font-weight:800;font-size:12.5px;cursor:pointer}
.wcf-bday-suggest .no{border:1px solid var(--line);border-radius:10px;padding:9px 12px;background:none;color:var(--dim);font-weight:700;font-size:12px;cursor:pointer}
.wcf-action-opt.bday{color:#f5d97a;border-color:rgba(245,217,122,.5);background:rgba(245,217,122,.08);display:flex;flex-direction:column;align-items:flex-start}
.wcf-action-opt.bday small{font-size:10.5px;color:var(--dim);font-weight:600;margin-top:2px}
/* Matchday tickets (MatchTickets): BOOKED on booking, PAID after confirmation */
.wcf-tk-layer{position:fixed;inset:0;z-index:150;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,6,12,.74);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);cursor:pointer;animation:wcfWonIn .25s both}
.wcf-tk-wrap{position:relative;width:min(290px,86vw)}
.wcf-ticket{display:grid;grid-template-columns:1fr 62px;border-radius:12px;overflow:hidden;background:#f3ead2;color:#1d1a14;box-shadow:0 18px 40px -16px #000;animation:wcfTkUp .5s cubic-bezier(.2,.9,.3,1.1) both}
.wcf-ticket-main{padding:15px}
.wcf-ticket-club{font-size:9px;font-weight:800;letter-spacing:.2em;color:#8a7a55}
.wcf-ticket-fx{font-family:var(--display);font-weight:800;font-size:19px;line-height:1.1;margin-top:6px}
.wcf-ticket-when{font-size:12px;font-weight:600;margin-top:4px;color:#4b4330}
.wcf-ticket-row{display:flex;gap:16px;margin-top:11px;font-size:9px;font-weight:800;letter-spacing:.12em;color:#8a7a55}
.wcf-ticket-row b{display:block;font-size:12.5px;font-weight:800;color:#1d1a14;letter-spacing:0;margin-top:2px}
.wcf-ticket-stub{border-left:2px dashed rgba(29,26,20,.35);display:grid;place-items:center}
.wcf-ticket-stub span,.wcf-mt-stub span{writing-mode:vertical-rl;transform:rotate(180deg);font-size:9px;font-weight:800;letter-spacing:.24em;color:#8a7a55}
.wcf-tk-st{position:absolute;width:80px;height:80px;border-radius:50%;display:grid;place-items:center;text-align:center;font-family:var(--display);font-weight:800;font-size:13.5px;line-height:1;letter-spacing:.08em;background:rgba(243,234,210,.94)}
.wcf-tk-st small{display:block;font-family:var(--sans);font-size:7px;letter-spacing:.16em;margin-top:4px}
.wcf-tk-st.booked{right:-18px;top:-30px;--r:-14deg;transform:rotate(-14deg);color:#b8860b;box-shadow:inset 0 0 0 3px #b8860b,inset 0 0 0 6px #f3ead2,inset 0 0 0 7.5px #b8860b}
.wcf-tk-st.paid{right:70px;bottom:-42px;--r:10deg;transform:rotate(10deg);color:#15803d;box-shadow:inset 0 0 0 3px #15803d,inset 0 0 0 6px #f3ead2,inset 0 0 0 7.5px #15803d}
.wcf-tk-layer.booked .wcf-tk-wrap>.wcf-tk-st.booked{animation:wcfThump .38s .55s cubic-bezier(.3,1.6,.5,1) both}
.wcf-tk-layer.paid .wcf-tk-wrap>.wcf-tk-st.paid{animation:wcfThump .38s .5s cubic-bezier(.3,1.6,.5,1) both}
.wcf-tk-layer.paid .wcf-tk-wrap{animation:wcfShake .25s .8s both}
.wcf-tk-stack{position:relative;width:min(260px,80vw)}
.wcf-mt{position:absolute;left:0;right:0;top:calc(var(--i) * 50px);display:grid;grid-template-columns:1fr 48px;border-radius:11px;background:#f3ead2;color:#1d1a14;box-shadow:0 14px 30px -14px #000;transform:rotate(calc((var(--i) - 1) * 3deg));animation:wcfTkFan .5s cubic-bezier(.2,.9,.3,1.1) both;animation-delay:calc(var(--i) * 70ms)}
.wcf-mt-main{padding:11px 12px}
.wcf-mt-date{font-family:var(--display);font-weight:800;font-size:12px;letter-spacing:.06em}
.wcf-mt-fx{font-family:var(--display);font-weight:800;font-size:15px;line-height:1.1;margin-top:4px}
.wcf-mt-club{font-size:8px;font-weight:800;letter-spacing:.2em;margin-top:3px;color:#8a7a55}
.wcf-mt-stub{border-left:2px dashed rgba(29,26,20,.35);display:grid;place-items:center}
.wcf-mt-stub span{font-size:7.5px}
.wcf-tk-st.sm{width:52px;height:52px;font-size:9.5px;right:-10px;top:-14px;bottom:auto;z-index:2;opacity:0;--r:10deg;animation:wcfThumpSm .32s cubic-bezier(.3,1.6,.5,1) both;animation-delay:calc(.6s + var(--d) * .2s)}
.wcf-tk-st.sm.booked{--r:-12deg}
.wcf-tk-more{position:absolute;right:-8px;bottom:-12px;padding:5px 9px;border-radius:999px;background:#15803d;color:#fff;font-weight:800;font-size:11px;box-shadow:0 6px 14px -6px #000;animation:wcfPop .3s 1.35s cubic-bezier(.3,1.6,.5,1) both}
.wcf-tk-layer.booked .wcf-tk-more{background:#b8860b}
.wcf-tk-cap{margin-top:48px;text-align:center;color:#fff;animation:wcfRvIn .35s .9s both}
.wcf-tk-stack+.wcf-tk-cap{animation-delay:.4s}
.wcf-tk-cap b{display:block;font-family:var(--display);font-weight:800;font-size:23px;font-variant-numeric:tabular-nums}
.wcf-tk-cap span{display:block;font-size:13px;color:var(--dim);margin-top:4px}
.wcf-tk-layer.out{animation:wcfTkOut .45s ease-in both}
.wcf-tk-layer.out .wcf-tk-wrap,.wcf-tk-layer.out .wcf-tk-stack,.wcf-tk-layer.out .wcf-tk-cap{animation:wcfTkInto .45s cubic-bezier(.5,0,.8,.4) both}
@keyframes wcfTkUp{from{transform:translateY(260px) rotate(6deg);opacity:0}to{transform:none;opacity:1}}
@keyframes wcfTkFan{from{transform:translateY(300px) rotate(8deg);opacity:0}to{transform:rotate(calc((var(--i) - 1) * 3deg));opacity:1}}
@keyframes wcfThump{from{transform:rotate(var(--r)) scale(2.4);opacity:0}to{transform:rotate(var(--r)) scale(1);opacity:1}}
@keyframes wcfThumpSm{from{opacity:0;transform:rotate(var(--r)) scale(2.4)}to{opacity:1;transform:rotate(var(--r)) scale(1)}}
@keyframes wcfShake{0%,100%{transform:none}30%{transform:translate(-2px,1px)}60%{transform:translate(2px,-1px)}}
@keyframes wcfTkOut{to{background:rgba(4,6,12,0);-webkit-backdrop-filter:blur(0);backdrop-filter:blur(0)}}
@keyframes wcfTkInto{to{transform:translateY(-40px) scale(.25);opacity:0}}
/* Player of the Month night (PotmIntro, PotmWinner) and the card landing */
.wcf-potm-intro{position:fixed;inset:0;z-index:145;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;cursor:pointer;background:radial-gradient(80% 55% at 50% 38%,rgba(234,179,8,.22),rgba(8,8,16,.97) 70%),rgba(8,8,16,.88);animation:wcfWonIn .3s both}
.wcf-potm-intro.winner{cursor:default;background:radial-gradient(90% 60% at 50% 35%,rgba(234,179,8,.3),rgba(8,8,16,.97) 70%),rgba(8,8,16,.9)}
.wcf-potm-intro.out{animation:wcfLayerOut .38s ease-in both}
@keyframes wcfLayerOut{to{opacity:0;transform:scale(1.04)}}
.wcf-pi-k{font-size:11px;font-weight:800;letter-spacing:.3em;color:#f5d97a}
.wcf-pi-page{margin-top:10px;width:160px;height:48px;perspective:400px;position:relative}
.wcf-pi-page div{position:absolute;inset:0;border-radius:8px;display:grid;place-items:center;font-family:var(--display);font-weight:800;font-size:18px;letter-spacing:.08em;backface-visibility:hidden}
.wcf-pi-page .old{background:#334155;color:#94a3b8;transform-origin:50% 0;animation:wcfTear .6s .25s cubic-bezier(.5,0,.7,1) both}
.wcf-pi-page .new{background:linear-gradient(180deg,#2a2440,#1a1830);box-shadow:inset 0 0 0 1.5px rgba(245,217,122,.5);color:#fff;animation:wcfPop .3s .65s both}
.wcf-pi-trophy{width:100px;height:114px;margin-top:18px}
.wcf-pi-trophy path,.wcf-pi-trophy line{fill:none;stroke:#f5d97a;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:300;animation:wcfDraw 1s .85s ease-out both}
.wcf-pi-trophy .cup{animation:wcfDraw 1s .85s ease-out both,wcfFillGold .5s 1.75s both}
.wcf-pi-trophy .cup.filled{fill:rgba(245,217,122,.85)}
.wcf-pi-trophy.big{width:124px;height:142px;animation:wcfLift 1.2s cubic-bezier(.2,.8,.2,1) both}
.wcf-pi-trophy.big path,.wcf-pi-trophy.big line{animation:none}
.wcf-pi-name{font-family:var(--display);font-weight:800;font-size:36px;margin-top:12px;color:#fff;animation:wcfRvIn .45s 1.95s both}
.wcf-pi-tap{font-size:12px;color:var(--dim);margin-top:18px;animation:wcfRvIn .4s 2.4s both}
.wcf-pw-k{font-size:10.5px;font-weight:800;letter-spacing:.2em;color:#f5d97a;margin-top:12px;animation:wcfRvIn .4s .8s both}
.wcf-pw-h{font-family:var(--display);font-weight:800;font-size:28px;line-height:1.1;margin-top:6px;color:#fff;max-width:280px;text-wrap:balance;animation:wcfRvIn .4s .95s both}
.wcf-pw-s{font-size:13.5px;color:var(--dim);margin-top:8px;line-height:1.5;animation:wcfRvIn .4s 1.1s both}
.wcf-pw-s b{color:#fff}
.wcf-pw-btn{margin-top:20px;border:0;border-radius:14px;padding:13px 22px;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);color:#1a1405;font-weight:800;font-size:14px;cursor:pointer;animation:wcfRvIn .4s 1.3s both}
@keyframes wcfTear{to{transform:rotateX(-110deg) translateY(30px);opacity:0}}
@keyframes wcfDraw{from{stroke-dashoffset:300}to{stroke-dashoffset:0}}
@keyframes wcfFillGold{to{fill:rgba(245,217,122,.85)}}
@keyframes wcfLift{0%{transform:translateY(80px) scale(.7);opacity:0}60%{transform:translateY(-14px) scale(1.05);opacity:1}100%{transform:none}}
.wcf-potm-land{animation:wcfGoldRing 1.4s ease-out}
.wcf-potm-land .wcf-potm-bg{animation:wcfPotmBg 1s ease-out both}
.wcf-potm-land .wcf-potm-face{animation:wcfFaceIn .55s .25s cubic-bezier(.3,1.5,.5,1) both}
.wcf-potm-land .wcf-potm-name{animation:wcfRvIn .4s .45s both}
.wcf-potm-land .wcf-potm-stats span{animation:wcfRvIn .35s both}
.wcf-potm-land .wcf-potm-stats span:nth-child(1){animation-delay:.6s}.wcf-potm-land .wcf-potm-stats span:nth-child(2){animation-delay:.7s}.wcf-potm-land .wcf-potm-stats span:nth-child(3){animation-delay:.8s}
@keyframes wcfPotmBg{from{opacity:0;transform:scale(1.1)}to{opacity:.9;transform:none}}
@keyframes wcfFaceIn{from{opacity:0;transform:scale(.3) rotate(-20deg)}to{opacity:1;transform:none}}
/* A record falls (Records page) and the record breaker's moment */
.wcf-rec-hero{position:relative}
.wcf-rec-hero-stat b span{font-size:inherit;line-height:inherit;color:inherit;font-weight:inherit}
.wcf-rb-play .wcf-rb-old,.wcf-rb-play .wcf-rb-was{position:relative;display:inline-block;white-space:nowrap;animation:wcfRbOut 1.6s both}
.wcf-rb-play .wcf-rb-old::after,.wcf-rb-play .wcf-rb-was::after{content:"";position:absolute;left:-4%;right:-4%;top:52%;height:3px;background:#E42A36;transform-origin:left;animation:wcfRbLine .35s .5s ease-out both}
.wcf-rb-play .wcf-rb-new{display:inline-block;animation:wcfRbIn .5s 1.1s cubic-bezier(.3,1.6,.5,1) both}
.wcf-rb-play .wcf-rec-val .wcf-rb-new{color:#f5d97a}
.wcf-rb-play .wcf-rb-now{display:inline-block;animation:wcfRbIn .45s 1.25s both}
.wcf-rb-tag{position:absolute;right:14px;top:14px;z-index:2;padding:6px 9px;border-radius:7px;background:#f5d97a;color:#0d0d1a;font-family:var(--display);font-weight:800;font-size:11px;letter-spacing:.1em;transform:rotate(6deg);animation:wcfRbStamp .38s 1.45s cubic-bezier(.3,1.6,.5,1) both}
.wcf-rb-chip{margin-left:6px;padding:2px 6px;border-radius:999px;background:#f5d97a;color:#0d0d1a;font-size:9px;font-weight:800;letter-spacing:.08em;vertical-align:1px;animation:wcfRbIn .3s 1.6s cubic-bezier(.3,1.6,.5,1) both}
.wcf-rec-row.wcf-rb-play{position:relative;overflow:hidden}
.wcf-rb-shine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,240,200,.22) 50%,transparent 65%);transform:translateX(-130%);animation:wcfRbShine .9s 1.5s ease-out both}
@keyframes wcfRbOut{0%,65%{opacity:1;max-width:240px}100%{opacity:0;max-width:0}}
@keyframes wcfRbLine{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes wcfRbIn{from{opacity:0;transform:scale(.4) translateY(6px)}to{opacity:1;transform:none}}
@keyframes wcfRbStamp{from{opacity:0;transform:rotate(6deg) scale(2.4)}to{opacity:1;transform:rotate(6deg) scale(1)}}
@keyframes wcfRbShine{to{transform:translateX(130%)}}
.wcf-rbm-k{font-size:11px;font-weight:800;letter-spacing:.26em;color:#f5d97a}
.wcf-rbm-balls{display:grid;grid-template-columns:repeat(3,34px);gap:10px;margin-top:18px}
.wcf-rbm-balls svg{width:34px;height:34px;animation:wcfRbDrop .5s cubic-bezier(.3,1.4,.5,1) both}
.wcf-rbm-big{font-family:var(--display);font-weight:800;font-size:96px;line-height:1;margin-top:10px;background:linear-gradient(180deg,#fde68a,#eab308);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wcfLift 1s cubic-bezier(.2,.8,.2,1) both}
.wcf-rbm-h{font-family:var(--display);font-weight:800;font-size:27px;line-height:1.1;color:#fff;margin-top:18px;max-width:300px;text-wrap:balance;animation:wcfRvIn .4s 1.6s both}
.wcf-rbm-s{font-size:13.5px;color:var(--dim);line-height:1.5;margin-top:8px;animation:wcfRvIn .4s 1.75s both}
.wcf-rbm-s b{color:#fff}
.wcf-potm-intro .wcf-pw-btn{animation-delay:1.95s}
.wcf-potm-intro.winner .wcf-pw-k~.wcf-pw-btn{animation-delay:1.3s}
@keyframes wcfRbDrop{from{opacity:0;transform:translateY(-120px) rotate(-180deg)}to{opacity:1;transform:none}}
@keyframes wcfGoldRing{0%{box-shadow:0 0 0 0 rgba(245,217,122,0)}30%{box-shadow:0 0 0 3px rgba(245,217,122,.8),0 0 40px 6px rgba(234,179,8,.45)}100%{box-shadow:0 0 0 0 rgba(245,217,122,0)}}

.wcf-rate-overlay{position:fixed;inset:0;z-index:130;background:rgba(3,4,8,.6);display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.wcf-rate{width:100%;max-width:480px;border-radius:26px 26px 0 0;overflow:hidden;background:#111427;border-top:1px solid rgba(245,217,122,.4);padding-bottom:env(safe-area-inset-bottom,0px);animation:wcfRateUp .45s cubic-bezier(.2,.8,.2,1)}
.wcf-rate-photo{position:relative;height:150px;background:linear-gradient(180deg,rgba(17,20,39,.05) 20%,#111427 100%),url('/pitch-floodlit.jpg') center 55%/cover}
.wcf-rate-k{position:absolute;left:18px;top:16px;font-size:10.5px;font-weight:800;letter-spacing:.18em;color:#f5d97a;text-shadow:0 1px 6px rgba(0,0,0,.7)}
.wcf-rate-x{position:absolute;right:14px;top:12px;width:32px;height:32px;border-radius:50%;border:0;background:rgba(13,13,26,.55);color:#fff;cursor:pointer}
.wcf-rate-score{position:absolute;left:0;right:0;bottom:12px;text-align:center;font-family:var(--display);font-weight:800;font-size:44px;color:#fff;font-variant-numeric:tabular-nums;text-shadow:0 2px 12px rgba(0,0,0,.6)}
.wcf-rate-score small{margin:0 10px;font-family:var(--sans);font-size:10.5px;font-weight:800;letter-spacing:.14em;color:#cbd5e1;vertical-align:middle}
.wcf-rate-body{padding:6px 18px 18px}
.wcf-rate-q{margin-bottom:14px;text-align:center;font-family:var(--display);font-weight:800;font-size:21px;color:#fff}
.wcf-rate-meter{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
.wcf-rate-meter button{height:48px;border-radius:11px;border:1px solid var(--line);background:var(--panel);cursor:pointer;transition:transform .15s,background .15s}
.wcf-rate-meter button:active{transform:scale(.94)}
.wcf-rate-meter button.on{border-color:transparent;background:linear-gradient(180deg,#f5d97a,#eab308);box-shadow:0 0 16px rgba(234,179,8,.35)}
.wcf-rate-meter button.on:nth-child(1){opacity:.55}
.wcf-rate-meter button.on:nth-child(2){opacity:.7}
.wcf-rate-meter button.on:nth-child(3){opacity:.85}
.wcf-rate-meter.small{flex:none;grid-template-columns:repeat(5,22px);gap:4px}
.wcf-rate-meter.small button{height:32px;border-radius:7px}
.wcf-rate-ends{display:flex;justify-content:space-between;margin-top:7px;font-size:11.5px;font-weight:700;color:var(--dim)}
.wcf-rate-verdict{min-height:24px;margin-top:10px;text-align:center;font-family:var(--display);font-weight:800;font-size:18px;color:#f5d97a}
.wcf-rate-next{display:block;width:100%;margin-top:12px;padding:13px;border:0;border-radius:14px;background:linear-gradient(90deg,#eab308,#f5d97a 60%,#eab308);color:#1a1405;font-weight:800;font-size:14px;cursor:pointer}
.wcf-rate-squad{margin-top:12px;padding:11px 12px;border-radius:12px;background:rgba(245,217,122,.08);border:1px solid rgba(245,217,122,.3);font-size:13px;color:#e2e8f0;text-align:center}
.wcf-rate-squad b{color:#f5d97a;font-family:var(--display);font-size:16px}
.wcf-rate-foot{margin-top:12px;text-align:center;font-size:12px;color:#64748b}
.wcf-rate-done{display:block;margin:12px auto 0;background:none;border:0;color:var(--dim);font-weight:700;font-size:13px;cursor:pointer}
.wcf-rate-card{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:12px 14px;border-radius:18px;border:1px solid rgba(245,217,122,.5);background:radial-gradient(100% 90% at 100% 0%,rgba(245,217,122,.14),transparent 60%),#111427}
.wcf-rate-card>div:first-child{flex:1;min-width:0}
.wcf-rate-card-t{font-family:var(--display);font-weight:800;font-size:15px;color:#fff}
.wcf-rate-card-s{margin-top:2px;font-size:11.5px;color:var(--dim)}
@media (prefers-reduced-motion:reduce){.wcf-rate{animation:none}}
.wcf-why{padding:12px 14px 14px;border-top:1px solid var(--line);background:linear-gradient(180deg,rgba(245,217,122,.06),transparent)}
.wcf-why-q{font-family:var(--display);font-weight:800;font-size:15px;color:#fff}
.wcf-why-s{margin-top:2px;font-size:11.5px;color:var(--dim)}
.wcf-why-tags{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:10px}
.wcf-why-tag{padding:10px 4px 9px;border-radius:12px;background:var(--panel);border:1px solid var(--line);color:var(--dim);text-align:center;cursor:pointer}
.wcf-why-tag b{display:block;margin-top:5px;font-size:11.5px;color:#e2e8f0}
.wcf-why-tag.on{border-color:#f5d97a;background:radial-gradient(90% 90% at 50% 20%,rgba(245,217,122,.2),transparent 70%),var(--panel);box-shadow:0 0 18px rgba(234,179,8,.3);color:#f5d97a}
.wcf-why-tag.on b{color:#f5d97a}
:where(.wcf-root) :where(button, input, select, textarea){font-family:inherit}
/* iOS Safari zooms the whole page when a field under 16px is focused,
   which feels like something broke. Thirteen separate rules had drifted
   to 10.5-15px, so the floor is set once here, last on purpose, rather
   than patched in thirteen places to drift again. */
.wcf-root input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),
.wcf-root select,
.wcf-root textarea{font-size:16px}
`;
