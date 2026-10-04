import { useEffect, useState } from "react";
import { MATCH_DURATION_MINUTES, kickoffCutoff, nowInLondon } from "../../lib/time";
import { Avatar, avatarFor } from "./shared";

// Match-day mode: on the day of a game you're playing in, the "Next match"
// card becomes the day's hub - a MATCHDAY badge, a live countdown (amber in
// the last hour), your team once it's picked, then LIVE NOW with the match
// clock. After full time the game leaves Fixtures and the usual "Rate
// tonight" / MOTM vote prompts take over.

// Seconds-accurate "now" in the same pretend-UTC frame as kickoffCutoff.
function nowMs() {
  return new Date(nowInLondon() + ":00Z").getTime() + new Date().getSeconds() * 1000;
}
const kickMs = (date: string, kickoff: string) => new Date(kickoffCutoff(date, kickoff, 0) + ":00Z").getTime();

export function isMatchDay(date: string, kickoff: string) {
  return nowInLondon().slice(0, 10) === date && nowMs() < kickMs(date, kickoff) + MATCH_DURATION_MINUTES * 60000;
}

export function MatchDayClock({ date, kickoff }: { date: string; kickoff: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.floor((kickMs(date, kickoff) - nowMs()) / 1000);
  if (diff > 0) {
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      <div className={"wcf-md-count" + (diff <= 3600 ? " hot" : "")}>
        {h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`}
        <small>TO KICK-OFF · {kickoff}</small>
      </div>
    );
  }
  const minute = Math.min(MATCH_DURATION_MINUTES, Math.floor(-diff / 60) + 1);
  return (
    <div className="wcf-md-livebox">
      <span className="wcf-md-live"><i />LIVE NOW</span>
      <div className="wcf-md-min">{minute}&apos;</div>
      <div className="wcf-md-bar"><i style={{ width: `${(minute / MATCH_DURATION_MINUTES) * 100}%` }} /></div>
    </div>
  );
}

export function MatchDayTeam({
  name,
  color,
  mates,
}: {
  name: string;
  color: string;
  mates: { display_name: string; avatar_url?: string | null }[];
}) {
  const light = ["#f5f6f8", "#ffffff", "#fff"].includes(color.toLowerCase());
  const first = mates.slice(0, 3).map((m) => m.display_name.split(" ")[0]);
  const rest = mates.length - first.length;
  return (
    <div className="wcf-md-team" style={{ background: `${color}22`, borderColor: `${color}88` }}>
      <svg className="bib" viewBox="0 0 40 44" aria-hidden="true">
        <path d="M10 4 L16 2 Q20 6 24 2 L30 4 L38 12 L33 17 L31 15 V42 H9 V15 L7 17 L2 12 Z" fill={color} stroke={light ? "#94a3b8" : "rgba(255,255,255,.7)"} strokeWidth="1.5" />
      </svg>
      <div className="tx">
        <b>You&apos;re in {name.toUpperCase()} tonight</b>
        {mates.length > 0 && (
          <span>
            with {first.join(", ")}
            {rest > 0 ? ` and ${rest} more` : ""}
          </span>
        )}
        <span className="mates">
          {mates.slice(0, 5).map((m) => (
            <Avatar key={m.display_name} name={m.display_name} avatarUrl={m.avatar_url} className="wcf-avatar-chip" background={avatarFor(m.display_name).gradient} />
          ))}
        </span>
      </div>
    </div>
  );
}
